-- =============================================================================
-- Backfill: jede `battery-hybrid`-Komponente MUSS `pv_power_kw` tragen.
--
-- Der Befund (Scout data/vp-geraete-triage-t2, Befund 1): die PV eines Hybriden
-- ist kein eigener Erzeuger, sondern der Kanal `pv_power_kw` AUF der
-- `battery-hybrid`-Entität. Fehlt der Kanal, leitet der TopologyDeriver keine
-- Rolle `pv` ab, das Portal synthetisiert keinen „Solarmodule"-Aspekt, und die
-- Karte „PV-Produktion dieses Geräts" (die genau daran hängt) verschwindet -
-- obwohl das Gerät live Solarstrom meldet.
--
-- Der Reparaturlauf `V20260909010000` heilte denselben Schaden, aber mit einem
-- BEWUSST ENGEN Zaun: nur Zeilen, deren `measure` EXAKT `[{power_kw}]` war. Eine
-- vom Kunden erweiterte Auswahl (mehr als ein Kanal) oder eine anders geformte
-- Beschädigung fiel durch das Netz und trägt bis heute kein `pv_power_kw`. Genau
-- diese Zeilen holt dieser Lauf nach.
--
-- Der neue Zaun: `entity_type = 'battery-hybrid'` UND `measure` ist ein Array
-- OHNE einen `pv_power_kw`-Eintrag. Das ist die WAHRE Bedingung des Schadens und
-- macht den Lauf zugleich idempotent - nach dem Lauf trägt jede Zeile den Kanal,
-- die WHERE-Klausel trifft sie also nicht mehr. Damit ist er auch out-of-order-
-- sicher (out-of-order: true): egal, ob er in Versionsreihenfolge auf frischer
-- DB oder verspätet nach anderen Migrationen ankommt - er beschreibt nur die
-- Zeilen, denen der Kanal fehlt, und lässt alle anderen unberührt.
--
-- ⚠ ZWEI Feinheiten, beide topologie-getrieben:
--   * Die kanonischen drei Kanäle (`soc_pct` / `battery_power_kw` /
--     `pv_power_kw`, wie sie `EntityRegistryService.batteryCapabilities`
--     komponiert) werden VORAN gestellt; schon vorhandene Exemplare davon werden
--     NICHT doppelt geführt (sie fielen sonst in dieselbe Rolle und summierten
--     den Knoten doppelt - der Grund, aus dem `V20260909010000` „ERSETZT statt
--     ergänzt").
--   * Ein nacktes `power_kw` wird ENTFERNT: es ist der geratene Rollen-Default,
--     der bei Kategorie storage/producer in dieselbe Rolle wie
--     `battery_power_kw`/`pv_power_kw` fiele. Es war nie gemessen.
-- Alle ANDEREN Kanäle (eine echte, nicht kollidierende Kunden-Auswahl wie
-- `zisterne_prozent`) bleiben mit ihrer Einheit erhalten.
--
-- `actuate` und `guard_config` bleiben unberührt (jsonb_set schreibt nur den
-- Schlüssel `measure`); die Fassungs-Historie in `component_definition` wird
-- NICHT umgeschrieben. Das Portal-Read-Model (Topologie/Cockpit) liest direkt
-- aus dieser Tabelle und heilt sofort; die Box erfährt es mit dem nächsten
-- Registry-Push. Der Anlagenbild-PV-Knoten entsteht damit wieder, und der
-- geräteseitige Assistent findet einen vorhandenen PV-Aspekt (ergänzt den
-- Portal-Fix (b), der den Einstieg schon ohne PV-Aspekt erreichbar macht).
-- =============================================================================

UPDATE measurement_point
   SET capabilities = jsonb_set(
           capabilities,
           '{measure}',
           '[{"channel": "soc_pct", "unit": "%"},
             {"channel": "battery_power_kw", "unit": "kW"},
             {"channel": "pv_power_kw", "unit": "kW"}]'::jsonb
           || COALESCE(
                (SELECT jsonb_agg(elem)
                   FROM jsonb_array_elements(capabilities -> 'measure') AS elem
                  WHERE elem ->> 'channel' NOT IN
                        ('soc_pct', 'battery_power_kw', 'pv_power_kw', 'power_kw')),
                '[]'::jsonb),
           true)
 WHERE entity_type = 'battery-hybrid'
   AND capabilities IS NOT NULL
   AND jsonb_typeof(capabilities -> 'measure') = 'array'
   AND NOT (capabilities -> 'measure' @> '[{"channel": "pv_power_kw"}]');
