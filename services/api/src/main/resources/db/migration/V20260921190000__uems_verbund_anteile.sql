-- UEMS AP-15 IP-7: Anteils-Ableitung und Zweischritt (G4, G5, E2 = A, Y1).
--
-- Additiv, nur für Anlagen MIT Gemeinsamer Steuerung (Bestand hat keine Zeile, I6):
--   * steuerungsverbund: der Vorbehalt je Richtung als gespeicherter Wert mit wer/wann (IP-13 füllt ihn später aus
--     Messwerten) und der Zeitpunkt, an dem ein Rückspielen erkannt wurde (A18: danach ändert die Cloud nichts mehr,
--     bis neu scharfgeschaltet wird).
--   * steuerungsverbund_geraet: je Box und Richtung die Geräte mit Nennleistung und Schreibfreigabe, dazu das
--     Ungeregelte hinter ihrem Abgang (Komponente leer) — der Eingang der Ableitung; der Rückfall kommt aus IP-6.
--   * steuerungsverbund_anteile: jedes veröffentlichte Anteils-Dokument (Epoche, Revision, Schritt, GANZE Tabelle,
--     verteilbar) — nur anhängen; der Zielstand eines Übergangs wartet in derselben Zeile auf die Quittungen.
-- Neue Tabellen mit RLS + FORCE, Rechte eng. Fremdschlüssel nur auf eigene/neue Zeilen — keine Bestandszeile ändert
-- sich, kein bestehender Schlüssel wird verschärft. Idempotent (IF NOT EXISTS), damit die Reihenfolge der Ankunft
-- (out-of-order neben IP-5 V20260921180000) keine Rolle spielt.

ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS vorbehalt_einspeisung_kw NUMERIC(12, 3);
ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS vorbehalt_bezug_kw NUMERIC(12, 3);
ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS vorbehalt_von TEXT;
ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS vorbehalt_am TIMESTAMPTZ;
ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS rueckgespielt_erkannt_am TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steuerungsverbund_vorbehalt_chk') THEN
        ALTER TABLE steuerungsverbund ADD CONSTRAINT steuerungsverbund_vorbehalt_chk
            CHECK ((vorbehalt_einspeisung_kw IS NULL OR vorbehalt_einspeisung_kw >= 0)
                   AND (vorbehalt_bezug_kw IS NULL OR vorbehalt_bezug_kw >= 0)
                   AND ((vorbehalt_einspeisung_kw IS NULL AND vorbehalt_bezug_kw IS NULL)
                        = (vorbehalt_am IS NULL))
                   AND ((vorbehalt_am IS NULL) = (vorbehalt_von IS NULL))
                   AND (vorbehalt_von IS NULL OR btrim(vorbehalt_von) <> ''));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS steuerungsverbund_geraet (
    id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID          NOT NULL,
    steuerungsverbund_id UUID          NOT NULL,
    site_id              UUID          NOT NULL,
    device_id            UUID          NOT NULL,
    entity_id            UUID,
    richtung             TEXT          NOT NULL,
    nenn_kw              NUMERIC(12, 3) NOT NULL,
    schreibfreigabe      BOOLEAN       NOT NULL,
    hinweis              TEXT,
    aufgehoben_am        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by           TEXT          NOT NULL,
    CONSTRAINT steuerungsverbund_geraet_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_geraet_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_geraet_box_fk FOREIGN KEY (device_id, site_id, tenant_id)
        REFERENCES device (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_geraet_komponente_fk FOREIGN KEY (entity_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_geraet_richtung_chk CHECK (richtung IN ('einspeisung', 'bezug')),
    CONSTRAINT steuerungsverbund_geraet_nenn_chk CHECK (nenn_kw >= 0),
    -- Das Ungeregelte hinter dem Abgang hat keine Komponente und ist nie freigegeben (zählt mit seinem Höchstwert).
    CONSTRAINT steuerungsverbund_geraet_ungeregelt_chk CHECK (entity_id IS NOT NULL OR NOT schreibfreigabe),
    CONSTRAINT steuerungsverbund_geraet_wer_chk CHECK (btrim(created_by) <> '')
);

-- Je Komponente und Richtung höchstens eine wirksame Angabe; das Ungeregelte höchstens einmal je Box und Richtung.
CREATE UNIQUE INDEX IF NOT EXISTS uq_steuerungsverbund_geraet_komponente
    ON steuerungsverbund_geraet (tenant_id, entity_id, richtung)
    WHERE aufgehoben_am IS NULL AND entity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_steuerungsverbund_geraet_ungeregelt
    ON steuerungsverbund_geraet (tenant_id, steuerungsverbund_id, device_id, richtung)
    WHERE aufgehoben_am IS NULL AND entity_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_geraet_verbund
    ON steuerungsverbund_geraet (steuerungsverbund_id);

CREATE TABLE IF NOT EXISTS steuerungsverbund_anteile (
    id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID          NOT NULL,
    steuerungsverbund_id     UUID          NOT NULL,
    site_id                  UUID          NOT NULL,
    epoche                   BIGINT        NOT NULL,
    revision                 BIGINT        NOT NULL,
    schritt                  TEXT          NOT NULL,
    verteilbar_einspeisung_kw NUMERIC(12, 1) NOT NULL,
    verteilbar_bezug_kw      NUMERIC(12, 1) NOT NULL,
    anteile                  JSONB         NOT NULL,
    ziel                     JSONB,
    verengte_boxen           UUID[]        NOT NULL DEFAULT '{}',
    anlass                   TEXT          NOT NULL,
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by               TEXT          NOT NULL,
    CONSTRAINT steuerungsverbund_anteile_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_anteile_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_anteile_stand_uq UNIQUE (steuerungsverbund_id, epoche, revision),
    CONSTRAINT steuerungsverbund_anteile_stand_chk CHECK (epoche >= 1 AND revision >= 1),
    CONSTRAINT steuerungsverbund_anteile_schritt_chk CHECK (schritt IN ('uebergang', 'ziel')),
    -- Nur ein Übergang trägt einen noch ausstehenden Zielstand; ein Zielstand wartet auf nichts.
    CONSTRAINT steuerungsverbund_anteile_ziel_chk CHECK (schritt = 'uebergang' OR ziel IS NULL),
    CONSTRAINT steuerungsverbund_anteile_verteilbar_chk
        CHECK (verteilbar_einspeisung_kw >= 0 AND verteilbar_bezug_kw >= 0),
    CONSTRAINT steuerungsverbund_anteile_anlass_chk
        CHECK (anlass IN ('scharfschalten', 'aendern', 'zielstand')),
    CONSTRAINT steuerungsverbund_anteile_wer_chk CHECK (btrim(created_by) <> '')
);

CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_anteile_verbund
    ON steuerungsverbund_anteile (steuerungsverbund_id, epoche DESC, revision DESC);

ALTER TABLE steuerungsverbund_geraet ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_geraet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_geraet_tenant_isolation ON steuerungsverbund_geraet;
CREATE POLICY steuerungsverbund_geraet_tenant_isolation ON steuerungsverbund_geraet
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerungsverbund_anteile ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_anteile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_anteile_tenant_isolation ON steuerungsverbund_anteile;
CREATE POLICY steuerungsverbund_anteile_tenant_isolation ON steuerungsverbund_anteile
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: ALTER DEFAULT PRIVILEGES gibt alles — hier wird alles genommen und eng neu gegeben. Geräte-Angaben werden
-- aufgehoben statt geändert, Dokumente nur angehängt (nie umgeschrieben: die Box hat sie quittiert). Das Offboarding
-- (TenantRepository.offboard) räumt beide vor dem Verbund ab.
REVOKE ALL ON steuerungsverbund_geraet, steuerungsverbund_anteile FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_geraet TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON steuerungsverbund_geraet TO ${appDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_anteile TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_geraet, steuerungsverbund_anteile TO ${adminDbUser};
GRANT UPDATE (vorbehalt_einspeisung_kw, vorbehalt_bezug_kw, vorbehalt_von, vorbehalt_am, rueckgespielt_erkannt_am)
    ON steuerungsverbund TO ${appDbUser};

COMMENT ON TABLE steuerungsverbund_geraet IS
    'UEMS AP-15 IP-7: Geraete je Box und Richtung (Nennleistung, Schreibfreigabe) und das Ungeregelte hinter dem Abgang (entity_id leer) - Eingang der Anteils-Ableitung; aufheben statt aendern.';
COMMENT ON TABLE steuerungsverbund_anteile IS
    'UEMS AP-15 IP-7: veroeffentlichte Anteils-Dokumente (Epoche, Revision, Schritt, ganze Tabelle, verteilbar); nur anhaengen, ein Uebergang traegt den ausstehenden Zielstand (G5, Y1).';
