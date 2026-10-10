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
#      Damit ist auch die Web-App :8484 im Tunnel frei, fuer das ganze
#      Techniker-Netz (siehe unten "Web-App im Tunnel").
#   3. Nur altes Service-VPN oder engere Wahl: die Web-App :8484 fuer einzelne
#      Adressen oeffnen (leer = wieder schliessen); aendert NUR diese eine
#      Firewall-Regel:
#        edge-light/openwrt/service-tunnel.sh root@<box> web 10.10.1.5 [10.10.1.x ...]
#   4. Einen Tunnel vollstaendig abbauen (nach dem Wechsel den alten):
#        edge-light/openwrt/service-tunnel.sh root@<box> abbauen wg_service
#      Verweigert, solange die SSH-Sitzung ueber genau diesen Tunnel laeuft.
#   5. Zustand ansehen:
#        edge-light/openwrt/service-tunnel.sh root@<box> status
#   Nur Ziel alt: die in WireGuard UI heruntergeladene Client-Datei uebernehmen
#   (dann kennt der VPN-Server den privaten Schluessel - nur fuer Altbestand):
#        VP_SERVICE_ZIEL=alt edge-light/openwrt/service-tunnel.sh root@<box> import <datei.conf>
#
# Anmeldung an der Box: das Skript ruft ssh auf. VP_SSH_KEY=<datei> nennt die
# Schluesseldatei (ssh -i); ohne die Variable entscheidet ~/.ssh/config.
#
# Was eingerichtet wird (alles im Betriebssystem, kein Teil des Programms):
#   - Schnittstelle (wg_wartung bzw. wg_service), persistent_keepalive 25
#   - Firewall-Zone "service" (alle Tunnel-Schnittstellen): eingehend NUR SSH
#     auf Port 2222, Ping und die Web-App :8484 wie unten; kein Weiterleiten
#     ins Kundennetz
#   - eine SSH-Instanz (Dropbear) je Tunnel auf Port 2222, nur mit Schluessel
#     (RSA - der Dropbear des Mango kennt kein Ed25519); die SSH-Anmeldung im
#     LAN bleibt. Am Wartungsserver ist es die Instanz der Fenster-Schluessel
#     (siehe unten), sonst eine UCI-Instanz, die an der ADRESSE des Tunnels
#     haengt (Option Interface) und auf allen Adressen lauscht, solange der
#     Tunnel unten ist. DirectInterface bindet an die Schnittstelle, verliert
#     die Bindung aber, sobald der Waechter die Schnittstelle neu startet -
#     danach ist SSH im Tunnel tot (am Mango unter 25.12.5 belegt, mango.md)
#   - SSH 2222 NUR aus den Tunneln: eine eigene Firewall-Kette weist den Port
#     auf jedem anderen Weg ab (LAN, WLAN, WAN), ob der Tunnel oben ist oder
#     unten (/etc/nftables.d/20-vp-wartung.nft). Port 22 im LAN bleibt.
#   - Waechter (cron): wireguard_watchdog jede Minute, Neustart der
#     Schnittstelle ohne Handshake seit 10 min
#
# Fenster-Schluessel (nur Wartungsserver, Vorgabe; docs/fernwartung.md):
#   Die Box holt im offenen Fenster den SSH-Schluessel ab, der im Portal am
#   Techniker-Zugang steht, haelt ihn nur im RAM und streicht ihn zum Ende des
#   Fensters. Eingerichtet werden dafuer
#     /usr/libexec/vp-wartung/schluessel-holen.sh   der Abholer
#     /etc/init.d/vp-wartung                        Dropbear im Tunnel mit
#                                                   eigener Schluesseldatei
#                                                   (dropbear -D) + Abholer
#     /etc/vp-wartung/keys                          tmpfs fuer die Schluesseldatei
#     /etc/config/vp-wartung                        Server, Port, Schnittstelle
#     cron: jede Minute Verfallenes streichen
#   Die UCI-Instanz dropbear.vp_wartung entfaellt. Was dauerhaft in
#   /etc/dropbear/authorized_keys steht, gilt im Tunnel weiter; die Datei wird
#   nur gelesen. Gefragt wird die Server-Adresse im Techniker-Netz (.1 von
#   VP_SERVICE_NET, sonst VP_SERVICE_SCHLUESSEL_SERVER) auf Port
#   VP_SERVICE_SCHLUESSEL_PORT (8022) - nur durch den Tunnel.
#   VP_SERVICE_SCHLUESSEL=aus richtet den Tunnel wie frueher ein (UCI-Instanz,
#   nur dauerhafte Schluessel) und raeumt den Abholer ab. Ein Dropbear ohne -D
#   (vor 2025.89, OpenWrt 24.10) bekommt von selbst die fruehere Instanz.
#
# Web-App im Tunnel (:8484, ohne eigene Anmeldung):
#   wartung  frei fuer das ganze Techniker-Netz (VP_SERVICE_NET), Regel
#            "Allow-Service-Web-Wartung". Die Schranke ist das Fenster am
#            Wartungsserver: er laesst einen Techniker nur im offenen Fenster
#            zu genau dieser Box durch. Die Box prueft selbst nur, dass das
#            Paket durch den Tunnel kam (WireGuard nimmt vom Server nur
#            Absender aus dem Techniker-Netz an) und an 2222, 8484 oder als
#            Ping. WER es ist und OB ein Fenster offen ist, prueft sie nicht.
#            VP_SERVICE_WEB=zu richtet den Tunnel ohne diese Regel ein; dann
#            bleibt Schritt 3 je Adresse oder ssh -L 8484:127.0.0.1:8484.
#   alt      nie fuer das Netz: im alten Service-VPN haengen auch
#            Kundensysteme. Nur je Adresse (Schritt 3) oder per ssh -L.
#
# Erneut ausfuehrbar; der Schluessel bleibt erhalten.
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.1}"
WHAT="${2:?\"key\", \"web <ip ...>\", \"abbauen <schnittstelle>\", \"status\" oder die Tunnel-Adresse fehlt}"
ZIEL="${VP_SERVICE_ZIEL:-wartung}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"

