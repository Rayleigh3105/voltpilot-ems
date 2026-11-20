#!/bin/sh
# Probe fuer das Update im Loader des WAGO PFC200
# (files/home/voltpilot/libexec/boot.sh) in einem BusyBox-Linux fuer ARMv7
# (busybox:1.34.1-glibc, wie die WAGO-Firmware 27: glibc, BusyBox 1.34.1) -
# ohne PFC200 und ohne Netz. Das Gegenstueck zu boot-update-probe.sh der
# Mango: DIESELBEN Faelle, damit belegt ist, dass der PFC200 dasselbe
# Protokoll spricht - ohne jsonfilter, uci und procd, und als Benutzer
# voltpilot statt root.
#
# Die "Programme" der Faelle 0-9 sind kleine Skripte, die sich verhalten wie
# die Fassungen im Laborbeweis: sie beantworten `version`, schreiben in der
# Probe ihr Urteil (probe-urteil.json, Format otalight.Urteil) und laufen, bis
# /probe/stopp existiert. Zeit und Speicher stellt die Probe ueber
# VP_LOADER_PROC nach (uptime, meminfo); wget ersetzt ein Skript, das aus
# /probe/srv liefert (oder ohne "Netz" scheitert).
#
#   0. Start: die bestaetigte Fassung startet; das Programm bekommt
#      VP_OTA_RAM_DIR, fest VP_MIRROR_PORT=1502 und leere Loader-Pfade - auch
#      gegen env-Zeilen der Einstellungen; env-Zeilen mit Leerzeichen kommen
#      an, ungueltige nicht; einzeilige Pruefsumme startet; zu wenig Speicher:
#      kein Start, mit Grund
#   1. Gut-Fall (P1): tauschen, Probe, Urteil bestanden -> behalten
#      (Pruefsummen, Kopie, Marke ok); nach Strom aus/an laeuft die neue
#   2. Probestart scheitert (P2): falsche Architektur / falsche Fassung
#   3. Absturz (P3): drei Abstuerze in der Probe -> zurueck, kein vierter
#   4. Keine Cloud (P4/P6): Urteil offen, Frist um -> Waechter beendet,
#      zurueck mit dem Grund des offenen Urteils
#   5. Selbsttest durchgefallen: sofort zurueck mit Grund (das Urteil als
#      eingeruecktes JSON mit Gefuege und Maskierungen: der JSON-Leser des
#      Loaders liest es wie jsonfilter)
#   6. Faelschung im RAM (P10): Lieferung passt nicht zu kandidat.json
#   7. Strom weg in der Probe (P8): kalter Start schreibt "abbruch", alte laeuft
#   8. Strom weg beim Flash-Tausch (P9): Kopie unvollstaendig -> genau diese
#      Fassung nachladen und pruefen; ohne Netz kein Start
#   9. Marken: feste Obergrenze im Flash
#  10. mit dem ECHTEN Programm fuer ARMv7 (edge-industrie/dist/vp-edge-industrie-linux-arm,
#      wenn gebaut): Probestart, probe.json vom Loader, Selbsttest des
#      Programms ohne Cloud -> Urteil offen; nach der Frist nimmt der Loader
#      mit dem Grund aus dem Urteil des Programms zurueck
#  11. kein Loader-Selbstupdate (echtes Programm): als bestaetigte Fassung
#      schreibt es weder an den Pfad des Mango-Loaders (auch wenn es dort
#      duerfte) noch aendert es den Loader des PFC200
#
#   edge-industrie/scripts/build.sh
#   edge-industrie/test/update-probe.sh
#   VPPU_LOADER=<pfad>/boot.sh ...   Gegenprobe mit einem anderen Stand
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; Ausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
LOADER="${VPPU_LOADER:-$HIER/../files/home/voltpilot/libexec/boot.sh}"
KONFIG="$HIER/../files/home/voltpilot/konfig"
BILD="${VPPU_BILD:-busybox:1.34.1-glibc}"
PLATTFORM=linux/arm/v7
C="vppu-$$"
ARBEIT="$(mktemp -d)"
OK=0
FEHLER=0
ALT=edge-industrie-2026.11.1
NEU=edge-industrie-2026.11.2
LADER=/home/voltpilot/libexec/boot.sh
LD=/home/voltpilot/fassung
N=vp-edge-industrie-linux-arm
RAM=/tmp/vp-edge-industrie/ota
FEST=/home/voltpilot/daten/ota

