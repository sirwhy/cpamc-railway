"""In-process job manager with on-disk persistence.

Simple but durable: every job has a directory under JOBS_DIR/<job_id>/ that
holds `state.json` (serialized JobStatusResponse) plus all stage artifacts.

A single-process asyncio loop runs at most MAX_CONCURRENT_JOBS jobs in
parallel. Re-queues survive restarts because state.json is loaded on boot.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional

from . import config
from .schemas import Artifact, CoverRequest, JobStatusResponse

log = logging.getLogger("hermes.jobs")

JobRunner = Callable[["Job"], Awaitable[None]]


def _now_iso() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


class Job:
    """Mutable in-memory job state + helpers to mirror to disk."""

    def __init__(self, job_id: str, request: CoverRequest):
        self.job_id = job_id
        self.request = request
        self.status: str = "queued"
        self.stage: Optional[str] = None
        self.progress: Optional[float] = 0.0
        self.message: Optional[str] = None
        self.artifacts: List[Artifact] = []
        self.created_at: float = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.error: Optional[str] = None
        self.cancel_requested: bool = False

    # ------------------------------------------------------------------
    @property
    def dir(self) -> Path:
        return config.JOBS_DIR / self.job_id

    @property
    def state_file(self) -> Path:
        return self.dir / "state.json"

    # ------------------------------------------------------------------
    def update(
        self,
        *,
        status: Optional[str] = None,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        message: Optional[str] = None,
    ) -> None:
        if status is not None:
            self.status = status
            if status not in {"queued"} and self.started_at is None:
                self.started_at = time.time()
            if status in {"done", "failed", "cancelled"}:
                self.finished_at = time.time()
        if stage is not None:
            self.stage = stage
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            self.message = message
        self.save()

    def add_artifact(self, artifact: Artifact) -> None:
        # Replace existing artifact with same kind (idempotent stages)
        self.artifacts = [a for a in self.artifacts if a.kind != artifact.kind]
        self.artifacts.append(artifact)
        self.save()

    # ------------------------------------------------------------------
    def to_response(self) -> JobStatusResponse:
        elapsed = None
        if self.started_at:
            end = self.finished_at or time.time()
            elapsed = int(end - self.started_at)
        return JobStatusResponse(
            job_id=self.job_id,
            status=self.status,  # type: ignore[arg-type]
            stage=self.stage,
            progress=self.progress,
            message=self.message,
            elapsed_seconds=elapsed,
            artifacts=self.artifacts or None,
            request=self.request,
        )

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = self.to_response().model_dump(mode="json")
        payload["_meta"] = {
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "cancel_requested": self.cancel_requested,
        }
        tmp = self.state_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.state_file)

    @classmethod
    def load(cls, state_file: Path) -> Optional["Job"]:
        try:
            payload = json.loads(state_file.read_text(encoding="utf-8"))
            req_data = payload.get("request") or {}
            request = CoverRequest(**req_data)
            job = cls(job_id=payload["job_id"], request=request)
            job.status = payload.get("status", "queued")
            job.stage = payload.get("stage")
            job.progress = payload.get("progress")
            job.message = payload.get("message")
            job.artifacts = [Artifact(**a) for a in payload.get("artifacts") or []]
            meta = payload.get("_meta", {})
            job.created_at = meta.get("created_at") or time.time()
            job.started_at = meta.get("started_at")
            job.finished_at = meta.get("finished_at")
            job.error = meta.get("error")
            job.cancel_requested = bool(meta.get("cancel_requested"))
            return job
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to load job state %s: %s", state_file, exc)
            return None


class JobManager:
    """Tracks jobs and dispatches them to the pipeline runner."""

    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._workers_started = False
        self._lock = asyncio.Lock()
        self._runner: Optional[JobRunner] = None

    # ------------------------------------------------------------------
    def set_runner(self, runner: JobRunner) -> None:
        self._runner = runner

    def load_persisted(self) -> None:
        """Load any state.json files from disk on boot."""
        if not config.JOBS_DIR.exists():
            return
        for jobdir in config.JOBS_DIR.iterdir():
            if not jobdir.is_dir():
                continue
            state = jobdir / "state.json"
            if not state.exists():
                continue
            job = Job.load(state)
            if job is None:
                continue
            # Any in-flight jobs from a crashed run are marked failed.
            if job.status not in {"done", "failed", "cancelled"}:
                job.update(
                    status="failed",
                    message="Worker restarted while job was running.",
                )
            self._jobs[job.job_id] = job

    async def start(self) -> None:
        if self._workers_started:
            return
        self._workers_started = True
        for _i in range(max(1, config.MAX_CONCURRENT_JOBS)):
            asyncio.create_task(self._worker_loop(_i))

    async def _worker_loop(self, idx: int) -> None:
        log.info("hermes worker %d started", idx)
        while True:
            job_id = await self._queue.get()
            try:
                job = self._jobs.get(job_id)
                if job is None or job.cancel_requested:
                    continue
                if self._runner is None:
                    job.update(status="failed", message="No pipeline runner registered.")
                    continue
                try:
                    await self._runner(job)
                except Exception as exc:  # noqa: BLE001
                    log.exception("job %s failed", job_id)
                    job.error = repr(exc)
                    job.update(status="failed", message=f"Pipeline error: {exc}")
            finally:
                self._queue.task_done()

    # ------------------------------------------------------------------
    async def enqueue(self, request: CoverRequest) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id=job_id, request=request)
        job.dir.mkdir(parents=True, exist_ok=True)
        job.save()
        async with self._lock:
            self._jobs[job_id] = job
        await self._queue.put(job_id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list_for_user(self, user_id: Optional[str], limit: int = 10) -> List[Job]:
        items = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        if user_id:
            items = [j for j in items if (j.request.user_id or "") == user_id]
        return items[: max(1, min(limit, 100))]

    async def cancel(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        if job.status in {"done", "failed", "cancelled"}:
            return job
        job.cancel_requested = True
        job.update(status="cancelled", message="Cancelled by user.")
        return job

    # ------------------------------------------------------------------
    def gc(self) -> int:
        """Delete on-disk artifacts of jobs older than JOB_TTL_HOURS."""
        cutoff = time.time() - config.JOB_TTL_HOURS * 3600
        removed = 0
        for job_id, job in list(self._jobs.items()):
            if job.finished_at and job.finished_at < cutoff:
                try:
                    for f in job.dir.glob("**/*"):
                        if f.is_file():
                            f.unlink()
                    for d in sorted(job.dir.glob("**/*"), reverse=True):
                        if d.is_dir():
                            d.rmdir()
                    job.dir.rmdir()
                except FileNotFoundError:
                    pass
                except OSError as e:
                    log.warning("gc partial for %s: %s", job_id, e)
                self._jobs.pop(job_id, None)
                removed += 1
        return removed


manager = JobManager()
