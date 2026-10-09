#!/bin/sh
# Integrationsprobe des Tunnel-Dienstes gegen ECHTES Kernel-WireGuard und
# ECHTES nftables - ohne Root auf dem Rechner, in Docker-Containern mit
# NET_ADMIN.
#
# Vier Container auf einem eigenen Docker-Netz:
#   server  wg-wartung (10.10.16.1/20 + 10.10.32.1/24, UDP 51820),
#           vp-tunnel-dienst und die API-Attrappe (test/attrappe)
#   box1    10.10.16.2, lauscht auf 2222 (SSH-Ersatz), 8484 (Dauerstrom), 9999
#   box2    10.10.16.3, lauscht auf 2222
#   tech    10.10.32.2, lauscht auf 2222 (prüft, dass eine Box nichts öffnet)
# Die Boxen bekommen absichtlich weitere erlaubte Netze als im Betrieb, damit
# sie Box <-> Box überhaupt versuchen können - der Server muss es verwerfen.
#
# Aufruf aus dem Repo:   services/tunnel-dienst/test/integration.sh
# Ohne DNS im Container: VPTD_DOCKER_DNS=1.1.1.1 services/tunnel-dienst/test/integration.sh
# Wie die VM (Debian 12, nftables 1.0.6): VPTD_BASIS=debian …
# Voraussetzung: Docker; der Host-Kernel kann WireGuard (ab Linux 5.6 eingebaut).
# shellcheck disable=SC2015 # ok()/falsch() schlagen nie fehl: A && ok || falsch ist hier if-then-else
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
MODUL="$(cd "$HIER/.." && pwd -P)"
P="vptd-$$"
NETZ="${VPTD_NETZ:-172.30.99}"
BASIS="${VPTD_BASIS:-alpine}"
case "$BASIS" in
  alpine) BILD="vptd-probe:alpine3.20" ;;
  debian) BILD="vptd-probe:bookworm" ;;
  *) echo "VPTD_BASIS: alpine oder debian" >&2; exit 2 ;;
esac
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
BIN="$(mktemp -d)"
FEHLER=0
OK=0

aufraeumen() {
  docker rm -f "$P-server" "$P-box1" "$P-box2" "$P-tech" >/dev/null 2>&1 || true
  docker network rm "$P" >/dev/null 2>&1 || true
  rm -rf "$BIN"
}
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }

x() { c="$1"; shift; docker exec "$P-$c" "$@"; }
xi() { c="$1"; shift; docker exec -i "$P-$c" "$@"; }

# tcp <von> <ziel-ip> <port>: Text der Gegenseite, sonst leer (2 s Verbindungsaufbau)
tcp() { x "$1" timeout 5 socat -u "TCP:$2:$3,connect-timeout=2" STDOUT 2>/dev/null || true; }
erreicht() { # erreicht <von> <ip> <port> <erwarteter Text> <Beschreibung>
  if [ "$(tcp "$1" "$2" "$3")" = "$4" ]; then ok "$5"; else falsch "$5"; fi
}
gesperrt() { # gesperrt <von> <ip> <port> <Beschreibung>
  if [ -z "$(tcp "$1" "$2" "$3")" ]; then ok "$4"; else falsch "$4"; fi
}
ping_ja() { if x "$1" ping -c1 -W2 "$2" >/dev/null 2>&1; then ok "$3"; else falsch "$3"; fi; }
# warte_tunnel <von> <server-ip>: bis der Handshake (wieder) steht, höchstens 40 s.
# Nach einem Neustart des Servers verwirft dieser die alten Sitzungen; der
# Client verhandelt neu, sobald er 15 s keine Antwort bekommt.
warte_tunnel() {
  i=0
  while [ "$i" -lt 40 ]; do
    x "$1" ping -c1 -W1 "$2" >/dev/null 2>&1 && return 0
    i=$((i + 1))
  done
  return 1
}
ping_nein() { if x "$1" ping -c1 -W2 "$2" >/dev/null 2>&1; then falsch "$3"; else ok "$3"; fi; }

DIENST_ENV="-e VP_TUNNEL_API_URL=http://127.0.0.1:8080 -e VP_TUNNEL_TOKEN_URL=http://127.0.0.1:8080/token \
 -e VP_TUNNEL_CLIENT_SECRET_FILE=/srv/secret -e VP_TUNNEL_ZUSTAND=/srv/zustand"