aufraeumen() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  rm -rf "$ARBEIT"
}
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
# x: als Benutzer voltpilot (so laufen Loader und Programm); r: als root.
x() { docker exec -u voltpilot "$C" sh -c "$*"; }
r() { docker exec "$C" sh -c "$*"; }
pruef() { # pruef <beschreibung> <bedingung im container>
  if x "$2" >/dev/null 2>&1; then ok "$1"; else falsch "$1"; zeige; fi
}
zeige() { x "for f in /probe/lauf.err $FEST/versuche; do echo \"    --- \$f\"; sed 's/^/    | /' \"\$f\" 2>/dev/null | tail -n 12; done" || true; }
warte() { # warte <beschreibung> <bedingung> [sekunden]
  i=0
  while ! x "$2" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "${3:-40}" ]; then falsch "$1 (Zeitueberschreitung)"; zeige; return 0; fi
    sleep 1
  done
  ok "$1"
}

# Loader im Hintergrund (eine Probe blockiert, solange das Programm laeuft).
# VP_WAGO_BESTELLNUMMER reicht sonst das Dienst-Skript herein.
lauf() {
  x 'rm -f /probe/lauf.rc /probe/stopp; : >/probe/lauf.out; : >/probe/lauf.err'
  docker exec -d -u voltpilot "$C" sh -c "PATH=/probe/bin:\$PATH VP_LOADER_PROC=/probe/proc VP_WAGO_BESTELLNUMMER=750-8212 sh $LADER >>/probe/lauf.out 2>>/probe/lauf.err; echo \$? >/probe/lauf.rc"
}
# Programm beenden und auf das Ende des Loaders warten.
stopp() {
  x 'touch /probe/stopp'
  i=0
  while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 20 ] && break
    sleep 1
  done
}
# Strom aus: alles im RAM weg, laufende Programme enden.
strom_aus() {
  x 'touch /probe/stopp'
  sleep 2
  x 'rm -rf /tmp/vp-edge-industrie /probe/lauf.rc'
}
uhr() { x "printf '%s.00 0.00\n' $1 >/probe/proc/uptime"; }
# ksetze <schluessel> <wert> - eine Angabe in den Einstellungen (root).
ksetze() {
  r "if grep -q '^$1 = ' /home/voltpilot/konfig; then sed 's|^$1 = .*|$1 = $2|' /home/voltpilot/konfig >/tmp/k && cat /tmp/k >/home/voltpilot/konfig; else echo '$1 = $2' >>/home/voltpilot/konfig; fi; rm -f /tmp/k"
}

# programm <ziel> <release> <verhalten>
#   laeuft        laeuft bis /probe/stopp (bestaetigte Fassung)
#   gut           in der Probe: Urteil bestanden
#   offen         in der Probe: Urteil offen "keine Cloud-Verbindung in der Probezeit"
#   durchgefallen in der Probe: Urteil endgueltig nicht bestanden
#   absturz       endet sofort mit Fehler
#   arch          `version` scheitert wie ein Programm der falschen Architektur
#   fassung       `version` nennt eine andere Fassung
cat >"$ARBEIT/programm.vorlage" <<'EOF'
#!/bin/sh
case "$1" in
  version)
    case '@ART@' in
      arch) echo 'exec format error' >&2; exit 126 ;;
      fassung) echo edge-industrie-2099.01.0; exit 0 ;;
    esac
    echo '@REL@'; exit 0 ;;
