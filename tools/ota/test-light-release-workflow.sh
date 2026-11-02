#!/usr/bin/env bash
# Selbsttest des Edge-Light-Laufs (.forgejo/workflows/edge-light-release.yaml):
# Trigger und Bedingungen, kein Manifest/Signatur/Register, die Anhaenge sind
# genau die von edge-light/scripts/release.sh, und der ECHTE run:-Text des
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
# Kein Signieren, kein Register, kein Release-Schluessel (Stufe 2)
code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
for verboten in ("vp-ota", "ota_sign", "ota_register", "ota_publish", "edge-releases", "VP_OTA_RELEASE_KEY", "VP_OTA_PORTAL", "VP_OTA_CLIENT"):
    assert verboten not in code, verboten
# Die Anhaenge sind genau die Dateien von release.sh
m = re.search(r"for f in ([^;]+); do", runs)
anh = m.group(1).split()
for f in anh:
    assert f in rel, f
assert set(anh) == {"vp-edge-light-linux-mipsle", "vp-edge-light-linux-arm64", "edge-light-openwrt.tar.gz", "sha256sums", "freigabe-edge-light.json"}, anh
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

echo
echo "$OK bestanden, $FEHL fehlgeschlagen"
[ "$FEHL" = 0 ]
