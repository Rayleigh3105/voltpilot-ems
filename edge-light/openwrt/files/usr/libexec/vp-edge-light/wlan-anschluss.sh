#!/bin/sh
# WLAN-Anschluss der Box: der Kunde waehlt beim Einrichten "Mit Netzwerkkabel"
# oder "Ueber WLAN" (Entscheide vom 13.11.2026, Konzept vp-edge-light-wlan,
# edge-light/docs/mango.md "Ohne Kabel zum Router"). Gehoert zum
# Betriebssystem, NICHT zu vp-edge-light: das Programm ruft das Skript hoechstens
# auf Knopfdruck auf und aendert selbst nie die Konfiguration
# (edge-light/docs/boot-und-updates.md).
#
#   wlan-anschluss.sh scan [--json]       Netze im 2,4-GHz-Band, staerkstes zuerst
#   wlan-anschluss.sh messen <ssid>       Signal dieses Netzes am Platz der Box
#   wlan-anschluss.sh verbinden <ssid>    Passwort als eine Zeile auf stdin
#   wlan-anschluss.sh kabel [--ohne-kabel]  zurueck zum Kabelweg
#   wlan-anschluss.sh status              Zustand
#   wlan-anschluss.sh nachziehen          lokale Adresse am Relay = WLAN-Adresse
#                                         (ruft der Hotplug-Haken bei ifup auf)
#
# Ausgabe: eine Zeile je Wert, "schluessel=wert" (scan: eine Zeile je Netz,
# mit --json die Liste von iwinfo). Rueckgabe:
#   0 erledigt            4 Netz nicht gefunden    7 kein Kabel an WAN
#   2 Aufruf falsch       5 Passwort passt nicht   8 Voraussetzung fehlt
#   3 Empfang reicht nicht (messen)  6 keine Adresse vom Router  9 anderer Fehler
#                         75 ein anderer Lauf haelt die Sperre
#
# Der WLAN-Weg (Betriebsart B, Entscheid E1=B):
#   - Die Box meldet sich als WLAN-Client beim Kundenrouter an (vp_wlan, DHCP,
#     metric 20: ein Kabel an WAN bleibt der Standardweg).
#   - relayd verbindet lan und vp_wlan zu einer Pseudo-Bruecke (vp_relay): die
#     Geraete an der LAN-Buchse holen ihre Adressen beim Kundenrouter und stehen
#     im Heimnetz. Der DHCP-Dienst der Box auf lan ist dafuer aus; 10.213.0.1
#     bleibt die Adresse der Box an der LAN-Buchse.
#   - Lokale Adresse am Relay (relayd -L) ist die WLAN-Adresse der Box. Nur mit
#     einer lokalen Adresse legt relayd auch fuer den Verkehr der Box SELBST
#     Wege zu den Geraeten an; ohne sie erreicht Edge Light die Wechselrichter
#     nicht (relayd route.c, lokale Tabelle; im Emulator gemessen). 10.213.0.1
#     ginge zu den Geraeten, aber relayd setzt die Adresse auch als Absender zu
#     jedem anderen gelernten Rechner, etwa dem Router (DNS) - der kennt
#     10.213.0.0/24 nicht. Bekommt die Box im WLAN eine neue Adresse, zieht
#     ein Hotplug-Haken sie nach (nachziehen).
#   - Das Funkmodul der Mango kann nur einen Kanal; nur 2,4 GHz.
#
# Schutz im Heimnetz (Konzept, Abschnitt 6.3):
#   - eigene Firewall-Zone "heimnetz" fuer vp_wlan, nicht die Zone lan der
#     ueblichen relayd-Anleitung (die oeffnet die Box samt Web-App ohne
#     Anmeldung) und nicht wan (die maskiert; mit NAT stuenden die Geraete nicht
#     mehr mit eigener Adresse im Heimnetz).
#   - Eingang zu wie bei wan; offen nur DHCP-Antworten, Ping und OCPP fuer die
#     Ladesaeule (Port wie firewall.vp_ocpp, Vorgabe 8887). SSH, LuCI, die
#     Web-App 8484 und der lokale Bus 1883 sind aus dem Heimnetz zu.
#   - Weiterleitung lan <-> heimnetz offen (das ist B), ausser zu den Leseports
#     der Box (TCP 502 Huawei-Dongle, 4196 Waveshare): sonst nimmt ein anderes
#     Geraet im Haus der Box den einen Leseplatz weg.
#
# Regeln:
#   - verbinden prueft das WLAN erst allein (Anmeldung, Adresse vom Router) und
#     stellt die LAN-Seite erst danach um. Scheitert etwas, kommt die vorige
#     Konfiguration zurueck: ein falsches Passwort laesst keinen Client zurueck,
#     der endlos sucht (und damit jeden Access Point auf dem Funkmodul
#     abschaltet, wpa_supplicant.uc in OpenWrt 25.12).
#   - Ein ausgeschaltetes Funkmodul (radio0.disabled=1: von Hand oder ab Werk
#     in aelteren OpenWrt) schaltet verbinden nur fuer den Client ein:
#     jedes andere WLAN darauf bekommt disabled=1, sonst startete etwa das
#     offene WLAN "OpenWrt" im lan mit. OpenWrt 25.12 legt das Funkmodul an
#     und dieses WLAN aus (default_radio0.disabled=1); das bleibt so.
#   - kabel verweigert, solange WAN keine Verbindung hat (--ohne-kabel
#     erzwingt es): ueber die Fernwartung soll sich niemand die Box abschiessen.
#   - Geraete an der LAN-Buchse holen ihre neue Adresse beim naechsten
#     DHCP-Lauf; sofort nur nach einem Neustart oder wenn ihr Kabel kurz
#     gezogen wird.
#   - Das Passwort erscheint nie in der Prozessliste und nie im Protokoll; es
#     steht wie jedes WLAN-Passwort von OpenWrt in /etc/config/wireless.
#   - Alle Abschnitte heissen vp_*: ein erneuter Lauf ersetzt sie, statt neue
#     anzulegen, und fremde Eintraege (etwa ein Access Point) bleiben.
set -u