esac
echo "PROGRAMM @REL@ GESTARTET ota_ram=$VP_OTA_RAM_DIR"
env >/probe/umgebung
[ '@ART@' = absturz ] && exit 3
if [ -f "$VP_OTA_RAM_DIR/probe.json" ]; then
  zuw=$(sed -n 's/.*"zuweisung":"\([^"]*\)".*/\1/p' "$VP_OTA_RAM_DIR/probe.json")
  case '@ART@' in
    gut) printf '{"release":"@REL@","zuweisung":"%s","bestanden":true}' "$zuw" >"$VP_OTA_RAM_DIR/probe-urteil.json" ;;
    offen) printf '{"release":"@REL@","zuweisung":"%s","bestanden":false,"offen":true,"grund":"keine Cloud-Verbindung in der Probezeit"}' "$zuw" >"$VP_OTA_RAM_DIR/probe-urteil.json" ;;
    durchgefallen)
      # Eingerueckt, mit einem Gefuege davor (dessen "zuweisung" nicht zaehlt)
      # und Maskierungen im Grund.
      sed "s/@ZUW@/$zuw/" >"$VP_OTA_RAM_DIR/probe-urteil.json.tmp" <<'JSON'
{
  "release": "@REL@",
  "anhang": {"zuweisung": "falsch", "liste": [1, "}", {"offen": true}]},
  "zuweisung": "@ZUW@",
  "bestanden": false,
  "offen": null,
  "grund": "Selbsttest nicht bestanden: \"Steuerpfad\" gepr\u00fcft"
}
JSON
      mv "$VP_OTA_RAM_DIR/probe-urteil.json.tmp" "$VP_OTA_RAM_DIR/probe-urteil.json"
      ;;
  esac
fi
while [ ! -f /probe/stopp ]; do sleep 1; done
EOF
programm() {
  sed -e "s/@REL@/$2/g" -e "s/@ART@/$3/g" "$ARBEIT/programm.vorlage" |
    docker exec -i -u voltpilot "$C" sh -c "cat >'$1' && chmod 0755 '$1'"
}

# kandidat <verhalten> <seq> <zuweisung> [kaputt] - wie das Programm (K3) ihn
# ablegt; size/gz_size sind echt (daraus leitet der Loader seine Schwelle ab).
kandidat() {
  programm /probe/kandidat-roh "$NEU" "$1"
  x "mkdir -p $RAM && gzip -9 -n -c /probe/kandidat-roh >$RAM/kandidat.gz
     sha=\$(sha256sum /probe/kandidat-roh | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/kandidat-roh); gzsize=\$(wc -c <$RAM/kandidat.gz)
     [ '${4:-}' = kaputt ] && printf 'x' >>$RAM/kandidat.gz
     printf '{\"release\":\"$NEU\",\"release_seq\":$2,\"arch\":\"linux/arm\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"$3\",\"state_schema\":1}' \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
}

# bestaetigt <release> [einzeilig] - die bestaetigte Fassung im Flash
bestaetigt() {
  programm /probe/alt "$1" laeuft
  x "gzip -9 -n -c /probe/alt >$LD/$N.gz
     sha=\$(sha256sum /probe/alt | cut -d' ' -f1); gz=\$(sha256sum $LD/$N.gz | cut -d' ' -f1)
     if [ '${2:-}' = einzeilig ]; then printf '%s  $N\n' \"\$sha\" >$LD/$N.sha256
     else printf '%s  $N\n%s  $N.gz\n' \"\$sha\" \"\$gz\" >$LD/$N.sha256; fi
     cp $LD/$N.gz /probe/srv/\$gz"
}

