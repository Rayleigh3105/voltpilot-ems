-- =============================================================================
-- V20261015120000 - Alerting Scheibe 0: der zentrale Versand (Ausgang + E-Mail)
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§2.4, §6.2, §6.6, §6.7, §7 Scheibe 0, §9),
-- Captain-Entscheide 15.10.2026: 1A (Portal + E-Mail, Web-Push erst Scheibe 3),
-- 7C (nie SMS oder Anruf).
--
-- Diese Migration legt NUR den Ausgang und den Zustellweg E-Mail an - keine
-- Ueberwachungen, keine Regeln, kein Meldungs-Center (Scheiben 1-6). Sie ist
-- bewusst GENERISCH geschnitten, ohne auf eine (noch nicht existierende)
-- `alarm`-Tabelle zu verweisen:
--
--   benachrichtigung   der Ausgang (Outbox). Eine Zeile ist eine EINZELNE
--                      Zustellung: wer eine Meldung bekommen soll (`quelle` +
--                      `quelle_id`, z.B. 'unterstuetzung_hinweis' + die ID der
--                      Hinweis-Zeile), auf welchem Weg, aus welchem Anlass und
--                      mit welcher Nummer (Erinnerung 1, 2, 3; sonst 0). Der
--                      eindeutige Schluessel (tenant_id, quelle, quelle_id,
--                      empfaenger_sub, weg, anlass, nr) verhindert Doppel-
--                      versand bei Wiederholung oder zwei Pods (§9).
--
--   zustellweg         wie eine Person per E-Mail erreicht wird - erst
--                      wirksam nach Bestaetigung ueber einen Link (§6.6: der
--                      Benutzer-Spiegel ist ungeprueft und veraltet still).
--
-- `benachrichtigung.ziel` ist NULL fuer eine normale Zustellung (der Zusteller
-- loest die Adresse zur Sendezeit ueber den bestaetigten `zustellweg` auf) und
-- NUR fuer die Bestaetigungs-Mail selbst gesetzt (sie muss an die noch NICHT
-- bestaetigte Adresse gehen - das ist ja ihr Zweck).
--
-- Aufbewahrung: 90 Tage (Entscheid 13A), geloescht von ZustellLaeufer ueber die
-- BYPASSRLS-Admin-Rolle - dasselbe Laeufer-Muster wie AblaufLaeufer
-- (UEMS AP-03 IP-8): kein Timescale-Retention-Job, weil der eindeutige
-- Schluessel die Partitionsspalte NICHT enthaelt (ON CONFLICT muss ueber den
-- gesamten Zeitraum hinweg wirken, nicht nur innerhalb eines Chunks) - eine
-- normale Tabelle mit App-seitiger Loeschung ist hier das richtige Werkzeug,
-- nicht `add_retention_policy`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS benachrichtigung (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL,
    -- Die Meldung, die zugestellt werden soll - generisch, weil es die
    -- `alarm`-Tabelle der spaeteren Scheiben hier noch nicht gibt.
    quelle            TEXT        NOT NULL,
    quelle_id         UUID        NOT NULL,
    empfaenger_sub    TEXT        NOT NULL,
    weg               TEXT        NOT NULL,
    anlass            TEXT        NOT NULL,
    nr                INTEGER     NOT NULL DEFAULT 0,
    -- NUR fuer die Bestaetigungs-Mail direkt gesetzt (siehe oben); sonst NULL
    -- und zur Sendezeit aus dem bestaetigten Zustellweg aufgeloest.
    ziel              TEXT,
    betreff           TEXT        NOT NULL,
    inhalt            TEXT        NOT NULL,
    zustand           TEXT        NOT NULL DEFAULT 'wartet',
    grund             TEXT,
    versuche          INTEGER     NOT NULL DEFAULT 0,
    naechster_versuch TIMESTAMPTZ NOT NULL DEFAULT now(),
    gesendet_am       TIMESTAMPTZ,
    fehler            TEXT,
    erstellt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_benachrichtigung_schluessel
        UNIQUE (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, nr),
    CONSTRAINT benachrichtigung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Nur E-Mail in dieser Scheibe (Entscheid 1A); weitere Wege (Web-Push,
    -- Webhook, Telegram) erweitern diese Liste additiv in ihrer eigenen
    -- Migration, nie SMS oder Anruf (Entscheid 7C).
    CONSTRAINT benachrichtigung_weg_chk CHECK (weg IN ('email')),
    CONSTRAINT benachrichtigung_zustand_chk
        CHECK (zustand IN ('wartet', 'gesendet', 'fehlgeschlagen', 'unterdrueckt')),
    CONSTRAINT benachrichtigung_quelle_chk CHECK (quelle <> ''),
    CONSTRAINT benachrichtigung_empfaenger_chk CHECK (empfaenger_sub <> ''),
    CONSTRAINT benachrichtigung_anlass_chk CHECK (anlass <> ''),
    CONSTRAINT benachrichtigung_nr_chk CHECK (nr >= 0),
    CONSTRAINT benachrichtigung_versuche_chk CHECK (versuche >= 0)
);
-- Der Zusteller holt faellige Arbeit stapelweise, aeltester zuerst (FOR UPDATE
-- SKIP LOCKED) - dasselbe Muster wie ComponentActivationOutboxService.
CREATE INDEX IF NOT EXISTS idx_benachrichtigung_faellig
    ON benachrichtigung (naechster_versuch)
    WHERE zustand = 'wartet';
