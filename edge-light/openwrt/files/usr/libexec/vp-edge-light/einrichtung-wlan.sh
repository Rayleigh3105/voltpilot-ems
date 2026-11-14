#!/bin/sh
# Einrichtungs-WLAN der Box: jede Box oeffnet dasselbe offene WLAN
# "VoltPilot-Einrichtung", aber nur, solange sie keine Verbindung hat
# (Entscheid E6=B vom 13.11.2026, Konzept vp-edge-light-wlan, Abschnitt 6.1;
# edge-light/docs/mango.md "Ohne Kabel zum Router"). Darueber erreicht ein
# Handy NUR die Einrichtungsseite der Box (:8484); aendern laesst sich dort
# erst etwas nach Eingabe der Kennung, die unten auf der Box steht.
#
#   einrichtung-wlan.sh takt       der Waechter, aus cron jede Minute
#   einrichtung-wlan.sh status     Zustand (eine Zeile je Wert)
#   einrichtung-wlan.sh auf        Einrichtungs-WLAN jetzt oeffnen
#   einrichtung-wlan.sh zu         Einrichtungs-WLAN jetzt schliessen
#   einrichtung-wlan.sh nachlauf   ruft der Hotplug-Haken bei ifup vp_wlan:
#                                  raeumt den Notweg, sobald das WLAN wieder
#                                  eine Adresse hat
#
# Wann das WLAN offen ist (takt):
#   - Beim ersten Start ohne Kabel sofort: seit dem Start gab es weder eine
#     Verbindung noch ein Kabel an WAN, und kein Kunden-WLAN ist eingerichtet.
#   - Nach einem Ausfall nach 10 Minuten (AUSFALL). Client und Access Point
#     teilen sich das eine Funkmodul der Mango, und waehrend der Client sucht,
#     ist jeder Access Point darauf aus (hostapd, OpenWrt 25.12); deshalb
#     wechselt der Waechter in festen Fenstern: FENSTER lang Einrichtungs-WLAN
#     (der Client ist dann aus), dann VERSUCH lang ein Versuch mit dem
#     Kunden-WLAN. Die Fenster sind fest und verlaengern sich nicht, auch wenn
#     ein Handy verbunden ist: sonst koennte ein Fremder die Box mit einer
#     dauerhaften Verbindung offline halten.
#   - RUHE nach der Rueckkehr der Verbindung schliesst es wieder; die kurze
#     Frist laesst die Einrichtungsseite ihr Ergebnis noch anzeigen.
#
# Eigenes Netz in eigener Zone (vp_einricht, Zone "einrichtung"): nur DHCP,
# DNS und die Seite der Box (8484, dazu Port 80 auf 8484 umgelenkt, damit die
# Anmelde-Erkennung des Handys die Seite oeffnet); keine Weiterleitung, weder
# ins Heimnetz noch zu den Geraeten, kein SSH, kein LuCI. DHCP kommt vom
# dnsmasq der Box (eigener Abschnitt dhcp.vp_einricht; ein zweiter dnsmasq
# bekaeme Port 67 nicht, im Emulator gesehen). DNS faengt ein eigener kleiner
# dnsmasq auf Port 5353: Die Firewall lenkt JEDE DNS-Frage aus der Zone
# dorthin, und er zeigt jeden Namen auf die Box - so oeffnet die
# Anmelde-Erkennung des Handys die Seite, ohne dass die Namensaufloesung der
# Box oder des Kabel-Netzes etwas davon merkt.
#
# Der Notweg: Faellt das Kunden-WLAN aus, behaelt vp_wlan seine Adresse
# (force_link, wlan-anschluss.sh), und die Box liest die Geraete an ihrem
# Kabel weiter. Im Einrichtungs-Fenster ist der Client aber AUS, seine
# Schnittstelle samt Adresse weg - dann legt der Waechter die letzte
# WLAN-Adresse auf br-lan (die Geraete haengen dort physisch), bis das WLAN
# wieder eine Adresse hat (nachlauf raeumt auf).
#
# Alle Fristen laufen in der Laufzeit der Box (/proc/uptime), der Zustand
# liegt in /tmp: ein Neustart beginnt sauber. Gemeldet wird nur, was sich
# aendert (logger), nie jeder Lauf; cron startet mit cronloglevel 9 still.
set -u

