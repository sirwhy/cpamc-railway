"""Stage 1 — fetch source audio from YouTube/URL/upload-id."""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from .. import config
from ..jobs import Job

log = logging.getLogger("hermes.stage.download")

_ALLOWED_URL_SCHEMES = frozenset({"http", "https"})


def _which(binary: str) -> Optional[str]:
    return shutil.which(binary)


async def _run(cmd: list, cwd: Optional[Path] = None, timeout: int = 600) -> str:
    log.info("$ %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"download timeout after {timeout}s: {cmd}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({proc.returncode}): {' '.join(cmd)}\n{out.decode(errors='ignore')[-2000:]}"
        )
    return out.decode(errors="ignore")


async def run(job: Job) -> Path:
    """Resolve job's source to a single audio file inside the job dir.

    Returns the absolute path to the source audio (WAV / M4A / MP3).
    """
    job.update(status="downloading", stage="download", progress=0.05, message="Fetching source audio…")

    out_dir = job.dir / "source"
    out_dir.mkdir(parents=True, exist_ok=True)

    req = job.request

    # --- Branch A: pre-uploaded file via /v1/upload --------------------
    if req.source_file_id:
        # Strip any directory components and resolve to confirm the file
        # really lives under uploads_root (defence against ../ traversal).
        safe_name = Path(req.source_file_id).name
        uploads_root = (config.CACHE_DIR / "uploads").resolve()
        upload_path = (uploads_root / safe_name).resolve()
        try:
            upload_path.relative_to(uploads_root)
        except ValueError as exc:
            raise RuntimeError(
                f"Invalid source_file_id '{req.source_file_id}': path traversal rejected."
            ) from exc
        if not upload_path.exists() or not upload_path.is_file():
            raise RuntimeError(
                f"source_file_id '{req.source_file_id}' not found in upload cache."
            )
        # Copy into job dir so cleanup doesn't pull from under us
        dest = out_dir / upload_path.name
        shutil.copy2(upload_path, dest)
        return dest

    # --- Branch B: URL via yt-dlp -------------------------------------
    if req.source_url:
        # Reject non-http(s) schemes — yt-dlp also supports file:// and
        # local paths which would let a malicious caller read disk.
        parsed = urlparse(req.source_url)
        if parsed.scheme.lower() not in _ALLOWED_URL_SCHEMES:
            raise RuntimeError(
                f"source_url scheme '{parsed.scheme}' not allowed (use http/https)."
            )
        if not _which("yt-dlp"):
            raise RuntimeError(
                "yt-dlp not installed on worker. Run: pip install yt-dlp"
            )
        out_template = str(out_dir / "source.%(ext)s")
        # NOTE: pass URL after `--` so yt-dlp won't interpret a hostile
        # leading-dash URL as a flag (e.g. --batch-file, --exec).
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--max-filesize",
            f"{config.MAX_FILE_SIZE_MB}M",
            "--no-warnings",
            "-q",
            "-x",  # extract audio
            "--audio-format",
            "wav",
            "--audio-quality",
            "0",
            "-o",
            out_template,
            "--",
            req.source_url,
        ]
        await _run(cmd, timeout=600)
        # Find produced file
        for cand in out_dir.glob("source.*"):
            if cand.is_file() and cand.suffix.lower() in {".wav", ".m4a", ".mp3", ".opus", ".ogg", ".flac"}:
                return cand
        raise RuntimeError("yt-dlp produced no audio file.")

    raise RuntimeError("Neither source_url nor source_file_id provided.")
