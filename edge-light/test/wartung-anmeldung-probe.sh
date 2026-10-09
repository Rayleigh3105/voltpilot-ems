#!/bin/sh
# Probe der Anmeldung im Wartungstunnel (Fenster-Schluessel, docs/fernwartung.md):
# ECHTE SSH-Anmeldung durch einen ECHTEN WireGuard-Tunnel an einem OpenWrt 25.12
# (procd, netifd, fw4, cron, Dropbear 2025.89 wie auf der Mango), gegen den
# Tunnel-Dienst aus diesem Repo. Ohne Mango, ohne Wartungs-VM, ohne Root auf dem
# Rechner - alles in Docker-Containern, alle Schluessel sind Wegwerf-Schluessel.
#
# Sechs Container, zwei Docker-Netze:
#   wan   server     wg-wartung (10.10.16.1/20 + 10.10.32.1/24), vp-tunnel-dienst
#                    mit Schluesselausgabe auf 10.10.32.1:8022, API-Attrappe
#         box        OpenWrt, WAN-Seite; eingerichtet mit service-tunnel.sh
#         tech1      Techniker 10.10.32.3, eigener WireGuard- und RSA-Schluessel
#         tech2      Techniker 10.10.32.4, ebenso; ausserdem "Nachbar im WAN"
#   lan   box        LAN-Seite der Box
#         werkstatt  Rechner im LAN der Box: richtet die Box ueber SSH ein (Port 22,
#                    wie in der Werkstatt) und ist der "Nachbar im LAN"
#
# Schritte (0 bis 8 wie im Bericht "Anmeldung an der Box", Abschnitt 6):
#   0  heutiger Stand: Box mit dem Skript von main - Fenster offen, Ping kommt
#      an, Anmeldung "Permission denied"; Tunnel unten: 2222 im LAN offen
#   1  neues Skript ueber einen Zugang, der heute geht; Fenster oeffnen,
#      Schluessel kommt, Anmeldung gelingt, Weiterleitung durch die Anmeldung;
#      erneutes Einrichten durch den Tunnel mit dem Fenster-Schluessel
#   2  Techniker mit Zugang und Schluessel, aber ohne Fenster
#   3  Luecke in der Server-Firewall: ohne Fenster kein Fenster-Schluessel
#   4  Fenster vorzeitig geschlossen; 4b Schluessel im Fenster ersetzt, entfernt
#   5  Frist ohne Server und ohne Abholer (nur cron)
#   6  Neustart der Box mitten im Fenster
#   7  Antworten eines falschen Servers
#   8  Frist in Laufzeit der Box, nicht in Uhrzeit
#   9  der Abholer fragt nur durch den Tunnel
#   10 SSH 2222 ausserhalb des Tunnels abgewiesen - Tunnel oben und Tunnel unten,
#      mit der neuen Instanz und mit der UCI-Instanz (VP_SERVICE_SCHLUESSEL=aus)
#   11 Rueckfall, wenn die neue Instanz nicht startet; Waechter-ifup
#   12 status, sysupgrade -l, abbauen
#
#   edge-light/test/wartung-anmeldung-probe.sh
#   VPTD_DOCKER_DNS=1.1.1.1 ...   ohne DNS im Container (nur beim ersten Lauf noetig:
#                                 die Abbilder mit wireguard-tools werden einmal gebaut)
#   VPWA_NETZ=172.29 ...          andere Docker-Netze (<netz>.97.0/24 und .98.0/24)
#   VPWA_TMPFS=docker ...         Docker stellt den RAM-Bereich der Schluesseldatei;
#                                 sonst haengt ihn das Startskript der Box selbst ein
#                                 (braucht SYS_ADMIN im Container)
#   VPWA_BEHALTEN=1 ...           Container am Ende stehen lassen (Fehlersuche)
# Voraussetzung: Docker, git (fuer Schritt 0), der Host-Kernel kann WireGuard.
# shellcheck disable=SC2015 # ok()/falsch() schlagen nie fehl: A && ok || falsch ist hier if-then-else
# shellcheck disable=SC2016 # die Pruefausdruecke werten im Container aus
# shellcheck disable=SC2086 # Optionslisten bewusst als Wortlisten
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
DIENST="$REPO/services/tunnel-dienst"
P="vpwa-$$"
NETZ="${VPWA_NETZ:-172.30}"
WAN="$NETZ.97"
LAN="$NETZ.98"
BOX_BASIS="openwrt/rootfs:x86-64-25.12.5"
BOX_BILD="vpwa-probe:openwrt-25.12.5"
TECH_BILD="vpwa-probe:trixie"
ALT_STAND=20b548df2641d4abbbeecda59039b8d8567a979a # main vor den Fenster-Schluesseln der Box
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
SPORT=8022
ARBEIT="$(mktemp -d)"
chmod 755 "$ARBEIT"
OK=0
FEHLER=0

ID_BOX=b0c5a9e1-7d42-4f6b-9c1e-5a3d7f9b2c10
ID_T1=11111111-1111-4111-8111-111111111111
ID_T2=22222222-2222-4222-8222-222222222222
REF=edge-k7m2xq3