BEFEHL="${1:-}"
RADIO="${VP_WLAN_RADIO:-radio0}"
SCHWELLE="${VP_WLAN_SCHWELLE:--70}"         # dBm, gemessen mit der Box (Konzept 4.2)
WARTE="${VP_WLAN_WARTE:-60}"                # Sekunden fuer Anmeldung und Adresse
MESSUNGEN="${VP_WLAN_MESSUNGEN:-3}"         # Scans je Messung, gewertet wird der mittlere
SPERRE="${VP_WLAN_SPERRE:-/var/lock/vp-wlan-anschluss}"
SICHERUNG="${VP_WLAN_SICHERUNG:-/tmp/vp-wlan-anschluss}"
HOTPLUG="${VP_WLAN_HOTPLUG:-/etc/hotplug.d/iface/90-vp-wlan-anschluss}"
SELBST="$(readlink -f "$0" 2>/dev/null || echo "$0")"
LESEPORTS="502 4196"
NETZ_DER_BOX="10.213.0."                    # die Werkstatt stellt lan auf 10.213.0.1/24
ZONE="heimnetz"
TAB="$(printf '\t')"

melde() { logger -t vp-wlan-anschluss "$*"; }
ganzzahl() { case "$1" in "" | *[!0-9-]*) return 1 ;; esac; }
ende() { # ende <rueckgabe> <ergebnis> <meldung>
  echo "ergebnis=$2"
  echo "meldung=$3"
  melde "$2: $3"
  exit "$1"
}

# mit_sperre <befehl ...>: aendern darf immer nur ein Lauf. Rueckgabe 75, wenn
# die Sperre nach 30 s nicht frei ist.
mit_sperre() {
  (
    n=0
    until flock -n 9; do
      n=$((n + 1))
      [ "$n" -le 30 ] || exit 75
      sleep 1
    done
    "$@"
  ) 9>"$SPERRE"
}

# ---- Scan ------------------------------------------------------------------

scan_json() { ubus call iwinfo scan "{\"device\":\"$RADIO\"}" 2>/dev/null; }

