#!/usr/bin/env bash
# Self-check for the standalone updater edge-app/update.sh.
#
# update.sh is the safe one-command update path for a running edge device.
# It SOURCES install.sh for the compose template (ONE source of truth) and
# carries its own hostnet-override template. This check proves:
#
#   1. `update.sh --print-compose` is byte-identical to
#      `install.sh --print-compose` (the sourcing actually shares the ONE
#      generate_compose - no duplicated template);
#   2. `update.sh --print-hostnet` (minus its marker first line) is
#      byte-identical to the repo docker-compose.hostnet.yml (lockstep guard,
#      like install-selfcheck's compose equivalence);
#   3. structural safety: the script never invokes `compose down`, never
#      removes volumes, never sets a VP_DEV_* hatch, never writes the .env,
#      and does use `up -d --remove-orphans`;
#   4. behavioral (docker-free, via --dry-run which degrades gracefully
#      without docker): no deployment -> clear failure; a current generated
#      compose -> "already up to date", file untouched; a STALE generated
#      compose -> "would update", file untouched in dry-run; a foreign
#      (hand-edited) compose -> kept, untouched; the .env is never modified;
#      a repo-clone deployment is detected as such; a missing install.sh
#      fails with actionable guidance;
#   5. if docker compose (v2) is available: the merged base + hostnet
#      templates pass `docker compose config`;
#   6. shellcheck is clean (if installed) - update.sh AND install.sh (which
#      update.sh sources).
set -euo pipefail

cd "$(dirname "$0")/.."          # -> edge-app/
UPDATE="./update.sh"
INSTALL="./install.sh"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
note() { printf '  ....  %s\n' "$*"; }

echo "== update.sh self-check =="

[ -f "$UPDATE" ] || fail "update.sh not found in $(pwd)"
[ -f "$INSTALL" ] || fail "install.sh not found in $(pwd)"

# --- 1. ONE compose template: update.sh emits install.sh's compose. -------
if ! diff <(bash "$INSTALL" --print-compose) <(bash "$UPDATE" --print-compose) >/dev/null; then
  fail "update.sh --print-compose differs from install.sh --print-compose (template must be shared, not duplicated)"
fi
pass "update.sh --print-compose == install.sh --print-compose (one source of truth)"

# --- 2. Hostnet template lockstep with the repo override file. ------------
HN="$(bash "$UPDATE" --print-hostnet)"
first_line="$(printf '%s\n' "$HN" | head -n1)"
case "$first_line" in
  "# @voltpilot-edge-install:"*) : ;;
  *) fail "--print-hostnet does not start with the generated marker" ;;
esac
if ! diff <(printf '%s\n' "$HN" | tail -n +2) docker-compose.hostnet.yml >/dev/null; then
  printf '%s\n' "--- diff (repo <  | generated >) ---" >&2
  diff docker-compose.hostnet.yml <(printf '%s\n' "$HN" | tail -n +2) >&2 || true
  fail "generated hostnet template drifted from the repo docker-compose.hostnet.yml"
fi
pass "hostnet template (minus marker) == repo docker-compose.hostnet.yml"

# --- 3. Structural safety greps on the script text. -----------------------
# Never an actual `compose down` / volume removal invocation (the strings
# only appear inside quoted "NIEMALS 'down -v'" guidance, never as commands).
if grep -qE '(dcu|docker compose|compose) +down' "$UPDATE"; then
  fail "update.sh must never invoke 'compose down'"
fi
if grep -qE 'docker +volume +(rm|prune)' "$UPDATE"; then
  fail "update.sh must never remove volumes"
fi
if grep -qE '(^|[^A-Za-z_])VP_DEV_[A-Z_]+=' "$UPDATE"; then
  fail "update.sh must never set a VP_DEV_* dev hatch"
fi
# shellcheck disable=SC2016  # the $ is a literal in the grep pattern, deliberately
if grep -qE '>+ *"?\$(ENV_FILE|envfile)' "$UPDATE"; then
  fail "update.sh must never write the .env"
fi
grep -q -- '--remove-orphans' "$UPDATE" || fail "update.sh must use 'up -d --remove-orphans'"
grep -q 'ff-only' "$UPDATE" || fail "update.sh must use 'git pull --ff-only' for repo clones"
pass "structural safety: no compose down / volume rm / VP_DEV_ / .env write; --remove-orphans + ff-only present"

# --- 4. Behavioral checks (docker-free: --dry-run degrades without docker).
tmp_root="$(mktemp -d)"
cleanup() { rm -rf "$tmp_root"; }
trap cleanup EXIT

sha() { shasum "$1" | cut -d' ' -f1; }

# 4a. Empty directory -> clear failure (update.sh never bootstraps).
d="$tmp_root/empty"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
if (cd "$d" && bash update.sh --dry-run --non-interactive >/dev/null 2>&1); then
  fail "update.sh must fail in a directory without a deployment"
fi
pass "no deployment -> refuses (install.sh is the bootstrap path)"