aufraeumen() {
  if [ "${VPWA_BEHALTEN:-}" = 1 ]; then
    echo "  Container bleiben stehen: $P-server $P-box $P-tech1 $P-tech2 $P-werkstatt ($ARBEIT)"
    return
  fi
  docker rm -f "$P-server" "$P-box" "$P-tech1" "$P-tech2" "$P-werkstatt" "$P-bau" >/dev/null 2>&1 || true
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
ms() { date +%s%3N; }
sek() { awk -v a="$1" 'BEGIN { printf "%.1f", a / 1000 }'; }
# warte <sekunden> <befehl ...>: alle 0,2 s, bis der Befehl gelingt
warte() {
  w_ende=$(($(ms) + $1 * 1000))
  shift
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(ms)" -lt "$w_ende" ] || return 1
    sleep 0.2
  done
}
zeit() { date -u -d "@$(($(date +%s) + $1))" +%Y-%m-%dT%H:%M:%SZ; }

# ── Server: Soll-Stand, Dienst ───────────────────────────────────────────────
# soll <ssh-schluessel von t1 oder leer> <fenster-json>
soll() {
  s1=""
  [ -z "$1" ] || s1=",\"sshPublicKey\":\"$1\""
  cat <<EOF | xi server sh -c 'cat > /srv/soll.neu && mv /srv/soll.neu /srv/soll.json'
{"version":1,"erzeugtAm":"$(zeit 0)","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24",
 "peers":[
  {"art":"box","id":"$ID_BOX","kennung":"$REF","publicKey":"$PUB_BOX","adresse":"10.10.16.2"},
  {"art":"techniker","id":"$ID_T1","kennung":"Techniker Eins","publicKey":"$PUB_T1","adresse":"10.10.32.3"$s1},
  {"art":"techniker","id":"$ID_T2","kennung":"Techniker Zwei","publicKey":"$PUB_T2","adresse":"10.10.32.4","sshPublicKey":"$SSH_T2"}],
 "fenster":[$2]}
EOF
}
# fenster <id> <techniker-id> <sekunden>
fenster() { echo "{\"id\":\"$1\",\"boxId\":\"$ID_BOX\",\"technikerId\":\"$2\",\"beginn\":\"$(zeit -5)\",\"ende\":\"$(zeit "$3")\"}"; }
api_an() {
  docker exec -d "$P-server" sh -c 'echo $$ > /srv/api.pid; exec /opt/vptd/attrappe -soll /srv/soll.json'
  sleep 1
}
# dienst_an <intervall>: Dauerlauf wie unter systemd - als nobody, nur CAP_NET_ADMIN
dienst_an() {
  docker exec -d -e VP_TUNNEL_API_URL=http://127.0.0.1:8080 -e VP_TUNNEL_TOKEN_URL=http://127.0.0.1:8080/token \
    -e VP_TUNNEL_CLIENT_SECRET_FILE=/tmp/z/secret -e VP_TUNNEL_ZUSTAND=/tmp/z -e VP_TUNNEL_INTERVALL="$1" \
    -e VP_TUNNEL_SCHLUESSEL_PORT="$SPORT" "$P-server" sh -c 'echo $$ > /srv/dienst.pid; exec setpriv --reuid=65534 \
      --regid=65534 --clear-groups --inh-caps=+net_admin --ambient-caps=+net_admin /opt/vptd/vp-tunnel-dienst lauf >>/srv/log 2>&1'
  warte 20 lauscht_server || true
}
lauscht_server() { x server sh -c "ss -ltnH | grep -q '10.10.32.1:$SPORT '"; }
dienst_aus() {
  x server sh -c '[ -s /srv/dienst.pid ] && kill "$(cat /srv/dienst.pid)" 2>/dev/null; rm -f /srv/dienst.pid; true'
  warte 10 dienst_weg || true
}
dienst_weg() { ! x server pgrep -f 'vp-tunnel-dienst' >/dev/null 2>&1; }
status_dienst() {
  docker exec -e VP_TUNNEL_ZUSTAND=/tmp/z -e VP_TUNNEL_INTERVALL=5s -e VP_TUNNEL_SCHLUESSEL_PORT="$SPORT" "$P-server" \
    /opt/vptd/vp-tunnel-dienst status 2>&1 || true
}
log_zeilen() { x server sh -c 'grep -c "" /srv/log || true'; }
im_log() { x server sh -c "tail -n +${2:-1} /srv/log | grep -c -- '$1' || true"; }
log_hat() { [ "$(im_log "$1" "${2:-1}")" -gt 0 ]; }
im_kernel() { x server sh -c "nft list set inet voltpilot_wartung fenster 2>/dev/null | grep -q '$1 . 10.10.16.2'"; }
nicht_im_kernel() { ! im_kernel "$1"; }
luecke_auf() { x server nft delete table inet voltpilot_wartung; }

# ── Box ──────────────────────────────────────────────────────────────────────
KEYS=/etc/vp-wartung/keys/authorized_keys
HOLEN=/usr/libexec/vp-wartung/schluessel-holen.sh
fenster_schluessel() { bx "grep -c 'vp-fenster:' $KEYS 2>/dev/null || true"; }
box_hat() { bx "grep -q 'vp-fenster:$1\$' $KEYS 2>/dev/null"; }
box_hat_nicht() { ! box_hat "$1"; }
box_hat_keinen() { [ "$(fenster_schluessel)" = 0 ]; }
box_hat_text() { bx "grep -q -F '$1' $KEYS 2>/dev/null"; }
tunnel_oben() { bx 'ping -c1 -W1 10.10.32.1' >/dev/null 2>&1; }
lauscht() { bx "netstat -ltn | awk -v a='$1' '\$4 == a { f = 1 } END { exit !f }'"; }
lauscht_irgendwo() { bx "netstat -ltn | awk '\$4 ~ /:2222\$/ { f = 1 } END { exit !f }'"; }
lauscht_nirgends() { ! lauscht_irgendwo; }
# [f]: sonst faende pgrep -f die eigene Befehlszeile
abholer_pid() { bx "pgrep -f 'schluessel-holen.sh lau[f]' | head -n 1"; }
abholer_laeuft() { [ -n "$(abholer_pid)" ]; }
# abholer_anhalten: SIGSTOP, aber nie mitten in einer Aenderung (Sperre frei)
abholer_anhalten() {
  i=0
  while [ "$i" -lt 20 ]; do
    bx 'kill -STOP $(pgrep -f "schluessel-holen.sh lau[f]") 2>/dev/null; pkill -f "uclient-fetc[h].*v1/schluessel" 2>/dev/null; true'
    if bx 'flock -n /tmp/vp-wartung/sperre true'; then return 0; fi
    bx 'kill -CONT $(pgrep -f "schluessel-holen.sh lau[f]") 2>/dev/null; true'
    sleep 0.3
    i=$((i + 1))
  done
  return 1
}
abholer_weiter() { bx 'kill -CONT $(pgrep -f "schluessel-holen.sh lau[f]") 2>/dev/null; true'; }
zaehler() { bx "nft list chain inet fw4 $1 2>/dev/null | sed -n 's/.*counter packets \\([0-9]*\\).*/\\1/p'"; }
# box_netz: WAN und LAN den Geraeten zuordnen, die Docker vergeben hat (nach
# MAC-Adresse). 0, wenn die Zuordnung schon stimmte.
box_netz() {
  bn_wan="$(docker inspect "$P-box" --format "{{(index .NetworkSettings.Networks \"$P-a-wan\").MacAddress}}")"
  bn_lan="$(docker inspect "$P-box" --format "{{(index .NetworkSettings.Networks \"$P-b-lan\").MacAddress}}")"
  bn_wd="$(bx "grep -il '$bn_wan' /sys/class/net/eth*/address | cut -d/ -f5")"
  bn_ld="$(bx "grep -il '$bn_lan' /sys/class/net/eth*/address | cut -d/ -f5")"
  if [ "$(bx 'uci -q get network.wan.device')" = "$bn_wd" ] && [ "$(bx 'uci -q get network.lan.device')" = "$bn_ld" ]; then return 0; fi
  bx "uci -q delete network.wan6; uci -q delete network.wan; uci -q delete network.@device[0]
    uci set network.lan.device=$bn_ld; uci -q delete network.lan.ipaddr; uci add_list network.lan.ipaddr=$LAN.11/24
    uci -q delete network.lan.ip6assign
    uci set network.wan=interface; uci set network.wan.device=$bn_wd; uci set network.wan.proto=static
    uci add_list network.wan.ipaddr=$WAN.11/24; uci set network.wan.gateway=$WAN.1
    uci commit network; /etc/init.d/network restart >/dev/null 2>&1; sleep 3; /etc/init.d/firewall reload >/dev/null 2>&1; true"
  return 1
}

# ── Techniker ────────────────────────────────────────────────────────────────
SSH_OPT="-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=4 -o IdentitiesOnly=yes -o PreferredAuthentications=publickey"
# anmelden <von> <schluesseldatei>: ANGEMELDET, ABGEWIESEN (Permission denied),
# KEINE-VERBINDUNG (Zeitueberschreitung) oder der Text von ssh
anmelden() {
  a_aus="$(docker exec "$P-$1" ssh $SSH_OPT -i "$2" -p 2222 root@10.10.16.2 'cat /etc/vp-edge-light/ref' 2>&1 | tr -d '\r' | tail -n 1 || true)"
  case "$a_aus" in
    "$REF") echo ANGEMELDET ;;
    *"Permission denied (publickey)"*) echo ABGEWIESEN ;;
    *"timed out"*) echo KEINE-VERBINDUNG ;;
    *) echo "$a_aus" ;;
  esac
}
# erwarte <von> <schluesseldatei> <ergebnis> <beschreibung>
erwarte() {
  e_ist="$(anmelden "$1" "$2")"
  if [ "$e_ist" = "$3" ]; then ok "$4: $e_ist"; else falsch "$4 (erwartet $3, ist: $e_ist)"; fi
}
# banner <von> <ip> <port>: die ersten Zeichen der Gegenseite, leer ohne Verbindung
banner() { docker exec "$P-$1" sh -c "timeout 4 socat -u TCP:$2:$3,connect-timeout=2 STDOUT 2>/dev/null | head -c 12" 2>/dev/null || true; }
offen() { [ "$(banner "$1" "$2" "$3")" = "SSH-2.0-drop" ] && ok "$4" || falsch "$4"; }
zu() { [ -z "$(banner "$1" "$2" "$3")" ] && ok "$4" || falsch "$4"; }
# einrichten <von> <ziel> [VAR=wert ...]: service-tunnel.sh ueber echtes ssh
SKRIPT=/skript/service-tunnel.sh
einrichten() {
  e_von="$1"; e_ziel="$2"; shift 2
  e_env=""
  for e in "$@"; do e_env="$e_env -e $e"; done
  docker exec -e VP_SERVICE_PUBKEY="$PUB_SERVER" -e VP_SERVICE_ENDPOINT="$WAN.10" $e_env "$P-$e_von" "$SKRIPT" "$e_ziel" 10.10.16.2
}
tunnel() { docker exec "$P-werkstatt" /skript/service-tunnel.sh "root@$LAN.11" "$@"; }

# ── Bauen ────────────────────────────────────────────────────────────────────
schritt "Bauen: Tunnel-Dienst aus diesem Repo, Abbilder"
mkdir -p "$ARBEIT/bin" "$ARBEIT/alt/files/usr/libexec/vp-edge-light"
chmod 755 "$ARBEIT/bin"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
  -v "$DIENST":/src:ro -v "$ARBEIT/bin":/out -w /src golang:1.24 \
  sh -c 'go build -ldflags "-X main.version=probe-anmeldung" -o /out/vp-tunnel-dienst ./cmd/vp-tunnel-dienst && go build -o /out/attrappe ./test/attrappe'
if ! docker image inspect "$BOX_BILD" >/dev/null 2>&1; then
  # OpenWrt mit wireguard-tools aus dem Paketarchiv (Kernel-WireGuard liefert der Host).
  docker run --name "$P-bau" $DNS "$BOX_BASIS" sh -c 'mkdir -p /var/lock /var/run && apk update >/dev/null 2>&1; apk add wireguard-tools >/dev/null' >/dev/null
  docker commit "$P-bau" "$BOX_BILD" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
if ! docker image inspect "$TECH_BILD" >/dev/null 2>&1; then
  docker run --name "$P-bau" $DNS debian:trixie-slim sh -c 'apt-get -qq update && DEBIAN_FRONTEND=noninteractive \
    apt-get -qq install -y --no-install-recommends wireguard-tools nftables iproute2 socat iputils-ping procps util-linux openssh-client' >/dev/null
  docker commit "$P-bau" "$TECH_BILD" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
# Das Skript von main vor dieser Aenderung, fuer den "heutigen Stand".
ALT=nein
if git -C "$REPO" cat-file -e "$ALT_STAND:edge-light/openwrt/service-tunnel.sh" 2>/dev/null; then
  git -C "$REPO" show "$ALT_STAND:edge-light/openwrt/service-tunnel.sh" >"$ARBEIT/alt/service-tunnel.sh"
  git -C "$REPO" show "$ALT_STAND:edge-light/openwrt/files/usr/libexec/vp-edge-light/service-tunnel-watch.sh" \
    >"$ARBEIT/alt/files/usr/libexec/vp-edge-light/service-tunnel-watch.sh"
  chmod 755 "$ARBEIT/alt/service-tunnel.sh"
  ALT=ja
fi
echo "  Abbilder $BOX_BILD und $TECH_BILD, Skript von main ($ALT_STAND): $ALT"

# ── Aufbau ───────────────────────────────────────────────────────────────────
schritt "Aufbau: Server, Box (WAN + LAN), zwei Techniker, Werkstatt-Rechner im LAN"
# Die Namen in dieser Reihenfolge: Docker ordnet die Netz-Geraete eines Containers
# beim Neustart nach dem Namen des Netzes - so bleibt eth0 das WAN.
docker network create --subnet "$WAN.0/24" "$P-a-wan" >/dev/null
docker network create --subnet "$LAN.0/24" "$P-b-lan" >/dev/null
starte() { # starte <name> <netz> <ip> [docker-optionen]
  n="$1"; netz="$2"; ip="$3"; shift 3
  docker run -d --name "$P-$n" --hostname "$n" --network "$P-$netz" --ip "$ip" --cap-add NET_ADMIN "$@" \
    -v "$REPO/edge-light/openwrt:/skript:ro" -v "$ARBEIT/alt:/alt:ro" "$TECH_BILD" sleep infinity >/dev/null
  x "$n" sh -c 'umask 077; wg genkey > /k; wg pubkey < /k > /p; mkdir -p /root/.ssh
    printf "Host *\n  BatchMode yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n  ConnectTimeout 5\nHost box-tunnel\n  HostName 10.10.16.2\n  Port 2222\n  User root\n  IdentitiesOnly yes\n" > /root/.ssh/config'
}
starte server a-wan "$WAN.10" --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.send_redirects=0 -v "$ARBEIT/bin:/opt/vptd:ro"
starte tech1 a-wan "$WAN.13"
starte tech2 a-wan "$WAN.14"
starte werkstatt b-lan "$LAN.20"
BOX_OPT="--cap-add SYS_ADMIN --security-opt apparmor=unconfined"
[ "${VPWA_TMPFS:-}" != docker ] || BOX_OPT="--tmpfs /etc/vp-wartung/keys:mode=0700,size=128k"
docker run -d --name "$P-box" --hostname box --network "$P-a-wan" --ip "$WAN.11" --cap-add NET_ADMIN --cap-add NET_RAW $BOX_OPT \
  --tmpfs /tmp:exec,mode=1777 "$BOX_BILD" /sbin/init >/dev/null
docker network connect --ip "$LAN.11" "$P-b-lan" "$P-box"
warte 40 bx 'ubus call network.interface.lan status' || true
box_netz || true
warte 20 bx "ip -4 addr | grep -q '$LAN.11/'" && warte 20 bx "ip -4 addr | grep -q '$WAN.11/'" && ok "Box hat WAN $WAN.11 und LAN $LAN.11" || falsch "Box hat WAN und LAN"
bx "mkdir -p /etc/vp-edge-light && echo $REF > /etc/vp-edge-light/ref"
bx 'grep -q "DISTRIB_RELEASE=.25\.12" /etc/openwrt_release && dropbear -V 2>&1 | grep -q "v2025\.89"' && ok "OpenWrt 25.12 mit Dropbear 2025.89" || falsch "OpenWrt 25.12 mit Dropbear 2025.89"
bx 'command -v uclient-fetch >/dev/null && ! command -v wget-ssl >/dev/null' && ok "Abholen mit uclient-fetch, wie auf der Mango" || falsch "uclient-fetch vorhanden"

PUB_SERVER="$(x server cat /p)"; PUB_T1="$(x tech1 cat /p)"; PUB_T2="$(x tech2 cat /p)"
x server sh -c 'ip link add wg-wartung type wireguard && wg set wg-wartung private-key /k listen-port 51820 &&
  ip addr add 10.10.16.1/20 dev wg-wartung && ip addr add 10.10.32.1/24 dev wg-wartung && ip link set wg-wartung up
  mkdir -p /srv/falsch /tmp/z && : > /srv/log && echo probe-geheim > /tmp/z/secret && chown -R 65534:65534 /tmp/z && chmod 600 /tmp/z/secret'
techniker() { # techniker <name> <adresse>
  x "$1" sh -c "ip link add wg0 type wireguard && wg set wg0 private-key /k peer $PUB_SERVER endpoint $WAN.10:51820 \
    allowed-ips 10.10.16.0/20 persistent-keepalive 5 && ip addr add $2/32 dev wg0 && ip link set wg0 up && ip route add 10.10.16.0/20 dev wg0
    ssh-keygen -q -t rsa -b 3072 -N '' -C '$1' -f /root/.ssh/id_rsa"
}
techniker tech1 10.10.32.3
techniker tech2 10.10.32.4
x tech1 ssh-keygen -q -t rsa -b 2048 -N '' -C tech1-neu -f /root/.ssh/id_rsa_neu
x werkstatt ssh-keygen -q -t rsa -b 3072 -N '' -C werkstatt -f /root/.ssh/id_rsa_werkstatt
# Normalform wie im Portal: "ssh-rsa <base64>", ohne Kommentar
SSH_T1="$(x tech1 awk '{ print $1 " " $2 }' /root/.ssh/id_rsa.pub)"
SSH_T1N="$(x tech1 awk '{ print $1 " " $2 }' /root/.ssh/id_rsa_neu.pub)"
SSH_T2="$(x tech2 awk '{ print $1 " " $2 }' /root/.ssh/id_rsa.pub)"
# Der dauerhafte Schluessel der Werkstatt liegt fuer Schritt 3 auch bei Techniker 2.
x werkstatt cat /root/.ssh/id_rsa_werkstatt | xi tech2 sh -c 'umask 077; cat > /root/.ssh/id_rsa_werkstatt'

# ── 0 ────────────────────────────────────────────────────────────────────────
schritt "0. Heutiger Stand: Box mit dem Skript von main, kein Schluessel auf der Box"
[ "$(x werkstatt ssh "root@$LAN.11" 'cat /etc/vp-edge-light/ref' 2>/dev/null)" = "$REF" ] &&
  ok "Werkstatt erreicht die Box im LAN (ssh, Port 22, wie eine frische Box ohne Root-Passwort)" || falsch "Werkstatt erreicht die Box im LAN"
AUS="$(tunnel key 2>&1)"
PUB_BOX="$(printf '%s\n' "$AUS" | sed -n '/^oeffentlicher Schluessel/{n;p;}')"
[ "${#PUB_BOX}" = 44 ] && ok "key: Schluessel auf der Box erzeugt, Referenz $(printf '%s\n' "$AUS" | sed -n 's/^Box-Referenz: //p')" || falsch "key liefert den oeffentlichen Schluessel"
soll "$SSH_T1" ""
api_an
dienst_an 5s
if [ "$ALT" = ja ]; then
  SKRIPT=/alt/service-tunnel.sh
  einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.0" 2>&1 && ok "Tunnel mit dem Skript von main eingerichtet" || falsch "Tunnel mit dem Skript von main eingerichtet"
  SKRIPT=/skript/service-tunnel.sh
else
  hinweis "Skript von main nicht im git-Verlauf: Schritt 0 mit VP_SERVICE_SCHLUESSEL=aus (dieselbe UCI-Instanz)"
  einrichten werkstatt "root@$LAN.11" VP_SERVICE_SCHLUESSEL=aus >"$ARBEIT/einrichten.0" 2>&1 && ok "Tunnel ohne Fenster-Schluessel eingerichtet" || falsch "Tunnel ohne Fenster-Schluessel eingerichtet"
fi
warte 30 tunnel_oben && ok "Tunnel steht (Box erreicht 10.10.32.1 mit Ping)" || falsch "Tunnel steht"
bx '[ "$(uci -q get dropbear.vp_wartung.Interface)" = wg_wartung ] && [ ! -e /etc/init.d/vp-wartung ]' && ok "UCI-Instanz dropbear.vp_wartung, kein Abholer" || falsch "UCI-Instanz dropbear.vp_wartung, kein Abholer"
bx '[ ! -s /etc/dropbear/authorized_keys ]' && ok "/etc/dropbear/authorized_keys fehlt oder ist leer" || falsch "/etc/dropbear/authorized_keys fehlt oder ist leer"
erwarte tech1 /root/.ssh/id_rsa KEINE-VERBINDUNG "ohne Fenster: tech1 -> Box"
soll "$SSH_T1" "$(fenster f0 "$ID_T1" 600)"
warte 15 im_kernel 10.10.32.3 && ok "Fenster tech1 -> Box im Kernel des Servers" || falsch "Fenster im Kernel des Servers"
x tech1 ping -c1 -W2 10.10.16.2 >/dev/null 2>&1 && ok "im Fenster: Ping tech1 -> Box kommt an" || falsch "im Fenster: Ping tech1 -> Box"
sleep 6
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "im Fenster, SSH-Schluessel steht am Zugang: tech1 -> Box"
status_dienst | grep "$REF" | grep -q "seit dem Start nicht gefragt" || falsch "die Box ohne neues Skript fragt den Server nie (status des Dienstes)"
status_dienst | grep "$REF" | grep -q "zuletzt gefragt" && falsch "die Box ohne neues Skript fragt den Server nie" || ok "die Box ohne neues Skript fragt den Server nie (status des Dienstes)"
if [ "$ALT" = ja ]; then
  # Befund aus der Folgearbeit am Wartungstunnel: Tunnel unten, 2222 auf allen Adressen.
  bx 'ifdown wg_wartung'
  warte 15 lauscht 0.0.0.0:2222 && ok "Tunnel unten: Dropbear 2222 lauscht auf allen Adressen" || falsch "Tunnel unten: Dropbear 2222 lauscht auf allen Adressen"
  offen werkstatt "$LAN.11" 2222 "… und ist aus dem LAN erreichbar (das stellt diese Aenderung ab)"
  zu tech2 "$WAN.11" 2222 "… aus dem WAN nicht (die WAN-Zone weist ab)"
  bx 'ifup wg_wartung'
  warte 30 tunnel_oben || falsch "Tunnel wieder oben"
fi
soll "$SSH_T1" ""
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster wieder geschlossen"

# ── 1 ────────────────────────────────────────────────────────────────────────
schritt "1. Neues Skript ueber einen Zugang, der heute geht; Fenster oeffnen, anmelden"
# Ein dauerhafter Schluessel, wie ihn die Werkstatt heute eintraegt (Uebergang).
x werkstatt cat /root/.ssh/id_rsa_werkstatt.pub | xi werkstatt ssh "root@$LAN.11" 'cat >> /etc/dropbear/authorized_keys'
SUMME_DAUER="$(bx 'md5sum < /etc/dropbear/authorized_keys')"
IFINDEX="$(bx 'cat /sys/class/net/wg_wartung/ifindex')"
einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.1" 2>&1 && ok "service-tunnel.sh von heute laeuft durch" || falsch "service-tunnel.sh von heute laeuft durch"
grep -q 'Tunnel unveraendert' "$ARBEIT/einrichten.1" && [ "$(bx 'cat /sys/class/net/wg_wartung/ifindex')" = "$IFINDEX" ] &&
  ok "der Tunnel selbst wird dabei nicht angefasst" || falsch "der Tunnel selbst wird dabei nicht angefasst"
bx '! uci -q get dropbear.vp_wartung' && ok "UCI-Instanz dropbear.vp_wartung abgeloest" || falsch "UCI-Instanz dropbear.vp_wartung abgeloest"
lauscht 10.10.16.2:2222 && [ "$(bx 'netstat -ltn | grep -c ":2222 "')" = 1 ] && ok "2222 lauscht nur auf der Tunnel-Adresse" || falsch "2222 lauscht nur auf der Tunnel-Adresse"
bx 'tr "\0" " " < /proc/$(cat /var/run/dropbear.vp_wartung.pid)/cmdline | grep -q "dropbear -F -s -g .*-D /etc/vp-wartung/keys .*-p 10.10.16.2:2222"' && ok "Dropbear im Tunnel: nur Schluessel (-s -g), eigene Schluesseldatei (-D)" || falsch "Dropbear im Tunnel mit -D"
abholer_laeuft && ok "Abholer laeuft als Dauerdienst" || falsch "Abholer laeuft als Dauerdienst"
if [ "${VPWA_TMPFS:-}" = docker ]; then
  hinweis "RAM-Bereich der Schluesseldatei von Docker gestellt (VPWA_TMPFS=docker) - das Einhaengen durch das Startskript ist so NICHT geprueft"
else
  bx 'grep -q "^vp-wartung /etc/vp-wartung/keys tmpfs .*size=128k,mode=700" /proc/mounts' && ok "das Startskript hat den RAM-Bereich selbst eingehaengt (tmpfs, 128k, nur root)" || falsch "RAM-Bereich eingehaengt"
fi
bx "ls -ld /etc/vp-wartung /etc/vp-wartung/keys $KEYS | awk '{ print \$1 }' | tr '\n' ' '" | grep -q '^drwx------ drwx------ -rw------- $' && ok "Verzeichnisse und Schluesseldatei nur fuer root" || falsch "Verzeichnisse und Schluesseldatei nur fuer root"
bx 'grep -c "schluessel-holen.sh frist # vp-wartung-frist$" /etc/crontabs/root' | grep -qx 1 && bx 'pgrep crond >/dev/null' && ok "cron-Zeile fuer die Frist, cron laeuft" || falsch "cron-Zeile fuer die Frist"
bx "grep -c 'ssh-rsa' $KEYS" | grep -qx 1 && bx "grep -q ' werkstatt\$' $KEYS" && ok "der dauerhafte Schluessel gilt im Tunnel weiter (steht in der Schluesseldatei)" || falsch "dauerhafter Schluessel in der Schluesseldatei"
[ "$(bx 'md5sum < /etc/dropbear/authorized_keys')" = "$SUMME_DAUER" ] && ok "/etc/dropbear/authorized_keys unveraendert" || falsch "/etc/dropbear/authorized_keys unveraendert"
grep -q 'Wartungsserver:     antwortet' "$ARBEIT/einrichten.1" && ok "Abschluss: der Wartungsserver antwortet" || falsch "Abschluss: der Wartungsserver antwortet"
grep -q "im offenen Fenster: der SSH-Schluessel, der im Portal am Techniker-Zugang hinterlegt ist" "$ARBEIT/einrichten.1" &&
  grep -q "ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2" "$ARBEIT/einrichten.1" &&
  grep -q "dauerhaft:          1 Schluessel aus /etc/dropbear/authorized_keys" "$ARBEIT/einrichten.1" &&
  ok "Abschluss sagt, wie man sich anmeldet" || falsch "Abschluss sagt, wie man sich anmeldet"
sed -n '/^Anmeldung im Tunnel/,$p' "$ARBEIT/einrichten.1" | sed 's/^/    | /'
sleep 2
status_dienst | grep "$REF" | grep -q "zuletzt gefragt vor [0-9]*s, 0 Schlüssel" && ok "der Dienst sieht die Anfrage der Box (uclient-fetch gegen den echten Dienst)" || falsch "der Dienst sieht die Anfrage der Box"
x werkstatt ssh "root@$LAN.11" 'echo lan' 2>/dev/null | grep -qx lan && ok "Anmeldung im LAN (Port 22) unveraendert" || falsch "Anmeldung im LAN (Port 22) unveraendert"

erwarte tech1 /root/.ssh/id_rsa KEINE-VERBINDUNG "vorher, ohne Fenster: tech1 -> Box"
T0="$(ms)"
soll "$SSH_T1" "$(fenster f1 "$ID_T1" 600)"
warte 15 im_kernel 10.10.32.3 || falsch "Fenster im Kernel"
T1="$(ms)"
warte 15 box_hat "$ID_T1" && ok "Fenster-Schluessel auf der Box" || falsch "Fenster-Schluessel auf der Box"
T2="$(ms)"
echo "  Soll-Stand geaendert -> Fenster im Kernel des Servers: $(sek $((T1 - T0))) s (Abruf im Versuch alle 5 s, im Betrieb 30 s)"
echo "  Fenster im Kernel -> Schluessel auf der Box:           $(sek $((T2 - T1))) s"
[ $((T2 - T1)) -le 3000 ] && ok "die offene Anfrage wird sofort beantwortet (uclient-fetch haelt die Verbindung)" || falsch "die offene Anfrage wird sofort beantwortet ($(sek $((T2 - T1))) s)"
echo "  Schluesseldatei der Wartungs-Instanz (RAM):"
bx "awk '/^ssh-/ { print \"    \" \$1, substr(\$2, 1, 16) \"…\", \$3 }' $KEYS"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 -> Box mit dem Schluessel aus dem Portal"
docker exec -d "$P-tech1" ssh $SSH_OPT -i /root/.ssh/id_rsa -p 2222 -N -L 127.0.0.1:18022:127.0.0.1:22 root@10.10.16.2
sleep 2
[ "$(banner tech1 127.0.0.1 18022)" = "SSH-2.0-drop" ] && ok "Weiterleitung durch die Anmeldung (-L; im Versuch Port 22 der Box statt 8484)" || falsch "Weiterleitung durch die Anmeldung (-L)"
x tech1 sh -c 'pkill -f "1802[2]"; true'
bx "logread -e vp-wartung | grep -q 'Fenster-Schluessel jetzt: $ID_T1'" && ok "Box-Log: wann welcher Fenster-Schluessel kam (Zugang, kein Schluessel)" || falsch "Box-Log nennt den Fenster-Schluessel"
bx "logread -e dropbear | grep -q \"Pubkey auth succeeded for 'root' with ssh-rsa key SHA256:.* from 10.10.32.3\"" && ok "Box-Log: Anmeldung mit Fingerabdruck und Absender" || falsch "Box-Log: Anmeldung mit Fingerabdruck und Absender"
[ "$(im_log 'msg="Schlüssel ausgegeben" box=10.10.16.2')" -ge 1 ] && ok "Journal des Dienstes: Schluessel an die Box ausgegeben" || falsch "Journal des Dienstes: Schluessel ausgegeben"
# Erneut einrichten - durch den Tunnel, angemeldet mit dem Fenster-Schluessel.
PID_ALT="$(bx 'cat /var/run/dropbear.vp_wartung.pid')"
if docker exec -e VP_SSH_KEY=/root/.ssh/id_rsa -e VP_SERVICE_PUBKEY="$PUB_SERVER" -e VP_SERVICE_ENDPOINT="$WAN.10" "$P-tech1" \
  /skript/service-tunnel.sh box-tunnel 10.10.16.2 >"$ARBEIT/einrichten.1b" 2>&1; then
  ok "erneutes Einrichten durch den Tunnel, angemeldet mit dem Fenster-Schluessel"
else
  falsch "erneutes Einrichten durch den Tunnel"
fi
grep -q 'Wartungsserver:     antwortet' "$ARBEIT/einrichten.1b" && [ "$(bx 'cat /var/run/dropbear.vp_wartung.pid')" != "$PID_ALT" ] &&
  ok "die Sitzung uebersteht den Neustart der Anmelde-Instanz (Skript laeuft bis zur letzten Zeile)" || falsch "die Sitzung uebersteht den Neustart der Anmelde-Instanz"
warte 10 box_hat "$ID_T1" || true
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "danach: tech1 -> Box"

# ── 2 ────────────────────────────────────────────────────────────────────────
schritt "2. Techniker 2 hat Zugang und SSH-Schluessel im Portal, aber KEIN Fenster"
erwarte tech2 /root/.ssh/id_rsa KEINE-VERBINDUNG "tech2 -> Box"
box_hat_nicht "$ID_T2" && ok "sein Schluessel liegt nicht auf der Box" || falsch "sein Schluessel liegt nicht auf der Box"

# ── 3 ────────────────────────────────────────────────────────────────────────
schritt "3. Luecke in der Server-Firewall (Tabelle des Dienstes weg, bis er sie neu laedt)"
dienst_aus
dienst_an 40s
warte 20 box_hat "$ID_T1" || falsch "Schluessel von tech1 liegt weiter auf der Box"
sleep 3
N0="$(log_zeilen)"
luecke_auf
x server nft list table inet voltpilot_wartung >/dev/null 2>&1 && falsch "Tabelle voltpilot_wartung ist weg" || ok "Tabelle voltpilot_wartung ist weg: die Weiterleitung filtert nichts mehr"
offen tech2 10.10.16.2 2222 "tech2 (kein Fenster) erreicht jetzt den Port"
erwarte tech2 /root/.ssh/id_rsa ABGEWIESEN "tech2 mit seinem eigenen Schluessel (steht im Portal)"
erwarte tech2 /root/.ssh/id_rsa_werkstatt ANGEMELDET "tech2 mit einem DAUERHAFT hinterlegten Schluessel (werkstatt)"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 (Fenster laeuft noch)"
A503="$(bx "uclient-fetch --no-proxy -T 5 -O - 'http://10.10.32.1:$SPORT/v1/schluessel?warte=0&stand=' 2>&1 || true")"
case "$A503" in *"HTTP error 503"*) ok "Schluesselausgabe ohne Tabelle: HTTP 503, keine Liste" ;; *) falsch "Schluesselausgabe ohne Tabelle: HTTP 503 (ist: $A503)" ;; esac
bx "$HOLEN einmal" >/dev/null 2>&1 && falsch "die Box uebernimmt daraus nichts" || ok "die Box uebernimmt daraus nichts (einmal meldet einen Fehler)"
box_hat "$ID_T1" && ok "… und behaelt, was sie hat, bis zur Frist" || falsch "… und behaelt, was sie hat, bis zur Frist"
warte 60 log_hat 'Firewall-Basis geladen' "$((N0 + 1))" && ok "der Dienst laedt die Basis beim naechsten Abruf neu" || falsch "der Dienst laedt die Basis beim naechsten Abruf neu"
sleep 1
zu tech2 10.10.16.2 2222 "danach erreicht tech2 den Port nicht mehr"

