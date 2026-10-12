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
#   4  Fenster vorzeitig geschlossen; 4b Schluessel im Fenster ersetzt, entfernt;
#      4c Fenster laeuft ab; 4d zwei Techniker und der dauerhafte Schluessel
#   5  Frist ohne Server und ohne Abholer (nur cron)
#   5b Protokoll der Box: cron protokolliert seine Starts nicht mehr; die
#      Ereignisse einer frueheren Sitzung bleiben nachlesbar, wenn der
#      Protokollspeicher laengst uebergelaufen ist
#   6  Neustart der Box mitten im Fenster, danach Neustart von Lauscher und Abholer
#   6b die Obergrenze der Ereignisliste haelt; ein Zeitauftrag, der ausbleibt,
#      faellt weiter auf
#   7  Antworten eines falschen Servers
#   8  Frist in Laufzeit der Box, nicht in Uhrzeit
#   9  der Abholer fragt nur durch den Tunnel
#   10 SSH 2222 ausserhalb des Tunnels abgewiesen - Tunnel oben und Tunnel unten,
#      mit der neuen Instanz und mit der UCI-Instanz (VP_SERVICE_SCHLUESSEL=aus)
#   11 Rueckfall, wenn die neue Instanz nicht startet; Waechter-ifup
#   11b Ausrollen: Box mit dem Skript vor dieser Aenderung, offene Sitzungen
#   12 status, sysupgrade -l, abbauen
#
# Sitzungen (Entscheid vom 10.10.2026): Wird ein Fenster-Schluessel gestrichen,
# beendet die Box die Sitzungen genau dieses Schluessels. In jedem der Schritte
# 4 bis 6, 10 und 11b steht dazu eine stille Sitzung offen (sitzung_auf); nach
# dem Streichen muss ihr Anmeldeprozess auf der Box weg sein (endet), und in
# einer Luecke der Server-Firewall darf sie nicht mehr antworten (stumm).
#
#   edge-light/test/wartung-anmeldung-probe.sh
#   VPTD_DOCKER_DNS=1.1.1.1 ...   ohne DNS im Container (nur beim ersten Lauf noetig:
#                                 die Abbilder mit wireguard-tools werden einmal gebaut)
#   VPWA_NETZ=172.29 ...          andere Docker-Netze (<netz>.97.0/24 und .98.0/24)
#   VPWA_TMPFS=docker ...         Docker stellt den RAM-Bereich der Schluesseldatei;
#                                 sonst haengt ihn das Startskript der Box selbst ein
#                                 (braucht SYS_ADMIN im Container)
#   VPWA_BEHALTEN=1 ...           Container am Ende stehen lassen (Fehlersuche)
#   VPWA_SKRIPT=<verzeichnis> ... Gegenprobe: ein anderer Stand von edge-light/openwrt
#                                 als Box-Skript. Mit dem Stand vor dem 10.10.2026
#                                 muessen die Pruefungen der Sitzungen rot sein, mit
#                                 dem vor dem 12.10.2026 die zum Protokoll der Box
#                                 (Schritte 1, 5b, 6, 6b, 12)
#
# Protokoll der Box (Entscheid vom 12.10.2026): cron protokollierte jeden Start
# eines Zeitauftrags, 132 Zeilen je Stunde; nach rund vier Stunden waren die
# Anmeldungen der Fernwartung aus dem Protokollspeicher (logread) verdraengt.
# Die Box stellt diese Zeilen ab und fuehrt die Ereignisse der Fernwartung in
# einer eigenen, begrenzten Liste im Flash (EREIGNISSE).
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
VOR_STAND=a9e9872e99c71efb704910d766b6bc4f767cb8cb # main mit Fenster-Schluesseln, vor dem Beenden der Sitzungen
SKRIPT_DIR="${VPWA_SKRIPT:-$REPO/edge-light/openwrt}"
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
# Die Attrappe nimmt auch die Rueckmeldung des Dienstes an und legt die letzte ab
# (docs/contracts/fernwartung-rueckmeldung-v1.md).
api_an() {
  docker exec -d "$P-server" sh -c 'echo $$ > /srv/api.pid; exec /opt/vptd/attrappe -soll /srv/soll.json -rueckmeldung /srv/rueckmeldung.json'
  sleep 1
}
meldung() { x server cat /srv/rueckmeldung.json 2>/dev/null || true; }
meldung_hat() { meldung | grep -q -- "$1"; }
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
EREIGNISSE=/etc/vp-wartung/ereignisse
# ereignisse: die Liste, wie sie der Abholer zeigt (uebernimmt vorher, was neu
# ist). Leer mit einem Skript, das sie nicht kennt.
ereignisse() { bx "$HOLEN ereignisse 2>/dev/null" || true; }
ereignis() { ereignisse | grep -q -- "$1"; }
ereignis_zeilen() { bx "wc -l < $EREIGNISSE 2>/dev/null" || echo 0; }
# marke <name>: eine Zeile im Protokoll der Box; cron_zeilen <name> zaehlt, wie
# oft cron seither den Start eines Zeitauftrags protokolliert hat.
marke() { bx "logger -t vpwa-marke '$1'"; }
marke_da() { bx "logread | grep -q 'vpwa-marke: $1\$'"; }
cron_zeilen() { bx "logread | sed -n '/vpwa-marke: $1\$/,\$p' | grep -c 'crond\[[0-9]*\]: USER ' || true"; }
frist_alter() { bx 'echo $(( $(cut -d. -f1 /proc/uptime) - $(cat /tmp/vp-wartung/frist 2>/dev/null || echo 0) ))'; }
frist_frisch() { [ "$(frist_alter)" -lt 100 ]; }
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
# sitzung_auf <von> <schluesseldatei> <name>: eine Anmeldung, die offen bleibt
# und schweigt, bis sie gefragt wird. Sie schweigt, damit weder Box noch
# Techniker auf eine Bestaetigung warten: gibt es sie noch, antwortet sie auch
# in einer Luecke der Server-Firewall sofort, ohne dass TCP erst wieder
# anlaufen muss. Die erste Zeile nennt ihren Anmeldeprozess auf der Box.
sitzung_auf() {
  docker exec -d "$P-$1" sh -c "rm -f /tmp/$3.ein /tmp/$3.aus /tmp/$3.pid; mkfifo /tmp/$3.ein; exec 3<>/tmp/$3.ein
    ssh $SSH_OPT -i $2 -p 2222 root@10.10.16.2 'echo bereit \$PPID; while read -r w; do echo antwort-\$w; done' <&3 >/tmp/$3.aus 2>&1 &
    echo \$! >/tmp/$3.pid; wait; echo zu >>/tmp/$3.aus"
  warte 10 x "$1" grep -q '^bereit [0-9]' "/tmp/$3.aus"
}
sitzung_pid() { x "$1" sed -n 's/^bereit //p' "/tmp/$2.aus" 2>/dev/null || true; }
sitzung_zu() { x "$1" grep -q '^zu$' "/tmp/$2.aus"; }
sitzung_schliessen() { x "$1" sh -c "kill \$(cat /tmp/$2.pid 2>/dev/null) 2>/dev/null; true"; }
# sitzung_fragt <von> <name> <sekunden>: ein neues Wort hin; 0, wenn die Antwort
# kommt. Hoert auf zu warten, sobald die Anmeldung des Technikers beendet ist.
sitzung_fragt() {
  sf_w="w$(ms)"
  sitzung_zu "$1" "$2" && return 1
  x "$1" timeout 2 sh -c "echo $sf_w > /tmp/$2.ein" 2>/dev/null || true
  warte "$3" x "$1" grep -q -e "^antwort-$sf_w\$" -e '^zu$' "/tmp/$2.aus" || return 1
  x "$1" grep -q "^antwort-$sf_w\$" "/tmp/$2.aus"
}
box_prozess() { bx "[ -d /proc/$1 ]"; }
box_prozess_weg() { ! box_prozess "$1"; }
# endet <von> <name> <beschreibung>: der Anmeldeprozess der Sitzung ist auf der Box weg
endet() {
  en_p="$(sitzung_pid "$1" "$2")"
  en_t="$(ms)"
  if [ -n "$en_p" ] && warte 10 box_prozess_weg "$en_p"; then ok "$3 (Dropbear-Prozess $en_p, $(sek $(($(ms) - en_t))) s)"; else falsch "$3 (Dropbear-Prozess ${en_p:-?} steht noch)"; fi
}
# bleibt <von> <name> <beschreibung>: der Anmeldeprozess steht noch
bleibt() {
  bl_p="$(sitzung_pid "$1" "$2")"
  [ -n "$bl_p" ] && box_prozess "$bl_p" && ok "$3" || falsch "$3"
}
# antwortet/stumm <von> <name> <beschreibung>: nur fragen, wenn der Weg offen
# ist (Fenster oder Luecke) - eine Frage ins Leere liesse TCP in immer
# groesserem Abstand wiederholen, und die naechste Antwort kaeme verspaetet.
antwortet() { sitzung_fragt "$1" "$2" 5 && ok "$3" || falsch "$3"; }
stumm() {
  if sitzung_fragt "$1" "$2" 6; then
    falsch "$3 (sie antwortet)"
  else
    ok "$3 ($(sitzung_zu "$1" "$2" && echo "die Anmeldung des Technikers ist beendet" || echo "keine Antwort in 6 s"))"
  fi
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
mkdir -p "$ARBEIT/bin" "$ARBEIT/alt/files/usr/libexec/vp-edge-light" "$ARBEIT/vor"
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
# Das Skript von main mit Fenster-Schluesseln, vor dem Beenden der Sitzungen:
# die Box, auf die diese Aenderung ausgerollt wird (Schritt 11b).
VOR=nein
if git -C "$REPO" cat-file -e "$VOR_STAND:edge-light/openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh" 2>/dev/null; then
  git -C "$REPO" archive "$VOR_STAND" edge-light/openwrt | tar -x -C "$ARBEIT/vor" --strip-components=2
  VOR=ja
fi
echo "  Abbilder $BOX_BILD und $TECH_BILD, Skript von main ($ALT_STAND): $ALT, Skript vor dieser Aenderung ($VOR_STAND): $VOR"
[ "$SKRIPT_DIR" = "$REPO/edge-light/openwrt" ] || echo "  GEGENPROBE: Box-Skript aus $SKRIPT_DIR, nicht aus diesem Repo"

# ── Aufbau ───────────────────────────────────────────────────────────────────
schritt "Aufbau: Server, Box (WAN + LAN), zwei Techniker, Werkstatt-Rechner im LAN"
# Die Namen in dieser Reihenfolge: Docker ordnet die Netz-Geraete eines Containers
# beim Neustart nach dem Namen des Netzes - so bleibt eth0 das WAN.
docker network create --subnet "$WAN.0/24" "$P-a-wan" >/dev/null
docker network create --subnet "$LAN.0/24" "$P-b-lan" >/dev/null
starte() { # starte <name> <netz> <ip> [docker-optionen]
  n="$1"; netz="$2"; ip="$3"; shift 3
  docker run -d --name "$P-$n" --hostname "$n" --network "$P-$netz" --ip "$ip" --cap-add NET_ADMIN "$@" \
    -v "$SKRIPT_DIR:/skript:ro" -v "$ARBEIT/alt:/alt:ro" -v "$ARBEIT/vor:/vor:ro" "$TECH_BILD" sleep infinity >/dev/null
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
# Befund vom 11.10.2026: so fuellt sich der Protokollspeicher der Box.
if [ "$ALT" = ja ]; then
  warte 70 bx 'logread | grep -q "crond\[[0-9]*\]: USER root pid .* cmd /usr/bin/wireguard_watchdog"' &&
    ok "heutiger Stand: cron protokolliert jeden Start eines Zeitauftrags (\"USER root pid … cmd /usr/bin/wireguard_watchdog\")" || falsch "heutiger Stand: cron protokolliert jeden Start"
fi

# ── 1 ────────────────────────────────────────────────────────────────────────
schritt "1. Neues Skript ueber einen Zugang, der heute geht; Fenster oeffnen, anmelden"
# Ein dauerhafter Schluessel, wie ihn die Werkstatt heute eintraegt (Uebergang).
x werkstatt cat /root/.ssh/id_rsa_werkstatt.pub | xi werkstatt ssh "root@$LAN.11" 'cat >> /etc/dropbear/authorized_keys'
SUMME_DAUER="$(bx 'md5sum < /etc/dropbear/authorized_keys')"
IFINDEX="$(bx 'cat /sys/class/net/wg_wartung/ifindex')"
einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.1" 2>&1 && ok "service-tunnel.sh von heute laeuft durch" || falsch "service-tunnel.sh von heute laeuft durch"
# Ab hier zaehlt Schritt 5b die Startzeilen von cron.
marke eingerichtet
T_MARKE="$(ms)"
bx '[ "$(uci -q get system.@system[0].cronloglevel)" = 9 ] && tr "\0" " " < /proc/$(pgrep crond | head -n 1)/cmdline | grep -q -- "-l 9"' &&
  grep -q 'cron protokolliert die Starts der Zeitauftraege nicht mehr' "$ARBEIT/einrichten.1" &&
  ok "cron protokolliert die Starts der Zeitauftraege nicht mehr (cronloglevel 9, crond laeuft damit); das Skript sagt es" || falsch "cronloglevel 9, crond laeuft damit, das Skript sagt es"
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
# Rueckmeldung ans Portal: "abgeholt" meldet der Dienst erst, wenn die Box den
# Pruefwert der Liste nennt - das echte Box-Skript tut das mit seiner naechsten Anfrage.
warte 20 meldung_hat "\"id\":\"$ID_BOX\",\"verbundenSeit\":\"20[^\"]*\",\"zuletztGefragtUm\":\"20" &&
  ok "Rueckmeldung: die Box steht als verbunden darin und hat nach Schluesseln gefragt" || falsch "Rueckmeldung: Box verbunden und gefragt ($(meldung))"
warte 20 meldung_hat "\"id\":\"f1\",\"schluesselAbgeholtUm\":\"20" &&
  ok "Rueckmeldung: der Schluessel des Fensters gilt als abgeholt ($(sek $(($(ms) - T2))) s nach dem Schreiben auf der Box)" || falsch "Rueckmeldung: Schluessel abgeholt ($(meldung))"
meldung | grep -q -e 'ssh-rsa' -e '10\.10\.' -e 'SHA256' -e "$REF" && falsch "die Rueckmeldung nennt weder Schluessel noch Adresse noch Kennung" || ok "die Rueckmeldung nennt weder Schluessel noch Adresse noch Kennung"
echo "  Schluesseldatei der Wartungs-Instanz (RAM):"
bx "awk '/^ssh-/ { print \"    \" \$1, substr(\$2, 1, 16) \"…\", \$3, \$4 }' $KEYS"
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
sitzung_auf tech1 /root/.ssh/id_rsa s4 && sitzung_fragt tech1 s4 5 && ok "dazu eine stille Sitzung von tech1, die auf Fragen antwortet" || falsch "stille Sitzung von tech1"
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
# Zweite Schranke: die Box beendet die Sitzungen des gestrichenen Schluessels.
P4="$(sitzung_pid tech1 s4)"
endet tech1 s4 "die Box beendet die Sitzung des gestrichenen Schluessels"
warte 5 bx '! pgrep -f "echo zeil[e]" >/dev/null' && ok "… auch die mit laufender Ausgabe: ihr Befehl laeuft auf der Box nicht mehr" || falsch "die Sitzung mit laufender Ausgabe ist auf der Box beendet"
bx "logread -e vp-wartung | grep -q 'Sitzung beendet (Dropbear-Prozess $P4): ihr Fenster-Schluessel ist gestrichen'" && ok "Box-Log: welche Sitzung die Box beendet hat, und warum" || falsch "Box-Log nennt die beendete Sitzung"
bx "logread -e dropbear | grep -q 'dropbear\\[$P4\\]: Exit (root) from <10.10.32.3:[0-9]*>: Terminated by signal'" && ok "Box-Log von Dropbear: Ende der Sitzung mit Absender" || falsch "Box-Log von Dropbear nennt das Ende der Sitzung"
x tech1 sh -c 'pkill -f "zeil[e]"; true'
erwarte tech1 /root/.ssh/id_rsa KEINE-VERBINDUNG "tech1 neu"
# Gegenprobe, ob der Schluessel wirklich weg ist: Luecke wie in Schritt 3.
dienst_aus
luecke_auf
offen tech1 10.10.16.2 2222 "Gegenprobe (Luecke): tech1 erreicht den Port"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "Gegenprobe (Luecke): tech1 meldet sich an"
stumm tech1 s4 "Luecke der Server-Firewall: die vor dem Schliessen begonnene Sitzung laeuft NICHT wieder"
dienst_an 5s

schritt "4b. SSH-Schluessel im offenen Fenster ersetzt, dann entfernt"
G1="$(fenster f4 "$ID_T1" 600)"
soll "$SSH_T1" "$G1"
warte 20 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
ALT_TEXT="$(printf '%s' "${SSH_T1#ssh-rsa }" | cut -c 60-120)"
NEU_TEXT="$(printf '%s' "${SSH_T1N#ssh-rsa }" | cut -c 60-120)"
box_hat_text "$ALT_TEXT" || falsch "der bisherige Schluessel liegt auf der Box"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 mit dem bisherigen Schluessel"
sitzung_auf tech1 /root/.ssh/id_rsa s4b || falsch "stille Sitzung mit dem bisherigen Schluessel"
T0="$(ms)"
soll "$SSH_T1N" "$G1"
warte 15 box_hat_text "$NEU_TEXT" && ok "der neue Schluessel liegt auf der Box" || falsch "der neue Schluessel liegt auf der Box"
T1="$(ms)"
box_hat_text "$ALT_TEXT" && falsch "der ersetzte Schluessel ist gestrichen" || ok "der ersetzte Schluessel ist gestrichen, $(sek $((T1 - T0))) s nach der Aenderung im Soll-Stand (Frist waere in rund 10 min)"
endet tech1 s4b "Schluessel ersetzt: die Box beendet die Sitzung des ersetzten Schluessels"
stumm tech1 s4b "… sie antwortet nicht mehr, obwohl das Fenster offen ist"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "tech1 mit dem ersetzten Schluessel"
erwarte tech1 /root/.ssh/id_rsa_neu ANGEMELDET "tech1 mit dem neuen Schluessel"
sitzung_auf tech1 /root/.ssh/id_rsa_neu s4n && sitzung_fragt tech1 s4n 5 || falsch "stille Sitzung mit dem neuen Schluessel"
soll "" "$G1"
warte 15 box_hat_keinen && ok "Schluessel am Zugang entfernt: von der Box gestrichen" || falsch "Schluessel am Zugang entfernt: von der Box gestrichen"
endet tech1 s4n "Schluessel entfernt: die Box beendet die Sitzung dieses Schluessels"
offen tech1 10.10.16.2 2222 "das Fenster selbst bleibt offen (Netzweg)"
stumm tech1 s4n "… die Sitzung antwortet trotzdem nicht mehr"
erwarte tech1 /root/.ssh/id_rsa_neu ABGEWIESEN "tech1 mit dem entfernten Schluessel"
soll "$SSH_T1" ""
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster geschlossen"

schritt "4c. Fenster laeuft ab - Dienst und Abholer laufen"
soll "$SSH_T1" "$(fenster f4c "$ID_T1" 30)"
warte 15 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
T0="$(ms)"
sitzung_auf tech1 /root/.ssh/id_rsa s4c && sitzung_fragt tech1 s4c 5 && ok "stille Sitzung von tech1 im Fenster (30 s)" || falsch "stille Sitzung von tech1 im Fenster"
warte 45 box_hat_keinen && ok "Fenster abgelaufen: Schluessel nach $(sek $(($(ms) - T0))) s gestrichen (ohne Zutun im Portal)" || falsch "Fenster abgelaufen: Schluessel gestrichen"
endet tech1 s4c "abgelaufenes Fenster: die Box beendet die Sitzung"
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster im Kernel des Servers abgelaufen"
soll "$SSH_T1" ""
dienst_aus
luecke_auf
offen tech1 10.10.16.2 2222 "Luecke: tech1 erreicht den Port"
stumm tech1 s4c "Luecke der Server-Firewall: die vor dem Ablauf begonnene Sitzung laeuft NICHT wieder"
dienst_an 5s

schritt "4d. Zwei Techniker mit je einem Fenster, dazu der dauerhafte Schluessel: eines endet, der Rest bleibt"
FA="$(fenster f4a "$ID_T1" 600)"
FB="$(fenster f4b "$ID_T2" 600)"
soll "$SSH_T1" "$FA,$FB"
warte 20 box_hat "$ID_T1" && warte 20 box_hat "$ID_T2" && ok "zwei Fenster offen, beide Schluessel auf der Box" || falsch "zwei Fenster offen, beide Schluessel auf der Box"
sitzung_auf tech1 /root/.ssh/id_rsa e1 || falsch "Sitzung von tech1"
sitzung_auf tech2 /root/.ssh/id_rsa e2 || falsch "Sitzung von tech2"
sitzung_auf tech2 /root/.ssh/id_rsa_werkstatt ed || falsch "Sitzung mit dem dauerhaften Schluessel"
# Nur eine Weiterleitung, kein Prozess auf der Box: sie laesst sich keinem Schluessel zuordnen.
docker exec -d "$P-tech2" ssh $SSH_OPT -i /root/.ssh/id_rsa -p 2222 -N -L 127.0.0.1:18023:127.0.0.1:22 root@10.10.16.2
sleep 2
[ "$(banner tech2 127.0.0.1 18023)" = "SSH-2.0-drop" ] && ok "tech2 haelt ausserdem eine Weiterleitung ohne Prozess auf der Box (-N -L)" || falsch "Weiterleitung von tech2 (-N -L)"
ST="$(bx "$HOLEN status")"
case "$ST" in
  *"Sitzungen im Tunnel: 4 - dauerhafter Schluessel 1, Fenster-Schluessel 2, gestrichener Fenster-Schluessel 0, nicht zuzuordnen 1"*) ok "status der Box zaehlt die Sitzungen nach der Art ihres Schluessels" ;;
  *) falsch "status der Box zaehlt die Sitzungen ($(printf '%s\n' "$ST" | grep 'Sitzungen im Tunnel'))" ;;
esac
soll "$SSH_T1" "$FB"
warte 15 box_hat_nicht "$ID_T1" && box_hat "$ID_T2" || falsch "Fenster von tech1 geschlossen, das von tech2 offen"
endet tech1 e1 "Fenster von tech1 geschlossen: die Box beendet seine Sitzung"
bleibt tech2 e2 "die Sitzung von tech2 bleibt (sein Fenster ist offen)"
antwortet tech2 e2 "… und antwortet"
bleibt tech2 ed "die Sitzung mit dem dauerhaften Schluessel bleibt"
antwortet tech2 ed "… und antwortet"
[ -z "$(banner tech2 127.0.0.1 18023)" ] && ok "im Zweifel endet die Sitzung: die Weiterleitung ohne Prozess ist beendet (nicht zuzuordnen)" || falsch "die nicht zuzuordnende Weiterleitung ist beendet"
x tech2 sh -c 'pkill -f "1802[3]"; true'
docker exec -d "$P-tech2" ssh $SSH_OPT -i /root/.ssh/id_rsa -p 2222 -N -L 127.0.0.1:18024:127.0.0.1:22 root@10.10.16.2
sleep 2
[ "$(banner tech2 127.0.0.1 18024)" = "SSH-2.0-drop" ] && ok "… und steht mit dem gueltigen Schluessel sofort wieder" || falsch "die Weiterleitung laesst sich sofort wieder aufbauen"
x tech2 sh -c 'pkill -f "1802[4]"; true'
dienst_aus
luecke_auf
stumm tech1 e1 "Luecke der Server-Firewall: die Sitzung von tech1 laeuft NICHT wieder"
antwortet tech2 e2 "… die von tech2 laeuft"
dienst_an 5s
warte 20 im_kernel 10.10.32.4 || falsch "Fenster von tech2 nach der Luecke wieder im Kernel"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster von tech2 geschlossen, Schluessel gestrichen"
endet tech2 e2 "Fenster von tech2 geschlossen: die Box beendet seine Sitzung"
bleibt tech2 ed "die Sitzung mit dem dauerhaften Schluessel bleibt auch jetzt"
warte 15 nicht_im_kernel 10.10.32.4 || falsch "Fenster von tech2 im Kernel weg"
dienst_aus
luecke_auf
stumm tech2 e2 "Luecke der Server-Firewall: die Sitzung von tech2 laeuft NICHT wieder"
antwortet tech2 ed "… die mit dem dauerhaften Schluessel laeuft (sie haengt an keinem Fenster)"
sitzung_schliessen tech2 ed
dienst_an 5s
# Derselbe Schluessel zugleich dauerhaft und Fenster-Schluessel: Dropbear nimmt
# die erste Zeile der Schluesseldatei, und das ist die dauerhafte.
x tech1 cat /root/.ssh/id_rsa.pub | xi werkstatt ssh "root@$LAN.11" 'cat >> /etc/dropbear/authorized_keys'
soll "$SSH_T1" "$(fenster f4e "$ID_T1" 600)"
warte 20 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
bx "$HOLEN frist"
sitzung_auf tech1 /root/.ssh/id_rsa eb || falsch "Sitzung mit dem Schluessel, der dauerhaft und im Fenster gilt"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster geschlossen, Fenster-Schluessel gestrichen"
sleep 3
bleibt tech1 eb "derselbe Schluessel zugleich dauerhaft und im Fenster: die Sitzung bleibt, wenn das Fenster endet"
sitzung_schliessen tech1 eb
bx "sed -i '/ tech1\$/d' /etc/dropbear/authorized_keys && $HOLEN frist"
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster geschlossen"

# ── 5 ────────────────────────────────────────────────────────────────────────
schritt "5. Frist ohne Server und ohne Abholer: Fenster 75 s, es bleibt nur der cron-Lauf"
# Nebenbei: ein neuer dauerhafter Schluessel gilt im Tunnel ohne weiteres Zutun.
x werkstatt sh -c 'ssh-keygen -q -t rsa -b 2048 -N "" -C dauerhaft2 -f /tmp/dauerhaft2 && cat /tmp/dauerhaft2.pub' | xi werkstatt ssh "root@$LAN.11" 'cat >> /etc/dropbear/authorized_keys'
soll "$SSH_T1" "$(fenster f5 "$ID_T1" 75)"
warte 15 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
T0="$(ms)"
# Eine Anmeldung, die im Fenster begonnen hat (Abnahme an der Labor-Mango,
# 10.10.2026): was wird aus ihr, wenn der Dienst steht und das Fenster endet?
docker exec -d "$P-tech1" sh -c "ssh $SSH_OPT -i /root/.ssh/id_rsa -p 2222 root@10.10.16.2 'while :; do echo zeile5; sleep 1; done' > /tmp/sitzung5 2>&1"
sitzung5() { x tech1 sh -c 'wc -l < /tmp/sitzung5'; }
sitzung5_waechst() { s5_a="$(sitzung5)"; sleep 2; [ "$(sitzung5)" -gt "$s5_a" ]; }
sitzung_auf tech1 /root/.ssh/id_rsa s5 || falsch "stille Sitzung von tech1"
abholer_anhalten && ok "Abholer angehalten (SIGSTOP)" || falsch "Abholer angehalten"
dienst_aus
lauscht_server && falsch "Schluesselausgabe beendet" || ok "Schluesselausgabe beendet"
sleep 28
box_hat "$ID_T1" && ok "nach $(sek $(($(ms) - T0))) s: Schluessel noch da" || falsch "nach 30 s: Schluessel noch da"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "… und die Anmeldung gelingt (das Fenster steht noch im Kernel)"
sitzung5_waechst && ok "Dienst angehalten, Fenster noch im Kernel: die laufende Sitzung von tech1 laeuft weiter ($(sitzung5) Zeilen)" || falsch "laufende Sitzung laeuft bis zum Ende des Fensters weiter"
warte 140 box_hat_nicht "$ID_T1" && ok "nach $(sek $(($(ms) - T0))) s: Schluessel weg (Frist rund 70 s, der cron-Lauf kommt jede volle Minute)" || falsch "Schluessel verfaellt ohne Server und ohne Abholer"
[ $(($(ms) - T0)) -ge 60000 ] && ok "… nicht vor der Frist" || falsch "… nicht vor der Frist"
endet tech1 s5 "der cron-Lauf beendet auch die Sitzung des verfallenen Schluessels (Abholer und Dienst stehen)"
bx "grep -q ' dauerhaft2\$' $KEYS" && ok "der neu eingetragene dauerhafte Schluessel steht in der Schluesseldatei (vom cron-Lauf uebernommen)" || falsch "neuer dauerhafter Schluessel uebernommen"
# Der Weg durch den Server endet mit dem Fenster, auch ohne Dienst: der Kernel
# laesst das Element ablaufen und verwirft danach jedes Paket der Sitzung.
warte 15 nicht_im_kernel 10.10.32.3 && ok "das Fenster ist im Kernel des Servers abgelaufen (ohne Dienst)" || falsch "Fenster im Kernel abgelaufen"
A="$(sitzung5)"; sleep 5; B="$(sitzung5)"
[ "$A" = "$B" ] && ok "laufende Sitzung mit dem Ende des Fensters abgerissen, Dienst angehalten ($A = $B Zeilen)" || falsch "laufende Sitzung mit dem Ende des Fensters abgerissen ($A -> $B Zeilen)"
warte 5 bx '! pgrep -f "echo zeile[5]" >/dev/null' && ok "… und die mit laufender Ausgabe: ihr Befehl laeuft auf der Box nicht mehr (ohne diese Schranke stand er bis zu 15 min, -K 300)" || falsch "die Sitzung mit laufender Ausgabe ist auf der Box beendet"
luecke_auf 2>/dev/null || true
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "Gegenprobe (Luecke): tech1 meldet sich an"
# Befund vom 10.10.2026, seit dem Entscheid vom selben Tag eine Zusicherung:
# Faellt nach dem Ende des Fensters auch die Firewall des Servers aus, kommt
# eine vorher begonnene Sitzung NICHT wieder durch - die Box hat sie beendet.
stumm tech1 s5 "Luecke der Server-Firewall: die vor dem Ende des Fensters begonnene Sitzung laeuft NICHT wieder"
[ "$(sitzung5)" = "$B" ] && ok "… auch die mit laufender Ausgabe nicht ($B = $(sitzung5) Zeilen)" || falsch "die Sitzung mit laufender Ausgabe laeuft in der Luecke wieder ($B -> $(sitzung5) Zeilen)"
x tech1 sh -c 'pkill -f "zeile[5]"; true'
bx 'for p in $(pgrep -f "echo zeile[5]"); do kill "$p" 2>/dev/null; done; true'
abholer_weiter
bx "sed -i '/ dauerhaft2\$/d' /etc/dropbear/authorized_keys"
soll "$SSH_T1" ""
dienst_an 5s

# ── 5b ───────────────────────────────────────────────────────────────────────
schritt "5b. Protokoll der Box: keine Minutenzeilen mehr, die Ereignisse einer frueheren Sitzung bleiben nachlesbar"
# Seit Schritt 1 lief cron ueber mehrere volle Minuten; in Schritt 5 hat sein
# Lauf den verfallenen Schluessel gestrichen.
MIN="$(( ($(ms) - T_MARKE) / 60000 ))"
marke_da eingerichtet || falsch "die Marke aus Schritt 1 steht noch im Protokollspeicher (sonst zaehlt die naechste Pruefung nichts)"
[ "$MIN" -ge 2 ] && warte 70 frist_frisch && ok "cron laeuft seit $MIN Minuten mit dem Skript dieser Probe; sein letzter Lauf ist $(frist_alter) s her (Lebenszeichen des Laufs)" || falsch "cron laeuft, der Lauf legt ein Lebenszeichen ab (seit $MIN Minuten, Alter: $(frist_alter) s)"
N="$(cron_zeilen eingerichtet)"
[ "$N" = 0 ] && ok "in dieser Zeit steht keine Startzeile von cron im Protokoll der Box" || falsch "keine Startzeile von cron im Protokoll (ist: $N Zeilen in $MIN Minuten)"
# Die Sitzung aus Schritt 4 (Anmeldeprozess $P4): Fenster-Schluessel gekommen,
# Anmeldung, von der Box beendet, Schluessel gestrichen.
ER="$(ereignisse)"
SITZUNG4="Sitzung beendet (Dropbear-Prozess $P4): ihr Fenster-Schluessel ist gestrichen"
pruefe_sitzung4() { # <woher>
  printf '%s\n' "$ER" | grep -q "vp-wartung: Fenster-Schluessel jetzt: $ID_T1 *\$" &&
    printf '%s\n' "$ER" | grep -q "dropbear\[$P4\]: Pubkey auth succeeded for 'root' with ssh-rsa key SHA256:[A-Za-z0-9+/]* from 10.10.32.3:[0-9]*\$" &&
    printf '%s\n' "$ER" | grep -q "vp-wartung: $SITZUNG4\$" &&
    printf '%s\n' "$ER" | grep -q "dropbear\[$P4\]: Exit (root) from <10.10.32.3:[0-9]*>: Terminated by signal\$" &&
    ok "$1: Schluessel des Fensters gekommen (Zugang), Anmeldung (Fingerabdruck, Absender, Zeit), von der Box beendet und warum, Ende der Sitzung" ||
    falsch "$1: die Ereignisse der Sitzung aus Schritt 4 stehen in der Liste"
}
pruefe_sitzung4 "Ereignisliste"
printf '%s\n' "$ER" | grep -q "Fenster-Schluessel jetzt: keine *\$" && ok "… und wann der Schluessel gestrichen wurde" || falsch "die Liste nennt das Streichen des Schluessels"
# Jetzt so viele Zeilen, wie die Zeitauftraege frueher in Stunden schrieben -
# dazwischen der Lauf, den cron jede Minute startet. Der Protokolldienst muss
# dabei durchlaufen: startet er neu, ist sein Speicher leer statt uebergelaufen.
LOGD="$(bx 'pgrep -f /sbin/logd | head -n 1')"
N_FLUT="$(bx "i=0; while [ \$i -lt 6000 ] && logread | grep -q 'Dropbear-Prozess $P4)'; do j=0
  while [ \$j -lt 200 ]; do logger -t 'minutenzeile[1]' -p cron.err \"USER root pid \$i cmd $HOLEN frist\"; j=\$((j + 1)); i=\$((i + 1)); done
  $HOLEN frist; done; echo \$i")"
bx "! logread | grep -q 'Dropbear-Prozess $P4)'" && [ -n "$LOGD" ] && [ "$(bx 'pgrep -f /sbin/logd | head -n 1')" = "$LOGD" ] && [ "$(bx 'logread | grep -c minutenzeile')" -ge 500 ] && ok "Protokollspeicher uebergelaufen: nach $N_FLUT Zeilen (so viele schrieb cron frueher in $((N_FLUT / 132)) Stunden) nennt logread die Sitzung aus Schritt 4 nicht mehr" || falsch "Protokollspeicher uebergelaufen, der Protokolldienst lief durch ($N_FLUT Zeilen)"
ER="$(ereignisse)"
pruefe_sitzung4 "danach, nach $((N_FLUT / 200)) weiteren Minutenlaeufen"
[ "$(printf '%s\n' "$ER" | grep -c "$SITZUNG4")" = 1 ] && ok "… jedes Ereignis genau einmal (die Laeufe uebernehmen nur, was neu ist)" || falsch "jedes Ereignis genau einmal (ist: $(printf '%s\n' "$ER" | grep -c "$SITZUNG4"))"
ST="$(bx "$HOLEN status" 2>&1 || true)"
case "$ST" in
  *"Ereignisse der Fernwartung: "*" in $EREIGNISSE"*"die letzten:"*) ok "status zeigt die letzten Ereignisse" ;;
  *) falsch "status zeigt die letzten Ereignisse" ;;