# verschluesselung <json> <index>: was das Netz anbietet, als UCI-Wert (none,
# psk, psk2, psk-mixed, sae, sae-mixed) oder "nicht_unterstuetzt" (Enterprise,
# WEP, OWE). Nur zur Anzeige verlaesslich, solange auf dem Funkmodul kein
# Client laeuft: dann meldet iwinfo jedes Netz mit psk und sae (im Emulator
# gemessen); verbinden stellt deshalb selbst WPA2/WPA3 ein (client_verschluesselung).
verschluesselung() {
  an="$(jsonfilter -s "$1" -e "@.results[$2].encryption.enabled" 2>/dev/null)"
  [ "$an" = "true" ] || { echo none; return; }
  wpa=" $(jsonfilter -s "$1" -e "@.results[$2].encryption.wpa[*]" 2>/dev/null | tr '\n' ' ')"
  auth=" $(jsonfilter -s "$1" -e "@.results[$2].encryption.authentication[*]" 2>/dev/null | tr '\n' ' ')"
  case "$auth" in
    *" 802.1x "* | *" owe "*) echo nicht_unterstuetzt; return ;;
  esac
  psk=nein
  sae=nein
  case "$auth" in *" psk "*) psk=ja ;; esac
  case "$auth" in *" sae "*) sae=ja ;; esac
  case "$psk$sae" in
    jaja) echo sae-mixed ;;
    neinja) echo sae ;;
    janein)
      w1=nein
      w2=nein
      case "$wpa" in *" 1 "*) w1=ja ;; esac
      case "$wpa" in *" 2 "*) w2=ja ;; esac
      case "$w1$w2" in
        jaja) echo psk-mixed ;;
        neinja) echo psk2 ;;
        janein) echo psk ;;
        *) echo nicht_unterstuetzt ;;
      esac
      ;;
    *) echo nicht_unterstuetzt ;; # WEP und Unbekanntes
  esac
}

# netze <json>: eine Zeile je Netz "<signal>TAB<kanal>TAB<verschluesselung>TAB<ssid>",
# staerkstes zuerst, je Name nur das staerkste; versteckte Netze fehlen.
netze() {
  i=0
  while ssid="$(jsonfilter -s "$1" -e "@.results[$i].ssid" 2>/dev/null)" ||
    [ -n "$(jsonfilter -s "$1" -e "@.results[$i].bssid" 2>/dev/null)" ]; do
    if [ -n "$ssid" ]; then
      sig="$(jsonfilter -s "$1" -e "@.results[$i].signal" 2>/dev/null)"
      kan="$(jsonfilter -s "$1" -e "@.results[$i].channel" 2>/dev/null)"
      ganzzahl "$sig" && printf '%s\t%s\t%s\t%s\n' "$sig" "${kan:-?}" "$(verschluesselung "$1" "$i")" "$ssid"
    fi
    i=$((i + 1))
  done | sort -t "$TAB" -k1,1nr | awk -F "$TAB" '!gesehen[$4]++'
}

befehl_scan() {
  json="$(scan_json)"
  [ -n "$json" ] || ende 8 kein_scan "Funkmodul $RADIO liefert keinen Scan (ubus iwinfo)"
  if [ "${1:-}" = "--json" ]; then
    printf '%s\n' "$json"
    return 0
  fi
  netze "$json" | while IFS="$TAB" read -r sig kan enc ssid; do
    printf 'signal=%s kanal=%s verschluesselung=%s ssid=%s\n' "$sig" "$kan" "$enc" "$ssid"
  done
}

# messung <ssid>: "<signal>TAB<kanal>TAB<verschluesselung>" - als Signal der
# mittlere Wert aus MESSUNGEN Scans; leer, wenn kein Scan das Netz sah.
messung() {
  werte=""
  rest=""
  n=0
  while [ "$n" -lt "$MESSUNGEN" ]; do
    [ "$n" -eq 0 ] || sleep 2
    z="$(netze "$(scan_json)" | awk -F "$TAB" -v s="$1" '$4 == s { print $1 "\t" $2 "\t" $3; exit }')"
    if [ -n "$z" ]; then
      werte="$werte${z%%"$TAB"*}
"
      rest="${z#*"$TAB"}"
    fi
    n=$((n + 1))
  done
  [ -n "$rest" ] || return 0
  mitte="$(printf '%s' "$werte" | sort -n | awk '{ w[NR] = $1 } END { print w[int((NR + 1) / 2)] }')"
  printf '%s\t%s\n' "$mitte" "$rest"
}

