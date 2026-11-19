#!/usr/bin/env bash
# Abgleich des PFC200-Loaders mit dem Mango-Loader, ohne Docker und ohne Geraet.
#
# Der Loader des WAGO PFC200 (edge-light/pfc/files/home/voltpilot/libexec/boot.sh)
# spricht dasselbe Update-Protokoll wie der Mango-Loader
# (edge-light/openwrt/files/usr/libexec/vp-edge-light/boot.sh): Tausch, Probe,
# Behalten, Zurueck. Die Funktionen, die das Protokoll ausmachen, stehen in
# beiden Dateien WORTGLEICH. Aendert sich eine im Mango-Loader (dort steigt
# dann LOADER_STAND), scheitert diese Pruefung, bis der PFC200-Loader
# nachgezogen ist: Funktion uebernehmen, ABGLEICH_MANGO_STAND auf den neuen
# LOADER_STAND setzen, PFC_LOADER_STAND erhoehen und
# edge-light/test/pfc-update-probe.sh laufen lassen.
#
# Dazu: die Skripte des PFC200 sind syntaktisch gueltiges POSIX-sh (die
# BusyBox-ash des Geraets kennt keine bash-Erweiterungen).
#
#   edge-light/scripts/pfc-abgleich.sh
set -euo pipefail

LIGHT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
MANGO="$LIGHT_DIR/openwrt/files/usr/libexec/vp-edge-light/boot.sh"
PFC="$LIGHT_DIR/pfc/files/home/voltpilot/libexec/boot.sh"
DIENST="$LIGHT_DIR/pfc/files/etc/init.d/vp-edge-light"
INSTALL="$LIGHT_DIR/pfc/install.sh"
# Das Protokoll: Speicherbedarf, Pruefsumme, Uhr, Marken, Ruecknahme, Behalten,
# Probestart, Tausch, Urteil, Wache.
GEMEINSAM="free_kb bedarf_kb summe uptime_s versuch zurueck behalten probestart tauschen probe_pruefen waechter"
FEHLER=0

# funktion <datei> <name> - die Funktion von "name() {" bis zur schliessenden
# Klammer in Spalte 1 (oder die eine Zeile, wenn sie dort schon endet).
funktion() {
  awk -v kopf="$2() {" '
    !drin && index($0, kopf) == 1 { drin = 1; print; if ($0 ~ /}$/) exit; next }
    drin { print; if ($0 == "}") exit }
  ' "$1"
}

for f in "$PFC" "$DIENST" "$INSTALL"; do
  if ! sh -n "$f"; then
    echo "FEHLER: ${f#"$LIGHT_DIR"/} ist kein gueltiges sh" >&2
    FEHLER=1
  fi
done

for name in $GEMEINSAM; do
  m="$(funktion "$MANGO" "$name")"
  p="$(funktion "$PFC" "$name")"
  if [ -z "$m" ] || [ -z "$p" ]; then
    echo "FEHLER: Funktion $name fehlt (Mango-Loader: ${#m} Zeichen, PFC200-Loader: ${#p} Zeichen)" >&2
    FEHLER=1
  elif [ "$m" != "$p" ]; then
    echo "FEHLER: Funktion $name weicht im PFC200-Loader vom Mango-Loader ab:" >&2
    diff <(printf '%s\n' "$m") <(printf '%s\n' "$p") | sed 's/^/    /' >&2 || true
    FEHLER=1
  fi
done

stand_mango="$(sed -n 's/^LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$MANGO")"
stand_abgleich="$(sed -n 's/^ABGLEICH_MANGO_STAND=\([0-9][0-9]*\)$/\1/p' "$PFC")"
stand_pfc="$(sed -n 's/^PFC_LOADER_STAND=\([0-9][0-9]*\)$/\1/p' "$PFC")"
if [ -z "$stand_mango" ] || [ "$stand_mango" != "$stand_abgleich" ]; then
  echo "FEHLER: der PFC200-Loader ist mit Mango-Stand '${stand_abgleich}' abgeglichen, der Mango-Loader traegt LOADER_STAND '${stand_mango}'" >&2
  FEHLER=1
fi
if [ -z "$stand_pfc" ] || [ "$stand_pfc" -lt 1 ]; then
  echo "FEHLER: der PFC200-Loader traegt keine Marke PFC_LOADER_STAND" >&2
  FEHLER=1
fi
# Die Marke der Mango darf im PFC200-Loader nicht stehen: das Programm liest
# sie fuer das Loader-Selbstupdate, das es auf dem PFC200 nicht gibt.
if grep -q '^LOADER_STAND=' "$PFC"; then
  echo "FEHLER: der PFC200-Loader traegt die Marke LOADER_STAND der Mango" >&2
  FEHLER=1
fi

[ "$FEHLER" = 0 ] || exit 1
echo "    PFC200-Loader Stand $stand_pfc: $(echo "$GEMEINSAM" | wc -w | tr -d ' ') Funktionen wortgleich mit dem Mango-Loader Stand $stand_mango"
