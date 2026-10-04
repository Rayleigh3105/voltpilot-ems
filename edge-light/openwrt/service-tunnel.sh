#!/bin/sh
# Wartungstunnel (WireGuard ins VoltPilot-Service-VPN) auf einem OpenWrt-Geraet
# einrichten - dauerhaft und unabhaengig von vp-edge-light.
#
#   1. Pakete + Schluessel (der private Schluessel bleibt auf dem Geraet):
#        edge-light/openwrt/service-tunnel.sh root@192.168.1.1 key
#      -> gibt den oeffentlichen Schluessel aus; damit in WireGuard UI
#         (vpn.voltpilot.de) einen Client anlegen, "Apply Config".
#   2. Tunnel mit der dort zugeteilten Adresse einrichten:
#        edge-light/openwrt/service-tunnel.sh root@192.168.1.1 10.10.1.23 [port]
#   oder: die in WireGuard UI heruntergeladene Client-Datei uebernehmen (dann
#   kennt der VPN-Server den privaten Schluessel - fuer die Flotte besser den
#   Schluessel des Geraets eintragen):
#        edge-light/openwrt/service-tunnel.sh root@192.168.1.1 import <datei.conf>
#   Schluessel und Preshared Key gehen per stdin in /etc/wireguard (0600),
#   nie ueber eine Befehlszeile; DNS aus der Datei wird NICHT uebernommen
#   (der Mango ist der Router, seine Namensaufloesung bleibt).
#
# Was eingerichtet wird (alles im Betriebssystem, kein Teil des Programms):
#   - Schnittstelle wg_service, persistent_keepalive 25 (haelt NAT offen)
#   - Firewall-Zone "service": eingehend NUR SSH auf Port 2222 und Ping; kein
#     Weiterleiten ins Kundennetz. Die Web-App :8484 hat keine Anmeldung und
#     bleibt deshalb ausserhalb des Tunnels - erreichbar per
#     ssh -p 2222 -L 8484:127.0.0.1:8484 root@<tunnel-ip>
#   - eine zweite Dropbear-Instanz nur im Tunnel, nur mit Schluessel (RSA - der
#     Dropbear des Mango kennt kein Ed25519); die bestehende SSH-Anmeldung im
#     LAN bleibt unveraendert
#   - Waechter (cron): wireguard_watchdog jede Minute, Neustart der
#     Schnittstelle ohne Handshake seit 10 min
#
# Erneut ausfuehrbar; der Schluessel bleibt erhalten.
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.1}"
WHAT="${2:?\"key\", \"import <datei>\" oder die Tunnel-Adresse fehlt, z. B. 10.10.1.23}"
PORT="${3:-1001}"
ENDPOINT="${VP_SERVICE_ENDPOINT:-vpn.voltpilot.de}"
SERVER_PUB="${VP_SERVICE_PUBKEY:-LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=}"
NET="${VP_SERVICE_NET:-10.10.1.0/24}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"

if [ "$WHAT" = key ]; then
  echo "--- WireGuard installieren und Schluessel erzeugen auf $TARGET"
  # shellcheck disable=SC2016 # wird auf dem Geraet ausgewertet
  ssh "$TARGET" 'set -e
    command -v wg >/dev/null 2>&1 || { apk update >/dev/null && apk add kmod-wireguard wireguard-tools >/dev/null; }
    mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
    [ -s /etc/wireguard/vp-service.key ] || (umask 077; wg genkey > /etc/wireguard/vp-service.key)
    # Schluessel und Identitaet ueberleben ein sysupgrade
    for p in /etc/wireguard/ /etc/vp-edge-light/; do grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf; done
    echo "oeffentlicher Schluessel des Geraets:"
    wg pubkey < /etc/wireguard/vp-service.key'
  exit 0
fi

if [ "$WHAT" = import ]; then
  CONF="${3:?Client-Datei aus WireGuard UI fehlt}"
  # conf_val KEY - der Wert nach dem ERSTEN "=" (Base64-Schluessel enden auf "=")
  conf_val() { tr -d '' <"$CONF" | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | head -1 | sed 's/[[:space:]]*$//'; }
  PRIV="$(conf_val PrivateKey)"
  PSK="$(conf_val PresharedKey)"
  ADDR="$(conf_val Address | cut -d, -f1 | cut -d/ -f1)"
  SERVER_PUB="$(conf_val PublicKey)"
  EP="$(conf_val Endpoint)"
  ENDPOINT="${EP%:*}"
  PORT="${EP##*:}"
  NET="$(conf_val AllowedIPs | tr -d ' ')"
  [ -n "$PRIV" ] && [ -n "$ADDR" ] && [ -n "$SERVER_PUB" ] && [ -n "$ENDPOINT" ] && [ "$PORT" != "$EP" ] || {
    echo "FEHLER: $CONF ist keine vollstaendige WireGuard-Client-Datei" >&2
    exit 1
  }
  echo "--- Schluessel aus $CONF uebernehmen (Adresse $ADDR, Server $ENDPOINT:$PORT)"
  printf '%s
' "$PRIV" | ssh "$TARGET" 'umask 077; mkdir -p /etc/wireguard && cat > /etc/wireguard/vp-service.key'
  if [ -n "$PSK" ]; then
    printf '%s
' "$PSK" | ssh "$TARGET" 'umask 077; cat > /etc/wireguard/vp-service.psk'
  else
    ssh "$TARGET" 'rm -f /etc/wireguard/vp-service.psk'
  fi
else
  case "$WHAT" in
    *.*.*.*) ADDR="$WHAT" ;;
    *) echo "FEHLER: keine IPv4-Adresse: $WHAT" >&2; exit 1 ;;
  esac