# client_verschluesselung <angebot>: was der Client der Box einstellt. Fuer
# jedes WPA2- oder WPA3-Netz "sae-mixed": wpa_supplicant nimmt dann WPA3, wo
# der Router es kann, sonst WPA2 - unabhaengig davon, was der Scan meldet.
# Nur reine WPA1-Router brauchen psk-mixed.
client_verschluesselung() {
  case "$1" in
    none | nicht_unterstuetzt) echo "$1" ;;
    psk) echo psk-mixed ;;
    *) echo sae-mixed ;;
  esac
}

urteil() { # urteil <signal>
  if [ "$1" -ge "$SCHWELLE" ]; then echo reicht; else echo reicht_nicht; fi
}

befehl_messen() {
  ssid="${1:-}"
  [ -n "$ssid" ] || { echo "messen <ssid>" >&2; exit 2; }
  m="$(messung "$ssid")"
  [ -n "$m" ] || ende 4 nicht_gefunden "Netz \"$ssid\" ist im 2,4-GHz-Band nicht zu sehen"
  sig="${m%%"$TAB"*}"
  rest="${m#*"$TAB"}"
  u="$(urteil "$sig")"
  echo "ssid=$ssid"
  echo "signal=$sig"
  echo "schwelle=$SCHWELLE"
  echo "urteil=$u"
  echo "kanal=${rest%%"$TAB"*}"
  echo "verschluesselung=${rest#*"$TAB"}"
  [ "$u" = reicht ] || exit 3
}

# ---- Zustand ---------------------------------------------------------------

wlan_schnittstelle() { # Name der Client-Schnittstelle (phy0-sta0), sonst leer
  ubus call network.wireless status 2>/dev/null |
    jsonfilter -e "@.$RADIO.interfaces[@.section='vp_wlan'].ifname" 2>/dev/null
}
adresse_von() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null; }
router_von() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@.route[@.target="0.0.0.0"].nexthop' 2>/dev/null | head -n 1; }
oben() { ifstatus "$1" 2>/dev/null | jsonfilter -e '@.up' 2>/dev/null | grep -qx true; }
ist_an() { case "$1" in 1 | yes | on | true | enabled) return 0 ;; esac; return 1; }
funkmodul_aus() { ist_an "$(uci -q get "wireless.$RADIO.disabled")"; }
# wlans_auf_funkmodul: Abschnitte aller WLANs auf RADIO (default_radio0,
# cfg033579, ...; -X: Namen ohne Klammern, die die Shell als Muster laese)
wlans_auf_funkmodul() {
  uci -q -X show wireless | sed -n "s/^wireless\.\([^.=]*\)\.device='$RADIO'\$/\1/p"
}

# wpa_zustand <schnittstelle>: COMPLETED, SCANNING, ... (wpa_supplicant ueber ubus)
wpa_zustand() {
  phy="$(cat "/sys/class/net/$1/phy80211/name" 2>/dev/null)"
  [ -n "$phy" ] || return 0
  ubus call wpa_supplicant phy_status "{\"phy\":\"$phy\"}" 2>/dev/null | jsonfilter -e '@.state' 2>/dev/null
}
signal_jetzt() { iwinfo "$1" info 2>/dev/null | sed -n 's/.*Signal: \(-[0-9]*\) dBm.*/\1/p' | head -n 1; }
kanal_jetzt() { iwinfo "$1" info 2>/dev/null | sed -n 's/.*Channel: \([0-9]*\).*/\1/p' | head -n 1; }

