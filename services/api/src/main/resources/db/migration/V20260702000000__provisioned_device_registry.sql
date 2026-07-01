-- =============================================================================
-- Provisioned-device registry: the manufactured sticker Geräte-IDs.
-- -----------------------------------------------------------------------------
-- Customer onboarding claims a device by the Geräte-ID printed on its sticker
-- (VP-XXXX-XXXX). Before this table, the claim endpoint accepted ANY string and
-- created a device row for it - so a typo'd ID silently produced a ghost device
-- that would "wait for first data" forever. Claims of sticker IDs (VP- prefix)
-- now validate against this registry and fail fast (HTTP 422) with actionable
-- copy when the ID is unknown.
--
-- The registry is GLOBAL manufacturing data: a device is provisioned when it is
-- produced/shipped, long before any customer exists, so there is deliberately
-- no tenant_id and no RLS (same reasoning as day_ahead_prices). Ownership is
-- established later by the claim (the `device` row). Writes are admin-only:
-- the app role may only read, the platform-admin API writes via the
-- voltpilot_admin role.
--
-- Date-based version: sorts after the api core V1/V2/V4 and the earlier
-- V2026... feature migrations, and never collides with forecast (V3) or
-- market-data (V2026070100...) versions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS provisioned_device (
    external_ref   TEXT PRIMARY KEY,
    kind           TEXT        NOT NULL DEFAULT 'inverter',
    note           TEXT,
    provisioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The app role (customer claim path) only ever checks existence/kind; the
-- default privileges from V2 would also grant it writes, so revoke those -
-- provisioning is a platform-admin operation (voltpilot_admin keeps full DML
-- via the V4 default privileges).
GRANT SELECT ON provisioned_device TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON provisioned_device FROM ${appDbUser};
