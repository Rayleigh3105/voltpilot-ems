"""AP-15 Folgepunkt ``vp-uems-v15-folge-leser-je-anlage``: die Leser je Anlage einer Mehr-Box-Anlage.

W2 ("zwei Fragen, zwei Anker") und B1: Anlagen-Summen liest man an der FUEHRENDEN
Box - sie liest den Netzzaehler; die PV der Anlage ist die Summe der Boxen. Die
echte Leser-SQL laeuft gegen echte Tabellen (sqlite im Speicher, Muster
``test_eingang_je_box``): ``telemetry`` fuer die drei rohen Leser, ``site`` und
``device`` fuer :func:`load_fuehrende_boxen`. Der vierte Leser
(``night_reserve._measured_load_slots``) und der abgeschlossene Teil der
Lastspitze lesen ``telemetry_rollup_15m``; das Rollup rechnet die Prozedur der
api (``V20260922020000``, bewiesen in ``UemsRollupMehrBoxMigrationTest``).
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from voltpilot_optimization.inputs import (
    _load_history,
    _measured_slot_means,
    _peak_so_far_kw,
    load_fuehrende_boxen,
)

# Dienstag 15.06.2027, 11:45 Europe/Berlin = 09:45 UTC; die laufende Viertelstunde
# beginnt 09:45, die abgeschlossene davor 09:30.
NOW = datetime(2027, 6, 15, 9, 59, 55, tzinfo=timezone.utc)
SLOT = datetime(2027, 6, 15, 9, 45, tzinfo=timezone.utc)
VORHER = SLOT - timedelta(minutes=15)
TENANT = UUID("00000000-0000-0000-0000-00000000a001")  # Kunststoffwerk Ahrenberg
AN_1 = UUID("00000000-0000-0000-0000-00000000a1a1")  # Werk Ahrenberg - Halle 1
E_1 = UUID("00000000-0000-0000-0000-0000000000e1")  # Box Halle 1 (fuehrend, Netzzaehler)
E_4 = UUID("00000000-0000-0000-0000-0000000000e4")  # Box Verwaltung (Abgang)


def _zeit(ts: datetime) -> str:
    # Feste Breite, damit der Textvergleich in sqlite der Zeitvergleich ist.
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def _sql_wert(value):
    if isinstance(value, datetime):
        return _zeit(value)
    if isinstance(value, UUID):
        return str(value)
    return value


class _Welt:
    """``telemetry``, ``site`` und ``device`` als echte Tabellen; die Leser-SQL laeuft unveraendert."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.create_function(
            "greatest", 2, lambda a, b: None if a is None else max(a, b)
        )
        self.db.execute(
            "CREATE TABLE telemetry (time TEXT NOT NULL, tenant_id TEXT NOT NULL,"
            " site_id TEXT NOT NULL, device_id TEXT NOT NULL, power_kw REAL,"
            " soc_pct REAL, pv_power_kw REAL, load_kw REAL, grid_limit_kw REAL)"
        )
        self.db.execute("CREATE TABLE site (id TEXT PRIMARY KEY, lead_device_id TEXT)")
        self.db.execute(
            "CREATE TABLE device (id TEXT PRIMARY KEY, site_id TEXT, ausgebaut_am TEXT)"
        )
        self.abfragen: list[str] = []

    def senden(self, box: UUID, slot: datetime, versatz_s: int = 0, **werte) -> None:
        """90 Proben im 10-s-Takt ueber die Viertelstunde (die laufende bis ``NOW``)."""
        spalten = ", ".join(("time", "tenant_id", "site_id", "device_id", *werte))
        marken = ", ".join("?" for _ in range(4 + len(werte)))
        for i in range(90):
            at = slot + timedelta(seconds=10 * i + versatz_s)
            if at > NOW:
                break
            self.db.execute(
                f"INSERT INTO telemetry ({spalten}) VALUES ({marken})",
                (_zeit(at), str(TENANT), str(AN_1), str(box), *werte.values()),
            )

    def abfrage(self, sql: str, params) -> list[tuple]:
        self.abfragen.append(" ".join(sql.split()))
        rows = self.db.execute(
            sql.replace("%s", "?"), tuple(_sql_wert(p) for p in params)
        ).fetchall()
        return [
            (datetime.fromisoformat(r[0]), *r[1:]) if isinstance(r[0], str) and "T" in r[0] else r
            for r in rows
        ]


