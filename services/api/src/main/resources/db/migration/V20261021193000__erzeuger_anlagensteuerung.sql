-- UEMS EZ-6 „Cloud-Modell“ (Konzept vp-erzeuger-wago-konzept §4.2, Entscheid EW-3 A): eine Erzeugeranlage
-- (PV oder Biogas-BHKW), deren Steuerung das VoltPilot-Registerbild Erzeuger trägt, ist KEINE neue
-- Anlagenart. Die Steuerung (z. B. WAGO PFC200) ist ein Gerät mit Geräteart `controller` wie heute die
-- WAGO-Steuerung der Energiekarten; Wechselrichter und Motoren sind ihre TEILE.
--
-- Rein additiv:
--   * geraet_teil              Teilart `erzeugungseinheit` neben `energiekarte`. Identität (Gerät, te_nr)
--                              wie die Karte (Gerät, Steckplatz) aus AP-05 E4; dazu Art, Nennleistung,
--                              MaStR-SEE und der Typname, den das Bild nennt (Vorbelegung, Konzept §3.10).
--   * registerbild_fassung     das Soll des Bilds je Steuerung, zeitgültig: Basisadresse, Funktionscode,
--                              Wortfolge, Zahl der Einheiten, Anlagenart, Steuerung-Kennung, Bedeutung der
--                              Rundsteuer-Stufen, Schwelle „veraltet“. Bildart heute nur `erzeuger`.
--   * anlage_netz_vermarktung  Stammdaten je Anlage: Direktvermarkter (Freitext + Kanal) und
--                              Einspeisemanagement; dazu die Namen, die das Bild nennt. Der Netzbetreiber
--                              bleibt am Netzanschluss (netzanschluss.netzbetreiber) — eine Abweichung des
--                              Bilds meldet die api als Hinweis, sie überschreibt nichts.
--
-- Kein Bestand ändert sich: jede vorhandene Karte erfüllt die neuen Bedingungen (alle neuen Spalten NULL).
-- Nicht dieses Paket: erzeuger_vorgabe und ihr Läufer (EZ-7).

-- -----------------------------------------------------------------------------
-- geraet_teil — die Erzeugungseinheit
-- -----------------------------------------------------------------------------
ALTER TABLE geraet_teil
    ADD COLUMN IF NOT EXISTS te_nr            INTEGER,
    ADD COLUMN IF NOT EXISTS einheit_art      TEXT,
    ADD COLUMN IF NOT EXISTS nennleistung_kw  NUMERIC(10, 3),
    ADD COLUMN IF NOT EXISTS registry_unit_id TEXT,
    ADD COLUMN IF NOT EXISTS typ_bild         TEXT;

-- Weitet den CHECK aus V20260911200000 (dort nur `energiekarte`).
ALTER TABLE geraet_teil DROP CONSTRAINT IF EXISTS geraet_teil_teilart_chk;
ALTER TABLE geraet_teil ADD CONSTRAINT geraet_teil_teilart_chk
    CHECK (teilart IN ('energiekarte', 'erzeugungseinheit'));

-- Eine Karte trägt keine Einheiten-Angaben; eine Einheit hat eine Nummer 1 … 10 (höchstens 10 Einheiten
-- je Bild, EZ-1 A1) und keinen Steckplatz.
ALTER TABLE geraet_teil DROP CONSTRAINT IF EXISTS geraet_teil_einheit_chk;
ALTER TABLE geraet_teil ADD CONSTRAINT geraet_teil_einheit_chk CHECK (
    (teilart = 'energiekarte' AND te_nr IS NULL AND einheit_art IS NULL AND nennleistung_kw IS NULL
        AND registry_unit_id IS NULL AND typ_bild IS NULL)
    OR (teilart = 'erzeugungseinheit' AND te_nr BETWEEN 1 AND 10 AND steckplatz IS NULL));
-- NULL = nicht erhoben — nie geraten, nie 0.
ALTER TABLE geraet_teil DROP CONSTRAINT IF EXISTS geraet_teil_einheit_werte_chk;
ALTER TABLE geraet_teil ADD CONSTRAINT geraet_teil_einheit_werte_chk CHECK (
    (einheit_art IS NULL OR einheit_art IN ('pv_wechselrichter', 'bhkw_motor'))
    AND (nennleistung_kw IS NULL OR nennleistung_kw > 0)
    AND (registry_unit_id IS NULL OR registry_unit_id ~ '^SEE[0-9]{12}$')
    -- 32 Zeichen ISO 8859-1 im Bild (Konzept §3.10); leer heißt „keiner“ und ist dann NULL.
    AND (typ_bild IS NULL OR (char_length(typ_bild) BETWEEN 1 AND 32 AND btrim(typ_bild) <> '')));

