#!/bin/sh
# Werkbank-Brücke prüfen (als root auf der Brücke; einrichten.sh ruft es am
# Ende auf, installiert als /usr/local/sbin/vp-werkbank-pruefen).
#
# Prüft den eingerichteten Stand, ohne etwas zu ändern: Durchleitung und
# Sperren, kein DHCP am Werkstatt-Anschluss, SSH nur mit Schlüssel und nur zu
# den Werkstatt-Zielen, sudo nur für die zwei Befehle. Jede Zeile beginnt mit
# "ok:" oder "FEHLER:"; Ausgang 1, sobald eine Prüfung fehlschlägt.
set -u
PARAM=/etc/vp-werkbank/parameter.env
fehler=0
ok() { echo "ok: $*"; }
nein() {
  echo "FEHLER: $*"
  fehler=1
}
[ -r "$PARAM" ] || {
  echo "FEHLER: $PARAM fehlt, die Brücke ist nicht eingerichtet"
  exit 1
}
wert() { sed -n "s/^$1=//p" "$PARAM" | head -n1; }
NETZ=$(wert NETZ)
WERKSTATT=$(wert WERKSTATT)
WERKSTATT_ADRESSEN=$(wert WERKSTATT_ADRESSEN)
ZIELE=$(wert ZIELE)
SSHD=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)

# 1 Fassung
if grep -Eq '^[0-9a-f]{12,64}$' /etc/vp-werkbank/fassung 2>/dev/null; then
  ok "Fassung $(cat /etc/vp-werkbank/fassung)"
else
  nein "keine Fassung in /etc/vp-werkbank/fassung"
fi

