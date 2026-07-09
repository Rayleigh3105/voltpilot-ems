-- =============================================================================
-- V20260709000000 - Additional measurement points per Anlage (multi-source).
-- -----------------------------------------------------------------------------
-- A site can have MORE than one energy source: a battery-hybrid inverter PLUS a
-- separate AC-coupled PV inverter. The edge already reads N sources and sums
-- their PV into ONE composite site reading (internal/sources), so the telemetry
-- / rollups / portal / earnings / optimizer contracts are unchanged. This table
-- records the MASTER DATA of each additional source (the Luxone role-tagged
-- measurement-point tree, report §3.1). Phase 1 ships the Erzeuger role only.
--
-- Reconciliation with the existing model: `asset(site_id, type)` STAYS the
-- AGGREGATE PV / battery the optimizer + earnings read; the PV asset's kWp
-- becomes Σ over all Erzeuger measurement points. So this is a CHILD detail
-- table, not a replacement - N points per role without touching the
-- "one aggregate PV per site" contract.
--
-- Control safety (report §3.4): additional sources are READ-ONLY. The battery
-- setpoint / curtailment targets the battery-hybrid inverter ONLY. Enforced in
-- the DB: `control` may be true for AT MOST ONE point per site, and only for the
-- battery-hybrid role. Every additional source read through the one claimed edge
-- needs NO device row / cert / claim, so device_id is nullable.
--
-- Tenant-scoped + RLS exactly like `asset` (the app role reads/writes it under
-- the caller's tenant). Date-based version per the AGENTS.md coordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS measurement_point (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID        NOT NULL REFERENCES site(id)  ON DELETE CASCADE,
    -- The fixed role vocabulary (Luxone). Phase 1 uses 'pv-generation' (Erzeuger);
    -- 'grid-meter' / 'load' / 'wallbox' / 'battery-hybrid' are reserved for later.
    role             TEXT        NOT NULL,
    -- Optional display-only grouping (Luxone "Ordner"); no semantics.
    folder           TEXT,
    label            TEXT,
    -- The read adapter, reusing the inverter catalog (brand -> model -> family ->
    -- communication -> connection), so a source needs no separate catalog.
    brand            TEXT,
    model            TEXT,
    family           TEXT,
    communication    TEXT,
    connection_json  JSONB,
    interval_s       INTEGER     NOT NULL DEFAULT 5 CHECK (interval_s >= 1 AND interval_s <= 3600),
    unit             TEXT        NOT NULL DEFAULT 'kW',
    -- The one claimed edge (battery-hybrid) links to its device; additional
    -- read-only points stay NULL - they are read THROUGH the one edge.
    device_id        UUID        REFERENCES device(id) ON DELETE SET NULL,
    -- READ-ONLY BY CONSTRUCTION. See the partial unique index + CHECK below.
    control          BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Erzeuger: per-point nameplate (kWp). Feeds the aggregate asset.pv kWp and
    -- the edge's widened physical envelope.
    capacity_kwp     NUMERIC(10, 3) CHECK (capacity_kwp IS NULL OR capacity_kwp >= 0),
    -- Optional per-source MaStR SEE number (each AC-PV has its own unit number).
    registry_unit_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Only the battery-hybrid role may ever be a control point.
    CONSTRAINT measurement_point_control_only_battery
        CHECK (control = FALSE OR role = 'battery-hybrid')
);

CREATE INDEX IF NOT EXISTS idx_measurement_point_site ON measurement_point (site_id);

-- At most ONE control=true measurement point per site (the single control target).
-- A partial unique index over site_id where control is true enforces exactly that.
CREATE UNIQUE INDEX IF NOT EXISTS uq_measurement_point_one_control
    ON measurement_point (site_id) WHERE control = TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON measurement_point TO ${appDbUser};

ALTER TABLE measurement_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_point FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS measurement_point_isolation ON measurement_point;
CREATE POLICY measurement_point_isolation ON measurement_point
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
