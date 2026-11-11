-- =============================================================================
-- V20261111170000 - S3 ("Rückblick", Konzept vp-prognosen-konzept): je Anlage,
-- Tag, Art und Modell "am Vortag erwartet" gegen "gemessen".
-- -----------------------------------------------------------------------------
-- Dieselbe Bauart wie forecast_accuracy/plan_accuracy (V20260701040000): RLS-
-- gebunden wie telemetry/weather, der Rückblick-Lauf (services/forecast
-- voltpilot_forecast.rueckblick) schreibt als vertraute Backend-Rolle (umgeht
-- RLS, trägt tenant_id selbst ein - das Wetter-Collector-Muster), das Portal
-- liest über die RLS-gebundene App-Rolle.
--
-- ANDERS als forecast_accuracy (das die Prognose vom LETZTEN Lauf bewertet,
-- Nebenbefund N3) ist der Bezugspunkt hier der ABEND-LAUF von 17:45 ± 15 min
-- des VORTAGS - "was eine Untergrenze am Vorabend über den nächsten Morgen
-- WUSSTE" (dieselbe Regel wie storage_release.evening_runs/night_reserve).
--
-- Die Tabelle trägt JEDES Modell einer Anlage, nicht nur das aktive, aus zwei
-- Gründen zugleich: das Blatt "Rückblick" (E5 = A) zeigt den Rückblick des
-- AKTIVEN Modells, und die Automatik (S5) vergleicht Kandidaten gegen das
-- Basismodell über genau diese Zeilen - eine zweite Tabelle wäre eine zweite
-- Wahrheit über dasselbe Ereignis gewesen.
--
-- `lead_days` ("Vorlauf") ist für eine künftige Erweiterung angelegt (S4 misst
-- den Wochen-Ausblick ohnehin stündlich je Tag voraus) - diese Migration füllt
-- bewusst nur `lead_days = 1` (der Vortagsvergleich, Bericht R.4 Punkt 1); die
-- Spalte existiert, damit eine spätere Scheibe den Wochen-Ausblick (Vorlauf
-- 2-6) ergänzen kann, ohne die Tabelle noch einmal zu migrieren.
--
-- `mae_kw` ist dieselbe Größe wie forecast_accuracy.mae_kw (mittlerer Betrag
-- der Abweichung je Viertelstunde), hier aber gegen den ABEND-LAUF statt den
-- letzten Lauf gerechnet - die Vergleichsgröße, die S5s Automatik nach
-- Bericht R.4 heranzieht ("mittlerer Fehler je Viertelstunde").
--
-- Datums-Version oberhalb des höchsten ausgelieferten Standes (V20261111150000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast_rueckblick (
    day           DATE           NOT NULL,  -- Europe/Berlin Tag (wie Historie)
    tenant_id     UUID           NOT NULL,
    site_id       UUID           NOT NULL,
    kind          TEXT           NOT NULL CHECK (kind IN ('load', 'pv')),
    model         TEXT           NOT NULL,  -- Registry-Modell-Id
    lead_days     SMALLINT       NOT NULL CHECK (lead_days >= 1),
    erwartet_kwh  NUMERIC(12, 4) NOT NULL,  -- Tagessumme des Abend-Laufs
    gemessen_kwh  NUMERIC(12, 4) NOT NULL,  -- Tagessumme der Messung, gepaarte Viertelstunden
    mae_kw        NUMERIC(12, 4) NOT NULL,  -- mittlerer |Abend-Lauf - Messung| je Viertelstunde
    n_slots       INTEGER        NOT NULL,  -- gepaarte Viertelstunden (Deckung >= 90 %)
    computed_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, kind, model, day, lead_days)
);
CREATE INDEX IF NOT EXISTS idx_forecast_rueckblick_site_day
    ON forecast_rueckblick (site_id, day DESC);

GRANT SELECT ON forecast_rueckblick TO ${appDbUser};

ALTER TABLE forecast_rueckblick ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_rueckblick FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forecast_rueckblick_isolation ON forecast_rueckblick;
CREATE POLICY forecast_rueckblick_isolation ON forecast_rueckblick
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
