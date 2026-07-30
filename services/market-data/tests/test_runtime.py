"""The container runtime contract of the long-running `serve` loops.

Guards exactly what a Kubernetes manifest is allowed to assume about this
service (docs/k8s-readiness.md): SIGTERM really stops the loop, a failed cycle
retries in seconds instead of idling a full interval, and the probe routes say
something true. Pure stdlib, offline, no DB/broker.
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from voltpilot_market_data.runtime import ServeRuntime, make_health_handler, serve_health


def _get(port: int, path: str) -> tuple[int, dict]:
    """GET a probe route; a 503 arrives as HTTPError, which is a response too."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # 404/503 carry a body as well
        return exc.code, json.loads(exc.read().decode("utf-8"))


@contextlib.contextmanager
def _probe(runtime: ServeRuntime):
    """The probe routes on an ephemeral port (never the production default)."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_health_handler(runtime))
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


# ---- shutdown -------------------------------------------------------------------

def test_sigterm_sets_the_stop_flag_and_ends_the_wait():
    # The container fact this guards: a Python process running as PID 1 gets NO
    # default SIGTERM action from the kernel, so without an installed handler
    # the loop keeps sleeping and Kubernetes SIGKILLs it after the full grace
    # period. Sending the signal to ourselves proves the handler is wired.
    runtime = ServeRuntime("t")
    previous = signal.getsignal(signal.SIGTERM)
    try:
        runtime.install_signal_handlers()
        assert signal.getsignal(signal.SIGTERM) is not previous
        os.kill(os.getpid(), signal.SIGTERM)
        assert runtime.stopping is True
        # A pending stop must never enter another long sleep.
        started = time.monotonic()
        assert runtime.sleep(30) is False
        assert time.monotonic() - started < 1.0
    finally:
        signal.signal(signal.SIGTERM, previous)


def test_sleep_is_interrupted_while_it_is_already_waiting():
    # The 6 h / 15 min cadence must not delay a rollout: a stop requested while
    # the loop is mid-sleep has to return within milliseconds, not hours.
    runtime = ServeRuntime("t")
    threading.Timer(0.05, lambda: runtime.request_stop("test")).start()
    started = time.monotonic()
    assert runtime.sleep(30) is False
    assert time.monotonic() - started < 5.0


def test_wait_for_stop_returns_on_request():
    runtime = ServeRuntime("t")
    threading.Timer(0.05, lambda: runtime.request_stop("test")).start()
    started = time.monotonic()
    runtime.wait_for_stop()
    assert time.monotonic() - started < 5.0
    assert runtime.stopping is True


# ---- cold-start back-off --------------------------------------------------------

def test_failed_cycle_backs_off_in_seconds_not_a_full_interval():
    # Kubernetes has no depends_on: on a cluster cold start the DB is simply
    # not up yet, the first cycle fails, and sleeping the market-data baseline
    # (6 h) would leave the fleet without prices for the rest of the day.
    baseline = 21600.0
    runtime = ServeRuntime("t")
    runtime.record_failure(RuntimeError("connection refused"))
    assert runtime.next_delay(baseline) == 5.0
    runtime.record_failure(RuntimeError("connection refused"))
    assert runtime.next_delay(baseline) == 10.0
    runtime.record_failure(RuntimeError("connection refused"))
    assert runtime.next_delay(baseline) == 20.0


def test_backoff_is_capped_and_never_exceeds_the_baseline():
    runtime = ServeRuntime("t")
    for _ in range(20):
        runtime.record_failure("down")
    assert runtime.next_delay(21600.0) == 300.0
    # A service that cycles FASTER than the cap keeps its own cadence.
    assert runtime.next_delay(60.0) == 60.0


def test_a_successful_cycle_returns_to_the_baseline_cadence():
    runtime = ServeRuntime("t")
    runtime.record_failure("down")
    assert runtime.next_delay(900.0) == 5.0
    runtime.record_success()
    assert runtime.next_delay(900.0) == 900.0


# ---- probe routes ---------------------------------------------------------------

def test_health_stays_200_while_cycles_fail_and_ready_gates_on_the_first_cycle():
    runtime = ServeRuntime("collector")
    with _probe(runtime) as port:
        # Before the first cycle: alive, but not ready.
        status, doc = _get(port, "/health")
        assert status == 200
        assert doc["status"] == "starting"
        assert doc["service"] == "collector"
        assert _get(port, "/ready")[0] == 503

        runtime.record_success()
        assert _get(port, "/ready")[0] == 200
        assert _get(port, "/health")[1]["status"] == "ok"

        # A failing upstream must NOT restart the pod - restarting a collector
        # never fixes an unreachable database, and a 503 here would turn one DB
        # blip into a fleet-wide restart storm. Liveness stays 200, the body
        # tells the truth.
        runtime.record_failure(RuntimeError("db down"))
        status, doc = _get(port, "/health")
        assert status == 200
        assert doc["status"] == "degraded"
        assert doc["consecutive_failures"] == 1
        assert doc["last_error"] == "db down"
        assert doc["last_cycle_ok"] is False
        # ...but readiness still reflects that the loop turns.
        assert _get(port, "/ready")[0] == 200


def test_ready_drops_while_shutting_down_so_traffic_drains_first():
    runtime = ServeRuntime("collector")
    runtime.record_success()
    with _probe(runtime) as port:
        assert _get(port, "/ready")[0] == 200
        runtime.request_stop("test")
        assert _get(port, "/ready")[0] == 503
        assert _get(port, "/health")[0] == 200


def test_unknown_probe_path_is_404():
    runtime = ServeRuntime("collector")
    with _probe(runtime) as port:
        assert _get(port, "/nope")[0] == 404


def test_health_server_is_disabled_by_a_non_positive_port():
    # 0 must mean OFF, not "pick an ephemeral port" - the unit suites rely on it.
    assert serve_health(ServeRuntime("t"), 0) is None
    assert serve_health(ServeRuntime("t"), -1) is None
