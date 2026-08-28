#!/usr/bin/env bash
# Self-check for the standalone installer edge-app/install.sh.
#
# install.sh is the ONLY file a device needs: it GENERATES its own
# docker-compose.yml. This check proves that generated compose is the correct
# real-mode, images-only subset and stays in lockstep with the repo compose:
#
#   1. `install.sh --print-compose` emits a compose that
#        - carries the generated marker, name voltpilot-edge, both registry
#          images (core + nodered), both named volumes, pull_policy: always;
#        - contains NO build:/context: (a device never builds), NO
#          sim/edge-sim (real mode only) and NO profile at all: since the
#          one-step simplification (26.08.2026) the apply sidecar `updater`
#          is a normal service, so an installed box updates itself without
#          any further step (docs/ota-autonomie.md).
#   2. If `docker compose` (v2) is available: the emitted compose passes
#        `docker compose -f - config` (valid), and its resolved service
#        definition is byte-identical to the repo compose's - and the repo
#        compose resolves the SAME with and without a profile flag, so no
#        service can hide behind one again.
#   3. shellcheck is clean (if installed).
#
# Docker-free by default (steps 1 + 3 always run); the equivalence proof
# (step 2) is skipped with a notice when docker/compose is absent.
set -euo pipefail

cd "$(dirname "$0")/.."          # -> edge-app/
INSTALL="./install.sh"

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
note() { printf '  ....  %s\n' "$*"; }

echo "== install.sh self-check =="

[ -f "$INSTALL" ] || fail "install.sh not found in $(pwd)"

# --- 1. Emit + structural assertions (no docker needed). ------------------
COMPOSE="$(bash "$INSTALL" --print-compose)"
[ -n "$COMPOSE" ] || fail "--print-compose produced no output"

grep_has()  { printf '%s\n' "$COMPOSE" | grep -qF -- "$1" || fail "generated compose is missing: $1"; }
grep_none() { printf '%s\n' "$COMPOSE" | grep -qiF -- "$1" && fail "generated compose must NOT contain: $1"; return 0; }

grep_has '@voltpilot-edge-install'
grep_has 'name: voltpilot-edge'
# Image refs are version-LEVERED (default :latest = the pre-pin behaviour;
# VP_EDGE_IMAGE_TAG pins a tag, VP_EDGE_*_IMAGE a full ref / digest).
# shellcheck disable=SC2016  # literal compose interpolation syntax, deliberately not expanded
grep_has 'image: ${VP_EDGE_CORE_IMAGE:-git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:${VP_EDGE_IMAGE_TAG:-latest}}'
# shellcheck disable=SC2016
grep_has 'image: ${VP_EDGE_NODERED_IMAGE:-git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:${VP_EDGE_IMAGE_TAG:-latest}}'
grep_has 'pull_policy: always'
grep_has 'vp-edge-data'
grep_has 'vp-nodered-data'
# Real-mode, images-only: never a build context, never the simulator.
grep_none 'build:'
grep_none 'context:'
grep_none 'edge-sim'
# "sim" as a standalone token (the profile / service) must be absent; the
# substring in "Simulator" comments does not appear (there are none).
if printf '%s\n' "$COMPOSE" | grep -qiE '(^|[^a-z])sim([^a-z]|$)'; then
  fail "generated compose references the simulator"
fi
# A device compose carries NO profile at all any more: the apply sidecar is a
# normal service since the one-step simplification (26.08.2026). The old `ota`
# profile was one of the two gates that kept an installed box from updating
# itself - and the ban on OTHER profiles (the simulator) is preserved by this
# stricter form.
if printf '%s\n' "$COMPOSE" | grep -qE '^[[:space:]]*profiles:'; then
  fail "generated compose must carry NO profile - the updater is a normal service"
