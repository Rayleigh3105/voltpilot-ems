#!/usr/bin/env bash
# Cache smoke: run the REAL built portal nginx image and prove its cache policy.
#
# Why this exists (captain report, 2026-07-30): nginx's `location /` set NO
# Cache-Control at all, so the browser fell back to heuristic freshness, reused a
# cached index.html without revalidating, and that stale document pulled the old
# hashed bundles from cache too - a reload after a deploy rendered the PREVIOUS
# version of the whole app. The policy now lives in nginx.conf; this script is
# its proof against the running container (i.e. the real headers).
#
# Checks:
#   1. /            -> Cache-Control: no-cache (revalidate every time), and NOT
#                      no-store (a 304 must stay possible).
#   2. /index.html  -> same.
#   3. an unknown SPA route (the try_files fallback) -> same, because a fallback
#      that cached would resurrect the whole old app exactly like index.html.
#   4. the hashed bundle Vite actually emitted (parsed out of index.html, never
#      guessed) -> public, max-age=31536000, immutable.
#   5. unhashed extras (/favicon.svg, /silent-check-sso.js) -> no-cache; they
#      keep their filename across releases, so immutable would pin them forever.
#   6. the SECURITY headers survive on every one of those responses - nginx does
#      not inherit add_header into an inner block (`location /assets/` exists
#      now and had to repeat the whole set). This is the guard for that trap.
#   7. a conditional request (If-None-Match) on / really answers 304 - i.e. the
#      policy costs a revalidation, not a full transfer.
#   8. a VANISHED hashed bundle -> hard 404 with no-cache + security headers,
#      never the SPA fallback: 200 + index.html under a .js URL gets cached by
#      CDNs/browsers (Cloudflare stamps its default browser TTL onto it,
#      live-measured 2026-08-04) and poisons the URL for hours - and the 404
#      must never carry the immutable policy, or a deploy race (new index.html,
#      old pod) would pin the miss for a year.
#
# Usage: test/cache-smoke.sh [image]
#   Without an image argument, builds the portal Dockerfile first.
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="${1:-voltpilot-portal-cache-smoke}"
if [ $# -eq 0 ]; then
  echo "==> docker build ${IMAGE} (portal Dockerfile)"
  docker build -q -t "$IMAGE" . >/dev/null
fi

CID=""
cleanup() { [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# nginx resolves the proxy upstreams (api/keycloak) at startup; dummy hosts keep
# it bootable without the backend stack.
CID="$(docker run -d --add-host api:127.0.0.1 --add-host keycloak:127.0.0.1 \
  -p 127.0.0.1::80 "$IMAGE")"
PORT="$(docker port "$CID" 80/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:${PORT}"

for i in $(seq 1 50); do
  curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
  [ "$i" -eq 50 ] && { echo "FAIL: nginx container never became ready"; docker logs "$CID"; exit 1; }
  sleep 0.2
done

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok: $*"; }

hdrs() { curl -fsS -D - -o /dev/null "$BASE$1" | tr -d '\r'; }
header_of() { printf '%s' "$2" | grep -i "^$1:" | head -1 | cut -d: -f2- | sed 's/^ *//'; }

# The security headers must ride along on EVERY response the SPA location serves.
assert_security_headers() { # url headers
  local u="$1" h="$2" name
  for name in content-security-policy x-content-type-options x-frame-options referrer-policy; do
    printf '%s' "$h" | grep -qi "^${name}:" \
      || fail "$u lost the $name header - nginx add_header does not inherit into inner blocks"
  done
  pass "$u keeps CSP + X-Content-Type-Options + X-Frame-Options + Referrer-Policy"
}

assert_no_cache() { # url
  local h cc
  h="$(hdrs "$1")"
  cc="$(header_of cache-control "$h")"
  [ "$cc" = "no-cache" ] || fail "$1: expected 'Cache-Control: no-cache', got '${cc:-<none>}'"
  printf '%s' "$cc" | grep -qi 'no-store' && fail "$1: no-store would forbid even a cheap 304"
  pass "$1 -> Cache-Control: no-cache"
  assert_security_headers "$1" "$h"
}

assert_immutable() { # url
  local h cc
  h="$(hdrs "$1")"
  cc="$(header_of cache-control "$h")"
  [ "$cc" = "public, max-age=31536000, immutable" ] \
    || fail "$1: expected the immutable one-year policy, got '${cc:-<none>}'"
  pass "$1 -> Cache-Control: $cc"
  assert_security_headers "$1" "$h"
}

echo "==> cache-policy checks against $BASE"

assert_no_cache "/"
assert_no_cache "/index.html"
# The SPA fallback: an unknown route is answered with index.html via try_files.
assert_no_cache "/anlage/00000000-0000-0000-0000-000000000000/steuerung"
assert_no_cache "/favicon.svg"
assert_no_cache "/silent-check-sso.js"

# Take the hashed bundles from the served index.html - never hardcode a hash.
INDEX="$(curl -fsS "$BASE/")"
ASSETS="$(printf '%s' "$INDEX" | grep -oE '/assets/[A-Za-z0-9._-]+' | sort -u)"
[ -n "$ASSETS" ] || fail "index.html references no /assets/* bundle - did the Vite output dir change?"
for a in $ASSETS; do
  assert_immutable "$a"
done

# A vanished hashed bundle is a hard 404 (check 8). hdrs() cannot be reused
# here - its curl -f fails on 4xx - so the status and headers are read without -f.
MISS="/assets/index-does-not-exist-$$.js"
MISS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$MISS")"
[ "$MISS_CODE" = "404" ] \
  || fail "$MISS answered $MISS_CODE, expected 404 - the SPA fallback would serve HTML under a .js URL and poison caches"
MISS_H="$(curl -sS -D - -o /dev/null "$BASE$MISS" | tr -d '\r')"
MISS_CC="$(header_of cache-control "$MISS_H")"
[ "$MISS_CC" = "no-cache" ] \
  || fail "$MISS: the 404 must carry 'Cache-Control: no-cache' (never immutable), got '${MISS_CC:-<none>}'"
pass "$MISS -> 404 with Cache-Control: no-cache"
assert_security_headers "$MISS" "$MISS_H"

# The revalidation must really be cheap: same ETag -> 304, no body.
ETAG="$(header_of etag "$(hdrs "/")")"
[ -n "$ETAG" ] || fail "/ carries no ETag - 'no-cache' would then mean a full transfer every time"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$BASE/")"
[ "$CODE" = "304" ] || fail "/ with a matching If-None-Match answered $CODE, expected 304"
pass "/ revalidates to 304 with a matching ETag"

echo "PASS: cache smoke green"