esac
printf '%s\n' "$ST" | sed -n '/Ereignisse der Fernwartung/,$p' | sed 's/^/    | /'
bx "[ -s $EREIGNISSE ] && ! grep -q -e 'AAAA[BCE][0-9A-Za-z]' -e '$ALT_TEXT' -e '$NEU_TEXT' $EREIGNISSE" && ok "kein Schluessel in der Liste (nur Zugang und Fingerabdruck)" || falsch "kein Schluessel in der Liste"
bx "[ -s $EREIGNISSE ] && ! grep -q -e 'from <\{0,1\}$LAN\.' -e 'Exit before auth' -e 'minutenzeile' $EREIGNISSE" && ok "nur Anmeldungen durch den Tunnel: die der Werkstatt an Port 22 im LAN stehen nicht darin, auch sonst nichts" || falsch "nur Anmeldungen durch den Tunnel in der Liste"
bx "[ \"\$(ls -l $EREIGNISSE 2>/dev/null | cut -c 1-10)\" = -rw------- ] && [ \"\$(df -P $EREIGNISSE | awk 'NR == 2 { print \$1 }')\" != tmpfs ] && [ \"\$(df -P $EREIGNISSE | awk 'NR == 2 { print \$1 }')\" != vp-wartung ]" &&
  ok "die Liste liegt im Flash, nicht im RAM, lesbar nur fuer root ($(ereignis_zeilen) Zeilen, $(bx "wc -c < $EREIGNISSE" || true) Bytes)" || falsch "die Liste liegt im Flash, nur fuer root"
