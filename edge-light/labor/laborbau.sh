#!/usr/bin/env bash
# Labor-Bau fuer den Laborbeweis P1-P11 (Konzept vp-edge-light-update, K6):
# eine WEGWERF-Signaturkette, ein Labor-Vertrauens-Set und alle Fassungen,
# die der Laborbeweis an der Labor-Mango braucht - signiert mit dem
# Labor-Release-Schluessel, NIE mit dem echten (README.md).
#
#   edge-light/labor/laborbau.sh <ausgabe> <erste-seq> [bauart]
#
#   <erste-seq>  die naechste freie release_seq des LOKALEN Portals
#                (GET /api/v1/admin/edge-releases/next-seq); die Fassungen
#                bekommen fortlaufende Nummern ab hier, in der Reihenfolge, in
#                der hochladen.sh sie eintraegt.
#   [bauart]     mipsle (Mango, Vorgabe) oder amd64 (OpenWrt im Container)
#
# Die Programme tragen die Labor-Wurzel EINGEBACKEN - der Anker ist kein
# Schalter (wie edge-app/test/ota-soak): gebaut wird aus einer Kopie der
# Quellen mit ersetzter otaverify/rootkeys.json. Ein Labor-Programm lehnt
# jedes echte Release ab und umgekehrt. Es gehoert nie auf eine Kundenbox.
#
# Ausgabe:
#   schluessel/              root-labor, rel-labor, rel-fremd (GEHEIM, nach dem Beweis loeschen)
#   trust-set/               trust-set.json(.sig) des Labors (nur rel-labor)
#   fassungen/<name>/        Programm, .gz, release.json(.sig), register.json
#   fassungen.txt            Fall, Fassung, Stand, Wirkung
#   hochladen.sh             traegt alle Fassungen ins LOKALE Portal ein und laedt die Programme hoch
# shellcheck disable=SC2016 # die printf-Vorlagen sind Skript-Text fuer die Box
set -euo pipefail

AUS="${1:?Ausgabeverzeichnis fehlt}"
SEQ0="${2:?erste release_seq (next-seq des lokalen Portals) fehlt}"
BAUART="${3:-mipsle}"
case "$SEQ0" in '' | *[!0-9]*) echo "FEHLER: erste-seq muss eine Zahl sein" >&2; exit 2 ;; esac
case "$BAUART" in mipsle | amd64) ;; *) echo "FEHLER: Bauart mipsle oder amd64" >&2; exit 2 ;; esac
HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
CORE="$REPO/edge-app/core"
command -v go >/dev/null || { echo "FEHLER: go fehlt" >&2; exit 2; }
mkdir -p "$AUS"
AUS="$(cd "$AUS" && pwd -P)"
[ -z "$(ls -A "$AUS" 2>/dev/null)" ] || { echo "FEHLER: $AUS ist nicht leer" >&2; exit 2; }
mkdir -p "$AUS/bin" "$AUS/schluessel" "$AUS/trust-set" "$AUS/fassungen" "$AUS/.src"
chmod 700 "$AUS/schluessel"

echo "--- vp-ota bauen"
(cd "$CORE" && go build -o "$AUS/bin/vp-ota" ./cmd/vp-ota)
OTA="$AUS/bin/vp-ota"

echo "--- Wegwerf-Kette: root-labor, rel-labor, rel-fremd"
"$OTA" keygen --role root --id root-labor --out "$AUS/schluessel" >/dev/null
"$OTA" keygen --role release --id rel-labor --out "$AUS/schluessel" >/dev/null
"$OTA" keygen --role release --id rel-fremd --out "$AUS/schluessel" >/dev/null
"$OTA" trust-set --key "$AUS/schluessel/rel-labor.pub" --out "$AUS/trust-set/trust-set.json" >/dev/null
"$OTA" sign --domain trust-set --in "$AUS/trust-set/trust-set.json" --key "$AUS/schluessel/root-labor.key" \
  --out "$AUS/trust-set/trust-set.json.sig" >/dev/null

