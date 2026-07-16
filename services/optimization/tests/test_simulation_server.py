"""HTTP surface + job store tests: async submit/poll round trip, German
400/404/429 bodies, saturation guard, the input cache. The runner is stubbed
- no solver, no DB, fully offline."""

from __future__ import annotations

import http.client
import json
import threading
import time

import pytest

from voltpilot_optimization.simulation.jobs import (
    BUSY_MESSAGE,
    JobStore,
    TooBusyError,
)
from voltpilot_optimization.simulation.request import parse_request
from voltpilot_optimization.simulation.server import serve


def valid_doc(capacity: float = 10.0) -> dict:
    return {
        "year": 2025,
        "plant": {"pvKwp": 10.0, "latitude": 52.52, "longitude": 13.41},
        "consumption": {"annualKwh": 4500},
        "battery": {"capacityKwh": capacity},
    }


class StubRunner:
    """Deterministic fake of run_simulation with an optional gate so tests
    can hold the single worker busy."""

    def __init__(self, gate: threading.Event | None = None):
        self.gate = gate
        self.calls = 0

    def __call__(self, request, publish):
        self.calls += 1
        publish(0.5, {"halb": True})
        if self.gate is not None:
            assert self.gate.wait(timeout=10)
        return {"scenarios": {}, "headline": {"gesamtVorteilEur": 42.0}}


@pytest.fixture
def server():
    runner = StubRunner()
    store = JobStore(runner)
    httpd = serve(store, port=0, bind="127.0.0.1")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd, store, runner
    httpd.shutdown()


def _request(httpd, method: str, path: str, body: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
    payload = json.dumps(body) if body is not None else None
    conn.request(method, path, body=payload)
    resp = conn.getresponse()
    doc = json.loads(resp.read().decode("utf-8"))
    conn.close()
    return resp.status, doc


def _wait_done(httpd, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, doc = _request(httpd, "GET", f"/simulations/{job_id}")
        assert status == 200
        if doc["status"] in ("done", "failed"):
            return doc
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_submit_poll_round_trip(server):
    httpd, _store, _runner = server
    status, doc = _request(httpd, "POST", "/simulations", valid_doc())
    assert status == 202
    job_id = doc["simulationId"]
    final = _wait_done(httpd, job_id)
    assert final["status"] == "done"
    assert final["progress"] == 1.0
    assert final["result"]["headline"]["gesamtVorteilEur"] == 42.0


def test_invalid_body_and_unknown_job(server):
    httpd, _store, _runner = server
    status, doc = _request(httpd, "POST", "/simulations", {"plant": {}})
    assert status == 400
    assert "angeben" in doc["message"] or "Ungültig" in doc["message"]
    status, doc = _request(httpd, "GET", "/simulations/" + "0" * 32)
    assert status == 404
    assert "nicht gefunden" in doc["message"]
    status, _ = _request(httpd, "GET", "/nope")
    assert status == 404
    status, doc = _request(httpd, "POST", "/simulations", None)
    assert status == 400


def test_health(server):
    httpd, _store, _runner = server
    status, doc = _request(httpd, "GET", "/health")
    assert status == 200 and doc == {"status": "ok"}


def test_cache_makes_repeat_requests_instant(server):
    httpd, _store, runner = server
    _, doc = _request(httpd, "POST", "/simulations", valid_doc())
    _wait_done(httpd, doc["simulationId"])
    assert runner.calls == 1
    status, doc = _request(httpd, "POST", "/simulations", valid_doc())
    assert status == 202
    # Same normalized inputs: answered from the cache, no second run.
    final = _request(httpd, "GET", f"/simulations/{doc['simulationId']}")[1]
    assert final["status"] == "done"
    assert runner.calls == 1
    # A different capacity is a different key and runs again.
    _, doc = _request(httpd, "POST", "/simulations", valid_doc(capacity=12.0))
    _wait_done(httpd, doc["simulationId"])
    assert runner.calls == 2


def test_saturation_returns_429_with_german_message():
    gate = threading.Event()
    store = JobStore(StubRunner(gate), max_queue_depth=2)
    try:
        ids = []
        # One running + two queued fit; the next submit is refused.
        for i in range(3):
            ids.append(store.submit(parse_request(valid_doc(capacity=10.0 + i))))
        with pytest.raises(TooBusyError, match="zu viele"):
            store.submit(parse_request(valid_doc(capacity=99.0)))
        assert BUSY_MESSAGE.startswith("Es laufen")
    finally:
        gate.set()


def test_progressive_result_is_visible_while_running():
    gate = threading.Event()
    store = JobStore(StubRunner(gate))
    job_id = store.submit(parse_request(valid_doc()))
    try:
        deadline = time.monotonic() + 5
        snapshot = None
        while time.monotonic() < deadline:
            snapshot = store.get(job_id)
            if snapshot and snapshot.get("result"):
                break
            time.sleep(0.01)
        assert snapshot["status"] == "running"
        assert snapshot["progress"] == 0.5
        assert snapshot["result"] == {"halb": True}
    finally:
        gate.set()


def test_failed_job_reports_its_message():
    def boom(request, publish):
        raise RuntimeError("Für das Jahr 2025 liegen nur 3% der Börsenpreise vor.")

    store = JobStore(boom)
    job_id = store.submit(parse_request(valid_doc()))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        snapshot = store.get(job_id)
        if snapshot["status"] == "failed":
            break
        time.sleep(0.01)
    assert snapshot["status"] == "failed"
    assert "Börsenpreise" in snapshot["error"]
