#!/bin/sh
# Werkbank-Brücke einrichten (services/werkstatt-dienst/bruecke, WI-13 B).
#
# Läuft als root auf der Brücke, im ausgepackten Paket des Werkstatt-Dienstes
# (parameter.env und authorized_keys liegen daneben). Wiederholbar: ein
# zweiter Lauf mit demselben Paket ändert nichts, ein neues Paket ersetzt
# alles, was dieses Skript angelegt hat. Andere Dateien der Brücke fasst es
# nicht an.
#
# Was danach gilt:
#   - Werkstatt-Anschluss ($WERKSTATT, die Netzwerkbuchse): feste Adressen,
#     kein DHCP (weder Server noch Client), kein IPv6
#   - Netz ($NETZ, das WLAN): wie vom Imager eingerichtet, Energiesparen aus
#   - Durchleitung: vom Werkstatt-Anschluss nur ins Internet, nie in private
#     Netze; NAT nur für die Werkstatt-Netze (nftables-Tabelle inet werkbank)
#   - auf die Brücke: nur SSH aus $SSH_QUELLEN; vom Werkstatt-Anschluss nichts
#   - SSH: nur der Benutzer werkstatt, nur mit Schlüssel; die Schlüssel stehen
#     root-eigen in /etc/ssh/vp-werkbank/werkstatt (Status, Weiterleitung,
#     Pflege, Notfall); der Benutzer vom Imager kommt danach nicht mehr herein
#
# Aufruf (macht der Dienst): sh einrichten.sh
set -eu

HIER=$(cd "$(dirname "$0")" && pwd)
PARAM="$HIER/parameter.env"
ZIEL=/etc/vp-werkbank

fehler() {
  echo "FEHLER: $*" >&2
  exit 1
}
schritt() { echo "einrichten: $*"; }

[ "$(id -u)" = 0 ] || fehler "einrichten.sh braucht root"
[ -f "$PARAM" ] || fehler "parameter.env fehlt neben einrichten.sh"
[ -f "$HIER/authorized_keys" ] || fehler "authorized_keys fehlt neben einrichten.sh"

# --- Parameter lesen, ohne die Datei auszuführen: nur bekannte Schlüssel ---
FASSUNG='' NETZ='' WERKSTATT='' WERKSTATT_ADRESSEN='' ZIELE='' SSH_QUELLEN=''
passt() { printf '%s' "$2" | grep -Eq "$1"; }
IP='([0-9]{1,3}\.){3}[0-9]{1,3}'
jede() { # jede <muster> "<liste mit Leerzeichen>"
  [ -n "$2" ] || return 1
  # shellcheck disable=SC2086 # die Liste soll an Leerzeichen zerfallen
  for _x in $2; do passt "^$1\$" "$_x" || return 1; done
}
while IFS= read -r zeile || [ -n "$zeile" ]; do
  case "$zeile" in '' | '#'*) continue ;; esac
  k=${zeile%%=*}
  v=${zeile#*=}
  case "$k" in
    FASSUNG) passt '^[0-9a-f]{12,64}$' "$v" || fehler "FASSUNG ungültig" && FASSUNG=$v ;;
    NETZ) passt '^[a-z][a-z0-9]{0,14}$' "$v" || fehler "NETZ ungültig" && NETZ=$v ;;
    WERKSTATT) passt '^[a-z][a-z0-9]{0,14}$' "$v" || fehler "WERKSTATT ungültig" && WERKSTATT=$v ;;
    WERKSTATT_ADRESSEN) jede "$IP/24" "$v" || fehler "WERKSTATT_ADRESSEN ungültig" && WERKSTATT_ADRESSEN=$v ;;
    ZIELE) jede "$IP:[0-9]{1,5}" "$v" || fehler "ZIELE ungültig" && ZIELE=$v ;;
    SSH_QUELLEN) jede "$IP(/[0-9]{1,2})?" "$v" || fehler "SSH_QUELLEN ungültig" && SSH_QUELLEN=$v ;;
    *) fehler "unbekannter Parameter $k" ;;
  esac
done <"$PARAM"
for v in FASSUNG NETZ WERKSTATT WERKSTATT_ADRESSEN ZIELE SSH_QUELLEN; do
  eval "[ -n \"\${$v}\" ]" || fehler "Parameter $v fehlt"
done
[ "$NETZ" != "$WERKSTATT" ] || fehler "NETZ und WERKSTATT sind dieselbe Schnittstelle"

# Werkstatt-Netze (/24 der Adressen) und Box-Adressen (Hosts der Ziele)
WERKSTATT_NETZE=$(for a in $WERKSTATT_ADRESSEN; do echo "${a%.*/24}.0/24"; done | sort -u | tr '\n' ' ')
BOXEN=$(for z in $ZIELE; do echo "${z%:*}"; done | sort -u | tr '\n' ' ')
komma() { echo "$*" | sed 's/^ *//; s/ *$//; s/  */, /g'; }