# passwort_abgelehnt <schnittstelle>: meldete wpa_supplicant seit dem
# Merkzeichen MARKE (dieser Lauf) einen falschen Schluessel? Gelesen wird nur
# das Ende des Protokollspeichers (zwei Leser des ganzen Speichers lassen logd
# neu starten, schluessel-holen.sh).
MARKE=""
passwort_abgelehnt() {
  logread -l 300 2>/dev/null | awk -v m="$MARKE" -v i="$1: " '
    index($0, m) { f = 1; next }
    f && index($0, i) && (index($0, "reason=WRONG_KEY") || index($0, "pre-shared key may be incorrect")) { ja = 1 }
    END { exit ja ? 0 : 1 }'
}

befehl_status() {
  ifn="$(wlan_schnittstelle)"
  if [ -n "$(uci -q get network.vp_relay)" ]; then
    modus=wlan
  elif oben wan; then
    modus=kabel
  else
    modus=keins
  fi
  echo "modus=$modus"
  if funkmodul_aus; then echo "funkmodul=aus"; else echo "funkmodul=an"; fi
  echo "wlan_ssid=$(uci -q get wireless.vp_wlan.ssid)"
  echo "wlan_schnittstelle=$ifn"
  if [ -n "$ifn" ]; then
    echo "wlan_zustand=$(wpa_zustand "$ifn")"
    echo "wlan_signal=$(signal_jetzt "$ifn")"
    echo "wlan_kanal=$(kanal_jetzt "$ifn")"
  else
    echo "wlan_zustand="
    echo "wlan_signal="
    echo "wlan_kanal="
  fi
  echo "wlan_adresse=$(adresse_von vp_wlan)"
  echo "router=$(router_von vp_wlan)"
  echo "schwelle=$SCHWELLE"
  if pidof relayd >/dev/null 2>&1; then echo "relay=an"; else echo "relay=aus"; fi
  echo "relay_adresse=$(uci -q get network.vp_relay.ipaddr)"
  if [ "$(uci -q get dhcp.lan.ignore)" = 1 ]; then echo "lan_dhcp=aus"; else echo "lan_dhcp=an"; fi
  if [ -n "$(uci -q get firewall.vp_heimnetz)" ]; then echo "zone_$ZONE=ja"; else echo "zone_$ZONE=nein"; fi
  if oben wan; then echo "kabel=ja"; else echo "kabel=nein"; fi
  echo "standardweg=$(ip -4 route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1)"
}

# ---- Konfiguration ---------------------------------------------------------

sichern() {
  rm -rf "$SICHERUNG"
  mkdir -p "$SICHERUNG"
  for d in wireless network firewall dhcp; do cp "/etc/config/$d" "$SICHERUNG/$d"; done
}
zurueck() { # die gesicherte Konfiguration wiederherstellen und anwenden
  for d in wireless network firewall dhcp; do
    [ -f "$SICHERUNG/$d" ] && cp "$SICHERUNG/$d" "/etc/config/$d"
  done
  anwenden
}
anwenden() {
  /etc/init.d/network reload >/dev/null 2>&1
  /etc/init.d/dnsmasq restart >/dev/null 2>&1
  /etc/init.d/firewall reload >/dev/null 2>&1
  /etc/init.d/relayd restart >/dev/null 2>&1
}

# Alles, was dieses Skript anlegt; fremde Eintraege bleiben.
abbauen() {
  for s in wireless.vp_wlan network.vp_wlan network.vp_relay \
    firewall.vp_heimnetz firewall.vp_heim_dhcp firewall.vp_heim_ping firewall.vp_heim_ocpp \
    firewall.vp_heim_lesen firewall.vp_lan_heim firewall.vp_heim_lan; do
    uci -q delete "$s"
  done
  uci -q delete dhcp.lan.ignore
  rm -f "$HOTPLUG"
}

