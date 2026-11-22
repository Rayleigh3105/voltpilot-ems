#!/bin/sh
# Probe fuer edge-industrie/fernlauf.sh (Fernlauf durch den Wartungstunnel auf
# einem WAGO PFC200) gegen ein BusyBox-Linux fuer ARMv7 im Container (ohne
# Netz) - ohne PFC200 und ohne Root auf dem Rechner. Dasselbe "Geraet" wie in
# install-probe.sh: busybox:1.34.1-glibc, BusyBox-Init als PID 1, kein gunzip.
#
# Gefahren wird, was der Werkstatt-Dienst in einem Fernlauf faehrt, mit den
# ECHTEN Skripten install.sh, fernlauf.sh, Dienst-Skript und Loader:
# sichern, neue Fassung aufspielen, Dienst neu starten, und die Sicherung
# zurueckspielen. Die "Programme" sind kleine Skripte, die /health
# mit ihrer Fassung beantworten (BusyBox httpd); neben ihnen laufen zwei
# Prozesse als Ersatz fuer die SPS-Laufzeit und den Wartungstunnel.
#
#   0. fernlauf.sh verweigert, was nicht passt, vor dem ersten SSH-Aufruf
#   1. sichern: ein lesbares tar.gz mit genau dem, was install.sh schreibt -
#      ohne Identitaet und Referenz der Box, ohne Tunnel
#   2. aufspielen (install.sh) und neustart: /health nennt die neue Fassung;
#      das Geraet startet nicht neu, SPS-Ersatz und Tunnel-Ersatz laufen mit
#      derselben PID weiter
#   3. zurueck: /health nennt wieder die alte Fassung; Fassung, Stand, Loader,
#      Dienst-Skript, Einstellungen und Start-Link sind zeichengleich wie
#      vorher, nichts von der neuen Fassung bleibt, Besitzer stimmen;
#      Identitaet und Referenz unberuehrt; wieder kein Neustart des Geraets
#   4. ein kaputtes, unvollstaendiges oder fremdes Archiv aendert nichts, der
#      Dienst laeuft weiter
#   5. ohne Edge Industrie auf dem Geraet: sichern verweigert und hinterlaesst
#      keine Datei
#
# Was die Probe NICHT belegt (nur am Geraet): den Weg durch den echten
# Wartungstunnel (vp-wartung, SSH 2222), das tar der WAGO-Firmware, die echte
# SPS-Laufzeit daneben, Dauer und Speicher.
#
#   edge-industrie/test/fernlauf-probe.sh
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; die Pruefausdruecke werten im Container aus
set -eu
# Das tar von macOS legt sonst "._"-Eintraege in die Archive der Probe.
export COPYFILE_DISABLE=1

HIER="$(cd "$(dirname "$0")" && pwd -P)"
INDUSTRIE="$(cd "$HIER/.." && pwd -P)"
REPO="$(cd "$INDUSTRIE/.." && pwd -P)"
BILD="${VPPF_BILD:-busybox:1.34.1-glibc}"
PLATTFORM=linux/arm/v7
C="vppf-$$"
C2="vppf-$$-leer"
ARBEIT="$(mktemp -d)"
OK=0
FEHLER=0
ALT=edge-industrie-2026.11.1
NEU=edge-industrie-2026.11.2
N=vp-edge-industrie-linux-arm

aufraeumen() {
  docker rm -f "$C" "$C2" >/dev/null 2>&1 || true
  rm -rf "$ARBEIT"
}
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
ZIEL="$C"
x() { docker exec "$ZIEL" sh -c "$*"; }
pruefe() { # pruefe <beschreibung> <befehl im container...>
  b="$1"; shift
  if docker exec "$ZIEL" sh -c "$*" >/dev/null 2>&1; then ok "$b"; else falsch "$b"; fi
}
gleich() { if [ "$2" = "$3" ]; then ok "$1"; else falsch "$1 (erwartet '$3', ist '$2')"; fi; }
summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }

