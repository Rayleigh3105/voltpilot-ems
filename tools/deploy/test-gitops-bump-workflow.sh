#!/usr/bin/env bash
# =============================================================================
# test-gitops-bump-workflow.sh - runs the REAL `gitops-tag-bump` step script out
# of .forgejo/workflows/*.yaml against a local throwaway git repo. No network,
# no Docker, no Forgejo, no cluster: the "gitops repo" is a bare repo in a temp
# dir seeded with a verbatim copy of the real prod overlay, and the workflow's
# `GITOPS_REMOTE` env var points at it.
#
# What it proves:
#   1. deploy.yaml and deploy-fast.yaml carry the SAME step script (lockstep).
#   2. Without GITOPS_PUSH_TOKEN the step skips cleanly (exit 0, nothing cloned,
#      nothing pushed) - the pipeline stays green before the captain sets it.
#   3. With a token the bump lands as ONE commit that changes only newTag lines,
#      authored ci@voltpilot.de, message `ci(images): voltpilot-ems@<sha>`.
#   4. A second run at the same sha produces NO empty commit.
#   5. A lost push race (another run pushed a different sha meanwhile) is
#      recovered by the retry loop: it re-derives from the new main and lands
#      on top - the two bumps never collide.
#   6. A shape change in the overlay is refused and nothing is pushed.
#
#   bash tools/deploy/test-gitops-bump-workflow.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
REPO_ROOT="$PWD"
FIXTURE=tools/deploy/testdata/gitops-prod-kustomization.yaml
OVERLAY_PATH=apps/voltpilot/overlays/prod/kustomization.yaml
SHA_A=1111111111111111111111111111111111111111
SHA_B=2222222222222222222222222222222222222222
SHA_C=3333333333333333333333333333333333333333