# einmal [weitere -e ...]: ein Lauf des Dienstes; Ausgabe nach /srv/log, Rückgabe des Dienstes
einmal() {
  # shellcheck disable=SC2086 # Umgebung bewusst als Wortliste
  docker exec $DIENST_ENV "$@" "$P-server" sh -c '/opt/vptd/vp-tunnel-dienst einmal >>/srv/log 2>&1'
}
peers() { x server wg show wg-wartung peers | grep -c . || true; }
elemente() { x server nft -j list set inet voltpilot_wartung fenster 2>/dev/null | grep -o '"concat"' | grep -c . || true; }
api_aus() {
  # shellcheck disable=SC2016 # wird im Container ausgewertet
  x server sh -c '[ -s /srv/api.pid ] && kill "$(cat /srv/api.pid)" 2>/dev/null; rm -f /srv/api.pid; true'
  sleep 1
}
api_an() {
  api_aus
  docker exec -d "$P-server" sh -c 'echo $$ > /srv/api.pid; exec /opt/vptd/attrappe -soll /srv/soll.json'
  sleep 1
}

zeit() { date -u -d "@$(($(date +%s) + $1))" +%Y-%m-%dT%H:%M:%SZ; }
# soll <fenster-json>: schreibt den Soll-Stand mit allen drei Peers
soll() {
  cat <<EOF | xi server sh -c 'cat > /srv/soll.json'
{"version":1,"erzeugtAm":"$(zeit 0)","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24",
 "peers":[
  {"art":"box","id":"b1","kennung":"edge-zay5sdd","publicKey":"$PUB_BOX1","adresse":"10.10.16.2"},
  {"art":"box","id":"b2","kennung":"edge-k7m2xq3","publicKey":"$PUB_BOX2","adresse":"10.10.16.3"},
  {"art":"techniker","id":"t1","kennung":"Probe-Techniker","publicKey":"$PUB_TECH","adresse":"10.10.32.2"}],
 "fenster":[$1]}
EOF
}
fenster() { echo "{\"id\":\"$1\",\"boxId\":\"$2\",\"technikerId\":\"t1\",\"beginn\":\"$(zeit -5)\",\"ende\":\"$(zeit "$3")\"}"; }

schritt "Bauen"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
  -v "$MODUL":/src:ro -v "$BIN":/out -w /src golang:1.24 \
  sh -c 'go build -ldflags "-X main.version=probe-1a2b3c" -o /out/vp-tunnel-dienst ./cmd/vp-tunnel-dienst && go build -o /out/attrappe ./test/attrappe'
if ! docker image inspect "$BILD" >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  if [ "$BASIS" = alpine ]; then
    docker run --name "$P-bau" $DNS alpine:3.20 apk add --no-cache wireguard-tools-wg iproute2 nftables socat setpriv >/dev/null
  else
    docker run --name "$P-bau" $DNS debian:bookworm-slim sh -c 'apt-get -qq update && DEBIAN_FRONTEND=noninteractive \
      apt-get -qq install -y --no-install-recommends wireguard-tools nftables iproute2 socat iputils-ping procps util-linux' >/dev/null
  fi
  docker commit "$P-bau" "$BILD" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
echo "  Bild $BILD, Programme in $BIN"

schritt "Aufbau: Server, zwei Boxen, ein Techniker"
docker network create --subnet "$NETZ.0/24" "$P" >/dev/null
starte() { # starte <name> <ip> [docker-optionen]
  n="$1"; ip="$2"; shift 2
  docker run -d --name "$P-$n" --hostname "$n" --network "$P" --ip "$NETZ.$ip" --cap-add NET_ADMIN "$@" \
    "$BILD" sleep infinity >/dev/null
  x "$n" sh -c 'umask 077; wg genkey > /k; wg pubkey < /k > /p'
}
starte server 10 --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.send_redirects=0 -v "$BIN:/opt/vptd:ro"
starte box1 11
starte box2 12
starte tech 13
PUB_SERVER="$(x server cat /p)"; PUB_BOX1="$(x box1 cat /p)"; PUB_BOX2="$(x box2 cat /p)"; PUB_TECH="$(x tech cat /p)"

