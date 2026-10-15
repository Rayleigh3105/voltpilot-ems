-- =============================================================================
-- V20261016090000 - Alerting Scheibe 3: Web-Push als zweiter Zustellweg
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4, §6.6, §6.7, §7 Scheibe 3, §9), Captain-
-- Entscheide 15.10.2026: 1A (Web-Push jetzt, dritter Weg neben Portal/E-Mail),
-- 7C (weiterhin nie SMS oder Anruf).
--
-- Additive Erweiterung der Scheibe-0-Tabellen (V20261015120000), wie schon
-- Scheibe 2 die `ueberwachung_herkunft_chk` additiv weitete:
--
--   benachrichtigung_weg_chk   'email' -> 'email', 'webpush'.
--   zustellweg                 bekommt `ab_schwere` fuer den E-Mail-Weg ("ab
--                               welcher Stufe diese Adresse Meldungen
--                               bekommt" - die Zustell-Vorgabe je Stufe aus
--                               §6.4 ist die VORGABE dieser Spalte, Vorgabe
--                               'warnung') sowie die Tages-Zusammenfassung
--                               ALS EIGENSCHAFT des E-Mail-Wegs (§6.4:
--                               "wahlweise in der Tages-Zusammenfassung" - sie
--                               ist kein eigener Kanal, sondern eine
--                               gebuendelte E-Mail desselben Wegs). `zustellweg`
--                               bleibt E-Mail-spezifisch (eine Adresse, ein
--                               Bestaetigungslink) - Push hat dafuer KEINE
--                               Entsprechung noetig (siehe unten), die CHECK
--                               `weg IN ('email')` bleibt darum unveraendert.
--   push_abo                   EIGENE FESTLEGUNG, kein Vorbild im Konzept-
--                               Text: anders als E-Mail (eine Adresse je
--                               Person) kann Push mehrere GERAETE je Person
--                               haben ("Abo je Gerät", §7); darum trägt JEDES
--                               Abo seine eigene Zustell-Vorgabe
--                               (`ab_schwere`, Vorgabe 'warnung') und seinen
--                               eigenen Schalter (`aktiv`, "Push je Gerät
--                               an/aus") - keine zusaetzliche
--                               personen-weite Push-Zeile in `zustellweg`,
--                               die mit mehreren Geraeten kollidieren wuerde.
--                               Endpunkt + die zwei Schluessel (`p256dh`,
--                               `auth`) sind die Browser-`PushSubscription`
--                               fuer die Ende-zu-Ende-Verschluesselung nach
--                               RFC 8291. Abgelaufene oder vom Push-Dienst als
--                               ungueltig gemeldete Abos (HTTP 404/410) werden
--                               vom Zusteller als `aktiv = false` markiert
--                               statt geloescht (Nachweis im Verlauf; "Dieses
--                               Handy" in der Einstellungsflaeche kann sie
--                               trotzdem entfernen, DELETE).
--
-- Die Browser-Push-Erlaubnis selbst IST die Bestaetigung (ein Tippen vor der
-- Nachfrage des Browsers, §5 [K1]) - push_abo braucht darum KEINE
-- bestaetigung_token-Spalte wie der E-Mail-Weg.
-- =============================================================================

ALTER TABLE benachrichtigung DROP CONSTRAINT benachrichtigung_weg_chk;
ALTER TABLE benachrichtigung ADD CONSTRAINT benachrichtigung_weg_chk
    CHECK (weg IN ('email', 'webpush'));

-- Nur fuer `quelle = 'alarm'` gesetzt (die Schwere der ausloesenden Regel) -
-- der Zusteller braucht sie, um Push auf GENAU die Geraete zu faechern, deren
-- eigene Zustell-Vorgabe (`push_abo.ab_schwere`) diese Stufe noch zulaesst,
-- OHNE dafuer das Paket `ueberwachung` zu kennen (dieselbe Entkopplung wie
-- `UeberwachungSichtPruefung`/`RuhezeitPruefung`, die den Alarm selbst
-- nachschlagen - diese Spalte ist der Fall, in dem das zu teuer waere, weil
-- JEDES Geraet der Zeile einzeln geprueft wird).
ALTER TABLE benachrichtigung ADD COLUMN IF NOT EXISTS schwere TEXT;
ALTER TABLE benachrichtigung ADD CONSTRAINT benachrichtigung_schwere_chk
    CHECK (schwere IS NULL OR schwere IN ('hinweis', 'warnung', 'dringend'));

-- Reihenfolge der Schwere fuer "ab welcher Stufe gilt dieser Weg" (§6.4): eine
-- schlichte Rang-Funktion statt eine vierte Kopie derselben drei-Werte-CASE in
-- jeder Abfrage - IMMUTABLE, damit sie in einem Index-Ausdruck stehen dürfte.
CREATE OR REPLACE FUNCTION schwere_rang(s TEXT) RETURNS INT AS $$
    SELECT CASE s WHEN 'hinweis' THEN 0 WHEN 'warnung' THEN 1 WHEN 'dringend' THEN 2 ELSE -1 END
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE zustellweg ADD COLUMN IF NOT EXISTS ab_schwere TEXT NOT NULL DEFAULT 'warnung';
ALTER TABLE zustellweg ADD CONSTRAINT zustellweg_ab_schwere_chk
    CHECK (ab_schwere IN ('hinweis', 'warnung', 'dringend'));
-- Nur der E-Mail-Weg kennt eine Tages-Zusammenfassung (§6.4 Nr. 6, Vorgabe AUS,
-- Vorgabezeit 07:00 Ortszeit - die Zeitzone ist die der Person, ruhezeit_person).
ALTER TABLE zustellweg ADD COLUMN IF NOT EXISTS zusammenfassung_aktiv BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE zustellweg ADD COLUMN IF NOT EXISTS zusammenfassung_uhrzeit TIME NOT NULL DEFAULT '07:00';

CREATE TABLE IF NOT EXISTS push_abo (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    benutzer_sub    TEXT        NOT NULL,
    endpoint        TEXT        NOT NULL,
    p256dh          TEXT        NOT NULL,
    auth            TEXT        NOT NULL,
    -- Anzeigename des Geraets ("iPhone von Ines") - vom Browser/Portal beim
    -- Abo mitgegeben, frei aenderbar, nie Teil der Kennung.
    geraet          TEXT        NOT NULL,
    user_agent      TEXT,
    -- "Push je Gerät an/aus" (§7 Scheibe 3 Punkt 7) und "ab welcher Stufe"
    -- (§6.4) - je GERAET, nicht je Person (siehe Kopf-Kommentar).
    aktiv           BOOLEAN     NOT NULL DEFAULT TRUE,
    ab_schwere      TEXT        NOT NULL DEFAULT 'warnung',
    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    letzter_erfolg_am TIMESTAMPTZ,
    abgelaufen_am   TIMESTAMPTZ,
    CONSTRAINT push_abo_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT uq_push_abo_endpoint UNIQUE (tenant_id, endpoint),
    CONSTRAINT push_abo_endpoint_chk CHECK (endpoint <> ''),
    CONSTRAINT push_abo_p256dh_chk CHECK (p256dh <> ''),
    CONSTRAINT push_abo_auth_chk CHECK (auth <> ''),
    CONSTRAINT push_abo_benutzer_chk CHECK (benutzer_sub <> ''),
    CONSTRAINT push_abo_geraet_chk CHECK (geraet <> ''),
    CONSTRAINT push_abo_ab_schwere_chk CHECK (ab_schwere IN ('hinweis', 'warnung', 'dringend'))
);
-- Der Zusteller faechert EINE Zustellung (benachrichtigung, weg='webpush') auf
-- ALLE aktiven Geraete der Person auf, die fuer diese Stufe gelten ("Abo je Gerät").
CREATE INDEX IF NOT EXISTS idx_push_abo_person
    ON push_abo (tenant_id, benutzer_sub) WHERE aktiv;

ALTER TABLE push_abo ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_abo FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_abo_tenant_isolation ON push_abo;
CREATE POLICY push_abo_tenant_isolation ON push_abo
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dieselbe Rechte-Form wie `zustellweg` (V20261015120000): die einreihende
-- Person verwaltet ihr eigenes Abo unter RLS; der Zusteller faechert quer
-- ueber alle Kundenbereiche faellige Zustellungen auf alle Geraete auf und
-- markiert abgelaufene Abos (410 Gone) - das braucht die BYPASSRLS-Admin-Rolle.
REVOKE ALL ON push_abo FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON push_abo TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON push_abo TO ${adminDbUser};

COMMENT ON TABLE push_abo IS
    'Alerting Scheibe 3 (§6.7): ein Geraete-Abo fuer Web-Push (Browser Push API); eine Person kann mehrere haben, je mit eigenem an/aus und eigener Zustell-Vorgabe.';
COMMENT ON COLUMN zustellweg.ab_schwere IS
    'Alerting Scheibe 3 (§6.4): dieser Weg gilt ab dieser Stufe (Zustell-Vorgabe je Stufe, personenseitig aenderbar).';
