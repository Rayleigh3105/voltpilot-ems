-- =============================================================================
-- V20260859000000 - optimizer_cycle_stat: die Dauer des letzten Optimierer-
-- Zyklus, damit das Kippen des 15-min-Takts SICHTBAR wird (Monitoring-Luecken,
-- Scout vp-scale-readiness-p4 §5.4 + §6.3). ADDITIV.
-- -----------------------------------------------------------------------------
-- WOFUER es da ist: der Optimierer plant SEQUENZIELL ueber alle Anlagen
-- (engine.run_cycle). Bei 100 Anlagen ist ein Zyklus in ~40-60 s durch, bei
-- 1.000 in ~5-8 min - noch im 15-min-Takt, aber ohne Reserve. Es gibt bis heute
-- KEINE Metrik dafuer; man saehe das Kippen erst am Plan-ALTER, also erst wenn
-- die Plaene bereits veralten. Diese Tabelle traegt genau die eine Zahl, an der
-- man es VORHER sieht: die Dauer des zuletzt abgeschlossenen Zyklus.
--
-- DER WEG (bewusst, entlang der bestehenden Architektur): der Optimierer misst
-- die Dauer ohnehin schon (cli.py serve-Schleife, time.monotonic um _run_one)
-- und PERSISTIERT sie hier; der api-Metrik-Sammler LIEST die eine Zeile und
-- exponiert sie auf /metrics als voltpilot_optimizer_cycle_seconds. Kein zweiter
-- /metrics-Endpunkt im Python-Dienst, keine neue Abhaengigkeit - „ueber den
-- vorhandenen Metrik-Sammler exponieren" (§6.3). Der Optimierer schreibt hier
-- wie in `schedule` als vertrauenswuerdige Backend-Rolle (POSTGRES_USER), die
-- diese Tabelle ohnehin besitzt.
--
-- EINE ZEILE, kein Verlauf: die Frage ist „wie lange dauerte der LETZTE Zyklus",
-- nicht „wie war er ueber die Zeit". Ein Verlauf gehoerte in eine Zeitreihe und
-- wuerde wachsen; das SCRAPE-Ziel ist eine Momentaufnahme. Deshalb ein
-- Ein-Zeilen-Upsert auf dem festen Schluessel id=1 (das CHECK erzwingt es).
--
-- finished_at traegt der Sammler nicht als Wert aus, sondern rechnet daraus beim
-- Scrape das ALTER (voltpilot_optimizer_cycle_age_seconds) - dieselbe
-- Ehrlichkeitsregel wie beim Flotten-Sammler: ein toter Optimierer friert die
-- Dauer auf einem gesunden Wert ein, das mitwachsende Alter dagegen macht ihn
-- sichtbar (die sichere Richtung).
--
-- GLOBALE Betriebsdaten wie edge_release: kein tenant_id, keine RLS. Die
-- App-Rolle hat hier nichts zu suchen (gelesen wird ueber die BYPASSRLS-Rolle
-- voltpilot_admin im /metrics-Sammler); der Optimierer schreibt als Eigentuemer.
--
-- Datums-Version ueber dem hoechsten ausgelieferten Stand (AGENTS.md-Koordination).
-- =============================================================================

CREATE TABLE IF NOT EXISTS optimizer_cycle_stat (
    -- Fester Ein-Zeilen-Schluessel: es gibt genau EINEN "letzten Zyklus".
    id               smallint         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- Ende des zuletzt abgeschlossenen Zyklus - Anker fuer das Alter beim Scrape.
    finished_at      timestamptz      NOT NULL,
    -- Wanduhr-Dauer des ganzen Zyklus in Sekunden (die "kippen"-Kurve).
    duration_seconds double precision  NOT NULL CHECK (duration_seconds >= 0),
    -- Kontext, damit die Dauer interpretierbar ist: 5 vs. 500 Anlagen erklaeren
    -- ganz verschiedene Dauern.
    sites_planned    integer          NOT NULL DEFAULT 0 CHECK (sites_planned >= 0),
    sites_skipped    integer          NOT NULL DEFAULT 0 CHECK (sites_skipped >= 0),
    -- Der angefragte Horizont dieses Zyklus (Diagnose; NULL vor dem ersten Lauf
    -- eines aelteren Optimierer-Stands).
    horizon_slots    integer
);

-- Nur der /metrics-Sammler liest, ausschliesslich ueber die Admin-Rolle. Die
-- App-Rolle bekommt nichts (die V2-Default-Privilegien wuerden ihr sonst Rechte
-- auf eine globale Betriebstabelle geben - dieselbe Disziplin wie edge_release).
REVOKE ALL ON optimizer_cycle_stat FROM ${appDbUser};
GRANT SELECT ON optimizer_cycle_stat TO ${adminDbUser};