BEFEHL="${1:-}"
RADIO="${VP_WLAN_RADIO:-radio0}"
SSID="VoltPilot-Einrichtung"
NETZ="${VP_EINRICHT_NETZ:-10.213.1}"        # /24; .1 ist die Box
ADR="$NETZ.1"
AUSFALL="${VP_EINRICHT_AUSFALL:-600}"       # s ohne Verbindung bis zum ersten Fenster
FENSTER="${VP_EINRICHT_FENSTER:-600}"       # s Einrichtungs-WLAN je Fenster
VERSUCH="${VP_EINRICHT_VERSUCH:-120}"       # s Versuch mit dem Kunden-WLAN
RUHE="${VP_EINRICHT_RUHE:-180}"             # s Verbindung, dann schliesst das WLAN
SPERRE="${VP_WLAN_SPERRE:-/var/lock/vp-wlan-anschluss}"  # dieselbe wie wlan-anschluss.sh
ZUSTAND="${VP_EINRICHT_ZUSTAND:-/tmp/vp-einricht}"
DNSMASQ_PID="$ZUSTAND/dnsmasq.pid"
FAENGER=5353                                # Port des DNS-Faengers
ZONE=einrichtung

melde() { logger -t vp-einrichtung-wlan "$*"; }
laufzeit() { cut -d. -f1 /proc/uptime; }
merke() { echo "${2:-1}" >"$ZUSTAND/$1"; }
gemerkt() { cat "$ZUSTAND/$1" 2>/dev/null; }
vergiss() { rm -f "$ZUSTAND/$1"; }

oben() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@.up' 2>/dev/null | grep -qx true; }
adresse_von() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null; }
maske_von() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].mask' 2>/dev/null; }
router_von() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@.route[@.target="0.0.0.0"].nexthop' 2>/dev/null | head -n 1; }
ist_an() { case "$1" in 1 | yes | on | true | enabled) return 0 ;; esac; return 1; }
funkmodul_aus() { ist_an "$(uci -q get "wireless.$RADIO.disabled")"; }
wlans_auf_funkmodul() {
  uci -q -X show wireless | sed -n "s/^wireless\.\([^.=]*\)\.device='$RADIO'\$/\1/p"
}
schnittstelle_von() { # Name der Funk-Schnittstelle eines wireless-Abschnitts
  ubus call network.wireless status 2>/dev/null |
    jsonfilter -e "@.$RADIO.interfaces[@.section='$1'].ifname" 2>/dev/null
}
wpa_zustand() {
  phy="$(cat "/sys/class/net/$1/phy80211/name" 2>/dev/null)"
  [ -n "$phy" ] || return 0
  ubus call wpa_supplicant phy_status "{\"phy\":\"$phy\"}" 2>/dev/null | jsonfilter -e '@.state' 2>/dev/null
}

# verbindung: hat die Box eine Verbindung? Kabel an WAN mit Adresse, oder das
# Kunden-WLAN angemeldet (COMPLETED) mit Adresse. Nur die Anmeldung zaehlt:
# mit force_link behaelt vp_wlan seine Adresse auch, wenn der Router weg ist.
verbindung() {
  oben wan && return 0
  ifn="$(schnittstelle_von vp_wlan)"
  [ -n "$ifn" ] || return 1
  [ "$(wpa_zustand "$ifn")" = COMPLETED ] || return 1
  [ -n "$(adresse_von vp_wlan)" ]
}
wan_traeger() { # haengt an WAN ein Kabel mit Gegenstelle? (carrier des Geraets)
  for g in $(uci -q get network.wan.device) $(uci -q get network.wan.ifname); do
    [ "$(cat "/sys/class/net/$g/carrier" 2>/dev/null)" = 1 ] && return 0
  done
  return 1
}

offen() { [ -n "$(uci -q get wireless.vp_einricht)" ] && ! ist_an "$(uci -q get wireless.vp_einricht.disabled)"; }

anwenden() {
  /etc/init.d/network reload >/dev/null 2>&1
  /etc/init.d/dnsmasq restart >/dev/null 2>&1
  /etc/init.d/firewall reload >/dev/null 2>&1
}

