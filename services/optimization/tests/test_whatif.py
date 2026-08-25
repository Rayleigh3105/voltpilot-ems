"""The admin what-if re-optimize (design vp-admin-optimizer-ui-design §4.3).

Three things are pinned here, in descending order of how much they matter:

1. **It is ephemeral.** The module must never reach persistence or the
   publisher - a preview that could write a plan or push MQTT would be a
   production incident, not a UI bug. Proven structurally (import graph) and
   behaviourally (a runner whose deps are stubs, with no DB in sight).
2. **The knobs do what they say and NOTHING else.** ``apply_overrides`` is
   pure, so each knob is checked to move its own field and leave every other
   input (prices, forecasts, SoC, §14a, feed-in cap) byte-identical.
3. **Baseline and variant share one input.** The delta is only meaningful on
   the same prices/forecasts, so the runner gathers ONCE and solves twice.

The solver-backed cases need the HiGHS wheel; everything else runs offline.
"""

from __future__ import annotations

import ast
import http.client
import importlib.util
import json
import threading
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

from voltpilot_optimization import whatif
from voltpilot_optimization.domain import (
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import SkipSite
from voltpilot_optimization.simulation.jobs import JobStore, TooBusyError
from voltpilot_optimization.simulation.server import serve
from voltpilot_optimization.whatif import (
    InvalidWhatIfRequest,
    WhatIfDeps,
    WhatIfOverrides,
    WhatIfUnavailable,
    apply_overrides,
    delta_document,
    parse_request,
    run_what_if,
)

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

T0 = datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)
SITE = UUID("11111111-2222-3333-4444-555555555555")


def make_input(prices: list[float] | None = None, **over) -> OptimizationInput:
    prices = prices or ([50.0] * 48 + [250.0] * 48)
    n = len(prices)
    battery = BatteryParams(
        capacity_kwh=10.0,
        max_charge_kw=5.0,
        max_discharge_kw=5.0,
        roundtrip_efficiency=0.92,
    )
    base = dict(
        tenant_id=uuid4(),
        site_id=SITE,
        device_id=uuid4(),
        battery=battery,
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=prices,
        load_kw=[2.0] * n,
        pv_kw=[0.0] * n,
        initial_soc_kwh=battery.soc_min_kwh,
        netzladen_erlaubt=True,
    )
    base.update(over)
    return OptimizationInput(**base)


# ---------------------------------------------------------------------------
# 1. ephemeral by construction
# ---------------------------------------------------------------------------


