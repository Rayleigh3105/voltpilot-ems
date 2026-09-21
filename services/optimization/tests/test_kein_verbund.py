"""Kein-Verbund-Nachweis im Planer (AP-15 IP-8, NW-5, Regel T3, Referenzfall R20).

Wo KEINE Gemeinsame Steuerung ist, entsteht auch keine: zwei Anlagen desselben
Standorts sind zwei Laeufe ohne gemeinsame Nebenbedingung, und keine Groesse
der einen steht im Eingang der anderen - auch wenn beide Boxen senden.

Die Welt ist Ahrenberg aus der Referenzdatei 1.5: Standort ST-1 "Werk
Ahrenberg" mit Anlage AN-1 "Halle 1" an NA-1 (Box Halle 1, E-1, traegt den
Speicher) und Anlage AN-2 "Halle 2" an NA-2 (Box Halle 2, E-2, eigener
Speicher). Der Optimierer kennt den Standort gar nicht - das IST der Beweis:
es gibt keinen Weg, auf dem eine Anlage die andere sehen koennte.

Wie in ``test_eingang_je_box`` (IP-9) laeuft die ECHTE Telemetrie-SQL gegen
eine echte Tabelle (sqlite im Speicher); die Anlagen- und Box-Bedingung wird
ausgefuehrt, nicht an ihrem Wortlaut erkannt. Die Prognose-Attrappe antwortet
je Anlage anders, damit ein Uebersprechen auch dort sichtbar wuerde.
"""

from __future__ import annotations

import dataclasses
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization import engine
from voltpilot_optimization.domain import BatteryParams, horizon_slot_starts
from voltpilot_optimization.inputs import BatterySite
from voltpilot_optimization.pricing import SiteTariff

pytest.importorskip("highspy")

# Dienstag 15.06.2027, 11:45 Europe/Berlin (Sommerzeit) = 09:45 UTC.
NOW = datetime(2027, 6, 15, 9, 45, tzinfo=timezone.utc)
SLOTS = 16
TENANT = UUID("00000000-0000-0000-0000-00000000a001")  # Kunststoffwerk Ahrenberg
AN_1 = UUID("00000000-0000-0000-0000-00000000a1a1")  # Werk Ahrenberg - Halle 1, NA-1
AN_2 = UUID("00000000-0000-0000-0000-00000000a2a2")  # Werk Ahrenberg - Halle 2, NA-2
E_1 = UUID("00000000-0000-0000-0000-0000000000e1")  # Box Halle 1
E_2 = UUID("00000000-0000-0000-0000-0000000000e2")  # Box Halle 2

# Der echte Solver-Aufruf, einmal gegriffen: jeder Zyklus des Tests legt seinen Faenger darum.
_OPTIMIZE = engine.optimize

# Prognose je Anlage (kW): verschieden, damit ein Uebersprechen auffiele.
PROGNOSE = {AN_1: {"pv": 40.0, "load": 90.0}, AN_2: {"pv": 15.0, "load": 30.0}}


def _zeit(ts: datetime) -> str:
    # Feste Breite, damit der Textvergleich in sqlite der Zeitvergleich ist.
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def _sql_wert(value):
    if isinstance(value, datetime):
        return _zeit(value)
    if isinstance(value, UUID):
        return str(value)
    return value


class _Telemetrie:
    """``telemetry`` beider Anlagen als echte Tabelle; die Leser-SQL laeuft unveraendert."""

    SPALTEN = ("soc_pct", "pv_power_kw", "load_kw", "grid_limit_kw")

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.execute(
            "CREATE TABLE telemetry (time TEXT NOT NULL, tenant_id TEXT NOT NULL,"
            " site_id TEXT NOT NULL, device_id TEXT NOT NULL, power_kw REAL,"
            " soc_pct REAL, pv_power_kw REAL, load_kw REAL, grid_limit_kw REAL)"
        )
        self.abfragen: list[tuple[str, tuple]] = []

    def senden(self, site: UUID, box: UUID, at: datetime, **werte: float) -> None:
        assert set(werte) <= set(self.SPALTEN), werte
        spalten = ", ".join(("time", "tenant_id", "site_id", "device_id", *werte))
        marken = ", ".join("?" for _ in range(4 + len(werte)))
        self.db.execute(
            f"INSERT INTO telemetry ({spalten}) VALUES ({marken})",
            (_zeit(at), str(TENANT), str(site), str(box), *werte.values()),
        )

    def abfrage(self, sql: str, params) -> list[tuple]:
        self.abfragen.append((" ".join(sql.split()), tuple(params)))
        rows = self.db.execute(
            sql.replace("%s", "?"), tuple(_sql_wert(p) for p in params)
        ).fetchall()
        return [(datetime.fromisoformat(row[0]), *row[1:]) for row in rows]


