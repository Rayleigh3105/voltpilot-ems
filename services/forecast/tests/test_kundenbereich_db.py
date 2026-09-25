"""UEMS AP-20 E10 = A against a REAL Postgres: the forecast writers leave a
"beendet" or deleted customer area alone, the neighbour keeps running.

The fake-connection tests (``test_kundenbereich.py``) pin the shape; only a
database can show the lock semantics (``FOR KEY SHARE ... SKIP LOCKED``
against the Löschzug's ``FOR UPDATE``). The fixture starts a throw-away
``timescale/timescaledb`` container and loads the dev bootstrap DDL
(``infra/local/timescale``, the mirror of the api migrations) plus the few
columns/tables the api adds. It self-skips without psycopg (the ``db`` extra -
CI installs ``dev,ml`` only) or without Docker, like the Testcontainers tests
of the JVM services::

    uv run --extra dev --extra db pytest tests/test_kundenbereich_db.py
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_forecast import evaluate, weather_collect  # noqa: E402
from voltpilot_forecast.domain import (  # noqa: E402
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
)
from voltpilot_forecast.forecast_collect import load_sites  # noqa: E402
from voltpilot_forecast.kundenbereich import lebenden_bereich_sperren  # noqa: E402
from voltpilot_forecast.openmeteo import WeatherForecast, WeatherPoint  # noqa: E402
from voltpilot_forecast.quality_repository import (  # noqa: E402
    AccuracyRecord,
    ModelState,
    PlanAccuracyRecord,
    TimescaleQualityRepository,
)
from voltpilot_forecast.repository import TimescaleForecastRepository  # noqa: E402
from voltpilot_forecast.weather_repository import (  # noqa: E402
    TimescaleWeatherForecastRepository,
)

IMAGE = "timescale/timescaledb:2.17.2-pg16"
DDL = Path(__file__).resolve().parents[3] / "infra" / "local" / "timescale"
T0 = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
TAG = date(2026, 9, 24)

#: What the api migrations add on top of the dev bootstrap for these writers.
_API_ZUSATZ = """
ALTER TABLE asset ADD COLUMN IF NOT EXISTS pv_capacity_kwp NUMERIC(10, 3);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS azimuth_deg NUMERIC(6, 2);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS tilt_deg NUMERIC(6, 2);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE forecast_model_state (
    tenant_id UUID NOT NULL, site_id UUID NOT NULL, model TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, days_collected INTEGER,
    days_required INTEGER, trained_at TIMESTAMPTZ, train_rows INTEGER,
    feature_importance JSONB, updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (site_id, model));
CREATE TABLE forecast_accuracy (
    day DATE NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    model TEXT NOT NULL, kind TEXT NOT NULL, mae_kw NUMERIC, nmae_pct NUMERIC,
    bias_kw NUMERIC, skill_vs_baseline NUMERIC, n_slots INTEGER,
    computed_at TIMESTAMPTZ, PRIMARY KEY (site_id, model, day));
CREATE TABLE plan_accuracy (
    day DATE NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    planned_cost_eur NUMERIC, baseline_cost_eur NUMERIC,
    realized_cost_eur NUMERIC, n_slots INTEGER, computed_at TIMESTAMPTZ,
    PRIMARY KEY (site_id, day));
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ;
"""

#: The five tables the forecast service writes per site.
TABELLEN = (
    "forecast",
    "forecast_model_state",
    "forecast_accuracy",
    "plan_accuracy",
    "weather_forecast",
)


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-kundenbereich-forecast-{uuid.uuid4().hex[:8]}"
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
            for datei in ("01-init.sql", "02-forecast.sql", "03-weather.sql"):
                conn.execute((DDL / datei).read_text())
            conn.execute(_API_ZUSATZ)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _bereich(dsn: str, name: str) -> tuple[str, str]:
    """A fresh customer area with one site at a real location."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute(
            "INSERT INTO tenant (name) VALUES (%s) RETURNING id", (name,)
        ).fetchone()[0]
        site = conn.execute(
            "INSERT INTO site (tenant_id, name, latitude, longitude) "
            "VALUES (%s, %s, 52.52, 13.40) RETURNING id",
            (tenant, name),
        ).fetchone()[0]
    return str(tenant), str(site)


def _sql(dsn: str, sql: str, params=()) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql, params)


