-- Erzeugte Flotte fuer den Lasttest: Boxen :lo..:hi (1-basiert), je Mandant 4 Anlagen,
-- je Anlage eine Box (device, claimed) + ein Speicher (asset). Deterministische UUIDs
-- aus md5, damit der Lastgenerator dieselben Kennungen rechnet. Idempotent.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenant (id, name, segment, betriebsart)
SELECT md5('lt-tenant-' || t)::uuid, 'Lasttest Kunde ' || lpad(t::text, 4, '0'), 'CI', 'endkunde'
FROM generate_series(((:lo - 1) / 4) + 1, ((:hi - 1) / 4) + 1) t
ON CONFLICT (id) DO NOTHING;

INSERT INTO site (id, tenant_id, name, bidding_zone, latitude, longitude, plant_kind, tarif_art, profil, component_authority)
SELECT md5('lt-site-' || b)::uuid, md5('lt-tenant-' || (((b - 1) / 4) + 1))::uuid,
       'LT Anlage ' || lpad(b::text, 5, '0'), 'DE-LU', 48.0 + (b % 50) * 0.05, 11.0 + (b % 40) * 0.05,
       'eigenverbrauch', 'dynamisch', 'gewerbe', 'box'
FROM generate_series(:lo, :hi) b
ON CONFLICT (id) DO NOTHING;

INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, name)
SELECT md5('lt-device-' || b)::uuid, md5('lt-tenant-' || (((b - 1) / 4) + 1))::uuid, md5('lt-site-' || b)::uuid,
       'lt-box-' || lpad(b::text, 5, '0'), 'inverter', 'claimed', 'LT Box ' || b
FROM generate_series(:lo, :hi) b
ON CONFLICT (id) DO NOTHING;

INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, is_primary)
SELECT md5('lt-asset-' || b)::uuid, md5('lt-tenant-' || (((b - 1) / 4) + 1))::uuid, md5('lt-site-' || b)::uuid,
       md5('lt-device-' || b)::uuid, 'battery', 100, 50, 50, true
FROM generate_series(:lo, :hi) b
ON CONFLICT (id) DO NOTHING;
COMMIT;
SELECT count(*) AS lt_devices FROM device WHERE external_ref LIKE 'lt-box-%';
