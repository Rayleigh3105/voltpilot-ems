-- =============================================================================
-- V20260810000000 - Steuerbare Verbraucher: master data + policy (Increment 1).
-- -----------------------------------------------------------------------------
-- Contract: docs/verbrauchssteuerung.md §9.2/§9.3 + docs/contracts/v2/
-- consumer-policy.schema.json. A controllable consumer (Verbraucher) STAYS a
-- v2 entity - a `measurement_point` row with a consumer `entity_type`
-- (wallbox / heating-rod / pump / generic-load). These two ADDITIVE tables carry
-- the extra facts a consumer needs beyond a generic entity:
--
--   consumer_profile  - the physical control profile + operating defaults
--                       (one row per entity; §9.2). power_ranges_kw is the D4
--                       non-convex power-range column (nullable JSONB).
--   consumer_policy    - versioned declarative operating requirements
--                       (draft | active | retired; §9.3). The DOCUMENT column
--                       carries the contract JSON verbatim; content_hash is the
--                       canonical-JSON digest the api computes on save.
--
-- Increment 1 (§19) ships master data + customer CRUD + the Anlagen-Modell
-- assistant only: policies are authored + stored as DRAFTS, there is no
-- compiler / optimizer / edge command yet, and every surface says honestly
-- "Steuerung noch nicht aktiviert". `consumer_requirement_state` is DELIBERATELY
-- NOT created here - it has no writer until the fulfilment path lands (§9.4).
--
-- The D4 power-range disjointness ("disjoint ascending [min,max] within the
-- effective rated power") and the levels_kw / min / resolution coherence rules
-- are enforced by the ConsumerProfileValidator (Java) + its TS twin - the house
-- pattern for rules richer than a single-row CHECK (FlowGraphValidator
-- precedent). The CHECKs below pin the cheap column-local invariants.
--
-- Tenant-scoped + ENABLE/FORCE ROW LEVEL SECURITY + default-deny exactly like
-- measurement_point / flow_definition; the app role gets only the needed grants.
-- Date-based version ABOVE the highest shipped migration (V20260809010000) per
-- the Flyway out-of-order rule. Additive: a site with no consumers is untouched.
-- =============================================================================

-- The composite FK on consumer_profile (tenant-/site-consistency, below) needs a
-- matching unique key on measurement_point (id is already the PK, so the triple
-- is trivially unique). It MUST exist BEFORE consumer_profile is created.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_measurement_point_id_tenant_site') THEN
        ALTER TABLE measurement_point
            ADD CONSTRAINT uq_measurement_point_id_tenant_site
            UNIQUE (id, tenant_id, site_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS consumer_profile (
    entity_id                  UUID        PRIMARY KEY REFERENCES measurement_point(id) ON DELETE CASCADE,
    tenant_id                  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id                    UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    control_kind               TEXT        NOT NULL
                               CHECK (control_kind IN ('on_off', 'stepped', 'continuous')),
    rated_power_kw             NUMERIC(10, 3) NOT NULL CHECK (rated_power_kw > 0),
    min_power_kw               NUMERIC(10, 3) CHECK (min_power_kw IS NULL OR min_power_kw >= 0),
    levels_kw                  JSONB,          -- stepped only: explicit ascending level list incl. 0
    resolution_kw              NUMERIC(10, 3) CHECK (resolution_kw IS NULL OR resolution_kw > 0),
    power_ranges_kw            JSONB,          -- D4: nullable non-convex [min,max] ranges (continuous)
    storage_relation           TEXT        NOT NULL DEFAULT 'consumer_first'
                               CHECK (storage_relation IN ('consumer_first', 'storage_first')),
    default_grid_energy_policy TEXT        NOT NULL DEFAULT 'allow'
                               CHECK (default_grid_energy_policy IN ('allow', 'avoid', 'forbid')),
    allow_storage_discharge    BOOLEAN     NOT NULL DEFAULT FALSE,
    default_service_rank       SMALLINT,       -- set only after a detected conflict (§7)
    availability_channel       TEXT,           -- open v2 channel vocabulary (CHANNEL_RE), not free text
    confirmation_channel       TEXT,
    min_on_seconds             INTEGER     CHECK (min_on_seconds  IS NULL OR min_on_seconds  >= 0),
    min_off_seconds            INTEGER     CHECK (min_off_seconds IS NULL OR min_off_seconds >= 0),
    max_starts_per_day         INTEGER     CHECK (max_starts_per_day IS NULL OR max_starts_per_day >= 0),
    failsafe                   TEXT        NOT NULL DEFAULT 'off'
                               CHECK (failsafe IN ('off', 'release')),
    enabled                    BOOLEAN     NOT NULL DEFAULT FALSE,  -- pausierbarer Gesamtschalter (§4.2)
    version                    BIGINT      NOT NULL DEFAULT 1,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- tenant-/site-FK consistency to the referenced entity (§9.2): the profile's
    -- (tenant, site) MUST equal the measurement_point's. The composite FK below
    -- enforces it - the entity can never be re-parented under the profile.
    CONSTRAINT consumer_profile_entity_consistency
        FOREIGN KEY (entity_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_profile_site ON consumer_profile (site_id);

CREATE TABLE IF NOT EXISTS consumer_policy (
    policy_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id     UUID        NOT NULL REFERENCES consumer_profile(entity_id) ON DELETE CASCADE,
    tenant_id     UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id       UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    version       INTEGER     NOT NULL CHECK (version >= 1),
    lifecycle     TEXT        NOT NULL DEFAULT 'draft'
                  CHECK (lifecycle IN ('draft', 'active', 'retired')),
    document      JSONB       NOT NULL,
    content_hash  TEXT        NOT NULL,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at  TIMESTAMPTZ,
    UNIQUE (entity_id, version)
);

CREATE INDEX IF NOT EXISTS idx_consumer_policy_site ON consumer_policy (site_id);

-- At most ONE active version per consumer (§9.3). No policy is active in
-- Increment 1 (activation does not exist yet), but the invariant is pinned now.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumer_policy_one_active
    ON consumer_policy (entity_id) WHERE lifecycle = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_profile TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_policy  TO ${appDbUser};

ALTER TABLE consumer_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_profile FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_profile_isolation ON consumer_profile;
CREATE POLICY consumer_profile_isolation ON consumer_profile
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE consumer_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_policy FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consumer_policy_isolation ON consumer_policy;
CREATE POLICY consumer_policy_isolation ON consumer_policy
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
