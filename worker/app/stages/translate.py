"""Stage 4 — translate lyrics while keeping syllable count / line timing.

Calls an OpenAI-compatible chat completions endpoint (configurable via
``OPENAI_BASE_URL``). If the API key is missing or the call fails we leave
the source lyrics untouched so the pipeline can still complete.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional

import httpx

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.translate")


LANG_MAP = {
    "id": "Indonesian",
    "in": "Indonesian",
    "indonesian": "Indonesian",
    "en": "English",
    "english": "English",
    "ru": "Russian",
    "russian": "Russian",
    "es": "Spanish",
    "spanish": "Spanish",
    "fr": "French",
    "french": "French",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "zh": "Chinese (Mandarin)",
    "chinese": "Chinese (Mandarin)",
    "de": "German",
    "german": "German",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "it": "Italian",
    "italian": "Italian",
    "ar": "Arabic",
    "arabic": "Arabic",
    "hi": "Hindi",
    "hindi": "Hindi",
    "tr": "Turkish",
    "turkish": "Turkish",
}


def _resolve_language(code_or_name: str) -> str:
    key = code_or_name.strip().lower()
    return LANG_MAP.get(key, code_or_name)


def _syllable_estimate(line: str) -> int:
    """Rough English-leaning syllable estimator. Good enough as guidance."""
    line = line.lower()
    line = re.sub(r"[^a-zA-Zàâäáåãèéêëìíîïòóôöùúûüýñç' ]", " ", line)
    words = [w for w in line.split() if w]
    total = 0
    for w in words:
        groups = re.findall(r"[aeiouyàâäáåãèéêëìíîïòóôöùúûüýy]+", w)
        n = max(1, len(groups))
        if w.endswith("e") and n > 1:
            n -= 1
        total += n
    return total


async def _chat_completion(messages: List[Dict], *, model: str, timeout: int = 60) -> str:
    if not config.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set on worker.")
    url = config.OPENAI_BASE_URL.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


SYSTEM_PROMPT = (
    "You are a professional song-lyric translator and adapter. "
    "Your goal: rewrite a song's lyrics into the requested target language so "
    "the singer can sing the new lyrics over the original melody without "
    "changing notes. Constraints: keep syllable count per line within ±1 of the "
    "source; preserve rhyme pattern where natural; preserve emotional tone and "
    "imagery; never add commentary; never re-order lines; one output line per "
    "input line. Output STRICT JSON of the shape: "
    '{"lines": [{"source": "<src>", "translated": "<tgt>", "src_syllables": int, "tgt_syllables": int}]}'
)


async def run(
    job: Job,
    transcript: Dict[str, Path],
) -> Optional[Path]:
    """Translate the transcript .txt to the requested target language.

    No-op when:
        - ``target_language`` is missing on the request
        - translation is disabled
        - the API key is missing
    """
    req = job.request
    if not req.target_language:
        return None
    if not config.ENABLE_TRANSLATION or not config.OPENAI_API_KEY:
        log.warning("translation skipped: feature disabled or missing API key")
        return None

    job.update(
        status="translating",
        stage="translate",
        progress=0.40,
        message=f"Translating lyrics to {_resolve_language(req.target_language)}…",
    )

    src_text = (transcript["txt"]).read_text(encoding="utf-8")
    src_lines = [ln for ln in src_text.splitlines() if ln.strip()]
    if not src_lines:
        return None

    target_lang = _resolve_language(req.target_language)
    user_msg = json.dumps(
        {
            "target_language": target_lang,
            "lines": [
                {
                    "index": i,
                    "text": line,
                    "approx_syllables": _syllable_estimate(line),
                }
                for i, line in enumerate(src_lines)
            ],
        },
        ensure_ascii=False,
    )

    try:
        raw = await _chat_completion(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            model=config.TRANSLATE_MODEL,
            timeout=90,
        )
        parsed = json.loads(raw)
        lines = parsed.get("lines") or []
        translated_lines = [str(item.get("translated") or item.get("text") or "") for item in lines]
        # Fall back if model returned wrong number of lines
        if len(translated_lines) != len(src_lines):
            log.warning(
                "translator returned %d lines for %d source lines — padding/truncating",
                len(translated_lines),
                len(src_lines),
            )
            translated_lines = (translated_lines + [""] * len(src_lines))[: len(src_lines)]
    except Exception as exc:  # noqa: BLE001
        log.exception("translation failed: %s", exc)
        return None

    out = job.dir / "transcript" / f"lyrics.{req.target_language}.txt"
    out.write_text("\n".join(translated_lines) + "\n", encoding="utf-8")

    # Also write a translated SRT preserving original timings.
    try:
        srt_path = transcript["srt"]
        translated_srt = _rewrite_srt(srt_path, translated_lines)
        out_srt = job.dir / "transcript" / f"lyrics.{req.target_language}.srt"
        out_srt.write_text(translated_srt, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        log.warning("translated SRT generation failed: %s", exc)

    return out


def _rewrite_srt(src_srt: Path, translated_lines: List[str]) -> str:
    src = src_srt.read_text(encoding="utf-8").splitlines()
    blocks = _split_srt_blocks(src)
    out_blocks: List[str] = []
    for i, block in enumerate(blocks):
        if i >= len(translated_lines):
            continue
        header = block[:2]  # index + timestamp
        out_blocks.append("\n".join([*header, translated_lines[i], ""]))
    return "\n".join(out_blocks)


def _split_srt_blocks(lines: List[str]) -> List[List[str]]:
    blocks: List[List[str]] = []
    cur: List[str] = []
    for ln in lines:
        if not ln.strip():
            if cur:
                blocks.append(cur)
                cur = []
        else:
            cur.append(ln)
    if cur:
        blocks.append(cur)
    return blocks