class _FakeCursor:
    """Telemetrie an sqlite; Prognose je Anlage; alles andere wie in test_eingang_je_box."""

    def __init__(self, telemetrie: _Telemetrie) -> None:
        self._t = telemetrie
        self._rows: list = []
        self._horizon = horizon_slot_starts(NOW, SLOTS)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        flat = " ".join(sql.split())
        if "FROM telemetry " in flat:
            self._rows = self._t.abfrage(sql, params)
        elif "FROM telemetry_rollup_15m" in flat or "FROM flow_claim" in flat:
            self._rows = []
        elif "FROM day_ahead_prices" in flat:
            self._rows = [(ts, "PT15M", 100.0) for ts in self._horizon]
        elif "FROM forecast" in flat and (
            "run_at < time" in flat or flat.startswith("SELECT run_at,")
        ):
            self._rows = []
        elif "FROM forecast" in flat:
            wert = PROGNOSE[UUID(str(params[0]))][params[1]]
            self._rows = [(ts, wert) for ts in self._horizon]
        elif "FROM schedule" in flat or "FROM monthly_market_value" in flat:
            self._rows = []
        else:  # pragma: no cover - eine neue Abfrage heisst: die SQL hat sich geaendert
            raise AssertionError(f"unhandled query: {flat}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def telemetrie(monkeypatch) -> _Telemetrie:
    table = _Telemetrie()

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _FakeCursor(table)

    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn())
    )
    for var in (
        "VOLTPILOT_ACTIVE_LOAD_MODEL",
        "VOLTPILOT_ACTIVE_PV_MODEL",
        "VOLTPILOT_V2_PLAN_SITES",
        "OPTIMIZER_GRID_LIMIT_MAX_AGE_MINUTES",
        "OPTIMIZER_SOC_MAX_AGE_MINUTES",
        "OPTIMIZER_REQUIRE_MEASURED_SOC",
        "OPTIMIZER_PV_ANCHOR_ENABLED",
        "OPTIMIZER_PV_NOWCAST_ENABLED",
        "OPTIMIZER_PV_NOWCAST_DECAY_SLOTS",
        "OPTIMIZER_PV_NOWCAST_MAX_AGE_SECONDS",
        "OPTIMIZER_PV_NOWCAST_LOOKBACK_SECONDS",
        "OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH",
    ):
        monkeypatch.delenv(var, raising=False)
    return table


def _anlage(site: UUID, box: UUID, capacity_kwh: float, einspeisung_kw: float) -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=site,
        device_id=box,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=capacity_kwh,
            max_charge_kw=capacity_kwh / 2,
            max_discharge_kw=capacity_kwh / 2,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=False,
        latitude=51.3,
        longitude=9.5,
        max_feed_in_kw=einspeisung_kw,
        tariff=SiteTariff(pv_capacity_kwp=150.0),
    )


HALLE_1 = _anlage(AN_1, E_1, 200.0, 100.0)
HALLE_2 = _anlage(AN_2, E_2, 60.0, 30.0)


def _kurzfrist(t: _Telemetrie, site: UUID, box: UUID, *, load: float, pv: float) -> None:
    """Zwei Minuten Last/PV alle 5 s bis kurz vor jetzt - die echte Telemetrie-Rate."""
    for i in range(24, -1, -1):
        t.senden(site, box, NOW - timedelta(seconds=2 + 5 * i), load_kw=load, pv_power_kw=pv)


def _halle_1_sendet(t: _Telemetrie) -> None:
    t.senden(AN_1, E_1, NOW - timedelta(minutes=25), soc_pct=64.0)
    t.senden(AN_1, E_1, NOW - timedelta(minutes=20), grid_limit_kw=300.0)
    _kurzfrist(t, AN_1, E_1, load=80.0, pv=30.0)


def _halle_2_sendet(t: _Telemetrie) -> None:
    """Box Halle 2: juenger in JEDEM Wert als Box Halle 1 - wuerde irgendein
    Leser anlagenuebergreifend "die juengste Zeile" nehmen, waere es ihre."""
    t.senden(AN_2, E_2, NOW - timedelta(seconds=10), soc_pct=12.0)
    t.senden(AN_2, E_2, NOW - timedelta(minutes=1), grid_limit_kw=120.0)
    _kurzfrist(t, AN_2, E_2, load=5.0, pv=55.0)


class _Laeufe:
    """Faengt jeden Solver-Aufruf des Zyklus: ein Eintrag = ein Lauf."""

    def __init__(self, monkeypatch) -> None:
        self.eingaenge = []

        def optimize(inp, plan_id, now):
            self.eingaenge.append(inp)
            return _OPTIMIZE(inp, plan_id, now)

        monkeypatch.setattr(engine, "optimize", optimize)

    def je_anlage(self) -> dict:
        return {inp.site_id: inp for inp in self.eingaenge}


