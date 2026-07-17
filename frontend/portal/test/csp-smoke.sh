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
#   5. (real browser, when Chrome is found) a same-origin harness page iframes
#      /silent-check-sso.html?state=x and must receive the postMessage within
#      3 s under the real CSP. Skipped with a warning if no Chrome binary.
#
# Usage: test/csp-smoke.sh [image]
#   Without an image argument, builds the portal Dockerfile first.
#   SSO_HTML_OVERRIDE=/path/file.html mounts a replacement over
#   /usr/share/nginx/html/silent-check-sso.html (used to reproduce the outage:
#   point it at the old inline-script variant and the smoke must go RED).
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="${1:-voltpilot-portal-csp-smoke}"
if [ $# -eq 0 ]; then
  echo "==> docker build ${IMAGE} (portal Dockerfile)"
  docker build -q -t "$IMAGE" . >/dev/null
fi

TMP="$(mktemp -d)"
CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
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

# nginx resolves the proxy upstreams (api/keycloak) at startup; dummy hosts
# keep it bootable without the backend stack.
CID="$(docker run -d --add-host api:127.0.0.1 --add-host keycloak:127.0.0.1 \
  -p 127.0.0.1::80 "${MOUNTS[@]}" "$IMAGE")"
PORT="$(docker port "$CID" 80/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:${PORT}"

for i in $(seq 1 50); do
  curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
  [ "$i" -eq 50 ] && { echo "FAIL: nginx container never became ready"; docker logs "$CID"; exit 1; }
  sleep 0.2
done

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok: $*"; }

echo "==> static header/content checks against $BASE"

# 1. CSP on the SPA, hardening intact.
CSP="$(curl -fsS -D - -o /dev/null "$BASE/" | tr -d '\r' | grep -i '^content-security-policy:' || true)"
[ -n "$CSP" ] || fail "no Content-Security-Policy header on /"
SCRIPT_SRC="$(printf '%s' "$CSP" | grep -oi "script-src [^;]*" || true)"
printf '%s' "$SCRIPT_SRC" | grep -q "'self'" || fail "script-src lacks 'self': $SCRIPT_SRC"
printf '%s' "$SCRIPT_SRC" | grep -qi "unsafe-inline" && fail "script-src allows 'unsafe-inline' - hardening was loosened: $SCRIPT_SRC"
pass "CSP present, script-src 'self' without 'unsafe-inline'"

# 2. No inline <script> in CSP-governed HTML (the outage class).
check_no_inline() { # url
  local body
  body="$(curl -fsS "$BASE$1")"
  # any <script ...> opening tag without a src= attribute is an inline script
  if printf '%s' "$body" | tr '\n' ' ' | grep -oiE '<script[^>]*>' | grep -viq 'src='; then
    fail "$1 contains an inline <script> - blocked by script-src 'self' (this is the login outage)"
  fi
  pass "$1 has no inline scripts"
}
check_no_inline "/index.html"
check_no_inline "/silent-check-sso.html"

# 3. The external postMessage script is served.
curl -fsS "$BASE/silent-check-sso.js" | grep -q "postMessage" \
  || fail "/silent-check-sso.js missing or lacks postMessage"
pass "/silent-check-sso.js served with postMessage"

# 4. Our CSP must not leak onto the proxied Keycloak responses.
AUTH_HDRS="$(curl -sS -D - -o /dev/null "$BASE/auth/realms/voltpilot/" | tr -d '\r' || true)"
printf '%s' "$AUTH_HDRS" | grep -qi '^content-security-policy:' \
  && fail "/auth/ response carries our CSP header - it must stay scoped to the SPA locations"
pass "/auth/ carries no portal CSP header (Keycloak governs its own)"

# 5. Real browser: the silent-SSO iframe must postMessage under the real CSP.
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "  WARN: no Chrome/Chromium binary found - skipping the real-browser postMessage check"
else
  echo "==> real-browser silent-SSO check via $CHROME"
  # perl alarm = portable timeout (macOS has no coreutils timeout); some Chrome
  # builds linger after --dump-dom has printed, the verdict is already out.
  DOM="$(perl -e 'alarm 45; exec @ARGV' "$CHROME" --headless=new --disable-gpu --no-first-run \
        --user-data-dir="$TMP/chrome-profile" \
        --virtual-time-budget=6000 --dump-dom "$BASE/csp-harness.html" 2>/dev/null || true)"
  if printf '%s' "$DOM" | grep -q 'data-csp-smoke="PASS"'; then
    pass "silent-check-sso iframe postMessage received under the real CSP"
  elif printf '%s' "$DOM" | grep -q 'data-csp-smoke="FAIL"'; then
    fail "silent-check-sso iframe loaded but never postMessaged within 3 s (CSP-blocked script?)"
  else
    fail "browser harness produced no verdict (chrome run broken?)"
  fi
fi

echo "PASS: CSP smoke green"