wg_server() {
  x server sh -c 'ip link add wg-wartung type wireguard && wg set wg-wartung private-key /k listen-port 51820 &&
    ip addr add 10.10.16.1/20 dev wg-wartung && ip addr add 10.10.32.1/24 dev wg-wartung && ip link set wg-wartung up'
}
wg_server
x server sh -c 'mkdir -p /srv/zustand && echo probe-geheim > /srv/secret && chmod 600 /srv/secret && : > /srv/log'
client() { # client <name> <adresse> <erlaubte netze>
  x "$1" sh -c "ip link add wg0 type wireguard && wg set wg0 private-key /k peer $PUB_SERVER endpoint $NETZ.10:51820 \
    allowed-ips $3 persistent-keepalive 5 && ip addr add $2/32 dev wg0 && ip link set wg0 up &&
    for n in \$(echo $3 | tr , ' '); do ip route add \$n dev wg0; done"
}
client box1 10.10.16.2 10.10.16.0/20,10.10.32.0/24
client box2 10.10.16.3 10.10.16.0/20,10.10.32.0/24
client tech 10.10.32.2 10.10.16.0/20
docker exec -d "$P-box1" socat TCP-LISTEN:2222,fork,reuseaddr SYSTEM:'echo box1'
docker exec -d "$P-box1" socat TCP-LISTEN:9999,fork,reuseaddr SYSTEM:'echo box1-9999'
docker exec -d "$P-box1" socat TCP-LISTEN:8484,fork,reuseaddr SYSTEM:'while true; do echo tick; sleep 1; done'
docker exec -d "$P-box2" socat TCP-LISTEN:2222,fork,reuseaddr SYSTEM:'echo box2'
docker exec -d "$P-tech" socat TCP-LISTEN:2222,fork,reuseaddr SYSTEM:'echo tech'
api_an

schritt "1. Peers ohne Fenster: Tunnel steht, aber kein Weg"
soll ""
if einmal; then ok "Lauf erfolgreich"; else falsch "Lauf erfolgreich"; fi
[ "$(peers)" = 3 ] && ok "3 Peers auf wg-wartung" || falsch "3 Peers auf wg-wartung (ist: $(peers))"
x server nft list table inet voltpilot_wartung >/dev/null 2>&1 && ok "Tabelle voltpilot_wartung angelegt" || falsch "Tabelle angelegt"
[ "$(x server /opt/vptd/vp-tunnel-dienst version)" = "vp-tunnel-dienst Version probe-1a2b3c" ] && ok "version nennt den beim Bau gesetzten Stand" || falsch "version nennt den beim Bau gesetzten Stand"
st="$(x server /opt/vptd/vp-tunnel-dienst status 2>&1 || true)"
echo "$st" | grep -q "Version probe-1a2b3c" && ok "status nennt die Version" || falsch "status nennt die Version"
echo "$st" | grep -q "Firewall-Basis stimmt: ja" && ok "status: Firewall-Basis stimmt" || falsch "status: Firewall-Basis stimmt"
ping_ja box1 10.10.16.1 "Box erreicht den Server (Handshake, nur Ping)"
ping_ja tech 10.10.16.1 "Techniker erreicht den Server (Handshake, nur Ping)"
ping_nein tech 10.10.16.2 "Techniker -> Box ohne Fenster: Ping verworfen"
gesperrt tech 10.10.16.2 2222 "Techniker -> Box ohne Fenster: 2222 verworfen"
gesperrt box1 10.10.16.3 2222 "Box -> Box verworfen"
ping_nein box1 10.10.16.3 "Box -> Box Ping verworfen"
gesperrt box1 10.10.32.2 2222 "Box -> Techniker (neue Verbindung) verworfen"