-- Je Einheiten-Nummer und Zeitpunkt steckt höchstens EINE Einheit (wie eine Karte je Steckplatz).
ALTER TABLE geraet_teil DROP CONSTRAINT IF EXISTS geraet_teil_eine_einheit_je_nummer;
ALTER TABLE geraet_teil ADD CONSTRAINT geraet_teil_eine_einheit_je_nummer EXCLUDE USING gist (
    tenant_id WITH =,
    geraet_id WITH =,
    te_nr WITH =,
    tstzrange(eingebaut_am, ausgebaut_am, '[)') WITH &&
);

-- Umbenennen ändert nur die Anzeige (bezeichnung, typ — schon gewährt); die Angaben je Einheit pflegt der
-- Einrichter, der Typname aus dem Bild kommt aus einer Lesung.
GRANT UPDATE (einheit_art, nennleistung_kw, registry_unit_id, typ_bild) ON geraet_teil TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- registerbild_fassung — das Soll des Bilds je Steuerung
-- -----------------------------------------------------------------------------
-- Zeitgültig, halboffen auf die volle Minute wie geraet_komponente; je Steuerung und Zeitpunkt EINE Fassung.
-- Eine neue Fassung beendet die laufende (gueltig_bis) und beginnt ab demselben Zeitpunkt.
CREATE TABLE IF NOT EXISTS registerbild_fassung (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID        NOT NULL,
    site_id               UUID        NOT NULL,
    geraet_id             UUID        NOT NULL,
    -- Ein Registerbild trägt nur eine Steuerung: fest und gegen die Geräteart geprüft (wie geraet_teil).
    traeger_art           TEXT        NOT NULL DEFAULT 'controller',
    bildart               TEXT        NOT NULL,
    basisadresse          INTEGER     NOT NULL DEFAULT 0,
    funktionscode         SMALLINT    NOT NULL DEFAULT 4,
    wortfolge             TEXT        NOT NULL DEFAULT 'big',
    -- Soll des Kopfs: die Box vergleicht, das Portal fragt bei Abweichung nach (Konzept §3.9).
    te_anzahl             INTEGER     NOT NULL,
    anlagenart            TEXT        NOT NULL,
    -- NULL = noch nicht vergeben/gelesen — die Box prüft das Feld dann nicht, nie 0.
    steuerung_kennung     BIGINT,
    -- Bedeutung der Rundsteuer-Stufen: [{"stufe": 1, "prozent": 60}, …]; NULL = nicht erhoben.
    rse_stufen            JSONB,
    -- Netzpunkt-Alter (a_alter_s), ab dem der Netzpunkt als veraltet gilt.
    veraltet_netzpunkt_s  INTEGER     NOT NULL DEFAULT 30,
    gueltig_ab            TIMESTAMPTZ NOT NULL,
    gueltig_bis           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            TEXT,
    CONSTRAINT registerbild_fassung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT registerbild_fassung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT registerbild_fassung_geraet_fk FOREIGN KEY (geraet_id, tenant_id, traeger_art)
        REFERENCES geraet (id, tenant_id, geraeteart) ON DELETE CASCADE,
    CONSTRAINT registerbild_fassung_traeger_chk CHECK (traeger_art = 'controller'),
    CONSTRAINT registerbild_fassung_bildart_chk CHECK (bildart IN ('erzeuger')),
    CONSTRAINT registerbild_fassung_parameter_chk CHECK (
        funktionscode IN (3, 4) AND wortfolge IN ('big', 'little')
        AND te_anzahl BETWEEN 1 AND 10
        AND anlagenart IN ('pv', 'bhkw', 'gemischt')
        -- Das laufende Bild (38 + 10 je Einheit) passt in den Adressraum.
        AND basisadresse BETWEEN 0 AND 65535 AND basisadresse + 38 + 10 * te_anzahl <= 65536
        AND (steuerung_kennung IS NULL OR steuerung_kennung BETWEEN 0 AND 4294967295)
        AND (rse_stufen IS NULL OR jsonb_typeof(rse_stufen) = 'array')
        AND veraltet_netzpunkt_s BETWEEN 1 AND 65534),
    CONSTRAINT registerbild_fassung_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC') = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC') = gueltig_bis AT TIME ZONE 'UTC')),
    CONSTRAINT registerbild_fassung_nicht_leer CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT registerbild_fassung_eine_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        geraet_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    )
);
CREATE INDEX IF NOT EXISTS idx_registerbild_fassung_site ON registerbild_fassung (site_id);

