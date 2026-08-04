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
#      removes volumes, never sets a VP_DEV_* hatch, writes the .env ONLY
#      through the single VP_EDGE_*-image-key writer (env_set_pin, reached
#      only via --tag/--core-image/--nodered-image/--latest), and does use
#      `up -d --remove-orphans`;
#   4. behavioral (docker-free, via --dry-run which degrades gracefully
#      without docker): no deployment -> clear failure; a current generated
#      compose -> "already up to date", file untouched; a STALE generated
#      compose -> "would update", file untouched in dry-run; a foreign
#      (hand-edited) compose -> kept, untouched; the .env is never modified
#      on the default path; a repo-clone deployment is detected as such; a
#      missing install.sh fails with actionable guidance;
#   4b. the image pin (R3): --help documents it, bad values are refused, a
#      dry-run pin writes nothing, and env_set_pin replaces exactly its own
#      key while every other .env line (secrets included) survives byte for
#      byte at mode 600;
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
  fail "update.sh must never redirect into the .env"
fi
# The ONLY .env write is env_set_pin's atomic replace: exactly one `mv` onto
# $ENV_FILE, inside that function, and it accepts only the three VP_EDGE_*
# image keys (guarded by its own case statement).
# shellcheck disable=SC2016
env_mv_count="$(grep -cE '^[[:space:]]*mv "\$tmp" "\$ENV_FILE"' "$UPDATE" || true)"
[ "$env_mv_count" = "1" ] || fail "expected exactly one .env write site (env_set_pin), found ${env_mv_count}"
grep -q 'VP_EDGE_IMAGE_TAG|VP_EDGE_CORE_IMAGE|VP_EDGE_NODERED_IMAGE) : ;;' "$UPDATE" \
  || fail "env_set_pin must whitelist ONLY the VP_EDGE_* image keys"
grep -q 'PIN_REQUESTED" -eq 1 \] || return 0' "$UPDATE" \
  || fail "apply_image_pin must return immediately unless a pin flag was given"
grep -q -- '--remove-orphans' "$UPDATE" || fail "update.sh must use 'up -d --remove-orphans'"
grep -q 'ff-only' "$UPDATE" || fail "update.sh must use 'git pull --ff-only' for repo clones"
pass "structural safety: no compose down / volume rm / VP_DEV_; single opt-in .env pin writer; --remove-orphans + ff-only present"

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

# --- 4g. Image pin (R3): documented, validated, opt-in, surgical. ---------
HELP="$(bash "$UPDATE" --help)"
for opt in --tag --core-image --nodered-image --latest; do
  printf '%s\n' "$HELP" | grep -q -- "$opt" || fail "--help must document ${opt}"
done
pass "--help documents --tag / --core-image / --nodered-image / --latest"

# Bad values are refused BEFORE anything is touched (exit 2, no side effects).
d="$tmp_root/pinargs"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
bash "$INSTALL" --print-compose > "$d/docker-compose.yml"
printf 'VP_NODERED_PASSWORD=geheim\n' > "$d/.env"; chmod 600 "$d/.env"
e1="$(sha "$d/.env")"
(cd "$d" && bash update.sh --tag 'bad tag' >/dev/null 2>&1) && fail "an invalid tag must be refused"
# shellcheck disable=SC2016
(cd "$d" && bash update.sh --core-image 'foo$(id)' >/dev/null 2>&1) && fail "an invalid image ref must be refused"
(cd "$d" && bash update.sh --tag >/dev/null 2>&1) && fail "--tag without a value must be refused"
(cd "$d" && bash update.sh --latest --tag v1 >/dev/null 2>&1) && fail "--latest must exclude --tag"
[ "$e1" = "$(sha "$d/.env")" ] || fail "a refused pin argument modified the .env"
pass "invalid pin values refused (exit != 0), .env untouched"