-- Der Loeschlauf fegt nach Alter, unabhaengig vom Zustand.
CREATE INDEX IF NOT EXISTS idx_benachrichtigung_erstellt
    ON benachrichtigung (erstellt_am);

CREATE TABLE IF NOT EXISTS zustellweg (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    benutzer_sub        TEXT        NOT NULL,
    weg                 TEXT        NOT NULL,
    ziel                TEXT        NOT NULL,
    -- Einmaliger, ablaufender Bestaetigungs-Token (§6.6); nach Gebrauch wird er
    -- geloescht (NULL), ein zweiter Aufruf desselben Links findet dann nichts
    -- mehr und bekommt den ehrlichen Befund "schon bestaetigt oder abgelaufen".
    bestaetigung_token      TEXT,
    bestaetigung_ablauf     TIMESTAMPTZ,
    bestaetigung_versandt_am TIMESTAMPTZ,
    bestaetigt_am       TIMESTAMPTZ,
    aktiv               BOOLEAN     NOT NULL DEFAULT TRUE,
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_zustellweg_person_weg UNIQUE (tenant_id, benutzer_sub, weg),
    CONSTRAINT zustellweg_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT zustellweg_weg_chk CHECK (weg IN ('email')),
    CONSTRAINT zustellweg_benutzer_chk CHECK (benutzer_sub <> ''),
    CONSTRAINT zustellweg_ziel_chk CHECK (ziel <> '')
);
-- Der Bestaetigungs-Endpunkt hat keine Anmeldung und damit keinen Mandanten-
-- Kontext; er findet die Zeile ausschliesslich ueber den Token (global
-- eindeutig per SecureRandom, 256 Bit).
CREATE UNIQUE INDEX IF NOT EXISTS uq_zustellweg_token
    ON zustellweg (bestaetigung_token) WHERE bestaetigung_token IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK (Hausregel).
-- -----------------------------------------------------------------------------
ALTER TABLE benachrichtigung ENABLE ROW LEVEL SECURITY;
ALTER TABLE benachrichtigung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS benachrichtigung_tenant_isolation ON benachrichtigung;
CREATE POLICY benachrichtigung_tenant_isolation ON benachrichtigung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE zustellweg ENABLE ROW LEVEL SECURITY;
ALTER TABLE zustellweg FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zustellweg_tenant_isolation ON zustellweg;
CREATE POLICY zustellweg_tenant_isolation ON zustellweg
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte: V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede
-- neue Tabelle - hier wird ALLES genommen und eng neu gegeben (wie IP-2 / IP-8).
-- -----------------------------------------------------------------------------
REVOKE ALL ON benachrichtigung, zustellweg FROM ${appDbUser}, ${adminDbUser};

-- Die einreihenden Dienste (RLS-Verbindung je Kundenbereich) legen nur an und
-- lesen ihren eigenen Zustellweg; der tatsaechliche Versand - als gesendet,
-- fehlgeschlagen oder unterdrueckt eintragen, loeschen - laeuft ausschliesslich
-- ueber die BYPASSRLS-Rolle (VersandRepository), weil der Zusteller quer ueber
-- ALLE Kundenbereiche faellige Zeilen claimt (wie ComponentActivationOutboxService).
GRANT SELECT, INSERT ON benachrichtigung TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON zustellweg TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: der Laeufer ueber alle Kundenbereiche
-- (wie AblaufLaeufer), der Loeschlauf (90 Tage, Entscheid 13A) und die
-- oeffentliche Bestaetigung (ohne Mandanten-Kontext, ZustellwegRepository).
GRANT SELECT, INSERT, UPDATE, DELETE ON benachrichtigung TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON zustellweg TO ${adminDbUser};

COMMENT ON TABLE benachrichtigung IS
    'Alerting Scheibe 0 (§6.7, §9): der EINE Ausgang des zentralen Versands; eindeutiger Schluessel je Meldung, Empfaenger, Weg, Anlass und Nummer gegen Doppelversand.';
COMMENT ON TABLE zustellweg IS
    'Alerting Scheibe 0 (§6.6): wie eine Person per E-Mail erreicht wird - erst wirksam nach Bestaetigung ueber einen einmaligen, ablaufenden Link.';