fi
# shellcheck disable=SC2016
grep_has 'image: ${VP_EDGE_UPDATER_IMAGE:-git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-updater:${VP_EDGE_IMAGE_TAG:-latest}}'
# The sidecar's two structural safety properties, pinned in the file itself:
# it owns the docker socket, so it must have NO network of its own.
grep_has '/var/run/docker.sock:/var/run/docker.sock'
grep_has 'network_mode: none'
# The device switch is GONE, not just defaulted: a compose that still carries
# it would mean the removal was half-done.
grep_none 'VP_OTA_AUTONOMOUS'
grep_none 'VP_OTA_NEUTRAL_VERIFIED'
pass "structural: marker, images, volumes, pull_policy; no build/context/sim; no profile, no autonomy switch"

# --- 1b. A FRESH install brings the updater along, no flag needed -----------
# It is a normal service now, so `pull`/`up -d` without any profile argument
# must cover it. A regression here would silently drop the sidecar again -
# the very bug the one-step simplification closes.
if grep -qE 'dc (pull|up)[^|&;\n]*--profile' "$INSTALL"; then
  fail "install.sh must not pass --profile any more - the updater is a normal service"
fi
if ! grep -qE 'dc pull' "$INSTALL"; then
  fail "pull_and_up must pull the whole stack"
fi
if ! grep -qE 'dc up -d\b' "$INSTALL"; then
  fail "pull_and_up must bring the whole stack up"
fi
pass "fresh installs pull + start core, nodered AND the updater sidecar - no flag, no profile"

# --- 1c. The portal endpoint comes from the CUSTOMER route, never a VPN. ---
# Stub Linux's `ip` so the rule is deterministic and Docker-free. The normal
# default-route source wins; if that route itself is WireGuard, the first
# physical global interface is used. 172.16/12 remains a legitimate customer
# LAN and must not be thrown away merely because Docker also uses that range.
lanstub="$(mktemp -d)"
cat > "$lanstub/ip" <<'EOF'
#!/bin/sh
case "$*" in
  "-4 route get 1.1.1.1") printf '%s\n' "1.1.1.1 via 192.168.178.1 dev eth0 src 192.168.178.42" ;;
  "-o -4 addr show scope global") printf '%s\n' "2: eth0 inet 192.168.178.42/24 scope global eth0" ;;
esac
EOF
chmod +x "$lanstub/ip"
detected="$(PATH="$lanstub:/usr/bin:/bin" bash -c '. ./install.sh; detect_lan_endpoint 8484')"
[ "$detected" = "192.168.178.42:8484" ] \
  || fail "LAN detector must use the physical default-route source, got: $detected"

cat > "$lanstub/ip" <<'EOF'
#!/bin/sh
case "$*" in
  "-4 route get 1.1.1.1") printf '%s\n' "1.1.1.1 dev wg0 src 10.10.1.23" ;;
  "-o -4 addr show scope global") {
    printf '%s\n' "2: wg0 inet 10.10.1.23/24 scope global wg0"
    printf '%s\n' "3: eth0 inet 172.20.5.42/24 scope global eth0"
  } ;;
esac
EOF
chmod +x "$lanstub/ip"
detected="$(PATH="$lanstub:/usr/bin:/bin" bash -c '. ./install.sh; detect_lan_endpoint 8484')"
rm -rf "$lanstub"
[ "$detected" = "172.20.5.42:8484" ] \
  || fail "LAN detector must skip VPN and retain a legitimate 172.16/12 customer LAN, got: $detected"
pass "customer-LAN detector: physical route wins; VPN skipped; 172.16/12 retained"

