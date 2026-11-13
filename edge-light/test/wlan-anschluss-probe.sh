#!/bin/sh
# Probe fuer edge-light/openwrt/files/usr/libexec/vp-edge-light/wlan-anschluss.sh
# gegen ein ECHTES OpenWrt 25.12.5 mit simuliertem Funk - ohne Mango, ohne
# Docker, ohne Root auf dem Rechner. Das Labor liegt unter test/wlan-labor/:
# OpenWrt x86/generic im Emulator v86 (Node), mac80211_hwsim mit drei
# Funkmodulen in Netz-Namensraeumen (Kundenrouter WPA2, Nachbar WPA3, Box), ein
# Kabelgeraet per veth an der LAN-Buchse der Box. hostapd, wpa_supplicant,
# netifd, fw4, dnsmasq und relayd sind die Programme aus 25.12.5.
#
# Jeder Lauf startet ein frisches OpenWrt und prueft einen Befehl mit festen
# Erwartungen (Zeilen "PRUEF ok|FEHLER" im Protokoll):
#   scan         Netze, Verschluesselung (WPA2, WPA3), --json
#   messen       Signal, Urteil gegen die Schwelle, Rueckgabe je Ausgang
#   verbinden    WLAN-Weg B: Geraete mit Adressen vom Router, Schutz der Box
#                (nur OCPP aus dem Heimnetz), Leseports gesperrt, Box liest
#                das Geraet, Hotplug, Wiederholung, Wechsel in ein WPA3-Netz
#   falsch       falsches Passwort, unbekanntes Netz, zu kurzes Passwort: die
#                vorige Einstellung gilt wieder, die LAN-Seite bleibt
#   kabel        Rueckweg: ohne Kabel verweigert, mit Kabel eigenes Netz und NAT;
#                ein ausgeschaltetes Funkmodul geht nur fuer den Client an
#   stoerfaelle  im WLAN-Weg B: Router aus, Passwort am Router geaendert
# Dazu, ohne Urteil: messung-relay (die Messung aus dem Konzept, Abschnitt
# 6.4: Zone und lokale Adresse am Relay).
#
#   edge-light/test/wlan-anschluss-probe.sh [lauf ...]      (Vorgabe: alle sechs)
#   VP_WLAN_LABOR_CACHE=<verz>  Zwischenspeicher fuer Abbilder, Pakete, v86
#                               (Vorgabe ~/.cache/vp-wlan-labor, rund 250 MB)
#   VP_WLAN_LABOR_AUS=<verz>    Protokolle, je Lauf <lauf>.log (Vorgabe: neu unter /tmp)
#   VP_WLAN_LABOR_LAST=<n>      hoechste Last vor jedem Lauf (Vorgabe: Kerne x 1,5);
#                               darueber wartet die Probe bis zu 30 min
#   FRIST_FAKTOR=<n>            alle Fristen strecken; LAUT=1 Konsole mitlesen
#
# Braucht node >= 22, curl, tar; einmal rund 115 MB aus dem Netz (hole.sh).
# Dauer je Lauf drei bis sechs Minuten auf einem ruhigen Rechner.
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
LABOR="$HIER/wlan-labor"
SKRIPT="$HIER/../openwrt/files/usr/libexec/vp-edge-light/wlan-anschluss.sh"
CACHE="${VP_WLAN_LABOR_CACHE:-$HOME/.cache/vp-wlan-labor}"
AUS="${VP_WLAN_LABOR_AUS:-$(mktemp -d "${TMPDIR:-/tmp}/vp-wlan-probe.XXXXXX")}"
LAEUFE="${*:-scan messen verbinden falsch kabel stoerfaelle}"

command -v node >/dev/null 2>&1 || { echo "FEHLER: node fehlt (>= 22)" >&2; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "FEHLER: node >= 22 noetig" >&2; exit 2; }
for lauf in $LAEUFE; do
  [ -f "$LABOR/laeufe/$lauf.txt" ] || { echo "FEHLER: kein Lauf $lauf (laeufe/*.txt)" >&2; exit 2; }
done

sh "$LABOR/hole.sh" "$CACHE"
mkdir -p "$AUS"

# Zweite Platte: Paketquellen, Pruefhelfer und das Skript aus diesem Stand.
hdb="$AUS/hdb"
rm -rf "$hdb"
mkdir -p "$hdb/skript" "$hdb/werkzeug"
cp -R "$CACHE/repo" "$hdb/"
cp "$LABOR/werkzeug/"*.sh "$hdb/werkzeug/"
cp "$SKRIPT" "$hdb/skript/"
(cd "$hdb" && COPYFILE_DISABLE=1 tar --format=ustar --uid 0 --gid 0 --uname root --gname root \
  -cf "$AUS/hdb.tar" repo werkzeug skript 2>/dev/null) ||
  (cd "$hdb" && tar --format=ustar --owner=0 --group=0 -cf "$AUS/hdb.tar" repo werkzeug skript)

kerne="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
grenze="${VP_WLAN_LABOR_LAST:-$((kerne * 3 / 2))}"
last() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg | awk '{print $2}'; fi
}
warte_auf_ruhe() {
  n=0
  while [ "$(last | cut -d. -f1 | cut -d, -f1)" -ge "$grenze" ]; do
    [ "$n" -eq 0 ] && echo "    Last $(last) >= $grenze - warte (der Emulator verliert unter Last die Fristen)"
    n=$((n + 1))
    [ "$n" -le 360 ] || { echo "FEHLER: Last nach 30 min noch ueber $grenze" >&2; exit 1; }
    sleep 5
  done
}

OK=0
FEHLER=0
ABBRUCH=""
for lauf in $LAEUFE; do
  echo
  echo "== $lauf"
  warte_auf_ruhe
  cat "$LABOR/laeufe/basis.txt" "$LABOR/laeufe/aufbau.txt" "$LABOR/laeufe/$lauf.txt" >"$AUS/$lauf.befehle"
  if ! node "$LABOR/boot.mjs" "$CACHE" "$AUS/$lauf.befehle" "$AUS/$lauf.log" "$AUS/hdb.tar" >"$AUS/$lauf.out" 2>&1; then
    ABBRUCH="$ABBRUCH $lauf"
    echo "  ABBRUCH: $(grep ABBRUCH "$AUS/$lauf.out" | head -n 1)"
  fi
  tr -d '\r' <"$AUS/$lauf.log" | grep -E '^(PRUEF (ok|FEHLER)|INFO) ' | sed 's/^PRUEF ok /  ok      /; s/^PRUEF FEHLER /  FEHLER  /; s/^INFO /  info    /' || true
  o="$(tr -d '\r' <"$AUS/$lauf.log" | grep -c '^PRUEF ok ' || true)"
  f="$(tr -d '\r' <"$AUS/$lauf.log" | grep -c '^PRUEF FEHLER ' || true)"
  OK=$((OK + o))
  FEHLER=$((FEHLER + f))
  if [ "$o" -eq 0 ] && [ "$lauf" != messung-relay ]; then
    echo "  FEHLER  keine einzige Pruefung gelaufen"
    FEHLER=$((FEHLER + 1))
  fi
done

echo
echo "== Ergebnis: $OK ok, $FEHLER Fehler${ABBRUCH:+, abgebrochen:$ABBRUCH} - Protokolle in $AUS"
[ "$FEHLER" -eq 0 ] && [ -z "$ABBRUCH" ]