frisch() { # frischer Box-Zustand: alte Fassung bestaetigt, keine Marken, RAM leer
  x 'touch /probe/stopp'
  sleep 1
  r "rm -rf /tmp/vp-edge-industrie /home/voltpilot/daten $LD /probe/lauf.* /probe/srv/* /probe/kein-netz /probe/umgebung /probe/abrufe
     mkdir -p /home/voltpilot/daten $LD && chown voltpilot /home/voltpilot/daten $LD && chmod 0700 /home/voltpilot/daten"
  bestaetigt "$ALT"
  uhr 1000
}

schritt "Aufbau: BusyBox-Linux fuer ARMv7 ohne Netz, Benutzer voltpilot"
mkdir -p "$ARBEIT/etc"
printf '::sysinit:/bin/true\n' >"$ARBEIT/etc/inittab"
docker create --name "$C" --platform "$PLATTFORM" --network none "$BILD" /bin/init >/dev/null
docker cp "$ARBEIT/etc/inittab" "$C:/etc/inittab" >/dev/null
docker start "$C" >/dev/null
r 'adduser -D -H -h /home/voltpilot -s /bin/false voltpilot
   mkdir -p /home/voltpilot/libexec /probe/bin /probe/srv /probe/proc && chown -R voltpilot /probe'
docker exec -i "$C" sh -c "cat >$LADER && chmod 0755 $LADER" <"$LOADER"
docker exec -i "$C" sh -c 'cat >/home/voltpilot/konfig' <"$KONFIG"
ksetze probe_takt 1
ksetze version_frist 2
x 'printf "MemTotal: 504000 kB\nMemAvailable: 90000 kB\n" >/probe/proc/meminfo'
# wget-Ersatz: -O <ziel> <url> -> /probe/srv/<letztes Segment>; ohne "Netz" Fehler
x 'cat >/probe/bin/wget <<"EOF"
#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in -O) ziel="$2"; shift 2 ;; *) shift ;; esac; done
[ -f /probe/kein-netz ] && exit 4
echo "$1" >>/probe/abrufe
cp "/probe/srv/${1##*/}" "$ziel"
EOF
chmod +x /probe/bin/wget'
pruef "ARMv7, der Loader gehoert root, die Probe laeuft als voltpilot" '[ "$(uname -m)" = armv7l ] && [ "$(stat -c %U '"$LADER"')" = root ] && [ "$(id -un)" = voltpilot ]'
pruef "kein jsonfilter, kein uci (der Loader braucht sie nicht)" '! command -v jsonfilter && ! command -v uci'

