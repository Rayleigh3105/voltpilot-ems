-- =============================================================================
-- V20261031160000 - Heizstab V1, Paket 3: die gemeldete STUFE eines Heizstabs
-- an consumer_runtime_status. ADDITIV (drei neue, nullbare Spalten).
-- -----------------------------------------------------------------------------
-- Ein Heizstab über eine Shelly-Ausgangsmenge (docs/contracts/v2/
-- heizstab-shelly.md) meldet im Herzschlag consumers.{id}.stage (befohlene und
-- BESTÄTIGTE Stufe mit kW) und, wo der Regler der Box ihn führt,
-- consumers.{id}.heizstab (heizstab-regler.md). Das Ledger rechnet die
-- angenommene Energie mit den kW der bestätigten Stufe statt mit
-- Nennleistung × Zeit - bei einer Phase wäre das sonst dreifach zu hoch.
--
--   stufe_json                 die gemeldete Stufe (geprüfter Auszug), NULL =
--                              kein Stufen-Verbraucher / ältere Box
--   heizstab_json              der Befund des Reglers der Box (Stufe, Code,
--                              Grund, verfügbare kW, frühester Wechsel), NULL =
--                              kein Regler
--   stufe_energie_kwh_heute    die angenommene Energie des Tages: je Herzschlag
--                              fortgeschrieben aus der Laufzeit-Differenz der
--                              Box × kW der zuvor gemeldeten Stufe; der Zähler
--                              der Box (runtime_seconds_today) bestimmt den
--                              Tageswechsel
--
-- Die Zeile wird je Herzschlag ersetzt (replaceForDevice); die Fortschreibung
-- liest dafür die zurückgegebene vorige Zeile. Rechte und RLS der Tabelle
-- gelten unverändert für die neuen Spalten.
--
-- Datumsversion ÜBER dem höchsten ausgelieferten Stand (V20261030181500).
-- =============================================================================

ALTER TABLE consumer_runtime_status
    ADD COLUMN IF NOT EXISTS stufe_json jsonb,
    ADD COLUMN IF NOT EXISTS heizstab_json jsonb,
    ADD COLUMN IF NOT EXISTS stufe_energie_kwh_heute numeric(12, 3);
