#!/bin/sh
# Probe fuer das Update im Loader (openwrt/files/.../boot.sh, Konzept
# vp-edge-light-update K4) in einem ECHTEN OpenWrt-25.12-Rootfs (BusyBox, uci,
# jsonfilter, /lib/functions.sh) - ohne Mango, ohne Netz, ohne gebautes
# Programm. Die "Programme" sind kleine Skripte, die sich verhalten wie die
# Fassungen im Laborbeweis: sie beantworten `version`, schreiben in der Probe
# ihr Urteil (probe-urteil.json, Format otalight.Urteil) und laufen, bis
# /probe/stopp existiert.
#
# Zeit und Speicher stellt die Probe ueber VP_LOADER_PROC nach (uptime,
# meminfo); uclient-fetch ersetzt ein Skript, das aus /probe/srv liefert
# (oder ohne "Netz" scheitert).
#
#   0. Bestand: ota-Symlink wird Flash-Verzeichnis, base_url ignoriert,
#      Programm bekommt VP_OTA_RAM_DIR, einzeilige Pruefsumme (Stufe 1) startet
#   1. Gut-Fall (P1): tauschen, Probe, Urteil bestanden -> behalten
#      (Pruefsummen, Kopie, Marke ok); nach Strom aus/an laeuft die neue
#   2. Probestart scheitert (P2): falsche Architektur / falsche Fassung
#   3. Absturz (P3): drei Abstuerze in der Probe -> zurueck, kein vierter
#   4. Keine Cloud (P4/P6): Urteil offen, Frist um -> Waechter beendet,
#      zurueck mit dem Grund des offenen Urteils
#   5. Selbsttest durchgefallen: sofort zurueck mit Grund
#   6. Faelschung im RAM (P10): Lieferung passt nicht zu kandidat.json
#   7. Strom weg in der Probe (P8): kalter Start schreibt "abbruch", alte laeuft
#   8. Strom weg beim Flash-Tausch (P9): Kopie unvollstaendig -> genau diese
#      Fassung nachladen und pruefen; ohne Netz kein Start (Tunnel unberuehrt)
#   9. Marken: feste Obergrenze im Flash
#  10. mit dem ECHTEN Programm (edge-light/dist/vp-edge-light-linux-amd64, wenn
#      gebaut): Probestart, probe.json vom Loader, Selbsttest des Programms
#      ohne Cloud -> Urteil offen "keine Cloud-Verbindung in der Probezeit"
#  11. Lader-Selbstupdate (echtes Programm): unter einem ALTEN Loader ohne
#      LOADER_STAND-Marke spielt das Programm waehrend der Probe nichts ein;
#      laeuft es als bestaetigte Fassung, ersetzt es Loader und Dienst-Init
#      atomar durch seine eingebetteten Kopien (ein liegengebliebener halber
#      Schreibrest .neu verschwindet); der neue Loader meldet seinen Stand,
#      und ein zweiter Start schreibt nichts mehr (Flash schonen)
#
#   edge-light/test/boot-update-probe.sh
#   VPBU_LOADER=<pfad>/boot.sh ...   Gegenprobe mit einem anderen Stand
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; Ausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
LOADER="${VPBU_LOADER:-$HIER/../openwrt/files/usr/libexec/vp-edge-light/boot.sh}"
KONFIG="$HIER/../openwrt/files/etc/config/vp-edge-light"
BILD="${VPBU_BILD:-openwrt/rootfs:x86-64-25.12.5}"
C="vpbu-$$"
OK=0
FEHLER=0
ALT=edge-light-2026.11.1
NEU=edge-light-2026.11.2
LD=/usr/share/vp-edge-light
N=vp-edge-light-linux-mipsle
RAM=/tmp/vp-edge-light/ota
FEST=/etc/vp-edge-light/ota

