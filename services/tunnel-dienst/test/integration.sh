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
# Schritte 1 bis 10: Peers und Fenster, je ein Lauf (`einmal`).
# Schritte 11 bis 20: die Schlüsselausgabe, mit dem Dienst als Dauerlauf.
#
# Aufruf aus dem Repo:   services/tunnel-dienst/test/integration.sh
# Ohne DNS im Container: VPTD_DOCKER_DNS=1.1.1.1 services/tunnel-dienst/test/integration.sh
# Debian 12 (nftables 1.0.6): VPTD_BASIS=debian …
# Wie die VM (Debian 13, nftables 1.1): VPTD_BASIS=trixie …
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
  debian) BILD="vptd-probe:bookworm"; DEBIAN="debian:bookworm-slim" ;;
  trixie) BILD="vptd-probe:trixie"; DEBIAN="debian:trixie-slim" ;;
  *) echo "VPTD_BASIS: alpine, debian oder trixie" >&2; exit 2 ;;
esac
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
BIN="$(mktemp -d)"
# Der Dienst läuft in der Probe auch als nobody und startet sich dort selbst
# noch einmal (Schlüsselausgabe): das Verzeichnis muss für ihn begehbar sein.
chmod 755 "$BIN"
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
  sh -c 'go build -ldflags "-X main.version=probe-1a2b3c" -o /out/vp-tunnel-dienst ./cmd/vp-tunnel-dienst &&
    go build -o /out/attrappe ./test/attrappe && go build -o /out/sshzeile ./test/sshzeile'
if ! docker image inspect "$BILD" >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  if [ "$BASIS" = alpine ]; then
    docker run --name "$P-bau" $DNS alpine:3.20 apk add --no-cache wireguard-tools-wg iproute2 nftables socat setpriv >/dev/null
  else
    docker run --name "$P-bau" $DNS "$DEBIAN" sh -c 'apt-get -qq update && DEBIAN_FRONTEND=noninteractive \
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
starte server 10 --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.send_redirects=0 -v "$BIN:/opt/vptd:ro" \
  -v "$MODUL/deploy:/opt/deploy:ro"
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

# ── Schlüsselausgabe (Fenster-Schlüssel) ─────────────────────────────────────
# Ab hier läuft der Dienst als Dauerlauf, wie unter systemd: als nobody, nur
# mit CAP_NET_ADMIN, Abruf alle 5 s, Schlüsselausgabe auf 10.10.32.1:$SPORT.
SPORT=8022

# frage <von> <warte> <stand>: die ganze HTTP-Antwort der Schlüsselausgabe,
# gestellt wie von einer Box mit einer einzelnen Anfrage (leer: keine Verbindung).
# shut-none: die Verbindung bleibt bis zur Antwort ganz offen, wie bei
# uclient-fetch und wget; schlösse socat nach der Anfrage seine Schreibseite,
# gälte die Box dem Server als gegangen.
frage() {
  x "$1" sh -c "printf 'GET /v1/schluessel?warte=$2&stand=$3 HTTP/1.0\r\n\r\n' |
    timeout $(($2 + 10)) socat -t$(($2 + 8)) - TCP:10.10.32.1:$SPORT,connect-timeout=2,shut-none 2>/dev/null" | tr -d '\r' || true
}
http_code() { printf '%s\n' "$1" | sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9]*\).*/\1/p'; }
rumpf() { printf '%s\n' "$1" | sed '1,/^$/d'; }
pruefwert() { rumpf "$1" | sed -n '1s/^vp-wartung-schluessel 1 //p'; }
anzahl() { rumpf "$1" | grep -c '^schluessel ' || true; }
# box_nimmt_an <box> <antwort>: prüft den Rumpf mit der Regel des Box-Skripts
# (Prototyp, Bericht "Anmeldung an der Box", Anhang B) auf der Box selbst.
# Ausgabe: je angenommenem Schlüssel "<sekunden> <zugang> <base64>".
box_nimmt_an() { rumpf "$2" | xi "$1" awk -f /tmp/pruefe.awk; }
for b in box1 box2; do
  xi "$b" sh -c 'cat > /tmp/pruefe.awk' <<'EOF'
function schlecht() { kaputt = 1; exit 2 }
NR == 1 { if ($1 != "vp-wartung-schluessel" || $2 != "1" || NF != 3) schlecht(); next }
$1 == "schluessel" {
  if (zu) schlecht()
  if (NF != 5 || $2 !~ /^[0-9]+$/ || $2 < 1) schlecht()
  if ($3 !~ /^[A-Za-z0-9_-]+$/ || length($3) > 64) schlecht()
  if ($4 != "ssh-rsa" || $5 !~ /^AAAAB3NzaC1yc2E[A-Za-z0-9+\/]+=*$/) schlecht()
  if (length($5) < 360 || length($5) > 1500) schlecht()
  n++; if (n > 8) schlecht()
  zeile[n] = $2 " " $3 " " $5
  next
}
$1 == "ende" { if (zu || NF != 2 || $2 != n + 0) schlecht(); zu = 1; next }
{ schlecht() }
END { if (kaputt || !zu) exit 2; for (i = 1; i <= n; i++) print zeile[i] }
EOF
done

