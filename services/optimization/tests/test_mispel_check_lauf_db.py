"""MiSpeL MP-13b gegen eine ECHTE Datenbank: der Lauf füllt ``site_mispel_check``
für eine Simulator-Anlage mit Z1/Z2 (Verlauf gemessen) und eine Bestandsanlage ohne
Messreihe (angenommen); die Beträge sind die der MP-13-Kommandozeile für dieselbe
Eingabe (``mispel-check --eingang`` → ``--anlage``); der Simulations-JobStore nimmt
währenddessen Aufträge an und rechnet sie; ein zweiter Lauf rechnet nichts, eine
geänderte Datenbasis rechnet genau diese Anlage neu; der Advisory-Lock lässt nie zwei
Läufe zugleich rechnen.

Wegwerf-``timescale/timescaledb`` wie ``test_kundenbereich_db.py`` (Dev-DDL aus
``infra/local/timescale``, dazu die api-Spalten); ``site_foerderweg`` und
``site_mispel_check`` sind die ECHTEN Migrationen der api - der Lauf muss ihre CHECKs
bestehen. Das Fenster ist auf drei Tage geschrumpft (echte HiGHS-Lösungen); der
Ganzjahreslauf ist der Prüfnachweis des PRs.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import time
import uuid
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")

from voltpilot_optimization.simulation import mispel_check as mc  # noqa: E402
from voltpilot_optimization.simulation import mispel_check_lauf as lauf  # noqa: E402
from voltpilot_optimization.simulation.data import BERLIN, price_rows_from_json  # noqa: E402
from voltpilot_optimization.simulation.jobs import STATUS_DONE, JobStore  # noqa: E402

IMAGE = "timescale/timescaledb:2.17.2-pg16"
REPO = Path(__file__).resolve().parents[3]
DDL = REPO / "infra" / "local" / "timescale"
MIGRATION = REPO / "services" / "api" / "src" / "main" / "resources" / "db" / "migration"
PREISE = Path(__file__).parent / "fixtures" / "day-ahead-de-lu-2025-10-bis-2026-09.json"
BEISPIEL = REPO / "docs" / "contracts" / "v2" / "mispel-check-beispiel.json"

START = datetime(2026, 5, 30, tzinfo=BERLIN).astimezone(timezone.utc)
SLOTS = [START + timedelta(minutes=15 * i) for i in range(3 * 96)]
FENSTER = lauf.Fenster((2026, 5), 1, date(2026, 5, 30), date(2026, 6, 1))
JETZT = datetime(2026, 6, 2, 3, 0, tzinfo=timezone.utc)

solver = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="HiGHS wheel unavailable on this platform",
)

_API_ZUSATZ = """
DO $$ BEGIN CREATE ROLE voltpilot_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE voltpilot_admin; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ;
ALTER TABLE site ADD CONSTRAINT site_id_tenant_uq UNIQUE (id, tenant_id);
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
-- Die Spalten, die der Lauf liest (V20261002121500, AP-04 Stellung, V20260701030000).
CREATE TABLE messstelle_stellung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), messstelle_id UUID NOT NULL, site_id UUID NOT NULL,
    gueltig_ab DATE NOT NULL, gueltig_bis DATE, aufgehoben_am TIMESTAMPTZ);
CREATE TABLE messstelle_zaehlerrolle (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), messstelle_id UUID NOT NULL, rolle TEXT,
    gueltig_ab DATE NOT NULL, aufgehoben_am TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE telemetry_rollup_1d (
    bucket TIMESTAMPTZ NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    pv_kwh NUMERIC(14, 6), load_kwh NUMERIC(14, 6), n_samples BIGINT NOT NULL,
    PRIMARY KEY (site_id, bucket));
