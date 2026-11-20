#!/bin/sh
# Probe fuer edge-industrie/install.sh, das Dienst-Skript und den Loader des
# WAGO PFC200 gegen ein BusyBox-Linux fuer ARMv7 im Container (ohne Netz) -
# ohne PFC200 und ohne Root auf dem Rechner.
#
# So nah an der WAGO-Firmware, wie es die Unterlagen belegen (Firmware 27:
# glibc, BusyBox 1.34.1, BusyBox-Init): das Bild busybox:1.34.1-glibc fuer
# linux/arm/v7, als PID 1 laeuft BusyBox-Init mit einer inittab, deren rcS die
# Links in /etc/rc.d startet. /tmp ist ein tmpfs und nach einem Neustart leer,
# wie der RAM des Geraets. Das Programm ist die ECHTE ARMv7-Fassung
# (GOARM=7, statisch). Unter /etc/config-tools/get_coupler_details liegt ein
# Ersatz, der die Bestellnummer 750-8212 nennt.
#
# Was die Probe NICHT belegt (nur am Geraet, edge-industrie/README.md): den
# echten Kernel (5.15-rt) und die SPS-Laufzeit daneben, die Ausgabe des echten
# get_coupler_details, das Muster der rc-Links der WAGO-Firmware, ob /tmp dort
# Programme startet, Speicher und Rechenzeit.
#
#   1. verweigert, bevor etwas auf das Geraet geht (Bauart, Schluesseldatei,
#      zweites Argument, Vertrauens-Set, fremdes Manifest, Link-Name),
#   2. fehlt dem Geraet ein Werkzeug, endet das Skript, ohne etwas zu aendern,
#   3. Aufbau und Rechte: Loader, Dienst-Skript und Einstellungen gehoeren
#      root, Fassung und Daten dem Benutzer voltpilot; der kann Loader und
#      Einstellungen nicht aendern,
#   4. das Programm laeuft als voltpilot (nie als root), mit nice und
#      oom_score_adj, meldet "WAGO 750-8212" und arm, ist update-bereit,
#   5. der Datenspiegel ist aus und nennt Port 1502; eingeschaltet lauscht er
#      auf 1502 und nichts auf 502,
#   6. kein Loader-Selbstupdate: nichts unter /usr/libexec/vp-edge-light,
#      Loader und Dienst-Skript bleiben zeichengleich mit dem Quellstand,
#   7. endet das Programm, startet der Dienst es nach 10 s neu; stop beendet
#      es; status meldet 0 bzw. 3; ein Start bei enabled = 0 startet nichts,
#   8. nach einem Neustart des Geraets (RAM leer) startet der Dienst von selbst,
#   9. ein zweiter Aufruf laesst die Einstellungen stehen und verdoppelt nichts,
#  10. startet /tmp keine Programme (noexec), laeuft das Programm aus dem Flash.
#
# "ssh" ist ein Ersatz, der die Befehle per docker exec im Container
# ausfuehrt (das Ziel root@<container> nennt den Container) und eine
# Schluesseldatei (-i) nur mitschreibt.
#
#   VP_INDUSTRIE_VERSION=edge-industrie-2099.01.0 edge-industrie/scripts/build.sh
#   edge-industrie/test/install-probe.sh
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; die Pruefausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
SKRIPT="$HIER/../install.sh"
QUELLE="$HIER/../files"
BIN="$HIER/../dist/vp-edge-industrie-linux-arm"
BILD="${VPPI_BILD:-busybox:1.34.1-glibc}"
PLATTFORM=linux/arm/v7
C="vppi-$$"
C2="vppi-$$-noexec"
ARBEIT="$(mktemp -d)"
OK=0
FEHLER=0

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
summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }
zeilen() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

[ -f "$BIN" ] || { echo "FEHLER: erst VP_INDUSTRIE_VERSION=edge-industrie-2099.01.0 edge-industrie/scripts/build.sh" >&2; exit 1; }
REPO="$(cd "$HIER/../.." && pwd -P)"
# Das echte, root-signierte Vertrauens-Set (oeffentlich, im Repo). Nie vom
# Portal laden: die Probe beruehrt kein Live-System.
VP_TRUST_SET_DIR="$REPO/edge-app/ota"
export VP_TRUST_SET_DIR

