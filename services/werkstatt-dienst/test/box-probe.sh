#!/bin/sh
# Probe eines ganzen Laufs ab frischem OpenWrt (V1a, P5) in Containern:
# ECHTES OpenWrt 25.12.5 (procd, netifd, Dropbear, busybox passwd) als Box,
# ECHTE Werkbank-Brücke (einrichten.sh, nftables, OpenSSH), ECHTER
# Wartungsserver (vp-tunnel-dienst mit Schlüsselausgabe, API-Attrappe), ECHTE
# Skripte des Release-Stands (install.sh, service-tunnel.sh aus diesem Repo) und
# das ECHTE Programm des Werkstatt-Dienstes. Ohne Mango, ohne Pi, ohne Portal.
# Alle Schlüssel sind Wegwerf-Schlüssel.
#
# Zwei Docker-Netze:
#   inet  198.51.100.0/24  "Internet und Netz der Werkbank" (mit NAT nach draußen)
#         dienst .241, bruecke .50 (wlan0), server .10
#   werk  192.168.1.0/24   der Werkstatt-Anschluss. Nicht "--internal": Docker
#                          verwirft dort jedes Paket mit Ziel außerhalb des
#                          Subnetzes, auch auf Ebene 2 - die Box käme nie durch
#                          die Brücke ins Internet. Die Box nimmt ihren Weg
#                          ohnehin über die Brücke (192.168.1.2), nie über Docker.
#         bruecke .2 (eth0), box .1 (frisches OpenWrt; später 10.213.0.1)
#
# Nicht geprüft (nur an der echten Mango, Prüfsteine PS-1 bis PS-4): die
# GL-Werksfirmware und "sysupgrade -n" (der Lauf beginnt hier ab frischem
# OpenWrt), die Bauart mipsle (die Box hier ist x86-64, Programm amd64).
#
# Die Box bekommt über die Brücke Internet (apk, wget); die Adressen von
# voltpilot.de löst sie auf 127.0.0.1 auf: Sie spricht nie mit dem echten Portal.
#
# Aufruf: services/werkstatt-dienst/test/box-probe.sh
#   VP_PROBE_BEHALTEN=1  Container, Netze, Bilder und Dateien nicht wegräumen
set -eu

HIER=$(cd "$(dirname "$0")" && pwd)
DIENST=$(cd "$HIER/.." && pwd)
REPO=$(cd "$DIENST/../.." && pwd)
P=vpwb-$$
BILD_DEB=vpwb-probe:trixie
BILD_BOX=vpwb-probe:openwrt-25.12.5
BILD_DIENST=vpwb-probe:dienst
FASSUNG=edge-light-2026.11.1
TUNNEL=10.10.16.5
BOX_ID=c0ffee00-0000-4000-8000-000000000001

