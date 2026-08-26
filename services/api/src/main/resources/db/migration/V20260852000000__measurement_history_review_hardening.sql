-- Slice 9 review hardening: catalog reads must never scan the 90-day raw
-- hypertable to discover whether a point was seen or to find its latest value.
-- The writer maintains one small row per historical site/device/point.
CREATE TABLE device_measurement_point_state (
    tenant_id       UUID NOT NULL,
    site_id         UUID NOT NULL,
    device_id       UUID NOT NULL,
    point_key       TEXT NOT NULL,
    first_read_at   TIMESTAMPTZ NOT NULL,
    last_read_at    TIMESTAMPTZ NOT NULL,
    edge_sequence   BIGINT NOT NULL,
    raw_numeric     NUMERIC,
    raw_text        TEXT,
    decoded_numeric NUMERIC,
    decoded_text    TEXT,
    quality         TEXT NOT NULL,
    gap             BOOLEAN NOT NULL DEFAULT FALSE,
    dropped_samples BIGINT NOT NULL DEFAULT 0,
    catalog_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, site_id, device_id, point_key),
    CONSTRAINT device_measurement_point_state_device_tenant_fk
        FOREIGN KEY (device_id, tenant_id)
        REFERENCES device (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT device_measurement_point_state_site_tenant_fk
        FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT device_measurement_point_state_raw_ck CHECK (
        (raw_numeric IS NOT NULL)::int + (raw_text IS NOT NULL)::int = 1)
);

CREATE INDEX idx_device_measurement_point_state_catalog
    ON device_measurement_point_state (tenant_id, site_id, device_id, last_read_at DESC);

GRANT SELECT, INSERT, UPDATE ON device_measurement_point_state TO ${appDbUser};
ALTER TABLE device_measurement_point_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_point_state FORCE ROW LEVEL SECURITY;
CREATE POLICY device_measurement_point_state_isolation ON device_measurement_point_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE device_measurement_point_state IS
  'Writer-maintained bounded latest-state index for catalog availability; historical samples and rollups remain authoritative for charts.';