def _zeilen(dsn: str, tenant: str) -> dict[str, int]:
    with psycopg.connect(dsn) as conn:
        return {
            t: conn.execute(
                f"SELECT count(*) FROM {t} WHERE tenant_id = %s", (tenant,)
            ).fetchone()[0]
            for t in TABELLEN
        }


def _schreibe_alles(conn, tenant: str, site: str) -> None:
    """One forecast cycle's writes for one site (collector + evaluation + weather)."""
    TimescaleForecastRepository(conn).save(
        ForecastSeries(
            kind=ForecastKind.LOAD, site_id=site, tenant_id=tenant, run_at=T0,
            method="persistence",
            points=[ForecastPoint(T0 + timedelta(minutes=15 * i), 1.0) for i in (1, 2)],
            model="load-persistence",
        )
    )
    quality = TimescaleQualityRepository(conn)
    quality.upsert_model_state(ModelState(
        tenant_id=tenant, site_id=site, model="load-persistence", kind="load",
        status="ready", updated_at=T0,
    ))
    quality.upsert_accuracy(AccuracyRecord(
        day=TAG, tenant_id=tenant, site_id=site, model="load-persistence",
        kind="load", mae_kw=0.1, n_slots=96,
    ))
    quality.upsert_plan_accuracy(PlanAccuracyRecord(
        day=TAG, tenant_id=tenant, site_id=site, n_slots=96, planned_cost_eur=1.0,
    ))
    TimescaleWeatherForecastRepository(conn).save(WeatherForecast(
        tenant_id=tenant, site_id=site, latitude=52.52, longitude=13.40, run_at=T0,
        points=(WeatherPoint(T0 + timedelta(hours=1), 18.0, 40.0, 300.0),),
    ))


def _site_ids(dsn: str) -> dict[str, set[str]]:
    with psycopg.connect(dsn) as conn:
        collector = {s.site_id for s in load_sites(conn)}
        with conn.cursor() as cur:
            bewertung = {site for _, site in evaluate._sites(cur)}
    wetter = {s.site_id for s in weather_collect.load_sites_with_coordinates(dsn)}
    return {"collector": collector, "bewertung": bewertung, "wetter": wetter}


#: One site's cycle: two forecast slots, one row everywhere else.
GESCHRIEBEN = {**dict.fromkeys(TABELLEN, 1), "forecast": 2}
NICHTS = dict.fromkeys(TABELLEN, 0)


def test_ein_beendeter_bereich_fehlt_in_jeder_anlagenliste(dsn):
    a_tenant, a_site = _bereich(dsn, "A beendet")
    _, b_site = _bereich(dsn, "B Nachbar")
    _sql(dsn, "UPDATE tenant SET beendet_am = now() WHERE id = %s", (a_tenant,))

    for liste, ids in _site_ids(dsn).items():
        assert b_site in ids, liste
        assert a_site not in ids, f"{liste}: beendeter Bereich in der Anlagenliste"


@pytest.mark.parametrize("ende", ["beendet", "geloescht"])
def test_nach_dem_listenlesen_legt_kein_schreiben_etwas_an(dsn, ende):
    """Der Zyklus liest die Liste, DANACH endet der Bereich - mitten im Zyklus
    beendet, oder der Löschzug hat die Mandantenzeile schon gelöscht."""
    a_tenant, a_site = _bereich(dsn, f"A {ende}")
    b_tenant, b_site = _bereich(dsn, "B Nachbar")
    assert {a_site, b_site} <= _site_ids(dsn)["collector"]

    if ende == "beendet":
        _sql(dsn, "UPDATE tenant SET beendet_am = now() WHERE id = %s", (a_tenant,))
    else:
        _sql(dsn, "DELETE FROM tenant WHERE id = %s", (a_tenant,))

    with psycopg.connect(dsn) as conn:
        _schreibe_alles(conn, a_tenant, a_site)
        _schreibe_alles(conn, b_tenant, b_site)

    assert _zeilen(dsn, a_tenant) == NICHTS
    assert _zeilen(dsn, b_tenant) == GESCHRIEBEN


