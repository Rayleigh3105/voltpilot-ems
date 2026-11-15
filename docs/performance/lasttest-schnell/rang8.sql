-- Rang 8 im Labor: Groesse des doppelten Index und Kosten je eingefuegter v1-Zeile mit/ohne ihn.
-- Einfuegen wie der Writer: eine Zeile je Anweisung (hier in einer Schleife), je Lauf 20 000 Zeilen.
\set ON_ERROR_STOP on
\timing on
SELECT 'idx_telemetry_device_time' AS index, count(*) AS teile, pg_size_pretty(sum(pg_relation_size(c.oid))) AS groesse, sum(pg_relation_size(c.oid)) AS bytes
  FROM pg_class c WHERE c.relkind = 'i' AND c.relname LIKE '%idx_telemetry_device_time%'
UNION ALL
SELECT 'uq_telemetry_device_time', count(*), pg_size_pretty(sum(pg_relation_size(c.oid))), sum(pg_relation_size(c.oid))
  FROM pg_class c WHERE c.relkind = 'i' AND c.relname LIKE '%uq_telemetry_device_time%'
UNION ALL
SELECT 'telemetry gesamt (Tabelle+Indizes)', NULL, pg_size_pretty(hypertable_size('telemetry')), hypertable_size('telemetry');
CREATE OR REPLACE FUNCTION pg_temp.einfuegen(start_ts timestamptz, n int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d record; i int := 0;
BEGIN
  FOR d IN SELECT id, tenant_id, site_id FROM device WHERE external_ref LIKE 'lt-box-%' ORDER BY id LIMIT 2000 LOOP
    FOR k IN 0 .. (n / 2000) - 1 LOOP
      INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw)
      VALUES (start_ts + k * interval '5 seconds', start_ts + k * interval '5 seconds', d.tenant_id, d.site_id, d.id, 1, 50, 2, 3, 70);
    END LOOP;
  END LOOP;
END $$;
-- je Lauf 20 000 Zeilen, eigener Zeitbereich in der Zukunft (neue Chunks wie im Betrieb fortlaufend)
SELECT pg_current_wal_lsn() AS lsn \gset a_
SELECT pg_temp.einfuegen(now() + interval '1 hour', 20000);
SELECT pg_current_wal_lsn() AS lsn \gset b_
SELECT 'mit (Lauf 1)' AS lauf, pg_size_pretty(pg_wal_lsn_diff(:'b_lsn', :'a_lsn')) AS wal, pg_wal_lsn_diff(:'b_lsn', :'a_lsn') / 20000 AS wal_bytes_je_zeile;
DROP INDEX CONCURRENTLY idx_telemetry_device_time;
SELECT pg_current_wal_lsn() AS lsn \gset a_
SELECT pg_temp.einfuegen(now() + interval '3 hours', 20000);
SELECT pg_current_wal_lsn() AS lsn \gset b_
SELECT 'ohne (Lauf 1)' AS lauf, pg_size_pretty(pg_wal_lsn_diff(:'b_lsn', :'a_lsn')) AS wal, pg_wal_lsn_diff(:'b_lsn', :'a_lsn') / 20000 AS wal_bytes_je_zeile;
CREATE INDEX idx_telemetry_device_time ON telemetry (device_id, time DESC);
SELECT pg_current_wal_lsn() AS lsn \gset a_
SELECT pg_temp.einfuegen(now() + interval '5 hours', 20000);
SELECT pg_current_wal_lsn() AS lsn \gset b_
SELECT 'mit (Lauf 2)' AS lauf, pg_size_pretty(pg_wal_lsn_diff(:'b_lsn', :'a_lsn')) AS wal, pg_wal_lsn_diff(:'b_lsn', :'a_lsn') / 20000 AS wal_bytes_je_zeile;
DROP INDEX CONCURRENTLY idx_telemetry_device_time;
SELECT pg_current_wal_lsn() AS lsn \gset a_
SELECT pg_temp.einfuegen(now() + interval '7 hours', 20000);
SELECT pg_current_wal_lsn() AS lsn \gset b_
SELECT 'ohne (Lauf 2)' AS lauf, pg_size_pretty(pg_wal_lsn_diff(:'b_lsn', :'a_lsn')) AS wal, pg_wal_lsn_diff(:'b_lsn', :'a_lsn') / 20000 AS wal_bytes_je_zeile;
-- Leseweg „juengster Wert je Box“ ohne den schlichten Index
EXPLAIN (ANALYZE, BUFFERS) SELECT time FROM telemetry WHERE device_id = (SELECT id FROM device WHERE external_ref = 'lt-box-00001') ORDER BY time DESC LIMIT 1;
-- Labor wieder wie vorher
CREATE INDEX idx_telemetry_device_time ON telemetry (device_id, time DESC);
DELETE FROM telemetry WHERE time > now();
