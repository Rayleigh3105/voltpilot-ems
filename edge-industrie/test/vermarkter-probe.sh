#!/usr/bin/env bash
# Direktvermarktung Stufe 4 am PFC200-Doppel im Container (vp-direktvermarktung-
# konzept d2 §5.4/§8/§10): der root-Helfer vp-vermarkter, das Firmware-OpenVPN
# (Stand-in mit derselben Schnittstelle, belegt an der WAGO-Quelle), die
# Umleitung 502 -> 1502 NUR am Tunnel und die Sicherheit des Anschlusses.
#
#   PS-D14  Darf der Helfer nur das Eine? (ohne root, fremder Pfad, Zusatz)
#   Sicher scheitern: laden die Firewall-Regeln nicht, kommt der Tunnel
#           nicht hoch (und faellt, wenn er lief)
#   script-security am Build erkannt: 0 auf einem Netlink-Build (die
#           Vorgabe, Konzept §8), 1 nur auf einem iproute2-Build wie dem
#           dieser Probe; ein iproute2-Build mit Stufe 0 scheitert sichtbar
#   PS-D11  Tunnel oben, nur der eine Port offen
#   PS-D12  Umleitung (502 -> 1512) traegt nur am Tunnel; 502 an der
#           "X1/X2"-Seite bleibt bei der SPS, :1502 beim Datenspiegel; der
#           eigene Port 1512 ist von der LAN-Seite zu (unter Linux koennen
#           Wildcard-:1502 und Tunnel-Adresse:1502 nicht nebeneinander
#           lauschen - der Beleg dafuer steht mit im Lauf)
#   PS-D17  gepushte Routen und redirect-gateway werden nicht angenommen
#   PS-D5   Vorgabe laeuft mit dem Lebenszeichen ab (verkuerzte Frist)
#   §5.4    Neustart: Register auf dem Ruhewert
#   §8      Widerruf: Zugang weg -> Tunnel, Regeln und Schluessel weg
#
# Zwei Container in einem eigenen Netz: "partner" (OpenVPN-Server plus der
# gestellte luox) und "box" (der Helfer, das Firmware-OpenVPN-Stand-in, die
# SPS als Banner auf :502, der Datenspiegel als Banner auf :1502 und der echte
# Datenspiegel-Server des Partners an der Tunnel-Adresse). Die Zertifikate
# erzeugt die Probe selbst (eigene Wegwerf-CA). Regeln wie e2e-compose.sh:
# kein Bind-Mount der Arbeitskopie ins Image (Helfer und Stand-in kommen per
# docker cp), keine Anfrage ueber 127.0.0.1 des Runners - alles laeuft im
# Docker-Netz ueber Containernamen. Braucht Docker (NET_ADMIN, /dev/net/tun).
set -euo pipefail

cd "$(dirname "$0")/../.."   # Repo-Wurzel

RUN_ID="$$"
IMAGE="vp-vermarkter-test:${RUN_ID}"
NET="vp-dv-s4-${RUN_ID}"
BOX="vp-dv-box-${RUN_ID}"
PARTNER="vp-dv-partner-${RUN_ID}"
PROBE_IMAGE="${VP_E2E_PROBE_IMAGE:-python:3.12-alpine}"
PROBE=""
PKI="$(mktemp -d)"

cleanup() {
  echo "--- cleanup"
  [ -n "$PROBE" ] && docker rm -f "$PROBE" >/dev/null 2>&1
  docker rm -f "$BOX" "$PARTNER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$PKI"
  return 0
}
trap cleanup EXIT

fail() { echo "vermarkter-probe FAILED: $*" >&2; exit 1; }
box() { docker exec "$BOX" "$@"; }
partner() { docker exec "$PARTNER" "$@"; }
# status_hat <text> - prueft eine Zeile der Helfer-Status-Ausgabe (einmal
# einsammeln, dann pruefen: grep -q an der lebenden Pipe reisst sie ab, und
# docker exec endet dann mit 141).
status_hat() {
  ausgabe="$(box /etc/init.d/vp-vermarkter status || true)"
  case "$ausgabe" in *"$1"*) return 0 ;; esac
  return 1
}

