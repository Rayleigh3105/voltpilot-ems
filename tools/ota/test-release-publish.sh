#!/usr/bin/env bash
# Selbsttest fuer tools/ota/release-publish.sh - OHNE Forgejo, OHNE Portal,
# OHNE Docker. Die reinen Funktionen laufen direkt, die Netz-Funktionen gegen
# einen lokalen Stub, der die drei Antworten spielt, auf die es ankommt:
# 201 neu · 200 bytegleiche Wiederholung · 409 abweichend.
#
# Ist `go` vorhanden, laeuft zusaetzlich die ECHTE Zeremonie in einem
# Temp-Verzeichnis (keygen -> trust-set -> manifest -> sign -> verify) und der
# fertige Register-Rumpf wird durch ota_register geschickt - damit ist der
# Zusammenbau aus Skript, vp-ota und Register-Endpunkt bewiesen und nicht nur
# behauptet.
#
#   tools/ota/test-release-publish.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
# shellcheck source=./release-publish.sh
. "$HERE/release-publish.sh"
# shellcheck source=./selfcheck-env.sh
. "$HERE/selfcheck-env.sh"
ota_install_err_trap
ota_env_report

PASS=0
FAIL=0
TMP="$(mktemp -d)"
STUB_PID=""
cleanup() {
	[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
	rm -rf "$TMP"
}
trap cleanup EXIT

ok() {
	PASS=$((PASS + 1))
	printf '  ok   %s\n' "$1"
}
bad() {
	FAIL=$((FAIL + 1))
	printf '  FAIL %s\n     erwartet: %s\n     bekommen: %s\n' "$1" "$2" "$3"
}
eq() {
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi
}
# Erwartet, dass ein Aufruf FEHLSCHLAEGT (die laute Ablehnung ist der Beweis).
fails() {
	local what="$1"
	shift
	if ( "$@" ) >/dev/null 2>&1; then
		bad "$what" "Abbruch" "erfolgreich durchgelaufen"
	else
		ok "$what"
	fi
}

echo "== reine Funktionen =="

# --- Zustandsversion ---------------------------------------------------------
eq "state-schema aus der ECHTEN Repo-Datei ist eine Ganzzahl >= 1" \
	"1" "$(ota_state_schema "$ROOT/edge-app/core/otastate.schema")"

printf '# nur ein Kommentar\n\n  7  \n' >"$TMP/s.schema"
eq "Kommentare + Leerzeilen werden uebersprungen" "7" "$(ota_state_schema "$TMP/s.schema")"

printf '# leer\n' >"$TMP/leer.schema"
fails "eine Datei ohne Zahl bricht ab statt eine zu erfinden" ota_state_schema "$TMP/leer.schema"
printf 'v3\n' >"$TMP/krumm.schema"
fails "eine unlesbare Zahl bricht ab" ota_state_schema "$TMP/krumm.schema"
fails "eine fehlende Datei bricht ab" ota_state_schema "$TMP/gibtsnicht.schema"

# --- Tag-Annotation ----------------------------------------------------------
ANN='Solarman-Lesepfad gehaertet.
min-from-seq=9
urgent=true
Keine /data-Migration.'

eq "min-from-seq aus der Annotation" "9" "$(ota_tag_directive min-from-seq "$ANN")"
eq "urgent aus der Annotation" "true" "$(ota_tag_directive urgent "$ANN")"
eq "eine nicht gesetzte Direktive ist LEER (der Aufrufer waehlt die Vorgabe)" \
	"" "$(ota_tag_directive allow-downgrade "$ANN")"
eq "die Notiz ist der Fliesstext OHNE die Direktiven" \
	"Solarman-Lesepfad gehaertet. Keine /data-Migration." "$(ota_tag_notes "$ANN")"

# Der Punkt der Whitelist: eine gewoehnliche Notiz mit einem Gleichheitszeichen
# darf nie zur Anweisung werden.
PROSE='Sollwert=0 wird jetzt sauber zurueckgenommen.
foo=bar'
eq "ein unbekannter Schluessel ist KEINE Direktive" "" "$(ota_tag_directive min-from-seq "$PROSE")"
eq "…und bleibt Teil der Notiz" \
	"Sollwert=0 wird jetzt sauber zurueckgenommen. foo=bar" "$(ota_tag_notes "$PROSE")"
eq "eine leere Annotation ergibt eine leere Notiz" "" "$(ota_tag_notes "")"

# --- key_id ------------------------------------------------------------------
cat >"$TMP/rel.key" <<'EOF'
{
  "schema_version": "1.0",
  "key_id": "rel-2026-a",
  "alg": "ed25519",
  "role": "release",
  "private_key": "AAAA",
  "public_key": "BBBB"
}
EOF
eq "key_id kommt AUS der Schluesseldatei" "rel-2026-a" "$(ota_key_id "$TMP/rel.key")"
printf '{"alg":"ed25519"}\n' >"$TMP/ohne.key"
fails "eine Schluesseldatei ohne key_id bricht ab" ota_key_id "$TMP/ohne.key"

# --- Forgejo-Auth ------------------------------------------------------------
eq "ein Repo-Token gewinnt" "token abc" "$(ota_forgejo_auth_header abc user pw)"
eq "Rueckfall auf Basic-Auth" "Basic dXNlcjpwdw==" "$(ota_forgejo_auth_header '' user pw)"
fails "ohne jede Zugangsdaten: Fehler statt anonymem Versuch" ota_forgejo_auth_header '' '' ''

# --- Token-URL ---------------------------------------------------------------
eq "die Token-URL haengt unter /auth (prod-Realm-Pfad)" \
	"https://portal.voltpilot.de/auth/realms/voltpilot/protocol/openid-connect/token" \
	"$(ota_token_url https://portal.voltpilot.de/)"

echo
echo "== gegen einen lokalen Stub =="

# Der Stub liegt in testdata/, damit ihn beide Selbsttests teilen.
STUB="$HERE/testdata/stub-portal.py"

PORTFILE="$TMP/port"
# stderr wird AUFGEHOBEN statt verworfen: kommt der Stub nicht hoch (kein
# Loopback, belegter Port, kaputtes python3), stand der Grund frueher nirgends.
STUBERR="$TMP/stub.err"
python3 "$STUB" >"$PORTFILE" 2>"$STUBERR" &
STUB_PID=$!
# Ohne disown meldet bash beim Aufraeumen ein "Terminated" ins Protokoll - das
# liest sich wie ein Fehlschlag und ist keiner.
disown "$STUB_PID" 2>/dev/null || true
for _ in $(seq 1 50); do
	[ -s "$PORTFILE" ] && break
	sleep 0.1
done
PORT="$(head -n 1 "$PORTFILE")"
[ -n "$PORT" ] || {
	echo "Stub konnte nicht starten" >&2
	[ -s "$STUBERR" ] && sed 's/^/  stub: /' "$STUBERR" >&2
	exit 1
}
BASE="http://127.0.0.1:$PORT"

TOK="$(ota_token "$BASE/auth/realms/voltpilot/protocol/openid-connect/token" \
	voltpilot-release-publisher richtig)"
eq "client_credentials liefert ein Token" "stub-token" "$TOK"
fails "ein falsches Geheimnis bricht LAUT ab" \
	ota_token "$BASE/auth/realms/voltpilot/protocol/openid-connect/token" \
	voltpilot-release-publisher falsch

eq "next-seq liefert die naechste UND die aktuelle Nummer" "13 12" \
	"$(ota_next_seq "$BASE" "$TOK")"
fails "next-seq ohne gueltiges Token bricht ab" ota_next_seq "$BASE" "kaputt"

cat >"$TMP/register.json" <<'EOF'
{
  "version": "edge-2026.08.1",
  "releaseSeq": 13,
  "targetCommit": "abcdef012345",
  "manifest": "{\n  \"release\": \"edge-2026.08.1\"\n}\n",
  "signature": "{\n  \"key_id\": \"rel-2026-a\"\n}\n",
  "signingKeyId": "rel-2026-a"
}
EOF
out="$(ota_register "$BASE" "$TOK" "$TMP/register.json")"
eq "erster Lauf: neu eingetragen" "Register: neu eingetragen." "$out"
out="$(ota_register "$BASE" "$TOK" "$TMP/register.json")"
eq "zweiter Lauf mit BYTEGLEICHEN Bytes: still in Ordnung" \
	"Register: bereits BYTEGLEICH eingetragen - Wiederholung, nichts geaendert." "$out"

sed 's/abcdef012345/000000000000/; s/edge-2026.08.1\\"/edge-2026.08.1x\\"/' \
	"$TMP/register.json" >"$TMP/abweichend.json"
fails "abweichende Bytes unter derselben Version: LAUTER Fehlschlag, kein stilles ok" \
	ota_register "$BASE" "$TOK" "$TMP/abweichend.json"

echo
echo "== echte Zeremonie (nur mit go) =="
if command -v go >/dev/null 2>&1; then
	# AUFGESPURT: das ist der einzige Block mit externem Werkzeug, und beim
	# Erstflug am 04.08. war der Fehler ein AUFGELOESTER PFAD (das
	# OTA_REPO_ROOT-Doppel unter edge-app/core) - genau das, was `set -x`
	# zeigt und eine blosse Fehlermeldung verschweigt. Der Rest des Laufs
	# bleibt still, damit die Spur nicht im Rauschen untergeht.
	set -x
	CER="$TMP/zeremonie"
	mkdir -p "$CER"
	CORE="$ROOT/edge-app/core"
	(cd "$CORE" && go run ./cmd/vp-ota keygen --id root-test --role root --out "$CER") >/dev/null
	(cd "$CORE" && go run ./cmd/vp-ota keygen --id rel-test --role release --out "$CER") >/dev/null
	(cd "$CORE" && go run ./cmd/vp-ota trust-set --key "$CER/rel-test.pub" --out "$CER/trust-set.json") >/dev/null
	(cd "$CORE" && go run ./cmd/vp-ota sign --key "$CER/root-test.key" --domain trust-set --in "$CER/trust-set.json") >/dev/null
	(cd "$CORE" && go run ./cmd/vp-ota manifest \
		--release edge-2026.08.2 --seq 14 --commit deadbeef0123 \
		--artifact "core=git.tecmaxx.de/x/edge-app-core@sha256:$(printf 'a%.0s' $(seq 64))" \
		--artifact "nodered=git.tecmaxx.de/x/edge-app-nodered@sha256:$(printf 'b%.0s' $(seq 64))" \
		--min-from-seq 13 --state-schema "$(ota_state_schema "$ROOT/edge-app/core/otastate.schema")" \
		--key-id rel-test --notes "Selbsttest" --out "$CER/release.json") >/dev/null
	(cd "$CORE" && go run ./cmd/vp-ota sign --key "$CER/rel-test.key" --domain release --in "$CER/release.json") >/dev/null

	if (cd "$CORE" && go run ./cmd/vp-ota verify --root "$CER/root-test.pub" \
		--trust-set "$CER/trust-set.json" --manifest "$CER/release.json") >/dev/null 2>&1; then
		ok "die frisch signierte Kette verifiziert (Wurzel -> Trust-Set -> Manifest)"
	else
		bad "die frisch signierte Kette verifiziert" "Urteil ok" "Pruefung fehlgeschlagen"
	fi

	# Die Gegenprobe, auf die es ankommt: eine FREMDE Wurzel darf nicht
	# durchgehen - genau das prueft der Lauf in CI mit `--root baked`.
	(cd "$CORE" && go run ./cmd/vp-ota keygen --id root-fremd --role root --out "$CER") >/dev/null
	fails "eine FREMDE Wurzel faellt durch" \
		env -C "$CORE" go run ./cmd/vp-ota verify --root "$CER/root-fremd.pub" \
		--trust-set "$CER/trust-set.json" --manifest "$CER/release.json"

	if [ -f "$CER/register.json" ]; then
		ok "vp-ota sign legt den Register-Rumpf daneben"
	else
		bad "vp-ota sign legt den Register-Rumpf daneben" "register.json" "fehlt"
	fi

	out="$(ota_register "$BASE" "$TOK" "$CER/register.json")"
	eq "der ECHTE Register-Rumpf wird angenommen" "Register: neu eingetragen." "$out"
	out="$(ota_register "$BASE" "$TOK" "$CER/register.json")"
	eq "…und ein Wiederholungslauf ist still in Ordnung" \
		"Register: bereits BYTEGLEICH eingetragen - Wiederholung, nichts geaendert." "$out"

	# --- der ganze Veroeffentlichungs-Weg, einmal komplett ------------------
	# ota_publish gegen den Stub: Release anlegen, VIER Assets anhaengen,
	# registrieren. Danach dasselbe noch einmal - ein Wiederholungslauf darf
	# weder an der schon vorhandenen Release noch an den gleichnamigen Assets
	# scheitern.
	cp "$CER/trust-set.json" "$TMP/trust-set.json"
	cp "$CER/trust-set.json.sig" "$TMP/trust-set.json.sig"
	pub() {
		VP_OTA_PORTAL="$BASE" VP_OTA_PORTAL_TOKEN="$TOK" \
			VP_OTA_FORGEJO_BASE="$BASE" VP_OTA_FORGEJO_REPO="mamotec/voltpilot-ems" \
			VP_OTA_FORGEJO_TOKEN="forgejo-stub" VP_OTA_TRUST_SET="$TMP/trust-set.json" \
			ota_publish "$CER/release.json" edge-2026.08.2
	}
	if out="$(pub 2>&1)"; then
		ok "ota_publish laeuft komplett durch"
	else
		bad "ota_publish laeuft komplett durch" "Erfolg" "$out"
	fi
	eq "es haengen genau VIER Assets an der Release" "4" \
		"$(curl -sS -H 'Authorization: token forgejo-stub' \
			"$BASE/api/v1/repos/mamotec/voltpilot-ems/releases/1/assets" |
			python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
	eq "…und es sind die richtigen vier" \
		"release.json release.json.sig trust-set.json trust-set.json.sig" \
		"$(curl -sS -H 'Authorization: token forgejo-stub' \
			"$BASE/api/v1/repos/mamotec/voltpilot-ems/releases/1/assets" |
			python3 -c 'import json,sys; print(" ".join(a["name"] for a in json.load(sys.stdin)))')"
	if out="$(pub 2>&1)"; then
		ok "ein WIEDERHOLTER Lauf ist ebenfalls in Ordnung (Release + Assets idempotent)"
	else
		bad "ein wiederholter Lauf ist ebenfalls in Ordnung" "Erfolg" "$out"
	fi
	eq "…und es sind danach immer noch genau vier (ersetzt, nicht vermehrt)" "4" \
		"$(curl -sS -H 'Authorization: token forgejo-stub' \
			"$BASE/api/v1/repos/mamotec/voltpilot-ems/releases/1/assets" |
			python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"

	# Die Bytes muessen den Weg unveraendert ueberstehen: aus dem Rumpf zurueck
	# gelesen ist das Manifest wieder byteweise die signierte Datei.
	if python3 - "$CER/register.json" "$CER/release.json" <<'PY'; then