# Schritt 1: nur der WLAN-Client und die Zone; die LAN-Seite bleibt, wie sie ist.
wlan_eintragen() { # wlan_eintragen <ssid> <verschluesselung> <passwort>
  if funkmodul_aus; then
    for s in $(wlans_auf_funkmodul); do
      [ "$s" = vp_wlan ] || uci set "wireless.$s.disabled=1"
    done
    uci set "wireless.$RADIO.disabled=0"
  fi
  uci set "wireless.$RADIO.country=DE"
  uci -q delete wireless.vp_wlan
  uci set wireless.vp_wlan=wifi-iface
  uci set "wireless.vp_wlan.device=$RADIO"
  uci set wireless.vp_wlan.mode=sta
  uci set wireless.vp_wlan.network=vp_wlan
  uci set "wireless.vp_wlan.ssid=$1"
  uci set "wireless.vp_wlan.encryption=$2"
  if [ "$2" = none ]; then uci -q delete wireless.vp_wlan.key; else uci set "wireless.vp_wlan.key=$3"; fi
  uci -q delete network.vp_wlan
  uci set network.vp_wlan=interface
  uci set network.vp_wlan.proto=dhcp
  uci set network.vp_wlan.metric=20
  # force_link: Faellt das Kunden-WLAN aus, nimmt netifd die Schnittstelle
  # sonst herunter (link connectivity loss), udhcpc gibt die Adresse frei -
  # und die relayd-Wege zu den Geraeten behalten genau diese Adresse als
  # Absender: die Box erreicht ihre eigenen Geraete nicht mehr (gemessen,
  # Lauf stoerfaelle, PR #1851). Mit force_link bleibt die Adresse stehen und
  # die Box liest waehrend des Ausfalls weiter. Der Preis: nach einem
  # Routertausch (gleicher Name, neues Netz) haelt udhcpc die alte Adresse
  # bis zur Verlaengerung - dafuer stoesst der Waechter des Einrichtungs-WLANs
  # (einrichtung-wlan.sh takt) eine frische an, wenn Router und Internet
  # trotz Anmeldung nicht antworten. Laeuft die Lease waehrend eines langen
  # Ausfalls ab, endet auch dieser Schutz (die Geraete verlieren ihre
  # Adressen dann ebenso).
  uci set network.vp_wlan.force_link=1
  uci -q delete firewall.vp_heimnetz
  uci set firewall.vp_heimnetz=zone
  uci set "firewall.vp_heimnetz.name=$ZONE"
  uci set firewall.vp_heimnetz.input=REJECT
  uci set firewall.vp_heimnetz.output=ACCEPT
  uci set firewall.vp_heimnetz.forward=REJECT
  uci add_list firewall.vp_heimnetz.network=vp_wlan
  regel vp_heim_dhcp "$ZONE" "" udp 68 ACCEPT "VoltPilot WLAN: DHCP-Antworten"
  uci set firewall.vp_heim_dhcp.family=ipv4
  regel vp_heim_ping "$ZONE" "" icmp "" ACCEPT "VoltPilot WLAN: Ping"
  uci set firewall.vp_heim_ping.icmp_type=echo-request
  uci set firewall.vp_heim_ping.family=ipv4
  ocpp="$(uci -q get firewall.vp_ocpp.dest_port)"
  regel vp_heim_ocpp "$ZONE" "" tcp "${ocpp:-8887}" ACCEPT "VoltPilot WLAN: OCPP (Ladesaeule im Heimnetz)"
  uci commit
}
regel() { # regel <name> <von> <nach> <proto> <ports> <ziel> <titel>
  uci -q delete "firewall.$1"
  uci set "firewall.$1=rule"
  uci set "firewall.$1.name=$7"
  uci set "firewall.$1.src=$2"
  [ -z "$3" ] || uci set "firewall.$1.dest=$3"
  uci set "firewall.$1.proto=$4"
  [ -z "$5" ] || uci set "firewall.$1.dest_port=$5"
  uci set "firewall.$1.target=$6"
}

# Hotplug-Haken: bekommt die Box im WLAN eine neue Adresse, zieht er die
# lokale Adresse am Relay nach. verbinden legt ihn an, kabel entfernt ihn.
hotplug_eintragen() {
  mkdir -p "$(dirname "$HOTPLUG")"
  cat >"$HOTPLUG" <<EOT
# vp-wlan-anschluss: von wlan-anschluss.sh verbinden angelegt, kabel entfernt ihn.
# Neue WLAN-Adresse der Box -> lokale Adresse am Relay (relayd -L) nachziehen.
[ "\$INTERFACE" = vp_wlan ] && { [ "\$ACTION" = ifup ] || [ "\$ACTION" = ifupdate ]; } && $SELBST nachziehen
EOT
}