# --- Pakete ---------------------------------------------------------------
fehlt=''
command -v nft >/dev/null 2>&1 || fehlt="$fehlt nftables"
command -v arping >/dev/null 2>&1 || fehlt="$fehlt iputils-arping"
command -v sudo >/dev/null 2>&1 || fehlt="$fehlt sudo"
command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ] || fehlt="$fehlt openssh-server"
command -v ip >/dev/null 2>&1 || fehlt="$fehlt iproute2"
if [ -n "$fehlt" ]; then
  command -v apt-get >/dev/null 2>&1 || fehler "es fehlen:$fehlt (kein apt-get)"
  schritt "Pakete installieren:$fehlt"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  # shellcheck disable=SC2086 # Liste der Paketnamen
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends $fehlt
fi
SSHD=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)

# --- Schnittstellen ---------------------------------------------------------
[ -d "/sys/class/net/$NETZ" ] || fehler "Schnittstelle $NETZ (Netz) gibt es nicht"
[ -d "/sys/class/net/$WERKSTATT" ] || fehler "Schnittstelle $WERKSTATT (Werkstatt-Anschluss) gibt es nicht"
# Liegt ein Werkstatt-Netz schon direkt am Netz (das WLAN ist selbst 192.168.1.x),
# fänden die Antworten der Box nicht zurück. Dann nicht einrichten.
for b in $BOXEN; do
  weg=$(ip -4 route get "$b" 2>/dev/null | head -n1 || true)
  case "$weg" in
    *" via "*) ;;
    *"dev $NETZ "*) fehler "das Netz an $NETZ enthält schon $b: Werkstatt-Netze und Netz der Werkbank überschneiden sich" ;;
  esac
done

# --- Benutzer werkstatt -----------------------------------------------------
if ! id werkstatt >/dev/null 2>&1; then
  schritt "Benutzer werkstatt anlegen"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/werkstatt --shell /bin/sh werkstatt
  else
    adduser -S -D -h /var/lib/werkstatt -s /bin/sh werkstatt
  fi
fi
# kein Passwort; die Anmeldung geht nur mit Schlüssel
if command -v usermod >/dev/null 2>&1; then usermod -p '*' werkstatt; else passwd -d werkstatt >/dev/null 2>&1 || true; fi

# --- Dateien ------------------------------------------------------------------
install -d -m 0755 "$ZIEL" /etc/ssh/vp-werkbank /usr/local/bin /usr/local/sbin
install -m 0755 "$HIER/bin/vp-werkbank-pflege" /usr/local/bin/vp-werkbank-pflege
install -m 0755 "$HIER/sbin/vp-werkbank-status" /usr/local/sbin/vp-werkbank-status
install -m 0755 "$HIER/sbin/vp-werkbank-einrichten" /usr/local/sbin/vp-werkbank-einrichten
install -m 0755 "$HIER/pruefen.sh" /usr/local/sbin/vp-werkbank-pruefen
grep -v '^FASSUNG=' "$PARAM" >"$ZIEL/parameter.env.neu"
chmod 0644 "$ZIEL/parameter.env.neu"
mv -f "$ZIEL/parameter.env.neu" "$ZIEL/parameter.env"

# Schlüssel: root-eigen, der Benutzer werkstatt kann sie nicht ändern
n=$(grep -c . "$HIER/authorized_keys" || true)
[ "$n" -ge 3 ] || fehler "authorized_keys hat $n Zeilen, erwartet mindestens 3"
if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -lf "$HIER/authorized_keys" >/dev/null || fehler "authorized_keys enthält eine ungültige Zeile"
fi
install -m 0644 "$HIER/authorized_keys" /etc/ssh/vp-werkbank/werkstatt.neu
mv -f /etc/ssh/vp-werkbank/werkstatt.neu /etc/ssh/vp-werkbank/werkstatt

# sudo: nur Status und Einrichten, sonst nichts
install -d -m 0750 /etc/sudoers.d
install -m 0440 "$HIER/sudoers/vp-werkbank" /etc/sudoers.d/vp-werkbank.neu
if command -v visudo >/dev/null 2>&1; then
  visudo -cqf /etc/sudoers.d/vp-werkbank.neu || {
    rm -f /etc/sudoers.d/vp-werkbank.neu
    fehler "sudoers-Datei ungültig"
  }
fi
mv -f /etc/sudoers.d/vp-werkbank.neu /etc/sudoers.d/vp-werkbank

# --- Kernel: Durchleitung -------------------------------------------------------
sed "s/@WERKSTATT@/$WERKSTATT/g" "$HIER/sysctl/90-werkbank.conf" >/etc/sysctl.d/90-werkbank.conf
sysctl -q -p /etc/sysctl.d/90-werkbank.conf >/dev/null || fehler "sysctl nicht gesetzt"

