#!/bin/sh
# Edge Light auf einem OpenWrt-Geraet einrichten - update-bereit (Konzept
# vp-edge-light-update, K5).
#
# Kopiert Loader, Dienst und Standard-Konfiguration auf das Geraet, legt das
# Vertrauens-Set in den Flash und spielt das Programm als BESTAETIGTE Fassung
# ein (gzip im Flash, mit Pruefsumme). Danach kommen neue Fassungen signiert
# ueber das Portal (Edge-Updates); der Loader tauscht und nimmt zurueck.
# Fixes an Loader und Dienst-Init bringt seither jedes Programm eingebettet
# mit und spielt sie als bestaetigte Fassung selbst ein (Loader-Selbstupdate,
# LOADER_STAND in boot.sh) - dieses Skript bleibt fuer die Ersteinrichtung,
# das Nachruesten von Stufe 1, die Tunnel-Skripte und die Konfiguration.
#
#   edge-light/scripts/build.sh mipsle        (oder die Fassung aus einem Release)
#   edge-light/openwrt/install.sh root@192.168.1.1
#
# Umgebung:
#   VP_SSH_KEY=<datei>         Schluesseldatei fuer ssh (ssh -i), wie service-tunnel.sh;
#                              ohne die Variable entscheidet ~/.ssh/config.
#   VP_LIGHT_ARCH              Bauart (mipsle, arm64, amd64); wird auf der Box eingetragen.
#   VP_LIGHT_MANIFEST=<datei>  das signierte Manifest (release.json) GENAU dieser Fassung.
#                              Damit vermerkt die Box den Stand (current.json: release_seq,
#                              state_schema = Anti-Rollback-Boden) und kann die bestaetigte
#                              Fassung nach einem Stromausfall beim Update aus dem Portal
#                              nachladen. Ohne Manifest: Programm laeuft, die Box ist aber
#                              erst nach dem ersten Update ueber das Portal voll update-bereit.
#   VP_TRUST_SET_DIR=<dir>     trust-set.json + trust-set.json.sig von dort (Labor: eigenes
#                              Labor-Vertrauens-Set). Sonst offen vom Portal geladen:
#   VP_PORTAL_URL              Vorgabe https://portal.voltpilot.de
#                              (/api/v1/edge/trust-set/trust-set.json und .sig)
#
# Ein erneuter Aufruf aktualisiert Loader, Dienst, Vertrauens-Set und Fassung;
# die Box-Daten bleiben (Identitaet, Zertifikat, Auswahl, Konfiguration). Nur
# local_dir, arch und enabled werden gesetzt; ein altes base_url wird entfernt
# (abgeschafft: es lud ungeprueft). Danach auf dem Geraet:
#   /etc/init.d/vp-edge-light restart ; logread -f -e vp-edge-light
#
# Firewall: Ladesaeulen stehen im Kundennetz, also auf der WAN-Seite der Box,
# und waehlen die Box unter ws://<box>:8887/ocpp/<kennung> an. Die WAN-Zone von
# OpenWrt weist eingehend alles ab; das Skript legt deshalb EINE benannte Regel
# an (firewall.vp_ocpp: TCP 8887 aus der Zone wan, ACCEPT) und laedt die
# Firewall neu. Der OCPP-Server der Box nimmt nur eingetragene Kennungen an.
# Nichts sonst wird geoeffnet: 8484 (Web-App) und 1883 (lokaler Bus) bleiben,
# wie sie sind. Am Gerät gefunden am 03.10.2026 (edge-light/docs/mango.md).
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.1}"
if [ "$#" -gt 1 ]; then
  echo "FEHLER: base_url ist abgeschafft - neue Fassungen kommen signiert ueber das Portal" >&2
  exit 1
fi
ARCH="${VP_LIGHT_ARCH:-mipsle}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/../dist/vp-edge-light-linux-$ARCH"
NAME="vp-edge-light-linux-$ARCH"
LOCAL_DIR=/usr/share/vp-edge-light
OTA_FEST=/etc/vp-edge-light/ota
PORTAL="${VP_PORTAL_URL:-https://portal.voltpilot.de}"
MANIFEST="${VP_LIGHT_MANIFEST:-}"

