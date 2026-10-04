-- MiSpeL MP-37b: das angesteckte Fahrzeug am Stecker - ob es bidirektional
-- uebertraegt und die eigene Uhr seines Ladestands.
--
-- Beides wusste bisher NUR die Box (Vertrag mispel-ladepunkt-bidirektional.md § 5b):
--   * `bidirectional` = das Fahrzeug fordert ueber ISO 15118-20 einen BPT-Modus
--     an (`ev_needs.bidirectional`, OCPP 2.1, docs/edge-ocpp21.md).
--   * `soc_measured_at` = wann der Ladestand `soc_pct` gemessen bzw. gemeldet
--     wurde. `soc_pct` ist seit MP-37b der juengere aus Messwert SoC und der
--     Meldung des Fahrzeugs (DC); die Meldung ist kein Messwert, `metered_at`
--     (die Uhr der Leistung) ist also nicht unbedingt ihre Uhr.
--
-- Rein ADDITIV: beide Spalten sind NULLABLE OHNE DEFAULT. NULL heisst „die Box
-- hat es nicht gemeldet“ (OCPP 1.6/2.0.1, vor der Aushandlung, ein aelterer
-- Edge-Stand) - bei `bidirectional` UNBEKANNT, nie false. Eine Box ohne die
-- neuen Felder verhaelt sich zeichengleich wie vorher.
--
-- RLS/Grants: `device_charge_connector` traegt sie seit V20260828000000; ein
-- ADD COLUMN erbt sie.

ALTER TABLE device_charge_connector
    ADD COLUMN IF NOT EXISTS soc_measured_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bidirectional   BOOLEAN;