# --- 2. docker compose validity + equivalence to the repo real-mode config.
if docker compose version >/dev/null 2>&1; then
  if ! printf '%s\n' "$COMPOSE" | docker compose -f - config >/dev/null 2>&1; then
    fail "'docker compose -f - config' rejected the generated compose"
  fi
  pass "docker compose config accepts the generated compose"

  # Resolve both with a clean env + an empty project dir so ONLY defaults are
  # substituted (no ambient VP_* / stray .env), then compare - the repo's
  # build: lines are the only legitimate difference and are stripped.
  emptyd="$(mktemp -d)"
  repo="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" -f docker-compose.yml config 2>/dev/null \
            | grep -vE '^[[:space:]]*(build:|context:|dockerfile:)')"
  gen="$(printf '%s\n' "$COMPOSE" | env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" -f - config 2>/dev/null)"
  rmdir "$emptyd" 2>/dev/null || true
  if [ "$repo" = "$gen" ]; then
    pass "generated compose == repo real-mode 'docker compose config' (minus build:)"
  else
    printf '%s\n' "--- diff (repo <  | generated >) ---" >&2
    diff <(printf '%s\n' "$repo") <(printf '%s\n' "$gen") >&2 || true
    fail "generated compose drifted from the repo real-mode compose"
  fi

  # And the repo compose must resolve IDENTICALLY with a profile flag on: a
  # service that reappears only with `--profile` would be a gate in disguise.
  emptyd="$(mktemp -d)"
  repo_ota="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" --profile ota -f docker-compose.yml config 2>/dev/null \
            | grep -vE '^[[:space:]]*(build:|context:|dockerfile:)')"
  gen_ota="$(printf '%s\n' "$COMPOSE" | env -i PATH="$PATH" HOME="${HOME:-/tmp}" docker compose --project-directory "$emptyd" --profile ota -f - config 2>/dev/null)"
  rmdir "$emptyd" 2>/dev/null || true
  if [ "$repo_ota" = "$gen_ota" ]; then
    pass "a profile flag changes NOTHING - the sidecar is a normal service"
  else
    printf '%s\n' "--- diff --profile ota (repo <  | generated >) ---" >&2
    diff <(printf '%s\n' "$repo_ota") <(printf '%s\n' "$gen_ota") >&2 || true
    fail "the OTA sidecar drifted between the repo compose and the generated one"
  fi

  # Image-version lever: unset = today's :latest (no behaviour change);
  # VP_EDGE_IMAGE_TAG pins both, VP_EDGE_*_IMAGE overrides a full ref/digest.
  emptyd="$(mktemp -d)"
  images() { # images <env assignments...>
    printf '%s\n' "$COMPOSE" | env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" \
      docker compose --project-directory "$emptyd" -f - config --images 2>/dev/null | sort
  }
  def="$(images)"
  printf '%s\n' "$def" | grep -qx 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest' \
    || fail "default (no VP_EDGE_*) must resolve core to :latest, got: $def"
  printf '%s\n' "$def" | grep -qx 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:latest' \
    || fail "default (no VP_EDGE_*) must resolve nodered to :latest, got: $def"
  tagged="$(images VP_EDGE_IMAGE_TAG=deadbeef)"
  printf '%s\n' "$tagged" | grep -qx 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:deadbeef' \
    || fail "VP_EDGE_IMAGE_TAG must pin the core image, got: $tagged"
  printf '%s\n' "$tagged" | grep -qx 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:deadbeef' \
    || fail "VP_EDGE_IMAGE_TAG must pin the nodered image, got: $tagged"
  pinned="$(images VP_EDGE_CORE_IMAGE=example.test/core@sha256:abc)"
  printf '%s\n' "$pinned" | grep -qx 'example.test/core@sha256:abc' \
    || fail "VP_EDGE_CORE_IMAGE must override the full core ref, got: $pinned"
  printf '%s\n' "$pinned" | grep -qx 'git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:latest' \
    || fail "a core-only pin must leave nodered on its default, got: $pinned"
  rmdir "$emptyd" 2>/dev/null || true
  pass "image lever: unset -> :latest; VP_EDGE_IMAGE_TAG pins both; VP_EDGE_CORE_IMAGE pins a digest"
else
  note "docker compose (v2) unavailable - skipping config validity + equivalence check"
fi

