"""Stage 8 — mix the converted vocal with the instrumental and master.

Final deliverables produced here:
    job.dir/output/final.mp3
    job.dir/output/stems.zip
    job.dir/output/lyrics.{txt,srt}        (copied from transcript)
    job.dir/output/lyrics.{lang}.{txt,srt} (if translated)
    job.dir/output/melody.mid              (if extracted)
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import zipfile
from pathlib import Path
from typing import Dict, Optional

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.mix")


async def _ffmpeg(cmd: list, *, timeout: int = 600) -> None:
    log.info("$ %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"ffmpeg timeout after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {err.decode(errors='ignore')[-1500:]}")


async def _mix_and_master(
    *,
    vocal: Path,
    instrumental: Path,
    out_mp3: Path,
    target_lufs: float,
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not installed.")
    # Mix vocal (mono → stereo) + instrumental, then loudness-normalize.
    filter_complex = (
        "[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.9[v];"
        "[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.85[i];"
        f"[v][i]amix=inputs=2:duration=longest:normalize=0,loudnorm=I={target_lufs}:LRA=11:TP=-1.5[a]"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(vocal),
        "-i",
        str(instrumental),
        "-filter_complex",
        filter_complex,
        "-map",
        "[a]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(out_mp3),
    ]
    await _ffmpeg(cmd)


def _build_stems_zip(stems: Dict[str, Path], out_zip: Path) -> None:
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for kind, path in stems.items():
            if path.exists():
                zf.write(path, arcname=f"{kind}.wav")


async def run(
    job: Job,
    *,
    stems: Dict[str, Path],
    new_vocal: Optional[Path],
    transcript: Dict[str, Path],
    translated_txt: Optional[Path],
    midi: Optional[Path],
) -> Dict[str, Path]:
    """Assemble all final artifacts. Returns mapping kind → path."""
    job.update(status="mixing", stage="mix", progress=0.90, message="Mixing & mastering…")
    out_dir = job.dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)

    artifacts: Dict[str, Path] = {}

    instrumental = stems.get("no_vocals")
    if instrumental is None:
        raise RuntimeError("instrumental (no_vocals) missing — cannot mix.")

    vocal_for_mix = new_vocal or stems["vocals"]
    final_mp3 = out_dir / "final.mp3"
    await _mix_and_master(
        vocal=vocal_for_mix,
        instrumental=instrumental,
        out_mp3=final_mp3,
        target_lufs=config.TARGET_LUFS,
    )
    artifacts["final_mp3"] = final_mp3

    # Stems bundle
    stems_zip = out_dir / "stems.zip"
    _build_stems_zip(stems, stems_zip)
    artifacts["stems_zip"] = stems_zip

    # Also expose individual stems for fine-grained download
    for kind in ("vocals", "drums", "bass", "other", "no_vocals"):
        p = stems.get(kind)
        if p and p.exists():
            dest = out_dir / f"{kind}.wav"
            shutil.copy2(p, dest)
            artifacts[f"stem_{kind}"] = dest

    # Lyrics
    for k, p in transcript.items():
        if k in ("txt", "srt"):
            dest = out_dir / f"lyrics.{k}"
            shutil.copy2(p, dest)
            artifacts[f"lyrics_{k}"] = dest
    if translated_txt and translated_txt.exists():
        shutil.copy2(translated_txt, out_dir / translated_txt.name)
        artifacts["lyrics_translated_txt"] = out_dir / translated_txt.name
        # Translated SRT lives next to translated TXT in transcript dir
        srt_candidate = translated_txt.with_suffix(".srt")
        if srt_candidate.exists():
            shutil.copy2(srt_candidate, out_dir / srt_candidate.name)
            artifacts["lyrics_translated_srt"] = out_dir / srt_candidate.name

    # Melody MIDI
    if midi and midi.exists():
        dest = out_dir / "melody.mid"
        shutil.copy2(midi, dest)
        artifacts["melody_midi"] = dest

    return artifacts