if [ -n "${VP_SSH_KEY:-}" ] && [ ! -r "$VP_SSH_KEY" ]; then
  echo "FEHLER: VP_SSH_KEY=$VP_SSH_KEY ist keine lesbare Schluesseldatei" >&2
  exit 1
fi
# box_ssh <ziel> <befehl> - ssh zur Box, mit VP_SSH_KEY als Schluesseldatei
box_ssh() {
  if [ -n "${VP_SSH_KEY:-}" ]; then
    ssh -i "$VP_SSH_KEY" "$@"
  else
    ssh "$@"
  fi
}

case "$ZIEL" in
  wartung)
    IFACE=wg_wartung
    KEYFILE=/etc/wireguard/vp-wartung.key
    DROPBEAR=vp_wartung
    ENDPOINT="${VP_SERVICE_ENDPOINT:-wartung.voltpilot.de}"
    PORT="${3:-51820}"
    SERVER_PUB="${VP_SERVICE_PUBKEY:-}"
    NET="${VP_SERVICE_NET:-10.10.32.0/24}"
    WEB="${VP_SERVICE_WEB:-netz}"
    SCHLUESSEL="${VP_SERVICE_SCHLUESSEL:-fenster}"
    ;;
  alt)
    IFACE=wg_service
    KEYFILE=/etc/wireguard/vp-service.key
    DROPBEAR=vp_service
    ENDPOINT="${VP_SERVICE_ENDPOINT:-vpn.voltpilot.de}"
    PORT="${3:-1001}"
    SERVER_PUB="${VP_SERVICE_PUBKEY:-LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=}"
    NET="${VP_SERVICE_NET:-10.10.1.0/24}"
    WEB="${VP_SERVICE_WEB:-zu}"
    SCHLUESSEL="${VP_SERVICE_SCHLUESSEL:-aus}"
    ;;
  *)
    echo "FEHLER: VP_SERVICE_ZIEL ist \"wartung\" oder \"alt\", nicht \"$ZIEL\"" >&2
    exit 1
    ;;
esac

# Web-App :8484 fuer das ganze Techniker-Netz - nur beim Wartungsserver.
case "$ZIEL:$WEB" in
  wartung:netz) WEB_NETZ="$NET" ;;
  *:zu) WEB_NETZ="" ;;
  alt:netz)
    echo "FEHLER: VP_SERVICE_WEB=netz gibt es nur fuer den Wartungsserver - im alten Service-VPN haengen Kundensysteme (dort: web <adresse>)" >&2
    exit 1
    ;;
  *)
    echo "FEHLER: VP_SERVICE_WEB ist \"netz\" oder \"zu\", nicht \"$WEB\"" >&2
    exit 1
    ;;
esac

# Fenster-Schluessel gibt nur der Wartungsserver aus.
case "$ZIEL:$SCHLUESSEL" in
  wartung:fenster | *:aus) ;;
  alt:fenster)
    echo "FEHLER: VP_SERVICE_SCHLUESSEL=fenster gibt es nur fuer den Wartungsserver - das alte Service-VPN gibt keine Schluessel aus" >&2
    exit 1
    ;;
  *)
    echo "FEHLER: VP_SERVICE_SCHLUESSEL ist \"fenster\" oder \"aus\", nicht \"$SCHLUESSEL\"" >&2
    exit 1
    ;;
