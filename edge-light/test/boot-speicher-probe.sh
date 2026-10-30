#!/bin/sh
# Probe fuer die Speicherpruefung des Loaders (openwrt/files/.../boot.sh) in
# einem ECHTEN OpenWrt-25.12-Rootfs (BusyBox, uci, /lib/functions.sh) - ohne
# Mango, ohne Netz, ohne gebautes Programm: die "lokale Kopie" ist ein kleines
# Skript, das nur "PROGRAMM GESTARTET" ausgibt.
#
# /proc/meminfo und /proc/sys/vm/drop_caches stellt die Probe ueber
# VP_LOADER_PROC nach. drop_caches ist eine FIFO: wer "1" hineinschreibt,
# bekommt danach das Bild nach dem Raeumen.
#
# Das Bild stammt aus der Abnahme am VoltPilotGATE (Mangel M1): nach einem
# Update MemFree 45 964, Cached 34 516, Inactive(file) 29 092, MemAvailable
# ~39 600 kB bei min_free_kb 40000 - die Box blieb aus, bis jemand von Hand
# drop_caches schrieb (danach 73 980 kB).
#
#   1. Bild aus dem Bericht, lokale Kopie: Cache geraeumt, Programm startet
#   2. dasselbe Bild beim Download (base_url): Programm startet
#   3. drop_caches nicht schreibbar: ehrlich verweigert (Schwelle unveraendert)
#   4. auch nach dem Raeumen zu knapp: verweigert
#   5. genug Speicher: der Cache bleibt unberuehrt
#
#   edge-light/test/boot-speicher-probe.sh
#   VPBS_LOADER=<pfad>/boot.sh ...   Gegenprobe mit einem anderen Stand
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; Ausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
LOADER="${VPBS_LOADER:-$HIER/../openwrt/files/usr/libexec/vp-edge-light/boot.sh}"
KONFIG="$HIER/../openwrt/files/etc/config/vp-edge-light"
BILD="${VPBS_BILD:-openwrt/rootfs:x86-64-25.12.5}"
C="vpbs-$$"
OK=0
FEHLER=0

aufraeumen() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
x() { docker exec "$C" sh -c "$*"; }
enthaelt() { # enthaelt <beschreibung> <datei im container> <text>
  if x "grep -qF -- '$3' '$2'" >/dev/null 2>&1; then ok "$1"; else falsch "$1"; x "sed 's/^/    | /' '$2'" || true; fi
}
fehlt() { # fehlt <beschreibung> <datei im container> <text>
  if x "grep -qF -- '$3' '$2'" >/dev/null 2>&1; then falsch "$1"; x "sed 's/^/    | /' '$2'" || true; else ok "$1"; fi
}

# meminfo <MemFree> <Cached> <Inactive(file)> <MemAvailable> - Zeilen wie am Router
meminfo() {
  printf 'MemTotal:         121032 kB\nMemFree:        %7s kB\nMemAvailable:   %7s kB\nBuffers:            1932 kB\nCached:         %7s kB\nInactive(file): %7s kB\n' "$1" "$4" "$2" "$3"
}
BERICHT="$(meminfo 45964 34516 29092 39600)"
GERAEUMT="$(meminfo 73980 6200 1100 73980)"

# lauf <name> [base_url] - Loader mit frischem RAM-Verzeichnis starten;
# Ausgabe in /probe/<name>.out, Fehlerkanal (log) in /probe/<name>.err.
lauf() {
  x "rm -rf /tmp/vp-edge-light /etc/vp-edge-light
     uci set vp-edge-light.main.base_url='${2:-}'
     uci set vp-edge-light.main.allow_http=0
     uci commit vp-edge-light
     PATH=/probe/bin:\$PATH VP_LOADER_PROC=/probe/proc sh /usr/libexec/vp-edge-light/boot.sh \
       >/probe/$1.out 2>/probe/$1.err; echo \$? >/probe/$1.rc" || true
}
# raeumbar <bild davor> <bild danach> - drop_caches als FIFO: das Schreiben
# von "1" tauscht das Bild und wird in /probe/proc/geraeumt mitgeschrieben.
raeumbar() {
  x "rm -rf /probe/proc && mkdir -p /probe/proc/sys/vm && mkfifo /probe/proc/sys/vm/drop_caches
     printf '%s\n' '$1' >/probe/proc/meminfo; printf '%s\n' '$2' >/probe/danach"
  docker exec -d "$C" sh -c 'cat /probe/proc/sys/vm/drop_caches >/probe/proc/geraeumt && cp /probe/danach /probe/proc/meminfo'
}