echo "==> environment"
echo "    docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"

echo "==> Zertifikate (Wegwerf-CA, EC P-256; der Server traegt serverAuth fuer remote-cert-tls)"
openssl ecparam -genkey -name prime256v1 -out "$PKI/ca.key" 2>/dev/null
openssl req -x509 -new -key "$PKI/ca.key" -subj "/CN=vp-probe-ca" -days 2 -out "$PKI/ca.pem" 2>/dev/null
for wer in server client; do
  openssl ecparam -genkey -name prime256v1 -out "$PKI/$wer.key" 2>/dev/null
  openssl req -new -key "$PKI/$wer.key" -subj "/CN=vp-probe-$wer" -out "$PKI/$wer.csr" 2>/dev/null
done
printf 'extendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' >"$PKI/server.ext"
printf 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n' >"$PKI/client.ext"
openssl x509 -req -in "$PKI/server.csr" -CA "$PKI/ca.pem" -CAkey "$PKI/ca.key" -CAcreateserial \
  -days 2 -extfile "$PKI/server.ext" -out "$PKI/server.pem" 2>/dev/null
openssl x509 -req -in "$PKI/client.csr" -CA "$PKI/ca.pem" -CAkey "$PKI/ca.key" -CAcreateserial \
  -days 2 -extfile "$PKI/client.ext" -out "$PKI/client.pem" 2>/dev/null

echo "==> build (Kontext edge-app/core)"
docker build -q -f edge-industrie/test/Dockerfile.vermarkter -t "$IMAGE" edge-app/core >/dev/null \
  || fail "Image-Build fehlgeschlagen"

echo "==> Netz, Seitenwagen (LAN-Sicht), Partner und Box"
docker network create "$NET" >/dev/null || fail "Netz liess sich nicht anlegen"
docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 \
  || docker pull -q "$PROBE_IMAGE" >/dev/null \
  || fail "Seitenwagen ${PROBE_IMAGE} liess sich nicht holen"
PROBE="$(docker run -d --network "$NET" "$PROBE_IMAGE" sleep 1800)" || fail "Seitenwagen startete nicht"
docker run -d --name "$PARTNER" --network "$NET" --cap-add NET_ADMIN --device /dev/net/tun \
  "$IMAGE" sleep 1800 >/dev/null || fail "Partner startete nicht"
docker run -d --name "$BOX" --network "$NET" --cap-add NET_ADMIN --device /dev/net/tun \
  "$IMAGE" sleep 1800 >/dev/null || fail "Box startete nicht"

echo "==> Partner: OpenVPN-Server (pusht Route und redirect-gateway, die die Box ablehnen muss, PS-D17)"
docker cp "$PKI/ca.pem" "$PARTNER:/pki-ca.pem"
docker cp "$PKI/server.pem" "$PARTNER:/pki-server.pem"
docker cp "$PKI/server.key" "$PARTNER:/pki-server.key"
partner sh -c 'mkdir -p /etc/openvpn && cat >/etc/openvpn/server.conf <<KONF
dev tun
topology subnet
server 10.99.88.0 255.255.255.0
proto udp
port 1194
ca /pki-ca.pem
cert /pki-server.pem
key /pki-server.key
dh none
push "route 203.0.113.0 255.255.255.0"
push "redirect-gateway def1"
keepalive 5 30
verb 2
KONF
mkdir -p /run/openvpn
openvpn --daemon ovpn-server --writepid /run/openvpn/server.pid --config /etc/openvpn/server.conf'
sleep 1
partner sh -c 'kill -0 "$(cat /run/openvpn/server.pid)"' || fail "OpenVPN-Server laeuft nicht"