def _zyklus(monkeypatch, anlagen: list[BatterySite]):
    monkeypatch.setattr(engine, "load_battery_sites", lambda dsn: list(anlagen))
    laeufe = _Laeufe(monkeypatch)
    summary = engine.run_cycle("postgresql://fake", None, None, now=NOW, horizon_slots=SLOTS)
    return summary, laeufe


def _ohne_kennung(plan):
    """Ein Plan ohne seine Zufallskennung - der Rest ist das Ergebnis des Laufs."""
    return dataclasses.replace(plan, plan_id=UUID(int=0))


# --- R20 Schritt 2: zwei Anlagen eines Standorts -> zwei Laeufe -------------


def test_r20_zwei_anlagen_eines_standorts_sind_zwei_laeufe(telemetrie, monkeypatch):
    """T3: der Planer laedt je Lauf genau eine Anlage - zwei Anlagen, zwei Laeufe,
    zwei Plaene an zwei Boxen, keiner nennt die andere Anlage."""
    _halle_1_sendet(telemetrie)
    _halle_2_sendet(telemetrie)

    summary, laeufe = _zyklus(monkeypatch, [HALLE_1, HALLE_2])

    assert summary.skipped == []
    assert [inp.site_id for inp in laeufe.eingaenge] == [AN_1, AN_2]
    assert [(p.site_id, p.device_id) for p in summary.planned] == [(AN_1, E_1), (AN_2, E_2)]
    assert summary.planned[0].plan_id != summary.planned[1].plan_id


def test_r20_keine_groesse_der_einen_anlage_im_eingang_der_anderen(telemetrie, monkeypatch):
    """T3, auch wenn beide Boxen senden: Speicherstand, Vorgabe, Last und PV
    jeder Anlage kommen aus IHRER Box; jede Telemetrie-Abfrage nennt genau eine
    Anlage, und wo sie eine Box nennt (P5), die Box dieser Anlage."""
    _halle_1_sendet(telemetrie)
    _halle_2_sendet(telemetrie)

    _, laeufe = _zyklus(monkeypatch, [HALLE_1, HALLE_2])
    an1, an2 = laeufe.je_anlage()[AN_1], laeufe.je_anlage()[AN_2]

    assert (an1.device_id, an2.device_id) == (E_1, E_2)
    assert an1.initial_soc_kwh == pytest.approx(0.64 * 200.0)
    assert an2.initial_soc_kwh == pytest.approx(0.12 * 60.0)
    assert (an1.grid_limit_kw, an2.grid_limit_kw) == (pytest.approx(300.0), pytest.approx(120.0))
    assert (an1.max_feed_in_kw, an2.max_feed_in_kw) == (100.0, 30.0)
    # Die Prognose je Anlage traegt jede Stunde nach dem laufenden Slot unverfaelscht.
    assert an1.load_kw[-1] == pytest.approx(90.0) and an2.load_kw[-1] == pytest.approx(30.0)
    assert an1.pv_kw[-1] == pytest.approx(40.0) and an2.pv_kw[-1] == pytest.approx(15.0)

    telemetrie_abfragen = telemetrie.abfragen
    assert telemetrie_abfragen, "die Telemetrie-Leser muessen gelaufen sein"
    eigene_box = {AN_1: E_1, AN_2: E_2}
    for sql, params in telemetrie_abfragen:
        assert "site_id = %s" in sql, sql
        anlagen = [a for a in (AN_1, AN_2) if a in params]
        assert len(anlagen) == 1, (sql, params)
        boxen = [b for b in (E_1, E_2) if b in params]
        assert boxen in ([], [eigene_box[anlagen[0]]]), (sql, params)
    assert sum("AND device_id = %s" in sql for sql, _ in telemetrie_abfragen) == 8, "vier P5-Leser je Anlage"


def test_r20_keine_gemeinsame_nebenbedingung(telemetrie, monkeypatch):
    """Keine gemeinsame Nebenbedingung heisst: ob die andere Anlage da ist und
    sendet, aendert an Eingang und Plan dieser Anlage nichts - Byte fuer Byte
    bis auf die Zufallskennung des Plans."""
    _halle_1_sendet(telemetrie)
    allein_1, laeufe_allein_1 = _zyklus(monkeypatch, [HALLE_1])

    _halle_2_sendet(telemetrie)
    allein_2, laeufe_allein_2 = _zyklus(monkeypatch, [HALLE_2])
    beide, laeufe_beide = _zyklus(monkeypatch, [HALLE_1, HALLE_2])

    assert laeufe_beide.je_anlage()[AN_1] == laeufe_allein_1.eingaenge[0]
    assert laeufe_beide.je_anlage()[AN_2] == laeufe_allein_2.eingaenge[0]
    assert _ohne_kennung(beide.planned[0]) == _ohne_kennung(allein_1.planned[0])
    assert _ohne_kennung(beide.planned[1]) == _ohne_kennung(allein_2.planned[0])

