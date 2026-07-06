-- =============================================================================
-- V20260706020000 - DEV-ONLY fleet seed (local profile only, like V100).
-- -----------------------------------------------------------------------------
-- Makes the demo tenant (user `demo`) a MULTI-SITE fleet so the portal's
-- adaptive Übersicht (fleet mode from 2 sites) is demonstrable out of the box:
--
--   Demo Site Berlin   (V100)  eigenverbrauch  - live via the edge sim / dev seed
--   Solarpark Dachau   (new)   direktvermarktung - fresh telemetry at api start
--   Hof Lindenberg     (new)   eigenverbrauch  - telemetry ends 3 h ago (stale),
--                              so the degraded card + amber fleet sentence show
--
-- Mixed plant kinds on purpose: the fleet hero must show its neutral wording
-- and the per-site cards their own ("mehr verdient" vs. "gespart").
-- Both new sites get 14 Berlin days of ex-ante optimizer plans so the hero's
-- savings number + 14-day mini chart render. Berlin deliberately gets NO
-- seeded plan - the real optimizer (compose profile `optimize`) owns it.
--
-- Date-versioned (NOT an edit of V100 - editing an applied migration breaks
-- Flyway checksums) and > V20260706010000 so `site.plant_kind` exists.
-- Deterministic UUIDs; every insert is guarded so re-running is a no-op.
-- =============================================================================

-- ---- Solarpark Dachau (Direktvermarktung, ~80 kW class) ----------------------
INSERT INTO site (id, tenant_id, name, bidding_zone, latitude, longitude, plant_kind) VALUES
    ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001',
     'Solarpark Dachau', 'DE-LU', 48.2599, 11.4342, 'direktvermarktung')
ON CONFLICT (id) DO NOTHING;
INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES
    ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000012', 'demo-inverter-02', 'inverter', 'claimed')
ON CONFLICT (id) DO NOTHING;
INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw,
                   max_discharge_kw, roundtrip_efficiency_pct) VALUES
    ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000013',
     'battery', 160.000, 80.000, 80.000, 92.00)
ON CONFLICT (id) DO NOTHING;

-- ---- Hof Lindenberg (Eigenverbrauchs-Haushalt, ~12 kW class) -----------------
INSERT INTO site (id, tenant_id, name, bidding_zone, latitude, longitude, plant_kind) VALUES
    ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001',
     'Hof Lindenberg', 'DE-LU', 47.6023, 9.8889, 'eigenverbrauch')
ON CONFLICT (id) DO NOTHING;
INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES
    ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000022', 'demo-inverter-03', 'inverter', 'claimed')
ON CONFLICT (id) DO NOTHING;
INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw,
                   max_discharge_kw, roundtrip_efficiency_pct) VALUES
    ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000023',
     'battery', 15.000, 8.000, 8.000, 92.00)
ON CONFLICT (id) DO NOTHING;

-- ---- Telemetry: Dachau fresh (received_at defaults to now() => online at api
-- start, like the V100 Berlin seed), Lindenberg ending 3 h ago with
-- received_at = observation time => honestly STALE (the degraded-card demo).
INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct,
                       pv_power_kw, load_kw, grid_limit_kw, payload)
SELECT ts,
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000012',
       '00000000-0000-0000-0000-000000000013',
       round((load - pv)::numeric, 3),
       round((45 + 35 * sin(hour / 24.0 * 2 * pi()))::numeric, 2),
       round(pv::numeric, 3),
       round(load::numeric, 3),
       60.0,
       jsonb_build_object('schema_version', 1, 'source', 'dev-seed')
FROM generate_series(now() - interval '24 hours', now(), interval '15 minutes') AS ts
CROSS JOIN LATERAL (
    SELECT extract(hour FROM ts) + extract(minute FROM ts) / 60.0 AS hour
) AS h
CROSS JOIN LATERAL (
    SELECT greatest(0, 72 * sin(greatest(0, (hour - 6) / 12.0) * pi())) AS pv,
           2.0 + 1.0 * abs(sin(hour / 3.0)) AS load
) AS m
WHERE NOT EXISTS (SELECT 1 FROM telemetry t
                  WHERE t.device_id = '00000000-0000-0000-0000-000000000013');

INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct,
                       pv_power_kw, load_kw, grid_limit_kw, payload, received_at)
SELECT ts,
       '00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000022',
       '00000000-0000-0000-0000-000000000023',
       round((load - pv)::numeric, 3),
       round((55 + 30 * sin(hour / 24.0 * 2 * pi()))::numeric, 2),
       round(pv::numeric, 3),
       round(load::numeric, 3),
       8.4,
       jsonb_build_object('schema_version', 1, 'source', 'dev-seed'),
       ts
FROM generate_series(now() - interval '27 hours', now() - interval '3 hours',
                     interval '15 minutes') AS ts
CROSS JOIN LATERAL (
    SELECT extract(hour FROM ts) + extract(minute FROM ts) / 60.0 AS hour
) AS h
CROSS JOIN LATERAL (
    SELECT greatest(0, 9 * sin(greatest(0, (hour - 6) / 12.0) * pi())) AS pv,
           0.5 + 0.8 * abs(sin(hour / 3.0)) AS load
) AS m
WHERE NOT EXISTS (SELECT 1 FROM telemetry t
                  WHERE t.device_id = '00000000-0000-0000-0000-000000000023');

-- ---- Ex-ante optimizer plans: 14 Berlin days x 96 slots per new site (one run
-- per day). Feeds the fleet hero's "heute geplant" number and its 14-day mini
-- chart. Deterministic plan ids via md5; savings vary per day (sin) so the
-- chart looks alive. Berlin gets none (the real optimizer owns it).
INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at,
                      battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh,
                      cost_eur, baseline_cost_eur)
SELECT ds.day_start + make_interval(mins => slot.n * 15),
       '00000000-0000-0000-0000-000000000001',
       s.site_id, s.device_id,
       md5(s.site_id::text || ds.day_start::text)::uuid,
       ds.day_start,
       round((CASE WHEN slot.n BETWEEN 40 AND 60 THEN s.batt_kw
                   WHEN slot.n BETWEEN 72 AND 88 THEN -s.batt_kw ELSE 0 END)::numeric, 3),
       0, 50.0, 0, 0,
       round((60 + 50 * sin(slot.n / 96.0 * 2 * pi()))::numeric, 2),
       round((s.slot_base - (s.daily_base + s.daily_var * (0.5 + 0.5 * sin(d.off))) / 96.0)::numeric, 6),
       s.slot_base
FROM (VALUES
        ('00000000-0000-0000-0000-000000000012'::uuid,
         '00000000-0000-0000-0000-000000000013'::uuid, 40.0, 1.8, 1.4, 0.05),
        ('00000000-0000-0000-0000-000000000022'::uuid,
         '00000000-0000-0000-0000-000000000023'::uuid, 6.0, 0.7, 0.5, 0.02)
     ) AS s(site_id, device_id, batt_kw, daily_base, daily_var, slot_base)
CROSS JOIN generate_series(0, 13) AS d(off)
CROSS JOIN generate_series(0, 95) AS slot(n)
CROSS JOIN LATERAL (
    SELECT ((date_trunc('day', now() AT TIME ZONE 'Europe/Berlin')
             - make_interval(days => d.off)) AT TIME ZONE 'Europe/Berlin') AS day_start
) AS ds
WHERE NOT EXISTS (SELECT 1 FROM schedule sch WHERE sch.site_id = s.site_id);