import json, sys
body = json.load(open(sys.argv[1]))
raw = open(sys.argv[2], "rb").read()
sys.exit(0 if body["manifest"].encode() == raw else 1)
PY
		ok "der Register-Rumpf traegt die Manifest-Bytes UNVERAENDERT"
	else
		bad "der Register-Rumpf traegt die Manifest-Bytes UNVERAENDERT" "gleich" "abweichend"
	fi
	set +x
else
	echo "  (uebersprungen - kein go im PATH)"
fi

echo
echo "== der Anhang haengt am REPO, nicht am Arbeitsverzeichnis =="
# Die zweite Haelfte derselben Falle, die den Erstflug beendete: die vier
# Assets werden ueber die VORGABE `edge-app/ota/trust-set.json` gefunden. Haengt
# die am Arbeitsverzeichnis, haengt sie daran, WO der Lauf gerade steht - und
# der Signier-Schritt davor steht nachweislich woanders. Also: derselbe Aufruf
# aus `edge-app/core` heraus, mit der Vorgabe (VP_OTA_TRUST_SET ist NICHT
# gesetzt), muss die vier Dateien des Repos anhaengen.
PUB="$TMP/anhang"
mkdir -p "$PUB"
printf '{"release":"edge-2026.08.3"}\n' >"$PUB/release.json"
printf '{"key_id":"rel-2026-a"}\n' >"$PUB/release.json.sig"
cat >"$PUB/register.json" <<'EOF'
{
  "version": "edge-2026.08.3",
  "releaseSeq": 15,
  "targetCommit": "0123456789ab",
  "manifest": "{\"release\":\"edge-2026.08.3\"}\n",
  "signature": "{\"key_id\":\"rel-2026-a\"}\n",
  "signingKeyId": "rel-2026-a"
}
EOF
if out="$(
	cd "$ROOT/edge-app/core" || exit 1
	VP_OTA_PORTAL="$BASE" VP_OTA_PORTAL_TOKEN="$TOK" \
		VP_OTA_FORGEJO_BASE="$BASE" VP_OTA_FORGEJO_REPO="mamotec/voltpilot-ems" \
		VP_OTA_FORGEJO_TOKEN="forgejo-stub" \
		ota_publish "$PUB/release.json" edge-2026.08.3 2>&1
)"; then
	ok "ota_publish findet das Trust-Set des Repos auch aus einem anderen Verzeichnis"
