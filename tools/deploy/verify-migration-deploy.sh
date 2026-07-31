#!/usr/bin/env bash
# =============================================================================
# verify-migration-deploy.sh - deploy-readiness check for the v1->v2 migration
# (MIG). Asserts, WITHOUT deploying anything or touching live infra:
#   1. docker-compose.prod.yml parses (resolved config), and carries the new
#      services (flowc-serve sidecar, simulation) + the optimization service.
#   2. The migration switch VOLTPILOT_V2_PLAN_SITES is a passthrough on the
#      optimization service in BOTH composes, defaulting to empty.
#   3. Every .forgejo/workflows/*.yaml still parses (the deploy pipeline).
#      Needs PyYAML; without it the script FAILS rather than silently skipping
#      (ALLOW_MISSING_PYYAML=1 downgrades that to a WARN the summary reports).
#   4. The project Keycloak image stays in lockstep: its BAKED build options
#      match the compose runtime (a mismatch makes the cluster's
#      `start --optimized` refuse to boot), its version pin matches the compose
#      image default, and both deploy workflows build it (deploy/keycloak/).
# Uses throwaway placeholder secrets - reads no real .env, connects to nothing.
#
# Run from the repo root:  bash tools/deploy/verify-migration-deploy.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."
fail=0
skipped=0
note() { printf '  %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

# Placeholder env so the prod compose's ${VAR:?} required secrets resolve.
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<'EOF'
ADMIN_DB_PASSWORD=x
APP_DB_PASSWORD=x
DOMAIN=example.com
EMQX_DASHBOARD_PASSWORD=x
EMQX_NODE_COOKIE=x
KEYCLOAK_ADMIN_PASSWORD=x
KEYCLOAK_DB_PASSWORD=x
POSTGRES_PASSWORD=x
VP_API_CLIENT_SECRET=x
VP_PORTAL_ADMIN_PASSWORD=x
VOLTPILOT_V2_PLAN_SITES=
EOF

echo "== 1. prod compose parses + carries the new services =="
if docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" config -q 2>/dev/null; then
  pass "docker-compose.prod.yml config resolves"
  services="$(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" config --services 2>/dev/null)"
  for svc in flowc simulation optimization api; do
    if grep -qx "$svc" <<<"$services"; then pass "service present: $svc"; else bad "service missing: $svc"; fi
  done
else
  bad "docker-compose.prod.yml did not resolve"
fi

echo "== 2. VOLTPILOT_V2_PLAN_SITES passthrough (defaults empty) =="
for compose in docker-compose.yml docker-compose.prod.yml; do
  # shellcheck disable=SC2016  # intentional: grep for the literal ${...:-} string
  if grep -q 'VOLTPILOT_V2_PLAN_SITES: ${VOLTPILOT_V2_PLAN_SITES:-}' "$compose"; then
    pass "$compose: optimizer has the migration switch (default empty)"
  else
    bad "$compose: VOLTPILOT_V2_PLAN_SITES passthrough missing"
  fi
done
if grep -q 'VOLTPILOT_V2_PLAN_SITES' .env.prod.example; then
  pass ".env.prod.example documents VOLTPILOT_V2_PLAN_SITES"
else
  bad ".env.prod.example missing the VOLTPILOT_V2_PLAN_SITES delta"
fi

echo "== 2b. Portal v3 M5 go-live: flow activation resolves ON in prod =="
# The v3 release turns customer flow activation ON in production. Assert the
# resolved prod compose really carries it (a typo here would silently ship an
# api that refuses every activation with `activation_disabled`), that the
# rollback lever is documented, and that the flow-status listener is wired.
if resolved="$(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" config 2>/dev/null)"; then
  if grep -qE 'VOLTPILOT_FLOWS_ACTIVATION_ENABLED: *"?true"?' <<<"$resolved"; then
    pass "prod compose resolves VOLTPILOT_FLOWS_ACTIVATION_ENABLED=true"
  else
    bad "prod compose does NOT resolve flow activation to true"
  fi
  if grep -qE 'VOLTPILOT_FLOWS_MQTT_LISTENER_ENABLED: *"?true"?' <<<"$resolved"; then
    pass "prod compose wires the flow-status listener"
  else
    bad "prod compose is missing VOLTPILOT_FLOWS_MQTT_LISTENER_ENABLED"
  fi
else
  bad "docker-compose.prod.yml did not resolve (flow-activation check)"
fi
if grep -q 'VOLTPILOT_FLOWS_ACTIVATION_ENABLED' .env.prod.example \
   && grep -q 'flows/{flowId}/deactivate' .env.prod.example; then
  pass ".env.prod.example documents the flag AND the per-flow stop lever"
else
  bad ".env.prod.example must document the activation flag + the deactivate lever"
fi

echo "== 3. deploy workflow YAML parses =="
PYYAML=""
for py in services/optimization/.venv/bin/python services/forecast/.venv/bin/python python3; do
  # command -v, not [ -x ]: the bare `python3` fallback is a PATH lookup, and
  # `[ -x python3 ]` only ever tested a ./python3 in the cwd - so on a machine
  # without one of the service venvs this loop could never succeed.
  if command -v "$py" >/dev/null 2>&1 && "$py" -c "import yaml" 2>/dev/null; then PYYAML="$py"; break; fi