case "$ARCH" in
  mipsle | arm64 | amd64) ;;
  *) echo "FEHLER: unbekannte Bauart VP_LIGHT_ARCH=$ARCH (mipsle|arm64|amd64)" >&2; exit 1 ;;
esac
if [ ! -f "$BIN" ]; then
  echo "FEHLER: das Programm fehlt ($BIN) - erst edge-light/scripts/build.sh $ARCH" >&2
  exit 1
fi
if [ -n "${VP_SSH_KEY:-}" ] && [ ! -r "$VP_SSH_KEY" ]; then
  echo "FEHLER: VP_SSH_KEY=$VP_SSH_KEY ist keine lesbare Schluesseldatei" >&2
  exit 1
fi
# box_ssh <ziel> <befehl> - ssh zur Box, mit VP_SSH_KEY als Schluesseldatei
box_ssh() {
  if [ -n "${VP_SSH_KEY:-}" ]; then
    ssh -i "$VP_SSH_KEY" "$@"
  else
    ssh "$@"
  fi
}
summe() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$1" | awk '{print $1}'; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
SUM="$(summe "$BIN")"

# --- Was die Box ueber diese Fassung wissen muss: aus dem Manifest ---------------
# Das Manifest kommt deterministisch aus `vp-ota manifest` (eine Angabe je
# Zeile); gelesen wird nur, was die Box braucht. Es muss GENAU dieses Programm
# beschreiben - sonst stimmten Boden und Nachlade-Pruefsumme nicht.
REL=""
SEQ=""
SCHEMA=""
GZSUM=""
if [ -n "$MANIFEST" ]; then
  [ -r "$MANIFEST" ] || { echo "FEHLER: VP_LIGHT_MANIFEST=$MANIFEST ist nicht lesbar" >&2; exit 1; }
  wert() { sed -n "s/^  \"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$MANIFEST" | head -n 1; }
  REL="$(wert release)"
  SEQ="$(wert release_seq)"
  SCHEMA="$(wert state_schema)"
  # shellcheck disable=SC2046 # bewusst zwei Woerter: sha256 und gz_sha256
  set -- $(awk -v a="linux/$ARCH" '
    index($0, "\"arch\": \"" a "\"") { f = 1; next }
    f && /"sha256":/ { gsub(/[",]/, "", $2); s = $2 }
    f && /"gz_sha256":/ { gsub(/[",]/, "", $2); g = $2 }
    f && /}/ { f = 0 }
    END { print s, g }' "$MANIFEST")
  MSUM="${1:-}"
  GZSUM="${2:-}"
  case "$REL" in edge-light-*) ;; *) echo "FEHLER: $MANIFEST ist kein Edge-Light-Manifest (release '$REL')" >&2; exit 1 ;; esac
  case "$SEQ" in '' | *[!0-9]*) echo "FEHLER: $MANIFEST traegt keine release_seq" >&2; exit 1 ;; esac
  case "$SCHEMA" in '' | *[!0-9]*) SCHEMA=0 ;; esac
  if [ "$MSUM" != "$SUM" ] || [ -z "$GZSUM" ]; then
    echo "FEHLER: das Manifest $REL beschreibt fuer linux/$ARCH ein anderes Programm (Manifest ${MSUM:-keins}, Programm $SUM)" >&2
    exit 1
  fi
  echo "--- Fassung $REL (Stand $SEQ, Datenformat $SCHEMA) laut signiertem Manifest"
else
  echo "--- ohne Manifest (VP_LIGHT_MANIFEST): kein Anti-Rollback-Boden, kein Nachladen der bestaetigten Fassung bis zum ersten Update"
fi

# --- Vertrauens-Set ---------------------------------------------------------------
# Die Box prueft die Root-Signatur selbst gegen ihre eingebackene Wurzel; der
# Weg hierher begruendet kein Vertrauen (docs/ota-signing.md, Trust-Set).
if [ -n "${VP_TRUST_SET_DIR:-}" ]; then
  cp "$VP_TRUST_SET_DIR/trust-set.json" "$tmp/trust-set.json"
  cp "$VP_TRUST_SET_DIR/trust-set.json.sig" "$tmp/trust-set.json.sig"
else
  hole() { # hole <url> <ziel> - curl, sonst wget (Alpine/BusyBox)
    if command -v curl >/dev/null 2>&1; then
      curl -fsS --max-time 30 -o "$2" "$1"
    else
      wget -q -T 30 -O "$2" "$1"
    fi
  }
  for f in trust-set.json trust-set.json.sig; do
    hole "$PORTAL/api/v1/edge/trust-set/$f" "$tmp/$f" || {
      echo "FEHLER: Vertrauens-Set nicht ladbar ($PORTAL/api/v1/edge/trust-set/$f) - VP_PORTAL_URL oder VP_TRUST_SET_DIR" >&2
      exit 1
    }
  done
fi
if ! grep -q '"keys"' "$tmp/trust-set.json" || ! grep -q '"signature"' "$tmp/trust-set.json.sig"; then
  echo "FEHLER: das Vertrauens-Set sieht nicht wie trust-set.json/.sig aus" >&2
  exit 1
fi

echo "--- kopiere Loader und Dienst nach $TARGET"
# Einzeldateien per cat|ssh: Dropbear auf OpenWrt bringt oft kein scp/sftp mit.
# Atomar (temporaere Datei, dann mv, dann sync): Strom weg oder ein gerissener
# Tunnel laesst nie einen halben Loader zurueck - dieselbe Regel, nach der das
# Programm den Loader selbst erneuert (agent/loader_pflege). Das Programm
# erneuert beide Dateien nur AUFWAERTS (LOADER_STAND): wer hier gezielt einen
# aelteren Stand einspielt, muss den Dienst stoppen oder ein Programm mit
# hoechstens diesem Stand fahren, sonst zieht das laufende Programm nach.
for f in usr/libexec/vp-edge-light/boot.sh etc/init.d/vp-edge-light; do
  # shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
  box_ssh "$TARGET" "mkdir -p /$(dirname "$f") && cat > /$f.neu && chmod 0755 /$f.neu && mv -f /$f.neu /$f && sync" <"$HERE/files/$f"
done
# Die Konfiguration nur anlegen, nie eine bestehende ueberschreiben.
box_ssh "$TARGET" "[ -f /etc/config/vp-edge-light ] || { cat > /etc/config/vp-edge-light.neu && mv -f /etc/config/vp-edge-light.neu /etc/config/vp-edge-light; }" <"$HERE/files/etc/config/vp-edge-light"
# WLAN-Anschluss (Kabel oder WLAN beim Einrichten, edge-light/docs/mango.md
# "Ohne Kabel zum Router"): nur das Skript. Es gehoert zum Betriebssystem und
# aendert erst etwas, wenn jemand es aufruft; das Programm erneuert es nicht.
# shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
box_ssh "$TARGET" "mkdir -p /usr/libexec/vp-edge-light && cat > /usr/libexec/vp-edge-light/wlan-anschluss.sh.neu && chmod 0755 /usr/libexec/vp-edge-light/wlan-anschluss.sh.neu && mv -f /usr/libexec/vp-edge-light/wlan-anschluss.sh.neu /usr/libexec/vp-edge-light/wlan-anschluss.sh && sync" <"$HERE/files/usr/libexec/vp-edge-light/wlan-anschluss.sh"
# Einrichtungs-WLAN (gleiches WLAN ab Werk, nur offen ohne Verbindung;
# edge-light/docs/mango.md "Ohne Kabel zum Router"): der Waechter und sein
# Hotplug-Haken. Aktiv wird er erst ueber den cron-Eintrag unten.
# shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
box_ssh "$TARGET" "cat > /usr/libexec/vp-edge-light/einrichtung-wlan.sh.neu && chmod 0755 /usr/libexec/vp-edge-light/einrichtung-wlan.sh.neu && mv -f /usr/libexec/vp-edge-light/einrichtung-wlan.sh.neu /usr/libexec/vp-edge-light/einrichtung-wlan.sh && sync" <"$HERE/files/usr/libexec/vp-edge-light/einrichtung-wlan.sh"
# shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
box_ssh "$TARGET" "mkdir -p /etc/hotplug.d/iface && cat > /etc/hotplug.d/iface/91-vp-einrichtung.neu && mv -f /etc/hotplug.d/iface/91-vp-einrichtung.neu /etc/hotplug.d/iface/91-vp-einrichtung && sync" <"$HERE/files/etc/hotplug.d/iface/91-vp-einrichtung"

echo "--- Vertrauens-Set in den Flash ($OTA_FEST)"
# Bis Stufe 1 war ota ein Symlink in den RAM - dort ginge das Set beim
# naechsten Stromausfall verloren.
# shellcheck disable=SC2029
box_ssh "$TARGET" "[ -L $OTA_FEST ] && rm -f $OTA_FEST; mkdir -p $OTA_FEST"
for f in trust-set.json trust-set.json.sig; do
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "cat > $OTA_FEST/$f.tmp && mv -f $OTA_FEST/$f.tmp $OTA_FEST/$f" <"$tmp/$f"
done

echo "--- bestaetigte Fassung in den Flash ($LOCAL_DIR/$NAME.gz)"
gzip -9 -n -c "$BIN" >"$tmp/$NAME.gz"
need_kb=$(($(wc -c <"$tmp/$NAME.gz") / 1024 + 512))
# Pruefsummen ZUERST (eine Datei, atomar): bleibt die Kopie unvollstaendig
# (Strom weg), startet nie eine falsche Fassung, und mit Zeile 2 laedt der
# Loader genau diese aus dem Portal nach. Die groesse-Zeile traegt die Groesse
# des entpackten Programms - daraus leitet der Loader seine Speicherschwelle
# ab (boot.sh, bedarf_kb).
GROESSE=$(($(wc -c <"$BIN")))
GZ_GROESSE=$(($(wc -c <"$tmp/$NAME.gz")))
if [ -n "$GZSUM" ]; then
  printf '%s  %s\n%s  %s\ngroesse %s %s\n' "$SUM" "$NAME" "$GZSUM" "$NAME.gz" "$GROESSE" "$GZ_GROESSE" >"$tmp/sum"
else
  printf '%s  %s\ngroesse %s %s\n' "$SUM" "$NAME" "$GROESSE" "$GZ_GROESSE" >"$tmp/sum"
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "mkdir -p $LOCAL_DIR && cat > $LOCAL_DIR/$NAME.sha256.tmp && mv -f $LOCAL_DIR/$NAME.sha256.tmp $LOCAL_DIR/$NAME.sha256 && sync" <"$tmp/sum"
# shellcheck disable=SC2029
avail_kb="$(box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz.part; df -k $LOCAL_DIR | awk 'NR==2 {print \$4}'")"
if [ "$avail_kb" -lt "$need_kb" ]; then
  # Kein Platz fuer alt und neu nebeneinander: die alte Kopie zuerst weg.
  echo "    wenig Flash frei (${avail_kb} kB) - alte Kopie wird vorher entfernt"
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz"
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "cat > $LOCAL_DIR/$NAME.gz.part" <"$tmp/$NAME.gz"
# shellcheck disable=SC2029
remote_sum="$(box_ssh "$TARGET" "gunzip -c $LOCAL_DIR/$NAME.gz.part | sha256sum" | awk '{print $1}')"
if [ "$remote_sum" != "$SUM" ]; then
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz.part"
  echo "FEHLER: Pruefsumme der lokalen Kopie stimmt auf dem Geraet nicht" >&2
  exit 1
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "mv -f $LOCAL_DIR/$NAME.gz.part $LOCAL_DIR/$NAME.gz && sync"
awk -v b="$(wc -c <"$tmp/$NAME.gz")" 'BEGIN {printf "    %.1f MB gepackt, Pruefsumme auf dem Geraet bestaetigt\n", b / 1048576}'

if [ -n "$SEQ" ]; then
  echo "--- Stand vermerkt: $REL ist die bestaetigte Fassung (current.json)"
  printf '{"release":"%s","release_seq":%s,"state_schema":%s}\n' "$REL" "$SEQ" "$SCHEMA" >"$tmp/current.json"
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "cat > $OTA_FEST/current.json.tmp && mv -f $OTA_FEST/current.json.tmp $OTA_FEST/current.json && sync" <"$tmp/current.json"
fi

echo "--- setze Bauart ($ARCH), entferne base_url und aktiviere den Dienst"
# shellcheck disable=SC2029
box_ssh "$TARGET" "uci -q delete vp-edge-light.main.base_url; uci -q delete vp-edge-light.main.channel; uci set vp-edge-light.main.local_dir='$LOCAL_DIR' && uci set vp-edge-light.main.arch='$ARCH' && uci set vp-edge-light.main.enabled='1' && uci commit vp-edge-light && /etc/init.d/vp-edge-light enable"

echo "--- Firewall: OCPP (TCP 8887) aus dem Kundennetz (Zone wan) zulassen"
# Eine BENANNTE Regel (firewall.vp_ocpp), damit ein erneuter Aufruf sie
# aktualisiert statt eine zweite anzulegen. Ohne /etc/config/firewall (kein
# fw4 auf dem Geraet) wird nur gewarnt - dann steht die Box nicht hinter einer
# eigenen Firewall.
# shellcheck disable=SC2029
box_ssh "$TARGET" "if [ -f /etc/config/firewall ]; then
  uci -q get firewall.vp_ocpp >/dev/null || uci set firewall.vp_ocpp=rule
  uci set firewall.vp_ocpp.name='VoltPilot OCPP (Ladesaeule im Kundennetz)'
  uci set firewall.vp_ocpp.src='wan'
  uci set firewall.vp_ocpp.proto='tcp'
  uci set firewall.vp_ocpp.dest_port='8887'
  uci set firewall.vp_ocpp.target='ACCEPT'
  uci set firewall.vp_ocpp.enabled='1'
  uci commit firewall
  if /etc/init.d/firewall reload >/dev/null 2>&1; then echo '    Regel firewall.vp_ocpp gesetzt und Firewall neu geladen'; else echo '    Regel firewall.vp_ocpp gesetzt; Firewall-Neuladen meldete einen Fehler - gilt spaetestens nach dem naechsten Start'; fi
else
  echo '    WARNUNG: /etc/config/firewall fehlt - keine fw4-Firewall auf diesem Geraet, keine Regel gesetzt'
fi"

echo "--- Einrichtungs-WLAN: Waechter jede Minute (cron)"
# Eine MARKIERTE Zeile (# vp-einrichtung-wlan) wie bei service-tunnel.sh: ein
# erneuter Aufruf ersetzt sie statt eine zweite anzulegen. cronloglevel 9 wie
# dort, sonst protokolliert cron jeden Start (60 Zeilen je Stunde); eine schon
# gesetzte Stufe bleibt. Der Waechter selbst meldet nur, was sich aendert.
# shellcheck disable=SC2029
box_ssh "$TARGET" "touch /etc/crontabs/root
grep -v 'vp-einrichtung-wlan\$' /etc/crontabs/root > /tmp/crontab.vp || true
echo '* * * * * /usr/libexec/vp-edge-light/einrichtung-wlan.sh takt # vp-einrichtung-wlan' >> /tmp/crontab.vp
cat /tmp/crontab.vp > /etc/crontabs/root && rm -f /tmp/crontab.vp
[ -n \"\$(uci -q get 'system.@system[0].cronloglevel' || true)\" ] || { uci set 'system.@system[0].cronloglevel=9'; uci commit system; }
/etc/init.d/cron enable
/etc/init.d/cron restart"

echo "--- fertig. Starten:  ssh $TARGET /etc/init.d/vp-edge-light restart"
echo "    Protokoll:         ssh $TARGET logread -f -e vp-edge-light"
echo "    Lokale Web-App:    http://${TARGET#*@}:8484"
echo "    Vor dem Eintragen einer OCPP-Adresse (ws://<box>:8887/ocpp/<kennung>) in der Ladesaeule:"
echo "    im Kundenrouter eine DHCP-RESERVIERUNG fuer die WAN-Adresse der Box anlegen - wechselt"
echo "    die Adresse, laeuft die Ladesaeule ins Leere (edge-light/docs/mango.md)."