echo "==> Box: Helfer, Firmware-OpenVPN-Stand-in, SPS-Banner auf :502, Datenspiegel-Banner auf :1502 (Wildcard)"
box mkdir -p /etc/init.d
docker cp edge-industrie/files/etc/init.d/vp-vermarkter "$BOX:/etc/init.d/vp-vermarkter"
docker cp edge-industrie/test/attrappe/openvpn-init "$BOX:/etc/init.d/openvpn"
box chmod 755 /etc/init.d/vp-vermarkter /etc/init.d/openvpn
box sh -c 'mkdir -p /etc/openvpn /var/run/firewall/iptables/default'
# Die SPS haelt :502 auf allen Schnittstellen, der Datenspiegel :1502 auf
# allen - genau die Belegung des PFC200 (konfig: Spiegel fest 1502). Der
# Partner-Server bindet spaeter die TUNNEL-Adresse:1502 daneben (Koexistenz).
box sh -c 'nohup socat TCP-LISTEN:502,fork,reuseaddr SYSTEM:"echo SPS" >/dev/null 2>&1 & echo $! >/run/sps.pid'
box sh -c 'nohup socat TCP-LISTEN:1502,fork,reuseaddr SYSTEM:"echo SPIEGEL" >/dev/null 2>&1 & echo $! >/run/spiegel.pid'

echo "==> PS-D14: ohne root wird JEDER Aufruf abgelehnt; fremde Pfade und Zusaetze ebenso"
for verb in start stop status; do
  if docker exec -u voltpilot "$BOX" /etc/init.d/vp-vermarkter "$verb" >/dev/null 2>&1; then
    fail "PS-D14: '$verb' als voltpilot wurde nicht abgelehnt"
  fi
done
box /etc/init.d/vp-vermarkter kaputt >/dev/null 2>&1 && fail "PS-D14: fremdes Verb angenommen"
box /etc/init.d/vp-vermarkter start /etc/shadow >/dev/null 2>&1 && fail "PS-D14: fremder Pfad angenommen"
box /etc/init.d/vp-vermarkter >/dev/null 2>&1 && fail "PS-D14: Aufruf ohne Verb angenommen"
echo "    OK: nur root, nur start|stop|restart|status"

echo "==> Helfer ohne Zugang: start ist ein sauberer Leerlauf"
box /etc/init.d/vp-vermarkter start >/dev/null
sleep 2
status_hat "zugang=fehlt" || fail "status ohne Zugang"
box ip link show tun-vermarkter >/dev/null 2>&1 && fail "Tunnel ohne Zugang"

echo "==> Zugang zustellen (wie die Cloud-Zustellung: Dateien unter /home/voltpilot/vermarkter)"
# Davor zwei Masken fuer die Negativ-Pfade: iptables-restore scheitert, und
# die Build-Erkennung sieht einen Netlink-Build (enable_iproute2=no) wie auf
# der WAGO-Firmware. /usr/local/sbin liegt im PATH vor /sbin.
box mkdir -p /usr/local/sbin
box sh -c 'printf "#!/bin/sh\nexit 1\n" >/usr/local/sbin/iptables-restore && chmod 755 /usr/local/sbin/iptables-restore'
box sh -c 'printf "#!/bin/sh\nif [ \"\$1\" = \"--version\" ]; then echo \"OpenVPN 2.5.11 arm-wago\"; echo \"Compile time defines: enable_iproute2='no'\"; exit 0; fi\nexec /usr/sbin/openvpn \"\$@\"\n" >/usr/local/sbin/openvpn && chmod 755 /usr/local/sbin/openvpn'
box sh -c 'mkdir -p /home/voltpilot/vermarkter/zugang'
docker cp "$PKI/ca.pem" "$BOX:/home/voltpilot/vermarkter/zugang/ca.pem"
docker cp "$PKI/client.pem" "$BOX:/home/voltpilot/vermarkter/zugang/zertifikat.pem"
docker cp "$PKI/client.key" "$BOX:/home/voltpilot/vermarkter/zugang/schluessel.pem"
box sh -c "printf '%s 1194 udp\n' '$PARTNER' >/home/voltpilot/vermarkter/zugang/gegenstelle"
box sh -c 'echo luox >/home/voltpilot/vermarkter/partner'

