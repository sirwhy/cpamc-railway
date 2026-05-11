"""Stage 5 — melody extraction to MIDI using Spotify's basic-pitch."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.melody")


def _convert_sync(vocals: str, out_dir: str) -> Optional[str]:
    try:
        from basic_pitch.inference import predict_and_save  # type: ignore
        from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "basic-pitch not installed. Run: pip install basic-pitch"
        ) from exc

    predict_and_save(
        audio_path_list=[vocals],
        output_directory=out_dir,
        save_midi=True,
        sonify_midi=False,
        save_model_outputs=False,
        save_notes=False,
        model_or_model_path=ICASSP_2022_MODEL_PATH,
    )
    # basic-pitch names output: <source_stem>_basic_pitch.mid
    from pathlib import Path as _P

    candidates = list(_P(out_dir).glob("*basic_pitch.mid"))
    if not candidates:
        return None
    return str(candidates[0])


async def run(job: Job, vocals: Path) -> Optional[Path]:
    if not config.ENABLE_BASIC_PITCH:
        return None

    job.update(
        status="extracting_melody",
        stage="melody",
        progress=0.45,
        message="Extracting melody to MIDI with basic-pitch…",
    )

    out_dir = job.dir / "melody"
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        midi_path_str = await asyncio.to_thread(_convert_sync, str(vocals), str(out_dir))
    except RuntimeError as exc:
        log.warning("melody extraction skipped: %s", exc)
        return None

    if midi_path_str is None:
        return None
    return Path(midi_path_str)
