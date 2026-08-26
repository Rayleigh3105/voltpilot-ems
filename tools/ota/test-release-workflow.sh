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

# Before a tag or manual run can write an Edge image to the registry, the
# release workflow must exercise every runtime layer it packages. Keep this
# structural assertion here because deploy.yaml already runs this self-check;
# accidentally removing the dependency then fails the normal main gate too.
python3 - "$WORKFLOW" <<'PY'
import sys, yaml

workflow = yaml.safe_load(open(sys.argv[1]))
jobs = workflow["jobs"]
assert jobs["build"]["needs"] == "test"
runs = "\n".join(
    step.get("run", "") for step in jobs["test"]["steps"]
)
for required in (
    "package_edge_runtime.py --check",
    # -timeout is pinned along with -race/-p 1: go test's 10-min DEFAULT is per
    # package and internal/agent runs close to it under -race on a shared
    # runner, so an explicit deadline is part of what makes this gate reliable.
    "go test -race -p 1 -timeout",
    "-not -path '*/node_modules/*'",
    '(( ${#tests[@]} > 0 ))',
    "node --test",
    "npm test",
    "edge-app/test/e2e-ocpp.sh",
    "edge-app/test/e2e-compose.sh",
):
    assert required in runs, required
PY
ok "Edge-Images werden erst nach Katalog-, Runtime-, Race- und Systemtests gebaut"

# Gegenprobe fuer Node 22: `node --test` ohne Dateipfade endet erfolgreich.
# Deshalb fuehren wir den ECHTEN Workflow-Schritt in einem absichtlich leeren
# nodered/-Baum aus und stellen sicher, dass der Nichtleer-Guard vorher
# abbricht und der erfolgreich endende node-Stub nie erreicht wird.
python3 - "$WORKFLOW" "$TMP/nodered-test-step.sh" <<'PY'
import sys, yaml

workflow, out = sys.argv[1], sys.argv[2]
steps = yaml.safe_load(open(workflow))["jobs"]["test"]["steps"]
step = next(s for s in steps if s.get("name") == "Node-RED runtime and drivers")
open(out, "w").write(step["run"])
PY
mkdir -p "$TMP/no-node-red-tests/nodered" "$TMP/node-stub-bin"
cat >"$TMP/node-stub-bin/node" <<EOF
#!/usr/bin/env bash
touch "$TMP/node-was-called"
exit 0
EOF
chmod +x "$TMP/node-stub-bin/node"
if (
	cd "$TMP/no-node-red-tests"
	PATH="$TMP/node-stub-bin:$PATH" bash "$TMP/nodered-test-step.sh"
) >"$TMP/no-tests.out" 2>"$TMP/no-tests.err"; then
	bad "leerer Node-RED-Fundlauf bricht ab" "Status ungleich 0" "Status 0"
else
	ok "leerer Node-RED-Fundlauf bricht trotz erfolgreichem node-Stub ab"
fi
has "$TMP/no-tests.err" "No Node-RED test files found" "der Nichtleer-Guard erklaert den Abbruch"
if [ -e "$TMP/node-was-called" ]; then
	bad "node --test wird ohne Dateien nicht aufgerufen" "node nicht aufgerufen" "node wurde aufgerufen"
else
	ok "node --test wird ohne Dateien nicht aufgerufen"
fi

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

# Der Signier-Schritt kommt gleich mit heraus - er ist der Schritt, der beim
# Erstflug (edge-2026.08.1) an einem verdoppelten Pfad zerbrach, und er wird
# unten mit ECHTER Verzeichnis-Tiefe ausgefuehrt.
python3 - "$WORKFLOW" "$TMP" <<'PY'
import sys, yaml
wf, out = sys.argv[1], sys.argv[2]
steps = yaml.safe_load(open(wf))["jobs"]["manifest"]["steps"]
step = next(s for s in steps if s.get("name", "").startswith("Signieren"))
open(out + "/sign-step.sh", "w").write(step["run"])
PY
ok "der Signier-Schritt ist im Workflow auffindbar"

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
#
# Die Identitaet wird ins REPO geschrieben, nicht je Kommando mitgegeben: ein
# ANNOTIERTER Tag braucht einen Tagger, und `git tag -a` erbt kein `-c` vom
# vorherigen `git commit`. Genau daran ist dieses Leg beim ERSTEN CI-Lauf
# gestorben (#183) - auf einem frischen Runner gibt es keine globale
# git-Identitaet, `git tag -a` endet mit Status 128, und weil der Block sein
# stderr verwarf, stand der Grund nirgends. Auf jeder Entwicklermaschine lief
# es durch, weil dort eine globale Identitaet konfiguriert ist.
#
# stdout bleibt still, stderr NICHT: ein Fehlschlag hier muss sich selbst
# erklaeren. (Der Nachbar tools/deploy/test-gitops-bump-workflow.sh macht es
# seit je richtig - er gibt die Identitaet jedem Kommando einzeln mit.)
(
	cd "$WS"
	git init -q .
	git config user.email t@t
	git config user.name t
	git commit -q --allow-empty -m init
	git tag -a edge-2026.08.1 -m 'Solarman-Lesepfad gehaertet.
min-from-seq=9
urgent=true
Keine /data-Migration.'
) >/dev/null

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
# stderr wird AUFGEHOBEN statt verworfen - siehe test-release-publish.sh.
STUBERR="$TMP/stub.err"
python3 "$HERE/testdata/stub-portal.py" >"$PORTFILE" 2>"$STUBERR" &
STUB_PID=$!
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
		"$(ota_file_mode "$KEYFILE")"
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
echo "== Fall 6: der ECHTE Signier-Schritt bei ECHTER Verzeichnis-Tiefe =="
# Die Luecke, durch die der Erstflug fiel: die 29 Faelle davor fuehrten NUR den
# Eingaben-Schritt aus, und der wechselt nirgends das Verzeichnis. `ota_sign`
# tut es (`cd edge-app/core`, weil dort das Go-Modul liegt) - und ein
# repo-relativer Pfad, der ERST DANN aufgeloest wird, landet bei
# `edge-app/core/edge-app/ota/trust-set.json`. Deshalb wird hier der echte
# `run:`-Text ausgefuehrt, in einem Baum mit der echten Tiefe (Trust-Set unter
# <root>/edge-app/ota, Werkzeug laufend in <root>/edge-app/core).
#
# Die Go-Werkzeugkette steht dabei als Stellvertreter da: gebaut werden muss
# nichts, geprueft wird die PFADAUFLOESUNG - und genau die ist Sache des
# Skripts, nicht des Compilers. Der Stellvertreter scheitert auf einer Datei,
# die es nicht gibt: dieselbe Ablehnung, mit der `vp-ota verify` abbrach.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/go" <<'SH'
#!/usr/bin/env bash
{ printf 'cwd=%s\n' "$(pwd -P)"; printf 'argv=%s\n' "$*"; } >>"$GO_SHIM_LOG"
prev=""
for a in "$@"; do
	case "$prev" in
	--trust-set | --manifest | --in | --key)
		[ -f "$a" ] || {
			printf 'open %s: no such file or directory\n' "$a" >&2
			exit 1
		}
		;;
	esac
	prev="$a"
