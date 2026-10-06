"""„Sonne + Speicher" (06.10.2026): die Speicheruntergrenze fürs Laden.

Die Szenarien des Auftrags - 12:00 sonnig, 20:00 Nacht, schlechter Folgetag,
voller Speicher bei Überschuss, veraltete/fehlende Prognose - plus die
Eigenschaften, auf denen die Box sich verlässt: die Untergrenze ist MONOTON
(mehr Ladestand ist nie schlechter) und eine Freigabe bis zu ihr erhöht den
prognostizierten Netzbezug NIE. Mehrere Ladepunkte teilen sich die Freigabe
auf der Box (``edge-app/core/internal/lastmgmt``, dort getestet).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from voltpilot_optimization.domain import (
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    PlanSlot,
    SchedulePlan,
)
from voltpilot_optimization.night_reserve import BERLIN, NightErrorQuantiles
from voltpilot_optimization.storage_release import (
    DEFAULT_LOAD_UPLIFT,
    DEFAULT_PV_HAIRCUT,
    DEFAULT_RESERVE_KWH,
    GRUND_KEIN_LADESTAND,
    GRUND_NACHT_UEBER_KAPAZITAET,
    GRUND_PROGNOSE_VERALTET,
    GRUND_RESERVE_UEBER_KAPAZITAET,
    GRUND_SPEICHER_GEHALTEN,
    DayErrorQuantiles,
    day_error_rels,
    day_windows,
    evening_runs,
    plan_storage_release,
    planned_sale_kw,
    release_slot,
    required_energy_kwh,
    unsicherheit,
)

TENANT = UUID("00000000-0000-0000-0000-000000000001")
SITE = UUID("00000000-0000-0000-0000-000000000002")
DEVICE = UUID("00000000-0000-0000-0000-000000000003")
SLOT_H = 0.25


def pv_curve(hour: float, peak_kw: float) -> float:
    """Eine Sonnenglocke 06-20 Uhr mit dem Maximum um 13 Uhr."""
    if hour < 6.0 or hour > 20.0:
        return 0.0
    return peak_kw * math.sin(math.pi * (hour - 6.0) / 14.0) ** 2


def day_profile(start_hour: float, slots: int, peak_today: float, peak_tomorrow: float,
                night_load: float = 0.5, day_load: float = 1.0):
    load, pv = [], []
    for i in range(slots):
        h = start_hour + i * SLOT_H
        day = int(h // 24)
        hod = h % 24
        peak = peak_today if day == 0 else peak_tomorrow
        pv.append(pv_curve(hod, peak))
        load.append(day_load if 7.0 <= hod < 22.0 else night_load)
    return load, pv


def battery(capacity=15.0, rte=1.0, power=5.0) -> BatteryParams:
    return BatteryParams(
        capacity_kwh=capacity, max_charge_kw=power, max_discharge_kw=power,
        roundtrip_efficiency=rte,
    )


def make_plan(load, pv, *, bat=None, battery_kw=None, grid_kw=None,
              start_hour=12.0, soc_source="gemessen") -> SchedulePlan:
    bat = bat or battery()
    t0 = datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc) + timedelta(hours=start_hour)
    n = len(load)
    battery_kw = battery_kw or [0.0] * n
    if grid_kw is None:
        grid_kw = [load[i] - pv[i] + battery_kw[i] for i in range(n)]
        # Ein Eigenverbrauchs-Plan: der Speicher deckt das Haus, Netz ~ 0.
        grid_kw = [min(g, 0.0) for g in grid_kw]
    slots = [
        PlanSlot(
            start=t0 + i * timedelta(minutes=15),
            battery_kw=battery_kw[i],
            grid_kw=grid_kw[i],
            soc_kwh=5.0,
            load_kw=load[i],
            pv_kw=pv[i],
            price_eur_mwh=100.0,
            cost_eur=0.0,
            baseline_cost_eur=0.0,
        )
        for i in range(n)
    ]
    return SchedulePlan(
        plan_id=UUID("a81bc81b-dead-4e5d-abff-90865d1e13b1"),
        tenant_id=TENANT, site_id=SITE, device_id=DEVICE,
        generated_at=t0, battery=bat, slots=slots, soc_source=soc_source,
    )


def release_of(plan, *, reserve=None, night=None, pv=None, fresh=True, held=False):
    return plan_storage_release(
        plan, reserve_kwh=reserve, night_errors=night, pv_errors=pv,
        forecasts_fresh=fresh, battery_held=held,
    )


def lo_kwh(bat: BatteryParams, reserve: float = DEFAULT_RESERVE_KWH) -> float:
    return bat.capacity_kwh * bat.effective_floor_soc_pct / 100.0 + reserve


def simulate_import(load, pv, start_kwh, bat, floor_kwh):
    """Vorwärts: wie viel kWh das Haus aus dem Netz holt, wenn der Speicher
    mit ``start_kwh`` beginnt und nie unter ``floor_kwh`` entlädt."""
    eta = bat.one_way_efficiency
    soc, imported = start_kwh, 0.0
    for lo, p in zip(load, pv):
        net = lo - p
        if net > 0:
            can = min(net, bat.max_discharge_kw, max(0.0, soc - floor_kwh) * eta / SLOT_H)
            soc -= can * SLOT_H / eta
            imported += (net - can) * SLOT_H
        else:
            take = min(-net, bat.max_charge_kw, max(0.0, bat.soc_max_kwh - soc) / (eta * SLOT_H))
            soc += take * SLOT_H * eta
    return imported


def conservative(load, pv, rel):
    u = rel.unsicherheit
    return ([x * (1 + u.last_aufschlag) for x in load],
            [x * (1 - u.pv_abschlag) for x in pv])


# --- Die Szenarien des Auftrags ---------------------------------------------


def test_noon_on_a_sunny_day_releases_down_to_the_reserve():
    """12:00 sonnig: der Nachmittag füllt den Speicher für die Nacht wieder,
    also darf er jetzt bis auf Reservestapel + Reserve herunter."""
    load, pv = day_profile(12.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    plan = make_plan(load, pv)
    rel = release_of(plan)
    assert rel.grund is None
    assert rel.floor_kwh[0] == pytest.approx(lo_kwh(plan.battery))
    # 5 % technischer Boden + 1 kWh Reserve an 15 kWh = 11,67 % -> aufgerundet.
    assert rel.floor_soc_pct[0] == pytest.approx(11.7)


def test_evening_releases_only_what_exceeds_the_night_plus_reserve():
    """20:00: freigegeben wird nur, was über den (vorsichtigen) Nachtbedarf bis
    zum Morgen plus Reserve hinausgeht."""
    load, pv = day_profile(20.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    plan = make_plan(load, pv, start_hour=20.0)
    rel = release_of(plan)
    bat = plan.battery
    floor = rel.floor_kwh[0]
    assert floor is not None
    cl, cp = conservative(load, pv, rel)
    # Die Nacht-Energie bis zur nächsten Erzeugung (vorsichtig gerechnet).
    night = 0.0
    for lo, p in zip(cl, cp):
        if p >= lo and night > 0:
            break
        night += max(0.0, lo - p) * SLOT_H
    assert floor == pytest.approx(lo_kwh(bat) + night, abs=0.05)
    # Und genau diese Grenze trägt: ab ihr kein prognostizierter Netzbezug,
    # einen Hauch darunter schon.
    assert simulate_import(cl[:60], cp[:60], floor, bat, lo_kwh(bat)) == pytest.approx(0.0, abs=1e-6)
    assert simulate_import(cl[:60], cp[:60], floor - 0.5, bat, lo_kwh(bat)) > 0.4


def test_a_poor_next_day_raises_the_floor():
    """Wenig Sonne morgen: die nächste Erzeugung kommt später und füllt
    weniger - die Untergrenze steigt."""
    load, pv_good = day_profile(20.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    _, pv_poor = day_profile(20.0, 192, peak_today=8.0, peak_tomorrow=1.5)
    good = release_of(make_plan(load, pv_good, start_hour=20.0))
    poor = release_of(make_plan(load, pv_poor, start_hour=20.0))
    assert good.floor_kwh[0] is not None
    if poor.floor_kwh[0] is not None:
        assert poor.floor_kwh[0] > good.floor_kwh[0] + 1.0
    else:
        assert poor.grund == GRUND_NACHT_UEBER_KAPAZITAET


def test_a_full_battery_in_a_surplus_releases_and_the_sun_refills_it():
    """Voller Speicher bei Überschuss: der Plan ruht (Speicher voll) und speist
    die Sonne ein. Die Freigabe ist dort erlaubt, die Untergrenze liegt beim
    Reservestapel - und die Sonne füllt nach, was das Auto nimmt."""
    load, pv = day_profile(11.0, 192, peak_today=9.0, peak_tomorrow=9.0)
    n = len(load)
    battery_kw = [0.0] * n
    grid_kw = [load[i] - pv[i] for i in range(n)]  # Export bei vollem Speicher
    plan = make_plan(load, pv, battery_kw=battery_kw, grid_kw=grid_kw, start_hour=11.0)
    assert grid_kw[0] < -1.0
    rel = release_of(plan)
    assert rel.floor_kwh[0] == pytest.approx(lo_kwh(plan.battery))
    cl, cp = conservative(load, pv, rel)
    bat = plan.battery
    # Ob voll oder bis zur Untergrenze geleert: dieselbe Nacht ohne Netzbezug.
    assert simulate_import(cl, cp, bat.soc_max_kwh, bat, lo_kwh(bat)) == pytest.approx(
        simulate_import(cl, cp, rel.floor_kwh[0], bat, lo_kwh(bat)), abs=1e-6)


@pytest.mark.parametrize(
    ("kwargs", "grund"),
    [
        ({"fresh": False}, GRUND_PROGNOSE_VERALTET),
        ({"held": True}, GRUND_SPEICHER_GEHALTEN),
    ],
)
def test_stale_or_missing_forecast_and_held_battery_release_nothing(kwargs, grund):
    load, pv = day_profile(12.0, 96, peak_today=8.0, peak_tomorrow=8.0)
    rel = release_of(make_plan(load, pv), **kwargs)
    assert rel.grund == grund
    assert all(v is None for v in rel.floor_soc_pct)
    assert not rel.any_release


def test_unknown_soc_releases_nothing():
    """Unbekannt ist keine Null: ohne Ladestand plant der Fahrplan den
    Speicher nicht, und es gibt keine Untergrenze."""
    load, pv = day_profile(12.0, 96, peak_today=8.0, peak_tomorrow=8.0)
    rel = release_of(make_plan(load, pv, soc_source=SOC_SOURCE_UNBEKANNT))
    assert rel.grund == GRUND_KEIN_LADESTAND
    assert not rel.any_release


def test_a_reserve_above_the_battery_releases_nothing():
    load, pv = day_profile(12.0, 96, peak_today=8.0, peak_tomorrow=8.0)
    rel = release_of(make_plan(load, pv), reserve=20.0)
    assert rel.grund == GRUND_RESERVE_UEBER_KAPAZITAET
    assert not rel.any_release


# --- Die Rechnung selbst ------------------------------------------------------


def test_the_lower_clamp_is_causality_not_the_full_battery():
    """Ein bewölkter Vormittag (Defizit) VOR einem sonnigen Nachmittag: der
    spätere Überschuss kann das frühere Defizit nicht bezahlen. Ohne die
    Begrenzung nach unten verrechnete die Rückwärtsrechnung beides."""
    load = [2.0] * 8 + [1.0] * 24          # 2 h Defizit, dann 6 h Sonne
    pv = [0.0] * 8 + [6.0] * 24
    need, capped = required_energy_kwh(
        load, pv, SLOT_H, floor_kwh=1.0, ceiling_kwh=9.5, max_charge_kw=5.0,
        max_discharge_kw=5.0, one_way_efficiency=1.0,
    )
    assert need[0] == pytest.approx(1.0 + 2.0 * 2.0)
    assert not any(capped)
    # Die naive Summe ohne Begrenzung hätte nur den Boden verlangt.
    naive = 1.0 + sum((lo - p) * SLOT_H for lo, p in zip(load, pv))
    assert naive < 1.0


def test_the_full_battery_is_the_upper_cap_and_a_small_battery_still_releases_at_noon():
    """Die Kapazität ist die obere Kappung: die Nacht braucht mehr, als der
    kleine Speicher hält - Netzbezug nachts ist ohnehin unvermeidlich. Mittags
    darf das Auto trotzdem, was der Nachmittag zurückbringt; abends nicht."""
    small = battery(capacity=4.0, power=3.0)
    load, pv = day_profile(12.0, 192, peak_today=8.0, peak_tomorrow=8.0, night_load=0.8)
    noon = release_of(make_plan(load, pv, bat=small))
    assert noon.grund is None
    assert noon.floor_kwh[0] == pytest.approx(lo_kwh(small))
    cl, cp = conservative(load, pv, noon)
    full = simulate_import(cl, cp, small.soc_max_kwh, small, lo_kwh(small))
    released = simulate_import(cl, cp, noon.floor_kwh[0], small, lo_kwh(small))
    assert full > 1.0  # die Nacht holt ohnehin Netzstrom
    assert released == pytest.approx(full, abs=1e-6)  # die Freigabe ändert daran nichts

    load_e, pv_e = day_profile(20.0, 192, peak_today=8.0, peak_tomorrow=8.0, night_load=0.8)
    evening = release_of(make_plan(load_e, pv_e, bat=small, start_hour=20.0))
    assert evening.grund == GRUND_NACHT_UEBER_KAPAZITAET
    assert not evening.any_release


def test_power_limits_count_only_what_the_battery_can_move():
    """Ein Defizit über der Entladeleistung kommt ohnehin aus dem Netz; ein
    Überschuss über der Ladeleistung lässt sich nicht einlagern."""
    need, _ = required_energy_kwh(
        [10.0] * 4, [0.0] * 4, SLOT_H, floor_kwh=0.0, ceiling_kwh=100.0,
        max_charge_kw=2.0, max_discharge_kw=2.0, one_way_efficiency=1.0,
    )
    assert need[0] == pytest.approx(4 * 2.0 * SLOT_H)
    need, _ = required_energy_kwh(
        [0.0] * 4 + [1.0] * 4, [10.0] * 4 + [0.0] * 4, SLOT_H, floor_kwh=0.0,
        ceiling_kwh=100.0, max_charge_kw=2.0, max_discharge_kw=5.0, one_way_efficiency=1.0,
    )
    # 1 kWh Nachtbedarf, 4 Slots x 2 kW x 0,25 h = 2 kWh Ladekapazität davor.
    assert need[0] == pytest.approx(0.0)
    assert need[4] == pytest.approx(1.0)


def test_efficiencies_raise_the_need_on_both_ends():
    need, _ = required_energy_kwh(
        [1.0] * 4, [0.0] * 4, SLOT_H, floor_kwh=0.0, ceiling_kwh=100.0,
        max_charge_kw=5.0, max_discharge_kw=5.0, one_way_efficiency=0.9,
    )
    assert need[0] == pytest.approx(1.0 / 0.9)


@pytest.mark.parametrize("start", [12.0, 16.0, 20.0, 2.0])
def test_the_floor_is_sufficient_and_monotone(start):
    """Die Eigenschaft, auf der die Box sich verlässt: wer mit der Untergrenze
    (oder mehr) beginnt, holt nicht mehr Netzstrom als mit vollem Speicher."""
    load, pv = day_profile(start, 192, peak_today=6.0, peak_tomorrow=6.0)
    plan = make_plan(load, pv, start_hour=start)
    rel = release_of(plan)
    bat = plan.battery
    if rel.floor_kwh[0] is None:
        pytest.skip("kein Freigabe-Slot")
    cl, cp = conservative(load, pv, rel)
    best = simulate_import(cl, cp, bat.soc_max_kwh, bat, lo_kwh(bat))
    for extra in (0.0, 0.5, 2.0):
        start_kwh = min(bat.soc_max_kwh, rel.floor_kwh[0] + extra)
        assert simulate_import(cl, cp, start_kwh, bat, lo_kwh(bat)) == pytest.approx(best, abs=1e-6)


def test_the_slot_floor_takes_the_higher_end_of_a_surplus_slot():
    load, pv = day_profile(17.0, 96, peak_today=8.0, peak_tomorrow=8.0)
    plan = make_plan(load, pv, start_hour=17.0)
    rel = release_of(plan)
    floors = [f for f in rel.floor_kwh if f is not None]
    assert floors
    # Rundung nach oben: der Prozentwert ist nie kleiner als die kWh.
    for kwh, pct in zip(rel.floor_kwh, rel.floor_soc_pct):
        if kwh is not None:
            assert pct * plan.battery.capacity_kwh / 100.0 >= kwh - 1e-9


# --- Fahrplan gegen Kundenwahl ----------------------------------------------


def test_trading_slots_carry_no_floor():
    # Geplanter Netzbezug (günstige Stunde / Netzladen / PV-Bus-Laden).
    assert not release_slot(battery_kw=3.0, grid_kw=2.0, load_kw=1.0, pv_kw=2.0)
    assert not release_slot(battery_kw=0.0, grid_kw=0.8, load_kw=0.8, pv_kw=0.0)
    # Geplanter Verkauf aus dem Speicher.
    assert not release_slot(battery_kw=-5.0, grid_kw=-4.0, load_kw=1.0, pv_kw=0.0)
    # Eigenverbrauch: Haus decken, Überschuss laden, voll ruhen.
    assert release_slot(battery_kw=-1.0, grid_kw=0.0, load_kw=1.0, pv_kw=0.0)
    assert release_slot(battery_kw=3.0, grid_kw=-1.0, load_kw=1.0, pv_kw=5.0)
    assert release_slot(battery_kw=0.0, grid_kw=-4.0, load_kw=1.0, pv_kw=5.0)


def test_a_planned_sale_raises_the_floor_before_it():
    """Der Fahrplan gewinnt beim Handel: was er um 19 Uhr verkaufen will, darf
    mittags nicht ins Auto."""
    load, pv = day_profile(12.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    n = len(load)
    base = release_of(make_plan(load, pv))
    battery_kw = [0.0] * n
    grid_kw = [min(0.0, load[i] - pv[i]) for i in range(n)]
    sale = list(range(28, 32))  # 19:00-20:00
    for i in sale:
        battery_kw[i] = -5.0
        grid_kw[i] = -(5.0 - max(0.0, load[i] - pv[i]))
    sold = release_of(make_plan(load, pv, battery_kw=battery_kw, grid_kw=grid_kw))
    assert all(sold.floor_soc_pct[i] is None for i in sale)
    # Der Verkauf (bis 5 kWh über das Haus hinaus) steckt in der Untergrenze
    # davor - soweit der Nachmittag ihn nicht ohnehin nachfüllt.
    assert sold.floor_kwh[20] > base.floor_kwh[20] + 1.0
    assert planned_sale_kw(-5.0, 1.0, 0.0) == pytest.approx(4.0)
    assert planned_sale_kw(2.0, 1.0, 0.0) == 0.0


# --- Vorsichtig: gemessene Unsicherheit statt Pauschale ---------------------


def night(q90: float, nights: int = 21) -> NightErrorQuantiles:
    return NightErrorQuantiles(
        quantiles={0.5: q90 / 2, 0.75: q90 * 0.8, 0.9: q90, 0.95: q90 * 1.2},
        nights=nights, model_id="load-persistence",
    )


def day_errors(q10: float, days: int = 19) -> DayErrorQuantiles:
    return DayErrorQuantiles(quantiles={0.1: q10}, days=days, model_id="pv-physical")


def test_measured_errors_beat_the_defaults_and_only_ever_make_it_safer():
    u = unsicherheit(night(0.12), day_errors(-0.35))
    assert (u.last_aufschlag, u.last_quelle, u.naechte) == (0.12, "gemessen", 21)
    assert (u.pv_abschlag, u.pv_quelle, u.tage) == (pytest.approx(0.35), "gemessen", 19)
    # Eine Anlage, die nachts eher WENIGER braucht, bekommt keinen Abschlag.
    assert unsicherheit(night(-0.05), day_errors(0.10)).last_aufschlag == 0.0
    assert unsicherheit(night(-0.05), day_errors(0.10)).pv_abschlag == 0.0
    # 95 % weniger Sonne wird auf 90 % gekappt - das wäre sonst Nacht.
    assert unsicherheit(None, day_errors(-0.95)).pv_abschlag == pytest.approx(0.9)


def test_without_a_distribution_the_documented_defaults_apply():
    u = unsicherheit(None, None)
    assert u.last_aufschlag == DEFAULT_LOAD_UPLIFT
    assert u.pv_abschlag == DEFAULT_PV_HAIRCUT
    assert (u.last_quelle, u.pv_quelle) == ("vorgabe", "vorgabe")


def test_more_uncertainty_means_a_higher_floor():
    load, pv = day_profile(20.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    plan = make_plan(load, pv, start_hour=20.0)
    calm = release_of(plan, night=night(0.02), pv=day_errors(-0.05))
    rough = release_of(plan, night=night(0.30), pv=day_errors(-0.40))
    assert rough.floor_kwh[0] > calm.floor_kwh[0]


def test_the_site_reserve_lifts_the_floor_one_to_one():
    load, pv = day_profile(12.0, 192, peak_today=8.0, peak_tomorrow=8.0)
    plan = make_plan(load, pv)
    std = release_of(plan)
    own = release_of(plan, reserve=2.5)
    assert std.reserve_standard and not own.reserve_standard
    assert own.floor_kwh[0] - std.floor_kwh[0] == pytest.approx(1.5)


# --- Die PV-Tagesfehler (Lesepfad, rein) -------------------------------------


def test_pv_day_errors_use_the_evening_run_before_and_drop_thin_days():
    now = datetime(2026, 6, 25, 22, 0, tzinfo=timezone.utc)
    windows = day_windows(now, 3)
    assert len(windows) == 3
    start, end = windows[0]
    assert start.astimezone(BERLIN).hour == 6 and end.astimezone(BERLIN).hour == 21
    slots = []
    t = start
    while t < end:
        slots.append(t)
        t += timedelta(minutes=15)
    run = datetime.combine(start.astimezone(BERLIN).date() - timedelta(days=1),
                           datetime.min.time().replace(hour=17, minute=45), tzinfo=BERLIN
                           ).astimezone(timezone.utc)
    later = run + timedelta(hours=12)
    by_run = {
        run: {s: 4.0 for s in slots},
        later: {s: 99.0 for s in slots},  # ein späterer Lauf zählt nicht
    }
    forecasts = evening_runs(windows[:1], by_run)
    assert set(forecasts[start].values()) == {4.0}
    measured = {s: 3.0 for s in slots}
    assert day_error_rels(windows[:1], measured, forecasts) == [pytest.approx(-0.25)]
    # Zu wenig gepaarte Viertelstunden: der Tag fällt weg, nie hochgerechnet.
    sparse = {s: 3.0 for s in slots[:20]}
    assert day_error_rels(windows[:1], sparse, forecasts) == []
    # Ein grauer Tag mit kaum prognostizierter Sonne ist Rauschen.
    grey = {start: {s: 0.01 for s in slots}}
    assert day_error_rels(windows[:1], measured, grey) == []


# --- Die gemeinsamen Vertragsvektoren (per PFAD, wie Go/Java/TS) -------------

import json  # noqa: E402
from pathlib import Path  # noqa: E402

from voltpilot_optimization import storage_release as sr  # noqa: E402

VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2"
     / "sonne-speicher-vectors.json").read_text()
)


@pytest.mark.parametrize("v", VECTORS["required_energy"], ids=lambda v: v["name"][:40])
def test_the_shared_required_energy_vectors(v):
    need, capped = required_energy_kwh(
        v["load_kw"], v["pv_kw"], v["slot_hours"],
        floor_kwh=v["floor_kwh"], ceiling_kwh=v["ceiling_kwh"],
        max_charge_kw=v["max_charge_kw"], max_discharge_kw=v["max_discharge_kw"],
        one_way_efficiency=v["one_way_efficiency"],
    )
    assert need[0] == pytest.approx(v["need0_kwh"])
    assert capped[0] is v["capped0"]


def test_the_cloud_reasons_and_the_reserve_are_the_shared_vocabulary():
    grunde = {
        sr.GRUND_KEIN_LADESTAND, sr.GRUND_SPEICHER_GEHALTEN, sr.GRUND_PROGNOSE_VERALTET,
        sr.GRUND_NACHT_UEBER_KAPAZITAET, sr.GRUND_RESERVE_UEBER_KAPAZITAET,
    }
    assert grunde == set(VECTORS["cloud_reasons"])
    assert sr.DEFAULT_RESERVE_KWH == VECTORS["reserve_kwh"]["standard"]
    assert sr.MAX_RESERVE_KWH == VECTORS["reserve_kwh"]["max"]
    schema = json.loads(
        (Path(__file__).resolve().parents[3] / "docs" / "contracts"
         / "mqtt-schedule.schema.json").read_text()
    )
    assert set(schema["properties"]["ev_release_reason"]["enum"]) == grunde
