# Portal-Admin ("Plattform") UX assessment

Assessment of the whole Portal-Admin surface a `platform-admin` sees, and the
plan for the improvements shipped in `fm/vp-admin-ux-x8`. Scope: the shell/nav
as the admin experiences it (`src/shell/AppShell.tsx`, `src/nav.ts`, the top-bar
tenant switcher) and the four Plattform pages (`src/pages/admin/*`: Mandanten,
Benutzer, Geräte-Registry, Optimizer).

Grounding: read against the real components + tokens + `docs/ui-quality-pass.md`
conventions, cross-checked with a faithful standalone HTML rendering built from
the real tokens (`docs/admin-ux-mockup.html`, before/after + the recommended
"Plattform-Übersicht" swing). No live backend/browser was available in this
environment (Docker + browser tooling blocked), so the honest limit is: layout,
hierarchy, tokens and copy were assessed statically and via the mockup, not by
clicking a running portal. `npm run typecheck && build && test` keep it honest.

---

## TL;DR

The Plattform surface is **correctly built on the design system and functionally
complete**, but it reads as **two tiers**. The just-merged **Optimizer** page is
a polished operator console — verdict banner, "glance" cards, titled sections,
`InfoTip`s, designed loading/empty/error states. The three older pages
(**Mandanten / Benutzer / Geräte-Registry**) are competent but **plain CRUD
tables**: thin headers, bare grey "nichts vorhanden" cards, no at-a-glance
platform pulse, and — across the group — **three different tenant pickers and
three different row-action patterns**. The admin's single most important tool,
the top-bar **tenant switcher**, is a weak, caret-less, unlabeled pill.

The work here raises the three older pages to the Optimizer's polish level and
makes the whole group read as one console, **without any behavior/data/routing
change**.

---

## What's strong (keep)

1. **Design-system discipline.** Everything is tokens + `Card`/`Badge`/`Modal`/
   `RowMenu`/`IconTile`, the `States.tsx` skeletons + `ErrorState`, the `Icon`
   component, and `format.ts`. No emoji glyphs, essentially no rogue hex.
2. **The list-in-card + centred-`Modal` pattern** is consistent and appropriate for
   entity management (create modal, detail modal, inline edit, `DangerZone`). It
   was a right-side drawer until 04.09.2026; the captain retired sidebars, so the
   same panel is now centred — see `frontend/portal/AGENTS.md` "Keine Seitenleisten".
3. **Careful German copy** and the internal-name discipline (no broker/RLS/
   Keycloak vocabulary leaking to the surface).
4. **The Optimizer page is genuinely good** — it is the right bar for the rest.
5. **Per-page loading/error/empty handling** already exists (skeletons, retryable
   `ErrorState`, load-error kept distinct from action-error), and the
   RLS-safe tenant-switcher plumbing is solid.

## What's weak (prioritized)

| # | Finding | Where |
|---|---------|-------|
| **P1** | **No platform pulse / at-a-glance.** The admin's first Plattform click (Mandanten) is a raw table — no totals, no segment mix, no sense of scale. A platform operator cannot gauge the platform at a glance. | Mandanten (de-facto landing) |
| **P2** | **Under-designed placeholder states.** ~7 bare `<Card><p class="vp-muted">…</p></Card>` sentences for "nothing yet / pick a tenant", while the design system ships a polished `EmptyState` (IconTile + heading + copy + CTA) used elsewhere in the app. Flat and inconsistent. | all 4 pages |
| **P3** | **The tenant switcher is visually weak & unlabeled.** The admin's core cross-tenant tool is a thin, caret-less pill defaulting to "Alle Mandanten" — a new admin would not recognize it as the key control. And there are **three** different tenant-selection UIs: the top-bar pill, the Benutzer page-head `<select>`, the Optimizer labeled-card `<select>`. | shell + Benutzer + Optimizer |
| **P4** | **Inconsistent, thin page headers.** Bare `h1 + p`; the Plattform group does not read as one iconed operator console. | all 4 pages |
| **P5** | **Three row-action patterns.** Benutzer = `RowMenu` (⋯ popover); Mandanten = whole-row-click **plus** a redundant "Details" ghost button; Geräte-Registry = an inline ghost button with a hand-set red `style`. | Mandanten, Benutzer, Registry |
| **P6** | **Scattered inline styles** for recurring chrome (the segment-`<select>` label is hand-styled with the same `{fontSize,fontWeight}` in 3 places; ad-hoc flex gaps in section heads). | Mandanten, Registry |
| **P7** | **Low-value column eats scan space.** The Mandant-ID mono column (`id.slice(0,8)…`) is prominent in the table for a value an operator rarely needs at a glance. | Mandanten |

---

## Shipped now (safe, design-system-only, no behavior change)

1. **Shared `AdminPageHead`** (IconTile + title + description + actions slot) on
   **all four** Plattform pages → they read as one operator console, and the
   older pages gain the visual weight the Optimizer already had. (P4)
2. **Polished `EmptyState`** for every bare placeholder across the four pages
   (Mandanten empty, Benutzer no-tenant + empty, Registry empty, Optimizer
   pick-tenant + pick-site + no-run), preserving the exact copy the tests
   assert. (P2)
3. **Tenant-switcher polish** in the top bar: a `building` icon + a `chevron-down`
   caret + a "Mandant" affordance around the native `<select>`, so the admin's
   core control is unmistakable and clearly a dropdown. Behavior unchanged. (P3)
4. **A platform pulse strip on Mandanten** (the landing): Mandanten total +
   Privat/Gewerbe split, derived purely from the in-hand `tenants` array — **no
   new API call, no new data**. Pure `tenantPulse()` (unit-tested). (P1, honest
   partial — see the bigger swing below for the real cross-tenant version.)
5. **Row-action consistency polish** (P5): on Mandanten the redundant word
   "Details" becomes a clear `chevron-right` drill-in affordance (row-click
   preserved); the Registry destructive action drops the inline-red `style` hack
   for the shared danger treatment.
6. **Removed low-value chrome / inline styles** where it improved scannability
   (P6/P7): the Mandant-ID moves to a quieter position, and the repeated
   hand-styled `<select>` label is replaced by the design-system label class.

All of the above is presentation only — no API calls, routing, auth, tenancy or
business logic changed; every existing feature keeps working, and the
OptimizerPage/AppShell test suites stay green (new tests added for
`AdminPageHead`, the switcher, and `tenantPulse`).

## Bigger swings — the captain decides later (mocked/described, NOT shipped)

These are taste-dependent or need backend/routing changes, so they are proposed,
not shipped:

- **A dedicated "Plattform-Übersicht" landing** (new nav entry + a real
  cross-tenant KPI endpoint): active tenants, devices online platform-wide,
  pending enrollments, tenants with a battery-without-device, today's platform
  savings. This is the *real* fix for P1 but needs an API + a route, i.e. beyond
  "no behavior change". Mocked in `docs/admin-ux-mockup.html`.
- **Search / filter / sort** on the Mandanten / Benutzer / Registry tables — the
  tables have no affordance for scale beyond one screenful.
- **Bulk actions** (multi-select provisioning; bulk user enable/disable).
- **One shared tenant picker** driven by the top-bar context, so a page never
  re-asks for a tenant it already has (retires the 2 extra pickers).
- **Per-tenant health column** on Mandanten (devices online / total, last-seen)
  once a lightweight aggregate endpoint exists.
