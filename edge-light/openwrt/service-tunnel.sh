#!/bin/sh
# Wartungstunnel (WireGuard) auf einem OpenWrt-Geraet einrichten - dauerhaft
# und unabhaengig von vp-edge-light. Der private Schluessel entsteht auf dem
# Geraet und verlaesst es nie.
#
# Zwei Ziele (VP_SERVICE_ZIEL):
#   wartung (Vorgabe)  der Wartungsserver aus dem Portal (Fernwartung, E5):
#                      Schnittstelle wg_wartung, Schluessel vp-wartung.key,
#                      Endpunkt VP_SERVICE_ENDPOINT (wartung.voltpilot.de),
#                      Port 51820, Server-Schluessel VP_SERVICE_PUBKEY (Pflicht,
#                      steht im Portal), erlaubtes Netz VP_SERVICE_NET =
#                      Techniker-Netz (10.10.32.0/24)
#   alt                das bisherige Service-VPN vpn.voltpilot.de:1001
#                      (WireGuard UI, 10.10.1.0/24): Schnittstelle wg_service,
#                      Schluessel vp-service.key - nur noch fuer den Piloten bis
#                      zum beaufsichtigten Wechsel (edge-light/docs/mango.md)
# Beide koennen nebeneinander laufen; so wird gewechselt, ohne die Box zu
# verlieren: neuen Tunnel einrichten, ueber ihn anmelden, alten abbauen.
#
#   1. Pakete + Schluessel (der private Schluessel bleibt auf dem Geraet):
#        edge-light/openwrt/service-tunnel.sh root@192.168.1.1 key
#      -> gibt oeffentlichen Schluessel und Box-Referenz aus; beides im Portal
#         unter Geraete > Fernwartung > "Tunnel-Schluessel hinterlegen" eintragen.
#   2. Tunnel mit der dort zugeteilten Adresse einrichten (das Portal zeigt die
#      fertige Befehlszeile):
#        VP_SERVICE_PUBKEY='<server>' edge-light/openwrt/service-tunnel.sh root@192.168.1.1 10.10.16.5 [port]
#   3. Optional die Web-App :8484 im Tunnel fuer Techniker-Adressen oeffnen
#      (leer = wieder schliessen); aendert NUR diese eine Firewall-Regel:
#        edge-light/openwrt/service-tunnel.sh root@<box> web 10.10.32.2 [10.10.32.x ...]
#      Verlaesslich, weil WireGuard die Absenderadresse an das Geraet bindet.
#   4. Einen Tunnel vollstaendig abbauen (nach dem Wechsel den alten):
#        edge-light/openwrt/service-tunnel.sh root@<box> abbauen wg_service
#      Verweigert, solange die SSH-Sitzung ueber genau diesen Tunnel laeuft.
#   5. Zustand ansehen:
#        edge-light/openwrt/service-tunnel.sh root@<box> status
#   Nur Ziel alt: die in WireGuard UI heruntergeladene Client-Datei uebernehmen
#   (dann kennt der VPN-Server den privaten Schluessel - nur fuer Altbestand):
#        VP_SERVICE_ZIEL=alt edge-light/openwrt/service-tunnel.sh root@<box> import <datei.conf>
#
# Was eingerichtet wird (alles im Betriebssystem, kein Teil des Programms):
#   - Schnittstelle (wg_wartung bzw. wg_service), persistent_keepalive 25
#   - Firewall-Zone "service" (alle Tunnel-Schnittstellen): eingehend NUR SSH
#     auf Port 2222 und Ping; kein Weiterleiten ins Kundennetz. Die Web-App
#     :8484 hat keine Anmeldung und bleibt ausserhalb des Tunnels -
#     erreichbar per ssh -p 2222 -L 8484:127.0.0.1:8484 root@<tunnel-ip>,
#     oder fuer benannte Techniker-Adressen (Schritt 3)
#   - eine Dropbear-Instanz je Tunnel, nur dort, nur mit Schluessel (RSA - der
#     Dropbear des Mango kennt kein Ed25519); die SSH-Anmeldung im LAN bleibt
#   - Waechter (cron): wireguard_watchdog jede Minute, Neustart der
#     Schnittstelle ohne Handshake seit 10 min
#
# Erneut ausfuehrbar; der Schluessel bleibt erhalten.
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.1}"
WHAT="${2:?\"key\", \"web <ip ...>\", \"abbauen <schnittstelle>\", \"status\" oder die Tunnel-Adresse fehlt}"
ZIEL="${VP_SERVICE_ZIEL:-wartung}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"