# --- 2b. Trust-set provisioning: structure (docker-free). ------------------
#
# A NEW box must join the OTA trust chain without a manual copy step - the
# first live rollout was rejected for a missing trust-set. Two properties are
# pinned here because both are load-bearing and neither is obvious from
# reading the happy path:
#
#   * The trust boundary. INSTALL time is a sanctioned TOFU moment (the box
#     just pulled its images over the same channel, and it still verifies the
#     ROOT signature itself). A RUNNING box must never fetch a trust-set on
#     its own - so the ONLY fetch lives in install.sh, and the core has no
#     such route.
#   * FILE-level copies only. `docker cp` of a DIRECTORY sets the owner of the
#     DESTINATION DIRECTORY to the host uid (measured: root:root / 501:root);
#     /data/ota would stop belonging to the unprivileged core user, which
#     could then write neither target.json (its assignment) nor current.json
#     (the stand it witnesses). Copying single FILES into an EXISTING
#     directory leaves that ownership untouched - proven for real in 2c.
grep -q 'refresh-trust' "$INSTALL" || fail "install.sh must offer --refresh-trust"
grep -q '/api/v1/edge/trust-set' "$INSTALL" || fail "install.sh must fetch the trust-set from the portal"
# The copy must name FILES on both sides - never `cp <dir> core:/data`.
if grep -E 'dc cp .*core:/data(/)?"?$' "$INSTALL" | grep -qv 'trust-set'; then
  fail "install.sh must copy trust-set FILES, never a directory into /data"
fi
# shellcheck disable=SC2016  # literal shell text inside install.sh, deliberately not expanded
grep -q 'core:${EDGE_OTA_DIR}/${TRUST_SET_FILE}' "$INSTALL" \
  || fail "the trust-set copy must target the FILE path inside /data/ota"
# A missing trust-set must never fail the install: a box without one works
# fully, it just cannot (yet) apply a release.
grep -q 'TRUST_RESULT="nicht verfügbar"' "$INSTALL" \
  || fail "install.sh must degrade (not die) when the portal serves no trust-set"
pass "trust-set: fetched at install time, FILE-level copy, missing set degrades"

# --- 2c. Trust-set provisioning: the REAL placement (docker). --------------
#
# The ownership rule above is a measured docker behaviour, not a style choice,
# so it is proven against a real container that mirrors the core image
# (unprivileged user owning /data) with a real stub portal.
if docker info >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  tdir="$(mktemp -d)"
  proj="vp-trustcheck-$$"
  cleanup_trust() {
    docker compose --project-directory "$tdir" -f "$tdir/docker-compose.yml" \
      -p "$proj" down -v >/dev/null 2>&1 || true
    docker rmi -f "$proj-core" >/dev/null 2>&1 || true
    [ -n "${stub_pid:-}" ] && kill "$stub_pid" >/dev/null 2>&1
    rm -rf "$tdir"
  }
  trap cleanup_trust EXIT

  # A stub portal serving the two RAW-byte routes, incl. a deliberately
  # "untidy" document: whatever the api stores must come back byte for byte,
  # because the root signature is over exactly these bytes.
  printf '{\n  "schema_version": "1.0",\n  "keys": [ ]\n}\n' > "$tdir/trust-set.json"
  printf '{"schema_version":"1.0","domain":"trust-set"}\n' > "$tdir/trust-set.json.sig"
  mkdir -p "$tdir/api/v1/edge/trust-set"
  cp "$tdir/trust-set.json" "$tdir/trust-set.json.sig" "$tdir/api/v1/edge/trust-set/"
  # Pick the port OURSELVES rather than parsing the server banner: python
  # block-buffers stdout into a file, so the banner is not there yet when we
  # would read it (measured).
  port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  ( cd "$tdir" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 ) &
  stub_pid=$!
  disown "$stub_pid" 2>/dev/null || true   # keep the kill quiet at the end
  sleep 1

  cat > "$tdir/Dockerfile" <<'EOF'
