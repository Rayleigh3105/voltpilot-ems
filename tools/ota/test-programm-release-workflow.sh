#!/usr/bin/env bash
# Selbsttest der Laeufe der Programm-Linien: Edge Light
# (.forgejo/workflows/edge-light-release.yaml, Mango und Raspberry Pi) und Edge
# Industrie (.forgejo/workflows/edge-industrie-release.yaml, WAGO PFC200).
# Trigger und Bedingungen, die Anhaenge sind genau die des release.sh der
# Linie, Signieren und Register nur mit der Freigabe der Linie
# (EDGE_LIGHT_SIGNIEREN bzw. EDGE_INDUSTRIE_SIGNIEREN =true) UND den
# Geheimnissen (der ECHTE run:-Text des Eingabe-Schritts wird ohne beides
# gefahren), und der ECHTE run:-Text des Namensschritts bestimmt den naechsten
# freien Namen nur aus den Tags der Linie. Ohne Forgejo, ohne Go-Bau. Sekunden.
#
#   tools/ota/test-programm-release-workflow.sh light
#   tools/ota/test-programm-release-workflow.sh industrie
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HIER/../.." && pwd -P)"
LINIE="${1:-}"
case "$LINIE" in
  light)
    WF="$REPO/.forgejo/workflows/edge-light-release.yaml"
    REL="$REPO/edge-light/scripts/release.sh"
    PRAEFIX=edge-light-
    FREIGABE=EDGE_LIGHT_SIGNIEREN
    ;;
  industrie)
    WF="$REPO/.forgejo/workflows/edge-industrie-release.yaml"
    REL="$REPO/edge-industrie/scripts/release.sh"
    PRAEFIX=edge-industrie-
    FREIGABE=EDGE_INDUSTRIE_SIGNIEREN
    ;;
  *)
    echo "FEHLER: Linie light oder industrie angeben" >&2
    exit 2
    ;;
esac
export LINIE
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OK=0
FEHL=0
ok() { OK=$((OK + 1)); echo "  ok   $*"; }
bad() { FEHL=$((FEHL + 1)); echo "  FEHLER $*"; }

echo "== Aufbau des Laufs =="
python3 - "$WF" "$REL" >"$TMP/struktur" 2>&1 <<'PY' && ok "Trigger, Jobs und Anhaenge wie verlangt" || { bad "Aufbau"; cat "$TMP/struktur"; }
import os, re, sys, yaml
LIGHT = os.environ["LINIE"] == "light"
L = "light" if LIGHT else "industrie"
PRAEFIX = "edge-light-" if LIGHT else "edge-industrie-"
PROG = "vp-edge-light" if LIGHT else "vp-edge-industrie"
ARCHS = ("mipsle", "arm64") if LIGHT else ("arm",)
FREIGABE = "EDGE_LIGHT_SIGNIEREN" if LIGHT else "EDGE_INDUSTRIE_SIGNIEREN"
wf = yaml.safe_load(open(sys.argv[1]))
text = open(sys.argv[1]).read()
rel = open(sys.argv[2]).read()
on = wf.get(True) or wf.get("on")
assert on["push"]["tags"] == [PRAEFIX + "*"], on["push"]
assert "workflow_dispatch" in on
jobs = wf["jobs"]
assert jobs["tag"]["if"] == "github.event_name == 'workflow_dispatch'", jobs["tag"]["if"]
co = jobs["tag"]["steps"][0]["with"]
assert co.get("persist-credentials") is False and co.get("fetch-depth") == 0, co
for j in ("test", "release"):
    assert f"startsWith(github.ref_name, '{PRAEFIX}')" in jobs[j]["if"] and "github.ref_type == 'tag'" in jobs[j]["if"], (j, jobs[j]["if"])
assert jobs["release"]["needs"] == "test"
runs = "\n".join(s.get("run", "") for j in jobs.values() for s in j["steps"])
assert f"ota_check_{L}_release" in runs and f"ota_next_{L}_release" in runs and "ota_tag_release" in runs
assert "bash edge-light/scripts/test.sh" in runs
assert ("bash edge-light/scripts/release.sh" if LIGHT else "bash edge-industrie/scripts/release.sh") in runs
# Signieren und Register: derselbe Weg wie die Docker-Box, nur hinter der
# Freigabe. Jeder Schritt, der etwas Geheimes anfasst oder hinausschickt,
# haengt an steps.inputs.outputs.ready.
steps = {s.get("name"): s for s in jobs["release"]["steps"]}
inp = steps["Release-Eingaben bestimmen"]
assert inp["env"][FREIGABE] == "${{ vars.%s }}" % FREIGABE, inp["env"]
assert '[ "${%s:-}" = "true" ]' % FREIGABE in inp["run"]
ohne_kommentar = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
assert ("EDGE_INDUSTRIE_SIGNIEREN" if LIGHT else "EDGE_LIGHT_SIGNIEREN") not in ohne_kommentar, "die Freigabe der anderen Linie"
for name in ("Manifest erzeugen", "Signieren + gegen die eingebackene Wurzel pruefen", "Manifest anhaengen + ins Register eintragen", "Programme ins Portal laden"):
    assert steps[name]["if"] == "steps.inputs.outputs.ready == 'true'", (name, steps[name].get("if"))
