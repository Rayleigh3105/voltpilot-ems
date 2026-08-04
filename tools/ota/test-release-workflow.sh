#!/usr/bin/env bash
# Fuehrt den ECHTEN `run:`-Text des Release-Schritts aus
# .forgejo/workflows/edge-images.yaml aus - gegen einen lokalen Stub, ohne
# Forgejo, ohne Portal, ohne Docker (das Muster von
# tools/deploy/test-gitops-bump-workflow.sh).
#
# Warum das eine eigene Pruefung ist: die Funktionen in release-publish.sh
# koennen alle stimmen, waehrend der Workflow sie falsch verdrahtet (ein
# vergessener env-Eintrag, eine falsche Vorgabe, ein Abbruch, der nicht
# abbricht). Genau diese Naht ist hier nachgewiesen.
#
#   tools/ota/test-release-workflow.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
WORKFLOW="$ROOT/.forgejo/workflows/edge-images.yaml"
STEP="Release-Eingaben bestimmen"

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
# has <datei> <muster (fest)> <was> - der Fund IST der Beweis.
has() {
	if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3" "$2" "nicht gefunden"; fi
}
hasre() {
	if grep -qE -- "$2" "$1"; then ok "$3"; else bad "$3" "$2" "nicht gefunden"; fi
}

command -v python3 >/dev/null || {
	echo "python3 fehlt" >&2
	exit 1
}

# --- den Schritt aus dem Workflow herausschneiden ----------------------------
python3 - "$WORKFLOW" "$STEP" "$TMP" <<'PY'
import sys, yaml
wf, step_name, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = yaml.safe_load(open(wf))
steps = d["jobs"]["manifest"]["steps"]
step = next(s for s in steps if s.get("name") == step_name)
open(out + "/step.sh", "w").write(step["run"])
open(out + "/step-env.txt", "w").write("\n".join(sorted(step.get("env", {}))) + "\n")
PY
ok "der Schritt \"$STEP\" ist im Workflow auffindbar"

# Der Schritt darf KEINE ${{ }}-Ausdruecke im Rumpf tragen: nur dann ist er
# ausserhalb von Forgejo ausfuehrbar - und nur dann kann eine Eingabe nicht
# heimlich an der env-Liste vorbei hereinkommen.
if grep -qE -- '[$][{][{]' "$TMP/step.sh"; then
	bad "der Rumpf ist frei von Workflow-Ausdruecken" "keine Ausdruecke" "$(grep -oE '[$][{][{][^}]*[}][}]' "$TMP/step.sh" | head -n 1)"
else
	ok "der Rumpf ist frei von Workflow-Ausdruecken (alle Eingaben ueber env:)"
fi

# Die env-Liste des Schritts muss genau die Variablen tragen, die der Rumpf
# liest - ein vergessener Eintrag waere im echten Lauf eine LEERE Eingabe.
eq "die env-Liste des Schritts ist vollstaendig" \
	"EDGE_MIN_FROM_SEQ EDGE_RELEASE_SEQ EDGE_SIGNING_KEY_ID EDGE_STATE_SCHEMA VP_OTA_PORTAL VP_OTA_PUBLISHER_CLIENT_ID VP_OTA_PUBLISHER_CLIENT_SECRET VP_OTA_RELEASE_KEY" \
	"$(tr '\n' ' ' <"$TMP/step-env.txt" | sed 's/ $//')"

# --- eine Arbeitskopie, in der der Schritt laufen kann -----------------------
WS="$TMP/ws"
mkdir -p "$WS/tools" "$WS/edge-app/core" "$WS/edge-app/ota"
cp -R "$ROOT/tools/ota" "$WS/tools/ota"
cp "$ROOT/edge-app/core/otastate.schema" "$WS/edge-app/core/otastate.schema"
printf '{"schema_version":"1.0","keys":[]}\n' >"$WS/edge-app/ota/trust-set.json"
printf '{"schema_version":"1.0"}\n' >"$WS/edge-app/ota/trust-set.json.sig"

# Ein echter git-Tag mit Annotation - genau das liest der Schritt aus.
(
	cd "$WS"
	git init -q .
	git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
	git tag -a edge-2026.08.1 -m 'Solarman-Lesepfad gehaertet.
min-from-seq=9
urgent=true
Keine /data-Migration.'
) >/dev/null 2>&1

