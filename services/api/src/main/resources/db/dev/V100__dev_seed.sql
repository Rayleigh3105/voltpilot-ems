-- =============================================================================
-- V100 - DEV-ONLY seed (activated only when the `local` Spring profile is on,
-- i.e. docker-compose and the integration tests - never in staging/prod).
-- -----------------------------------------------------------------------------
-- Seeds TWO tenants with fully disjoint data so tenant isolation is
-- demonstrable and testable, plus ~24h of demo telemetry per site because the
-- real ingest path (EMQX -> ingest -> Redpanda -> writer) is a later increment.
-- Runs as the Flyway superuser, which BYPASSES RLS, so it can populate both
-- tenants in one migration. Deterministic UUIDs make local testing reproducible.
--
--   Tenant A  00000000-0000-0000-0000-000000000001  "Demo C&I Tenant"   (user: demo)
--   Tenant B  10000000-0000-0000-0000-000000000001  "Nordwind Energie"  (user: demo2)
-- =============================================================================

-- ---- Tenant A (mirrors the dev bootstrap in 01-init.sql; harmless if present)
INSERT INTO tenant (id, name, segment) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Demo C&I Tenant', 'CI')
ON CONFLICT (id) DO NOTHING;
INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Demo Site Berlin', 'DE-LU')
ON CONFLICT (id) DO NOTHING;
INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES
    ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002', 'demo-inverter-01', 'inverter', 'claimed')
ON CONFLICT (id) DO NOTHING;
INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) VALUES
    ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003',
     'battery', 100.000, 50.000, 50.000)
ON CONFLICT (id) DO NOTHING;

-- ---- Tenant B (Nordwind Energie) - fully disjoint from Tenant A
INSERT INTO tenant (id, name, segment) VALUES
    ('10000000-0000-0000-0000-000000000001', 'Nordwind Energie', 'CI')
ON CONFLICT (id) DO NOTHING;
INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES
    ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Nordwind Hamburg', 'DE-LU')
ON CONFLICT (id) DO NOTHING;
INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES
    ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002', 'nordwind-inverter-01', 'inverter', 'claimed')
ON CONFLICT (id) DO NOTHING;
INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) VALUES
    ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003',
     'battery', 250.000, 120.000, 120.000)
ON CONFLICT (id) DO NOTHING;

-- ---- Demo telemetry: ~24h at 15-min resolution for both sites' devices.
-- Shapes: a PV bell curve over the day, load noise, battery SoC tracking, and a
-- §14a grid_limit_kw. NOT EXISTS keeps re-seeding a no-op on a persisted volume.
INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw, payload)
SELECT
    ts,
    d.tenant_id, d.site_id, d.id,
    round((pv - load)::numeric, 3)                                   AS power_kw,
    round((40 + 40 * sin(hour / 24.0 * 2 * pi()))::numeric, 2)       AS soc_pct,
    round(pv::numeric, 3)                                            AS pv_power_kw,
    round(load::numeric, 3)                                          AS load_kw,
    d.cap * 0.7                                                      AS grid_limit_kw,
    jsonb_build_object('schema_version', 1, 'source', 'dev-seed')    AS payload
FROM (
    VALUES
        ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, 50.0),
        ('10000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, '10000000-0000-0000-0000-000000000003'::uuid, 120.0)
) AS d(tenant_id, site_id, id, cap)
CROSS JOIN LATERAL generate_series(
    now() - interval '24 hours', now(), interval '15 minutes'
) AS ts
CROSS JOIN LATERAL (
    SELECT extract(hour FROM ts) + extract(minute FROM ts) / 60.0 AS hour
) AS h
CROSS JOIN LATERAL (
    SELECT
        greatest(0, d.cap * 0.9 * sin(greatest(0, (hour - 6) / 12.0) * pi())) AS pv,
        d.cap * (0.25 + 0.15 * abs(sin(hour / 3.0)))                          AS load
) AS m
WHERE NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.device_id = d.id);
