#!/usr/bin/env bash
# Groessen-Waechter der drei AGENTS.md.
#
# Warum: Claude Code laedt `CLAUDE.md` -> `AGENTS.md` bei JEDEM Sitzungsstart in den
# Kontext. Am 05.09.2026 waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB
# angewachsen und haben Worker binnen Minuten an der Kontextgrenze sterben lassen.
# Seither ist jede der drei ein WEGWEISER; das Detail wohnt in `docs/agents/`.
#
# Die Budgets liegen bewusst UEBER dem Zielwert des Umbaus (39 / 29 / 24 KB), damit
# eine ehrliche Zeile Platz hat. **Sie werden nur KLEINER, nie groesser** - wer sie
# anhebt, hat den Waechter abgeschafft, nicht bestanden.
#
#   bash tools/agents-md-budget.sh          # prueft
#   bash tools/agents-md-budget.sh --list   # zeigt nur die Groessen
set -euo pipefail

cd "$(dirname "$0")/.."

# datei:budget_in_bytes
BUDGETS=(
  "AGENTS.md:60000"
  "frontend/portal/AGENTS.md:45000"
  "edge-app/AGENTS.md:45000"
)

fail=0
printf '%-28s %10s %10s   %s\n' "Datei" "Bytes" "Budget" "Stand"
for entry in "${BUDGETS[@]}"; do
  file="${entry%%:*}"
  budget="${entry##*:}"
  if [ ! -f "$file" ]; then
    printf '%-28s %10s %10s   %s\n' "$file" "-" "$budget" "FEHLT"
    fail=1
    continue
  fi
  bytes=$(wc -c < "$file" | tr -d ' ')
  if [ "$bytes" -le "$budget" ]; then
    pct=$(( bytes * 100 / budget ))
    printf '%-28s %10s %10s   ok (%s%% des Budgets)\n' "$file" "$bytes" "$budget" "$pct"
  else
    over=$(( bytes - budget ))
    printf '%-28s %10s %10s   ZU GROSS um %s B\n' "$file" "$bytes" "$budget" "$over"
    fail=1
  fi
done

if [ "${1:-}" = "--list" ]; then
  exit 0
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

Ein Wegweiser ist ueber sein Budget gelaufen.
Das Budget wird NICHT angehoben - der neue Abschnitt zieht um:

  1. Text nach `docs/agents/<bereich>/<slug>.md` (H1 = Ueberschrift, Text unveraendert)
  2. EINE Zeile in den Themen-Index der AGENTS.md:
     - **Thema** — ein Satz Kern · `<slug>.md`
  3. `bash tools/agents-md-budget.sh` erneut

In den Wegweiser gehoert nur, was FAST JEDE Sitzung braucht.
Regeln: der Abschnitt "Maintaining this file" der jeweiligen Datei.
MSG
  exit 1
fi