"""


def _docker_bereit() -> bool:
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


def _migration(prefix: str) -> str:
    datei = next(MIGRATION.glob(f"{prefix}__*.sql"))
    return (datei.read_text()
            .replace("${appDbUser}", "voltpilot_app").replace("${adminDbUser}", "voltpilot_admin"))


@pytest.fixture(scope="module")
def dsn():
    if not _docker_bereit():
        pytest.skip("Docker fehlt: kein Wegwerf-Postgres")
    name = f"vp-mispel-check-lauf-{uuid.uuid4().hex[:8]}"
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
            for datei in ("01-init.sql", "02-day-ahead-prices.sql", "04-schedule.sql", "05-market-value.sql",
                          "07-mispel-marktdaten.sql"):
                conn.execute((DDL / datei).read_text())
            conn.execute(_API_ZUSATZ)
            conn.execute(_migration("V20261002141500"))
            conn.execute(_migration("V20261002234100"))
            rows = [r for r in price_rows_from_json(json.loads(PREISE.read_text()))
                    if START - timedelta(hours=2) <= r[0] <= SLOTS[-1] + timedelta(hours=2)]
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh) "
                    "VALUES (%s, 'DE-LU', %s, %s)", rows)
        yield url
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _wetter_body() -> str:
    """Open-Meteo-Archivantwort: sonnig 8-17 Uhr Berliner Zeit."""
    zeiten, ghi = [], []
    t = START - timedelta(hours=1)
    while t <= SLOTS[-1] + timedelta(hours=1):
        zeiten.append(t.strftime("%Y-%m-%dT%H:%M"))
        ghi.append(700.0 if 8 <= t.astimezone(BERLIN).hour < 17 else 0.0)
        t += timedelta(hours=1)
    return json.dumps({"hourly": {"time": zeiten, "shortwave_radiation": ghi,
                                  "direct_radiation": [g * 0.7 for g in ghi],
                                  "diffuse_radiation": [g * 0.3 for g in ghi]}})


def _anlagen(dsn: str) -> dict[str, uuid.UUID]:
    """Simulator-Anlage (Z1/Z2, Verlauf im Fenster) und Bestandsanlage (nichts gemessen)."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute("INSERT INTO tenant (name) VALUES ('MiSpeL-Lauf') RETURNING id").fetchone()[0]
        ids = {}
        for name, kwh, kw, kwp, aw, lat in (("simulator", 65, 30, 100, 6.9, 48.62),
                                             ("bestand", 10, 5, 9.9, 8.2, None)):
            site = conn.execute(
                "INSERT INTO site (tenant_id, name, plant_kind, anzulegender_wert_ct_kwh, latitude, longitude) "
                "VALUES (%s, %s, 'direktvermarktung', %s, %s, %s) RETURNING id",
                (tenant, name, aw, lat, 12.55 if lat else None)).fetchone()[0]
            conn.execute("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                         "max_discharge_kw) VALUES (%s, %s, 'battery', %s, %s, %s)", (tenant, site, kwh, kw, kw))
            conn.execute("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (%s, %s, 'pv', %s)",
                         (tenant, site, kwp))
            ids[name] = site
        sim = ids["simulator"]
        for rolle in ("Z1", "Z2"):
            mst = uuid.uuid4()
            conn.execute("INSERT INTO messstelle_stellung (messstelle_id, site_id, gueltig_ab) "
                         "VALUES (%s, %s, '2026-01-01')", (mst, sim))
            conn.execute("INSERT INTO messstelle_zaehlerrolle (messstelle_id, rolle, gueltig_ab) "
                         "VALUES (%s, %s, '2026-01-01')", (mst, rolle))
        # Nur diese beiden: die Dev-Seeds der DDL bringen eigene Speicher-Anlagen mit.
        conn.execute("DELETE FROM asset WHERE type = 'battery' AND site_id <> ALL(%s)", (list(ids.values()),))
        for tag in range(3):
            bucket = datetime(2026, 5, 30, tzinfo=BERLIN) + timedelta(days=tag)
            conn.execute("INSERT INTO telemetry_rollup_1d (bucket, tenant_id, site_id, pv_kwh, load_kwh, n_samples) "
                         "VALUES (%s, %s, %s, 420, 160, 96)", (bucket, tenant, sim))
    return ids


def _zeilen(dsn: str) -> dict:
    with psycopg.connect(dsn) as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute("SELECT * FROM site_mispel_check")
        return {r["site_id"]: r for r in cur.fetchall()}