esac
# Die Schluesselausgabe lauscht auf der Server-Adresse im Techniker-Netz.
S_PORT="${VP_SERVICE_SCHLUESSEL_PORT:-8022}"
S_NETZ="${NET%%,*}"
S_NETZ="${S_NETZ%%/*}"
S_SERVER="${VP_SERVICE_SCHLUESSEL_SERVER:-${S_NETZ%.*}.1}"
if [ "$SCHLUESSEL" = fenster ]; then
  case "$S_PORT" in "" | *[!0-9]*) echo "FEHLER: VP_SERVICE_SCHLUESSEL_PORT ist kein Port: $S_PORT" >&2; exit 1 ;; esac
  case "$S_SERVER" in
    *[!0-9.]* | "") echo "FEHLER: keine IPv4-Adresse fuer die Schluesselausgabe: $S_SERVER" >&2; exit 1 ;;
    *.*.*.*) ;;
    *) echo "FEHLER: keine IPv4-Adresse fuer die Schluesselausgabe: $S_SERVER" >&2; exit 1 ;;
  esac
fi

# Funktionen, die auf der Box laufen (vor "einrichten" und "abbauen" gestellt).
box_funktionen() {
  cat <<'BOX'
# vp_sperre: schreibt /etc/nftables.d/20-vp-wartung.nft (fw4 bindet die Datei
# ein, sysupgrade behaelt sie). Zwei eigene Ketten VOR denen von fw4:
#   - SSH 2222 kommt nur aus den Tunneln der Zone service an (und von der Box
#     selbst) - auf jedem anderen Weg abgewiesen, ob der Tunnel oben ist oder nicht
#   - die Anfrage nach Fenster-Schluesseln verlaesst die Box nur durch den Tunnel
# vp_kette_weg <kette>: eine eigene Kette auch aus dem geladenen Regelsatz
# nehmen - ein Neuladen von fw4 laesst sie sonst leer stehen.
vp_kette_weg() {
  nft flush chain inet fw4 "$1" 2>/dev/null || return 0
  nft delete chain inet fw4 "$1" 2>/dev/null || true
}
vp_sperre() {
  vps_datei=/etc/nftables.d/20-vp-wartung.nft
  vps_tunnel="$(uci -q get firewall.vp_service.network || true)"
  if [ -z "$vps_tunnel" ]; then
    rm -f "$vps_datei"
    vp_kette_weg vp_wartung_eingang
    vp_kette_weg vp_wartung_ausgang
    return 0
  fi
  vps_menge='"lo"'
  for vps_t in $vps_tunnel; do vps_menge="$vps_menge, \"$vps_t\""; done
  vps_server="$(uci -q get vp-wartung.schluessel.server || true)"
  vps_port="$(uci -q get vp-wartung.schluessel.port || true)"
  vps_if="$(uci -q get vp-wartung.schluessel.schnittstelle || true)"
  mkdir -p /etc/nftables.d
  {
    echo "# VoltPilot Wartungstunnel - geschrieben von service-tunnel.sh, nicht von Hand aendern."
    echo "chain vp_wartung_eingang {"
    echo "	type filter hook input priority -1; policy accept;"
    echo "	tcp dport 2222 iifname != { $vps_menge } counter reject with tcp reset comment \"vp-wartung: SSH 2222 nur im Tunnel\""
    echo "}"
    if [ -n "$vps_server" ] && [ -n "$vps_port" ] && [ -n "$vps_if" ]; then
      echo "chain vp_wartung_ausgang {"
      echo "	type filter hook output priority -1; policy accept;"
      echo "	ip daddr $vps_server tcp dport $vps_port oifname != \"$vps_if\" counter reject comment \"vp-wartung: Fenster-Schluessel nur durch den Tunnel\""
      echo "}"
    else
      vp_kette_weg vp_wartung_ausgang
    fi
  } > "$vps_datei.neu"
  # Erst pruefen, dann ablegen: eine Datei, die nft nicht liest, liesse fw4 beim
  # naechsten Laden scheitern - dann stuende die Box ohne Firewall da.
  if { echo "table inet vp_pruefung {"; cat "$vps_datei.neu"; echo "}"; } | nft -c -f - >/dev/null 2>&1; then
    mv -f "$vps_datei.neu" "$vps_datei"
  else
    rm -f "$vps_datei.neu" "$vps_datei"
    echo "FEHLER: die Regel fuer SSH 2222 laesst sich nicht laden - 2222 ist ausserhalb des Tunnels NICHT gesperrt" >&2
    return 1
  fi
}

# vp_uci_instanz <name> <schnittstelle>: die Dropbear-Instanz im Tunnel ueber
# UCI (ohne Fenster-Schluessel; liest /etc/dropbear/authorized_keys).
vp_uci_instanz() {
  uci -q delete "dropbear.$1" || true
  uci set "dropbear.$1=dropbear"
  uci set "dropbear.$1.enable=1"
  uci set "dropbear.$1.Port=2222"
  # Interface, nicht DirectInterface: Begruendung im Kopf von service-tunnel.sh.
  uci set "dropbear.$1.Interface=$2"
  uci set "dropbear.$1.PasswordAuth=off"
  uci set "dropbear.$1.RootPasswordAuth=off"
}

# vp_fenster_weg: Abholer, Startskript, RAM-Bereich und cron-Zeile der
# Fenster-Schluessel abraeumen. Nichts davon liegt danach noch auf der Box.
vp_fenster_weg() {
  if [ -x /etc/init.d/vp-wartung ]; then
    /etc/init.d/vp-wartung stop >/dev/null 2>&1 || true
    /etc/init.d/vp-wartung disable >/dev/null 2>&1 || true
  fi
  rm -f /etc/init.d/vp-wartung /etc/init.d/vp-wartung.neu /etc/rc.d/S60vp-wartung /etc/config/vp-wartung
  rm -rf /usr/libexec/vp-wartung /tmp/vp-wartung
  if grep -q ' /etc/vp-wartung/keys tmpfs ' /proc/mounts; then umount /etc/vp-wartung/keys || true; fi
  rm -rf /etc/vp-wartung || true
  if [ -f /etc/crontabs/root ] && grep -q 'vp-wartung-frist$' /etc/crontabs/root; then
    grep -v 'vp-wartung-frist$' /etc/crontabs/root > /tmp/crontab.vpw || true
    cat /tmp/crontab.vpw > /etc/crontabs/root
    rm -f /tmp/crontab.vpw
  fi
  if [ -f /etc/sysupgrade.conf ]; then
    grep -v -x -e '/usr/libexec/vp-wartung/' -e '/etc/init.d/vp-wartung' -e '/etc/rc.d/S60vp-wartung' /etc/sysupgrade.conf > /tmp/sysupgrade.vpw || true
    cat /tmp/sysupgrade.vpw > /etc/sysupgrade.conf
    rm -f /tmp/sysupgrade.vpw
  fi
}
BOX
}

