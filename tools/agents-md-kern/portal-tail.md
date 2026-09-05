## Maintaining this file

**Größen-Budget (seit 05.09.2026, hart bewacht):** `AGENTS.md` ≤ 60 KB,
`frontend/portal/AGENTS.md` ≤ 45 KB, `edge-app/AGENTS.md` ≤ 45 KB. Wächter:
`bash tools/agents-md-budget.sh` (Matrix-Leg `agents-md` in `.forgejo/workflows/deploy.yaml`),
im Portal zusätzlich `npm run test:agents-md`. **Die Zahl wird nur KLEINER, nie größer** —
wer sie anhebt, hat den Wächter abgeschafft, nicht bestanden.

Der Grund: Claude Code lädt `CLAUDE.md` → diese Datei bei JEDEM Sitzungsstart. Am 05.09.2026
waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB angewachsen und haben Worker binnen
Minuten an der Kontextgrenze sterben lassen.

**Die Regel daraus: hier steht ein POINTER, das Detail wohnt in `docs/agents/`.** Ein neuer
Abschnitt wird `docs/agents/<bereich>/<slug>.md` und bekommt hier EINE Index-Zeile
(`**Thema** — ein Satz Kern · \`<slug>.md\``). In den Wegweiser gehört nur, was FAST JEDE
Sitzung braucht: Aufbau, Befehle, die harten Hausregeln. Was der Code schon zeigt, gehört
gar nicht hierher — dann reicht der Verweis auf Datei, Befehl oder Test.

Der Umbau ist wiederholbar: `python3 tools/agents-md-split.py` erzeugt aus dem Kern
(`tools/agents-md-kern/<bereich>.md`) plus dem Bestand denselben Zustand, `--verify` beweist
die Byte-Gleichheit jedes ausgelagerten Abschnitts.
