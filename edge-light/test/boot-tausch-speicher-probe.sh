#!/bin/sh
# Nachbau des Tausch-Vorfalls an der Box "Zuhause" (11.2026): der Loader
# verlangte vor dem Tauschen pauschal 40 000 kB MemAvailable, die Box lag knapp
# darunter - das Update wurde zurueckgenommen, obwohl das Programm samt Prozess
# laengst gepasst haette. Seitdem ist die Schwelle der BEDARF der Fassung
# (Groesse des entpackten Programms + prozess_reserve_kb).
#
# Seit Loader Stand 2 ist die Prozessreserve 12 000 kB statt 20 000 (die
# VmRSS zaehlte die Seiten der Programmdatei doppelt) - der Tausch an ASP
# (17.11.2026) scheiterte mit Stand 1 an 280 kB.
#
# Sechs Faelle in einem ECHTEN OpenWrt-25.12-Rootfs, jeder mit eigenem
# Container, /tmp als echtes groessenbegrenztes tmpfs (die Entpack-Schreiben
# belegen wirklich Speicher; QEMU mipsel steht hier nicht zur Verfuegung):
#
#   1. der Vorfall: 39 200 kB verfuegbar, Kandidat 17 MB entpackt -> der
#      Tausch GELINGT (Bedarf 28 601 kB), Probe, behalten; der alte Stand
#      (Pauschale 40 000) nahm hier zurueck
#   2. gewachsene Fassung (size 32 MB): ehrlich zurueckgenommen, obwohl
#      42 000 kB frei sind - mehr als die alte Pauschale; die alte Fassung
#      laeuft weiter
#   3. echte Speichergrenze (tmpfs 12 MB, Messwert luegt): das Entpacken
#      scheitert wirklich (kein Platz), der Loader nimmt zurueck, die
#      bestaetigte Fassung startet - die Box ist nie ohne startbares Programm
#   4. ASP am 17.11.2026 (29 612 kB, nach dem Raeumen 36 744 kB; 11.15 mit
#      17 432 791 B): Stand 2 tauscht ohne Raeumen (Bedarf 29 024 kB)
#   5. dasselbe mit uci prozess_reserve_kb=20000: genau das Log von ASP
#      (36 744 kB < 37 024 kB), zurueck, die bestaetigte Fassung laeuft
#   6. dasselbe mit uci prozess_reserve_kb=15000 (Uebergang fuer ASP):
#      der Tausch gelingt nach dem Raeumen (Bedarf 32 024 kB)
#
#   edge-light/test/boot-tausch-speicher-probe.sh
#   VPTS_LOADER=<pfad>/boot.sh ...   Gegenprobe mit einem anderen Stand
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; Ausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
LOADER="${VPTS_LOADER:-$HIER/../openwrt/files/usr/libexec/vp-edge-light/boot.sh}"
KONFIG="$HIER/../openwrt/files/etc/config/vp-edge-light"
BILD="${VPTS_BILD:-openwrt/rootfs:x86-64-25.12.5}"
ALT=edge-light-2026.11.9
NEU=edge-light-2026.11.10
LD=/usr/share/vp-edge-light
N=vp-edge-light-linux-mipsle
RAM=/tmp/vp-edge-light/ota
FEST=/etc/vp-edge-light/ota
C=""
OK=0
FEHLER=0

aufraeumen() { [ -n "$C" ] && docker rm -f "$C" >/dev/null 2>&1 || true; }
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
lauf() {
  x 'rm -f /probe/lauf.rc /probe/stopp; : >/probe/lauf.out; : >/probe/lauf.err'
  docker exec -d "$C" sh -c 'PATH=/probe/bin:$PATH VP_LOADER_PROC=/probe/proc sh /usr/libexec/vp-edge-light/boot.sh >>/probe/lauf.out 2>>/probe/lauf.err; echo $? >/probe/lauf.rc'
}
stopp() {
  x 'touch /probe/stopp'
  i=0
  while ! x '[ -f /probe/lauf.rc ]' >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 15 ] && break
    sleep 1
  done
}