else
	bad "ota_publish findet das Trust-Set des Repos auch aus einem anderen Verzeichnis" "Erfolg" "$out"
fi
# Die Release-id wird ueber den Tag gesucht, nicht geraten - sonst haenge diese
# Pruefung daran, ob die Zeremonie oben gelaufen ist.
RID="$(curl -sS -H 'Authorization: token forgejo-stub' \
	"$BASE/api/v1/repos/mamotec/voltpilot-ems/releases/tags/edge-2026.08.3" |
	python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
eq "…und es sind wieder genau die vier richtigen Dateien" \
	"release.json release.json.sig trust-set.json trust-set.json.sig" \
	"$(curl -sS -H 'Authorization: token forgejo-stub' \
		"$BASE/api/v1/repos/mamotec/voltpilot-ems/releases/$RID/assets" |
		python3 -c 'import json,sys; print(" ".join(a["name"] for a in json.load(sys.stdin)))')"

echo
echo "== Wirkpfad-Disziplin =="
# Der Anker der Pfadaufloesung ist die Skriptdatei selbst - NIE das
# Arbeitsverzeichnis. Ein `pwd`-Anker war genau der Fehler des Erstflugs
# (edge-2026.08.1): er wurde erst INNERHALB von `(cd edge-app/core && …)`
# ausgewertet und verdoppelte den Pfad.
if grep -qE '^OTA_REPO_ROOT=.*BASH_SOURCE' "$HERE/release-publish.sh"; then
	ok "die Repo-Wurzel wird aus dem Ort der Skriptdatei bestimmt"