# Das echte, root-signierte Vertrauens-Set (oeffentlich, im Repo). Nie vom Portal laden.
VP_TRUST_SET_DIR="$REPO/edge-app/ota"
export VP_TRUST_SET_DIR

# ssh-Ersatz: ssh root@<container> <befehl>  ->  docker exec
mkdir -p "$ARBEIT/bin"
cat > "$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
if [ "\$1" = -i ]; then shift 2; fi
ziel="\${1#*@}"
shift
exec docker exec -i "\$ziel" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"
PATH="$ARBEIT/bin:$PATH"
export PATH

# Das "Geraet": BusyBox-Init als PID 1, rcS startet syslogd und die Links in /etc/rc.d.
mkdir -p "$ARBEIT/etc/init.d" "$ARBEIT/etc/rc.d" "$ARBEIT/etc/config-tools"
printf '::sysinit:/etc/init.d/rcS\n' >"$ARBEIT/etc/inittab"
cat >"$ARBEIT/etc/init.d/rcS" <<'EOF'
#!/bin/sh
mkdir -p /var/log /var/run
syslogd -O /var/log/messages
for s in /etc/rc.d/S*; do
  [ -x "$s" ] && "$s" start
done
EOF
cat >"$ARBEIT/etc/config-tools/get_coupler_details" <<'EOF'
#!/bin/sh
[ "$1" = order-number ] && echo 750-8212
EOF
chmod 0755 "$ARBEIT/etc/init.d/rcS" "$ARBEIT/etc/config-tools/get_coupler_details"

geraet() { # geraet <name>
  docker create --name "$1" --platform "$PLATTFORM" --network none --tmpfs "/tmp:rw,exec,size=256m" "$BILD" /bin/init >/dev/null
  docker cp "$ARBEIT/etc/." "$1:/etc/" >/dev/null
  docker start "$1" >/dev/null
  docker exec "$1" rm -f /bin/gunzip
  i=0
  until docker exec "$1" sh -c '[ -S /dev/log ]' 2>/dev/null || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
}
health() { x 'wget -q -O - http://127.0.0.1:8484/health' 2>/dev/null || true; }
warte_fassung() { # warte_fassung <fassung> - bis /health sie nennt (hoechstens 90 s)
  i=0
  until health | grep -q "\"version\":\"$1\"" || [ "$i" -ge 90 ]; do i=$((i + 1)); sleep 1; done
  health | grep -q "\"version\":\"$1\""
}

# Eine Fassung als Baum wie im Release: die echten Skripte, dazu ein "Programm",
# das seine Referenz anlegt (wie das echte beim ersten Start) und /health mit
# seiner Fassung beantwortet.
fassung() { # fassung <name> <release> <stand>
  b="$ARBEIT/$1/edge-industrie"
  mkdir -p "$b/dist"
  cp "$INDUSTRIE/install.sh" "$INDUSTRIE/fernlauf.sh" "$b/"
  cp -R "$INDUSTRIE/files" "$b/files"
  cat >"$b/dist/$N" <<EOF
#!/bin/sh
[ "\$1" = version ] && { echo $2; exit 0; }
[ -s "\$VP_DATA_DIR/ref" ] || echo edge-probe7 >"\$VP_DATA_DIR/ref"
mkdir -p "\$VP_DATA_DIR/identity" /tmp/vp-probe-web
[ -s "\$VP_DATA_DIR/identity/device.key" ] || echo GEHEIMER-SCHLUESSEL-DER-BOX >"\$VP_DATA_DIR/identity/device.key"
printf '{"status":"ok","ref":"%s","version":"$2"}\n' "\$(cat "\$VP_DATA_DIR/ref")" >/tmp/vp-probe-web/health
exec httpd -f -p 127.0.0.1:8484 -h /tmp/vp-probe-web
EOF
  chmod 0755 "$b/dist/$N"
  gzip -9 -n -c "$b/dist/$N" >"$ARBEIT/$1/$N.gz"
  # Ein Manifest in der Form von `vp-ota manifest` (eine Angabe je Zeile): Daraus
  # liest install.sh Stand und Pruefsummen. Signiert ist es hier nicht; die
  # Signatur prueft der Werkstatt-Dienst, bevor er install.sh aufruft.
  cat >"$ARBEIT/$1/release.json" <<EOF
{
  "schema_version": "1.0",
  "release": "$2",
  "release_seq": $3,
  "artifacts": [
    {
      "type": "binary",
      "name": "vp-edge-industrie",
      "arch": "linux/arm",
      "sha256": "$(summe "$b/dist/$N")",
      "gz_sha256": "$(summe "$ARBEIT/$1/$N.gz")"
    }
  ],
  "state_schema": 1
}
EOF
}
fassung alt "$ALT" 77
fassung neu "$NEU" 78
installiere() { # installiere <name>
  VP_INDUSTRIE_MANIFEST="$ARBEIT/$1/release.json" "$ARBEIT/$1/edge-industrie/install.sh" "root@$C" >"$ARBEIT/install-$1.out" 2>&1
}
FL="$ARBEIT/neu/edge-industrie/fernlauf.sh"