fail=0
pass() { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

PY=python3
if ! $PY -c 'import yaml' >/dev/null 2>&1; then
  if [ "${ALLOW_MISSING_PYYAML:-0}" = "1" ]; then
    printf 'SKIP  PyYAML missing (ALLOW_MISSING_PYYAML=1) - workflow step not exercised\n'; exit 0
  fi
  printf 'FAIL  PyYAML is required to read the step script out of the workflows.\n'
  printf '      pip install pyyaml, or re-run with ALLOW_MISSING_PYYAML=1 to skip.\n'
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --------------------------------------------------------------------------
# 1. Extract the step script; both workflows must carry it byte-identically.
# --------------------------------------------------------------------------
if ! $PY - "$WORK" <<'PY'
import sys, pathlib, yaml, json
work = pathlib.Path(sys.argv[1])
runs, envs = {}, {}
for f in sorted(pathlib.Path(".forgejo/workflows").glob("*.yaml")):
    jobs = yaml.safe_load(f.read_text())["jobs"]
    job = jobs.get("gitops-tag-bump")
    if not job:
        continue
    step = [s for s in job["steps"] if "run" in s][0]
    runs[f.name] = step["run"]
    envs[f.name] = dict(job.get("env", {}))
assert set(runs) == {"deploy.yaml", "deploy-fast.yaml"}, sorted(runs)
assert len(set(runs.values())) == 1, "step scripts differ between the two workflows"
assert len({json.dumps(e, sort_keys=True) for e in envs.values()}) == 1, "job env differs"
(work / "step.sh").write_text(next(iter(runs.values())))
(work / "step.env.json").write_text(json.dumps(next(iter(envs.values()))))
PY
then
  bad "could not extract a matching step script from both workflows"; exit 1
fi
pass "both workflows carry the same gitops-tag-bump step (script + job env)"

# Job-level env, minus the remote we redirect at the local repo.
BARE="$WORK/gitops.git"
export GITOPS_HOST=git.tecmaxx.de
export GITOPS_REMOTE="$BARE"
export GITOPS_BRANCH=main
export OVERLAY="$OVERLAY_PATH"
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
export RUN_URL="https://git.example/run/1" WORKFLOW="Test"
# Never touch the developer's git identity/credentials, and never let git open
# a credential prompt when a scenario would otherwise hang.
export HOME="$WORK/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig" GIT_CONFIG_SYSTEM=/dev/null
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/true

seed_bare() {
  rm -rf "$BARE" "$WORK/seed"
  mkdir -p "$WORK/seed/$(dirname "$OVERLAY_PATH")"
  cp "${1:-$FIXTURE}" "$WORK/seed/$OVERLAY_PATH"
  printf 'placeholder\n' > "$WORK/seed/README.md"
  git init -q -b main "$WORK/seed"
  git -C "$WORK/seed" -c user.name=seed -c user.email=seed@example.com add -A
  git -C "$WORK/seed" -c user.name=seed -c user.email=seed@example.com commit -qm "seed"
  git init -q --bare "$BARE"
  git -C "$WORK/seed" push -q "$BARE" main:main
}

run_step() {  # run_step <sha> [token]
  : > "$GITHUB_STEP_SUMMARY"
  ( cd "$REPO_ROOT" \
    && SHA="$1" GITOPS_PUSH_TOKEN="${2-}" bash "$WORK/step.sh" ) > "$WORK/out.log" 2>&1
}
head_of() { git -C "$BARE" rev-parse main; }
count_of() { git -C "$BARE" rev-list --count main; }
show_overlay() { git -C "$BARE" show "main:$OVERLAY_PATH"; }

# --------------------------------------------------------------------------
# 2. No secret -> clean skip.
# --------------------------------------------------------------------------
seed_bare
before="$(head_of)"
run_step "$SHA_A" ""; rc=$?
if [ $rc -eq 0 ] && [ "$(head_of)" = "$before" ] \
   && grep -q 'UEBERSPRUNGEN' "$WORK/out.log" \
   && grep -q 'uebersprungen' "$GITHUB_STEP_SUMMARY"; then
  pass "no GITOPS_PUSH_TOKEN: step exits 0, says so, and the repo is untouched"
else
  bad "no-token skip: rc=$rc"; cat "$WORK/out.log"
fi

# --------------------------------------------------------------------------
# 3. The bump itself.
# --------------------------------------------------------------------------
run_step "$SHA_A" token123; rc=$?
if [ $rc -ne 0 ]; then bad "bump: rc=$rc"; cat "$WORK/out.log"; else
  n_commits="$(count_of)"
  subject="$(git -C "$BARE" log -1 --format=%s main)"
  email="$(git -C "$BARE" log -1 --format=%ae main)"
  name="$(git -C "$BARE" log -1 --format=%an main)"
  changed="$(git -C "$BARE" diff --numstat main~1 main | awk '{print $1"/"$2"/"$3}')"
  offenders="$(git -C "$BARE" diff main~1 main | grep -E '^[+-]' | grep -v '^[+-][+-][+-]' | grep -vc 'newTag:')"
  if [ "$n_commits" = "2" ] \
     && [ "$subject" = "ci(images): voltpilot-ems@$SHA_A" ] \
     && [ "$email" = "ci@voltpilot.de" ] && [ "$name" = "VoltPilot CI" ] \
     && [ "$changed" = "9/9/$OVERLAY_PATH" ] && [ "$offenders" -eq 0 ] \
     && [ "$(show_overlay | grep -c "newTag: $SHA_A")" -eq 9 ]; then
    pass "bump: one commit by VoltPilot CI <ci@voltpilot.de>, subject exact, 9 newTag lines and nothing else"
  else
    bad "bump: commits=$n_commits subject='$subject' author='$name <$email>' numstat='$changed' non-newTag=$offenders"
    git -C "$BARE" diff main~1 main | head -30
  fi
  if git -C "$BARE" log -1 --format=%b main | grep -qF "$RUN_URL"; then
    pass "bump: the commit body links the pipeline run (auditability)"
  else
    bad "bump: run link missing from the commit body"
  fi
  # the token must not survive anywhere the job could later print
  if grep -rq token123 "$WORK/out.log" || [ -f "$HOME/.gitconfig" ] && grep -q 'credential' "$HOME/.gitconfig" 2>/dev/null; then
    bad "bump: token leaked into the log, or a credential helper was written to the global git config"
  else
    pass "bump: no token in the log, global git config untouched"
  fi
fi

# --------------------------------------------------------------------------
# 4. Same sha again -> no empty commit.
# --------------------------------------------------------------------------
before="$(head_of)"
run_step "$SHA_A" token123; rc=$?
if [ $rc -eq 0 ] && [ "$(head_of)" = "$before" ] && grep -q 'bereits' "$WORK/out.log"; then
  pass "idempotent: a re-run at the same sha commits nothing"
else
  bad "idempotent re-run: rc=$rc head moved? $(head_of)"; cat "$WORK/out.log"
fi

# --------------------------------------------------------------------------
# 5. The race. A pre-receive hook rejects the FIRST push and, while doing so,
#    advances main with a competing bump - exactly what a second pipeline run
#    finishing a second earlier looks like. The retry loop must re-derive from
#    the new main and land on top, without a merge conflict on the very lines
#    both runs touch.
# --------------------------------------------------------------------------
seed_bare
cat > "$BARE/hooks/pre-receive" <<HOOK
#!/usr/bin/env bash
cat >/dev/null            # always drain stdin
[ -f "\$GIT_DIR/raced" ] && exit 0
touch "\$GIT_DIR/raced"
# Leave git's push quarantine: inside it new objects are throwaway and ref
# updates are forbidden, so the competing commit could not be created there.
unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
# competing bump, committed with plumbing straight into the bare repo
blob=\$(git cat-file -p "main:$OVERLAY_PATH" | sed 's/newTag: .*/newTag: $SHA_C/' | git hash-object -w --stdin)
export GIT_INDEX_FILE="\$GIT_DIR/tmp-index"
git read-tree main
git update-index --add --cacheinfo 100644,\$blob,$OVERLAY_PATH
tree=\$(git write-tree)
commit=\$(git -c user.name=other -c user.email=other@example.com commit-tree \$tree -p main -m "ci(images): voltpilot-ems@$SHA_C")
git update-ref refs/heads/main \$commit
rm -f "\$GIT_INDEX_FILE"
echo "simulated race: main moved on" >&2
exit 1
HOOK
chmod +x "$BARE/hooks/pre-receive"

run_step "$SHA_B" token123; rc=$?
if [ $rc -eq 0 ] \
   && [ "$(count_of)" = "3" ] \
   && [ "$(git -C "$BARE" log -1 --format=%s main)" = "ci(images): voltpilot-ems@$SHA_B" ] \
   && [ "$(git -C "$BARE" log -1 --format=%s main~1)" = "ci(images): voltpilot-ems@$SHA_C" ] \
   && [ "$(show_overlay | grep -c "newTag: $SHA_B")" -eq 9 ] \
   && grep -q 'Versuch 1 von 3' "$WORK/out.log"; then
  pass "race: the rejected push is retried, re-derived from the competitor's main, and lands on top"
else
  bad "race: rc=$rc commits=$(count_of) head='$(git -C "$BARE" log -1 --format=%s main)'"
  tail -20 "$WORK/out.log"
fi

# --------------------------------------------------------------------------
# 6. A shape change in the overlay is refused - nothing is pushed.
# --------------------------------------------------------------------------
awk '/newTag: 23ac1009720ca92ac519cf496472eac4be7f7bfe/ && !done { done = 1; next } { print }' \
  "$FIXTURE" > "$WORK/broken.yaml"
seed_bare "$WORK/broken.yaml"
before="$(head_of)"
run_step "$SHA_A" token123; rc=$?
if [ $rc -eq 1 ] && [ "$(head_of)" = "$before" ]; then
  pass "shape guard: an entry without a newTag fails the job and pushes nothing"
else
  bad "shape guard: rc=$rc (expected 1), head moved? $([ "$(head_of)" = "$before" ] && echo no || echo yes)"
  cat "$WORK/out.log"
fi

printf '\n'
[ $fail -eq 0 ] && printf 'gitops-tag-bump workflow step: all checks passed\n' || printf 'gitops-tag-bump workflow step: FAILURES above\n'
exit $fail