regel() { # regel <name> <proto> <ports> <dest_ip oder -> <titel>
  uci -q delete "firewall.$1"
  uci set "firewall.$1=rule"
  uci set "firewall.$1.name=$5"
  uci set "firewall.$1.src=$ZONE"
  uci set "firewall.$1.proto=$2"
  uci set "firewall.$1.dest_port=$3"
  [ "$4" = - ] || uci set "firewall.$1.dest_ip=$4"
  uci set "firewall.$1.target=ACCEPT"
}

# ---- Einrichtungs-WLAN auf und zu ------------------------------------------

dns_starten() {
  ifn="$(schnittstelle_von vp_einricht)"
  [ -n "$ifn" ] || return 1
  alte="$(cat "$DNSMASQ_PID" 2>/dev/null)"
  if [ -n "$alte" ] && kill -0 "$alte" 2>/dev/null; then
    [ "$(gemerkt dnsmasq_ifn)" = "$ifn" ] && return 0
    kill "$alte" 2>/dev/null
  fi
  # Der DNS-Faenger: nur diese Schnittstelle, Port 5353 (53 und 67 haelt der
  # dnsmasq der Box), jede Frage zeigt auf die Box. Kein Upstream (no-resolv):
  # nichts verlaesst das Netz.
  dnsmasq --conf-file=/dev/null --pid-file="$DNSMASQ_PID" \
    --interface="$ifn" --bind-dynamic --except-interface=lo --port="$FAENGER" \
    --no-resolv --no-hosts --address="/#/$ADR" 2>/dev/null || return 1
  merke dnsmasq_ifn "$ifn"
}
dns_stoppen() {
  alte="$(cat "$DNSMASQ_PID" 2>/dev/null)"
  [ -z "$alte" ] || kill "$alte" 2>/dev/null
  rm -f "$DNSMASQ_PID"
  vergiss dnsmasq_ifn
}

# pool_sicherstellen: der dnsmasq der Box laedt den Adressbereich der
# Einrichtung nur, wenn die Schnittstelle beim Start schon oben ist - der
# Neustart in anwenden kommt dafuer zu frueh (netifd baut den Access Point
# erst auf, im Emulator gesehen). Deshalb genau EIN weiterer Neustart, sobald
# die Schnittstelle steht; bis dahin versucht es jeder Takt erneut.
pool_sicherstellen() {
  [ -n "$(gemerkt pool)" ] && return 0
  oben vp_einricht || return 0
  /etc/init.d/dnsmasq restart >/dev/null 2>&1
  merke pool
}