# ── 4 ────────────────────────────────────────────────────────────────────────
schritt "4. Fenster wird im Portal vorzeitig geschlossen"
dienst_aus
dienst_an 5s
warte 20 box_hat "$ID_T1" || falsch "Schluessel von tech1 liegt auf der Box"
docker exec -d "$P-tech1" sh -c "ssh $SSH_OPT -i /root/.ssh/id_rsa -p 2222 root@10.10.16.2 'while :; do echo zeile; sleep 1; done' > /tmp/sitzung 2>&1"
sleep 4
A="$(x tech1 sh -c 'wc -l < /tmp/sitzung')"
[ "$A" -ge 2 ] && ok "laufende Sitzung von tech1: $A Zeilen" || falsch "laufende Sitzung von tech1 ($A Zeilen)"
T0="$(ms)"
soll "$SSH_T1" ""
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Element im Kernel weg"
T1="$(ms)"
warte 15 box_hat_keinen && ok "Fenster-Schluessel von der Box gestrichen" || falsch "Fenster-Schluessel von der Box gestrichen"
T2="$(ms)"
echo "  Soll-Stand ohne Fenster -> Element im Kernel weg: $(sek $((T1 - T0))) s;  danach Schluessel von der Box weg: $(sek $((T2 - T1))) s"
[ $((T2 - T1)) -le 3000 ] && ok "… ohne auf die Frist zu warten (Frist waere in rund 9 min)" || falsch "… ohne auf die Frist zu warten ($(sek $((T2 - T1))) s)"
A="$(x tech1 sh -c 'wc -l < /tmp/sitzung')"; sleep 4; B="$(x tech1 sh -c 'wc -l < /tmp/sitzung')"
[ "$A" = "$B" ] && ok "laufende Sitzung abgerissen ($A = $B Zeilen)" || falsch "laufende Sitzung abgerissen ($A -> $B Zeilen)"
x tech1 sh -c 'pkill -f "zeil[e]"; true'
erwarte tech1 /root/.ssh/id_rsa KEINE-VERBINDUNG "tech1 neu"
# Gegenprobe, ob der Schluessel wirklich weg ist: Luecke wie in Schritt 3.
dienst_aus
luecke_auf
offen tech1 10.10.16.2 2222 "Gegenprobe (Luecke): tech1 erreicht den Port"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "Gegenprobe (Luecke): tech1 meldet sich an"
dienst_an 5s

