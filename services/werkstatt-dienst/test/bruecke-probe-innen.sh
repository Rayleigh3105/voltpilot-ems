#!/bin/bash
# Innerer Teil von bruecke-probe.sh: läuft als root im Probe-Container.
# /probe enthält das Programm, die Wegwerf-Schlüssel und dieses Skript.
set -u
fehler=0
ok() { echo "ok: $*"; }
nein() {
  echo "FEHLER: $*"
  fehler=1
}
ns() { ip netns exec "$@"; }

# ---------------------------------------------------------------- Netz -----
for n in kabel router cluster fremd internet mango mango2; do ip netns add "$n"; done
ip -n kabel link add buero type bridge
ip -n kabel link add werk type bridge
ip -n kabel link set buero up
ip -n kabel link set werk up
verbinde() { # verbinde <ns-oder-wurzel> <name> <switch> <port>
  if [ "$1" = wurzel ]; then
    ip link add "$2" type veth peer name "$4" netns kabel
    ip link set "$2" up
  else
    ip -n "$1" link add "$2" type veth peer name "$4" netns kabel
    ip -n "$1" link set "$2" up
  fi
  ip -n kabel link set "$4" master "$3" up
}
verbinde wurzel wlan0 buero k-bruecke
verbinde wurzel eth0 werk k-werkstatt
verbinde router r-lan buero k-router
verbinde fremd f0 buero k-fremd
verbinde mango m0 werk k-mango
verbinde mango2 m0 werk k-mango2
ip -n kabel link set k-mango2 down # das zweite Gerät steckt erst in Schritt 9
ip -n router link add r-cl type veth peer name c0 netns cluster
ip -n router link add r-inet type veth peer name i0 netns internet
for x in "router r-cl" "router r-inet" "cluster c0" "internet i0"; do
  set -- $x
  ip -n "$1" link set "$2" up
done
for n in router cluster fremd internet mango mango2; do ip -n "$n" link set lo up; done
ip addr add 192.168.0.50/24 dev wlan0
ip route add default via 192.168.0.1
ip -n router addr add 192.168.0.1/24 dev r-lan
ip -n router addr add 192.168.178.1/24 dev r-cl
ip -n router addr add 198.51.100.1/24 dev r-inet
ns router sysctl -qw net.ipv4.ip_forward=1
ip -n cluster addr add 192.168.178.241/24 dev c0
ip -n cluster route add default via 192.168.178.1
ip -n fremd addr add 192.168.0.20/24 dev f0
ip -n fremd route add default via 192.168.0.1
ip -n internet addr add 198.51.100.10/24 dev i0
ip -n internet route add default via 198.51.100.1
ip -n mango addr add 192.168.8.1/24 dev m0
ip -n mango2 addr add 192.168.8.1/24 dev m0

lausche() { # lausche <ns> <adresse> <port> <antwort>
  ns "$1" socat "TCP-LISTEN:$3,bind=$2,fork,reuseaddr" "SYSTEM:echo $4 \$SOCAT_PEERADDR" >/dev/null 2>&1 &
}
lausche internet 198.51.100.10 80 internet
lausche router 192.168.0.1 80 router
lausche cluster 192.168.178.241 80 cluster
lausche fremd 192.168.0.20 80 fremd
lausche mango 192.168.8.1 22 SSH-2.0-dropbear-werk
lausche mango 192.168.8.1 80 gl-werk
lausche mango 192.168.8.1 23 telnet
sleep 0.5
# frage <ns> <adresse> <port>: Antwort oder leer (nach 3 s)
frage() { ns "$1" timeout 4 socat -T3 - "TCP:$2:$3,connect-timeout=3" </dev/null 2>/dev/null | head -n1; }
[ "$(frage router 198.51.100.10 80)" = "internet 198.51.100.1" ] && ok "Netz der Probe steht" || nein "Netz der Probe steht nicht"

