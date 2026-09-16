-- UEMS AP-06 IP-14: the latest edge-reported state per (box, data source).
-- The source identifier on the wire is its stable DQ-* Kennzeichen; the
-- listener resolves it to data_source.id before inserting here.

CREATE TABLE device_data_source_status (
    device_id          UUID             NOT NULL,
    data_source_id     UUID             NOT NULL,
    tenant_id          UUID             NOT NULL,
    site_id            UUID             NOT NULL,
    health             TEXT             NOT NULL,
    error_class        TEXT,
    since_at           TIMESTAMPTZ,
    read_at            TIMESTAMPTZ,
    requests_per_min   DOUBLE PRECISION,
    samples_per_min    DOUBLE PRECISION,
    reported_at        TIMESTAMPTZ      NOT NULL,
    PRIMARY KEY (device_id, data_source_id),
    CONSTRAINT device_data_source_status_source_fk
        FOREIGN KEY (data_source_id, tenant_id)
        REFERENCES data_source (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT device_data_source_status_health_chk
        CHECK (health IN ('ok', 'stale', 'never')),
    CONSTRAINT device_data_source_status_error_chk
        CHECK (error_class IS NULL OR error_class IN (
            'unreachable', 'no_answer', 'invalid_response', 'implausible',
            'fronius_api', 'timeout', 'layout_changed', 'budget')),
    CONSTRAINT device_data_source_status_shape_chk CHECK (
        (health = 'ok' AND error_class IS NULL AND since_at IS NULL)
        OR (health IN ('stale', 'never') AND since_at IS NOT NULL)),
    CONSTRAINT device_data_source_status_requests_chk CHECK (
        requests_per_min IS NULL OR
        (requests_per_min >= 0 AND requests_per_min <> 'NaN'::double precision)),
    CONSTRAINT device_data_source_status_samples_chk CHECK (
        samples_per_min IS NULL OR
        (samples_per_min >= 0 AND samples_per_min <> 'NaN'::double precision))
);

CREATE INDEX device_data_source_status_site
    ON device_data_source_status (site_id);

ALTER TABLE device_data_source_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_data_source_status FORCE ROW LEVEL SECURITY;
CREATE POLICY device_data_source_status_isolation ON device_data_source_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- This is a latest-state sink: the listener replaces one box's complete set.
GRANT SELECT, INSERT, UPDATE, DELETE ON device_data_source_status TO ${appDbUser};
