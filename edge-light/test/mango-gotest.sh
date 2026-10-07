#!/usr/bin/env bash
# Go-Tests des Cores AUF DEM MANGO ausfuehren - fuer Rechner, auf denen die
# Testprogramme nicht laufen (Windows-Anwendungssteuerung blockiert sie; kein
# Docker, kein WSL). Gebaut wird lokal fuer mipsle, ausgefuehrt im RAM des
# Mango, danach ist alles wieder geloescht.
#
#   edge-light/test/mango-gotest.sh <ssh-ziel> <paket> [go-test-argumente...]
#   edge-light/test/mango-gotest.sh root@10.10.1.25 ./internal/lastmgmt/
#   SSH_PORT=2222 edge-light/test/mango-gotest.sh root@10.10.1.25 ./internal/agent/ -test.run 'Ocpp|Phase'
#
# ⚠ NIE WAEHREND EINER LADESITZUNG. Die Tests belegen die einzige CPU des
# Mango. Am 05.10.2026 verlor die Box dabei rund 9 Minuten die Kontrolle ueber
# die go-e (OCPP-Zeitueberschreitungen, Schutzprofile neu einzurichten), und
# das Auto lud kurz ohne Grenze aus dem Netz. Das Skript bricht deshalb ab,
# solange an einer Saeule eine Sitzung laeuft (Auto abstecken; FORCE=1 nur
# ohne Fahrzeug und ohne Saeule, die etwas starten koennte).
#
# ⚠ Der Mango ist eine Produktivbox: /tmp ist RAM (~44 MB frei neben dem
# Dienst). Deshalb:
#   - der Testprozess ist das bevorzugte Opfer des OOM-Killers
#     (oom_score_adj=1000), mit kleinem Heap (GOMEMLIMIT, Vorgabe 10 MiB);
#   - ein Paket nach dem anderen, grosse Pakete (agent ~18 MB) per -test.run;
#   - TestJournalOverflow* (csms) schreibt ueber 30 MB nach /tmp und wird
#     ausgelassen, sofern kein eigenes -test.skip angegeben ist;
#   - Tests, die ../../../../docs/... lesen, scheitern dort (keine Repo-Dateien).
# Am Ende stehen freier RAM und /tmp, damit Reste auffallen.
# Die Befehle an remote werden bewusst erst auf dem Mango ausgewertet:
# shellcheck disable=SC2029
# shellcheck source=edge-light/scripts/lib.sh
source "$(dirname "$0")/../scripts/lib.sh"

TARGET="${1:?SSH-Ziel fehlt, z. B. root@10.10.1.25}"
PKG="${2:?Paket fehlt, z. B. ./internal/lastmgmt/}"
shift 2
ARGS=("$@")
case " ${ARGS[*]-} " in
  *" -test.skip"*) ;;
  *) ARGS+=(-test.skip 'TestJournalOverflow') ;;
esac

NAME="vp-gotest-$(basename "$PKG")"
# Unter dem Repo, damit es auch im golang-Container (go_run) erreichbar ist.
OUT="$LIGHT_DIR/dist/gotest"
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT

echo "--- baue $PKG fuer mipsle"
go_run GOOS=linux GOARCH=mipsle GOMIPS=softfloat -- \
  test -c -ldflags="-s -w" -o "$(core_rel "$OUT")/$NAME" "$PKG"
gzip -c "$OUT/$NAME" > "$OUT/$NAME.gz"

REMOTE_ARGS=""
for a in "${ARGS[@]}"; do REMOTE_ARGS+=" '${a//\'/\'\\\'\'}'"; done

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -p "${SSH_PORT:-22}" "$TARGET")
if [ "${FORCE:-0}" != 1 ] && "${SSH[@]}" 'wget -q -T 4 -O - http://127.0.0.1:8484/api/ocpp 2>/dev/null' | grep -q '"session_since_ms"'; then
  echo "ABBRUCH: an einer Ladesaeule laeuft eine Sitzung - die Tests wuerden der Box die CPU nehmen." >&2
  echo "Auto abstecken und erneut starten." >&2
  exit 1
fi

echo "--- fuehre auf $TARGET aus"
"${SSH[@]}" "
  set -e
  cat > /tmp/$NAME.gz
  gunzip -f /tmp/$NAME.gz && chmod +x /tmp/$NAME
  cd /tmp
  echo 1000 > /proc/self/oom_score_adj
  GOMEMLIMIT=${MEMLIMIT:-10MiB} GOGC=50 ./$NAME $REMOTE_ARGS > /tmp/$NAME.log 2>&1 || true
  grep -E '^(--- FAIL|FAIL|PASS|ok|panic)|_test.go:[0-9]+:|fatal error' /tmp/$NAME.log | head -80
  rm -f /tmp/$NAME /tmp/$NAME.log /tmp/$NAME.gz
  echo '--- danach:'; free -m | sed -n 2p; df -m /tmp | tail -1; ls -d /tmp/Test* 2>/dev/null || true
" < "$OUT/$NAME.gz"