befehl_auf() {
  offen && { pool_sicherstellen; dns_starten; return 0; }
  if funkmodul_aus; then
    for s in $(wlans_auf_funkmodul); do
      [ "$s" = vp_einricht ] && continue
      uci set "wireless.$s.disabled=1"
      # Einen dabei abgeschalteten Kunden-WLAN-Client spaeter wieder anschalten.
      [ "$s" = vp_wlan ] && merke client_aus
    done
    uci set "wireless.$RADIO.disabled=0"
  fi
  uci set "wireless.$RADIO.country=DE"
  uci -q delete wireless.vp_einricht
  uci set wireless.vp_einricht=wifi-iface
  uci set "wireless.vp_einricht.device=$RADIO"
  uci set wireless.vp_einricht.mode=ap
  uci set wireless.vp_einricht.network=vp_einricht
  uci set "wireless.vp_einricht.ssid=$SSID"
  uci set wireless.vp_einricht.encryption=none
  uci set wireless.vp_einricht.isolate=1
  uci -q delete network.vp_einricht
  uci set network.vp_einricht=interface
  uci set network.vp_einricht.proto=static
  uci set "network.vp_einricht.ipaddr=$ADR"
  uci set network.vp_einricht.netmask=255.255.255.0
  # DHCP ueber den dnsmasq der Box: ein eigener Adressbereich fuer die
  # Einrichtungs-Schnittstelle; er nennt sich selbst als Router und DNS.
  uci -q delete dhcp.vp_einricht
  uci set dhcp.vp_einricht=dhcp
  uci set dhcp.vp_einricht.interface=vp_einricht
  uci set dhcp.vp_einricht.start=100
  uci set dhcp.vp_einricht.limit=100
  uci set dhcp.vp_einricht.leasetime=10m
  uci -q delete firewall.vp_einricht
  uci set firewall.vp_einricht=zone
  uci set "firewall.vp_einricht.name=$ZONE"
  uci set firewall.vp_einricht.input=REJECT
  uci set firewall.vp_einricht.output=ACCEPT
  uci set firewall.vp_einricht.forward=REJECT
  uci add_list firewall.vp_einricht.network=vp_einricht
  # DHCP kommt als Broadcast an, deshalb ohne dest_ip; der DNS-Faenger und die
  # Seite nur an die Adresse der Box: http://10.213.0.1:8484 aus dem
  # Einrichtungs-WLAN bliebe sonst an der Schranke der Web-App vorbei
  # erreichbar.
  regel vp_einricht_dhcp udp 67 - "VoltPilot Einrichtung: DHCP"
  regel vp_einricht_dns tcpudp "$FAENGER" "$ADR" "VoltPilot Einrichtung: DNS-Faenger"
  seite="$(uci -q get vp-edge-light.main.web_addr | sed 's/^.*://')"
  regel vp_einricht_seite tcp "${seite:-8484}" "$ADR" "VoltPilot Einrichtung: Seite der Box"
  # JEDE DNS-Frage aus der Zone auf den Faenger, auch an fest eingestellte
  # fremde Namensserver des Handys.
  uci -q delete firewall.vp_einricht_dnsu
  uci set firewall.vp_einricht_dnsu=redirect
  uci set "firewall.vp_einricht_dnsu.name=VoltPilot Einrichtung: DNS auf den Faenger"
  uci set firewall.vp_einricht_dnsu.target=DNAT
  uci set "firewall.vp_einricht_dnsu.src=$ZONE"
  uci set firewall.vp_einricht_dnsu.proto=tcpudp
  uci set firewall.vp_einricht_dnsu.src_dport=53
  uci set "firewall.vp_einricht_dnsu.dest_ip=$ADR"
  uci set "firewall.vp_einricht_dnsu.dest_port=$FAENGER"
  # Anmelde-Erkennung: Das Handy fragt einen festen Namen ab, der eigene DNS
  # zeigt ihn auf die Box, und Port 80 AN DIE BOX landet auf der Seite. Nur an
  # die Box (src_dip): Port 80 zu anderen Adressen bleibt abgewiesen wie jede
  # Weiterleitung aus dieser Zone.
  uci -q delete firewall.vp_einricht_fang
  uci set firewall.vp_einricht_fang=redirect
  uci set "firewall.vp_einricht_fang.name=VoltPilot Einrichtung: 80 auf die Seite"
  uci set firewall.vp_einricht_fang.target=DNAT
  uci set "firewall.vp_einricht_fang.src=$ZONE"
  uci set firewall.vp_einricht_fang.proto=tcp
  uci set "firewall.vp_einricht_fang.src_dip=$ADR"
  uci set firewall.vp_einricht_fang.src_dport=80
  uci set "firewall.vp_einricht_fang.dest_ip=$ADR"
  uci set "firewall.vp_einricht_fang.dest_port=${seite:-8484}"
  uci commit
  anwenden
  n=0
  while [ "$n" -lt 20 ] && ! oben vp_einricht; do sleep 1; n=$((n + 1)); done
  pool_sicherstellen
  dns_starten
  melde "Einrichtungs-WLAN \"$SSID\" offen ($ADR, Zone $ZONE)"
}

befehl_zu() {
  entfernt=nein
  for s in wireless.vp_einricht network.vp_einricht dhcp.vp_einricht firewall.vp_einricht \
    firewall.vp_einricht_dhcp firewall.vp_einricht_dns firewall.vp_einricht_dnsu \
    firewall.vp_einricht_seite firewall.vp_einricht_fang; do
    [ -z "$(uci -q get "$s")" ] || entfernt=ja
    uci -q delete "$s"
  done
  dns_stoppen
  vergiss pool
  notweg_aus
  client_an
  [ "$entfernt" = ja ] || return 0
  uci commit
  anwenden
  melde "Einrichtungs-WLAN geschlossen"
}

# ---- Fenster: Client aus, Client an ----------------------------------------

client_aus() { # Kunden-WLAN-Client fuer ein Einrichtungs-Fenster abschalten
  [ -n "$(uci -q get wireless.vp_wlan)" ] || return 0
  ist_an "$(uci -q get wireless.vp_wlan.disabled)" && return 0
  uci set wireless.vp_wlan.disabled=1
  uci commit wireless
  merke client_aus
  /etc/init.d/network reload >/dev/null 2>&1
}
client_an() { # nur zuruecknehmen, was dieser Waechter abgeschaltet hat
  [ -n "$(gemerkt client_aus)" ] || return 0
  vergiss client_aus
  [ -n "$(uci -q get wireless.vp_wlan)" ] || return 0
  uci -q delete wireless.vp_wlan.disabled
  uci commit wireless
  /etc/init.d/network reload >/dev/null 2>&1
}

