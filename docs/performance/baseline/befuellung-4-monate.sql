-- vp-anlagen-cockpit-perf: ONE private plant ("Zuhause") with ~4 months of data, faithful to the
-- documented cadences: v1 telemetry 10 s (1 box), writer fan-out 5 v2 channels/sample, optimizer
-- 96 runs/day x 192 slots (48 h horizon), forecast 4 series x 96 runs x 192 slots (retention 30 d,
-- compression 14 d), weather 8 runs/day x 48 h (retention 60 d), prices PT15M, telemetry_v2 retention 90 d.
-- Run as superuser (bypasses RLS).
\timing on
\set ten '10000000-0000-0000-0000-000000000001'
\set site '10000000-0000-0000-0000-000000000002'
\set dev '10000000-0000-0000-0000-000000000003'
\set DAYS 126

UPDATE site SET name = 'Zuhause' WHERE id = :'site';
UPDATE tenant SET segment = 'B2C' WHERE id = :'ten';
UPDATE asset SET capacity_kwh = 10, max_charge_kw = 5, max_discharge_kw = 5 WHERE site_id = :'site' AND type = 'battery';

DELETE FROM telemetry WHERE site_id = :'site';
DELETE FROM telemetry_rollup_15m WHERE site_id = :'site';
DELETE FROM telemetry_rollup_1h  WHERE site_id = :'site';
DELETE FROM telemetry_rollup_1d  WHERE site_id = :'site';
DELETE FROM telemetry_v2 WHERE site_id = :'site';
DELETE FROM telemetry_v2_rollup_15m WHERE site_id = :'site';
DELETE FROM telemetry_v2_rollup_1h WHERE site_id = :'site';
DELETE FROM telemetry_v2_rollup_1d WHERE site_id = :'site';
DELETE FROM schedule WHERE site_id = :'site';
DELETE FROM forecast WHERE site_id = :'site';
DELETE FROM weather_forecast WHERE site_id = :'site';
DELETE FROM forecast_accuracy WHERE site_id = :'site';
DELETE FROM plan_accuracy WHERE site_id = :'site';

-- 1) raw v1 telemetry: DAYS d @ 10 s, one box (received_at = time + 1 s, payload NULL since d8/E2)
INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw, received_at)
SELECT ts, :'ten', :'site', :'dev',
       round((l - p + b)::numeric, 3), round(soc::numeric, 2), round(p::numeric, 3), round(l::numeric, 3),
       ts + interval '1 second'
FROM (
  SELECT ts, h,
         greatest(0, 8.0 * sin(pi() * (h - 6.0) / 13.0)) * (CASE WHEN h BETWEEN 6 AND 19 THEN 1 ELSE 0 END) AS p,
         0.8 + 1.2 * abs(sin(pi() * h / 24.0)) + 0.3 * sin(ts_e / 300.0) AS l,
         55 + 40 * sin(2 * pi() * (h - 9) / 24.0) AS soc
  FROM (SELECT ts, extract(epoch FROM ts)::bigint AS ts_e, mod(extract(epoch FROM ts)::bigint, 86400) / 3600.0 AS h
        FROM generate_series(date_trunc('hour', now()) - (:DAYS || ' days')::interval, now() - interval '20 seconds', interval '10 seconds') ts) g
) x, LATERAL (SELECT least(greatest(p - l, -5.0), 5.0) AS b) bb
ON CONFLICT DO NOTHING;

-- 2) v1 rollups through the REAL procedure (the 15-min job's path)
CALL refresh_telemetry_rollups(now() - (:DAYS + 1 || ' days')::interval);

-- 3) telemetry_v2: the writer fan-out, 5 channels @ 10 s for the whole period, then retention like prod
CREATE TEMP TABLE _ents AS SELECT entity_type, id FROM measurement_point WHERE site_id = :'site' AND entity_type IS NOT NULL;
INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, channel, value)
SELECT ts, ts + interval '1 second', :'ten', :'site', :'dev', e.id::text, c.channel,
       round((CASE c.channel
         WHEN 'soc_pct' THEN 55 + 40 * sin(2 * pi() * (h - 9) / 24.0)
         WHEN 'pv_power_kw' THEN p
         WHEN 'battery_power_kw' THEN b
         WHEN 'power_kw' THEN CASE WHEN e.entity_type = 'grid-meter' THEN l - p + b ELSE l END
       END)::numeric, 3)