@solver
@pytest.mark.timeout(900)
def test_der_lauf_fuellt_die_tabelle_wie_die_kommandozeile(dsn, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(mc, "window_slot_starts", lambda year, month, months: SLOTS)
    monkeypatch.setattr(lauf, "fenster", lambda heute, monate=12: FENSTER)
    ids = _anlagen(dsn)
    wetter = tmp_path / "wetter.json"
    wetter.write_text(_wetter_body())
    assert lauf.check_deps(dsn, 5).max_workers == lauf.MAX_WORKERS  # nie mehr als zwei Solver-Prozesse
    # Gleichheit ohne Krücke (MP-33c): der Check endet an der Knotengrenze, nicht an der
    # Wanduhr - dieselbe Eingabe, dieselben Beträge, auch unter Last.
    deps = lauf.check_deps(dsn, 1)
    deps.weather = mc.ArchivDateiWetter([wetter.read_text()])

    # Der Simulations-JobStore rechnet, während der Lauf eine Anlage in „wird_gerechnet“ hat.
    store = JobStore(lambda request, publish: {"ok": True})
    waehrenddessen = []
    gerechnet = {}

    def rechne(anlage, d, beginn, monate):
        zeilen = _zeilen(dsn)
        stand = {k: z["stand"] for k, z in zeilen.items()}
        job = store.submit(object.__new__(_Anfrage))
        frist = time.monotonic() + 5
        while store.get(job)["status"] != STATUS_DONE and time.monotonic() < frist:
            time.sleep(0.01)
        waehrenddessen.append((stand, store.get(job)["status"]))
        result = mc.mispel_check(anlage, d, beginn, monate)
        gerechnet[json.dumps(asdict(anlage), sort_keys=True)] = result
        return result

    berichte = lauf.lauf(dsn, deps, jetzt=JETZT, rechne=rechne)
    with capsys.disabled():
        for b in berichte:
            print(f"\nMP-13b Laufzeit {b.site_id}: {b.sekunden:.1f} s, Spanne {b.spanne}")
    assert sorted(b.stand for b in berichte) == ["fertig", "fertig"]
    assert all(s == STATUS_DONE for _, s in waehrenddessen)
    assert "wird_gerechnet" in waehrenddessen[0][0].values()

    zeilen = _zeilen(dsn)
    for name, site in ids.items():
        z = zeilen[site]
        bericht = next(b for b in berichte if b.site_id == site)
        assert z["stand"] == "fertig" and z["formelsatz"] == "A1" and z["hinweis"] is None
        assert (z["fenster_von"], z["fenster_bis"]) == (date(2026, 5, 30), date(2026, 6, 1))
        # Abgelegt = gerechnet; für die Bestandsanlage zusätzlich = MP-13-Kommandozeile mit
        # derselben Eingabe (die Simulator-Anlage rechnet ohne Zeitgrenze ~3 min - einmal genügt).
        spanne = gerechnet[json.dumps(bericht.eingang, sort_keys=True)]["spanne"]
        if name == "bestand":
            anlage = tmp_path / f"{name}.json"
            anlage.write_text(json.dumps(bericht.eingang))
            assert mc.main(["--anlage", str(anlage), "--preise", str(PREISE), "--wetter", str(wetter),
                            "--beginn", "2026-05", "--monate", "1", "--workers", "1"]) == 0
            spanne = json.loads(capsys.readouterr().out)["spanne"]
        for fall in mc.FAELLE:
            assert float(z[f"differenz_{fall}_eur"]) == pytest.approx(spanne[fall], abs=0.005)
        assert {p["art"] for p in z["posten"]} == {"handel_saldierung", "jahresmarktwert", "zaehler_z2", "bilanzkreis"}
        mittel = sum(p["mittel_eur"] for p in z["posten"])
        assert mittel == pytest.approx(float(z["differenz_mittel_eur"]), abs=0.05)

    sim = {a["angabe"]: a for a in zeilen[ids["simulator"]]["datenbasis"]}
    assert sim["Jahresverbrauch"]["herkunft"] == "gemessen" and sim["Jahresverbrauch"]["wert"] == 160 * 3 * 12
    assert sim["Erzeugung im Jahr"]["herkunft"] == "gemessen"
    assert sim["Formelsatz"]["quelle"].startswith("Zähler Z1 und Z2")
    bestand = {a["angabe"]: a for a in zeilen[ids["bestand"]]["datenbasis"]}
    assert bestand["Jahresverbrauch"]["herkunft"] == "angenommen" and bestand["Jahresverbrauch"]["wert"] == 60_000
    assert bestand["Erzeugung im Jahr"]["herkunft"] == "angenommen"
    assert bestand["Formelsatz"]["herkunft"] == "angenommen"

    # Die Form der Zeilen ist die des Vertragsbeispiels, das MispelCheckApiTest liest.
    beispiel = json.loads(BEISPIEL.read_text())
    for z in zeilen.values():
        for p in z["posten"]:
            assert set(p) == set(beispiel["zeilen"][0]["posten"][0])
        for a in z["datenbasis"]:
            assert set(a) == set(beispiel["zeilen"][0]["datenbasis"][0])

    # Ein zweiter Lauf rechnet nichts; ein laufender Lauf sperrt den nächsten.
    assert lauf.lauf(dsn, deps, jetzt=JETZT) == []
    with psycopg.connect(dsn, autocommit=True) as halter:
        halter.execute("SELECT pg_advisory_lock(%s)", (lauf.LOCK_SCHLUESSEL,))
        assert lauf.lauf(dsn, deps, jetzt=JETZT) is None
        halter.execute("SELECT pg_advisory_unlock(%s)", (lauf.LOCK_SCHLUESSEL,))

    # Eine geänderte Datenbasis (Z3 dazu → A4) rechnet genau diese Anlage neu - ohne Betrag.
    with psycopg.connect(dsn, autocommit=True) as conn:
        mst = uuid.uuid4()
        conn.execute("INSERT INTO messstelle_stellung (messstelle_id, site_id, gueltig_ab) "
                     "VALUES (%s, %s, '2026-01-01')", (mst, ids["simulator"]))
        conn.execute("INSERT INTO messstelle_zaehlerrolle (messstelle_id, rolle, gueltig_ab) "
                     "VALUES (%s, 'Z3', '2026-01-01')", (mst,))
    berichte = lauf.lauf(dsn, deps, jetzt=JETZT)
    assert [(b.site_id, b.grund, b.stand) for b in berichte] == [
        (ids["simulator"], "Datenbasis geändert", "nicht_unterstuetzt")]
    z = _zeilen(dsn)[ids["simulator"]]
    assert (z["formelsatz"], z["differenz_mittel_eur"], z["posten"]) == ("A4", None, [])
    assert mc.NICHT_UNTERSTUETZT in z["hinweis"]


class _Anfrage:
    """Ein Simulationsauftrag ohne Inhalt - der JobStore-Läufer ist ein Stub."""

    def cache_key(self) -> str:
        return uuid.uuid4().hex


def test_ein_fehlschlag_legt_einen_satz_ab_und_die_naechste_anlage_rechnet_weiter(dsn, monkeypatch):
    monkeypatch.setattr(lauf, "fenster", lambda heute, monate=12: FENSTER)
    with psycopg.connect(dsn, autocommit=True) as conn:
        tenant = conn.execute("INSERT INTO tenant (name) VALUES ('MiSpeL-Fehlschlag') RETURNING id").fetchone()[0]
        site = conn.execute("INSERT INTO site (tenant_id, name) VALUES (%s, 'netz') RETURNING id",
                            (tenant,)).fetchone()[0]
        conn.execute("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) "
                     "VALUES (%s, %s, 'battery', 100, 50, 50)", (tenant, site))

    def kaputt(*_):
        raise RuntimeError("keine Preise im Fenster")

    berichte = lauf.lauf(dsn, mc.CheckDeps(load_prices=kaputt), jetzt=JETZT, site_id=site, rechne=kaputt)
    assert [(b.stand, b.grund) for b in berichte] == [("fehlgeschlagen", "noch nie gerechnet")]
    z = _zeilen(dsn)[site]
    assert z["stand"] == "fehlgeschlagen" and z["formelsatz"] == "A11" and z["differenz_mittel_eur"] is None
    assert z["hinweis"] == "Der Check konnte für diese Anlage nicht gerechnet werden: keine Preise im Fenster"
    # Vor Ablauf der Wartezeit kein neuer Versuch.
    assert lauf.lauf(dsn, mc.CheckDeps(load_prices=kaputt), jetzt=JETZT, site_id=site, rechne=kaputt) == []