# ssh-Ersatz: ssh [-i <datei>] root@<container> <befehl>  ->  docker exec
mkdir -p "$ARBEIT/bin"
cat > "$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
echo aufruf >> "$ARBEIT/ssh.log"
if [ "\$1" = -i ]; then echo "\$2" >> "$ARBEIT/ssh-i.log"; shift 2; fi
ziel="\${1#*@}"
shift
exec docker exec -i "\$ziel" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"
PATH="$ARBEIT/bin:$PATH"
export PATH

# Das "Geraet": BusyBox-Init als PID 1, rcS startet syslogd und die Links in
# /etc/rc.d - das Muster eines BusyBox-Init-Systems.
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
# Ersatz fuer das WAGO-Werkzeug: nennt die Bestellnummer.
[ "$1" = order-number ] && echo 750-8212
EOF
chmod 0755 "$ARBEIT/etc/init.d/rcS" "$ARBEIT/etc/config-tools/get_coupler_details"

geraet() { # geraet <name> <tmpfs-optionen>
  docker create --name "$1" --platform "$PLATTFORM" --network none --tmpfs "/tmp:$2" "$BILD" /bin/init >/dev/null
  docker cp "$ARBEIT/etc/." "$1:/etc/" >/dev/null
  docker start "$1" >/dev/null
  # Wie am Geraet (Firmware 03.10.08): gzip und zcat, aber kein gunzip.
  docker exec "$1" rm -f /bin/gunzip
  i=0
  until docker exec "$1" sh -c '[ -S /dev/log ]' 2>/dev/null || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
}
warte_health() { # warte_health <datei> - bis /health antwortet (hoechstens 180 s)
  i=0
  until x 'wget -q -O - http://127.0.0.1:8484/health' >"$1" 2>/dev/null || [ "$i" -ge 180 ]; do i=$((i + 1)); sleep 1; done
}
protokoll() { x 'cat /var/log/messages 2>/dev/null' | grep 'vp-edge-industrie' || true; }

schritt "Aufbau: BusyBox-Linux fuer ARMv7 mit BusyBox-Init, ohne Netz"
geraet "$C" "rw,exec,size=256m"
pruefe "BusyBox-Init ist PID 1, syslogd laeuft" 'tr "\000" " " </proc/1/cmdline | grep -q init && [ -S /dev/log ]'
pruefe "ARMv7 ($(x 'uname -m'))" '[ "$(uname -m)" = armv7l ]'
pruefe "kein gunzip, wie am Geraet (Installer und Loader nehmen gzip -d)" '! command -v gunzip && command -v gzip'
pruefe "Ersatz get_coupler_details nennt 750-8212" '[ "$(/etc/config-tools/get_coupler_details order-number)" = 750-8212 ]'

schritt "0. Fassung und Manifest (Werkzeug vp-ota)"
FASSUNG="$(docker run --rm --platform "$PLATTFORM" --network none -v "$BIN:/p:ro" "$BILD" /p version 2>/dev/null || true)"
MANIFEST=""
SEQ=77
# Nur ein Release-Name (edge-industrie-JJJJ.MM.N) traegt ein Manifest; ein Bau
# zwischen zwei Tags heisst edge-industrie-JJJJ.MM.N-3-g<commit> und faellt hier
# mit dem Hinweis auf VP_INDUSTRIE_VERSION durch.
case "$(printf '%s\n' "$FASSUNG" | grep -E '^edge-industrie-[0-9]{4}\.[0-9]{2}\.[0-9]+$' || true)" in
  edge-industrie-*)
    ok "die ARMv7-Fassung startet im Container und nennt $FASSUNG"
    gzip -9 -n -c "$BIN" >"$ARBEIT/prog.gz"
    if (cd "$REPO/edge-app/core" && go run ./cmd/vp-ota manifest --release "$FASSUNG" --seq "$SEQ" --commit 3bf8c038a1b2 \
      --binary "vp-edge-industrie:linux/arm=$BIN,$ARBEIT/prog.gz" --state-schema 1 --key-id rel-2026-a \
      --out "$ARBEIT/release.json") >/dev/null 2>&1; then
      MANIFEST="$ARBEIT/release.json"
      ok "Manifest fuer $FASSUNG (Stand $SEQ) mit linux/arm erzeugt"
    else
      falsch "Manifest fuer $FASSUNG erzeugt"
    fi
    ;;
  *) falsch "Fassung '$FASSUNG' ohne Release-Namen - VP_INDUSTRIE_VERSION=edge-industrie-2099.01.0 edge-industrie/scripts/build.sh" ;;
esac