-- -----------------------------------------------------------------------------
-- anlage_netz_vermarktung — Direktvermarkter und Einspeisemanagement je Anlage
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anlage_netz_vermarktung (
    site_id                      UUID        PRIMARY KEY,
    tenant_id                    UUID        NOT NULL,
    -- Die Anzeige; vorbelegt aus dem Bild, Umbenennen ändert nur sie. NULL = keiner erfasst.
    direktvermarkter             TEXT,
    -- Weg der Vorgaben des Direktvermarkters (Vokabular d_kanal des Bilds); NULL = nicht erhoben.
    direktvermarkter_kanal       TEXT,
    -- statisch (feste %-Grenze) · stufen (Rundsteuer) · fernwirk (Fernwirktechnik); NULL = nicht erhoben.
    einspeisemanagement          TEXT,
    einspeisemanagement_prozent  NUMERIC(5, 2),
    -- Was das Bild nennt (Konzept §3.10), unverändert gespeichert; NULL = nicht gelesen oder leer.
    netzbetreiber_bild           TEXT,
    direktvermarkter_bild        TEXT,
    namen_gelesen_am             TIMESTAMPTZ,
    revision                     INTEGER     NOT NULL DEFAULT 1,
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                   TEXT,
    CONSTRAINT anlage_netz_vermarktung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT anlage_netz_vermarktung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT anlage_netz_vermarktung_chk CHECK (
        (direktvermarkter IS NULL OR (char_length(direktvermarkter) BETWEEN 1 AND 120
                                      AND btrim(direktvermarkter) <> ''))
        AND (direktvermarkter_kanal IS NULL OR direktvermarkter_kanal IN ('keiner', 'relais_ma', 'modbus'))
        AND (einspeisemanagement IS NULL OR einspeisemanagement IN ('statisch', 'stufen', 'fernwirk'))
        -- Eine Prozentgrenze gehört nur zum statischen Einspeisemanagement.
        AND (einspeisemanagement_prozent IS NULL
             OR (einspeisemanagement = 'statisch' AND einspeisemanagement_prozent BETWEEN 0 AND 100))
        AND (netzbetreiber_bild IS NULL OR (char_length(netzbetreiber_bild) BETWEEN 1 AND 32
                                            AND btrim(netzbetreiber_bild) <> ''))
        AND (direktvermarkter_bild IS NULL OR (char_length(direktvermarkter_bild) BETWEEN 1 AND 32
                                               AND btrim(direktvermarkter_bild) <> ''))
        AND revision >= 1)
);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (fremd ist 404, ohne app.tenant_id 0 Zeilen) und der Standortzaun
-- -----------------------------------------------------------------------------
ALTER TABLE registerbild_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE registerbild_fassung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registerbild_fassung_tenant_isolation ON registerbild_fassung;
CREATE POLICY registerbild_fassung_tenant_isolation ON registerbild_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS registerbild_fassung_site_scope ON registerbild_fassung;
CREATE POLICY registerbild_fassung_site_scope ON registerbild_fassung AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

ALTER TABLE anlage_netz_vermarktung ENABLE ROW LEVEL SECURITY;
ALTER TABLE anlage_netz_vermarktung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anlage_netz_vermarktung_tenant_isolation ON anlage_netz_vermarktung;
CREATE POLICY anlage_netz_vermarktung_tenant_isolation ON anlage_netz_vermarktung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS anlage_netz_vermarktung_site_scope ON anlage_netz_vermarktung;
CREATE POLICY anlage_netz_vermarktung_site_scope ON anlage_netz_vermarktung AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

-- Kein DELETE: eine Fassung wird beendet, Stammdaten werden geändert.
GRANT SELECT, INSERT ON registerbild_fassung TO ${appDbUser};
GRANT UPDATE (gueltig_bis) ON registerbild_fassung TO ${appDbUser};
GRANT SELECT, INSERT ON anlage_netz_vermarktung TO ${appDbUser};
GRANT UPDATE (direktvermarkter, direktvermarkter_kanal, einspeisemanagement, einspeisemanagement_prozent,
              netzbetreiber_bild, direktvermarkter_bild, namen_gelesen_am, revision, updated_at, updated_by)
    ON anlage_netz_vermarktung TO ${appDbUser};