SUMME_E="$(bx "md5sum < $EREIGNISSE" || true)"
bx "$HOLEN frist; sleep 2; $HOLEN frist; sleep 2"
[ -n "$SUMME_E" ] && [ "$(bx "md5sum < $EREIGNISSE" || true)" = "$SUMME_E" ] && ok "ohne neues Ereignis schreibt ein Lauf nichts in den Flash (Datei unveraendert)" || falsch "ohne neues Ereignis bleibt die Datei unveraendert"

# ── 6 ────────────────────────────────────────────────────────────────────────
schritt "6. Neustart der Box mitten im Fenster, Schluesselausgabe solange angehalten"
soll "$SSH_T1" "$(fenster f6 "$ID_T1" 600)"
warte 20 box_hat "$ID_T1" && ok "Fenster offen, Schluessel auf der Box" || falsch "Fenster offen, Schluessel auf der Box"
sitzung_auf tech1 /root/.ssh/id_rsa s6a || falsch "stille Sitzung von tech1 vor dem Neustart"
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
bx "! logread | grep -q -e 'Dropbear-Prozess $P4)' -e 'minutenzeile'" && ereignis "vp-wartung: $SITZUNG4\$" &&
  ok "der Protokollspeicher ist nach dem Neustart leer, die Ereignisliste nennt die Sitzung aus Schritt 4 weiter" || falsch "die Ereignisliste uebersteht den Neustart"
