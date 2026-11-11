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
#   4. ein zweiter Aufruf ohne VP_SSH_KEY ruft ssh ohne -i auf,
#   5. die Schlusszeile nennt die Web-App unter der Adresse des Ziels,
#   7. die Firewall-Regel fuer OCPP (TCP 8887 aus der Zone wan) steht benannt
#      in /etc/config/firewall und bleibt bei einem zweiten Aufruf EINE Regel;
#      die Schlusszeilen nennen die DHCP-Reservierung,
#   6. update-bereit (Konzept vp-edge-light-update, K5): base_url wird
#      verweigert bzw. von der Box entfernt, ein fremdes Manifest und ein
#      fehlendes Vertrauens-Set verweigert, bevor etwas auf die Box geht; das
#      Vertrauens-Set (das echte, root-signierte aus edge-app/ota) liegt im
#      Flash statt im alten RAM-Symlink, die Pruefsummen-Datei traegt die
#      Nachlade-Pruefsumme, current.json den Stand - und /health meldet
#      Box-Art light, ein gepruefte Vertrauens-Set und current_seq.
#      Volle Pruefung nur mit einer Fassung mit Release-Namen:
#        VP_LIGHT_VERSION=edge-light-2099.01.0 edge-light/scripts/build.sh amd64
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
REPO="$(cd "$HIER/../.." && pwd -P)"
# Das echte, root-signierte Vertrauens-Set (oeffentlich, im Repo). Nie vom
# Portal laden: die Probe beruehrt kein Live-System.
VP_TRUST_SET_DIR="$REPO/edge-app/ota"
export VP_TRUST_SET_DIR

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

schritt "0. Fassung und Manifest (Werkzeug vp-ota)"
FASSUNG="$(docker run --rm --network none -v "$BIN:/p:ro" "$BILD" /p version 2>/dev/null || true)"
MANIFEST=""
SEQ=77
case "$FASSUNG" in
  edge-light-[0-9][0-9][0-9][0-9].[0-9][0-9].*)
    gzip -9 -n -c "$BIN" >"$ARBEIT/prog.gz"
    if (cd "$REPO/edge-app/core" && go run ./cmd/vp-ota manifest --release "$FASSUNG" --seq "$SEQ" --commit 3bf8c038a1b2 \
      --binary "vp-edge-light:linux/amd64=$BIN,$ARBEIT/prog.gz" --state-schema 1 --key-id rel-2026-a \
      --out "$ARBEIT/release.json") >/dev/null 2>&1; then
      MANIFEST="$ARBEIT/release.json"
      ok "Manifest fuer $FASSUNG (Stand $SEQ) erzeugt"
    else
      falsch "Manifest fuer $FASSUNG erzeugt"
    fi
    ;;
  *) echo "  uebersprungen: Fassung '$FASSUNG' ohne Release-Namen - ohne Manifest (VP_LIGHT_VERSION=edge-light-2099.01.0 build.sh amd64)" ;;
esac

schritt "1. Verweigert, bevor etwas auf die Box geht"
: > "$ARBEIT/schluessel"
if VP_LIGHT_ARCH=sparc "$SKRIPT" root@box >/dev/null 2>&1; then falsch "unbekannte Bauart verweigert"; else ok "unbekannte Bauart verweigert"; fi
if VP_LIGHT_ARCH=amd64 VP_SSH_KEY="$ARBEIT/gibt-es-nicht" "$SKRIPT" root@box >/dev/null 2>&1; then
  falsch "fehlende Schluesseldatei verweigert"
else
  ok "fehlende Schluesseldatei verweigert"
fi
if VP_LIGHT_ARCH=amd64 "$SKRIPT" root@box https://downloads.example.invalid/edge-light >/dev/null 2>&1; then
  falsch "base_url als zweites Argument verweigert"
else
  ok "base_url als zweites Argument verweigert"
fi
if VP_LIGHT_ARCH=amd64 VP_TRUST_SET_DIR='' VP_PORTAL_URL=http://127.0.0.1:9 "$SKRIPT" root@box >/dev/null 2>&1; then
  falsch "ohne Vertrauens-Set verweigert"
else
  ok "ohne Vertrauens-Set verweigert"
fi
printf '{\n  "release": "edge-light-2099.01.0",\n  "release_seq": 5,\n  "artifacts": [\n    {\n      "arch": "linux/amd64",\n      "sha256": "%s",\n      "gz_sha256": "%s"\n    }\n  ]\n}\n' "$(printf '0%.0s' $(seq 64))" "$(printf '1%.0s' $(seq 64))" >"$ARBEIT/fremd.json"
if VP_LIGHT_ARCH=amd64 VP_LIGHT_MANIFEST="$ARBEIT/fremd.json" "$SKRIPT" root@box >"$ARBEIT/fremd.out" 2>&1; then
  falsch "Manifest eines anderen Programms verweigert"