man = steps["Manifest erzeugen"]["run"]
for arch in ARCHS:
    assert f'--binary "{PROG}:linux/{arch}=${{RUNNER_TEMP}}/fassung/{PROG}-linux-{arch}"' in man, arch
assert man.count("--binary") == len(ARCHS), man
assert "--artifact" not in man
# Was die Werkstatt beim Einrichten auflegt, reist signiert im Manifest, als
# eigene Felder und nie als Bestandteil des Updates: jede Linie ihren
# Skriptstand, Edge Industrie dazu das Tunnel-Programm vp-wartung.
SKRIPTE = "edge-light-openwrt.tar.gz" if LIGHT else "edge-industrie-skripte.tar.gz"
ANDERE_SKRIPTE = "edge-industrie-skripte.tar.gz" if LIGHT else "edge-light-openwrt.tar.gz"
WARTUNG = "vp-wartung-linux-arm"
assert f'--skripte "${{RUNNER_TEMP}}/fassung/{SKRIPTE}"' in man, man
assert man.count("--skripte") == 1 and ANDERE_SKRIPTE not in text, man
assert (f'--wartung "${{RUNNER_TEMP}}/fassung/{WARTUNG}"' in man) == (not LIGHT), man
assert man.count("--wartung") == (0 if LIGHT else 1), man
assert "ota_sign " in steps["Signieren + gegen die eingebackene Wurzel pruefen"]["run"]
assert "ota_publish " in steps["Manifest anhaengen + ins Register eintragen"]["run"]
# K2: die Programme ins Portal NACH dem Register (das Portal prueft gegen das Manifest dort)
names = [s.get("name") for s in jobs["release"]["steps"]]
assert names.index("Programme ins Portal laden") > names.index("Manifest anhaengen + ins Register eintragen")
up = steps["Programme ins Portal laden"]["run"]
if LIGHT:
    assert "ota_light_upload" in up and "for arch in mipsle arm64;" in up and 'vp-edge-light-linux-$arch.gz' in up, up
else:
    assert "ota_light_upload" in up and '"linux/arm"' in up and "vp-edge-industrie-linux-arm.gz" in up, up
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
erwartet = {f"{PROG}-linux-{a}" for a in ARCHS} | {f"{PROG}-linux-{a}.gz" for a in ARCHS} | {"sha256sums", SKRIPTE}
if not LIGHT:
    erwartet.add(WARTUNG)
assert set(anh) == erwartet and len(anh) == len(erwartet), anh
# Das Tunnel-Programm geht nie ins Portal und nie unter die Bestandteile des
# Updates: ein unbekannter Bestandteil liesse Boxen das ganze Release zurueckstellen.
assert WARTUNG not in up and SKRIPTE not in up, up
# Kein Freigabe-Block mehr zum Abschreiben: die Werkstatt liest das signierte Manifest.
assert "freigabe-edge-light" not in text and "freigabe-edge-light" not in rel
print("ok")
PY

# edge-images.yaml startet nie fuer eine Programm-Linie
grep -q "'!$PRAEFIX\*'" "$REPO/.forgejo/workflows/edge-images.yaml" && ok "edge-images.yaml schliesst $PRAEFIX* aus" || bad "edge-images.yaml ohne Ausschluss von $PRAEFIX*"

echo "== Der echte Namensschritt =="
python3 - "$WF" >"$TMP/name.sh" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
for s in wf["jobs"]["tag"]["steps"]:
    if s.get("id") == "name":
        print(s["run"])