done
if [ -z "$PYYAML" ]; then
  # A silently skipped check that still printed "ALL DEPLOY CHECKS PASSED" made
  # the gate lie on any VM without PyYAML (pre-deploy migration report). Fail
  # loud by default; ALLOW_MISSING_PYYAML=1 downgrades it to a WARN that the
  # final summary still reports - never a clean pass.
  if [ "${ALLOW_MISSING_PYYAML:-0}" = "1" ]; then
    printf 'WARN  workflow YAML parse SKIPPED (no PyYAML on this machine)\n'
    note "install it (pip install pyyaml) and re-run to actually check .forgejo/workflows/*.yaml"
    skipped=1
  else
    bad "workflow YAML parse CANNOT RUN: no PyYAML (pip install pyyaml, or re-run with ALLOW_MISSING_PYYAML=1)"
  fi
else
  if "$PYYAML" - <<'PY'
import glob, sys, yaml
bad = False
for f in sorted(glob.glob(".forgejo/workflows/*.yaml")):
    try:
        yaml.safe_load(open(f)); print(f"  ok  {f}")
    except Exception as e:
        print(f"  FAIL {f}: {e}"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "all .forgejo/workflows/*.yaml parse"; else bad "a workflow YAML did not parse"; fi
fi

echo "== 4. Keycloak image: build-option + version lockstep, and CI builds it =="
# The k8s Deployment runs `start --optimized`, which REFUSES to boot when a
# Keycloak BUILD option differs from what the image baked. Three drifts would
# each surface only at cluster boot (or worse, as two Keycloak versions against
# one database), so they are checked here instead:
#   a) every ENV in deploy/keycloak/Dockerfile's builder stage matches the
#      runtime value the compose keycloak service supplies,
#   b) ARG KEYCLOAK_VERSION == the version the compose image default pins,
#   c) both deploy workflows carry the `keycloak` build-matrix entry.
# The GitOps repo's keycloak.env is the cluster's runtime half; it lives in
# another repository and is therefore verified there, not here.
if [ -z "$PYYAML" ]; then
  note "keycloak lockstep check needs PyYAML too - covered by the section above"
else
  if "$PYYAML" - <<'PY'
import re, sys, yaml

dockerfile = open("deploy/keycloak/Dockerfile").read()
compose = yaml.safe_load(open("docker-compose.prod.yml"))["services"]["keycloak"]
ok = True

# (a) baked build options == compose runtime values
env_block = re.search(r"^ENV (.*?)(?=\n(?:[A-Z]|#|$))", dockerfile, re.S | re.M)
if not env_block:
    print("  FAIL deploy/keycloak/Dockerfile has no ENV build-option block"); sys.exit(1)
baked = dict(p.split("=", 1) for p in env_block.group(1).replace("\\\n", " ").split())
if not baked:
    print("  FAIL no build options parsed from the Dockerfile ENV"); sys.exit(1)
runtime = {str(k): str(v) for k, v in (compose.get("environment") or {}).items()}
for key, value in sorted(baked.items()):
    if key not in runtime:
        print(f"  ok   {key}={value} baked (compose leaves it to the image)")
    elif runtime[key] == value:
        print(f"  ok   {key}={value} baked == compose runtime")
    else:
        print(f"  FAIL {key}: image bakes {value!r} but compose runs {runtime[key]!r}"); ok = False

# (b) version pin lockstep
arg = re.search(r"^ARG KEYCLOAK_VERSION=(\S+)", dockerfile, re.M)
img = re.search(r"quay\.io/keycloak/keycloak:([^}\s]+)", str(compose.get("image", "")))
if not arg or not img:
    print("  FAIL could not read the Keycloak version from Dockerfile and/or compose"); ok = False
elif arg.group(1) != img.group(1):
    print(f"  FAIL version drift: Dockerfile {arg.group(1)} vs compose {img.group(1)}"); ok = False
else:
    print(f"  ok   version {arg.group(1)} pinned identically in Dockerfile and compose")

# (c) CI builds the image in both pipelines
for wf in (".forgejo/workflows/deploy.yaml", ".forgejo/workflows/deploy-fast.yaml"):
    entries = yaml.safe_load(open(wf))["jobs"]["build"]["strategy"]["matrix"]["include"]
    entry = next((e for e in entries if e.get("component") == "keycloak"), None)
    if entry is None:
        print(f"  FAIL {wf}: no `keycloak` build-matrix entry"); ok = False
    elif entry.get("dockerfile") != "./deploy/keycloak/Dockerfile" or entry.get("context") != ".":
        print(f"  FAIL {wf}: keycloak entry must build ./deploy/keycloak/Dockerfile from the repo root"); ok = False
    else:
        print(f"  ok   {wf}: builds keycloak from the repo-root context")
sys.exit(0 if ok else 1)
PY
  then pass "keycloak image: build options, version pin and CI matrix are in lockstep"
  else bad "keycloak image lockstep broken (see above) - fix before the k8s cutover"; fi
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "DEPLOY CHECKS FAILED"
  exit 1
elif [ "$skipped" -ne 0 ]; then
  echo "DEPLOY CHECKS PASSED WITH SKIPS - the workflow YAML parse did NOT run (no PyYAML)"
else
  echo "ALL DEPLOY CHECKS PASSED"
fi
