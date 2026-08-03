#!/usr/bin/env bash
# =============================================================================
# mirror-rollout-journal.sh - der OPTIONALE, rein DOKUMENTARISCHE Spiegel des
# OTA-Audit-Journals ins gitops-Repo (Scout vp-ota-rollout-h4 §6, Entscheid D2,
# Stufe 4 „Politur").
# -----------------------------------------------------------------------------
# WAS DAS IST: ein Betreiber-Werkzeug, das `GET /api/v1/admin/rollout-journal.md`
# abholt und die Datei ins gitops-Repo committet - damit die eine Git-Zeitachse
# auch die Rollout-Historie enthält.
#
# WAS DAS AUSDRÜCKLICH NICHT IST - und das ist der ganze Grund für dieses
# Skript statt eines Jobs in der api:
#
#   * Es liegt NICHT im Wirkpfad. D2 ist eindeutig: die Autorität über den
#     Soll-Zustand ist die Portal-DB plus die retained MQTT-Nachricht. Fällt
#     dieser Spiegel aus, ändert das an keinem Rollout irgendetwas.
#   * Die api hält KEIN gitops-Schreib-Token. Ein Zugangsdaten-Satz, der ein
#     zweites Repo beschreiben darf, wäre eine neue Angriffsfläche - für etwas,
#     das laut Entscheid gar nicht im Wirkpfad liegen darf. Deshalb läuft der
#     Commit hier draußen, mit den Zugangsdaten des Betreibers.
#   * Es liest nichts zurück. Ein Spiegel, der etwas entscheiden könnte, wäre
#     eine zweite Wahrheit.
#
# Die Ausgabe des Endpunkts ist DETERMINISTISCH: derselbe Zustand ergibt
# dieselben Bytes, ein wiederholter Lauf also KEINEN Commit. Genau das macht
# einen Cron hier unbedenklich.
#
# BENUTZUNG
#   export VP_PORTAL_URL=https://portal.voltpilot.de
#   export VP_ADMIN_TOKEN="$(...)"        # ein platform-admin-Zugangstoken
#   export GITOPS_DIR=/pfad/zum/gitops    # ein KLON, in dem gepusht werden darf
#   tools/deploy/mirror-rollout-journal.sh
#
# Optional: VP_JOURNAL_LIMIT (Vorgabe 1000), MIRROR_PATH (Vorgabe
# docs/voltpilot/edge-rollout-journal.md), MIRROR_PUSH=0 (nur committen).
#
# Als Cron (Beispiel, täglich um 03:00):
#   0 3 * * * VP_PORTAL_URL=… VP_ADMIN_TOKEN=… GITOPS_DIR=… \
#             /srv/voltpilot-ems/tools/deploy/mirror-rollout-journal.sh >>/var/log/vp-mirror.log 2>&1
# =============================================================================
set -euo pipefail

die() { echo "FEHLER: $*" >&2; exit 1; }

: "${VP_PORTAL_URL:?VP_PORTAL_URL ist Pflicht (z. B. https://portal.voltpilot.de)}"
: "${VP_ADMIN_TOKEN:?VP_ADMIN_TOKEN ist Pflicht (ein platform-admin-Zugangstoken)}"
: "${GITOPS_DIR:?GITOPS_DIR ist Pflicht (ein gitops-Klon mit Push-Recht)}"
LIMIT="${VP_JOURNAL_LIMIT:-1000}"
MIRROR_PATH="${MIRROR_PATH:-docs/voltpilot/edge-rollout-journal.md}"
PUSH="${MIRROR_PUSH:-1}"

[ -d "$GITOPS_DIR/.git" ] || die "$GITOPS_DIR ist kein git-Klon."

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# --- 1. Holen ---------------------------------------------------------------
# --fail lässt curl bei 4xx/5xx scheitern, statt eine Fehlerseite zu committen.
status="$(curl -sS --fail-with-body -w '%{http_code}' -o "$tmp" \
  -H "Authorization: Bearer ${VP_ADMIN_TOKEN}" \
  "${VP_PORTAL_URL%/}/api/v1/admin/rollout-journal.md?limit=${LIMIT}" || true)"
[ "$status" = "200" ] || die "Abruf fehlgeschlagen (HTTP ${status:-?}): $(head -c 200 "$tmp")"

# Ein Journal ohne die Selbstauskunft ist nicht unser Dokument - lieber gar
# nichts committen als etwas Fremdes.
grep -q 'Die Autorität ist die Portal-DB' "$tmp" \
  || die "Die Antwort sieht nicht wie das Journal aus - es wird nichts committet."

# --- 2. Ablegen -------------------------------------------------------------
target="$GITOPS_DIR/$MIRROR_PATH"
mkdir -p "$(dirname "$target")"
if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
  echo "Unverändert - kein Commit. (Das ist der Normalfall.)"
  exit 0
fi
cp "$tmp" "$target"

# --- 3. Committen -----------------------------------------------------------
cd "$GITOPS_DIR"
git add -- "$MIRROR_PATH"
if git diff --cached --quiet; then
  echo "Unverändert - kein Commit."
  exit 0
fi
git -c user.name="${GIT_AUTHOR_NAME:-voltpilot-mirror}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-noreply@voltpilot.de}" \
    commit -q -m "docs(ota): Rollout-Journal gespiegelt

Rein dokumentarisch (Entscheid D2) - die Autorität bleibt die Portal-DB."
echo "Committet: $MIRROR_PATH"

if [ "$PUSH" = "1" ]; then
  # Ohne Rebase: diese Datei fasst niemand sonst an. Scheitert der Push (ein
  # paralleler Commit im Repo), ist das kein Drama - der nächste Lauf holt es
  # nach, weil die Datei dann immer noch abweicht.
  git push -q || echo "WARNUNG: Push fehlgeschlagen - der nächste Lauf holt es nach." >&2
fi