cat >"$WS/rel.key" <<'EOF'
{
  "schema_version": "1.0",
  "key_id": "rel-2026-z",
  "alg": "ed25519",
  "role": "release",
  "private_key": "AAAA",
  "public_key": "BBBB"
}
EOF

# --- Stub ---------------------------------------------------------------------
PORTFILE="$TMP/port"
python3 "$HERE/testdata/stub-portal.py" >"$PORTFILE" 2>/dev/null &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
for _ in $(seq 1 50); do
	[ -s "$PORTFILE" ] && break
	sleep 0.1
done
PORT="$(head -n 1 "$PORTFILE")"
[ -n "$PORT" ] || {
	echo "Stub konnte nicht starten" >&2
	exit 1
}
STUB_BASE="http://127.0.0.1:$PORT"

# run_step <ausgabedatei> ; Umgebung kommt vom Aufrufer
run_step() {
	local outfile="$1"
	: >"$outfile"
	(
		cd "$WS"
		export GITHUB_OUTPUT="$outfile"
		export RUNNER_TEMP="$TMP/runner"
		mkdir -p "$RUNNER_TEMP"
		export GITHUB_REF_NAME=edge-2026.08.1
		bash "$TMP/step.sh"
	)
}
val() { sed -n "s/^$2=//p" "$1"; }

echo
echo "== Fall 1: alle Geheimnisse da (der Normalfall) =="
export VP_OTA_RELEASE_KEY
VP_OTA_RELEASE_KEY="$(cat "$WS/rel.key")"
export VP_OTA_PUBLISHER_CLIENT_SECRET=richtig
export VP_OTA_PORTAL="$STUB_BASE"
export VP_OTA_PUBLISHER_CLIENT_ID=voltpilot-release-publisher
export EDGE_RELEASE_SEQ="" EDGE_MIN_FROM_SEQ="" EDGE_STATE_SCHEMA="" EDGE_SIGNING_KEY_ID=""

if run_step "$TMP/out1" >"$TMP/log1" 2>&1; then
	ok "der Schritt laeuft durch"
else
	bad "der Schritt laeuft durch" "Erfolg" "$(tail -n 3 "$TMP/log1")"
fi
eq "ready=true" "true" "$(val "$TMP/out1" ready)"
eq "die Sequenz kommt aus dem REGISTER, nicht aus einer Repo-Variable" \
	"13" "$(val "$TMP/out1" seq)"
eq "der Vorgaenger-Stand wird mitgefuehrt" "12" "$(val "$TMP/out1" prev)"
eq "die key_id kommt AUS der Schluesseldatei" "rel-2026-z" "$(val "$TMP/out1" key_id)"
eq "die Zustandsversion kommt aus der Repo-Datei" "1" "$(val "$TMP/out1" state_schema)"
eq "min-from-seq kommt aus der Tag-Annotation" "9" "$(val "$TMP/out1" min_from)"
eq "urgent kommt aus der Tag-Annotation" "true" "$(val "$TMP/out1" urgent)"
eq "die Notiz ist der Annotations-Fliesstext" \
	"Solarman-Lesepfad gehaertet. Keine /data-Migration." "$(val "$TMP/out1" notes)"

