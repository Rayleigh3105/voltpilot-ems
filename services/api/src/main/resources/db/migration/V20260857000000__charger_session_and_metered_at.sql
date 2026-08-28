-- Cockpit Phase 1 / E2: die Sitzungsbilanz und das ALTER der Leistung je Stecker.
--
-- Beides wusste bisher NUR die Box:
--   * `session_kwh` = das kumulative Zaehlerregister minus seinem Stand bei
--     StartTransaction. Die Cloud kam bis heute nur ueber einen Slice-10-Join
--     (`ocpp_meter_sample` - `ocpp_transaction.meter_start`) daran, und der
--     steht dem Cockpit-Lesepfad nicht zur Verfuegung.
--   * `metered_at` = wann die Saeule zuletzt MeterValues gemeldet hat. Ohne es
--     kann keine Flaeche ein stehengebliebenes Kilowatt von einem lebenden
--     unterscheiden - „laedt mit 11 kW" waere dann eine Aussage ueber eine
--     halbe Stunde alte Zahl.
--
-- Rein ADDITIV: beide Spalten sind NULLABLE OHNE DEFAULT. NULL heisst „die Box
-- hat es nicht gemeldet" (ein aelterer Edge-Stand), NIE 0 bzw. „gerade eben" -
-- dieselbe Ehrlichkeitsregel wie bei `power_kw`/`energy_kwh` daneben. Eine
-- Anlage ohne Ladepunkt und eine Box ohne die neuen Felder verhalten sich
-- zeichengleich wie vorher.
--
-- RLS/Grants: `device_charge_connector` traegt sie seit V20260828000000; ein
-- ADD COLUMN erbt sie.

ALTER TABLE device_charge_connector
    ADD COLUMN IF NOT EXISTS session_kwh NUMERIC,
    ADD COLUMN IF NOT EXISTS metered_at  TIMESTAMPTZ;