schritt "4b. SSH-Schluessel im offenen Fenster ersetzt, dann entfernt"
G1="$(fenster f4 "$ID_T1" 600)"
soll "$SSH_T1" "$G1"
warte 20 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
ALT_TEXT="$(printf '%s' "${SSH_T1#ssh-rsa }" | cut -c 60-120)"
NEU_TEXT="$(printf '%s' "${SSH_T1N#ssh-rsa }" | cut -c 60-120)"
box_hat_text "$ALT_TEXT" || falsch "der bisherige Schluessel liegt auf der Box"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 mit dem bisherigen Schluessel"
T0="$(ms)"
soll "$SSH_T1N" "$G1"
warte 15 box_hat_text "$NEU_TEXT" && ok "der neue Schluessel liegt auf der Box" || falsch "der neue Schluessel liegt auf der Box"
T1="$(ms)"
box_hat_text "$ALT_TEXT" && falsch "der ersetzte Schluessel ist gestrichen" || ok "der ersetzte Schluessel ist gestrichen, $(sek $((T1 - T0))) s nach der Aenderung im Soll-Stand (Frist waere in rund 10 min)"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "tech1 mit dem ersetzten Schluessel"
erwarte tech1 /root/.ssh/id_rsa_neu ANGEMELDET "tech1 mit dem neuen Schluessel"
soll "" "$G1"
warte 15 box_hat_keinen && ok "Schluessel am Zugang entfernt: von der Box gestrichen" || falsch "Schluessel am Zugang entfernt: von der Box gestrichen"
offen tech1 10.10.16.2 2222 "das Fenster selbst bleibt offen (Netzweg)"
erwarte tech1 /root/.ssh/id_rsa_neu ABGEWIESEN "tech1 mit dem entfernten Schluessel"
soll "$SSH_T1" ""
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster geschlossen"

# ── 5 ────────────────────────────────────────────────────────────────────────
schritt "5. Frist ohne Server und ohne Abholer: Fenster 75 s, es bleibt nur der cron-Lauf"
# Nebenbei: ein neuer dauerhafter Schluessel gilt im Tunnel ohne weiteres Zutun.
x werkstatt sh -c 'ssh-keygen -q -t rsa -b 2048 -N "" -C dauerhaft2 -f /tmp/dauerhaft2 && cat /tmp/dauerhaft2.pub' | xi werkstatt ssh "root@$LAN.11" 'cat >> /etc/dropbear/authorized_keys'
soll "$SSH_T1" "$(fenster f5 "$ID_T1" 75)"
warte 15 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
T0="$(ms)"
abholer_anhalten && ok "Abholer angehalten (SIGSTOP)" || falsch "Abholer angehalten"
dienst_aus
lauscht_server && falsch "Schluesselausgabe beendet" || ok "Schluesselausgabe beendet"
sleep 28
box_hat "$ID_T1" && ok "nach $(sek $(($(ms) - T0))) s: Schluessel noch da" || falsch "nach 30 s: Schluessel noch da"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "… und die Anmeldung gelingt (das Fenster steht noch im Kernel)"
warte 140 box_hat_nicht "$ID_T1" && ok "nach $(sek $(($(ms) - T0))) s: Schluessel weg (Frist rund 70 s, der cron-Lauf kommt jede volle Minute)" || falsch "Schluessel verfaellt ohne Server und ohne Abholer"
[ $(($(ms) - T0)) -ge 60000 ] && ok "… nicht vor der Frist" || falsch "… nicht vor der Frist"
bx "grep -q ' dauerhaft2\$' $KEYS" && ok "der neu eingetragene dauerhafte Schluessel steht in der Schluesseldatei (vom cron-Lauf uebernommen)" || falsch "neuer dauerhafter Schluessel uebernommen"
luecke_auf 2>/dev/null || true
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "Gegenprobe (Luecke): tech1 meldet sich an"
abholer_weiter
bx "sed -i '/ dauerhaft2\$/d' /etc/dropbear/authorized_keys"
soll "$SSH_T1" ""
dienst_an 5s

# ── 6 ────────────────────────────────────────────────────────────────────────
schritt "6. Neustart der Box mitten im Fenster, Schluesselausgabe solange angehalten"
soll "$SSH_T1" "$(fenster f6 "$ID_T1" 600)"
warte 20 box_hat "$ID_T1" && ok "Fenster offen, Schluessel auf der Box" || falsch "Fenster offen, Schluessel auf der Box"
dienst_aus
T0="$(ms)"
docker restart -t 3 "$P-box" >/dev/null
warte 40 bx 'ubus call network.interface.lan status' || true
if box_netz; then
  ok "Box neu gestartet (Netz-Zuordnung des Containers unveraendert)"
else
  hinweis "Docker hat die Netz-Geraete des Containers beim Neustart vertauscht - neu zugeordnet (Eigenheit des Versuchs)"
fi
warte 60 tunnel_oben && ok "Tunnel steht nach $(sek $(($(ms) - T0))) s wieder" || falsch "Tunnel steht nach dem Neustart wieder"
warte 30 lauscht 10.10.16.2:2222 && ok "Anmelde-Instanz startet von selbst" || falsch "Anmelde-Instanz startet von selbst"
warte 20 abholer_laeuft && ok "Abholer startet von selbst" || falsch "Abholer startet von selbst"
bx 'pgrep crond >/dev/null' && ok "cron laeuft wieder" || falsch "cron laeuft wieder"
[ "${VPWA_TMPFS:-}" = docker ] || { bx 'grep -q "^vp-wartung /etc/vp-wartung/keys tmpfs " /proc/mounts' && ok "RAM-Bereich nach dem Neustart wieder eingehaengt" || falsch "RAM-Bereich nach dem Neustart wieder eingehaengt"; }
box_hat_keinen && bx "grep -c 'ssh-rsa' $KEYS" | grep -qx 1 && ok "in der Schluesseldatei steht nur der dauerhafte Schluessel" || falsch "in der Schluesseldatei steht nur der dauerhafte Schluessel"
bx '[ ! -s /tmp/vp-wartung/stand ]' && ok "der Arbeitsstand ist leer (lag im RAM)" || falsch "der Arbeitsstand ist leer"
im_kernel 10.10.32.3 && ok "das Fenster steht weiter im Kernel des Servers" || falsch "das Fenster steht weiter im Kernel des Servers"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "tech1 -> Box nach dem Neustart, ohne Schluesselausgabe"
T0="$(ms)"
dienst_an 5s
warte 30 box_hat "$ID_T1" && ok "Schluesselausgabe wieder an: Schluessel nach $(sek $(($(ms) - T0))) s zurueck" || falsch "Schluessel kommt von selbst wieder"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 -> Box"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster geschlossen, Schluessel gestrichen"

# ── 7 ────────────────────────────────────────────────────────────────────────
schritt "7. Antworten eines falschen Servers (an der Adresse der Schluesselausgabe)"
dienst_aus
abholer_anhalten || falsch "Abholer angehalten"
xi server sh -c 'cat > /srv/falsch.sh && chmod 755 /srv/falsch.sh' <<'EOF'
#!/bin/sh
# liest die Anfrage bis zur Leerzeile und schickt die vorbereitete Antwort
while IFS= read -r z; do
  z="$(printf '%s' "$z" | tr -d '\r')"
  [ -n "$z" ] || break
done
cat /srv/falsch/antwort
EOF
docker exec -d "$P-server" socat "TCP-LISTEN:$SPORT,bind=10.10.32.1,reuseaddr,fork" EXEC:/srv/falsch.sh
sleep 1
K1="${SSH_T1#ssh-rsa }"
K2="${SSH_T2#ssh-rsa }"
KOPF="vp-wartung-schluessel 1 0123456789abcdef"
# antwort <status> <rumpf>: Rumpf mit \n; ein Schluessel enthaelt keinen \.
# Mit Content-Length, wie der echte Dienst: ohne sie meldet uclient-fetch jede
# Antwort als abgebrochen.
antwort() {
  printf '%b' "$2" >"$ARBEIT/rumpf"
  { printf 'HTTP/1.0 %s\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n' "$1" "$(wc -c <"$ARBEIT/rumpf")"; cat "$ARBEIT/rumpf"; } |
    xi server sh -c 'cat > /srv/falsch/antwort.neu && mv /srv/falsch/antwort.neu /srv/falsch/antwort'
}
stand() { bx "md5sum < /tmp/vp-wartung/stand; md5sum < $KEYS"; }
# verworfen <beschreibung>: einmal meldet einen Fehler, Stand und Schluesseldatei bleiben
verworfen() {
  v_vor="$(stand)"
  if bx "$HOLEN einmal" >/dev/null 2>&1; then falsch "verworfen: $1 (einmal meldet Erfolg)"; return; fi
  [ "$(stand)" = "$v_vor" ] && ok "verworfen, Stand unveraendert: $1" || falsch "verworfen, Stand unveraendert: $1"
}
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T1 ssh-rsa $K1\nende 1\n"
bx "$HOLEN einmal" && box_hat "$ID_T1" && [ "$(fenster_schluessel)" = 1 ] && ok "angenommen: ein Schluessel" || falsch "angenommen: ein Schluessel"
ACHT=""; i=1
while [ "$i" -le 8 ]; do ACHT="${ACHT}schluessel 600 zugang-$i ssh-rsa $K2\n"; i=$((i + 1)); done
antwort "200 OK" "$KOPF\n${ACHT}ende 8\n"
bx "$HOLEN einmal" && [ "$(fenster_schluessel)" = 8 ] && box_hat_nicht "$ID_T1" && ok "angenommen: acht Schluessel (die Antwort ist die ganze Liste)" || falsch "angenommen: acht Schluessel"
antwort "200 OK" "$KOPF\nschluessel 999999 $ID_T1 ssh-rsa $K1\nende 1\n"
U="$(bx 'cut -d. -f1 /proc/uptime')"
bx "$HOLEN einmal" || falsch "angenommen: Laufzeit 999 999 s"
F="$(bx "awk '{ print \$1 }' /tmp/vp-wartung/stand")"
[ "$((F - U))" -ge 86400 ] && [ "$((F - U))" -le 86410 ] && [ "$(fenster_schluessel)" = 1 ] && ok "angenommen, aber gekappt: 999 999 s werden 24 h (Frist $((F - U)) s)" || falsch "999 999 s auf 24 h gekappt (ist: $((F - U)))"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T1 ssh-rsa $K1\nende 1\n"
bx "$HOLEN einmal" || falsch "Ausgangsstand fuer die Ablehnungen"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 command=\"id\" ssh-rsa $K2\nende 1\n"; verworfen "Option vor dem Schluessel (command=)"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0wmN/Cr3JXqmLW7u+g9pTh+wyqDHpSQEIQczXkVx9q\nende 1\n"; verworfen "Ed25519-Schluessel"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\n"; verworfen "abgeschnitten (ohne ende)"
# Dasselbe mitten in der Uebertragung: die Laenge verspricht mehr, als kommt.
{ printf 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 900\r\nConnection: close\r\n\r\n'; printf '%b' "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n"; } |
  xi server sh -c 'cat > /srv/falsch/antwort'
verworfen "Verbindung bricht vor dem Ende der Antwort ab"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 2\n"; verworfen "falsche Anzahl"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\nschluessel 600 $ID_T1 ssh-rsa $K1\n"; verworfen "Zeile nach dem Ende"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2 ssh-rsa $K1\nende 1\n"; verworfen "zweiter Schluessel im Kommentar"
antwort "200 OK" "vp-wartung-schluessel 2 0123456789abcdef\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n"; verworfen "unbekannte Version"
antwort "200 OK" "vp-wartung-schluessel 1 0123456789ABCDEF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n"; verworfen "Pruefwert in falscher Form"
antwort "200 OK" "$KOPF\nschluessel 600 t2;reboot ssh-rsa $K2\nende 1\n"; verworfen "Sonderzeichen in der Kennung"
antwort "200 OK" "$KOPF\n${ACHT}schluessel 600 zugang-9 ssh-rsa $K2\nende 9\n"; verworfen "neun Schluessel auf einmal"
antwort "200 OK" "$KOPF\nschluessel 0 $ID_T2 ssh-rsa $K2\nende 1\n"; verworfen "Restlaufzeit 0"
antwort "200 OK" "$KOPF\nschluessel 600  $ID_T2 ssh-rsa $K2\nende 1\n"; verworfen "zwei Leerzeichen zwischen den Feldern"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2\tssh-rsa $K2\nende 1\n"; verworfen "Tabulator statt Leerzeichen"
antwort "200 OK" "$KOPF\r\nschluessel 600 $ID_T2 ssh-rsa $K2\r\nende 1\r\n"; verworfen "Zeilenenden mit CR"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $(printf '%s' "$K2" | cut -c 1-200)\nende 1\n"; verworfen "Schluessel zu kurz"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $(printf '%s' "$K2" | cut -c 1-100)\$(reboot)$(printf '%s' "$K2" | cut -c 110-)\nende 1\n"; verworfen "fremde Zeichen im Schluessel"
antwort "404 Not Found" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n"; verworfen "HTTP 404 mit einer formgerechten Liste"
antwort "503 Service Unavailable" "$KOPF\nende 0\n"; verworfen "HTTP 503 mit einer leeren Liste (wuerde alles streichen)"
antwort "429 Too Many Requests" "$KOPF\nende 0\n"; verworfen "HTTP 429"
GROSS="$(awk 'BEGIN { for (i = 0; i < 20000; i++) printf "x" }')"
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n$GROSS\n"; verworfen "Antwort ueber 16 KiB"
antwort "200 OK" "$(awk 'BEGIN { for (i = 0; i < 60000; i++) printf "y" }')\n"; verworfen "Antwort ueber 32 KiB (Abbruch beim Schreiben)"
box_hat "$ID_T1" && [ "$(fenster_schluessel)" = 1 ] && box_hat_nicht "$ID_T2" && ok "nach allen Ablehnungen: weiter genau der eine Schluessel von vorher" || falsch "nach allen Ablehnungen: weiter genau der eine Schluessel"
antwort "200 OK" "vp-wartung-schluessel 1 99ba3c5f3272c926\nende 0\n"
bx "$HOLEN einmal" && box_hat_keinen && ok "angenommen: die leere Liste streicht alles" || falsch "angenommen: die leere Liste streicht alles"

# ── 8 ────────────────────────────────────────────────────────────────────────
schritt "8. Die Frist laeuft in Laufzeit der Box, nicht in Uhrzeit"
! grep -q -w -e date -e hwclock "$REPO/edge-light/openwrt/files$HOLEN" && ok "der Abholer ruft date nirgends auf" || falsch "der Abholer ruft date nirgends auf"
# Eine gestellte Laufzeit weit vor der echten: der cron-Lauf (echte Laufzeit) stoert nicht.
F0=$(($(bx 'cut -d. -f1 /proc/uptime') + 100000))
antwort "200 OK" "$KOPF\nschluessel 60 $ID_T1 ssh-rsa $K1\nende 1\n"
bx "echo '$F0.00 0.00' > /tmp/laufzeit && VP_WARTUNG_UPTIME=/tmp/laufzeit $HOLEN einmal" && box_hat "$ID_T1" || falsch "Schluessel fuer 60 s bei Laufzeit $F0"
[ "$(bx "awk '{ print \$1 }' /tmp/vp-wartung/stand")" = "$((F0 + 60))" ] && ok "Schluessel fuer 60 s bei Laufzeit $F0: Frist $((F0 + 60))" || falsch "Frist = Laufzeit + 60"
bx "echo '$((F0 + 59)).99 0.00' > /tmp/laufzeit && VP_WARTUNG_UPTIME=/tmp/laufzeit $HOLEN frist"
box_hat "$ID_T1" && ok "bei Laufzeit $((F0 + 59)): noch da" || falsch "bei Laufzeit +59: noch da"
bx "echo '$((F0 + 61)).00 0.00' > /tmp/laufzeit && VP_WARTUNG_UPTIME=/tmp/laufzeit $HOLEN frist"
box_hat_nicht "$ID_T1" && ok "bei Laufzeit $((F0 + 61)): weg" || falsch "bei Laufzeit +61: weg"
bx "echo unlesbar > /tmp/laufzeit; printf '%s\n' '99999999999 $ID_T1 $K1' > /tmp/vp-wartung/stand; VP_WARTUNG_UPTIME=/tmp/laufzeit $HOLEN frist; true"
box_hat_nicht "$ID_T1" && ok "ohne lesbare Laufzeit gilt kein Fenster-Schluessel" || falsch "ohne lesbare Laufzeit gilt kein Fenster-Schluessel"
bx ': > /tmp/vp-wartung/stand; rm -f /tmp/laufzeit'

# ── 9 ────────────────────────────────────────────────────────────────────────
schritt "9. Der Abholer fragt nur durch den Tunnel"
# Tunnel unten, und im Netz vor der Box (WAN) gibt sich jemand als 10.10.32.1 aus.
antwort "200 OK" "$KOPF\nschluessel 600 $ID_T2 ssh-rsa $K2\nende 1\n"
x server cat /srv/falsch.sh | xi tech2 sh -c 'mkdir -p /srv/falsch && cat > /srv/falsch.sh && chmod 755 /srv/falsch.sh'
x server cat /srv/falsch/antwort | xi tech2 sh -c 'cat > /srv/falsch/antwort'
x tech2 ip addr add 10.10.32.1/32 dev lo
docker exec -d "$P-tech2" socat "TCP-LISTEN:$SPORT,bind=10.10.32.1,reuseaddr,fork" EXEC:/srv/falsch.sh
bx 'ifdown wg_wartung'
bx "ip route add 10.10.32.1/32 via $WAN.14"
sleep 1
bx 'ip -4 route get 10.10.32.1' | grep -q "via $WAN.14 dev" && ok "Tunnel unten, 10.10.32.1 liegt jetzt im WAN (falscher Server)" || falsch "Aufbau: 10.10.32.1 im WAN"
V0="$(zaehler vp_wartung_ausgang)"
FEHLERTEXT="$(bx "$HOLEN einmal" 2>&1 || true)"
case "$FEHLERTEXT" in *"Tunnel wg_wartung unten"*) ok "der Abholer fragt nicht: \"$FEHLERTEXT\"" ;; *) falsch "der Abholer fragt nicht (ist: $FEHLERTEXT)" ;; esac
DIREKT="$(bx "uclient-fetch -q --no-proxy -T 4 -O - 'http://10.10.32.1:$SPORT/v1/schluessel?warte=0&stand=' 2>/dev/null || true")"
V1="$(zaehler vp_wartung_ausgang)"
[ -z "$DIREKT" ] && [ "$V1" -gt "$V0" ] && ok "auch an der Pruefung des Abholers vorbei: die Firewall der Box weist die Anfrage ab (Zaehler $V0 -> $V1)" || falsch "die Firewall der Box weist die Anfrage ausserhalb des Tunnels ab ($V0 -> $V1, Antwort: $DIREKT)"
bx 'nft flush chain inet fw4 vp_wartung_ausgang'
DIREKT="$(bx "uclient-fetch -q --no-proxy -T 4 -O - 'http://10.10.32.1:$SPORT/v1/schluessel?warte=0&stand=' 2>/dev/null || true")"
case "$DIREKT" in *"schluessel 600 $ID_T2 ssh-rsa"*) ok "Gegenprobe: ohne diese Regel kaeme die Antwort des falschen Servers an" ;; *) falsch "Gegenprobe: ohne die Regel kaeme die Antwort an" ;; esac
bx '/etc/init.d/firewall reload >/dev/null 2>&1'
box_hat_keinen && ok "kein Schluessel uebernommen" || falsch "kein Schluessel uebernommen"
bx "ip route del 10.10.32.1/32 via $WAN.14"
x tech2 sh -c 'pkill socat; ip addr del 10.10.32.1/32 dev lo; true'
x server sh -c 'pkill socat; true'
bx 'ifup wg_wartung'
warte 30 tunnel_oben || falsch "Tunnel wieder oben"
abholer_weiter
dienst_an 5s

