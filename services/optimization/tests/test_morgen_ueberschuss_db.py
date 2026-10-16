"""NS-5 B gegen einen ECHTEN Postgres: ob heute schon ein geplanter Lade-Slot
lief, liest der Optimierer aus den gespeicherten Läufen (``schedule``), und
zwar je vergangenem Slot aus dem Lauf, der ihn ausgeführt hat.

Dasselbe Wegwerf-``timescale/timescaledb``-Muster wie
``tests/test_kundenbereich_db.py``. Überspringt sich ohne psycopg (CI
installiert ``dev,solver``) oder ohne Docker::

    uv run --extra dev --extra db --with-editable ../forecast \\
        pytest tests/test_morgen_ueberschuss_db.py
"""

from __future__ import annotations

import shutil
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_optimization.domain import (  # noqa: E402
    BatteryParams,
    PlanSlot,
    SchedulePlan,
)
from voltpilot_optimization.inputs import _heute_geplant_geladen  # noqa: E402
from voltpilot_optimization.persistence import TimescaleScheduleRepository  # noqa: E402

IMAGE = "timescale/timescaledb:2.17.2-pg16"
DDL = Path(__file__).resolve().parents[3] / "infra" / "local" / "timescale"
BERLIN = ZoneInfo("Europe/Berlin")
Q = timedelta(minutes=15)

#: Was die api-Migrationen für das Schreiben eines Plans ergänzen.
_API_ZUSATZ = "ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ;"


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-morgen-ueberschuss-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "run", "-d", "--rm", "--name", name,
         "-e", "POSTGRES_PASSWORD=pw", "-p", "127.0.0.1::5432", IMAGE],
        check=True, capture_output=True,
    )
    try:
        port = subprocess.run(
            ["docker", "port", name, "5432/tcp"],
            check=True, capture_output=True, text=True,
        ).stdout.split()[0].rsplit(":", 1)[1]
        url = (f"host=127.0.0.1 port={port} user=postgres password=pw "
               "dbname=postgres connect_timeout=2")
        frist = time.monotonic() + 90
        while True:
            try:
                with psycopg.connect(url) as probe:
                    probe.execute("SELECT 1")
                break
            except psycopg.OperationalError:
                if time.monotonic() > frist:
                    raise
                time.sleep(0.5)
        with psycopg.connect(url, autocommit=True) as conn:
            for datei in ("01-init.sql", "04-schedule.sql"):
                conn.execute((DDL / datei).read_text())
            conn.execute(_API_ZUSATZ)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _anlage(dsn: str) -> tuple[UUID, UUID]:
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute(
            "INSERT INTO tenant (name) VALUES ('Herzogau') RETURNING id"
        ).fetchone()[0]
        site = conn.execute(
            "INSERT INTO site (tenant_id, name) VALUES (%s, 'Pilsting') RETURNING id",
            (tenant,),
        ).fetchone()[0]
    return tenant, site


def _berlin(tag: int, stunde: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, tag, stunde, minute, tzinfo=BERLIN).astimezone(
        timezone.utc
    )


def _lauf(dsn, tenant, site, erzeugt: datetime, laden_kw: list[float]) -> None:
    """Ein gespeicherter Lauf: erster Slot = der laufende, je Slot der Sollwert."""
    erster = erzeugt.replace(minute=erzeugt.minute - erzeugt.minute % 15, second=0)
    TimescaleScheduleRepository(dsn).upsert_plan(
        SchedulePlan(
            plan_id=uuid4(), tenant_id=tenant, site_id=site, device_id=None,
            generated_at=erzeugt,
            battery=BatteryParams(
                capacity_kwh=65.0, max_charge_kw=30.0, max_discharge_kw=30.0
            ),
            slots=[
                PlanSlot(start=erster + i * Q, battery_kw=kw, grid_kw=0.0,
                         soc_kwh=10.0, load_kw=5.0, pv_kw=20.0,
                         price_eur_mwh=100.0, cost_eur=0.0, baseline_cost_eur=0.0)
                for i, kw in enumerate(laden_kw)
            ],
        )
    )


def test_nur_der_ausgefuehrte_slot_eines_laufs_zaehlt(dsn):
    """Der 13.10. im Kleinen: um 06:00 will der Plan erst um 06:15 laden (nur
    Zukunft, zählt nicht), die Läufe um 06:15 und 06:30 ruhen im eigenen Slot.
    Um 11:00 lädt der laufende Slot - ab dann ist der erste Lade-Slot vorbei.
    Der nächste Berliner Tag beginnt wieder ohne."""
    tenant, site = _anlage(dsn)
    _lauf(dsn, tenant, site, _berlin(13, 6) + timedelta(seconds=4), [0.0, 12.0, 12.0])
    _lauf(dsn, tenant, site, _berlin(13, 6, 15) + timedelta(seconds=4), [0.0, 0.0])
    _lauf(dsn, tenant, site, _berlin(13, 6, 30) + timedelta(seconds=4), [0.0, 0.0])

    assert _heute_geplant_geladen(dsn, site, _berlin(13, 6, 45)) is False

    # Ein Neuplan mitten im 11:00-Slot (replan) - sein erster Slot ist 11:00.
    _lauf(dsn, tenant, site, _berlin(13, 11, 7), [20.0, 20.0])
    assert _heute_geplant_geladen(dsn, site, _berlin(13, 11)) is False
    assert _heute_geplant_geladen(dsn, site, _berlin(13, 11, 15)) is True
    assert _heute_geplant_geladen(dsn, site, _berlin(13, 15)) is True

    # 23:45 Berlin lädt noch am 13. - der 14. beginnt trotzdem ohne.
    _lauf(dsn, tenant, site, _berlin(13, 23, 45) + timedelta(seconds=4), [5.0])
    assert _heute_geplant_geladen(dsn, site, _berlin(14, 0, 15)) is False
    assert _heute_geplant_geladen(dsn, site, _berlin(14, 8)) is False


def test_eine_andere_anlage_und_die_totzone_zaehlen_nicht(dsn):
    tenant, site = _anlage(dsn)
    _, nachbar = _anlage(dsn)
    _lauf(dsn, tenant, nachbar, _berlin(13, 9), [20.0])
    _lauf(dsn, tenant, site, _berlin(13, 9), [0.05])  # Rundungsrauschen, keine Ladung
    assert _heute_geplant_geladen(dsn, site, _berlin(13, 10)) is False
    assert _heute_geplant_geladen(dsn, nachbar, _berlin(13, 10)) is True