# 4b. Current generated compose -> already up to date, file + .env untouched.
d="$tmp_root/current"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
bash "$INSTALL" --print-compose > "$d/docker-compose.yml"
printf 'VP_WEB_PORT=8484\nVP_NODERED_PASSWORD=geheim-nicht-ausgeben\n' > "$d/.env"
c1="$(sha "$d/docker-compose.yml")"; e1="$(sha "$d/.env")"
out="$(cd "$d" && bash update.sh --dry-run --non-interactive 2>&1)" || fail "dry-run on a current generated compose must succeed"
printf '%s\n' "$out" | grep -q "bereits auf dem aktuellen Stand" || fail "current generated compose not reported as up to date"
printf '%s\n' "$out" | grep -q "geheim-nicht-ausgeben" && fail "update.sh echoed a secret from the .env"
[ "$c1" = "$(sha "$d/docker-compose.yml")" ] || fail "dry-run modified docker-compose.yml"
[ "$e1" = "$(sha "$d/.env")" ] || fail "dry-run modified the .env"
pass "current generated compose -> up to date; compose + .env untouched; no secret echoed"

# 4c. STALE generated compose -> would update, but dry-run writes nothing.
d="$tmp_root/stale"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
bash "$INSTALL" --print-compose | sed 's/VP_BUFFER_HOURS:-48/VP_BUFFER_HOURS:-24/' > "$d/docker-compose.yml"
c1="$(sha "$d/docker-compose.yml")"
out="$(cd "$d" && bash update.sh --dry-run --non-interactive 2>&1)" || fail "dry-run on a stale generated compose must succeed"
printf '%s\n' "$out" | grep -q "WÜRDE auf die aktuelle Vorlage gebracht" || fail "stale generated compose not reported as would-update"
[ "$c1" = "$(sha "$d/docker-compose.yml")" ] || fail "dry-run modified a stale docker-compose.yml"
pass "stale generated compose -> would-update reported; dry-run writes nothing"

# 4d. Foreign (hand-edited) compose -> kept in --non-interactive, untouched.
d="$tmp_root/foreign"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
printf 'services:\n  core:\n    image: something/custom:1\n' > "$d/docker-compose.yml"
c1="$(sha "$d/docker-compose.yml")"
out="$(cd "$d" && bash update.sh --dry-run --non-interactive 2>&1)" || fail "dry-run on a foreign compose must succeed"
printf '%s\n' "$out" | grep -q "wird beibehalten" || fail "foreign compose not reported as kept"
[ "$c1" = "$(sha "$d/docker-compose.yml")" ] || fail "a foreign docker-compose.yml was modified"
pass "foreign compose -> kept (never clobbered without --force-compose)"

# 4e. Repo-clone deployment -> detected, git pull offered (not run in dry-run).
if command -v git >/dev/null 2>&1; then
  d="$tmp_root/repo"; mkdir -p "$d"
  cp docker-compose.yml docker-compose.hostnet.yml "$INSTALL" "$UPDATE" "$d/"
  (cd "$d" && git init -q \
    && git add docker-compose.yml docker-compose.hostnet.yml \
    && git -c user.email=t@t -c user.name=t commit -qm seed)
  c1="$(sha "$d/docker-compose.yml")"
  out="$(cd "$d" && bash update.sh --dry-run --non-interactive 2>&1)" || fail "dry-run on a repo clone must succeed"
  printf '%s\n' "$out" | grep -q "Repo-Klon-Deployment erkannt" || fail "repo-clone deployment not detected"
  printf '%s\n' "$out" | grep -q "git pull --ff-only" || fail "repo model must mention 'git pull --ff-only'"
  [ "$c1" = "$(sha "$d/docker-compose.yml")" ] || fail "repo compose was modified"
  pass "repo-clone deployment -> detected; refresh via git pull --ff-only"
else
  note "git unavailable - skipping repo-model detection check"
fi

# 4f. Missing install.sh -> actionable failure (shared-template dependency).
d="$tmp_root/noinstall"; mkdir -p "$d"; cp "$UPDATE" "$d/"
if out="$(cd "$d" && bash update.sh --dry-run 2>&1)"; then
  fail "update.sh must fail when install.sh is missing"
fi
printf '%s\n' "$out" | grep -q "install.sh" || fail "missing-install.sh error must name install.sh"
pass "missing install.sh -> clear, actionable failure"

# --- 5. docker compose validity of the merged templates (docker-gated). ---
if docker compose version >/dev/null 2>&1; then
  d="$tmp_root/merge"; mkdir -p "$d"
  bash "$UPDATE" --print-compose > "$d/docker-compose.yml"
  bash "$UPDATE" --print-hostnet > "$d/docker-compose.hostnet.yml"
  if env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$d" \
       -f "$d/docker-compose.yml" -f "$d/docker-compose.hostnet.yml" config >/dev/null 2>&1; then
    pass "docker compose config accepts base + hostnet override merged"
  else
    fail "'docker compose config' rejected the merged base + hostnet templates"
  fi
else
  note "docker compose (v2) unavailable - skipping merged-config validity check"
fi

# --- 6. shellcheck (if present) - update.sh AND the sourced install.sh. ---
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$UPDATE" "$INSTALL"; then pass "shellcheck clean (update.sh + install.sh)"; else fail "shellcheck reported issues"; fi
else
  note "shellcheck unavailable - skipping lint"
fi

echo "== self-check OK =="