schritt "0. Start: Umgebung des Programms, einzeilige Pruefsumme, Speicher"
frisch
bestaetigt "$ALT" einzeilig
r "printf '%s\n' 'env = VP_REF=VP-1234' 'env = VP_PROBE_TEXT=zwei Worte = ja' 'env = VP_MIRROR_PORT=502' 'env = VP_LOADER_PATH=/tmp/fremd.sh' 'env = VP_WAGO_BESTELLNUMMER=750-0000' 'env = 9FALSCH=x' 'env = ohne-gleich' >>/home/voltpilot/konfig"
lauf
warte "die bestaetigte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "das Programm bekommt VP_OTA_RAM_DIR, Datenverzeichnis, Web-Adresse" "grep -q 'ota_ram=$RAM' /probe/lauf.out && grep -qx 'VP_DATA_DIR=/home/voltpilot/daten' /probe/umgebung && grep -qx 'VP_HTTP_ADDR=:8484' /probe/umgebung"
pruef "env-Zeilen kommen an, auch mit Leerzeichen und Gleichheitszeichen im Wert" "grep -qx 'VP_REF=VP-1234' /probe/umgebung && grep -qx 'VP_PROBE_TEXT=zwei Worte = ja' /probe/umgebung"
pruef "VP_MIRROR_PORT ist fest 1502 - eine env-Zeile aendert das nicht" "[ \"\$(grep -c '^VP_MIRROR_PORT=' /probe/umgebung)\" = 1 ] && grep -qx 'VP_MIRROR_PORT=1502' /probe/umgebung"
pruef "die Loader-Pfade sind leer - eine env-Zeile aendert das nicht" "grep -qx 'VP_LOADER_PATH=' /probe/umgebung && grep -qx 'VP_LOADER_INIT_PATH=' /probe/umgebung"
pruef "die Bestellnummer kommt vom Dienst-Skript, nicht aus den Einstellungen" "grep -qx 'VP_WAGO_BESTELLNUMMER=750-8212' /probe/umgebung"
pruef "ungueltige env-Zeilen werden uebergangen und gemeldet" "! grep -q -e '9FALSCH' -e 'ohne-gleich' /probe/umgebung && [ \"\$(grep -c 'env-Zeile ohne' /probe/lauf.err)\" = 2 ]"
pruef "der Loader meldet seinen Stand" "grep -q 'Loader PFC Stand $(sed -n 's/^PFC_LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$LOADER") ' /probe/lauf.err"
pruef "was laufend geschrieben wird, liegt im RAM (Links im Datenverzeichnis)" '[ "$(readlink /home/voltpilot/daten/buffer)" = /tmp/vp-edge-industrie/buffer ] && [ -L /home/voltpilot/daten/ocpp-journal ]'
pruef "kein Download" '[ ! -f /probe/abrufe ]'
stopp
r "sed '/^env = /d' /home/voltpilot/konfig >/tmp/k && cat /tmp/k >/home/voltpilot/konfig && rm -f /tmp/k"
strom_aus
x 'printf "MemTotal: 504000 kB\nMemAvailable: 9000 kB\n" >/probe/proc/meminfo'
lauf
warte "zu wenig Speicher: kein Start, Exit 1 (der Dienst versucht es weiter)" '[ "$(cat /probe/lauf.rc 2>/dev/null)" = 1 ]'
pruef "nennt den gemessenen Wert und die Folge" 'grep -q "zu wenig freier Speicher (9000 kB < 40000 kB) - lokale Kopie nicht entpackt" /probe/lauf.err && ! grep -q "PROGRAMM" /probe/lauf.out'
x 'printf "MemTotal: 504000 kB\nMemAvailable: 90000 kB\n" >/probe/proc/meminfo'

schritt "1. Gut-Fall (P1)"
frisch
kandidat gut 42 z-1
lauf
warte "Marke start im Flash" "grep -qx 'start 42 z-1' $FEST/versuche"
warte "Urteil bestanden -> behalten (Marke ok)" "grep -qx 'ok 42 z-1' $FEST/versuche"
pruef "die neue Fassung lief zur Probe" 'grep -q "PROGRAMM edge-industrie-2026.11.2 GESTARTET" /probe/lauf.out'
pruef "Pruefsummen im Flash: Programm und Kopie der neuen Fassung" \
  "[ \"\$(sed -n 1p $LD/$N.sha256 | cut -d' ' -f1)\" = \"\$(sha256sum /probe/kandidat-roh | cut -d' ' -f1)\" ] && [ \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" = \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" ]"
pruef "groesse-Zeile im Flash (Schwelle des naechsten Starts)" \
  "grep -qx \"groesse \$(wc -c </probe/kandidat-roh | tr -d ' ') \$(wc -c <$LD/$N.gz | tr -d ' ')\" $LD/$N.sha256"
pruef "Kandidat und Probe im RAM aufgeraeumt" "[ ! -f $RAM/kandidat.gz ] && [ ! -f $RAM/kandidat.json ] && [ ! -f $RAM/probe.json ]"
pruef "das Programm laeuft nach dem Behalten weiter" '[ ! -f /probe/lauf.rc ]'
stopp
strom_aus
lauf
warte "nach Strom aus/an startet die neue Fassung aus dem Flash" 'grep -q "PROGRAMM edge-industrie-2026.11.2 GESTARTET" /probe/lauf.out'
pruef "ohne Abbruch-Marke (die Probe war beendet)" "! grep -q '^abbruch' $FEST/versuche"
stopp

