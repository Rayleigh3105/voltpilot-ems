"""Container runtime helpers for the long-running ``serve`` loops.

Kubernetes has no ``depends_on`` and it SIGKILLs a pod that ignores SIGTERM
once ``terminationGracePeriodSeconds`` expires. Three container facts drive
this module; the per-service contract lives in ``docs/k8s-readiness.md``.

1. **PID 1 does not get the kernel's default signal actions.** Linux delivers
   a signal to PID 1 only when that process installed a handler for it, so a
   Python entrypoint that never calls ``signal.signal(SIGTERM, ...)`` simply
   IGNORES SIGTERM inside a container: ``docker stop`` / a k8s rollout then
   always ends in SIGKILL after the full grace period.
   :meth:`ServeRuntime.install_signal_handlers` installs it, and
   :meth:`ServeRuntime.sleep` makes the between-cycles wait interruptible so
   the loop leaves within milliseconds instead of up to six hours.
2. **A failed first cycle must not sleep the full interval.** The collectors
   sleep their steady-state cadence between cycles (up to 6 h for
   market-data). Without ``depends_on`` the database simply is not up yet on a
   cluster cold start, the first cycle fails, and the service would then do
   nothing at all for hours. :meth:`ServeRuntime.next_delay` backs a FAILING
   loop off exponentially from a few seconds instead, and returns to the
   baseline cadence the moment a cycle succeeds.
3. **Probes need an endpoint.** :func:`serve_health` exposes the loop's own
   state over stdlib HTTP so a manifest can point a probe at it.

Stdlib only, no service logic - deliberately duplicated byte-for-byte into
``voltpilot_optimization`` / ``voltpilot_forecast`` / ``voltpilot_market_data``
(three independent distributions with no shared package, so an import would be
a new build-time dependency). That is the repo's twin discipline; the drift
guard is ``services/optimization/tests/test_runtime.py``.
"""

from __future__ import annotations

import json
import logging
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("voltpilot.runtime")

#: First back-off after a failed cycle; doubles per consecutive failure.
FAILURE_BACKOFF_SECONDS = 5.0
#: Ceiling for the exponential back-off (also never exceeds the baseline).
MAX_FAILURE_BACKOFF_SECONDS = 300.0
#: Signals a container runtime uses to ask for a clean stop.
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)


