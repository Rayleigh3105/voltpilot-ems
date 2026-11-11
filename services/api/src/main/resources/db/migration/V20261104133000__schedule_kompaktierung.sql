-- =============================================================================
-- V20261104133000 - Fahrplan-Kompaktierung: überholte Läufe älterer Slots löschen
-- -----------------------------------------------------------------------------
-- Der Optimierer schreibt alle 15 Minuten einen 48-Stunden-Plan (192 Slots),
-- also liegt jede Viertelstunde bis zu 192-mal in `schedule`. Nach vier Monaten
-- sind das für EINE Anlage 2,3 Mio Zeilen / 808 MB, und die Leser des
-- Nutzerwegs (Übersicht, Verlauf, Erlöse, Fahrplan) verlieren bei diesem
-- Volumen den SkipScan: /overview 55 ms -> 300-1.000 ms, Verlauf Jahr
-- 0,3 s -> 3,6-18 s (Bericht vp-anlagen-cockpit-perf vom 04.11.2026, Befund B5,
-- Prototyp P-A: nach der Verdichtung 2,32 Mio -> 66 k Zeilen, /overview
-- 90-97 ms, Verlauf Jahr 0,7 s).
--
-- WAS JE SLOT (site_id, time) BLEIBT, sobald der Slot älter als N Stunden ist:
--   * der Lauf, der bei SLOTBEGINN galt: der jüngste Lauf mit
--     generated_at <= time, und
--   * jeder Lauf, der NACH Slotbeginn kam und den Slot noch plante
--     (generated_at > time) - in der Regel genau einer, der an der Slotgrenze
--     ausgelöste Lauf (er ist Mikrosekunden nach `time` gestempelt, siehe
--     ScheduleRepository.RUN_STAMP_TOLERANCE); bei einer Neuplanung im Slot zwei.
-- Gelöscht wird also nur, was schon VOR Slotbeginn durch einen neueren Lauf
-- abgelöst war. Aus bis zu 192 Zeilen je Slot werden zwei.
--
-- WARUM NICHT NUR DER JÜNGSTE LAUF (so der Prototyp): die Leser des Nutzerwegs
-- nehmen je Slot den jüngsten Lauf (DISTINCT ON (time) ... generated_at DESC),
-- aber zwei Leser fragen nach dem Lauf, der bei Slotbeginn galt:
--   * die Plan-Bewertung des Forecast-Dienstes (services/forecast,
--     evaluate._planned_costs: generated_at <= time). Sie läuft täglich für
--     GESTERN und VORGESTERN, also bis 48 h plus Sammeltakt zurück;
--   * der Tagesfilm (ScheduleRepository.dayAsPlanned: generated_at <= time + 1 s).
-- Mit nur dem jüngsten Lauf fände die Bewertung für verdichtete Slots KEINE
-- Zeile und schriebe den Tag vorgestern mit weniger Viertelstunden neu. Mit
-- beiden Regeln bleibt jeder bekannte Leser bytegleich
-- (ScheduleKompaktierungLeserGleichheitTest). Die Admin-Optimierer-Diagnose
-- sieht ältere Läufe nur noch mit den Viertelstunden, in denen sie galten
-- (Entscheid des Captains vom 04.11.2026: Diagnosetiefe = N, keine eigene
-- Lauf-Tabelle).
--
-- N: EIN Konfigurationspunkt, der Job-Parameter `keep_all_runs_hours`
-- (Standard 48). Anheben, zum Beispiel auf eine Woche:
--   SELECT alter_job(job_id, config => '{"keep_all_runs_hours": 168}')
--     FROM timescaledb_information.jobs WHERE proc_name = 'schedule_compaction_job';
-- Werte unter 1 lehnt die Prüffunktion schon beim alter_job ab: der laufende
-- und der eben beendete Slot können noch Neuplanungen erhalten.
--
-- AUSFÜHRUNG: TimescaleDB-Hintergrundjob, stündlich, in kleinen Schritten (ein
-- DELETE je Anlage und 7-Tage-Chunk, jeder Schritt eine eigene Transaktion),
-- idempotent (ein zweiter Lauf löscht nichts). Er läuft als Jobeigentümer (die
-- Flyway-Rolle, wie telemetry_rollups_job), also mandantenübergreifend an FORCE
-- ROW LEVEL SECURITY vorbei - die App-Rolle bleibt außen vor (SELECT-only).
-- Die Retention von 180 Tagen (V20260809000000) bleibt unverändert und
-- unabhängig: sie wirft ganze Chunks weg, dieser Job dünnt innerhalb der
-- Chunks aus; beide löschen nur, ein Lauf in denselben Chunk wartet auf die
-- Sperre des anderen und holt den Rest beim nächsten Takt nach.
--
-- Keine Erst-Verdichtung in der Migration: den Altbestand (Millionen Zeilen)
-- räumt der erste Joblauf Schritt für Schritt auf, nicht die Flyway-Transaktion.
-- Idempotent gegen Wiederanwendung (CREATE OR REPLACE, Job-Registrierung
-- geprüft), rein additiv, versioniert über dem höchsten Stand auf main
-- (V20261102200000). Bewiesen durch ScheduleKompaktierungJobTest.
-- =============================================================================