# A dry-run pin announces but writes nothing.
out="$(cd "$d" && bash update.sh --dry-run --non-interactive --tag v9 2>&1)" || fail "dry-run pin must succeed"
printf '%s\n' "$out" | grep -q "WÜRDE festgelegt" || fail "dry-run pin not announced"
[ "$e1" = "$(sha "$d/.env")" ] || fail "dry-run pin wrote the .env"
pass "--tag in --dry-run: announced, .env untouched"

# env_set_pin is surgical: only its own key changes, everything else survives
# byte for byte (secrets included), mode stays 600.
d="$tmp_root/pinwrite"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
bash "$INSTALL" --print-compose > "$d/docker-compose.yml"
printf '# kopf\nVP_WEB_PORT=8484\nVP_NODERED_PASSWORD=streng-geheim\n' > "$d/.env"; chmod 600 "$d/.env"
(cd "$d" && bash -c '. ./update.sh
  env_set_pin VP_EDGE_IMAGE_TAG "abc123"
  env_set_pin VP_EDGE_CORE_IMAGE "reg.example/core@sha256:deadbeef"
  env_set_pin VP_EDGE_IMAGE_TAG "def456"') || fail "env_set_pin failed"
grep -qx '# kopf' "$d/.env" || fail "env_set_pin dropped a comment line"
grep -qx 'VP_WEB_PORT=8484' "$d/.env" || fail "env_set_pin dropped an unrelated key"
grep -qx 'VP_NODERED_PASSWORD=streng-geheim' "$d/.env" || fail "env_set_pin dropped the secret"
grep -qx 'VP_EDGE_IMAGE_TAG=def456' "$d/.env" || fail "env_set_pin did not replace its own key"
[ "$(grep -c '^VP_EDGE_IMAGE_TAG=' "$d/.env")" = "1" ] || fail "env_set_pin duplicated its key instead of replacing it"
grep -qx 'VP_EDGE_CORE_IMAGE=reg.example/core@sha256:deadbeef' "$d/.env" || fail "digest pin not written"
# shellcheck disable=SC2012  # fixed, known filename - ls is fine and portable here
case "$(ls -l "$d/.env" | cut -c1-10)" in -rw-------) : ;; *) fail ".env lost its 600 permissions" ;; esac
# Releasing removes the key again.
(cd "$d" && bash -c '. ./update.sh; env_set_pin VP_EDGE_CORE_IMAGE ""') || fail "env_set_pin release failed"
grep -q 'VP_EDGE_CORE_IMAGE' "$d/.env" && fail "released pin key still present"
grep -qx 'VP_NODERED_PASSWORD=streng-geheim' "$d/.env" || fail "release dropped the secret"
pass "env_set_pin: replaces only its key, keeps every other line + mode 600, release removes it"

# --- 4b. --from-target (OTA Stufe 2): the assignment comes from the DEVICE. ---
#
# The property under test is the safety one: the digests that end up in a pin
# come from the box's own VERIFIED assignment, and a non-ok verdict applies
# NOTHING. The whole path is exercised offline against a canned /api/ota/target
# body - no docker, no core, no network.
bash "$UPDATE" --help 2>&1 | grep -q -- '--from-target' \
  || fail "--help does not document --from-target"
if bash "$UPDATE" --from-target --tag abc >/dev/null 2>&1; then
  fail "--from-target must exclude --tag (two sources for one question)"
fi
if bash "$UPDATE" --from-target --latest >/dev/null 2>&1; then
  fail "--from-target must exclude --latest"
fi

d="$tmp_root/fromtarget"; mkdir -p "$d"; cp "$INSTALL" "$UPDATE" "$d/"
ok_json='{"has_target":true,"verdict":"ok","release":"edge-2026.08.0","release_seq":12,"running":false,"images":{"core":"reg.example/edge-app-core@sha256:aaaa","nodered":"reg.example/edge-app-nodered@sha256:bbbb"}}'
got="$(cd "$d" && bash -c ". ./update.sh; target_image_ref '$ok_json' core")"
[ "$got" = "reg.example/edge-app-core@sha256:aaaa" ] \
  || fail "target_image_ref picked the wrong core digest: $got"
