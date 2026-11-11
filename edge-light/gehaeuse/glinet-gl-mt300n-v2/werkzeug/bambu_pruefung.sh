#!/bin/bash
# Kontrolle einer 3MF mit Bambu Studio auf der Kommandozeile: lädt die Datei,
# setzt P1S (0,4 mm), das Profil "0.20mm Standard" und drei Filamente und
# slict. Ergebnis: ob Objekte, Teilnamen und Filamentplätze ankommen, dazu
# Druckzeit, Filamentwechsel, Verbrauch und Abfall (Spülen und Turm).
# Das geslicte 3MF bleibt zur Auswertung liegen; es ist NICHT zum Drucken
# gedacht (die Voreinstellungen sind ein Nachbau, an keinem Drucker geprüft).
# Läuft ohne Bildschirm und ohne Root-Rechte; vorher werkzeug/bambu_einrichten.sh.
#
#   werkzeug/bambu_pruefung.sh <datei.3mf> <zielordner> [filamente] [weitere Optionen]
#
# filamente: drei Namen aus bambu_voreinstellung.py, Vorgabe "asa;asa;abs"
# (weiß, schwarz, hellblau als ABS Azure). Für alles in PETG: "petg-hf;petg-hf;petg-hf".
#
# Die Meldung "glfwInit return error" im Protokoll ist harmlos: Ohne Bildschirm
# entfällt nur das Vorschaubild in der Projektdatei.
set -euo pipefail
HIER=$(dirname "$(readlink -f "$0")")
WURZEL=$(dirname "$HIER")
BAMBU=${BAMBU:-$WURZEL/.werkzeug/bambu/squashfs-root}
LIBS=${LIBS:-$WURZEL/.werkzeug/bambu/sysroot/usr/lib/x86_64-linux-gnu}
EIN=$(readlink -f "$1")
mkdir -p "$2"
ZIEL=$(readlink -f "$2")
FILAMENTE=${3:-"asa;asa;abs"}
shift $(( $# < 3 ? $# : 3 ))
NAME=${NAME:-$(basename "$EIN" .3mf)}   # NAME=... legt einen zweiten Lauf derselben Datei daneben
export LD_LIBRARY_PATH="$BAMBU/bin:$LIBS:$LIBS/libproxy" LC_ALL=C

V="$ZIEL/voreinstellungen"
python3 "$HIER/bambu_voreinstellung.py" "$BAMBU/resources/profiles/BBL" "$V" >/dev/null
LISTE=""
IFS=';' read -ra F <<<"$FILAMENTE"
for f in "${F[@]}"; do LISTE="$LISTE${LISTE:+;}$V/$f.json"; done

A=$(mktemp -d)
(cd "$A" && nice -n 15 "$BAMBU/bin/bambu-studio" --debug 1 \
    --load-settings "$V/maschine.json;$V/prozess.json" \
    --load-filaments "$LISTE" \
    --filament-colour "#FFFFFF;#101010;#489FDF" \
    --curr-bed-type "Textured PEI Plate" "$@" --slice 0 \
    --export-3mf "$ZIEL/$NAME-geslict.3mf" "$EIN" >"$ZIEL/$NAME-bambu.log" 2>&1 || true
 [ -f result.json ] && cp result.json "$ZIEL/$NAME-bambu-ergebnis.json")
rm -rf "$A"
python3 "$HIER/bambu_auswertung.py" "$ZIEL/$NAME" "$FILAMENTE"