im_kernel 10.10.32.3 && ok "das Fenster steht weiter im Kernel des Servers" || falsch "das Fenster steht weiter im Kernel des Servers"
erwarte tech1 /root/.ssh/id_rsa ABGEWIESEN "tech1 -> Box nach dem Neustart, ohne Schluesselausgabe"
T0="$(ms)"
dienst_an 5s
warte 30 box_hat "$ID_T1" && ok "Schluesselausgabe wieder an: Schluessel nach $(sek $(($(ms) - T0))) s zurueck" || falsch "Schluessel kommt von selbst wieder"
erwarte tech1 /root/.ssh/id_rsa ANGEMELDET "tech1 -> Box"
stumm tech1 s6a "die Sitzung von vor dem Neustart gibt es nicht mehr (Fenster offen, Schluessel wieder da)"
# Die Zuordnung haengt an nichts, was der Neustart geloescht hat: neue Sitzung,
# dann starten auch Lauscher und Abholer neu - die Sitzung haengt danach an
# keinem Lauscher mehr - und erst dann endet das Fenster.
sitzung_auf tech1 /root/.ssh/id_rsa s6 || falsch "stille Sitzung von tech1 nach dem Neustart"
P6="$(sitzung_pid tech1 s6)"
# Angehalten wird hier mit dem Schritt, den die Box beim Herunterfahren
# ausfuehrt (K20): er uebernimmt, was seit dem letzten cron-Lauf geschah - die
# Anmeldung von eben steht in der Liste, ohne dass ein Lauf dazwischen kam.
bx '/etc/rc.d/K20vp-wartung shutdown; /etc/init.d/vp-wartung start' || true
bx "grep -q 'dropbear\[$P6\]: Pubkey auth succeeded .* from 10.10.32.3:' $EREIGNISSE 2>/dev/null" && bx '[ -L /etc/rc.d/K20vp-wartung ]' &&
  ok "Herunterfahren (K20, vor dem Protokolldienst): die Anmeldung von eben kommt noch in die Liste" || falsch "beim Herunterfahren uebernimmt der Abholer die letzten Ereignisse (K20)"
