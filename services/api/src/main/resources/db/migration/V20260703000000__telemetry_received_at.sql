-- =============================================================================
-- Device liveness must reflect ARRIVAL time, not the observation timestamp.
-- -----------------------------------------------------------------------------
-- The portal's device online/offline indicator derives from the newest telemetry
-- per device. It used `telemetry.time` - the OBSERVATION timestamp the edge
-- stamps on each sample. That is wrong for a store-and-forward edge: a device
-- that lost connectivity buffers samples on disk and, on reconnect, replays them
-- oldest-first with their ORIGINAL timestamps (edge-app buffer, contract
-- `mqtt-telemetry.schema.json`). So a device that is actively connected and
-- publishing RIGHT NOW can be delivering samples whose `time` is hours old, and
-- the device list wrongly showed it offline while its values still rendered on
-- the dashboard (which reads the site's latest sample, not a freshness window).
--
-- `received_at` records when the cloud actually RECEIVED a sample. The writer
-- stamps it from the event's `ingested_at` (set by the ingest service at MQTT
-- receipt, so it is immune to Redpanda/writer lag); direct inserts fall back to
-- the DEFAULT now(). Liveness is now correct under backlog replay and edge clock
-- skew, and a genuinely silent device still ages out of the online window.
-- =============================================================================

ALTER TABLE telemetry
    ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

-- Backfill historical rows: the truest arrival proxy is the event's ingested_at
-- if it was preserved in the payload, else the observation time (which correctly
-- keeps a long-silent device offline).
UPDATE telemetry
SET received_at = COALESCE((payload ->> 'ingested_at')::timestamptz, time)
WHERE received_at IS NULL;

ALTER TABLE telemetry ALTER COLUMN received_at SET DEFAULT now();
ALTER TABLE telemetry ALTER COLUMN received_at SET NOT NULL;

-- Backs the per-device "newest arrival" liveness lookup (mirrors the existing
-- (device_id, time DESC) index used for observation-time reads).
CREATE INDEX IF NOT EXISTS idx_telemetry_device_received
    ON telemetry (device_id, received_at DESC);
