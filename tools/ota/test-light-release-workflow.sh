#!/usr/bin/env bash
# Selbsttest des Edge-Light-Laufs (.forgejo/workflows/edge-light-release.yaml):
# Trigger und Bedingungen, die Anhaenge sind genau die von
# edge-light/scripts/release.sh, Signieren und Register nur mit der Freigabe
# EDGE_LIGHT_SIGNIEREN=true UND den Geheimnissen (der ECHTE run:-Text des
# Eingabe-Schritts wird ohne beides gefahren), und der ECHTE run:-Text des
# Namensschritts bestimmt den naechsten freien Namen nur aus Edge-Light-Tags.
# Ohne Forgejo, ohne Go-Bau. Sekunden.
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
WF="$REPO/.forgejo/workflows/edge-light-release.yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OK=0
FEHL=0
ok() { OK=$((OK + 1)); echo "  ok   $*"; }
bad() { FEHL=$((FEHL + 1)); echo "  FEHLER $*"; }

echo "== Aufbau des Laufs =="
python3 - "$WF" "$REPO/edge-light/scripts/release.sh" >"$TMP/struktur" 2>&1 <<'PY' && ok "Trigger, Jobs und Anhaenge wie verlangt" || { bad "Aufbau"; cat "$TMP/struktur"; }
import re, sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
text = open(sys.argv[1]).read()
rel = open(sys.argv[2]).read()
on = wf.get(True) or wf.get("on")
assert on["push"]["tags"] == ["edge-light-*"], on["push"]
assert "workflow_dispatch" in on
jobs = wf["jobs"]
assert jobs["tag"]["if"] == "github.event_name == 'workflow_dispatch'", jobs["tag"]["if"]
co = jobs["tag"]["steps"][0]["with"]
assert co.get("persist-credentials") is False and co.get("fetch-depth") == 0, co
for j in ("test", "release"):
    assert "startsWith(github.ref_name, 'edge-light-')" in jobs[j]["if"] and "github.ref_type == 'tag'" in jobs[j]["if"], (j, jobs[j]["if"])
assert jobs["release"]["needs"] == "test"
runs = "\n".join(s.get("run", "") for j in jobs.values() for s in j["steps"])
assert "ota_check_light_release" in runs and "ota_next_light_release" in runs and "ota_tag_release" in runs
assert "bash edge-light/scripts/test.sh" in runs and "bash edge-light/scripts/release.sh" in runs
# Signieren und Register: derselbe Weg wie die Docker-Box, nur hinter der
# Freigabe. Jeder Schritt, der etwas Geheimes anfasst oder hinausschickt,
# haengt an steps.inputs.outputs.ready.
steps = {s.get("name"): s for s in jobs["release"]["steps"]}
inp = steps["Release-Eingaben bestimmen"]
assert inp["env"]["EDGE_LIGHT_SIGNIEREN"] == "${{ vars.EDGE_LIGHT_SIGNIEREN }}", inp["env"]
assert '[ "${EDGE_LIGHT_SIGNIEREN:-}" = "true" ]' in inp["run"]
for name in ("Manifest erzeugen", "Signieren + gegen die eingebackene Wurzel pruefen", "Manifest anhaengen + ins Register eintragen"):
    assert steps[name]["if"] == "steps.inputs.outputs.ready == 'true'", (name, steps[name].get("if"))
man = steps["Manifest erzeugen"]["run"]
for arch in ("mipsle", "arm64"):
    assert f'--binary "vp-edge-light:linux/{arch}=${{RUNNER_TEMP}}/fassung/vp-edge-light-linux-{arch}"' in man, arch
assert "--artifact" not in man
assert "ota_sign " in steps["Signieren + gegen die eingebackene Wurzel pruefen"]["run"]
assert "ota_publish " in steps["Manifest anhaengen + ins Register eintragen"]["run"]
assert steps["Schluessel + Token vom Runner entfernen"]["if"] == "always()"
# Der Lauf weist nie etwas zu und startet keinen Rollout.
code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
for verboten in ("update-target", "/rollouts", "edge-updates/"):
    assert verboten not in code, verboten
# Die Anhaenge sind genau die Dateien von release.sh
m = re.search(r"for f in ([^;]+); do", runs)
anh = m.group(1).split()
for f in anh:
    assert f in rel, f
assert set(anh) == {"vp-edge-light-linux-mipsle", "vp-edge-light-linux-arm64", "vp-edge-light-linux-mipsle.gz", "vp-edge-light-linux-arm64.gz", "edge-light-openwrt.tar.gz", "sha256sums", "freigabe-edge-light.json"}, anh
print("ok")
PY