echo "--- Quellen mit eingebackener Labor-Wurzel"
SRC="$AUS/.src/core"
mkdir -p "$SRC"
cp -R "$CORE/go.mod" "$CORE/go.sum" "$CORE/cmd" "$CORE/internal" "$SRC/"
PUB="$(sed -n 's/.*"public_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AUS/schluessel/root-labor.pub")"
[ -n "$PUB" ] || { echo "FEHLER: Labor-Wurzel nicht lesbar" >&2; exit 1; }
cat >"$SRC/internal/otaverify/rootkeys.json" <<WURZEL
{
  "schema_version": "1.0",
  "keys": [
    { "key_id": "root-labor", "alg": "ed25519", "public_key": "$PUB" }
  ]
}
WURZEL

# echt <ziel> <fassung> [goarch] - das echte Programm mit Labor-Wurzel
echt() {
  local arch="${3:-$BAUART}"
  (cd "$SRC" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOMIPS=softfloat go build -trimpath \
    -ldflags "-s -w -X git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent.Version=$2" \
    -o "$1" ./cmd/vp-edge-light)
}

# skript <ziel> <fassung> <rumpf> - eine Fehler-Fassung als Shell-Skript: sie
# beantwortet `version` wie das echte Programm und tut dann <rumpf>.
skript() {
  {
    printf '#!/bin/sh\n# Labor-Fassung %s (edge-light/labor/laborbau.sh) - nie auf eine Kundenbox\n' "$2"
    printf '[ "$1" = version ] && { echo %s; exit 0; }\n' "$2"
    printf '%s\n' "$3"
  } >"$1"
  chmod 0755 "$1"
}

# huelle <ziel> <fassung> - P4: das echte Programm (diese Fassung) in einer
# Huelle, die es mit LEEREM Datenverzeichnis im RAM und ohne Dev-Identitaet
# startet. Es laeuft, besteht Trockenlauf und Web-App, erreicht aber nie die
# Cloud - genau der Fall "keine Cloud in der Probezeit". Die echten Box-Daten
# bleiben unberuehrt.
huelle() {
  local innen="$AUS/.src/huelle-innen" groesse
  echt "$innen" "$2"
  gzip -9 -n -c "$innen" >"$innen.gz"
  groesse="$(wc -c <"$innen.gz" | tr -d ' ')"
  {
    printf '#!/bin/sh\n# Labor-Fassung %s (P4, edge-light/labor/laborbau.sh) - nie auf eine Kundenbox\n' "$2"
    printf '[ "$1" = version ] && { echo %s; exit 0; }\n' "$2"
    printf 'd=/tmp/vp-labor-p4; rm -rf "$d"; mkdir -p "$d/daten"\n'
    printf 'tail -c %s "$0" | gunzip >"$d/programm" && chmod 0755 "$d/programm" || exit 4\n' "$groesse"
    printf 'unset VP_DEV_TENANT_ID VP_DEV_SITE_ID VP_DEV_DEVICE_ID VP_DEV_CLOUD_URL VP_DEV_INSECURE\n'
    printf 'VP_DATA_DIR="$d/daten" VP_PORTAL_BASE_URL=http://127.0.0.1:9 exec "$d/programm"\n'
  } >"$1"
  cat "$innen.gz" >>"$1"
  chmod 0755 "$1"
  rm -f "$innen" "$innen.gz"
}

N=0
: >"$AUS/fassungen.txt"
REIHE=""
# fassung <name> <fall> <art> <signierer> <wirkung> [rumpf] - baut, packt, signiert.
#   art: echt | andere (echtes Programm der anderen Architektur) | skript | huelle
fassung() {
  local name="$1" fall="$2" art="$3" signierer="$4" wirkung="$5" rumpf="${6:-}"
  local seq=$((SEQ0 + N))
  local rel="edge-light-2099.01.$N"
  local dir="$AUS/fassungen/$name"
  local prog="$dir/vp-edge-light-linux-$BAUART"
  mkdir -p "$dir"
  case "$art" in
    echt) echt "$prog" "$rel" ;;
    andere) echt "$prog" "$rel" "$ANDERE" ;;
    skript) skript "$prog" "$rel" "$rumpf" ;;
    huelle) huelle "$prog" "$rel" ;;
  esac
  gzip -9 -n -c "$prog" >"$prog.gz"
  "$OTA" manifest --release "$rel" --seq "$seq" --commit "$(git -C "$REPO" rev-parse --short=12 HEAD)" \
    --binary "vp-edge-light:linux/$BAUART=$prog" --state-schema 1 \
    --key-id "$signierer" --notes "Labor $fall: $wirkung" --out "$dir/release.json" >/dev/null
  "$OTA" sign --key "$AUS/schluessel/$signierer.key" --domain release --in "$dir/release.json" >/dev/null
  [ -f "$dir/register.json" ] || { echo "FEHLER: kein Register-Rumpf fuer $name" >&2; exit 1; }
  printf '%-11s %-12s %-22s Stand %-6s %s\n' "$name" "$fall" "$rel" "$seq" "$wirkung" >>"$AUS/fassungen.txt"
  REIHE="$REIHE $name"
  N=$((N + 1))
  echo "    $name: $rel (Stand $seq) - $wirkung"
}

