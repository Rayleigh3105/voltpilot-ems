-- Labor-Bestand vp-lasttest-schnell: Preise DE-LU (35 Tage zurueck, 1 Tag voraus, PT15M) und duenne
-- v1-Telemetrie fuer die lt-Boxen (alle 2 h ueber 56 Tage = 8 Chunks a 7 Tage), damit Lesewege
-- je Geraet ueber mehrere Chunks gehen wie in einem laenger laufenden Betrieb. Superuser, idempotent.
\set ON_ERROR_STOP on
INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source)
SELECT g, 'DE-LU', 'PT15M', round((80 + 40 * sin(extract(epoch FROM g) / 43200.0))::numeric, 2), 'EUR', 'labor'
FROM generate_series(date_trunc('hour', now()) - interval '35 days', date_trunc('hour', now()) + interval '1 day', interval '15 minutes') g
ON CONFLICT DO NOTHING;
INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw)
SELECT ts, ts + interval '300 ms', d.tenant_id, d.site_id, d.id, 5.0, 50.0, 10.0, 20.0, 70.0
FROM device d
CROSS JOIN generate_series(date_trunc('hour', now()) - interval '56 days', date_trunc('hour', now()) - interval '1 hour', interval '2 hours') ts
WHERE d.external_ref LIKE 'lt-box-%'
ON CONFLICT DO NOTHING;
ANALYZE telemetry; ANALYZE day_ahead_prices; ANALYZE device; ANALYZE site;
SELECT count(*) AS telemetry_rows FROM telemetry;
SELECT count(*) AS chunks FROM show_chunks('telemetry');
