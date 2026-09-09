-- =============================================================================
-- Reparaturlauf: die Fähigkeiten einer über den Anlege-Weg entstandenen
-- Komponente kommen aus dem TYPKATALOG, nicht aus einem Rollen-Default.
--
-- Der Befund (Scout data/vp-deye-diybms-luecke-l5 §2.2/§3.1, Paket P1):
-- ComponentDefaults.capabilities(role) schrieb für jede Rolle außer Erzeuger
-- genau `power_kw`. Beim Bearbeiten von „Verbindung & Modell" ging dieser eine
-- Kanal über COALESCE in `measurement_point.capabilities` und ersetzte die aus
-- dem Speicher-Asset komponierten drei Kanäle eines `battery-hybrid`
-- (soc_pct / battery_power_kw / pv_power_kw). Folge im Portal: das
-- Energiefluss-Schaltbild hatte KEINEN PV-Knoten (TopologyDeriver leitet die
-- Rolle `pv` nur aus dem Kanal `pv_power_kw` ab) und einen leeren
-- Speicher-Knoten - „das Cockpit zeigt kein PV".
--
-- Der Code liest ab sofort `entitytypes/catalog.json` (`default_measure`) und
-- schreibt beim Bearbeiten ohne Typwechsel gar keine Fähigkeiten mehr. Diese
-- Migration hebt die BEREITS beschädigten Zeilen auf denselben Stand.
--
-- Der Zaun ist bewusst eng - genau die Zeilen, die den Rollen-Default TRAGEN:
--   * `measure` ist ein Array mit GENAU EINEM Eintrag,
--   * und dieser Eintrag ist `power_kw`,
--   * bei einem Typ, dessen Katalog-Wahrheit etwas anderes sagt.
-- Eine korrekt gepflegte Bootstrap-Anlage trägt drei Kanäle und wird deshalb
-- nicht angefasst; eine vom Kunden erweiterte Auswahl (Mess-Selektion je
-- Komponente) ebenfalls nicht. `grid-meter`, `house-load` und `generic-load`
-- messen laut Katalog wirklich `power_kw` - sie stehen hier gar nicht.
--
-- ⚠ ERSETZT statt ergänzt, und das ist der Punkt: ein zusätzlich stehen
-- gelassenes `power_kw` fiele bei Kategorie `storage` bzw. `producer` in
-- DIESELBE Topologie-Rolle wie battery_power_kw bzw. pv_power_kw und würde den
-- Knoten doppelt summieren. Die Fähigkeit war nie gemessen, sie war geraten.
--
-- `actuate` und `guard_config` bleiben unberührt (jsonb_set schreibt nur den
-- Schlüssel `measure`); die Fassungs-Historie in `component_definition` wird
-- NICHT umgeschrieben - sie sagt weiterhin ehrlich, was damals angewandt war.
--
-- Die Box erfährt es mit dem nächsten Registry-Push; das Portal-Read-Model
-- (Topologie/Cockpit) liest direkt aus dieser Tabelle und heilt sofort.
-- =============================================================================

UPDATE measurement_point
   SET capabilities = jsonb_set(
           capabilities,
           '{measure}',
           '[{"channel": "soc_pct", "unit": "%"},
             {"channel": "battery_power_kw", "unit": "kW"},
             {"channel": "pv_power_kw", "unit": "kW"}]'::jsonb,
           true)
 WHERE entity_type = 'battery-hybrid'
   AND capabilities IS NOT NULL
   AND jsonb_typeof(capabilities -> 'measure') = 'array'
   AND jsonb_array_length(capabilities -> 'measure') = 1
   AND capabilities -> 'measure' -> 0 ->> 'channel' = 'power_kw';

UPDATE measurement_point
   SET capabilities = jsonb_set(
           capabilities,
           '{measure}',
           '[{"channel": "pv_power_kw", "unit": "kW"}]'::jsonb,
           true)
 WHERE entity_type = 'producer'
   AND capabilities IS NOT NULL
   AND jsonb_typeof(capabilities -> 'measure') = 'array'
   AND jsonb_array_length(capabilities -> 'measure') = 1
   AND capabilities -> 'measure' -> 0 ->> 'channel' = 'power_kw';
