#!/bin/sh
# shellcheck disable=SC2154 # interface, ip, mask, router setzt udhcpc
# DHCP-Skript fuer udhcpc in den Netz-Namensraeumen des Labors (Kabelgeraet):
# Adresse und Standardweg setzen, mehr nicht.
case "$1" in
  bound | renew)
    ip addr flush dev "$interface"
    ip addr add "$ip/${mask:-24}" dev "$interface"
    [ -z "${router:-}" ] || ip route replace default via "$router" dev "$interface"
    echo "udhcpc: $interface -> $ip"
    ;;
  deconfig) ip addr flush dev "$interface" ;;
esac
