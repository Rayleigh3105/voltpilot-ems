"""NS-2 A gegen einen ECHTEN Postgres: der Optimierer liest den Vorsprung mit
Bestand aus der Tabelle, die die api-Migration anlegt und der api-Läufer
schreibt (``steuerung_vorsprung``, Vertrag
``docs/contracts/steuerung-vorsprung-v1.md``). Die Tabelle entsteht aus der
MIGRATIONSDATEI selbst - ein umbenannter Spaltenname oder Typ fällt hier auf.

Dasselbe Wegwerf-``timescale/timescaledb``-Muster wie
``tests/test_morgen_ueberschuss_db.py``. Überspringt sich ohne psycopg oder
ohne Docker::

    uv run --extra dev --extra db --with-editable ../forecast \\
        pytest tests/test_vorsprung_budget_db.py
"""

from __future__ import annotations

import shutil
import subprocess
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_optimization.domain import VorsprungStand  # noqa: E402
from voltpilot_optimization.inputs import _vorsprung_stand  # noqa: E402

IMAGE = "timescale/timescaledb:2.17.2-pg16"
WURZEL = Path(__file__).resolve().parents[3]
DDL = WURZEL / "infra" / "local" / "timescale"
MIGRATION = (
    WURZEL / "services" / "api" / "src" / "main" / "resources" / "db" / "migration"
    / "V20261017031500__steuerung_vorsprung.sql"
)

#: Was die api-Migrationen davor für diese Tabelle schon angelegt haben: die
#: zwei Rollen und den zusammengesetzten Schlüssel der Anlage.
_API_ZUSATZ = """
CREATE ROLE voltpilot_app;
CREATE ROLE voltpilot_admin;
ALTER TABLE site ADD CONSTRAINT uq_site_id_tenant_identity UNIQUE (id, tenant_id);
"""


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-vorsprung-{uuid.uuid4().hex[:8]}"
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
        migration = (
            MIGRATION.read_text()
            .replace("${appDbUser}", "voltpilot_app")
            .replace("${adminDbUser}", "voltpilot_admin")
        )
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute((DDL / "01-init.sql").read_text())
            conn.execute(_API_ZUSATZ)
            conn.execute(migration)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def test_der_optimierer_liest_die_zeile_der_api(dsn):
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute(
            "INSERT INTO tenant (name) VALUES ('Herzogau') RETURNING id").fetchone()[0]
        site = conn.execute(
            "INSERT INTO site (tenant_id, name) VALUES (%s, 'Pilsting') RETURNING id",
            (tenant,),
        ).fetchone()[0]
        ohne = conn.execute(
            "INSERT INTO site (tenant_id, name) VALUES (%s, 'ohne Zeile') RETURNING id",
            (tenant,),
        ).fetchone()[0]
        # So schreibt der api-Läufer (SteuerungVorsprungRepository#upsert).
        conn.execute(
            """
            INSERT INTO steuerung_vorsprung (site_id, tenant_id, tag, messung_bis,
                bewertung_ct_kwh, vorsprung_kwh, kapazitaet_kwh, monat_mit_bestand_eur,
                sieben_tage_mit_bestand_eur, tage_mit_bestand_eur, berechnet_am)
            VALUES (%s, %s, '2026-10-13', '2026-10-13T10:15:00Z', 23.98, -4.5, 59.7,
                    12.34, NULL, ARRAY[1.10, NULL, 0, -0.25, 0, 2]::numeric[], now())
            """,
            (site, tenant),
        )
    stand = _vorsprung_stand(dsn, site)
    assert stand == VorsprungStand(
        messung_bis=datetime(2026, 10, 13, 10, 15, tzinfo=timezone.utc),
        tag=date(2026, 10, 13),
        bewertung_ct_kwh=23.98,
        vorsprung_kwh=-4.5,
        kapazitaet_kwh=59.7,
        monat_eur=12.34,
        sieben_tage_eur=None,
        tage_eur=(1.1, None, 0.0, -0.25, 0.0, 2.0),
    )
    assert _vorsprung_stand(dsn, ohne) is None


def test_die_tabelle_ist_mandanten_gezaeunt(dsn):
    """Die Laufzeitrolle sieht nur ihren Kundenbereich (RLS mit FORCE)."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert conn.execute(
            "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class"
            " WHERE relname = 'steuerung_vorsprung'"
        ).fetchone()[0] is True
        assert conn.execute(
            "SELECT has_table_privilege('voltpilot_app', 'steuerung_vorsprung', 'UPDATE')"
        ).fetchone()[0] is True
        assert conn.execute(
            "SELECT has_table_privilege('voltpilot_admin', 'steuerung_vorsprung', 'INSERT')"
        ).fetchone()[0] is False
    # Kapazität muss positiv sein, höchstens 6 Tage stehen einzeln.
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute("INSERT INTO tenant (name) VALUES ('X') RETURNING id").fetchone()[0]
        site = conn.execute(
            "INSERT INTO site (tenant_id, name) VALUES (%s, 'X') RETURNING id", (tenant,)
        ).fetchone()[0]
        for kaputt in ("0, ARRAY[]::numeric[]", "60, ARRAY[1,2,3,4,5,6,7]::numeric[]"):
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute(
                    "INSERT INTO steuerung_vorsprung (site_id, tenant_id, tag, messung_bis,"
                    " bewertung_ct_kwh, vorsprung_kwh, kapazitaet_kwh, tage_mit_bestand_eur)"
                    f" VALUES (%s, %s, '2026-10-13', now(), 23.98, 0, {kaputt})",
                    (site, tenant),
                )