else
  grep -q "anderes Programm" "$ARBEIT/fremd.out" && ok "Manifest eines anderen Programms verweigert" || falsch "Manifest eines anderen Programms verweigert (Grund)"
fi
[ "$(zeilen "$ARBEIT/ssh.log")" = 0 ] && ok "dabei kein ssh-Aufruf" || falsch "dabei kein ssh-Aufruf"

schritt "2. VP_SSH_KEY und VP_LIGHT_ARCH=amd64 (auf einer Box mit Stufe 1)"
# Der Stand einer Box mit Stufe 1: ota als Symlink in den RAM, base_url gesetzt.
x 'mkdir -p /etc/vp-edge-light /tmp/vp-edge-light/ota && ln -s /tmp/vp-edge-light/ota /etc/vp-edge-light/ota
   mkdir -p /etc/config && printf "config vp-edge-light main\n\toption base_url https://downloads.example.invalid\n\toption enabled 0\n" >/etc/config/vp-edge-light'
if VP_LIGHT_ARCH=amd64 VP_SSH_KEY="$ARBEIT/schluessel" VP_LIGHT_MANIFEST="$MANIFEST" "$SKRIPT" root@box >"$ARBEIT/install.1" 2>&1; then
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
grep -qF 'Lokale Web-App:    http://box:8484' "$ARBEIT/install.1" && ok "Schlusszeile nennt die Adresse des Ziels" || falsch "Schlusszeile nennt die Adresse des Ziels"
grep -q 'DHCP-RESERVIERUNG' "$ARBEIT/install.1" && ok "Schlusszeilen nennen die DHCP-Reservierung fuer OCPP" || falsch "Schlusszeilen nennen die DHCP-Reservierung fuer OCPP"

schritt "2b. Firewall: OCPP aus dem Kundennetz"
pruefe "Regel firewall.vp_ocpp: wan -> tcp 8887 ACCEPT" '[ "$(uci get firewall.vp_ocpp)" = rule ] && [ "$(uci get firewall.vp_ocpp.src)" = wan ] && [ "$(uci get firewall.vp_ocpp.proto)" = tcp ] && [ "$(uci get firewall.vp_ocpp.dest_port)" = 8887 ] && [ "$(uci get firewall.vp_ocpp.target)" = ACCEPT ]'
pruefe "genau eine Regel fuer 8887" '[ "$(uci show firewall | grep -c "dest_port=.8887.")" = 1 ]'
pruefe "8484 und 1883 nicht geoeffnet" '! uci show firewall | grep -q "dest_port=.8484." && ! uci show firewall | grep -q "dest_port=.1883."'

