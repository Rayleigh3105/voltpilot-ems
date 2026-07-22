# M6 · Anlagen-Modell (Geräte → **Komponenten** → Anlage)

> Realizes report §4 **P6** · concept tab **7 · Anlagen-Modell**.
> Read [`BUILD.md`](./BUILD.md) §2 (**D3** is locked) and §4 first.

## Goal

Replace the device/entity list with **one picture: "so ist Ihre Anlage verschaltet."** Three columns —
**Geräte** (the physical boxes that deliver data) → **Komponenten** (the roles the plant is thought
in: PV-Dach, Speicher, Netzanschluss, Haus, Wallbox — customer-nameable) → **Ihre Anlage** (what the
cockpit makes of it). Tapping a device highlights its components. A newly reported device appears as
**"Neues Gerät gefunden … jetzt zuordnen"** and is assigned in **one move** (adopt + role in one
dialog). Health dots sit on the device, where people look for them.

**Dictionary (D3, customer-facing):** **Gerät** / **Komponente** / **Messwert**.
Entität · Messpunkt · Quelle · Mess-Einheit vanish from the customer surface (they stay in the
installer/admin panels — M7 — and unchanged in the backend).

## Scope

**In**
- The three-column model page with click-highlight, health dots and the right-hand "what this does"
  column (Energiefluss node · Steuerungs-Bezug · Historie per Messwert · Gesundheit).
- The one-move assignment dialog = existing **adoption** (`adopt()`) + **role assignment**
  (`topology-roles`) in one step.
- Customer-nameable components.
- The dictionary sweep on this surface (the portal-wide sweep is M7).

**Out**
- The technical panels (entity types, raw channels, guard bands, registry sync) — they **move** into
  the admin/installer panels of the same route; M7 gates them.
- No backend model change: v2 entity, `measurement_point`, AE1 roles stay as they are.
- **Assignment is presentation only** — it never changes control. Control rights hang off
  capabilities/guards, never off a role. Keep that sentence in the UI.

## Files to change / create

| File | New? | What |
|---|---|---|
| `frontend/portal/src/pages/AnlagenModellSection.tsx` | **new** | The three-column surface. Replaces `pages/EntitaetenSection.tsx` as the customer area. |
| `frontend/portal/src/komponenten.ts` | **new** | The pure derivation: `plantModel(entities, topology, sources)` → `{devices: [{id, label, health, componentIds[]}], components: [{id, label, role, summary, deviceIds[], channels[]}], effects: […]}`, plus `componentLabel`, `deviceSummary`, `newlyReported(sources, entities)`. Reuses `src/rollen.ts` (`roleBoxes`, `suggestEntityType`, `adoptableSources`, `sourceRoleLabel`) and `src/topology.ts` (`defaultRole`) — **no second role derivation**. |
| `frontend/portal/src/components/ZuordnenDialog.tsx` | **new** | "Was misst dieses Gerät?" → pick or create a Komponente → done. Calls `entitiesApi.adopt` and `api.setTopologyRoles` in one submit, with an honest single failure message. |
| `frontend/portal/src/pages/EntitaetenSection.tsx` | edit | Loses the customer framing; its entity cards, guard rows, sync/drift banner and registry view become the **installer/admin panels** rendered inside the new route (M7 gates them behind the role). Do not delete the file — its content is the technical view. |
| `frontend/portal/src/entities.ts` / `src/rollen.ts` / `src/channels.ts` | edit | Copy only: German customer wording per D3 (`channels.ts` stays the one channel→German map with raw-name fallback). |
| `frontend/portal/src/nav.ts` | edit | Add the `modell` `AnlagenSub` (`#/anlage/{id}/modell`) and map the retired `entitaeten` sub through `LEGACY_SUBS` → `modell` (bookmarks keep working, the existing redirect pattern). |
| `frontend/portal/src/anlageNav.ts` | edit | The base group's "Anlagen-Modell" entry points at `modell`. |
| `frontend/portal/src/pages/AnlagenPage.tsx` | edit | Mount the new sub. |
| `frontend/portal/src/components/AnlagenModell.css` | **new** | Component-local three-column CSS (columns collapse to a stack < 980 px). |
| `frontend/portal/src/entitiesApi.ts` | edit | Point `adopt` at the customer route once it exists (below); keep the honest 403 message as the fallback. |

### Backend — the customer adoption twin (**OPEN O3**, built here)