class _Cursor:
    def __init__(self, welt: _Welt) -> None:
        self._w = welt
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if "FROM telemetry_rollup_15m" in sql:
            self._rows = []  # das Rollup rechnet die api (UemsRollupMehrBoxMigrationTest)
        else:
            self._rows = self._w.abfrage(sql, params)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


@pytest.fixture()
def welt(monkeypatch) -> _Welt:
    w = _Welt()

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor(w)

    errors = SimpleNamespace(UndefinedTable=type("UT", (Exception,), {}),
                             UndefinedColumn=type("UC", (Exception,), {}))
    monkeypatch.setitem(
        sys.modules, "psycopg", SimpleNamespace(connect=lambda dsn: _Conn(), errors=errors)
    )
    return w


def _zwei_boxen(w: _Welt) -> None:
    # R3 in der laufenden Viertelstunde: 367 kW am Netzzaehler, 77 kW am Abgang Verwaltung.
    w.senden(E_1, SLOT, power_kw=367.0, load_kw=367.0, pv_power_kw=0.0)
    w.senden(E_4, SLOT, 5, power_kw=77.0, load_kw=77.0, pv_power_kw=0.0)
    # Davor PV an beiden Boxen, jede mit ausgeglichener eigener Bilanz: Halle 1 240 kW
    # Bezug, 20 kW PV, Last 260 kW; Verwaltung -40 kW, 60 kW PV, Last 20 kW.
    # Die Anlage: 240 kW Bezug, 80 kW PV, 320 kW Last.
    w.senden(E_1, VORHER, power_kw=240.0, load_kw=260.0, pv_power_kw=20.0)
    w.senden(E_4, VORHER, 5, power_kw=-40.0, load_kw=20.0, pv_power_kw=60.0)


# ---- (1) laufende Lastspitze ---------------------------------------------------------


def test_r3_laufende_lastspitze_rot_ohne_fuehrende_box_geheilt_an_ihr(welt):
    _zwei_boxen(welt)
    heute = _peak_so_far_kw("dsn", AN_1, NOW, "jahr")
    geheilt = _peak_so_far_kw("dsn", AN_1, NOW, "jahr", fuehrende_box=E_1)
    assert heute == pytest.approx(222.0)
    assert geheilt == pytest.approx(367.0)
    assert welt.abfragen[-1].endswith("AND time <= %s AND device_id = %s")


# ---- (2) PV-Anker und Rueckfall-Historie ---------------------------------------------


def test_pv_anker_ist_die_summe_der_boxen_nicht_ihr_mittel(welt):
    _zwei_boxen(welt)
    assert _measured_slot_means("dsn", AN_1, "pv_power_kw", [VORHER]) == {
        VORHER: pytest.approx(40.0)
    }
    assert _measured_slot_means(
        "dsn", AN_1, "pv_power_kw", [VORHER], fuehrende_box=E_1
    ) == {VORHER: pytest.approx(80.0)}


def test_last_historie_an_der_fuehrenden_box_plus_nettoabgabe_der_anderen(welt):
    _zwei_boxen(welt)
    heute = _load_history("dsn", AN_1, "load_kw", NOW)
    geheilt = dict(_load_history("dsn", AN_1, "load_kw", NOW, fuehrende_box=E_1))
    # heute: 360 rohe Proben beider Boxen durcheinander (Mittel des Slots 140 kW)
    assert len(heute) == 4 * 90
    # 260 + (20 - (-40)) = 320 kW: Bezug 240 = Last 320 - PV 80, die Bilanz geht auf.
    assert geheilt[VORHER] == pytest.approx(320.0)
    # R3: 367 + (77 - 77) = 367 kW - der Abgang liegt hinter dem Netzzaehler.
    assert geheilt[SLOT] == pytest.approx(367.0)
    pv = dict(_load_history("dsn", AN_1, "pv_power_kw", NOW, fuehrende_box=E_1))
    assert pv[VORHER] == pytest.approx(80.0)


def test_ohne_nettoabgabe_einer_sendenden_box_ist_die_last_unbekannt(welt):
    welt.senden(E_1, VORHER, power_kw=300.0, load_kw=300.0, pv_power_kw=0.0)
    welt.senden(E_4, VORHER, 5, pv_power_kw=30.0)  # nur PV, kein Paar load/power
    welt.senden(E_1, SLOT, power_kw=250.0, load_kw=250.0, pv_power_kw=0.0)  # Verwaltung stumm
    geheilt = dict(_load_history("dsn", AN_1, "load_kw", NOW, fuehrende_box=E_1))
    assert VORHER not in geheilt  # unbekannt, nie die zu kleine Zahl 300
    assert geheilt[SLOT] == pytest.approx(250.0)  # wer nicht sendet, zaehlt nicht


