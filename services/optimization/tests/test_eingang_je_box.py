"""Optimierer-Eingang je Box (AP-15 IP-9, Regel P5, Referenzfall R8).

Speicherstand, Netzbetreiber-Vorgabe (§14a ``grid_limit_kw``) und die
Kurzfrist-Werte Last/PV des laufenden Slots werden mit der Box der Entitaet
gelesen - der Box der geplanten Batterie (``asset.device_id``). Bis IP-9 nahm
der Optimierer "die juengste Zeile der Anlage"; sobald eine zweite Box der
Anlage Telemetrie sendet (Box Verwaltung seit IP-7), konnte das ihr Wert sein.

Anders als die Text-Attrappen der Nachbarmodule laeuft hier die ECHTE SQL der
Leser gegen eine echte ``telemetry``-Tabelle (sqlite im Speicher): die
Box-Bedingung wird ausgefuehrt, nicht an ihrem Wortlaut erkannt. Nur die
uebrigen Abfragen (Preise, Prognosen, Fahrplan) beantwortet eine Attrappe.

Zahlen aus R8: Anlage AN-1 "Werk Ahrenberg - Halle 1", Box Halle 1 (E-1,
fuehrt, traegt den geplanten Speicher) + Box Verwaltung (E-4, PV ohne
Speicher), Dienstag 15.06.2027 11:45; Fristen 30 s · 60 min · 120 min.
"""

from __future__ import annotations

import dataclasses
import inspect
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.config import (
    grid_limit_max_age,
    pv_nowcast_max_age,
    soc_max_age,
)
from voltpilot_optimization.domain import (
    SOC_SOURCE_GEMESSEN,
    SOC_SOURCE_UNBEKANNT,
    BatteryParams,
    horizon_slot_starts,
)
from voltpilot_optimization.inputs import (
    BatterySite,
    _fresh_measurement,
    _recent_load_samples,
    _recent_pv_samples,
    gather_inputs,
)
from voltpilot_optimization.pricing import SiteTariff

# Dienstag 15.06.2027, 11:45 Europe/Berlin (Sommerzeit) = 09:45 UTC.
NOW = datetime(2027, 6, 15, 9, 45, tzinfo=timezone.utc)
TENANT = UUID("00000000-0000-0000-0000-00000000a001")
SITE = UUID("00000000-0000-0000-0000-00000000a1a1")  # AN-1
BOX_HALLE = UUID("00000000-0000-0000-0000-0000000000e1")  # E-1, fuehrt
BOX_VERWALTUNG = UUID("00000000-0000-0000-0000-0000000000e4")  # E-4
SLOTS = 16
CAPACITY_KWH = 200.0

# Beide Reihenfolgen des Eintreffens: jede Aussage muss in beiden gelten.
REIHENFOLGEN = {
    "halle_zuerst": (BOX_HALLE, BOX_VERWALTUNG),
    "verwaltung_zuerst": (BOX_VERWALTUNG, BOX_HALLE),
}


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
    """``telemetry`` als echte Tabelle; die Leser-SQL laeuft unveraendert."""

    SPALTEN = ("soc_pct", "pv_power_kw", "load_kw", "grid_limit_kw")

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.execute(
            "CREATE TABLE telemetry (time TEXT NOT NULL, tenant_id TEXT NOT NULL,"
            " site_id TEXT NOT NULL, device_id TEXT NOT NULL, power_kw REAL,"
            " soc_pct REAL, pv_power_kw REAL, load_kw REAL, grid_limit_kw REAL)"
        )
        self.abfragen: list[str] = []

    def senden(self, box: UUID, at: datetime, **werte: float) -> None:
        assert set(werte) <= set(self.SPALTEN), werte
        spalten = ", ".join(("time", "tenant_id", "site_id", "device_id", *werte))
        marken = ", ".join("?" for _ in range(4 + len(werte)))
        self.db.execute(
            f"INSERT INTO telemetry ({spalten}) VALUES ({marken})",
            (_zeit(at), str(TENANT), str(SITE), str(box), *werte.values()),
        )

    def abfrage(self, sql: str, params) -> list[tuple]:
        self.abfragen.append(" ".join(sql.split()))
        rows = self.db.execute(
            sql.replace("%s", "?"), tuple(_sql_wert(p) for p in params)
        ).fetchall()
        return [(datetime.fromisoformat(row[0]), *row[1:]) for row in rows]


class _FakeCursor:
    """Telemetrie an sqlite; alles andere wie die Attrappe in test_pv_nowcast."""

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
            self._rows = []  # Nacht-Reserve und Flow-Anspruch: nicht Gegenstand
        elif "FROM day_ahead_prices" in flat:
            self._rows = [(ts, "PT15M", 100.0) for ts in self._horizon]
        elif "FROM forecast" in flat and (
            "run_at < time" in flat or flat.startswith("SELECT run_at,")
        ):
            self._rows = []  # fruehere Laeufe: kein Anker, keine Nacht-Fehler
        elif "FROM forecast" in flat:
            value = 40.0 if params[1] == "pv" else 90.0
            self._rows = [(ts, value) for ts in self._horizon]
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


