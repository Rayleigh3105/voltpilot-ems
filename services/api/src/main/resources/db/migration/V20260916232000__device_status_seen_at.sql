-- AP-06 IP-15: Die Verbindung einer Box folgt der ANKUNFT ihres Status-
-- Herzschlags, nicht dem Vorhandensein von v1-Anlagen-Telemetrie. Die Spalte
-- bleibt fuer den Bestand NULL; die Lesepfade verwenden bis zum ersten
-- Status-Herzschlag den bisherigen Telemetrie-Beleg als Bestandsschutz.
ALTER TABLE device ADD COLUMN IF NOT EXISTS device_status_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN device.device_status_seen_at IS
    'Cloud arrival time of the newest valid status heartbeat; device liveness anchor (AP-06 IP-15)';
