-- =============================================================================
-- V20261017030000 - Alerting Scheibe 6: Webhook als vierter Zustellweg
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4, §6.6, §6.7, §7 Scheibe 6, §9), Captain-
-- Entscheid 7C (weiterhin nie SMS oder Anruf).
--
-- Additive Erweiterung der Scheibe-0/3-Tabellen, wie schon Scheibe 3 die
-- `benachrichtigung_weg_chk` additiv weitete:
--
--   benachrichtigung_weg_chk   'email', 'webpush' -> + 'webhook'.
--   webhook_ziel                EIGENE FESTLEGUNG, kein Vorbild im Konzept-
--                                Text, aber derselbe Zuschnitt wie `push_abo`
--                                (V20261016090000): anders als E-Mail (eine
--                                Adresse je Person) kann eine Person mehrere
--                                Webhook-Ziele haben (ein Teams-Kanal, ein
--                                Slack-Kanal, ...) - darum trägt JEDES Ziel
--                                seine eigene Zustell-Vorgabe (`ab_schwere`,
--                                Vorgabe 'warnung') und seinen eigenen
--                                Schalter (`aktiv`). `geheimnis` ist das
--                                HMAC-Geheimnis GENAU dieses Ziels (nie
--                                geteilt, nie ins Repo - serverseitig per
--                                SecureRandom erzeugt, einmal beim Anlegen
--                                gezeigt). Ein dauerhaft totes Ziel (HTTP
--                                404/410) ODER ein Ziel, das die SSRF-Prüfung
--                                nicht mehr besteht, wird vom Zusteller als
--                                `aktiv = false` markiert statt gelöscht
--                                (Nachweis im Verlauf; die Einstellungsfläche
--                                kann es trotzdem entfernen, DELETE).
-- =============================================================================

ALTER TABLE benachrichtigung DROP CONSTRAINT benachrichtigung_weg_chk;
ALTER TABLE benachrichtigung ADD CONSTRAINT benachrichtigung_weg_chk
    CHECK (weg IN ('email', 'webpush', 'webhook'));

CREATE TABLE IF NOT EXISTS webhook_ziel (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    benutzer_sub    TEXT        NOT NULL,
    url             TEXT        NOT NULL,
    -- HMAC-SHA256-Geheimnis GENAU dieses Ziels (256 Bit, URL-sicher kodiert) -
    -- signiert jede Nutzlast (Header X-VoltPilot-Signature), nie ins Repo.
    geheimnis       TEXT        NOT NULL,
    name            TEXT        NOT NULL DEFAULT '',
    aktiv           BOOLEAN     NOT NULL DEFAULT TRUE,
    ab_schwere      TEXT        NOT NULL DEFAULT 'warnung',
    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    letzter_erfolg_am TIMESTAMPTZ,
    abgelaufen_am   TIMESTAMPTZ,
    CONSTRAINT webhook_ziel_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT uq_webhook_ziel_url UNIQUE (tenant_id, benutzer_sub, url),
    CONSTRAINT webhook_ziel_url_chk CHECK (url <> ''),
    CONSTRAINT webhook_ziel_geheimnis_chk CHECK (geheimnis <> ''),
    CONSTRAINT webhook_ziel_benutzer_chk CHECK (benutzer_sub <> ''),
    CONSTRAINT webhook_ziel_ab_schwere_chk CHECK (ab_schwere IN ('hinweis', 'warnung', 'dringend'))
);
-- Der Zusteller fächert EINE Zustellung (benachrichtigung, weg='webhook') auf
-- ALLE aktiven Ziele der Person auf, die für diese Stufe gelten.
CREATE INDEX IF NOT EXISTS idx_webhook_ziel_person
    ON webhook_ziel (tenant_id, benutzer_sub) WHERE aktiv;

ALTER TABLE webhook_ziel ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_ziel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_ziel_tenant_isolation ON webhook_ziel;
CREATE POLICY webhook_ziel_tenant_isolation ON webhook_ziel
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dieselbe Rechte-Form wie `push_abo`: die einreihende Person verwaltet ihr
-- eigenes Ziel unter RLS; der Zusteller fächert quer über alle Kundenbereiche
-- fällige Zustellungen auf alle Ziele auf und markiert tote Ziele - das
-- braucht die BYPASSRLS-Admin-Rolle.
REVOKE ALL ON webhook_ziel FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_ziel TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_ziel TO ${adminDbUser};

COMMENT ON TABLE webhook_ziel IS
    'Alerting Scheibe 6 (§7): ein Webhook-Ziel (Teams-Workflow, Slack-Incoming-Webhook, ...); eine Person kann mehrere haben, je mit eigenem an/aus und eigener Zustell-Vorgabe.';
