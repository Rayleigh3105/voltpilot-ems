# M7 · Rollen & Politur

> Realizes report §4 **P7** · concept tab **8 · Rollen & Umsetzung**.
> Read [`BUILD.md`](./BUILD.md) §4, §5 and §7 first. **This is the closing milestone.**

## Goal

Two views, **one product**: the end customer sees results and their wiring picture; installer/admin
see, **at the same place**, the technical layer on top (entity-type badges, raw channels, guard
bands, Soll/Ist sync + drift, registry). No second portal, no fork — same pages, additional panels.
Then the polish that makes v3 shippable: legacy route redirects, the 375 / 768 / 1440 proof, and a
copy sweep to the v3 rules (result language, "—" instead of 0, the D3 dictionary).

## Scope

**In**
- Role-gate every technical panel behind `isPlatformAdmin()` (plus a future installer role via ONE
  helper, so adding the role later is a one-line change).
- Legacy route redirects for everything v3 moved; a sweep that no `AnlagenSub` is orphaned.
- Responsive proof at 375 / 768 / 1440 across every v3 surface.
- Copy sweep + the guard tests that keep it from regressing.
- Documentation: root `AGENTS.md` + `frontend/portal/AGENTS.md` v3 entries.

**Out**
- No new features. If something is missing, it belongs in its own milestone.

## Files to change / create

| File | New? | What |
|---|---|---|
| `frontend/portal/src/rollen.ts` | edit | Add the **one** visibility helper `showTechnicalLayer(): boolean` (today `isPlatformAdmin()`; the future installer role plugs in here and nowhere else). Every technical panel imports it. |
| `frontend/portal/src/pages/AnlagenModellSection.tsx` | edit | Wrap the technical panels (entity type badges, raw channels, guard bands, sync/drift, registry) in `showTechnicalLayer()`. |
| `frontend/portal/src/pages/EntitaetenSection.tsx` | edit | Same gate on the panels it still owns. |
| `frontend/portal/src/pages/AnlageTechnik.tsx` | edit | The "Technische Details" disclosures stay for everyone (they are the customer's own device data); only platform-level internals move behind the gate. Do not over-hide. |
| `frontend/portal/src/nav.ts` | edit | Final legacy map: every retired v2 hash and sub redirects (`entitaeten → modell`, `optimierung → steuerung`, `#/standorte`, `#/geraete`, `#/live`, `#/fahrplan`, `#/historie`, `#/wetter` …). Nothing 404s. |
| `frontend/portal/src/copy.test.ts` | **new** | The copy guard: reads the customer-facing source files (`node:fs`, the `migration.test.ts` teardown-guard precedent) and fails on forbidden vocabulary — `Entität`, `Messpunkt`, `Quelle` (as an entity noun), `Mess-Einheit`, `Modul`, `MILP`, `Optimizer`, `Broker`, `Flow-Dokument`, `Anlagenteil` — outside `src/pages/admin/**` and the technical panels. |
| `frontend/portal/src/migration.test.ts` | edit | Final invariants: an un-migrated plant and a backend without the v3 routes render nothing new; `AnlageMoreMenu` does not exist; the M3 profile overlay is a no-op without rows. |
| `AGENTS.md` (root) + `frontend/portal/AGENTS.md` | edit | One durable entry per v3 area: the shell derivation, the widget pattern, the profile state + overlay, the two capsules, the editor's layout/hash rule + the D-16 code node, the Komponenten dictionary. Prune what v3 superseded (the M1 "Mehr ▾" interim note, the retired tab-bar notes). |

## Acceptance criteria

1. A customer token sees **no** entity type, raw channel, guard band, registry or sync/drift anywhere
   in the customer areas; a platform-admin sees them **on the same pages**, additively.
2. Exactly one helper decides that visibility (`showTechnicalLayer`), used by every panel — a grep
   finds no second role check in a page.
3. Every retired hash from v1/v2 resolves to its v3 home; a test round-trips every `AnlagenSub`.
4. Zero horizontal overflow at 375 / 768 / 1440 on: Cockpit, Live, Historie, Steuerung, Profile,
   Automationen (canvas may scroll **inside its own container**), Anlagen-Modell, Fahrplan,
   Marktpreise, Lastspitzen, Technik, Portfolio and an un-migrated plant. Measure with a real device
   emulation, not a window resize.
5. `copy.test.ts` is green and would fail on a re-introduced forbidden word.
6. No customer-facing number renders a fabricated `0`; missing values render "—" or the row is absent.
7. The whole-release acceptance list in `BUILD.md` §7 passes, including the real-data dress rehearsal.

## Tests to add / adjust

- `src/copy.test.ts` (**new**, source-reading vocabulary guard).
- `src/rollen.test.ts` — `showTechnicalLayer` for customer vs admin.
- `src/nav.test.ts` — the complete legacy map; every sub reachable from the M1 shell model.
- `src/migration.test.ts` — the consolidated v3 invariants (above).
- Component tests of the gated pages: a customer render contains no technical panel; an admin render
  does.

## Dependencies

**M1–M6** — M7 gates, redirects and sweeps what they built.

## Gotchas

- **Do not over-hide.** The customer's *own* device data (inverter model, capacity, controlling
  device, MaStR) belongs to them and stays visible behind the existing "Technische Details"
  disclosure. Only *platform* internals move behind the role.
- The copy guard must exclude `src/pages/admin/**`, the technical panels and `src/channels.ts`'s raw
  fallback — otherwise it fails on legitimate operator vocabulary. Scope it explicitly by path.
- The admin console chrome (`AdminPageHead`, the exact German empty-state strings `OptimizerPage.test.tsx`
  asserts) is **do-not-touch**; a careless copy sweep breaks those tests.
- Re-run `npm run test:csp` after any nginx/CSP-adjacent change; an inline script is silently blocked
  in prod and produced a full login outage once.
- Watch the esbuild "unbalanced {" warning while consolidating CSS — it silently swallows every later
  rule (BUILD.md §4.7).
- Keep the AGENTS.md entries **concise and durable**; prune superseded bullets rather than appending.