# ── 10 ───────────────────────────────────────────────────────────────────────
schritt "10. SSH 2222 ausserhalb des Tunnels abgewiesen (Entscheid vom 09.10.2026)"
G10="$(fenster f10 "$ID_T1" 900)"
soll "$SSH_T1" "$G10"
warte 30 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
x werkstatt ip route add 10.10.16.2/32 via "$LAN.11"
x tech2 ip route add 10.10.16.2/32 via "$WAN.11"
echo "  -- Tunnel oben, Instanz der Fenster-Schluessel"
lauscht 10.10.16.2:2222 && ok "2222 lauscht auf der Tunnel-Adresse" || falsch "2222 lauscht auf der Tunnel-Adresse"
Z0="$(zaehler vp_wartung_eingang)"
zu werkstatt "$LAN.11" 2222 "LAN -> LAN-Adresse der Box, 2222: abgewiesen"
zu werkstatt 10.10.16.2 2222 "LAN -> Tunnel-Adresse der Box (Route ueber das LAN), 2222: abgewiesen"
zu tech2 "$WAN.11" 2222 "WAN -> WAN-Adresse der Box, 2222: abgewiesen"
zu tech2 10.10.16.2 2222 "WAN -> Tunnel-Adresse der Box (Route ueber das WAN), 2222: abgewiesen"
Z1="$(zaehler vp_wartung_eingang)"
[ "$Z1" -ge $((Z0 + 4)) ] && ok "… abgewiesen von der eigenen Regel der Box (Zaehler $Z0 -> $Z1)" || falsch "… abgewiesen von der eigenen Regel (Zaehler $Z0 -> $Z1)"
bx 'nft flush chain inet fw4 vp_wartung_eingang'
offen werkstatt 10.10.16.2 2222 "Gegenprobe: ohne die Regel erreichte das LAN die Tunnel-Adresse (Binden an die Adresse allein genuegt nicht)"
bx '/etc/init.d/firewall reload >/dev/null 2>&1'
zu werkstatt 10.10.16.2 2222 "… mit der Regel wieder abgewiesen"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "im Tunnel, im offenen Fenster: tech1 -> Box"
x werkstatt ssh "root@$LAN.11" 'echo lan' 2>/dev/null | grep -qx lan && ok "Port 22 im LAN bleibt offen" || falsch "Port 22 im LAN bleibt offen"
echo "  -- Tunnel unten, Instanz der Fenster-Schluessel"
bx 'ifdown wg_wartung'
warte 15 lauscht_nirgends && ok "auf 2222 lauscht niemand" || falsch "auf 2222 lauscht niemand"
zu werkstatt "$LAN.11" 2222 "LAN -> Box, 2222: keine Verbindung"
zu tech2 "$WAN.11" 2222 "WAN -> Box, 2222: keine Verbindung"
bx 'ifup wg_wartung'
warte 30 tunnel_oben && warte 20 lauscht 10.10.16.2:2222 && ok "Tunnel wieder oben: die Instanz lauscht wieder auf der Tunnel-Adresse" || falsch "Tunnel wieder oben: die Instanz lauscht wieder"
echo "  -- UCI-Instanz (VP_SERVICE_SCHLUESSEL=aus: Box mit aelterem Dropbear, altes Service-VPN)"
einrichten werkstatt "root@$LAN.11" VP_SERVICE_SCHLUESSEL=aus >"$ARBEIT/einrichten.10" 2>&1 && ok "eingerichtet ohne Fenster-Schluessel" || falsch "eingerichtet ohne Fenster-Schluessel"
bx '[ "$(uci -q get dropbear.vp_wartung.Interface)" = wg_wartung ] && [ ! -e /etc/init.d/vp-wartung ] && [ ! -e /usr/libexec/vp-wartung ] && [ ! -e /etc/vp-wartung ] && ! grep -q vp-wartung /proc/mounts /etc/crontabs/root /etc/sysupgrade.conf' &&
  ok "UCI-Instanz wieder da; Abholer, Startskript, RAM-Bereich und cron-Zeile abgeraeumt" || falsch "UCI-Instanz wieder da, Abholer abgeraeumt"
