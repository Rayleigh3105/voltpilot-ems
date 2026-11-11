-- UEMS EZ-7 „Vorgaben-Läufer und Protokoll-Daten“ (Konzept vp-erzeuger-wago-konzept §4.2, §4.6; Entscheide
-- EW-8 A, EW-12 A): aus den Rohwerten des Erzeuger-Registerbilds leitet der VorgabenLaeufer in der Cloud ab, wer
-- wann wie lange die Anlage begrenzt oder gesteuert hat. Grundlage für das Protokoll im Verlauf (EZ-9) und die
-- Kachel „Wer hat heute geregelt?“.
--
-- Rein additiv, drei neue Tabellen:
--   * erzeuger_vorgabe         je Vorgabe ein Zeitraum (Ende leer = läuft) mit Urheber, Art, Einheit (leer = ganze
--                              Anlage), kleinster Vorgabe, Ist und verfügbarer Leistung im Mittel, geschätzt nicht
--                              erzeugter Energie samt Methode, Kanal, Bindung, „unvollständig“ und Zählerständen.
--   * erzeuger_vorgabe_luecke  eine Datenlücke, über die n_zaehler oder d_zaehler mehr Vorgaben zählt, als gesehen
--                              wurden: „n weitere Wechsel während einer Datenlücke“ — ohne erfundene Zeiten.
--   * erzeuger_vorgabe_lauf    der Stand des Läufers je Anlagensteuerung (verarbeitet bis, offene Vorgaben) —
--                              so setzt er nach einem Neustart genau dort fort (idempotent).
--
-- Aufbewahrung wie die Messreihen (zehn Jahre, E7): beide Protokoll-Tabellen sind Hypertables mit einer
-- Aufbewahrungsregel, ohne Kompression (RLS + FORCE). Kein Bestand ändert sich.

-- -----------------------------------------------------------------------------
-- erzeuger_vorgabe — die Vorgaben
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeuger_vorgabe (
    id                   UUID        NOT NULL,
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    -- Die Anlagensteuerung (Gerät, Geräteart controller); te_nr leer = die ganze Anlage.
    geraet_id            UUID        NOT NULL,
    te_nr                INTEGER,
    urheber              TEXT        NOT NULL,
    art                  TEXT        NOT NULL,
    beginn               TIMESTAMPTZ NOT NULL,
    -- Genau = aus „seit“ der Steuerung datiert; sonst die Lesung, in der sie zuerst galt (spätestens).
    beginn_genau         BOOLEAN     NOT NULL,
    -- NULL = läuft.
    ende                 TIMESTAMPTZ,
    ende_genau           BOOLEAN     NOT NULL DEFAULT false,
    -- Die letzte Lesung, in der sie galt (bei einer laufenden: bis wohin sie belegt ist).
    gesehen_bis          TIMESTAMPTZ NOT NULL,
    -- Kleinste Vorgabe in % (der installierten bzw. Nennleistung) und in W; NULL = nicht bekannt, nie 0.
    vorgabe_prozent      NUMERIC(7, 2),
    vorgabe_w            NUMERIC(14, 0),
    ist_mittel_w         NUMERIC(14, 0),
    verfuegbar_mittel_w  NUMERIC(14, 0),
    -- ∫ max(0, verfügbar − Ist) solange der Urheber bindet; NULL = ohne Grundlage (nie 0 statt nichts).
    energie_kwh          NUMERIC(14, 3),
    methode              TEXT,
    -- Je Tag (Europe/Berlin) die geschätzte Energie in kWh: {"2026-10-21": 12.345}.
    energie_je_tag       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Euro-Schätzung zu den Preisen der Anlage (EW-8 A); NULL ohne Preisgrundlage.
    wert_eur             NUMERIC(14, 2),
    kanal                TEXT,
    bindung              TEXT,
    unvollstaendig       BOOLEAN     NOT NULL DEFAULT false,
    neustart             BOOLEAN     NOT NULL DEFAULT false,
    zaehler_beginn       INTEGER,
    zaehler_ende         INTEGER,
    gruende              TEXT[]      NOT NULL DEFAULT '{}',
    roh_beginn           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    roh_ende             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    aktualisiert_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Der Zeitraum ist die Partition: der Schlüssel trägt ihn (Hypertable).
    CONSTRAINT erzeuger_vorgabe_pkey PRIMARY KEY (id, beginn),
    CONSTRAINT erzeuger_vorgabe_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeuger_vorgabe_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_wort_chk CHECK (
        urheber IN ('netzbetreiber', 'direktvermarkter', 'anlage', 'hand', 'ersatzwert', 'schutz')
        AND art IN ('p_begrenzung', 'abschaltung', 'q_vorgabe', 'dv_aktivierung', 'dv_stopp', 'nicht_bereit',
                    'automatik', 'ersatzwert')
        AND (methode IS NULL OR methode IN ('pv_prognose', 'nennleistung_bereite_motoren', 'dv_sollwert_davor'))
        AND (bindung IS NULL OR bindung IN ('bindend', 'nicht_bindend'))
        AND (kanal IS NULL OR kanal IN ('keiner', 'feste_grenze', 'stufen', 'fernwirktechnik', 'relais_ma',
                                        'modbus'))),
    CONSTRAINT erzeuger_vorgabe_werte_chk CHECK (
        (te_nr IS NULL OR te_nr BETWEEN 1 AND 10)
        AND (ende IS NULL OR ende >= beginn)
        AND gesehen_bis >= beginn
        AND (energie_kwh IS NULL OR (energie_kwh >= 0 AND methode IS NOT NULL))
        AND (wert_eur IS NULL OR energie_kwh IS NOT NULL)
        AND jsonb_typeof(energie_je_tag) = 'object'
        AND jsonb_typeof(roh_beginn) = 'object'
        AND jsonb_typeof(roh_ende) = 'object'
        AND (zaehler_beginn IS NULL OR zaehler_beginn BETWEEN 0 AND 65535)
        AND (zaehler_ende IS NULL OR zaehler_ende BETWEEN 0 AND 65535))
);

