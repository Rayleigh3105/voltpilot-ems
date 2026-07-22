# M1 · Shell & Navigation

> Realizes report §4 **P1** · concept tab **2 · Shell & Navigation**.
> Read [`BUILD.md`](./BUILD.md) §4 (global conventions) and §5 (do-not-touch) first.

## Goal

Give an Anlage **one** navigation. The sidebar shows every area of the selected plant openly,
grouped into **Anlage** (Cockpit · Live-Daten · Historie · Steuerung · Anlagen-Modell) plus **one
coloured group per active mode profile** (`Modus · Marktoptimierung` → Fahrplan · Marktpreise ·
Prognosequalität; `Modus · Gewerbe` → Lastspitzen), with Einstellungen · Hilfe in the foot. The
"Mehr ▾" popover and every remaining tab strip disappear. The top bar gains a **Health-Badge** (one
aggregated plant state: OK / Hinweis / Warnung). Phones get a **5-slot bottom bar** (Cockpit · Live ·
Steuerung · Anlage · Mehr-Sheet); tablets get a 56 px **icon rail** instead of a hamburger.
Routes are untouched — every bookmark keeps working.

## Scope

**In**
- Sidebar group model derived from `surface.ts` (`activeModes` + each manifest's `deepViews`).
- The Anlage context card (name + health line; tap = switcher, "Alle Anlagen" → fleet/portfolio).
- Health badge: a new pure derivation + its render in the top bar.
- Bottom bar 5 slots + a "Mehr" sheet; tablet icon rail (721–1023 px).
- Delete `components/AnlageMoreMenu.tsx` and every use of it.
- Wetter loses its nav entry (it becomes a cockpit card + drill-in in M2); its **route stays**.

**Out**
- Any page CONTENT change (cockpit is M2, Steuerung M4, Anlagen-Modell M6). M1 only mounts the
  existing pages under the new nav. The `Anlagen-Modell` sidebar entry points at the existing
  `entitaeten` sub until M6 renames/replaces it.
- The profile shelf and profile state (M3) — M1 reads the *derived* modes only.
- Role gating of technical panels (M7).

## Files to change / create

| File | New? | What changes |
|---|---|---|
| `frontend/portal/src/anlageNav.ts` | edit | Replace `anlageTrio` with **`anlageSidebar(surface, activeModeCount)`** returning the grouped model: a `base` group (`cockpit · live · historie · steuerung · anlagen-modell`) + `ModeNavGroup[]` (one per active mode, with a colour key + its `deepViews`). Keep `resolveAnlage` and `activeAreaKey` (extend the latter to the five base areas). Add `bottomBarSlots(...)` (5 slots incl. the "Mehr" sheet) and `moreSheetItems(...)` (everything not in the bottom bar). **Delete `DEEP_VIEW_ITEMS`** — its members become real sidebar entries or Mehr-sheet items. |
| `frontend/portal/src/health.ts` | edit | Add **`healthBadge(input): {state: 'ok'|'hinweis'|'warnung', label, detail}`** aggregating the existing `healthChecklist` items (any `warn` → warnung, any `off` → hinweis, else ok) plus entity sync drift when available. Pure; `healthChecklist` stays as-is (M2/M7 keep using it). |
| `frontend/portal/src/shell/AppShell.tsx` | edit | Render the grouped sidebar (group label + items), the Anlage context card, the health badge in the top bar, the 5-slot bottom bar + Mehr sheet, and the tablet icon rail. The `AnlageNav` prop type grows `groups: SidebarGroup[]`, `health: HealthBadge | null`, `onOpenPage: (page: PageId) => void`. |
| `frontend/portal/src/App.tsx` | edit | Build the new nav model around line ~575 (today: `shellSite` → `useAnlageSurface` → `anlageTrio`/`modeNavGroup`). Feed `anlageSidebar(surface)` and the health badge (compose its input from the already-fetched overview row + schedule/control state; every fetch stays `.catch`-ed). |
| `frontend/portal/src/nav.ts` | edit | Keep every existing route. Only additions: a `MORE_SHEET` grouping helper if needed; `MAIN_PAGES` unchanged. **No PageId is removed.** |
| `frontend/portal/src/components/AnlageMoreMenu.tsx` | **delete** | Superseded by real sidebar entries + the phone Mehr sheet. Remove its import from `pages/AnlagenPage.tsx` and every deep-view head. |
| `frontend/portal/src/components/AnlageMoreMenu.test.tsx` | **delete** | With the component. |
| `frontend/portal/src/shell/Shell.css` | **new** | Component-local CSS for the grouped sidebar, context card, health badge, bottom bar (5 slots), Mehr sheet and icon rail. Move the "M1 · Anlage-scoped shell nav" block out of `src/index.css` into it (keep `.vp-bottombar` class names so nothing else breaks). |
| `frontend/portal/designsystem/components/core/Icon.jsx` + `Icon.d.ts` | edit | Add the glyphs the new nav needs and the set lacks: **`help-circle`** (Hilfe & Kontakt) and **`layers`** (Anlagen-Modell). Both files in the same change. |

## Acceptance criteria

1. Opening an Anlage shows **one** navigation: the base group with five entries and, per active
   mode, a labelled group (`Modus · <Name>`) with a colour dot; **no "Mehr ▾" button exists anywhere**.
2. Toggling a mode (by activating/deactivating its flow or master data) makes its group appear /
   disappear on the next surface load — the group set equals
   `activeModes(site)` × each manifest's `deepViews`, never a hardcoded list.
3. Marktpreise + Prognosequalität are visible **only** while the market mode is active; a plain
   self-consumption plant never sees them.
4. The top bar shows exactly one health badge with three possible states and a title naming the
   worst finding (e.g. "Wallbox meldet seit 2 Std. keine Daten"). It is **never** green while a
   device is silent.
5. `#/marktpreise`, `#/live`, `#/fahrplan`, `#/wetter`, `#/geraete`, `#/standorte`,
   `#/anlage/{id}/…` and every legacy hash still resolve exactly as before (no route change).
6. At ≤ 720 px the bottom bar has **five** slots and "Mehr" opens a sheet containing every remaining
   area (Historie, mode views grouped and colour-tagged, Einstellungen, Hilfe). At 721–1023 px the
   sidebar is a 56 px icon rail with tooltip labels — **no hamburger**.
7. An un-migrated v1 plant (no v2 entities, no modes) renders the base group only, with **no badge
   and no mode group** — and nothing else about its pages changed.

## Tests to add / adjust

- `src/anlageNav.test.ts` — **rewrite**: the base group is fixed and ordered; a mode group exists
  iff the mode is active; `bottomBarSlots` is exactly 5; **the no-orphaned-view guard becomes
  "base ∪ mode groups ∪ Mehr-sheet == every `AnlagenSub` exactly once"** (the old
  `trio ∪ DEEP_VIEW_ITEMS` assertion is replaced, not deleted).
- `src/health.test.ts` — add `healthBadge` vectors: all-ok → ok; one silent device → warnung and the
  device is named; missing plan only → hinweis; empty input → ok without invented detail.
- `src/shell/AppShell.test.tsx` — grouped sidebar renders; the 5-slot bottom bar renders on the
  Anlage; the health badge renders its state; the admin tenant switcher still renders.
- `src/nav.test.ts` — unchanged assertions must stay green (round-trip of every sub).
- `src/migration.test.ts` — extend: an un-migrated plant yields no mode group and no badge; add a
  source-reading guard that **`AnlageMoreMenu` no longer exists** (the `adaptiveNav` teardown-guard
  precedent, `node:fs`).

## Dependencies

None (first milestone). Everything else mounts into this shell.

## Gotchas

- **`anlageNav.test.ts`'s exhaustiveness guard will fail loudly** the moment you delete
  `DEEP_VIEW_ITEMS` — that is intended; port the guard to the new model instead of weakening it.
- **`activeAreaKey` returning `null` was load-bearing** (a deep view highlighted no area). With deep
  views now being real sidebar entries, each must map to its own key or highlight its mode group —
  decide once in `anlageNav.ts`, do not spread the rule into `AppShell`.
- `App.tsx` builds the nav for `page === 'anlagen'` **and** for `marktpreise` / `prognose` (so a mode
  page keeps the Anlage nav). Keep that branch — dropping it strands the customer.
- Every surface fetch in `useAnlageSurface` is `.catch`-ed. **Keep it fail-soft**: a backend without
  the v2 routes must still render the base group.
- The health badge must not add a new request on the main page. Compose it from data `App.tsx`
  already holds (overview row, control status, schedule) — gate any extra fetch behind a real need.
- Moving CSS out of `index.css`: watch for the esbuild "unbalanced {" warning (BUILD.md §4.7) and
  keep the existing `.vp-bottombar` / `.vp-main.has-bottombar` class names, which other rules use.
- **OPEN (O2, BUILD.md §8):** Fahrplan currently sits in the market mode group. If the owner decides
  it should be a base entry for any plant with a battery plan, the change is one line in
  `anlageSidebar` — leave a `// OPEN(O2)` marker there.
