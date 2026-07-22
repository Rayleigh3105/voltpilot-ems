# M2 · Live-Cockpit

> Realizes report §4 **P2** · concept tab **3 · Live-Cockpit**.
> Read [`BUILD.md`](./BUILD.md) §2 (the EnergyFlow refinement) and §4 first.

## Goal

Make the Anlage's home screen a **live cockpit**: the hero card carries the **existing energy-flow
diagram, hosted large and central**, with **Autarkie heute** and **Eigenverbrauch** as ring KPIs plus
"Heute verdient" (incl. "davon X € durch VoltPilots Steuerung") and one Fahrplan sentence beside it.
Below that a **widget grid** (Speicher · Erzeugung · Haus · Netz, plus profile-dependent Handel and
Lastspitze): each tile is compact, and a tap opens a **modal** with the segments **Jetzt | Verlauf**
and the tile's controls. Widgets follow the plant + active profiles strictly — **no empty placeholders**.

## Scope

**In**
- Hero composition: `EnergyFlow` / `AdaptiveEnergyFlow` hosted large; ring KPIs; status sentence;
  "Heute verdient"; the Fahrplan one-liner.
- The generic FlatWidget pattern: one widget definition shape `{id, label, value, sub, accent,
  modal: {jetzt, verlauf}}`, a `WidgetGrid` and a `WidgetModal` (segmented Jetzt/Verlauf).
- Migrating the existing cockpit blocks (Peak-Band, Erlös-Komposition, Handel, Eigenverbrauch) into
  widgets/modals of the same family.
- The Wetter card ("Warum"-line + drill-in) that replaces the retired Wetter nav item.

**Out**
- **No new energy-flow component.** `EnergyFlow.tsx` and `AdaptiveEnergyFlow.tsx` are reused; only
  size/placement change. There is **no `EnergyWheel.tsx`**.
- No new money math and no new endpoint — every number already exists.
- Nav/shell (M1), profile shelf (M3).

## Data sources — all already shipped

| Cockpit piece | Source |
|---|---|
| Energy flow (v1 4-node) | `src/live.ts` `buildSnapshot`/`flowState` over `api.telemetry` + the overview live sample |
| Energy flow (migrated, N role nodes) | `useAdaptiveLive` → `api.topology` → `src/topology.ts` → `components/AdaptiveEnergyFlow.tsx` |
| Autarkie / Eigenverbrauch rings | `HistoryTotals.autarkiePct` / `.eigenverbrauchPct` (`src/api.ts`), already consumed by `cockpit.ts eigenverbrauchBlock` |
| "Heute verdient" + steering attribution | `api.earnings(...)` → `EarningsSite.savedEur` and the M0 `moneyStreams` (`attribution: 'steering'`) |
| Fahrplan sentence, plan windows | `src/schedule.ts planSentence` / `cockpit.ts planWindows` |
| Speicher reserves / Speicherschonung control | `optimizerApi.configViaSwitcher` (fail-soft) + `src/speicherschonung.ts` |
| Peak widget | `src/peakBand.ts` + `EarningsSite.peakShaving` |
| Which widgets exist at all | `surface.ts` `anlageSurface(site).cockpitBlocks` / `activeModes` |

## Files to change / create

| File | New? | What changes |
|---|---|---|
| `frontend/portal/src/cockpitWidgets.ts` | **new** | The pure derivation: `cockpitWidgets(input): WidgetDef[]` — one widget per cockpit block/mode that has data, in the M0 `BLOCK_ORDER` rank, each with its `jetzt` rows and `verlauf` descriptor. Honest gaps: a widget without a source is **omitted**; a row without a value renders "—". |
| `frontend/portal/src/components/WidgetGrid.tsx` | **new** | Render-only grid of FlatWidget tiles (`--vp-flow-*` accents), tap → opens the modal. |
| `frontend/portal/src/components/WidgetModal.tsx` | **new** | Render-only modal with the `Jetzt | Verlauf` segment, the tile's rows, its chart slot and its control slot. Portals to `document.body` (the `InfoTip`/`RowMenu` clip-escape pattern). |
| `frontend/portal/src/components/CockpitHero.tsx` | **new** | The hero card: flow slot (left) + rings/money/plan (right); switches between `EnergyFlow` and `AdaptiveEnergyFlow` on the existing `hasTopology` gate. |
| `frontend/portal/src/components/EnergyFlow.tsx` | edit | **Size/placement only.** Add an optional `size?: 'compact' | 'hero'` that raises the WIDE layout's height cap (today `Math.min(rawHeight, 264)`) and lets the hero host fill its container. Default stays today's behaviour so the fleet card and Live view are byte-identical. |
| `frontend/portal/src/components/AdaptiveEnergyFlow.tsx` | edit | Same optional `size` prop (its `maxWidth: L.W` cap must lift in hero mode). No geometry/`adaptiveFlow.ts` change. |
| `frontend/portal/src/pages/AnlagenPage.tsx` | edit | `AnlageSeite`: the projection path composes **hero + widget grid** instead of the block stack; the M5-setup path and the v1 zone dashboard stay as-is. |
| `frontend/portal/src/components/CockpitBlocks.tsx` / `.css` | edit | Block bodies become widget/modal bodies (`HandelBlockBody`, `EigenverbrauchBlockBody`, `GeraeteAutomatikBody` are reused inside modals). Extend the component-local CSS; do not touch `index.css`. |