schritt "Aufbau: BusyBox-Linux fuer ARMv7, Edge Industrie $ALT eingerichtet und gestartet"
geraet "$C"
pruefe "BusyBox-Init ist PID 1, kein gunzip wie am Geraet" 'tr "\000" " " </proc/1/cmdline | grep -q init && ! command -v gunzip'
if installiere alt && grep -q 'Pruefsumme auf dem Geraet bestaetigt' "$ARBEIT/install-alt.out"; then ok "install.sh: $ALT eingerichtet"; else falsch "install.sh $ALT"; cat "$ARBEIT/install-alt.out"; fi
x '/etc/init.d/vp-edge-industrie restart >/dev/null 2>&1 </dev/null'
if warte_fassung "$ALT"; then ok "/health nennt $ALT"; else falsch "/health nennt $ALT nicht: $(health)"; fi
# Neben dem Dienst: Ersatz fuer die SPS-Laufzeit und den Wartungstunnel, und eine Marke im RAM.
x 'sleep 987654 >/dev/null 2>&1 & echo $! >/tmp/sps.pid; sleep 876543 >/dev/null 2>&1 & echo $! >/tmp/tunnel.pid; echo seit-dem-start >/tmp/marke
   mkdir -p /home/voltpilot/wartung && echo TUNNEL-SCHLUESSEL >/home/voltpilot/wartung/schluessel'
