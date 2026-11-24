#!/bin/sh
# Zeitleiste fuer die Fehlersuche an den eigenen Wegen der Box (Lauf
# messung-wege): jede Sekunde eine Zeile mit Laufzeit, relayd (PIDs), der
# WLAN-Adresse, ob vp_wlan oben ist, und ob das Geraet in relayds Tabellen
# steht - Weiterleitung (Tabelle der WLAN-Schnittstelle) und eigener Weg der
# Box (lokale Tabelle).
#
#   sh /tmp/labor/werkzeug/zeitleiste.sh <adresse des geraets> > /tmp/zeit.txt &
#
# Nur eine Zeile, wenn sich etwas aendert:
#   awk '{k=$0; sub(/^[^ ]* /, "", k); if (k != v) print; v = k}' /tmp/zeit.txt
g="$1"
while :; do
  s="$(ubus call network.wireless status 2>/dev/null | jsonfilter -e '@.radio0.interfaces[@.section="vp_wlan"].ifname' 2>/dev/null)"
  a="$(ip -4 -o addr show dev "${s:-keins}" 2>/dev/null | awk '{print $4}')"
  u="$(ifstatus vp_wlan 2>/dev/null | jsonfilter -e '@.up' 2>/dev/null)"
  w="$(ip route show table 16801 2>/dev/null | grep -c "^$g ")"
  b="$(ip route show table 16800 2>/dev/null | grep -c "^$g ")"
  echo "$(cut -d' ' -f1 /proc/uptime) relayd=$(pidof relayd | tr ' ' ,) adresse=${a:-keine} oben=${u:-?} weiterleitung=$w weg_der_box=$b"
  sleep 1
done