case "$ZIEL" in
  wartung)
    IFACE=wg_wartung
    KEYFILE=/etc/wireguard/vp-wartung.key
    DROPBEAR=vp_wartung
    ENDPOINT="${VP_SERVICE_ENDPOINT:-wartung.voltpilot.de}"
    PORT="${3:-51820}"
    SERVER_PUB="${VP_SERVICE_PUBKEY:-}"
    NET="${VP_SERVICE_NET:-10.10.32.0/24}"
    ;;
  alt)
    IFACE=wg_service
    KEYFILE=/etc/wireguard/vp-service.key
    DROPBEAR=vp_service
    ENDPOINT="${VP_SERVICE_ENDPOINT:-vpn.voltpilot.de}"
    PORT="${3:-1001}"
    SERVER_PUB="${VP_SERVICE_PUBKEY:-LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=}"
    NET="${VP_SERVICE_NET:-10.10.1.0/24}"
    ;;
  *)
    echo "FEHLER: VP_SERVICE_ZIEL ist \"wartung\" oder \"alt\", nicht \"$ZIEL\"" >&2
    exit 1
    ;;
esac

if [ "$WHAT" = key ]; then
  echo "--- WireGuard installieren und Schluessel ($ZIEL) erzeugen auf $TARGET"
  # shellcheck disable=SC2029 # KEYFILE kommt bewusst von hier
  ssh "$TARGET" "KEYFILE='$KEYFILE' sh -s" <<'REMOTE'
set -e
command -v wg >/dev/null 2>&1 || { apk update >/dev/null && apk add kmod-wireguard wireguard-tools >/dev/null; }
mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
[ -s "$KEYFILE" ] || (umask 077; wg genkey > "$KEYFILE")
# Schluessel und Identitaet ueberleben ein sysupgrade
for p in /etc/wireguard/ /etc/vp-edge-light/; do grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf; done
echo "oeffentlicher Schluessel des Geraets:"
wg pubkey < "$KEYFILE"
if [ -s /etc/vp-edge-light/ref ]; then
  echo "Box-Referenz: $(cat /etc/vp-edge-light/ref)"
else
  echo "Box-Referenz: noch keine (vp-edge-light einmal starten, dann steht sie in /etc/vp-edge-light/ref)"
fi
REMOTE
  [ "$ZIEL" = wartung ] && echo "--- im Portal: Geraete > Fernwartung > Tunnel-Schluessel hinterlegen (Referenz + Schluessel)"
  exit 0
fi

if [ "$WHAT" = status ]; then
  ssh "$TARGET" 'wg show 2>/dev/null || echo "kein WireGuard aktiv"
    echo "--- Tunnel in der Zone service: $(uci -q get firewall.vp_service.network || echo keine)"
    echo "--- Dropbear: $(uci show dropbear 2>/dev/null | sed -n "s/^dropbear\.\([a-z_]*\)\.Interface=.\(.*\)./\1 -> \2/p" | tr "\n" " ")"'
  exit 0
fi

if [ "$WHAT" = web ]; then
  shift 2
  FROM="$*"
  for ip in $FROM; do
    case "$ip" in
      *.*.*.*) ;;
      *) echo "FEHLER: keine IPv4-Adresse: $ip" >&2; exit 1 ;;
    esac
  done
  if [ -n "$FROM" ]; then
    echo "--- Web-App :8484 im Tunnel oeffnen fuer: $FROM"
  else
    echo "--- Web-App :8484 im Tunnel wieder schliessen"
  fi
  # shellcheck disable=SC2029 # die Adressen kommen bewusst von hier
  ssh "$TARGET" "FROM='$FROM' sh -s" <<'REMOTE'
