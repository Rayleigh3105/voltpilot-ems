-- =============================================================================
-- V20260729020000 - entity_observed_state.edge_model: the reported source's
-- MODEL as its own column, so the stored label can stay CLEAN. ADDITIVE.
-- -----------------------------------------------------------------------------
-- Until now the status listener squashed a local_setup entry's identity into
-- the label column as "brand · model · label · role" (localLabel). That raw
-- concatenation leaked into every customer surface that renders the reported
-- device (Anlagen-Modell GERÄTE column) AND was the prefill of the adoption
-- dialogs' "Name der Komponente" field - an unedited adoption persisted it as
-- the entity's name (the Pilsting "fronius_sunspec · fronius-eco-27-3-s · …"
-- ghost, scout vp-vier-erzeuger-p9).
--
-- With edge_role/edge_brand (V20260720010000) and now edge_model, every part
-- of the report has its own column and label carries ONLY the operator-given
-- name. No backfill: entity_observed_state is replaced wholesale per heartbeat
-- (replaceForDevice), so every row self-heals with the device's next report.
-- =============================================================================

ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_model TEXT;