warte 20 lauscht 10.10.16.2:2222 && warte 20 abholer_laeuft || falsch "Lauscher und Abholer nach restart wieder da"
warte 20 box_hat "$ID_T1" || falsch "Schluessel nach restart auf der Box"
[ "$(bx "awk '/^PPid:/ { print \$2 }' /proc/$P6/status")" = 1 ] && [ "$(bx 'cat /var/run/dropbear.vp_wartung.pid')" != "$P6" ] &&
  ok "Lauscher und Abholer neu gestartet: die Sitzung steht weiter, jetzt ohne ihren Lauscher (Elternprozess 1)" || falsch "die Sitzung uebersteht den Neustart von Lauscher und Abholer"
antwortet tech1 s6 "… und antwortet (ihr Schluessel gilt)"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster geschlossen, Schluessel gestrichen"
endet tech1 s6 "Fenster geschlossen: die Box beendet die Sitzung auch nach beiden Neustarts"
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster im Kernel weg"
dienst_aus
luecke_auf
offen tech1 10.10.16.2 2222 "Luecke: tech1 erreicht den Port"
stumm tech1 s6 "Luecke der Server-Firewall: die Sitzung laeuft NICHT wieder"
dienst_an 5s

# ── 6b ───────────────────────────────────────────────────────────────────────
schritt "6b. Die Obergrenze der Ereignisliste haelt; ein Zeitauftrag, der ausbleibt, faellt weiter auf"
# 320 Ereignisse, in Schueben von 40 uebernommen: die Liste hat nie mehr als 250 Zeilen.
E_MAX="$(bx "m=0; i=0; while [ \$i -lt 320 ]; do logger -t vp-wartung \"Fenster-Schluessel jetzt: probe-\$i\"; i=\$((i + 1))
  [ \$((i % 40)) -eq 0 ] || continue; $HOLEN ereignisse >/dev/null 2>&1; n=\$(wc -l < $EREIGNISSE 2>/dev/null); [ \"\${n:-0}\" -le \"\$m\" ] || m=\$n; done; echo \$m" || true)"
