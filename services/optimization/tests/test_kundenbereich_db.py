"""UEMS AP-20 E10 = A against a REAL Postgres: the optimizer gives a
"beendet" or deleted customer area no plan, the neighbour keeps its plan.

Same throw-away ``timescale/timescaledb`` container pattern as
``services/forecast/tests/test_kundenbereich_db.py`` (dev bootstrap DDL from
``infra/local/timescale`` plus the columns the api adds). Self-skips without
psycopg (CI installs ``dev,solver``) or without Docker::

    uv run --extra dev --extra db --with-editable ../forecast \\
        pytest tests/test_kundenbereich_db.py
"""

from __future__ import annotations

import shutil
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_optimization.domain import (  # noqa: E402
    BatteryParams,
    PlanSlot,
    SchedulePlan,
)
from voltpilot_optimization.entities import LoadDispatch, LoadSlot, SitePlan  # noqa: E402
from voltpilot_optimization.inputs import load_battery_sites  # noqa: E402
from voltpilot_optimization.persistence import TimescaleScheduleRepository  # noqa: E402
from voltpilot_optimization.persistence_v2 import TimescaleSitePlanRepository  # noqa: E402

IMAGE = "timescale/timescaledb:2.17.2-pg16"
DDL = Path(__file__).resolve().parents[3] / "infra" / "local" / "timescale"
T0 = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)

#: What the api migrations add on top of the dev bootstrap for these paths.
_API_ZUSATZ = """
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ;
ALTER TABLE site ADD COLUMN IF NOT EXISTS netzladen_erlaubt BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE site ADD COLUMN IF NOT EXISTS latitude NUMERIC(9, 6);
ALTER TABLE site ADD COLUMN IF NOT EXISTS longitude NUMERIC(9, 6);
ALTER TABLE site ADD COLUMN IF NOT EXISTS plant_kind TEXT;
ALTER TABLE site ADD COLUMN IF NOT EXISTS tarif_art TEXT;
ALTER TABLE site ADD COLUMN IF NOT EXISTS tarif_param_ct_kwh NUMERIC;
ALTER TABLE site ADD COLUMN IF NOT EXISTS anzulegender_wert_ct_kwh NUMERIC;
ALTER TABLE site ADD COLUMN IF NOT EXISTS backup_reserve_soc_pct NUMERIC;
ALTER TABLE site ADD COLUMN IF NOT EXISTS max_feed_in_kw NUMERIC;
ALTER TABLE site ADD COLUMN IF NOT EXISTS leistungspreis_eur_kw NUMERIC;
ALTER TABLE site ADD COLUMN IF NOT EXISTS abrechnung_leistung TEXT;
ALTER TABLE site ADD COLUMN IF NOT EXISTS peak_reserve_soc_pct NUMERIC;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS commissioned_on DATE;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS pv_capacity_kwp NUMERIC;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS soc_min_pct NUMERIC;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS soc_max_pct NUMERIC;
CREATE TABLE site_supply_price (
    site_id UUID PRIMARY KEY, netzentgelt_arbeitspreis_ct NUMERIC,
    stromsteuer_ct NUMERIC, konzessionsabgabe_ct NUMERIC, umlagen_ct NUMERIC,
    vertriebsaufschlag_ct NUMERIC, ust_pct NUMERIC, komponenten_stand TEXT);
CREATE TABLE plan_zustellung (
    device_id UUID NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    plan_id UUID NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL, veroeffentlicht_um TIMESTAMPTZ,
    PRIMARY KEY (device_id, plan_id));
"""

TABELLEN = ("schedule", "site_plan_run", "entity_plan_slot", "plan_zustellung")
GESCHRIEBEN = {"schedule": 2, "site_plan_run": 1, "entity_plan_slot": 1,
               "plan_zustellung": 1}