schritt "Aufbau: OpenWrt-Rootfs ohne Netz, lokale Kopie = Probe-Skript"
docker run -d --name "$C" --network none "$BILD" /bin/sleep 3600 >/dev/null 2>&1
x 'mkdir -p /usr/libexec/vp-edge-light /usr/share/vp-edge-light /probe/bin /probe/srv'
docker exec -i "$C" sh -c 'cat >/usr/libexec/vp-edge-light/boot.sh' <"$LOADER"
docker exec -i "$C" sh -c 'cat >/etc/config/vp-edge-light' <"$KONFIG"
x 'printf "#!/bin/sh\necho PROGRAMM GESTARTET\n" >/probe/programm
   gzip -c /probe/programm >/usr/share/vp-edge-light/vp-edge-light-linux-mipsle.gz
   sha256sum /probe/programm | awk "{print \$1}" >/usr/share/vp-edge-light/vp-edge-light-linux-mipsle.sha256
   cp /probe/programm /probe/srv/vp-edge-light-linux-mipsle
   sha256sum /probe/programm >/probe/srv/vp-edge-light-linux-mipsle.sha256'
# uclient-fetch-Ersatz: -O <ziel> <url> -> Datei gleichen Namens aus /probe/srv
x 'cat >/probe/bin/uclient-fetch <<"EOF"
#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in -O) ziel="$2"; shift 2 ;; *) shift ;; esac; done
cp "/probe/srv/${1##*/}" "$ziel"
EOF
chmod +x /probe/bin/uclient-fetch'
if x '[ "$(uci get vp-edge-light.main.min_free_kb)" = 40000 ]'; then ok "Vorgabe min_free_kb = 40000 (Schwelle nicht gesenkt)"; else falsch "Vorgabe min_free_kb = 40000"; fi

schritt "1. Bild aus dem Bericht (MemAvailable 39 600 kB), lokale Kopie"
raeumbar "$BERICHT" "$GERAEUMT"
lauf bericht
enthaelt "Programm startet" /probe/bericht.out "PROGRAMM GESTARTET"
enthaelt "Seitencache einmal geraeumt (\"1\" in drop_caches)" /probe/proc/geraeumt "1"
enthaelt "Loader meldet 39600 -> 73980 kB" /probe/bericht.err "Seitencache geraeumt: 39600 kB -> 73980 kB verfuegbar"
enthaelt "lokale Kopie entpackt" /probe/bericht.err "lokale Kopie entpackt"

schritt "2. Dasselbe Bild beim Download (base_url)"
raeumbar "$BERICHT" "$GERAEUMT"
lauf download https://downloads.example.invalid/edge-light
enthaelt "Programm startet" /probe/download.out "PROGRAMM GESTARTET"
enthaelt "Programm geladen (Download-Weg)" /probe/download.err "Programm geladen"
enthaelt "Seitencache geraeumt" /probe/download.err "Seitencache geraeumt: 39600 kB -> 73980 kB verfuegbar"

schritt "3. drop_caches nicht schreibbar: verweigert, nichts gestartet"
x "rm -rf /probe/proc && mkdir -p /probe/proc/sys/vm/drop_caches && printf '%s\n' '$BERICHT' >/probe/proc/meminfo"
lauf gesperrt
fehlt "Programm startet nicht" /probe/gesperrt.out "PROGRAMM GESTARTET"
enthaelt "Exit 1 (procd versucht es neu)" /probe/gesperrt.rc "1"
enthaelt "nennt den gesperrten Cache" /probe/gesperrt.err "Seitencache nicht raeumbar"
enthaelt "zu wenig Speicher gegen die unveraenderte Schwelle" /probe/gesperrt.err "zu wenig freier Speicher (39600 kB < 40000 kB) - lokale Kopie nicht entpackt"

schritt "4. Auch nach dem Raeumen zu knapp"
raeumbar "$BERICHT" "$(meminfo 30100 4000 900 30100)"
lauf knapp
fehlt "Programm startet nicht" /probe/knapp.out "PROGRAMM GESTARTET"
enthaelt "zu wenig Speicher nach dem Raeumen" /probe/knapp.err "zu wenig freier Speicher (30100 kB < 40000 kB) - lokale Kopie nicht entpackt"

schritt "5. Genug Speicher: der Cache bleibt unberuehrt"
x "rm -rf /probe/proc && mkdir -p /probe/proc/sys/vm && : >/probe/proc/sys/vm/drop_caches && printf '%s\n' '$GERAEUMT' >/probe/proc/meminfo"
lauf genug
enthaelt "Programm startet" /probe/genug.out "PROGRAMM GESTARTET"
if x '[ ! -s /probe/proc/sys/vm/drop_caches ]'; then ok "drop_caches nicht beschrieben"; else falsch "drop_caches nicht beschrieben"; fi
fehlt "keine Meldung zum Seitencache" /probe/genug.err "Seitencache"

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'grep DISTRIB_DESCRIPTION /etc/openwrt_release' | cut -d"'" -f2))"
[ "$FEHLER" -eq 0 ]