# ---- (3) welche Anlage eine fuehrende Box hat ---------------------------------------


def test_fuehrende_box_nur_in_einer_mehr_box_anlage_mit_bestimmter_wahl(welt):
    anlagen = {
        "ZWEI": ("e1", ["e1", "e4"], None),
        "EINS": ("x1", ["x1"], None),  # Ein-Box-Anlage mit gespeicherter Wahl
        "OHNE": (None, ["o1", "o2"], None),  # keine gespeicherte Wahl
        "AUS": ("a1", ["a1", "a2"], "a1"),  # gewaehlte Box ausgebaut
        "FREMD": ("e4", ["f1", "f2"], None),  # gewaehlte Box in einer anderen Anlage
    }
    ids = {}
    for nr, (name, (lead, boxen, ausgebaut)) in enumerate(anlagen.items(), start=1):
        ids[name] = UUID(int=nr)
        welt.db.execute(
            "INSERT INTO site VALUES (?, ?)",
            (str(ids[name]), str(_box(lead)) if lead else None),
        )
        for b in boxen:
            welt.db.execute(
                "INSERT INTO device VALUES (?, ?, ?)",
                (str(_box(b)), str(ids[name]), "2027-06-01" if b == ausgebaut else None),
            )
    assert load_fuehrende_boxen("dsn") == {ids["ZWEI"]: _box("e1")}
    assert load_fuehrende_boxen("dsn", ids["ZWEI"]) == {ids["ZWEI"]: _box("e1")}
    assert load_fuehrende_boxen("dsn", ids["EINS"]) == {}


def _box(name: str) -> UUID:
    return UUID(int=int.from_bytes(name.encode(), "big"))


# ---- (4) Ein-Box-Anlage: Wort fuer Wort wie heute -----------------------------------

_SQL_VON_HEUTE = {
    "lastspitze": "SELECT avg(greatest(power_kw, 0)) FROM telemetry WHERE site_id = %s"
    " AND power_kw IS NOT NULL AND time >= %s AND time <= %s",
    "pv_anker": "SELECT time, pv_power_kw FROM telemetry WHERE site_id = %s AND"
    " pv_power_kw IS NOT NULL AND time >= %s AND time < %s ORDER BY time",
    "historie": "SELECT time, load_kw FROM telemetry WHERE site_id = %s AND load_kw"
    " IS NOT NULL AND time >= %s ORDER BY time",
}


def test_ein_box_anlage_liest_wort_fuer_wort_und_wert_fuer_wert_wie_heute(welt):
    welt.senden(E_1, VORHER, power_kw=-25.0, load_kw=35.0, pv_power_kw=70.0)
    welt.senden(E_1, SLOT, power_kw=120.0, load_kw=150.0, pv_power_kw=30.0)
    # ohne fuehrende Box (so liefert load_fuehrende_boxen jede Ein-Box-Anlage)
    spitze = _peak_so_far_kw("dsn", AN_1, NOW, "jahr")
    anker = _measured_slot_means("dsn", AN_1, "pv_power_kw", [VORHER])
    historie = _load_history("dsn", AN_1, "load_kw", NOW)
    telemetrie = [q for q in welt.abfragen if "FROM telemetry " in q + " "]
    assert telemetrie == [
        _SQL_VON_HEUTE["lastspitze"], _SQL_VON_HEUTE["pv_anker"], _SQL_VON_HEUTE["historie"]
    ]
    assert spitze == pytest.approx(120.0)
    assert anker == {VORHER: pytest.approx(70.0)}
    # und selbst MIT fuehrender Box aendert eine einzige sendende Box keinen Wert
    assert _peak_so_far_kw("dsn", AN_1, NOW, "jahr", fuehrende_box=E_1) == spitze
    assert _measured_slot_means(
        "dsn", AN_1, "pv_power_kw", [VORHER], fuehrende_box=E_1
    ) == pytest.approx(anker)
    je_slot = dict(_load_history("dsn", AN_1, "load_kw", NOW, fuehrende_box=E_1))
    assert je_slot == {VORHER: pytest.approx(35.0), SLOT: pytest.approx(150.0)}
    assert len(historie) == 2 * 90
