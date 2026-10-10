-- NW-3 Punkt 4: die Stammdaten, ohne die der Writer einen Wert der Box nicht
-- annehmen KANN - und nur die.
--
-- * `device`: ohne Zeile bricht MeasurementWriteRepository.insert() den Umschlag
--   sofort ab (`purgeRows.isEmpty()` -> 0 Zeilen). Das ist die Wasserzeichen-Sperre.
-- * `device_measurement_selection`: die Auswahl IST das Gedaechtnis der Cloud
--   darueber, welcher Punkt seit wann gewaehlt ist. Ohne Zeile ist `meta == null`
--   und jeder Wert wird still uebergangen (kein Verwurf - er war nie bestellt).
--
-- Die Kennungen sind die des NW-3-Rigs (docker-compose.e2e.yml VP_DEV_*), der
-- Punkt und der Katalogstand sind die der festgenagelten Nutzlast
-- docs/contracts/v2/examples/mqtt-measurement-config.valid.nw3-simulator.json.
INSERT INTO tenant (id) VALUES ('00000000-0000-0000-0000-000000000001')
    ON CONFLICT DO NOTHING;

INSERT INTO device (id, tenant_id, site_id) VALUES (
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002')
    ON CONFLICT DO NOTHING;

INSERT INTO device_measurement_selection (
    tenant_id, site_id, device_id, point_key, enabled, cadence_s, desired_revision,
    enabled_at, catalog_version, changed_by, apply_status, applied_at,
    retention_class, raw_retention_days, long_term_cadence_s, long_term_strategy)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003',
    'custom.sim.soc', TRUE, 10, 8,
    now() - INTERVAL '1 hour', '2026.09.23.3', 'nw3', 'applied', now() - INTERVAL '1 hour',
    'unclassified', 90, 900, 'fifteen_minute')
    ON CONFLICT DO NOTHING;