if [ "$WHAT" = key ]; then
  echo "--- WireGuard installieren und Schluessel ($ZIEL) erzeugen auf $TARGET"
  # shellcheck disable=SC2029 # KEYFILE kommt bewusst von hier
  box_ssh "$TARGET" "KEYFILE='$KEYFILE' sh -s" <<'REMOTE'
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
  box_ssh "$TARGET" 'sh -s' <<'REMOTE'
wg show 2>/dev/null || echo "kein WireGuard aktiv"
echo "--- Tunnel in der Zone service: $(uci -q get firewall.vp_service.network || echo keine)"
UCI="$(uci show dropbear 2>/dev/null | sed -n "s/^dropbear\.\([a-z_]*\)\.Interface=.\(.*\)./\1 -> \2/p" | tr "\n" " ")"
echo "--- Dropbear: ${UCI:-keine UCI-Instanz im Tunnel}"
echo "--- Web-App 8484 im Tunnel: Techniker-Netz $(uci -q get firewall.vp_service_web_netz.src_ip || echo zu), einzelne Adressen $(uci -q get firewall.vp_service_web.src_ip || echo keine)"
LAUSCHT="$(netstat -ltn 2>/dev/null | awk '$4 ~ /:2222$/ { print $4 }' | tr '\n' ' ')"
echo "--- SSH 2222 lauscht auf: ${LAUSCHT:-nichts}"
if nft list chain inet fw4 vp_wartung_eingang 2>/dev/null | grep -q 'dport 2222'; then
  echo "--- SSH 2222 ausserhalb der Tunnel: abgewiesen ($(nft list chain inet fw4 vp_wartung_eingang | sed -n 's/.*iifname != \(.*\) counter packets \([0-9]*\).*/nur aus \1, bisher \2 Pakete abgewiesen/p'))"
else
  echo "--- SSH 2222 ausserhalb der Tunnel: NICHT gesperrt (service-tunnel.sh erneut ausfuehren)"