def _site(device_id: UUID | None = BOX_HALLE) -> BatterySite:
    return BatterySite(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=device_id,
        bidding_zone="DE-LU",
        battery=BatteryParams(
            capacity_kwh=CAPACITY_KWH,
            max_charge_kw=100.0,
            max_discharge_kw=100.0,
            roundtrip_efficiency=0.92,
        ),
        netzladen_erlaubt=False,
        latitude=51.3,
        longitude=9.5,
        tariff=SiteTariff(pv_capacity_kwp=150.0),
    )


def _eingang(device_id: UUID | None = BOX_HALLE):
    return gather_inputs("postgresql://fake", _site(device_id), NOW, SLOTS)


def _ohne_box(inp):
    return dataclasses.replace(inp, device_id=None)


def _kurzfrist(t: _Telemetrie, box: UUID, *, load: float, pv: float, bis: datetime) -> None:
    """Zwei Minuten Last/PV alle 5 s bis ``bis`` - die echte Telemetrie-Rate."""
    for i in range(24, -1, -1):
        t.senden(box, bis - timedelta(seconds=5 * i), load_kw=load, pv_power_kw=pv)


def _halle(t: _Telemetrie) -> None:
    """Was Box Halle 1 in R8 sendet: Speicherstand, Vorgabe, Last/PV."""
    t.senden(BOX_HALLE, NOW - timedelta(minutes=25), soc_pct=64.0)
    t.senden(BOX_HALLE, NOW - timedelta(minutes=20), grid_limit_kw=11.0)
    _kurzfrist(t, BOX_HALLE, load=80.0, pv=30.0, bis=NOW - timedelta(seconds=3))


def _verwaltung(t: _Telemetrie) -> None:
    """Box Verwaltung: juenger in JEDEM Wert - und mit "einem zweiten Speicher"
    (R8 Schritt 1: eine Zeile mit ``soc_pct`` waere heute nicht harmlos)."""
    t.senden(BOX_VERWALTUNG, NOW - timedelta(seconds=10), soc_pct=12.0)
    t.senden(BOX_VERWALTUNG, NOW - timedelta(minutes=1), grid_limit_kw=4.2)
    _kurzfrist(t, BOX_VERWALTUNG, load=5.0, pv=55.0, bis=NOW - timedelta(seconds=1))


SENDER = {BOX_HALLE: _halle, BOX_VERWALTUNG: _verwaltung}


# --- (1) Ein-Box-Anlagen: dieselben Eingaenge wie vor IP-9 -----------------


def test_ein_box_anlage_liest_dieselben_eingaenge_mit_und_ohne_box(telemetrie):
    """NW-6: sendet nur die Box der Batterie, aendert die Box-Bedingung nichts.

    ``device_id=None`` ist die Abfrage von vor IP-9 Wort fuer Wort (keine
    Box-Bedingung in der SQL); mit Box muss jedes Feld gleich herauskommen.
    """
    _halle(telemetrie)

    vorher = _eingang(device_id=None)
    ohne_box_sql = list(telemetrie.abfragen)
    telemetrie.abfragen.clear()
    nachher = _eingang(device_id=BOX_HALLE)

    assert not any("device_id" in q for q in ohne_box_sql)
    # Speicherstand, Vorgabe, Last-, PV-Fenster: genau die vier Leser von P5.
    assert sum("AND device_id = %s" in q for q in telemetrie.abfragen) == 4
    assert _ohne_box(nachher) == _ohne_box(vorher)
    # ...und es sind wirklich die gemessenen Werte, kein doppelt leeres Ergebnis:
    assert nachher.soc_source == SOC_SOURCE_GEMESSEN
    assert nachher.initial_soc_kwh == pytest.approx(0.64 * CAPACITY_KWH)
    assert nachher.grid_limit_kw == pytest.approx(11.0)
    assert nachher.pv_kw[0] == pytest.approx(30.0)


def test_ohne_box_der_entitaet_bleibt_die_abfrage_von_heute(telemetrie):
    """``asset.device_id`` NULL: die Leser lesen wie vor IP-9 die ganze Anlage."""
    _halle(telemetrie)
    _verwaltung(telemetrie)
    assert _fresh_measurement(
        "postgresql://fake", SITE, "soc_pct", NOW, soc_max_age()
    ) == pytest.approx(12.0)  # der Ist-Befund "juengste Zeile gewinnt" (ist/B B5 Nr. 3)
    assert not any("device_id" in q for q in telemetrie.abfragen)


# --- (2) R8: zwei Boxen senden --------------------------------------------


