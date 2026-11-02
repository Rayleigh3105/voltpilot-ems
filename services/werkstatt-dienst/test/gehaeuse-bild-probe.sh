#!/bin/sh
# Probe des Bau-Images der Gehäuse-Druckdatei (services/werkstatt-dienst/gehaeuse,
# P10, Prüfstein PS-8): baut das Bild für linux/amd64 und fährt einen Auftrag so,
# wie der Werkstatt-Dienst ihn als Kubernetes-Job startet: Benutzer 10001,
# Dateisystem nur lesbar, keine Capabilities, no-new-privileges, ohne Netz;
# schreibbar nur /tmp und aus/ (dort hängt der Job die Ablage ein).
#
# Geprüft: Rückgabewert 0, beide Druckdateien und ein Prüfbericht ohne Fehler
# (der QR-Code ist aus dem G-Code lesbar), die Ausgabe in aus/ausgabe.log; dazu
# lehnt das Bild eine Referenz mit falschem Prüfzeichen ab. Gemessen: Dauer und
# höchster Speicher (für VP_GEHAEUSE_FRIST und VP_GEHAEUSE_SPEICHER).
#
# Aufruf: services/werkstatt-dienst/test/gehaeuse-bild-probe.sh
#   VP_PROBE_BILD=<bild>  ein fertiges Bild prüfen statt zu bauen
#   VP_PROBE_BEHALTEN=1   Bild und Ausgabe nicht wegräumen
#   VP_PROBE_AUSGABE=<dir> die Ausgabe des Auftrags dorthin kopieren
# Auf einem arm64-Rechner läuft das Bild emuliert: Es geht, dauert aber länger.
set -eu

HIER=$(cd "$(dirname "$0")" && pwd)
WURZEL=$(cd "$HIER/../../.." && pwd)
REF=edge-wrk7abg   # die erfundene Probe-Referenz des Gehäuse-Programms
BILD=${VP_PROBE_BILD:-vp-werkstatt-gehaeuse-probe:lokal}
NAME=vp-werkstatt-gehaeuse-probe-$$

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "FEHLER: Docker antwortet nicht" >&2; exit 2; }
TMP=$(mktemp -d)
aufraeumen() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "${VP_PROBE_BEHALTEN:-}" = 1 ]; then echo "behalten: $BILD, $TMP"; return; fi
  [ -n "${VP_PROBE_BILD:-}" ] || docker image rm "$BILD" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap aufraeumen EXIT
fehler=0
ok() { echo "ok: $*"; }
nein() { echo "FEHLER: $*"; fehler=1; }

if [ -z "${VP_PROBE_BILD:-}" ]; then
  echo "== Bild bauen (linux/amd64)"
  docker buildx build --platform linux/amd64 --load -q -t "$BILD" \
    -f "$WURZEL/services/werkstatt-dienst/gehaeuse/Dockerfile" "$WURZEL" >/dev/null
fi
docker image inspect "$BILD" --format '{{.Architecture}} {{.Size}}' | {
  read -r arch groesse
  [ "$arch" = amd64 ] && ok "Bild für amd64, $((groesse / 1000000)) MB" || nein "Architektur $arch"
}
[ "$(docker run --rm --platform linux/amd64 --entrypoint id "$BILD" -u)" = 10001 ] && ok "läuft als 10001" || nein "Benutzer"

lauf() { # lauf <ziel> <referenz>
  mkdir -p "$1"
  chmod 0777 "$1"
  docker run --name "$NAME" --platform linux/amd64 --network none \
    --read-only --tmpfs /tmp:rw,size=4g --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
    -e HOME=/tmp -v "$1:/opt/vp/edge-light/gehaeuse/glinet-gl-mt300n-v2/aus" "$BILD" "$2" >/dev/null 2>&1
  rc=$?
  docker rm "$NAME" >/dev/null 2>&1 || true
  return $rc
}

echo "== Falsches Prüfzeichen"
if lauf "$TMP/falsch" edge-k7m2xqz; then nein "edge-k7m2xqz angenommen"; else ok "edge-k7m2xqz abgelehnt"; fi

echo "== Auftrag $REF (wie der Job)"
beginn=$(date +%s)
docker stats --no-stream >/dev/null 2>&1 || true
( while sleep 2; do docker stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null; done ) > "$TMP/speicher" &
mess=$!
if lauf "$TMP/aus" "$REF"; then ok "Rückgabewert 0"; else nein "Rückgabewert nicht 0 (Ausgabe: $TMP/aus/ausgabe.log)"; fi
kill "$mess" 2>/dev/null || true
wait "$mess" 2>/dev/null || true
dauer=$(( $(date +%s) - beginn ))
spitze=$(sed -n 's/^\([0-9.]*\)\([GM]i\)B.*/\1 \2/p' "$TMP/speicher" | awk '{m=($2=="Gi")?$1*1024:$1; if (m>s) s=m} END {printf "%d", s}')
echo "gemessen: $dauer s, höchstens ${spitze:-?} MiB"

D="$TMP/aus/kennung/$REF"
for f in "gehaeuse-$REF.3mf" "unterteil-$REF.3mf" pruefung.md; do
  [ -s "$D/$f" ] && ok "$f" || nein "$f fehlt"
done
grep -q "Keine verletzte Regel; der QR-Code ist aus dem G-Code lesbar" "$D/pruefung.md" 2>/dev/null \
  && ok "Prüfbericht ohne Fehler, QR-Code aus dem G-Code lesbar" || nein "Prüfbericht: $(grep -m3 'Fehler' "$D/pruefung.md" 2>/dev/null)"
grep -q "== Gehäuse für $REF" "$TMP/aus/ausgabe.log" 2>/dev/null && ok "aus/ausgabe.log" || nein "aus/ausgabe.log fehlt"
if [ -n "${VP_PROBE_AUSGABE:-}" ]; then
  mkdir -p "$VP_PROBE_AUSGABE"
  cp "$TMP/aus/ausgabe.log" "$D/pruefung.md" "$VP_PROBE_AUSGABE/" 2>/dev/null || true
  echo "$dauer s, höchstens ${spitze:-?} MiB" > "$VP_PROBE_AUSGABE/messung.txt"
fi

[ "$fehler" = 0 ] && echo "== Bau-Image: alles ok" || echo "== Bau-Image: FEHLER"
exit "$fehler"