schritt "2. Probestart scheitert (P2)"
frisch
kandidat arch 43 z-2
lauf
warte "zurueck: Probestart gescheitert" "grep -q '^zurueck 43 z-2 Probestart gescheitert: Programm startet nicht' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "keine Marke start (nie zur Probe gestartet)" "! grep -q '^start' $FEST/versuche"
pruef "der Flash ist unveraendert" "[ \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" = \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" ] && gunzip -c $LD/$N.gz | grep -q $ALT"
stopp
frisch
kandidat fassung 44 z-3
lauf
warte "zurueck: meldet eine andere Fassung" "grep -q \"^zurueck 44 z-3 Probestart gescheitert: meldet Fassung 'edge-industrie-2099.01.0' statt $NEU\" $FEST/versuche"
stopp

schritt "3. Absturz in der Probe (P3)"
frisch
kandidat absturz 45 z-4
for n in 1 2 3; do
  lauf
  warte "Start $n der neuen Fassung endet" '[ -f /probe/lauf.rc ]'
done
pruef "nach drei Abstuerzen noch keine Ruecknahme" "! grep -q '^zurueck' $FEST/versuche"
lauf
warte "vierter Start: zurueck statt eines vierten Versuchs" "grep -q '^zurueck 45 z-4 in der Probezeit 3-mal abgestuerzt' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "die neue Fassung lief nicht ein viertes Mal" '! grep -q "PROGRAMM edge-industrie-2026.11.2" /probe/lauf.out'
stopp

schritt "4. Keine Cloud in der Probezeit (P4/P6)"
frisch
kandidat offen 46 z-5
lauf
warte "Urteil offen" "grep -q '\"offen\":true' $RAM/probe-urteil.json"
sleep 3
pruef "vor der Frist laeuft die Probe weiter" '[ ! -f /probe/lauf.rc ]'
uhr 1601
warte "Frist um: der Waechter beendet das Programm" '[ -f /probe/lauf.rc ]'
lauf
warte "zurueck mit dem Grund des offenen Urteils" "grep -q '^zurueck 46 z-5 keine Cloud-Verbindung in der Probezeit' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
stopp

schritt "5. Selbsttest durchgefallen"
frisch
kandidat durchgefallen 47 z-6
lauf
warte "der Waechter beendet die Probe sofort" '[ -f /probe/lauf.rc ]'
lauf
# Der Grund traegt ein Anfuehrungszeichen und ein ue als \u00fc (zwei Bytes).
warte "zurueck mit dem Grund des Selbsttests (Maskierungen aufgeloest)" "grep -q '^zurueck 47 z-6 Selbsttest nicht bestanden: \"Steuerpfad\" gepr..ft\$' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
stopp

schritt "6. Faelschung im RAM (P10)"
frisch
kandidat gut 48 z-7 kaputt
lauf
warte "zurueck: Lieferung passt nicht" "grep -q '^zurueck 48 z-7 Lieferung im RAM passt nicht zur Pruefsumme' $FEST/versuche"
warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
pruef "nie gestartet" '! grep -q "PROGRAMM edge-industrie-2026.11.2" /probe/lauf.out'
stopp

schritt "7. Strom weg in der Probe (P8)"
frisch
for n in 1 2; do
  kandidat offen 49 z-8
  lauf
  warte "Probe $n laeuft" "[ -f $RAM/probe.json ] && grep -q 'PROGRAMM edge-industrie-2026.11.2' /probe/lauf.out"
  strom_aus
  lauf
  warte "kalter Start $n: die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
  stopp
done
pruef "zwei Abbruch-Marken (das Programm gibt danach auf, otalight.AbbruchMax)" "[ \"\$(grep -c '^abbruch 49 z-8' $FEST/versuche)\" = 2 ]"

