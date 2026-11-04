#!/bin/sh
# Probe der Werkbank-Brücke (services/werkstatt-dienst/bruecke) in einem
# Container: ECHTES einrichten.sh, ECHTES nftables, ECHTER OpenSSH-Server mit
# den drei Schlüsseln des Dienstes, eingerichtet vom ECHTEN Dienst-Programm
# (vp-werkstatt-dienst werkbank) - ohne Pi, ohne Mango, ohne echtes Netz.
# Alle Schlüssel sind Wegwerf-Schlüssel; alle Netze liegen in Netz-Namensräumen
# eines Containers ohne Netz nach draußen (--network none).
#
# Ein Container (Debian trixie wie Raspberry Pi OS), darin:
#
#   Brücke (Wurzel)  wlan0 192.168.0.50/24 ins "Büronetz", eth0 = Werkstatt-Anschluss
#   router           192.168.0.1 | 192.168.178.1 (Cluster) | 198.51.100.1 (Internet)
#   cluster          192.168.178.241 - von hier spricht der Dienst mit der Brücke
#   fremd            192.168.0.20 - ein anderes Gerät im Büronetz
#   internet         198.51.100.10 - ein öffentlicher Server
#   mango, mango2    am Werkstatt-Anschluss: ab Werk 192.168.8.1, später 192.168.1.1
#
# Prüft:
#   1  der Dienst richtet die frische Brücke über den Imager-Benutzer ein;
#      vp-werkbank-pruefen besteht; zweiter Lauf ändert nichts
#   2  danach kommt der Imager-Benutzer nicht mehr herein
#   3  Status-Schlüssel: nur der Status (auch bei anderem Befehl), keine
#      Weiterleitung; der Status nennt die Mango am Werkstatt-Anschluss
#   4  Weiterleitungs-Schlüssel: nur zu den Werkstatt-Zielen, keine Shell
#   5  Pflege-Schlüssel: nur "einrichten <sha256>", falsche Prüfsumme abgewiesen;
#      geänderte Parameter spielt der Dienst über die Pflege neu auf
#   6  Notfall-Schlüssel: Shell als werkstatt, sudo nur für die zwei Befehle
#   7  SSH auf die Brücke nur aus dem Cluster: nicht aus dem Büronetz, nicht
#      vom Werkstatt-Anschluss
#   8  Durchleitung: Mango ins Internet (mit NAT), nie ins Büronetz, Cluster
#      oder zum Router; aus dem Büronetz nicht zur Mango
#   9  zwei Geräte am Werkstatt-Anschluss: der Status nennt zwei MACs
#   10 fehlt die Firewall, prüfen schlägt fehl und der Dienst spielt neu auf
#
# Aufruf: services/werkstatt-dienst/test/bruecke-probe.sh
#   VP_PROBE_BEHALTEN=1  Container und Bild nicht wegräumen (zum Nachsehen)
set -eu

HIER=$(cd "$(dirname "$0")" && pwd)
DIENST=$(cd "$HIER/.." && pwd)
BILD=vp-werkbank-probe:trixie
NAME=vp-werkbank-probe-$$

command -v docker >/dev/null 2>&1 || { echo "FEHLER: docker fehlt" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "FEHLER: Docker antwortet nicht" >&2; exit 2; }
command -v go >/dev/null 2>&1 || { echo "FEHLER: go fehlt" >&2; exit 2; }
command -v ssh-keygen >/dev/null 2>&1 || { echo "FEHLER: ssh-keygen fehlt" >&2; exit 2; }

ARCH=$(docker version --format '{{.Server.Arch}}')
TMP=$(mktemp -d)
aufraeumen() {
  if [ "${VP_PROBE_BEHALTEN:-}" = 1 ]; then
    echo "behalten: Container $NAME, Dateien $TMP"
    return
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker image rm "$BILD" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap aufraeumen EXIT

echo "== Programm bauen (linux/$ARCH)"
(cd "$DIENST" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o "$TMP/vp-werkstatt-dienst" ./cmd/vp-werkstatt-dienst)

echo "== Wegwerf-Schlüssel"
mkdir -p "$TMP/geheim"
for k in werkbank-status werkbank-weiterleitung werkbank-pflege werkbank-einrichten; do
  ssh-keygen -q -t ed25519 -N '' -C "probe-$k" -f "$TMP/geheim/$k"
done
ssh-keygen -q -t rsa -b 3072 -N '' -C voltpilot-notfall -f "$TMP/notfall"
chmod 0644 "$TMP"/geheim/* "$TMP"/notfall*

echo "== Bild $BILD"
docker build -q -t "$BILD" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server openssh-client nftables iproute2 iputils-arping iputils-ping \
      sudo socat procps \
 && rm -rf /var/lib/apt/lists/*
EOF

cp "$HIER/bruecke-probe-innen.sh" "$TMP/innen.sh"
# Die Dateien kommen per docker cp in den Container, nicht per Bind-Mount: auf
# dem Runner gibt es $TMP für den Docker-Daemon nicht (volumen.sh).
docker create --name "$NAME" --privileged --network none "$BILD" sleep infinity >/dev/null
docker cp "$TMP/." "$NAME:/probe"
docker start "$NAME" >/dev/null
echo "== Probe im Container"
docker exec "$NAME" bash /probe/innen.sh
