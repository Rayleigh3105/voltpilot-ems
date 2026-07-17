// Keycloak silent SSO check: report the redirect result to the opener frame.
// Kept as an EXTERNAL file because the nginx CSP is script-src 'self' with no
// 'unsafe-inline' - an inline <script> here is silently blocked, the postMessage
// never fires, keycloak-js init never settles and every visitor hits the boot
// timeout (real prod outage, 2026-07-17).
parent.postMessage(location.href, location.origin);
