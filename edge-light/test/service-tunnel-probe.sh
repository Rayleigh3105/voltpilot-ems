#!/bin/sh
# Probe fuer edge-light/openwrt/service-tunnel.sh gegen ein ECHTES OpenWrt
# (Rootfs 24.10 mit procd, netifd, fw4, Dropbear und cron als Container) -
# ohne Mango und ohne Root auf dem Rechner. Kernel-WireGuard kommt vom Host.
#
# Nachgestellt wird der beaufsichtigte Wechsel des Piloten (mango.md):
#   1. Altbestand: Tunnel ins alte Service-VPN (wg_service) mit der Crontab
#      aus der Zeit vor zwei Tunneln,
#   2. Schluessel fuer den Wartungsserver erzeugen; ohne Server-Schluessel
#      wird nichts eingerichtet,
#   3. wg_wartung NEBEN wg_service einrichten (beide in der Zone service,
#      zwei Dropbear-Instanzen, Waechter je Schnittstelle), wiederholbar,
#   4. Abbauen des Tunnels, ueber den die Sitzung laeuft, wird verweigert,
#   5. den alten Tunnel abbauen, 6. Web-App-Freigabe, 7. alles abbauen.
#
# "ssh" ist ein Ersatz, der die Befehle per docker exec im Container
# ausfuehrt; SSH_CONNECTION wird so gesetzt, als kaeme die Sitzung ueber den
# genannten Weg. Die Server-Gegenstellen sind Adressen ohne Server - geprueft
# wird die Einrichtung auf der Box, nicht der Handshake (den belegt die
# Integrationsprobe des Tunnel-Dienstes, services/tunnel-dienst/test/). Sie
# liegen im LAN des Containers: netifd bringt eine WireGuard-Schnittstelle erst
# hoch, wenn es eine Route zur Gegenstelle gibt, und der Container hat keine
# WAN-Route (auf der Box ist das die Route ins Internet).
#
#   edge-light/test/service-tunnel-probe.sh
#   VPTD_DOCKER_DNS=1.1.1.1 edge-light/test/service-tunnel-probe.sh   # ohne DNS im Container
# shellcheck disable=SC2016 # die Pruefausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
SKRIPT="$HIER/../openwrt/service-tunnel.sh"
BILD="${VPTB_BILD:-openwrt/rootfs:x86-64-24.10.4}"
C="vptb-$$"
ARBEIT="$(mktemp -d)"
DNS="${VPTD_DOCKER_DNS:+--dns $VPTD_DOCKER_DNS}"
OK=0
FEHLER=0

aufraeumen() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$ARBEIT"; }
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
pruefe() { # pruefe <beschreibung> <befehl im container...>
  b="$1"; shift
  if docker exec "$C" sh -c "$*" >/dev/null 2>&1; then ok "$b"; else falsch "$b"; fi
}
x() { docker exec "$C" sh -c "$*"; }

# ssh-Ersatz: ssh <ziel> <befehl>  ->  docker exec im Container
mkdir -p "$ARBEIT/bin"
cat > "$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
shift
exec docker exec -i -e SSH_CONNECTION="\${SSH_SIM:-}" "$C" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"
PATH="$ARBEIT/bin:$PATH"
export PATH

tunnel() { "$SKRIPT" root@box "$@"; }

schritt "Aufbau: OpenWrt mit procd, wireguard-tools aus dem Paketarchiv"
# shellcheck disable=SC2086 # DNS bewusst als Wortliste
docker run --rm $DNS --user "$(id -u):$(id -g)" -v "$ARBEIT":/out alpine:3.20 sh -c '
  B=https://downloads.openwrt.org/releases/24.10.4/packages/x86_64/base
  cd /out && wget -q "$B/Packages.gz" -O p.gz && gunzip -f p.gz
  F=$(awk "/^Package: wireguard-tools\$/{p=1} p&&/^Filename:/{print \$2; exit}" p)
  wget -q "$B/$F" -O wg.ipk'