got="$(cd "$d" && bash -c ". ./update.sh; target_image_ref '$ok_json' nodered")"
[ "$got" = "reg.example/edge-app-nodered@sha256:bbbb" ] \
  || fail "target_image_ref picked the wrong nodered digest: $got"
# A key that is not in the images object must yield nothing (never a neighbour).
got="$(cd "$d" && bash -c ". ./update.sh; target_image_ref '$ok_json' sidecar")"
[ -z "$got" ] || fail "target_image_ref invented a ref for an absent artifact: $got"

# A REJECTED assignment must abort before anything is pinned; a stubbed curl
# stands in for the device.
mkdir -p "$d/bin"
cat > "$d/bin/curl" <<'STUB'
#!/bin/sh
echo '{"has_target":true,"verdict":"rejected","reason":"Kette gebrochen","release":"edge-2026.08.0"}'
STUB
chmod +x "$d/bin/curl"
out="$(cd "$d" && PATH="$d/bin:$PATH" bash -c '. ./update.sh
  FROM_TARGET=1; ACTIVE_WEB_PORT=8484
  resolve_target_pin
  echo "PIN=${PIN_CORE_IMAGE:-none}"' 2>&1 || true)"
printf '%s\n' "$out" | grep -q 'nicht anwendbar' \
  || fail "a rejected assignment must be refused loudly: $out"
printf '%s\n' "$out" | grep -q 'PIN=' \
  && fail "a rejected assignment must abort BEFORE anything is pinned"
pass "--from-target: digests come from the device's verified assignment; a non-ok verdict applies nothing"

# --- 4c. A MISSING trust-set: name the fix, download NOTHING. -------------
#
# The most common reason a rejected assignment on an EXISTING box: the
# root-signed trust-set was never placed under /data/ota (the first live
# rollout died on exactly this). Two properties, and the second is the
# security-relevant one:
#
#   * update.sh RECOGNISES the reason and prints the concrete fix - both the
#     automated form (`install.sh --refresh-trust`) and the manual two-liner,
#     because install.sh need not be present next to a hand-deployed box.
#   * update.sh NEVER downloads a trust-set. A RUNNING box must not fetch the
#     revocation anchor over the network - that would let it travel the very
#     channel it revokes. Install time is the sanctioned TOFU moment, not
#     update time.
cat > "$d/bin/curl" <<'STUB'
#!/bin/sh
echo '{"has_target":true,"verdict":"rejected","reason":"Das Vertrauens-Set oder seine Signatur fehlt.","release":"edge-2026.08.0"}'
STUB
chmod +x "$d/bin/curl"
out="$(cd "$d" && PATH="$d/bin:$PATH" bash -c '. ./update.sh
  FROM_TARGET=1; ACTIVE_WEB_PORT=8484
  resolve_target_pin
  echo "PIN=${PIN_CORE_IMAGE:-none}"' 2>&1 || true)"
printf '%s\n' "$out" | grep -q -- '--refresh-trust' \
  || fail "a missing trust-set must name the automated fix: $out"
printf '%s\n' "$out" | grep -q 'docker compose cp trust-set.json core:/data/ota/trust-set.json' \
  || fail "a missing trust-set must also name the manual path: $out"
printf '%s\n' "$out" | grep -q 'PIN=' \
  && fail "a missing trust-set must abort BEFORE anything is pinned"
# THE boundary: no fetch of a trust-set anywhere in update.sh.
if grep -nE '(curl|wget)[^|]*trust-set' "$UPDATE"; then
  fail "update.sh must never DOWNLOAD a trust-set - a running box stays out-of-band"
fi
grep -q '/api/v1/edge/trust-set' "$UPDATE" \
  && fail "update.sh must not know the trust-set route at all"
pass "missing trust-set: fix named (automated + manual), nothing downloaded, nothing pinned"

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