fi
if [ -x /usr/libexec/vp-wartung/schluessel-holen.sh ]; then
  echo "--- $(/usr/libexec/vp-wartung/schluessel-holen.sh status)"
else
  echo "--- Fenster-Schluessel: nicht eingerichtet - Anmeldung im Tunnel nur mit Schluesseln aus /etc/dropbear/authorized_keys"
fi
REMOTE
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
    echo "--- Web-App :8484 im Tunnel oeffnen fuer einzelne Adressen: $FROM"
  else
    echo "--- Web-App :8484 im Tunnel: Freigabe fuer einzelne Adressen schliessen"
  fi
  # shellcheck disable=SC2029 # die Adressen kommen bewusst von hier
  box_ssh "$TARGET" "FROM='$FROM' sh -s" <<'REMOTE'
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
if uci -q get firewall.vp_service_web_netz >/dev/null; then
  echo "    (die Freigabe fuer das Techniker-Netz gehoert zum Tunnel wg_wartung und bleibt)"
fi
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
  {
    box_funktionen
    cat <<'REMOTE'
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
# Die Freigabe der Web-App fuer das Techniker-Netz gehoert zum Wartungsserver.
if [ "$WEG" = wg_wartung ]; then uci -q delete firewall.vp_service_web_netz || true; fi
if [ -z "$(uci -q get firewall.vp_service.network)" ]; then
  for s in vp_service vp_service_ssh vp_service_ping vp_service_web vp_service_web_netz; do uci -q delete "firewall.$s" || true; done
fi
uci -q delete "dropbear.$WEG_DROPBEAR" || true
uci commit network
uci commit firewall
uci commit dropbear
# Die Fenster-Schluessel gehoeren zum Wartungsserver: Abholer, Startskript,
# RAM-Bereich und cron-Zeile gehen mit ihm.
if [ "$WEG" = wg_wartung ]; then vp_fenster_weg; fi
# SSH 2222 bleibt nur aus den verbliebenen Tunneln erreichbar.
vp_sperre || true
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
echo "abgebaut: $WEG (Schnittstelle, SSH-Instanz, Zone-Eintrag, Schluessel, Waechter$([ "$WEG" != wg_wartung ] || echo ", Fenster-Schluessel"))"
REMOTE
  } | box_ssh "$TARGET" "WEG='$WEG' WEG_KEYS='$WEG_KEYS' WEG_DROPBEAR='$WEG_DROPBEAR' sh -s"
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
  printf '%s\n' "$PRIV" | box_ssh "$TARGET" 'umask 077; mkdir -p /etc/wireguard && cat > /etc/wireguard/vp-service.key'
  if [ -n "$PSK" ]; then
    printf '%s\n' "$PSK" | box_ssh "$TARGET" 'umask 077; cat > /etc/wireguard/vp-service.psk'
  else
    box_ssh "$TARGET" 'rm -f /etc/wireguard/vp-service.psk'
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
box_ssh "$TARGET" 'mkdir -p /usr/libexec/vp-edge-light && cat > /usr/libexec/vp-edge-light/service-tunnel-watch.sh && chmod 0755 /usr/libexec/vp-edge-light/service-tunnel-watch.sh' \
  <"$HERE/files/usr/libexec/vp-edge-light/service-tunnel-watch.sh"

if [ "$SCHLUESSEL" = fenster ]; then
  echo "--- Abholer und Startskript der Fenster-Schluessel kopieren"
  # Unter anderem Namen ablegen: der laufende Abholer liest seine Datei weiter,
  # bis die Box sie unten an ihren Platz schiebt.
  for f in usr/libexec/vp-wartung/schluessel-holen.sh etc/init.d/vp-wartung; do
    # shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
    box_ssh "$TARGET" "mkdir -p /$(dirname "$f") && cat > /$f.neu && chmod 0755 /$f.neu" <"$HERE/files/$f"
  done
fi

