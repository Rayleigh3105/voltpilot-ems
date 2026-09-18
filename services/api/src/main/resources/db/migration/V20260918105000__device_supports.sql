-- AP-06 IP-18: additive capability reports; existing boxes stay NULL.
-- Device ownership, FORCE RLS and tenant grants are inherited from device.
ALTER TABLE device ADD COLUMN IF NOT EXISTS supports JSONB;
ALTER TABLE device ADD COLUMN IF NOT EXISTS supports_reported_at TIMESTAMPTZ;
ALTER TABLE device ADD CONSTRAINT device_supports_array
    CHECK (supports IS NULL OR jsonb_typeof(supports) = 'array');
GRANT SELECT (supports, supports_reported_at), UPDATE (supports, supports_reported_at)
    ON device TO ${appDbUser};
COMMENT ON COLUMN device.supports IS
    'Known capabilities from the latest valid status heartbeat; NULL = no supports block, [] = empty report. Effective capability = reported OR release table.';