# edge-images.yaml startet weiter nie fuer edge-light-*
grep -q "'!edge-light-\*'" "$REPO/.forgejo/workflows/edge-images.yaml" && ok "edge-images.yaml schliesst edge-light-* weiter aus" || bad "edge-images.yaml ohne Ausschluss"

echo "== Der echte Namensschritt =="
python3 - "$WF" >"$TMP/name.sh" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
for s in wf["jobs"]["tag"]["steps"]:
    if s.get("id") == "name":
        print(s["run"])
PY
mkdir -p "$TMP/ws"
(
  cd "$TMP/ws"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git init -q .
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t git commit -q --allow-empty -m init
  ym="$(TZ=Europe/Berlin date +%Y.%m)"
  git tag "edge-$ym.9"
  git tag "edge-light-$ym.0"
  git tag "edge-light-$ym.1"
  mkdir -p tools/ota
  cp "$REPO/tools/ota/release-publish.sh" tools/ota/
) >/dev/null
ym="$(TZ=Europe/Berlin date +%Y.%m)"
out="$(cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe" RELEASE_INPUT='' bash "$TMP/name.sh" 2>&1)" || true
grep -qx "release=edge-light-$ym.2" "$TMP/ausgabe" 2>/dev/null && ok "naechster freier Name aus Edge-Light-Tags: edge-light-$ym.2 (Docker-Tags zaehlen nicht)" || bad "Name: $out"
if (cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe2" RELEASE_INPUT="edge-$ym.10" bash "$TMP/name.sh") >/dev/null 2>&1; then
  bad "ein Docker-Name ging durch den Edge-Light-Weg"
else
  ok "ein Docker-Name bricht im Edge-Light-Weg ab"
fi
if (cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe3" RELEASE_INPUT=" edge-light-$ym.5 " bash "$TMP/name.sh") >/dev/null 2>&1 && grep -qx "release=edge-light-$ym.5" "$TMP/ausgabe3"; then
  ok "eine vorgegebene Fassung (mit Leerzeichen) geht durch"
else
  bad "vorgegebene Fassung"
fi

echo "== Der echte Eingabe-Schritt: ohne Freigabe kein Schluessel =="
python3 - "$WF" >"$TMP/inputs.sh" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
for s in wf["jobs"]["release"]["steps"]:
    if s.get("id") == "inputs":
        print(s["run"])
PY
mkdir -p "$TMP/ws/edge-app/core" "$TMP/runner"
printf '3\n' >"$TMP/ws/edge-app/core/otastate.schema"
(cd "$TMP/ws" && git tag -a -m "min-from-seq=7" "edge-light-$ym.7" 2>/dev/null) || true
eingabe() { # <ausgabe> <env...>
  local aus="$1"
  shift
  (cd "$TMP/ws" && env -i PATH="$PATH" HOME="$TMP" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GITHUB_OUTPUT="$aus" GITHUB_REF_NAME="edge-light-$ym.7" RUNNER_TEMP="$TMP/runner" "$@" bash "$TMP/inputs.sh") >/dev/null 2>&1
}
geheim=(VP_OTA_RELEASE_KEY='{"key_id":"rel-test"}' VP_OTA_PUBLISHER_CLIENT_SECRET=geheim VP_OTA_PORTAL=http://127.0.0.1:9)
if eingabe "$TMP/e1" "${geheim[@]}" && grep -qx "ready=false" "$TMP/e1" && [ ! -e "$TMP/runner/vp-ota-release.key" ]; then
  ok "Geheimnisse ohne EDGE_LIGHT_SIGNIEREN: ready=false, kein Schluessel auf dem Runner"
else
  bad "Geheimnisse ohne Freigabe"
fi
if eingabe "$TMP/e2" EDGE_LIGHT_SIGNIEREN=true && grep -qx "ready=false" "$TMP/e2" && grep -qx "min_from=7" "$TMP/e2" && grep -qx "state_schema=3" "$TMP/e2"; then
  ok "Freigabe ohne Geheimnisse: ready=false, Eingaben trotzdem gelesen (min-from-seq aus der Annotation)"
else
  bad "Freigabe ohne Geheimnisse: $(cat "$TMP/e2" 2>/dev/null)"
fi
if eingabe "$TMP/e3" EDGE_LIGHT_SIGNIEREN=true "${geheim[@]}"; then
  bad "mit Freigabe und Geheimnissen lief der Schritt ohne Portal durch"
else
  [ -e "$TMP/runner/vp-ota-release.key" ] && ok "mit Freigabe und Geheimnissen geht es zum Register (hier: kein Portal -> Abbruch)" || bad "Schluesseldatei nicht angelegt"
fi

echo
echo "$OK bestanden, $FEHL fehlgeschlagen"
[ "$FEHL" = 0 ]