done
SH
chmod +x "$TMP/bin/go"

printf '{"release":"edge-2026.08.1"}\n' >"$WS/release.json"

# Der Rumpf traegt GENAU EINEN Workflow-Ausdruck (die Schluesseldatei aus dem
# Eingaben-Schritt). Das wird gepruefft, bevor er ersetzt wird - ein spaeter
# hinzugefuegter zweiter Ausdruck darf hier nicht stillschweigend verschwinden.
eq "der Signier-Schritt traegt genau EINEN Workflow-Ausdruck (die Schluesseldatei)" \
	"\${{ steps.inputs.outputs.keyfile }}" \
	"$(grep -oE '[$][{][{][^}]*[}][}]' "$TMP/sign-step.sh" | tr '\n' ' ' | sed 's/ $//')"
sed 's|\${{ steps.inputs.outputs.keyfile }}|'"$WS"'/rel.key|' \
	"$TMP/sign-step.sh" >"$TMP/sign-step.run.sh"

# Der Anker im Skript ist `pwd -P`-aufgeloest (auf macOS liegt /var unter
# /private/var) - die Erwartung muss dieselbe Aufloesung benutzen.
WS_P="$(cd "$WS" && pwd -P)"
GO_LOG="$TMP/go-shim.log"
: >"$GO_LOG"
if (
	cd "$WS"
	PATH="$TMP/bin:$PATH" GO_SHIM_LOG="$GO_LOG" GITHUB_WORKSPACE="$WS" \
		bash "$TMP/sign-step.run.sh"
) >"$TMP/log6" 2>&1; then
	ok "der echte Signier-Schritt laeuft bei echter Tiefe durch"
else
	bad "der echte Signier-Schritt laeuft bei echter Tiefe durch" "Erfolg" "$(tail -n 3 "$TMP/log6")"
fi

eq "…und das Werkzeug lief wirklich UNTERHALB der Wurzel (sonst waere die Tiefe fingiert)" \
	"$WS_P/edge-app/core" "$(sed -n 's/^cwd=//p' "$GO_LOG" | tail -n 1)"

# DIE Zeile, die den Erstflug beendet haette: der Pfad, den die Gegenpruefung
# zu sehen bekommt, ist der im Repo - nicht der unter dem Arbeitsverzeichnis
# des Werkzeugs.
eq "die Gegenpruefung bekommt das Trust-Set AUS DEM REPO (nicht unter edge-app/core)" \
	"$WS_P/edge-app/ota/trust-set.json" \
	"$(sed -n 's/.*--trust-set \([^ ]*\).*/\1/p' "$GO_LOG" | tail -n 1)"
if grep -q 'edge-app/core/edge-app' "$GO_LOG"; then
	bad "kein verdoppelter Pfad" "einfacher Pfad" "$(grep -o '[^ ]*edge-app/core/edge-app[^ ]*' "$GO_LOG" | head -n 1)"
else
	ok "kein Pfad ist verdoppelt worden"
fi

# Und die Verallgemeinerung: der Anker haengt am Skript, nicht am Aufrufer -
# derselbe Aufruf aus einem anderen Verzeichnis findet dieselben Dateien.
: >"$GO_LOG"
if (
	cd "$WS/edge-app/core"
	PATH="$TMP/bin:$PATH" GO_SHIM_LOG="$GO_LOG" \
		bash -c '. "$1/tools/ota/release-publish.sh"; ota_sign "$1/release.json" "$1/rel.key"' _ "$WS"
) >"$TMP/log6b" 2>&1; then
	ok "…und derselbe Aufruf aus einem ANDEREN Arbeitsverzeichnis findet dieselben Dateien"
else
	bad "derselbe Aufruf aus einem anderen Arbeitsverzeichnis" "Erfolg" "$(tail -n 3 "$TMP/log6b")"
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