-- ---- 1. Die Verdichtung selbst: ein Schritt je Anlage und Chunk ---------------
-- `cutoff` ist exklusiv: verdichtet werden Slots mit time < cutoff. Die
-- Zeitgrenzen stehen in beiden Hälften des DELETE, damit TimescaleDB jeden
-- Schritt auf seinen einen Chunk eingrenzt.
CREATE OR REPLACE PROCEDURE compact_schedule_runs(cutoff TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
    chunk   RECORD;
    anlage  UUID;
    bis     TIMESTAMPTZ;
    zeilen  BIGINT;
BEGIN
    FOR chunk IN
        SELECT range_start, range_end
        FROM timescaledb_information.chunks
        WHERE hypertable_schema = 'public' AND hypertable_name = 'schedule'
          AND range_start < cutoff
        ORDER BY range_start
    LOOP
        bis := least(chunk.range_end, cutoff);
        FOR anlage IN
            SELECT DISTINCT site_id FROM schedule
            WHERE time >= chunk.range_start AND time < bis
        LOOP
            DELETE FROM schedule s
            USING (
                SELECT time, max(generated_at) AS in_force
                FROM schedule
                WHERE site_id = anlage
                  AND time >= chunk.range_start AND time < bis
                  AND generated_at <= time
                GROUP BY time
            ) k
            WHERE s.site_id = anlage
              AND s.time = k.time
              AND s.time >= chunk.range_start AND s.time < bis
              AND s.generated_at < k.in_force;
            GET DIAGNOSTICS zeilen = ROW_COUNT;
            IF zeilen > 0 THEN
                RAISE LOG 'schedule_compaction: site % chunk [%, %) - % überholte Zeilen gelöscht',
                    anlage, chunk.range_start, bis, zeilen;
            END IF;
            COMMIT;
        END LOOP;
    END LOOP;
END
$$;

-- ---- 2. Der Konfigurationspunkt und seine Prüfung -----------------------------
CREATE OR REPLACE FUNCTION schedule_compaction_keep_hours(config JSONB)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    stunden INTEGER;
BEGIN
    stunden := coalesce((config ->> 'keep_all_runs_hours')::integer, 48);
    IF stunden < 1 THEN
        RAISE EXCEPTION 'schedule_compaction_job: keep_all_runs_hours muss mindestens 1 sein, ist %',
            stunden;
    END IF;
    RETURN stunden;
END
$$;

-- Prüffunktion für add_job/alter_job: ein ungültiger Wert fällt beim Setzen auf,
-- nicht erst eine Stunde später im Joblauf.
CREATE OR REPLACE FUNCTION schedule_compaction_check_config(config JSONB)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM schedule_compaction_keep_hours(config);
END
$$;

-- ---- 3. Der Job-Einstieg (TimescaleDB-Signatur) ------------------------------
CREATE OR REPLACE PROCEDURE schedule_compaction_job(job_id INTEGER, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
    CALL compact_schedule_runs(
        now() - make_interval(hours => schedule_compaction_keep_hours(config)));
END
$$;

-- ---- 4. Registrierung: stündlich, Standard 48 Stunden -------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                   WHERE proc_schema = 'public' AND proc_name = 'schedule_compaction_job') THEN
        PERFORM add_job('schedule_compaction_job', INTERVAL '1 hour',
                        config => '{"keep_all_runs_hours": 48}'::jsonb,
                        check_config => 'schedule_compaction_check_config'::regproc);
    END IF;
END
$$;
