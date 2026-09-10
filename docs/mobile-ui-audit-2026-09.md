# Mobile UI audit — September 2026

## Outcome

An implementation and browser review of the portal, its Keycloak login theme,
and the local Edge-App. Existing VoltPilot styling and navigation are retained.
No API, database, device-control semantics, or production deployment changes.

## Findings and changes

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Device claiming loses focus after the first typed character | Browser typing `edge-abcdefj` produced only `e`. The drawer effect reran whenever its inline close callback changed. | Keep the latest callback in a ref; acquire/release focus and scroll lock only when opening/closing. |
| First registration tap can be lost on phones | At the Pixel 5 viewport, pointer-down hit the submit button; blur inserted validation text; pointer-up hit the form after the button moved. | Invalid submits keep focus through mouse-down so the click reaches the button, then focus the first invalid field. Verified with actual Playwright touch taps in Chromium/WebKit. |
| Drawer keyboard focus escapes into the page | The standard portal drawer lacked a Tab boundary; the Edge source drawer also lacked Escape and return-focus behavior. | Contain keyboard focus, preserve nested picker handling, restore focus on close. Edge remembers the actual opener because Safari taps do not focus buttons. |
| Validation callbacks overwrite Input focus handling | Spreading `onFocus`/`onBlur` after internal handlers bypassed them, leaving focus rings on blurred fields. | Compose callbacks; preserve error/hint descriptions and expose invalid state to assistive technology. |
| Small text has insufficient contrast | Active navigation: 3.28:1 on white; password success hint: 2.78:1; copied muted text: 4.45:1 on the page background. | Use existing action/success/error ink colors; synchronize copied muted tokens in Keycloak and Edge (4.72:1). Focus borders use action ink and no longer become paler on focus. |
| Mobile editable text is undersized | Edge connection/model/rename/settings fields: 13.8–15 px; portal settings search: 14.72 px. | 16 px editable text on phones; preserve desktop sizing on Edge. Physical iOS automatic zoom still needs device verification. |
| Full-screen drawer chrome lacks complete safe-area protection | Portal lacked top/left padding; Edge lacked safe-area padding. | Add missing safe-area padding and prevent headers/footers shrinking into the scrollable body. Landscape action visibility is browser-tested. |
| Edge fields and icon buttons are difficult to locate/use | Connection fields/pickers used the decorative card border; icon buttons were 32 px. | Use the copied field-border token for editable controls; 44 px icon touch targets. |
| Admin mobile summary delays the records | At 375 px, the first tenant card began around y=778. | Compact summary padding and type, align the header icon to its heading. First tenant card begins around y=639. |

## Coverage and limits

- Isolated Compose project `vp-ui-audit`, fresh demo database; a separate Edge core with a fresh temporary data directory and cloud enrollment pointed to localhost. No production accounts or hardware used.
- 54 portal route visits across three seeded sites and nine admin destinations. Chromium: 320/375/390/430/768/834/1440 px. WebKit: 320/375/834/1440 px. This is a route/state sweep, not a claim that every possible state has been exercised.
- Supplemental checks cover the canonical portfolio measurement/earnings routes and a device detail page in both engines at all seven widths. Legacy aliases in the first sweep resolved normally.
- No page-level horizontal overflow or uncaught page exceptions detected in those sweeps. Intentional table/tab/chart scrolling is excluded from the overflow findings.
- Browser interaction regressions cover device claiming, device editing, registration validation, wallbox actions/retries/offline behavior, nested pickers, keyboard focus and phone landscape.
- Edge browser checks exercise the real Go-served setup UI and catalog, source drawer, model search, phone text sizes and landscape actions in both engines. No configuration is saved or hardware commanded.
- Keycloak login rendered and used in both engines. OTP, password update/reset, expired-login and logout templates were source-reviewed; those entire server-side journeys were not exercised.
- Some seeded screens have empty/unavailable data. Full admin flow editing/rollouts, real device responses, physical iPhone keyboards/safe areas, assistive-technology sessions, and every possible modal/error combination remain outside the verified set.

## Larger issues for a joint decision

1. **Advanced Edge setup is too long for routine mobile onboarding.** The Deye connection form exposes firmware write codes, remote-mode strategy, watchdog and lengthy explanations together with IP/serial fields. Recommended: a collapsed “Erweiterte Einstellungen” section, retaining all values and controls. This is a flow change and remains deferred pending the user's answer; no fields have been hidden.
2. **The portal entry bundle was large on the audited revision.** That production build reported about 1.73 MB raw / 565 kB gzip for its main JavaScript chunk. The newer main revision has already reduced it to about 751 kB raw / 241 kB gzip; this audit does not claim credit for that change. A separate measured mobile startup-performance pass can determine whether more work is warranted. The remaining size warning alone is not a measured loading-time regression.

## Reproduction and checks

```sh
cd frontend/portal
npm ci
npx playwright install chromium webkit
npm test
npm run test:e2e
npm run build

# From the repository root; starts/stops its own isolated core:
node edge-app/test/ui-mobile.mjs
cd edge-app/core
go test ./internal/web
```

Results: 284 unit/component test files, 5,413 tests passed; 52 portal browser
checks passed across desktop/tablet/mobile Chromium and mobile WebKit. The
registration checks additionally passed with touch taps. Edge browser checks
passed in both engines; Go web tests and the portal production build passed.
Build retains its bundle-size warning.

The visual review and local screenshots are in `.lavish/mobile-ui-review.html`.
Existing unrelated working-tree edits were preserved. The audit did not deploy
changes to production; the checks above describe the original audited revision.

## Integration into main

Integrated onto `4a7f9e7c` in an isolated worktree. Newer main had already
replaced the portal Drawer with the centered Modal and fixed focus retention,
focus-border contrast, and Playwright artifact ignores. Those changes were
retained rather than reintroducing the old Drawer. Safe-area and non-shrinking
header/footer changes were applied to the current Modal stylesheet.

Post-integration checks: 37 focused unit/component tests, 48 portal browser
checks (Chromium and WebKit), the isolated Edge browser checks in both engines,
and the production build passed. The no-mistakes pipeline was explicitly
skipped at the user's request. No deployment was triggered.
