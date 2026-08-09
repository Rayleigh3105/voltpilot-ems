"""POST /replan - the D8 on-demand single-site replan (Verbrauchssteuerung
§13.4): a REAL cycle for one site on the solve surface, semaphore-bounded.

The safety property tested at the IMPORT level is the CONTRAST to the
what-if: replan deliberately reuses the engine's plan_site (persist +
publish - one cycle implementation, two callers), while whatif.py's own AST
guard (test_whatif.py) keeps the ephemeral path ephemeral - this suite
asserts that guard's subject is untouched by the replan work.
"""

from __future__ import annotations

import ast
import http.client
import json
import threading
import time
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import replan as replan_mod
from voltpilot_optimization import whatif
from voltpilot_optimization.inputs import SkipSite
from voltpilot_optimization.replan import (
    InvalidReplanRequest,
    ReplanDeps,
    ReplanUnavailable,
    UnknownReplanSite,
    parse_request,
    run_replan,
)
from voltpilot_optimization.simulation.jobs import JobStore, TooBusyError
from voltpilot_optimization.simulation.server import serve

SITE = UUID("00000000-0000-0000-0000-000000000002")


class _Plan:
    plan_id = UUID("11111111-2222-4333-8444-555555555555")
    generated_at = datetime(2026, 8, 10, 9, 0, tzinfo=timezone.utc)
    device_id = UUID("00000000-0000-0000-0000-000000000003")
    slots = [object()] * 96


# ---------------------------------------------------------------------------
# request parsing + the run itself
# ---------------------------------------------------------------------------


def test_parse_request_validates_the_site_id():
    assert parse_request({"site_id": str(SITE)}) == SITE
    assert parse_request({"siteId": str(SITE)}) == SITE
    for bad in [None, [], {}, {"site_id": 5}, {"site_id": "nicht-uuid"}]:
        with pytest.raises(InvalidReplanRequest):
            parse_request(bad)


def test_run_replan_reports_exactly_what_happened():
    deps = ReplanDeps(load_site=lambda sid: object(), plan=lambda site: _Plan(),
                      publishes=True, persists=True)
    out = run_replan(SITE, deps)
    assert out["siteId"] == str(SITE)
    assert out["planId"] == str(_Plan.plan_id)
    assert out["slots"] == 96
    assert out["persisted"] is True
    assert out["published"] is True


def test_run_replan_never_claims_a_publish_without_a_device_or_publisher():
    class DevicelessPlan(_Plan):
        device_id = None

    with_publisher = ReplanDeps(load_site=lambda sid: object(),
                                plan=lambda site: DevicelessPlan(), publishes=True)
    assert run_replan(SITE, with_publisher)["published"] is False

    without_publisher = ReplanDeps(load_site=lambda sid: object(),
                                   plan=lambda site: _Plan(), publishes=False)
    assert run_replan(SITE, without_publisher)["published"] is False


def test_unknown_site_and_skip_site_are_nameable_errors():
    with pytest.raises(UnknownReplanSite):
        run_replan(uuid4(), ReplanDeps(load_site=lambda sid: None, plan=lambda s: _Plan()))

    def skip(site):
        raise SkipSite("only 0 priced slots for zone DE-LU (need 16)")

    with pytest.raises(ReplanUnavailable, match="priced slots"):
        run_replan(SITE, ReplanDeps(load_site=lambda sid: object(), plan=skip))


# ---------------------------------------------------------------------------
# the import-graph contrast: replan REUSES the engine, whatif stays ephemeral
# ---------------------------------------------------------------------------


def test_replan_reuses_the_engine_cycle_and_whatif_stays_guarded():
    # One cycle implementation: replan.py imports the engine's plan_site.
    tree = ast.parse(open(replan_mod.__file__, encoding="utf-8").read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    assert any(m.endswith("engine") for m in imported), \
        "replan must reuse engine.plan_site - never a second planning path"

    # The what-if guard's SUBJECT is untouched: whatif.py still imports
    # neither persistence nor a publisher (test_whatif pins the rule itself).
    wtree = ast.parse(open(whatif.__file__, encoding="utf-8").read())
    wimported = set()
    for node in ast.walk(wtree):
        if isinstance(node, ast.Import):
            wimported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            wimported.add(node.module)
    forbidden = {"persistence", "publisher", "publisher_v2", "replan"}
    assert not {m for m in wimported if m.rsplit(".", 1)[-1] in forbidden}


# ---------------------------------------------------------------------------
# the HTTP route
# ---------------------------------------------------------------------------


@pytest.fixture
def server_with(request):
    def build(handler):
        store = JobStore(lambda req, publish: {})
        httpd = serve(store, port=0, bind="127.0.0.1", replan=handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        request.addfinalizer(httpd.shutdown)
        return httpd

    return build


def _post(httpd, path: str, body: dict):
    conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
    conn.request("POST", path, body=json.dumps(body))
    resp = conn.getresponse()
    doc = json.loads(resp.read().decode("utf-8"))
    conn.close()
    return resp.status, doc


def test_replan_route_returns_the_handler_result(server_with):
    httpd = server_with(lambda doc: {"siteId": doc["site_id"], "published": True})
    status, doc = _post(httpd, "/replan", {"site_id": str(SITE)})
    assert status == 200
    assert doc["published"] is True


@pytest.mark.parametrize(
    "raised,expected_status",
    [
        (InvalidReplanRequest("Ungültige Anfrage: site_id fehlt."), 400),
        (UnknownReplanSite("Diese Anlage ist dem Optimierer unbekannt."), 404),
        (ReplanUnavailable("keine Preise"), 400),
        (TooBusyError("busy"), 429),
        (RuntimeError("solver exploded"), 500),
    ],
)
def test_replan_route_maps_the_error_classes(server_with, raised, expected_status):
    def handler(doc):
        raise raised

    httpd = server_with(handler)
    status, doc = _post(httpd, "/replan", {"site_id": str(SITE)})
    assert status == expected_status
    assert "message" in doc


def test_replan_route_is_503_without_a_handler(server_with):
    httpd = server_with(None)
    status, _ = _post(httpd, "/replan", {"site_id": str(SITE)})
    assert status == 503


def test_the_cli_handler_is_semaphore_bounded(monkeypatch):
    """Two concurrent replans on a max-1 gate: the second is refused 429-style."""
    import voltpilot_optimization.engine as engine
    import voltpilot_optimization.inputs as inputs
    import voltpilot_optimization.persistence as persistence
    from voltpilot_optimization.cli import _replan_handler

    release = threading.Event()
    started = threading.Event()

    monkeypatch.setattr(persistence, "TimescaleScheduleRepository", lambda dsn: object())
    monkeypatch.setattr(inputs, "load_battery_sites",
                        lambda dsn, site_id=None: [object()])

    def slow_plan(dsn, site, repository, publisher, now, **kwargs):
        started.set()
        release.wait(timeout=5)
        return _Plan()

    monkeypatch.setattr(engine, "plan_site", slow_plan)

    handler = _replan_handler("postgresql://ignored", {}, max_concurrent=1)

    results = {}

    def first():
        results["first"] = handler({"site_id": str(SITE)})

    t = threading.Thread(target=first)
    t.start()
    assert started.wait(timeout=5)
    with pytest.raises(TooBusyError):
        handler({"site_id": str(SITE)})
    release.set()
    t.join(timeout=5)
    assert results["first"]["slots"] == 96
    # The gate is released: a follow-up call solves again.
    assert handler({"site_id": str(SITE)})["slots"] == 96