befehl_nachziehen() {
  [ -n "$(uci -q get network.vp_relay)" ] || return 0
  adr="$(adresse_von vp_wlan)"
  [ -n "$adr" ] || return 0
  [ "$adr" != "$(uci -q get network.vp_relay.ipaddr)" ] || return 0
  uci set "network.vp_relay.ipaddr=$adr"
  uci commit network
  /etc/init.d/relayd restart >/dev/null 2>&1
  melde "neue WLAN-Adresse $adr: lokale Adresse am Relay nachgezogen"
}

# Schritt 2: LAN-Seite umstellen - Relay mit lokaler Adresse, DHCP der Box aus,
# Weiterleitung ins Heimnetz ohne die Leseports.
relay_eintragen() { # relay_eintragen <WLAN-Adresse der Box = lokale Adresse am Relay>
  uci -q delete network.vp_relay
  uci set network.vp_relay=interface
  uci set network.vp_relay.proto=relay
  uci add_list network.vp_relay.network=lan
  uci add_list network.vp_relay.network=vp_wlan
  uci set "network.vp_relay.ipaddr=$1"
  uci set dhcp.lan.ignore=1
  uci -q delete firewall.vp_lan_heim
  uci set firewall.vp_lan_heim=forwarding
  uci set firewall.vp_lan_heim.src=lan
  uci set "firewall.vp_lan_heim.dest=$ZONE"
  uci -q delete firewall.vp_heim_lan
  uci set firewall.vp_heim_lan=forwarding
  uci set "firewall.vp_heim_lan.src=$ZONE"
  uci set firewall.vp_heim_lan.dest=lan
  regel vp_heim_lesen "$ZONE" lan tcp "$LESEPORTS" REJECT "VoltPilot WLAN: Leseports der Box nicht aus dem Heimnetz"
  uci commit
  hotplug_eintragen
}

# warte_auf_wlan: 0 verbunden mit Adresse, 5 Passwort abgelehnt,
# 6 angemeldet ohne Adresse, 9 nicht angemeldet.
warte_auf_wlan() {
  n=0
  angemeldet=nein
  while [ "$n" -lt "$WARTE" ]; do
    ifn="$(wlan_schnittstelle)"
    if [ -n "$ifn" ]; then
      [ "$(wpa_zustand "$ifn")" != COMPLETED ] || angemeldet=ja
      [ "$angemeldet" = nein ] || [ -z "$(adresse_von vp_wlan)" ] || return 0
      passwort_abgelehnt "$ifn" && return 5
    fi
    sleep 1
    n=$((n + 1))
  done
  [ "$angemeldet" = ja ] && return 6
  return 9
}

