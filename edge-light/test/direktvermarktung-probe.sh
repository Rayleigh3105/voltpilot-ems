#!/bin/sh
# Probe der Direktvermarktung Stufe 2 (vp-direktvermarktung-konzept d2,
# Abschnitte 5.4, 5.6 und 8): das ECHTE vp-edge-light auf einem OpenWrt
# 25.12.5 (procd, fw4, apk - wie die Mango), ein ECHTER OpenVPN-Tunnel zu
# einem Labor-Server, der gestellte luox (vp-luox-sim) aus diesem Repo. Ohne
# Mango, ohne luox, ohne Root auf dem Rechner - alles in Docker-Containern,
# alle Schluessel sind Wegwerf-Schluessel, nichts verlaesst die Docker-Netze
# (das Portal zeigt auf einen geschlossenen Port).
#
# Drei Container, zwei Docker-Netze:
#   wan  luox        OpenVPN-Server 10.99.0.1 (Labor-CA, tls-crypt), der
#                    PUSHT redirect-gateway, eine Route und DNS (PS-D17);
#                    vp-luox-sim liest und schreibt durch den Tunnel
#        box         OpenWrt mit openvpn-mbedtls und vp-edge-light; die
#                    Zustellung liegt als Dateien unter
#                    /etc/vp-edge-light/vermarkter (zugang.go)
#   lan  box         LAN-Seite der Box
#        lanrechner  ein Geraet im Kundennetz, das luox NIE erreichen darf
#
# Schritte und Pruefsteine:
#   1  Aufbau: Tunnel kommt, Lage tunnel_oben/verbunden; openvpn.conf ist die
#      EIGENE Konfiguration der Box (0600, route-nopull, script-security 0)
#   2  PS-D3/PS-D17: ip route unveraendert - kein redirect-gateway, keine
#      gepushte Route, kein DNS vom Partner; Zone und nft-Ketten stehen
#   3  PS-D4: der gestellte luox liest die fuenf Werte (Vorzeichen gedreht)
#      und schreibt 30 % - Lage vorgabe_aktiv, Grenze 3,6 kW von 12 kWp,
#      und der Einspeisewaechter der Box haelt genau diese Grenze
#   4  PS-D16: durch den Tunnel erreicht luox NUR <tunnel-adresse>:502 -
#      nicht SSH 22/2222, nicht 8484, nicht den lokalen Bus 1883, nicht
#      OCPP 8887, kein Ping, kein Geraet im LAN (Weiterleitung aus)
#   5  PS-D5 (verkuerzt ueber VP_VERMARKTER_LEBENSZEICHEN_S, nur kuerzen):
#      Lebenszeichen bleibt aus -> Ruhewert 100, Lage abgelaufen, Ereignis
#   6  5.6 Tunnelverlust: Server weg -> Lage tunnel_unten, Grenze faellt;
#      Server wieder da -> die Box verbindet von selbst neu
#   7  PS-D8 (Programmtausch): vp-edge-light stirbt und kommt neu - der
#      OpenVPN-Daemon laeuft durch (selbe PID), der Neue adoptiert ihn
#   8  PS-D7 (Neustart): Box-Neustart mit aktiver Vorgabe -> Register auf
#      Ruhewert, Tunnel startet mit dem System (init.d/vp-vermarkter), noch
#      BEVOR das Programm wieder laeuft
#   9  PS-D2 (RAM-Haelfte): VmRSS des OpenVPN-Prozesses und MemAvailable der
#      Box - Hinweis: hier x86/arm unter Docker, die Mango-Zahl (mipsel)
#      steht in edge-light/docs/direktvermarktung.md
#
# PS-D9 (Speicher laedt zuerst) haengt an einem geregelten Wechselrichter und
# laeuft als Go-Test der Kaskade (guards/exportcascade, agent/
# direktvermarktung_test.go); diese Probe belegt, dass die Partner-Grenze den
# Einspeisewaechter wirklich erreicht (Schritt 3).
#
#   edge-light/test/direktvermarktung-probe.sh
#   VPTD_DOCKER_DNS=1.1.1.1 ...  ohne DNS im Container (nur beim ersten Lauf:
#                                das Box-Abbild mit openvpn-mbedtls wird einmal gebaut)
#   VPDV_NETZ=172.31 ...         andere Docker-Netze (<netz>.95.0/24 und .96.0/24)
#   VPDV_BEHALTEN=1 ...          Container am Ende stehen lassen (Fehlersuche)
#   VPDV_LEBENSZEICHEN=900 ...   die volle 15-Minuten-Frist statt 90 s (Schritt 5
#                                dauert dann entsprechend)
#
# Voraussetzung: Docker; der Host stellt /dev/net/tun.
# shellcheck disable=SC2015 # ok()/falsch() schlagen nie fehl: A && ok || falsch ist if-then-else
# shellcheck disable=SC2086 # Optionslisten bewusst als Wortlisten
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
CORE="$REPO/edge-app/core"
P="vpdv-$$"
NETZ="${VPDV_NETZ:-172.31}"
WAN="$NETZ.95"
LAN="$NETZ.96"
BOX_BASIS="openwrt/rootfs:x86-64-25.12.5"
BOX_BILD="vpdv-probe:openwrt-25.12.5-openvpn"
LUOX_BILD="vpdv-probe:trixie-openvpn"
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
FRIST="${VPDV_LEBENSZEICHEN:-90}"
ARBEIT="$(mktemp -d)"
chmod 755 "$ARBEIT"
OK=0
FEHLER=0