echo "--- Tunnel $IFACE $ADDR -> $ENDPOINT:$PORT einrichten ($ZIEL)"
{
  box_funktionen
  cat <<'REMOTE'
set -e
[ -s "$KEYFILE" ] || { echo "FEHLER: kein Schluessel $KEYFILE - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }
command -v wg >/dev/null 2>&1 || { echo "FEHLER: wireguard-tools fehlt - erst: service-tunnel.sh <ziel> key" >&2; exit 1; }
PSKFILE="${KEYFILE%.key}.psk"

# Stand der Schnittstelle vor und nach der Aenderung - nur zum Vergleich auf
# der Box, damit ein erneuter Lauf mit denselben Werten den Tunnel nicht anfasst.
tunnel_stand() { uci -q show "network.$IFACE"; uci -q show "network.${IFACE}_peer"; }
STAND_ALT="$(tunnel_stand || true)"

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
# Web-App :8484 fuer das ganze Techniker-Netz: nur am Tunnel zum Wartungsserver.
# Die Regel haengt am Absender, nicht an der Schnittstelle - das genuegt, weil
# WireGuard einen Absender aus diesem Netz nur ueber wg_wartung annimmt. Ein
# zweiter Tunnel in der Zone (altes Service-VPN) bekommt damit nichts geoeffnet,
# und seine Einrichtung laesst die Regel stehen.
if [ "$IFACE" = wg_wartung ]; then
  uci -q delete firewall.vp_service_web_netz || true
  if [ -n "$WEB_NETZ" ]; then
    uci set firewall.vp_service_web_netz=rule
    uci set firewall.vp_service_web_netz.name='Allow-Service-Web-Wartung'
    uci set firewall.vp_service_web_netz.src='service'
    uci set firewall.vp_service_web_netz.proto='tcp'
    uci set firewall.vp_service_web_netz.dest_port='8484'
    for n in $(echo "$WEB_NETZ" | tr ',' ' '); do uci add_list firewall.vp_service_web_netz.src_ip="$n"; done
    uci set firewall.vp_service_web_netz.target='ACCEPT'
  fi
fi

# Anmeldung im Tunnel: Fenster-Schluessel (eigene Instanz mit dropbear -D)
# oder wie frueher die UCI-Instanz mit den dauerhaften Schluesseln.
FENSTER=aus
GRUND="mit VP_SERVICE_SCHLUESSEL=aus eingerichtet"
[ "$IFACE" = wg_wartung ] || GRUND="die gibt nur der Wartungsserver aus"
if [ "$SCHLUESSEL" = fenster ]; then
  if dropbear -h 2>&1 | grep -q '^-D'; then
    FENSTER=an
  else
    GRUND="dieser Dropbear kennt -D nicht (vor 2025.89)"
    echo "HINWEIS: $GRUND - Fenster-Schluessel werden NICHT eingerichtet, es bleibt bei der bisherigen Instanz"
  fi
fi
ALT_INSTANZ=nein
if uci -q get "dropbear.$DROPBEAR" >/dev/null; then ALT_INSTANZ=ja; fi
if [ "$FENSTER" = an ]; then
  mv -f /usr/libexec/vp-wartung/schluessel-holen.sh.neu /usr/libexec/vp-wartung/schluessel-holen.sh
  mv -f /etc/init.d/vp-wartung.neu /etc/init.d/vp-wartung
  touch /etc/config/vp-wartung
  uci set vp-wartung.schluessel=abholer
  uci set "vp-wartung.schluessel.server=$S_SERVER"
  uci set "vp-wartung.schluessel.port=$S_PORT"
  uci set "vp-wartung.schluessel.schnittstelle=$IFACE"
  uci commit vp-wartung
  uci -q delete "dropbear.$DROPBEAR" || true
else
  rm -f /usr/libexec/vp-wartung/schluessel-holen.sh.neu /etc/init.d/vp-wartung.neu
  # Nur der eigene Tunnel: das alte Service-VPN daneben einzurichten laesst die
  # Fenster-Schluessel des Wartungsservers stehen.
  if [ "$IFACE" = wg_wartung ]; then vp_fenster_weg; fi
  vp_uci_instanz "$DROPBEAR" "$IFACE"
fi

uci commit network
uci commit firewall
uci commit dropbear
STAND_NEU="$(tunnel_stand || true)"
MANGEL=0
vp_sperre || MANGEL=1

# Was ein sysupgrade behalten muss (Schluessel und Identitaet stehen seit "key" darin).
for p in /usr/libexec/vp-edge-light/service-tunnel-watch.sh; do grep -qxF "$p" /etc/sysupgrade.conf 2>/dev/null || echo "$p" >> /etc/sysupgrade.conf; done
if [ "$FENSTER" = an ]; then
  # Nicht /etc/vp-wartung/: dort liegt nur der RAM-Bereich mit den Fenster-Schluesseln.
  for p in /usr/libexec/vp-wartung/ /etc/init.d/vp-wartung /etc/rc.d/S60vp-wartung; do grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf; done
fi

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
if [ "$FENSTER" = an ] && ! grep -q 'vp-wartung-frist$' /etc/crontabs/root; then
  # Unabhaengig vom Abholer: streicht Verfallenes, auch wenn der haengt.
  echo '* * * * * /usr/libexec/vp-wartung/schluessel-holen.sh frist # vp-wartung-frist' >> /etc/crontabs/root
fi
/etc/init.d/cron enable
/etc/init.d/cron restart

/etc/init.d/firewall reload >/dev/null 2>&1
if [ -n "$WEB_NETZ" ]; then WEB_TEXT=", Web-App 8484 fuer $WEB_NETZ"; else WEB_TEXT=""; fi
echo "eingerichtet: $IFACE $ADDR, Firewall-Zone service (SSH 2222, Ping$WEB_TEXT), Dropbear 2222 nur Schluessel, Waechter"
# lauscht <adresse>: 0, wenn auf <adresse>:2222 jemand lauscht
lauscht() { netstat -ltn 2>/dev/null | awk -v a="$1:2222" '$4 == a { f = 1 } END { exit !f }'; }
# instanz_laeuft: 0, wenn procd die neue Anmelde-Instanz als laufend fuehrt
instanz_laeuft() { [ "$(ubus call service list '{"name":"vp-wartung"}' 2>/dev/null | jsonfilter -e '@["vp-wartung"].instances.ssh.running' 2>/dev/null)" = true ]; }
# Erst die Schnittstelle, dann Dropbear: die Instanz haengt an der Adresse des
# Tunnels. Ohne Adresse meldet Dropbear "has no suitable IP address(es)" und
# lauscht auf ALLEN Adressen, bis die Schnittstelle da ist.
# netifd liest Protokoll-Skripte nur beim Start ein: direkt nach der
# Installation von wireguard-tools reicht ein reload nicht (am Mango gefunden).
oben() { ubus call "network.interface.$IFACE" status 2>/dev/null | grep -q '"up": true'; }
if ubus call network get_proto_handlers 2>/dev/null | grep -q '"wireguard"'; then
  # Nur diese eine Schnittstelle, und nur wenn sich an ihr etwas geaendert hat:
  # ifup liest die Konfiguration neu ein und startet sie (die Gegenstelle liest
  # netifd sonst nicht neu). "/etc/init.d/network reload" setzt am Mango auch
  # den Switch zurueck - WAN und LAN sind dann einige Sekunden ohne Link, der
  # Tunnel startet ein zweites Mal, und Dropbear lauscht so lange auf allen
  # Adressen (gemessen am 09.10.2026, mango.md).
  if [ "$STAND_ALT" != "$STAND_NEU" ] || ! oben; then
    ifup "$IFACE"
    sleep 1
  else
    echo "Tunnel unveraendert - Schnittstelle bleibt oben"
  fi
  i=0
  until oben || [ "$i" -ge 20 ]; do
    i=$((i + 1))
    sleep 1
  done
  oben || echo "HINWEIS: $IFACE ist nach 20 s nicht oben (ifstatus $IFACE) - die Anmeldung im Tunnel lauscht, sobald die Schnittstelle da ist"
  /etc/init.d/dropbear reload
  if [ "$FENSTER" = an ]; then
    # Erst wenn die bisherige Instanz den Port freigegeben hat. Eine Sitzung,
    # die ueber sie laeuft, bleibt bestehen (nur der Lauscher endet).
    i=0
    while [ "$ALT_INSTANZ" = ja ] && lauscht "$ADDR" && [ "$i" -lt 5 ]; do i=$((i + 1)); sleep 1; done
    /etc/init.d/vp-wartung enable
    /etc/init.d/vp-wartung stop >/dev/null 2>&1 || true
    # Die Zeile "Wartungsserver: antwortet" unten soll eine Antwort von jetzt meinen.
    rm -f /tmp/vp-wartung/zuletzt /tmp/vp-wartung/grund
    /etc/init.d/vp-wartung start || true
    if oben; then
      # Zweimal im Abstand von 1 s: eine Instanz, die am belegten Port scheitert, zaehlt nicht.
      i=0; gut=0
      while [ "$gut" -lt 2 ] && [ "$i" -lt 12 ]; do
        sleep 1; i=$((i + 1))
        if instanz_laeuft && lauscht "$ADDR"; then gut=$((gut + 1)); else gut=0; fi
      done
      if [ "$gut" -lt 2 ]; then
        # Nicht aussperren: zurueck auf die Instanz, die bis eben ging.
        echo "FEHLER: die Anmeldung mit Fenster-Schluesseln lauscht nicht auf $ADDR:2222 (logread -e vp-wartung) - zurueck auf die bisherige Instanz, es gelten nur die dauerhaften Schluessel" >&2
        vp_fenster_weg
        vp_uci_instanz "$DROPBEAR" "$IFACE"
        uci commit dropbear
        vp_sperre || true
        /etc/init.d/cron restart
        /etc/init.d/firewall reload >/dev/null 2>&1
        /etc/init.d/dropbear reload
        exit 1
      fi
    fi
  fi
else
  # Hier geht es nicht anders herum: der Neustart beendet diese Sitzung. Dropbear
  # muss die neue Instanz vorher kennen, dann laedt es sich selbst neu, sobald
  # die Schnittstelle da ist (interface-Trigger von procd).
  echo "netifd kennt wireguard noch nicht - Netzwerk-Neustart in 2 s (WLAN/LAN kurz weg)"
  echo "die folgende Dropbear-Meldung \"no suitable IP address(es)\" ist dabei kein Fehler"
  /etc/init.d/dropbear reload
  if [ "$FENSTER" = an ]; then
    # Die Anmelde-Instanz startet von selbst, sobald die Schnittstelle da ist.
    /etc/init.d/vp-wartung enable
    /etc/init.d/vp-wartung stop >/dev/null 2>&1 || true
    # Die Zeile "Wartungsserver: antwortet" unten soll eine Antwort von jetzt meinen.
    rm -f /tmp/vp-wartung/zuletzt /tmp/vp-wartung/grund
    /etc/init.d/vp-wartung start || true
  fi
  (sleep 2; /etc/init.d/network restart) >/dev/null 2>&1 </dev/null &
fi

# Wer sich im Tunnel anmelden darf.
DAUERHAFT="$(grep -c -E '(^| )(ssh-|ecdsa-)' /etc/dropbear/authorized_keys 2>/dev/null || true)"
echo "Anmeldung im Tunnel: ssh -p 2222 root@$ADDR, nur mit RSA-Schluessel"
if [ "$FENSTER" = an ]; then
  echo "  im offenen Fenster: der SSH-Schluessel, der im Portal am Techniker-Zugang hinterlegt ist. Die Box holt ihn beim"
  echo "                      Wartungsserver ($S_SERVER:$S_PORT, nur durch den Tunnel), haelt ihn nur im RAM und streicht ihn"
  echo "                      zum Ende des Fensters. Vom Techniker-Geraet: ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@$ADDR"
  echo "  dauerhaft:          ${DAUERHAFT:-0} Schluessel aus /etc/dropbear/authorized_keys gelten im Tunnel weiter"
  i=0
  until [ -s /tmp/vp-wartung/zuletzt ] || [ "$i" -ge 8 ]; do i=$((i + 1)); sleep 1; done
  if [ -s /tmp/vp-wartung/zuletzt ]; then
    echo "  Wartungsserver:     antwortet - die Schluesselausgabe ist an"
  else
    echo "  Wartungsserver:     gibt noch KEINE Schluessel aus (Tunnel ohne Handshake oder Schluesselausgabe am Server aus)."
    echo "                      Bis dahin gelingt die Anmeldung nur mit einem dauerhaften Schluessel; die Box fragt weiter."
  fi
else
  echo "  nur mit einem Schluessel, der in /etc/dropbear/authorized_keys der Box steht (${DAUERHAFT:-0} Schluessel)"
  echo "  Fenster-Schluessel sind NICHT eingerichtet: $GRUND"
fi
[ "$MANGEL" -eq 0 ] || exit 1
REMOTE
} | box_ssh "$TARGET" "IFACE='$IFACE' KEYFILE='$KEYFILE' DROPBEAR='$DROPBEAR' ADDR='$ADDR' PORT='$PORT' ENDPOINT='$ENDPOINT' SERVER_PUB='$SERVER_PUB' NET='$NET' WEB_NETZ='$WEB_NETZ' SCHLUESSEL='$SCHLUESSEL' S_SERVER='$S_SERVER' S_PORT='$S_PORT' sh -s"

echo "--- fertig. Pruefen: ssh $TARGET wg show $IFACE"
echo "    Zugang ueber den Tunnel: ssh -p 2222 root@$ADDR  (wer sich anmelden darf: oben unter \"Anmeldung im Tunnel\")"
echo "    Stand der Box:           $(basename "$0") $TARGET status"
if [ -n "$WEB_NETZ" ]; then
  echo "    Web-App ueber den Tunnel: http://$ADDR:8484 (aus $WEB_NETZ, im offenen Fenster)"
else
  echo "    Web-App ueber den Tunnel: ssh -p 2222 -L 8484:127.0.0.1:8484 root@$ADDR  -> http://127.0.0.1:8484"
fi