E_JETZT="$(ereignis_zeilen)"
[ "${E_MAX:-0}" -ge 200 ] && [ "$E_MAX" -le 250 ] && [ "$E_JETZT" -le 250 ] && ok "320 Ereignisse dazu: die Liste hatte nie mehr als $E_MAX Zeilen (Obergrenze 250), jetzt $E_JETZT" || falsch "die Obergrenze von 250 Zeilen haelt (hoechster Stand: ${E_MAX:-keiner}, jetzt: $E_JETZT)"
bx "grep -q 'jetzt: probe-319 *\$' $EREIGNISSE && ! grep -q -e 'jetzt: probe-0 *\$' -e 'Dropbear-Prozess $P4)' $EREIGNISSE" && ok "es bleiben die neuesten: das letzte Ereignis steht darin, das aelteste und die Sitzung aus Schritt 4 nicht mehr" || falsch "es bleiben die neuesten Ereignisse"
bx "logger -t vp-wartung \"Fenster-Schluessel jetzt: \$(head -c 900 /dev/zero | tr '\\0' z)\"; $HOLEN ereignisse >/dev/null 2>&1; true"
bx "grep -q 'jetzt: zzzzzzzz' $EREIGNISSE && ! awk 'length(\$0) > 400 { f = 1 } END { exit !f }' $EREIGNISSE && [ \"\$(wc -c < $EREIGNISSE)\" -le 100250 ]" &&
  ok "eine ueberlange Zeile wird bei 400 Zeichen abgeschnitten; die Datei bleibt unter 100 KB ($(bx "wc -c < $EREIGNISSE" || true) Bytes)" || falsch "Zeilen hoechstens 400 Zeichen, Datei unter 100 KB"