for c in docker go ssh-keygen jq; do command -v "$c" >/dev/null 2>&1 || { echo "FEHLER: $c fehlt" >&2; exit 2; }; done
docker info >/dev/null 2>&1 || { echo "FEHLER: Docker antwortet nicht" >&2; exit 2; }
ARCH=$(docker version --format '{{.Server.Arch}}')
TMP=$(mktemp -d)
chmod 755 "$TMP"
fehler=0
ok() { echo "ok: $*"; }
nein() { echo "FEHLER: $*"; fehler=1; }
x() { c=$1; shift; docker exec "$P-$c" "$@"; }
aufraeumen() {
  if [ "${VP_PROBE_BEHALTEN:-}" = 1 ]; then
    echo "behalten: $P-* ($TMP)"
    return
  fi
  docker rm -f "$P-dienst" "$P-bruecke" "$P-box" "$P-server" "$P-bau" >/dev/null 2>&1 || true
  docker network rm "$P-a-inet" "$P-b-werk" >/dev/null 2>&1 || true
  docker volume rm "$P-daten" >/dev/null 2>&1 || true
  docker image rm "$BILD_DIENST" "$BILD_DEB" "$BILD_BOX" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap aufraeumen EXIT INT TERM

# ── Bauen ────────────────────────────────────────────────────────────────────
echo "== Programme bauen"
mkdir -p "$TMP/bin" "$TMP/geheim" "$TMP/oeffentlich" "$TMP/fassungen" "$TMP/freigabe"
(cd "$DIENST" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags "-X main.fassung=probe" -o "$TMP/bin/vp-werkstatt-dienst" ./cmd/vp-werkstatt-dienst)
(cd "$REPO/services/tunnel-dienst" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o "$TMP/bin/vp-tunnel-dienst" ./cmd/vp-tunnel-dienst && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -o "$TMP/bin/attrappe" ./test/attrappe)
# Edge Light für die x86-64-Box, mit der Fassung der Freigabe (wie ein Release, P4)
(cd "$REPO/edge-app/core" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent.Version=$FASSUNG" \
  -o "$TMP/vp-edge-light-linux-amd64" ./cmd/vp-edge-light)
# Skriptstand wie der Release-Anhang edge-light-openwrt.tar.gz
# (COPYFILE_DISABLE, --no-xattrs: macOS legte sonst ._-Dateien dazu, die der Dienst ablehnt)
COPYFILE_DISABLE=1 tar --no-xattrs -C "$REPO/edge-light" -czf "$TMP/edge-light-openwrt.tar.gz" openwrt
PROG_SHA=$(shasum -a 256 "$TMP/vp-edge-light-linux-amd64" | cut -d' ' -f1)
SKR_SHA=$(shasum -a 256 "$TMP/edge-light-openwrt.tar.gz" | cut -d' ' -f1)
# In die Ablage nach Prüfsumme: der Dienst lädt dann nichts aus dem Netz.
mv "$TMP/vp-edge-light-linux-amd64" "$TMP/fassungen/$PROG_SHA"
mv "$TMP/edge-light-openwrt.tar.gz" "$TMP/fassungen/$SKR_SHA"

echo "== Wegwerf-Schlüssel"
for k in werkbank-status werkbank-weiterleitung werkbank-pflege werkbank-einrichten; do
  ssh-keygen -q -t ed25519 -N '' -C "probe-$k" -f "$TMP/geheim/$k"
done
ssh-keygen -q -t rsa -b 3072 -N '' -C voltpilot-notfall -f "$TMP/notfall"
cp "$TMP/notfall.pub" "$TMP/oeffentlich/voltpilot-notfall.pub"
mv "$TMP/geheim/werkbank-einrichten.pub" "$TMP/einrichten.pub"
rm -f "$TMP"/geheim/*.pub
chmod 0644 "$TMP"/geheim/*
# age-Schlüssel mit einem kleinen Programm aus den Abhängigkeiten des Dienstes
# (ohne age-Werkzeug auf dem Rechner, ohne Netz)
mkdir -p "$TMP/age"
sed 's#^module .*#module agewerkzeug#' "$DIENST/go.mod" >"$TMP/age/go.mod"
cp "$DIENST/go.sum" "$TMP/age/go.sum"
cat >"$TMP/age/main.go" <<'EOF'
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"filippo.io/age"
	"filippo.io/age/armor"
)

func main() {
	if os.Args[1] == "neu" {
		id, _ := age.GenerateX25519Identity()
		fmt.Println(id.Recipient().String())
		fmt.Fprintln(os.Stderr, id.String())
		return
	}
	b, _ := os.ReadFile(os.Args[2])
	id, err := age.ParseX25519Identity(strings.TrimSpace(string(b)))
	if err != nil {
		os.Exit(1)
	}
	r, err := age.Decrypt(armor.NewReader(os.Stdin), id)
	if err != nil {
		os.Exit(1)
	}
	_, _ = io.Copy(os.Stdout, r)
}
EOF
(cd "$TMP/age" && go build -o "$TMP/agewerkzeug" .)
AGE_PUB=$("$TMP/agewerkzeug" neu 2>"$TMP/age.key")
cat >"$TMP/freigabe/freigabe.json" <<EOF
{"schema":"vp-werkstatt-freigabe.v1","kennung":"probe-1","box_art":"mango","erteilt_von":"Probe",
 "erteilt_am":"$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)",
 "gueltig_bis":"$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)","obergrenze":3,
 "openwrt":{"fassung":"25.12.5","datei":"openwrt-25.12.5-x86-64-generic-squashfs-sysupgrade.bin","sha256":"$(printf '%064d' 0)","quelle":"https://downloads.openwrt.org/releases/25.12.5/targets/x86/64/"},
 "edge_light":{"fassung":"$FASSUNG","quelle":"https://probe.invalid/edge/","programm_sha256":"$PROG_SHA","skripte_sha256":"$SKR_SHA"}}
EOF

echo "== Bilder"
docker build -q -t "$BILD_DEB" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client nftables iproute2 iputils-arping iputils-ping \
      sudo socat procps wireguard-tools util-linux \
 && rm -rf /var/lib/apt/lists/*
EOF
if ! docker image inspect "$BILD_BOX" >/dev/null 2>&1; then
  docker run --name "$P-bau" openwrt/rootfs:x86-64-25.12.5 sh -c 'mkdir -p /var/lock /var/run && apk update >/dev/null 2>&1; apk add wireguard-tools >/dev/null' >/dev/null
  docker commit "$P-bau" "$BILD_BOX" >/dev/null
  docker rm "$P-bau" >/dev/null
fi
# Das Laufzeit-Bild wie im Dockerfile (Alpine, GNU gzip, Benutzer 10001), mit
# dem eben gebauten Programm statt einer zweiten Go-Stufe.
cp "$DIENST/Dockerfile" "$TMP/Dockerfile.echt"
cat >"$TMP/bin/Dockerfile" <<'EOF'
FROM alpine:3
RUN apk add --no-cache ca-certificates gzip && adduser -D -H -u 10001 -s /sbin/nologin werkstatt
COPY vp-werkstatt-dienst /usr/local/bin/vp-werkstatt-dienst
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/vp-werkstatt-dienst"]
CMD ["dienst"]
EOF
grep -q 'apk add --no-cache ca-certificates gzip' "$TMP/Dockerfile.echt" && ok "Laufzeit wie im Dockerfile (Alpine, GNU gzip)" || nein "Dockerfile hat eine andere Laufzeit als die Probe"
docker build -q -t "$BILD_DIENST" "$TMP/bin" >/dev/null

# ── Netze und Container ──────────────────────────────────────────────────────
echo "== Aufbau"
docker network create --subnet 198.51.100.0/24 --gateway 198.51.100.1 "$P-a-inet" >/dev/null
docker network create --subnet 192.168.1.0/24 --gateway 192.168.1.254 "$P-b-werk" >/dev/null

# Wartungsserver: wg-wartung, API-Attrappe mit dem Soll-Stand, Tunnel-Dienst
docker run -d --name "$P-server" --hostname server --network "$P-a-inet" --ip 198.51.100.10 --cap-add NET_ADMIN \
  --sysctl net.ipv4.ip_forward=1 -v "$TMP/bin:/opt/vptd:ro" "$BILD_DEB" sleep infinity >/dev/null
x server sh -c 'umask 077; wg genkey > /k; wg pubkey < /k > /p
  ip link add wg-wartung type wireguard && wg set wg-wartung private-key /k listen-port 51820 &&
  ip addr add 10.10.16.1/20 dev wg-wartung && ip addr add 10.10.32.1/24 dev wg-wartung && ip link set wg-wartung up
  mkdir -p /srv /tmp/z && : > /srv/log && echo probe-geheim > /tmp/z/secret && chown -R 65534:65534 /tmp/z && chmod 600 /tmp/z/secret'
SERVER_PUB=$(x server cat /p)
soll() { # soll <box-schlüssel oder leer>
  peers=""
  [ -z "$1" ] || peers="{\"art\":\"box\",\"id\":\"$BOX_ID\",\"kennung\":\"$2\",\"publicKey\":\"$1\",\"adresse\":\"$TUNNEL\"}"
  printf '{"version":1,"erzeugtAm":"%s","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24","peers":[%s],"fenster":[]}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$peers" | docker exec -i "$P-server" sh -c 'cat > /srv/soll.neu && mv /srv/soll.neu /srv/soll.json'
}
soll ""
docker exec -d "$P-server" sh -c 'exec /opt/vptd/attrappe -soll /srv/soll.json -rueckmeldung /srv/rueckmeldung.json'
sleep 1
docker exec -d -e VP_TUNNEL_API_URL=http://127.0.0.1:8080 -e VP_TUNNEL_TOKEN_URL=http://127.0.0.1:8080/token \
  -e VP_TUNNEL_CLIENT_SECRET_FILE=/tmp/z/secret -e VP_TUNNEL_ZUSTAND=/tmp/z -e VP_TUNNEL_INTERVALL=5s \
  -e VP_TUNNEL_SCHLUESSEL_PORT=8022 "$P-server" sh -c 'exec setpriv --reuid=65534 --regid=65534 --clear-groups \
  --inh-caps=+net_admin --ambient-caps=+net_admin /opt/vptd/vp-tunnel-dienst lauf >>/srv/log 2>&1'
warte() { # warte <sekunden> <befehl…>
  w_ende=$(($(date +%s) + $1)); shift
  until "$@" >/dev/null 2>&1; do [ "$(date +%s)" -lt "$w_ende" ] || return 1; sleep 1; done
}
warte 30 x server sh -c "ss -ltnH | grep -q '10.10.32.1:8022 '" && ok "Wartungsserver: Tunnel-Dienst mit Schlüsselausgabe läuft" ||
  { nein "Tunnel-Dienst startet nicht"; x server tail -5 /srv/log; }

# Brücke: frisch wie vom Imager (Benutzer vpwerkstatt mit dem Werkstatt-Schlüssel, sudo ohne Passwort)
docker run -d --name "$P-bruecke" --hostname vp-werkbank --privileged --network "$P-a-inet" --ip 198.51.100.50 "$BILD_DEB" sleep infinity >/dev/null
docker network connect --ip 192.168.1.2 "$P-b-werk" "$P-bruecke"
MAC_INET=$(docker inspect "$P-bruecke" --format "{{(index .NetworkSettings.Networks \"$P-a-inet\").MacAddress}}")
x bruecke sh -c "set -e
  n=\$(grep -il '$MAC_INET' /sys/class/net/eth*/address | cut -d/ -f5); w=\$(ls /sys/class/net | grep '^eth' | grep -v \"^\$n\$\")
  ip link set \$n down; ip link set \$n name wlan0; ip link set wlan0 up
  ip link set \$w down; ip link set \$w name eth0; ip link set eth0 up
  ip route replace default via 198.51.100.1 dev wlan0
  echo \"127.0.1.1 vp-werkbank\" >> /etc/hosts
  useradd -m -s /bin/bash vpwerkstatt
  install -d -m 0700 -o vpwerkstatt /home/vpwerkstatt/.ssh
  echo 'vpwerkstatt ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/010_vpwerkstatt-nopasswd; chmod 0440 /etc/sudoers.d/010_vpwerkstatt-nopasswd
  ssh-keygen -A >/dev/null; mkdir -p /run/sshd; /usr/sbin/sshd"
docker cp "$TMP/einrichten.pub" "$P-bruecke:/home/vpwerkstatt/.ssh/authorized_keys"
x bruecke sh -c 'chown vpwerkstatt /home/vpwerkstatt/.ssh/authorized_keys; chmod 600 /home/vpwerkstatt/.ssh/authorized_keys'

# Box: frisches OpenWrt unter 192.168.1.1, LAN direkt an der einen Netzwerkkarte
box_starten() {
  docker run -d --name "$P-box" --hostname OpenWrt --network "$P-b-werk" --ip 192.168.1.1 \
    --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
    --tmpfs /tmp:exec,mode=1777 "$BILD_BOX" /sbin/init >/dev/null
}
box_starten
warte 60 x box ubus call network.interface.lan status || nein "OpenWrt startet nicht"
MAC_BOX=$(docker inspect "$P-box" --format "{{(index .NetworkSettings.Networks \"$P-b-werk\").MacAddress}}")
x box sh -c "d=\$(grep -il '$MAC_BOX' /sys/class/net/eth*/address | cut -d/ -f5)
  uci -q delete network.wan6; uci -q delete network.wan; uci -q delete network.@device[0]
  uci set network.lan.device=\$d; uci -q delete network.lan.ipaddr; uci -q delete network.lan.netmask
  uci add_list network.lan.ipaddr=192.168.1.1/24; uci -q delete network.lan.ip6assign; uci commit network
  /etc/init.d/network restart >/dev/null 2>&1; sleep 3
  # Die Box spricht nie mit dem echten Portal.
  echo 'address=/voltpilot.de/127.0.0.1' >> /etc/dnsmasq.conf; /etc/init.d/dnsmasq restart >/dev/null 2>&1
  true"
box_mango() { x box sh -c 'mkdir -p /tmp/sysinfo && echo glinet,gl-mt300n-v2 > /tmp/sysinfo/board_name'; }
box_mango
x box sh -c '. /etc/openwrt_release; [ "$DISTRIB_RELEASE" = 25.12.5 ] && [ -z "$(sed -n "s/^root:\([^:]*\):.*/\1/p" /etc/shadow)" ]' &&
  ok "Box: frisches OpenWrt 25.12.5, root ohne Passwort" || nein "Box nicht im Ausgangszustand"

# Werkstatt-Dienst wie im Pod (Benutzer 10001, nur lesbar, ohne Capabilities)
docker volume create "$P-daten" >/dev/null
docker run --rm -u 0 -v "$P-daten:/d" -v "$TMP/fassungen:/f:ro" --entrypoint sh "$BILD_DIENST" -c 'mkdir -p /d/fassungen && cp /f/* /d/fassungen/ && chown -R 10001:10001 /d'
docker run -d --name "$P-dienst" --network "$P-a-inet" --ip 198.51.100.241 \
  --read-only --tmpfs /tmp:rw,exec,size=64m,uid=10001 --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  -v "$P-daten:/var/lib/vp-werkstatt-dienst" -v "$TMP/geheim:/etc/vp-werkstatt/geheim:ro" \
  -v "$TMP/oeffentlich:/etc/vp-werkstatt/oeffentlich:ro" -v "$TMP/freigabe:/etc/vp-werkstatt/freigabe:ro" \
  -e VP_WERKBANK_ADRESSE=198.51.100.50 -e VP_WERKBANK_SSH_QUELLEN=198.51.100.241 \
  -e VP_WERKSTATT_NOTFALL_PUB=/etc/vp-werkstatt/oeffentlich/voltpilot-notfall.pub \
  -e VP_WERKSTATT_PASSWORT_EMPFAENGER="$AGE_PUB" -e VP_WARTUNG_PUBKEY="$SERVER_PUB" -e VP_WARTUNG_ENDPUNKT=198.51.100.10 \
  -e VP_WERKSTATT_EDGE_BAUART=amd64 -e VP_WERKSTATT_TAKT=3s -e VOLTPILOT_LOGGING_FORMAT=json \
  "$BILD_DIENST" >/dev/null

# ── Lauf ─────────────────────────────────────────────────────────────────────
echo "== Lauf (ein Neustart der Box ist hier das Ende und der Neustart ihres Containers)"
zustand() { x dienst wget -qO- http://127.0.0.1:8101/zustand.json 2>/dev/null || echo '{}'; }
ende=$(($(date +%s) + 1500))
eingetragen=nein
geprobt=nein
letzter=""
while :; do
  # Ein reboot beendet den OpenWrt-Container: wie Strom weg und wieder da.
  if [ "$(docker inspect -f '{{.State.Running}}' "$P-box" 2>/dev/null)" = false ]; then
    docker start "$P-box" >/dev/null
    warte 60 x box ubus call network.interface.lan status || true
    box_mango
  fi
  z=$(zustand)
  st=$(printf '%s' "$z" | jq -r '.lauf.zustand // "-"')
  schritt=$(printf '%s' "$z" | jq -r '.lauf.schritt // "-"')
  [ "$st/$schritt" = "$letzter" ] || { echo "   Lauf: $st $schritt"; letzter="$st/$schritt"; }
  case "$st" in
    fertig | angehalten) break ;;
  esac
  auf=$(printf '%s' "$z" | jq -r '.lauf.wartet_auf // ""')
  if [ "$st" = wartet ] && [ "$auf" = probe ] && [ "$geprobt" = nein ]; then
    # Die Probe im Fenster macht in V1a der Betreiber im Portal (hier nicht
    # nachgestellt, siehe wartung-anmeldung-probe.sh). Belegt wird: Der Tunnel
    # steht in diesem Moment noch, über das Werkstatt-Internet der Brücke.
    x box sh -c 'wg show wg_wartung latest-handshakes | awk "{print \$2}" | grep -qv "^0$"' &&
      ok "während der Probe steht der Tunnel (Handshake), der Weg über die Brücke ist noch da" || nein "Tunnel während der Probe unten"
    x dienst vp-werkstatt-dienst eingabe probe erledigt >/dev/null && ok "Probe bestätigt (kubectl exec … eingabe probe erledigt)" || nein "Probe-Eingabe abgelehnt"
    geprobt=ja
  fi
  if [ "$st" = wartet ] && [ "$auf" = tunnel_adresse ] && [ "$eingetragen" = nein ]; then
    k=$(printf '%s' "$z" | jq -r '.lauf.kennung')
    pub=$(x dienst wget -qO- "http://127.0.0.1:8101/laeufe/$k.json" | jq -r '[.[] | select(.schritt=="tunnel_schluessel" and .art=="schritt_belegt") | .beleg[] | select(.name=="tunnel_schluessel") | .wert][0]')
    ref=$(x dienst wget -qO- "http://127.0.0.1:8101/laeufe/$k.json" | jq -r '[.[] | select(.schritt=="programm" and .art=="schritt_belegt") | .beleg[] | select(.name=="referenz") | .wert][0]' | cut -d' ' -f1)
    # wie im Portal: Tunnel-Schlüssel hinterlegen, Adresse zuteilen
    soll "$pub" "$ref"
    warte 30 x server sh -c "wg show wg-wartung peers | grep -qF '$pub'" && ok "Wartungsserver kennt den Tunnel-Schlüssel der Box" || nein "Server ohne Peer"
    x dienst vp-werkstatt-dienst eingabe tunnel_adresse "$TUNNEL" >/dev/null && ok "Tunnel-Adresse eingetragen (kubectl exec … eingabe)" || nein "Eingabe abgelehnt"
    eingetragen=ja
  fi
  [ "$(date +%s)" -lt "$ende" ] || { nein "Lauf nach 25 Minuten nicht zu Ende"; break; }
  sleep 3
done

# ── Prüfen ───────────────────────────────────────────────────────────────────
z=$(zustand)
k=$(printf '%s' "$z" | jq -r '.lauf.kennung')
P_JSON=$(x dienst wget -qO- "http://127.0.0.1:8101/laeufe/$k.json" 2>/dev/null || echo '[]')
printf '%s\n' "$P_JSON" >"$TMP/protokoll.json"
beleg() { jq -r --arg s "$1" --arg n "$2" '[.[] | select(.schritt==$s and .art=="schritt_belegt") | .beleg[] | select(.name==$n) | .wert][0] // ""' "$TMP/protokoll.json"; }
st=$(printf '%s' "$z" | jq -r '.lauf.zustand')
if [ "$st" = fertig ]; then
  ok "Lauf fertig: $(printf '%s' "$z" | jq -r '.lauf.erledigt | join(" ")')"
else
  nein "Lauf $st im Schritt $(printf '%s' "$z" | jq -r '.lauf.schritt'): $(printf '%s' "$z" | jq -r '.lauf.grund')"
fi
case "$(beleg internet standardweg)" in *"via 192.168.1.2"*) ok "Werkstatt-Internet über die Brücke (PS-12 in der Probe)" ;; *) nein "internet: $(beleg internet standardweg)" ;; esac
case "$(beleg programm install)" in *"Pruefsumme auf dem Geraet bestaetigt"*) ok "install.sh aus dem Skriptstand: Prüfsumme auf der Box bestätigt" ;; *) nein "install: $(beleg programm install)" ;; esac
REF=$(beleg programm referenz | cut -d' ' -f1)
case "$REF" in edge-???????) ok "Referenz $REF mit gültigem Prüfzeichen" ;; *) nein "Referenz: $(beleg programm referenz)" ;; esac
case "$(beleg tunnel handshake)" in *"latest handshake"*) ok "Tunnel: $(beleg tunnel handshake)" ;; *) nein "Tunnel ohne Handshake" ;; esac
case "$(beleg tunnel abholer)" in *"Abholer laeuft,"*"letzte gueltige Antwort"*) ok "Abholer läuft mit gültiger Antwort des Wartungsservers" ;; *) nein "Abholer: $(beleg tunnel abholer)" ;; esac
case "$(beleg neustart host_schluessel)" in *"$(beleg erkennen host_schluessel | cut -d' ' -f2)"*) ok "Host-Schlüssel nach dem Neustart derselbe" ;; *) nein "Host-Schlüssel nach dem Neustart" ;; esac

