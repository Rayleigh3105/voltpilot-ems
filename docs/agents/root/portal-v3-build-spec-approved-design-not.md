# Portal v3 build spec (approved design, not yet built)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 110).


The owner-approved UX/UI rework of the customer portal (one navigation, live cockpit, mode profiles, two-capsule Steuerung, Node-RED-quality automations, Geräte→**Komponente**→Anlage plant model) has a milestone-based, agent-executable build spec in **[`docs/portal-v3/BUILD.md`](docs/portal-v3/BUILD.md)** (+ `M1-shell.md` … `M7-rollen.md`, one file per milestone: goal, scope, real file paths, acceptance criteria, tests, dependencies, gotchas). It carries the three LOCKED decisions (customer code edge-only + watchdog; our own editor at Node-RED quality deploying via flowc; the vocabulary is "Komponente"), the reuse-`EnergyFlow.tsx` refinement, the do-not-touch list and the branch/dress-rehearsal delivery strategy. Read it before starting any portal-v3 work.

**M1–M7 are BUILT on `main` (the per-milestone detail lives in `frontend/portal/AGENTS.md`).** The closing milestone **M7 (Rollen & Politur)** added the ONE technical-layer visibility helper `frontend/portal/src/rollen.ts` `showTechnicalLayer()` (today `isPlatformAdmin()`; owner decision: admin-only, no separate installer role — the future role plugs in there and nowhere else). Every technical/installer panel (entity types, raw channels, guard bands, Soll/Ist sync + drift, registry) gates on it, so a customer sees results + their wiring picture while a platform-admin sees the technical layer added on the SAME pages. A source-reading copy guard (`frontend/portal/src/copy.test.ts`) keeps the D3 dictionary (Gerät/Komponente/Messwert) and result-language regression-free. The v3 release still ships as one deploy after the owner's real-data dress rehearsal (BUILD.md §6/§7).