@pytest.mark.parametrize("reihenfolge", REIHENFOLGEN)
def test_r8_zwei_boxen_senden_der_eingang_ist_der_von_box_halle_allein(
    telemetrie, reihenfolge
):
    """Box Verwaltung ist in jedem Wert juenger - und aendert nichts am Eingang.

    Vergleich gegen die Welt, in der Box Verwaltung gar nicht sendet: kein
    Feld darf sich unterscheiden, in keiner Reihenfolge des Eintreffens.
    """
    for box in REIHENFOLGEN[reihenfolge]:
        SENDER[box](telemetrie)
    zwei_boxen = _eingang()

    telemetrie.db.execute(
        "DELETE FROM telemetry WHERE device_id = ?", (str(BOX_VERWALTUNG),)
    )
    nur_halle = _eingang()

    assert zwei_boxen == nur_halle
    assert zwei_boxen.initial_soc_kwh == pytest.approx(0.64 * CAPACITY_KWH)  # nie 12 %
    assert zwei_boxen.grid_limit_kw == pytest.approx(11.0)  # nie 4,2 kW
    assert zwei_boxen.pv_kw[0] == pytest.approx(30.0)  # nie 55 kW, nie ein Mischmittel


@pytest.mark.parametrize("reihenfolge", REIHENFOLGEN)
def test_r8_der_juengere_speicherstand_der_fremden_box_wird_nie_genommen(
    telemetrie, reihenfolge
):
    for box in REIHENFOLGEN[reihenfolge]:
        SENDER[box](telemetrie)
    assert _fresh_measurement(
        "postgresql://fake", SITE, "soc_pct", NOW, soc_max_age(), device_id=BOX_HALLE
    ) == pytest.approx(64.0)
    assert _fresh_measurement(
        "postgresql://fake", SITE, "grid_limit_kw", NOW, grid_limit_max_age(),
        device_id=BOX_HALLE,
    ) == pytest.approx(11.0)
    lookback = timedelta(minutes=2)
    assert set(_recent_load_samples(
        "postgresql://fake", TENANT, SITE, NOW, device_id=BOX_HALLE
    )) == {80.0}
    assert set(_recent_pv_samples(
        "postgresql://fake", TENANT, SITE, NOW,
        lookback=lookback, max_age=pv_nowcast_max_age(), device_id=BOX_HALLE,
    )) == {30.0}


@pytest.mark.parametrize("reihenfolge", REIHENFOLGEN)
def test_r8_veraltet_an_der_eigenen_box_heisst_unbekannt_nie_der_partnerwert(
    telemetrie, reihenfolge
):
    """R8 Schritt 2/3: aelter als die Frist ist fuer DIESE Box unbekannt.

    Box Halle 1 meldet jeden Wert eine Sekunde bzw. Minute ueber seiner Frist;
    Box Verwaltung ist frisch. Es gibt kein zulaessiges Alter fuer ihren Wert.
    """
    def halle_veraltet(t):
        t.senden(BOX_HALLE, NOW - timedelta(minutes=121), soc_pct=64.0)
        t.senden(BOX_HALLE, NOW - timedelta(minutes=61), grid_limit_kw=11.0)
        _kurzfrist(t, BOX_HALLE, load=80.0, pv=30.0, bis=NOW - timedelta(seconds=31))

    sender = {BOX_HALLE: halle_veraltet, BOX_VERWALTUNG: _verwaltung}
    for box in REIHENFOLGEN[reihenfolge]:
        sender[box](telemetrie)
    inp = _eingang()

    assert inp.soc_source == SOC_SOURCE_UNBEKANNT
    assert inp.grid_limit_kw is None
    # Ohne frische Kurzfrist-Werte gehoert der laufende Slot der Prognose.
    assert inp.pv_kw[0] == pytest.approx(40.0)
    assert inp.load_kw[0] == pytest.approx(90.0)
    assert _recent_load_samples(
        "postgresql://fake", TENANT, SITE, NOW, device_id=BOX_HALLE
    ) == []
    assert _recent_pv_samples(
        "postgresql://fake", TENANT, SITE, NOW, lookback=timedelta(minutes=2),
        max_age=pv_nowcast_max_age(), device_id=BOX_HALLE,
    ) == []


@pytest.mark.parametrize("reihenfolge", REIHENFOLGEN)
def test_r8_gleicher_zeitstempel_beider_boxen_entscheidet_nicht_die_ankunft(
    telemetrie, reihenfolge
):
    """Der haerteste Fall fuer "juengste Zeile gewinnt": beide Boxen melden in
    derselben Mikrosekunde. Mit Box gibt es keinen Gleichstand mehr."""
    gleich = NOW - timedelta(minutes=1)
    werte = {BOX_HALLE: 64.0, BOX_VERWALTUNG: 12.0}
    for box in REIHENFOLGEN[reihenfolge]:
        telemetrie.senden(box, gleich, soc_pct=werte[box])
    inp = _eingang()
    assert inp.initial_soc_kwh == pytest.approx(0.64 * CAPACITY_KWH)


# --- (3) Fristen unveraendert ---------------------------------------------


def test_fristen_von_heute_bleiben(telemetrie):
    """P5: "mit den Fristen von heute (30 s · 60 min · 120 min)"."""
    assert soc_max_age() == timedelta(minutes=120)
    assert grid_limit_max_age() == timedelta(minutes=60)
    assert pv_nowcast_max_age() == timedelta(seconds=30)
    load_default = inspect.signature(_recent_load_samples).parameters["max_age"].default
    assert load_default == timedelta(seconds=30)
