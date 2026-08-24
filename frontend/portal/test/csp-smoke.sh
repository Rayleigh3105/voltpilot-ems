#!/usr/bin/env bash
# CSP smoke: run the REAL built portal nginx image (with its production
# security headers) and prove the silent-SSO flow survives the CSP.
#
# Why this exists (real prod login outage, 2026-07-17): the nginx CSP is
# script-src 'self' WITHOUT 'unsafe-inline', and silent-check-sso.html used an
# inline <script>. The CSP silently blocked it, the iframe loaded but never
# postMessaged, keycloak-js init never settled, and every visitor hit the 10 s
# boot-timeout card. The #158 crew verified the prod BUILD but never the built
# image WITH its nginx headers - this script closes that gap.
#
# Checks (all against the running container, i.e. the real headers):
#   1. / carries the CSP; script-src has 'self' and NO 'unsafe-inline'
#      (the hardening must stay - fix victims, don't loosen the policy).
#   2. NO inline <script> anywhere the CSP governs: index.html and
#      silent-check-sso.html must only reference external scripts (a <script>
#      tag without src= under script-src 'self' is dead code = this outage).
#   3. /silent-check-sso.js is served and contains the postMessage.
#   4. /auth/ (proxied Keycloak) does NOT carry our CSP - Keycloak's login
#      pages govern their own headers; our header must stay scoped to the SPA.
#   5. The CSP names NO third-party font host, and the two Inter woff2 really
#      are served from OUR origin as hashed /assets. Both halves matter: the
#      allowlist may only shrink once the fonts are self-hosted (perf review
#      vp-cockpit-perf-p7 §2 U3), and a CSP without the hosts over a bundle
#      that still @imports Google would be a silently unstyled portal.
#   6. (real browser, when Chrome is found) a same-origin harness page iframes
#      /silent-check-sso.html?state=x and must receive the postMessage within
#      3 s under the real CSP. Skipped with a warning if no Chrome binary.
#
# Usage: test/csp-smoke.sh [image]
#   Without an image argument, builds the portal Dockerfile first.
#   SSO_HTML_OVERRIDE=/path/file.html mounts a replacement over
#   /usr/share/nginx/html/silent-check-sso.html (used to reproduce the outage:
#   point it at the old inline-script variant and the smoke must go RED).
set -euo pipefail