schritt "1. Verweigert, bevor etwas auf das Geraet geht"
: > "$ARBEIT/schluessel"
verweigert() { # verweigert <beschreibung> <grund-muster> <env...> -- <argumente...>
  b="$1"; muster="$2"; shift 2
  if env "$@" >"$ARBEIT/nein.out" 2>&1; then
    falsch "$b"
  elif grep -q "$muster" "$ARBEIT/nein.out"; then
    ok "$b"
  else
    falsch "$b (Grund fehlt)"; sed 's/^/    | /' "$ARBEIT/nein.out"
  fi
}
verweigert "unbekannte Bauart verweigert" "unbekannte Bauart" VP_INDUSTRIE_ARCH=sparc "$SKRIPT" "root@$C"
verweigert "mipsle (die Mango) verweigert" "unbekannte Bauart" VP_INDUSTRIE_ARCH=mipsle "$SKRIPT" "root@$C"
verweigert "fehlende Schluesseldatei verweigert" "keine lesbare Schluesseldatei" VP_SSH_KEY="$ARBEIT/gibt-es-nicht" "$SKRIPT" "root@$C"
verweigert "zweites Argument (Download-Adresse) verweigert" "nur das Ziel" "$SKRIPT" "root@$C" https://downloads.example.invalid/edge-light
verweigert "ohne Vertrauens-Set verweigert" "Vertrauens-Set nicht ladbar" VP_TRUST_SET_DIR= VP_PORTAL_URL=http://127.0.0.1:9 "$SKRIPT" "root@$C"
verweigert "Link-Name mit Pfad verweigert" "ist kein Dateiname" VP_PFC_RC_LINK=../S99x "$SKRIPT" "root@$C"
printf '{\n  "release": "edge-industrie-2099.01.0",\n  "release_seq": 5,\n  "artifacts": [\n    {\n      "arch": "linux/arm",\n      "sha256": "%s",\n      "gz_sha256": "%s"\n    }\n  ]\n}\n' "$(printf '0%.0s' $(seq 64))" "$(printf '1%.0s' $(seq 64))" >"$ARBEIT/fremd.json"
verweigert "Manifest eines anderen Programms verweigert" "anderes Programm" VP_INDUSTRIE_MANIFEST="$ARBEIT/fremd.json" "$SKRIPT" "root@$C"
# Ein Manifest, das nur die Mango kennt, beschreibt kein Programm fuer linux/arm.
printf '{\n  "release": "edge-industrie-2099.01.0",\n  "release_seq": 5,\n  "artifacts": [\n    {\n      "arch": "linux/mipsle",\n      "sha256": "%s",\n      "gz_sha256": "%s"\n    }\n  ]\n}\n' "$(summe "$BIN")" "$(printf '1%.0s' $(seq 64))" >"$ARBEIT/mango.json"
verweigert "Manifest ohne linux/arm verweigert" "anderes Programm" VP_INDUSTRIE_MANIFEST="$ARBEIT/mango.json" "$SKRIPT" "root@$C"
[ "$(zeilen "$ARBEIT/ssh.log")" = 0 ] && ok "dabei kein ssh-Aufruf" || falsch "dabei kein ssh-Aufruf"

schritt "2. Fehlt dem Geraet ein Werkzeug, aendert das Skript nichts"
x 'mv /bin/su /bin/su.weg'
if "$SKRIPT" "root@$C" >"$ARBEIT/fehlt.out" 2>&1; then
  falsch "ohne su verweigert"
else
  grep -q 'fehlt: su' "$ARBEIT/fehlt.out" && grep -q 'nichts geaendert' "$ARBEIT/fehlt.out" && ok "ohne su verweigert, mit Grund" || { falsch "ohne su verweigert (Grund)"; sed 's/^/    | /' "$ARBEIT/fehlt.out"; }
fi
x 'mv /bin/su.weg /bin/su'
pruefe "kein Benutzer voltpilot, kein /home/voltpilot, kein Dienst-Skript" '! id -u voltpilot 2>/dev/null && [ ! -e /home/voltpilot ] && [ ! -e /etc/init.d/vp-edge-industrie ]'

schritt "3. Einrichten (VP_SSH_KEY, Manifest)"
: > "$ARBEIT/ssh.log"
if VP_SSH_KEY="$ARBEIT/schluessel" VP_INDUSTRIE_MANIFEST="$MANIFEST" "$SKRIPT" "root@$C" >"$ARBEIT/install.1" 2>&1; then
  ok "install.sh laeuft durch"
else
  falsch "install.sh laeuft durch"; sed 's/^/    | /' "$ARBEIT/install.1"