class ServeRuntime:
    """Shutdown flag + cycle bookkeeping for one long-running ``serve`` loop.

    The loop shape every caller follows::

        runtime = ServeRuntime("market-data")
        runtime.install_signal_handlers()
        serve_health(runtime, health_port)
        while not runtime.stopping:
            try:
                run_one_cycle()
                runtime.record_success()
            except Exception as exc:
                runtime.record_failure(exc)
            if not runtime.sleep(runtime.next_delay(interval_seconds)):
                break
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._started_at = time.monotonic()
        self._cycles = 0
        self._consecutive_failures = 0
        self._last_cycle_ok: bool | None = None
        self._last_success_at: float | None = None
        self._last_cycle_duration_seconds: float | None = None
        self._last_error: str | None = None

    # ---- shutdown ---------------------------------------------------------

    def install_signal_handlers(self, signals=STOP_SIGNALS) -> None:
        """Make SIGTERM/SIGINT set the stop flag (see module docstring, 1).

        Must run on the main thread (``signal.signal`` refuses elsewhere); the
        CLI entrypoints always do. A platform without one of the signals is
        skipped rather than fatal.
        """
        for sig in signals:
            try:
                signal.signal(sig, self._on_signal)
            except (ValueError, OSError, RuntimeError):  # pragma: no cover
                logger.warning(
                    "runtime.signal_handler_unavailable",
                    extra={"context": {"service": self.name, "signal": int(sig)}},
                )

    def _on_signal(self, signum, _frame) -> None:
        self.request_stop(f"signal {int(signum)}")

    def request_stop(self, reason: str = "requested") -> None:
        if not self._stop.is_set():
            logger.info(
                "runtime.shutdown",
                extra={"context": {"service": self.name, "reason": reason}},
            )
        self._stop.set()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def sleep(self, seconds: float) -> bool:
        """Wait ``seconds``, but wake immediately on shutdown.

        Returns ``True`` when the full time elapsed (keep looping) and
        ``False`` when a stop was requested during the wait.
        """
        if seconds <= 0:
            return not self._stop.is_set()
        return not self._stop.wait(seconds)

    def wait_for_stop(self) -> None:
        """Block until a stop is requested - for event-driven servers whose
        own loop already blocks (``simulate-serve``'s ``serve_forever``)."""
        self._stop.wait()

    # ---- cycle bookkeeping ------------------------------------------------

    def record_success(self, duration_seconds: float | None = None) -> None:
        with self._lock:
            self._cycles += 1
            self._consecutive_failures = 0
            self._last_cycle_ok = True
            self._last_success_at = time.monotonic()
            self._last_cycle_duration_seconds = duration_seconds
            self._last_error = None

    def record_failure(self, error: BaseException | str, duration_seconds: float | None = None) -> None:
        with self._lock:
            self._cycles += 1
            self._consecutive_failures += 1
            self._last_cycle_ok = False
            self._last_error = str(error)
            self._last_cycle_duration_seconds = duration_seconds

    def next_delay(self, baseline_seconds: float) -> float:
        """Seconds to wait before the next cycle (see module docstring, 2)."""
        with self._lock:
            failures = self._consecutive_failures
        if failures <= 0:
            return baseline_seconds
        backoff = FAILURE_BACKOFF_SECONDS * (2 ** (failures - 1))
        return min(backoff, MAX_FAILURE_BACKOFF_SECONDS, baseline_seconds)

    def status(self) -> dict:
        """The document both health routes serve; also handy in logs."""
        with self._lock:
            cycles = self._cycles
            failures = self._consecutive_failures
            last_ok = self._last_cycle_ok
            last_success_at = self._last_success_at
            last_error = self._last_error
            cycle_duration = self._last_cycle_duration_seconds
        now = time.monotonic()
        if cycles == 0:
            state = "starting"
        elif failures == 0:
            state = "ok"
        else:
            state = "degraded"
        doc: dict = {
            "service": self.name,
            "status": state,
            "cycles": cycles,
            "consecutive_failures": failures,
            "uptime_seconds": round(now - self._started_at, 3),
            "stopping": self.stopping,
        }
        if last_ok is not None:
            doc["last_cycle_ok"] = last_ok
        if last_success_at is not None:
            doc["last_success_age_seconds"] = round(now - last_success_at, 3)
            doc["plan_age_seconds"] = round(now - last_success_at, 3)
        if cycle_duration is not None:
            doc["solve_duration_seconds"] = round(cycle_duration, 3)
        if last_error is not None:
            doc["last_error"] = last_error
        return doc


def make_health_handler(runtime: ServeRuntime):
    """Bind the probe handler class to a runtime.

    ``GET /health`` is the LIVENESS probe and answers 200 as long as the
    process is up - deliberately also while cycles fail, because restarting a
    collector never fixes an unreachable database and a 503 here would turn one
    DB blip into a fleet-wide restart storm. The body carries the real state.

    ``GET /ready`` is the READINESS probe: 503 until the loop completed its
    first cycle, 200 afterwards. So a rollout only counts a new collector pod
    as ready once its loop actually turns, without coupling readiness to
    upstream health.
    """

    class Handler(BaseHTTPRequestHandler):
        server_version = "voltpilot-health"

        def log_message(self, fmt, *args):  # route through logging, not stderr
            logger.debug("health " + fmt % args)

        def _send(self, status: int, doc: dict) -> None:
            body = json.dumps(doc).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib API
            doc = runtime.status()
            if self.path == "/health":
                self._send(200, doc)
                return
            if self.path == "/ready":
                ready = doc["cycles"] > 0 and not doc["stopping"]
                self._send(200 if ready else 503, doc)
                return
            self._send(404, {"message": "unknown path"})

    return Handler


def serve_health(
    runtime: ServeRuntime, port: int, bind: str = "0.0.0.0"
) -> ThreadingHTTPServer | None:
    """Start the probe endpoint on a daemon thread; ``port <= 0`` disables it.

    Binding is deliberately fail-fast: a collector whose probe port is taken
    would otherwise run invisibly to every manifest that points a probe at it.
    """
    if port <= 0:
        logger.info(
            "runtime.health_disabled", extra={"context": {"service": runtime.name}}
        )
        return None
    httpd = ThreadingHTTPServer((bind, port), make_health_handler(runtime))
    httpd.daemon_threads = True
    thread = threading.Thread(
        target=httpd.serve_forever, name=f"{runtime.name}-health", daemon=True
    )
    thread.start()
    logger.info(
        "runtime.health_listening",
        extra={"context": {"service": runtime.name, "port": port, "bind": bind}},
    )
    return httpd
