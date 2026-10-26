"""Der Optimierer lädt eine OCPP-Säule über ihre Box-Bindung (Audit W-02).

Die Plattform komponiert eine gemeldete Säule ohne ``edge_source_id`` und ohne
``device_id`` (``ChargerComponentComposer``); verbunden ist sie über
``device_charge_point.entity_id``. ``_CONSUMER_SQL`` fragte nur die ersten
beiden ab - eine Säule mit Steuerart wurde deshalb NIE geplant, auch mit
richtiger Regelart und Nennleistung.

Gegen einen ECHTEN Wegwerf-Postgres, mit genau den Spalten, die die Abfrage
liest (api-Migrationen V20260810000000 consumer_profile/consumer_policy,
V20260828000000 device_charge_point). Überspringt sich ohne psycopg oder
Docker::

    uv run --extra dev --extra db pytest tests/test_ladepunkt_db.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_optimization.consumer_inputs import load_consumer_entities  # noqa: E402
from voltpilot_optimization.domain import horizon_slot_starts  # noqa: E402

IMAGE = "postgres:16-alpine"
VECTORS = (
    Path(__file__).resolve().parents[3]
    / "docs" / "contracts" / "v2" / "ladepunkt-profil-vectors.json"
)

DDL = """
CREATE TABLE measurement_point (
    id UUID PRIMARY KEY, site_id UUID NOT NULL, entity_type TEXT,
    edge_source_id TEXT, device_id UUID);
CREATE TABLE consumer_profile (
    entity_id UUID PRIMARY KEY, site_id UUID NOT NULL, control_kind TEXT NOT NULL,
    rated_power_kw NUMERIC(10, 3), min_power_kw NUMERIC(10, 3), levels_kw JSONB,
    power_ranges_kw JSONB, storage_relation TEXT NOT NULL DEFAULT 'consumer_first',
    default_grid_energy_policy TEXT NOT NULL DEFAULT 'allow',
    allow_storage_discharge BOOLEAN NOT NULL DEFAULT FALSE, default_service_rank SMALLINT,
    min_on_seconds INTEGER, min_off_seconds INTEGER, max_starts_per_day INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE consumer_policy (
    entity_id UUID NOT NULL, lifecycle TEXT NOT NULL, document JSONB NOT NULL);
CREATE TABLE device_charge_point (
    device_id UUID NOT NULL, charge_point_id TEXT NOT NULL, site_id UUID NOT NULL,
    entity_id UUID, PRIMARY KEY (device_id, charge_point_id));
"""


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-ladepunkt-db-{uuid.uuid4().hex[:8]}"
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
            conn.execute(DDL)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _verbraucher(dsn, site, *, entity_type, edge_source_id=None, saeule_an=None):
    """Eine Komponente mit Profil (wie die API) und aktiver Policy aus den Vektoren."""
    vektoren = json.loads(VECTORS.read_text(encoding="utf-8"))
    (fall,) = [f for f in vektoren["faelle"] if f["name"] == "guenstig-mit-ziel"]
    entity = uuid4()
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO measurement_point (id, site_id, entity_type, edge_source_id) "
            "VALUES (%s, %s, %s, %s)", (entity, site, entity_type, edge_source_id))
        conn.execute(
            "INSERT INTO consumer_profile (entity_id, site_id, control_kind, rated_power_kw, "
            "enabled) VALUES (%s, %s, %s, %s, TRUE)",
            (entity, site, fall["profil"]["control_kind"], fall["profil"]["rated_power_kw"]))
        conn.execute(
            "INSERT INTO consumer_policy (entity_id, lifecycle, document) "
            "VALUES (%s, 'active', %s::jsonb)",
            (entity, json.dumps(fall["dokument"])))
        if saeule_an is not None:
            conn.execute(
                "INSERT INTO device_charge_point (device_id, charge_point_id, site_id, entity_id) "
                "VALUES (%s, %s, %s, %s)", (saeule_an, f"CP-{entity.hex[:6]}", site, entity))
    return str(entity)


def test_eine_an_ihre_box_gebundene_saeule_wird_geplant(dsn):
    site, box = uuid4(), uuid4()
    gebunden = _verbraucher(dsn, site, entity_type="ev-charger", saeule_an=box)
    mit_quelle = _verbraucher(dsn, site, entity_type="heating-rod", edge_source_id="shelly-1")
    # Ohne Quelle und ohne Bindung bleibt eine Komponente draußen (§17), wie vorher.
    _verbraucher(dsn, site, entity_type="ev-charger")
    # Die Bindung einer FREMDEN Anlage verbindet hier nichts.
    fremd = _verbraucher(dsn, site, entity_type="ev-charger")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO device_charge_point (device_id, charge_point_id, site_id, entity_id) "
            "VALUES (%s, 'CP-FREMD', %s, %s)", (uuid4(), uuid4(), fremd))

    jetzt = datetime(2026, 10, 24, 20, 0, tzinfo=timezone.utc)
    starts = horizon_slot_starts(jetzt, 48)
    loads = load_consumer_entities(dsn, site, starts, 15, [10.0] * 48, [35.0] * 48)

    assert sorted(e.entity_id for e in loads) == sorted([gebunden, mit_quelle])
    (saeule,) = [e for e in loads if e.entity_id == gebunden]
    assert saeule.control_kind == "continuous"
    assert saeule.max_power_kw == 11.0
