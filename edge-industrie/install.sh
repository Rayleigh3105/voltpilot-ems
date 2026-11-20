#!/bin/sh
# Edge Industrie auf einem WAGO PFC200 (750-8212, WAGO-Firmware) einrichten -
# update-bereit. Das Gegenstueck zu edge-light/openwrt/install.sh (Edge Light
# auf der Mango) fuer ein Linux mit BusyBox-Init statt OpenWrt.
#
# Legt den Benutzer voltpilot an, kopiert Loader, Dienst-Skript und
# Standard-Einstellungen auf das Geraet, legt das Vertrauens-Set in den Flash
# und spielt das Programm als BESTAETIGTE Fassung ein (gzip im Flash, mit
# Pruefsumme). Danach kommen neue Fassungen signiert ueber das Portal
# (Edge-Updates); der Loader tauscht und nimmt zurueck. Loader und
# Dienst-Skript aendern sich NUR durch dieses Skript (kein
# Loader-Selbstupdate auf dem PFC200).
#
#   edge-industrie/scripts/build.sh           (oder die Fassung aus einem Release)
#   edge-industrie/install.sh root@192.168.1.17
#
# Umgebung (wie edge-light/openwrt/install.sh):
#   VP_SSH_KEY=<datei>             Schluesseldatei fuer ssh (ssh -i); ohne die
#                                  Variable entscheidet ~/.ssh/config.
#   VP_INDUSTRIE_ARCH              Bauart (arm; arm64/amd64 nur fuer Proben).
#   VP_INDUSTRIE_MANIFEST=<datei>  das signierte Manifest (release.json) GENAU dieser Fassung.
#                                  Damit vermerkt die Box den Stand (current.json: release_seq,
#                                  state_schema = Anti-Rollback-Boden) und kann die bestaetigte
#                                  Fassung nach einem Stromausfall beim Update aus dem Portal
#                                  nachladen. Ohne Manifest: Programm laeuft, die Box ist aber
#                                  erst nach dem ersten Update ueber das Portal voll update-bereit.
#   VP_TRUST_SET_DIR=<dir>         trust-set.json + trust-set.json.sig von dort. Sonst offen
#                                  vom Portal geladen:
#   VP_PORTAL_URL                  Vorgabe https://portal.voltpilot.de
#   VP_PFC_RC_LINK                 Name des Start-Links in /etc/rc.d
#                                  (Vorgabe S99_vp-edge-industrie).
#
# Was auf dem Geraet entsteht (alles unter /home/voltpilot, dazu das
# Dienst-Skript):
#   /etc/init.d/vp-edge-industrie      Dienst-Skript            root
#   /etc/rc.d/S99_vp-edge-industrie    Link: Start beim Hochfahren
#   /home/voltpilot/libexec/boot.sh    Loader                   root
#   /home/voltpilot/konfig             Einstellungen            root
#   /home/voltpilot/fassung/           bestaetigte Fassung      voltpilot
#   /home/voltpilot/daten/             Identitaet, Vertrauen    voltpilot
# Was root gehoert, kann das Programm nicht aendern. Was voltpilot gehoert,
# schreibt dieses Skript auch ALS voltpilot (su), nie als root.
#
# Ein erneuter Aufruf aktualisiert Loader, Dienst-Skript, Vertrauens-Set und
# Fassung; die Box-Daten bleiben (Identitaet, Zertifikat, Auswahl,
# Einstellungen). In den Einstellungen werden nur local_dir, arch und enabled
# gesetzt (und programm_dir, wenn /tmp keine Programme startet). Die SPS, ihre
# Dienste und die Firewall des Geraets fasst das Skript nicht an.
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@192.168.1.17}"
if [ "$#" -gt 1 ]; then
  echo "FEHLER: nur das Ziel angeben - neue Fassungen kommen signiert ueber das Portal" >&2
  exit 1
fi
ARCH="${VP_INDUSTRIE_ARCH:-arm}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/dist/vp-edge-industrie-linux-$ARCH"
NAME="vp-edge-industrie-linux-$ARCH"
BENUTZER=voltpilot
HEIM=/home/voltpilot
KONFIG="$HEIM/konfig"
LOCAL_DIR="$HEIM/fassung"
DATA_DIR="$HEIM/daten"
OTA_FEST="$DATA_DIR/ota"
PROG_FLASH="$HEIM/programm"
PORTAL="${VP_PORTAL_URL:-https://portal.voltpilot.de}"
MANIFEST="${VP_INDUSTRIE_MANIFEST:-}"
RC_LINK="${VP_PFC_RC_LINK:-S99_vp-edge-industrie}"

