"""Hermes Worker — runtime configuration.

Reads from environment (or .env via python-dotenv if installed).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val


def _env_int(name: str, default: int) -> int:
    val = _env(name)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    val = _env(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


# --- Auth ----------------------------------------------------------------
AUTH_TOKEN: str = _env("HERMES_AUTH_TOKEN", "") or ""

# --- Storage -------------------------------------------------------------
DATA_DIR: Path = Path(_env("HERMES_DATA_DIR", "/data") or "/data")
JOBS_DIR: Path = DATA_DIR / "jobs"
VOICES_DIR: Path = DATA_DIR / "voices"
MODELS_DIR: Path = DATA_DIR / "models"
CACHE_DIR: Path = DATA_DIR / "cache"

for _d in (JOBS_DIR, VOICES_DIR, MODELS_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- Pipeline tunables ---------------------------------------------------
DEMUCS_MODEL: str = _env("HERMES_DEMUCS_MODEL", "htdemucs_ft") or "htdemucs_ft"
WHISPER_MODEL: str = _env("HERMES_WHISPER_MODEL", "large-v3") or "large-v3"
WHISPER_DEVICE: str = _env("HERMES_WHISPER_DEVICE", "cuda") or "cuda"
WHISPER_COMPUTE: str = _env("HERMES_WHISPER_COMPUTE", "float16") or "float16"
XTTS_MODEL: str = _env("HERMES_XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2") or "tts_models/multilingual/multi-dataset/xtts_v2"
RVC_DEVICE: str = _env("HERMES_RVC_DEVICE", "cuda:0") or "cuda:0"
TARGET_LUFS: float = float(_env("HERMES_TARGET_LUFS", "-14") or -14)
MAX_DURATION_SEC: int = _env_int("HERMES_MAX_DURATION_SEC", 600)  # 10 min cap
MAX_FILE_SIZE_MB: int = _env_int("HERMES_MAX_FILE_SIZE_MB", 100)
MAX_CONCURRENT_JOBS: int = _env_int("HERMES_MAX_CONCURRENT_JOBS", 1)
JOB_TTL_HOURS: int = _env_int("HERMES_JOB_TTL_HOURS", 24)

# --- Translation -------------------------------------------------------------
OPENAI_API_KEY: Optional[str] = _env("OPENAI_API_KEY")
OPENAI_BASE_URL: str = _env("OPENAI_BASE_URL", "https://api.openai.com/v1") or "https://api.openai.com/v1"
TRANSLATE_MODEL: str = _env("HERMES_TRANSLATE_MODEL", "gpt-4o-mini") or "gpt-4o-mini"

# --- Server -----------------------------------------------------------------
HOST: str = _env("HERMES_HOST", "0.0.0.0") or "0.0.0.0"
PORT: int = _env_int("HERMES_PORT", 8000)
LOG_LEVEL: str = _env("HERMES_LOG_LEVEL", "info") or "info"

# --- Feature toggles ---------------------------------------------------------
ENABLE_XTTS: bool = _env_bool("HERMES_ENABLE_XTTS", True)
ENABLE_RVC: bool = _env_bool("HERMES_ENABLE_RVC", True)
ENABLE_BASIC_PITCH: bool = _env_bool("HERMES_ENABLE_BASIC_PITCH", True)
ENABLE_TRANSLATION: bool = _env_bool("HERMES_ENABLE_TRANSLATION", True)


def public_health() -> dict:
    return {
        "demucs_model": DEMUCS_MODEL,
        "whisper_model": WHISPER_MODEL,
        "xtts_model": XTTS_MODEL,
        "max_duration_sec": MAX_DURATION_SEC,
        "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
        "features": {
            "xtts": ENABLE_XTTS,
            "rvc": ENABLE_RVC,
            "basic_pitch": ENABLE_BASIC_PITCH,
            "translation": ENABLE_TRANSLATION and bool(OPENAI_API_KEY),
        },
    }