echo "==> Sicher scheitern: iptables-restore schlaegt fehl - der Tunnel kommt NICHT hoch"
for i in $(seq 1 30); do
  box test -f /etc/openvpn/vp-vermarkter.conf && break
  [ "$i" = 30 ] && fail "Konfiguration wurde nicht geschrieben"
  sleep 1
done
sleep 22   # mindestens zwei weitere Waechter-Takte
status_hat "umleitung=fehlt" || fail "sicher scheitern: Umleitung gilt als da"
status_hat "tunnel=unten" || fail "sicher scheitern: Tunnel kam trotz fehlender Regeln hoch"
status_hat "openvpn=steht" || fail "sicher scheitern: OpenVPN laeuft trotz fehlender Regeln"
echo "    OK: ohne Regeln kein Tunnel"

echo "==> Build-Erkennung: der (vorgetaeuschte) Netlink-Build bekommt script-security 0 (Konzept §8)"
box grep -q "script-security 0" /etc/openvpn/vp-vermarkter.conf \
  || fail "Netlink-Build: script-security 0 fehlt in der Konfiguration"
echo "    OK: script-security 0 auf dem Netlink-Build"

echo "==> Falsche Stufe scheitert sichtbar: Regeln wieder ladbar, aber der echte iproute2-Build mit Stufe 0 bringt keinen Tunnel"
box rm -f /usr/local/sbin/iptables-restore
for i in $(seq 1 30); do
  status_hat "umleitung=da" && break
  [ "$i" = 30 ] && fail "Regeln kamen nach dem Demaskieren nicht"
  sleep 1
done
sleep 22
adresse_da="$(box sh -c "ip -4 addr show tun-vermarkter 2>/dev/null | grep -c inet" || true)"
[ "${adresse_da:-0}" = "0" ] || fail "iproute2-Build mit Stufe 0 bekam trotzdem eine Tunnel-Adresse"
echo "    OK: Stufe 0 auf dem iproute2-Build scheitert sichtbar (keine Tunnel-Adresse)"

echo "==> Maske weg: die Build-Erkennung sieht wieder iproute2, der Waechter schreibt Stufe 1 neu und der Tunnel kommt"
box rm -f /usr/local/sbin/openvpn

echo "==> PS-D11: der Waechter nimmt den Zugang, der Tunnel kommt"
for i in $(seq 1 30); do
  status_hat "tunnel=oben" && break
  [ "$i" = 30 ] && { box /etc/init.d/vp-vermarkter status || true; fail "Tunnel kam nicht"; }
  sleep 1
done
status_hat "umleitung=da" || fail "Umleitung fehlt"
BOXTUN="$(box sh -c "ip -4 addr show tun-vermarkter | sed -n 's/.*inet \([0-9.]*\).*/\1/p'")"
[ -n "$BOXTUN" ] || fail "Tunnel ohne Adresse"
echo "    Tunnel-Adresse der Box: $BOXTUN"

echo "==> PS-D17: gepushte Route und redirect-gateway wurden NICHT angenommen"
routen="$(box ip route)"
case "$routen" in *"203.0.113"*) fail "PS-D17: gepushte Route angenommen" ;; esac
echo "$routen" | while IFS= read -r zeile; do
  case "$zeile" in
    default*tun-vermarkter* | 0.0.0.0/1*tun-vermarkter* | 128.0.0.0/1*tun-vermarkter*)
      echo "PS-D17: redirect-gateway angenommen: $zeile" >&2
      exit 9
      ;;
  esac
done || fail "PS-D17: redirect-gateway angenommen"
box grep -q "script-security 1" /etc/openvpn/vp-vermarkter.conf || fail "script-security fehlt"
rechte="$(box sh -c 'ls -l /etc/openvpn/vp-vermarkter/schluessel.pem')"
case "$rechte" in -rw-------*) ;; *) fail "Schluessel nicht 0600: $rechte" ;; esac

