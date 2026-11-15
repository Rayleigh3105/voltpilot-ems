-- Labor: sechs Releases (Manifest ~3 KB wie ein echtes, unsigniert) und ein gemeldeter Stand je lt-Box,
-- damit RolloutService.readModel den Weg je Geraet mit gemeldetem Stand geht. Idempotent.
\set ON_ERROR_STOP on
INSERT INTO edge_release (release_seq, version, target_commit, notes, created_at, created_by, manifest, signature, signing_key_id)
SELECT n, '2026.11.' || n, md5(n::text), 'Labor-Release ' || n, now() - (7 - n) * interval '1 day', 'labor',
       '{"version":"2026.11.' || n || '","artifacts":[' || string_agg('{"type":"image","name":"edge-' || k || '","sha256":"' || md5(n::text || k::text) || md5(k::text) || '"}', ',') || ']}', 'labor-signatur', 'labor-key'
FROM generate_series(1, 6) n CROSS JOIN generate_series(1, 30) k
GROUP BY n
ON CONFLICT DO NOTHING;
INSERT INTO device_update_status (device_id, tenant_id, site_id, version, current_version, state, reported_at)
SELECT d.id, d.tenant_id, d.site_id, '2026.11.' || (1 + (row_number() OVER (ORDER BY d.id)) % 6), '2026.11.' || (1 + (row_number() OVER (ORDER BY d.id)) % 6), 'idle', now()
FROM device d WHERE d.external_ref LIKE 'lt-box-%'
ON CONFLICT DO NOTHING;
SELECT count(*), round(avg(length(manifest))) FROM edge_release;
SELECT count(*) FROM device_update_status;
