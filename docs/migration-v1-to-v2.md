# Migrating a site from v1 to the adaptive v2 EMS (MIG runbook)

This is the exact, rehearsed, **reversible** procedure to move ONE live site onto
the adaptive v2 EMS. It is written so the captain and firstmate execute it
together in minutes, per site, and can roll back in seconds.

> **Scope for the current live sites.** The two production customer sites only
> **read / optimize / display** — they do **not** actively control the battery.
> So migrating them is **data conversion + a flag flip + the edge image** — there
> is **no battery actuation** on the path and therefore **no device-control
> certification** (no Deye bench) is required. Everything v2 is flag-gated and v1
> stays byte-identical, so the blast radius of a mistake is "the adaptive UI does
> not appear", never "the battery misbehaves".

Everything below has an automated proof that a future run can re-execute:

| Guarantee | Proof |
|---|---|
| Conversion preview reports exactly what apply does, writes nothing, idempotent | `AdminApiTest.v2ConversionPreviewMatchesBootstrapWithoutWritingAndCutoverIsControllable` |
| Portal history is gap-free across the cutover, and rollback reverts to pure v1 | `PortalApiTest.migratedSiteHistoryBridgesV1AndV2ErasGapFree` |
| The v2 optimizer plan is bit-identical to v1 for a migrated site, and v1 is byte-identical whether or not flagged | `services/optimization/tests/test_migration_dryrun.py` + the golden suite `test_golden_cooptimizer.py` |
| The adaptive topology / role read-model is correct | `AdminApiTest.topologyReadModelAggregatesRolesFromV2EntitiesAndAssignmentIsSettable` |
| Prod compose + deploy workflow parse with the new services | `tools/deploy/verify-migration-deploy.sh` |

---

## The migration in one picture

A v1 site has **master data** (asset rows: battery, PV; measurement_point rows:
producer / grid-meter) and streams **v1 telemetry** (the frozen 5-channel
`telemetry` topic). Migration adds, without touching any of that:

1. **v2 entities** — composed from the existing master data (battery →
   `battery-hybrid`, PV points → `producer`, grid meter → `grid-meter`) and pushed
   to the device as a retained registry. → the adaptive topology + entity UI.
2. **The optimizer flag** `VOLTPILOT_V2_PLAN_SITES` — the optimizer then ALSO
   publishes a v2 shadow plan (`.../v2/plan`). The v1 `/schedule` plan the device
   runs on is **byte-identical**.
3. **The edge image** — the updated Edge-App consumes the registry push and shows
   the adaptive `:8484` UI. (Read-only sites: nothing changes about what the edge
   *does*.)
4. **The history cutover** — one per-site instant so the portal Historie splices
   the v1 era (before) and the reconstructed v2 era (after) into one continuous
   series.

Every one of these is independently reversible.

---

## Preconditions (once)

- The v2 stack is deployed: the api carries the v2 migrations, and the prod
  compose runs `flowc` + `simulation` + the optimizer. Verify with
  `bash tools/deploy/verify-migration-deploy.sh` (parses only, deploys nothing).
- You have a **platform-admin** token. All admin calls below go through the
  tenant switcher: `-H "Authorization: Bearer $ADMIN"` **and**
  `-H "X-Tenant-Id: $TENANT"` (the RLS-scoped path — a wrong/absent tenant is a
  404, never a cross-tenant write).
- Know the site's `SITE_ID` and its `TENANT`.

Set up shell vars for the session:

```bash
API=https://portal.voltpilot.de          # or your api base
ADMIN='<platform-admin access token>'
TENANT='<tenant uuid>'
SITE='<site uuid>'
auth=(-H "Authorization: Bearer $ADMIN" -H "X-Tenant-Id: $TENANT")
```

---

## Step 1 — Preview (review, writes nothing)

```bash
curl -s "${auth[@]}" "$API/api/v1/admin/sites/$SITE/v2-entities/preview" | jq
```

Read the response and confirm it matches the physical plant:

- `plan[]` — one entry per entity that would be created (`action: "create"`) or
  refreshed (`action: "refresh"` on a re-run). Check the `entityType`s:
  - **hybrid Deye site** → `battery-hybrid` (roles `["pv","storage"]`), plus a
    `grid-meter` if a Netz-Zähler measurement point exists.
  - **Fronius / AC-coupled PV** → an additional `producer` (role `["pv"]`).
  - **plain PV+battery** → just `battery-hybrid` (PV + Speicher from the hybrid).
  - Check `roles`, `capabilities` (measure channels) and `guards` (charge/discharge
    limits, SoC window, `charge_from_grid_allowed` mirroring the EEG switch).
