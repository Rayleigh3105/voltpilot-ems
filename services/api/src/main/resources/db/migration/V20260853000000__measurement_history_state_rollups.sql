-- R2: state-like values are durable history facts, not merely annotations.
-- They are included in both physical rollup resolutions independent of their
-- 15-minute long-term sampling cadence. This migration replaces the procedure
-- additively; the already-reviewed V49/V50 checksums remain immutable.
CREATE OR REPLACE PROCEDURE refresh_device_measurement_rollup(
    target_table REGCLASS, bucket_width INTERVAL, since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($q$
    INSERT INTO %s
    WITH ordered AS (
      SELECT *, lag(COALESCE(decoded_numeric, raw_numeric)) OVER
        (PARTITION BY tenant_id, site_id, device_id, point_key ORDER BY time, edge_sequence) AS prev_numeric,
        lag(COALESCE(decoded_text, raw_text, decoded_numeric::text, raw_numeric::text)) OVER
        (PARTITION BY tenant_id, site_id, device_id, point_key ORDER BY time, edge_sequence) AS prev_value
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
    FROM ordered
    WHERE long_term_cadence_s = EXTRACT(EPOCH FROM $1)::int
       OR aggregation_kind IN ('state','event','bitfield','text')
    GROUP BY 1,2,3,4,5,6
    ON CONFLICT (tenant_id,site_id,device_id,point_key,bucket) DO UPDATE SET
      aggregation_kind=EXCLUDED.aggregation_kind,
      first_numeric=EXCLUDED.first_numeric,last_numeric=EXCLUDED.last_numeric,
      min_numeric=EXCLUDED.min_numeric,max_numeric=EXCLUDED.max_numeric,
      avg_numeric=EXCLUDED.avg_numeric,positive_delta=EXCLUDED.positive_delta,
      counter_reset_count=EXCLUDED.counter_reset_count,first_text=EXCLUDED.first_text,
      last_text=EXCLUDED.last_text,change_count=EXCLUDED.change_count,
      sample_count=EXCLUDED.sample_count,catalog_version=EXCLUDED.catalog_version
  $q$, target_table) USING bucket_width, since;
END $$;

COMMENT ON PROCEDURE refresh_device_measurement_rollup(REGCLASS, INTERVAL, TIMESTAMPTZ) IS
  'Quality-filtered, historical-site-local durable gauge/counter/state/event/bitfield/text rollups.';
