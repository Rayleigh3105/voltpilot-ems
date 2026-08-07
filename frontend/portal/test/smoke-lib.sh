#!/usr/bin/env bash
# Shared plumbing for the portal's real-nginx smoke tests (csp-smoke.sh +
# cache-smoke.sh). It owns exactly three things: how the container is started,
# how a request reaches it, and what the environment says about itself. Every
# ASSERTION stays in the two scripts - this file must never decide whether
# something passes.
#
# WHY the checks no longer curl a published port (CI run #183, 2026-08-07).
# Both smokes went red on the Forgejo runner the very first time they ran there:
# `test:csp` entered the gate with #160 (17.07.), `test:cache` with #283
# (30.07.), and the gated deploy.yaml had not been started by hand since run #95
# - which predates both. So this was never a regression, it was first contact.
#
# `docker run -p 127.0.0.1::80` publishes the port on the DOCKER HOST. When the
# job itself runs in a container against a mounted docker socket - the default
# for a Forgejo/Gitea runner - the job's own 127.0.0.1 is NOT the docker host's
# loopback, so every request is refused and the readiness loop gives up before
# the first assertion. A Testcontainers suite survives this because it resolves
# the docker host itself; a hand-rolled `docker run -p` + `curl` does not, which
# is exactly why the JVM legs stayed green while these two died.
#
# Therefore every request now runs INSIDE a sidecar container that SHARES the
# nginx container's network namespace (`--network container:<cid>`) and reaches
# it at 127.0.0.1:80 from within. That is true on a laptop and inside a
# containerized runner alike, so BOTH environments exercise the same path -
# a fallback that only runs where things are already broken is a path nobody
# tests.
#
# `req` takes the same curl arguments the checks always passed, and returns the
# same stdout and the same exit status, so the assertions above it are unchanged.

# The sidecar only has to carry a curl. Pinned so a smoke failure is never the
# upstream image changing under us; override when a runner mirrors its images.
SMOKE_CURL_IMAGE="${VP_SMOKE_CURL_IMAGE:-curlimages/curl:8.11.1}"

SMOKE_CID=""
SMOKE_SIDECAR=""
# Reachable from INSIDE the sidecar - what every assertion uses.
BASE="http://127.0.0.1"
# The published port, reachable only when this job shares the docker host's
# network namespace. Empty when it is not; only the real-browser check needs it.
# shellcheck disable=SC2034  # read by the sourcing script (csp-smoke.sh)
SMOKE_HOST_BASE=""

smoke_stop() {
  [ -n "$SMOKE_SIDECAR" ] && docker rm -f "$SMOKE_SIDECAR" >/dev/null 2>&1
  [ -n "$SMOKE_CID" ] && docker rm -f "$SMOKE_CID" >/dev/null 2>&1
  return 0
}

# Is this job itself running inside a container? Heuristic, and deliberately
# only ever PRINTED - the functional probe below is what actually decides.
smoke_in_container() {
  [ -f /.dockerenv ] && return 0
  grep -qaE '(docker|containerd|kubepods|libpod)' /proc/1/cgroup 2>/dev/null && return 0
  return 1
}

# The self-report. It exists so the NEXT red run explains itself instead of
# needing a person to reproduce it: run #183 gave no usable trace at all.
smoke_report_context() {
  local ctx="host"
  smoke_in_container && ctx="container"
  echo "==> environment"
  echo "    job runs in: ${ctx}"
  echo "    docker:      $(docker version --format '{{.Client.Version}} (server {{.Server.Version}}, API {{.Server.APIVersion}})' 2>/dev/null || echo 'unavailable')"
  echo "    curl(host):  $(command -v curl >/dev/null 2>&1 && curl --version 2>/dev/null | head -1 || echo 'absent')"
  echo "    sidecar:     ${SMOKE_CURL_IMAGE}"
}

# Start the image under test plus the request sidecar, and wait until nginx
# answers. Extra arguments are passed straight to `docker run` (the csp smoke
# uses them for its harness mounts).
smoke_start() { # image [docker run args...]
  local image="$1"
  shift

  if ! docker image inspect "$SMOKE_CURL_IMAGE" >/dev/null 2>&1; then
    echo "==> pulling ${SMOKE_CURL_IMAGE} (request sidecar)"
    docker pull -q "$SMOKE_CURL_IMAGE" >/dev/null || {
      echo "FAIL: cannot pull ${SMOKE_CURL_IMAGE} - the checks run their requests from it."
      echo "      Set VP_SMOKE_CURL_IMAGE to an image with curl that this runner can reach."
      return 1
    }
  fi

  # nginx resolves its proxy upstreams (api/keycloak) at startup; the dummy
  # hosts keep it bootable without the backend stack. The port stays published
  # because the real-browser check needs a host-reachable URL - the assertions
  # no longer depend on it.
  SMOKE_CID="$(docker run -d --add-host api:127.0.0.1 --add-host keycloak:127.0.0.1 \
    -p 127.0.0.1::80 "$@" "$image")"

  SMOKE_SIDECAR="$(docker run -d --network "container:${SMOKE_CID}" \
    --entrypoint sleep "$SMOKE_CURL_IMAGE" 900)" || {
    echo "FAIL: could not attach the request sidecar to the container's network namespace"
    docker logs "$SMOKE_CID" 2>&1 | tail -20
    return 1
  }

  local i
  for i in $(seq 1 50); do
    req -fsS -o /dev/null "$BASE/" 2>/dev/null && break
    if [ "$i" -eq 50 ]; then
      echo "FAIL: nginx container never became ready"
      docker logs "$SMOKE_CID"
      return 1
    fi
    sleep 0.2
  done

  # Probe the published port from THIS job. The answer is the evidence for the
  # container-runner hypothesis above - and it decides whether the real-browser
  # check (which needs a host binary and therefore a host URL) can run.
  local port host_base="" reach="no"
  port="$(docker port "$SMOKE_CID" 80/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [ -n "$port" ]; then
    host_base="http://127.0.0.1:${port}"
    if command -v curl >/dev/null 2>&1 &&
      curl -fsS --max-time 5 -o /dev/null "$host_base/" 2>/dev/null; then
      reach="yes"
      # shellcheck disable=SC2034  # read by the sourcing script (csp-smoke.sh)
      SMOKE_HOST_BASE="$host_base"
    fi
  fi
  echo "    published port ${port:-<none>} reachable from this job: ${reach}"
  [ "$reach" = "no" ] && [ -n "$host_base" ] &&
    echo "    -> requests go through the sidecar (this is the run #183 failure mode)"
  return 0
}

# The ONE indirection the checks call instead of curl. Same arguments, same
# stdout, same exit status.
req() {
  docker exec "$SMOKE_SIDECAR" curl "$@"
}