def test_the_whatif_module_can_never_persist_or_publish():
    """The safety property of the whole feature, checked at the import graph.

    A what-if must not be able to write the `schedule` hypertable or push a
    retained MQTT plan, so the module simply does not know how: it imports
    neither persistence nor either publisher. A future edit that pulls one in
    fails HERE, before it can ever reach a real plant.
    """
    tree = ast.parse(open(whatif.__file__, encoding="utf-8").read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    forbidden = {"persistence", "publisher", "publisher_v2"}
    offenders = {m for m in imported if m.rsplit(".", 1)[-1] in forbidden}
    assert not offenders, f"whatif.py must not import {offenders}"


def test_the_runner_never_touches_a_database_or_the_tick_loop():
    """All data access is injected, so the runner is exercised end to end with
    stubs - the same reason the tick loop's state can never leak into it."""
    inp = make_input()
    gathered: list[tuple] = []

    deps = WhatIfDeps(
        load_site=lambda site_id: object(),
        gather=lambda site, now, slots: (gathered.append((now, slots)), inp)[1],
    )
    result = run_what_if(
        whatif.WhatIfRequest(SITE, WhatIfOverrides(wear_cost_ct_per_kwh=8.0), 96),
        deps,
        now=T0,
    )
    # Gathered exactly ONCE, and both plans came out of that one input.
    assert gathered == [(T0, 96)]
    assert result["baseline"]["knobs"]["wearCostCtPerKwh"] == pytest.approx(4.0)
    assert result["variant"]["knobs"]["wearCostCtPerKwh"] == pytest.approx(8.0)


# ---------------------------------------------------------------------------
# 2. the knobs, one at a time
# ---------------------------------------------------------------------------


def test_no_overrides_returns_the_very_same_input_object():
    inp = make_input()
    assert apply_overrides(inp, WhatIfOverrides()) is inp


@pytest.mark.parametrize(
    "override,field,expected",
    [
        (WhatIfOverrides(wear_cost_ct_per_kwh=9.5), "wear_cost_ct_per_kwh", 9.5),
        (WhatIfOverrides(backup_reserve_soc_pct=30.0), "backup_reserve_pct", 30.0),
        (WhatIfOverrides(soc_min_pct=12.0), "soc_min_fraction", 0.12),
        (WhatIfOverrides(soc_max_pct=88.0), "soc_max_fraction", 0.88),
    ],
)
def test_each_battery_knob_moves_only_its_own_field(override, field, expected):
    inp = make_input()
    out = apply_overrides(inp, override)
    assert getattr(out.battery, field) == pytest.approx(expected)
    # Everything else about the plant is untouched.
    assert replace(out.battery, **{field: getattr(inp.battery, field)}) == inp.battery
    assert out.prices_eur_mwh == inp.prices_eur_mwh
    assert out.load_kw == inp.load_kw and out.pv_kw == inp.pv_kw
    assert out.initial_soc_kwh == inp.initial_soc_kwh
    assert out.grid_limit_kw == inp.grid_limit_kw
    assert out.max_feed_in_kw == inp.max_feed_in_kw
    assert out.netzladen_erlaubt == inp.netzladen_erlaubt


def test_netzladen_override_flips_only_the_posture():
    inp = make_input(netzladen_erlaubt=True)
    out = apply_overrides(inp, WhatIfOverrides(netzladen_erlaubt=False))
    assert out.netzladen_erlaubt is False
    assert out.battery == inp.battery
    assert out.prices_eur_mwh == inp.prices_eur_mwh


def test_a_zero_backup_reserve_is_no_reserve_not_an_ambiguous_null():
    """0 % and "no floor" are the same constraint, which is why the knob needs
    no separate clear flag."""
    inp = make_input()
    out = apply_overrides(inp, WhatIfOverrides(backup_reserve_soc_pct=0.0))
    soc0 = inp.battery.clamp_soc_kwh(inp.initial_soc_kwh)
    assert out.battery.soc_floor_kwh(soc0) == inp.battery.soc_floor_kwh(soc0)


def test_a_one_sided_band_override_crossing_the_sites_own_side_is_refused():
    """The request-level check cannot see this case (only one side is sent),
    so the site's own other side must reject it - with a German message."""
    inp = make_input()
    with pytest.raises(InvalidWhatIfRequest) as exc:
        apply_overrides(inp, WhatIfOverrides(soc_min_pct=99.0))
    assert "Speicher-Regler" in str(exc.value)


def test_the_terminal_value_is_rederived_for_the_variants_own_posture():
    """Flipping netzladen changes WHICH slots can refill the battery, so a
    carried-over V_end would price the variant with the baseline's assumption.

    Asymmetric pricing on purpose: under the bare-spot symmetric model import
    and export are the same number, so the two postures could not differ even
    in principle - a real plant's retail import always exceeds its export.
    """
    prices = [50.0] * 48 + [250.0] * 48
    inp = make_input(
        prices=prices,
        import_price_eur_mwh=[p + 200.0 for p in prices],
        export_value_eur_mwh=prices,
    )
    merchant = inp.effective_terminal_value_eur_per_kwh()
    eeg = apply_overrides(
        inp, WhatIfOverrides(netzladen_erlaubt=False)
    ).effective_terminal_value_eur_per_kwh()
    # An EEG plant with no PV cannot refill from the grid, so a stored kWh is
    # worth the avoided IMPORT, not the forgone export - a different number.
    assert eeg != pytest.approx(merchant)


# ---------------------------------------------------------------------------
# request parsing
# ---------------------------------------------------------------------------


def test_parse_request_defaults_to_a_24h_horizon_and_no_overrides():
    req = parse_request({"siteId": str(SITE)})
    assert req.site_id == SITE
    assert req.horizon_slots == 96
    assert req.overrides.is_empty()


@pytest.mark.parametrize(
    "doc",
    [
        {},
        {"siteId": "nope"},
        {"siteId": str(SITE), "horizonSlots": 2},
        {"siteId": str(SITE), "horizonSlots": 10_000},
        {"siteId": str(SITE), "overrides": {"wearCostCtPerKwh": -1}},
        {"siteId": str(SITE), "overrides": {"wearCostCtPerKwh": "viel"}},
        {"siteId": str(SITE), "overrides": {"socMinPct": 120}},
        {"siteId": str(SITE), "overrides": {"socMinPct": 80, "socMaxPct": 20}},
        {"siteId": str(SITE), "overrides": {"netzladenErlaubt": "ja"}},
        {"siteId": str(SITE), "overrides": []},
    ],
)
def test_bad_requests_are_refused_with_a_german_message(doc):
    with pytest.raises(InvalidWhatIfRequest) as exc:
        parse_request(doc)
    assert str(exc.value)
    assert str(exc.value)[0].isupper()


def test_null_overrides_read_as_untouched_never_as_zero():
    req = parse_request(
        {"siteId": str(SITE), "overrides": {"wearCostCtPerKwh": None, "socMinPct": None}}
    )
    assert req.overrides.is_empty()


def test_applied_overrides_echo_only_what_was_actually_set():
    req = parse_request(
        {"siteId": str(SITE), "overrides": {"wearCostCtPerKwh": 8, "netzladenErlaubt": False}}
    )
    assert req.overrides.as_document() == {
        "wearCostCtPerKwh": 8.0,
        "netzladenErlaubt": False,
    }


# ---------------------------------------------------------------------------
# the runner's honesty
# ---------------------------------------------------------------------------


def test_an_unknown_or_battery_less_site_says_so_instead_of_returning_a_plan():
    deps = WhatIfDeps(load_site=lambda site_id: None, gather=lambda *a: None)
    with pytest.raises(WhatIfUnavailable) as exc:
        run_what_if(whatif.WhatIfRequest(SITE, WhatIfOverrides()), deps, now=T0)
    assert "Batteriespeicher" in str(exc.value)


def test_a_site_without_price_coverage_names_the_reason():
    def gather(site, now, slots):
        raise SkipSite("keine Preisabdeckung")

    deps = WhatIfDeps(load_site=lambda site_id: object(), gather=gather)
    with pytest.raises(WhatIfUnavailable) as exc:
        run_what_if(whatif.WhatIfRequest(SITE, WhatIfOverrides()), deps, now=T0)
    assert "keine Preisabdeckung" in str(exc.value)


def test_a_delta_over_a_missing_number_stays_null_never_a_zero_difference():
    assert delta_document({"costEur": None}, {"costEur": 3.0})["costEur"] is None
    assert delta_document({"costEur": 1.0}, {"costEur": None})["costEur"] is None
    assert delta_document({"costEur": 1.0}, {"costEur": 3.0})["costEur"] == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# 3. real solves (HiGHS)
# ---------------------------------------------------------------------------


@needs_highs
def test_an_empty_override_set_yields_two_identical_plans():
    """The delta is the whole point, so "changed nothing" must read as zero -
    not as noise from two differently-gathered runs."""
    inp = make_input()
    deps = WhatIfDeps(load_site=lambda s: object(), gather=lambda *a: inp)
    result = run_what_if(whatif.WhatIfRequest(SITE, WhatIfOverrides()), deps, now=T0)

    assert result["appliedOverrides"] == {}
    assert result["baseline"]["slots"] == result["variant"]["slots"]
    assert result["delta"]["costEur"] == pytest.approx(0.0)
    assert result["delta"]["cycles"] == pytest.approx(0.0)


@needs_highs
def test_raising_the_wear_cost_stops_the_cycling_and_the_delta_shows_it():
    """The knob's real effect, on a spread that only just clears the default
    wear threshold: at 4 ct the plan cycles, at 40 ct it does not."""
    # 100 -> 200 EUR/MWh clears the 4 ct default (0.92*200-100 = 84 > ~38.4)
    # but not a 40 ct rate (threshold ~384 EUR/MWh).
    inp = make_input(prices=[100.0] * 48 + [200.0] * 48)
    deps = WhatIfDeps(load_site=lambda s: object(), gather=lambda *a: inp)

    quiet = run_what_if(
        whatif.WhatIfRequest(SITE, WhatIfOverrides(wear_cost_ct_per_kwh=40.0)), deps, now=T0
    )
    assert quiet["baseline"]["cycles"] > 0.0
    assert quiet["variant"]["cycles"] == pytest.approx(0.0)
    assert quiet["delta"]["cycles"] < 0.0
    # Both plans priced the SAME horizon, so the comparison is like for like.
    assert len(quiet["baseline"]["slots"]) == len(quiet["variant"]["slots"])
    assert quiet["horizonSlots"] == len(quiet["variant"]["slots"])


@needs_highs
def test_forbidding_grid_charging_removes_the_grid_arbitrage_from_the_variant():
    inp = make_input(prices=[50.0] * 48 + [250.0] * 48)
    deps = WhatIfDeps(load_site=lambda s: object(), gather=lambda *a: inp)
    result = run_what_if(
        whatif.WhatIfRequest(SITE, WhatIfOverrides(netzladen_erlaubt=False)), deps, now=T0
    )
    assert result["baseline"]["chargedKwh"] > 0.0
    # No PV in this fixture, so an EEG plant may not charge at all.
    assert result["variant"]["chargedKwh"] == pytest.approx(0.0)
    assert result["variant"]["knobs"]["netzladenErlaubt"] is False
    assert result["appliedOverrides"] == {"netzladenErlaubt": False}


@needs_highs
def test_a_backup_reserve_floor_holds_in_the_variant_at_any_price():
    inp = make_input(prices=[50.0] * 48 + [250.0] * 48, initial_soc_kwh=8.0)
    deps = WhatIfDeps(load_site=lambda s: object(), gather=lambda *a: inp)
    result = run_what_if(
        whatif.WhatIfRequest(SITE, WhatIfOverrides(backup_reserve_soc_pct=60.0)), deps, now=T0
    )
    assert min(s["socPct"] for s in result["variant"]["slots"]) >= 60.0 - 1e-6
    assert min(s["socPct"] for s in result["baseline"]["slots"]) < 60.0


# ---------------------------------------------------------------------------
# the HTTP route
# ---------------------------------------------------------------------------


@pytest.fixture
def server_with(request):
    """Serve the on-demand surface with a stubbed what-if handler."""

    def build(handler):
        store = JobStore(lambda req, publish: {})
        httpd = serve(store, port=0, bind="127.0.0.1", what_if=handler)
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


def test_route_returns_the_handler_result(server_with):
    httpd = server_with(lambda doc: {"siteId": doc["siteId"], "delta": {}})
    status, doc = _post(httpd, "/what-if", {"siteId": str(SITE)})
    assert status == 200
    assert doc["siteId"] == str(SITE)


@pytest.mark.parametrize(
    "raised,expected_status",
    [
        (InvalidWhatIfRequest("Ungültige Anlagen-ID."), 400),
        (WhatIfUnavailable("Kein Batteriespeicher."), 400),
        (TooBusyError("busy"), 429),
        (RuntimeError("solver exploded"), 500),
    ],
)
def test_route_maps_every_failure_to_an_honest_german_body(
    server_with, raised, expected_status
):
    def boom(doc):
        raise raised

    httpd = server_with(boom)
    status, doc = _post(httpd, "/what-if", {"siteId": str(SITE)})
    assert status == expected_status
    assert doc["message"]
    # A failed preview never claims a result.
    assert "variant" not in doc and "delta" not in doc


def test_route_answers_503_when_the_feature_is_not_wired(server_with):
    httpd = server_with(None)
    status, doc = _post(httpd, "/what-if", {"siteId": str(SITE)})
    assert status == 503
    assert doc["message"]


def test_the_simulation_routes_are_untouched_by_the_new_one(server_with):
    httpd = server_with(lambda doc: {})
    status, doc = _post(httpd, "/simulations", {"nonsense": True})
    assert status == 400  # still the simulation validator's own refusal
    assert doc["message"]


# ---------------------------------------------------------------------------
# the CLI wiring (the handler the route actually calls)
# ---------------------------------------------------------------------------


def test_the_wired_handler_also_reaches_neither_persistence_nor_a_publisher():
    """The module guard above covers whatif.py; this covers the CLI factory
    that BUILDS the route's handler - a preview that persisted would most
    plausibly get there by wiring a repository in here."""
    import inspect

    from voltpilot_optimization import cli

    tree = ast.parse(inspect.getsource(cli._what_if_handler))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    forbidden = {"persistence", "publisher", "publisher_v2"}
    assert not {m for m in imported if m.rsplit(".", 1)[-1] in forbidden}


def test_the_tick_loop_does_not_know_about_the_whatif_at_all():
    """No shared state with the 15-min cycle: the engine must not import it."""
    from voltpilot_optimization import engine

    assert "whatif" not in open(engine.__file__, encoding="utf-8").read()


def test_the_handler_validates_before_taking_a_concurrency_slot(monkeypatch):
    """A garbage request must not consume one of the few solve slots - and a
    burst past the cap is refused immediately (429) rather than queued behind
    a minutes-long simulation."""
    from voltpilot_optimization import cli, inputs as inputs_mod

    monkeypatch.setattr(inputs_mod, "load_battery_sites", lambda dsn, site_id=None: [])
    handle = cli._what_if_handler("postgresql://unused", 1)

    # Invalid input never reaches a slot ...
    with pytest.raises(InvalidWhatIfRequest):
        handle({"siteId": "nope"})

    # ... and the slot it would have taken is still free.
    with pytest.raises(WhatIfUnavailable):
        handle({"siteId": str(SITE)})


def test_the_handler_refuses_a_burst_past_the_cap_instead_of_queueing(monkeypatch):
    from voltpilot_optimization import cli, inputs as inputs_mod
    from voltpilot_optimization.simulation.jobs import TooBusyError

    started = threading.Event()
    release = threading.Event()

    def slow_load(dsn, site_id=None):
        started.set()
        assert release.wait(timeout=10)
        return []

    monkeypatch.setattr(inputs_mod, "load_battery_sites", slow_load)
    handle = cli._what_if_handler("postgresql://unused", 1)

    def hold():
        try:
            handle({"siteId": str(SITE)})
        except WhatIfUnavailable:
            pass

    holder = threading.Thread(target=hold, daemon=True)
    holder.start()
    assert started.wait(timeout=5)

    with pytest.raises(TooBusyError):
        handle({"siteId": str(SITE)})

    release.set()
    holder.join(timeout=10)


# ---------------------------------------------------------------------------
# 6. Steuerung Stufe 7 - die KUNDEN-Knöpfe (Konzept vp-steuerung-konzept-b3 §3.8)
# ---------------------------------------------------------------------------


def test_customer_knobs_are_absent_by_default_and_change_nothing():
    """Die tragende Bestands-Aussage: ohne die Knöpfe ist alles wie vorher."""
    inp = make_input()
    assert WhatIfOverrides().is_empty()
    assert apply_overrides(inp, WhatIfOverrides()) is inp
    assert inp.forced_charge_slots == 0
    assert inp.forced_charge_kw == 0.0


def test_soc_floor_now_raises_the_floor_to_where_the_battery_stands():
    """„Ladestand halten" benutzt die VORHANDENE Reservierung, keine zweite Bodenlogik."""
    inp = make_input(initial_soc_kwh=7.0)  # 70 % von 10 kWh
    variant = apply_overrides(inp, WhatIfOverrides(soc_floor_now=True))
    assert variant.battery.backup_reserve_pct == pytest.approx(70.0)
    # ... und der EFFEKTIVE Boden ist wirklich der Stand von jetzt.
    assert variant.battery.soc_floor_kwh(7.0) == pytest.approx(7.0)
    # Alles Übrige bleibt Byte für Byte stehen.
    assert variant.prices_eur_mwh == inp.prices_eur_mwh
    assert variant.load_kw == inp.load_kw
    assert variant.pv_kw == inp.pv_kw
    assert variant.initial_soc_kwh == inp.initial_soc_kwh

    # Eine BESTEHENDE höhere Reserve wird nie GESENKT - der Knopf hält, er löst nicht.
    hoch = make_input(initial_soc_kwh=3.0, battery=replace(
        make_input().battery, backup_reserve_pct=60.0))
    assert apply_overrides(hoch, WhatIfOverrides(soc_floor_now=True)) \
        .battery.backup_reserve_pct == pytest.approx(60.0)


def test_forced_charge_is_capped_at_the_headroom_and_refuses_a_full_battery():
    inp = make_input(initial_soc_kwh=5.0)  # Kopfraum bis 95 % = 9,5 kWh -> 4,5 kWh
    variant = apply_overrides(inp, WhatIfOverrides(forced_charge_slots=8))
    assert variant.forced_charge_slots == 8
    # 4,5 kWh / (8 * 0,25 h * eta) - und nie über die Ladeleistung.
    eta = inp.battery.one_way_efficiency
    assert variant.forced_charge_kw == pytest.approx(
        min(4.5 / (8 * 0.25 * eta), inp.battery.max_charge_kw))
    assert variant.forced_charge_kw <= inp.battery.max_charge_kw

    # Ein VOLLER Speicher bekommt einen deutschen Grund, keine unlösbare Vorschau.
    voll = make_input(initial_soc_kwh=inp.battery.soc_max_kwh)
    with pytest.raises(InvalidWhatIfRequest, match="bereits voll"):
        apply_overrides(voll, WhatIfOverrides(forced_charge_slots=8))


def test_consumer_load_shift_adds_the_device_only_inside_its_window():
    inp = make_input()
    variant = apply_overrides(inp, WhatIfOverrides(
        consumer_load_shift=whatif.LoadShift(from_slot=4, slots=3, kw=11.0)))
    assert variant.load_kw[3] == pytest.approx(2.0)
    assert variant.load_kw[4:7] == pytest.approx([13.0, 13.0, 13.0])
    assert variant.load_kw[7] == pytest.approx(2.0)
    # Die PV- und Preisreihen bleiben unangetastet - es ist DIESELBE Anlage.
    assert variant.pv_kw == inp.pv_kw
    assert variant.prices_eur_mwh == inp.prices_eur_mwh


@pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None, reason="needs the HiGHS wheel")
def test_the_three_knobs_move_the_money_in_the_direction_they_promise():
    """Durch den ECHTEN Solver: jeder Knopf kostet, und die Zahl ist die Aussage."""
    prices = [50.0] * 48 + [250.0] * 48
    inp = make_input(prices, initial_soc_kwh=9.0)  # fast voll: es gibt was zu entladen
    now = T0

    basis, _ = whatif.solve_ephemeral(inp, now)

    # „Ladestand halten" verbietet das Entladen -> die Ersparnis SINKT.
    halten = whatif.solve_ephemeral(
        apply_overrides(inp, WhatIfOverrides(soc_floor_now=True)), now)[0]
    assert halten.savings_eur < basis.savings_eur
    # ⚠ Der Boden ist ein BODEN, keine Einfrierung: der Ladestand fällt nie
    # unter den Stand von jetzt (das ist die Zusage), laden und wieder bis auf
    # diesen Stand entladen DARF der Plan. Genau deshalb ist die Vorschau als
    # Näherung beschriftet - siehe den Docstring von `WhatIfOverrides`.
    assert min(s.soc_kwh for s in halten.slots) >= 9.0 - 1e-6

    # „Jetzt laden" erzwingt Ladung in den ersten Slots.
    geladen = whatif.solve_ephemeral(
        apply_overrides(make_input(prices, initial_soc_kwh=1.0),
                        WhatIfOverrides(forced_charge_slots=4)), now)[0]
    assert all(s.battery_kw > 0 for s in geladen.slots[:4])

    # Ein Gerät, das im TEUREN Fenster läuft, kostet mehr als im günstigen.
    teuer = whatif.solve_ephemeral(apply_overrides(inp, WhatIfOverrides(
        consumer_load_shift=whatif.LoadShift(from_slot=60, slots=8, kw=6.0))), now)[0]
    guenstig = whatif.solve_ephemeral(apply_overrides(inp, WhatIfOverrides(
        consumer_load_shift=whatif.LoadShift(from_slot=0, slots=8, kw=6.0))), now)[0]
    assert teuer.cost_eur > guenstig.cost_eur


@pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None, reason="needs the HiGHS wheel")
def test_a_run_without_the_new_knobs_is_byte_identical_to_before():
    """Der Bestands-Beweis: dieselben Setpoints, dieselbe Zahl."""
    inp = make_input()
    a, _ = whatif.solve_ephemeral(inp, T0)
    b, _ = whatif.solve_ephemeral(replace(inp, forced_charge_slots=0, forced_charge_kw=0.0), T0)
    assert [s.battery_kw for s in a.slots] == [s.battery_kw for s in b.slots]
    assert a.cost_eur == pytest.approx(b.cost_eur)