aufraeumen() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
x() { docker exec "$C" sh -c "$*"; }
pruef() { # pruef <beschreibung> <bedingung im container>
  if x "$2" >/dev/null 2>&1; then ok "$1"; else falsch "$1"; zeige; fi
}
zeige() { x 'for f in /probe/lauf.err /etc/vp-edge-light/ota/versuche; do echo "    --- $f"; sed "s/^/    | /" "$f" 2>/dev/null | tail -n 12; done' || true; }
warte() { # warte <beschreibung> <bedingung> [sekunden]
  i=0
  while ! x "$2" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "${3:-25}" ]; then falsch "$1 (Zeitueberschreitung)"; zeige; return 0; fi
    sleep 1
  done
  ok "$1"
}

# Loader im Hintergrund (eine Probe blockiert, solange das Programm laeuft).
lauf() {
  x 'rm -f /probe/lauf.rc /probe/stopp; : >/probe/lauf.out; : >/probe/lauf.err'
  docker exec -d "$C" sh -c 'PATH=/probe/bin:$PATH VP_LOADER_PROC=/probe/proc sh /usr/libexec/vp-edge-light/boot.sh >>/probe/lauf.out 2>>/probe/lauf.err; echo $? >/probe/lauf.rc'
}
# Programm beenden und auf das Ende des Loaders warten.
stopp() {
  x 'touch /probe/stopp'
  i=0
  while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 15 ] && break
    sleep 1
  done
}
# Strom aus: alles im RAM weg, laufende Programme enden.
strom_aus() {
  x 'touch /probe/stopp'
  sleep 2
  x 'rm -rf /tmp/vp-edge-light /probe/lauf.rc'
}
uhr() { x "printf '%s.00 0.00\n' $1 >/probe/proc/uptime"; }

# programm <ziel> <release> <verhalten>
#   laeuft        laeuft bis /probe/stopp (bestaetigte Fassung)
#   gut           in der Probe: Urteil bestanden
#   offen         in der Probe: Urteil offen "keine Cloud-Verbindung in der Probezeit"
#   durchgefallen in der Probe: Urteil endgueltig nicht bestanden
#   absturz       endet sofort mit Fehler
#   arch          `version` scheitert wie ein Programm der falschen Architektur
#   fassung       `version` nennt eine andere Fassung
programm() {
  x "cat >'$1' <<EOF
#!/bin/sh
case \"\\\$1\" in
  version)
    case '$3' in
      arch) echo 'exec format error' >&2; exit 126 ;;
      fassung) echo edge-light-2099.01.0; exit 0 ;;
    esac
    echo '$2'; exit 0 ;;
esac
echo \"PROGRAMM $2 GESTARTET ota_ram=\\\$VP_OTA_RAM_DIR\"
[ '$3' = absturz ] && exit 3
if [ -f \"\\\$VP_OTA_RAM_DIR/probe.json\" ]; then
  zuw=\\\$(jsonfilter -i \"\\\$VP_OTA_RAM_DIR/probe.json\" -e @.zuweisung)
  case '$3' in
    gut) printf '{\"release\":\"$2\",\"zuweisung\":\"%s\",\"bestanden\":true}' \"\\\$zuw\" >\"\\\$VP_OTA_RAM_DIR/probe-urteil.json\" ;;
    offen) printf '{\"release\":\"$2\",\"zuweisung\":\"%s\",\"bestanden\":false,\"offen\":true,\"grund\":\"keine Cloud-Verbindung in der Probezeit\"}' \"\\\$zuw\" >\"\\\$VP_OTA_RAM_DIR/probe-urteil.json\" ;;
    durchgefallen) printf '{\"release\":\"$2\",\"zuweisung\":\"%s\",\"bestanden\":false,\"grund\":\"Selbsttest nicht bestanden: Steuerpfad\"}' \"\\\$zuw\" >\"\\\$VP_OTA_RAM_DIR/probe-urteil.json\" ;;
  esac
fi
while [ ! -f /probe/stopp ]; do sleep 1; done
EOF
chmod 0755 '$1'"
}

