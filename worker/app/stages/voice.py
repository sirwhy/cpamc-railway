"""Stage 7 — RVC v2 timbre conversion.

Operates on a "candidate vocal" track that already follows the melody
(either the original isolated vocal stem for ``ai_cover``, or the XTTS
synth output for ``translation_cover``). Output is the same vocal with
the timbre of the requested voice model.

Three voice paths:

* ``preserve_original`` — for ``translation_cover``: target voice is
  inferred by training/loading an RVC model derived from the original
  vocal stem itself. In v1 we shortcut: when ``preserve_original`` is
  requested AND mode is ``translation_cover`` we still need an RVC model
  to map *to*. If the bot did not pre-register a voice from this song,
  we fall back to the XTTS synth output directly (no RVC pass).
* ``<voice_name>`` from registry — explicit RVC model name.
* ``generic_synth`` — no RVC pass; we keep the XTTS output as-is.

We invoke RVC through the ``rvc-python`` library if present (PyPI:
``rvc-python``), or via an in-tree ``rvc_cli.py`` if you prefer to drop
in your own RVC fork. If neither is available we skip with a warning;
the pipeline still produces output (just without timbre conversion).
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

from .. import config, voices
from ..jobs import Job

log = logging.getLogger("hermes.stage.voice")


def _have_rvc_python() -> bool:
    try:
        import rvc_python  # type: ignore  # noqa: F401

        return True
    except ImportError:
        return False


async def _run_rvc_python(
    *,
    input_wav: Path,
    output_wav: Path,
    model_path: Path,
    index_path: Optional[Path],
    pitch_shift: int,
    voice_strength: float,
) -> None:
    """Call rvc-python CLI module ``python -m rvc_python``.

    rvc-python's CLI accepts:
        -i input.wav -o output.wav -p pitch_shift -fr feature_ratio
        -mp model.pth -ip feature.index
    """
    cmd = [
        "python",
        "-m",
        "rvc_python",
        "-i",
        str(input_wav),
        "-o",
        str(output_wav),
        "-p",
        str(int(pitch_shift)),
        "-fr",
        f"{float(voice_strength):.2f}",
        "-mp",
        str(model_path),
    ]
    if index_path is not None and index_path.exists():
        cmd.extend(["-ip", str(index_path)])

    log.info("$ %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=900)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("rvc-python timeout after 900s")
    if proc.returncode != 0:
        raise RuntimeError(
            f"rvc-python failed ({proc.returncode}): {out.decode(errors='ignore')[-2000:]}"
        )


async def _concat_segments_to_wav(
    *,
    seg_manifest: Path,
    seg_dir: Path,
    out_wav: Path,
    duration_target_sec: float,
) -> None:
    """Concatenate XTTS segment wavs into a single track aligned to
    transcript timings (silence padding between segments)."""
    import json as _json

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not installed.")
    manifest = _json.loads(seg_manifest.read_text(encoding="utf-8"))
    segs: List[Dict] = manifest.get("segments") or []
    if not segs:
        raise RuntimeError("synth manifest empty")

    # Build an ffmpeg concat filter that inserts silence + each clip.
    # We use anullsrc to generate silence then concat with each clip.
    inputs: List[str] = []
    filter_lines: List[str] = []
    cur = 0.0
    label_idx = 0
    cat_labels: List[str] = []
    for i, seg in enumerate(segs):
        start = float(seg["start"])
        clip_path = seg_dir / seg["wav"]
        gap = max(0.0, start - cur)
        if gap > 0.01:
            inputs.extend(["-f", "lavfi", "-t", f"{gap:.3f}", "-i", "anullsrc=r=24000:cl=mono"])
            label = f"[{label_idx}:a]"
            filter_lines.append(f"{label}aformat=sample_rates=24000:channel_layouts=mono[s{i}]")
            cat_labels.append(f"[s{i}]")
            label_idx += 1
        inputs.extend(["-i", str(clip_path)])
        label = f"[{label_idx}:a]"
        filter_lines.append(f"{label}aformat=sample_rates=24000:channel_layouts=mono[c{i}]")
        cat_labels.append(f"[c{i}]")
        label_idx += 1
        # Approximate seg end (we don't time-stretch; XTTS chooses its own duration)
        # We just use the clip's start as cursor advance and trust mix to handle drift.
        cur = float(seg.get("end") or start)

    # Trailing silence to reach target duration
    tail = max(0.0, duration_target_sec - cur)
    if tail > 0.05:
        inputs.extend(["-f", "lavfi", "-t", f"{tail:.3f}", "-i", "anullsrc=r=24000:cl=mono"])
        label = f"[{label_idx}:a]"
        filter_lines.append(f"{label}aformat=sample_rates=24000:channel_layouts=mono[t]")
        cat_labels.append("[t]")
        label_idx += 1

    filter_lines.append(
        "".join(cat_labels) + f"concat=n={len(cat_labels)}:v=0:a=1[out]"
    )
    filter_complex = ";".join(filter_lines)

    cmd = [ffmpeg, "-y", *inputs, "-filter_complex", filter_complex, "-map", "[out]", "-ac", "1", "-ar", "24000", str(out_wav)]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg synth concat failed: {err.decode(errors='ignore')[-1000:]}")


async def run(
    job: Job,
    *,
    vocals: Path,
    synth_out: Optional[Dict[str, Path]],
    source_duration_sec: float,
) -> Path:
    """Produce the final "new vocal" wav (in job.dir/voice/new_vocal.wav)."""
    req = job.request
    out_dir = job.dir / "voice"
    out_dir.mkdir(parents=True, exist_ok=True)
    final_vocal = out_dir / "new_vocal.wav"

    job.update(
        status="voice_converting",
        stage="voice",
        progress=0.72,
        message="Voice-converting vocals…",
    )

    # Determine candidate input:
    if req.mode == "translation_cover" and synth_out:
        candidate = out_dir / "candidate.wav"
        await _concat_segments_to_wav(
            seg_manifest=synth_out["manifest"],
            seg_dir=synth_out["dir"],
            out_wav=candidate,
            duration_target_sec=source_duration_sec,
        )
    elif req.mode == "ai_cover":
        candidate = vocals
    else:  # stems_only / transcribe_only never call this stage, but guard anyway
        shutil.copy2(vocals, final_vocal)
        return final_vocal

    # Determine voice target
    target = (req.voice_target or "preserve_original").strip()
    if target == "generic_synth":
        # Just keep XTTS output as-is (no RVC pass)
        shutil.copy2(candidate, final_vocal)
        return final_vocal

    if target == "preserve_original":
        # For ai_cover this is a no-op; for translation_cover we don't have
        # an auto-trained RVC of this singer in v1, so we keep the XTTS
        # output untouched and warn.
        if req.mode == "ai_cover":
            shutil.copy2(candidate, final_vocal)
            return final_vocal
        log.warning(
            "voice_target=preserve_original in translation_cover mode: "
            "no auto-trained RVC for this song in v1; keeping synth output."
        )
        shutil.copy2(candidate, final_vocal)
        return final_vocal

    voice = voices.get_voice(target)
    if voice is None or not voice.model_path:
        raise RuntimeError(
            f"Voice '{target}' not found in registry. Register it first via hermes_upload_voice."
        )

    if not _have_rvc_python():
        log.warning(
            "rvc-python not installed; skipping RVC conversion. Run: pip install rvc-python"
        )
        shutil.copy2(candidate, final_vocal)
        return final_vocal

    await _run_rvc_python(
        input_wav=candidate,
        output_wav=final_vocal,
        model_path=Path(voice.model_path),
        index_path=Path(voice.index_path) if voice.index_path else None,
        pitch_shift=int(req.voice_pitch_shift or 0),
        voice_strength=float(req.voice_strength or 0.75),
    )
    return final_vocal