-- Chunk ein Jahr: wenige Zeilen je Anlage und Tag. Ohne Vorgabe-Indizes (sie stünden ohne tenant_id vorn).
SELECT create_hypertable('erzeuger_vorgabe', 'beginn', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '365 days',
                         create_default_indexes => FALSE);

CREATE INDEX IF NOT EXISTS idx_erzeuger_vorgabe_site_beginn
    ON erzeuger_vorgabe (tenant_id, site_id, beginn DESC);
-- Die laufenden je Anlage (Kachel „heute“, Cockpit) und das Detail über die Kennung.
CREATE INDEX IF NOT EXISTS idx_erzeuger_vorgabe_laeuft
    ON erzeuger_vorgabe (tenant_id, site_id) WHERE ende IS NULL;
CREATE INDEX IF NOT EXISTS idx_erzeuger_vorgabe_id ON erzeuger_vorgabe (id);

-- -----------------------------------------------------------------------------
-- erzeuger_vorgabe_luecke — weitere Wechsel während einer Datenlücke
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeuger_vorgabe_luecke (
    id               UUID        NOT NULL,
    tenant_id        UUID        NOT NULL,
    site_id          UUID        NOT NULL,
    geraet_id        UUID        NOT NULL,
    -- Wessen Zähler: n_zaehler (Netzbetreiber) oder d_zaehler (Direktvermarkter).
    urheber          TEXT        NOT NULL,
    -- Die letzte Lesung vor und die erste nach der Lücke.
    beginn           TIMESTAMPTZ NOT NULL,
    ende             TIMESTAMPTZ NOT NULL,
    -- (nachher − vorher) mod 65536 minus die gesehenen Wechsel; NULL = unbekannt (Neustart der Steuerung).
    weitere_wechsel  INTEGER,
    neustart         BOOLEAN     NOT NULL DEFAULT false,
    zaehler_vorher   INTEGER,
    zaehler_nachher  INTEGER,
    erkannt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT erzeuger_vorgabe_luecke_pkey PRIMARY KEY (id, beginn),
    CONSTRAINT erzeuger_vorgabe_luecke_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeuger_vorgabe_luecke_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_luecke_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_luecke_chk CHECK (
        urheber IN ('netzbetreiber', 'direktvermarkter')
        AND ende >= beginn
        AND (weitere_wechsel IS NULL OR weitere_wechsel > 0)
        AND (weitere_wechsel IS NOT NULL OR neustart)
        AND (zaehler_vorher IS NULL OR zaehler_vorher BETWEEN 0 AND 65535)
        AND (zaehler_nachher IS NULL OR zaehler_nachher BETWEEN 0 AND 65535))
);