# kandidat <verhalten> <seq> <zuweisung> [kaputt] - wie das Programm (K3) ihn
# ablegt; size/gz_size sind echt (daraus leitet der Loader seine Schwelle ab).
kandidat() {
  programm /probe/kandidat-roh "$NEU" "$1"
  x "mkdir -p $RAM && gzip -9 -n -c /probe/kandidat-roh >$RAM/kandidat.gz
     sha=\$(sha256sum /probe/kandidat-roh | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/kandidat-roh); gzsize=\$(wc -c <$RAM/kandidat.gz)
     [ '${4:-}' = kaputt ] && printf 'x' >>$RAM/kandidat.gz
     printf '{\"release\":\"$NEU\",\"release_seq\":$2,\"arch\":\"linux/mipsle\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"$3\",\"state_schema\":1}' \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
}

# bestaetigt <release> [einzeilig] - die bestaetigte Fassung im Flash
bestaetigt() {
  programm /probe/alt "$1" laeuft
  x "mkdir -p $LD && gzip -9 -n -c /probe/alt >$LD/$N.gz
     sha=\$(sha256sum /probe/alt | cut -d' ' -f1); gz=\$(sha256sum $LD/$N.gz | cut -d' ' -f1)
     if [ '${2:-}' = einzeilig ]; then printf '%s  $N\n' \"\$sha\" >$LD/$N.sha256
     else printf '%s  $N\n%s  $N.gz\n' \"\$sha\" \"\$gz\" >$LD/$N.sha256; fi
     cp $LD/$N.gz /probe/srv/\$gz"
}

frisch() { # frischer Box-Zustand: alte Fassung bestaetigt, keine Marken, RAM leer
  x "touch /probe/stopp; sleep 1; rm -rf /tmp/vp-edge-light /etc/vp-edge-light /probe/lauf.* /probe/srv/*; rm -f /probe/kein-netz"
  bestaetigt "$ALT"
  uhr 1000
}

schritt "Aufbau: OpenWrt-Rootfs ohne Netz"
docker run -d --name "$C" --network none "$BILD" /bin/sleep 3600 >/dev/null 2>&1
x 'mkdir -p /usr/libexec/vp-edge-light /usr/share/vp-edge-light /probe/bin /probe/srv /probe/proc'
docker exec -i "$C" sh -c 'cat >/usr/libexec/vp-edge-light/boot.sh' <"$LOADER"
docker exec -i "$C" sh -c 'cat >/etc/config/vp-edge-light' <"$KONFIG"
x 'uci set vp-edge-light.main.probe_takt=1 && uci set vp-edge-light.main.version_frist=2 && uci commit vp-edge-light
   printf "MemTotal: 121032 kB\nMemAvailable: 90000 kB\n" >/probe/proc/meminfo'
# uclient-fetch-Ersatz: -O <ziel> <url> -> /probe/srv/<letztes Segment>; ohne "Netz" Fehler
x 'cat >/probe/bin/uclient-fetch <<"EOF"
#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in -O) ziel="$2"; shift 2 ;; *) shift ;; esac; done
[ -f /probe/kein-netz ] && exit 4
echo "$1" >>/probe/abrufe
cp "/probe/srv/${1##*/}" "$ziel"
EOF
chmod +x /probe/bin/uclient-fetch'
pruef "Vorgaben: Frist 600 s, 3 Starts" '[ "$(sh -c ". /lib/functions.sh; config_load vp-edge-light; config_get v main probe_frist 600; config_get s main probe_starts 3; echo \$v/\$s")" = 600/3 ]'

schritt "0. Bestand: ota-Symlink, base_url, einzeilige Pruefsumme"
frisch
bestaetigt "$ALT" einzeilig
x "mkdir -p /etc/vp-edge-light /tmp/alt-ota && ln -s /tmp/alt-ota $FEST
   uci set vp-edge-light.main.base_url=https://downloads.example.invalid/edge-light && uci commit vp-edge-light"
