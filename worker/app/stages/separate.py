"""Stage 2 — source separation via Demucs (htdemucs_ft)."""
from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Dict, Optional

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.separate")


async def _run(cmd: list, timeout: int = 1200) -> str:
    log.info("$ %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"demucs timeout after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(
            f"demucs failed ({proc.returncode}): {out.decode(errors='ignore')[-2000:]}"
        )
    return out.decode(errors="ignore")


async def run(job: Job, source: Path) -> Dict[str, Path]:
    """Run Demucs on `source` and return mapping kind -> wav path.

    Keys: ``vocals``, ``drums``, ``bass``, ``other``, ``no_vocals``
    (``no_vocals`` is computed by mixing drums+bass+other).
    """
    job.update(
        status="separating",
        stage="separate",
        progress=0.15,
        message=f"Separating stems with Demucs ({config.DEMUCS_MODEL})…",
    )

    out_root = job.dir / "stems"
    out_root.mkdir(parents=True, exist_ok=True)

    demucs_bin = shutil.which("demucs")
    if demucs_bin is None:
        raise RuntimeError(
            "demucs CLI not found. Install with: pip install demucs"
        )

    # demucs writes to {out_root}/{model}/{stem_track}/*.wav
    # 4-stem split (vocals/drums/bass/other); we synthesize no_vocals
    # ourselves below to control the mix instead of using --two-stems.
    cmd = [
        demucs_bin,
        "-n",
        config.DEMUCS_MODEL,
        "-o",
        str(out_root),
        str(source),
    ]
    await _run(cmd)

    # Demucs naming: out_root / DEMUCS_MODEL / <source stem name> / *.wav
    src_stem = source.stem
    produced_dir = out_root / config.DEMUCS_MODEL / src_stem
    if not produced_dir.exists():
        # Fallback: scan for the only subdirectory under model dir
        model_dir = out_root / config.DEMUCS_MODEL
        if model_dir.exists():
            candidates = [p for p in model_dir.iterdir() if p.is_dir()]
            if len(candidates) == 1:
                produced_dir = candidates[0]
    if not produced_dir.exists():
        raise RuntimeError(f"demucs output not found under {out_root}")

    stems: Dict[str, Path] = {}
    for name in ("vocals", "drums", "bass", "other"):
        candidate = produced_dir / f"{name}.wav"
        if candidate.exists():
            stems[name] = candidate

    if "vocals" not in stems:
        raise RuntimeError("demucs did not produce vocals.wav")

    # Compose no_vocals (instrumental) = drums + bass + other
    inst_parts = [stems[k] for k in ("drums", "bass", "other") if k in stems]
    if inst_parts:
        instrumental = produced_dir / "no_vocals.wav"
        await _mix_to_instrumental(inst_parts, instrumental)
        stems["no_vocals"] = instrumental

    return stems


async def _mix_to_instrumental(parts, dest: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not installed.")
    inputs: list[str] = []
    for p in parts:
        inputs.extend(["-i", str(p)])
    filter_complex = "".join(f"[{i}:a]" for i in range(len(parts))) + f"amix=inputs={len(parts)}:duration=longest:normalize=0[a]"
    cmd = [ffmpeg, "-y", *inputs, "-filter_complex", filter_complex, "-map", "[a]", "-c:a", "pcm_s16le", str(dest)]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg mix instrumental failed: {err.decode(errors='ignore')[-1000:]}")
