"""Async simulation jobs: one worker, small queue, TTL, result cache.

Design report §3: a simulation burns all its workers for minutes, so exactly
ONE job runs at a time; a small queue (depth 4) absorbs bursts and anything
beyond is refused with a German 429 message. Results live 1 h (V1 is
stateless - nothing persisted); a normalized-input cache makes repeated runs
(the sales demo case) instant.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

from voltpilot_optimization.simulation.request import SimulationRequest

logger = logging.getLogger("voltpilot.simulation.jobs")

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

JOB_TTL_SECONDS = 3600
MAX_QUEUE_DEPTH = 4
CACHE_SIZE = 32

BUSY_MESSAGE = (
    "Es laufen gerade zu viele Simulationen. Bitte versuchen Sie es in "
    "wenigen Minuten erneut."
)


class TooBusyError(RuntimeError):
    """Queue full - the caller maps this onto HTTP 429."""


@dataclass
class Job:
    id: str
    request: SimulationRequest
    status: str = STATUS_QUEUED
    progress: float = 0.0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)

    def snapshot(self) -> dict:
        doc: dict = {"status": self.status, "progress": round(self.progress, 3)}
        if self.result is not None:
            doc["result"] = self.result
        if self.error is not None:
            doc["error"] = self.error
        return doc


class JobStore:
    """Thread-safe job registry + single-worker execution + result cache.

    ``runner`` is :func:`voltpilot_optimization.simulation.runner.run_simulation`
    shaped: ``runner(request, publish) -> result``. Kept injectable so the
    HTTP layer is testable without solving anything.
    """

    def __init__(
        self,
        runner: Callable[[SimulationRequest, Callable[[float, dict], None]], dict],
        max_queue_depth: int = MAX_QUEUE_DEPTH,
        ttl_seconds: float = JOB_TTL_SECONDS,
    ) -> None:
        self._runner = runner
        self._max_queue = max_queue_depth
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._queue: list[str] = []
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._worker = threading.Thread(
            target=self._work, name="simulation-worker", daemon=True
        )
        self._wake = threading.Condition(self._lock)
        self._worker.start()

    def submit(self, request: SimulationRequest) -> str:
        """Queue a job (or answer instantly from the cache); returns its id."""
        job_id = uuid.uuid4().hex
        with self._lock:
            self._purge_locked()
            cached = self._cache.get(request.cache_key())
            job = Job(id=job_id, request=request)
            if cached is not None:
                job.status = STATUS_DONE
                job.progress = 1.0
                job.result = cached
                self._jobs[job_id] = job
                logger.info(
                    "job.cache_hit", extra={"context": {"job_id": job_id}}
                )
                return job_id
            queued = sum(
                1 for j in self._jobs.values()
                if j.status in (STATUS_QUEUED, STATUS_RUNNING)
            )
            if queued > self._max_queue:
                raise TooBusyError(BUSY_MESSAGE)
            self._jobs[job_id] = job
            self._queue.append(job_id)
            self._wake.notify()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            self._purge_locked()
            job = self._jobs.get(job_id)
            return job.snapshot() if job else None

    def _purge_locked(self) -> None:
        cutoff = time.monotonic() - self._ttl
        stale = [
            jid
            for jid, job in self._jobs.items()
            if job.created_at < cutoff
            and job.status in (STATUS_DONE, STATUS_FAILED)
        ]
        for jid in stale:
            del self._jobs[jid]

    def _work(self) -> None:
        while True:
            with self._lock:
                while not self._queue:
                    self._wake.wait()
                job_id = self._queue.pop(0)
                job = self._jobs.get(job_id)
                if job is None:
                    continue
                job.status = STATUS_RUNNING
            self._run_one(job)

    def _run_one(self, job: Job) -> None:
        def publish(progress: float, result: dict) -> None:
            # The runner keeps mutating its own dict; snapshot a consistent
            # deep copy (publish fires ~once per chunk, so the JSON round
            # trip is cheap) so a concurrent GET never serializes a torn doc.
            snapshot = json.loads(json.dumps(result))
            with self._lock:
                job.progress = min(max(progress, 0.0), 1.0)
                job.result = snapshot

        try:
            result = self._runner(job.request, publish)
            with self._lock:
                job.result = result
                job.progress = 1.0
                job.status = STATUS_DONE
                key = job.request.cache_key()
                self._cache[key] = result
                self._cache.move_to_end(key)
                while len(self._cache) > CACHE_SIZE:
                    self._cache.popitem(last=False)
            logger.info("job.done", extra={"context": {"job_id": job.id}})
        except Exception as exc:  # noqa: BLE001 - job isolation boundary
            logger.warning(
                "job.failed",
                extra={"context": {"job_id": job.id, "error": str(exc)}},
            )
            with self._lock:
                job.status = STATUS_FAILED
                job.error = str(exc)
