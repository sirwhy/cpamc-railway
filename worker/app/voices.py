"""Voice model registry — list, register, fetch RVC voices.

State stored at ``$HERMES_DATA_DIR/voices/registry.json`` plus actual
``.pth`` / ``.index`` files under the same directory. New voices may be
registered via the ``/v1/voices`` POST endpoint by providing public HTTPS
URLs to download; downloaded files are stored on disk and re-used.

This module is intentionally self-contained: it does NOT load PyTorch
weights into memory. ``rvc_engine`` (used by ``stages/voice.py``) reads
``.pth`` lazily right before inference.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Dict, List, Optional

import httpx

from . import config
from .schemas import VoiceModel

log = logging.getLogger("hermes.voices")

REGISTRY_FILE: Path = config.VOICES_DIR / "registry.json"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_\-\.]{1,63}$", re.IGNORECASE)


def _load_registry() -> Dict[str, VoiceModel]:
    if not REGISTRY_FILE.exists():
        return {}
    try:
        raw = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        return {name: VoiceModel(**data) for name, data in raw.items()}
    except Exception as exc:  # noqa: BLE001
        log.warning("voices registry corrupt: %s", exc)
        return {}


def _save_registry(reg: Dict[str, VoiceModel]) -> None:
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({k: v.model_dump(mode="json") for k, v in reg.items()}, indent=2),
        encoding="utf-8",
    )
    tmp.replace(REGISTRY_FILE)


def list_voices() -> List[VoiceModel]:
    reg = _load_registry()
    return sorted(reg.values(), key=lambda v: v.name.lower())


def get_voice(name: str) -> Optional[VoiceModel]:
    return _load_registry().get(name)


async def _download(url: str, dest: Path, max_bytes: Optional[int] = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"download failed {resp.status_code}: {url}")
            total = 0
            with open(dest, "wb") as fp:
                async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if max_bytes and total > max_bytes:
                        raise RuntimeError(
                            f"download exceeds {max_bytes // (1024 * 1024)}MB limit: {url}"
                        )
                    fp.write(chunk)


async def register_voice(
    *,
    name: str,
    model_url: str,
    index_url: Optional[str] = None,
    language_hint: Optional[str] = None,
    description: Optional[str] = None,
) -> VoiceModel:
    if not _NAME_RE.match(name):
        raise ValueError(
            "Invalid voice name. Must be 2-64 chars: alphanumerics, _, -, ."
        )

    target_dir = config.VOICES_DIR / name
    target_dir.mkdir(parents=True, exist_ok=True)
    model_path = target_dir / "model.pth"
    index_path = target_dir / "feature.index" if index_url else None

    max_model_bytes = 250 * 1024 * 1024  # 250 MB per .pth — generous
    max_index_bytes = 250 * 1024 * 1024

    try:
        await _download(model_url, model_path, max_model_bytes)
        if index_url and index_path is not None:
            await _download(index_url, index_path, max_index_bytes)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise

    voice = VoiceModel(
        name=name,
        description=description,
        language_hint=language_hint,
        model_path=str(model_path),
        index_path=str(index_path) if index_path else None,
        created_at=_dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    )

    reg = _load_registry()
    reg[name] = voice
    _save_registry(reg)
    return voice


def remove_voice(name: str) -> bool:
    reg = _load_registry()
    if name not in reg:
        return False
    reg.pop(name)
    _save_registry(reg)
    shutil.rmtree(config.VOICES_DIR / name, ignore_errors=True)
    return True


# Allow synchronous registration of pre-existing on-disk voices (for the
# admin install flow: copy a .pth into $DATA/voices/<name>/ and reload).
def scan_disk() -> int:
    reg = _load_registry()
    found = 0
    for entry in config.VOICES_DIR.iterdir():
        if not entry.is_dir():
            continue
        pth = entry / "model.pth"
        if not pth.exists():
            continue
        if entry.name in reg:
            continue
        reg[entry.name] = VoiceModel(
            name=entry.name,
            description="(auto-detected from disk)",
            model_path=str(pth),
            index_path=str(entry / "feature.index") if (entry / "feature.index").exists() else None,
            created_at=_dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        )
        found += 1
    if found:
        _save_registry(reg)
    return found


async def initialize() -> None:
    """Called on app boot."""
    await asyncio.to_thread(scan_disk)