# ---- Notweg: letzte WLAN-Adresse auf br-lan --------------------------------

# Der Notweg traegt die Einrichtungs-Fenster: Dort ist der Client AUS, seine
# Schnittstelle samt WLAN-Adresse weg - die letzte Adresse auf br-lan laesst
# die Box die Geraete an ihrem Kabel weiterlesen (die /24-Route von ip addr
# add bringt den richtigen Absender mit; eine Route ohne src-Hinweis nimmt
# die ERSTE br-lan-Adresse 10.213.0.1, der kein Geraet antworten kann -
# gemessen, Lauf fenster).
#
# VOR den Fenstern (Client sucht noch) braucht es den Notweg im Normalfall
# nicht: Edge Light liest die Geraete alle paar Sekunden, relayd kennt sie
# deshalb und seine Wege tragen mit der Adresse, die force_link haelt, durch
# den Ausfall (Lauf routerausfall). Nur eine Box, die WAEHREND des Ausfalls
# neu startet (relayd kennt noch niemanden), liest erst ab dem ersten
# Fenster wieder: relayd prueft eigene Regeln vor der Haupttabelle, dagegen
# kommt keine Notweg-Route an, solange seine Schnittstellen stehen.
notweg_an() {
  [ -n "$(gemerkt notweg)" ] && return 0
  am="$(gemerkt letzte_adresse)"
  [ -n "$am" ] || return 0
  ip addr add "$am" dev br-lan 2>/dev/null || return 0
  merke notweg "$am"
  melde "Notweg: $am auf br-lan, die Box liest die Geraete im Einrichtungs-Fenster weiter"
}
notweg_aus() {
  am="$(gemerkt notweg)"
  [ -n "$am" ] || return 0
  ip addr del "$am" dev br-lan 2>/dev/null
  vergiss notweg
  melde "Notweg beendet ($am)"
}

befehl_nachlauf() { # Hotplug ifup/ifupdate vp_wlan: WLAN hat wieder eine Adresse
  [ -n "$(gemerkt notweg)" ] || exit 0
  [ -n "$(adresse_von vp_wlan)" ] || exit 0
  notweg_aus
}

# ---- Der Waechter -----------------------------------------------------------

# nudge: angemeldet mit Adresse, aber weder Router noch Internet antworten -
# nach einem Routertausch (gleicher Name, neues Netz) haelt udhcpc sonst die
# alte Adresse bis zur Verlaengerung. Zwei Fehlschlaege in Folge, hoechstens
# alle 10 Minuten: ifup vp_wlan holt eine frische Adresse.
nudge_pruefen() {
  gw="$(router_von vp_wlan)"
  if { [ -n "$gw" ] && ping -c 1 -W 2 "$gw" >/dev/null 2>&1; } ||
    ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
    vergiss gw_fehlt
    return 0
  fi
  f=$(($(gemerkt gw_fehlt || echo 0) + 1))
  merke gw_fehlt "$f"
  [ "$f" -ge 2 ] || return 0
  jetzt="$(laufzeit)"
  zuletzt="$(gemerkt nudge_zuletzt)"
  [ -z "$zuletzt" ] || [ $((jetzt - zuletzt)) -ge 600 ] || return 0
  merke nudge_zuletzt "$jetzt"
  vergiss gw_fehlt
  melde "angemeldet, aber Router und Internet antworten nicht: ifup vp_wlan holt eine frische Adresse (Routertausch?)"
  ifup vp_wlan >/dev/null 2>&1
}