fi

echo "--- Waechter kopieren"
ssh "$TARGET" 'mkdir -p /usr/libexec/vp-edge-light && cat > /usr/libexec/vp-edge-light/service-tunnel-watch.sh && chmod 0755 /usr/libexec/vp-edge-light/service-tunnel-watch.sh' \
  <"$HERE/files/usr/libexec/vp-edge-light/service-tunnel-watch.sh"

echo "--- Tunnel $ADDR -> $ENDPOINT:$PORT einrichten"
# shellcheck disable=SC2029 # die Werte kommen bewusst von hier
ssh "$TARGET" "ADDR='$ADDR' PORT='$PORT' ENDPOINT='$ENDPOINT' SERVER_PUB='$SERVER_PUB' NET='$NET' sh -s" <<'REMOTE'
set -e
[ -s /etc/wireguard/vp-service.key ] || { echo "FEHLER: kein Schluessel - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }
command -v wg >/dev/null 2>&1 || { echo "FEHLER: wireguard-tools fehlt - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }

uci -q delete network.wg_service || true
uci set network.wg_service=interface
uci set network.wg_service.proto=wireguard
uci set network.wg_service.private_key="$(cat /etc/wireguard/vp-service.key)"
uci add_list network.wg_service.addresses="$ADDR/32"
uci -q delete network.wg_service_peer || true
uci set network.wg_service_peer=wireguard_wg_service
uci set network.wg_service_peer.description='VoltPilot Service-VPN'
uci set network.wg_service_peer.public_key="$SERVER_PUB"
uci set network.wg_service_peer.endpoint_host="$ENDPOINT"
uci set network.wg_service_peer.endpoint_port="$PORT"
uci set network.wg_service_peer.persistent_keepalive='25'
uci set network.wg_service_peer.route_allowed_ips='1'
for n in $(echo "$NET" | tr ',' ' '); do uci add_list network.wg_service_peer.allowed_ips="$n"; done
if [ -s /etc/wireguard/vp-service.psk ]; then
  uci set network.wg_service_peer.preshared_key="$(cat /etc/wireguard/vp-service.psk)"
fi

uci -q delete firewall.vp_service || true
uci set firewall.vp_service=zone
uci set firewall.vp_service.name='service'
uci add_list firewall.vp_service.network='wg_service'
uci set firewall.vp_service.input='REJECT'
uci set firewall.vp_service.output='ACCEPT'
uci set firewall.vp_service.forward='REJECT'
uci -q delete firewall.vp_service_ssh || true
uci set firewall.vp_service_ssh=rule
uci set firewall.vp_service_ssh.name='Allow-Service-SSH'
uci set firewall.vp_service_ssh.src='service'
uci set firewall.vp_service_ssh.proto='tcp'
uci set firewall.vp_service_ssh.dest_port='2222'
uci set firewall.vp_service_ssh.target='ACCEPT'
uci -q delete firewall.vp_service_ping || true
uci set firewall.vp_service_ping=rule
uci set firewall.vp_service_ping.name='Allow-Service-Ping'
uci set firewall.vp_service_ping.src='service'
uci set firewall.vp_service_ping.proto='icmp'
uci set firewall.vp_service_ping.icmp_type='echo-request'
uci set firewall.vp_service_ping.family='ipv4'
uci set firewall.vp_service_ping.target='ACCEPT'

uci -q delete dropbear.vp_service || true
uci set dropbear.vp_service=dropbear
uci set dropbear.vp_service.enable='1'
uci set dropbear.vp_service.Port='2222'
uci set dropbear.vp_service.Interface='wg_service'
uci set dropbear.vp_service.PasswordAuth='off'
uci set dropbear.vp_service.RootPasswordAuth='off'

uci commit network
uci commit firewall
uci commit dropbear

# Waechter: ersetzt nur die eigenen Zeilen in der crontab
touch /etc/crontabs/root
grep -v 'vp-service-tunnel' /etc/crontabs/root > /tmp/crontab.vp || true
if [ -x /usr/bin/wireguard_watchdog ]; then
  echo '* * * * * /usr/bin/wireguard_watchdog # vp-service-tunnel' >> /tmp/crontab.vp
fi
echo '*/5 * * * * /usr/libexec/vp-edge-light/service-tunnel-watch.sh # vp-service-tunnel' >> /tmp/crontab.vp
cat /tmp/crontab.vp > /etc/crontabs/root && rm -f /tmp/crontab.vp
/etc/init.d/cron enable
/etc/init.d/cron restart

/etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/dropbear reload
echo "eingerichtet: wg_service $ADDR, Firewall-Zone service (SSH 2222, Ping), Dropbear 2222 nur Schluessel, Waechter"
# netifd liest Protokoll-Skripte nur beim Start ein: direkt nach der
# Installation von wireguard-tools reicht ein reload nicht (am Mango gefunden).
if ubus call network get_proto_handlers 2>/dev/null | grep -q '"wireguard"'; then
  /etc/init.d/network reload
else
  echo "netifd kennt wireguard noch nicht - Netzwerk-Neustart in 2 s (WLAN/LAN kurz weg)"
  (sleep 2; /etc/init.d/network restart) >/dev/null 2>&1 </dev/null &
fi
REMOTE

echo "--- fertig. Pruefen: ssh $TARGET wg show wg_service"
echo "    Zugang ueber den Tunnel: ssh -p 2222 root@$ADDR"
echo "    Web-App ueber den Tunnel: ssh -p 2222 -L 8484:127.0.0.1:8484 root@$ADDR  -> http://127.0.0.1:8484"