PY
if [ "$LINIE" = light ]; then ANDERE=edge-industrie-; else ANDERE=edge-light-; fi
mkdir -p "$TMP/ws"
(
  cd "$TMP/ws"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git init -q .
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t git commit -q --allow-empty -m init
  ym="$(TZ=Europe/Berlin date +%Y.%m)"
  git tag "edge-$ym.9"
  git tag "${PRAEFIX}$ym.0"
  git tag "${PRAEFIX}$ym.1"
  # Die jeweils andere Programm-Linie zaehlt nicht mit.
  git tag "${ANDERE}$ym.8"
  mkdir -p tools/ota
  cp "$REPO/tools/ota/release-publish.sh" tools/ota/
) >/dev/null
ym="$(TZ=Europe/Berlin date +%Y.%m)"
out="$(cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe" RELEASE_INPUT='' bash "$TMP/name.sh" 2>&1)" || true
grep -qx "release=${PRAEFIX}$ym.2" "$TMP/ausgabe" 2>/dev/null && ok "naechster freier Name aus den Tags der Linie: ${PRAEFIX}$ym.2 (Docker und $ANDERE zaehlen nicht)" || bad "Name: $out"
if (cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe2" RELEASE_INPUT="edge-$ym.10" bash "$TMP/name.sh") >/dev/null 2>&1; then
  bad "ein Docker-Name ging durch den Weg der Linie $LINIE"
else
  ok "ein Docker-Name bricht im Weg der Linie $LINIE ab"
fi
if (cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe4" RELEASE_INPUT="${ANDERE}$ym.10" bash "$TMP/name.sh") >/dev/null 2>&1; then
  bad "ein Name der anderen Linie ging durch den Weg der Linie $LINIE"
else
  ok "ein Name der anderen Linie (${ANDERE}) bricht ab"
fi
if (cd "$TMP/ws" && GITHUB_OUTPUT="$TMP/ausgabe3" RELEASE_INPUT=" ${PRAEFIX}$ym.5 " bash "$TMP/name.sh") >/dev/null 2>&1 && grep -qx "release=${PRAEFIX}$ym.5" "$TMP/ausgabe3"; then
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
(cd "$TMP/ws" && git tag -a -m "min-from-seq=7" "${PRAEFIX}$ym.7" 2>/dev/null) || true
eingabe() { # <ausgabe> <env...>
  local aus="$1"
  shift
  (cd "$TMP/ws" && env -i PATH="$PATH" HOME="$TMP" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GITHUB_OUTPUT="$aus" GITHUB_REF_NAME="${PRAEFIX}$ym.7" RUNNER_TEMP="$TMP/runner" "$@" bash "$TMP/inputs.sh") >/dev/null 2>&1
}
geheim=(VP_OTA_RELEASE_KEY='{"key_id":"rel-test"}' VP_OTA_PUBLISHER_CLIENT_SECRET=geheim VP_OTA_PORTAL=http://127.0.0.1:9)
if eingabe "$TMP/e1" "${geheim[@]}" && grep -qx "ready=false" "$TMP/e1" && [ ! -e "$TMP/runner/vp-ota-release.key" ]; then
  ok "Geheimnisse ohne $FREIGABE: ready=false, kein Schluessel auf dem Runner"
else
  bad "Geheimnisse ohne Freigabe"
fi
if eingabe "$TMP/e2" "$FREIGABE=true" && grep -qx "ready=false" "$TMP/e2" && grep -qx "min_from=7" "$TMP/e2" && grep -qx "state_schema=3" "$TMP/e2"; then
  ok "Freigabe ohne Geheimnisse: ready=false, Eingaben trotzdem gelesen (min-from-seq aus der Annotation)"
else
  bad "Freigabe ohne Geheimnisse: $(cat "$TMP/e2" 2>/dev/null)"
fi
if [ "$LINIE" = industrie ] && eingabe "$TMP/e4" EDGE_LIGHT_SIGNIEREN=true "${geheim[@]}" && grep -qx "ready=false" "$TMP/e4"; then
  ok "die Freigabe von Edge Light schaltet Edge Industrie nicht frei"
elif [ "$LINIE" = industrie ]; then
  bad "EDGE_LIGHT_SIGNIEREN schaltet Edge Industrie frei"
fi
if eingabe "$TMP/e3" "$FREIGABE=true" "${geheim[@]}"; then
  bad "mit Freigabe und Geheimnissen lief der Schritt ohne Portal durch"
else
  [ -e "$TMP/runner/vp-ota-release.key" ] && ok "mit Freigabe und Geheimnissen geht es zum Register (hier: kein Portal -> Abbruch)" || bad "Schluesseldatei nicht angelegt"
fi

echo
echo "$OK bestanden, $FEHL fehlgeschlagen"
[ "$FEHL" = 0 ]