fi
AUFRUFE="$(zeilen "$ARBEIT/ssh.log")"
if [ "$AUFRUFE" -gt 0 ] && [ "$(zeilen "$ARBEIT/ssh-i.log")" = "$AUFRUFE" ] && [ "$(sort -u "$ARBEIT/ssh-i.log")" = "$ARBEIT/schluessel" ]; then
  ok "jeder der $AUFRUFE ssh-Aufrufe bekommt -i <datei>"
else
  falsch "jeder ssh-Aufruf bekommt -i <datei> ($(zeilen "$ARBEIT/ssh-i.log") von $AUFRUFE)"
fi
grep -q 'Pruefsumme auf dem Geraet bestaetigt' "$ARBEIT/install.1" && ok "bestaetigte Fassung auf dem Geraet nachgeprueft" || falsch "bestaetigte Fassung auf dem Geraet nachgeprueft"
grep -qF "Lokale Web-App:    http://$C:8484" "$ARBEIT/install.1" && ok "Schlusszeile nennt die Adresse des Ziels" || falsch "Schlusszeile nennt die Adresse des Ziels"
grep -q 'lauscht er auf 1502' "$ARBEIT/install.1" && ok "Schlusszeile nennt Port 1502 des Datenspiegels" || falsch "Schlusszeile nennt Port 1502 des Datenspiegels"
grep -q 'laeuft aus /tmp/vp-edge-industrie' "$ARBEIT/install.1" && ok "/tmp startet Programme: das Programm laeuft aus dem RAM" || falsch "/tmp startet Programme: das Programm laeuft aus dem RAM"

eigner() { echo "[ \"\$(stat -c '%U %a' $1)\" = '$2' ]"; }
pruefe "Benutzer voltpilot ohne Anmeldung (Shell /bin/false), nicht root" '[ "$(id -u voltpilot)" -gt 0 ] && grep -q "^voltpilot:.*:/home/voltpilot:/bin/false$" /etc/passwd'
pruefe "root: /home/voltpilot (0755), libexec, Loader (0755), Dienst-Skript (0755), Einstellungen (0644)" \
  "$(eigner /home/voltpilot 'root 755') && $(eigner /home/voltpilot/libexec 'root 755') && $(eigner /home/voltpilot/libexec/boot.sh 'root 755') && $(eigner /etc/init.d/vp-edge-industrie 'root 755') && $(eigner /home/voltpilot/konfig 'root 644')"
pruefe "voltpilot: daten (0700), fassung, Vertrauens-Set, bestaetigte Fassung" \
  "$(eigner /home/voltpilot/daten 'voltpilot 700') && [ \"\$(stat -c %U /home/voltpilot/fassung)\" = voltpilot ] && [ \"\$(stat -c %U /home/voltpilot/daten/ota/trust-set.json)\" = voltpilot ] && [ \"\$(stat -c %U /home/voltpilot/fassung/vp-edge-industrie-linux-arm.gz)\" = voltpilot ]"
pruefe "kein halber Schreibrest (.neu, .tmp, .part)" '[ -z "$(find /home/voltpilot /etc/init.d -name "*.neu" -o -name "*.tmp" -o -name "*.part")" ]'
pruefe "voltpilot kann Loader, Einstellungen und Dienst-Skript nicht aendern" \
  '! su -s /bin/sh voltpilot -c "echo x >>/home/voltpilot/libexec/boot.sh" 2>/dev/null && ! su -s /bin/sh voltpilot -c "echo x >>/home/voltpilot/konfig" 2>/dev/null && ! su -s /bin/sh voltpilot -c "echo x >>/etc/init.d/vp-edge-industrie" 2>/dev/null && ! su -s /bin/sh voltpilot -c "mv /home/voltpilot/libexec /home/voltpilot/x" 2>/dev/null && ! su -s /bin/sh voltpilot -c "rm -f /home/voltpilot/konfig" 2>/dev/null && [ -f /home/voltpilot/konfig ]'
pruefe "Einstellungen: arch = arm, local_dir, enabled = 1, kein programm_dir" \
  'grep -qx "arch = arm" /home/voltpilot/konfig && grep -qx "local_dir = /home/voltpilot/fassung" /home/voltpilot/konfig && grep -qx "enabled = 1" /home/voltpilot/konfig && ! grep -q "^programm_dir" /home/voltpilot/konfig'
