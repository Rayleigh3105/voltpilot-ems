-- =============================================================================
-- V20260829000000 - Die Anschlussgrenze wird im PORTAL gepflegt (Stufe 3).
-- -----------------------------------------------------------------------------
-- Bis hierher lebten die Lastmanagement-Einstellungen ausschliesslich auf der
-- Box (`lastmgmt.json`, gepflegt auf `:8484`) - wer einen Ladepark einrichtete,
-- musste im LAN am Geraet stehen. Der Aktivieren-Dialog der Steuerungs-Karte
-- fragt die Anschlussgrenze jetzt im Portal ab (Captain-Entscheid aus dem
-- Mockup-Zyklus), also braucht die Cloud einen Ort, an dem SIE steht.
--
-- ⚠ Es entsteht KEIN zweiter Verteiler. Gespeichert wird nur, was der Kunde
-- WÜNSCHT; gerechnet und durchgesetzt wird weiter auf der Box (die
-- Anschlussgrenze ist eine physische Grenze, ihr Waechter darf nicht am WAN
-- haengen - Konzept E1). Der Weg ist der etablierte: Zeile -> retained
-- Dokument auf `v2/charging-config` -> die Box uebernimmt es in ihre
-- Einstellungen.
--
-- ⚠ ZWEI Tabellen, weil es zwei verschiedene Dinge sind: die Anlagen-Zahl
-- (eine Zeile) und die VORRANG-Wahl je Saeule. Der Vorrang ist eine Menge, und
-- die ANWESENHEIT der Zeile IST die Aussage (das
-- device_control_activation-Muster) - kein `priority BOOLEAN`, das auf false
-- stehen und trotzdem Historie vortaeuschen koennte.
--
-- Mandantengebunden + RLS + FORCE: das sind KUNDENDATEN einer Anlage.
--
-- Datums-Version nach der AGENTS.md-Regel zur Migrations-Koordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_charging_config (
    site_id        UUID          NOT NULL PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id      UUID          NOT NULL,
    -- Die Anschlussgrenze am Netzverknuepfungspunkt in kW. NULL = nicht
    -- gepflegt, und dann ist das Budget der Box 0: eine erfundene Grenze waere
    -- eine Zusage ueber die Sicherung eines Kunden.
    grid_limit_kw  DOUBLE PRECISION,
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- Wer sie zuletzt gesetzt hat (JWT-Subject) - dieselbe Papier-Spur wie bei
    -- jeder anderen Kunden-Entscheidung ueber eine Anlage.
    updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS site_charge_point_priority (
    site_id         UUID  NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    charge_point_id TEXT  NOT NULL,
    tenant_id       UUID  NOT NULL,
    PRIMARY KEY (site_id, charge_point_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_charging_config TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON site_charge_point_priority TO ${appDbUser};

ALTER TABLE site_charging_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_charging_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_charging_config_isolation ON site_charging_config;
CREATE POLICY site_charging_config_isolation ON site_charging_config
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE site_charge_point_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_charge_point_priority FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_charge_point_priority_isolation ON site_charge_point_priority;
CREATE POLICY site_charge_point_priority_isolation ON site_charge_point_priority
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
