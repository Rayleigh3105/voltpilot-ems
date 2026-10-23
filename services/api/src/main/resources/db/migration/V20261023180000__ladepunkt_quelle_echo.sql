-- =============================================================================
-- V20261023180000 - Echo der Ladequelle je Säule (Konzept k1 „Gewählt ist
-- nicht geladen", Regel 4, 23.10.2026; Vertrag
-- docs/contracts/ladepunkt-quelle-echo.md).
-- -----------------------------------------------------------------------------
-- Die Box meldet im Herzschlag je Säule die Bahn, die sie FÄHRT. Das ist der
-- IST der Box neben dem SOLL des Kunden (site_charge_point_allowlist.source,
-- .min_kw, .storage_release); erst der Vergleich beider sagt dem Portal „Box
-- hat übernommen".
--
--   * applied_source - nur_sonne | sonne_zuerst | schnell. NULL = eine ältere
--     Box meldet es nicht - NIE eine geratene Bahn.
--   * applied_min_kw - eigene Mindestleistung neben sonne_zuerst; NULL = keine.
--   * applied_storage_release - darf die Box für diese Säule Speicherenergie
--     freigeben? NULL = nicht gemeldet (ältere Box), nicht FALSE.
--
-- RLS/Grants erbt device_charge_point (V20260828000000); ein ADD COLUMN ändert
-- daran nichts. Kein Bootstrap-Spiegel (die Tabelle hat keinen). Out-of-order-
-- sicher: IF NOT EXISTS bzw. DROP ... IF EXISTS vor ADD CONSTRAINT.
-- =============================================================================

ALTER TABLE device_charge_point
    ADD COLUMN IF NOT EXISTS applied_source TEXT,
    ADD COLUMN IF NOT EXISTS applied_min_kw DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS applied_storage_release BOOLEAN;

ALTER TABLE device_charge_point
    DROP CONSTRAINT IF EXISTS device_charge_point_applied_source_chk;
ALTER TABLE device_charge_point ADD CONSTRAINT device_charge_point_applied_source_chk
    CHECK (applied_source IS NULL OR applied_source IN ('nur_sonne', 'sonne_zuerst', 'schnell'));
