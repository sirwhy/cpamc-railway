"""Stage 3 — speech-to-text with word-level timestamps using faster-whisper."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Dict, List, Optional

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.transcribe")

_model = None


def _format_srt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms_total = int(round(seconds * 1000))
    ms = ms_total % 1000
    s = (ms_total // 1000) % 60
    m = (ms_total // 60000) % 60
    h = ms_total // 3600000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _load_model():
    global _model
    if _model is not None:
        return _model
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper not installed. Run: pip install faster-whisper"
        ) from exc
    log.info("loading whisper model %s (%s, %s)", config.WHISPER_MODEL, config.WHISPER_DEVICE, config.WHISPER_COMPUTE)
    _model = WhisperModel(
        config.WHISPER_MODEL,
        device=config.WHISPER_DEVICE,
        compute_type=config.WHISPER_COMPUTE,
    )
    return _model


def _transcribe_sync(audio_path: str) -> Dict:
    model = _load_model()
    segments_iter, info = model.transcribe(
        audio_path,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    segments_out: List[Dict] = []
    words_out: List[Dict] = []
    for seg in segments_iter:
        segments_out.append(
            {
                "id": seg.id,
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
            }
        )
        for w in (seg.words or []):
            words_out.append(
                {
                    "start": float(w.start),
                    "end": float(w.end),
                    "word": w.word,
                }
            )
    return {
        "language": info.language,
        "language_probability": float(info.language_probability),
        "duration": float(info.duration),
        "segments": segments_out,
        "words": words_out,
    }


async def run(job: Job, vocals: Path) -> Dict[str, Path]:
    """Run Whisper on vocal stem, write .txt and .srt artifacts.

    Returns ``{"txt": ..., "srt": ..., "json": ...}`` paths.
    """
    job.update(
        status="transcribing",
        stage="transcribe",
        progress=0.30,
        message=f"Transcribing vocals with Whisper {config.WHISPER_MODEL}…",
    )

    out_dir = job.dir / "transcript"
    out_dir.mkdir(parents=True, exist_ok=True)

    result = await asyncio.to_thread(_transcribe_sync, str(vocals))

    plain = "\n".join(seg["text"] for seg in result["segments"]).strip() + "\n"
    txt_path = out_dir / "lyrics.txt"
    txt_path.write_text(plain, encoding="utf-8")

    srt_lines: List[str] = []
    for i, seg in enumerate(result["segments"], start=1):
        srt_lines.append(str(i))
        srt_lines.append(f"{_format_srt_time(seg['start'])} --> {_format_srt_time(seg['end'])}")
        srt_lines.append(seg["text"])
        srt_lines.append("")
    srt_path = out_dir / "lyrics.srt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

    import json as _json

    json_path = out_dir / "transcript.json"
    json_path.write_text(_json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    return {"txt": txt_path, "srt": srt_path, "json": json_path}
