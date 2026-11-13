#!/bin/sh
# Beobachter im Gast: alle <sekunden> (Vorgabe 2) eine Zeile mit Laufzeit, Client-Schnittstelle,
# Zustand von wpa_supplicant, WLAN-Adresse und lokaler Adresse am Relay - bis er beendet wird.
#   sh /tmp/labor/werkzeug/beob-wlan.sh [sekunden] > /tmp/beob.txt &
while true; do
  i="$(ubus call network.wireless status 2>/dev/null | jsonfilter -e "@.radio0.interfaces[@.section='vp_wlan'].ifname" 2>/dev/null)"
  p="$(cat "/sys/class/net/$i/phy80211/name" 2>/dev/null)"
  z="$(ubus call wpa_supplicant phy_status "{\"phy\":\"$p\"}" 2>/dev/null | jsonfilter -e '@.state' 2>/dev/null)"
  a="$(ifstatus vp_wlan 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null)"
  echo "$(cut -d. -f1 /proc/uptime) if=$i zustand=$z adresse=$a relay=$(uci -q get network.vp_relay.ipaddr) relayd=$(pidof relayd)"
  sleep "${1:-2}"
done
