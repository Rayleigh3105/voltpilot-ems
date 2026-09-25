#!/usr/bin/env bash
#
# pruefe.sh - beweist den gitops-Vorschlag VoltPilotSicherungZuAlt im
# Anwendungsrepo, bevor er als Zweig nach gitops geht (AP-20 IP-19, NR8).
#
# Dieselben zwei Schritte wie gitops hack/alert-tests/run.sh:
#   1. promtool check rules  - gueltiges PromQL?
#   2. promtool test rules   - feuert die Regel bei den richtigen Zeitreihen
#                              und schweigt bei den falschen?
# `.spec` wird aus DERSELBEN PrometheusRule-Datei geschnitten, die nach
# gitops geht - ein Test gegen eine Kopie waere keiner.
#
# Werkzeuge: promtool (`brew install prometheus`), python3 mit PyYAML.
# Fehlt eines, ist der Vorschlag NICHT bewiesen (Exit 2), nicht gruen.
#
# Usage: docs/bewertung/vorschlaege/gitops/pruefe.sh

set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGEL="$HIER/infra/monitoring/datenebene/prometheusrule-sicherung.yaml"
TEST="$HIER/hack/alert-tests/sicherung_test.yaml"

command -v promtool >/dev/null 2>&1 || { echo "fehlt: promtool (brew install prometheus) - Vorschlag nicht bewiesen" >&2; exit 2; }
python3 -c 'import yaml' 2>/dev/null || { echo "fehlt: python3 mit PyYAML - Vorschlag nicht bewiesen" >&2; exit 2; }

ARBEIT="$(mktemp -d)"
trap 'rm -rf "$ARBEIT"' EXIT

python3 - "$REGEL" "$ARBEIT/sicherung_rules.yaml" <<'PY'
import sys, yaml
src, dst = sys.argv[1], sys.argv[2]
with open(src) as fh:
    doc = yaml.safe_load(fh)
if doc.get("kind") != "PrometheusRule":
    sys.exit(f"{src}: kind ist {doc.get('kind')!r}, erwartet PrometheusRule")
with open(dst, "w") as fh:
    yaml.safe_dump({"groups": doc["spec"]["groups"]}, fh,
                   allow_unicode=True, sort_keys=False, width=10_000)
PY
cp "$TEST" "$ARBEIT/"

echo "=== $(basename "$REGEL") ==="
echo "1) promtool check rules"
promtool check rules "$ARBEIT/sicherung_rules.yaml"
echo
echo "2) promtool test rules    ($(basename "$TEST"))"
( cd "$ARBEIT" && promtool test rules "$(basename "$TEST")" )
echo
echo "Vorschlag VoltPilotSicherungZuAlt bewiesen ($(promtool --version 2>&1 | head -1))"