case "$ARCH" in
  arm | arm64 | amd64) ;;
  *) echo "FEHLER: unbekannte Bauart VP_INDUSTRIE_ARCH=$ARCH (arm; arm64|amd64 nur fuer Proben)" >&2; exit 1 ;;
esac
case "$RC_LINK" in
  '' | */* | *[!A-Za-z0-9_.-]*) echo "FEHLER: VP_PFC_RC_LINK=$RC_LINK ist kein Dateiname" >&2; exit 1 ;;
esac
if [ ! -f "$BIN" ]; then
  echo "FEHLER: das Programm fehlt ($BIN) - erst edge-industrie/scripts/build.sh" >&2
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
  [ -r "$MANIFEST" ] || { echo "FEHLER: VP_INDUSTRIE_MANIFEST=$MANIFEST ist nicht lesbar" >&2; exit 1; }
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
  case "$REL" in edge-industrie-*) ;; *) echo "FEHLER: $MANIFEST ist kein Edge-Industrie-Manifest (release '$REL')" >&2; exit 1 ;; esac
  case "$SEQ" in '' | *[!0-9]*) echo "FEHLER: $MANIFEST traegt keine release_seq" >&2; exit 1 ;; esac
  case "$SCHEMA" in '' | *[!0-9]*) SCHEMA=0 ;; esac
  if [ "$MSUM" != "$SUM" ] || [ -z "$GZSUM" ]; then
    echo "FEHLER: das Manifest $REL beschreibt fuer linux/$ARCH ein anderes Programm (Manifest ${MSUM:-keins}, Programm $SUM)" >&2
    exit 1
  fi
  echo "--- Fassung $REL (Stand $SEQ, Datenformat $SCHEMA) laut signiertem Manifest"
else
  echo "--- ohne Manifest (VP_INDUSTRIE_MANIFEST): kein Anti-Rollback-Boden, kein Nachladen der bestaetigten Fassung bis zum ersten Update"
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

# --- Das Geraet: erst pruefen, dann aendern ---------------------------------------
# Bis hierher ist das Geraet unberuehrt. Die Pruefung aendert nichts; fehlt
# etwas, endet das Skript, bevor irgendeine Datei geschrieben ist.
echo "--- pruefe $TARGET"
# shellcheck disable=SC2029 # bewusst lokal expandiert: die Pfade kommen von hier
pruefung="$(box_ssh "$TARGET" "
  [ \"\$(id -u)\" = 0 ] || echo 'FEHLT: Anmeldung als root'
  for w in su sha256sum gunzip awk sed grep cut tr head tail logger nice id chown df; do
    command -v \$w >/dev/null 2>&1 || echo \"FEHLT: \$w\"
  done
  if ! id -u $BENUTZER >/dev/null 2>&1; then
    command -v adduser >/dev/null 2>&1 || command -v useradd >/dev/null 2>&1 || echo 'FEHLT: adduser oder useradd'
  fi
  [ -d /etc/init.d ] || echo 'FEHLT: /etc/init.d'
  for d in $DATA_DIR $LOCAL_DIR $HEIM/libexec; do
    [ ! -L \$d ] || echo \"FEHLT: \$d ist ein Link, kein Verzeichnis\"
  done
  [ ! -L $HEIM ] || echo 'FEHLT: $HEIM ist ein Link, kein Verzeichnis'
  command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1 || echo 'HINWEIS: weder wget noch curl - der Loader kann die bestaetigte Fassung nach einem Stromausfall beim Update nicht nachladen'
  [ -d /etc/rc.d ] || echo 'HINWEIS: /etc/rc.d fehlt - der Start beim Hochfahren wird nicht eingerichtet'
  echo PRUEFUNG-ENDE
")"
case "$pruefung" in
  *PRUEFUNG-ENDE*) ;;
  *) echo "FEHLER: $TARGET antwortet nicht wie erwartet (ssh als root?)" >&2; exit 1 ;;
esac
echo "$pruefung" | sed -n 's/^HINWEIS: /    HINWEIS: /p'
if echo "$pruefung" | grep -q '^FEHLT: '; then
  echo "$pruefung" | sed -n 's/^FEHLT: /    fehlt: /p' >&2
  echo "FEHLER: $TARGET erfuellt die Voraussetzungen nicht - nichts geaendert" >&2
  exit 1
fi

echo "--- Benutzer $BENUTZER (ohne Passwort, ohne Anmeldung) und Verzeichnisse"
# $HEIM selbst gehoert root: so kann das Programm weder Loader noch
# Einstellungen noch die Verzeichnisnamen darunter ersetzen.
# shellcheck disable=SC2029
box_ssh "$TARGET" "set -e
  if ! id -u $BENUTZER >/dev/null 2>&1; then
    adduser -D -H -h $HEIM -s /bin/false $BENUTZER 2>/dev/null ||
      useradd -r -M -d $HEIM -s /bin/false $BENUTZER
  fi
  mkdir -p $HEIM/libexec $DATA_DIR $LOCAL_DIR
  chown root:root $HEIM $HEIM/libexec
  chmod 0755 $HEIM $HEIM/libexec $LOCAL_DIR
  chown $BENUTZER $DATA_DIR $LOCAL_DIR
  chmod 0700 $DATA_DIR"
# Der Benutzerwechsel muss wirklich bei voltpilot landen - sonst liefe das
# Programm als root oder gar nicht.
# shellcheck disable=SC2029
wechsel="$(box_ssh "$TARGET" "echo \"\$(id -u $BENUTZER) \$(su -s /bin/sh $BENUTZER -c 'id -u' 2>/dev/null)\"")"
# shellcheck disable=SC2086 # bewusst zwei Woerter: Soll und Ist
set -- $wechsel
if [ -z "${1:-}" ] || [ "$1" = 0 ] || [ "$1" != "${2:-}" ]; then
  echo "FEHLER: 'su -s /bin/sh $BENUTZER' wechselt auf $TARGET nicht zum Benutzer $BENUTZER (Soll ${1:-?}, Ist ${2:-nichts})" >&2
  exit 1
fi
# als <befehl> - der Befehl fuer das Geraet, ausgefuehrt als voltpilot.
als() { echo "su -s /bin/sh $BENUTZER -c '$1'"; }

echo "--- kopiere Loader und Dienst-Skript nach $TARGET"
# Einzeldateien per cat|ssh (kein scp/sftp vorausgesetzt). Atomar (temporaere
# Datei, dann mv, dann sync): Strom weg oder eine gerissene Verbindung laesst
# nie einen halben Loader zurueck. Ein laufender Loader liest seine alte Datei
# weiter; der neue Stand wirkt ab dem naechsten Start.
for f in home/voltpilot/libexec/boot.sh etc/init.d/vp-edge-industrie; do
  # shellcheck disable=SC2029 # bewusst lokal expandiert: der Zielpfad kommt von hier
  box_ssh "$TARGET" "cat > /$f.neu && chown root:root /$f.neu && chmod 0755 /$f.neu && mv -f /$f.neu /$f && sync" <"$HERE/files/$f"
done
# Die Einstellungen nur anlegen, nie bestehende ueberschreiben.
# shellcheck disable=SC2029
box_ssh "$TARGET" "[ -f $KONFIG ] || { cat > $KONFIG.neu && chown root:root $KONFIG.neu && chmod 0644 $KONFIG.neu && mv -f $KONFIG.neu $KONFIG; }" <"$HERE/files/home/voltpilot/konfig"

echo "--- Vertrauens-Set in den Flash ($OTA_FEST)"
# shellcheck disable=SC2029
box_ssh "$TARGET" "$(als "mkdir -p $OTA_FEST")"
for f in trust-set.json trust-set.json.sig; do
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "$(als "cat > $OTA_FEST/$f.tmp && mv -f $OTA_FEST/$f.tmp $OTA_FEST/$f")" <"$tmp/$f"
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
box_ssh "$TARGET" "$(als "cat > $LOCAL_DIR/$NAME.sha256.tmp && mv -f $LOCAL_DIR/$NAME.sha256.tmp $LOCAL_DIR/$NAME.sha256 && sync")" <"$tmp/sum"
# shellcheck disable=SC2029
avail_kb="$(box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz.part; df -k $LOCAL_DIR | awk 'NR==2 {print \$4}'")"
case "$avail_kb" in
  '' | *[!0-9]*) echo "FEHLER: freier Platz in $LOCAL_DIR nicht lesbar ('$avail_kb')" >&2; exit 1 ;;
esac
if [ "$avail_kb" -lt "$need_kb" ]; then
  # Kein Platz fuer alt und neu nebeneinander: die alte Kopie zuerst weg.
  echo "    wenig Flash frei (${avail_kb} kB) - alte Kopie wird vorher entfernt"
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz"
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "$(als "cat > $LOCAL_DIR/$NAME.gz.part")" <"$tmp/$NAME.gz"
# shellcheck disable=SC2029
remote_sum="$(box_ssh "$TARGET" "gunzip -c $LOCAL_DIR/$NAME.gz.part | sha256sum" | awk '{print $1}')"
if [ "$remote_sum" != "$SUM" ]; then
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "rm -f $LOCAL_DIR/$NAME.gz.part"
  echo "FEHLER: Pruefsumme der lokalen Kopie stimmt auf dem Geraet nicht" >&2
  exit 1
fi
# shellcheck disable=SC2029
box_ssh "$TARGET" "$(als "mv -f $LOCAL_DIR/$NAME.gz.part $LOCAL_DIR/$NAME.gz && sync")"
awk -v b="$(wc -c <"$tmp/$NAME.gz")" 'BEGIN {printf "    %.1f MB gepackt, Pruefsumme auf dem Geraet bestaetigt\n", b / 1048576}'

if [ -n "$SEQ" ]; then
  echo "--- Stand vermerkt: $REL ist die bestaetigte Fassung (current.json)"
  printf '{"release":"%s","release_seq":%s,"state_schema":%s}\n' "$REL" "$SEQ" "$SCHEMA" >"$tmp/current.json"
  # shellcheck disable=SC2029
  box_ssh "$TARGET" "$(als "cat > $OTA_FEST/current.json.tmp && mv -f $OTA_FEST/current.json.tmp $OTA_FEST/current.json && sync")" <"$tmp/current.json"
fi

echo "--- setze Bauart ($ARCH) und aktiviere den Dienst"
# Startet /tmp keine Programme (noexec), laeuft das Programm aus dem Flash
# statt aus dem RAM: programm_dir. Geprueft wird mit einem echten Start als
# voltpilot, nicht an den Mount-Angaben. Ein schon gesetztes programm_dir
# bleibt.
# shellcheck disable=SC2029
box_ssh "$TARGET" "set -e
  ksetze() {
    if grep -q \"^[[:space:]]*\$1[[:space:]]*=\" $KONFIG; then
      sed \"s|^[[:space:]]*\$1[[:space:]]*=.*|\$1 = \$2|\" $KONFIG > $KONFIG.neu
    else
      { cat $KONFIG; echo \"\$1 = \$2\"; } > $KONFIG.neu
    fi
    chown root:root $KONFIG.neu && chmod 0644 $KONFIG.neu && mv -f $KONFIG.neu $KONFIG
  }
  kwert() { sed -n \"s/^[[:space:]]*\$1[[:space:]]*=[[:space:]]*//p\" $KONFIG | sed 's/[[:space:]]*\$//' | tail -n 1; }
  ksetze local_dir $LOCAL_DIR
  ksetze arch $ARCH
  ram=\"\$(kwert ram_dir)\"
  ram=\"\${ram:-/tmp/vp-edge-industrie}\"
  oben=\"\$(dirname \"\$ram\")\"
  if [ -z \"\$(kwert programm_dir)\" ]; then
    probe=\"\$oben/.vp-startprobe.\$\$\"
    printf '#!/bin/sh\nexit 0\n' > \"\$probe\"
    chmod 0755 \"\$probe\"
    if su -s /bin/sh $BENUTZER -c \"\$probe\" 2>/dev/null; then
      echo \"    das Programm laeuft aus \$ram (dort starten Programme)\"
    else
      mkdir -p $PROG_FLASH
      chown $BENUTZER $PROG_FLASH
      chmod 0755 $PROG_FLASH
      ksetze programm_dir $PROG_FLASH
      echo \"    \$oben startet keine Programme (noexec) - das Programm laeuft aus $PROG_FLASH (Flash)\"
    fi
    rm -f \"\$probe\"
  else
    echo \"    programm_dir bleibt: \$(kwert programm_dir)\"
  fi
  ksetze enabled 1
  sync
  echo \"    \$oben liegt auf: \$(df -k \"\$oben\" 2>/dev/null | awk 'NR==2 {print \$1}')\"
  if [ -d /etc/rc.d ]; then
    ln -sf ../init.d/vp-edge-industrie /etc/rc.d/$RC_LINK
    echo '    Start beim Hochfahren: /etc/rc.d/$RC_LINK'
  else
    echo '    WARNUNG: /etc/rc.d fehlt - Start beim Hochfahren NICHT eingerichtet'
  fi"

echo "--- fertig. Starten:  ssh $TARGET /etc/init.d/vp-edge-industrie restart"
echo "    Zustand:           ssh $TARGET /etc/init.d/vp-edge-industrie status"
echo "    Protokoll:         syslog des Geraets, Marke vp-edge-industrie"
echo "    Lokale Web-App:    http://${TARGET#*@}:8484"
echo "    Modbus-Datenspiegel: ab Werk aus; eingeschaltet lauscht er auf 1502 (502 gehoert der SPS)."
