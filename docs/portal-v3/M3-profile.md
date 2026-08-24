# M3 · Anwendungen (im Code: Modus-Profile) — the one backend piece

> **⚠ Vocabulary (Stufe 0, 24.08.2026):** the customer-facing word is **„Anwendung"**;
> „Modus-Profil"/„Modus"/„Modi" survive only as CODE ids (`ModeKind`, the route
> `/profiles`, the column `site_profile_state.profile`, `SiteProfileCatalog`).
> This spec keeps the code vocabulary; the rendered copy says „Anwendungen".

> Realizes report §4 **P3** · concept tab **4 · Modus-Profile** (now rendered as „Anwendungen").
> Read [`BUILD.md`](./BUILD.md) §4 and §5 first.

## Goal

Turn the plant's feature set into a **visible shelf with switches**: Eigenverbrauch ·
Marktoptimierung · Gewerbe (Lastspitzenkappung) · further profiles — customer-switchable, several
active at once, prominent on **every** plant including simple v1 ones. Each profile card states in
one sentence what it does, **what it unlocks** (views · widgets · money stream) and **what it
requires** (✓ / fehlt chips).

**Owner decision: EVERY profile is a direct customer toggle — there is no "Angefragt" state and no
VoltPilot-request wall.** The contract-near profiles (Gewerbe / Lastspitzenkappung, Marktoptimierung)
switch exactly like the free ones. There are therefore only **two** persisted states, `an` and `aus`,
and one honest rule on top:

| | Behaviour |
|---|---|
| **Toggle on** | The server enables **exactly that profile's gated node types** for that site and seeds/activates its starter flow (`FlowTemplateService.autoStart`). The surface follows immediately. |
| **Toggle off** | The profile's flows are deactivated and `aus` is persisted (a re-derived signal must not silently re-enable it). |
| **Prerequisite missing** | The toggle still flips — but the card states honestly and specifically what is still missing ("Leistungspreis nicht hinterlegt", "kein dynamischer Tarif"), and the part that genuinely cannot run **does not run**. Never a fake success, never a request wall. |

Structurally impossible profiles collapse under "Weitere Profile" but **never disappear** — the
shelf is also the honest catalogue.

## Scope

**In**
- One additive table + a customer-reachable read/write endpoint for the per-Anlage profile state.
- A profile-state **overlay** on the `surface.ts` derivation (`aus` suppresses a derived mode).
- The shelf page and its route.
- Opening **any** profile → the existing `FlowTemplateService.autoStart` path, made reachable for
  customers, **plus** the server-side enablement of that profile's gated node types. Closing one →
  the existing flow `deactivate`.

**Out**
- No change to `FlowActivationService`'s gate *logic*, to the peak-shaving configuration gate, or to
  the edge guard chain / §14a / EEG protections — those stay literal. What changes is **who may open
  the per-site governance entry**, not what the gate checks.
- No change to how a mode is *derived* — `activeModes()` keeps its signals; M3 only overlays intent.
- No "Angefragt" state, no notification channel, no admin task list.

---

## ⚠️ OPEN — owner: what must hold before market trading actually starts

Making **Marktoptimierung** a bare customer toggle means a customer switch lets the optimizer trade
on their behalf. A toggle alone must not be able to start **uncontracted** market participation.

**Recommended reconciliation (built unless the owner says otherwise): the toggle is *intent*, and
trading only runs when the technical prerequisite is present on the site.** Concretely, the market
strategy dispatches only when the site actually has market access — a `tarif_art = 'dynamisch'`
and/or `plant_kind = 'direktvermarktung'` (the same master data `surface.ts` already reads to
activate the market mode, and the same data the optimizer's pricing layer needs to price an export
at spot + Marktprämie at all). Without it the profile switches on, the card names the missing
prerequisite, and nothing trades. Toggling the profile **never** writes that master data — a tariff
or a DV contract is a real-world fact, entered on the Technik/Vergütung form, not implied by a switch.

**Owner to confirm:** is "dynamic tariff and/or Direktvermarktung on the site" the right and
sufficient prerequisite, or does market participation need an explicit, separately recorded
contract flag before any trading? Implement the recommendation, keep the check in **one** place
(`SiteProfileService` + the card copy in `profiles.ts`) so a different answer is a one-line change,
and leave an `// OPEN(O1)` marker at that check.

Unrelated and unchanged: §14a, EEG solar-only charging, the guard chain and the co-optimisation
reserve stack all continue to clamp whatever any profile asks for.

## Backend

| File | New? | What |
|---|---|---|
| `services/api/src/main/resources/db/migration/V20260723000000__site_profile_state.sql` | **new** | `site_profile_state(site_id UUID REFERENCES site(id) ON DELETE CASCADE, profile TEXT, state TEXT CHECK (state IN ('an','aus')), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, profile))`, `GRANT SELECT, INSERT, UPDATE, DELETE … TO ${appDbUser}`, `ENABLE`+`FORCE ROW LEVEL SECURITY` and the `tenant_id = current_setting('app.tenant_id')` policy — **copy the shape of `V20260719000000__flow_definition.sql` verbatim**. Two states only (there is no "Angefragt"). Additive only; no row means "derived default", which is why existing plants are untouched. |
| `services/api/…/repo/SiteProfileStateRepository.java` | **new** | RLS-scoped `JdbcTemplate` repo (the `@Primary` tenant-aware template, never the admin one): `findBySite(siteId)`, `upsert(siteId, profile, state)`, `clear(siteId, profile)`. |
| `services/api/…/profile/SiteProfileService.java` | **new** | Merges the stored state with `UsageProfileService`'s signals into the response model and performs the transitions. **On → (a)** enable that profile's gated node types for the site via `FlowGatedNodeRepository.upsert(tenantId, siteId, nodeType, true)` — the profile→node-type map is derived from the catalog (`vp.strategy.market` for Marktoptimierung, `vp.strategy.peakshaving` for Gewerbe, …), never a hand-kept list — **(b)** `FlowTemplateService.autoStart`, **(c)** persist `an`. **Off →** `FlowService.deactivate` of the profile's flows, disable the node types again, persist `aus`. Also holds the **one** market-prerequisite check (`// OPEN(O1)`, see above). |
| `services/api/…/web/SiteProfileController.java` | **new** | `@RequestMapping("/api/v1/sites/{siteId}/profiles")`, **no `@PreAuthorize`** — authentication + RLS are the fence, a foreign site is 404 (the `SiteTopologyController` / `SiteFlowController` pattern). `GET` → the shelf model; `PUT` → `{profile, state}` transition, returns the recomputed model. |
| `services/api/…/flows/FlowService.java` | edit | **The governance WRITE stays admin-only** (`setGovernance` keeps its admin caller). M3 does not open that endpoint to customers; the per-site enablement is written by `SiteProfileService` as a server-side effect of an authorized profile toggle. Keep the class docstring accurate about that (it currently says the write is admin-only, full stop). |
| `services/api/…/web/SiteFlowController.java` | edit | Add the customer twin `POST /sites/{siteId}/flows/auto-start` delegating to the same `FlowService`/`FlowTemplateService.autoStart` the admin route uses (`AdminFlowController` line ~77). **The gate logic is unchanged** — a flow whose gated node was not enabled still fails with `gated_node_not_enabled`; after a profile toggle it simply *is* enabled. |
| `services/api/…/web/dto/SiteProfilesDto.java` | **new** | `{profiles: [{id, label, state, derivedActive, unlocks: {views[], widgets[], moneyStream}, requirements: [{label, met}], blockedReason, origin, flowRef}]}` — `blockedReason` is the honest German sentence for a profile that is `an` but cannot fully run yet (missing Leistungspreis, missing market access), **never** a request prompt. |
| `docs/contracts/openapi.yaml` | edit | Document `GET/PUT /sites/{id}/profiles` and the customer `auto-start` (tag `flows`/`profile`). |

**Do not** store the *derived* profile — the derivation stays the single truth (the AE7 rule); the
new table stores only the customer's **intent**.

## Frontend

| File | New? | What |
|---|---|---|
| `frontend/portal/src/profiles.ts` | **new** | Pure: `profileShelf(surface, states)` → the ordered cards (active + reachable first, structurally impossible collapsed under "Weitere Profile"; **removed in Stufe 0** — the rendering shelf is `steuerungArea.profileRows`), `requirementChips(signals)`, `blockedReason(profile, signals)` (the honest "läuft noch nicht, weil …" sentence — **no** request copy), and `applyProfileStates(modes, states)` — the **overlay**: `aus` removes a derived mode; `an` never invents one that the plant cannot structurally have. All German copy lives here. |
| `frontend/portal/src/surface.ts` | edit | `anlageSurface(input)` accepts an optional `profileStates` and applies `applyProfileStates` after `activeModes`. Absent/null = today's behaviour byte-for-byte. |
| `frontend/portal/src/useAnlageSurface.ts` | edit | Additionally fetch `api.siteProfiles(siteId)` **fail-soft** (`.catch(() => null)`) and pass it through. |
| `frontend/portal/src/pages/ProfileSection.tsx` | **new** | The shelf: profile cards with switch, one-sentence benefit, "Schaltet frei" chips, requirement chips, the co-optimisation line (reserve stack, reuse `steuerungArea.ts socReservationStack`), and the "Weitere Profile" fold. |
| `frontend/portal/src/nav.ts` | edit | Add the `profile` `AnlagenSub` (route `#/anlage/{id}/profile`) to `AnlagenSub` + `SUBS`. |
| `frontend/portal/src/api.ts` | edit | `siteProfiles(siteId)` / `setSiteProfile(siteId, profile, state)` / `autoStart(siteId)` (customer route). |
| `frontend/portal/src/pages/AnlagenPage.tsx` | edit | Mount the new sub. |
| `frontend/portal/src/components/Profile.css` | **new** | Component-local CSS for the shelf. |

## Acceptance criteria

1. Every plant — including a v1 plant with only an inverter — shows the full shelf, with honest
   requirement chips ("dynamischer Tarif fehlt", "Leistungsmessung fehlt").
2. Switching **any** profile on — free or contract-near — enables that profile's gated node types
   for the site, creates/activates its starter flow, and the surface follows: nav group, cockpit
   widget and money stream appear (BUILD.md §4.1 — all through `surface.ts`). **There is no
   "Angefragt" state anywhere in the UI, the API or the DB.**
3. Switching a profile **off** deactivates its flows, disables its gated node types again and
   persists `aus`; a re-derived signal does **not** silently re-enable it.
4. **Honest prerequisites, no fake success:** toggling Gewerbe on a site without a Leistungspreis
   flips the switch and shows the specific German reason; the parts that cannot run do not run
   (the server's `peakshaving_not_configured` gate still holds and is surfaced as that reason, not
   as a raw error). Toggling Marktoptimierung without market access behaves the same way per the
   `OPEN — owner` rule above — **no trading starts**.
5. A master-data-driven profile (a DV park) shows "Von VoltPilot eingerichtet"; switching it off
   still deactivates its flows (the customer stays in control), it never silently keeps running.
6. A site with **no rows** in `site_profile_state` behaves exactly like today (proven by
   `migration.test.ts` and by a Testcontainers test).
7. Foreign-site access is 404 through RLS; an admin reaches any tenant via the `X-Tenant-Id`
   switcher. A customer still cannot call the admin governance PUT (403) — only their own profile
   toggle opens their own site's nodes.

## Tests to add / adjust

- `services/api` `SiteProfileApiTest` (**new**, Testcontainers): customer GET/PUT round-trip; a
  **free** profile on → gated nodes untouched + flow created; a **contract-near** profile on → its
  gated node type is now enabled for that site AND its starter flow activates; off → flow
  deactivated, node type disabled again, state `aus`; a site without the prerequisite keeps the
  toggle but reports the honest reason and does not dispatch; a customer still gets **403** on the
  admin governance PUT; foreign site 404; a customer cannot write another tenant's row.
- `services/api` `CustomerFlowApiTest` — extend with the customer `auto-start` twin (created +
  idempotent `already_has_flow`), and pin that the activation gate itself is unchanged: a gated node
  that was **not** enabled by a profile toggle still yields `gated_node_not_enabled`.
- `frontend/portal/src/profiles.test.ts` (**new**): shelf order, requirement chips, `blockedReason`
  wording (and a guard that no copy contains "Angefragt" / "in Vorbereitung" / "VoltPilot richtet
  ein"), and the overlay — `aus` suppresses the mode's block/stream.
- `frontend/portal/src/surface.test.ts` — add: `profileStates` absent ⇒ byte-identical result.
- `frontend/portal/src/migration.test.ts` — a plant with no profile rows produces nothing new.

## Dependencies

**M1** (the shelf is reachable from the shell; "Profile verwalten →" comes from M4).
Blocks **M4** (the Steuerung profile capsule renders this state).

## Gotchas

- **Never edit an applied migration.** Use a fresh date-versioned file; Flyway fingerprints every
  applied migration and a checksum mismatch fails api startup on long-lived DBs.
- The `db/dev` seed discipline applies if you seed demo profile rows: **existence-guard** them
  (`IF NOT EXISTS (SELECT 1 FROM tenant WHERE id = …) THEN RETURN`) — an unguarded FK insert once
  crash-looped a production deploy.
- Use the **RLS-scoped `@Primary` JdbcTemplate**, never `adminJdbcTemplate`. BYPASSRLS stays behind
  `/api/v1/admin/**`.
- **The gate is opened, never faked.** A customer toggle causes the *server* to write the per-site
  enablement; the activation path still re-checks it. Do **not** add a client-side "pretend it is
  enabled" branch, and do **not** open the admin governance endpoint to customers.
- **Enable exactly the toggled profile's node types — nothing else.** Derive them from the catalog's
  gated types per profile; a blanket "enable all gated nodes for this site" would hand a customer
  the atypical-grid strategy (whose economics are not built) as a side effect.
- **Toggling never writes money/contract master data.** A tariff, a Leistungspreis or a DV contract
  is a real-world fact entered on the Technik/Vergütung form. A profile switch may *require* it and
  say so — it must never set it.
- `autoStart` refuses with `already_has_flow` / `no_battery` — surface those German reasons on the
  card instead of a generic error.
- Since a customer can now switch a battery strategy on, **two profiles can claim the same battery**:
  make sure the co-optimisation line + reserve stack (`steuerungArea.ts socReservationStack`) render
  from two battery-claiming modes, and that the V-5 exclusive-resource validation still refuses a
  genuine conflict at activation.
- Keep the shelf honest for a **master-data** profile (a DV park): it may be switched off like any
  other, but its card must still say where it came from ("Von VoltPilot eingerichtet").