set -e
uci -q delete firewall.vp_service_web || true
if [ -n "$FROM" ]; then
  uci set firewall.vp_service_web=rule
  uci set firewall.vp_service_web.name='Allow-Service-Web-Techniker'
  uci set firewall.vp_service_web.src='service'
  uci set firewall.vp_service_web.proto='tcp'
  uci set firewall.vp_service_web.dest_port='8484'
  for ip in $FROM; do uci add_list firewall.vp_service_web.src_ip="$ip"; done
  uci set firewall.vp_service_web.target='ACCEPT'
fi
uci commit firewall
/etc/init.d/firewall reload >/dev/null 2>&1
nft list chain inet fw4 input_service | grep -E 'dport (2222|8484)' | sed 's/^[[:space:]]*/    /'
REMOTE
  exit 0
fi

if [ "$WHAT" = abbauen ]; then
  WEG="${3:?Schnittstelle fehlt: wg_service oder wg_wartung}"
  case "$WEG" in
    wg_service) WEG_KEYS='/etc/wireguard/vp-service.key /etc/wireguard/vp-service.psk'; WEG_DROPBEAR=vp_service ;;
    wg_wartung) WEG_KEYS='/etc/wireguard/vp-wartung.key'; WEG_DROPBEAR=vp_wartung ;;
    *) echo "FEHLER: abbauen kennt nur wg_service und wg_wartung" >&2; exit 1 ;;
  esac
  echo "--- Tunnel $WEG auf $TARGET abbauen"
  # shellcheck disable=SC2029 # die Werte kommen bewusst von hier
  ssh "$TARGET" "WEG='$WEG' WEG_KEYS='$WEG_KEYS' WEG_DROPBEAR='$WEG_DROPBEAR' sh -s" <<'REMOTE'
set -e
# Nicht den Ast absaegen, auf dem man sitzt: laeuft diese SSH-Sitzung ueber
# genau diesen Tunnel, waere die Box danach nur noch vor Ort erreichbar.
# shellcheck disable=SC2086 # SSH_CONNECTION bewusst in Woerter zerlegt
set -- ${SSH_CONNECTION:-}
HIER="${3:-}"
if [ -n "$HIER" ] && ip -4 addr show dev "$WEG" 2>/dev/null | grep -q "inet $HIER/"; then
  echo "FEHLER: diese Sitzung laeuft ueber $WEG ($HIER) - erst ueber den anderen Tunnel anmelden" >&2
  exit 1
fi
ifdown "$WEG" 2>/dev/null || true
uci -q delete "network.$WEG" || true
uci -q delete "network.${WEG}_peer" || true
uci -q del_list firewall.vp_service.network="$WEG" || true
if [ -z "$(uci -q get firewall.vp_service.network)" ]; then
  for s in vp_service vp_service_ssh vp_service_ping vp_service_web; do uci -q delete "firewall.$s" || true; done
fi
uci -q delete "dropbear.$WEG_DROPBEAR" || true
uci commit network
uci commit firewall
uci commit dropbear
# shellcheck disable=SC2086 # Liste von Dateien
rm -f $WEG_KEYS
touch /etc/crontabs/root
grep -v "vp-service-tunnel:$WEG\$" /etc/crontabs/root > /tmp/crontab.vp || true
# Waechter-Zeile aus der Zeit vor zwei Tunneln (ohne Schnittstelle) gehoert zu wg_service.
if [ "$WEG" = wg_service ]; then
  grep -v 'service-tunnel-watch.sh # vp-service-tunnel$' /tmp/crontab.vp > /tmp/crontab.vp2 || true
  mv /tmp/crontab.vp2 /tmp/crontab.vp
fi
if ! uci -q get network.wg_service >/dev/null && ! uci -q get network.wg_wartung >/dev/null; then
  grep -v 'wireguard_watchdog # vp-service-tunnel' /tmp/crontab.vp > /tmp/crontab.vp2 || true
  mv /tmp/crontab.vp2 /tmp/crontab.vp