# Passwort: nur verschlüsselt im Beleg, entschlüsselt meldet es an, nirgends im Klartext
beleg passwort passwort_age >"$TMP/pw.age"
if "$TMP/agewerkzeug" lies "$TMP/age.key" <"$TMP/pw.age" >"$TMP/pw" 2>/dev/null && [ -s "$TMP/pw" ]; then
  ok "Passwort im Beleg: nur mit dem age-Schlüssel lesbar"
  PW=$(tr -d '\n' <"$TMP/pw")
  docker cp "$TMP/pw" "$P-bruecke:/tmp/pw" >/dev/null
  x bruecke sh -c 'printf "#!/bin/sh\ncat /tmp/pw\n" > /tmp/ask; chmod 700 /tmp/ask'
  if x bruecke env SSH_ASKPASS=/tmp/ask SSH_ASKPASS_REQUIRE=force DISPLAY=x setsid ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ConnectTimeout=5 root@10.213.0.1 true </dev/null 2>/dev/null; then
    ok "mit dem entschlüsselten Passwort meldet sich root an der Box an"
  else
    nein "entschlüsseltes Passwort meldet nicht an"
  fi
  x bruecke rm -f /tmp/pw /tmp/ask
  if docker logs "$P-dienst" 2>&1 | grep -qF "$PW" || grep -qF "$PW" "$TMP/protokoll.json"; then nein "Passwort im Klartext in Log oder Protokoll"; else ok "Passwort in keinem Log und keinem Beleg"; fi