aufraeumen() {
  if [ "${VPDV_BEHALTEN:-}" = 1 ]; then
    echo "  Container bleiben stehen: $P-luox $P-box $P-lanrechner ($ARBEIT)"
    return
  fi
  docker rm -f "$P-luox" "$P-box" "$P-lanrechner" "$P-bau" >/dev/null 2>&1 || true
  docker network rm "$P-a-wan" "$P-b-lan" >/dev/null 2>&1 || true
  rm -rf "$ARBEIT"
}
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
hinweis() { echo "  Hinweis $*"; }
schritt() { echo; echo "== $*"; }
x() { c="$1"; shift; docker exec "$P-$c" "$@"; }
xi() { c="$1"; shift; docker exec -i "$P-$c" "$@"; }
bx() { docker exec "$P-box" sh -c "$1"; }
lx() { docker exec "$P-luox" sh -c "$1"; }
# warte <sekunden> <befehl ...>: alle 0,5 s, bis der Befehl gelingt
warte() {
  w_ende=$(($(date +%s) + $1))
  shift
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(date +%s)" -lt "$w_ende" ] || return 1
    sleep 0.5
  done
}

# ── Box: Zustand lesen ───────────────────────────────────────────────────────
# dv [feld]: GET /api/direktvermarktung der Box (ihre lokale Web-App)
dv() { bx "uclient-fetch -qO- http://127.0.0.1:8484/api/direktvermarktung 2>/dev/null" || true; }
dv_hat() { dv | grep -q -- "$1"; }
lage_ist() { dv | grep -q "\"lage\":\"$1\""; }
zustand() { bx "uclient-fetch -qO- http://127.0.0.1:8484/api/state 2>/dev/null" || true; }
tunnel_adresse() { bx "ip -4 addr show dev vp_vermarkter 2>/dev/null | sed -n 's/.*inet \\([0-9.]*\\).*/\\1/p'" || true; }
openvpn_pid() { bx "cat /tmp/vp-vermarkter/openvpn.pid 2>/dev/null" || true; }
programm_an() {
  docker exec -d -e VP_DATA_DIR=/etc/vp-edge-light -e VP_PORTAL_BASE_URL=http://127.0.0.1:9 \
    -e VP_VERMARKTER_LEBENSZEICHEN_S="$FRIST" "$P-box" \
    sh -c 'exec /opt/vp/vp-edge-light >> /tmp/vp-edge-light.log 2>&1'
  warte 30 bx 'uclient-fetch -qO- http://127.0.0.1:8484/api/state | grep -q ref'
}
programm_aus() { bx 'kill $(pgrep -f "/opt/vp/vp-edge-ligh[t]") 2>/dev/null; true'; }
# Mess-Speiser: alle 10 s dieselbe Standortmessung auf den lokalen Bus, wie
# sie Layer 1 liefern wuerde (Netz -2,35 kW = Einspeisung, PV 5 kW)
speiser_an() {
  docker exec -d "$P-box" sh -c 'while :; do /opt/vp/vp-mqtt-pub -broker tcp://127.0.0.1:1883 -topic edge/telemetry \
    -payload "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"power_kw\":-2.35,\"pv_power_kw\":5.0,\"load_kw\":0.4,\"soc_pct\":55}" >/dev/null 2>&1; sleep 10; done'
}

