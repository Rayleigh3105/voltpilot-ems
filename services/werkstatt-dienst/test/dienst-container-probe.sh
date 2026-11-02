#!/bin/sh
# Probe des Dienst-Bilds (services/werkstatt-dienst/Dockerfile) unter den
# Bedingungen von PodSecurity "restricted": Benutzer 10001, Dateisystem nur
# lesbar, keine Capabilities, no-new-privileges; schreibbar nur /tmp und das
# Datenverzeichnis. Ohne Brücke (die Adresse antwortet nicht) - geprüft wird,
# dass der Dienst so startet, seine Betriebsseite antwortet, die
# Werkstatt-Anzeige nur innen auf Loopback lauscht und die Logs dem
# Betriebsvertrag folgen.
#
# Aufruf: services/werkstatt-dienst/test/dienst-container-probe.sh
#   VP_PROBE_BEHALTEN=1  Bild und Container nicht wegräumen
set -eu

HIER=$(cd "$(dirname "$0")" && pwd)
DIENST=$(cd "$HIER/.." && pwd)
BILD=vp-werkstatt-dienst-probe:lokal
NAME=vp-werkstatt-dienst-probe-$$
PORT=18100

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "FEHLER: Docker antwortet nicht" >&2; exit 2; }
TMP=$(mktemp -d)
aufraeumen() {
  if [ "${VP_PROBE_BEHALTEN:-}" = 1 ]; then echo "behalten: $NAME, $TMP"; return; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker image rm "$BILD" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap aufraeumen EXIT
fehler=0
ok() { echo "ok: $*"; }
nein() { echo "FEHLER: $*"; fehler=1; }

echo "== Bild bauen"
docker build -q --build-arg FASSUNG=probe-1234 -t "$BILD" "$DIENST" >/dev/null

mkdir -p "$TMP/geheim" "$TMP/oeffentlich"
for k in werkbank-status werkbank-weiterleitung werkbank-pflege; do
  ssh-keygen -q -t ed25519 -N '' -C "probe-$k" -f "$TMP/geheim/$k"
  rm -f "$TMP/geheim/$k.pub"
done
ssh-keygen -q -t rsa -b 3072 -N '' -C voltpilot-notfall -f "$TMP/notfall"
cp "$TMP/notfall.pub" "$TMP/oeffentlich/voltpilot-notfall.pub"
chmod 0644 "$TMP"/geheim/*

[ "$(docker run --rm "$BILD" fassung)" = probe-1234 ] && ok "Fassung aus dem Bau" || nein "Fassung"
[ "$(docker run --rm --entrypoint id "$BILD" -u)" = 10001 ] && ok "läuft als 10001" || nein "Benutzer"

echo "== Dienst starten (wie im Pod)"
docker volume create "$NAME-daten" >/dev/null
docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp:rw,size=64m --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  -v "$NAME-daten:/var/lib/vp-werkstatt-dienst" \
  -v "$TMP/geheim:/etc/vp-werkstatt/geheim:ro" -v "$TMP/oeffentlich:/etc/vp-werkstatt/oeffentlich:ro" \
  -e VP_WERKBANK_ADRESSE=127.0.0.1:1 -e VP_WERKSTATT_NOTFALL_PUB=/etc/vp-werkstatt/oeffentlich/voltpilot-notfall.pub \
  -e VP_WERKSTATT_TAKT=2s -e VOLTPILOT_LOGGING_FORMAT=json \
  -p "127.0.0.1:$PORT:8100" "$BILD" >/dev/null
# das Datenvolumen gehört root; im Pod setzt fsGroup die Rechte, hier vorher einmal
docker run --rm -u 0 -v "$NAME-daten:/d" --entrypoint chown "$BILD" 10001:10001 /d
docker restart "$NAME" >/dev/null
i=0
until curl -fsS "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 30 ] || break
  sleep 1
done
[ "$(curl -fsS "http://127.0.0.1:$PORT/health")" = ok ] && ok "/health" || nein "/health"
[ "$(curl -fsS "http://127.0.0.1:$PORT/ready")" = bereit ] && ok "/ready" || nein "/ready"
sleep 3
m=$(curl -fsS "http://127.0.0.1:$PORT/metrics")
for w in 'vp_werkstatt_werkbank_bereit 0' 'vp_werkstatt_freigabe_laufend 0' 'vp_werkstatt_info{fassung="probe-1234"} 1' 'vp_werkstatt_lauf_aktiv 0'; do
  printf '%s\n' "$m" | grep -qF "$w" && ok "/metrics: $w" || nein "/metrics ohne $w"
done
curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && nein "Werkstatt-Anzeige auf der Betriebsseite" || ok "Werkstatt-Anzeige nicht auf der Betriebsseite"
innen=$(docker exec "$NAME" wget -qO- http://127.0.0.1:8101/zustand.json 2>/dev/null || true)
case "$innen" in *'"werkbank"'*) ok "Werkstatt-Anzeige innen auf 127.0.0.1:8101" ;; *) nein "Werkstatt-Anzeige innen: $innen" ;; esac
docker exec "$NAME" sh -c 'netstat -ltn 2>/dev/null' | grep -q '127.0.0.1:8101' && ok "Anzeige lauscht nur auf Loopback" || nein "Anzeige nicht auf Loopback"
logs=$(docker logs "$NAME" 2>&1)
printf '%s\n' "$logs" | grep -q '"message":"Werkstatt-Dienst startet' && ok "Log als JSON-Zeile" || nein "Log: $logs"
printf '%s\n' "$logs" | grep -q 'Brücke nicht bereit' && ok "Log nennt die fehlende Brücke" || nein "Log ohne Grund"
printf '%s\n' "$logs" | grep -v '^{' | grep -q . && nein "Zeile ohne JSON im Log" || ok "jede Log-Zeile ist JSON"
printf '%s\n' "$logs" | grep -q 'PRIVATE KEY' && nein "Schlüssel im Log" || ok "kein Schlüssel im Log"
docker exec "$NAME" sh -c 'touch /usr/local/bin/x' 2>/dev/null && nein "Dateisystem schreibbar" || ok "Dateisystem nur lesbar"
docker exec "$NAME" sh -c 'ls /var/lib/vp-werkstatt-dienst/laeufe' >/dev/null 2>&1 && ok "Datenverzeichnis angelegt" || nein "Datenverzeichnis"
docker stop -t 10 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep -q 'Werkstatt-Dienst beendet' && ok "beendet sich sauber bei SIGTERM" || nein "kein sauberes Ende"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$NAME-daten" >/dev/null 2>&1 || true

echo
if [ "$fehler" = 0 ]; then echo "Probe des Dienst-Bilds: alles bestanden"; else echo "Probe des Dienst-Bilds: FEHLER"; fi
exit "$fehler"
