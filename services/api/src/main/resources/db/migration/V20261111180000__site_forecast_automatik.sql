-- =============================================================================
-- V20261111180000 - S5 ("Verbrauch lernt von selbst", Konzept
-- vp-prognosen-konzept, E6 = B): der Schalter "automatisch wählen" JE ANLAGE.
-- -----------------------------------------------------------------------------
-- WOFÜR (Bericht R.4 Punkt 2 - "Ein Mensch gewinnt"):
--
-- Wählt der Kunde das Lastmodell von Hand (site_forecast_model_choice,
-- V20260826000000), wechselt die Automatik nicht mehr, bis er sie wieder
-- einschaltet - sonst überschriebe die jüngste automatische Umstellung eine
-- ausdrückliche Entscheidung. Diese Tabelle trägt GENAU diesen einen Schalter.
--
-- ⚠ BEWUSST EINE EIGENE, VERÄNDERLICHE TABELLE statt eine Spalte auf
--   site_forecast_model_choice: jene Tabelle ist APPEND-ONLY (das Journal -
--   "was galt wann"); ein nachträglich überschreibbares Feld darin wäre ein
--   zweiter Tabellen-Charakter in derselben Tabelle gewesen. Hier steht nur
--   der AKTUELLE Zustand, eine Zeile je Anlage, austauschbar wie jede
--   Einstellung.
--
-- ⚠ NUR 'load': die Automatik gilt nach R.4 ausdrücklich dem Verbrauch - für
--   die lernende PV-Korrektur bleibt es bei der Wahl von Hand (keine Spalte
--   "kind", die nie einen zweiten Wert trägt).
--
-- Schreibpfade: der Kunde über die RLS-gefencte App-Rolle
-- (/api/v1/sites/{id}/forecast-models), automatisch deaktiviert von
-- SiteForecastModelController bei einer Wahl von Hand, wieder eingeschaltet
-- über denselben Pfad (POST .../forecast-models/automatik). Der Läufer
-- (AutomatikLaeufer) selbst schreibt hier NIE - er liest nur, ob er für eine
-- Anlage zuständig ist, und schreibt ausschließlich über
-- SiteForecastModelChoiceRepository.promote (dieselbe RLS-gefencte Rolle,
-- je Mandant über TenantContext).
--
-- Ohne eine Zeile gilt die Automatik AN (der Vorgabewert nach E6 = B - eine
-- Anlage, die nie etwas gewählt hat, soll das lernende Modell bekommen,
-- sobald es besser ist).
--
-- Datums-Version oberhalb des höchsten ausgelieferten Standes
-- (V20261111170000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_forecast_automatik (
    site_id    UUID        PRIMARY KEY REFERENCES site(id)   ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL    REFERENCES tenant(id) ON DELETE CASCADE,
    aktiv      BOOLEAN     NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Das JWT-Subject des Umstellers, wie set_by im Journal; NULL bleibt nur
    -- der nie von Hand berührte Vorgabewert (keine Zeile).
    updated_by TEXT
);

GRANT SELECT, INSERT, UPDATE ON site_forecast_automatik TO ${appDbUser};
REVOKE DELETE ON site_forecast_automatik FROM ${appDbUser};

ALTER TABLE site_forecast_automatik ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_forecast_automatik FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_forecast_automatik_isolation ON site_forecast_automatik;
CREATE POLICY site_forecast_automatik_isolation ON site_forecast_automatik
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