schritt "2. Fenster Techniker -> box1 offen"
soll "$(fenster f1 b1 40)"
einmal && ok "Lauf erfolgreich" || falsch "Lauf erfolgreich"
[ "$(elemente)" = 1 ] && ok "ein Element in der Menge fenster" || falsch "ein Element (ist: $(elemente))"
x server sh -c "nft list set inet voltpilot_wartung fenster | grep -q 'timeout'" && ok "Element mit Ablaufzeit" || falsch "Element mit Ablaufzeit"
erreicht tech 10.10.16.2 2222 box1 "Techniker -> box1:2222 im Fenster"
ping_ja tech 10.10.16.2 "Techniker -> box1 Ping im Fenster"
gesperrt tech 10.10.16.2 9999 "Techniker -> box1:9999 (kein Dienste-Port) verworfen"
gesperrt tech 10.10.16.3 2222 "Techniker -> box2 (kein Fenster) verworfen"
gesperrt box1 10.10.16.3 2222 "Box -> Box auch bei offenem Fenster verworfen"
gesperrt box1 10.10.32.2 2222 "Box -> Techniker (neue Verbindung) auch im Fenster verworfen"
x server grep -q "Fenster geöffnet" /srv/log && ok "Öffnen im Log" || falsch "Öffnen im Log"
n1="$(x server grep -c . /srv/log)"
einmal
n2="$(x server grep -c . /srv/log)"
[ "$n1" = "$n2" ] && ok "zweiter Lauf idempotent (keine Änderung, kein Logeintrag)" || falsch "zweiter Lauf idempotent ($n1 -> $n2 Zeilen)"

schritt "3. Vorzeitig schließen reißt auch eine laufende Sitzung ab"
docker exec -d "$P-tech" sh -c 'socat -u TCP:10.10.16.2:8484 STDOUT > /tmp/strom 2>&1'
sleep 3
vorher="$(x tech sh -c 'wc -l < /tmp/strom')"
[ "$vorher" -gt 0 ] && ok "Dauerstrom läuft ($vorher Zeilen)" || falsch "Dauerstrom läuft"
soll ""
einmal && ok "Lauf erfolgreich" || falsch "Lauf erfolgreich"
[ "$(elemente)" = 0 ] && ok "Element entfernt" || falsch "Element entfernt (ist: $(elemente))"
sleep 1
a="$(x tech sh -c 'wc -l < /tmp/strom')"; sleep 4; b="$(x tech sh -c 'wc -l < /tmp/strom')"
[ "$a" = "$b" ] && ok "bestehende Sitzung abgerissen ($a = $b Zeilen)" || falsch "bestehende Sitzung abgerissen ($a -> $b)"
x tech sh -c 'pkill socat; true'
docker exec -d "$P-tech" socat TCP-LISTEN:2222,fork,reuseaddr SYSTEM:'echo tech'
gesperrt tech 10.10.16.2 2222 "Techniker -> box1 nach dem Schließen verworfen"

schritt "4. Fenster schließt im Kernel, auch wenn API und Dienst ausfallen"
soll "$(fenster f2 b1 12)"
einmal
erreicht tech 10.10.16.2 2222 box1 "Fenster offen"
api_aus
sleep 14
gesperrt tech 10.10.16.2 2222 "nach Ablauf ohne Dienst und API verworfen"
[ "$(elemente)" = 0 ] && ok "Menge leer" || falsch "Menge leer"

schritt "5. API unerreichbar: letzter Stand bleibt, nichts Neues geht auf"
soll "$(fenster f3 b2 300)"
if einmal; then falsch "Lauf meldet Fehler"; else ok "Lauf meldet Fehler (API aus)"; fi
[ "$(peers)" = 3 ] && ok "Peers bleiben" || falsch "Peers bleiben (ist: $(peers))"
[ "$(elemente)" = 0 ] && ok "kein neues Fenster" || falsch "kein neues Fenster"
gesperrt tech 10.10.16.3 2222 "Techniker -> box2 bleibt verworfen"
x server grep -q "API nicht erreichbar" /srv/log && ok "Grund im Log" || falsch "Grund im Log"

schritt "6. Neustart der VM ohne API: Peers aus dem Zwischenstand, nie ein Fenster"
x server sh -c 'ip link del wg-wartung; nft flush ruleset'
wg_server
x server /opt/vptd/vp-tunnel-dienst status 2>&1 | grep -q "Firewall-Basis stimmt: nein" && ok "status erkennt die fehlende Basis" || falsch "status erkennt die fehlende Basis"
if einmal; then falsch "Lauf meldet Fehler"; else ok "Lauf meldet Fehler (API aus)"; fi
[ "$(peers)" = 3 ] && ok "3 Peers wiederhergestellt" || falsch "Peers wiederhergestellt (ist: $(peers))"
x server nft list table inet voltpilot_wartung >/dev/null 2>&1 && ok "Basis wieder geladen" || falsch "Basis wieder geladen"
[ "$(elemente)" = 0 ] && ok "kein Fenster aus dem Zwischenstand" || falsch "kein Fenster aus dem Zwischenstand"
gesperrt tech 10.10.16.3 2222 "Techniker -> box2 verworfen"