# Ein Zeitauftrag faellt aus. cron selbst meldet weiter, was es nicht lesen kann;
# dass der Lauf der Fenster-Schluessel ausbleibt, meldet der Abholer.
marke zeitauftrag
bx "cp /etc/crontabs/root /tmp/crontab.gut; grep -v 'vp-wartung-frist\$' /tmp/crontab.gut > /etc/crontabs/root
  echo '61 * * * * true # vpwa-unlesbar' >> /etc/crontabs/root; /etc/init.d/cron restart"
warte 15 bx 'logread | grep -q "crond\[[0-9]*\]: user root: parse error at 61"' && ok "Fehler von cron selbst stehen weiter im Protokoll: eine unlesbare Zeile der crontab (\"user root: parse error at 61\")" || falsch "cron meldet eine unlesbare Zeile der crontab weiter"
# Die Zeile des Laufs fehlt: als waere sein letzter Lauf zehn Minuten her.
bx 'echo $(( $(cut -d. -f1 /proc/uptime) - 600 )) > /tmp/vp-wartung/frist'
bx "$HOLEN status" 2>&1 | grep -q 'cron-Lauf (streicht Verfallenes, jede Minute): AUSGEBLIEBEN seit [0-9]* s' && ok "status: der cron-Lauf ist ausgeblieben" || falsch "status nennt den ausgebliebenen cron-Lauf"
soll "$SSH_T1" "$(fenster f6b "$ID_T1" 600)" # der Abholer bekommt eine Antwort und dreht eine Runde
warte 20 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
warte 70 bx "logread -e vp-wartung | grep -q 'FEHLER: der cron-Lauf (frist) ist seit [0-9]* s ausgeblieben'" && ok "Protokoll der Box: der Abholer meldet, dass der Zeitauftrag ausbleibt (cron selbst sagte dazu nie etwas)" || falsch "der Abholer meldet den ausgebliebenen Zeitauftrag"
bx 'cat /tmp/crontab.gut > /etc/crontabs/root; rm -f /tmp/crontab.gut; /etc/init.d/cron restart'
warte 75 frist_frisch && ok "crontab wieder ganz: der Lauf kommt wieder (Lebenszeichen $(frist_alter) s alt)" || falsch "der cron-Lauf kommt wieder"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster geschlossen, Schluessel gestrichen"
warte 70 bx "logread -e vp-wartung | grep -q 'der cron-Lauf (frist) kommt wieder'" && ok "… und der Abholer meldet auch das" || falsch "der Abholer meldet, dass der cron-Lauf wieder kommt"
marke_da zeitauftrag && [ "$(cron_zeilen zeitauftrag)" = 0 ] && ok "auch nach dem Neustart von cron keine Startzeile im Protokoll" || falsch "nach dem Neustart von cron keine Startzeile im Protokoll"
warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster im Kernel weg"

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
warte 30 box_hat "$ID_T1" || falsch "Fenster-Schluessel nach ifup auf der Box"
sitzung_auf tech1 /root/.ssh/id_rsa s10 || falsch "stille Sitzung von tech1 vor dem Abraeumen"
einrichten werkstatt "root@$LAN.11" VP_SERVICE_SCHLUESSEL=aus >"$ARBEIT/einrichten.10" 2>&1 && ok "eingerichtet ohne Fenster-Schluessel" || falsch "eingerichtet ohne Fenster-Schluessel"
endet tech1 s10 "mit der Instanz der Fenster-Schluessel enden ihre Sitzungen (danach beendete sie niemand mehr)"
stumm tech1 s10 "… die Sitzung antwortet nicht mehr, obwohl das Fenster offen ist"
bx '[ "$(uci -q get dropbear.vp_wartung.Interface)" = wg_wartung ] && [ ! -e /etc/init.d/vp-wartung ] && [ ! -e /usr/libexec/vp-wartung ] && [ ! -e /etc/vp-wartung ] && ! grep -q vp-wartung /proc/mounts /etc/crontabs/root /etc/sysupgrade.conf' &&
  ok "UCI-Instanz wieder da; Abholer, Startskript, RAM-Bereich und cron-Zeile abgeraeumt" || falsch "UCI-Instanz wieder da, Abholer abgeraeumt"
bx '[ ! -e /etc/rc.d/K20vp-wartung ] && [ ! -e /etc/rc.d/S60vp-wartung ] && [ "$(uci -q get system.@system[0].cronloglevel)" = 9 ]' &&
  ok "mit dem Abholer ist auch die Ereignisliste weg; der Tunnel steht, cron protokolliert weiter keine Starts" || falsch "Ereignisliste und Startverweise weg, cronloglevel bleibt 9"
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

# ── 11b ──────────────────────────────────────────────────────────────────────
schritt "11b. Ausrollen: Box mit dem Skript vor dieser Aenderung, offene Sitzungen"
soll "$SSH_T1" ""
warte 15 box_hat_keinen || falsch "Fenster geschlossen"
if [ "$VOR" = ja ]; then
  SKRIPT=/vor/service-tunnel.sh
  einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.11v" 2>&1 && ok "Box auf dem Stand vor dieser Aenderung eingerichtet (Fenster-Schluessel, Abholer von vorher)" || falsch "Box auf dem Stand vor dieser Aenderung eingerichtet"
  SKRIPT=/skript/service-tunnel.sh
  soll "$SSH_T1" "$(fenster f11v "$ID_T1" 600)"
  warte 30 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
  bx "! grep -q ' vp[df]-[0-9a-f]' $KEYS" && bx "! $HOLEN status | grep -q 'Sitzungen im Tunnel'" && ok "vorher: die Schluesseldatei traegt keine Marke, status nennt keine Sitzungen" || falsch "vorher: keine Marke, status ohne Sitzungen"
  sitzung_auf tech1 /root/.ssh/id_rsa sv || falsch "stille Sitzung von tech1"
  soll "$SSH_T1" ""
  warte 15 box_hat_keinen && warte 15 nicht_im_kernel 10.10.32.3 || falsch "Fenster geschlossen, Schluessel gestrichen"
  sleep 3
  bleibt tech1 sv "Skript von vorher: die Box streicht nur den Schluessel, der Anmeldeprozess bleibt stehen"
  dienst_aus
  luecke_auf
  antwortet tech1 sv "… und in der Luecke der Server-Firewall laeuft die Sitzung wieder (der Befund vom 10.10.2026)"
  dienst_an 5s
  # Jetzt das Skript dieser Aenderung, waehrend Sitzungen offen stehen.
  soll "$SSH_T1" "$(fenster f11w "$ID_T1" 600)"
  warte 30 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
  sitzung_auf tech1 /root/.ssh/id_rsa_werkstatt svd || falsch "stille Sitzung mit dem dauerhaften Schluessel"
  IFINDEX="$(bx 'cat /sys/class/net/wg_wartung/ifindex')"
  einrichten werkstatt "root@$LAN.11" >"$ARBEIT/einrichten.11w" 2>&1 && ok "service-tunnel.sh dieser Aenderung laeuft ueber das Skript von vorher" || falsch "service-tunnel.sh dieser Aenderung laeuft ueber das Skript von vorher"
  grep -q 'Tunnel unveraendert' "$ARBEIT/einrichten.11w" && [ "$(bx 'cat /sys/class/net/wg_wartung/ifindex')" = "$IFINDEX" ] && ok "der Tunnel wird dabei nicht angefasst" || falsch "der Tunnel wird dabei nicht angefasst"
  warte 20 box_hat "$ID_T1" || falsch "Schluessel nach dem Lauf auf der Box"
  [ "$(bx "grep -c '^ssh-rsa [^ ]* vp[df]-[0-9a-f]\\{32\\} ' $KEYS")" = 2 ] && ok "nachher: beide Zeilen der Schluesseldatei tragen eine Marke" || falsch "nachher: die Schluesseldatei traegt Marken"
  bleibt tech1 sv "die offene Sitzung mit dem Fenster-Schluessel uebersteht den Lauf"
  bleibt tech1 svd "die offene Sitzung mit dem dauerhaften Schluessel uebersteht den Lauf"
  antwortet tech1 sv "… und laeuft weiter"
  bx "$HOLEN status" | grep -q "Sitzungen im Tunnel: 2 - dauerhafter Schluessel 0, Fenster-Schluessel 0, gestrichener Fenster-Schluessel 0, nicht zuzuordnen 2" &&
    ok "status: beide Sitzungen von vorher sind nicht zuzuordnen (sie tragen keine Marke)" || falsch "status: Sitzungen von vorher nicht zuzuordnen ($(bx "$HOLEN status" | grep 'Sitzungen im Tunnel'))"
  sitzung_auf tech1 /root/.ssh/id_rsa sn || falsch "neue Sitzung mit dem Fenster-Schluessel"
  sitzung_auf tech1 /root/.ssh/id_rsa_werkstatt snd || falsch "neue Sitzung mit dem dauerhaften Schluessel"
  soll "$SSH_T1" ""
  warte 15 box_hat_keinen || falsch "Fenster geschlossen, Schluessel gestrichen"
  endet tech1 sn "erstes Streichen nach dem Ausrollen: die neue Sitzung des Fenster-Schluessels endet"
  endet tech1 sv "… die Sitzung von vorher mit dem Fenster-Schluessel endet"
  endet tech1 svd "… die von vorher mit dem dauerhaften Schluessel auch (nicht zuzuordnen, im Zweifel endet sie)"
  bleibt tech1 snd "… die nach dem Lauf begonnene Sitzung mit dem dauerhaften Schluessel bleibt"
