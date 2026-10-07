-- =============================================================================
-- V20261007120000 - Steuerstand des Speichers je Box (device_battery_control).
-- -----------------------------------------------------------------------------
-- Die Box meldet in JEDEM Status-Herzschlag (ems/{t}/{s}/{d}/status, additiver
-- Block `battery_control`), ob VoltPilot den Speicher steuert oder nur
-- beobachtet (Vertrag docs/contracts/speicher-steuerstand.md):
--
--   state            gesteuert | beobachtet | not_aus
--   control_enabled  Steuerschalter UND Modell-/Gerätefreigabe (dieselbe
--                    Bedeutung wie in device_control_status und auf edge/setpoint)
--   certified        Modell-/Gerätefreigabe
--
-- Eine eigene Tabelle statt Spalten in device_control_status: dort entsteht
-- eine Zeile nur mit einer Rücklesung (all_match/checked_at NOT NULL), und
-- ihre Existenz steuert die Steuerungs-Zeile im Portal. Edge Light liest nicht
-- zurück und hätte dort nie eine Zeile.
--
-- Der Optimierer liest die Tabelle (Backend-Rolle, wie flow_claim) über
-- asset.device_id und plant einen frisch als beobachtet oder Not-Aus gemeldeten
-- Speicher als Eigenverbrauch. Fehlt die Zeile oder ist reported_at zu alt,
-- gilt der Speicher als gesteuert - der Stand vor dieser Migration.
--
--   reported_at  letzter Herzschlag mit dem Block, Uhr der API beim Empfang
--                (nicht die der Box: eine vorgehende Box-Uhr hielte die
--                Zeile sonst künstlich frisch)
--   state_since  seit wann die API diesen state sieht (bleibt bei gleichem
--                state stehen) - für Betrieb und Diagnose
--
-- Mandantengebunden + RLS + FORCE wie device_control_status (der Listener läuft
-- als App-Rolle mit dem Mandanten des Topics in app.tenant_id).
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_battery_control (
    device_id       UUID          PRIMARY KEY,
    tenant_id       UUID          NOT NULL,
    site_id         UUID          NOT NULL,
    state           TEXT          NOT NULL
        CONSTRAINT device_battery_control_state_check
        CHECK (state IN ('gesteuert', 'beobachtet', 'not_aus')),
    control_enabled BOOLEAN       NOT NULL,
    certified       BOOLEAN       NOT NULL,
    state_since     TIMESTAMPTZ   NOT NULL,
    reported_at     TIMESTAMPTZ   NOT NULL,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_battery_control_site
    ON device_battery_control (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_battery_control TO ${appDbUser};

ALTER TABLE device_battery_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_battery_control FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_battery_control_isolation ON device_battery_control;
CREATE POLICY device_battery_control_isolation ON device_battery_control
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
