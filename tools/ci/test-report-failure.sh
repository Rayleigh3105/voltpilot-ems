#!/usr/bin/env bash
# Selbsttest fuer tools/ci/report-failure.sh - OHNE echtes Forgejo: ein
# lokaler Stub spielt die Issue-API (tools/ci/testdata/stub-forgejo-issues.py).
#
#   tools/ci/test-report-failure.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

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
fails() {
	local what="$1"
	shift
	if ( "$@" ) >/dev/null 2>&1; then
		bad "$what" "Abbruch" "erfolgreich durchgelaufen"
	else
		ok "$what"
	fi
}

STUB="$HERE/testdata/stub-forgejo-issues.py"
PORTFILE="$TMP/port"
STUBERR="$TMP/stub.err"
python3 "$STUB" >"$PORTFILE" 2>"$STUBERR" &
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

AUTH='Authorization: Basic dnA6dnA='
REPO="irgendwer/irgendwas"

printf 'Zeile 1\nZeile 2\nZeile 3\n' >"$TMP/klein.log"
# 250 Zeilen, damit die Beschneidung auf die letzten 200 pruefbar ist.
seq 1 250 | sed 's/^/Zeile /' >"$TMP/gross.log"

echo "== ohne Secrets bricht laut ab =="
fails "FORGEJO_USERNAME/FORGEJO_PASSWORD fehlen" \
	env -u FORGEJO_USERNAME -u FORGEJO_PASSWORD \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	"$HERE/report-failure.sh" "Test (Go, Skripte)" "$TMP/klein.log"

echo
echo "== erster Bericht legt die Issue an =="
out="$(FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	GITHUB_SHA=abc123 GITHUB_WORKFLOW=Werkstatt-Dienst GITHUB_RUN_NUMBER=7 \
	"$HERE/report-failure.sh" "Test (Go, Skripte)" "$TMP/klein.log" "$TMP/gross.log")"
eq "meldet die angelegte Issue #1" "report-failure.sh: Bericht an Issue #1 angehaengt (http://127.0.0.1:$PORT/api/v1/repos/$REPO)" "$out"

kommentare="$(curl -fsS -H "$AUTH" "http://127.0.0.1:$PORT/api/v1/repos/$REPO/issues/1/comments")"
eq "genau ein Kommentar auf der Issue" "1" "$(printf '%s' "$kommentare" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
body="$(printf '%s' "$kommentare" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"

case "$body" in
*"klein.log"*) ok "nennt die kleine Log-Datei" ;;
*) bad "nennt die kleine Log-Datei" "klein.log im Bericht" "$body" ;;
esac
case "$body" in
*"Zeile 51"*) ok "die grosse Log-Datei ist auf die letzten 200 Zeilen beschnitten (Zeile 51 noch dabei)" ;;
*) bad "die grosse Log-Datei ist auf die letzten 200 Zeilen beschnitten" "Zeile 51 enthalten" "$body" ;;
esac
case "$body" in
*"Zeile 50"$'\n'*) bad "Zeile 50 darf NICHT mehr dabei sein (nur die letzten 200 von 250)" "Zeile 50 fehlt" "$body" ;;
*) ok "Zeile 50 ist abgeschnitten (nur die letzten 200 von 250 Zeilen)" ;;
esac
case "$body" in
*abc123*) ok "nennt den Commit" ;;
*) bad "nennt den Commit" "abc123 im Bericht" "$body" ;;
esac

echo
echo "== zweiter Bericht findet dieselbe Issue wieder, legt keine zweite an =="
out2="$(FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	GITHUB_SHA=def456 GITHUB_WORKFLOW=Werkstatt-Dienst GITHUB_RUN_NUMBER=8 \
	"$HERE/report-failure.sh" "Test (Go, Skripte)" "$TMP/klein.log")"
eq "haengt wieder an Issue #1, keine #2" "report-failure.sh: Bericht an Issue #1 angehaengt (http://127.0.0.1:$PORT/api/v1/repos/$REPO)" "$out2"

kommentare2="$(curl -fsS -H "$AUTH" "http://127.0.0.1:$PORT/api/v1/repos/$REPO/issues/1/comments")"
eq "jetzt zwei Kommentare auf derselben Issue" "2" "$(printf '%s' "$kommentare2" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"

