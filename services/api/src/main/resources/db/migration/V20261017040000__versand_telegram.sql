-- =============================================================================
-- V20261017040000 - Alerting Scheibe 6: Telegram als fünfter Zustellweg
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4, §6.6, §6.7, §7 Scheibe 6, §9).
--
-- `telegram_ziel` trägt sowohl den OFFENEN Verbindungs-Versuch (Start-Link-
-- Fluss, "Telegram verbinden" erzeugt t.me/<bot>?start=<token>) als auch die
-- BESTÄTIGTE Verbindung: `chat_id` ist NULL, solange die Person den Start-Link
-- noch nicht in Telegram geöffnet hat, und wird vom Webhook-Empfänger der
-- Bot-Updates gesetzt, sobald die Nachricht "/start <token>" eintrifft - die
-- Chat-Interaktion selbst IST die Bestätigung (kein zweiter Link wie bei
-- E-Mail nötig, derselbe Gedanke wie die Browser-Push-Erlaubnis bei `push_abo`).
-- "Trennen" (§7 Scheibe 6 Punkt 2) löscht die Zeile (DELETE), wie ein
-- Geräte-Abo entfernt wird.
-- =============================================================================

ALTER TABLE benachrichtigung DROP CONSTRAINT benachrichtigung_weg_chk;
ALTER TABLE benachrichtigung ADD CONSTRAINT benachrichtigung_weg_chk
    CHECK (weg IN ('email', 'webpush', 'webhook', 'telegram'));

CREATE TABLE IF NOT EXISTS telegram_ziel (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    benutzer_sub        TEXT        NOT NULL,
    -- NULL bis zur Bestätigung per "/start <token>" in Telegram.
    chat_id             TEXT,
    -- Einmaliger, ablaufender Verbindungs-Token (derselbe Vertrag wie
    -- `zustellweg.bestaetigung_token`); nach Gebrauch auf NULL gesetzt.
    verbindungs_token   TEXT,
    verbindungs_ablauf  TIMESTAMPTZ,
    aktiv               BOOLEAN     NOT NULL DEFAULT TRUE,
    ab_schwere          TEXT        NOT NULL DEFAULT 'warnung',
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    bestaetigt_am       TIMESTAMPTZ,
    letzter_erfolg_am   TIMESTAMPTZ,
    abgelaufen_am       TIMESTAMPTZ,
    CONSTRAINT telegram_ziel_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT telegram_ziel_benutzer_chk CHECK (benutzer_sub <> ''),
    CONSTRAINT telegram_ziel_ab_schwere_chk CHECK (ab_schwere IN ('hinweis', 'warnung', 'dringend')),
    CONSTRAINT telegram_ziel_zustand_chk
        CHECK (chat_id IS NOT NULL OR verbindungs_token IS NOT NULL)
);
-- Der Bestätigungs-Webhook (Telegram-Update "/start <token>") hat keine
-- Anmeldung und damit keinen Mandanten-Kontext - wie der E-Mail-Bestätigungs-
-- Endpunkt findet er die Zeile ausschließlich über den global eindeutigen Token.
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_ziel_token
    ON telegram_ziel (verbindungs_token) WHERE verbindungs_token IS NOT NULL;
-- Eine bestätigte Chat-ID ist je Kundenbereich eindeutig - zwei Personen
-- könnten sonst denselben Chat beanspruchen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_ziel_chat
    ON telegram_ziel (tenant_id, chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telegram_ziel_person
    ON telegram_ziel (tenant_id, benutzer_sub) WHERE aktiv;

ALTER TABLE telegram_ziel ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_ziel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telegram_ziel_tenant_isolation ON telegram_ziel;
CREATE POLICY telegram_ziel_tenant_isolation ON telegram_ziel
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dieselbe Rechte-Form wie `push_abo`/`webhook_ziel`: die einreihende Person
-- verwaltet ihre eigene Verbindung unter RLS; der Bestätigungs-Webhook und
-- der Zusteller (quer über alle Kundenbereiche) brauchen die BYPASSRLS-Rolle.
REVOKE ALL ON telegram_ziel FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_ziel TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_ziel TO ${adminDbUser};

COMMENT ON TABLE telegram_ziel IS
    'Alerting Scheibe 6 (§7): eine Telegram-Verbindung - offen (nur Token) bis "/start <token>" die chat_id setzt, danach ein Zustellweg wie push_abo.';