befehl_takt() {
  jetzt="$(laufzeit)"
  merke takt "$jetzt"
  wan_traeger && merke hatte_traeger
  if [ "$(wpa_zustand "$(schnittstelle_von vp_wlan)")" = COMPLETED ]; then
    a="$(adresse_von vp_wlan)"
    m="$(maske_von vp_wlan)"
    [ -z "$a" ] || merke letzte_adresse "$a/${m:-24}"
  fi
  if verbindung; then
    merke hatte_verbindung
    vergiss ausfall_seit
    [ -n "$(gemerkt verbunden_seit)" ] || merke verbunden_seit "$jetzt"
    notweg_aus
    client_an
    if offen && [ $((jetzt - $(gemerkt verbunden_seit))) -ge "$RUHE" ]; then
      befehl_zu
    fi
    # Nur am WLAN: Kabel an WAN braucht keinen Anstoss.
    oben wan || nudge_pruefen
    return 0
  fi
  vergiss verbunden_seit
  vergiss gw_fehlt
  [ -n "$(gemerkt ausfall_seit)" ] || merke ausfall_seit "$jetzt"
  dauer=$((jetzt - $(gemerkt ausfall_seit)))
  if [ -z "$(gemerkt hatte_verbindung)" ] && [ -z "$(uci -q get wireless.vp_wlan)" ] &&
    [ -z "$(gemerkt hatte_traeger)" ]; then
    # Erster Start ohne Kabel: sofort, und ohne Fenster - es gibt kein
    # Kunden-WLAN, das die Box nebenher suchen koennte.
    befehl_auf
    return 0
  fi
  if [ "$dauer" -lt "$AUSFALL" ]; then
    # Der Client sucht selbst weiter; die relayd-Wege tragen das Lesen mit
    # der Adresse, die force_link haelt (siehe notweg_an).
    return 0
  fi
  if [ -z "$(uci -q get wireless.vp_wlan)" ]; then
    # Kabelweg ohne Ersatz-WLAN: nur oeffnen, nichts zu versuchen.
    befehl_auf
    return 0
  fi
  pos=$(((dauer - AUSFALL) % (FENSTER + VERSUCH)))
  if [ "$pos" -lt "$FENSTER" ]; then
    # Erst den Client abschalten (seine Schnittstelle nimmt die Adresse mit),
    # dann die letzte Adresse als Notweg auf br-lan.
    client_aus
    notweg_an
    befehl_auf
  else
    # Versuch mit dem Kunden-WLAN: der Client sucht, der Access Point ist
    # dabei von selbst still (ein Funkmodul); der Notweg bleibt, bis das WLAN
    # wieder eine Adresse hat (Hotplug: nachlauf).
    client_an
  fi
}

befehl_status() {
  if offen; then echo "einrichtung=offen"; else echo "einrichtung=zu"; fi
  echo "ssid=$SSID"
  echo "adresse=$ADR"
  if verbindung; then echo "verbindung=ja"; else echo "verbindung=nein"; fi
  echo "ausfall_seit=$(gemerkt ausfall_seit)"
  echo "verbunden_seit=$(gemerkt verbunden_seit)"
  echo "hatte_verbindung=$(gemerkt hatte_verbindung)"
  echo "client_aus=$(gemerkt client_aus)"
  echo "notweg=$(gemerkt notweg)"
  echo "letzte_adresse=$(gemerkt letzte_adresse)"
  d="$(cat "$DNSMASQ_PID" 2>/dev/null)"
  if [ -n "$d" ] && kill -0 "$d" 2>/dev/null; then echo "dns=an"; else echo "dns=aus"; fi
  t="$(gemerkt takt)"
  if [ -n "$t" ] && [ $(($(laufzeit) - t)) -gt 180 ]; then
    echo "takt=AUSGEBLIEBEN seit $(($(laufzeit) - t)) s"
  else
    echo "takt=${t:-nie}"
  fi
}

mkdir -p "$ZUSTAND"
case "$BEFEHL" in
  # Aendern darf immer nur ein Lauf - dieselbe Sperre wie wlan-anschluss.sh.
  # Haelt sie gerade ein verbinden/kabel, ist dieser Takt uebersprungen; der
  # naechste kommt in einer Minute.
  takt) (flock -n 9 || exit 0; befehl_takt) 9>"$SPERRE" ;;
  auf) (flock -n 9 || exit 75; befehl_auf) 9>"$SPERRE" ;;
  zu) (flock -n 9 || exit 75; befehl_zu) 9>"$SPERRE" ;;
  nachlauf) (flock -n 9 || exit 0; befehl_nachlauf) 9>"$SPERRE" ;;
  status) befehl_status ;;
  *)
    echo "takt | status | auf | zu | nachlauf" >&2
    exit 2
    ;;
esac
