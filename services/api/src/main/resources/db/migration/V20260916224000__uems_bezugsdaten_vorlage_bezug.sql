-- UEMS AP-09 IP-14: die fachlichen Bezüge einer Vorlagen-Fassung (V20260916224000).
--
-- `bezugsdaten_vorlage` aus IP-12 hält die unveränderliche Fassung. Diese
-- normalisierte Tabelle macht jede darin genannte Bezugsgröße als FK sichtbar:
-- Bearbeiter dürfen nur Vorlagen ihrer Standorte sehen und ein späterer Import
-- kann die benutzte Fassung dauerhaft belegen. Bestehende Vorlagen gibt es beim
-- Ausrollen noch nicht; ein Backfill ist daher weder nötig noch zulässig.
CREATE TABLE bezugsdaten_vorlage_bezug (
    tenant_id          UUID    NOT NULL,
    vorlage_id         UUID    NOT NULL,
    vorlage_fassung    INTEGER NOT NULL,
    bezugsgroesse_id   UUID    NOT NULL,
    CONSTRAINT bezugsdaten_vorlage_bezug_pk
        PRIMARY KEY (tenant_id, vorlage_id, vorlage_fassung, bezugsgroesse_id),
    CONSTRAINT bezugsdaten_vorlage_bezug_vorlage_fk
        FOREIGN KEY (tenant_id, vorlage_id, vorlage_fassung)
        REFERENCES bezugsdaten_vorlage (tenant_id, vorlage_id, fassung) ON DELETE CASCADE,
    CONSTRAINT bezugsdaten_vorlage_bezug_bezugsgroesse_fk
        FOREIGN KEY (tenant_id, bezugsgroesse_id)
        REFERENCES bezugsgroesse (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE bezugsdaten_vorlage_bezug ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsdaten_vorlage_bezug FORCE ROW LEVEL SECURITY;
CREATE POLICY bezugsdaten_vorlage_bezug_tenant_isolation ON bezugsdaten_vorlage_bezug
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON bezugsdaten_vorlage_bezug FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsdaten_vorlage_bezug TO ${appDbUser};
GRANT INSERT (tenant_id, vorlage_id, vorlage_fassung, bezugsgroesse_id)
    ON bezugsdaten_vorlage_bezug TO ${appDbUser};
GRANT SELECT, DELETE ON bezugsdaten_vorlage_bezug TO ${adminDbUser};

COMMENT ON TABLE bezugsdaten_vorlage_bezug IS
    'AP-09 IP-14: Bezugsgrößen einer unveränderlichen Zuordnungs-Vorlagenfassung.';
