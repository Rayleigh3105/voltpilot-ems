-- =============================================================================
-- V20260707030000 - site.strompreis_ct_kwh (Meine Anlage v2, geldzentriert).
-- -----------------------------------------------------------------------------
-- The money-centric "Meine Anlage" view values a site's SELF-CONSUMED energy in
-- euros. Self-consumption avoids buying grid power at the customer's RETAIL
-- tariff, which VoltPilot does not otherwise know (it only sees wholesale spot
-- prices) - so, exactly like the Deye Copilot app, the customer maintains their
-- own household electricity price per Anlage (captain decision 1, 2026-07-07).
--
--   site.strompreis_ct_kwh - the customer's retail electricity price (ct/kWh,
--   from their Stromrechnung). Nullable: NULL (the default) means the portal
--   shows the self-consumption only in kWh, NEVER a fabricated euro value; when
--   set, the earnings math adds the Eigenverbrauchs-Wert
--   (self-consumed kWh x this price) to the Gesamtertrag.
--
-- Pure additive ALTER: the existing site RLS policy + grants (V2) already cover
-- the new column, so no infra bootstrap mirror and no new grant are needed.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS strompreis_ct_kwh NUMERIC(8, 3)
    CHECK (strompreis_ct_kwh IS NULL OR strompreis_ct_kwh >= 0);