ANDERE=arm64
echo "--- Fassungen ($BAUART)"
fassung ausgang    "Ausgang/P11" echt   rel-labor "die bestaetigte Fassung zu Beginn; spaeter als Rueckschritt zugewiesen"
fassung gut        "P1/P7/P9"    echt   rel-labor "neuere gute Fassung"
fassung arch       "P2"          andere rel-labor "Programm fuer $ANDERE, als linux/$BAUART signiert"
fassung absturz    "P3"          skript rel-labor "endet sofort mit Fehler" 'exit 3'
fassung keincloud  "P4"          huelle rel-labor "echtes Programm mit leerem Datenverzeichnis: keine Cloud"
# shellcheck disable=SC2016 # der Rumpf laeuft auf der Box
fassung speicher   "P5"          skript rel-labor "belegt Speicher bis zum OOM-Killer" 'a=x; while :; do a="$a$a"; done'
fassung haenger    "P6/P8"       skript rel-labor "laeuft, Selbsttest wird nie gruen" 'while :; do sleep 60; done'
fassung faelschung "P10a"        echt   rel-labor "echt; die Bytes werden NACH dem Hochladen im Labor-Portal veraendert"
fassung fremd      "P10b"        echt   rel-fremd "mit rel-fremd signiert (nicht im Labor-Vertrauens-Set)"
rm -rf "$AUS/.src"

echo "--- hochladen.sh"
{
  cat <<'KOPF'
#!/usr/bin/env bash
# Traegt die Labor-Fassungen ins LOKALE Portal ein (in dieser Reihenfolge,
# release_seq ist monoton) und laedt ihre Programme hoch. Nie gegen das
# Produktiv-Portal.
#
#   VP_LABOR_PORTAL=http://<entwicklungs-stapel>:8080 VP_LABOR_TOKEN=<admin-token> ./hochladen.sh
# shellcheck disable=SC2016 # die printf-Vorlagen sind Skript-Text fuer die Box
set -euo pipefail
: "${VP_LABOR_PORTAL:?VP_LABOR_PORTAL (lokales Portal) fehlt}"
: "${VP_LABOR_TOKEN:?VP_LABOR_TOKEN (Admin-Token des lokalen Portals) fehlt}"
case "$VP_LABOR_PORTAL" in *voltpilot.de*) echo "FEHLER: das ist kein lokales Portal" >&2; exit 2 ;; esac
HIER="$(cd "$(dirname "$0")" && pwd -P)"
KOPF
  printf '. %q\n' "$REPO/tools/ota/release-publish.sh"
  printf 'BAUART=%s\n' "$BAUART"
  printf 'for f in%s; do\n' "$REIHE"
  cat <<'RUMPF'
  rel="$(sed -n 's/^  "release": "\(.*\)",$/\1/p' "$HIER/fassungen/$f/release.json")"
  ota_register "$VP_LABOR_PORTAL" "$VP_LABOR_TOKEN" "$HIER/fassungen/$f/register.json"
  ota_light_upload "$VP_LABOR_PORTAL" "$VP_LABOR_TOKEN" "$rel" "linux/$BAUART" \
    "$HIER/fassungen/$f/vp-edge-light-linux-$BAUART.gz"
done
echo "--- alle Labor-Fassungen eingetragen und hochgeladen:"
cat "$HIER/fassungen.txt"
RUMPF
} >"$AUS/hochladen.sh"
chmod 0755 "$AUS/hochladen.sh"

echo
echo "--- fertig: $AUS"
cat "$AUS/fassungen.txt"
echo "Weiter: edge-light/labor/README.md (Labor-Mango einrichten, hochladen.sh, P1-P11)."