PUB_TECH2="$(x server sh -c 'wg genkey | wg pubkey')"
SSH1="$(x server /opt/vptd/sshzeile 1)"; SSH2="$(x server /opt/vptd/sshzeile 2)"; SSH3="$(x server /opt/vptd/sshzeile 3)"
# soll2 <ssh von t1> <fenster-json>: zwei Boxen, zwei Techniker-Zugänge (t2 ist
# nur im Soll-Stand ein Peer; kein Container hängt daran)
soll2() {
  ssh1=""; [ -z "$1" ] || ssh1=",\"sshPublicKey\":\"$1\""
  cat <<EOF | xi server sh -c 'cat > /srv/soll.neu && mv /srv/soll.neu /srv/soll.json'
{"version":1,"erzeugtAm":"$(zeit 0)","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24",
 "peers":[
  {"art":"box","id":"b1","kennung":"edge-zay5sdd","publicKey":"$PUB_BOX1","adresse":"10.10.16.2"},
  {"art":"box","id":"b2","kennung":"edge-k7m2xq3","publicKey":"$PUB_BOX2","adresse":"10.10.16.3"},
  {"art":"techniker","id":"t1","kennung":"Probe-Techniker","publicKey":"$PUB_TECH","adresse":"10.10.32.2"$ssh1},
  {"art":"techniker","id":"t2","kennung":"Zweiter Techniker","publicKey":"$PUB_TECH2","adresse":"10.10.32.3","sshPublicKey":"$SSH2"}],
 "fenster":[$2]}
EOF
}
# fenster2 <id> <box> <techniker> <sekunden>
fenster2() { echo "{\"id\":\"$1\",\"boxId\":\"$2\",\"technikerId\":\"$3\",\"beginn\":\"$(zeit -5)\",\"ende\":\"$(zeit "$4")\"}"; }