befehl_verbinden() {
  ssid="${1:-}"
  [ -n "$ssid" ] || { echo "verbinden <ssid>   (Passwort als eine Zeile auf stdin)" >&2; exit 2; }
  pass=""
  [ -t 0 ] || IFS= read -r pass || true
  # relayd bringt die Werkstatt mit; fehlt es und hat die Box gerade Internet
  # (Einrichtung ueber die Fernwartung, Box noch am Kabel), holt verbinden es.
  command -v relayd >/dev/null 2>&1 || { apk update >/dev/null 2>&1 && apk add relayd >/dev/null 2>&1; } || true
  command -v relayd >/dev/null 2>&1 || ende 8 relayd_fehlt "Paket relayd fehlt und laesst sich ohne Internet nicht holen (apk add relayd)"
  [ -n "$(uci -q get "wireless.$RADIO")" ] || ende 8 kein_funkmodul "kein Funkmodul $RADIO in /etc/config/wireless"
  m="$(messung "$ssid")"
  [ -n "$m" ] || ende 4 nicht_gefunden "Netz \"$ssid\" ist im 2,4-GHz-Band nicht zu sehen"
  enc="$(client_verschluesselung "${m##*"$TAB"}")"
  case "$enc" in
    nicht_unterstuetzt) ende 8 verschluesselung "das Netz nutzt eine Anmeldung, die die Box nicht kann (Enterprise, WEP oder OWE)" ;;
    none) [ -z "$pass" ] || ende 2 passwort_unnoetig "das Netz ist offen; ohne Passwort aufrufen" ;;
    *)
      laenge=${#pass}
      [ "$laenge" -ge 8 ] && [ "$laenge" -le 64 ] || ende 5 passwort_falsch "ein WLAN-Passwort hat 8 bis 63 Zeichen (oder 64 Hex-Zeichen)"
      ;;
  esac
  MARKE="verbinden-$$-$(cut -d. -f1 /proc/uptime)"
  melde "$MARKE: \"$ssid\" ($enc), Signal ${m%%"$TAB"*} dBm"
  sichern
  wlan_eintragen "$ssid" "$enc" "$pass"
  pass=""
  anwenden
  warte_auf_wlan
  r=$?
  if [ "$r" -ne 0 ]; then
    zurueck
    case "$r" in
      5) ende 5 passwort_falsch "\"$ssid\" hat das Passwort abgelehnt; die vorige Einstellung gilt wieder" ;;
      6) ende 6 keine_adresse "bei \"$ssid\" angemeldet, aber keine Adresse vom Router; die vorige Einstellung gilt wieder" ;;
      *) ende 9 nicht_angemeldet "keine Anmeldung bei \"$ssid\" in $WARTE s; die vorige Einstellung gilt wieder" ;;
    esac
  fi
  adr="$(adresse_von vp_wlan)"
  case "$adr" in
    "$NETZ_DER_BOX"*)
      zurueck
      ende 9 netz_kollidiert "das Heimnetz nutzt dasselbe Netz wie die Box (${NETZ_DER_BOX}0/24); die vorige Einstellung gilt wieder"
      ;;
  esac
  relay_eintragen "$adr"
  anwenden
  ifn="$(wlan_schnittstelle)"
  sig="$(signal_jetzt "$ifn")"
  ganzzahl "$sig" || sig="${m%%"$TAB"*}"
  gw="$(router_von vp_wlan)"
  echo "ergebnis=verbunden"
  echo "ssid=$ssid"
  echo "signal=$sig"
  echo "schwelle=$SCHWELLE"
  echo "urteil=$(urteil "$sig")"
  echo "kanal=$(kanal_jetzt "$ifn")"
  echo "wlan_adresse=$adr"
  echo "router=$gw"
  echo "relay_adresse=$(uci -q get network.vp_relay.ipaddr)"
  if [ -n "$gw" ] && ping -c 1 -W 3 "$gw" >/dev/null 2>&1; then echo "router_erreichbar=ja"; else echo "router_erreichbar=nein"; fi
  if ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then echo "internet=ja"; else echo "internet=nein"; fi
  melde "verbunden mit \"$ssid\": $adr, Signal $sig dBm, Relay an"
}

befehl_kabel() {
  if [ "${1:-}" != "--ohne-kabel" ] && ! oben wan; then
    ende 7 kein_kabel "an WAN kommt keine Verbindung an; erst das Kabel stecken (oder --ohne-kabel)"
  fi
  sichern
  abbauen
  uci commit
  anwenden
  echo "ergebnis=kabel"
  if oben wan; then echo "kabel=ja"; else echo "kabel=nein"; fi
  melde "zurueck auf den Kabelweg: WLAN-Client, Relay und Zone $ZONE entfernt, DHCP der Box an"
}

case "$BEFEHL" in
  scan) befehl_scan "${2:-}" ;;
  messen) befehl_messen "${2:-}" ;;
  status) befehl_status ;;
  verbinden) mit_sperre befehl_verbinden "${2:-}" ;;
  kabel) mit_sperre befehl_kabel "${2:-}" ;;
  # Aus dem Hotplug-Haken: haelt ein anderer Lauf die Sperre, setzt der die
  # Adresse selbst - dann nicht warten.
  nachziehen) (flock -n 9 || exit 0; befehl_nachziehen) 9>"$SPERRE" ;;
  *)
    echo "scan [--json] | messen <ssid> | verbinden <ssid> (Passwort auf stdin) | kabel [--ohne-kabel] | status | nachziehen" >&2
    exit 2
    ;;
esac