docker run -d --name "$C" --cap-add NET_ADMIN --cap-add NET_RAW "$BILD" /sbin/init >/dev/null
docker cp "$ARBEIT/wg.ipk" "$C:/tmp/wg.ipk"
i=0
until x 'ubus call network get_proto_handlers' >/dev/null 2>&1 || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
# Nur die Dateien des Pakets (Kernel-WireGuard liefert der Host).
x 'mkdir -p /tmp/wg && cd /tmp/wg && tar xzf ../wg.ipk && tar xzf data.tar.gz -C / && /etc/init.d/network restart'
sleep 3
pruefe "netifd kennt wireguard" 'ubus call network get_proto_handlers | grep -q "\"wireguard\""'
x 'mkdir -p /etc/vp-edge-light && echo edge-zay5sdd > /etc/vp-edge-light/ref'

schritt "1. Altbestand wie am Piloten: wg_service ins alte VPN"
VP_SERVICE_ZIEL=alt tunnel key >/dev/null
VP_SERVICE_ZIEL=alt VP_SERVICE_ENDPOINT=192.168.1.201 tunnel 10.10.1.25 >/dev/null
# Die Crontab aus der Zeit vor zwei Tunneln (am Piloten so eingerichtet).
x "printf '%s\n' '* * * * * /usr/bin/wireguard_watchdog # vp-service-tunnel' '*/5 * * * * /usr/libexec/vp-edge-light/service-tunnel-watch.sh # vp-service-tunnel' > /etc/crontabs/root"
sleep 2
pruefe "wg_service hat 10.10.1.25" 'ip -4 addr show dev wg_service | grep -q "inet 10.10.1.25/32"'
pruefe "Dropbear-Instanz vp_service im Tunnel" '[ "$(uci get dropbear.vp_service.Interface)" = wg_service ]'

schritt "2. Schluessel fuer den Wartungsserver"
AUS="$(tunnel key)"
case "$AUS" in *"Box-Referenz: edge-zay5sdd"*) ok "key nennt die Box-Referenz" ;; *) falsch "key nennt die Box-Referenz" ;; esac
PRIV="$(x 'cat /etc/wireguard/vp-wartung.key')"
case "$AUS" in *"$PRIV"*) falsch "privater Schluessel bleibt auf der Box" ;; *) ok "privater Schluessel bleibt auf der Box" ;; esac
pruefe "Schluesseldatei nur fuer root (0600)" 'ls -l /etc/wireguard/vp-wartung.key | grep -q "^-rw------- "'
pruefe "alter Schluessel unberuehrt daneben" '[ -s /etc/wireguard/vp-service.key ]'
if tunnel 10.10.16.2 >/dev/null 2>&1; then falsch "ohne Server-Schluessel verweigert"; else ok "ohne Server-Schluessel verweigert"; fi
pruefe "nichts eingerichtet ohne Server-Schluessel" '! uci -q get network.wg_wartung'

schritt "3. wg_wartung neben wg_service (wiederholbar)"
SERVER=LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=
for _ in 1 2; do
  VP_SERVICE_PUBKEY="$SERVER" VP_SERVICE_ENDPOINT=192.168.1.202 tunnel 10.10.16.2 51820 >/dev/null
