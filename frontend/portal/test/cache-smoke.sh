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
#   9. the App-Huelle (PWA): /manifest.webmanifest, /sw.js, /offline.html and the
#      icons -> no-cache + the security headers, exactly like the other unhashed
#      files. A cached sw.js would pin the whole shell (the browser only updates
#      a worker when its BYTES change), and an immutable manifest/icon would
#      outlive a rebrand.
#  10. the manifest carries `application/manifest+json` AND a hashed .css still
#      carries text/css. nginx's `types` REPLACES the inherited map when it is
#      declared on an inner level; the config adds the one mapping at the http
#      level so it only ACCUMULATES - this check is the guard for that trap.
#
# Usage: test/cache-smoke.sh [image]
#   Without an image argument, builds the portal Dockerfile first.
set -euo pipefail

# Resolve the script's own directory BEFORE the cd, so sourcing never depends on
# how the script was invoked.
SMOKE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SMOKE_HERE/.."
IMAGE="${1:-voltpilot-portal-cache-smoke}"
if [ $# -eq 0 ]; then
  echo "==> docker build ${IMAGE} (portal Dockerfile)"
  docker build -q -t "$IMAGE" . >/dev/null
fi

# Requests run inside a sidecar sharing the container's network namespace, not
# over a published port - see test/smoke-lib.sh for why (CI run #183).
# shellcheck source=./smoke-lib.sh
. "$SMOKE_HERE/smoke-lib.sh"

trap smoke_stop EXIT

smoke_report_context
smoke_start "$IMAGE" || exit 1

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok: $*"; }

hdrs() { req -fsS -D - -o /dev/null "$BASE$1" | tr -d '\r'; }
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

# Check 9: the App-Huelle. Same policy as every other unhashed file - a cached
# sw.js would pin the whole shell until its bytes change.
for f in /manifest.webmanifest /sw.js /offline.html \
         /icons/icon-192.png /icons/icon-512.png /icons/icon-maskable-512.png \
         /icons/apple-touch-icon-180.png; do
  assert_no_cache "$f"
done

# Check 10: the MIME trap. The manifest needs its own type, and adding it must
# NOT have replaced the inherited mime.types map for everything else.
MANIFEST_TYPE="$(header_of content-type "$(hdrs /manifest.webmanifest)")"
case "$MANIFEST_TYPE" in
  application/manifest+json*) pass "/manifest.webmanifest -> Content-Type: $MANIFEST_TYPE" ;;
  *) fail "/manifest.webmanifest: expected application/manifest+json, got '${MANIFEST_TYPE:-<none>}'" ;;
esac

# Take the hashed bundles from the served index.html - never hardcode a hash.
INDEX="$(req -fsS "$BASE/")"
ASSETS="$(printf '%s' "$INDEX" | grep -oE '/assets/[A-Za-z0-9._-]+' | sort -u)"
[ -n "$ASSETS" ] || fail "index.html references no /assets/* bundle - did the Vite output dir change?"
for a in $ASSETS; do
  assert_immutable "$a"
done

# The other half of check 10: the shipped mime.types map is still intact. An
# inner `types` block would have stripped these down to octet-stream.
for a in $ASSETS; do
  ATYPE="$(header_of content-type "$(hdrs "$a")")"
  case "$a" in
    *.css)
      case "$ATYPE" in
        text/css*) pass "$a -> Content-Type: $ATYPE" ;;
        *) fail "$a: expected text/css, got '${ATYPE:-<none>}' - did a 'types' block replace mime.types?" ;;
      esac
      ;;
    *.js)
      case "$ATYPE" in
        */javascript*) pass "$a -> Content-Type: $ATYPE" ;;
        *) fail "$a: expected a javascript type, got '${ATYPE:-<none>}' - did a 'types' block replace mime.types?" ;;
      esac
      ;;
  esac
done

# A vanished hashed bundle is a hard 404 (check 8). hdrs() cannot be reused
# here - its curl -f fails on 4xx - so the status and headers are read without -f.
MISS="/assets/index-does-not-exist-$$.js"
MISS_CODE="$(req -sS -o /dev/null -w '%{http_code}' "$BASE$MISS")"
[ "$MISS_CODE" = "404" ] \
  || fail "$MISS answered $MISS_CODE, expected 404 - the SPA fallback would serve HTML under a .js URL and poison caches"
MISS_H="$(req -sS -D - -o /dev/null "$BASE$MISS" | tr -d '\r')"
MISS_CC="$(header_of cache-control "$MISS_H")"
[ "$MISS_CC" = "no-cache" ] \
  || fail "$MISS: the 404 must carry 'Cache-Control: no-cache' (never immutable), got '${MISS_CC:-<none>}'"
pass "$MISS -> 404 with Cache-Control: no-cache"
assert_security_headers "$MISS" "$MISS_H"

# The revalidation must really be cheap: same ETag -> 304, no body.
ETAG="$(header_of etag "$(hdrs "/")")"
[ -n "$ETAG" ] || fail "/ carries no ETag - 'no-cache' would then mean a full transfer every time"
CODE="$(req -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$BASE/")"
[ "$CODE" = "304" ] || fail "/ with a matching If-None-Match answered $CODE, expected 304"
pass "/ revalidates to 304 with a matching ETag"

echo "PASS: cache smoke green"
