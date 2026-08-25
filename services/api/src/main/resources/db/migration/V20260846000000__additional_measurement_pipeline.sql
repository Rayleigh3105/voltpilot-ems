-- =============================================================================
-- Slices 6-8: additional device measurements, isolated from frozen telemetry.
-- =============================================================================

-- Retained status redelivery is normal after every edge/API reconnect. The
-- immutable audit log records an acknowledgement once per changed point and
-- desired revision, while repeated QoS1 deliveries remain idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_selection_edge_ack
    ON device_measurement_selection_event
       (device_id, point_key, desired_revision, event_kind)
    WHERE event_kind = 'edge_ack';

CREATE TABLE IF NOT EXISTS measurement_catalog_point_metadata (
    catalog_version       TEXT NOT NULL,
    point_key             TEXT NOT NULL,
    aggregation_kind      TEXT NOT NULL CHECK (aggregation_kind IN
                              ('gauge','counter','state','event','bitfield','text','none')),
    long_term_cadence_s   INTEGER CHECK (long_term_cadence_s IN (300, 900)),
    PRIMARY KEY (catalog_version, point_key)
);

-- Generated catalog facts are global/read-only, like day-ahead prices. The
-- following migration is generated from the canonical catalog artifact.
REVOKE ALL ON measurement_catalog_point_metadata FROM ${appDbUser};
GRANT SELECT ON measurement_catalog_point_metadata TO ${appDbUser};

CREATE TABLE IF NOT EXISTS device_measurement_sample (
    time                  TIMESTAMPTZ NOT NULL,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id             UUID NOT NULL,
    site_id               UUID NOT NULL,
    device_id             UUID NOT NULL,
    point_key             TEXT NOT NULL,
    raw_numeric           DOUBLE PRECISION,
    raw_text              TEXT,
    decoded_numeric       DOUBLE PRECISION,
    decoded_text          TEXT,
    quality               TEXT NOT NULL CHECK (quality IN
                              ('good','uncertain','invalid','stale','device_error')),
    catalog_version       TEXT NOT NULL,
    edge_sequence         BIGINT NOT NULL CHECK (edge_sequence >= 0),
    aggregation_kind      TEXT NOT NULL CHECK (aggregation_kind IN
                              ('gauge','counter','state','event','bitfield','text','none')),
    long_term_cadence_s   INTEGER CHECK (long_term_cadence_s IN (300, 900)),
    gap                   BOOLEAN NOT NULL DEFAULT FALSE,
    dropped_samples       BIGINT NOT NULL DEFAULT 0 CHECK (dropped_samples >= 0),
    signed_data           TEXT,
    signed_data_format    TEXT,
    CONSTRAINT device_measurement_sample_value_ck CHECK (
        (raw_numeric IS NOT NULL)::int + (raw_text IS NOT NULL)::int = 1),
    CONSTRAINT device_measurement_sample_device_fk
        FOREIGN KEY (device_id, tenant_id, site_id)
        REFERENCES device (id, tenant_id, site_id) ON DELETE CASCADE
);

SELECT create_hypertable('device_measurement_sample', 'time', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '1 day');
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_sample_idempotency
    ON device_measurement_sample (device_id, point_key, time, edge_sequence);
CREATE INDEX IF NOT EXISTS idx_device_measurement_sample_read
    ON device_measurement_sample (device_id, point_key, time DESC);

CREATE TABLE IF NOT EXISTS device_measurement_event (
    occurred_at           TIMESTAMPTZ NOT NULL,
    tenant_id             UUID NOT NULL,
    site_id               UUID NOT NULL,
    device_id             UUID NOT NULL,
    point_key             TEXT NOT NULL,
    event_kind            TEXT NOT NULL CHECK (event_kind IN
                              ('state_change','error_change','bitfield_change','text_change',
                               'counter_reset','data_gap')),
    previous_numeric      DOUBLE PRECISION,
    value_numeric         DOUBLE PRECISION,
    previous_text         TEXT,
    value_text            TEXT,
    catalog_version       TEXT NOT NULL,
    edge_sequence         BIGINT NOT NULL,
    details               JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT device_measurement_event_device_fk
        FOREIGN KEY (device_id, tenant_id, site_id)
        REFERENCES device (id, tenant_id, site_id) ON DELETE CASCADE
);
SELECT create_hypertable('device_measurement_event', 'occurred_at', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '7 days');
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_event_idempotency
    ON device_measurement_event (device_id, point_key, occurred_at, edge_sequence, event_kind);