- `gatewayDevice` — the device the registry will be pushed to. If it is `null`,
  read `gatewayReason`:
  - `no_claimed_device` → claim the edge device first;
  - `multiple_devices_no_battery_link` → link the battery to its controlling
    device (the battery editor's device picker) so the gateway is unambiguous.
- `skipped[]` — honest notes (e.g. "no battery asset"). Fix the master data and
  re-preview if anything important is skipped.

The preview writes **nothing** — call it as many times as you like while fixing
master data.

## Step 2 — Apply (create the v2 entities + push the registry)

```bash
curl -s "${auth[@]}" -X POST "$API/api/v1/admin/sites/$SITE/v2-entities/bootstrap" | jq
```

- `entities[]` must match the preview's plan.
- `push` reports the retained registry publish to the gateway
  (`published: true`; `mqtt_not_configured`/`no_gateway_device`/`publish_failed`
  otherwise — the edge converges on the next connect either way; re-push with
  `POST .../v2-entities/push`).

This is **idempotent** — safe to re-run; it refreshes the same rows from current
master data (never duplicates).

## Step 3 — Flip the optimizer flag

Add the `SITE` uuid to `VOLTPILOT_V2_PLAN_SITES` (comma-separated) in the prod
`.env`, then restart just the optimizer:

```bash
# in /srv/docker/voltpilot/.env
VOLTPILOT_V2_PLAN_SITES=<site-uuid>[,<already-migrated-site>...]

docker compose -f docker-compose.prod.yml up -d optimization
```

The optimizer now ALSO publishes a co-optimized v2 plan on
`ems/$TENANT/$SITE/<device>/v2/plan`. **The v1 `/schedule` plan is unchanged** —
`test_migration_dryrun.py` proves the v1 payload is byte-identical with or without
the flag, and the v2 plan reproduces it slot-by-slot.

## Step 4 — Update the edge image

On the customer device (or via the standalone updater):

```bash
cd <edge deploy dir> && ./update.sh      # pulls edge-app-core + nodered, up -d
```

The updated core consumes the retained registry push and serves the adaptive
`:8484` UI (topology energy-flow + entity tiles). For a read-only site nothing
about the edge's *behaviour* changes — only the UI.

## Step 5 — Set the history cutover

The moment the site is live on v2 (edge updated, v2 telemetry flowing), stamp the
cutover so the portal Historie splices there:

```bash
curl -s "${auth[@]}" -X PUT "$API/api/v1/admin/sites/$SITE/v2-entities/history-cutover" \
  -H 'Content-Type: application/json' -d '{}' | jq      # {} = "now"; or {"at":"<ISO instant>"}
```

Before the instant the Historie reads v1 5-channel telemetry/rollups; at/after it
the same chart is reconstructed from the v2 per-entity telemetry — **gap-free and
overlap-free** (`migratedSiteHistoryBridgesV1AndV2ErasGapFree`). No data is copied.

## Step 6 — Verify

- **Adaptive UI**: `GET /api/v1/sites/$SITE/topology` returns the role-grouped
  hub topology (PV / Speicher / Netz nodes) with live values; the portal Anlage
  page shows the adaptive energy flow + entity tiles; the edge `:8484` shows the
  adaptive diagram.
- **Historie continuity**: open the site's Historie for the day spanning the
  cutover — the series is continuous across the instant (no reset, no gap).
- **v1 unchanged**: the money hero / Fahrplan / earnings are unchanged; the device
  still runs on the v1 `/schedule` plan; v1 telemetry still flows.

---

## Rollback (seconds, no data loss)

Any subset, in any order — each is independent:

1. **Optimizer** — remove the site from `VOLTPILOT_V2_PLAN_SITES` and
   `docker compose -f docker-compose.prod.yml up -d optimization`. The v2 plan
   stops; v1 was never affected.
2. **History** — clear the cutover, reverting the Historie to pure v1:
   ```bash
   curl -s "${auth[@]}" -X DELETE "$API/api/v1/admin/sites/$SITE/v2-entities/history-cutover"
   ```
3. **Edge** — roll the edge image back (`./update.sh` to a prior tag, or
   `docker compose … up -d` on the pinned SHA). The v1 telemetry path is
   untouched, so the portal keeps working throughout.
4. **Entities** (optional, rarely needed) — the v2 entity rows are inert while the
   optimizer flag is off and the edge is v1; leave them, or delete via
   `DELETE /api/v1/admin/sites/$SITE/v2-entities/{id}` (a v1-backed producer/
   grid-meter row only loses its entity config; the master data stays).

A site with the flag off, the cutover cleared and a v1 edge image is **byte-for-byte
a v1 site** — that is the design invariant the whole test matrix guards.

---

## Verification checklist (per site)

- [ ] Preview reviewed; entity types / roles / guards match the physical plant.
- [ ] `gatewayDevice` resolved (not null).
- [ ] Apply done; `entities[]` == preview; registry `push.published` (or re-pushed).
- [ ] Site uuid added to `VOLTPILOT_V2_PLAN_SITES`; optimizer restarted.
- [ ] v2 plan observed on `ems/{t}/{s}/{d}/v2/plan`; v1 `/schedule` unchanged.
- [ ] Edge image updated; `:8484` shows the adaptive UI; device online.
- [ ] History cutover set; Historie continuous across the instant.
- [ ] Topology endpoint + portal adaptive view correct.
- [ ] Money view / earnings / Fahrplan unchanged (v1 behavior intact).
- [ ] Rollback rehearsed at least once on the rig (flag off + cutover cleared →
      pure v1).

---

## Notes & seams (for the record)

- **History bridge granularity.** The cutover splits at the bucket that *starts*
  before it (v1) vs at/after it (v2); a bucket straddling the instant is owned by
  v1. Choosing an hour/day boundary keeps the week/month views clean. The v2 era's
  grid import/export is split per 15-min quarter and summed, dimensionally matching
  the v1 rollups. A site with **no grid-meter entity** (bare hybrid) shows PV /
  Speicher / SoC in the v2 era and leaves grid/load absent — add a Netz-Zähler
  measurement point for full continuity.
- **Money is never at risk.** During the shadow phase the writer keeps producing v1
  telemetry + rollups, so earnings/optimizer economics keep reading the v1 tables.
  The bridge is a display seam.
- **Roles are derived, not stored.** The adaptive topology derives each capability's
  role from the entity's channels + category (AE1 `DefaultRole`); the preview reports
  these so you can review them. Overrides are optional
  (`PUT /api/v1/admin/sites/{id}/topology-roles`).
- **The real live cutover happens WITH the captain.** This runbook + its automated
  dry-run are the rehearsal; the production switch is a joint, supervised session.
