"""NS-3 B: Speicher vor dem Überschuss-Verbraucher - die Plan-Hälfte
(Captain-Entscheid 15.10.2026, ``vp-herzogau-nie-schlechter-k5`` Abschnitt 3,
Kandidat g, Bauplan NS-P3b).

Erkennung und Grundlast (echte Grundlast, ein Lastsprung ohne Sonne bleibt
Grundlast, keine Fehlerkennung bei normaler Last), die Lastreihe ohne den
Verbraucher, der Schalter je Anlage (aus = unverändert), der Weg durch
``gather_inputs`` und der Planeffekt am echten Solver samt Haltefeld für die
Box.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization import ueberschuss_verbraucher as uv
from voltpilot_optimization.config import ueberschuss_verbraucher_enabled
from voltpilot_optimization.domain import BatteryParams, OptimizationInput, horizon_slot_starts
from voltpilot_optimization.publisher import build_schedule_payload

needs_highs = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

BERLIN = ZoneInfo("Europe/Berlin")
HERZOGAU = UUID("063012ff-4be7-4c1f-85c4-498bf555bd12")
TENANT = UUID("e09aa026-9a21-48ee-a117-84f2f9552d74")
BOX = UUID("00000000-0000-0000-0000-0000000000b0")
#: 13.10.2026, 13:00 Berlin - der Verbraucher läuft mit 37 kW.
JETZT = datetime(2026, 10, 13, 11, 0, tzinfo=timezone.utc)


def _berlin(tag: int, stunde: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, tag, stunde, minute, tzinfo=BERLIN).astimezone(timezone.utc)


def herzogau_woche(
    *, bis_tag: int = 13, sonnig=(6, 7, 8, 9, 12), morgen_heizung: bool = True
) -> list[uv.Viertelstunde]:
    """Sieben Tage Herzogau im Kleinen: Nacht 2,5 kW, tags 5 kW Grundlast; an
    sonnigen Tagen 45 kW Sonne und der Verbraucher mit 37 kW von 12 bis 15 Uhr,
    an trüben Tagen 8 kW Sonne; morgens 07-08 Uhr ein Heizstab mit 14 kW ohne
    Sonne (er läuft auf dem Netz, kein Speicher verdrängt ihn)."""
    out = []
    for tag in range(bis_tag - 7, bis_tag):
        for k in range(96):
            st, mi = divmod(k * 15, 60)
            start = _berlin(tag, st, mi)
            if st < 7 or st >= 19:
                last, pv = 2.5, 0.0
            elif st < 8 and morgen_heizung:
                last, pv = 14.0, 0.5
            else:
                pv = 45.0 if tag in sonnig else 8.0
                last = 5.0
                if tag in sonnig and 12 <= st < 15:
                    last = 37.0
            out.append(uv.Viertelstunde(start=start, last_kw=last, pv_kw=pv))
    return out


# ---- die Grundlast -----------------------------------------------------------


def test_die_grundlast_ist_die_last_ohne_den_verbraucher():
    """Mittags lief der Verbraucher an fünf von sieben Tagen - die Grundlast ist
    trotzdem die Last der Tage ohne ihn, nicht der Median aller Tage."""
    profil = uv.grundlast_profil(herzogau_woche())
    assert profil is not None
    assert profil.nachtlast_kw == pytest.approx(2.5)
    assert profil.fuer(_berlin(13, 13)) == pytest.approx(5.0)
    assert profil.fuer(_berlin(13, 10)) == pytest.approx(5.0)
    # 5 sonnige Tage x 12 Viertelstunden 12-15 Uhr
    assert profil.belege == 60


def test_ein_lastsprung_ohne_sonne_bleibt_grundlast():
    """Der Heizstab am Morgen läuft auf dem Netz: er ist Last, die der Plan
    decken muss, kein Überschuss-Verbraucher."""
    profil = uv.grundlast_profil(herzogau_woche())
    assert profil.fuer(_berlin(13, 7, 30)) == pytest.approx(14.0)
    assert not uv.ist_verbraucher_viertelstunde(14.0, 0.5, 2.5)
    assert uv.ist_verbraucher_viertelstunde(37.0, 45.0, 2.5)


def test_ohne_tage_ohne_verbraucher_keine_grundlast_dieser_tageszeit():
    """Lief der Verbraucher an jedem Tag der Lesung, gibt es für diese Tageszeit
    keine Grundlast - und die Regel bleibt dort stumm."""
    profil = uv.grundlast_profil(herzogau_woche(sonnig=range(1, 32)))
    assert profil.fuer(_berlin(13, 13)) is None
    assert profil.fuer(_berlin(13, 10)) == pytest.approx(5.0)
    assert uv.erkenne(profil, _berlin(13, 13), [37.0], [45.0]) is None


def test_ohne_nacht_kein_profil_und_kaputte_werte_zaehlen_nicht():
    tag = [uv.Viertelstunde(_berlin(12, 12), 37.0, 45.0)]
    assert uv.grundlast_profil(tag) is None
    kaputt = herzogau_woche() + [
        uv.Viertelstunde(_berlin(12, 13), float("nan"), 45.0),
        uv.Viertelstunde(_berlin(12, 13), -3.0, 45.0),
        uv.Viertelstunde(_berlin(12, 13), 37.0, float("inf")),
    ]
    assert uv.grundlast_profil(kaputt) == uv.grundlast_profil(herzogau_woche())


# ---- die Erkennung im Messfenster ----------------------------------------------


def test_der_verbraucher_wird_im_messfenster_erkannt():
    profil = uv.grundlast_profil(herzogau_woche())
    e = uv.erkenne(profil, JETZT, [36.5, 37.0, 37.5], [46.0, 47.0, 48.0])
    assert e is not None
    assert e.grundlast_kw == pytest.approx(5.0)
    assert e.gemessen_kw == pytest.approx(37.0)
    assert e.sonne_kw == pytest.approx(47.0)
    assert e.verbraucher_kw == pytest.approx(32.0)
    assert e.belege == 60


@pytest.mark.parametrize(
    "last, pv, grund",
    [
        (12.0, 45.0, "nur 7 kW über der Grundlast - normale Hauslast"),
        (37.0, 20.0, "die Sonne deckt die Last nicht - sie läuft auf dem Netz"),
        (37.0, float("nan"), "keine Sonne gemessen"),
    ],
)
def test_keine_fehlerkennung_bei_normaler_last(last, pv, grund):
    profil = uv.grundlast_profil(herzogau_woche())
    assert uv.erkenne(profil, JETZT, [last], [pv]) is None, grund


def test_ohne_das_muster_in_den_letzten_tagen_bleibt_die_regel_stumm():
    """Eine Anlage, die das Muster nie gezeigt hat (hier: an keinem Tag ein
    Verbraucher auf Überschuss), erkennt auch jetzt nichts - selbst wenn die
    Last gerade hoch ist und die Sonne sie deckt."""
    profil = uv.grundlast_profil(herzogau_woche(sonnig=()))
    assert profil.belege == 0
    assert uv.erkenne(profil, JETZT, [37.0], [45.0]) is None
    assert uv.erkenne(None, JETZT, [37.0], [45.0]) is None
    assert uv.erkenne(uv.grundlast_profil(herzogau_woche()), JETZT, [], [45.0]) is None


# ---- die Lastreihe ohne den Verbraucher ----------------------------------------------


def test_die_lastreihe_ohne_den_verbraucher():
    """Slot 0 liegt auf der Grundlast, der Nachlauf des Messfensters klingt mit
    dem Nowcast ab, nie unter die Grundlast und nie über den Wert von vorher;
    außerhalb des Sonnenfensters und nach dem Nowcast bleibt alles."""
    profil = uv.grundlast_profil(herzogau_woche())
    e = uv.erkenne(profil, JETZT, [37.0], [47.0])
    starts = horizon_slot_starts(JETZT, 12)
    # nach dem Nowcast: gemessene 37 kW, Abklingen über 8 Slots auf 5 kW
    last = [5.0 + 32.0 * max(0.0, 1.0 - t / 8) for t in range(12)]
    last[3] = 4.0  # eine Prognose unter der Grundlast bleibt, wie sie ist
    pv = [47.0] * 6 + [3.0] * 6  # ab Slot 6 kein Sonnenfenster
    neu, markiert = uv.ohne_verbraucher(last, pv, starts, profil, e)
    assert neu[0] == pytest.approx(5.0)
    assert neu[1] == pytest.approx(5.0)  # 33 - 32 * 7/8 = 5
    assert neu[3] == 4.0 and not markiert[3]
    assert all(n <= a + 1e-12 for n, a in zip(neu, last))
    assert all(n >= min(a, 5.0) - 1e-12 for n, a in zip(neu, last))
    assert neu[6:] == last[6:] and not any(markiert[6:])
    assert markiert[:3] == (True, True, True)
    # Eine Prognose mit dem Verbraucher von gestern verliert ihn auch.
    gestern = [37.0] * 12
    neu, markiert = uv.ohne_verbraucher(gestern, [47.0] * 12, starts, profil, e)
    assert neu[0] == pytest.approx(5.0)
    assert neu[4] == pytest.approx(37.0 - 32.0 * 0.5)
    assert neu[8:] == gestern[8:]


# ---- der Schalter ---------------------------------------------------------------


def test_der_schalter_ist_je_anlage_und_vorgabe_aus():
    env = "OPTIMIZER_UEBERSCHUSS_VERBRAUCHER_ANLAGEN"
    assert not ueberschuss_verbraucher_enabled(HERZOGAU, {})
    assert not ueberschuss_verbraucher_enabled(HERZOGAU, {env: ""})
    assert ueberschuss_verbraucher_enabled(HERZOGAU, {env: f" {HERZOGAU} "})
    assert ueberschuss_verbraucher_enabled(HERZOGAU, {env: f"{uuid4()},{HERZOGAU}"})
    assert not ueberschuss_verbraucher_enabled(HERZOGAU, {env: str(uuid4())})
    with pytest.raises(ValueError, match=env):
        ueberschuss_verbraucher_enabled(HERZOGAU, {env: "herzogau"})
    # Die Schalter der beiden Pakete sind getrennt.
    assert not ueberschuss_verbraucher_enabled(
        HERZOGAU, {"OPTIMIZER_MORGEN_UEBERSCHUSS_ANLAGEN": str(HERZOGAU)}
    )


# ---- der Weg durch gather_inputs ------------------------------------------------

_SLOTS = 16


class _Cursor:
    """Beantwortet die Abfragen von gather_inputs (das test_soc_source-Muster),
    mit der gemessenen Last und Sonne des Messfensters und den Rollups."""

    def __init__(self, welt: dict) -> None:
        self.welt = welt
        self._rows: list = []
        self.slot_starts = horizon_slot_starts(JETZT, _SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        self.welt.setdefault("sql", []).append(sql)
        jetzt = JETZT
        if "FROM day_ahead_prices" in sql:
            self._rows = [(ts, "PT15M", 50.0) for ts in self.slot_starts]
        elif "FROM forecast" in sql and "model_choice" not in sql:
            _site_id, kind, _model, since = params
            value = 5.0 if kind == "load" else 47.0
            self._rows = [(ts, value) for ts in self.slot_starts if ts >= since]
        elif "SELECT time, load_kw FROM telemetry" in sql:
            self._rows = [(jetzt - timedelta(seconds=s), self.welt["last"]) for s in (90, 50, 10)]
        elif "SELECT time, pv_power_kw FROM telemetry" in sql:
            self._rows = [(jetzt - timedelta(seconds=s), 47.0) for s in (90, 50, 10)]
        elif "load_kwh * 4.0, pv_kwh * 4.0 FROM telemetry_rollup_15m" in sql:
            if isinstance(self.welt.get("rollup"), Exception):
                raise self.welt["rollup"]
            self._rows = [(v.start, v.last_kw, v.pv_kw) for v in herzogau_woche()]
        elif "LIMIT 1" in sql and "soc_pct" in sql:
            self._rows = [(jetzt - timedelta(minutes=1), 40.0)]
        else:
            self._rows = []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


BATTERY = BatteryParams(
    capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0, roundtrip_efficiency=0.92
)


def _gather(monkeypatch, welt: dict) -> OptimizationInput:
    from voltpilot_optimization.inputs import BatterySite, gather_inputs

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor(welt)

        def rollback(self):  # pragma: no cover
            pass

    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn()))
    site = BatterySite(
        tenant_id=TENANT,
        site_id=HERZOGAU,
        device_id=None,
        bidding_zone="DE-LU",
        battery=BATTERY,
        netzladen_erlaubt=False,
    )
    return gather_inputs("postgresql://fake", site, JETZT, _SLOTS)


def test_gather_inputs_schalter_aus_liest_nichts_und_aendert_nichts(monkeypatch):
    env = "OPTIMIZER_UEBERSCHUSS_VERBRAUCHER_ANLAGEN"
    monkeypatch.delenv(env, raising=False)
    welt = {"last": 37.0}
    aus = _gather(monkeypatch, welt)
    assert aus.ueberschuss_verbraucher == ()
    assert not any("telemetry_rollup_15m" in q and "pv_kwh * 4.0" in q and "load_kwh * 4.0" in q
                   for q in welt["sql"])
    # Die Reihe ist die von vorher: Messfenster 37 kW im ersten Slot, mit Aufschlag.
    assert aus.load_kw[0] == pytest.approx(37.0 + 1.85, abs=0.2)

    # Eingeschaltet, aber der Verbraucher läuft nicht: dieselbe Reihe.
    monkeypatch.setenv(env, str(HERZOGAU))
    ruhig = _gather(monkeypatch, {"last": 5.0})
    monkeypatch.delenv(env)
    ohne = _gather(monkeypatch, {"last": 5.0})
    assert ruhig.ueberschuss_verbraucher == ()
    assert ruhig.load_kw == ohne.load_kw


def test_gather_inputs_rechnet_den_verbraucher_heraus(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_UEBERSCHUSS_VERBRAUCHER_ANLAGEN", str(HERZOGAU))
    welt = {"last": 37.0}
    inp = _gather(monkeypatch, welt)
    assert inp.ueberschuss_verbraucher[0] is True
    # Slot 0: Grundlast 5 kW plus der Sicherheitsaufschlag von 5 %.
    assert inp.load_kw[0] == pytest.approx(5.25, abs=0.05)
    assert any("telemetry_rollup_15m" in q for q in welt["sql"])
    # Jenseits des Nowcasts bleibt die Prognose.
    assert inp.load_kw[8:] == [5.0] * (_SLOTS - 8)


def test_gather_inputs_ein_lesefehler_kostet_die_regel_nie_den_plan(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_UEBERSCHUSS_VERBRAUCHER_ANLAGEN", str(HERZOGAU))
    inp = _gather(monkeypatch, {"last": 37.0, "rollup": RuntimeError("Datenbank weg")})
    monkeypatch.delenv("OPTIMIZER_UEBERSCHUSS_VERBRAUCHER_ANLAGEN")
    ohne = _gather(monkeypatch, {"last": 37.0})
    assert inp.ueberschuss_verbraucher == ()
    assert inp.load_kw == ohne.load_kw


# ---- am echten Solver -------------------------------------------------------------


def _mittag(**over) -> OptimizationInput:
    """13.10. ab 13:00 Berlin, zwölf Stunden: Sonne 47 kW bis 15:30, dann
    abnehmend; mittags 2 ct, abends 30 ct Einspeisewert, Bezug 25 ct (fester
    Tarif). Der Verbraucher misst 37 kW im ersten Slot und klingt im Nowcast
    ab; die Prognose dahinter ist 5 kW Grundlast. Speicher 20 %."""
    n = 48
    starts = horizon_slot_starts(JETZT, n)
    pv = [47.0 if t < 10 else max(0.0, 47.0 - 6.0 * (t - 10)) for t in range(n)]
    last = [5.0 + 32.0 * max(0.0, 1.0 - t / 8) for t in range(n)]
    last = [x * (1.0 + 0.05 * max(0.0, 1.0 - t / 8)) for t, x in enumerate(last)]
    einspeisung = [20.0 if t < 12 else 300.0 for t in range(n)]
    base = dict(
        tenant_id=TENANT,
        site_id=HERZOGAU,
        device_id=BOX,
        battery=BATTERY,
        slot_starts=starts,
        prices_eur_mwh=list(einspeisung),
        load_kw=last,
        pv_kw=pv,
        initial_soc_kwh=13.0,
        netzladen_erlaubt=False,
        import_price_eur_mwh=[250.0] * n,
        export_value_eur_mwh=einspeisung,
    )
    base.update(over)
    return OptimizationInput(**base)


def _mit_regel() -> OptimizationInput:
    """Dieselbe Eingabe, wie gather_inputs sie mit erkanntem Verbraucher baut:
    die Last ohne ihn, dann der Aufschlag."""
    from voltpilot_optimization.load_nowcast import apply_uncertainty_reserve

    roh = _mittag()
    profil = uv.grundlast_profil(herzogau_woche())
    e = uv.erkenne(profil, JETZT, [37.0], [47.0])
    nowcast = [5.0 + 32.0 * max(0.0, 1.0 - t / 8) for t in range(roh.slots)]
    neu, markiert = uv.ohne_verbraucher(nowcast, roh.pv_kw, roh.slot_starts, profil, e)
    return _mittag(load_kw=apply_uncertainty_reserve(neu), ueberschuss_verbraucher=markiert)


def _solve(inp):
    from voltpilot_optimization.solver import optimize

    return optimize(inp, plan_id=uuid4(), generated_at=JETZT)


@needs_highs
def test_ohne_die_regel_plant_der_plan_nur_sonne_minus_verbraucher():
    """Der Fall von heute: im ersten Slot misst der Lauf 37 kW Last bei 47 kW
    Sonne - mehr als ~10 kW Laden wäre Netzladen."""
    plan = _solve(_mittag())
    assert plan.slots[0].battery_kw <= 47.0 - 37.0 * 1.05 + 0.05
    assert all(s.charge_hold_base_load_kw is None for s in plan.slots)
    assert all(uv.SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER not in (s.slot_flags or ()) for s in plan.slots)


@needs_highs
def test_mit_der_regel_laedt_der_plan_gegen_den_verbraucher_und_die_box_haelt():
    """Mit der Regel plant der Lauf gegen die Grundlast: der erste Slot lädt
    mit voller Leistung, er trägt den Grund im Erklärtext und das Haltefeld für
    die Box (die geplante Last, 5 kW Grundlast plus 5 %)."""
    heute, plan = _solve(_mittag()), _solve(_mit_regel())
    s0 = plan.slots[0]
    assert s0.battery_kw == pytest.approx(30.0, abs=0.05)
    assert s0.battery_kw > heute.slots[0].battery_kw + 15.0
    assert s0.load_kw == pytest.approx(5.25, abs=0.01)
    assert uv.SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER in s0.slot_flags
    assert s0.charge_from_surplus_only is True
    assert s0.charge_hold_base_load_kw == pytest.approx(round(s0.load_kw, 3))
    # Nur wo der Lauf den Verbraucher herausgerechnet hat und lädt.
    for i, s in enumerate(plan.slots):
        markiert = _mit_regel().ueberschuss_verbraucher[i]
        assert (uv.SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER in (s.slot_flags or ())) == markiert
        if s.charge_hold_base_load_kw is not None:
            assert markiert and s.battery_kw > 0.05 and s.charge_from_surplus_only
    # Der Speicher hat am Ende des laufenden Slots die Ladung, die heute der
    # Verbraucher nimmt (30 statt ~8 kW über eine Viertelstunde).
    assert plan.slots[0].soc_kwh > heute.slots[0].soc_kwh + 4.0
    # Die Nachricht an die Box trägt das Feld nur dort.
    payload = build_schedule_payload(plan)
    assert payload["slots"][0]["charge_hold_base_load_kw"] == round(s0.load_kw, 3)
    assert all(
        ("charge_hold_base_load_kw" in p) == (s.charge_hold_base_load_kw is not None)
        for p, s in zip(payload["slots"], plan.slots)
    )


@needs_highs
def test_schalter_aus_ist_byte_identisch():
    """Ohne Markierung (der Schalter aus, oder nichts erkannt) ist die
    Nachricht an die Box dieselbe wie vor dem Paket."""
    a = build_schedule_payload(_solve(_mittag()))
    b = build_schedule_payload(_solve(_mittag(ueberschuss_verbraucher=())))
    a.pop("plan_id"), b.pop("plan_id")
    assert a == b
    assert all("charge_hold_base_load_kw" not in s for s in a["slots"])


@needs_highs
def test_kein_haltefeld_ohne_trim_oder_mit_gehaltenem_speicher(monkeypatch):
    """Das Halten ist eine Änderung der Trim-Pflicht: ohne sie (Kill-Switch,
    ein Speicher, den eine Kundenregel hält, unbekannter Ladestand) gibt es
    nichts zu halten."""
    from dataclasses import replace

    from voltpilot_optimization.domain import SOC_SOURCE_UNBEKANNT

    monkeypatch.setenv("OPTIMIZER_SLOT_TRIM_ENABLED", "false")
    assert all(s.charge_hold_base_load_kw is None for s in _solve(_mit_regel()).slots)
    monkeypatch.delenv("OPTIMIZER_SLOT_TRIM_ENABLED")
    assert all(
        s.charge_hold_base_load_kw is None
        for s in _solve(replace(_mit_regel(), battery_held=True)).slots
    )
    assert all(
        s.charge_hold_base_load_kw is None
        for s in _solve(replace(_mit_regel(), soc_source=SOC_SOURCE_UNBEKANNT)).slots
    )


def test_die_markierung_muss_zum_horizont_passen():
    with pytest.raises(ValueError, match="ueberschuss_verbraucher"):
        _mittag(ueberschuss_verbraucher=(True, False))