KEYFILE="$(val "$TMP/out1" keyfile)"
if [ -f "$KEYFILE" ]; then
	eq "die Schluesseldatei liegt 0600 AUSSERHALB des Checkouts" "600" \
		"$(stat -f '%OLp' "$KEYFILE" 2>/dev/null || stat -c '%a' "$KEYFILE")"
	case "$KEYFILE" in
	"$WS"/*) bad "die Schluesseldatei liegt ausserhalb des Checkouts" "ausserhalb" "$KEYFILE" ;;
	*) ok "die Schluesseldatei liegt ausserhalb des Checkouts" ;;
	esac
else
	bad "die Schluesseldatei wird geschrieben" "$KEYFILE" "fehlt"
fi
if grep -q 'AAAA' "$TMP/log1"; then
	bad "der geheime Schluessel steht NICHT im Protokoll" "kein private_key" "im Log gefunden"
else
	ok "der geheime Schluessel steht NICHT im Protokoll"
fi

echo
echo "== Fall 2: kein Trust-Set im Repo =="
mv "$WS/edge-app/ota/trust-set.json" "$WS/edge-app/ota/trust-set.json.weg"
if run_step "$TMP/out2" >"$TMP/log2" 2>&1; then
	bad "ohne Trust-Set bricht der Schritt ab" "Abbruch" "durchgelaufen"
else
	ok "ohne Trust-Set bricht der Schritt ab (die Gegenpruefung waere unmoeglich)"
fi
has "$TMP/log2" '::error::' "…und sagt LAUT, welche Datei fehlt"
mv "$WS/edge-app/ota/trust-set.json.weg" "$WS/edge-app/ota/trust-set.json"

echo
echo "== Fall 3: keine Geheimnisse - Handpfad, aber GRUEN =="
export VP_OTA_RELEASE_KEY="" VP_OTA_PUBLISHER_CLIENT_SECRET=""
export EDGE_RELEASE_SEQ=42 EDGE_SIGNING_KEY_ID=rel-2026-a
if run_step "$TMP/out3" >"$TMP/log3" 2>&1; then
	ok "ohne Geheimnisse laeuft der Schritt GRUEN durch (die Automatik ist einschaltbar)"
else
	bad "ohne Geheimnisse laeuft der Schritt gruen durch" "Erfolg" "$(tail -n 3 "$TMP/log3")"
fi
eq "ready=false" "false" "$(val "$TMP/out3" ready)"
eq "die Sequenz kommt dann aus der Repo-Variable" "42" "$(val "$TMP/out3" seq)"
eq "die key_id ebenfalls aus der Variable" "rel-2026-a" "$(val "$TMP/out3" key_id)"
has "$TMP/log3" '::notice::' "…und der Lauf sagt, WARUM nicht signiert wurde"

echo
echo "== Fall 4: weder Konto noch EDGE_RELEASE_SEQ =="
export EDGE_RELEASE_SEQ=""
if run_step "$TMP/out4" >"$TMP/log4" 2>&1; then
	bad "ohne jede Ordnungsquelle bricht der Schritt ab" "Abbruch" "durchgelaufen"
else
	ok "ohne jede Ordnungsquelle bricht der Schritt ab, statt eine Nummer zu erfinden"
fi

echo
echo "== Fall 5: falsches Client-Geheimnis =="
export VP_OTA_RELEASE_KEY
VP_OTA_RELEASE_KEY="$(cat "$WS/rel.key")"
export VP_OTA_PUBLISHER_CLIENT_SECRET=falsch EDGE_RELEASE_SEQ=42
if run_step "$TMP/out5" >"$TMP/log5" 2>&1; then
	bad "ein abgelehntes Token bricht ab" "Abbruch" "durchgelaufen"
else
	ok "ein abgelehntes Token bricht ab - es faellt NICHT still auf die Repo-Variable zurueck"
fi

echo
echo "== Verdrahtung der spaeteren Schritte =="
python3 - "$WORKFLOW" <<'PY' >"$TMP/wire.txt"
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
for s in d["jobs"]["manifest"]["steps"]:
    print("%s|%s|%s" % (s.get("name", ""), s.get("if", ""), (s.get("run") or "").replace("\n", " ")))
PY
hasre "$TMP/wire.txt" "^Signieren.*ready == 'true'" "signiert wird nur mit ready=true"
hasre "$TMP/wire.txt" "^Assets anhaengen.*ready == 'true'" "veroeffentlicht wird nur mit ready=true"
has "$TMP/wire.txt" 'Schluessel + Token vom Runner entfernen|always()' \
	"der Schluessel wird IMMER vom Runner entfernt (auch nach einem Abbruch)"
has "$TMP/wire.txt" 'ota_sign ' \
	"der Signier-Schritt ruft die geprüfte Funktion, statt vp-ota selbst zu verdrahten"
has "$TMP/wire.txt" 'ota_publish ' "der Veroeffentlichungs-Schritt ruft ota_publish"

echo
printf '%d bestanden, %d fehlgeschlagen\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
