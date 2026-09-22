-- AP-15 NW-8/I4: die vom Betreiber benannte Verbindungsunterbrechung. Der Grenz-Nachweis wird beim Lesen
-- aus der Mess-Welt gerechnet; gespeichert werden nur Zeitraum, Box und Bemerkung. Eine Zeile je Probe.
CREATE TABLE IF NOT EXISTS steuerungsverbund_steckerprobe (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    box_id      UUID        NOT NULL,
    von         TIMESTAMPTZ NOT NULL,
    bis         TIMESTAMPTZ NOT NULL,
    bemerkung   TEXT,
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_steckerprobe_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_steckerprobe_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_steckerprobe_box_fk FOREIGN KEY (box_id)
        REFERENCES device (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_steckerprobe_zeit_chk CHECK (bis > von AND bis <= von + INTERVAL '31 days'),
    CONSTRAINT steuerungsverbund_steckerprobe_bemerkung_chk CHECK (bemerkung IS NULL OR length(bemerkung) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_steckerprobe_anlage
    ON steuerungsverbund_steckerprobe (site_id, von DESC);

ALTER TABLE steuerungsverbund_steckerprobe ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_steckerprobe FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_steckerprobe_tenant_isolation ON steuerungsverbund_steckerprobe;
CREATE POLICY steuerungsverbund_steckerprobe_tenant_isolation ON steuerungsverbund_steckerprobe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON steuerungsverbund_steckerprobe FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_steckerprobe TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_steckerprobe TO ${adminDbUser};