schritt "7. API wieder da: das geplante Fenster wirkt erst jetzt"
warte_tunnel box2 10.10.16.1 && warte_tunnel tech 10.10.16.1 && ok "Tunnel nach dem Neustart wieder verhandelt" ||
  falsch "Tunnel nach dem Neustart wieder verhandelt"
api_an
einmal && ok "Lauf erfolgreich" || falsch "Lauf erfolgreich"
erreicht tech 10.10.16.3 2222 box2 "Techniker -> box2 im Fenster"
gesperrt tech 10.10.16.2 2222 "Techniker -> box1 weiter verworfen"

schritt "8. Ohne root, nur mit CAP_NET_ADMIN (wie die systemd-Unit)"
soll ""
x server sh -c 'mkdir -p /tmp/z && chown 65534:65534 /tmp/z && cp /srv/secret /tmp/z/secret && chown 65534 /tmp/z/secret'
if docker exec "$P-server" sh -c 'VP_TUNNEL_API_URL=http://127.0.0.1:8080 VP_TUNNEL_TOKEN_URL=http://127.0.0.1:8080/token \
     VP_TUNNEL_CLIENT_SECRET_FILE=/tmp/z/secret VP_TUNNEL_ZUSTAND=/tmp/z \
     setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=+net_admin --ambient-caps=+net_admin \
     /opt/vptd/vp-tunnel-dienst einmal >>/srv/log 2>&1'; then
  ok "Lauf als nobody mit Ambient-Capability"
else
  falsch "Lauf als nobody mit Ambient-Capability"
fi
[ "$(elemente)" = 0 ] && ok "Fenster als nobody geschlossen" || falsch "Fenster als nobody geschlossen"

schritt "9. Ein leerer Soll-Stand entfernt nicht alle Boxen"
xi server sh -c 'cat > /srv/soll.json' <<'EOF'
{"version":1,"boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24","peers":[],"fenster":[]}
EOF
einmal -e VP_TUNNEL_MAX_ENTFERNEN=2
[ "$(peers)" = 3 ] && ok "keiner entfernt (3 > höchstens 2)" || falsch "keiner entfernt (ist: $(peers))"
x server grep -q "ALARM" /srv/log && ok "Alarm im Log" || falsch "Alarm im Log"
einmal -e VP_TUNNEL_MAX_ENTFERNEN=3
[ "$(peers)" = 0 ] && ok "mit ausdrücklich erhöhtem Wert entfernt" || falsch "entfernt (ist: $(peers))"

schritt "10. Anmeldung abgelehnt (falsches Secret): eigene Meldung, nichts geht auf"
soll "$(fenster f4 b1 300)"
x server sh -c 'echo falsch > /srv/falsch && chmod 600 /srv/falsch'
if einmal -e VP_TUNNEL_CLIENT_SECRET_FILE=/srv/falsch; then falsch "Lauf meldet Fehler"; else ok "Lauf meldet Fehler (Secret falsch)"; fi
x server tail -n 3 /srv/log | grep "Anmeldung abgelehnt: Client oder Secret prüfen" | grep -q "level=ERROR" &&
  ok "Meldung sofort als Fehler im Log" || falsch "Meldung sofort als Fehler im Log"
x server tail -n 3 /srv/log | grep -q "API nicht erreichbar" && falsch "nicht als unerreichbare API gemeldet" || ok "nicht als unerreichbare API gemeldet"
[ "$(elemente)" = 0 ] && ok "kein Fenster mit abgelehnter Anmeldung" || falsch "kein Fenster mit abgelehnter Anmeldung (ist: $(elemente))"
[ "$(peers)" = 0 ] && ok "Peers unverändert" || falsch "Peers unverändert (ist: $(peers))"

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler (nft $(x server nft --version | cut -d' ' -f2), Kernel $(uname -r))"
if [ "$FEHLER" -ne 0 ]; then
  echo "--- Log des Dienstes"; x server cat /srv/log
  exit 1
fi