FROM (
  SELECT ts, h,
         greatest(0, 8.0 * sin(pi() * (h - 6.0) / 13.0)) * (CASE WHEN h BETWEEN 6 AND 19 THEN 1 ELSE 0 END) AS p,
         0.8 + 1.2 * abs(sin(pi() * h / 24.0)) + 0.3 * sin(ts_e / 300.0) AS l
  FROM (SELECT ts, extract(epoch FROM ts)::bigint AS ts_e, mod(extract(epoch FROM ts)::bigint, 86400) / 3600.0 AS h
        FROM generate_series(date_trunc('hour', now()) - (:DAYS || ' days')::interval, now() - interval '20 seconds', interval '10 seconds') ts) g
) x, LATERAL (SELECT least(greatest(p - l, -5.0), 5.0) AS b) bb,
(VALUES ('battery-hybrid','soc_pct'), ('battery-hybrid','pv_power_kw'), ('battery-hybrid','battery_power_kw'),
        ('grid-meter','power_kw'), ('house-load','power_kw')) c(etype, channel)
JOIN _ents e ON e.entity_type = c.etype
ON CONFLICT DO NOTHING;

CALL refresh_telemetry_v2_rollups(now() - (:DAYS + 1 || ' days')::interval);
SELECT count(*) AS v2_chunks_dropped FROM drop_chunks('telemetry_v2', older_than => INTERVAL '90 days');

-- 4) schedule: DAYS d x 96 runs/day x 192 slots (48 h horizon) - every slot exists ~192x
INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at,
                      battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh,
                      cost_eur, baseline_cost_eur, curtail_kw, wear_cost_eur,
                      terminal_value_eur_per_kwh, slot_role, stored_value_ct_kwh,
                      cover_load_from_battery, charge_from_surplus_only)
SELECT r + (i * interval '15 minutes'),
       :'ten', :'site', :'dev',
       md5(r::text)::uuid,
       r + interval '70 seconds',
       round(b::numeric, 3),
       round((l - p + b)::numeric, 3),
       round((55 + 40 * sin(2 * pi() * (h - 9) / 24.0))::numeric, 2),
       round(l::numeric, 3), round(p::numeric, 3),
       round((70 + 60 * sin(2 * pi() * (h - 14) / 24.0))::numeric, 2),
       round(((l - p + b) * 0.25 * (70 + 60 * sin(2 * pi() * (h - 14) / 24.0)) / 1000.0)::numeric, 6),
       round(((l - p) * 0.25 * (70 + 60 * sin(2 * pi() * (h - 14) / 24.0)) / 1000.0)::numeric, 6),
       NULL, 0.0012, 0.061,
       CASE WHEN p - l > 1 THEN 'pv_speichern' WHEN b < -0.5 THEN 'eigenverbrauch' ELSE 'warten' END,
       18.4, (b < -0.5), (b > 0.5)
FROM generate_series(date_trunc('hour', now()) - (:DAYS || ' days')::interval, now(), interval '15 minutes') r,
     generate_series(0, 191) i,
     LATERAL (SELECT mod(extract(epoch FROM r + (i * interval '15 minutes'))::bigint, 86400) / 3600.0 AS h) hh,
     LATERAL (SELECT greatest(0, 8.0 * sin(pi() * (h - 6.0) / 13.0)) * (CASE WHEN h BETWEEN 6 AND 19 THEN 1 ELSE 0 END) AS p,
                     0.8 + 1.2 * abs(sin(pi() * h / 24.0)) AS l) pl,
     LATERAL (SELECT least(greatest(p - l, -5.0), 5.0) AS b) bb
ON CONFLICT DO NOTHING;

-- 5) forecast: 4 series x 96 runs x 192 slots for the 30-day retention window, compress > 14 d like prod
INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min, method, schema_version)
SELECT r + (i * interval '15 minutes'),
       :'ten', :'site', k.kind, k.model,
       round((CASE WHEN k.kind = 'pv'
              THEN greatest(0, 8.0 * sin(pi() * (h - 6.0) / 13.0)) * (CASE WHEN h BETWEEN 6 AND 19 THEN 1 ELSE 0 END)
              ELSE 0.8 + 1.2 * abs(sin(pi() * h / 24.0)) END)::numeric, 3),
       r, (i * 15), k.model, 1
FROM generate_series(date_trunc('hour', now()) - interval '30 days', now(), interval '15 minutes') r,
     generate_series(0, 191) i,
     (VALUES ('load','load-persistence'), ('load','load-xgb'), ('pv','pv-physical'), ('pv','pv-residual-xgb')) k(kind, model),
     LATERAL (SELECT mod(extract(epoch FROM r + (i * interval '15 minutes'))::bigint, 86400) / 3600.0 AS h) hh
ON CONFLICT DO NOTHING;
SELECT count(*) AS forecast_chunks_compressed FROM (SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('forecast', older_than => INTERVAL '14 days') c) z;