schritt "8. Strom weg beim Flash-Tausch (P9)"
frisch
kandidat gut 50 z-9
x "cp $RAM/kandidat.gz /probe/srv/\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)"
lauf
warte "behalten" "grep -qx 'ok 50 z-9' $FEST/versuche"
stopp
for art in halb fehlt; do
  strom_aus
  if [ "$art" = halb ]; then x "head -c 300 $LD/$N.gz >/probe/h && mv /probe/h $LD/$N.gz"; else x "rm -f $LD/$N.gz"; fi
  x 'rm -f /probe/abrufe'
  lauf
  warte "Kopie $art: genau diese Fassung wird nachgeladen und gestartet" 'grep -q "PROGRAMM edge-industrie-2026.11.2 GESTARTET" /probe/lauf.out'
  pruef "Kopie $art: abgerufen nach ihrer Pruefsumme" "grep -q \"/api/v1/edge/light-programm/\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" /probe/abrufe"
  pruef "Kopie $art: die Kopie im Flash ist wiederhergestellt" "[ \"\$(sha256sum $LD/$N.gz | cut -d' ' -f1)\" = \"\$(sed -n 2p $LD/$N.sha256 | cut -d' ' -f1)\" ]"
  stopp
done
strom_aus
x "rm -f $LD/$N.gz; touch /probe/kein-netz"
lauf
warte "ohne Netz: kein Start, Exit 1 (der Dienst versucht es weiter)" '[ "$(cat /probe/lauf.rc 2>/dev/null)" = 1 ]'
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

ECHT="$HIER/../dist/vp-edge-industrie-linux-arm"
# Das echte Programm beachtet /probe/stopp nicht: beenden und auf das Ende des
# Loaders warten, sonst haelt es 8484/1883 besetzt. Die Klammer im Muster:
# pkill findet so nicht die Befehlszeile, die es aufruft.
echt_ende() {
  x 'pkill -f "/tmp/vp-edge-industrie/vp-edge[-]industrie"' || true
  i=0
  while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 20 ] && break; sleep 1; done
}
echt_laeuft='pgrep -f "/tmp/vp-edge-industrie/vp-edge[-]industrie"'

schritt "10. Mit dem echten Programm (ARMv7)"
if [ -f "$ECHT" ]; then
  frisch
  docker cp "$ECHT" "$C:/probe/echt" >/dev/null
  r 'chown voltpilot /probe/echt'
  ksetze portal_url http://127.0.0.1:9
  x "rel=\$(/probe/echt version) && echo \$rel >/probe/echt.version
     mkdir -p $RAM && gzip -1 -n -c /probe/echt >$RAM/kandidat.gz
     sha=\$(sha256sum /probe/echt | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/echt); gzsize=\$(wc -c <$RAM/kandidat.gz)
     printf '{\"release\":\"%s\",\"release_seq\":60,\"arch\":\"linux/arm\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"z-echt\",\"state_schema\":1}' \"\$rel\" \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
  # Der Probestart des echten Programms braucht im Emulator laenger als 2 s.
  ksetze version_frist 20
  lauf
  warte "Probestart mit dem echten Programm bestanden (Marke start)" "grep -qx 'start 60 z-echt' $FEST/versuche" 90
  warte "das Programm urteilt: offen, keine Cloud" "grep -q '\"offen\":true' $RAM/probe-urteil.json && grep -q 'keine Cloud-Verbindung in der Probezeit' $RAM/probe-urteil.json && grep -q 'z-echt' $RAM/probe-urteil.json" 240
  pruef "ohne Cloud wird nichts behalten" "! grep -q '^ok 60' $FEST/versuche && [ -f $RAM/probe.json ]"
  pruef "die Zuweisung des Programms liegt nicht im Flash" "[ ! -f $FEST/target.json ] && [ ! -f $FEST/core-signal.json ]"
  pruef "das echte Programm laeuft mit VP_MIRROR_PORT=1502 und leeren Loader-Pfaden" \
    "p=\$($echt_laeuft | head -n 1) && tr '\\000' '\\n' </proc/\$p/environ >/probe/echt.umgebung && grep -qx 'VP_MIRROR_PORT=1502' /probe/echt.umgebung && grep -qx 'VP_LOADER_PATH=' /probe/echt.umgebung && grep -qx 'VP_OTA_RAM_DIR=$RAM' /probe/echt.umgebung"
  uhr 1601
  warte "Frist um: der Waechter beendet das echte Programm (TERM)" '[ -f /probe/lauf.rc ]' 60
  pruef "das echte Programm endet auf TERM geordnet (Code 0)" '[ "$(cat /probe/lauf.rc)" = 0 ]'
  bestaetigt "$ALT"
  lauf
  warte "zurueck mit dem Grund aus dem Urteil des echten Programms" "grep -q '^zurueck 60 z-echt keine Cloud-Verbindung in der Probezeit' $FEST/versuche"
  warte "die alte Fassung startet" 'grep -q "PROGRAMM edge-industrie-2026.11.1 GESTARTET" /probe/lauf.out'
  stopp
  ksetze version_frist 2