pruefe "Start beim Hochfahren: /etc/rc.d/S99_vp-edge-industrie -> ../init.d/vp-edge-industrie" '[ "$(readlink /etc/rc.d/S99_vp-edge-industrie)" = ../init.d/vp-edge-industrie ]'
if [ -n "$MANIFEST" ]; then
  GZ="$(sed -n 's/.*"gz_sha256": "\([0-9a-f]*\)".*/\1/p' "$MANIFEST")"
  pruefe "Pruefsummen-Datei: Zeile 2 ist gz_sha256 aus dem Manifest" "[ \"\$(sed -n 2p /home/voltpilot/fassung/vp-edge-industrie-linux-arm.sha256 | cut -d' ' -f1)\" = $GZ ]"
  GROESSE="$(wc -c <"$BIN" | tr -d ' ')"
  pruefe "Pruefsummen-Datei: groesse-Zeile mit der Programmgroesse" "grep -q '^groesse $GROESSE ' /home/voltpilot/fassung/vp-edge-industrie-linux-arm.sha256"
  pruefe "current.json: $FASSUNG, Stand $SEQ" "grep -q '\"release\":\"$FASSUNG\",\"release_seq\":$SEQ,\"state_schema\":1' /home/voltpilot/daten/ota/current.json"
fi
pruefe "der Loader verweigert den Start als root" '! /home/voltpilot/libexec/boot.sh 2>/tmp/root.out && grep -q "nie als root" /tmp/root.out'
pruefe "noch laeuft nichts: status meldet 3" '/etc/init.d/vp-edge-industrie status; [ "$?" = 3 ]'

schritt "4. Starten: das Programm laeuft als voltpilot"
x '/etc/init.d/vp-edge-industrie start' >"$ARBEIT/start.out" 2>&1 || true
grep -q 'gestartet' "$ARBEIT/start.out" && ok "start meldet: gestartet" || falsch "start meldet: gestartet"
warte_health "$ARBEIT/health"
grep -q '"ref":"edge-' "$ARBEIT/health" && ok "Programm laeuft, /health nennt die Referenz ($(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health"))" || { falsch "Programm laeuft, /health nennt die Referenz"; protokoll | tail -n 20 | sed 's/^/    | /'; }
grep -q "\"version\":\"$FASSUNG\"" "$ARBEIT/health" && ok "/health nennt die Fassung $FASSUNG" || falsch "/health nennt die Fassung $FASSUNG"
pruefe "status meldet 0 und nennt Dienst und Programm" '/etc/init.d/vp-edge-industrie status | grep -q "laeuft (Dienst [0-9]*, Programm [0-9]*)"'
pruefe "ein zweiter start startet nichts doppelt" '/etc/init.d/vp-edge-industrie start | grep -q "laeuft schon"'
# Das Programm: der Prozess aus der Kind-Datei des Dienstes.
pruefe "das Programm laeuft mit der Benutzernummer von voltpilot" \
  'k="$(cat /var/run/vp-edge-industrie.kind)"; u="$(id -u voltpilot)"; [ "$(awk "/^Uid:/ {print \$2, \$3, \$4}" /proc/$k/status)" = "$u $u $u" ] && tr "\000" " " </proc/$k/cmdline | grep -q "/tmp/vp-edge-industrie/vp-edge-industrie"'
# Die Klammern in den Mustern: die Pruefung findet so nicht ihre eigene Befehlszeile.
pruefe "kein Prozess des Programms oder des Loaders laeuft als root" \
  'for s in /proc/[0-9]*/status; do p="${s%/status}"; if tr "\000" " " <"$p/cmdline" 2>/dev/null | grep -q -e "/tmp/vp-edge-industrie/vp-edge[-]industrie" -e "libexec/boot[.]sh"; then [ "$(awk "/^Uid:/ {print \$2}" "$s")" != 0 ] || exit 1; fi; done'
pruefe "nice 10 und oom_score_adj 800" 'k="$(cat /var/run/vp-edge-industrie.kind)"; [ "$(awk "{print \$19}" /proc/$k/stat)" = 10 ] && [ "$(cat /proc/$k/oom_score_adj)" = 800 ]'
pruefe "RAM-Verzeichnis gehoert voltpilot (0700)" "$(eigner /tmp/vp-edge-industrie 'voltpilot 700')"
protokoll >"$ARBEIT/log.1"
grep -q "Loader PFC Stand $(sed -n 's/^PFC_LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$QUELLE/home/voltpilot/libexec/boot.sh") " "$ARBEIT/log.1" && ok "syslog: der Loader meldet seinen Stand" || falsch "syslog: der Loader meldet seinen Stand"
grep -q 'lokale Kopie entpackt' "$ARBEIT/log.1" && ok "syslog: bestaetigte Fassung aus dem Flash entpackt" || falsch "syslog: bestaetigte Fassung aus dem Flash entpackt"
if grep -q '"msg":"device detected","model":"WAGO 750-8212","arch":"arm"}' "$ARBEIT/log.1"; then
  ok "das Programm erkennt sein Geraet: WAGO 750-8212, arm"
