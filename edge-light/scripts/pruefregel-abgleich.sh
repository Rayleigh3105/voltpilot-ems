#!/usr/bin/env bash
# Abgleich der Pruefregel fuer die Antwort der Schluesselausgabe
# (docs/contracts/fernwartung-schluessel-v1.md), ohne Docker und ohne Geraet.
#
# Die Regel gibt es zweimal: als Funktion pruefe im Abholer der Mango
# (edge-light/openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh) und in
# Go im Tunnel-Programm von Edge Industrie (edge-industrie/wartung/internal/vertrag). Beide
# muessen dieselben Antworten annehmen und verwerfen; die Faelle stehen in
# docs/contracts/fernwartung-schluessel-v1-pruefregel.json. Dieses Skript
# prueft die Shell-Regel: Es nimmt die Funktion pruefe WORTGLEICH aus dem
# Abholer und laesst sie ueber jeden Fall laufen. Die Go-Regel prueft
# TestPruefregelFaelle gegen dieselbe Datei.
#
#   edge-light/scripts/pruefregel-abgleich.sh
#   VP_PRUEF_BILD=openwrt/rootfs:x86-64-25.12.5 edge-light/scripts/pruefregel-abgleich.sh   # mit Shell und awk der Mango
set -euo pipefail

LIGHT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
ABHOLER="$LIGHT_DIR/openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh"
FAELLE="$LIGHT_DIR/../docs/contracts/fernwartung-schluessel-v1-pruefregel.json"
# Laufzeit der Box im Abgleich: die Frist eines Schluessels ist Laufzeit plus
# Restlaufzeit.
JETZT=1000

command -v python3 >/dev/null 2>&1 || { echo "    uebersprungen: python3 fehlt"; exit 0; }

# funktion <datei> <name> - die Funktion von "name() {" bis zur schliessenden
# Klammer in Spalte 1.
funktion() {
  awk -v kopf="$2() {" '
    !drin && index($0, kopf) == 1 { drin = 1; print; next }
    drin { print; if ($0 == "}") exit }
  ' "$1"
}

regel="$(funktion "$ABHOLER" pruefe)"
[ -n "$regel" ] || { echo "FEHLER: die Funktion pruefe fehlt in ${ABHOLER#"$LIGHT_DIR"/}" >&2; exit 1; }
# Die Grenzen stehen im Kopf des Abholers.
grenzen="$(sed -n -E 's/^(MAX_SEK|MAX_ANZAHL)=([0-9]+).*/\1=\2/p' "$ABHOLER")"
case "$grenzen" in
  *MAX_SEK=*MAX_ANZAHL=* | *MAX_ANZAHL=*MAX_SEK=*) ;;
  *) echo "FEHLER: MAX_SEK oder MAX_ANZAHL fehlt im Abholer" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Je Fall: <n>.antwort (die Antwort, Byte fuer Byte), <n>.soll (was pruefe
# ausgeben muss; fehlt bei einem Fall, den die Box verwirft), <n>.name.
python3 - "$FAELLE" "$tmp" "$JETZT" <<'PY'
import json, sys
faelle = json.load(open(sys.argv[1], encoding="utf-8"))["faelle"]
jetzt = int(sys.argv[3])
for n, f in enumerate(faelle):
    open(f"{sys.argv[2]}/{n}.antwort", "wb").write(f["antwort"].encode("utf-8"))
    open(f"{sys.argv[2]}/{n}.name", "w", encoding="utf-8").write(f["name"] + "\n")
    if f["gilt"]:
        with open(f"{sys.argv[2]}/{n}.soll", "w") as s:
            for k in f["schluessel"]:
                s.write(f"{jetzt + k['rest']} {k['zugang']} {k['base64']}\n")
PY

# Der Durchgang selbst, als eigenes Skript: so laeuft er wahlweise mit der
# Shell und dem awk dieses Rechners oder im Container mit denen der Box
# (VP_PRUEF_BILD, etwa openwrt/rootfs:x86-64-25.12.5 fuer das BusyBox-awk der Mango).
{
  echo "$grenzen"
  echo "laufzeit() { echo $JETZT; }"
  echo "$regel"
  cat <<'LAUF'
FEHLER=0
ANZAHL=0
for antwort in "$1"/*.antwort; do
  n="${antwort%.antwort}"
  ANZAHL=$((ANZAHL + 1))
  rc=0
  ist="$(pruefe "$antwort" 2>/dev/null)" || rc=$?
  if [ -f "$n.soll" ]; then
    if [ "$rc" -ne 0 ] || [ "$ist" != "$(cat "$n.soll")" ]; then
      echo "FEHLER: die Shell-Regel verwirft oder liest anders (Ausgang $rc): $(cat "$n.name")" >&2
      FEHLER=1
    fi
  elif [ "$rc" -eq 0 ]; then
    echo "FEHLER: die Shell-Regel nimmt an, was sie verwerfen muss: $(cat "$n.name")" >&2
    FEHLER=1
  fi
done
[ "$FEHLER" = 0 ] || exit 1
echo "    Pruefregel des Abholers (Mango): $ANZAHL Faelle wie im Vertrag ($(awk --version 2>/dev/null | head -n 1 || true)$(if command -v busybox >/dev/null 2>&1; then busybox 2>&1 | head -n 1; fi))"
LAUF
} >"$tmp/lauf.sh"

if [ -n "${VP_PRUEF_BILD:-}" ]; then
  docker run --rm --network none -v "$tmp:/faelle:ro" "$VP_PRUEF_BILD" sh /faelle/lauf.sh /faelle
else
  sh "$tmp/lauf.sh" "$tmp"
fi