else
  echo "  uebersprungen: $ECHT fehlt (edge-industrie/scripts/build.sh)"
fi

schritt "11. Kein Loader-Selbstupdate mit dem echten Programm (ARMv7)"
# Das Programm bringt den Mango-Loader eingebettet mit (agent/loader_pflege)
# und erneuert ihn auf einer Mango am Pfad /usr/libexec/vp-edge-light/boot.sh.
# Auf dem PFC200 liegt dort kein Loader: es schreibt nichts - hier sogar, wenn
# es an dem Pfad schreiben DUERFTE (auf dem Geraet gehoert er root).
if [ -f "$ECHT" ]; then
  frisch
  r 'mkdir -p /usr/libexec/vp-edge-light && chown voltpilot /usr/libexec/vp-edge-light'
  x "gzip -1 -n -c /probe/echt >$LD/$N.gz
     sha=\$(sha256sum /probe/echt | cut -d' ' -f1); gz=\$(sha256sum $LD/$N.gz | cut -d' ' -f1)
     size=\$(wc -c </probe/echt); gzsize=\$(wc -c <$LD/$N.gz)
     printf '%s  $N\n%s  $N.gz\ngroesse %s %s\n' \"\$sha\" \"\$gz\" \"\$size\" \"\$gzsize\" >$LD/$N.sha256"
  VOR="$(r "sha256sum $LADER | cut -d' ' -f1")"
  lauf
  warte "die bestaetigte Fassung (echtes Programm) laeuft" "$echt_laeuft" 90
  # Die Pflege-Pruefung des Programms kommt nach ~30 s; im Emulator grosszuegig.
  sleep 60
  pruef "das Programm laeuft weiter" "$echt_laeuft && [ ! -f /probe/lauf.rc ]"
  pruef "nichts am Pfad des Mango-Loaders geschrieben" '[ -z "$(ls -A /usr/libexec/vp-edge-light)" ] && [ ! -e /etc/init.d/vp-edge-industrie ]'
  pruef "der Loader des PFC200 ist unveraendert" "[ \"\$(sha256sum $LADER | cut -d' ' -f1)\" = $VOR ]"
  echt_ende
  ksetze portal_url https://portal.voltpilot.de
else
  echo "  uebersprungen: $ECHT fehlt (edge-industrie/scripts/build.sh)"
fi

echo
echo "$OK bestanden, $FEHLER fehlgeschlagen ($(r 'busybox | head -n 1' | cut -d'(' -f1 | sed 's/ *$//'), $(r 'uname -m'))"
[ "$FEHLER" = 0 ]