lauf
warte "die bestaetigte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "das Programm bekommt VP_OTA_RAM_DIR" "grep -q 'ota_ram=$RAM' /probe/lauf.out"
pruef "ota ist jetzt ein Verzeichnis im Flash" "[ -d $FEST ] && [ ! -L $FEST ]"
pruef "base_url wird ignoriert und gemeldet" 'grep -q "base_url ist abgeschafft" /probe/lauf.err'
pruef "kein Download ueber base_url" '[ ! -f /probe/abrufe ]'
stopp
x 'uci set vp-edge-light.main.base_url="" && uci commit vp-edge-light'

schritt "1. Gut-Fall (P1)"
frisch
kandidat gut 42 z-1
lauf
warte "Marke start im Flash" "grep -qx 'start 42 z-1' $FEST/versuche"
warte "Urteil bestanden -> behalten (Marke ok)" "grep -qx 'ok 42 z-1' $FEST/versuche" 15
pruef "die neue Fassung lief zur Probe" 'grep -q "PROGRAMM edge-light-2026.11.2 GESTARTET" /probe/lauf.out'
pruef "Pruefsummen im Flash: Programm und Kopie der neuen Fassung" \
  "[ \"\$(sed -n 1p $LD/$N.sha256 | cut -d' ' -f1)\" = \"\$(sha256sum /probe/kandidat-roh | cut -d' ' -f1)\" ] && [ \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" = \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" ]"
pruef "groesse-Zeile im Flash (Schwelle des naechsten Starts)" \
  "grep -qx \"groesse \$(wc -c </probe/kandidat-roh | tr -d ' ') \$(wc -c <$LD/$N.gz | tr -d ' ')\" $LD/$N.sha256"
pruef "Kandidat und Probe im RAM aufgeraeumt" "[ ! -f $RAM/kandidat.gz ] && [ ! -f $RAM/kandidat.json ] && [ ! -f $RAM/probe.json ]"
pruef "das Programm laeuft nach dem Behalten weiter" '[ ! -f /probe/lauf.rc ]'
stopp
strom_aus
lauf
warte "nach Strom aus/an startet die neue Fassung aus dem Flash" 'grep -q "PROGRAMM edge-light-2026.11.2 GESTARTET" /probe/lauf.out'
pruef "ohne Abbruch-Marke (die Probe war beendet)" "! grep -q '^abbruch' $FEST/versuche"
stopp

schritt "2. Probestart scheitert (P2)"
frisch
kandidat arch 43 z-2
lauf
warte "zurueck: Probestart gescheitert" "grep -q '^zurueck 43 z-2 Probestart gescheitert: Programm startet nicht' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "keine Marke start (nie zur Probe gestartet)" "! grep -q '^start' $FEST/versuche"
pruef "der Flash ist unveraendert" "[ \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" = \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" ] && gunzip -c $LD/$N.gz | grep -q $ALT"
stopp
frisch
kandidat fassung 44 z-3
lauf
warte "zurueck: meldet eine andere Fassung" "grep -q \"^zurueck 44 z-3 Probestart gescheitert: meldet Fassung 'edge-light-2099.01.0' statt $NEU\" $FEST/versuche"
stopp

schritt "3. Absturz in der Probe (P3)"
frisch
kandidat absturz 45 z-4
for n in 1 2 3; do
  lauf
  warte "Start $n der neuen Fassung endet" '[ -f /probe/lauf.rc ]' 10
done
pruef "nach drei Abstuerzen noch keine Ruecknahme" "! grep -q '^zurueck' $FEST/versuche"
lauf
warte "vierter Start: zurueck statt eines vierten Versuchs" "grep -q '^zurueck 45 z-4 in der Probezeit 3-mal abgestuerzt' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "die neue Fassung lief nicht ein viertes Mal" '! grep -q "PROGRAMM edge-light-2026.11.2" /probe/lauf.out'
stopp