Today adoption is admin-only: `POST /api/v1/admin/sites/{siteId}/v2-entities/adopt`
(`AdminEntityRegistryController` ~L114), and the portal already carries the honest
`ADOPT_FORBIDDEN_MSG` fallback for a plain customer token.

| File | New? | What |
|---|---|---|
| `services/api/…/web/SiteEntityAdoptController.java` | **new** | `POST /api/v1/sites/{siteId}/v2-entities/adopt` — **no `@PreAuthorize`**, RLS-fenced, foreign site 404 (the `SiteTopologyController` / `SiteFlowController` pattern). Delegates to the **same** `EntityRegistryService.adopt` the admin route uses, but **catalog-guarded**: only types the guided path derives (`rollen.ts suggestEntityType` equivalents — producer / grid-meter / controllable consumer), never a free type picker, never guard-config input. |
| `docs/contracts/openapi.yaml` | edit | Document the customer twin. |

If the owner prefers adoption to stay admin-first, drop this controller: the page then renders the
existing honest hint and everything else in M6 still works. Mark the decision in the PR body.

## Acceptance criteria

1. The customer area shows three columns; tapping a device highlights exactly the Komponenten it
   measures/controls; the right column explains the effect in plain German.
2. The words **Entität, Messpunkt, Quelle, Mess-Einheit, Kanal** appear **nowhere** in the customer
   view (a test greps the rendered copy); the dictionary is Gerät / Komponente / Messwert.
3. A newly reported device shows "Neues Gerät gefunden"; assignment is **one dialog** and afterwards
   the device's component appears in the middle column and in the energy flow.
4. Renaming a Komponente changes its label everywhere it is shown (cockpit node label included) and
   changes **nothing** about control.
5. Health dots on devices match the existing `ok` / `stale` / `never` states and roll up into M1's
   header badge — a silent wallbox turns the badge amber and names the device.
6. Every existing `#/anlage/{id}/entitaeten` bookmark lands on the new page.
7. The technical content (entity types, raw channels, guard bands, Soll/Ist sync, registry) still
   exists on the same route for admins — nothing was deleted.

## Tests to add / adjust

- `src/komponenten.test.ts` (**new**): the model derivation across the pilot shapes (hybrid only;
  hybrid + second producer; wallbox; grid meter; a device with no components); component↔device
  mapping; the "newly reported" set; the vocabulary guard (no forbidden words in any produced label).
- `src/pages/AnlagenModellSection.test.tsx` (**new**): three columns render, click-highlight works,
  the assign dialog opens, the customer 403 fallback message is shown when the twin is absent.
- `src/pages/EntitaetenSection.test.tsx` — adjust to the technical-panel framing (keep the coverage).
- `src/nav.test.ts` — `entitaeten` → `modell` redirect round-trips.
- `services/api` `PortalApiTest` — the customer adopt twin: adopts idempotently per `edgeSourceId`,
  refuses a non-guided type, foreign site 404 (mirrors
  `AdminApiTest.adminAdoptsEdgeReportedSourcesIntoV2EntitiesIdempotently`).

## Dependencies

**M1** (the "Anlagen-Modell" area exists in the sidebar). Independent of M2–M5; may run in parallel
with M2/M3.

## Gotchas

- **Adoption is idempotent per `(site, edge source)` and deletion does NOT unpin the point.** Deleting
  a composed entity only clears its config and leaves the `measurement_point` bound to the source, so
  the re-adopt path must probe the **unfiltered** point lookup — a filtered probe once produced an
  opaque HTTP 500 on a button the portal keeps offering.
- A producer adoption sums its kWp into the aggregate `asset.pv` **as a delta** (the existing service
  does this) — do not double-apply it in the dialog.
- Role assignment is presentation-level: the customer `PUT /sites/{id}/topology-roles` needs no extra
  gate, but the UI must not imply that a role grants control.
- Composed entity types (battery-hybrid / producer / grid-meter / house-load) are platform-managed:
  they are hidden from customer create/delete and 409-guarded server-side. The dialog must not offer
  them as free choices.
- Keep `src/channels.ts` as the only channel→German map, **with its raw-name fallback** — the channel
  vocabulary is open (operators declare their own Modbus channels), so hiding an unknown channel
  would be dishonest.
- `EntitaetenSection.tsx` is ~990 lines. Move content, do not rewrite it: its sync/drift verdicts
  (`src/entities.ts syncVerdict`) are unit-tested and must keep passing.
