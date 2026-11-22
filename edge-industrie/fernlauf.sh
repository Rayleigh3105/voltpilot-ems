#!/bin/sh
# Was ein Fernlauf durch den Wartungstunnel auf einem WAGO PFC200 (Edge
# Industrie) neben install.sh braucht: sichern, was install.sh aendert, den
# Dienst neu starten und die Sicherung zurueckspielen.
# Der Werkstatt-Dienst ruft es fuer eine Box ohne Kundenkonto auf
# (docs/contracts/werkstatt-fernlauf-v1.md); das Gegenstueck auf der Mango sind
# die Befehle in services/werkstatt-dienst/internal/fernlauf.
#
#   edge-industrie/fernlauf.sh root@<adresse> sichern <sicherung.tar.gz>
#   edge-industrie/fernlauf.sh root@<adresse> neustart
#   edge-industrie/fernlauf.sh root@<adresse> zurueck <sicherung.tar.gz>
#
# Umgebung: VP_SSH_KEY=<datei> wie install.sh.
#
# Was dieses Skript NIE tut:
#   - das Geraet neu starten (kein reboot), die SPS-Laufzeit, ihre Dienste
#     oder ihre Einstellungen anfassen: neu startet NUR der Dienst
#     /etc/init.d/vp-edge-industrie,
#   - den Wartungstunnel anfassen (/home/voltpilot/wartung,
#     /etc/init.d/vp-wartung): durch ihn laeuft der Fernlauf,
#   - Identitaet oder Referenz der Box lesen oder sichern
#     (/home/voltpilot/daten/identity und /home/voltpilot/daten/ref bleiben,
#     wie sie sind, und stehen in keiner Sicherung),
#   - Passwoerter, Netze, Firewall oder Schluessel aendern.
#
# Gesichert und zurueckgespielt wird genau, was install.sh schreibt:
#   /home/voltpilot/libexec/boot.sh    Loader
#   /etc/init.d/vp-edge-industrie      Dienst-Skript
#   /etc/rc.d/*vp-edge-industrie       Link: Start beim Hochfahren
#   /home/voltpilot/konfig             Einstellungen
#   /home/voltpilot/daten/ota/         Vertrauens-Set, Stand (current.json)
#   /home/voltpilot/fassung/           bestaetigte Fassung
set -eu

TARGET="${1:?Ziel fehlt, z. B. root@10.10.16.7}"
WAS="${2:?sichern <datei>, neustart oder zurueck <datei>}"
DATEI="${3:-}"
case "$WAS" in
  sichern | zurueck)
    if [ "$#" -ne 3 ] || [ -z "$DATEI" ]; then
      echo "FEHLER: $WAS braucht die Datei der Sicherung: fernlauf.sh <ziel> $WAS <sicherung.tar.gz>" >&2
      exit 1
    fi
    ;;
  neustart)
    if [ "$#" -ne 2 ]; then
      echo "FEHLER: neustart nimmt nur das Ziel" >&2
      exit 1
    fi
    ;;
  *)
    echo "FEHLER: unbekannter Befehl '$WAS' (sichern <datei>, neustart, zurueck <datei>)" >&2
    exit 1
    ;;
esac
if [ "$WAS" = zurueck ] && [ ! -r "$DATEI" ]; then
  echo "FEHLER: die Sicherung $DATEI ist nicht lesbar" >&2
  exit 1
fi
if [ -n "${VP_SSH_KEY:-}" ] && [ ! -r "$VP_SSH_KEY" ]; then
  echo "FEHLER: VP_SSH_KEY=$VP_SSH_KEY ist keine lesbare Schluesseldatei" >&2
  exit 1
fi
HEIM=/home/voltpilot
DIENST=/etc/init.d/vp-edge-industrie
# Ohne fuehrenden Schraegstrich: so heissen die Eintraege der Sicherung.
DATEIEN="home/voltpilot/libexec/boot.sh etc/init.d/vp-edge-industrie home/voltpilot/konfig"
VERZEICHNISSE="home/voltpilot/daten/ota home/voltpilot/fassung"
ARBEIT="$HEIM/.fernlauf-zurueck"

# box_ssh <ziel> <befehl> - ssh zur Box, mit VP_SSH_KEY als Schluesseldatei
box_ssh() {
  if [ -n "${VP_SSH_KEY:-}" ]; then
    ssh -i "$VP_SSH_KEY" "$@"
  else
    ssh "$@"
  fi
}

