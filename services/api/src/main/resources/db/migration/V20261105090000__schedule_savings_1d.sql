-- =============================================================================
-- V20261105090000 - Ersparnis je Anlage und Kalendertag aus dem Fahrplan, vorberechnet
-- -----------------------------------------------------------------------------
-- Die 14-Tage-Sparzeile der Übersicht (`OverviewRepository.dailySavings`, "Meine
-- Anlagen" und Cockpit-Erstbild) summiert je Viertelstunde den JÜNGSTEN Lauf des
-- Fahrplans (DISTINCT ON (time) ... generated_at DESC). Vergangene Tage ändern sich
-- nie mehr, wurden aber bei JEDEM Aufruf (und im Cockpit alle 10 s) neu aus `schedule`
-- gelesen: nach vier Monaten Datenbestand 259.046 Buffer / 180-420 ms je Aufruf, der
-- teuerste Posten von /overview (Bericht vp-anlagen-cockpit-perf, Befund B1, Rang 4b).
-- Die Verdichtung (V20261104133000) hat den Bestand der Tage vor den letzten 48 h
-- verkleinert, die letzten zwei Tage tragen aber weiter jede Version - und das
-- Fenster bleibt 14 Tage breit.
--
-- WAS HIER STEHT: eine Zeile je (Anlage, Berliner Kalendertag) mit der Summe
-- sum(baseline_cost_eur - cost_eur) über die Viertelstunden dieses Tages, genau wie der
-- Leser sie bildet (jüngster Lauf je Slot, dann Slots mit beiden Kosten; NULL =
-- berechnet, aber kein bepreister Slot - der Leser lässt solche Tage aus, nie eine
-- falsche Null). NUMERIC ohne Skala: die Summe behält die Skala der Quellspalten, die
-- Summe über Anlagen ist damit zeichengleich zur Summe über alle Slots.
--
-- WANN EIN TAG FERTIG IST: sobald sein Ende `settle_hours` zurückliegt (Standard 1).
-- Ein Lauf wird Mikrosekunden NACH seiner Slotgrenze gestempelt und plant den Slot
-- noch (ScheduleRepository.RUN_STAMP_TOLERANCE, eine Sekunde); danach plant kein Lauf
-- mehr einen Slot dieses Tages. Der heutige Tag - und ein eben erst beendeter - bleibt
-- live (der Leser rechnet ihn weiter aus `schedule`).
--
-- WIE DER LESER WEISS, WAS FERTIG IST: `schedule_savings_1d_state` hält EINE Zeile
-- (von, bis): für alle Anlagen sind die Tage von..bis berechnet. Der Job schreibt
-- sie Tag für Tag (jeder Tag eine eigene Transaktion, Zeilen UND Stand gemeinsam), der
-- Leser nimmt aus der Tabelle nur Tage innerhalb von..bis und rechnet den Rest live.
-- Fehlt die Stand-Zeile (frische DB, Job noch nicht gelaufen) oder deckt sie das Fenster
-- nicht, antwortet der Leser wie bisher aus `schedule` - nie eine Lücke.
--
-- Fenster: `window_days` (Standard 35, mindestens 14 für die Sparzeile). Ältere Zeilen
-- räumt der Job weg; die Retention von `schedule` (180 Tage) bleibt unabhängig.
-- Der Job (stündlich) läuft als Jobeigentümer (Flyway-Rolle), also mandantenübergreifend
-- an FORCE ROW LEVEL SECURITY vorbei, wie telemetry_rollups_job und
-- schedule_compaction_job; die App-Rolle liest nur (SELECT, RLS je Mandant).
--
-- Nachrechnen ab einem Tag (zum Beispiel nach einer nachträglichen Fahrplan-Korrektur,
-- die vergangene Slots berührt - der Optimierer tut das nicht):
--   UPDATE schedule_savings_1d_state SET bis = <tag> - 1;
--   DELETE FROM schedule_savings_1d WHERE day >= <tag>;
-- Der nächste Joblauf rechnet die Tage ab <tag> neu; bis dahin liest der Leser sie live.
--
-- Rein additiv, idempotent gegen Wiederanwendung, versioniert über dem höchsten Stand
-- auf main (V20261104190000). Bewiesen durch ScheduleSavings1dTest.
-- =============================================================================

-- ---- 1. Die Tabellen -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS schedule_savings_1d (
    site_id     UUID        NOT NULL REFERENCES site (id) ON DELETE CASCADE,
    day         DATE        NOT NULL,           -- Europe/Berlin-Kalendertag
    tenant_id   UUID        NOT NULL,           -- für RLS, wie `schedule`
    savings_eur NUMERIC,                        -- NULL = berechnet, aber kein bepreister Slot
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, day)
);
CREATE INDEX IF NOT EXISTS idx_schedule_savings_1d_tenant_day
    ON schedule_savings_1d (tenant_id, day);