else
  hinweis "Skript vor dieser Aenderung nicht im git-Verlauf: Schritt 11b ausgelassen"
fi
soll "$SSH_T1" "$(fenster f12 "$ID_T1" 600)"
warte 30 box_hat "$ID_T1" || falsch "Fenster offen, Schluessel auf der Box"
[ "$VOR" = ja ] || sitzung_auf tech1 /root/.ssh/id_rsa_werkstatt snd || falsch "Sitzung mit dem dauerhaften Schluessel"

# ── 12 ───────────────────────────────────────────────────────────────────────
schritt "12. status, sysupgrade, abbauen"
ST="$(tunnel status 2>&1)"
printf '%s\n' "$ST" | sed -n '/^--- /,$p' | sed 's/^/    | /'
for z in "SSH 2222 lauscht auf: 10.10.16.2:2222" "SSH 2222 ausserhalb der Tunnel: abgewiesen (nur aus { \"lo\", \"wg_wartung\" }" \
  "Fenster-Schluessel: Abholer laeuft, Server 10.10.32.1:$SPORT ueber wg_wartung" "letzte gueltige Antwort des Wartungsservers: vor " \
  "Schluesseldatei im RAM (tmpfs /etc/vp-wartung/keys): ja" "dauerhaft aus /etc/dropbear/authorized_keys: 1 Schluessel" "im Fenster: Zugang $ID_T1, noch " \
  "Sitzungen im Tunnel: 1 - dauerhafter Schluessel 1, Fenster-Schluessel 0, gestrichener Fenster-Schluessel 0, nicht zuzuordnen 0" \
  "cron protokolliert die Starts der Zeitauftraege: nein (cronloglevel 9" "cron-Lauf (streicht Verfallenes, jede Minute): zuletzt vor " \
  "Ereignisse der Fernwartung: "; do
  case "$ST" in *"$z"*) ok "status: $z…" ;; *) falsch "status: $z…" ;; esac
done
case "$ST" in *AAAAB3NzaC1yc2E*) falsch "status zeigt keinen Schluessel" ;; *) ok "status zeigt keinen Schluessel" ;; esac
SU="$(bx 'sysupgrade -l 2>/dev/null')"
for f in /usr/libexec/vp-wartung/schluessel-holen.sh /etc/init.d/vp-wartung /etc/rc.d/S60vp-wartung /etc/config/vp-wartung /etc/nftables.d/20-vp-wartung.nft \
  /usr/libexec/vp-edge-light/service-tunnel-watch.sh /etc/wireguard/vp-wartung.key /etc/crontabs/root \
  /etc/vp-wartung/ereignisse /etc/rc.d/K20vp-wartung /etc/config/system; do
  printf '%s\n' "$SU" | grep -qx "$f" && ok "sysupgrade -l nennt $f" || falsch "sysupgrade -l nennt $f"
done
printf '%s\n' "$SU" | grep '^/etc/vp-wartung' | grep -q -v -x "$EREIGNISSE" && falsch "die Schluesseldatei im RAM steht nicht in der Sicherung" || ok "die Schluesseldatei im RAM steht nicht in der Sicherung (aus /etc/vp-wartung nur die Ereignisliste)"
[ "$(printf '%s\n' "$SU" | grep -c 'vp-wartung')" = 8 ] && ok "acht Zeilen mit vp-wartung: die sechs von bisher, dazu die Ereignisliste und der Verweis fuer das Herunterfahren" || falsch "sysupgrade -l nennt genau acht Zeilen mit vp-wartung (ist: $(printf '%s\n' "$SU" | grep -c 'vp-wartung'))"
P12="$(sitzung_pid tech1 snd)"
soll "$SSH_T1" ""
tunnel abbauen wg_wartung >"$ARBEIT/abbauen" 2>&1 && ok "abbauen wg_wartung laeuft durch" || falsch "abbauen wg_wartung laeuft durch"
[ -n "$P12" ] && warte 5 box_prozess_weg "$P12" && ok "mit dem Tunnel endet auch die Sitzung, die noch offen stand (Dropbear-Prozess $P12)" || falsch "abbauen beendet die offene Sitzung im Tunnel"
bx '[ ! -e /etc/init.d/vp-wartung ] && [ ! -e /etc/rc.d/S60vp-wartung ] && [ ! -e /etc/rc.d/K20vp-wartung ] && [ ! -e /usr/libexec/vp-wartung ] && [ ! -e /etc/vp-wartung ] && [ ! -e /etc/config/vp-wartung ] && [ ! -e /tmp/vp-wartung ]' &&
  ok "Abholer, Startskript, Einstellung, Arbeitsstand und Ereignisliste weg" || falsch "Abholer, Startskript, Einstellung, Arbeitsstand und Ereignisliste weg"
bx '[ -z "$(uci -q get system.@system[0].cronloglevel)" ] && pgrep crond >/dev/null && ! tr "\0" " " < /proc/$(pgrep crond | head -n 1)/cmdline | grep -q -- "-l 9"' &&
  ok "mit dem letzten Tunnel protokolliert cron wieder wie vom System vorgegeben (cronloglevel nicht mehr gesetzt)" || falsch "cronloglevel nach dem Abbauen nicht mehr gesetzt"
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
