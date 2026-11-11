-- MiSpeL MP-6: die Zählerrolle einer Messstelle nach Anlage 1 der Festlegung
-- (BNetzA, Marktintegration von Speichern und Ladepunkten, Beschluss 01.10.2026).
-- Vertrag: docs/contracts/v2/mispel-zaehlerrolle.md.
--
-- Anlage 1 rechnet mit „Zählern“ Z1 (Netzanschluss, Zweirichtung), Z2 (Speicher
-- und/oder Ladepunkt) und Z3 (Speicher allein, Basisfall A4) — und sagt auf
-- S. 23 (Abschn. 3.2.2): die „Zähler“ sind Zählpunkte mit den jeweils
-- erforderlichen Messeinrichtungen. Eine Messstelle des Registers trägt EINE
-- Richtung (V20260911140000); der Zweirichtungszähler Z1 sind darum zwei
-- Messstellen derselben Rolle (Bezug = Z1NB, Abgabe = Z1NE), Z2 entsprechend
-- Z2V/Z2E. Welche Größe der Festlegung eine Messstelle liefert, folgt aus Rolle
-- und Richtung (ZaehlerrolleRegeln.festlegungsgroesse), nie aus einer Spalte.
--
-- FASSUNGEN STATT ÜBERSCHREIBEN: jede Zeile gilt ab einem TAG (00:00 in der
-- Zeitzone des Kundenbereichs) bis zum Tag vor der nächsten Fassung derselben
-- Messstelle; `rolle` NULL = ab diesem Tag keine Rolle (dann trägt die Zeile
-- auch keine Angaben). Das Rechenwerk (MP-8) liest je Monat die Fassung jedes
-- Tages. Eine Korrektur desselben Tages hebt die alte Zeile auf
-- (`aufgehoben_am`) und lässt sie lesbar; gelöscht oder umgeschrieben wird nie.
--
-- `eichstatus` NULL = nicht erhoben (wie die Messmittel-Angaben am Einbau,
-- V20260922245000, G3) — nie ein Vorgabewert: unbekannt ist nicht konform.
-- Die Angaben am Einbau beschreiben das Gerät der Box; diese Zeile beschreibt
-- den Zählpunkt der Festlegung, dessen Messeinrichtung meist dem
-- Messstellenbetreiber gehört. Beide bleiben getrennt.
--
-- Was die Datenbank NICHT prüft (Regeln des Schreibwegs ZaehlerrolleService,
-- die den Tag, den elektrischen Baum und die Komponenten brauchen): die
-- Passung zur Messstelle (gemessen, Strom, Wirkenergie, Bezug/Abgabe), je
-- Anlage und Festlegungs-Größe höchstens eine Messstelle, und die strikte
-- messtechnische Trennung hinter Z2/Z3 (Anlage 1 S. 25, Abschn. 3.2.4).
--
-- Keine Bestandszeile ändert sich; die Tabelle beginnt leer.

CREATE TABLE IF NOT EXISTS messstelle_zaehlerrolle (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID        NOT NULL,
    messstelle_id         UUID        NOT NULL,
    rolle                 TEXT,
    -- Die Zählpunktbezeichnung (Messlokations-ID, 33 Zeichen: „DE“ + 31).
    -- NULL = noch nicht bekannt. Nichts wird umgewandelt.
    zaehlpunkt            TEXT,
    messstellenbetreiber  TEXT,
    eichstatus            TEXT,
    eichfrist_bis         DATE,
    -- Woher die maßgeblichen Werte kommen: vom Messstellenbetreiber (mess- und
    -- eichrechtskonform, Tenor S. 28) oder vom Gerät der Box.
    wertequelle           TEXT,
    gueltig_ab            DATE        NOT NULL,
    aufgehoben_am         TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            TEXT,
    CONSTRAINT messstelle_zaehlerrolle_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_zaehlerrolle_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    -- Das geschlossene Vokabular von ZaehlerrolleRegeln.ROLLEN.
    CONSTRAINT messstelle_zaehlerrolle_rolle_chk CHECK (rolle IS NULL OR rolle IN ('Z1', 'Z2', 'Z3')),
    CONSTRAINT messstelle_zaehlerrolle_zaehlpunkt_chk
        CHECK (zaehlpunkt IS NULL OR zaehlpunkt ~ '^DE[0-9A-Z]{31}$'),
    CONSTRAINT messstelle_zaehlerrolle_msb_chk CHECK (messstellenbetreiber IS NULL
        OR (btrim(messstellenbetreiber) <> '' AND char_length(messstellenbetreiber) <= 200)),
    CONSTRAINT messstelle_zaehlerrolle_eichstatus_chk
        CHECK (eichstatus IS NULL OR eichstatus IN ('eichrechtskonform', 'nicht_eichrechtskonform')),
    CONSTRAINT messstelle_zaehlerrolle_wertequelle_chk
        CHECK (wertequelle IS NULL OR wertequelle IN ('messstellenbetreiber', 'geraet')),
    -- Eine Rolle nennt immer ihre Wertequelle; „keine Rolle“ trägt nichts.
    CONSTRAINT messstelle_zaehlerrolle_angaben_chk CHECK (
        (rolle IS NOT NULL AND wertequelle IS NOT NULL)
        OR (rolle IS NULL AND zaehlpunkt IS NULL AND messstellenbetreiber IS NULL
            AND eichstatus IS NULL AND eichfrist_bis IS NULL AND wertequelle IS NULL))
);

-- Je Messstelle und Tag höchstens EINE wirksame Fassung.
CREATE UNIQUE INDEX IF NOT EXISTS messstelle_zaehlerrolle_ein_tag
    ON messstelle_zaehlerrolle (messstelle_id, gueltig_ab) WHERE aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_messstelle_zaehlerrolle_tenant
    ON messstelle_zaehlerrolle (tenant_id, messstelle_id, gueltig_ab);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE messstelle_zaehlerrolle ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_zaehlerrolle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_zaehlerrolle_tenant_isolation ON messstelle_zaehlerrolle;
CREATE POLICY messstelle_zaehlerrolle_tenant_isolation ON messstelle_zaehlerrolle
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Lesen, anhängen, aufheben; nur das administrative Offboarding löscht.
REVOKE ALL ON messstelle_zaehlerrolle FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON messstelle_zaehlerrolle TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON messstelle_zaehlerrolle TO ${appDbUser};
GRANT SELECT, DELETE ON messstelle_zaehlerrolle TO ${adminDbUser};

COMMENT ON TABLE messstelle_zaehlerrolle IS
    'MiSpeL MP-6: Zählerrolle Z1/Z2/Z3 nach Anlage 1 je Messstelle, als Fassungen ab einem Tag.';