# --- Netz -------------------------------------------------------------------------
if command -v nmcli >/dev/null 2>&1 && nmcli -t -f RUNNING general 2>/dev/null | grep -q running; then
  schritt "Werkstatt-Anschluss $WERKSTATT über NetworkManager"
  set -- $WERKSTATT_ADRESSEN
  i=1
  adr=''
  for a in "$@"; do
    adr="${adr}address$i=$a\\n" # awk -v macht aus \n den Zeilenumbruch
    i=$((i + 1))
  done
  awk -v w="$WERKSTATT" -v adr="$adr" '{ gsub(/@WERKSTATT@/, w); if ($0 == "@ADRESSEN@") { printf "%s", adr; next } print }' \
    "$HIER/netz/vp-werkstatt.nmconnection" >/etc/NetworkManager/system-connections/vp-werkstatt.nmconnection
  chmod 0600 /etc/NetworkManager/system-connections/vp-werkstatt.nmconnection
  sed -e "s/@WERKSTATT@/$WERKSTATT/g" -e "s/@NETZ@/$NETZ/g" "$HIER/netz/90-werkbank.conf" >/etc/NetworkManager/conf.d/90-werkbank.conf
  nmcli general reload conf >/dev/null 2>&1 || true
  nmcli connection reload
  # Ohne Kabel bleibt die Verbindung bis zum Einstecken unten; das ist kein Fehler.
  nmcli connection up vp-werkstatt >/dev/null 2>&1 || schritt "vp-werkstatt kommt hoch, sobald ein Kabel steckt"
else
  schritt "Werkstatt-Anschluss $WERKSTATT direkt (ohne NetworkManager, gilt bis zum Neustart)"
  ip link set "$WERKSTATT" up
  ip -4 addr flush dev "$WERKSTATT"
  for a in $WERKSTATT_ADRESSEN; do ip addr add "$a" dev "$WERKSTATT"; done
fi
if command -v iw >/dev/null 2>&1; then iw dev "$NETZ" set power_save off >/dev/null 2>&1 || true; fi

# --- Firewall ---------------------------------------------------------------------
sed -e "s|@NETZ@|$NETZ|g" -e "s|@WERKSTATT@|$WERKSTATT|g" \
  -e "s|@SSH_QUELLEN@|$(komma "$SSH_QUELLEN")|g" -e "s|@WERKSTATT_NETZE@|$(komma "$WERKSTATT_NETZE")|g" \
  "$HIER/nftables/werkbank.nft" >"$ZIEL/werkbank.nft.neu"
nft -c -f "$ZIEL/werkbank.nft.neu" || fehler "Firewall-Regeln ungültig"
mv -f "$ZIEL/werkbank.nft.neu" "$ZIEL/werkbank.nft"
nft -f "$ZIEL/werkbank.nft"
if [ -d /run/systemd/system ]; then
  install -m 0644 "$HIER/systemd/vp-werkbank-firewall.service" /etc/systemd/system/vp-werkbank-firewall.service
  systemctl daemon-reload
  systemctl enable vp-werkbank-firewall.service >/dev/null 2>&1
fi

# --- SSH ------------------------------------------------------------------------------
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config ||
  fehler "/etc/ssh/sshd_config bindet sshd_config.d nicht ein"
install -d -m 0755 /etc/ssh/sshd_config.d
sed "s|@ZIELE@|$ZIELE|g" "$HIER/ssh/10-werkbank.conf" >/etc/ssh/sshd_config.d/10-werkbank.conf.neu
mv -f /etc/ssh/sshd_config.d/10-werkbank.conf /etc/ssh/sshd_config.d/10-werkbank.conf.alt 2>/dev/null || true
mv -f /etc/ssh/sshd_config.d/10-werkbank.conf.neu /etc/ssh/sshd_config.d/10-werkbank.conf
if ! "$SSHD" -t; then
  # nie mit kaputter SSH-Konfiguration zurücklassen
  if [ -f /etc/ssh/sshd_config.d/10-werkbank.conf.alt ]; then
    mv -f /etc/ssh/sshd_config.d/10-werkbank.conf.alt /etc/ssh/sshd_config.d/10-werkbank.conf
  else
    rm -f /etc/ssh/sshd_config.d/10-werkbank.conf
  fi
  fehler "SSH-Konfiguration ungültig, nicht übernommen"
fi
rm -f /etc/ssh/sshd_config.d/10-werkbank.conf.alt
# reload: laufende Sitzungen (auch die, über die dieses Skript läuft) bleiben
if [ -d /run/systemd/system ]; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
elif [ -f /run/sshd.pid ]; then
  kill -HUP "$(cat /run/sshd.pid)"
fi

# --- Fassung zuletzt: erst jetzt meldet der Status die neue -------------------------------
printf '%s\n' "$FASSUNG" >"$ZIEL/fassung.neu"
chmod 0644 "$ZIEL/fassung.neu"
mv -f "$ZIEL/fassung.neu" "$ZIEL/fassung"
schritt "Fassung $FASSUNG eingerichtet"

/usr/local/sbin/vp-werkbank-pruefen