bx '! nft list chain inet fw4 vp_wartung_ausgang >/dev/null 2>&1 && nft list chain inet fw4 vp_wartung_eingang | grep -q "dport 2222"' && ok "die Regel fuer die Anfrage des Abholers ist mit ihm weg, die fuer 2222 bleibt" || falsch "Regel des Abholers weg, Regel fuer 2222 bleibt"
grep -q "Fenster-Schluessel sind NICHT eingerichtet" "$ARBEIT/einrichten.10" && ok "Abschluss sagt, dass nur dauerhafte Schluessel gelten" || falsch "Abschluss sagt, dass nur dauerhafte Schluessel gelten"
warte 15 lauscht 10.10.16.2:2222 || falsch "UCI-Instanz lauscht im Tunnel"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "Tunnel oben: tech1 mit dem Schluessel aus dem Portal"
zu werkstatt 10.10.16.2 2222 "Tunnel oben: LAN -> Tunnel-Adresse, 2222: abgewiesen"
bx 'ifdown wg_wartung'
warte 15 lauscht 0.0.0.0:2222 && ok "Tunnel unten: die UCI-Instanz lauscht auf allen Adressen (wie bisher)" || falsch "Tunnel unten: die UCI-Instanz lauscht auf allen Adressen"
Z0="$(zaehler vp_wartung_eingang)"
zu werkstatt "$LAN.11" 2222 "Tunnel unten: LAN -> Box, 2222: abgewiesen"
zu tech2 "$WAN.11" 2222 "Tunnel unten: WAN -> Box, 2222: abgewiesen"
Z1="$(zaehler vp_wartung_eingang)"
[ "$Z1" -ge $((Z0 + 2)) ] && ok "… abgewiesen von der eigenen Regel der Box (Zaehler $Z0 -> $Z1)" || falsch "… abgewiesen von der eigenen Regel (Zaehler $Z0 -> $Z1)"
bx 'nft flush chain inet fw4 vp_wartung_eingang'
offen werkstatt "$LAN.11" 2222 "Gegenprobe: ohne die Regel waere 2222 im LAN offen (Stand vor dieser Aenderung)"
bx '/etc/init.d/firewall reload >/dev/null 2>&1'
zu werkstatt "$LAN.11" 2222 "… mit der Regel wieder abgewiesen"
bx 'ifup wg_wartung'
warte 30 tunnel_oben || falsch "Tunnel wieder oben"
x werkstatt ip route del 10.10.16.2/32
x tech2 ip route del 10.10.16.2/32
erwarte tech2 /root/.ssh/id_rsa_werkstatt KEINE-VERBINDUNG "im Tunnel, ohne Fenster: tech2 mit dem dauerhaften Schluessel"