fi
cat /tmp/crontab.vp > /etc/crontabs/root && rm -f /tmp/crontab.vp
/etc/init.d/cron restart
/etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/dropbear reload
/etc/init.d/network reload
echo "abgebaut: $WEG (Schnittstelle, Dropbear-Instanz, Zone-Eintrag, Schluessel, Waechter)"
REMOTE
  exit 0
fi

if [ "$WHAT" = import ]; then
  [ "$ZIEL" = alt ] || { echo "FEHLER: import nur mit VP_SERVICE_ZIEL=alt - fuer den Wartungsserver entsteht der Schluessel auf der Box" >&2; exit 1; }
  CONF="${3:?Client-Datei aus WireGuard UI fehlt}"
  # conf_val KEY - der Wert nach dem ERSTEN "=" (Base64-Schluessel enden auf "=")
  conf_val() { tr -d '\r' <"$CONF" | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | head -1 | sed 's/[[:space:]]*$//'; }
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
  printf '%s\n' "$PRIV" | ssh "$TARGET" 'umask 077; mkdir -p /etc/wireguard && cat > /etc/wireguard/vp-service.key'
  if [ -n "$PSK" ]; then
    printf '%s\n' "$PSK" | ssh "$TARGET" 'umask 077; cat > /etc/wireguard/vp-service.psk'
  else
    ssh "$TARGET" 'rm -f /etc/wireguard/vp-service.psk'
  fi
else
  case "$WHAT" in
    *.*.*.*) ADDR="$WHAT" ;;
    *) echo "FEHLER: keine IPv4-Adresse: $WHAT" >&2; exit 1 ;;
  esac
fi

case "$SERVER_PUB" in
  "")
    echo "FEHLER: Server-Schluessel fehlt - VP_SERVICE_PUBKEY='<Schluessel aus dem Portal, Geraete > Fernwartung>' setzen" >&2
    exit 1
    ;;
  *[!A-Za-z0-9+/=]*)
    echo "FEHLER: VP_SERVICE_PUBKEY ist kein WireGuard-Schluessel" >&2
    exit 1
    ;;
esac

echo "--- Waechter kopieren"
ssh "$TARGET" 'mkdir -p /usr/libexec/vp-edge-light && cat > /usr/libexec/vp-edge-light/service-tunnel-watch.sh && chmod 0755 /usr/libexec/vp-edge-light/service-tunnel-watch.sh' \
  <"$HERE/files/usr/libexec/vp-edge-light/service-tunnel-watch.sh"

