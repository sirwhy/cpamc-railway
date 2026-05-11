"""Hermes Worker — FastAPI entrypoint.

Routes (all require Bearer auth except ``/healthz``):

* ``GET  /healthz``                          → liveness + config snapshot
* ``POST /v1/cover``                         → submit a job
* ``GET  /v1/jobs``                          → list jobs (optional user filter)
* ``GET  /v1/jobs/{job_id}/status``          → job status + artifacts
* ``POST /v1/jobs/{job_id}/cancel``          → cancel job
* ``GET  /v1/jobs/{job_id}/result/{file}``   → download artifact by filename
* ``GET  /v1/voices``                        → list registered RVC voices
* ``POST /v1/voices``                        → register a voice (download .pth/.index)
* ``DELETE /v1/voices/{name}``               → remove a voice from registry
* ``POST /v1/upload``                        → upload a binary file, returns upload_id
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
from pathlib import Path
from typing import Optional

from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, JSONResponse

from . import config, voices
from .auth import require_token
from .jobs import manager as job_manager
from .pipeline import run_pipeline
from .schemas import (
    CoverRequest,
    CoverResponse,
    HealthResponse,
    JobStatusResponse,
    JobsListResponse,
    VoiceModel,
    VoiceRegisterRequest,
    VoicesResponse,
)

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
log = logging.getLogger("hermes.main")

VERSION = "0.1.0"

app = FastAPI(title="Hermes Worker", version=VERSION)


_GC_INTERVAL_SEC = 3600  # 1h is fine; TTL is in hours and disk grows slowly


async def _gc_loop() -> None:
    """Periodically delete finished jobs older than HERMES_JOB_TTL_HOURS."""
    while True:
        try:
            await asyncio.sleep(_GC_INTERVAL_SEC)
            removed = job_manager.gc()
            if removed:
                log.info("gc: removed %d expired job(s)", removed)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover — never let GC kill the loop
            log.exception("gc loop iteration failed")


@app.on_event("startup")
async def _startup() -> None:
    job_manager.set_runner(run_pipeline)
    job_manager.load_persisted()
    await voices.initialize()
    await job_manager.start()
    # Run one GC sweep immediately so restarts also clean up stale jobs,
    # then schedule the recurring loop.
    try:
        job_manager.gc()
    except Exception:
        log.exception("initial gc sweep failed")
    app.state.gc_task = asyncio.create_task(_gc_loop())
    log.info("hermes worker %s ready (data=%s)", VERSION, config.DATA_DIR)


@app.on_event("shutdown")
async def _shutdown() -> None:
    task = getattr(app.state, "gc_task", None)
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(ok=True, version=VERSION, config=config.public_health())


# ---------- Jobs ----------------------------------------------------------


@app.post("/v1/cover", response_model=CoverResponse, dependencies=[Depends(require_token)])
async def submit_cover(req: CoverRequest) -> CoverResponse:
    if not (req.source_url or req.source_file_id):
        raise HTTPException(400, detail="Either source_url or source_file_id is required.")
    if req.mode == "translation_cover" and not req.target_language:
        raise HTTPException(400, detail="target_language is required for translation_cover.")
    job = await job_manager.enqueue(req)
    # Naive ETA: 60s baseline + 60s per requested output kind
    eta = 60 + 60 * max(1, len(req.output_bundle or []))
    return CoverResponse(
        job_id=job.job_id,
        status="queued",  # type: ignore[arg-type]
        eta_seconds=eta,
        message="Job queued.",
    )


@app.get("/v1/jobs", response_model=JobsListResponse, dependencies=[Depends(require_token)])
async def list_jobs(
    user_id: Optional[str] = Query(default=None),
    limit: int = Query(default=10, ge=1, le=100),
) -> JobsListResponse:
    items = job_manager.list_for_user(user_id, limit)
    return JobsListResponse(jobs=[j.to_response() for j in items])


@app.get("/v1/jobs/{job_id}/status", response_model=JobStatusResponse, dependencies=[Depends(require_token)])
async def job_status(job_id: str) -> JobStatusResponse:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(404, detail=f"Job {job_id} not found.")
    return job.to_response()


@app.post("/v1/jobs/{job_id}/cancel", response_model=JobStatusResponse, dependencies=[Depends(require_token)])
async def cancel(job_id: str) -> JobStatusResponse:
    job = await job_manager.cancel(job_id)
    if job is None:
        raise HTTPException(404, detail=f"Job {job_id} not found.")
    return job.to_response()


@app.get("/v1/jobs/{job_id}/result/{filename}", dependencies=[Depends(require_token)])
async def download(job_id: str, filename: str) -> FileResponse:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(404, detail=f"Job {job_id} not found.")
    # Allow downloading anything under <job.dir>/output/ OR any artifact we've
    # exposed (which lives elsewhere on disk).
    safe = Path(filename).name  # no traversal
    candidates = [job.dir / "output" / safe]
    for art in job.artifacts:
        if art.filename == safe:
            candidates.append(job.dir / art.filename)  # legacy
            # Find the actual on-disk path matching this artifact filename
            for p in job.dir.rglob(safe):
                candidates.append(p)
            break
    for c in candidates:
        if c.exists() and c.is_file():
            return FileResponse(c, filename=c.name)
    raise HTTPException(404, detail=f"Artifact {filename} not found for job {job_id}.")


# ---------- Voices --------------------------------------------------------


@app.get("/v1/voices", response_model=VoicesResponse, dependencies=[Depends(require_token)])
async def get_voices() -> VoicesResponse:
    return VoicesResponse(voices=voices.list_voices())


@app.post("/v1/voices", response_model=VoiceModel, dependencies=[Depends(require_token)])
async def post_voice(req: VoiceRegisterRequest) -> VoiceModel:
    try:
        return await voices.register_voice(
            name=req.name,
            model_url=req.model_url,
            index_url=req.index_url,
            language_hint=req.language_hint,
            description=req.description,
        )
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@app.delete("/v1/voices/{name}", dependencies=[Depends(require_token)])
async def delete_voice(name: str) -> JSONResponse:
    ok = voices.remove_voice(name)
    if not ok:
        raise HTTPException(404, detail=f"Voice '{name}' not found.")
    return JSONResponse({"ok": True, "removed": name})


# ---------- Upload --------------------------------------------------------


@app.post("/v1/upload", dependencies=[Depends(require_token)])
async def upload_audio(file: UploadFile = File(...)) -> JSONResponse:
    upload_id = secrets.token_hex(8)
    suffix = Path(file.filename or "audio.bin").suffix or ".bin"
    cache_dir = config.CACHE_DIR / "uploads"
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / f"{upload_id}{suffix}"
    # Enforce size limit while streaming
    max_bytes = config.MAX_FILE_SIZE_MB * 1024 * 1024
    total = 0
    with open(dest, "wb") as fp:
        while True:
            chunk = await file.read(1024 * 256)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                fp.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Upload exceeds {config.MAX_FILE_SIZE_MB} MB limit.",
                )
            fp.write(chunk)
    return JSONResponse(
        {
            "ok": True,
            "upload_id": f"{upload_id}{suffix}",
            "filename": file.filename,
            "size_bytes": total,
        }
    )
