-- =============================================================================
-- Unterverteilungen (Konzept vp-unterzaehler-anzeige, Stufe 1, C1): ein reiner
-- Zähler in einer Unterverteilung ist ein `sub-meter`, kein `generic-load`.
--
-- Der Befund (Schramm „Zuhause“, 07.11.2026): ein Shelly Pro 3EM, angelegt als
-- Verbraucher, entstand als `generic-load` („Steuerbare Last“, controllable).
-- Das Portal nannte die Unterverteilungen deshalb „Schaltbar per Regel“, obwohl
-- sie nur messen, und ihre Komponente nannte nur `power_kw` - Zählerstände und
-- Phasen, die die Box ab jetzt meldet, verwarf sie (die Box schickt nur, was
-- die Komponente nennt).
--
-- Der Code legt einen Zähler auf der Verbraucher-Seite ab sofort als
-- `sub-meter` an (ComponentService.entityTypeFor) und gibt einem Netz-Zähler,
-- der über einen Zähler gelesen wird, dieselben Kanäle
-- (ComponentDefaults.netzZaehlerCapabilities). Diese Migration hebt den
-- Bestand auf denselben Stand.
--
-- Der Zaun ist eng - genau die Zeilen, die der alte Anlege-Weg schrieb:
--   1. Unterzähler: Typ `generic-load`, Rolle `consumer`, gelesen über den
--      Shelly-Zähler (`communication = 'shelly_em_http'`), nicht steuerbar
--      (`control = false`, kein `actuate`). Typ wird `sub-meter`; `measure`
--      wird die Liste des Typkatalogs, ein darüber hinaus gepflegter Kanal
--      bleibt hinten stehen.
--   2. Netz-Zähler: Typ `grid-meter`, gelesen über den Shelly-Zähler. Die fünf
--      Zählerkanäle kommen hinzu, soweit sie fehlen; `power_kw` und alles
--      andere bleibt.
--
-- `guard_config` bleibt (measure-only); die Fassungs-Historie in
-- `component_definition` wird NICHT umgeschrieben - sie sagt weiterhin, was
-- damals angewandt war. Die Box erfährt es mit dem nächsten Registry-Push; das
-- Portal liest direkt aus dieser Tabelle. Wiederholbar: ein zweiter Lauf findet
-- nichts mehr.
-- =============================================================================

UPDATE measurement_point mp
   SET entity_type = 'sub-meter',
       capabilities = jsonb_set(
           COALESCE(mp.capabilities, '{}'::jsonb),
           '{measure}',
           '[{"channel": "power_kw", "unit": "kW"},
             {"channel": "energy_kwh", "unit": "kWh"},
             {"channel": "energy_export_kwh", "unit": "kWh"},
             {"channel": "power_l1_kw", "unit": "kW"},
             {"channel": "power_l2_kw", "unit": "kW"},
             {"channel": "power_l3_kw", "unit": "kW"}]'::jsonb
           || COALESCE((
                SELECT jsonb_agg(m)
                  FROM jsonb_array_elements(
                           CASE WHEN jsonb_typeof(mp.capabilities -> 'measure') = 'array'
                                THEN mp.capabilities -> 'measure' ELSE '[]'::jsonb END) m
                 WHERE m ->> 'channel' NOT IN ('power_kw', 'energy_kwh', 'energy_export_kwh',
                                               'power_l1_kw', 'power_l2_kw', 'power_l3_kw')),
              '[]'::jsonb),
           true)
 WHERE mp.entity_type = 'generic-load'
   AND mp.role = 'consumer'
   AND mp.communication = 'shelly_em_http'
   AND mp.control = false
   AND (mp.capabilities IS NULL
        OR jsonb_typeof(mp.capabilities -> 'actuate') IS DISTINCT FROM 'array'
        OR jsonb_array_length(mp.capabilities -> 'actuate') = 0);

UPDATE measurement_point mp
   SET capabilities = jsonb_set(
           COALESCE(mp.capabilities, '{}'::jsonb),
           '{measure}',
           COALESCE(CASE WHEN jsonb_typeof(mp.capabilities -> 'measure') = 'array'
                         THEN mp.capabilities -> 'measure' END,
                    '[{"channel": "power_kw", "unit": "kW"}]'::jsonb)
           || COALESCE((
                SELECT jsonb_agg(d.value ORDER BY d.ord)
                  FROM jsonb_array_elements(
                           '[{"channel": "energy_kwh", "unit": "kWh"},
                             {"channel": "energy_export_kwh", "unit": "kWh"},
                             {"channel": "power_l1_kw", "unit": "kW"},
                             {"channel": "power_l2_kw", "unit": "kW"},
                             {"channel": "power_l3_kw", "unit": "kW"}]'::jsonb)
                       WITH ORDINALITY AS d(value, ord)
                 WHERE NOT EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements(
                                  CASE WHEN jsonb_typeof(mp.capabilities -> 'measure') = 'array'
                                       THEN mp.capabilities -> 'measure' ELSE '[]'::jsonb END) m
                        WHERE m ->> 'channel' = d.value ->> 'channel')),
              '[]'::jsonb),
           true)
 WHERE mp.entity_type = 'grid-meter'
   AND mp.communication = 'shelly_em_http'
   AND NOT (COALESCE(mp.capabilities -> 'measure', '[]'::jsonb) @> '[{"channel": "energy_kwh"},
             {"channel": "energy_export_kwh"}, {"channel": "power_l1_kw"},
             {"channel": "power_l2_kw"}, {"channel": "power_l3_kw"}]'::jsonb);