## Acceptance criteria

1. The Anlage home screen leads with the **existing** energy-flow diagram, visibly larger than
   today's "Jetzt gerade" card, with unchanged animation, colours and "—" behaviour. A diff of
   `EnergyFlow.tsx` shows **only** the optional size handling.
2. Autarkie and Eigenverbrauch render as ring KPIs next to the flow, sourced from the history day
   totals; when a total is null the ring is **absent**, not 0 %.
3. Every widget opens a modal with `Jetzt | Verlauf`; both faces read the **same** channel/number as
   the tile (no second derivation).
4. Widget presence follows the projection: a plant without a market mode has **no Handel widget**;
   without a peak module **no Lastspitze widget**; a pure PV plant shows 3 flow nodes; a plant with
   a wallbox shows the consumer node.
5. A stale/absent live sample dims the hero and keeps the last good values with the honest freshness
   line — it never renders a fabricated 0 (the `adaptiveLive.ts` `liveState` three-value truth stays
   the single freshness authority).
6. Wetter has no nav entry but is reachable from the cockpit card and its route still works.
7. 375 / 768 / 1440: hero stacks on phone, grid is 1 / 2 / 3-up, modal becomes a full-screen sheet
   on phone, zero horizontal overflow.

## Tests to add / adjust

- `src/cockpitWidgets.test.ts` — **new, exhaustive**: widget set per Ausprägung (Privat / Gewerbe /
  Markt / Multi / leer) incl. the negative proofs; omission instead of 0; deterministic order.
- `src/components/WidgetModal.test.tsx` + `WidgetGrid.test.tsx` — thin render + open/close + segment
  switch.
- `src/pages/AnlagenPage.test.tsx` — the projection path renders hero + grid; **the v1 path stays
  character-identical** (the existing DOM-equality invariant must still pass unchanged).
- `src/pages/AnlagenPage.v1.test.tsx` — unchanged, must stay green.
- Keep `cockpit.test.ts` green: `handelBlock` / `eigenverbrauchBlock` keep their contracts and are
  now consumed by widgets.

## Dependencies

**M1** (the cockpit is mounted as the base group's first area and loses the "Mehr ▾" head).
Independent of M3–M6; may run in parallel with M3 and M6.

## Gotchas

- **Do not build a new radial component.** The owner reviewed and rejected the "Energie-Rad";
  reuse is the decision (BUILD.md §2). If the hero looks small, change the host container and the
  height cap — not the geometry.
- `EnergyFlow` picks `NARROW` below 380 px container width via a ResizeObserver. A wider hero host
  changes which layout phones get — re-check the 375 px viewport specifically.
- The Peak-Band lead rule (`leadSlot.ts` `leadArtifact` / `leadBlock`) still decides what leads the
  page on a peak plant. Widgets must not silently reorder past it; feed `cockpitWidgets` the same
  ordered block list.
- Money attribution stays a **sub-line**, never a sibling summand: `savedEur` already sits inside the
  feed-in revenue (`MoneyStream.attribution: 'steering'`). Summing it separately double-counts.
- The Peak-Band's live quarter-hour fetch is deliberately gated to peak-leading plants — keep that
  gate, do not fetch a 20-minute telemetry window for everyone.
- Modals must portal to `document.body`: their host `Card` has `overflow: hidden`, which clips
  absolutely positioned children (the documented RowMenu bug class).
