-- A component label is a name chosen by a human. Older charger composition
-- used the OCPP ChargePointId as a stored label when no name had been supplied,
-- which made the technical identifier indistinguishable from an alias.
--
-- Clearing it is presentation-only: every charger surface already falls back
-- to charge_point_id when the component has no own name.
UPDATE measurement_point AS mp
SET label = NULL
FROM device_charge_point AS cp
WHERE mp.id = cp.entity_id
  AND mp.entity_type = 'ev-charger'
  AND BTRIM(mp.label) = cp.charge_point_id;