-- Eine Zeile, kein Mandant: sie sagt nur, bis wohin die Tabelle für ALLE Anlagen reicht.
CREATE TABLE IF NOT EXISTS schedule_savings_1d_state (
    id  BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    von DATE NOT NULL,
    bis DATE NOT NULL
);

-- Rechte: V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen ALLES auf jede neue Tabelle - erst zurücknehmen,
-- dann eng erteilen. Geschrieben wird nur vom Job (Jobeigentümer), gelesen von der App-Rolle (RLS je Mandant) und,
-- für Diagnose, von der Verwaltungsrolle. Das Abräumen mit der Anlage (Löschweg, Offboarding) besorgt die Kaskade
-- des Fremdschlüssels, sie braucht kein DELETE-Recht einer der beiden Rollen.
REVOKE ALL ON schedule_savings_1d, schedule_savings_1d_state FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON schedule_savings_1d, schedule_savings_1d_state TO ${appDbUser};
GRANT SELECT ON schedule_savings_1d, schedule_savings_1d_state TO ${adminDbUser};

ALTER TABLE schedule_savings_1d ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_savings_1d FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schedule_savings_1d_isolation ON schedule_savings_1d;
CREATE POLICY schedule_savings_1d_isolation ON schedule_savings_1d
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---- 2. Die Berechnung: ein Tag je Transaktion -----------------------------------
-- `jetzt` ist ein Parameter, damit der Test jede Uhrzeit nachstellen kann; der Job
-- reicht now() durch.
CREATE OR REPLACE PROCEDURE refresh_schedule_savings_1d(
    jetzt TIMESTAMPTZ, fenster_tage INTEGER, abschluss_stunden INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
    heute        DATE        := (jetzt AT TIME ZONE 'Europe/Berlin')::date;
    heute_beginn TIMESTAMPTZ := (((jetzt AT TIME ZONE 'Europe/Berlin')::date)::timestamp AT TIME ZONE 'Europe/Berlin');
    letzter      DATE;
    erster       DATE;
    stand_von    DATE;
    stand_bis    DATE;
    tag          DATE;
    tag_beginn   TIMESTAMPTZ;
    tag_ende     TIMESTAMPTZ;
BEGIN
    -- Jüngster abgeschlossener Tag: sein Ende liegt `abschluss_stunden` zurück.
    IF jetzt >= heute_beginn + make_interval(hours => abschluss_stunden) THEN
        letzter := heute - 1;
    ELSE
        letzter := heute - 2;
    END IF;
    erster := letzter - (fenster_tage - 1);

    SELECT von, bis INTO stand_von, stand_bis FROM schedule_savings_1d_state WHERE id;
    IF NOT FOUND OR stand_bis < erster - 1 THEN
        -- Kein anschließender Bestand (frisch oder lange stehen geblieben): neu aufsetzen. Die Stand-Zeile sagt
        -- dabei "leer" (bis < von), der Leser rechnet bis zum ersten Tag live.
        DELETE FROM schedule_savings_1d;
        stand_von := erster;
        stand_bis := erster - 1;
        INSERT INTO schedule_savings_1d_state (id, von, bis) VALUES (true, stand_von, stand_bis)
            ON CONFLICT (id) DO UPDATE SET von = EXCLUDED.von, bis = EXCLUDED.bis;
        COMMIT;
    END IF;

    FOR i IN 0 .. (letzter - (stand_bis + 1)) LOOP
        tag := stand_bis + 1 + i;
        tag_beginn := tag::timestamp AT TIME ZONE 'Europe/Berlin';
        tag_ende := (tag + 1)::timestamp AT TIME ZONE 'Europe/Berlin';
        -- Wörtlich die Form des Lesers (OverviewRepository.dailySavings): je Anlage der jüngste Lauf je Slot, DANN
        -- der Filter auf beide Kosten. Je Anlage ein LATERAL mit Gleichheit auf site_id, damit der SkipScan greift.
        INSERT INTO schedule_savings_1d (site_id, day, tenant_id, savings_eur)
        SELECT s.id, tag, s.tenant_id, x.savings
        FROM site s
        CROSS JOIN LATERAL (
            SELECT sum(y.baseline_cost_eur - y.cost_eur) AS savings
            FROM (SELECT DISTINCT ON (time) baseline_cost_eur, cost_eur
                  FROM schedule
                  WHERE site_id = s.id AND time >= tag_beginn AND time < tag_ende
                  ORDER BY time, generated_at DESC) y
            WHERE y.baseline_cost_eur IS NOT NULL AND y.cost_eur IS NOT NULL
        ) x
        ON CONFLICT (site_id, day) DO NOTHING;
        UPDATE schedule_savings_1d_state SET bis = tag WHERE id;
        COMMIT;
    END LOOP;

    -- Das Fenster nachziehen: erst die Stand-Zeile (der Leser nimmt die alten Tage nicht mehr), dann die Zeilen.
    IF stand_von < erster THEN
        UPDATE schedule_savings_1d_state SET von = erster WHERE id AND von < erster;
        DELETE FROM schedule_savings_1d WHERE day < erster;
        COMMIT;
    END IF;
END
$$;

-- ---- 3. Der Konfigurationspunkt und seine Prüfung ---------------------------------
CREATE OR REPLACE FUNCTION schedule_savings_1d_config(config JSONB)
RETURNS TABLE (fenster_tage INTEGER, abschluss_stunden INTEGER)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    tage    INTEGER := coalesce((config ->> 'window_days')::integer, 35);
    stunden INTEGER := coalesce((config ->> 'settle_hours')::integer, 1);
BEGIN
    IF tage < 14 THEN
        RAISE EXCEPTION 'schedule_savings_1d_job: window_days muss mindestens 14 sein (Sparzeile), ist %', tage;
    END IF;
    IF stunden < 1 OR stunden > 24 THEN
        RAISE EXCEPTION 'schedule_savings_1d_job: settle_hours muss zwischen 1 und 24 liegen, ist %', stunden;
    END IF;
    RETURN QUERY SELECT tage, stunden;
END
$$;

CREATE OR REPLACE FUNCTION schedule_savings_1d_check_config(config JSONB)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM * FROM schedule_savings_1d_config(config);
END
$$;

-- ---- 4. Der Job-Einstieg (TimescaleDB-Signatur) und die Registrierung ---------------
CREATE OR REPLACE PROCEDURE schedule_savings_1d_job(job_id INTEGER, config JSONB)
LANGUAGE plpgsql AS $$
DECLARE
    tage    INTEGER;
    stunden INTEGER;
BEGIN
    SELECT c.fenster_tage, c.abschluss_stunden INTO tage, stunden FROM schedule_savings_1d_config(config) c;
    CALL refresh_schedule_savings_1d(now(), tage, stunden);
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_schema = 'public' AND proc_name = 'schedule_savings_1d_job') THEN
        PERFORM add_job('schedule_savings_1d_job', INTERVAL '1 hour',
                        config => '{"window_days": 35, "settle_hours": 1}'::jsonb,
                        check_config => 'schedule_savings_1d_check_config'::regproc);
    END IF;
END
$$;