echo "==> Beleg: Tunnel-Adresse:1502 NEBEN dem Wildcard-:1502 des Datenspiegels geht unter Linux NICHT (darum Port 1512)"
if docker exec -u voltpilot "$BOX" vp-direktvermarkter-server -modbus "$BOXTUN:1502" -http :8089 >/dev/null 2>&1; then
  fail "Tunnel-Adresse:1502 liess sich neben dem Wildcard-:1502 binden - Portwahl 1512 neu begruenden"
fi
echo "    OK: EADDRINUSE wie erwartet - der Partner-Server gehoert auf 1512"

echo "==> Der Partner-Server des Box-Programms lauscht an der Tunnel-Adresse:1512"
docker exec -u voltpilot -d "$BOX" vp-direktvermarkter-server \
  -modbus "$BOXTUN:1512" -http :8080 -watchdog-deadline 4s
sleep 2
zustand="$(box sh -c 'wget -qO- http://127.0.0.1:8080/zustand' || true)"
case "$zustand" in *zustand*) ;; *) fail "Server-API antwortet nicht" ;; esac

sidecar_banner() { # host port erwartet
  docker exec -i -e VP_HOST="$1" -e VP_PORT="$2" "$PROBE" python3 - <<'PY'
import os, socket
s = socket.create_connection((os.environ["VP_HOST"], int(os.environ["VP_PORT"])), timeout=5)
print(s.recv(32).decode().strip())
s.close()
PY
}

echo "==> PS-D12 (LAN-Seite): :502 bleibt bei der SPS, :1502 beim Datenspiegel, :1512 ist zu - die Umleitung traegt dort NICHT"
[ "$(sidecar_banner "$BOX" 502)" = "SPS" ] || fail "LAN :502 nicht bei der SPS"
[ "$(sidecar_banner "$BOX" 1502)" = "SPIEGEL" ] || fail "LAN :1502 nicht beim Datenspiegel"
if sidecar_banner "$BOX" 1512 >/dev/null 2>&1; then
  fail "LAN :1512 offen (der Partner-Server darf nur an der Tunnel-Adresse lauschen)"
fi

echo "==> PS-D12 (Tunnel-Seite): der gestellte luox erreicht ueber $BOXTUN:502 den Partner-Server (Umleitung auf 1512)"
partner sh -c "nohup vp-luox-sim -server $BOXTUN:502 -interval 1s -http :8081 >/dev/null 2>&1 & echo \$! >/run/luox.pid"
sidecar_json() { # url python-expr desc tries
  local url="$1" expr="$2" desc="$3" tries="${4:-20}" i=0
  while ! docker exec -i -e VP_URL="$url" -e VP_EXPR="$expr" -e VP_DESC="$desc" "$PROBE" python3 - <<'PY' 2>/tmp/vermarkter-probe-fehler
import json, os, sys, urllib.request
try:
    with urllib.request.urlopen(os.environ["VP_URL"], timeout=5) as resp:
        d = json.loads(resp.read().decode())
except Exception as e:
    print(f"{os.environ['VP_DESC']}: {e}", file=sys.stderr)
    sys.exit(1)
if not eval(os.environ["VP_EXPR"]):
    print(f"{os.environ['VP_DESC']}: {json.dumps(d)}", file=sys.stderr)
    sys.exit(1)
PY
  do
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then
      cat /tmp/vermarkter-probe-fehler >&2
      fail "$desc"
    fi
    sleep 1
  done
  echo "    OK: $desc"
}
docker exec -i -e VP_URL="http://${BOX}:8080/werte" "$PROBE" python3 - <<'PY'
import os, urllib.request
body = b'{"werte":{"nvp_einspeisung_w":2350,"erzeugung_w":3100,"netzbetreiber_vorgabe_pct":100,"referenz_w":10000}}'
urllib.request.urlopen(urllib.request.Request(os.environ["VP_URL"], data=body,
    method="POST", headers={"Content-Type": "application/json"}), timeout=5).read()
PY
sidecar_json "http://${PARTNER}:8081/status" "d['gelesen'].get('nvp_einspeisung_w') == 2350" \
  "luox liest durch den Tunnel die Messung (502 -> 1512)" 30

