-- =============================================================================
-- V20261114150000 - Abrechnung prüfen (Bedienkonzept vp-privatkunde-bedienkonzept §7, Paket R3,
-- Entscheid BK-10 = A vom 14.11.2026): die Mengen „laut Rechnung", die der Kunde neben die gemessenen
-- Mengen eines Zeitraums schreibt - EINE Zeile je Anlage und Zeitraum, nicht nur die letzte, damit
-- „Frühere Prüfungen" jeden geprüften Zeitraum wieder öffnen kann.
-- -----------------------------------------------------------------------------
-- * von/bis sind ganze Berliner Tage, beide eingeschlossen (Regel des Repos für tagesgenaue
--   Zuordnungen). Ein Zeitraum ist der Schlüssel: dieselben zwei Tage = dieselbe Prüfung.
-- * bezug_kwh / einspeisung_kwh: die Zahl von der Rechnung, je Richtung einzeln. NULL = nicht
--   eingetragen (ein leeres Feld löscht nur seine Zahl); sind beide NULL, löscht die API die Zeile.
-- * Kein Euro, kein Urteil: hier steht nur, was der Kunde abgeschrieben hat. Den Unterschied rechnet
--   die Oberfläche gegen die gemessene Menge (GET /api/v1/sites/{id}/abrechnung).
-- * Mandant aus dem Token (TenantContext), nie aus dem Request; RLS mit FORCE wie jede
--   mandanteneigene Tabelle. Die Anlage löscht ihre Prüfungen mit (ON DELETE CASCADE).
--
-- Datums-Version oberhalb des höchsten ausgelieferten Standes (V20261113190000). Wiederholbar
-- (IF NOT EXISTS / DROP POLICY IF EXISTS); läuft in Versionsreihenfolge auf frischer DB wie nach
-- späterer Ankunft, denn sie hängt nur an tenant und site.
-- =============================================================================

CREATE TABLE IF NOT EXISTS abrechnung_pruefung (
    site_id         UUID          NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    tenant_id       UUID          NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    von             DATE          NOT NULL,
    bis             DATE          NOT NULL,
    bezug_kwh       NUMERIC(14,3),
    einspeisung_kwh NUMERIC(14,3),
    geaendert_am    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- Das JWT-Subject der Person, die zuletzt geschrieben hat.
    geaendert_von   TEXT,
    PRIMARY KEY (site_id, von, bis),
    CONSTRAINT abrechnung_pruefung_zeitraum_chk CHECK (bis >= von),
    CONSTRAINT abrechnung_pruefung_menge_chk CHECK (
        (bezug_kwh IS NULL OR bezug_kwh >= 0) AND (einspeisung_kwh IS NULL OR einspeisung_kwh >= 0))
);

CREATE INDEX IF NOT EXISTS idx_abrechnung_pruefung_tenant ON abrechnung_pruefung (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON abrechnung_pruefung TO ${appDbUser};

ALTER TABLE abrechnung_pruefung ENABLE ROW LEVEL SECURITY;
ALTER TABLE abrechnung_pruefung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS abrechnung_pruefung_isolation ON abrechnung_pruefung;
CREATE POLICY abrechnung_pruefung_isolation ON abrechnung_pruefung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