else
  nein "passwort_age nicht entschlüsselbar"
fi

# Die Box am Ende
N=$(x box sh -c 'grep -c . /etc/dropbear/authorized_keys' 2>/dev/null || echo 0)
FP_BOX=$(x box cat /etc/dropbear/authorized_keys | ssh-keygen -lf - | awk '{print $2}')
FP_N=$(ssh-keygen -lf "$TMP/notfall.pub" | awk '{print $2}')
[ "$N" = 1 ] && [ "$FP_BOX" = "$FP_N" ] && ok "auf der Box genau ein dauerhafter Schlüssel: der Notfall-Schlüssel" || nein "dauerhafte Schlüssel: $N ($FP_BOX)"
[ "$(x box uci -q get network.lan.ipaddr)" = 10.213.0.1/24 ] && ok "LAN auf 10.213.0.1/24 (Entscheid 6a)" || nein "LAN: $(x box uci -q get network.lan.ipaddr)"
x box sh -c '! uci -q get network.lan.gateway' && ok "Werkstatt-Internet aus der Netz-Einstellung entfernt" || nein "Weg über die Brücke steht noch"
[ "$(x box cat /etc/vp-edge-light/ref 2>/dev/null)" = "$REF" ] && ok "Referenz auf der Box = Beleg" || nein "Referenz auf der Box"
# Am Ende hat die Box keinen Standardweg mehr: Der Tunnel (frischer Handshake
# belegt in der Neustart-Probe) kommt beim Kunden über WAN wieder hoch; ohne Weg
# hält OpenWrt wg_wartung unten.
[ -z "$(x box ip -4 route show default)" ] && [ "$(x box uci -q get network.wg_wartung.proto)" = wireguard ] &&
  ok "Box am Ende ohne Standardweg, Tunnel eingerichtet (kommt beim Kunden über WAN)" || nein "Box am Ende: Standardweg oder Tunnel"
case "$(beleg neustart handshake)" in *"latest handshake"*) ok "Neustart-Probe: $(beleg neustart handshake)" ;; *) nein "Neustart-Probe ohne Handshake" ;; esac
x bruecke /usr/local/sbin/vp-werkbank-pruefen >/dev/null && ok "Brücke: vp-werkbank-pruefen besteht" || nein "Brücke: pruefen"
docker logs "$P-dienst" 2>&1 | grep -v '^{' | grep -q . && nein "Zeile ohne JSON im Log des Dienstes" || ok "jede Log-Zeile des Dienstes ist JSON"

echo
if [ "$fehler" = 0 ]; then echo "Probe eines Laufs ab OpenWrt: alles bestanden"; else
  echo "Probe eines Laufs ab OpenWrt: FEHLER"
  docker logs "$P-dienst" 2>&1 | tail -n 30
fi
exit "$fehler"