echo "==> PS-D13-Vorstufe: Vorgabe 30 % kommt an und wird wirksame Grenze (den Koppelbild-Wunsch mit Grund vertrag belegt der Go-Test internal/layer1 TestVermarkterBegrenztUeberDasKoppelbild)"
docker exec -i -e VP_URL="http://${PARTNER}:8081/vorgabe" "$PROBE" python3 - <<'PY'
import os, urllib.request
urllib.request.urlopen(urllib.request.Request(os.environ["VP_URL"], data=b'{"pct":30}',
    method="POST", headers={"Content-Type": "application/json"}), timeout=5).read()
PY
sidecar_json "http://${BOX}:8080/zustand" "d['zustand']=='vorgabe_aktiv' and d['vorgabe_pct']==30" \
  "Vorgabe 30 % wirksam" 20

echo "==> PS-D16-Kern: durch den Tunnel ist NUR der eine Port offen"
partner timeout 3 nc "$BOXTUN" 502 </dev/null >/dev/null 2>&1 || fail "Tunnel :502 zu (muss offen sein)"
partner timeout 3 nc "$BOXTUN" 22 </dev/null >/dev/null 2>&1 && fail "Tunnel :22 offen"
partner timeout 3 nc "$BOXTUN" 8080 </dev/null >/dev/null 2>&1 && fail "Tunnel :8080 (Server-API) offen"
BOXLAN="$(box sh -c "ip -4 addr show eth0 | sed -n 's/.*inet \([0-9.]*\).*/\1/p'")"
partner timeout 3 nc "$BOXLAN" 8080 </dev/null >/dev/null 2>&1 || true # LAN-Seite ist Kundennetz, nicht Teil dieser Pruefung
echo "    OK: Tunnel nur :502"

echo "==> PS-D5: das Lebenszeichen laeuft ab (Frist 4 s verkuerzt), die Grenze faellt auf den Ruhewert"
partner sh -c 'kill "$(cat /run/luox.pid)" 2>/dev/null' || true
sleep 6
sidecar_json "http://${BOX}:8080/zustand" "d['zustand']=='abgelaufen' and d['vorgabe_pct']==100" \
  "Ruhewert nach Ablauf" 10

echo "==> §5.4 Neustart: nach einem Neustart des Partner-Servers stehen die Register auf dem Ruhewert"
box sh -c 'pid="$(pgrep -f vp-direktvermarkter-serve[r])" && kill "$pid"' || fail "Server-PID nicht gefunden"
sleep 1
docker exec -u voltpilot -d "$BOX" vp-direktvermarkter-server \
  -modbus "$BOXTUN:1512" -http :8080 -watchdog-deadline 4s
sidecar_json "http://${BOX}:8080/zustand" "d['vorgabe_pct']==100 and d['zustand']=='wartet_auf_abfrage'" \
  "Ruhewert nach Neustart" 20

echo "==> §8 Widerruf: Zugang weg -> Tunnel, Regeln, Konfiguration und Schluessel weg"
box rm -rf /home/voltpilot/vermarkter/zugang
for i in $(seq 1 30); do
  if status_hat "tunnel=unten"; then break; fi
  [ "$i" = 30 ] && fail "Widerruf: Tunnel blieb oben"
  sleep 1
done
box test -e /etc/openvpn/vp-vermarkter.conf && fail "Widerruf: Konfiguration blieb"
box test -e /etc/openvpn/vp-vermarkter/schluessel.pem && fail "Widerruf: Schluesselkopie blieb"
box test -e /var/run/firewall/iptables/default/vp-vermarkter && fail "Widerruf: Fragment blieb"
box iptables -t nat -C PREROUTING -i tun-vermarkter -j vp_vermarkter 2>/dev/null && fail "Widerruf: Umleitung blieb"
echo "    OK: alles abgebaut"

echo "==> Helfer stop: der Waechter endet sauber"
box /etc/init.d/vp-vermarkter stop >/dev/null
status_hat "dienst=steht" || fail "Waechter steht nicht"

echo ""
echo "vermarkter-probe PASSED"