# ── luox: Sim steuern, Zugriffe versuchen ────────────────────────────────────
sim_status() { lx "curl -s --max-time 4 http://127.0.0.1:8081/status" || true; }
sim_vorgabe() { lx "curl -s --max-time 4 -X POST -d '{\"pct\":$1}' http://127.0.0.1:8081/vorgabe"; }
sim_lebenszeichen() { lx "curl -s --max-time 4 -X POST -d '{\"aktiv\":$1}' http://127.0.0.1:8081/lebenszeichen"; }
# offen/zu <adresse> <port>: kommt von luox aus eine TCP-Verbindung zustande?
tcp_offen() { lx "timeout 4 socat -u TCP:$1:$2,connect-timeout=3 STDOUT >/dev/null 2>&1 || timeout 4 socat /dev/null TCP:$1:$2,connect-timeout=3 >/dev/null 2>&1"; }
zu() { if tcp_offen "$1" "$2"; then falsch "$3 (erreichbar!)"; else ok "$3"; fi; }

# ── Bauen ────────────────────────────────────────────────────────────────────
schritt "Bauen: vp-edge-light, vp-luox-sim, vp-mqtt-pub (linux/amd64), Abbilder"
mkdir -p "$ARBEIT/bin" "$ARBEIT/pki"
chmod 755 "$ARBEIT/bin"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e CGO_ENABLED=0 \
  -e GOFLAGS=-buildvcs=false -e GOOS=linux -e GOARCH=amd64 \
  -v "$CORE":/src:ro -v "$ARBEIT/bin":/out -w /src golang:1.24 \
  sh -c 'go build -o /out/vp-edge-light ./cmd/vp-edge-light && go build -o /out/vp-luox-sim ./cmd/vp-luox-sim && go build -o /out/vp-mqtt-pub ./cmd/vp-mqtt-pub'
if ! docker image inspect "$BOX_BILD" >/dev/null 2>&1; then
  docker run --name "$P-bau" $DNS "$BOX_BASIS" sh -c 'mkdir -p /var/lock /var/run && apk update >/dev/null 2>&1; apk add openvpn-mbedtls >/dev/null' >/dev/null
  docker commit "$P-bau" "$BOX_BILD" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
if ! docker image inspect "$LUOX_BILD" >/dev/null 2>&1; then
  docker run --name "$P-bau" $DNS debian:trixie-slim sh -c 'apt-get -qq update && DEBIAN_FRONTEND=noninteractive \
    apt-get -qq install -y --no-install-recommends openvpn openssl iproute2 socat iputils-ping procps curl ca-certificates' >/dev/null
  docker commit "$P-bau" "$LUOX_BILD" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
echo "  Abbilder $BOX_BILD und $LUOX_BILD"

# ── Aufbau ───────────────────────────────────────────────────────────────────
schritt "Aufbau: luox (WAN), Box (WAN + LAN), Kundengeraet im LAN"
docker network create --subnet "$WAN.0/24" "$P-a-wan" >/dev/null
docker network create --subnet "$LAN.0/24" "$P-b-lan" >/dev/null
docker run -d --name "$P-luox" --hostname luox --network "$P-a-wan" --ip "$WAN.10" \
  --cap-add NET_ADMIN --device /dev/net/tun -v "$ARBEIT/bin:/opt/vp:ro" "$LUOX_BILD" sleep infinity >/dev/null
docker run -d --name "$P-lanrechner" --hostname lanrechner --network "$P-b-lan" --ip "$LAN.20" \
  "$LUOX_BILD" sleep infinity >/dev/null
docker run -d --name "$P-box" --hostname box --network "$P-a-wan" --ip "$WAN.11" \
  --cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun \
  --tmpfs /tmp:exec,mode=1777 -v "$ARBEIT/bin:/opt/vp:ro" "$BOX_BILD" /sbin/init >/dev/null