# ── 11 ───────────────────────────────────────────────────────────────────────
schritt "11. Rueckfall, wenn die neue Instanz nicht startet; danach sauber; ifup des Waechters"
warte 15 lauscht 10.10.16.2:2222 || falsch "UCI-Instanz lauscht im Tunnel"
bx 'rm -rf /etc/vp-wartung && : > /etc/vp-wartung' # der Einhaengepunkt laesst sich so nicht anlegen
if einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.11" 2>&1; then falsch "das Skript meldet den Fehler (Rueckgabe)"; else ok "das Skript meldet den Fehler (Rueckgabe ungleich 0)"; fi
grep -q "zurueck auf die bisherige Instanz" "$ARBEIT/einrichten.11" && ok "… und sagt, dass es auf die bisherige Instanz zurueckgeht" || falsch "… und sagt, dass es auf die bisherige Instanz zurueckgeht"
bx '[ "$(uci -q get dropbear.vp_wartung.Interface)" = wg_wartung ] && [ ! -e /etc/init.d/vp-wartung ] && ! grep -q vp-wartung /etc/crontabs/root' && warte 15 lauscht 10.10.16.2:2222 &&
  ok "die bisherige Instanz lauscht wieder im Tunnel, nichts Halbes bleibt liegen" || falsch "die bisherige Instanz lauscht wieder im Tunnel"