# ------------------------------------------- frische Brücke (wie vom Imager) ---
mkdir -p /root/keys
cp /probe/geheim/* /probe/notfall /root/keys/
chmod 0600 /root/keys/*
useradd -m -s /bin/bash vpwerkstatt
install -d -m 0700 -o vpwerkstatt /home/vpwerkstatt/.ssh
install -m 0600 -o vpwerkstatt /probe/geheim/werkbank-einrichten.pub /home/vpwerkstatt/.ssh/authorized_keys
echo 'vpwerkstatt ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/010_vpwerkstatt-nopasswd
chmod 0440 /etc/sudoers.d/010_vpwerkstatt-nopasswd
echo "127.0.1.1 $(hostname)" >>/etc/hosts # sonst warnt sudo bei jedem Aufruf
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
/usr/sbin/sshd
sleep 0.3

SSHO=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=4 -o IdentitiesOnly=yes -o LogLevel=ERROR)
als() { # als <ns> <schlüssel> <benutzer> [befehl…]
  local n=$1 k=$2 b=$3
  shift 3
  ns "$n" timeout 15 ssh "${SSHO[@]}" -i "/root/keys/$k" "$b@192.168.0.50" "$@"
}
weiter() { # weiter <ns> <schlüssel> <ziel>: ssh -W (direct-tcpip) als werkstatt
  # LogLevel INFO zuerst: sonst schweigt ssh über den Grund der Ablehnung
  ns "$1" timeout 15 ssh -o LogLevel=INFO "${SSHO[@]}" -i "/root/keys/$2" -W "$3" werkstatt@192.168.0.50 </dev/null
}
dienst() { # dienst [VAR=wert…]: einmal vp-werkstatt-dienst werkbank aus dem Cluster
  ns cluster env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    VP_WERKBANK_ADRESSE=192.168.0.50 VP_WERKSTATT_GEHEIM=/probe/geheim \
    VP_WERKSTATT_NOTFALL_PUB=/probe/notfall.pub VP_WERKSTATT_DATEN=/tmp/daten \
    VP_WERKBANK_SSH_QUELLEN=192.168.178.241 "$@" \
    timeout 120 /probe/vp-werkstatt-dienst werkbank
}

# ------------------------------------------------------------ 1 einrichten ---
if aus=$(dienst 2>/tmp/einrichten.log); then
  ok "1 Dienst hat die Brücke eingerichtet"
else
  nein "1 Einrichten gescheitert"
  cat /tmp/einrichten.log
fi
grep -q '^eingerichtet (Fassung' /tmp/einrichten.log && ok "1 erstmals über den Imager-Benutzer" || nein "1 nicht über den Imager-Benutzer eingerichtet"
grep -q 'alle Prüfungen bestanden' /tmp/einrichten.log && ok "1 einrichten.sh: pruefen bestanden" || {
  nein "1 pruefen nach dem Einrichten"
  grep 'FEHLER' /tmp/einrichten.log
}
fassung=$(cat /etc/vp-werkbank/fassung 2>/dev/null)
case "$aus" in *"\"fassung\": \"$fassung\""*) ok "1 Status nennt die Fassung $fassung" ;; *) nein "1 Status: $aus" ;; esac
/usr/local/sbin/vp-werkbank-pruefen >/tmp/pruefen.log && ok "1 vp-werkbank-pruefen besteht" || {
  nein "1 vp-werkbank-pruefen"
  cat /tmp/pruefen.log
}
if dienst 2>/tmp/zweiter.log >/dev/null && ! grep -Eq '^(eingerichtet|gepflegt)' /tmp/zweiter.log; then
  ok "1 zweiter Lauf ändert nichts"
else
  nein "1 zweiter Lauf hat neu aufgespielt"
  cat /tmp/zweiter.log
fi

# ------------------------------------------------------- 2 Imager-Benutzer ---
als cluster werkbank-einrichten vpwerkstatt true 2>/dev/null && nein "2 Imager-Benutzer kommt noch herein" || ok "2 Imager-Benutzer abgewiesen"
ns cluster timeout 10 ssh "${SSHO[@]}" -o PubkeyAuthentication=no -o PasswordAuthentication=yes werkstatt@192.168.0.50 true 2>/dev/null &&
  nein "2 Anmeldung ohne Schlüssel" || ok "2 ohne Schlüssel keine Anmeldung"

# ------------------------------------------------------------- 3 Status ---
mac=$(ip -n mango -br link show m0 | awk '{print $3}')
s=$(als cluster werkbank-status werkstatt 'cat /etc/shadow; id')
case "$s" in
  '{"schema":"vp-werkbank-status.v1"'*) ok "3 Status-Schlüssel: erzwungener Status statt des Befehls" ;;
  *) nein "3 Status-Schlüssel führt anderes aus: $s" ;;
esac
case "$s" in *"\"adresse\":\"192.168.8.1\",\"macs\":[\"$mac\"]"*) ok "3 Status nennt die Mango ab Werk ($mac)" ;; *) nein "3 Status ohne die Mango: $s" ;; esac
case "$s" in *'"ip_forward":true,"firewall":true'*) ok "3 Status: Durchleitung und Firewall" ;; *) nein "3 Status: $s" ;; esac
w=$(weiter cluster werkbank-status 192.168.8.1:22 2>&1 </dev/null)
case "$w" in *SSH-2.0*) nein "3 Status-Schlüssel leitet weiter" ;; *) ok "3 Status-Schlüssel leitet nicht weiter" ;; esac

# ------------------------------------------------------- 4 Weiterleitung ---
w=$(weiter cluster werkbank-weiterleitung 192.168.8.1:22 2>/dev/null)
case "$w" in SSH-2.0-dropbear-werk*) ok "4 Weiterleitung zu 192.168.8.1:22" ;; *) nein "4 Weiterleitung zu 192.168.8.1:22: $w" ;; esac
w=$(weiter cluster werkbank-weiterleitung 192.168.8.1:80 2>/dev/null)
case "$w" in gl-werk*) ok "4 Weiterleitung zu 192.168.8.1:80" ;; *) nein "4 Weiterleitung zu 192.168.8.1:80: $w" ;; esac
for z in 192.168.8.1:23 192.168.0.1:80 192.168.178.241:80 198.51.100.10:80; do
  w=$(weiter cluster werkbank-weiterleitung "$z" 2>&1)
  case "$w" in *"administratively prohibited"*) ok "4 kein Weg zu $z (abgewiesen)" ;; *) nein "4 Weiterleitung zu $z: $w" ;; esac
done
w=$(als cluster werkbank-weiterleitung werkstatt id 2>&1)
case "$w" in *uid=*) nein "4 Weiterleitungs-Schlüssel hat eine Shell" ;; *) ok "4 Weiterleitungs-Schlüssel ohne Shell" ;; esac

# ------------------------------------------------------------- 5 Pflege ---
w=$(als cluster werkbank-pflege werkstatt id 2>&1)
case "$w" in *"kennt nur: einrichten"*) ok "5 Pflege-Schlüssel nur für einrichten" ;; *) nein "5 Pflege-Schlüssel: $w" ;; esac
w=$(echo kaputt | als cluster werkbank-pflege werkstatt "einrichten $(printf '%064d' 0)" 2>&1)
case "$w" in *"Prüfsumme"*) ok "5 falsche Prüfsumme abgewiesen" ;; *) nein "5 falsche Prüfsumme: $w" ;; esac
if dienst VP_WERKBANK_SSH_QUELLEN=192.168.178.241,192.168.178.242 2>/tmp/pflege.log >/dev/null && grep -q '^gepflegt (Fassung' /tmp/pflege.log; then
  ok "5 geänderte Parameter: über den Pflege-Schlüssel neu aufgespielt"
else
  nein "5 Pflege"
  cat /tmp/pflege.log
fi
nft list set inet werkbank ssh_quellen | grep -q 192.168.178.242 && ok "5 neue SSH-Quelle in der Firewall" || nein "5 neue SSH-Quelle fehlt"
[ "$(cat /etc/vp-werkbank/fassung)" != "$fassung" ] && ok "5 neue Fassung" || nein "5 Fassung unverändert"

# ------------------------------------------------------------ 6 Notfall ---
w=$(als cluster notfall werkstatt id 2>&1)
case "$w" in *"(werkstatt)"*) ok "6 Notfall-Schlüssel: Shell als werkstatt" ;; *) nein "6 Notfall-Schlüssel: $w" ;; esac
als cluster notfall werkstatt 'sudo -n id' >/dev/null 2>&1 && nein "6 werkstatt darf beliebiges sudo" || ok "6 sudo nur für die zwei Befehle"
w=$(als cluster notfall werkstatt 'sudo -n /usr/local/sbin/vp-werkbank-status' 2>&1)
case "$w" in '{"schema"'*) ok "6 sudo für den Status" ;; *) nein "6 sudo Status: $w" ;; esac
case "$w" in *'"strom":{"quelle":"keine"}'*) ok "6 Status ohne vcgencmd: Strom unbekannt" ;; *) nein "6 Strom ohne vcgencmd: $w" ;; esac
printf '#!/bin/sh\necho throttled=0x50005\n' > /usr/local/bin/vcgencmd && chmod 755 /usr/local/bin/vcgencmd
w=$(als cluster notfall werkstatt 'sudo -n /usr/local/sbin/vp-werkbank-status' 2>&1)
case "$w" in *'"strom":{"unterspannung_jetzt":true,"unterspannung_seit_start":true,"quelle":"vcgencmd"}'*) ok "6 Unterspannung des Pi im Status" ;; *) nein "6 Unterspannung: $w" ;; esac
printf '#!/bin/sh\necho throttled=0x0\n' > /usr/local/bin/vcgencmd
w=$(als cluster notfall werkstatt 'sudo -n /usr/local/sbin/vp-werkbank-status' 2>&1)
case "$w" in *'"unterspannung_jetzt":false,"unterspannung_seit_start":false'*) ok "6 ohne Unterspannung" ;; *) nein "6 ohne Unterspannung: $w" ;; esac
mv /usr/local/bin/vcgencmd /usr/local/bin/vcgencmd.aus

# ------------------------------------------------------- 7 SSH-Quellen ---
als fremd notfall werkstatt true 2>/dev/null && nein "7 SSH aus dem Büronetz" || ok "7 SSH aus dem Büronetz abgewiesen"
w=$(frage mango 192.168.8.2 22)
[ -z "$w" ] && ok "7 SSH vom Werkstatt-Anschluss abgewiesen" || nein "7 SSH vom Werkstatt-Anschluss: $w"

# -------------------------------------------------------- 8 Durchleitung ---
ip -n mango route add default via 192.168.8.2
w=$(frage mango 198.51.100.10 80)
[ "$w" = "internet 192.168.0.50" ] && ok "8 Mango ab Werk ins Internet, mit NAT" || nein "8 Mango ab Werk ins Internet: $w"
ip -n mango addr flush dev m0
ip -n mango addr add 192.168.1.1/24 dev m0
ip -n mango route add default via 192.168.1.2
w=$(frage mango 198.51.100.10 80)
[ "$w" = "internet 192.168.0.50" ] && ok "8 Mango nach OpenWrt (192.168.1.1) ins Internet" || nein "8 Mango 192.168.1.1 ins Internet: $w"
for z in "192.168.0.1 router" "192.168.0.20 fremd" "192.168.178.241 cluster"; do
  set -- $z
  w=$(frage mango "$1" 80)
  [ -z "$w" ] && ok "8 Mango nicht zu $2 ($1)" || nein "8 Mango erreicht $2: $w"
done
ip -n mango addr flush dev m0
ip -n mango addr add 10.213.0.1/24 dev m0
ip -n mango route add default via 10.213.0.2
w=$(frage mango 198.51.100.10 80)
[ "$w" = "internet 192.168.0.50" ] && ok "8 Mango im LAN-Netz (10.213.0.1) ins Internet" || nein "8 Mango 10.213.0.1 ins Internet: $w"
ip -n mango addr add 172.31.0.5/24 dev m0
w=$(ns mango timeout 4 socat -T3 - "TCP:198.51.100.10:80,bind=172.31.0.5,connect-timeout=3" </dev/null 2>/dev/null | head -n1)
[ -z "$w" ] && ok "8 fremde Quelle am Werkstatt-Anschluss nicht durchgeleitet" || nein "8 fremde Quelle durchgeleitet: $w"
ip -n fremd route add 10.213.0.0/24 via 192.168.0.50
lausche mango 10.213.0.1 22 SSH-2.0-dropbear-lan
sleep 0.3
w=$(frage fremd 10.213.0.1 22)
[ -z "$w" ] && ok "8 aus dem Büronetz nicht zur Box" || nein "8 Büronetz erreicht die Box: $w"
w=$(weiter cluster werkbank-weiterleitung 10.213.0.1:22 2>/dev/null)
case "$w" in SSH-2.0-dropbear-lan*) ok "8 Dienst erreicht die Box im LAN-Netz über die Brücke" ;; *) nein "8 Weiterleitung zu 10.213.0.1:22: $w" ;; esac

# ---------------------------------------------------- 9 zwei Geräte ---
ip -n mango addr flush dev m0
ip -n mango addr add 192.168.8.1/24 dev m0
ip -n kabel link set k-mango2 up
sleep 1
s=$(als cluster werkbank-status werkstatt status)
n=$(printf '%s' "$s" | grep -o '"adresse":"192.168.8.1","macs":\[[^]]*\]' | grep -o '..:..:..:..:..:..' | sort -u | wc -l)
[ "$n" = 2 ] && ok "9 zwei Geräte am Werkstatt-Anschluss: zwei MACs" || nein "9 zwei Geräte: $n MACs ($s)"
ip -n kabel link set k-mango2 down

# ------------------------------------------- 10 Firewall fehlt: neu aufspielen ---
nft delete table inet werkbank
/usr/local/sbin/vp-werkbank-pruefen >/tmp/pruefen2.log && nein "10 pruefen besteht ohne Firewall" || {
  grep -q 'FEHLER: Tabelle inet werkbank fehlt' /tmp/pruefen2.log && ok "10 pruefen meldet die fehlende Firewall" || nein "10 pruefen: $(cat /tmp/pruefen2.log)"
}
if dienst VP_WERKBANK_SSH_QUELLEN=192.168.178.241,192.168.178.242 2>/tmp/heilen.log >/dev/null && grep -q '^gepflegt' /tmp/heilen.log && nft list table inet werkbank >/dev/null 2>&1; then
  ok "10 Dienst spielt die Firewall neu auf"
else
  nein "10 Firewall nicht neu aufgespielt"
  cat /tmp/heilen.log
fi

echo
if [ "$fehler" = 0 ]; then echo "Probe der Werkbank-Brücke: alles bestanden"; else echo "Probe der Werkbank-Brücke: FEHLER"; fi
exit "$fehler"