def test_loeschzug_sperrt_zuerst_der_zyklus_laesst_den_bereich_ohne_warten_aus(dsn):
    a_tenant, a_site = _bereich(dsn, "A im Loeschzug")
    b_tenant, b_site = _bereich(dsn, "B Nachbar")
    # Die erste Sperre des Löschzugs (Wache#vorDemAbbau), offen gehalten.
    with psycopg.connect(dsn) as loeschzug:
        loeschzug.execute(
            "SELECT id FROM tenant WHERE id = %s FOR UPDATE", (a_tenant,)
        )
        with psycopg.connect(dsn) as conn:
            conn.execute("SET lock_timeout = '5s'")
            conn.commit()
            start = time.monotonic()
            _schreibe_alles(conn, a_tenant, a_site)
            dauer = time.monotonic() - start
            _schreibe_alles(conn, b_tenant, b_site)
        loeschzug.rollback()

    assert dauer < 2.0, f"Zyklus wartete {dauer:.1f} s auf den Löschzug"
    assert _zeilen(dsn, a_tenant) == NICHTS
    assert _zeilen(dsn, b_tenant) == GESCHRIEBEN


def test_zyklus_sperrt_zuerst_der_loeschzug_wartet_und_nimmt_die_zeilen_mit(dsn):
    a_tenant, a_site = _bereich(dsn, "A")
    b_tenant, b_site = _bereich(dsn, "B Nachbar")
    with psycopg.connect(dsn) as conn:
        _schreibe_alles(conn, b_tenant, b_site)
    zyklus = psycopg.connect(dsn)
    try:
        # Die Transaktion von TimescaleForecastRepository.save bis vor den Commit.
        with zyklus.cursor() as cur:
            assert lebenden_bereich_sperren(cur, a_tenant)
            cur.execute(
                "INSERT INTO forecast (time, tenant_id, site_id, kind, model, "
                "value_kw, run_at, horizon_min, method) "
                "VALUES (%s, %s, %s, 'load', 'load-persistence', 1, %s, 15, 'p')",
                (T0 + timedelta(minutes=15), a_tenant, a_site, T0),
            )

        loeschzug = psycopg.connect(dsn)
        pid = loeschzug.info.backend_pid
        fehler: list[BaseException] = []

        def loeschen() -> None:
            # Das Muster des Löschzugs: erste Sperre, dann je Tabelle ein DELETE
            # nach tenant_id (katalogRestLoeschen), dann die Mandantenzeile.
            try:
                loeschzug.execute(
                    "SELECT id FROM tenant WHERE id = %s FOR UPDATE", (a_tenant,)
                )
                for t in TABELLEN:
                    loeschzug.execute(f"DELETE FROM {t} WHERE tenant_id = %s", (a_tenant,))
                loeschzug.execute("DELETE FROM tenant WHERE id = %s", (a_tenant,))
                loeschzug.commit()
            except BaseException as exc:  # pragma: no cover - reported below
                fehler.append(exc)

        faden = threading.Thread(target=loeschen)
        faden.start()
        with psycopg.connect(dsn) as aufsicht:
            frist = time.monotonic() + 10
            while True:
                warte = aufsicht.execute(
                    "SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s",
                    (pid,),
                ).fetchone()
                aufsicht.commit()
                if warte and warte[0] == "Lock":
                    break
                assert time.monotonic() < frist, "Löschzug wartete nicht auf den Zyklus"
                time.sleep(0.05)
        zyklus.commit()
        faden.join(timeout=10)
        loeschzug.close()
        assert not fehler, fehler
    finally:
        zyklus.close()

    assert _zeilen(dsn, a_tenant)["forecast"] == 0
    with psycopg.connect(dsn) as conn:
        assert conn.execute(
            "SELECT count(*) FROM tenant WHERE id = %s", (a_tenant,)
        ).fetchone()[0] == 0
    assert _zeilen(dsn, b_tenant) == GESCHRIEBEN


def test_vor_der_api_migration_gilt_kein_bereich_als_beendet(dsn):
    """Ohne ``tenant.beendet_am`` (Dienst startet vor der api-Migration)
    laufen Liste und Sperre wie vorher, statt den Zyklus zu brechen."""
    a_tenant, a_site = _bereich(dsn, "A vor der Migration")
    _sql(dsn, "ALTER TABLE tenant DROP COLUMN beendet_am")
    try:
        assert a_site in _site_ids(dsn)["collector"]
        with psycopg.connect(dsn) as conn:
            _schreibe_alles(conn, a_tenant, a_site)
        assert _zeilen(dsn, a_tenant) == GESCHRIEBEN
    finally:
        _sql(dsn, "ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ")