docker network connect --ip "$LAN.11" "$P-b-lan" "$P-box"
warte 40 bx 'ubus call network.interface.lan status' || true
# WAN und LAN den Geraeten zuordnen, die Docker vergeben hat (nach MAC).
bn_wan="$(docker inspect "$P-box" --format "{{(index .NetworkSettings.Networks \"$P-a-wan\").MacAddress}}")"
bn_lan="$(docker inspect "$P-box" --format "{{(index .NetworkSettings.Networks \"$P-b-lan\").MacAddress}}")"
bn_wd="$(bx "grep -il '$bn_wan' /sys/class/net/eth*/address | cut -d/ -f5")"
bn_ld="$(bx "grep -il '$bn_lan' /sys/class/net/eth*/address | cut -d/ -f5")"
bx "uci -q delete network.wan6; uci -q delete network.wan; uci -q delete network.@device[0]
  uci set network.lan.device=$bn_ld; uci -q delete network.lan.ipaddr; uci add_list network.lan.ipaddr=$LAN.11/24
  uci -q delete network.lan.ip6assign
  uci set network.wan=interface; uci set network.wan.device=$bn_wd; uci set network.wan.proto=static
  uci add_list network.wan.ipaddr=$WAN.11/24; uci set network.wan.gateway=$WAN.1
  uci commit network; /etc/init.d/network restart >/dev/null 2>&1; sleep 3; /etc/init.d/firewall reload >/dev/null 2>&1; true"
warte 20 bx "ip -4 addr | grep -q '$WAN.11/'" && warte 20 bx "ip -4 addr | grep -q '$LAN.11/'" \
  && ok "Box hat WAN $WAN.11 und LAN $LAN.11" || falsch "Box hat WAN und LAN"
bx 'command -v openvpn >/dev/null && openvpn --version | head -1 | grep -qi "mbed.\{0,1\}tls"' \
  && ok "openvpn-mbedtls auf der Box: $(bx 'openvpn --version | head -1 | cut -d" " -f1-2')" \
  || falsch "openvpn-mbedtls auf der Box"
# Das Kundengeraet lauscht, damit Schritt 4 einen POSITIVEN Gegenbeweis hat.
x lanrechner sh -c "printf 'HTTP/1.0 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nkundengeraet' > /antwort"
docker exec -d "$P-lanrechner" sh -c 'exec socat TCP-LISTEN:8080,reuseaddr,fork OPEN:/antwort,rdonly'

# ── Labor-CA und Server bei luox ─────────────────────────────────────────────
schritt "Labor-luox: Wegwerf-CA, Server-Zertifikat, tls-crypt; Server PUSHT Routen (PS-D17)"
lx 'mkdir -p /pki && cd /pki &&
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.crt -days 60 -subj "/CN=vpdv-labor-ca" 2>/dev/null &&
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout server.key -out server.csr -subj "/CN=luox-labor-server" 2>/dev/null &&
  printf "extendedKeyUsage = serverAuth\nkeyUsage = digitalSignature, keyEncipherment\n" > server.ext &&
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 60 -extfile server.ext -out server.crt 2>/dev/null &&
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout anlage.key -out anlage.csr -subj "/CN=anlage-0001" 2>/dev/null &&
  printf "extendedKeyUsage = clientAuth\nkeyUsage = digitalSignature\n" > anlage.ext &&
  openssl x509 -req -in anlage.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 60 -extfile anlage.ext -out anlage.crt 2>/dev/null &&
  openvpn --genkey tls-crypt /pki/ta.key'
lx 'cat > /pki/server.conf <<EOF
dev tun0
topology subnet
server 10.99.0.0 255.255.255.0
proto udp
port 1194
ca /pki/ca.crt
cert /pki/server.crt
key /pki/server.key
dh none
tls-crypt /pki/ta.key
keepalive 10 60
push "redirect-gateway def1"
push "route 192.168.99.0 255.255.255.0"
push "dhcp-option DNS 10.99.0.1"
status /pki/server-status 5
verb 3
EOF'
server_an() { docker exec -d "$P-luox" sh -c 'openvpn --cd /pki --config /pki/server.conf --writepid /pki/server.pid --daemon vpdv-server'; }
server_aus() { lx 'kill $(cat /pki/server.pid) 2>/dev/null; rm -f /pki/server.pid; true'; }
server_an
warte 10 lx 'ip -4 addr show dev tun0 | grep -q 10.99.0.1' && ok "Labor-Server lauscht (10.99.0.1, udp 1194, tls-crypt)" || falsch "Labor-Server startet"

# ── Zustellung auf die Box legen (wie vp-dv-zustellung sie ablegt) ───────────
schritt "Zustellung: anschluss.json + Zugang unter /etc/vp-edge-light/vermarkter"
for f in ca.crt anlage.crt anlage.key ta.key; do
  docker cp -q "$P-luox:/pki/$f" "$ARBEIT/pki/$f"
done
bx 'mkdir -p /etc/vp-edge-light/vermarkter/zugang && chmod 700 /etc/vp-edge-light/vermarkter /etc/vp-edge-light/vermarkter/zugang'
xi box sh -c 'cat > /etc/vp-edge-light/vermarkter/zugang/ca.pem' <"$ARBEIT/pki/ca.crt"
xi box sh -c 'cat > /etc/vp-edge-light/vermarkter/zugang/zertifikat.pem' <"$ARBEIT/pki/anlage.crt"
xi box sh -c 'umask 077; cat > /etc/vp-edge-light/vermarkter/zugang/schluessel.pem' <"$ARBEIT/pki/anlage.key"
xi box sh -c 'umask 077; cat > /etc/vp-edge-light/vermarkter/zugang/tls.key' <"$ARBEIT/pki/ta.key"
GUELTIG="$(date -u -v+60d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+60 days' +%Y-%m-%dT%H:%M:%SZ)"
bx "cat > /etc/vp-edge-light/vermarkter/zugang/zugang.json <<EOF
{\"gegenstelle\":{\"host\":\"$WAN.10\",\"port\":1194,\"protokoll\":\"udp\"},
 \"tls_schluessel\":\"tls_crypt\",\"gueltig_bis\":\"$GUELTIG\",\"fingerabdruck\":\"labor\"}
EOF
chmod 600 /etc/vp-edge-light/vermarkter/zugang/*"
bx 'cat > /etc/vp-edge-light/vermarkter/anschluss.json <<EOF
{"partner":"luox","referenz_wp":12000}
EOF'
# Das Startskript des Systems (Tunnel startet mit dem System, Schritt 8).
xi box sh -c 'cat > /etc/init.d/vp-vermarkter && chmod 0755 /etc/init.d/vp-vermarkter && /etc/init.d/vp-vermarkter enable' \
  <"$REPO/edge-light/openwrt/files/etc/init.d/vp-vermarkter"
ok "Zustellung liegt (0600/0700), init.d/vp-vermarkter eingerichtet"

# ── 1: Aufbau des Anschlusses ────────────────────────────────────────────────
schritt "1. vp-edge-light startet, der Verwalter schreibt die Konfiguration und baut den Tunnel"
ROUTE_VORHER="$(bx 'ip route')"
programm_an && ok "vp-edge-light laeuft (Web-App :8484)" || falsch "vp-edge-light startet nicht (logs: /tmp/vp-edge-light.log)"
speiser_an
warte 60 bx 'ip -4 addr show dev vp_vermarkter | grep -q inet' \
  && ok "Tunnel oben: vp_vermarkter hat $(tunnel_adresse)" || falsch "Tunnel kommt nicht ($(dv))"
TUN="$(tunnel_adresse)"
warte 60 lage_ist tunnel_oben || warte 10 lage_ist verbunden || true
case "$(dv)" in
  *'"lage":"tunnel_oben"'* | *'"lage":"verbunden"'*) ok "Lage: $(dv | sed -n 's/.*"lage":"\([a-z_]*\)".*/\1/p')" ;;
  *) falsch "Lage nach Aufbau: $(dv)" ;;
esac
bx 'test -f /etc/vp-edge-light/vermarkter/openvpn.conf' && ok "openvpn.conf erzeugt" || falsch "openvpn.conf fehlt"
[ "$(bx 'ls -l /etc/vp-edge-light/vermarkter/openvpn.conf | cut -c1-10')" = "-rw-------" ] && ok "openvpn.conf 0600" || falsch "openvpn.conf nicht 0600"
for zeile in "route-nopull" "script-security 0" "remote-cert-tls server" "pull-filter ignore"; do
  bx "grep -q '$zeile' /etc/vp-edge-light/vermarkter/openvpn.conf" && ok "Konfiguration traegt: $zeile" || falsch "Konfiguration ohne: $zeile"
done
bx 'grep -q "von vp-edge-light erzeugt" /etc/vp-edge-light/vermarkter/openvpn.conf' \
  && ok "die EIGENE Konfiguration der Box, nie die Datei des Partners" || falsch "Konfigurations-Herkunft unklar"

# ── 2: Routen und Firewall (PS-D3, PS-D17) ───────────────────────────────────
schritt "2. PS-D3/PS-D17: gepushte Routen werden verworfen, Zone und Ketten stehen"
ROUTE_NACHHER="$(bx 'ip route')"
echo "$ROUTE_NACHHER" | grep -q '0.0.0.0/1' && falsch "redirect-gateway angenommen (0.0.0.0/1 in ip route)" || ok "kein redirect-gateway (PS-D17)"
echo "$ROUTE_NACHHER" | grep -q '192.168.99.0' && falsch "gepushte Route 192.168.99.0/24 angenommen" || ok "gepushte Route verworfen (PS-D17)"
[ "$(echo "$ROUTE_VORHER" | grep '^default')" = "$(echo "$ROUTE_NACHHER" | grep '^default')" ] \
  && ok "Standardroute unveraendert ($(echo "$ROUTE_NACHHER" | grep '^default'))" || falsch "Standardroute veraendert"
bx 'nft list chain inet fw4 vp_vermarkter_eingang 2>/dev/null | grep -q "dport 502"' \
  && ok "nft-Kette vp_vermarkter_eingang steht (nur 502 zur Tunnel-Adresse)" || falsch "nft-Kette vp_vermarkter_eingang fehlt"
bx 'nft list chain inet fw4 vp_vermarkter_weiter 2>/dev/null | grep -q drop' \
  && ok "nft-Kette vp_vermarkter_weiter steht (keine Weiterleitung)" || falsch "nft-Kette vp_vermarkter_weiter fehlt"
bx 'uci -q get firewall.vp_vermarkter.name | grep -q vermarkter' \
  && ok "fw4-Zone vermarkter eingetragen" || falsch "fw4-Zone vermarkter fehlt"

# ── 3: der gestellte luox liest und schreibt (PS-D4) ─────────────────────────
schritt "3. PS-D4: vp-luox-sim liest die Werte und schreibt 30 % - die Grenze erreicht den Waechter"
docker exec -d "$P-luox" sh -c "exec /opt/vp/vp-luox-sim -server $TUN:502 -interval 5s -http 127.0.0.1:8081 >> /tmp/sim.log 2>&1"
warte 60 lx 'curl -s --max-time 2 http://127.0.0.1:8081/status | grep -q "nvp_einspeisung_w"' \
  && ok "Sim liest durch den Tunnel" || falsch "Sim liest nicht: $(sim_status)"
sim_status | grep -q '"nvp_einspeisung_w":2350' && ok "nvp_einspeisung_w = 2350 (aus power_kw -2,35: Vorzeichen gedreht)" || falsch "nvp_einspeisung_w: $(sim_status)"
sim_status | grep -q '"erzeugung_w":5000' && ok "erzeugung_w = 5000" || falsch "erzeugung_w: $(sim_status)"
sim_status | grep -q '"referenz_w":12000' && ok "referenz_w = 12000 (aus der Zustellung)" || falsch "referenz_w: $(sim_status)"
sim_status | grep -q '"netzbetreiber_vorgabe_pct":100' && ok "netzbetreiber_vorgabe_pct = 100 (keine registrierte Grenze, F7)" || falsch "netzbetreiber_vorgabe_pct: $(sim_status)"
sim_vorgabe 30
warte 30 lage_ist vorgabe_aktiv && ok "Lage vorgabe_aktiv nach Vorgabe 30 %" || falsch "Lage nach 30 %: $(dv)"
dv_hat '"grenze_kw":3.6' && ok "Grenze 3,6 kW (30 % von 12 kWp)" || falsch "Grenze: $(dv)"
warte 30 bx 'uclient-fetch -qO- http://127.0.0.1:8484/api/state | grep -q "\"limit_kw\":3.6"' \
  && ok "Einspeisewaechter haelt 3,6 kW (export_guard im /api/state)" || falsch "Einspeisewaechter: $(zustand | grep -o '"export_guard":{[^}]*}' || echo fehlt)"

# ── 4: nichts als die Schnittstelle (PS-D16) ─────────────────────────────────
schritt "4. PS-D16: durch den Tunnel erreicht luox NUR $TUN:502"
tcp_offen "$TUN" 502 && ok "$TUN:502 antwortet (die Schnittstelle)" || falsch "$TUN:502 antwortet nicht"
zu "$TUN" 22 "SSH 22 durch den Tunnel abgewiesen"
zu "$TUN" 2222 "SSH 2222 durch den Tunnel abgewiesen"
zu "$TUN" 8484 "Web-App 8484 durch den Tunnel abgewiesen"
zu "$TUN" 1883 "lokaler Bus 1883 durch den Tunnel abgewiesen"
zu "$TUN" 8887 "OCPP 8887 durch den Tunnel abgewiesen"
lx "ping -c1 -W2 $TUN >/dev/null 2>&1" && falsch "Ping zur Box kommt an (F16: kein Ping ohne Bedarf)" || ok "kein Ping zur Box (F16)"
# Ein Geraet im Kundennetz: der Server routet das LAN bewusst in den Tunnel -
# die Box darf es NICHT weiterleiten. Vorher der Gegenbeweis aus der Box.
# nc, nicht uclient-fetch: dessen non-blocking connect verfehlt unter
# Docker-Emulation (x86-Box auf arm64) das Schreibbarkeits-Ereignis.
bx "nc $LAN.20 8080 </dev/null | grep -q kundengeraet" \
  && ok "Gegenbeweis: das Kundengeraet antwortet der Box im LAN" || falsch "Gegenbeweis: Kundengeraet antwortet der Box nicht"
lx "ip route replace $LAN.0/24 dev tun0"
zu "$LAN.20" 8080 "Kundengeraet im LAN durch den Tunnel unerreichbar (keine Weiterleitung)"
lx "ping -c1 -W2 $LAN.20 >/dev/null 2>&1" && falsch "Ping ins Kundennetz kommt an" || ok "kein Ping ins Kundennetz"
lx "ip route del $LAN.0/24 dev tun0 2>/dev/null; true"

# ── 5: Lebenszeichen laeuft ab (PS-D5, Frist $FRIST s) ───────────────────────
schritt "5. PS-D5: Lebenszeichen bleibt aus -> Ruhewert nach $FRIST s, Ereignis"
sim_lebenszeichen false
warte $((FRIST + 60)) lage_ist abgelaufen && ok "Lage abgelaufen" || falsch "Lage nach Ablauf: $(dv)"
dv_hat '"vorgabe_pct":100' && ok "Register zurueck auf Ruhewert 100" || falsch "vorgabe_pct: $(dv)"
dv | grep -q '"grenze_kw"' && falsch "Grenze steht noch: $(dv)" || ok "keine Grenze mehr (Waechter frei)"
bx 'grep -q "lebenszeichen abgelaufen" /etc/vp-edge-light/vermarkter/ereignisse' \
  && ok "Ereignisliste im Flash traegt den Ablauf" || falsch "Ereignis fehlt: $(bx 'cat /etc/vp-edge-light/vermarkter/ereignisse 2>/dev/null')"
bx 'grep -qi "schluessel\|BEGIN\|passwort" /etc/vp-edge-light/vermarkter/ereignisse' \
  && falsch "Ereignisliste traegt Geheimnisse" || ok "Ereignisliste: nie ein Schluessel"
sim_lebenszeichen true
warte 60 lage_ist vorgabe_aktiv && ok "Lebenszeichen wieder da -> Vorgabe 30 % gilt wieder" || falsch "Rueckkehr der Vorgabe: $(dv)"

# ── 6: Tunnelverlust und Rueckkehr (5.6) ─────────────────────────────────────
schritt "6. 5.6: Server weg -> tunnel_unten und Grenze faellt; Server wieder da -> neu verbunden"
server_aus
warte 240 lage_ist tunnel_unten && ok "Lage tunnel_unten nach Serververlust" || falsch "Lage nach Serververlust: $(dv)"
keine_grenze() { ! dv | grep -q '"grenze_kw"'; }
warte $((FRIST + 90)) keine_grenze \
  && ok "Grenze faellt mit dem Lebenszeichen (nie eingefroren)" \
  || falsch "Grenze ueberlebt den Tunnelverlust ueber die Frist hinaus: $(dv)"
server_an
warte 240 bx 'uclient-fetch -qO- http://127.0.0.1:8484/api/direktvermarktung | grep -qE "\"lage\":\"(tunnel_oben|verbunden|vorgabe_aktiv|abgelaufen)\""' \
  && ok "Box verbindet von selbst neu (Lage: $(dv | sed -n 's/.*"lage":"\([a-z_]*\)".*/\1/p'))" || falsch "keine Rueckkehr: $(dv)"

# ── 7: Programmtausch laesst den Tunnel stehen (PS-D8) ───────────────────────
schritt "7. PS-D8: vp-edge-light stirbt und kommt neu - der Daemon laeuft durch"
PID_VORHER="$(openvpn_pid)"
[ -n "$PID_VORHER" ] && ok "OpenVPN-Daemon laeuft (PID $PID_VORHER)" || falsch "keine OpenVPN-PID"
programm_aus
sleep 3
bx "[ -d /proc/$PID_VORHER ]" && ok "Daemon laeuft ohne das Programm weiter" || falsch "Daemon starb mit dem Programm"
programm_an && ok "vp-edge-light wieder da" || falsch "vp-edge-light kommt nicht wieder"
sleep 12
[ "$(openvpn_pid)" = "$PID_VORHER" ] && bx "[ -d /proc/$PID_VORHER ]" \
  && ok "das neue Programm adoptiert den laufenden Daemon (PID unveraendert $PID_VORHER)" \
  || falsch "Daemon wurde ersetzt (vorher $PID_VORHER, nachher $(openvpn_pid))"

# ── 8: Neustart der Box (PS-D7) ──────────────────────────────────────────────
schritt "8. PS-D7: Neustart bei aktiver Vorgabe -> Ruhewert; der Tunnel startet mit dem System"
warte 60 lage_ist vorgabe_aktiv || true
docker restart "$P-box" >/dev/null
warte 60 bx 'ubus call network.interface.lan status' || true
# Erst der Beweis, dass das SYSTEM den Tunnel bringt - das Programm laeuft noch nicht.
warte 90 sh -c "docker exec $P-box pgrep -x openvpn >/dev/null" \
  && ok "init.d/vp-vermarkter startet den Tunnel beim Booten, VOR dem Programm" || falsch "kein OpenVPN nach dem Neustart"
bx 'pgrep -f "/opt/vp/vp-edge-ligh[t]" >/dev/null' && falsch "Programm lief schon vor programm_an (Probe-Annahme verletzt)" || true
programm_an && speiser_an
warte 60 bx 'ip -4 addr show dev vp_vermarkter | grep -q inet' || true
TUN="$(tunnel_adresse)"
docker exec -d "$P-luox" sh -c "pkill -f vp-luox-si[m]; sleep 1; exec /opt/vp/vp-luox-sim -server $TUN:502 -interval 5s -http 127.0.0.1:8081 >> /tmp/sim.log 2>&1"
warte 90 lx 'curl -s --max-time 2 http://127.0.0.1:8081/status | grep -q nvp_einspeisung_w' || true
dv_hat '"vorgabe_pct":100' && ok "nach dem Neustart: Ruhewert 100, keine fortgesetzte Vorgabe" || falsch "vorgabe_pct nach Neustart: $(dv)"
dv | grep -q '"grenze_kw"' && falsch "Grenze ueberlebt den Neustart" || ok "keine Grenze aus dem Gedaechtnis"

# ── 9: RAM-Haelfte von PS-D2 ─────────────────────────────────────────────────
schritt "9. PS-D2 (RAM, hier $(docker version --format '{{.Server.Arch}}') unter Docker - Mango-Zahlen in edge-light/docs/direktvermarktung.md)"
PID="$(openvpn_pid)"
[ -n "$PID" ] && hinweis "OpenVPN $(bx "awk '/VmRSS/ {print \$2, \$3}' /proc/$PID/status") RSS; Box MemAvailable $(bx "awk '/MemAvailable/ {print \$2, \$3}' /proc/meminfo")"

echo
echo "== Ergebnis: $OK ok, $FEHLER Fehler"
[ "$FEHLER" -eq 0 ]