schritt "4. Keine Cloud in der Probezeit (P4/P6)"
frisch
kandidat offen 46 z-5
lauf
warte "Urteil offen" "grep -q '\"offen\":true' $RAM/probe-urteil.json"
sleep 2
pruef "vor der Frist laeuft die Probe weiter" '[ ! -f /probe/lauf.rc ]'
uhr 1601
warte "Frist um: der Waechter beendet das Programm" '[ -f /probe/lauf.rc ]' 15
lauf
warte "zurueck mit dem Grund des offenen Urteils" "grep -q '^zurueck 46 z-5 keine Cloud-Verbindung in der Probezeit' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
stopp

schritt "5. Selbsttest durchgefallen"
frisch
kandidat durchgefallen 47 z-6
lauf
warte "der Waechter beendet die Probe sofort" '[ -f /probe/lauf.rc ]' 15
lauf
warte "zurueck mit dem Grund des Selbsttests" "grep -q '^zurueck 47 z-6 Selbsttest nicht bestanden: Steuerpfad' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
stopp

schritt "6. Faelschung im RAM (P10)"
frisch
kandidat gut 48 z-7 kaputt
lauf
warte "zurueck: Lieferung passt nicht" "grep -q '^zurueck 48 z-7 Lieferung im RAM passt nicht zur Pruefsumme' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "nie gestartet" '! grep -q "PROGRAMM edge-light-2026.11.2" /probe/lauf.out'
stopp

schritt "7. Strom weg in der Probe (P8)"
frisch
for n in 1 2; do
  kandidat offen 49 z-8
  lauf
  warte "Probe $n laeuft" "[ -f $RAM/probe.json ] && grep -q 'PROGRAMM edge-light-2026.11.2' /probe/lauf.out"
  strom_aus
  lauf
  warte "kalter Start $n: die alte Fassung startet" 'grep -q "PROGRAMM edge-light-2026.11.1 GESTARTET" /probe/lauf.out'
  stopp
done
pruef "zwei Abbruch-Marken (das Programm gibt danach auf, otalight.AbbruchMax)" "[ \"\$(grep -c '^abbruch 49 z-8' $FEST/versuche)\" = 2 ]"

schritt "8. Strom weg beim Flash-Tausch (P9)"
frisch
kandidat gut 50 z-9
x "cp $RAM/kandidat.gz /probe/srv/\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)"
lauf
warte "behalten" "grep -qx 'ok 50 z-9' $FEST/versuche" 15
stopp
for art in halb fehlt; do
  strom_aus
  if [ "$art" = halb ]; then x "head -c 300 $LD/$N.gz >/probe/h && mv /probe/h $LD/$N.gz"; else x "rm -f $LD/$N.gz"; fi
  x 'rm -f /probe/abrufe'
  lauf
  warte "Kopie $art: genau diese Fassung wird nachgeladen und gestartet" 'grep -q "PROGRAMM edge-light-2026.11.2 GESTARTET" /probe/lauf.out'
  pruef "Kopie $art: abgerufen nach ihrer Pruefsumme" "grep -q \"/api/v1/edge/light-programm/\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" /probe/abrufe"
  pruef "Kopie $art: die Kopie im Flash ist wiederhergestellt" "[ \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" = \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" ]"
  stopp
done
strom_aus
x "rm -f $LD/$N.gz; touch /probe/kein-netz"
lauf
warte "ohne Netz: kein Start, Exit 1 (procd versucht es weiter)" '[ "$(cat /probe/lauf.rc 2>/dev/null)" = 1 ]'
pruef "nennt den Grund" 'grep -q "kein startbares Programm" /probe/lauf.err'
x 'rm -f /probe/kein-netz'

schritt "9. Marken im Flash: feste Obergrenze"
frisch
x "mkdir -p $FEST && i=0; while [ \$i -lt 60 ]; do echo \"ok \$i z\" >>$FEST/versuche; i=\$((i+1)); done"
kandidat fassung 51 z-10
lauf
warte "Ruecknahme geschrieben" "grep -q '^zurueck 51 z-10' $FEST/versuche"
pruef "hoechstens 40 Zeilen" "[ \"\$(wc -l <$FEST/versuche)\" -le 40 ]"
stopp

