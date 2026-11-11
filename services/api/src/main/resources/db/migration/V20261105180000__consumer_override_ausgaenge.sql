-- =============================================================================
-- V20261105180000 - consumer_override.target_outputs: die Phasen, die ein
-- Handeingriff am Heizstab gewählt hat (heizstab-shelly.md "Handeingriff je
-- Phase"). ADDITIV.
-- -----------------------------------------------------------------------------
-- Der Kunde schaltet am Heizstab L1/L2/L3 einzeln; die Cloud legt die gewählten
-- Ausgänge (Kanalnummern des Shelly) neben den Sollwert der Stufe. Das Portal
-- zeigt damit, was gewünscht ist, getrennt von dem, was die Box bestätigt
-- (Herzschlag stage.outputs_on). NULL = kein Phasen-Wunsch (die Box wählt die
-- Ausgänge der Stufe selbst) - jeder bestehende Eingriff bleibt so, wie er war.
-- Nur neben einem Sollwert, 1 bis 4 Ausgänge 0..3 (wie command.outputs).
-- RLS, Rechte und FORCE ROW LEVEL SECURITY der Tabelle gelten unverändert.
-- =============================================================================

ALTER TABLE consumer_override
    ADD COLUMN IF NOT EXISTS target_outputs INTEGER[]
        CHECK (target_outputs IS NULL OR (
            target_command = 'setpoint_kw'
            AND cardinality(target_outputs) BETWEEN 1 AND 4
            AND 0 <= ALL (target_outputs) AND 3 >= ALL (target_outputs)));