SPS="$(x 'cat /tmp/sps.pid')"
TUNNEL="$(x 'cat /tmp/tunnel.pid')"
GESTARTET="$(docker inspect -f '{{.State.StartedAt}}' "$C")"
laeuft_weiter() { # laeuft_weiter <wann>
  pruefe "$1: das Geraet hat nicht neu gestartet (Marke im RAM, PID 1)" "[ \"\$(cat /tmp/marke)\" = seit-dem-start ]"
  gleich "$1: der Container laeuft seit demselben Start" "$(docker inspect -f '{{.State.StartedAt}}' "$C")" "$GESTARTET"
  pruefe "$1: der SPS-Ersatz laeuft mit derselben PID" "kill -0 $SPS"
  pruefe "$1: der Tunnel-Ersatz laeuft mit derselben PID" "kill -0 $TUNNEL"
}
zustand() { # zustand <datei> - Pruefsummen und Besitzer dessen, was install.sh schreibt, dazu Identitaet und Tunnel
  x 'cd / && for f in home/voltpilot/libexec/boot.sh etc/init.d/vp-edge-industrie home/voltpilot/konfig; do echo "$(sha256sum "$f" | cut -d" " -f1) $(stat -c "%U %a" "$f") $f"; done
     find home/voltpilot/daten/ota home/voltpilot/fassung -type f | sort | while read -r f; do echo "$(sha256sum "$f" | cut -d" " -f1) $(stat -c "%U %a" "$f") $f"; done
     stat -c "%U %a %n" home/voltpilot/daten/ota home/voltpilot/fassung
     for l in etc/rc.d/*vp-edge-industrie; do echo "$l -> $(readlink "$l")"; done' >"$1"
}
eigenes() { x 'sha256sum /home/voltpilot/daten/ref /home/voltpilot/daten/identity/device.key /home/voltpilot/wartung/schluessel'; }
zustand "$ARBEIT/zustand-alt"
EIGENES="$(eigenes)"

schritt "0. Verweigert, bevor etwas auf das Geraet geht"
if "$FL" "root@$C" >/dev/null 2>&1; then falsch "ohne Befehl verweigert"; else ok "ohne Befehl verweigert"; fi
if "$FL" "root@$C" loeschen >"$ARBEIT/nein.out" 2>&1; then falsch "unbekannter Befehl verweigert"; else
  grep -q "unbekannter Befehl" "$ARBEIT/nein.out" && ok "unbekannter Befehl verweigert" || falsch "unbekannter Befehl: $(cat "$ARBEIT/nein.out")"; fi
if "$FL" "root@$C" neustart mehr >/dev/null 2>&1; then falsch "neustart mit einem dritten Argument verweigert"; else ok "neustart mit einem dritten Argument verweigert"; fi
if "$FL" "root@$C" sichern >/dev/null 2>&1; then falsch "sichern ohne Datei verweigert"; else ok "sichern ohne Datei verweigert"; fi
if "$FL" "root@$C" zurueck "$ARBEIT/gibt-es-nicht" >"$ARBEIT/nein.out" 2>&1; then falsch "zurueck ohne lesbare Sicherung verweigert"; else
  grep -q "nicht lesbar" "$ARBEIT/nein.out" && ok "zurueck ohne lesbare Sicherung verweigert" || falsch "zurueck ohne Sicherung: $(cat "$ARBEIT/nein.out")"; fi

schritt "1. sichern: genau, was install.sh schreibt"
if "$FL" "root@$C" sichern "$ARBEIT/sicherung.tar.gz" >"$ARBEIT/sichern.out" 2>&1 && grep -q '^gesichert: ' "$ARBEIT/sichern.out"; then ok "sichern endet ohne Fehler ($(cat "$ARBEIT/sichern.out"))"; else falsch "sichern: $(cat "$ARBEIT/sichern.out")"; fi
[ ! -e "$ARBEIT/sicherung.tar.gz.teil" ] && ok "keine unfertige Datei bleibt" || falsch "eine unfertige Datei bleibt"
if tar -tzf "$ARBEIT/sicherung.tar.gz" >"$ARBEIT/liste" 2>/dev/null; then ok "die Sicherung ist ein lesbares tar.gz ($(wc -c <"$ARBEIT/sicherung.tar.gz" | tr -d ' ') Bytes)"; else falsch "die Sicherung ist nicht lesbar"; : >"$ARBEIT/liste"; fi
for p in home/voltpilot/libexec/boot.sh etc/init.d/vp-edge-industrie home/voltpilot/konfig home/voltpilot/daten/ota/current.json \
  home/voltpilot/daten/ota/trust-set.json "home/voltpilot/fassung/$N.gz" "home/voltpilot/fassung/$N.sha256" etc/rc.d/S99_vp-edge-industrie; do
  grep -qx "$p" "$ARBEIT/liste" && ok "gesichert: $p" || falsch "nicht gesichert: $p"
done
if grep -E 'identity|daten/ref|wartung|dropbear|shadow|passwd' "$ARBEIT/liste" >/dev/null; then falsch "die Sicherung enthaelt Identitaet, Referenz oder Tunnel: $(grep -E 'identity|daten/ref|wartung' "$ARBEIT/liste" | tr '\n' ' ')"; else ok "ohne Identitaet, Referenz und Tunnel"; fi
if gzip -dc "$ARBEIT/sicherung.tar.gz" | grep -q -a -e GEHEIMER-SCHLUESSEL -e TUNNEL-SCHLUESSEL; then falsch "ein Schluessel steht in der Sicherung"; else ok "kein Schluessel in den Bytes der Sicherung"; fi
zustand "$ARBEIT/zustand-nach-sichern"
cmp -s "$ARBEIT/zustand-alt" "$ARBEIT/zustand-nach-sichern" && ok "sichern aendert am Geraet nichts" || falsch "sichern hat etwas geaendert"
pruefe "sichern hinterlaesst keine Arbeitsdatei" '! ls /home/voltpilot/.fernlauf-zurueck /tmp/vp-fernlauf* 2>/dev/null | grep -q .'

schritt "2. aufspielen und neustart: nur der Dienst"
if installiere neu && grep -q 'Pruefsumme auf dem Geraet bestaetigt' "$ARBEIT/install-neu.out"; then ok "install.sh: $NEU aufgespielt"; else falsch "install.sh $NEU"; cat "$ARBEIT/install-neu.out"; fi
gleich "bis zum Neustart des Dienstes laeuft noch $ALT" "$(health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" "$ALT"
"$FL" "root@$C" neustart >"$ARBEIT/neustart.out" 2>&1 && grep -q 'nur der Dienst vp-edge-industrie' "$ARBEIT/neustart.out" && ok "neustart meldet: nur der Dienst" || falsch "neustart: $(cat "$ARBEIT/neustart.out")"
if warte_fassung "$NEU"; then ok "/health nennt $NEU"; else falsch "/health nennt $NEU nicht: $(health)"; fi
pruefe "current.json nennt Stand 78" "grep -q '\"release_seq\":78' /home/voltpilot/daten/ota/current.json"
laeuft_weiter "nach dem Neustart des Dienstes"
gleich "Identitaet, Referenz und Tunnel unberuehrt" "$(eigenes)" "$EIGENES"

schritt "3. zurueck: die Sicherung einspielen"
x 'echo fremd >/home/voltpilot/fassung/von-der-neuen-fassung; chown voltpilot /home/voltpilot/fassung/von-der-neuen-fassung'
if "$FL" "root@$C" zurueck "$ARBEIT/sicherung.tar.gz" >"$ARBEIT/zurueck.out" 2>&1 && grep -q '^zurueck: ' "$ARBEIT/zurueck.out"; then ok "zurueck endet ohne Fehler ($(cat "$ARBEIT/zurueck.out"))"; else falsch "zurueck: $(cat "$ARBEIT/zurueck.out")"; fi
if warte_fassung "$ALT"; then ok "/health nennt wieder $ALT"; else falsch "/health nennt $ALT nicht: $(health)"; fi
zustand "$ARBEIT/zustand-zurueck"
if cmp -s "$ARBEIT/zustand-alt" "$ARBEIT/zustand-zurueck"; then ok "Fassung, Stand, Loader, Dienst-Skript, Einstellungen und Start-Link zeichengleich wie vorher, Besitzer und Rechte auch"; else falsch "der Stand weicht ab:"; diff "$ARBEIT/zustand-alt" "$ARBEIT/zustand-zurueck" || true; fi
pruefe "nichts von der neuen Fassung bleibt" '[ ! -e /home/voltpilot/fassung/von-der-neuen-fassung ] && ! ls -d /home/voltpilot/fassung.fernlauf-weg /home/voltpilot/daten/ota.fernlauf-weg /home/voltpilot/.fernlauf-zurueck 2>/dev/null | grep -q .'
pruefe "das Programm laeuft als voltpilot, nicht als root" '[ "$(stat -c %U /proc/$(pidof httpd))" = voltpilot ]'
laeuft_weiter "nach dem Zurueckspielen"
gleich "Identitaet, Referenz und Tunnel unberuehrt" "$(eigenes)" "$EIGENES"

schritt "4. Ein kaputtes, unvollstaendiges oder fremdes Archiv aendert nichts"
PID="$(x 'pidof httpd')"
printf 'kein archiv' >"$ARBEIT/kaputt"
if "$FL" "root@$C" zurueck "$ARBEIT/kaputt" >"$ARBEIT/kaputt.out" 2>&1; then falsch "ein kaputtes Archiv wird abgewiesen"; else
  grep -q 'nichts geaendert' "$ARBEIT/kaputt.out" && ok "ein kaputtes Archiv wird abgewiesen: nichts geaendert" || falsch "kaputtes Archiv: $(cat "$ARBEIT/kaputt.out")"; fi
# Unvollstaendig: nur der Loader. Was fehlt, wuerde beim Einspielen entfernt.
mkdir -p "$ARBEIT/halb/home/voltpilot/libexec"
echo '#!/bin/sh' >"$ARBEIT/halb/home/voltpilot/libexec/boot.sh"
(cd "$ARBEIT/halb" && tar -cf - home/voltpilot/libexec/boot.sh | gzip -c) >"$ARBEIT/halb.tar.gz"
if "$FL" "root@$C" zurueck "$ARBEIT/halb.tar.gz" >"$ARBEIT/halb.out" 2>&1; then falsch "ein unvollstaendiges Archiv wird abgewiesen"; else
  grep -q 'keine vollstaendige Sicherung' "$ARBEIT/halb.out" && ok "ein Archiv ohne Dienst-Skript und Einstellungen wird abgewiesen" || falsch "unvollstaendiges Archiv: $(cat "$ARBEIT/halb.out")"; fi
# Vollstaendig, aber mit einem Schluessel der Identitaet darin.
mkdir -p "$ARBEIT/fremd/home/voltpilot/libexec" "$ARBEIT/fremd/home/voltpilot/daten/identity" "$ARBEIT/fremd/etc/init.d"
echo '#!/bin/sh' >"$ARBEIT/fremd/home/voltpilot/libexec/boot.sh"
echo '#!/bin/sh' >"$ARBEIT/fremd/etc/init.d/vp-edge-industrie"
echo 'enabled = 1' >"$ARBEIT/fremd/home/voltpilot/konfig"
echo FREMD >"$ARBEIT/fremd/home/voltpilot/daten/identity/device.key"
(cd "$ARBEIT/fremd" && tar -cf - home/voltpilot/libexec/boot.sh etc/init.d/vp-edge-industrie home/voltpilot/konfig home/voltpilot/daten/identity/device.key | gzip -c) >"$ARBEIT/fremd.tar.gz"
if "$FL" "root@$C" zurueck "$ARBEIT/fremd.tar.gz" >"$ARBEIT/fremd.out" 2>&1; then falsch "ein Archiv mit Fremdem wird abgewiesen"; else
  grep -q 'enthaelt Fremdes' "$ARBEIT/fremd.out" && ok "ein Archiv mit Identitaet darin wird abgewiesen" || falsch "fremdes Archiv: $(cat "$ARBEIT/fremd.out")"; fi
gleich "der Dienst lief durch (dieselbe PID des Programms)" "$(x 'pidof httpd')" "$PID"
zustand "$ARBEIT/zustand-nach-nein"
cmp -s "$ARBEIT/zustand-alt" "$ARBEIT/zustand-nach-nein" && ok "am Geraet ist nichts geaendert" || falsch "ein abgewiesenes Archiv hat etwas geaendert"
gleich "Identitaet, Referenz und Tunnel unberuehrt" "$(eigenes)" "$EIGENES"
pruefe "keine Arbeitsdatei bleibt" '[ ! -e /home/voltpilot/.fernlauf-zurueck ]'

schritt "5. Ohne Edge Industrie auf dem Geraet"
geraet "$C2"
ZIEL="$C2"
if "$FL" "root@$C2" sichern "$ARBEIT/leer.tar.gz" >"$ARBEIT/leer.out" 2>&1; then falsch "sichern verweigert ohne Edge Industrie"; else
  grep -q 'kein Edge Industrie' "$ARBEIT/leer.out" && ok "sichern verweigert: kein Edge Industrie" || falsch "sichern: $(cat "$ARBEIT/leer.out")"; fi
[ ! -e "$ARBEIT/leer.tar.gz" ] && [ ! -e "$ARBEIT/leer.tar.gz.teil" ] && ok "und hinterlaesst keine Datei" || falsch "eine Datei bleibt"

echo
echo "== Ergebnis: $OK ok, $FEHLER Fehler"
[ "$FEHLER" -eq 0 ]