else
  falsch "das Programm erkennt sein Geraet: WAGO 750-8212, arm"; grep 'device detected' "$ARBEIT/log.1" | sed 's/^/    | /'
fi
python3 - "$ARBEIT/health" "${MANIFEST:+$SEQ}" >"$ARBEIT/bereit" 2>&1 <<'PY' && ok "/health: Box-Art industrie, Vertrauens-Set geprueft$( [ -n "$MANIFEST" ] && echo ", current_seq $SEQ")" || { falsch "/health meldet update-bereit"; sed 's/^/    | /' "$ARBEIT/bereit"; }
import json, sys
u = json.load(open(sys.argv[1]))["ota_update"]
assert u["backend"] == "industrie", u
t = u["trust"]
assert t.get("trust_set_key_ids") and not t.get("trust_set_error"), t
if sys.argv[2]:
    assert u.get("current_seq") == int(sys.argv[2]), u
PY

schritt "5. Modbus-Datenspiegel: aus, Port 1502"
x 'wget -q -O - http://127.0.0.1:8484/api/mirror' >"$ARBEIT/mirror.1" 2>/dev/null || true
python3 - "$ARBEIT/mirror.1" >"$ARBEIT/mirror.aus" 2>&1 <<'PY' && ok "ab Werk aus; angezeigter Port 1502, Lauschport 1502" || { falsch "ab Werk aus; angezeigter Port 1502, Lauschport 1502"; sed 's/^/    | /' "$ARBEIT/mirror.aus"; }
import json, sys
m = json.load(open(sys.argv[1]))["mirror"]
assert m["enabled"] is False and m["running"] is False, m
assert m["advertise_port"] == 1502 and m["listen_port"] == 1502, m
PY
pruefe "nichts lauscht auf 502 oder 1502" '! netstat -ltn | grep -q -e ":502 " -e ":1502 "'
x "wget -q -O - --header 'Content-Type: application/json' --post-data '{\"enabled\":true}' http://127.0.0.1:8484/api/mirror" >"$ARBEIT/mirror.2" 2>/dev/null || true
sleep 2
pruefe "eingeschaltet lauscht er auf 1502 - und nichts auf 502" 'netstat -ltn | grep -q ":1502 " && ! netstat -ltn | grep -q ":502 "'
x "wget -q -O - --header 'Content-Type: application/json' --post-data '{\"enabled\":false}' http://127.0.0.1:8484/api/mirror" >/dev/null 2>&1 || true

schritt "6. Kein Loader-Selbstupdate"
pruefe "nichts unter /usr/libexec/vp-edge-light (Pfad des Mango-Loaders)" '[ ! -e /usr/libexec/vp-edge-light ]'
pruefe "Loader zeichengleich mit dem Quellstand" "[ \"\$(sha256sum /home/voltpilot/libexec/boot.sh | cut -d' ' -f1)\" = $(summe "$QUELLE/home/voltpilot/libexec/boot.sh") ]"
pruefe "Dienst-Skript zeichengleich mit dem Quellstand" "[ \"\$(sha256sum /etc/init.d/vp-edge-industrie | cut -d' ' -f1)\" = $(summe "$QUELLE/etc/init.d/vp-edge-industrie") ]"