echo "--- Tunnel $IFACE $ADDR -> $ENDPOINT:$PORT einrichten ($ZIEL)"
# shellcheck disable=SC2029 # die Werte kommen bewusst von hier
ssh "$TARGET" "IFACE='$IFACE' KEYFILE='$KEYFILE' DROPBEAR='$DROPBEAR' ADDR='$ADDR' PORT='$PORT' ENDPOINT='$ENDPOINT' SERVER_PUB='$SERVER_PUB' NET='$NET' sh -s" <<'REMOTE'
set -e
[ -s "$KEYFILE" ] || { echo "FEHLER: kein Schluessel $KEYFILE - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }
command -v wg >/dev/null 2>&1 || { echo "FEHLER: wireguard-tools fehlt - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }
PSKFILE="${KEYFILE%.key}.psk"

uci -q delete "network.$IFACE" || true
uci set "network.$IFACE=interface"
uci set "network.$IFACE.proto=wireguard"
uci set "network.$IFACE.private_key=$(cat "$KEYFILE")"
uci add_list "network.$IFACE.addresses=$ADDR/32"
uci -q delete "network.${IFACE}_peer" || true
uci set "network.${IFACE}_peer=wireguard_$IFACE"
uci set "network.${IFACE}_peer.description=VoltPilot Wartungstunnel"
uci set "network.${IFACE}_peer.public_key=$SERVER_PUB"
uci set "network.${IFACE}_peer.endpoint_host=$ENDPOINT"
uci set "network.${IFACE}_peer.endpoint_port=$PORT"
uci set "network.${IFACE}_peer.persistent_keepalive=25"
uci set "network.${IFACE}_peer.route_allowed_ips=1"
for n in $(echo "$NET" | tr ',' ' '); do uci add_list "network.${IFACE}_peer.allowed_ips=$n"; done
if [ -s "$PSKFILE" ]; then
  uci set "network.${IFACE}_peer.preshared_key=$(cat "$PSKFILE")"
fi

# Die Zone "service" umfasst alle Tunnel-Schnittstellen; ein zweiter Tunnel
# kommt dazu, statt den ersten zu verdraengen (Wechsel ohne Funkloch).
if ! uci -q get firewall.vp_service >/dev/null; then
  uci set firewall.vp_service=zone
  uci set firewall.vp_service.name='service'
  uci set firewall.vp_service.input='REJECT'
  uci set firewall.vp_service.output='ACCEPT'
  uci set firewall.vp_service.forward='REJECT'
fi
uci -q del_list firewall.vp_service.network="$IFACE" || true
uci add_list firewall.vp_service.network="$IFACE"
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

uci -q delete "dropbear.$DROPBEAR" || true
uci set "dropbear.$DROPBEAR=dropbear"
uci set "dropbear.$DROPBEAR.enable=1"
uci set "dropbear.$DROPBEAR.Port=2222"
uci set "dropbear.$DROPBEAR.Interface=$IFACE"
uci set "dropbear.$DROPBEAR.PasswordAuth=off"
uci set "dropbear.$DROPBEAR.RootPasswordAuth=off"

uci commit network
uci commit firewall
uci commit dropbear

# Waechter: ersetzt nur die eigenen Zeilen dieser Schnittstelle in der crontab
touch /etc/crontabs/root
grep -v -e "vp-service-tunnel:$IFACE\$" -e 'wireguard_watchdog # vp-service-tunnel' /etc/crontabs/root > /tmp/crontab.vp || true
if [ "$IFACE" = wg_service ]; then
  # Zeile aus der Zeit vor zwei Tunneln ersetzen
  grep -v 'service-tunnel-watch.sh # vp-service-tunnel$' /tmp/crontab.vp > /tmp/crontab.vp2 || true
  mv /tmp/crontab.vp2 /tmp/crontab.vp
fi
if [ -x /usr/bin/wireguard_watchdog ]; then
  echo '* * * * * /usr/bin/wireguard_watchdog # vp-service-tunnel:watchdog' >> /tmp/crontab.vp
fi
echo "*/5 * * * * /usr/libexec/vp-edge-light/service-tunnel-watch.sh $IFACE # vp-service-tunnel:$IFACE" >> /tmp/crontab.vp
cat /tmp/crontab.vp > /etc/crontabs/root && rm -f /tmp/crontab.vp
/etc/init.d/cron enable
/etc/init.d/cron restart

/etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/dropbear reload
echo "eingerichtet: $IFACE $ADDR, Firewall-Zone service (SSH 2222, Ping), Dropbear 2222 nur Schluessel, Waechter"
# netifd liest Protokoll-Skripte nur beim Start ein: direkt nach der
# Installation von wireguard-tools reicht ein reload nicht (am Mango gefunden).
if ubus call network get_proto_handlers 2>/dev/null | grep -q '"wireguard"'; then
  /etc/init.d/network reload
else
  echo "netifd kennt wireguard noch nicht - Netzwerk-Neustart in 2 s (WLAN/LAN kurz weg)"
  (sleep 2; /etc/init.d/network restart) >/dev/null 2>&1 </dev/null &
fi
REMOTE

echo "--- fertig. Pruefen: ssh $TARGET wg show $IFACE"
echo "    Zugang ueber den Tunnel: ssh -p 2222 root@$ADDR"
echo "    Web-App ueber den Tunnel: ssh -p 2222 -L 8484:127.0.0.1:8484 root@$ADDR  -> http://127.0.0.1:8484"