schritt "10. Mit dem echten Programm (amd64)"
ECHT="$HIER/../dist/vp-edge-light-linux-amd64"
if [ -f "$ECHT" ]; then
  frisch
  docker cp "$ECHT" "$C:/probe/echt" >/dev/null
  x "uci set vp-edge-light.main.portal_url=http://127.0.0.1:9 && uci commit vp-edge-light
     rel=\$(/probe/echt version) && echo \$rel >/probe/echt.version
     mkdir -p $RAM && gzip -1 -n -c /probe/echt >$RAM/kandidat.gz
     sha=\$(sha256sum /probe/echt | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/echt); gzsize=\$(wc -c <$RAM/kandidat.gz)
     printf '{\"release\":\"%s\",\"release_seq\":60,\"arch\":\"linux/amd64\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"z-echt\",\"state_schema\":1}' \"\$rel\" \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
  lauf
  warte "Probestart mit dem echten Programm bestanden (Marke start)" "grep -qx 'start 60 z-echt' $FEST/versuche"
  warte "das Programm urteilt: offen, keine Cloud" "grep -q '\"offen\":true' $RAM/probe-urteil.json && grep -q 'keine Cloud-Verbindung in der Probezeit' $RAM/probe-urteil.json && grep -q 'z-echt' $RAM/probe-urteil.json" 120
  pruef "ohne Cloud wird nichts behalten" "! grep -q '^ok 60' $FEST/versuche && [ -f $RAM/probe.json ]"
  pruef "die Zuweisung des Programms liegt nicht im Flash" "[ ! -f $FEST/target.json ] && [ ! -f $FEST/core-signal.json ]"
  x 'kill $(pidof vp-edge-light) 2>/dev/null; sleep 2' || true
else
  echo "  uebersprungen: $ECHT fehlt (edge-light/scripts/build.sh amd64)"
fi

