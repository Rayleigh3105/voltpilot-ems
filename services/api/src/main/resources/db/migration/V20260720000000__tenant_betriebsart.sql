-- =============================================================================
-- V20260720000000 - tenant.betriebsart: the U0 Kontotyp/Betriebsart frame
-- (composition-driven UI overhaul, design vp-ems-ui-overhaul §2 / epic UO #509).
-- -----------------------------------------------------------------------------
-- The coarse, explicit frame that picks the portal's NAVIGATION SHELL:
--   'endkunde'  -> single-object cockpit shell (never fleet/operator chrome)
--   'betreiber' -> fleet/portfolio shell
--   NULL        -> derived default from the existing tenant.segment
--                  (B2C -> endkunde, CI -> betreiber; the derived-with-explicit-
--                  override pattern, same philosophy as AE7's usage profile).
-- The derivation itself lives in ONE place, the api's Betriebsart class - this
-- column only stores the explicit override.
--
-- Presentation-frame only: no RLS/grant change (the V2 tenant policy + grants
-- and V4's admin-role privileges cover the new column), no bootstrap mirror
-- needed (pure additive ALTER layers over any volume - the plant_kind
-- precedent). Idempotent for the compose-bootstrapped dev DB.
-- =============================================================================

ALTER TABLE tenant ADD COLUMN IF NOT EXISTS betriebsart TEXT
    CHECK (betriebsart IN ('endkunde', 'betreiber'));
