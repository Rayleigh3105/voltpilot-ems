-- Independent-review hardening for the additive measurement pipeline.
-- The preceding measurement schema is V20260848000000 in the agreed PR 510 merge sequence.

-- JSON integers/decimals must survive verbatim numeric conversion (not IEEE-754).
ALTER TABLE device_measurement_sample
    ALTER COLUMN raw_numeric TYPE NUMERIC USING raw_numeric::numeric,
    ALTER COLUMN decoded_numeric TYPE NUMERIC USING decoded_numeric::numeric;
ALTER TABLE device_measurement_event
    ALTER COLUMN previous_numeric TYPE NUMERIC USING previous_numeric::numeric,
    ALTER COLUMN value_numeric TYPE NUMERIC USING value_numeric::numeric;
ALTER TABLE device_measurement_rollup_5m
    ALTER COLUMN first_numeric TYPE NUMERIC USING first_numeric::numeric,
    ALTER COLUMN last_numeric TYPE NUMERIC USING last_numeric::numeric,
    ALTER COLUMN min_numeric TYPE NUMERIC USING min_numeric::numeric,
    ALTER COLUMN max_numeric TYPE NUMERIC USING max_numeric::numeric,
    ALTER COLUMN avg_numeric TYPE NUMERIC USING avg_numeric::numeric,
    ALTER COLUMN positive_delta TYPE NUMERIC USING positive_delta::numeric;
ALTER TABLE device_measurement_rollup_15m
    ALTER COLUMN first_numeric TYPE NUMERIC USING first_numeric::numeric,
    ALTER COLUMN last_numeric TYPE NUMERIC USING last_numeric::numeric,
    ALTER COLUMN min_numeric TYPE NUMERIC USING min_numeric::numeric,
    ALTER COLUMN max_numeric TYPE NUMERIC USING max_numeric::numeric,
    ALTER COLUMN avg_numeric TYPE NUMERIC USING avg_numeric::numeric,
    ALTER COLUMN positive_delta TYPE NUMERIC USING positive_delta::numeric;

-- Replays remain eligible throughout raw retention, and non-good input never
-- contaminates long-term facts. Filtering precedes lag(), so resets/deltas are
-- calculated between accepted samples only.
CREATE OR REPLACE PROCEDURE refresh_device_measurement_rollup(
    target_table REGCLASS, bucket_width INTERVAL, since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($q$
    INSERT INTO %s
    WITH ordered AS (
      SELECT *, lag(COALESCE(decoded_numeric, raw_numeric)) OVER
        (PARTITION BY device_id, point_key ORDER BY time, edge_sequence) AS prev_numeric,
        lag(COALESCE(decoded_text, raw_text, decoded_numeric::text, raw_numeric::text)) OVER
        (PARTITION BY device_id, point_key ORDER BY time, edge_sequence) AS prev_value
      FROM device_measurement_sample
      WHERE time >= time_bucket($1, $2) AND quality = 'good'
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
                                          INTERVAL '5 minutes', now()-INTERVAL '90 days');
  CALL refresh_device_measurement_rollup('device_measurement_rollup_15m',
                                          INTERVAL '15 minutes', now()-INTERVAL '90 days');
END $$;
