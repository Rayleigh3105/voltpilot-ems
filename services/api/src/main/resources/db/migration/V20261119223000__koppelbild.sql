-- PFC200 Stufe 4 „Wünschen“ (docs/contracts/v2/koppelbild.md §15): die Box schreibt Wünsche in das Koppelbild einer
-- Anlagensteuerung, die SPS entscheidet und quittiert. Die Cloud hält dafür zweierlei:
--
--   * koppelbild_stand     der jüngste Herzschlag-Block `koppel` je Box und Steuerung (Lage, Kopf, Angebot, Wunsch,
--                          Quittung je Stellplatz) - reine Anzeige, nie Soll-Stand; ersetzt mit jedem Herzschlag, der
--                          den Block trägt.
--   * koppelbild_freigabe  je Anlagensteuerung und Stellplatz der Beleg des Schalt-Tests und die Freigabe, beide an
--                          die Form des Angebots gebunden (Art, Ziel, Nummer, Band). Ändert das Anlagenprogramm die
--                          Form, fällt die Freigabe (widerrufen_grund 'angebot_geaendert'). Je Steuerung höchstens ein
--                          freigegebener Stellplatz je Kommando des Schiedsrichters (Teilindex).
--
-- Rein additiv: zwei neue, leere Tabellen. Mandantenzaun (RLS + FORCE) und Standortzaun wie erzeuger_vorgabe_lauf;
-- beide gehen mit Anlage, Gerät, Box und Kundenbereich (Fremdschlüssel ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS koppelbild_stand (
    device_id     UUID        NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    -- Die Komponente der Anlagensteuerung (measurement_point, entity_type 'anlagensteuerung'), Feld `steuerung`.
    entity_id     UUID        NOT NULL,
    tenant_id     UUID        NOT NULL,
    -- Die Anlage der Steuerung (nicht die der Box: eine Box darf eine Quelle einer anderen Anlage lesen).
    site_id       UUID        NOT NULL,
    -- Der bereinigte Eintrag (Koppelbild.json): nur bekannte Felder, ein fehlender Wert fehlt.
    stand         JSONB       NOT NULL,
    empfangen_at  TIMESTAMPTZ NOT NULL,
    CONSTRAINT koppelbild_stand_pkey PRIMARY KEY (device_id, entity_id),
    CONSTRAINT koppelbild_stand_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    CONSTRAINT koppelbild_stand_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT koppelbild_stand_chk CHECK (jsonb_typeof(stand) = 'object')
);

-- Der jüngste Stand einer Steuerung (Route, Überwachung, Wegfall der Freigabe).
CREATE INDEX IF NOT EXISTS idx_koppelbild_stand_entity ON koppelbild_stand (tenant_id, entity_id, empfangen_at DESC);

CREATE TABLE IF NOT EXISTS koppelbild_freigabe (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    -- Die Anlagensteuerung (geraet, Geräteart controller).
    geraet_id            UUID        NOT NULL,
    platz                INTEGER     NOT NULL,
    -- Die Form des Angebots, an der Beleg und Freigabe hängen (ganze Einheiten des Bilds).
    art                  TEXT        NOT NULL,
    ziel                 TEXT        NOT NULL,
    nr                   INTEGER     NOT NULL,
    band_min             BIGINT      NOT NULL,
    band_max             BIGINT      NOT NULL,
    kommando             TEXT        NOT NULL,
    -- Der letzte Versuch eines Schalt-Tests, bestanden oder nicht (Anzeige).
    versuch_at           TIMESTAMPTZ,
    versuch_urteil       TEXT,
    versuch_ok           BOOLEAN,
    -- Der Beleg: nur ein bestandener Test (Urteil angenommen, begrenzt oder ueberstimmt zu genau seiner Folge).
    test_wert            BIGINT,
    test_urteil          TEXT,
    test_wirksam         BIGINT,
    test_folge           INTEGER,
    test_at              TIMESTAMPTZ,
    test_von             TEXT,
    -- Die Freigabe: bestandener Test für genau diese Form UND bestätigte Wirkung an der Anlage.
    freigegeben_at       TIMESTAMPTZ,
    freigegeben_von      TEXT,
    physisch_bestaetigt  BOOLEAN     NOT NULL DEFAULT false,
    evidenz              TEXT,
    widerrufen_at        TIMESTAMPTZ,
    widerrufen_von       TEXT,
    widerrufen_grund     TEXT,
    aktualisiert_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT koppelbild_freigabe_platz_uq UNIQUE (geraet_id, platz),
    CONSTRAINT koppelbild_freigabe_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    CONSTRAINT koppelbild_freigabe_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT koppelbild_freigabe_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT koppelbild_freigabe_wort_chk CHECK (
        platz BETWEEN 1 AND 8
        AND art IN ('limit_w', 'limit_pct', 'setpoint_w', 'on_off', 'mode', 'setpoint_c')
        AND ziel IN ('erzeugung_gesamt', 'erzeugungseinheit', 'speicher', 'verbraucher', 'netzbezug', 'einspeisung',
                     'probe')
        AND kommando IN ('limit_kw', 'limit_pct', 'setpoint_kw', 'on_off', 'mode', 'setpoint_c')
        AND nr BETWEEN 0 AND 65535
        AND band_min <= band_max
        AND (widerrufen_grund IS NULL OR widerrufen_grund IN ('zurueckgenommen', 'angebot_geaendert'))
        AND (test_urteil IS NULL OR test_urteil IN ('angenommen', 'begrenzt', 'ueberstimmt'))),
    CONSTRAINT koppelbild_freigabe_folge_chk CHECK (
        (test_at IS NULL) = (test_urteil IS NULL)
        AND (test_at IS NULL OR test_wert IS NOT NULL)
        AND (freigegeben_at IS NULL OR (test_at IS NOT NULL AND physisch_bestaetigt))
        AND (widerrufen_at IS NULL) = (widerrufen_grund IS NULL))
);

-- Je Steuerung und Kommando höchstens ein freigegebener Stellplatz: der Schiedsrichter der Box gewährt je Gerät
-- einen Wert je Kommando.
CREATE UNIQUE INDEX IF NOT EXISTS uq_koppelbild_freigabe_kommando
    ON koppelbild_freigabe (geraet_id, kommando) WHERE freigegeben_at IS NOT NULL AND widerrufen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_koppelbild_freigabe_site ON koppelbild_freigabe (tenant_id, site_id);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['koppelbild_stand', 'koppelbild_freigabe'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON koppelbild_stand TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON koppelbild_freigabe TO ${appDbUser};