# programm <ziel> <release> <verhalten> [polster_bytes] - wie in
# boot-update-probe.sh; mit Polster wird die Datei nach einem expliziten
# "exit 0" auf echte Groesse aufgefuellt (Nullbytes, sh liest sie nie).
programm() {
  x "cat >'$1' <<EOF
#!/bin/sh
case \"\\\$1\" in
  version) echo '$2'; exit 0 ;;
esac
echo \"PROGRAMM $2 GESTARTET\"
if [ '$3' = gut ] && [ -f \"\\\$VP_OTA_RAM_DIR/probe.json\" ]; then
  zuw=\\\$(jsonfilter -i \"\\\$VP_OTA_RAM_DIR/probe.json\" -e @.zuweisung)
  printf '{\"release\":\"$2\",\"zuweisung\":\"%s\",\"bestanden\":true}' \"\\\$zuw\" >\"\\\$VP_OTA_RAM_DIR/probe-urteil.json\"
fi
while [ ! -f /probe/stopp ]; do sleep 1; done
exit 0
EOF
chmod 0755 '$1'"
  if [ -n "${4:-}" ]; then
    x "kopf=\$(wc -c <'$1'); head -c \$(($4 - kopf)) /dev/zero >>'$1'"
  fi
}

# kandidat <verhalten> <seq> <zuweisung> [polster_bytes] [size_override]
kandidat() {
  programm /probe/kandidat-roh "$NEU" "$1" "${4:-}"
  x "mkdir -p $RAM && gzip -9 -n -c /probe/kandidat-roh >$RAM/kandidat.gz
     sha=\$(sha256sum /probe/kandidat-roh | cut -d' ' -f1); gz=\$(sha256sum $RAM/kandidat.gz | cut -d' ' -f1)
     size=${5:-\$(wc -c </probe/kandidat-roh)}; gzsize=\$(wc -c <$RAM/kandidat.gz)
     printf '{\"release\":\"$NEU\",\"release_seq\":$2,\"arch\":\"linux/mipsle\",\"sha256\":\"%s\",\"size\":%s,\"gz_sha256\":\"%s\",\"gz_size\":%s,\"zuweisung\":\"$3\",\"state_schema\":1}' \"\$sha\" \"\$size\" \"\$gz\" \"\$gzsize\" >$RAM/kandidat.json"
}

# container <name> <tmpfs_mb> <memavailable_kb> - frischer Container, Loader,
# Konfiguration, bestaetigte alte Fassung im "Flash", /proc-Nachbau.
container() {
  aufraeumen
  C="vpts-$$-$1"
  # exec: Docker haengt tmpfs sonst mit noexec ein - auf der Box ist /tmp
  # ausfuehrbar (das Programm laeuft von dort).
  docker run -d --name "$C" --network none --tmpfs "/tmp:rw,exec,size=${2}m,mode=1777" "$BILD" /bin/sleep 3600 >/dev/null 2>&1
  x 'mkdir -p /usr/libexec/vp-edge-light /usr/share/vp-edge-light /probe/bin /probe/proc/sys/vm'
  docker exec -i "$C" sh -c 'cat >/usr/libexec/vp-edge-light/boot.sh' <"$LOADER"
  docker exec -i "$C" sh -c 'cat >/etc/config/vp-edge-light' <"$KONFIG"
  x "uci set vp-edge-light.main.probe_takt=1 && uci set vp-edge-light.main.version_frist=2 && uci commit vp-edge-light
     printf 'MemTotal: 121032 kB\nMemAvailable: $3 kB\n' >/probe/proc/meminfo
     printf '%s.00 0.00\n' 1000 >/probe/proc/uptime
     mkdir -p /probe/proc/sys/vm/drop_caches
     printf '#!/bin/sh\nexit 4\n' >/probe/bin/uclient-fetch && chmod +x /probe/bin/uclient-fetch"
  programm /probe/alt "$ALT" laeuft
  x "gzip -9 -n -c /probe/alt >$LD/$N.gz
     sha=\$(sha256sum /probe/alt | cut -d' ' -f1); gz=\$(sha256sum $LD/$N.gz | cut -d' ' -f1)
     printf '%s  $N\n%s  $N.gz\ngroesse %s %s\n' \"\$sha\" \"\$gz\" \"\$(wc -c </probe/alt)\" \"\$(wc -c <$LD/$N.gz)\" >$LD/$N.sha256"
}

# raeumbar <MemAvailable davor> <MemAvailable danach> - drop_caches als FIFO
# (wie boot-speicher-probe.sh): wer "1" hineinschreibt, bekommt danach das
# Bild nach dem Raeumen; mitgeschrieben in /probe/proc/geraeumt.
raeumbar() {
  x "rm -rf /probe/proc/sys/vm/drop_caches && mkfifo /probe/proc/sys/vm/drop_caches
     printf 'MemTotal: 121032 kB\nMemAvailable: $1 kB\n' >/probe/proc/meminfo
     printf 'MemTotal: 121032 kB\nMemAvailable: $2 kB\n' >/probe/danach"
  docker exec -d "$C" sh -c 'cat /probe/proc/sys/vm/drop_caches >/probe/proc/geraeumt && cp /probe/danach /probe/proc/meminfo'
}
reserve() { x "uci set vp-edge-light.main.prozess_reserve_kb=$1 && uci commit vp-edge-light"; }

schritt "1. Der Vorfall: 39 200 kB frei, Kandidat 17 MB - der Tausch gelingt"
container vorfall 28 39200
kandidat gut 42 z-1 17000000
lauf
warte "Marke start im Flash (Bedarf 28 601 kB <= 39 200 kB)" "grep -qx 'start 42 z-1' $FEST/versuche" 40
warte "Urteil bestanden -> behalten (Marke ok)" "grep -qx 'ok 42 z-1' $FEST/versuche" 30
pruef "die neue Fassung lief zur Probe" "grep -q 'PROGRAMM $NEU GESTARTET' /probe/lauf.out"
pruef "der Seitencache wurde nicht angefasst (Schwelle passte sofort)" "! grep -q Seitencache /probe/lauf.err"
pruef "groesse-Zeile der neuen Fassung im Flash" \
  "grep -qx \"groesse \$(wc -c </probe/kandidat-roh | tr -d ' ') \$(wc -c <$LD/$N.gz | tr -d ' ')\" $LD/$N.sha256"
pruef "keine Ruecknahme" "! grep -q '^zurueck' $FEST/versuche"
stopp

schritt "2. Gewachsene Fassung (32 MB): ehrlich zurueck trotz 42 000 kB frei"
container gewachsen 28 42000
kandidat gut 43 z-2 "" 32000000
lauf
warte "zurueck: zu wenig freier Speicher zum Entpacken" "grep -q '^zurueck 43 z-2 zu wenig freier Speicher zum Entpacken' $FEST/versuche" 40
warte "die alte Fassung startet" "grep -q 'PROGRAMM $ALT GESTARTET' /probe/lauf.out"
pruef "die Meldung nennt den Bedarf der Fassung" "grep -q 'zu wenig freier Speicher (42000 kB < 43250 kB) - Kandidat nicht entpackt' /probe/lauf.err"
pruef "nie zur Probe gestartet" "! grep -q 'PROGRAMM $NEU' /probe/lauf.out"
stopp

schritt "3. Echte Speichergrenze (tmpfs 12 MB): Entpacken scheitert, Box laeuft weiter"
container grenze 12 90000
kandidat gut 44 z-3 17000000
lauf
warte "zurueck: Kandidat nicht entpackbar" "grep -q '^zurueck 44 z-3 Kandidat nicht entpackbar' $FEST/versuche" 60
warte "die bestaetigte Fassung startet (nie ohne startbares Programm)" "grep -q 'PROGRAMM $ALT GESTARTET' /probe/lauf.out" 40
pruef "kein Rest des Kandidaten im RAM" "[ ! -f $RAM/kandidat.gz ] && [ ! -f /tmp/vp-edge-light/vp-edge-light.part ]"
pruef "nie zur Probe gestartet" "! grep -q 'PROGRAMM $NEU' /probe/lauf.out"
stopp

# ASP (edge-tgjn9gd) am 17.11.2026, Tausch auf 11.15 (Stand 53): vor der
# Pruefung 29 612 kB, nach dem Raeumen 36 744 kB (im tmpfs: Lieferung
# 5 430 kB und 48 h Messwert-Puffer, 16 848 kB). 11.15 entpackt 17 432 791 B.
ASP_VORHER=29612
ASP_GERAEUMT=36744
ASP_GROESSE=17432791

schritt "4. ASP 17.11.2026 mit Stand 2: der Tausch auf 11.15 gelingt ohne Raeumen"
container asp 28 "$ASP_VORHER"
raeumbar "$ASP_VORHER" "$ASP_GERAEUMT"
kandidat gut 53 z-4 "" "$ASP_GROESSE"
lauf
warte "Marke start im Flash (Bedarf 17024 + 12000 = 29 024 kB <= 29 612 kB)" "grep -qx 'start 53 z-4' $FEST/versuche" 40
warte "Urteil bestanden -> behalten (Marke ok)" "grep -qx 'ok 53 z-4' $FEST/versuche" 30
pruef "die Meldung nennt Messwert und Bedarf" "grep -qF 'genug freier Speicher (29612 kB >= 29024 kB)' /probe/lauf.err"
pruef "der Seitencache wurde nicht angefasst" "! grep -q Seitencache /probe/lauf.err && [ ! -s /probe/proc/geraeumt ]"
pruef "keine Ruecknahme" "! grep -q '^zurueck' $FEST/versuche"
stopp

schritt "5. Dasselbe mit uci prozess_reserve_kb=20000 (wie Stand 1): das Log von ASP"
container asp-alt 28 "$ASP_VORHER"
reserve 20000
raeumbar "$ASP_VORHER" "$ASP_GERAEUMT"
kandidat gut 53 z-5 "" "$ASP_GROESSE"
lauf
warte "zurueck: zu wenig freier Speicher zum Entpacken" "grep -q '^zurueck 53 z-5 zu wenig freier Speicher zum Entpacken' $FEST/versuche" 40
warte "die bestaetigte Fassung startet" "grep -q 'PROGRAMM $ALT GESTARTET' /probe/lauf.out"
pruef "Seitencache geraeumt: 29612 -> 36744 kB (wie im Log)" "grep -qF 'Seitencache geraeumt: 29612 kB -> 36744 kB verfuegbar' /probe/lauf.err"
pruef "zu wenig: 36 744 kB < 37 024 kB (wie im Log)" "grep -qF 'zu wenig freier Speicher (36744 kB < 37024 kB) - Kandidat nicht entpackt' /probe/lauf.err"
pruef "nie zur Probe gestartet" "! grep -q 'PROGRAMM $NEU' /probe/lauf.out"
stopp

schritt "6. Dasselbe mit uci prozess_reserve_kb=15000 (Uebergang): Tausch nach dem Raeumen"
container asp-uebergang 28 "$ASP_VORHER"
reserve 15000
raeumbar "$ASP_VORHER" "$ASP_GERAEUMT"
kandidat gut 53 z-6 "" "$ASP_GROESSE"
lauf
warte "Marke start im Flash (Bedarf 32 024 kB <= 36 744 kB)" "grep -qx 'start 53 z-6' $FEST/versuche" 40
warte "Urteil bestanden -> behalten (Marke ok)" "grep -qx 'ok 53 z-6' $FEST/versuche" 30
pruef "Seitencache geraeumt: 29612 -> 36744 kB" "grep -qF 'Seitencache geraeumt: 29612 kB -> 36744 kB verfuegbar' /probe/lauf.err"
pruef "keine Ruecknahme" "! grep -q '^zurueck' $FEST/versuche"
stopp

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler"
[ "$FEHLER" -eq 0 ]