SELECT create_hypertable('erzeuger_vorgabe_luecke', 'beginn', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '365 days',
                         create_default_indexes => FALSE);

CREATE INDEX IF NOT EXISTS idx_erzeuger_vorgabe_luecke_site_beginn
    ON erzeuger_vorgabe_luecke (tenant_id, site_id, beginn DESC);

-- -----------------------------------------------------------------------------
-- erzeuger_vorgabe_lauf — der Stand des Läufers je Anlagensteuerung
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeuger_vorgabe_lauf (
    geraet_id        UUID        PRIMARY KEY,
    tenant_id        UUID        NOT NULL,
    site_id          UUID        NOT NULL,
    -- Bis hierher (Lesezeit) sind die Werte verarbeitet; der nächste Lauf liest danach weiter.
    verarbeitet_bis  TIMESTAMPTZ NOT NULL,
    -- Fassung der Ableitung: eine neue Fassung leitet die Steuerung von vorn ab.
    fassung          INTEGER     NOT NULL,
    -- Letzte Lesung, offene Vorgaben, Zähler (VorgabenAbleitung.Zustand).
    zustand          JSONB       NOT NULL,
    aktualisiert_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT erzeuger_vorgabe_lauf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeuger_vorgabe_lauf_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_lauf_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeuger_vorgabe_lauf_chk CHECK (fassung >= 1 AND jsonb_typeof(zustand) = 'object')
);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (fremd ist 404, ohne app.tenant_id 0 Zeilen) und der Standortzaun
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['erzeuger_vorgabe', 'erzeuger_vorgabe_luecke', 'erzeuger_vorgabe_lauf'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
        EXECUTE format('CREATE POLICY %I ON %I '
            || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
            || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            t || '_tenant_isolation', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_site_scope', t);
        EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE '
            || 'USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id)) '
            || 'WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))',
            t || '_site_scope', t);
    END LOOP;
END $$;

-- Der Läufer schreibt als Laufzeitrolle unter dem Mandanten; die Routen lesen nur. Gelöscht wird nur beim
-- Neuableiten einer Steuerung (neue Fassung der Ableitung) — und mit dem Kundenbereich.
GRANT SELECT, INSERT, DELETE ON erzeuger_vorgabe TO ${appDbUser};
GRANT UPDATE (ende, ende_genau, gesehen_bis, vorgabe_prozent, vorgabe_w, ist_mittel_w, verfuegbar_mittel_w,
              energie_kwh, methode, energie_je_tag, wert_eur, kanal, bindung, unvollstaendig, neustart,
              zaehler_beginn, zaehler_ende, gruende, roh_beginn, roh_ende, aktualisiert_am)
    ON erzeuger_vorgabe TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON erzeuger_vorgabe_luecke TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON erzeuger_vorgabe_lauf TO ${appDbUser};
GRANT UPDATE (verarbeitet_bis, fassung, zustand, aktualisiert_am) ON erzeuger_vorgabe_lauf TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Aufbewahrung wie die Messreihen: zehn Jahre (E7). KEINE Kompression: RLS + FORCE.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'erzeuger_vorgabe') THEN
        PERFORM add_retention_policy('erzeuger_vorgabe', INTERVAL '3653 days');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'erzeuger_vorgabe_luecke') THEN
        PERFORM add_retention_policy('erzeuger_vorgabe_luecke', INTERVAL '3653 days');
    END IF;
END $$;
