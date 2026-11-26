#!/usr/bin/env bash
# report-failure.sh <job-titel> <log-datei> [weitere log-dateien ...]
#
# Macht einen roten Lauf ohne Browser lesbar: haengt die ersten Fehlerzeilen
# UND die letzten ~200 Zeilen jeder angegebenen Log-Datei als Kommentar an
# eine feste, idempotent gefundene-oder-angelegte Forgejo-Issue (Titel
# ${REPORT_FAILURE_ISSUE_TITLE:-"CI: automatische Fehlermeldungen"}). Die
# Forgejo-API dieser Version hat keine Log-Route (actions/{jobs,runs}/logs
# antworten 404); dieser Weg braucht darum nur die vorhandenen Secrets
# FORGEJO_USERNAME/FORGEJO_PASSWORD (Basic gegen die REST-API, wie schon fuer
# die Registry) - kein neues Geheimnis.
#
# Die letzten 200 Zeilen allein reichen oft nicht: ein Teardown nach einem
# roten Build (Hikari/Postgres-Verbindungsabbau, Spring-Context-Shutdown)
# haengt oft NACH der eigentlichen Fehlermeldung noch Rauschen an, das die
# echte Ursache aus dem Tail-Fenster drueckt (beobachtet in Lauf 661:
# "password authentication failed" beim Pool-Abbau, nicht die Ursache
# selbst). Darum sucht report_failure_first_error_excerpt zusaetzlich die
# erste Zeile, die wie eine echte Testfehlermeldung aussieht (Maven
# "<<< FAILURE!"/"<<< ERROR!"/"Tests run: N, Failures|Errors: >0", pytest
# "FAILED "/"ERROR "/"=== FAILURES ===") und haengt ab dort einen Ausschnitt
# an - vor dem unveraenderten Tail der letzten 200 Zeilen.
#
# Absichtlich klein und ohne Workflow-Bezug, damit der nightly-Lauf denselben
# Weg spaeter ohne Aenderung hier mitbenutzen kann. Fehlende Log-Dateien
# werden stillschweigend ausgelassen (ein fruehgescheiterter Schritt laesst
# spaetere Schritte nie laufen, ihre Log-Datei existiert dann nicht).
set -euo pipefail

# report_failure_first_error_excerpt <log-datei> - gibt bis zu 200 Zeilen ab
# der ersten erkennbaren Testfehlermeldung aus, leer wenn keine gefunden
# wird (dann bleibt nur der Tail uebrig, wie vorher).
report_failure_first_error_excerpt() {
	local log="$1" line
	line="$(grep -n -m1 -E \
		'<<< FAILURE!|<<< ERROR!|Tests run: [0-9]+, Failures: [1-9]|Tests run: [0-9]+, Errors: [1-9]|^\[ERROR\]|^FAILED |^ERROR |^=+ FAILURES =+' \
		"$log" 2>/dev/null | head -n1 | cut -d: -f1 || true)"
	[ -n "$line" ] || return 0
	tail -n "+$line" "$log" | head -n 200
}

if [ "$#" -lt 2 ]; then
	echo "Verwendung: $0 <job-titel> <log-datei> [weitere log-dateien ...]" >&2
	exit 2
fi

job="$1"
shift

base="${GITHUB_SERVER_URL:-https://git.tecmaxx.de}"
base="${base%/}"
repo="${GITHUB_REPOSITORY:-mamotec/voltpilot-ems}"
titel="${REPORT_FAILURE_ISSUE_TITLE:-CI: automatische Fehlermeldungen}"
user="${FORGEJO_USERNAME:-}"
pass="${FORGEJO_PASSWORD:-}"

if [ -z "$user" ] || [ -z "$pass" ]; then
	echo "report-failure.sh: FORGEJO_USERNAME/FORGEJO_PASSWORD fehlen, kein Bericht moeglich" >&2
	exit 1
fi

auth="Basic $(printf '%s:%s' "$user" "$pass" | base64 | tr -d '\n')"

# report_failure_find_issue <api> <auth> <titel> - gibt die Nummer der
# offenen Issue mit genau diesem Titel aus, leer wenn keine existiert.
report_failure_find_issue() {
	local api="$1" auth="$2" titel="$3" res
	res="$(curl -fsS -H "Authorization: $auth" \
		"$api/issues?state=open&type=issues&q=$(report_failure_urlencode "$titel")")"
	printf '%s' "$res" |
		python3 -c '
import json, sys
titel = sys.argv[1]
for issue in json.load(sys.stdin):
    if issue.get("title") == titel:
        print(issue["number"])
        break
' "$titel"
}

# report_failure_urlencode <text> - minimale URL-Kodierung fuer den
# Issue-Suchparameter, ohne Abhaengigkeit von jq/curl --data-urlencode (der
# Aufruf hier ist ein GET).
report_failure_urlencode() {
	python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

# report_failure_create_issue <api> <auth> <titel> - legt die Issue an, gibt
# ihre Nummer aus.
report_failure_create_issue() {
	local api="$1" auth="$2" titel="$3" body
	body="Sammelt automatische Berichte roter CI-Laeufe (erste Fehlerzeilen und letzte ~200 Zeilen je gescheitertem Schritt), damit sie ohne Browser-Login ueber die Forgejo-API lesbar sind. Siehe tools/ci/report-failure.sh."
	curl -fsS -X POST -H "Authorization: $auth" -H "Content-Type: application/json" \
		"$api/issues" \
		-d "$(python3 -c 'import json, sys; print(json.dumps({"title": sys.argv[1], "body": sys.argv[2]}))' "$titel" "$body")" |
		python3 -c 'import json, sys; print(json.load(sys.stdin)["number"])'
}

api="$base/api/v1/repos/$repo"
issue="$(report_failure_find_issue "$api" "$auth" "$titel")"
if [ -z "$issue" ]; then
	issue="$(report_failure_create_issue "$api" "$auth" "$titel")"
fi

{
	printf '### %s rot\n\n' "$job"
	printf -- '- Commit: %s\n' "${GITHUB_SHA:-unbekannt}"
	printf -- '- Lauf: %s #%s\n' "${GITHUB_WORKFLOW:-unbekannt}" "${GITHUB_RUN_NUMBER:-?}"
	printf '\n'
	for log in "$@"; do
		if [ -f "$log" ]; then
			excerpt="$(report_failure_first_error_excerpt "$log")"
			if [ -n "$excerpt" ]; then
				printf '<details><summary>%s (erste Fehlerzeilen)</summary>\n\n```\n' "$(basename "$log")"
				printf '%s' "$excerpt"
				printf '\n```\n\n</details>\n\n'
			fi
			printf '<details><summary>%s (letzte 200 Zeilen)</summary>\n\n```\n' "$(basename "$log")"
			tail -n 200 "$log"
			printf '\n```\n\n</details>\n\n'
		fi
	done
} >/tmp/report-failure-body.md

python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    body = f.read()
print(json.dumps({"body": body}))
' /tmp/report-failure-body.md >/tmp/report-failure-body.json

curl -fsS -X POST -H "Authorization: $auth" -H "Content-Type: application/json" \
	"$api/issues/$issue/comments" \
	-d @/tmp/report-failure-body.json >/dev/null

echo "report-failure.sh: Bericht an Issue #$issue angehaengt ($api)"
