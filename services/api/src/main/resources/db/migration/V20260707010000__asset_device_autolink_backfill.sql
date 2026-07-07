-- =============================================================================
-- V20260707010000 - backfill the battery-asset <-> device link.
-- -----------------------------------------------------------------------------
-- The battery is controlled by the inverter, and the inverter is the edge
-- device, so asset.device_id is what the optimizer publishes a plan against
-- (services/optimization publisher.py refuses to publish without it). MaStR-
-- created battery assets (and dev seeds) leave device_id NULL, so the optimizer
-- persists a plan but never publishes it - the edge shows "noch kein Fahrplan
-- empfangen" while the portal shows a plan. This bit a real customer plant.
--
-- This backfill heals every such plant on deploy: a battery asset whose
-- device_id is NULL, on a site that has EXACTLY ONE device, is linked to that
-- device. A site with MULTIPLE devices is left alone on purpose - we never
-- guess which inverter controls the battery; the portal lets the owner pick.
--
-- Runs as the Flyway superuser (BYPASSRLS), so it heals all tenants at once.
-- The self-maintaining hooks going forward (on device claim, on asset write)
-- live in services/api (AssetRepository.autoLinkBatteryDevice); this migration
-- is the one-time catch-up for rows that predate them.
-- =============================================================================

-- (array_agg(id))[1] picks the site's one device; HAVING count = 1 guarantees
-- there is exactly one, so the pick is unambiguous. Postgres has no max(uuid),
-- hence array_agg rather than an aggregate over the UUID directly.
UPDATE asset a
SET device_id = single.device_id
FROM (
    SELECT site_id, (array_agg(id))[1] AS device_id
    FROM device
    GROUP BY site_id
    HAVING count(*) = 1
) single
WHERE a.site_id = single.site_id
  AND a.type = 'battery'
  AND a.device_id IS NULL;