schritt "11. Lader-Selbstupdate mit dem echten Programm (amd64)"
# Das bestaetigte Programm erneuert Loader und Dienst-Init aus seinen
# eingebetteten Kopien (agent/loader_pflege). Ein gruenes Behalten braucht die
# Cloud, die es hier nicht gibt - die bestaetigte Fassung unter einem alten
# Loader IST der Zustand nach "behalten" (alter Loader + neues Programm).
# Die eingebetteten Kopien muessen dem Repo-Stand entsprechen: erst
# edge-light/scripts/build.sh amd64, sonst scheitert der Byte-Vergleich.
if [ -f "$ECHT" ]; then
  LADER=/usr/libexec/vp-edge-light/boot.sh
  INIT=/etc/init.d/vp-edge-light
  STAND="$(sed -n 's/^LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$LOADER")"
  docker cp "$LOADER" "$C:/probe/loader-soll" >/dev/null
  docker cp "$HIER/../openwrt/files/etc/init.d/vp-edge-light" "$C:/probe/init-soll" >/dev/null

  echo "-- 11a. waehrend der Probe spielt das Programm nichts ein"
  frisch
  # Der alte Loader der Mangos im Feld: kennt Updates, traegt aber keine
  # LOADER_STAND-Marke (hier: der aktuelle Stand ohne Marke und Stand-Meldung).
  x "sed '/^LOADER_STAND=/d; /Loader Stand/d' $LADER >/probe/alt-loader && cat /probe/alt-loader >$LADER
     rm -f $INIT"
  x "mkdir -p $RAM && gzip -1 -n -c /probe/echt >$RAM/kandidat.gz
     rel=\$(/probe/echt version)
     sha=\$(sha256sum /probe/echt | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/echt); gzsize=\$(wc -c <$RAM/kandidat.gz)
     printf '{\"release\":\"%s\",\"release_seq\":70,\"arch\":\"linux/amd64\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"z-lader\",\"state_schema\":1}' \"\$rel\" \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
  lauf
  warte "die echte Fassung startet zur Probe (Marke start)" "grep -qx 'start 70 z-lader' $FEST/versuche" 60
  # Die erste Pflege-Pruefung des Programms kommt nach ~30 s - sie muss die
  # Probe sehen und still bleiben.
  sleep 40
  pruef "waehrend der Probe bleibt der alte Loader (keine Marke)" "! grep -q '^LOADER_STAND=' $LADER"
  pruef "die Probe laeuft weiter" "[ -f $RAM/probe.json ]"
  # Das echte Programm beachtet /probe/stopp nicht: erst beenden und auf das
  # Ende des 11a-Loaders warten, sonst haelt es 8484/1883 besetzt und der
  # naechste Start stirbt am belegten Port.
  x 'kill $(pidof vp-edge-light) 2>/dev/null' || true
  i=0; while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 15 ] && break; sleep 1; done
  strom_aus

  echo "-- 11b. als bestaetigte Fassung: Loader und Dienst-Init werden erneuert"
  x "gzip -1 -n -c /probe/echt >$LD/$N.gz
     sha=\$(sha256sum /probe/echt | cut -d' ' -f1); gz=\$(sha256sum $LD/$N.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/echt); gzsize=\$(wc -c <$LD/$N.gz)
     printf '%s  $N\n%s  $N.gz\ngroesse %s %s\n' \"\$sha\" \"\$gz\" \"\$size\" \"\$gzsize\" >$LD/$N.sha256"
  # Strom weg mitten in einem frueheren Lader-Schreiben: der halbe Rest stoert
  # nicht und verschwindet.
  x "printf 'halb geschrie' >$LADER.neu"
  lauf
  warte "das bestaetigte Programm spielt den Loader ein (LOADER_STAND=$STAND)" "grep -qx 'LOADER_STAND=$STAND' $LADER" 90
  pruef "boot.sh ist byte-gleich mit der eingebetteten Kopie" "cmp -s $LADER /probe/loader-soll"
  pruef "das Init-Skript liegt daneben, byte-gleich" "cmp -s $INIT /probe/init-soll"
  pruef "kein halber Schreibrest mehr (.neu)" "[ ! -f $LADER.neu ] && [ ! -f $INIT.neu ]"
  pruef "das Programm laeuft dabei weiter" '[ ! -f /probe/lauf.rc ]'
  x 'kill $(pidof vp-edge-light) 2>/dev/null' || true
  i=0; while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 15 ] && break; sleep 1; done

  echo "-- 11c. der neue Loader meldet seinen Stand; ein zweiter Start schreibt nichts"
  VOR_LADER="$(x "date -r $LADER +%s")"
  VOR_INIT="$(x "date -r $INIT +%s")"
  lauf
  warte "der neue Loader meldet seinen Stand" "grep -q 'Loader Stand $STAND' /probe/lauf.err" 30
  warte "die bestaetigte Fassung laeuft wieder" 'pidof vp-edge-light' 30
  # Auch die zweite Pflege-Pruefung (nach ~30 s) darf nichts schreiben.
  sleep 40
  pruef "zweiter Start schreibt nichts (boot.sh unveraendert)" "[ \"\$(date -r $LADER +%s)\" = '$VOR_LADER' ]"
  pruef "zweiter Start schreibt nichts (Init unveraendert)" "[ \"\$(date -r $INIT +%s)\" = '$VOR_INIT' ]"
  x 'kill $(pidof vp-edge-light) 2>/dev/null; sleep 2' || true
  x 'uci set vp-edge-light.main.portal_url=https://portal.voltpilot.de && uci commit vp-edge-light'
else
  echo "  uebersprungen: $ECHT fehlt (edge-light/scripts/build.sh amd64)"
fi

echo
echo "$OK bestanden, $FEHLER fehlgeschlagen"
[ "$FEHLER" = 0 ]
