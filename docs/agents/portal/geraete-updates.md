# Geräte & Updates

The Geräte sidebar entry opens `edge-updates`. `geraete-registry` remains the secondary Registrierung tab, including existing `?geraet=` links. `BoxVersions` leads with the newest release (by `releaseSeq`) and every connected box's reported version, target and server update status. It reuses `versionDisplay` and `releaseIsRunning`; a confirmed target is not necessarily the newest release.

Search, filters, release register and journal start collapsed. Registration has no onboarding KPI strip. Pending enrollments appear below the inventory in collapsed support details, omitted when empty, with an explicit error on failed fetch.

Update actions use the shared Modal. `UpdateActionError` focuses failed writes inside that modal because disabling the submit button drops focus in Chrome. `restingLine` also checks individual updates without a rollout. Registration keeps the shared `Blende` loading transition.

Verification: `pages/admin/EdgeUpdatesPage.test.tsx`, `GeraeteRegistryPage.test.tsx`, `GeraeteBereich.test.tsx`, navigation and shell suites. Browser coverage: `e2e/box-updates.spec.ts` with fictional in-memory fixtures in `box-updates.html`; no production requests.
