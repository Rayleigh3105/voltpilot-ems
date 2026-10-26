#!/bin/sh
# Probe fuer edge-light/openwrt/install.sh gegen ein ECHTES OpenWrt 25.12
# (Rootfs mit procd, uci und BusyBox als Container, ohne Netz) - ohne Mango
# und ohne Root auf dem Rechner. Das Programm ist die amd64-Fassung, damit es
# im Container startet; eben deshalb prueft die Probe die Bauart auf der Box.
#
#   1. eine unbekannte Bauart und eine fehlende Schluesseldatei werden
#      verweigert, bevor etwas auf die Box geht,
#   2. VP_SSH_KEY nennt die Schluesseldatei fuer JEDEN ssh-Aufruf,
#   3. die Bauart steht danach auf der Box (uci vp-edge-light.main.arch), und
#      der Loader startet die lokale Kopie dieser Bauart,
#   4. ein zweiter Aufruf ohne VP_SSH_KEY ruft ssh ohne -i auf.
#
# "ssh" ist ein Ersatz, der die Befehle per docker exec im Container
# ausfuehrt und eine Schluesseldatei (-i) nur mitschreibt.
#
#   edge-light/scripts/build.sh amd64
#   edge-light/test/install-probe.sh
#   VPIP_SKRIPT=<dir>/openwrt/install.sh ...   Gegenprobe mit einem anderen Stand
#                                (daneben <dir>/dist mit dem amd64-Programm)
# shellcheck disable=SC2015,SC2016 # ok/falsch-Zeilen; die Pruefausdruecke werten im Container aus
set -eu

HIER="$(cd "$(dirname "$0")" && pwd -P)"
SKRIPT="${VPIP_SKRIPT:-$HIER/../openwrt/install.sh}"
BIN="$(dirname "$SKRIPT")/../dist/vp-edge-light-linux-amd64"
BILD="${VPIP_BILD:-openwrt/rootfs:x86-64-25.12.5}"
C="vpip-$$"
ARBEIT="$(mktemp -d)"
OK=0
FEHLER=0

aufraeumen() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$ARBEIT"; }
trap aufraeumen EXIT INT TERM

ok() { OK=$((OK + 1)); echo "  ok      $*"; }
falsch() { FEHLER=$((FEHLER + 1)); echo "  FEHLER  $*"; }
schritt() { echo; echo "== $*"; }
pruefe() { # pruefe <beschreibung> <befehl im container...>
  b="$1"; shift
  if docker exec "$C" sh -c "$*" >/dev/null 2>&1; then ok "$b"; else falsch "$b"; fi
}
x() { docker exec "$C" sh -c "$*"; }

[ -f "$BIN" ] || { echo "FEHLER: erst edge-light/scripts/build.sh amd64" >&2; exit 1; }

# ssh-Ersatz: ssh [-i <datei>] <ziel> <befehl>  ->  docker exec im Container
mkdir -p "$ARBEIT/bin"
cat > "$ARBEIT/bin/ssh" <<EOF
#!/bin/sh
echo aufruf >> "$ARBEIT/ssh.log"
if [ "\$1" = -i ]; then echo "\$2" >> "$ARBEIT/ssh-i.log"; shift 2; fi
shift
exec docker exec -i "$C" sh -c "\$1"
EOF
chmod +x "$ARBEIT/bin/ssh"
PATH="$ARBEIT/bin:$PATH"
export PATH
zeilen() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

schritt "Aufbau: OpenWrt mit procd, ohne Netz"
docker run -d --name "$C" --network none "$BILD" /sbin/init >/dev/null
i=0
until x 'ubus list service' >/dev/null 2>&1 || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
pruefe "procd antwortet" 'ubus list service'

schritt "1. Verweigert, bevor etwas auf die Box geht"
: > "$ARBEIT/schluessel"
if VP_LIGHT_ARCH=sparc "$SKRIPT" root@box >/dev/null 2>&1; then falsch "unbekannte Bauart verweigert"; else ok "unbekannte Bauart verweigert"; fi
if VP_LIGHT_ARCH=amd64 VP_SSH_KEY="$ARBEIT/gibt-es-nicht" "$SKRIPT" root@box >/dev/null 2>&1; then
  falsch "fehlende Schluesseldatei verweigert"
else
  ok "fehlende Schluesseldatei verweigert"
fi
[ "$(zeilen "$ARBEIT/ssh.log")" = 0 ] && ok "dabei kein ssh-Aufruf" || falsch "dabei kein ssh-Aufruf"

schritt "2. VP_SSH_KEY und VP_LIGHT_ARCH=amd64"
if VP_LIGHT_ARCH=amd64 VP_SSH_KEY="$ARBEIT/schluessel" "$SKRIPT" root@box >"$ARBEIT/install.1" 2>&1; then
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
grep -q 'Pruefsumme auf dem Geraet bestaetigt' "$ARBEIT/install.1" && ok "lokale Kopie auf der Box nachgeprueft" || falsch "lokale Kopie auf der Box nachgeprueft"

schritt "3. Die Bauart steht auf der Box, der Loader startet ihre Kopie"
pruefe "uci vp-edge-light.main.arch = amd64" '[ "$(uci get vp-edge-light.main.arch)" = amd64 ]'
pruefe "lokale Kopie vp-edge-light-linux-amd64.gz im Flash" '[ -s /usr/share/vp-edge-light/vp-edge-light-linux-amd64.gz ]'
x '/etc/init.d/vp-edge-light restart' >/dev/null 2>&1 || true
i=0
until x 'wget -q -O - http://127.0.0.1:8484/health' >"$ARBEIT/health" 2>/dev/null || [ "$i" -ge 60 ]; do i=$((i + 1)); sleep 1; done
grep -q '"ref":"edge-' "$ARBEIT/health" && ok "Programm laeuft, /health nennt die Referenz ($(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health"))" || falsch "Programm laeuft, /health nennt die Referenz"
pruefe "Loader: lokale Kopie entpackt" 'logread -l 200 -e vp-edge-light | grep -q "lokale Kopie entpackt"'
pruefe "Loader: keine Meldung \"weder base_url noch lokale Kopie\"" '! logread -l 200 -e vp-edge-light | grep -q "weder base_url noch lokale Kopie"'

schritt "4. Zweiter Aufruf ohne VP_SSH_KEY"
VOR="$(zeilen "$ARBEIT/ssh-i.log")"
if VP_LIGHT_ARCH=amd64 "$SKRIPT" root@box >"$ARBEIT/install.2" 2>&1; then ok "install.sh laeuft durch"; else falsch "install.sh laeuft durch"; fi
[ "$(zeilen "$ARBEIT/ssh-i.log")" = "$VOR" ] && ok "ohne VP_SSH_KEY kein -i" || falsch "ohne VP_SSH_KEY kein -i"
pruefe "Bauart bleibt amd64" '[ "$(uci get vp-edge-light.main.arch)" = amd64 ]'

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'grep DISTRIB_DESCRIPTION /etc/openwrt_release' | cut -d"'" -f2))"
[ "$FEHLER" -eq 0 ]