else
	bad "die Repo-Wurzel wird aus dem Ort der Skriptdatei bestimmt" "OTA_REPO_ROOT=… BASH_SOURCE" "fehlt"
fi
# `pwd` darf GENAU EINMAL vorkommen: in der Zeile, die den Anker selbst
# aufloest. Jedes weitere Vorkommen waere wieder ein Pfad am Aufrufer.
eq "ausser dem Anker selbst haengt kein Pfad am Arbeitsverzeichnis" "0" \
	"$(grep -c 'pwd' "$HERE/release-publish.sh" | tr -d ' ' |
		awk -v n="$(grep -c '^OTA_REPO_ROOT=.*pwd' "$HERE/release-publish.sh" | tr -d ' ')" '{print $1 - n}')"
# Und die Verallgemeinerung, die den Fehler als KLASSE ausschliesst: in den
# Zeilen, die nach einem `cd` laufen, darf keine Kommandosubstitution stehen -
# sie wuerde erst dort ausgewertet, also im falschen Verzeichnis.
# shellcheck disable=SC2016  # das $ ist ein Literal im grep-Muster, bewusst nicht expandiert
CD_LINES="$(grep -n 'cd "\$core" && go run' -A 2 "$HERE/release-publish.sh" | grep '\$(' || true)"
eq "die vp-ota-Aufrufe tragen keine Kommandosubstitution (alles ist VOR dem cd aufgeloest)" \
	"" "$CD_LINES"
# Das ist keine Kosmetik: `--root baked` IST die Pruefung des Geraets. Ein Lauf,
# der gegen irgendeine andere Wurzel prueft, prueft nicht das, was zaehlt.
if grep -q -- '--root baked' "$HERE/release-publish.sh"; then
	ok "die Gegenpruefung laeuft gegen die EINGEBACKENE Wurzel"
else
	bad "die Gegenpruefung laeuft gegen die EINGEBACKENE Wurzel" "--root baked" "fehlt"
fi
if grep -qE 'ota_die .*Gegenpruefung' "$HERE/release-publish.sh"; then
	ok "eine fehlgeschlagene Gegenpruefung bricht ab"
else
	bad "eine fehlgeschlagene Gegenpruefung bricht ab" "ota_die" "fehlt"
fi

echo
printf '%d bestanden, %d fehlgeschlagen\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