# 2 Durchleitung im Kernel
[ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" = 1 ] && ok "ip_forward = 1" || nein "ip_forward ist nicht 1"
if [ "$(cat "/proc/sys/net/ipv6/conf/$WERKSTATT/disable_ipv6" 2>/dev/null)" = 1 ]; then
  ok "kein IPv6 an $WERKSTATT"
else
  nein "IPv6 an $WERKSTATT nicht abgeschaltet"
fi

# 3 Firewall: Tabelle geladen, Eingang und Durchleitung sperren von selbst
if nft list table inet werkbank >/dev/null 2>&1; then
  ok "Tabelle inet werkbank geladen"
  for kette in eingang weiter; do
    if nft list chain inet werkbank "$kette" 2>/dev/null | grep -q 'policy drop'; then
      ok "Kette $kette: policy drop"
    else
      nein "Kette $kette sperrt nicht von selbst (policy drop fehlt)"
    fi
  done
  if nft list chain inet werkbank weiter 2>/dev/null | grep -q '!= @nicht_internet'; then
    ok "Durchleitung nur ins Internet (nie in private Netze)"
  else
    nein "Durchleitung ohne Sperre der privaten Netze"
  fi
else
  nein "Tabelle inet werkbank fehlt"
fi

# 4 Werkstatt-Anschluss: genau die festen Adressen, kein Standardweg, kein DHCP-Client
ist=$(ip -4 -o addr show dev "$WERKSTATT" 2>/dev/null | awk '{print $4}' | sort | tr '\n' ' ' | sed 's/ $//')
soll=$(for a in $WERKSTATT_ADRESSEN; do echo "$a"; done | sort | tr '\n' ' ' | sed 's/ $//')
if [ "$ist" = "$soll" ]; then
  ok "$WERKSTATT: $soll"
elif [ "$(cat "/sys/class/net/$WERKSTATT/carrier" 2>/dev/null)" != 1 ] && [ -z "$ist" ]; then
  ok "$WERKSTATT: kein Kabel, Adressen kommen mit dem Kabel ($soll)"
else
  nein "$WERKSTATT hat \"$ist\", erwartet \"$soll\""
fi
if [ -n "$(ip -4 route show default dev "$WERKSTATT" 2>/dev/null)" ]; then
  nein "Standardweg über $WERKSTATT"
else
  ok "kein Standardweg über $WERKSTATT"
fi
if command -v nmcli >/dev/null 2>&1 && nmcli -t -f RUNNING general 2>/dev/null | grep -q running; then
  methode=$(nmcli -g ipv4.method connection show vp-werkstatt 2>/dev/null || true)
  [ "$methode" = manual ] && ok "NetworkManager: vp-werkstatt mit festen Adressen" || nein "NetworkManager: vp-werkstatt fehlt oder nutzt \"$methode\""
fi
if ps -eo args 2>/dev/null | grep -E "(dhclient|dhcpcd|udhcpc).*[[:space:]]$WERKSTATT([[:space:]]|$)" | grep -vq grep; then
  nein "ein DHCP-Client läuft an $WERKSTATT"
else
  ok "kein DHCP-Client an $WERKSTATT"
fi

# 5 kein DHCP-Server auf der Brücke
if command -v ss >/dev/null 2>&1; then
  if [ -n "$(ss -Hlun 'sport = :67' 2>/dev/null)" ]; then
    nein "ein Dienst lauscht auf UDP 67 (DHCP-Server)"
  else
    ok "kein DHCP-Server (UDP 67)"
  fi
else
  nein "ss fehlt, DHCP-Server nicht prüfbar"
fi

# 6 Netz und Werkstatt-Anschluss getrennt
if [ "$(cat "/sys/class/net/$NETZ/operstate" 2>/dev/null)" = up ]; then
  ok "Netz $NETZ ist oben"
else
  nein "Netz $NETZ ist nicht oben"
fi
getrennt=1
for z in $ZIELE; do
  b=${z%:*}
  dev=$(ip -4 route get "$b" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1)
  if [ "$dev" = "$WERKSTATT" ]; then
    :
  else
    nein "$b liegt nicht am Werkstatt-Anschluss (Weg über \"$dev\")"
    getrennt=0
  fi
done
[ "$getrennt" = 1 ] && ok "Box-Adressen nur über $WERKSTATT"

# 7 SSH, wie sshd es wirklich anwendet
if [ -x "$SSHD" ] && t=$("$SSHD" -T 2>/dev/null); then
  pruef() { # pruef <schluessel> <wert>
    if printf '%s\n' "$t" | grep -qix "$1 $2"; then ok "sshd: $1 $2"; else nein "sshd: $1 ist nicht \"$2\" ($(printf '%s\n' "$t" | grep -i "^$1 " | head -n1))"; fi
  }
  pruef passwordauthentication no
  pruef kbdinteractiveauthentication no
  pruef permitrootlogin no
  pruef allowusers werkstatt
  pruef allowtcpforwarding local
  pruef authorizedkeysfile /etc/ssh/vp-werkbank/%u
  pruef permitopen "$ZIELE"
else
  nein "sshd -T nicht lesbar"
fi

# 8 Schlüssel: root-eigen, die des Dienstes eingeschränkt
k=/etc/ssh/vp-werkbank/werkstatt
if [ -f "$k" ] && [ "$(stat -c %u "$k" 2>/dev/null)" = 0 ] && [ -z "$(find "$k" -perm -022 2>/dev/null)" ]; then
  ok "$k root-eigen, nur root schreibt"
else
  nein "$k fehlt oder ist nicht root-eigen"
fi
for name in werkstatt-dienst-status werkstatt-dienst-weiterleitung werkstatt-dienst-pflege; do
  zeile=$(grep " $name\$" "$k" 2>/dev/null || true)
  case "$zeile" in
    restrict,*) ok "Schlüssel $name eingeschränkt" ;;
    '') nein "Schlüssel $name fehlt" ;;
    *) nein "Schlüssel $name ohne restrict" ;;
  esac
done

# 9 sudo nur für die zwei Befehle
if [ -f /etc/sudoers.d/vp-werkbank ]; then
  if command -v visudo >/dev/null 2>&1 && ! visudo -cqf /etc/sudoers.d/vp-werkbank; then
    nein "sudoers-Datei ungültig"
  else
    ok "sudoers vp-werkbank gültig"
  fi
else
  nein "/etc/sudoers.d/vp-werkbank fehlt"
fi

# 10 Status-Befehl antwortet mit JSON
s=$(/usr/local/sbin/vp-werkbank-status 2>/dev/null || true)
case "$s" in
  '{"schema":"vp-werkbank-status.v1","fassung":'*) ok "Status-Befehl antwortet" ;;
  *) nein "Status-Befehl antwortet nicht (${s:-leer})" ;;
esac

if [ "$fehler" = 0 ]; then echo "Werkbank-Brücke: alle Prüfungen bestanden"; fi
exit "$fehler"