echo
echo "== fehlende Log-Dateien werden stillschweigend ausgelassen =="
out3="$(FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	"$HERE/report-failure.sh" "Test (Go, Skripte)" "$TMP/gibtsnicht.log" "$TMP/klein.log")"
eq "laeuft trotz einer fehlenden Datei durch" "report-failure.sh: Bericht an Issue #1 angehaengt (http://127.0.0.1:$PORT/api/v1/repos/$REPO)" "$out3"

echo
echo "== erste Fehlerzeilen landen vor dem Tail, auch wenn Abbau-Rauschen danach den Tail füllt =="
{
	printf 'INFO: Start\n'
	printf 'EchteKlasseTest.echteMethode:42 Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE!\n'
	printf 'java.lang.AssertionError: erwartet war anders\n'
	printf '\tat EchteKlasseTest.echteMethode(EchteKlasseTest.java:42)\n'
	seq 1 250 | sed 's/^/Abbau-Rauschen Zeile /'
} >"$TMP/teardown.log"

out4="$(FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	GITHUB_SHA=feedface GITHUB_WORKFLOW=Nightly GITHUB_RUN_NUMBER=661 \
	"$HERE/report-failure.sh" "Test (api-1)" "$TMP/teardown.log")"
eq "haengt weiter an Issue #1" "report-failure.sh: Bericht an Issue #1 angehaengt (http://127.0.0.1:$PORT/api/v1/repos/$REPO)" "$out4"

kommentare4="$(curl -fsS -H "$AUTH" "http://127.0.0.1:$PORT/api/v1/repos/$REPO/issues/1/comments")"
body4="$(printf '%s' "$kommentare4" | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1])')"

case "$body4" in
*"erste Fehlerzeilen"*) ok "hat einen Abschnitt 'erste Fehlerzeilen'" ;;
*) bad "hat einen Abschnitt 'erste Fehlerzeilen'" "Abschnitt vorhanden" "$body4" ;;
esac
case "$body4" in
*"erwartet war anders"*) ok "die echte Fehlermeldung ist im Bericht, trotz 250 Zeilen Rauschen danach" ;;
*) bad "die echte Fehlermeldung ist im Bericht" "AssertionError im Bericht" "$body4" ;;
esac

echo
echo "== grosses Log (SIGPIPE-Falle): tail|head in report_failure_first_error_excerpt darf das Skript nicht unter pipefail abreissen =="
{
	printf 'INFO: Start\n'
	printf 'EchteKlasseTest.echteMethode:42 Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE!\n'
	printf 'java.lang.AssertionError: erwartet war anders\n'
	# Deutlich mehr als 200 Zeilen nach dem Treffer UND gross genug, dass die
	# Pipe (64 KB) voll wird, waehrend `tail` noch schreibt und `head` schon
	# zu ist (SIGPIPE, tail endet 141) - ein kleines Testlog wie oben
	# reproduziert das nicht zuverlaessig, siehe Kommentar im Skript selbst.
	seq 1 500000 | sed 's/^/Abbau-Rauschen Zeile /'
} >"$TMP/riesig.log"

out5="$(FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp \
	GITHUB_SERVER_URL="http://127.0.0.1:$PORT" GITHUB_REPOSITORY="$REPO" \
	GITHUB_SHA=riesig GITHUB_WORKFLOW=Nightly GITHUB_RUN_NUMBER=999 \
	"$HERE/report-failure.sh" "Test (api-1)" "$TMP/riesig.log")"
eq "haengt trotz grossem Log weiter an Issue #1" "report-failure.sh: Bericht an Issue #1 angehaengt (http://127.0.0.1:$PORT/api/v1/repos/$REPO)" "$out5"

kommentare5="$(curl -fsS -H "$AUTH" "http://127.0.0.1:$PORT/api/v1/repos/$REPO/issues/1/comments")"
body5="$(printf '%s' "$kommentare5" | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1])')"
case "$body5" in
*"erwartet war anders"*) ok "die echte Fehlermeldung ist im Bericht, trotz 500000 Zeilen Rauschen danach" ;;
*) bad "die echte Fehlermeldung ist im Bericht" "AssertionError im Bericht" "$body5" ;;
esac

echo
echo "== zu wenige Argumente bricht laut ab =="
fails "ohne Log-Datei" env FORGEJO_USERNAME=vp FORGEJO_PASSWORD=vp "$HERE/report-failure.sh" "Test (Go, Skripte)"

echo
echo "$PASS ok, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
