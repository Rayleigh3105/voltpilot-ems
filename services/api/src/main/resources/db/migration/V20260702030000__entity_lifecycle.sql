-- =============================================================================
-- Entity lifecycle: edit + delete for Standorte/Geräte/Mandanten.
-- -----------------------------------------------------------------------------
-- RLS note (checked): the V2 policies (and the later weather/schedule/rollup
-- policies) carry no FOR clause, so they already apply to SELECT, INSERT,
-- UPDATE and DELETE alike - no new policies are needed for updates/deletes;
-- own-tenant scoping holds for every command. What IS missing are table
-- privileges:
--
-- 1. The app role could so far only SELECT the series tables the api reads
--    (weather_forecast, schedule, rollups, forecast_* quality tables) and had
--    no grant at all on `forecast`. Deleting a site (customer or admin via the
--    tenant switcher) must cascade that site's series rows, and deleting a
--    device must cascade its telemetry - all through the SAME RLS-scoped app
--    role, so the deletes can never cross a tenant boundary. (DELETE with a
--    WHERE clause also needs SELECT on the referenced columns, hence the
--    SELECT grant on forecast. `forecast` itself has no RLS - backend-only
--    consumers - so its delete is additionally gated in code by the RLS site
--    ownership check.)
--
-- 2. The admin role's V4 default privileges only cover tables created AFTER V4
--    by Flyway. On a dev-compose volume the feed tables were bootstrapped by
--    the infra init scripts BEFORE Flyway ran, so voltpilot_admin has no grant
--    on them there. Tenant offboarding (the admin cascade) deletes a tenant's
--    series rows through the admin role, so grant explicitly - idempotent and
--    a no-op where the default privileges already applied.
--
-- 3. `device.name`: an optional customer-facing label ("Bezeichnung"). The
--    external_ref stays the immutable identity (MQTT topics + registry
--    gating); the label is the thing that may be edited freely.
--
-- Date-based version per AGENTS.md coordination (V20260702000000 is owned by
-- services/forecast, ...010000 by MaStR, ...020000 by the device registry).
-- =============================================================================

ALTER TABLE device ADD COLUMN IF NOT EXISTS name TEXT;

-- (1) App role: RLS-scoped series cleanup for site/device deletion.
GRANT SELECT, DELETE ON forecast TO ${appDbUser};
GRANT DELETE ON weather_forecast, schedule,
    forecast_model_state, forecast_accuracy, plan_accuracy,
    telemetry_rollup_15m, telemetry_rollup_1h, telemetry_rollup_1d
    TO ${appDbUser};

-- (2) Admin role: explicit grants for the offboarding cascade (see header).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    day_ahead_prices, weather_forecast, schedule, forecast,
    forecast_model_state, forecast_accuracy, plan_accuracy,
    telemetry_rollup_15m, telemetry_rollup_1h, telemetry_rollup_1d,
    provisioned_device
    TO ${adminDbUser};