-- 6) weather: 8 runs/day x 48 hourly points, 60 d retention window
INSERT INTO weather_forecast (time, tenant_id, site_id, run_at, temperature_c, cloud_cover_pct, ghi_w_m2, dni_w_m2, dhi_w_m2, source)
SELECT r + (i * interval '1 hour'), :'ten', :'site', r,
       15 + 8 * sin(2 * pi() * (mod(extract(epoch FROM r + (i * interval '1 hour'))::bigint, 86400) / 3600.0 - 13) / 24.0),
       40, 300, 200, 100, 'open-meteo'
FROM generate_series(date_trunc('hour', now()) - interval '60 days', now(), interval '3 hours') r,
     generate_series(0, 47) i
ON CONFLICT DO NOTHING;

-- 7) day-ahead prices: DE-LU PT15M, 13 months back .. +2 d (the strip reads 12 months)
INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source, fetched_at)
SELECT ts, 'DE-LU', 'PT15M',
       round((70 + 60 * sin(2 * pi() * (mod(extract(epoch FROM ts)::bigint, 86400) / 3600.0 - 14) / 24.0))::numeric, 2),
       'EUR', 'energy-charts', now()
FROM generate_series(date_trunc('day', now()) - interval '400 days',
                     date_trunc('day', now()) + interval '2 days' - interval '15 minutes',
                     interval '15 minutes') ts
ON CONFLICT DO NOTHING;

-- 8) quality tables: one row per day (and model)
INSERT INTO forecast_accuracy (day, tenant_id, site_id, model, kind, mae_kw, nmae_pct, bias_kw, skill_vs_baseline, n_slots, computed_at)
SELECT d::date, :'ten', :'site', k.model, k.kind, 0.4 + random() * 0.2, 12 + random() * 3, 0.05,
       CASE WHEN k.model LIKE '%xgb' THEN 0.15 ELSE NULL END, 96, now()
FROM generate_series(date_trunc('day', now()) - (:DAYS - 1 || ' days')::interval, now(), interval '1 day') d,
     (VALUES ('load','load-persistence'), ('load','load-xgb'), ('pv','pv-physical'), ('pv','pv-residual-xgb')) k(kind, model)
ON CONFLICT DO NOTHING;
INSERT INTO plan_accuracy (day, tenant_id, site_id, planned_cost_eur, baseline_cost_eur, realized_cost_eur, n_slots, computed_at)
SELECT d::date, :'ten', :'site', 1.2 + random(), 1.9 + random(), 1.3 + random(), 96, now()
FROM generate_series(date_trunc('day', now()) - (:DAYS - 1 || ' days')::interval, now() - interval '1 day', interval '1 day') d
ON CONFLICT DO NOTHING;

UPDATE device SET device_status_seen_at = now() WHERE id = :'dev';

ANALYZE telemetry; ANALYZE telemetry_v2; ANALYZE schedule; ANALYZE forecast; ANALYZE weather_forecast;
ANALYZE telemetry_rollup_15m; ANALYZE telemetry_rollup_1h; ANALYZE telemetry_rollup_1d;
ANALYZE telemetry_v2_rollup_15m; ANALYZE telemetry_v2_rollup_1h; ANALYZE telemetry_v2_rollup_1d;
ANALYZE day_ahead_prices; ANALYZE forecast_accuracy; ANALYZE plan_accuracy; ANALYZE device; ANALYZE site;

SELECT 'telemetry' t, count(*) FROM telemetry WHERE site_id = :'site'
UNION ALL SELECT 'telemetry_v2', count(*) FROM telemetry_v2 WHERE site_id = :'site'
UNION ALL SELECT 'schedule', count(*) FROM schedule WHERE site_id = :'site'
UNION ALL SELECT 'forecast', count(*) FROM forecast WHERE site_id = :'site'
UNION ALL SELECT 'rollup_15m', count(*) FROM telemetry_rollup_15m WHERE site_id = :'site'
UNION ALL SELECT 'rollup_1h', count(*) FROM telemetry_rollup_1h WHERE site_id = :'site'
UNION ALL SELECT 'rollup_1d', count(*) FROM telemetry_rollup_1d WHERE site_id = :'site'
UNION ALL SELECT 'v2_rollup_15m', count(*) FROM telemetry_v2_rollup_15m WHERE site_id = :'site'
UNION ALL SELECT 'weather', count(*) FROM weather_forecast WHERE site_id = :'site'
UNION ALL SELECT 'prices', count(*) FROM day_ahead_prices;
SELECT hypertable_name, count(*) AS chunks, pg_size_pretty(sum(total_bytes)) AS size
FROM timescaledb_information.chunks c JOIN LATERAL (SELECT total_bytes FROM chunks_detailed_size(format('%I.%I', c.hypertable_schema, c.hypertable_name)) s WHERE s.chunk_name = c.chunk_name) z ON true
GROUP BY 1 ORDER BY 1;