schritt "7. Dienst: Neustart nach 10 s, stop, enabled = 0"
ALT="$(x 'cat /var/run/vp-edge-industrie.kind')"
x "kill -KILL $ALT"
sleep 4
pruefe "nach dem Ende des Programms wartet der Dienst (10 s Pause)" '/etc/init.d/vp-edge-industrie status | grep -q "wartet auf den naechsten Start"'
i=0
until [ "$i" -ge 60 ] || { NEU="$(x 'cat /var/run/vp-edge-industrie.kind 2>/dev/null')" && [ -n "$NEU" ] && [ "$NEU" != "$ALT" ]; }; do i=$((i + 1)); sleep 1; done
[ "$i" -ge 4 ] && [ "$i" -lt 60 ] && ok "der Dienst startet das Programm neu (nach $((i + 4)) s)" || falsch "der Dienst startet das Programm neu (nach $((i + 4)) s)"
warte_health "$ARBEIT/health"
grep -q '"status":"UP"' "$ARBEIT/health" && ok "das Programm antwortet wieder" || falsch "das Programm antwortet wieder"
protokoll >"$ARBEIT/log.2"
grep -q 'endete mit Code 137' "$ARBEIT/log.2" && ok "syslog nennt das Ende des Programms mit Code" || falsch "syslog nennt das Ende des Programms mit Code"
grep -q 'entpackte Fassung entspricht der bestaetigten' "$ARBEIT/log.2" && ok "die entpackte Fassung im RAM wird nach Pruefung wiederverwendet" || falsch "die entpackte Fassung im RAM wird nach Pruefung wiederverwendet"
T0="$(date +%s)"
x '/etc/init.d/vp-edge-industrie stop' >"$ARBEIT/stop.out" 2>&1 || true
T1="$(date +%s)"
grep -q 'beendet' "$ARBEIT/stop.out" && [ $((T1 - T0)) -le 25 ] && ok "stop beendet den Dienst ($((T1 - T0)) s)" || falsch "stop beendet den Dienst ($((T1 - T0)) s)"
pruefe "danach laeuft kein Prozess von voltpilot, 8484 ist frei, status meldet 3" \
  'u="$(id -u voltpilot)"; for s in /proc/[0-9]*/status; do [ "$(awk "/^Uid:/ {print \$2}" "$s" 2>/dev/null)" != "$u" ] || exit 1; done; ! netstat -ltn | grep -q ":8484 " && { /etc/init.d/vp-edge-industrie status; [ "$?" = 3 ]; }'
protokoll >"$ARBEIT/log.3"
grep -q 'endete mit Code 0' "$ARBEIT/log.3" && ok "das Programm endete auf stop geordnet (Code 0)" || { falsch "das Programm endete auf stop geordnet (Code 0)"; grep 'endete mit Code' "$ARBEIT/log.3" | tail -n 3 | sed 's/^/    | /'; }
x 'sed "s/^enabled = 1$/enabled = 0/" /home/voltpilot/konfig >/tmp/k && cat /tmp/k >/home/voltpilot/konfig'
pruefe "enabled = 0: start startet nichts" '/etc/init.d/vp-edge-industrie start | grep -q "nicht eingeschaltet" && sleep 2 && { /etc/init.d/vp-edge-industrie status; [ "$?" = 3 ]; }'
x 'sed "s/^enabled = 0$/enabled = 1/" /home/voltpilot/konfig >/tmp/k && cat /tmp/k >/home/voltpilot/konfig'

schritt "8. Neustart des Geraets: RAM leer, der Dienst startet von selbst"
x '/etc/init.d/vp-edge-industrie start' >/dev/null 2>&1 || true
warte_health "$ARBEIT/health"
REF_VOR="$(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health")"
# Hartes Ende wie ein Stromausfall: die PID-Dateien bleiben liegen.
x ': >/var/log/messages'
docker kill "$C" >/dev/null
docker start "$C" >/dev/null
sleep 2
warte_health "$ARBEIT/health"
grep -q '"status":"UP"' "$ARBEIT/health" && ok "der Dienst startet ueber /etc/rc.d von selbst, das Programm antwortet" || { falsch "der Dienst startet ueber /etc/rc.d von selbst, das Programm antwortet"; protokoll | tail -n 20 | sed 's/^/    | /'; }
protokoll >"$ARBEIT/log.4"
grep -q 'lokale Kopie entpackt' "$ARBEIT/log.4" && ok "der RAM war leer: die bestaetigte Fassung wurde neu entpackt" || falsch "der RAM war leer: die bestaetigte Fassung wurde neu entpackt"
REF_NACH="$(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health")"
[ -n "$REF_VOR" ] && [ "$REF_VOR" = "$REF_NACH" ] && ok "die Box behaelt ihre Identitaet ueber den Neustart ($REF_NACH)" || falsch "die Box behaelt ihre Identitaet ueber den Neustart ($REF_VOR / $REF_NACH)"