case "$WAS" in
  sichern)
    # Die Sicherung kommt als tar.gz in die genannte Datei auf diesem Rechner.
    # Erst ein Leselauf ohne Ausgabe: Scheitert er, kommt kein halbes Archiv;
    # eine unfertige Datei bleibt nie liegen.
    rm -f "$DATEI"
    # shellcheck disable=SC2029
    if ! box_ssh "$TARGET" "
      cd / || exit 3
      da=''
      for p in $DATEIEN $VERZEICHNISSE; do
        if [ -e \"\$p\" ] || [ -L \"\$p\" ]; then da=\"\$da \$p\"; fi
      done
      for f in etc/rc.d/*vp-edge-industrie; do
        if [ -L \"\$f\" ]; then da=\"\$da \$f\"; fi
      done
      if [ -z \"\$da\" ] || [ ! -f home/voltpilot/libexec/boot.sh ]; then
        echo 'FEHLER: auf dem Geraet liegt kein Edge Industrie' >&2
        exit 3
      fi
      # shellcheck disable=SC2086
      tar -cf - \$da >/dev/null || { echo 'FEHLER: die Sicherung ist nicht lesbar' >&2; exit 4; }
      # shellcheck disable=SC2086
      tar -cf - \$da | gzip -c" >"$DATEI.teil"; then
      rm -f "$DATEI.teil"
      echo "FEHLER: nichts gesichert" >&2
      exit 1
    fi
    if ! gzip -t "$DATEI.teil" 2>/dev/null; then
      rm -f "$DATEI.teil"
      echo "FEHLER: die Sicherung kam nicht vollstaendig an" >&2
      exit 1
    fi
    mv -f "$DATEI.teil" "$DATEI"
    echo "gesichert: $(wc -c <"$DATEI" | tr -d ' ') Bytes, ohne Identitaet, Referenz und Tunnel"
    ;;

  neustart)
    # Nur der Dienst: Der Loader startet die bestaetigte Fassung aus dem
    # Flash. Geraet, SPS-Laufzeit und Wartungstunnel laufen weiter.
    # shellcheck disable=SC2029
    box_ssh "$TARGET" "$DIENST restart >/dev/null 2>&1 </dev/null" || {
      echo "FEHLER: $DIENST restart ist gescheitert" >&2
      exit 1
    }
    echo "neu gestartet: nur der Dienst vp-edge-industrie"
    ;;

  zurueck)
    # Die Sicherung kommt aus der genannten Datei. Erst ablegen und pruefen,
    # dann den Dienst anhalten; ein unlesbares Archiv aendert nichts.
    # Verzeichnisse werden als Ganzes getauscht (was das Aufspielen dazulegte,
    # ist danach weg), Dateien einzeln und atomar ersetzt. Was install.sh neu
    # angelegt hat und nicht in der Sicherung steht, wird entfernt.
    # shellcheck disable=SC2029
    box_ssh "$TARGET" "
      T=$ARBEIT
      rm -rf \"\$T\" && mkdir -p \"\$T/neu\" && chmod 0700 \"\$T\" || exit 3
      cat > \"\$T/sicherung.tar.gz\" || exit 3
      gzip -dc \"\$T/sicherung.tar.gz\" 2>/dev/null | tar -tf - > \"\$T/liste\" 2>/dev/null
      # Loader, Dienst-Skript und Einstellungen muessen alle darin stehen: Was
      # fehlt, wuerde unten entfernt, und ohne sie startet der Dienst nicht.
      for f in $DATEIEN; do
        if ! grep -q -x -F \"\$f\" \"\$T/liste\"; then
          rm -rf \"\$T\"
          echo 'FEHLER: das ist keine vollstaendige Sicherung von Edge Industrie - nichts geaendert' >&2
          exit 4
        fi
      done
      # Nur was dieses Skript sichert, darf darin stehen.
      # (Verzeichnisse stehen in der Liste mit Schraegstrich am Ende.)
      if grep -v -e '^home/voltpilot/libexec/boot.sh\$' -e '^etc/init.d/vp-edge-industrie\$' -e '^home/voltpilot/konfig\$' \
          -e '^home/voltpilot/daten/ota/' -e '^home/voltpilot/fassung/' \
          -e '^etc/rc.d/[A-Za-z0-9_.-]*vp-edge-industrie\$' \"\$T/liste\" | grep -q .; then
        rm -rf \"\$T\"
        echo 'FEHLER: die Sicherung enthaelt Fremdes - nichts geaendert' >&2
        exit 4
      fi
      gzip -dc \"\$T/sicherung.tar.gz\" | tar -xf - -C \"\$T/neu\" || { rm -rf \"\$T\"; echo 'FEHLER: die Sicherung laesst sich nicht auspacken - nichts geaendert' >&2; exit 4; }
      set -e
      $DIENST stop >/dev/null 2>&1 </dev/null || true
      for d in $VERZEICHNISSE; do
        rm -rf \"/\$d.fernlauf-weg\"
        if [ -e \"/\$d\" ]; then mv \"/\$d\" \"/\$d.fernlauf-weg\"; fi
        if [ -d \"\$T/neu/\$d\" ]; then mv \"\$T/neu/\$d\" \"/\$d\"; fi
        rm -rf \"/\$d.fernlauf-weg\"
      done
      for f in $DATEIEN; do
        if [ -f \"\$T/neu/\$f\" ]; then
          cp -p \"\$T/neu/\$f\" \"/\$f.neu\" && mv -f \"/\$f.neu\" \"/\$f\"
        else
          rm -f \"/\$f\"
        fi
      done
      for l in /etc/rc.d/*vp-edge-industrie; do
        if [ -L \"\$l\" ]; then rm -f \"\$l\"; fi
      done
      for l in \"\$T\"/neu/etc/rc.d/*vp-edge-industrie; do
        if [ -L \"\$l\" ]; then ln -sf \"\$(readlink \"\$l\")\" \"/etc/rc.d/\$(basename \"\$l\")\"; fi
      done
      n=\$(wc -l < \"\$T/liste\")
      rm -rf \"\$T\"
      sync
      $DIENST start >/dev/null 2>&1 </dev/null
      echo \"zurueck: \$n Eintraege der Sicherung eingespielt, nur der Dienst vp-edge-industrie neu gestartet\"" <"$DATEI"
    ;;
esac