NICHTS = dict.fromkeys(TABELLEN, 0)


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-kundenbereich-optimierer-{uuid.uuid4().hex[:8]}"
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
            for datei in ("01-init.sql", "04-schedule.sql", "06-consumer-plan.sql"):
                conn.execute((DDL / datei).read_text())
            conn.execute(_API_ZUSATZ)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _bereich(dsn: str, name: str) -> tuple[UUID, UUID, UUID]:
    """A fresh customer area: one site, one box, one battery."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute(
            "INSERT INTO tenant (name) VALUES (%s) RETURNING id", (name,)
        ).fetchone()[0]
        site = conn.execute(
            "INSERT INTO site (tenant_id, name) VALUES (%s, %s) RETURNING id",
            (tenant, name),
        ).fetchone()[0]
        device = conn.execute(
            "INSERT INTO device (tenant_id, site_id) VALUES (%s, %s) RETURNING id",
            (tenant, site),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO asset (tenant_id, site_id, device_id, type, capacity_kwh, "
            "max_charge_kw, max_discharge_kw) VALUES (%s, %s, %s, 'battery', 10, 5, 5)",
            (tenant, site, device),
        )
    return tenant, site, device


def _sql(dsn: str, sql: str, params=()) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql, params)


def _zeilen(dsn: str, tenant: UUID) -> dict[str, int]:
    with psycopg.connect(dsn) as conn:
        return {
            t: conn.execute(
                f"SELECT count(*) FROM {t} WHERE tenant_id = %s", (tenant,)
            ).fetchone()[0]
            for t in TABELLEN
        }


def _plane(dsn: str, tenant: UUID, site: UUID, device: UUID):
    """Every DB write of one optimizer cycle for one site (engine order)."""
    schedule = SchedulePlan(
        plan_id=uuid4(), tenant_id=tenant, site_id=site, device_id=device,
        generated_at=T0,
        battery=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0),
        slots=[PlanSlot(start=T0 + timedelta(minutes=15 * i), battery_kw=1.0,
                        grid_kw=0.0, soc_kwh=5.0, load_kw=1.0, pv_kw=0.0,
                        price_eur_mwh=100.0, cost_eur=0.0, baseline_cost_eur=0.0)
               for i in range(2)],
    )
    site_plan = SitePlan(
        plan_id=uuid4(), tenant_id=tenant, site_id=site, device_id=device,
        generated_at=T0,
        loads=[LoadDispatch(entity_id=f"wp-{site}", control_kind="on_off",
                            slots=[LoadSlot(T0, True, 3.0, "fixed_window", "r")])],
    )
    TimescaleScheduleRepository(dsn).upsert_plan(schedule)
    v2 = TimescaleSitePlanRepository(dsn)
    v2.upsert_site_plan(site_plan)
    lauf_nr = v2.assign_run_number(site_plan)
    v2.record_publication(site_plan, device, T0)
    return lauf_nr


def test_ein_beendeter_bereich_bekommt_keinen_plan(dsn):
    a_tenant, a_site, _ = _bereich(dsn, "A beendet")
    _, b_site, _ = _bereich(dsn, "B Nachbar")
    _sql(dsn, "UPDATE tenant SET beendet_am = now() WHERE id = %s", (a_tenant,))

    ids = {s.site_id for s in load_battery_sites(dsn)}
    assert b_site in ids
    assert a_site not in ids
    # Der Einzel-Neuplan (replan/what-if) findet die Anlage nicht mehr.
    assert load_battery_sites(dsn, a_site) == []


@pytest.mark.parametrize("ende", ["beendet", "geloescht"])
def test_nach_dem_listenlesen_legt_kein_planschreiben_etwas_an(dsn, ende):
    a_tenant, a_site, a_device = _bereich(dsn, f"A {ende}")
    b_tenant, b_site, b_device = _bereich(dsn, "B Nachbar")
    assert {a_site, b_site} <= {s.site_id for s in load_battery_sites(dsn)}

    if ende == "beendet":
        _sql(dsn, "UPDATE tenant SET beendet_am = now() WHERE id = %s", (a_tenant,))
    else:
        _sql(dsn, "DELETE FROM tenant WHERE id = %s", (a_tenant,))

    assert _plane(dsn, a_tenant, a_site, a_device) is None
    assert _plane(dsn, b_tenant, b_site, b_device) == 1
    assert _zeilen(dsn, a_tenant) == NICHTS
    assert _zeilen(dsn, b_tenant) == GESCHRIEBEN


def test_loeschzug_sperrt_zuerst_der_optimierer_laesst_den_bereich_ohne_warten_aus(dsn):
    a_tenant, a_site, a_device = _bereich(dsn, "A im Loeschzug")
    b_tenant, b_site, b_device = _bereich(dsn, "B Nachbar")
    warten = dsn + " options='-c lock_timeout=5000'"
    with psycopg.connect(dsn) as loeschzug:
        loeschzug.execute("SELECT id FROM tenant WHERE id = %s FOR UPDATE", (a_tenant,))
        start = time.monotonic()
        assert _plane(warten, a_tenant, a_site, a_device) is None
        dauer = time.monotonic() - start
        assert _plane(warten, b_tenant, b_site, b_device) == 1
        loeschzug.rollback()

    assert dauer < 2.0, f"Optimierer wartete {dauer:.1f} s auf den Löschzug"
    assert _zeilen(dsn, a_tenant) == NICHTS
    assert _zeilen(dsn, b_tenant) == GESCHRIEBEN
