-- =============================================================================
-- V20260706030000 - DEV-ONLY realized-earnings seed (local profile, like V100).
-- -----------------------------------------------------------------------------
-- Phase 2 of the fleet overview computes REALIZED earnings from
-- telemetry_rollup_15m x day_ahead_prices. The dev telemetry seeds cover only
-- the last ~27 hours and the price collector only fetches today+tomorrow, so a
-- fresh dev stack would show an empty Monat/Jahr hero. This seed makes the
-- demo tenant's fleet visibly earn:
--
--   * 32 days of deterministic PT15M day-ahead prices (DE-LU, cheap midday /
--     expensive evening; ON CONFLICT DO NOTHING so collector rows always win),
--   * 30 days of 15-min rollup buckets for Solarpark Dachau + Hof Lindenberg
--     with a realistic dispatch (charge cheap midday, discharge expensive
--     evening, 92% round-trip - so the saved number is positive but honest),
--   * the matching 1h/1d rollups (Historie week/month stay consistent).
--
-- Demo Site Berlin deliberately gets NO seeded rollups (the V20260706020000
-- precedent): the real refresh job owns Berlin's rollups from its live/raw
-- telemetry, and the api test suite (which runs these dev migrations too)
-- pins exact Berlin rollup contents in the history/purge tests.
--
-- The seeded rollup window ends 30 hours ago: the recent buckets belong to the
-- REAL refresh job (raw telemetry -> rollups, 7-day trailing window), which
-- never touches buckets that have no raw samples - so this seed and the job
-- coexist without fighting. Deterministic values; every insert is guarded
-- (ON CONFLICT DO NOTHING) so re-running is a no-op.
--
-- EXISTENCE-GUARDED like V20260706020000 (same outage class): the whole seed
-- no-ops when the demo tenant row is absent. The price block is deliberately
-- inside the guard too - the fake dev prices exist ONLY to make the demo fleet
-- earn, and on a real deployment without the demo tenant they would silently
-- pollute 32 back-days of `day_ahead_prices` that real tenants' earnings math
-- reads. Checksum note: see the V20260706020000 header.
-- =============================================================================

DO $earnings_seed$
BEGIN
IF NOT EXISTS (SELECT 1 FROM tenant
               WHERE id = '00000000-0000-0000-0000-000000000001') THEN
    RAISE NOTICE 'dev earnings seed skipped: demo tenant absent';
    RETURN;
END IF;

-- ---- 1. Day-ahead prices: PT15M, evening peak / midday trough ----------------
INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source)
SELECT ts, 'DE-LU', 'PT15M',
       round((100
              + 60 * sin((extract(hour FROM ts AT TIME ZONE 'Europe/Berlin')
                          + extract(minute FROM ts) / 60.0 - 15) / 24.0 * 2 * pi())
              + 12 * sin(extract(day FROM ts) / 4.5))::numeric, 2),
       'EUR', 'dev-seed'
FROM generate_series(
         date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'
             - interval '32 days',
         date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'
             + interval '1 day' - interval '15 minutes',
         interval '15 minutes') AS ts
ON CONFLICT (bidding_zone, resolution, ts) DO NOTHING;

-- ---- 2. 30 days of 15-min rollups for the demo fleet -------------------------
-- Profile per bucket (kW): diurnal PV, household load, battery charging 11-14h
-- at cheap prices and discharging 18-21h at expensive ones (discharge power =
-- 0.92 * charge power => the round-trip loss is visibly debited). Grid follows
-- the power balance; energies are kW * 0.25 h.
INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh,
    grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh,
    soc_min_pct, soc_max_pct, soc_last_pct, n_samples)
SELECT b.bucket,
       '00000000-0000-0000-0000-000000000001',
       s.site_id,
       round((m.pv * 0.25)::numeric, 6),
       round((m.load * 0.25)::numeric, 6),
       round((greatest(m.grid, 0) * 0.25)::numeric, 6),
       round((greatest(-m.grid, 0) * 0.25)::numeric, 6),
       round((greatest(m.batt, 0) * 0.25)::numeric, 6),
       round((greatest(-m.batt, 0) * 0.25)::numeric, 6),
       round((50 + 30 * sin((h.hour - 14) / 24.0 * 2 * pi()))::numeric, 2),
       round((52 + 30 * sin((h.hour - 14) / 24.0 * 2 * pi()))::numeric, 2),
       round((51 + 30 * sin((h.hour - 14) / 24.0 * 2 * pi()))::numeric, 2),
       90
FROM (VALUES
        -- site_id, pv peak kW, load base kW, load var kW, battery charge kW
        ('00000000-0000-0000-0000-000000000012'::uuid, 72.0, 2.0, 1.0, 40.0),
        ('00000000-0000-0000-0000-000000000022'::uuid,  9.0, 0.5, 0.8,  4.0)
     ) AS s(site_id, pv_cap, load_base, load_var, batt_p)
CROSS JOIN generate_series(
        date_trunc('hour', now() - interval '31 days'),
        now() - interval '30 hours',
        interval '15 minutes') AS b(bucket)
CROSS JOIN LATERAL (
    SELECT extract(hour FROM b.bucket AT TIME ZONE 'Europe/Berlin')
           + extract(minute FROM b.bucket) / 60.0 AS hour
) AS h
CROSS JOIN LATERAL (
    SELECT greatest(0, s.pv_cap * sin(greatest(0, (h.hour - 6) / 12.0) * pi())) AS pv,
           s.load_base + s.load_var * abs(sin(h.hour / 3.0)) AS load,
           CASE WHEN h.hour >= 11 AND h.hour < 14 THEN s.batt_p
                WHEN h.hour >= 18 AND h.hour < 21 THEN -0.92 * s.batt_p
                ELSE 0 END AS batt
) AS p
CROSS JOIN LATERAL (
    SELECT p.pv AS pv, p.load AS load, p.batt AS batt,
           p.load - p.pv + p.batt AS grid
) AS m
ON CONFLICT (site_id, bucket) DO NOTHING;

-- ---- 3. Matching 1h/1d rollups (Historie week/month consistency) -------------
INSERT INTO telemetry_rollup_1h (bucket, tenant_id, site_id, pv_kwh, load_kwh,
    grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh,
    soc_min_pct, soc_max_pct, soc_last_pct, n_samples)
SELECT time_bucket('1 hour', bucket), tenant_id, site_id,
       sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
       sum(battery_charge_kwh), sum(battery_discharge_kwh),
       min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket), sum(n_samples)
FROM telemetry_rollup_15m
WHERE bucket >= date_trunc('hour', now() - interval '31 days')
  AND bucket < now() - interval '30 hours'
  AND site_id IN ('00000000-0000-0000-0000-000000000012',
                  '00000000-0000-0000-0000-000000000022')
GROUP BY 1, 2, 3
ON CONFLICT (site_id, bucket) DO NOTHING;

INSERT INTO telemetry_rollup_1d (bucket, tenant_id, site_id, pv_kwh, load_kwh,
    grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh,
    soc_min_pct, soc_max_pct, soc_last_pct, n_samples)
SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id,
       sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
       sum(battery_charge_kwh), sum(battery_discharge_kwh),
       min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket), sum(n_samples)
FROM telemetry_rollup_15m
WHERE bucket >= date_trunc('hour', now() - interval '31 days')
  AND bucket < now() - interval '30 hours'
  AND site_id IN ('00000000-0000-0000-0000-000000000012',
                  '00000000-0000-0000-0000-000000000022')
GROUP BY 1, 2, 3
ON CONFLICT (site_id, bucket) DO NOTHING;

END $earnings_seed$;