-- TimescaleDB 2.17 refuses continuous aggregates over FORCE-RLS hypertables.
-- These two rollup hypertables are therefore continuously maintained by a
-- five-minute Timescale background job, following telemetry_v2's established
-- RLS-safe pattern. They are the durable long-term 5/15-minute tracks.
CREATE TABLE IF NOT EXISTS device_measurement_rollup_5m (
    bucket TIMESTAMPTZ NOT NULL, tenant_id UUID NOT NULL, site_id UUID NOT NULL,
    device_id UUID NOT NULL, point_key TEXT NOT NULL, aggregation_kind TEXT NOT NULL,
    first_numeric DOUBLE PRECISION, last_numeric DOUBLE PRECISION,
    min_numeric DOUBLE PRECISION, max_numeric DOUBLE PRECISION, avg_numeric DOUBLE PRECISION,
    positive_delta DOUBLE PRECISION, counter_reset_count BIGINT NOT NULL DEFAULT 0,
    first_text TEXT, last_text TEXT, change_count BIGINT NOT NULL DEFAULT 0,
    sample_count BIGINT NOT NULL, catalog_version TEXT NOT NULL
);
SELECT create_hypertable('device_measurement_rollup_5m', 'bucket', if_not_exists => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_rollup_5m
    ON device_measurement_rollup_5m (device_id, point_key, bucket);

CREATE TABLE IF NOT EXISTS device_measurement_rollup_15m
    (LIKE device_measurement_rollup_5m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
SELECT create_hypertable('device_measurement_rollup_15m', 'bucket', if_not_exists => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_rollup_15m
    ON device_measurement_rollup_15m (device_id, point_key, bucket);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_measurement_sample','device_measurement_event',
                            'device_measurement_rollup_5m','device_measurement_rollup_15m'] LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO ${appDbUser}', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I USING '
      || '(tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_isolation', t);
  END LOOP;
END $$;

-- Writers do not mutate rollups; only the Timescale-owned refresh job does.
REVOKE INSERT ON device_measurement_rollup_5m, device_measurement_rollup_15m
    FROM ${appDbUser};

CREATE OR REPLACE PROCEDURE refresh_device_measurement_rollup(
    target_table REGCLASS, bucket_width INTERVAL, since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($q$
    INSERT INTO %s
    WITH ordered AS (
      SELECT *, lag(COALESCE(decoded_numeric, raw_numeric)) OVER
        (PARTITION BY device_id, point_key ORDER BY time, edge_sequence)
        AS prev_numeric,
        lag(COALESCE(decoded_text, raw_text, decoded_numeric::text, raw_numeric::text)) OVER
        (PARTITION BY device_id, point_key ORDER BY time, edge_sequence)
        AS prev_value
      FROM device_measurement_sample WHERE time >= time_bucket($1, $2)
    )
    SELECT time_bucket($1, time), tenant_id, site_id, device_id, point_key,
      aggregation_kind,
      CASE WHEN aggregation_kind IN ('gauge','counter') THEN
        first(COALESCE(decoded_numeric,raw_numeric),time) END,
      CASE WHEN aggregation_kind IN ('gauge','counter') THEN
        last(COALESCE(decoded_numeric,raw_numeric),time) END,
      CASE WHEN aggregation_kind='gauge' THEN min(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='gauge' THEN max(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='gauge' THEN avg(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='counter' THEN
        sum(CASE WHEN prev_numeric IS NULL THEN 0
                 WHEN COALESCE(decoded_numeric,raw_numeric) >= prev_numeric
                   THEN COALESCE(decoded_numeric,raw_numeric)-prev_numeric ELSE 0 END) END,
      count(*) FILTER (WHERE aggregation_kind='counter' AND prev_numeric IS NOT NULL
                    AND COALESCE(decoded_numeric,raw_numeric) < prev_numeric),
      CASE WHEN aggregation_kind IN ('state','event','bitfield','text') THEN
        first(COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text),time) END,
      CASE WHEN aggregation_kind IN ('state','event','bitfield','text') THEN
        last(COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text),time) END,
      count(*) FILTER (WHERE aggregation_kind IN ('state','event','bitfield','text')
                               AND prev_value IS DISTINCT FROM
                         COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text)),
      count(*), last(catalog_version,time)
    FROM ordered WHERE long_term_cadence_s = EXTRACT(EPOCH FROM $1)::int
    GROUP BY 1,2,3,4,5,6
    ON CONFLICT (device_id,point_key,bucket) DO UPDATE SET
      tenant_id=EXCLUDED.tenant_id, site_id=EXCLUDED.site_id,
      aggregation_kind=EXCLUDED.aggregation_kind,
      first_numeric=EXCLUDED.first_numeric,last_numeric=EXCLUDED.last_numeric,
      min_numeric=EXCLUDED.min_numeric,max_numeric=EXCLUDED.max_numeric,
      avg_numeric=EXCLUDED.avg_numeric,positive_delta=EXCLUDED.positive_delta,
      counter_reset_count=EXCLUDED.counter_reset_count,first_text=EXCLUDED.first_text,
      last_text=EXCLUDED.last_text,change_count=EXCLUDED.change_count,
      sample_count=EXCLUDED.sample_count,catalog_version=EXCLUDED.catalog_version
  $q$, target_table) USING bucket_width, since;
END $$;

CREATE OR REPLACE PROCEDURE device_measurement_rollup_job(job_id INT, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
  CALL refresh_device_measurement_rollup('device_measurement_rollup_5m',
                                          INTERVAL '5 minutes', now()-INTERVAL '2 days');
  CALL refresh_device_measurement_rollup('device_measurement_rollup_15m',
                                          INTERVAL '15 minutes', now()-INTERVAL '2 days');
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                 WHERE proc_name='device_measurement_rollup_job') THEN
    PERFORM add_job('device_measurement_rollup_job', INTERVAL '5 minutes');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                 WHERE proc_name='policy_retention'
                   AND hypertable_name='device_measurement_sample') THEN
    PERFORM add_retention_policy('device_measurement_sample', INTERVAL '90 days');
  END IF;
END $$;

COMMENT ON TABLE device_measurement_sample IS
  'Additional measurement raw samples only; never reconstructed from decoded values. 90-day retention.';
COMMENT ON TABLE device_measurement_event IS
  'Durable on-change state/error/bitfield/text, counter-reset and explicit data-gap events.';
