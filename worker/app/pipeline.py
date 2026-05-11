"""End-to-end pipeline orchestrator.

The single entry point is :func:`run_pipeline`, registered as the
:class:`JobManager` runner in ``main.py`` on application startup.

Each stage adds its outputs to ``job.artifacts`` so they remain queryable
via the status endpoint even mid-pipeline (lyrics are exposed as soon as
transcription finishes, etc).
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Optional

from . import config
from .jobs import Job
from .schemas import Artifact
from .stages import (
    download as st_download,
    melody as st_melody,
    mix as st_mix,
    separate as st_separate,
    synth as st_synth,
    transcribe as st_transcribe,
    translate as st_translate,
    voice as st_voice,
)

log = logging.getLogger("hermes.pipeline")


def _expose(job: Job, *, kind: str, path: Path, media_type: str = "document", caption: Optional[str] = None) -> None:
    if not path.exists():
        return
    job.add_artifact(
        Artifact(
            kind=kind,
            filename=path.name,
            media_type=media_type,  # type: ignore[arg-type]
            caption=caption,
            size_bytes=path.stat().st_size,
        )
    )


def _audio_duration_sec(path: Path) -> float:
    """Cheap probe via ffprobe."""
    import subprocess

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 0.0
    try:
        out = subprocess.check_output(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            timeout=20,
        )
        return float(out.strip() or 0.0)
    except Exception:  # noqa: BLE001
        return 0.0


async def run_pipeline(job: Job) -> None:
    """The job runner. Updates progress/status and adds artifacts."""
    req = job.request
    log.info("pipeline start job=%s mode=%s lang=%s voice=%s",
             job.job_id, req.mode, req.target_language, req.voice_target)

    if job.cancel_requested:
        return

    # ----- 1. download -------------------------------------------------
    source = await st_download.run(job)
    duration = _audio_duration_sec(source)
    if duration > 0 and duration > config.MAX_DURATION_SEC:
        raise RuntimeError(
            f"Source audio is {duration:.0f}s long, max allowed {config.MAX_DURATION_SEC}s."
        )

    if req.mode == "transcribe_only":
        # Run transcribe directly on the source file
        transcript = await st_transcribe.run(job, source)
        _expose(job, kind="lyrics_txt", path=transcript["txt"])
        _expose(job, kind="lyrics_srt", path=transcript["srt"])
        translated_txt = await st_translate.run(job, transcript)
        if translated_txt and translated_txt.exists():
            _expose(job, kind="lyrics_translated_txt", path=translated_txt)
            srt2 = translated_txt.with_suffix(".srt")
            if srt2.exists():
                _expose(job, kind="lyrics_translated_srt", path=srt2)
        job.update(status="done", stage="done", progress=1.0, message="Transcription complete.")
        return

    # ----- 2. separate ------------------------------------------------
    if job.cancel_requested:
        return
    stems = await st_separate.run(job, source)
    for kind in ("vocals", "drums", "bass", "other", "no_vocals"):
        p = stems.get(kind)
        if p and p.exists():
            _expose(job, kind=f"stem_{kind}", path=p)

    if req.mode == "stems_only":
        # Build stems.zip and exit
        from zipfile import ZipFile, ZIP_DEFLATED

        out_dir = job.dir / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        zip_path = out_dir / "stems.zip"
        with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as zf:
            for kind, p in stems.items():
                if p.exists():
                    zf.write(p, arcname=f"{kind}.wav")
        _expose(job, kind="stems_zip", path=zip_path, caption="Stems bundle")
        job.update(status="done", stage="done", progress=1.0, message="Stems ready.")
        return

    # ----- 3. transcribe ----------------------------------------------
    if job.cancel_requested:
        return
    transcript = await st_transcribe.run(job, stems["vocals"])
    _expose(job, kind="lyrics_txt", path=transcript["txt"])
    _expose(job, kind="lyrics_srt", path=transcript["srt"])

    # ----- 4. translate (translation_cover only) ----------------------
    translated_txt: Optional[Path] = None
    if req.mode == "translation_cover":
        if job.cancel_requested:
            return
        translated_txt = await st_translate.run(job, transcript)
        if translated_txt and translated_txt.exists():
            _expose(job, kind="lyrics_translated_txt", path=translated_txt)
            srt2 = translated_txt.with_suffix(".srt")
            if srt2.exists():
                _expose(job, kind="lyrics_translated_srt", path=srt2)

    # ----- 5. melody extraction (parallel-safe but cheap; run sequentially)
    if job.cancel_requested:
        return
    midi_path: Optional[Path] = None
    if "midi" in (req.output_bundle or []):
        midi_path = await st_melody.run(job, stems["vocals"])
        if midi_path:
            _expose(job, kind="melody_midi", path=midi_path)

    # ----- 6. synth (translation_cover only) --------------------------
    synth_out = None
    if req.mode == "translation_cover":
        if job.cancel_requested:
            return
        synth_out = await st_synth.run(job, transcript, translated_txt, stems["vocals"])

    # ----- 7. voice (RVC) ---------------------------------------------
    if job.cancel_requested:
        return
    new_vocal = await st_voice.run(
        job,
        vocals=stems["vocals"],
        synth_out=synth_out,
        source_duration_sec=duration or 0.0,
    )

    # ----- 8. mix & master --------------------------------------------
    if job.cancel_requested:
        return
    final_artifacts = await st_mix.run(
        job,
        stems=stems,
        new_vocal=new_vocal,
        transcript=transcript,
        translated_txt=translated_txt,
        midi=midi_path,
    )

    # Replace stem artifacts with the output/-copied paths (so the bot
    # always downloads from /output/) and add final mp3 + stems.zip.
    job.artifacts = [a for a in job.artifacts if not a.kind.startswith("stem_")]
    if "final_mp3" in final_artifacts:
        _expose(job, kind="final_mp3", path=final_artifacts["final_mp3"], media_type="audio", caption="Final cover")
    if "stems_zip" in final_artifacts:
        _expose(job, kind="stems_zip", path=final_artifacts["stems_zip"], caption="Stems bundle")
    for k, p in final_artifacts.items():
        if k.startswith("stem_"):
            _expose(job, kind=k, path=p)
    if "lyrics_txt" in final_artifacts:
        _expose(job, kind="lyrics_txt", path=final_artifacts["lyrics_txt"])
    if "lyrics_srt" in final_artifacts:
        _expose(job, kind="lyrics_srt", path=final_artifacts["lyrics_srt"])
    if "lyrics_translated_txt" in final_artifacts:
        _expose(job, kind="lyrics_translated_txt", path=final_artifacts["lyrics_translated_txt"])
    if "lyrics_translated_srt" in final_artifacts:
        _expose(job, kind="lyrics_translated_srt", path=final_artifacts["lyrics_translated_srt"])
    if "melody_midi" in final_artifacts:
        _expose(job, kind="melody_midi", path=final_artifacts["melody_midi"])

    job.update(status="done", stage="done", progress=1.0, message="Cover ready.")
