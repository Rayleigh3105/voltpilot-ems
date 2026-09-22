"""AP-15 Folgepaket ``vp-uems-v15-folge-mehrbox-restleser``: der Forecast liest je Anlage.

Eine Mehr-Box-Anlage mit bestimmter fuehrender Box liest ihre Istwerte ueber die eine
Regel der api (``telemetry_anlage_15m``, ``V20260922170000``); jede andere Anlage
stellt die rohe Abfrage von vorher, Zeichen fuer Zeichen. Die Zahlen der Funktion
selbst (367 statt 222 kW, PV 80, Last 320) beweist ``UemsAnlageLeserMigrationTest``
gegen TimescaleDB mit genau diesen SQL-Texten; hier geht es um den Weg dorthin.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from voltpilot_forecast.anlage import anlage_slot_kw
from voltpilot_forecast.evaluate import _actuals
from voltpilot_forecast.forecast_collect import _telemetry_history

SITE = "00000000-0000-0000-0000-00000000a1a1"
BOX = "00000000-0000-0000-0000-0000000000e1"
R3 = datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc)
PV = R3 + timedelta(minutes=15)
START = R3
END = R3 + timedelta(hours=1)

# Die rohen Abfragen von vor diesem Paket, woertlich (Whitespace normalisiert).
EVAL_VORHER = (
    "SELECT time_bucket('15 minutes', time) AS bucket, avg(load_kw) FROM telemetry "
    "WHERE site_id = %s AND load_kw IS NOT NULL AND time >= %s AND time < %s "
    "GROUP BY bucket"
)
COLLECT_VORHER = (
    "SELECT time, pv_power_kw FROM telemetry "
    "WHERE site_id = %s AND pv_power_kw IS NOT NULL AND time >= %s ORDER BY time"
)


class _Cursor:
    """Protokolliert jede Abfrage; die fuehrende Box und die Zeilen sind vorgegeben."""

    def __init__(self, fuehrend: str | None, rows: list) -> None:
        self.fuehrend = fuehrend
        self.rows = rows
        self.calls: list[tuple[str, tuple]] = []
        self._next: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        self.calls.append((sql, tuple(params)))
        self._next = [(self.fuehrend,)] if "telemetry_fuehrende_box" in sql else self.rows

    def fetchone(self):
        return self._next[0] if self._next else None

    def fetchall(self):
        return self._next


class _Conn:
    def __init__(self, cur: _Cursor) -> None:
        self.cur = cur

    def cursor(self):
        return self.cur


def test_ein_box_anlage_stellt_die_rohen_abfragen_von_vorher():
    cur = _Cursor(None, [(R3, Decimal("150.0"))])
    assert _actuals(cur, SITE, "load_kw", START, END) == {R3: 150.0}
    assert cur.calls[-1] == (EVAL_VORHER, (SITE, START, END))

    cur = _Cursor(None, [(R3, Decimal("30.0"))])
    history = _telemetry_history(_Conn(cur), SITE, "pv_power_kw", START)
    assert [(o.timestamp, o.value_kw) for o in history] == [(R3, 30.0)]
    assert cur.calls[-1] == (COLLECT_VORHER, (SITE, START))
    # Nur die Frage nach der fuehrenden Box ist dazugekommen, sonst nichts.
    assert [c[0] for c in cur.calls] == ["SELECT telemetry_fuehrende_box(%s)", COLLECT_VORHER]


def test_mehr_box_anlage_liest_die_anlagen_summe_ueber_die_eine_regel():
    # So liefert telemetry_anlage_15m die Zwei-Box-Anlage (kWh je Viertelstunde x 4).
    cur = _Cursor(BOX, [(R3, Decimal("367.0")), (PV, Decimal("240.0"))])
    assert _actuals(cur, SITE, "power_kw", START, END) == {R3: 367.0, PV: 240.0}
    sql, params = cur.calls[-1]
    assert sql == (
        "SELECT bucket, (grid_import_kwh - grid_export_kwh) * 4 "
        "FROM telemetry_anlage_15m(%s, %s, %s) "
        "WHERE (grid_import_kwh - grid_export_kwh) * 4 IS NOT NULL ORDER BY bucket"
    )
    assert params == (START, END, SITE)
    assert "FROM telemetry " not in sql

    cur = _Cursor(BOX, [(PV, Decimal("80.0"))])
    history = _telemetry_history(_Conn(cur), SITE, "pv_power_kw", START)
    assert [(o.timestamp, o.value_kw) for o in history] == [(PV, 80.0)]
    assert cur.calls[-1] == (
        "SELECT bucket, pv_kwh * 4 FROM telemetry_anlage_15m(%s, %s, %s) "
        "WHERE pv_kwh * 4 IS NOT NULL ORDER BY bucket",
        (START, None, SITE),
    )


@pytest.mark.parametrize(
    ("column", "expr"),
    [("load_kw", "load_kwh * 4"), ("pv_power_kw", "pv_kwh * 4"),
     ("power_kw", "(grid_import_kwh - grid_export_kwh) * 4")],
)
def test_jede_groesse_hat_genau_ihren_ausdruck(column, expr):
    cur = _Cursor(BOX, [])
    assert anlage_slot_kw(cur, SITE, column, START, END) == []
    assert cur.calls[-1][0].startswith(f"SELECT bucket, {expr} FROM telemetry_anlage_15m")


def test_fremde_spalte_wird_abgelehnt():
    with pytest.raises(ValueError):
        anlage_slot_kw(_Cursor(BOX, []), SITE, "soc_pct; DROP TABLE t", START, END)