# Resolve the script's own directory BEFORE the cd, so sourcing never depends on
# how the script was invoked.
SMOKE_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SMOKE_HERE/.."
IMAGE="${1:-voltpilot-portal-csp-smoke}"
if [ $# -eq 0 ]; then
  echo "==> docker build ${IMAGE} (portal Dockerfile)"
  docker build -q -t "$IMAGE" . >/dev/null
fi

# Requests run inside a sidecar sharing the container's network namespace, not
# over a published port - see test/smoke-lib.sh for why (CI run #183).
# shellcheck source=./smoke-lib.sh
. "$SMOKE_HERE/smoke-lib.sh"

TMP="$(mktemp -d)"
cleanup() {
  smoke_stop
  rm -rf "$TMP"
}
trap cleanup EXIT

# Harness page + script for the real-browser check. Both EXTERNAL files served
# from the same origin, so the harness itself runs under the container's CSP.
cat >"$TMP/csp-harness.html" <<'EOF'
<!doctype html><html><body><script src="/csp-harness.js"></script></body></html>
EOF
cat >"$TMP/csp-harness.js" <<'EOF'
window.addEventListener('message', function (e) {
  if (typeof e.data === 'string' && e.data.indexOf('silent-check-sso') !== -1) {
    document.body.setAttribute('data-csp-smoke', 'PASS');
  }
});
var f = document.createElement('iframe');
f.src = '/silent-check-sso.html?state=x';
document.body.appendChild(f);
setTimeout(function () {
  if (!document.body.hasAttribute('data-csp-smoke')) {
    document.body.setAttribute('data-csp-smoke', 'FAIL');
  }
}, 3000);
EOF

MOUNTS=(-v "$TMP/csp-harness.html:/usr/share/nginx/html/csp-harness.html:ro"
        -v "$TMP/csp-harness.js:/usr/share/nginx/html/csp-harness.js:ro")
if [ -n "${SSO_HTML_OVERRIDE:-}" ]; then
  echo "==> overriding silent-check-sso.html with ${SSO_HTML_OVERRIDE}"
  MOUNTS+=(-v "${SSO_HTML_OVERRIDE}:/usr/share/nginx/html/silent-check-sso.html:ro")
fi

smoke_report_context
smoke_start "$IMAGE" "${MOUNTS[@]}" || exit 1

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok: $*"; }

echo "==> static header/content checks against $BASE"

# 1. CSP on the SPA, hardening intact.
CSP="$(req -fsS -D - -o /dev/null "$BASE/" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
[ -n "$CSP" ] || fail "no Content-Security-Policy header on /"
SCRIPT_SRC="$(printf '%s' "$CSP" | grep -oi "script-src [^;]*" || true)"
printf '%s' "$SCRIPT_SRC" | grep -q "'self'" || fail "script-src lacks 'self': $SCRIPT_SRC"
printf '%s' "$SCRIPT_SRC" | grep -qi "unsafe-inline" && fail "script-src allows 'unsafe-inline' - hardening was loosened: $SCRIPT_SRC"
pass "CSP present, script-src 'self' without 'unsafe-inline'"

# 2. No inline <script> in CSP-governed HTML (the outage class).
check_no_inline() { # url
  local body
  body="$(req -fsS "$BASE$1")"
  # any <script ...> opening tag without a src= attribute is an inline script
  if printf '%s' "$body" | tr '\n' ' ' | grep -oiE '<script[^>]*>' | grep -viq 'src='; then
    fail "$1 contains an inline <script> - blocked by script-src 'self' (this is the login outage)"
  fi
  pass "$1 has no inline scripts"
}
check_no_inline "/index.html"
check_no_inline "/silent-check-sso.html"

# 3. The external postMessage script is served.
req -fsS "$BASE/silent-check-sso.js" | grep -q "postMessage" \
  || fail "/silent-check-sso.js missing or lacks postMessage"
pass "/silent-check-sso.js served with postMessage"

# 4. Our CSP must not leak onto the proxied Keycloak responses.
AUTH_HDRS="$(req -sS -D - -o /dev/null "$BASE/auth/realms/voltpilot/" | tr -d '\r' || true)"
printf '%s' "$AUTH_HDRS" | grep -qi '^content-security-policy:' \
  && fail "/auth/ response carries our CSP header - it must stay scoped to the SPA locations"
pass "/auth/ carries no portal CSP header (Keycloak governs its own)"

# 5. Self-hosted fonts: the CSP must not name a third-party font host, and the
#    woff2 must actually come from this origin. A slimmer allowlist is only
#    honest if the bundle no longer reaches out - so both halves are asserted.
printf '%s' "$CSP" | grep -qi 'fonts\.googleapis\.com' \
  && fail "CSP still allows fonts.googleapis.com - the fonts are self-hosted, drop the host: $CSP"
printf '%s' "$CSP" | grep -qi 'fonts\.gstatic\.com' \
  && fail "CSP still allows fonts.gstatic.com - the fonts are self-hosted, drop the host: $CSP"
FONT_SRC="$(printf '%s' "$CSP" | grep -oi "font-src [^;]*" || true)"
printf '%s' "$FONT_SRC" | grep -q "'self'" || fail "font-src lacks 'self': $FONT_SRC"
pass "CSP names no third-party font host (font-src: $FONT_SRC)"

# The built CSS must reference the woff2 as same-origin hashed assets and must
# NOT @import a foreign stylesheet - that @import was the render-blocking,
# serial DNS+TLS hop this change removed.
CSS_HREF="$(req -fsS "$BASE/" | tr '<' '\n' | grep -oE 'href="/assets/index-[^"]+\.css"' \
            | head -1 | sed 's/^href="//; s/"$//' || true)"
[ -n "$CSS_HREF" ] || fail "no /assets/index-*.css referenced by the served index.html"
CSS_BODY="$(req -fsS "$BASE$CSS_HREF")"
printf '%s' "$CSS_BODY" | grep -qi 'fonts\.googleapis\.com' \
  && fail "$CSS_HREF still @imports fonts.googleapis.com"
printf '%s' "$CSS_BODY" | grep -qi 'fonts\.gstatic\.com' \
  && fail "$CSS_HREF still references fonts.gstatic.com"
FONT_COUNT=0
for f in $(printf '%s' "$CSS_BODY" | grep -oE '/assets/[A-Za-z0-9._-]+\.woff2' | sort -u); do
  CT="$(req -fsS -D - -o /dev/null "$BASE$f" | tr -d '\r' \
        | grep -i '^content-type:' | head -1 || true)"
  printf '%s' "$CT" | grep -qi 'font/woff2' \
    || fail "$f is not served as font/woff2 (got: ${CT:-nothing})"
  FONT_COUNT=$((FONT_COUNT + 1))
done
[ "$FONT_COUNT" -ge 2 ] \
  || fail "expected the two self-hosted Inter woff2 under /assets, found $FONT_COUNT"
pass "$FONT_COUNT self-hosted woff2 served from this origin, no Google @import in $CSS_HREF"

# 6. Real browser: the silent-SSO iframe must postMessage under the real CSP.
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "  WARN: no Chrome/Chromium binary found - skipping the real-browser postMessage check"
elif [ -z "$SMOKE_HOST_BASE" ]; then
  # A browser on this host cannot reach the container: the published port lands
  # on the docker host, and this job is not on it (see smoke-lib.sh). The four
  # static checks above ran at full strength through the sidecar - only this
  # one needs a host-reachable URL, so it is skipped LOUDLY rather than faked.
  echo "  WARN: the container's published port is not reachable from this job -"
  echo "        skipping the real-browser postMessage check (the static CSP checks all ran)"
else
  echo "==> real-browser silent-SSO check via $CHROME"
  # perl alarm = portable timeout (macOS has no coreutils timeout); some Chrome
  # builds linger after --dump-dom has printed, the verdict is already out.
  DOM="$(perl -e 'alarm 45; exec @ARGV' "$CHROME" --headless=new --disable-gpu --no-first-run \
        --user-data-dir="$TMP/chrome-profile" \
        --virtual-time-budget=6000 --dump-dom "$SMOKE_HOST_BASE/csp-harness.html" 2>/dev/null || true)"
  if printf '%s' "$DOM" | grep -q 'data-csp-smoke="PASS"'; then
    pass "silent-check-sso iframe postMessage received under the real CSP"
  elif printf '%s' "$DOM" | grep -q 'data-csp-smoke="FAIL"'; then
    fail "silent-check-sso iframe loaded but never postMessaged within 3 s (CSP-blocked script?)"
  else
    fail "browser harness produced no verdict (chrome run broken?)"
  fi
fi

echo "PASS: CSP smoke green"
