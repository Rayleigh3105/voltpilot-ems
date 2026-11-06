-- =============================================================================
-- Plattform-Übersicht (Scheibe S4, Nachbesserung): „Braucht dich" einzeln auf
-- gelesen/erledigt setzen.
--
-- Der Schlüssel ist der stabile Eintragsschlüssel aus `plattformUebersicht.ts`
-- (z. B. `fehler-<ref>`). `stand` hält den Grund-Text zum Zeitpunkt des
-- Erledigens fest: trägt der Eintrag später einen anderen Grund, erscheint er
-- wieder - die Tabelle hält also nur den ZULETZT bestätigten Stand, kein
-- Protokoll.
--
-- Global ohne Mandant, wie werkstatt_code (V20261102150000): keine Rechte für
-- die App-Rolle, RLS mit FORCE und ohne Policy, gelesen und geschrieben nur
-- über die BYPASSRLS-Rolle voltpilot_admin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS plattform_braucht_dich_erledigt (
    schluessel      TEXT        PRIMARY KEY,
    stand           TEXT        NOT NULL,
    erledigt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    erledigt_von    TEXT        NOT NULL,
    CONSTRAINT plattform_braucht_dich_erledigt_schluessel_chk
        CHECK (length(schluessel) BETWEEN 1 AND 200)
);

REVOKE ALL ON plattform_braucht_dich_erledigt FROM ${appDbUser};
REVOKE ALL ON plattform_braucht_dich_erledigt FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON plattform_braucht_dich_erledigt TO ${adminDbUser};

ALTER TABLE plattform_braucht_dich_erledigt ENABLE ROW LEVEL SECURITY;
ALTER TABLE plattform_braucht_dich_erledigt FORCE ROW LEVEL SECURITY;
