"""Stage 6 — multilingual singing-ish synthesis using Coqui XTTS-v2.

v1 disclaimer: XTTS is a *speech* TTS engine, not a true singing-voice
synthesizer. We push it toward 'sung-spoken' output by:

  1. Using the original vocal stem as the speaker reference (so timbre is
     preserved) when ``voice_target == 'preserve_original'``.
  2. Generating one clip per SRT segment so we can time-stretch each clip
     onto the original timing grid in ``mix.py``.

The output is a directory of WAV segments + a manifest JSON consumed by
the mix stage. Real singing alignment (true SVS) is planned for v2.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.synth")


_tts = None


def _load_tts():
    global _tts
    if _tts is not None:
        return _tts
    try:
        from TTS.api import TTS  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "Coqui TTS not installed. Run: pip install TTS"
        ) from exc
    log.info("loading XTTS-v2 (%s)…", config.XTTS_MODEL)
    _tts = TTS(model_name=config.XTTS_MODEL, progress_bar=False, gpu=True)
    return _tts


def _synth_segment_sync(
    text: str,
    out_path: str,
    *,
    speaker_wav: Optional[str],
    language: str,
) -> None:
    tts = _load_tts()
    tts.tts_to_file(
        text=text,
        file_path=out_path,
        speaker_wav=speaker_wav,
        language=language,
    )


def _xtts_lang_code(target_language: str) -> str:
    code = target_language.strip().lower()
    aliases = {
        "indonesian": "id",
        "in": "id",
        "english": "en",
        "russian": "ru",
        "spanish": "es",
        "french": "fr",
        "japanese": "ja",
        "korean": "ko",
        "chinese": "zh-cn",
        "zh": "zh-cn",
        "german": "de",
        "portuguese": "pt",
        "italian": "it",
        "arabic": "ar",
        "hindi": "hi",
        "turkish": "tr",
    }
    if code in aliases:
        return aliases[code]
    if len(code) >= 2:
        return code[:2]
    return "en"


def _split_translated_lines(translated_txt: Path) -> List[str]:
    return [ln.strip() for ln in translated_txt.read_text(encoding="utf-8").splitlines() if ln.strip()]


async def run(
    job: Job,
    transcript: Dict[str, Path],
    translated_txt: Optional[Path],
    vocals: Path,
) -> Optional[Dict[str, Path]]:
    """Synthesize one wav per transcript segment using translated text.

    Returns ``{"manifest": manifest_path, "dir": out_dir}`` or None if
    nothing to synthesize.
    """
    req = job.request
    if req.mode == "stems_only" or req.mode == "transcribe_only":
        return None
    if not config.ENABLE_XTTS:
        return None
    if req.mode == "translation_cover" and not translated_txt:
        log.warning("translation_cover requested but translation missing; skipping synth")
        return None

    job.update(
        status="synthesizing",
        stage="synth",
        progress=0.55,
        message="Synthesizing multilingual vocals with XTTS-v2…",
    )

    # Load transcript JSON to get segment timing
    transcript_json = json.loads(transcript["json"].read_text(encoding="utf-8"))
    segments = transcript_json.get("segments") or []
    if not segments:
        return None

    if req.mode == "translation_cover" and translated_txt is not None:
        lines = _split_translated_lines(translated_txt)
        if len(lines) != len(segments):
            log.warning(
                "translation lines (%d) != segments (%d); padding/truncating",
                len(lines),
                len(segments),
            )
            lines = (lines + [""] * len(segments))[: len(segments)]
        target_lang_code = _xtts_lang_code(req.target_language or "en")
    else:
        # ai_cover mode: re-sing original text in source language
        lines = [seg["text"] for seg in segments]
        target_lang_code = transcript_json.get("language") or "en"
        target_lang_code = _xtts_lang_code(target_lang_code)

    out_dir = job.dir / "synth"
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest: List[Dict] = []
    for i, (seg, text) in enumerate(zip(segments, lines)):
        text = text.strip()
        if not text:
            continue
        out_wav = out_dir / f"seg_{i:04d}.wav"
        try:
            await asyncio.to_thread(
                _synth_segment_sync,
                text,
                str(out_wav),
                speaker_wav=str(vocals),
                language=target_lang_code,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("xtts segment %d failed: %s", i, exc)
            continue
        manifest.append(
            {
                "index": i,
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": text,
                "wav": out_wav.name,
            }
        )
        if (i + 1) % 5 == 0 or i + 1 == len(segments):
            job.update(progress=0.55 + 0.10 * ((i + 1) / max(1, len(segments))))

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps({"segments": manifest, "language": target_lang_code}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"manifest": manifest_path, "dir": out_dir}