done
sleep 3
pruefe "wg_wartung hat 10.10.16.2" 'ip -4 addr show dev wg_wartung | grep -q "inet 10.10.16.2/32"'
pruefe "wg_service laeuft weiter" 'ip -4 addr show dev wg_service | grep -q "inet 10.10.1.25/32"'
pruefe "Tunnel erlaubt nur das Techniker-Netz" '[ "$(wg show wg_wartung allowed-ips | cut -f2)" = 10.10.32.0/24 ]'
pruefe "Gegenstelle 192.168.1.202:51820" 'wg show wg_wartung endpoints | grep -q "192.168.1.202:51820"'
pruefe "Zone service umfasst beide Tunnel" '[ "$(uci get firewall.vp_service.network)" = "wg_service wg_wartung" ]'
pruefe "fw4: SSH 2222 aus der Zone service" 'nft list chain inet fw4 input_service | grep -q "dport 2222"'
pruefe "fw4: wg_wartung springt in die Zone service" 'nft list chain inet fw4 input | grep "input_service" | grep -q wg_wartung'
pruefe "Dropbear-Instanz vp_wartung nur im neuen Tunnel" '[ "$(uci get dropbear.vp_wartung.Interface)" = wg_wartung ] && [ "$(uci get dropbear.vp_wartung.PasswordAuth)" = off ]'
pruefe "ein Waechter je Tunnel, wireguard_watchdog genau einmal" \
  '[ "$(grep -c wireguard_watchdog /etc/crontabs/root)" = 1 ] && [ "$(grep -c "service-tunnel-watch.sh wg_wartung # vp-service-tunnel:wg_wartung" /etc/crontabs/root)" = 1 ]'
pruefe "Alt-Waechter fuer wg_service bleibt" 'grep -q "service-tunnel-watch.sh # vp-service-tunnel$" /etc/crontabs/root'

schritt "4. Den Ast, auf dem man sitzt, nicht absaegen"
if SSH_SIM="10.10.32.2 50000 10.10.16.2 2222" tunnel abbauen wg_wartung >/dev/null 2>&1; then
  falsch "Abbauen ueber den eigenen Tunnel verweigert"
else
  ok "Abbauen ueber den eigenen Tunnel verweigert"
fi
pruefe "wg_wartung steht noch" 'uci -q get network.wg_wartung'

schritt "5. Alten Tunnel abbauen (angemeldet ueber den neuen)"
SSH_SIM="10.10.32.2 50000 10.10.16.2 2222" tunnel abbauen wg_service >/dev/null
sleep 2
pruefe "wg_service weg (Schnittstelle und Konfiguration)" '! uci -q get network.wg_service && ! ip link show wg_service'
pruefe "alter Schluessel geloescht" '[ ! -e /etc/wireguard/vp-service.key ]'
pruefe "Zone service nur noch wg_wartung" '[ "$(uci get firewall.vp_service.network)" = wg_wartung ]'
pruefe "Dropbear-Instanz vp_service weg" '! uci -q get dropbear.vp_service'
pruefe "Alt-Waechter weg, wireguard_watchdog bleibt" \
  '! grep -q "service-tunnel-watch.sh # vp-service-tunnel$" /etc/crontabs/root && grep -q wireguard_watchdog /etc/crontabs/root'
pruefe "neuer Tunnel unberuehrt" 'ip -4 addr show dev wg_wartung | grep -q "inet 10.10.16.2/32"'

schritt "6. Web-App fuer eine Techniker-Adresse"
tunnel web 10.10.32.2 >/dev/null
pruefe "Freigabe 8484 nur fuer 10.10.32.2" '[ "$(uci get firewall.vp_service_web.src_ip)" = 10.10.32.2 ]'
tunnel web >/dev/null
pruefe "Freigabe wieder zu" '! uci -q get firewall.vp_service_web'

schritt "7. Alles abbauen (angemeldet im LAN)"
SSH_SIM="192.168.1.10 50000 192.168.1.1 22" tunnel abbauen wg_wartung >/dev/null
pruefe "keine Tunnel-Zone mehr" '! uci -q get firewall.vp_service && ! uci -q get firewall.vp_service_ssh'
pruefe "keine Waechter mehr" '! grep -q vp-service-tunnel /etc/crontabs/root'

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'grep DISTRIB_DESCRIPTION /etc/openwrt_release' | cut -d"'" -f2), Kernel $(uname -r))"
[ "$FEHLER" -eq 0 ]