schritt "9. Zweiter Aufruf ohne VP_SSH_KEY, bei laufendem Dienst"
REF1="$(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health")"
x 'sed "s/^nice = 10$/nice = 12/" /home/voltpilot/konfig >/tmp/k && cat /tmp/k >/home/voltpilot/konfig'
VOR="$(zeilen "$ARBEIT/ssh-i.log")"
if VP_INDUSTRIE_MANIFEST="$MANIFEST" "$SKRIPT" "root@$C" >"$ARBEIT/install.2" 2>&1; then ok "install.sh laeuft durch"; else falsch "install.sh laeuft durch"; sed 's/^/    | /' "$ARBEIT/install.2"; fi
[ "$(zeilen "$ARBEIT/ssh-i.log")" = "$VOR" ] && ok "ohne VP_SSH_KEY kein -i" || falsch "ohne VP_SSH_KEY kein -i"
pruefe "die Einstellungen bleiben (nice = 12), jede Angabe steht einmal da" \
  'grep -qx "nice = 12" /home/voltpilot/konfig && [ "$(grep -c "^enabled = " /home/voltpilot/konfig)" = 1 ] && [ "$(grep -c "^arch = " /home/voltpilot/konfig)" = 1 ] && [ "$(grep -c "^local_dir = " /home/voltpilot/konfig)" = 1 ] && ! grep -q "^programm_dir" /home/voltpilot/konfig'
pruefe "ein Benutzer voltpilot, ein Link in /etc/rc.d" '[ "$(grep -c "^voltpilot:" /etc/passwd)" = 1 ] && [ "$(ls /etc/rc.d | grep -c vp-edge-industrie)" = 1 ]'
x '/etc/init.d/vp-edge-industrie restart' >/dev/null 2>&1 || true
warte_health "$ARBEIT/health"
REF2="$(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health")"
[ -n "$REF1" ] && [ "$REF1" = "$REF2" ] && ok "die Box behaelt ihre Identitaet ($REF2)" || falsch "die Box behaelt ihre Identitaet ($REF1 / $REF2)"
pruefe "nach restart laeuft das Programm mit nice 12" 'k="$(cat /var/run/vp-edge-industrie.kind)"; [ "$(awk "{print \$19}" /proc/$k/stat)" = 12 ]'
x '/etc/init.d/vp-edge-industrie stop' >/dev/null 2>&1 || true

schritt "10. /tmp startet keine Programme (noexec): das Programm laeuft aus dem Flash"
ZIEL="$C2"
geraet "$C2" "rw,noexec,size=256m"
if VP_INDUSTRIE_MANIFEST="$MANIFEST" VP_PFC_RC_LINK=S98_vp-edge-industrie "$SKRIPT" "root@$C2" >"$ARBEIT/install.3" 2>&1; then ok "install.sh laeuft durch"; else falsch "install.sh laeuft durch"; sed 's/^/    | /' "$ARBEIT/install.3"; fi
grep -q 'startet keine Programme (noexec)' "$ARBEIT/install.3" && ok "install.sh erkennt es und nennt es" || falsch "install.sh erkennt es und nennt es"
pruefe "Einstellungen: programm_dir = /home/voltpilot/programm (gehoert voltpilot)" 'grep -qx "programm_dir = /home/voltpilot/programm" /home/voltpilot/konfig && [ "$(stat -c %U /home/voltpilot/programm)" = voltpilot ]'
pruefe "VP_PFC_RC_LINK: der Link heisst S98_vp-edge-industrie" '[ "$(readlink /etc/rc.d/S98_vp-edge-industrie)" = ../init.d/vp-edge-industrie ] && [ ! -e /etc/rc.d/S99_vp-edge-industrie ]'
x '/etc/init.d/vp-edge-industrie start' >/dev/null 2>&1 || true
warte_health "$ARBEIT/health"
grep -q '"status":"UP"' "$ARBEIT/health" && ok "das Programm laeuft" || { falsch "das Programm laeuft"; protokoll | tail -n 20 | sed 's/^/    | /'; }
pruefe "es laeuft aus dem Flash, der fluechtige Zustand bleibt im RAM" \
  'k="$(cat /var/run/vp-edge-industrie.kind)"; tr "\000" " " </proc/$k/cmdline | grep -q "/home/voltpilot/programm/vp-edge-industrie" && [ ! -e /tmp/vp-edge-industrie/vp-edge-industrie ] && [ -d /tmp/vp-edge-industrie/ota ] && [ -L /home/voltpilot/daten/buffer ]'
x '/etc/init.d/vp-edge-industrie stop' >/dev/null 2>&1 || true
ZIEL="$C"

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'busybox | head -n 1' | cut -d'(' -f1 | sed 's/ *$//'), $(x 'uname -m'))"
[ "$FEHLER" -eq 0 ]
