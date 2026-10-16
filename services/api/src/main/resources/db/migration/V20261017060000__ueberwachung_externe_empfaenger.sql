-- =============================================================================
-- V20261017060000 - Alerting Scheibe 6: freie externe E-Mail-Empfänger
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§7 Scheibe 6, Entscheid 11B): "freie externe
-- E-Mail-Empfänger je Überwachung erlaubt, aber NUR mit Bestätigung
-- (Double-Opt-In über den bestehenden Adress-Bestätigungs-Mechanismus aus
-- Scheibe 0); externe Inhalte knapp (keine Messwerte/Detaildaten, nur was
-- nötig ist plus Link ins Portal); Abbestellen-Möglichkeit in jeder externen Mail."
--
-- Anders als `zustellweg` (EINE E-Mail-Adresse je Person) gehört eine Zeile
-- hier zu GENAU EINER `ueberwachung` - eine externe Person kann für mehrere
-- Regeln eingetragen sein, jede mit ihrer eigenen Bestätigung. `aktiv = false`
-- nach "Abbestellen" (Link in jeder Mail, KEINE Anmeldung nötig - ein eigener,
-- NIE ablaufender Token, anders als der Bestätigungs-Token) oder nach
-- explizitem Entfernen durch die verwaltende Person; die Zeile bleibt als
-- Nachweis stehen (wie ein abgelaufenes `push_abo`), nicht gelöscht.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ueberwachung_externer_empfaenger (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    ueberwachung_id     UUID        NOT NULL,
    email               TEXT        NOT NULL,
    -- Einmaliger, ablaufender Bestätigungs-Token (derselbe Vertrag wie
    -- zustellweg.bestaetigung_token) - nach Gebrauch auf NULL gesetzt.
    bestaetigung_token      TEXT,
    bestaetigung_ablauf     TIMESTAMPTZ,
    bestaetigung_versandt_am TIMESTAMPTZ,
    bestaetigt_am       TIMESTAMPTZ,
    -- Eigener, NIE ablaufender Token für den Abbestellen-Link in jeder
    -- externen Mail (Entscheid 11B) - bewusst getrennt vom Bestätigungs-
    -- Token, der nach Gebrauch verbraucht ist.
    abbestellen_token   TEXT        NOT NULL,
    aktiv               BOOLEAN     NOT NULL DEFAULT TRUE,
    abbestellt_am       TIMESTAMPTZ,
    hinzugefuegt_von    TEXT        NOT NULL,
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ueb_ext_empf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ueb_ext_empf_ueberwachung_fk FOREIGN KEY (ueberwachung_id)
        REFERENCES ueberwachung (id) ON DELETE CASCADE,
    CONSTRAINT uq_ueb_ext_empf_regel_email UNIQUE (ueberwachung_id, email),
    CONSTRAINT ueb_ext_empf_email_chk CHECK (email <> ''),
    CONSTRAINT ueb_ext_empf_hinzugefuegt_chk CHECK (hinzugefuegt_von <> ''),
    CONSTRAINT ueb_ext_empf_abbestellen_token_chk CHECK (abbestellen_token <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ueb_ext_empf_bestaetigung_token
    ON ueberwachung_externer_empfaenger (bestaetigung_token) WHERE bestaetigung_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ueb_ext_empf_abbestellen_token
    ON ueberwachung_externer_empfaenger (abbestellen_token);
-- Der Versand liest je Regel NUR die bestätigten, aktiven Zeilen.
CREATE INDEX IF NOT EXISTS idx_ueb_ext_empf_regel
    ON ueberwachung_externer_empfaenger (ueberwachung_id) WHERE aktiv AND bestaetigt_am IS NOT NULL;

ALTER TABLE ueberwachung_externer_empfaenger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ueberwachung_externer_empfaenger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ueb_ext_empf_tenant_isolation ON ueberwachung_externer_empfaenger;
CREATE POLICY ueb_ext_empf_tenant_isolation ON ueberwachung_externer_empfaenger
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dieselbe Rechte-Form wie `zustellweg`: die verwaltende Person legt/entfernt
-- unter RLS; der Bestätigungs-/Abbestellen-Webhook (ohne Anmeldung) UND der
-- Zusteller (quer über alle Kundenbereiche fällige Zustellungen) brauchen die
-- BYPASSRLS-Admin-Rolle.
REVOKE ALL ON ueberwachung_externer_empfaenger FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ueberwachung_externer_empfaenger TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ueberwachung_externer_empfaenger TO ${adminDbUser};

COMMENT ON TABLE ueberwachung_externer_empfaenger IS
    'Alerting Scheibe 6 (Entscheid 11B): ein freier externer E-Mail-Empfänger EINER Überwachung - erst wirksam nach Bestätigung, mit eigenem, nie ablaufendem Abbestellen-Token.';