FROM alpine:3.20
RUN addgroup -S voltpilot && adduser -S -G voltpilot voltpilot \
    && mkdir -p /data && chown voltpilot:voltpilot /data
USER voltpilot
ENTRYPOINT ["sleep", "600"]
EOF
  cat > "$tdir/docker-compose.yml" <<EOF
name: $proj
services:
  core:
    image: $proj-core
    volumes:
      - vp-edge-data:/data
volumes:
  vp-edge-data:
EOF

  if docker build -q -t "$proj-core" "$tdir" >/dev/null 2>&1 \
     && docker compose --project-directory "$tdir" -f "$tdir/docker-compose.yml" -p "$proj" up -d >/dev/null 2>&1; then
    # The core creates /data/ota itself at startup (agent/ota.go); the stand-in
    # cannot, so create it AS THE IMAGE USER exactly like install.sh does.
    docker compose --project-directory "$tdir" -f "$tdir/docker-compose.yml" -p "$proj" \
      exec -T core mkdir -p /data/ota >/dev/null 2>&1 || true
    # Something the core owns and must keep owning + writing.
    docker compose --project-directory "$tdir" -f "$tdir/docker-compose.yml" -p "$proj" \
      exec -T core sh -c 'echo KEEP > /data/ota/current.json' >/dev/null 2>&1

    # Drive install.sh's OWN functions - not a re-implementation.
    (
      set +u
      # shellcheck disable=SC1090
      source "$INSTALL"
      TARGET_DIR="$tdir"; COMPOSE_FILE="$tdir/docker-compose.yml"
      # Both are consumed by install.sh's OWN functions below (indirectly).
      # shellcheck disable=SC2329
      dc() { docker compose --project-directory "$TARGET_DIR" -f "$COMPOSE_FILE" -p "$proj" "$@"; }
      # shellcheck disable=SC2034
      VP_PORTAL_BASE_URL="http://127.0.0.1:${port}"
      fetched="$(mktemp -d)"
      fetch_trust_set "$fetched" || { echo "FETCH-FAILED"; exit 1; }
      place_trust_set "$fetched" || { echo "PLACE-FAILED"; exit 1; }
      rm -rf "$fetched"
    ) || fail "install.sh's fetch/place of the trust-set failed against the stub portal"

    dcx() {
      docker compose --project-directory "$tdir" -f "$tdir/docker-compose.yml" -p "$proj" \
        exec -T core "$@"
    }
    # (a) byte-exact: the untidy document survives the whole path.
    got="$(dcx cat /data/ota/trust-set.json)"
    [ "$got" = "$(cat "$tdir/trust-set.json")" ] \
      || fail "the trust-set did not arrive byte for byte"
    dcx test -s /data/ota/trust-set.json.sig || fail "the detached signature was not placed"
    # (b) other files in /data/ota survive - a wipe would destroy current.json,
    #     which is integrity-relevant LOCAL state.
    [ "$(dcx cat /data/ota/current.json)" = "KEEP" ] \
      || fail "placing the trust-set must not touch other files in /data/ota"
    # (c) THE ownership rule: the core can still write its own state.
    dcx sh -c 'touch /data/ota/target.json' >/dev/null 2>&1 \
      || fail "after placement the core can no longer write /data/ota - the directory was chowned away"
    pass "trust-set placement: byte-exact, merges, and /data/ota stays writable by the core"
  else
    note "could not build/start the stand-in core - skipping the real placement proof"
  fi
  cleanup_trust
  trap - EXIT
else
  note "docker / python3 unavailable - skipping the real trust-set placement proof"
fi

# --- 3. shellcheck (if present). ------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$INSTALL"; then pass "shellcheck clean"; else fail "shellcheck reported issues"; fi
else
  note "shellcheck unavailable - skipping lint"
fi

echo "== self-check OK =="
