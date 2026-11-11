#!/usr/bin/env bash
# Hält eine Labor-Box "online" wie eine echte: alle 10 s eine v1-Zeile, die v2-Kanäle des Writer-Fanouts und der
# Herzschlag am Gerät. Usage: box-meldet.sh <tenant> <site> <device>   (läuft, bis sie per PID beendet wird)
TEN=$1; SITE=$2; DEV=$3
while true; do
  docker exec vp-perf-db psql -U voltpilot -d voltpilot -q -c "
    INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw, received_at)
    VALUES (now(), '$TEN', '$SITE', '$DEV', -1.2, 61.5, 3.4, 2.2, now()) ON CONFLICT DO NOTHING;
    INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, channel, value)
    SELECT now(), now(), '$TEN', '$SITE', '$DEV', e.id::text, c.channel, c.v
    FROM measurement_point e JOIN (VALUES ('battery-hybrid','soc_pct',61.5),('battery-hybrid','pv_power_kw',3.4),
      ('battery-hybrid','battery_power_kw',0.0),('grid-meter','power_kw',-1.2),('house-load','power_kw',2.2)) c(t,channel,v)
      ON c.t = e.entity_type
    WHERE e.site_id = '$SITE' ON CONFLICT DO NOTHING;
    UPDATE device SET device_status_seen_at = now() WHERE id = '$DEV';
    UPDATE entity_observed_state SET reported_at = now(), last_telemetry_at = now() WHERE site_id = '$SITE';
  " >/dev/null 2>&1
  sleep 10
done
