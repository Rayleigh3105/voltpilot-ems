# M3 · Modus-Profile (the one backend piece)

> Realizes report §4 **P3** · concept tab **4 · Modus-Profile**.
> Read [`BUILD.md`](./BUILD.md) §4 and §5 first.

## Goal

Turn the plant's feature set into a **visible shelf with switches**: Eigenverbrauch ·
Marktoptimierung · Gewerbe (Lastspitzenkappung) · further profiles — customer-switchable, several
active at once, prominent on **every** plant including simple v1 ones. Each profile card states in
one sentence what it does, **what it unlocks** (views · widgets · money stream) and **what it
requires** (✓ / missing). Three switch classes:

| Class | Behaviour |
|---|---|
| **sofort** (free profiles, e.g. Eigenverbrauch) | Switch flips → the profile's starter flow is auto-started; the surface follows immediately. |
| **sofort wenn freigeschaltet** (Marktoptimierung) | Flips only when the per-site governance already enables the gated strategy node; otherwise it becomes an **Anfrage**. |
| **Anfrage** (contract-near: Gewerbe / Lastspitzen) | State `angefragt` → card reads "Angefragt — VoltPilot richtet ein · in Vorbereitung". **The server gate is untouched** — this is UX over the gate, never a bypass. |

Structurally impossible profiles collapse under "Weitere Profile" but **never disappear** — the
shelf is also the honest catalogue.

## Scope

**In**
- One additive table + a customer-reachable read/write endpoint for the per-Anlage profile state.
- A profile-state **overlay** on the `surface.ts` derivation (`aus` suppresses a derived mode,
  `angefragt` shows the card without activating anything).
- The shelf page and its route.
- Opening a free profile → the existing `FlowTemplateService.autoStart` path, made reachable for
  customers. Closing one → the existing flow `deactivate`.

**Out**
- No change to `FlowGovernance`, `FlowActivationService` or the peak-shaving gate.
- No notification channel for `angefragt` (**OPEN O1** — state is persisted and logged only).
- No change to how a mode is *derived* — `activeModes()` keeps its signals; M3 only overlays intent.

## Backend

| File | New? | What |
|---|---|---|
| `services/api/src/main/resources/db/migration/V20260723000000__site_profile_state.sql` | **new** | `site_profile_state(site_id UUID REFERENCES site(id) ON DELETE CASCADE, profile TEXT, state TEXT CHECK (state IN ('an','aus','angefragt')), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, requested_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (site_id, profile))`, `GRANT SELECT, INSERT, UPDATE, DELETE … TO ${appDbUser}`, `ENABLE`+`FORCE ROW LEVEL SECURITY` and the `tenant_id = current_setting('app.tenant_id')` policy — **copy the shape of `V20260719000000__flow_definition.sql` verbatim**. Additive only; no row means "derived default", which is why existing plants are untouched. |
| `services/api/…/repo/SiteProfileStateRepository.java` | **new** | RLS-scoped `JdbcTemplate` repo (the `@Primary` tenant-aware template, never the admin one): `findBySite(siteId)`, `upsert(siteId, profile, state)`, `clear(siteId, profile)`. |
| `services/api/…/profile/SiteProfileService.java` | **new** | Merges the stored state with `UsageProfileService`'s signals into the response model; performs the transitions (open free profile → `FlowTemplateService.autoStart`; close → `FlowService.deactivate` of the profile's flows; contract-near → record `angefragt`). |
| `services/api/…/web/SiteProfileController.java` | **new** | `@RequestMapping("/api/v1/sites/{siteId}/profiles")`, **no `@PreAuthorize`** — authentication + RLS are the fence, a foreign site is 404 (the `SiteTopologyController` / `SiteFlowController` pattern). `GET` → the shelf model; `PUT` → `{profile, state}` transition, returns the recomputed model. |
| `services/api/…/web/SiteFlowController.java` | edit | Add the customer twin `POST /sites/{siteId}/flows/auto-start` delegating to the same `FlowService`/`FlowTemplateService.autoStart` the admin route uses (`AdminFlowController` line ~77). **Gates unchanged** — a starter flow carrying a gated node still fails activation with `gated_node_not_enabled`, which the shelf renders as `angefragt`. |
| `services/api/…/web/dto/SiteProfilesDto.java` | **new** | `{profiles: [{id, label, state, derivedActive, switchClass, unlocks: {views[], widgets[], moneyStream}, requirements: [{label, met}], origin, flowRef}]}`. |
| `docs/contracts/openapi.yaml` | edit | Document `GET/PUT /sites/{id}/profiles` and the customer `auto-start` (tag `flows`/`profile`). |

**Do not** store the *derived* profile — the derivation stays the single truth (the AE7 rule); the
new table stores only the customer's **intent**.

## Frontend

| File | New? | What |
|---|---|---|
| `frontend/portal/src/profiles.ts` | **new** | Pure: `profileShelf(surface, states)` → the ordered cards (active + reachable first, structurally impossible collapsed under "Weitere Profile"), `switchClass(profile, governance)`, `requirementChips(signals)`, `applyProfileStates(modes, states)` — the **overlay**: `aus` removes a derived mode, `angefragt` yields a card-only entry that contributes **no** cockpit block and **no** money stream. All German copy lives here. |
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
2. Switching a **free** profile on creates/activates its starter flow and the surface follows: nav
   group, cockpit widget and money stream appear (BUILD.md §4.1 — all through `surface.ts`).
3. Switching a profile **off** deactivates its flows and persists `aus`; a re-derived signal does
   **not** silently re-enable it.
4. A contract-near profile switch lands in `angefragt` and the card reads "Angefragt — VoltPilot
   richtet ein"; **no flow is activated, no gate is bypassed** — a direct activation attempt still
   returns `gated_node_not_enabled` / `peakshaving_not_configured`.
5. A master-data-driven profile (a DV park) shows "Von VoltPilot eingerichtet" and its off-switch
   leads to contact, not to a silent deactivation.
6. A site with **no rows** in `site_profile_state` behaves exactly like today (proven by
   `migration.test.ts` and by a Testcontainers test).
7. Foreign-site access is 404 through RLS; an admin reaches any tenant via the `X-Tenant-Id` switcher.

## Tests to add / adjust

- `services/api` `SiteProfileApiTest` (**new**, Testcontainers): customer GET/PUT round-trip; free
  profile on → flow created; off → flow deactivated + state `aus`; contract-near → `angefragt`
  without activation; the gate still refuses a direct activation; foreign site 404; a customer
  cannot write another tenant's row.
- `services/api` `CustomerFlowApiTest` — extend with the customer `auto-start` twin (created +
  idempotent `already_has_flow`).
- `frontend/portal/src/profiles.test.ts` (**new**): shelf order, switch classes, requirement chips,
  and the overlay — `aus` suppresses the mode's block/stream, `angefragt` contributes none.
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
- "Angefragt" is **UX over the gate, not a bypass.** Copy must not promise activation, and the
  server must still refuse. Keep the wording exactly "Angefragt — VoltPilot richtet ein".
- `autoStart` refuses with `already_has_flow` / `no_battery` — surface those German reasons on the
  card instead of a generic error.
- Do not let the overlay hide a mode that is active because of **master data** on the plant (a DV
  park): `origin: 'masterdata'` profiles get the contact path, not an off switch.