erwarte tech1 /root/.ssh/id_rsa_neu ABGEWIESEN "niemand ausgesperrt, niemand zusaetzlich drin: tech1 ohne passenden Schluessel"
x werkstatt cat /root/.ssh/id_rsa_werkstatt | xi tech1 sh -c 'umask 077; cat > /root/.ssh/id_rsa_werkstatt'
erwarte tech1 /root/.ssh/id_rsa_werkstatt ANGEMELDET "… tech1 im Fenster mit dem dauerhaften Schluessel"
einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.11b" 2>&1 && ok "erneut eingerichtet, jetzt mit Fenster-Schluesseln" || falsch "erneut eingerichtet, jetzt mit Fenster-Schluesseln"
warte 20 box_hat "$ID_T1" && ok "der Fenster-Schluessel ist wieder da" || falsch "der Fenster-Schluessel ist wieder da"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 -> Box"
# Der Waechter startet die Schnittstelle mit ifup neu (kein Handshake seit 10 min).
IFINDEX="$(bx 'cat /sys/class/net/wg_wartung/ifindex')"
bx 'ifup wg_wartung'
warte 30 tunnel_oben && warte 20 lauscht 10.10.16.2:2222 || falsch "nach ifup: Tunnel und Instanz wieder da"
[ "$(bx 'cat /sys/class/net/wg_wartung/ifindex')" != "$IFINDEX" ] && ok "ifup des Waechters legt die Schnittstelle neu an" || hinweis "ifup hat die Schnittstelle nicht neu angelegt"
warte 20 box_hat "$ID_T1" || true
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "… und die Anmeldung im Tunnel geht danach weiter"

# ── 12 ───────────────────────────────────────────────────────────────────────
schritt "12. status, sysupgrade, abbauen"
ST="$(tunnel status 2>&1)"
printf '%s\n' "$ST" | sed -n '/^--- /,$p' | sed 's/^/    | /'
for z in "SSH 2222 lauscht auf: 10.10.16.2:2222" "SSH 2222 ausserhalb der Tunnel: abgewiesen (nur aus { \"lo\", \"wg_wartung\" }" \
  "Fenster-Schluessel: Abholer laeuft, Server 10.10.32.1:$SPORT ueber wg_wartung" "letzte gueltige Antwort des Wartungsservers: vor " \
  "Schluesseldatei im RAM (tmpfs /etc/vp-wartung/keys): ja" "dauerhaft aus /etc/dropbear/authorized_keys: 1 Schluessel" "im Fenster: Zugang $ID_T1, noch "; do
  case "$ST" in *"$z"*) ok "status: $z…" ;; *) falsch "status: $z…" ;; esac
done
case "$ST" in *AAAAB3NzaC1yc2E*) falsch "status zeigt keinen Schluessel" ;; *) ok "status zeigt keinen Schluessel" ;; esac
SU="$(bx 'sysupgrade -l 2>/dev/null')"
for f in /usr/libexec/vp-wartung/schluessel-holen.sh /etc/init.d/vp-wartung /etc/rc.d/S60vp-wartung /etc/config/vp-wartung /etc/nftables.d/20-vp-wartung.nft \
  /usr/libexec/vp-edge-light/service-tunnel-watch.sh /etc/wireguard/vp-wartung.key /etc/crontabs/root; do
  printf '%s\n' "$SU" | grep -qx "$f" && ok "sysupgrade -l nennt $f" || falsch "sysupgrade -l nennt $f"
done
printf '%s\n' "$SU" | grep -q '^/etc/vp-wartung' && falsch "die Schluesseldatei im RAM steht nicht in der Sicherung" || ok "die Schluesseldatei im RAM steht nicht in der Sicherung"
soll "$SSH_T1" ""
tunnel abbauen wg_wartung >"$ARBEIT/abbauen" 2>&1 && ok "abbauen wg_wartung laeuft durch" || falsch "abbauen wg_wartung laeuft durch"
bx '[ ! -e /etc/init.d/vp-wartung ] && [ ! -e /etc/rc.d/S60vp-wartung ] && [ ! -e /usr/libexec/vp-wartung ] && [ ! -e /etc/vp-wartung ] && [ ! -e /etc/config/vp-wartung ] && [ ! -e /tmp/vp-wartung ]' &&
  ok "Abholer, Startskript, Einstellung und Arbeitsstand weg" || falsch "Abholer, Startskript, Einstellung und Arbeitsstand weg"
bx '! grep -q vp-wartung /proc/mounts /etc/crontabs/root /etc/sysupgrade.conf' && ok "RAM-Bereich ausgehaengt, cron-Zeile und sysupgrade-Eintraege weg" || falsch "RAM-Bereich, cron-Zeile, sysupgrade-Eintraege weg"
bx '[ ! -e /etc/nftables.d/20-vp-wartung.nft ] && ! nft list chain inet fw4 vp_wartung_eingang >/dev/null 2>&1 && ! nft list chain inet fw4 vp_wartung_ausgang >/dev/null 2>&1 && ! uci -q get firewall.vp_service' && ok "Firewall-Regeln und Zone weg" || falsch "Firewall-Regeln und Zone weg"
warte 10 lauscht_nirgends && bx '! pgrep -f "schluessel-hole[n]|dropbea[r].*2222" >/dev/null' && ok "auf 2222 lauscht niemand, kein Abholer" || falsch "auf 2222 lauscht niemand, kein Abholer"
[ "$(bx 'md5sum < /etc/dropbear/authorized_keys')" = "$SUMME_DAUER" ] && ok "/etc/dropbear/authorized_keys bis zum Schluss unveraendert" || falsch "/etc/dropbear/authorized_keys bis zum Schluss unveraendert"
x werkstatt ssh "root@$LAN.11" 'echo lan' 2>/dev/null | grep -qx lan && ok "Anmeldung im LAN (Port 22) geht weiter" || falsch "Anmeldung im LAN (Port 22) geht weiter"

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(bx 'grep DISTRIB_DESCRIPTION /etc/openwrt_release' | cut -d"'" -f2), $(bx 'dropbear -V 2>&1'), Tunnel-Dienst $(x server /opt/vptd/vp-tunnel-dienst version | sed 's/.*Version //'), Kernel $(uname -r))"
if [ "$FEHLER" -ne 0 ]; then
  echo "--- Log der Box (vp-wartung)"; bx 'logread -e vp-wartung | tail -n 40' || true
  echo "--- Log des Dienstes"; x server tail -n 40 /srv/log || true
  exit 1
fi