schritt "3. Die Bauart steht auf der Box, der Loader startet ihre Kopie"
pruefe "uci vp-edge-light.main.arch = amd64" '[ "$(uci get vp-edge-light.main.arch)" = amd64 ]'
pruefe "lokale Kopie vp-edge-light-linux-amd64.gz im Flash" '[ -s /usr/share/vp-edge-light/vp-edge-light-linux-amd64.gz ]'
x '/etc/init.d/vp-edge-light restart' >/dev/null 2>&1 || true
i=0
until x 'wget -q -O - http://127.0.0.1:8484/health' >"$ARBEIT/health" 2>/dev/null || [ "$i" -ge 60 ]; do i=$((i + 1)); sleep 1; done
grep -q '"ref":"edge-' "$ARBEIT/health" && ok "Programm laeuft, /health nennt die Referenz ($(sed -n 's/.*"ref":"\(edge-[^"]*\)".*/\1/p' "$ARBEIT/health"))" || falsch "Programm laeuft, /health nennt die Referenz"
pruefe "Loader: lokale Kopie entpackt" 'logread -l 200 -e vp-edge-light | grep -q "lokale Kopie entpackt"'
pruefe "Loader: keine Meldung \"weder base_url noch lokale Kopie\"" '! logread -l 200 -e vp-edge-light | grep -q "weder base_url noch lokale Kopie"'
# Lader-Selbstupdate: der eingespielte Loader traegt seine LOADER_STAND-Marke
# (so erkennt das Programm, ob sein eingebetteter Stand neuer ist), er meldet
# sie beim Start, und das atomare Schreiben laesst keinen halben Rest zurueck.
# Nur mit Marke im Quellstand - eine Gegenprobe mit einem alten Stand hat keine.
STAND="$(sed -n 's/^LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$(dirname "$SKRIPT")/files/usr/libexec/vp-edge-light/boot.sh")"
if [ -n "$STAND" ]; then
  pruefe "Loader traegt LOADER_STAND=$STAND" "grep -qx 'LOADER_STAND=$STAND' /usr/libexec/vp-edge-light/boot.sh"
  pruefe "Loader meldet seinen Stand" "logread -l 200 -e vp-edge-light | grep -q 'Loader Stand $STAND'"
  pruefe "kein halber Schreibrest (.neu) von Loader/Dienst/Konfiguration" \
    '[ ! -f /usr/libexec/vp-edge-light/boot.sh.neu ] && [ ! -f /etc/init.d/vp-edge-light.neu ] && [ ! -f /etc/config/vp-edge-light.neu ]'
fi

schritt "3b. Update-bereit"
pruefe "Vertrauens-Set im Flash (kein RAM-Symlink mehr)" '[ -d /etc/vp-edge-light/ota ] && [ ! -L /etc/vp-edge-light/ota ] && [ -s /etc/vp-edge-light/ota/trust-set.json ] && [ -s /etc/vp-edge-light/ota/trust-set.json.sig ]'
pruefe "base_url auf der Box entfernt" '! uci -q get vp-edge-light.main.base_url'
if [ -n "$MANIFEST" ]; then
  GZ="$(sed -n 's/.*"gz_sha256": "\([0-9a-f]*\)".*/\1/p' "$MANIFEST")"
  pruefe "Pruefsummen-Datei: Zeile 2 ist gz_sha256 aus dem Manifest" "[ \"\$(sed -n 2p /usr/share/vp-edge-light/vp-edge-light-linux-amd64.sha256 | cut -d' ' -f1)\" = $GZ ]"
  GROESSE="$(wc -c <"$BIN" | tr -d ' ')"
  pruefe "Pruefsummen-Datei: groesse-Zeile mit der Programmgroesse (Speicherschwelle des Loaders)" \
    "grep -q '^groesse $GROESSE ' /usr/share/vp-edge-light/vp-edge-light-linux-amd64.sha256"
  pruefe "current.json: $FASSUNG, Stand $SEQ" "grep -q '\"release\":\"$FASSUNG\",\"release_seq\":$SEQ,\"state_schema\":1' /etc/vp-edge-light/ota/current.json"
fi
x 'wget -q -O - http://127.0.0.1:8484/health' >"$ARBEIT/health" 2>/dev/null || true
python3 - "$ARBEIT/health" "${MANIFEST:+$SEQ}" >"$ARBEIT/bereit" 2>&1 <<'PY' && ok "/health: Box-Art light, Vertrauens-Set geprueft$( [ -n "$MANIFEST" ] && echo ", current_seq $SEQ")" || { falsch "/health meldet update-bereit"; sed 's/^/    | /' "$ARBEIT/bereit"; }
import json, sys
u = json.load(open(sys.argv[1]))["ota_update"]
assert u["backend"] == "light", u
t = u["trust"]
assert t.get("trust_set_key_ids") and not t.get("trust_set_error"), t
if sys.argv[2]:
    assert u.get("current_seq") == int(sys.argv[2]), u
PY

schritt "4. Zweiter Aufruf ohne VP_SSH_KEY"
VOR="$(zeilen "$ARBEIT/ssh-i.log")"
if VP_LIGHT_ARCH=amd64 VP_LIGHT_MANIFEST="$MANIFEST" "$SKRIPT" root@box >"$ARBEIT/install.2" 2>&1; then ok "install.sh laeuft durch"; else falsch "install.sh laeuft durch"; sed 's/^/    | /' "$ARBEIT/install.2"; fi
[ "$(zeilen "$ARBEIT/ssh-i.log")" = "$VOR" ] && ok "ohne VP_SSH_KEY kein -i" || falsch "ohne VP_SSH_KEY kein -i"
pruefe "Bauart bleibt amd64" '[ "$(uci get vp-edge-light.main.arch)" = amd64 ]'
pruefe "Firewall-Regel bleibt EINE (kein Doppel beim zweiten Aufruf)" '[ "$(uci show firewall | grep -c "dest_port=.8887.")" = 1 ]'

schritt "Ergebnis"
echo "  $OK ok, $FEHLER Fehler ($(x 'grep DISTRIB_DESCRIPTION /etc/openwrt_release' | cut -d"'" -f2))"
[ "$FEHLER" -eq 0 ]