dienst_an() {
  docker exec -d -e VP_TUNNEL_API_URL=http://127.0.0.1:8080 -e VP_TUNNEL_TOKEN_URL=http://127.0.0.1:8080/token \
    -e VP_TUNNEL_CLIENT_SECRET_FILE=/tmp/z/secret -e VP_TUNNEL_ZUSTAND=/tmp/z -e VP_TUNNEL_INTERVALL=5s \
    -e VP_TUNNEL_SCHLUESSEL_PORT="$SPORT" "$P-server" sh -c 'echo $$ > /srv/dienst.pid; exec setpriv --reuid=65534 \
      --regid=65534 --clear-groups --inh-caps=+net_admin --ambient-caps=+net_admin /opt/vptd/vp-tunnel-dienst lauf >>/srv/log 2>&1'
}
dienst_aus() {
  # shellcheck disable=SC2016 # wird im Container ausgewertet
  x server sh -c '[ -s /srv/dienst.pid ] && kill "$(cat /srv/dienst.pid)" 2>/dev/null; rm -f /srv/dienst.pid; true'
  sleep 2
}
# status_dienst: `status` mit der Konfiguration des Dauerlaufs
status_dienst() {
  docker exec -e VP_TUNNEL_ZUSTAND=/tmp/z -e VP_TUNNEL_INTERVALL=5s -e VP_TUNNEL_SCHLUESSEL_PORT="$SPORT" "$P-server" \
    /opt/vptd/vp-tunnel-dienst status 2>&1 || true
}
# im_log <muster> [ab-zeile]: zählt die Zeilen des Journals mit dem Muster
im_log() { x server sh -c "tail -n +${2:-1} /srv/log | grep -c -- '$1' || true"; }
log_zeilen() { x server sh -c 'grep -c "" /srv/log || true'; }
# warte_log <muster> <sekunden> [ab-zeile]: bis die Zeile im Journal steht
warte_log() {
  i=0
  while [ "$i" -lt "$2" ]; do
    [ "$(im_log "$1" "${3:-1}")" -gt 0 ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}
# warte_schluessel <box> <anzahl> <sekunden>: bis die Box so viele Schlüssel genannt bekommt
warte_schluessel() {
  i=0
  while [ "$i" -lt "$3" ]; do
    [ "$(anzahl "$(frage "$1" 0 "")")" = "$2" ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}
kennung_basis() { x server sh -c "nft list set inet voltpilot_wartung fenster | sed -n 's/.*comment \"\\(.*\\)\"/\\1/p'"; }
verworfen() { x server sh -c "nft list chain inet voltpilot_wartung eingang_wartung | sed -n 's/.*counter packets \\([0-9]*\\) bytes [0-9]* drop/\\1/p'"; }

schritt "11. Schlüsselausgabe einschalten: die Basis ändert sich, offene Fenster schließen einmal"
# Die Fenster einmal festlegen: jeder neue Soll-Stand nennt dasselbe Ende.
G1="$(fenster2 g1 b1 t1 600)"; G2="$(fenster2 g2 b2 t2 600)"; G4="$(fenster2 g4 b2 t1 600)"
soll2 "$SSH1" "$G1"
einmal && ok "Lauf erfolgreich (noch ohne Schlüsselausgabe)" || falsch "Lauf erfolgreich (noch ohne Schlüsselausgabe)"
[ "$(peers)" = 4 ] && ok "4 Peers auf wg-wartung" || falsch "4 Peers auf wg-wartung (ist: $(peers))"
warte_tunnel box1 10.10.16.1 && warte_tunnel box2 10.10.16.1 && warte_tunnel tech 10.10.16.1 && ok "Tunnel wieder verhandelt" || falsch "Tunnel wieder verhandelt"
erreicht tech 10.10.16.2 2222 box1 "Fenster offen, Basis ohne Schlüsselausgabe"
x server sh -c "nft list table inet voltpilot_wartung | grep -q 'dport $SPORT'" && falsch "ohne Einstellung keine Regel für den Port" || ok "ohne Einstellung keine Regel für den Port"
gesperrt box1 10.10.32.1 "$SPORT" "ohne Einstellung ist der Port vom Tunnel aus zu"
alt="$(kennung_basis)"
docker exec -d "$P-tech" sh -c 'socat -u TCP:10.10.16.2:8484 STDOUT > /tmp/strom2 2>&1'
sleep 3
n0="$(log_zeilen)"
einmal -e VP_TUNNEL_SCHLUESSEL_PORT="$SPORT" && ok "Lauf mit eingestelltem Port erfolgreich" || falsch "Lauf mit eingestelltem Port erfolgreich"
neu="$(kennung_basis)"
[ -n "$alt" ] && [ -n "$neu" ] && [ "$alt" != "$neu" ] && ok "Prüfwert der Basis geändert ($alt -> $neu)" || falsch "Prüfwert der Basis geändert ($alt -> $neu)"
[ "$(im_log 'Firewall-Basis geladen' "$((n0 + 1))")" = 1 ] && ok "Basis beim ersten Lauf neu geladen (Journal)" || falsch "Basis beim ersten Lauf neu geladen (Journal)"
[ "$(im_log 'Fenster geöffnet' "$((n0 + 1))")" = 1 ] && ok "derselbe Lauf öffnet das Fenster wieder" || falsch "derselbe Lauf öffnet das Fenster wieder"
[ "$(elemente)" = 1 ] && ok "Fenster steht wieder in der Menge" || falsch "Fenster steht wieder in der Menge (ist: $(elemente))"
x server sh -c "nft list chain inet voltpilot_wartung eingang_wartung | grep -q 'ip saddr 10.10.16.0/20 ip daddr 10.10.32.1 tcp dport $SPORT ct direction original accept'" &&
  ok "die eine zusätzliche Regel ist geladen" || falsch "die eine zusätzliche Regel ist geladen"
[ "$(x server sh -c "VP_TUNNEL_SCHLUESSEL_PORT=$SPORT /opt/vptd/vp-tunnel-dienst basis | grep -c 'dport $SPORT'")" = 1 ] &&
  ok "basis nennt die Regel genau einmal" || falsch "basis nennt die Regel genau einmal"
status_dienst | grep -q "Firewall-Basis stimmt: ja" && ok "status (mit der Einstellung): Basis stimmt" || falsch "status (mit der Einstellung): Basis stimmt"
x server /opt/vptd/vp-tunnel-dienst status 2>&1 | grep -q "Firewall-Basis stimmt: nein" && ok "status ohne die Einstellung erkennt die Abweichung" || falsch "status ohne die Einstellung erkennt die Abweichung"
erreicht tech 10.10.16.2 2222 box1 "Techniker -> box1 nach dem Neuladen wieder offen"
a="$(x tech sh -c 'wc -l < /tmp/strom2')"; sleep 3; b="$(x tech sh -c 'wc -l < /tmp/strom2')"
if [ "$b" -gt "$a" ]; then
  echo "  Hinweis laufende Sitzung hat das Neuladen überstanden ($a -> $b Zeilen): die Menge war nur für die Dauer eines Abrufs leer"
else
  echo "  Hinweis laufende Sitzung ist beim Neuladen abgerissen ($a = $b Zeilen)"
fi
x tech sh -c 'pkill -f "TCP:10.10.16.2:848[4]"; true'
# Der Server darf keine Box erreichen - auch nicht vom Port der Schlüsselausgabe
# aus, obwohl Pakete von Boxen an diesen Port jetzt erlaubt sind.
vom_port() { x server timeout 6 socat -u "TCP:10.10.16.2:2222,bind=10.10.32.1:$SPORT,reuseaddr,connect-timeout=3" STDOUT 2>/dev/null || true; }
[ -z "$(vom_port)" ] && ok "Server -> Box vom Port der Schlüsselausgabe aus: keine Verbindung" || falsch "Server -> Box vom Port der Schlüsselausgabe aus: keine Verbindung"
# Gegenprobe: dieselbe Regel OHNE "ct direction original" ließe die Antwort der
# Box durch - die Probe oben prüft also wirklich diese Bedingung.
x server nft insert rule inet voltpilot_wartung eingang_wartung ip saddr 10.10.16.0/20 ip daddr 10.10.32.1 tcp dport "$SPORT" counter accept comment '"gegenprobe"'
[ "$(vom_port)" = box1 ] && ok "Gegenprobe: ohne die Richtungsbedingung erreichte der Server die Box" || falsch "Gegenprobe: ohne die Richtungsbedingung erreichte der Server die Box"
x server sh -c 'nft delete rule inet voltpilot_wartung eingang_wartung handle "$(nft -a list chain inet voltpilot_wartung eingang_wartung | sed -n "s/.*gegenprobe.* # handle \([0-9]*\)$/\1/p")"'
x server sh -c 'nft list chain inet voltpilot_wartung eingang_wartung | grep -q gegenprobe' && falsch "Gegenprobe wieder entfernt" || ok "Gegenprobe wieder entfernt"
[ -z "$(vom_port)" ] && ok "… danach wieder keine Verbindung" || falsch "… danach wieder keine Verbindung"

schritt "12. Dauerlauf: der Teil im Tunnel läuft ohne die Netzrechte des Dienstes"
n0="$(log_zeilen)"
dienst_an
warte_log "Schlüsselausgabe lauscht" 15 "$((n0 + 1))" && ok "Schalter lauscht (Journal)" || falsch "Schalter lauscht (Journal)"
x server sh -c "tail -n +$((n0 + 1)) /srv/log | grep 'Tunnel-Dienst läuft' | grep -q 'schluesselausgabe=10.10.32.1:$SPORT'" &&
  ok "Startzeile nennt die Schlüsselausgabe" || falsch "Startzeile nennt die Schlüsselausgabe"
pid_d="$(x server cat /srv/dienst.pid)"
pid_s="$(x server pgrep -P "$pid_d" -f schluessel-schalter || true)"
[ -n "$pid_s" ] && ok "Schalter ist ein eigener Prozess des Dienstes (PID $pid_s, Dienst $pid_d)" || falsch "Schalter ist ein eigener Prozess des Dienstes"
caps() { x server sh -c "grep -E '^(Cap(Inh|Prm|Eff|Amb)|NoNewPrivs|Uid):' /proc/$1/status | tr -s '\t ' ' ' | tr '\n' ';'"; }
cd_="$(caps "$pid_d")"; cs="$(caps "$pid_s")"
echo "  Dienst:   $cd_"
echo "  Schalter: $cs"
echo "$cd_" | grep -q 'CapEff: 0000000000001000;' && ok "Dienst: wirksam genau CAP_NET_ADMIN" || falsch "Dienst: wirksam genau CAP_NET_ADMIN"
for c in CapInh CapPrm CapEff CapAmb; do
  echo "$cs" | grep -q "$c: 0000000000000000;" && ok "Schalter: $c leer" || falsch "Schalter: $c leer"
done
echo "$cs" | grep -q 'NoNewPrivs: 1;' && ok "Schalter: kann keine Rechte zurückgewinnen (NoNewPrivs)" || falsch "Schalter: NoNewPrivs"
echo "$cs" | grep -q 'Uid: 65534 65534 65534 65534;' && ok "Schalter läuft als Benutzer des Dienstes, nicht als root" || falsch "Schalter läuft als Benutzer des Dienstes"
if [ "$(im_log 'dateizugriff=gesperrt' "$((n0 + 1))")" -gt 0 ]; then
  ok "Schalter: Dateizugriff gesperrt (Landlock)"
else
  echo "  Hinweis Dateizugriff des Schalters NICHT gesperrt: $(x server sh -c "grep -o 'dateizugriff=.*' /srv/log | tail -n 1")"
fi
x server sh -c "ss -ltnH 2>/dev/null | grep -c ':$SPORT '" | grep -qx 1 && ok "genau ein Lauscher auf dem Port" || falsch "genau ein Lauscher auf dem Port"
x server sh -c "ss -ltnH | grep ':$SPORT ' | grep -q '10.10.32.1:$SPORT'" && ok "lauscht nur auf der Server-Adresse im Techniker-Netz" || falsch "lauscht nur auf der Server-Adresse im Techniker-Netz"

schritt "13. Die Box sieht nur ihre eigenen Fenster"
a1="$(frage box1 0 "")"
[ "$(http_code "$a1")" = 200 ] && ok "box1: Antwort 200" || falsch "box1: Antwort 200 (ist: $(http_code "$a1"))"
l1="$(box_nimmt_an box1 "$a1" || echo ABGELEHNT)"
[ "$(echo "$l1" | grep -c .)" = 1 ] && echo "$l1" | grep -q " t1 ${SSH1#ssh-rsa }\$" &&
  ok "box1: die Prüfregel des Box-Skripts nimmt die Antwort an, genau der Schlüssel von t1" || falsch "box1: genau der Schlüssel von t1 (ist: $l1)"
sek="$(echo "$l1" | cut -d' ' -f1 | grep -E '^[0-9]+$' || echo 0)"
[ "$sek" -ge 500 ] && [ "$sek" -le 600 ] && ok "box1: Restlaufzeit des Fensters ($sek s von 600)" || falsch "box1: Restlaufzeit des Fensters (ist: $sek)"
# Ein zweiter, üblicher Abholer, wo die Box ihn hat (wget von BusyBox unter Alpine).
if x box1 sh -c 'command -v wget >/dev/null 2>&1'; then
  aw="$(x box1 wget -q -T 5 -O - "http://10.10.32.1:$SPORT/v1/schluessel?warte=0&stand=" 2>/dev/null || true)"
  [ "$(printf '%s\n' "$aw" | xi box1 awk -f /tmp/pruefe.awk | grep -c . || true)" = 1 ] && ok "box1 mit wget: dieselbe Liste, von der Prüfregel angenommen" ||
    falsch "box1 mit wget: dieselbe Liste ($aw)"
fi
a2="$(frage box2 0 "")"
[ "$(http_code "$a2")" = 200 ] && [ "$(rumpf "$a2" | tail -n 1)" = "ende 0" ] && [ -z "$(box_nimmt_an box2 "$a2" || echo ABGELEHNT)" ] &&
  ok "box2 ohne Fenster: leere, gültige Liste" || falsch "box2 ohne Fenster: leere, gültige Liste ($a2)"
[ "$(pruefwert "$a1")" != "$(pruefwert "$a2")" ] && ok "verschiedene Listen, verschiedene Prüfwerte" || falsch "verschiedene Listen, verschiedene Prüfwerte"
n0="$(log_zeilen)"
soll2 "$SSH1" "$G1,$G2"
warte_schluessel box2 1 12 && ok "box2 bekommt nach dem Öffnen ihres Fensters einen Schlüssel" || falsch "box2 bekommt nach dem Öffnen ihres Fensters einen Schlüssel"
a2="$(frage box2 0 "")"; l2="$(box_nimmt_an box2 "$a2" || echo ABGELEHNT)"
echo "$l2" | grep -q " t2 ${SSH2#ssh-rsa }\$" && [ "$(echo "$l2" | grep -c .)" = 1 ] && ok "box2: nur der Schlüssel von t2" || falsch "box2: nur der Schlüssel von t2 (ist: $l2)"
a1="$(frage box1 0 "")"; l1="$(box_nimmt_an box1 "$a1" || echo ABGELEHNT)"
echo "$l1" | grep -q " t1 ${SSH1#ssh-rsa }\$" && [ "$(echo "$l1" | grep -c .)" = 1 ] && ok "box1: weiter nur der Schlüssel von t1" || falsch "box1: weiter nur der Schlüssel von t1 (ist: $l1)"

schritt "14. Nur Boxen, nur dieser Port"
# Ein Techniker, der die Server-Adresse im Techniker-Netz selbst in seinen
# Tunnel einträgt (im Betrieb führt sein Zugang nur das Box-Netz): seine Pakete
# kommen am Server an und müssen dort verworfen werden.
x tech sh -c "wg set wg0 peer $PUB_SERVER allowed-ips 10.10.16.0/20,10.10.32.1/32 && ip route add 10.10.32.1/32 dev wg0"
ping_ja tech 10.10.32.1 "Techniker erreicht die Server-Adresse im Techniker-Netz (Ping)"
v0="$(verworfen)"
at="$(frage tech 0 "")"
[ -z "$at" ] && ok "Techniker-Adresse -> Schlüsselausgabe: keine Antwort" || falsch "Techniker-Adresse -> Schlüsselausgabe: keine Antwort ($at)"
v1="$(verworfen)"
[ "$v1" -gt "$v0" ] && ok "… verworfen an der Regel des Dienstes (Zähler $v0 -> $v1)" || falsch "… verworfen an der Regel des Dienstes (Zähler $v0 -> $v1)"
as="$(frage server 0 "")"
[ "$(http_code "$as")" = 403 ] && ! echo "$as" | grep -q -e ssh-rsa -e vp-wartung-schluessel &&
  ok "Absender ohne Box-Adresse (der Server selbst): 403, kein Inhalt" || falsch "Absender ohne Box-Adresse: 403 (ist: $as)"
docker exec -d "$P-server" socat TCP-LISTEN:8023,fork,reuseaddr SYSTEM:'echo offen'
docker exec -d "$P-server" socat "TCP-LISTEN:$SPORT,bind=10.10.16.1,fork,reuseaddr" SYSTEM:'echo offen'
sleep 1
[ "$(tcp server 127.0.0.1 8023)" = offen ] && [ "$(tcp server 10.10.16.1 "$SPORT")" = offen ] && ok "Gegenprobe: auf dem Server lauschen zwei weitere Dienste" || falsch "Gegenprobe: auf dem Server lauschen zwei weitere Dienste"
gesperrt box1 10.10.32.1 8023 "Box -> Server, anderer Port: verworfen"
gesperrt box1 10.10.16.1 "$SPORT" "Box -> Server-Adresse im Box-Netz, gleicher Port: verworfen"
gesperrt tech 10.10.32.1 8023 "Techniker -> Server, anderer Port: verworfen"
ping_ja box1 10.10.32.1 "Box -> Server: Ping geht weiter"
x server sh -c 'pkill -f "TCP-LISTEN:802[3]"; pkill -f "bind=10.10.16.[1]"; true'

schritt "15. Schlüssel im offenen Fenster ersetzt, dann entfernt"
pw="$(pruefwert "$(frage box1 0 "")")"
n0="$(log_zeilen)"
x box1 rm -f /tmp/lang /tmp/lang.fertig
docker exec -d "$P-box1" sh -c "printf 'GET /v1/schluessel?warte=40&stand=$pw HTTP/1.0\r\n\r\n' |
  socat -t50 - TCP:10.10.32.1:$SPORT,connect-timeout=2,shut-none > /tmp/lang 2>/dev/null; date +%s > /tmp/lang.fertig"
sleep 2
x box1 test -e /tmp/lang.fertig && falsch "die Anfrage bleibt offen, solange die Liste gleich ist" || ok "die Anfrage bleibt offen, solange die Liste gleich ist"
t0="$(date +%s)"
soll2 "$SSH3" "$G1,$G2"
i=0; while [ "$i" -lt 15 ] && ! x box1 test -e /tmp/lang.fertig; do sleep 1; i=$((i + 1)); done
if x box1 test -e /tmp/lang.fertig; then
  dauer=$(($(x box1 cat /tmp/lang.fertig) - t0))
  [ "$dauer" -le 8 ] && ok "offene Anfrage beantwortet $dauer s nach der Änderung im Soll-Stand (Abruf alle 5 s)" ||
    falsch "offene Anfrage beantwortet $dauer s nach der Änderung"
else
  falsch "offene Anfrage wird nach dem Schlüsselwechsel beantwortet"
fi
al="$(x box1 cat /tmp/lang | tr -d '\r')"; ll="$(box_nimmt_an box1 "$al" || echo ABGELEHNT)"
echo "$ll" | grep -q " t1 ${SSH3#ssh-rsa }\$" && [ "$(echo "$ll" | grep -c .)" = 1 ] && ok "die Antwort nennt den neuen Schlüssel" || falsch "die Antwort nennt den neuen Schlüssel (ist: $ll)"
echo "$al" | grep -q "${SSH1#ssh-rsa }" && falsch "der alte Schlüssel wird nicht mehr genannt" || ok "der alte Schlüssel wird nicht mehr genannt"
soll2 "" "$G1,$G2"
warte_schluessel box1 0 12 && ok "Schlüssel am Zugang entfernt: leere Liste" || falsch "Schlüssel am Zugang entfernt: leere Liste"
erreicht tech 10.10.16.2 2222 box1 "das Fenster selbst bleibt offen (der Netzweg hängt nicht am Schlüssel)"
[ "$(im_log 'msg="Schlüssel ausgegeben" box=10.10.16.2 kennung=edge-zay5sdd techniker=Probe-Techniker zugang=t1 fingerabdruck=SHA256:' "$((n0 + 1))")" = 1 ] &&
  ok "Journal: welcher Box welcher Schlüssel (Fingerabdruck) ausgegeben wurde" || falsch "Journal: Schlüssel ausgegeben"
[ "$(im_log 'msg="Schlüssel nicht mehr ausgegeben" box=10.10.16.2' "$((n0 + 1))")" = 2 ] &&
  ok "Journal: alter und neuer Schlüssel je einmal zurückgenommen" || falsch "Journal: Schlüssel nicht mehr ausgegeben (ist: $(im_log 'Schlüssel nicht mehr ausgegeben" box=10.10.16.2' "$((n0 + 1))"))"
[ "$(im_log 'AAAAB3NzaC1yc2E')" = 0 ] && ok "kein Schlüssel im Journal, nur Fingerabdrücke" || falsch "kein Schlüssel im Journal"
sleep 6
st="$(status_dienst)"
echo "$st" | grep -q "Schlüsselausgabe: 10.10.32.1:$SPORT, lauscht" && ok "status: Schlüsselausgabe lauscht" || falsch "status: Schlüsselausgabe lauscht"
echo "$st" | grep "edge-zay5sdd" | grep -q "10.10.16.2 .*zuletzt gefragt vor [0-9]*s, 0 Schlüssel" && ok "status: box1 zuletzt gefragt" || falsch "status: box1 zuletzt gefragt"
echo "$st" | grep "edge-k7m2xq3" | grep -q "zuletzt gefragt vor .*, 1 Schlüssel" && echo "$st" | grep -q "Zweiter Techniker  SHA256:" &&
  ok "status: box2 mit dem Fingerabdruck ihres Schlüssels" || falsch "status: box2 mit dem Fingerabdruck ihres Schlüssels"

schritt "16. Eine offene Anfrage je Box"
pw2="$(pruefwert "$(frage box2 0 "")")"
x box2 rm -f /tmp/a1 /tmp/a2
docker exec -d "$P-box2" sh -c "printf 'GET /v1/schluessel?warte=30&stand=$pw2 HTTP/1.0\r\n\r\n' | socat -t40 - TCP:10.10.32.1:$SPORT,connect-timeout=2,shut-none > /tmp/a1 2>/dev/null"
sleep 2
docker exec -d "$P-box2" sh -c "printf 'GET /v1/schluessel?warte=30&stand=$pw2 HTTP/1.0\r\n\r\n' | socat -t40 - TCP:10.10.32.1:$SPORT,connect-timeout=2,shut-none > /tmp/a2 2>/dev/null"
sleep 2
x box2 sh -c 'head -n 1 /tmp/a1' | grep -q " 429 " && ok "die ältere Anfrage wird von der neueren abgelöst (429)" || falsch "die ältere Anfrage wird abgelöst (ist: $(x box2 sh -c 'head -n 1 /tmp/a1'))"
[ -z "$(x box2 cat /tmp/a2)" ] && ok "die neuere bleibt offen" || falsch "die neuere bleibt offen"
x box2 sh -c 'pkill -f "TCP:10.10.32.[1]"; true'

schritt "17. Nach Ablauf eine leere Liste; das Journal nennt das Ende des Fensters"
n0="$(log_zeilen)"
soll2 "$SSH1" "$G2"
warte_log 'msg="Fenster geschlossen" techniker=10.10.32.2 box=10.10.16.2' 12 "$((n0 + 1))" && ok "Fenster zu box1 im Soll-Stand geschlossen" || falsch "Fenster zu box1 im Soll-Stand geschlossen"
n0="$(log_zeilen)"
soll2 "$SSH1" "$(fenster2 g3 b1 t1 25),$G2"
warte_schluessel box1 1 10 && ok "kurzes Fenster offen, Schlüssel ausgegeben" || falsch "kurzes Fenster offen, Schlüssel ausgegeben"
ak="$(frage box1 0 "")"; rest="$(box_nimmt_an box1 "$ak" | cut -d' ' -f1 | grep -E '^[0-9]+$' || echo 99)"
t0="$(date +%s)"
al="$(frage box1 40 "$(pruefwert "$ak")")"
dauer=$(($(date +%s) - t0))
[ "$(http_code "$al")" = 200 ] && [ "$(anzahl "$al")" = 0 ] && [ "$(rumpf "$al" | tail -n 1)" = "ende 0" ] &&
  ok "offene Anfrage endet mit einer leeren Liste" || falsch "offene Anfrage endet mit einer leeren Liste ($al)"
[ "$dauer" -le "$((rest + 3))" ] && [ "$dauer" -lt 28 ] && ok "… zum Ablauf des Fensters (nach $dauer s bei $rest s Restlaufzeit), nicht erst nach 40 s" ||
  falsch "… zum Ablauf des Fensters (nach $dauer s bei $rest s Restlaufzeit)"
[ "$dauer" -ge 11 ] && ok "… und die Anfrage blieb dafür länger als zehn Sekunden offen" || falsch "… und die Anfrage blieb dafür länger als zehn Sekunden offen (ist: $dauer s)"
sleep 3 # die Liste ist leer, kurz bevor das Element im Kernel abläuft
gesperrt tech 10.10.16.2 2222 "Techniker -> box1 nach Ablauf verworfen"
warte_log 'msg="Fenster abgelaufen" techniker=10.10.32.2 box=10.10.16.2 kennung=edge-zay5sdd' 8 "$((n0 + 1))" &&
  ok "Journal: Fenster abgelaufen (beim nächsten Abgleich)" || falsch "Journal: Fenster abgelaufen"
[ "$(im_log 'Fenster geschlossen' "$((n0 + 1))")" = 0 ] && ok "… und nicht als vom Dienst geschlossen" || falsch "… und nicht als vom Dienst geschlossen"

schritt "18. API aus: kein neuer Schlüssel. API wieder da: eine Zeile im Journal"
api_aus
n0="$(log_zeilen)"
soll2 "$SSH1" "$G2,$G4"
warte_log "API nicht erreichbar" 12 "$((n0 + 1))" && ok "Dienst meldet die unerreichbare API" || falsch "Dienst meldet die unerreichbare API"
sleep 6
a2="$(frage box2 0 "")"; l2="$(box_nimmt_an box2 "$a2" || echo ABGELEHNT)"
[ "$(echo "$l2" | grep -c .)" = 1 ] && echo "$l2" | grep -q " t2 " && ok "box2: weiter nur der bisherige Schlüssel, kein neuer" || falsch "box2: kein neuer Schlüssel ohne API (ist: $l2)"
gesperrt tech 10.10.16.3 2222 "das neue Fenster ist auch im Netz nicht offen"
api_an
warte_log 'msg="API wieder erreichbar" fehllaeufe=' 12 "$((n0 + 1))" && ok "Journal: API wieder erreichbar, mit der Zahl der Fehlläufe" || falsch "Journal: API wieder erreichbar"
echo "  $(x server sh -c "grep 'API wieder erreichbar' /srv/log | tail -n 1")"
warte_schluessel box2 2 12 && ok "box2 bekommt jetzt beide Schlüssel" || falsch "box2 bekommt jetzt beide Schlüssel"
erreicht tech 10.10.16.3 2222 box2 "Techniker -> box2 im neuen Fenster"

schritt "19. Neustart des Dienstes ohne API: kein Stand, keine Liste"
api_aus
dienst_aus
[ "$(x server sh -c 'pgrep -f schluessel-schalte[r] | grep -c . || true')" = 0 ] && ok "mit dem Dienst endet auch der Schalter" || falsch "mit dem Dienst endet auch der Schalter"
[ "$(elemente)" = 2 ] && ok "die Fenster stehen weiter im Kernel (laufen von selbst ab)" || falsch "die Fenster stehen weiter im Kernel (ist: $(elemente))"
gesperrt box2 10.10.32.1 "$SPORT" "ohne Dienst antwortet niemand"
n0="$(log_zeilen)"
dienst_an
warte_log "Schlüsselausgabe lauscht" 15 "$((n0 + 1))" && ok "Schalter lauscht wieder" || falsch "Schalter lauscht wieder"
sleep 2
a2="$(frage box2 0 "")"
[ "$(http_code "$a2")" = 503 ] && ! echo "$a2" | grep -q -e ssh-rsa -e vp-wartung-schluessel &&
  ok "Fenster offen, aber kein frischer Stand: 503 statt einer Liste" || falsch "kein frischer Stand: 503 (ist: $a2)"
api_an
warte_schluessel box2 2 15 && ok "mit dem ersten frischen Stand wieder beide Schlüssel" || falsch "mit dem ersten frischen Stand wieder beide Schlüssel"

schritt "20. Muster für die eigene Firewall der VM (deploy/vm-firewall.nft.beispiel)"
e0="$(elemente)"
x server nft -f /opt/deploy/vm-firewall.nft.beispiel && ok "Muster lädt" || falsch "Muster lädt"
x server sh -c "nft list chain inet filter input | grep -q 'policy drop' && nft list chain inet filter forward | grep -q 'policy drop'" &&
  ok "Eingang und Weiterleitung der VM stehen auf drop" || falsch "Eingang und Weiterleitung der VM stehen auf drop"
[ "$(elemente)" = "$e0" ] && status_dienst | grep -q "Firewall-Basis stimmt: ja" && ok "einzeln geladen: Tabelle und Fenster des Dienstes unberührt" || falsch "Tabelle und Fenster des Dienstes unberührt"
[ "$(anzahl "$(frage box2 0 "")")" = 2 ] && ok "Schlüsselausgabe durch die Freigabe erreichbar" || falsch "Schlüsselausgabe durch die Freigabe erreichbar"
erreicht tech 10.10.16.3 2222 box2 "Techniker -> Box im Fenster geht durch die Ausnahme der Weiterleitung"
gesperrt tech 10.10.16.2 2222 "Techniker -> Box ohne Fenster bleibt verworfen"
[ -z "$(frage tech 0 "")" ] && ok "Techniker-Adresse -> Schlüsselausgabe bleibt ohne Antwort" || falsch "Techniker-Adresse -> Schlüsselausgabe bleibt ohne Antwort"
ping_ja box1 10.10.32.1 "Ping zum Server geht weiter"
n0="$(log_zeilen)"; sleep 7
[ "$(im_log 'level=WARN' "$((n0 + 1))")" = 0 ] && [ "$(im_log 'level=ERROR' "$((n0 + 1))")" = 0 ] && ok "der Dienst gleicht weiter ohne Warnung ab" || falsch "der Dienst gleicht weiter ohne Warnung ab"
# Gegenprobe: ohne die Zeile für die Schlüsselausgabe kommt keine Box durch.
x server sh -c "sed '/tcp dport $SPORT/d' /opt/deploy/vm-firewall.nft.beispiel | nft -f -"
[ -z "$(frage box2 0 "")" ] && ok "Gegenprobe: ohne die Freigabe im Muster bekommt die Box keine Antwort" || falsch "Gegenprobe: ohne die Freigabe keine Antwort"
x server nft -f /opt/deploy/vm-firewall.nft.beispiel
[ "$(anzahl "$(frage box2 0 "")")" = 2 ] && ok "mit der Freigabe wieder" || falsch "mit der Freigabe wieder"
dienst_aus

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler (nft $(x server nft --version | cut -d' ' -f2), Kernel $(uname -r))"
if [ "$FEHLER" -ne 0 ]; then
  echo "--- Log des Dienstes"; x server cat /srv/log
  exit 1
fi
