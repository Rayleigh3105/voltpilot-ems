# Migrating a site from v1 to the adaptive v2 EMS (MIG runbook)

This is the exact, rehearsed, **reversible** procedure to move ONE live site onto
the adaptive v2 EMS. It is written so the captain and firstmate execute it
together in minutes, per site, and can roll back in minutes (cloud-side in
seconds; the device rollback is one `./update.sh --core-image …` per device).

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

1. **The edge image** — the updated Edge-App consumes the registry push and shows
   the adaptive `:8484` UI. (Read-only sites: nothing changes about what the edge
   *does*.) A new edge image on a device that has NOT been pushed a registry is
   byte-for-byte v1, so this step is invisible to the customer — which is exactly
   why it goes **first** (see the ordering warning below).
2. **v2 entities** — composed from the existing master data (battery →
   `battery-hybrid`, PV points → `producer`, grid meter → `grid-meter`) and pushed
   to the device as a retained registry. → the adaptive topology + entity UI.
3. **The optimizer flag** `VOLTPILOT_V2_PLAN_SITES` — the optimizer then ALSO
   publishes a v2 shadow plan (`.../v2/plan`). The v1 `/schedule` plan the device
   runs on is **byte-identical**.
4. **The history cutover** — one per-site instant so the portal Historie splices
   the v1 era (before) and the reconstructed v2 era (after) into one continuous
   series.

Every one of these is independently reversible — but see **Rollback** below:
reverting fully requires **deleting the entity rows**, they are not inert.

> ### ⚠️ Order matters: update the edge BEFORE the bootstrap
> The moment `bootstrap` returns, the portal switches that site's cockpit and
> Live-Daten page from the working v1 view to the entity/Projektion view — which
> is **empty until the device publishes v2 telemetry** (verified in the browser:
> `Solar 10,4 kW · Batterie 65 %` before, `PV-Erzeugung – wartet auf Daten` right
> after). Nothing is lost, the data is intact underneath, but a customer looking
> at the portal in that window sees a dead plant. Updating the edge first shrinks
> that window from "as long as it takes you" to "the seconds until the retained
> registry push lands". The steps below are in the correct order.

---

## Preconditions (once)

- The v2 stack is deployed: the api carries the v2 migrations, and the prod
  compose runs `flowc` + `simulation` + the optimizer. Verify with
  `PATH=<python-with-pyyaml> bash tools/deploy/verify-migration-deploy.sh`
  (parses only, deploys nothing) → **ALL DEPLOY CHECKS PASSED** *and* the three
  `ok .forgejo/…` lines. Without PyYAML on the VM the workflow check FAILs
  loudly (`pip install pyyaml`); it no longer skips silently.
- You have a **platform-admin** token. All admin calls below go through the
  tenant switcher: `-H "Authorization: Bearer $ADMIN"` **and**
  `-H "X-Tenant-Id: $TENANT"` (the RLS-scoped path — a wrong/absent tenant is a
  404, never a cross-tenant write).
- Know the site's `SITE_ID` and its `TENANT`.

### Pre-flight (before the deploy window — all verified, all cheap)

- [ ] **Backup**:
      `docker exec <db> pg_dump -U voltpilot -Fc voltpilot > pre-projektion-$(date +%F).dump`.
- [ ] `SPRING_PROFILES_ACTIVE` in `/srv/docker/voltpilot/.env` is **blank** (the
      prod default). A VM that historically ran `local` is safe to blank: the
      recorded dev-seed rows + the `*:missing` guard boot cleanly.
- [ ] `VOLTPILOT_V2_PLAN_SITES` **empty** and `VOLTPILOT_FLOWS_ACTIVATION_ENABLED`
      **unset** at deploy time (nothing a customer builds can reach a device on
      day one). The flag is flipped per site, later, in step 4.
- [ ] **Broker ACL `v2/#`, per live device**, once the new api is up — an
      un-granted device fails *silently* (EMQX `deny_action=ignore`): it never
      receives the registry, stays v1, and the migration looks successful while
      doing nothing. This grep is the highest-value 10 seconds of the cutover:
      ```bash
      grep -A8 '"<device-uuid>"' /srv/docker/voltpilot/infra/mqtt/acl/acl.conf | grep 'v2/#'   # expect 2 lines
      # if missing: tools/pki/voltpilot-ca.sh issue --tenant <t> --site <s> --device <d>
      #             bash tools/pki/reload-broker-authz.sh
      ```
- [ ] **Record the edge image digests BEFORE touching any device** — that is the
      rollback target of step 2:
      ```bash
      docker inspect --format '{{index .RepoDigests 0}}' \
        git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:latest \
        git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered:latest | tee ~/edge-rollback-digests.txt
      ```
      (`./update.sh` also prints the resolved digests at the end of every run.)
- [ ] **Preview every live site** (step 1 — writes nothing, can be done today,
      against production, with zero risk) and fix the master data it reports.
- [ ] Spot-check one existing customer's cockpit + Historie + Fahrplan after the
      cloud deploy. Expect: unchanged.

> **Tell support before the deploy:** an **un-migrated** plant now reads
> „Aktive Modi 0" on `#/anlage/{id}/steuerung` and „Noch keine Geräte" on
> `#/anlage/{id}/entitaeten`, even with a claimed inverter and a running plan —
> those pages read the v2 registry, which is empty until this runbook is run for
> that site. Not a defect; it resolves on migration.

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
  re-preview if anything important is skipped. **Since U2 this list is noisier:**
  the preview only composes the three pilot types, so an entity that already
  exists as a non-pilot type — e.g. a consumer (Wallbox/Heizstab) adopted from
  the edge on the Geräte page — legitimately shows up here. An already-adopted
  or already-converted entity in `skipped[]` is **normal, not a problem**; only
  a skipped *pilot* (battery / PV / Netz-Zähler) needs a master-data fix.

The preview writes **nothing** — call it as many times as you like while fixing
master data. Do this **before** the window, for every site.

## Step 2 — Update the edge image FIRST

On the customer device (or via the standalone updater):

```bash
cd <edge deploy dir> && ./update.sh      # pulls edge-app-core + nodered, up -d
```

Wait for PASS, `:8484` reachable and the device online in the portal. **A new
edge that has not been pushed a registry is byte-for-byte v1**, so this is a
no-op for the customer — and it is what makes step 3's blank window seconds
instead of minutes. Note the digests `update.sh` prints at the end (rollback
target). To go to a specific version instead of `:latest`:
`./update.sh --tag <tag>` — the image workflow publishes `:latest` **and**
`:<commit-sha>` for both images, so any built state is directly selectable, and
the pin persists in the device's `.env` (a later plain `docker compose up -d`
will not silently jump to the newest `:latest`).

## Step 3 — Apply (create the v2 entities + push the registry)

```bash
curl -s "${auth[@]}" -X POST "$API/api/v1/admin/sites/$SITE/v2-entities/bootstrap" | jq
```

- `entities[]` must match the preview's plan.
- `push` reports the retained registry publish to the gateway
  (`published: true`; `mqtt_not_configured`/`no_gateway_device`/`publish_failed`
  otherwise — the edge converges on the next connect either way; re-push with
  `POST .../v2-entities/push`).
- **Now watch the portal live view / `:8484` come back within ~1 min.** The
  cockpit switches to the entity view immediately and is empty until the device
  publishes v2 telemetry. If it is still empty after a few minutes, the broker
  ACL (`v2/#`, pre-flight) is the first suspect — the device is silently denied
  and never received the registry.

This is **idempotent** — safe to re-run; it refreshes the same rows from current
master data (never duplicates).

## Step 4 — Flip the optimizer flag

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

Then check `docker compose -f docker-compose.prod.yml logs --tail=50 optimization`:
a normal cycle summary, **not**
`ValueError: VOLTPILOT_V2_PLAN_SITES must be comma-separated site UUIDs` — that
error means **no site at all** is being planned, fleet-wide. Copy-paste the uuid.

## Step 5 — Wait for real v2 telemetry, then set the history cutover

Only once v2 telemetry is actually flowing (the live view shows values again),
stamp the cutover so the portal Historie splices there:

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

## Rollback (minutes, no data loss)

Each step is independently reversible, and the DB needs **no** down-migration
(every v2 change is additive and unread by the old code). But **step 3 is
required, not optional** — see the warning under it.

1. **Optimizer** — remove the site from `VOLTPILOT_V2_PLAN_SITES` and
   `docker compose -f docker-compose.prod.yml up -d optimization`. The v2 plan
   stops; v1 was never affected.
2. **History** — clear the cutover, reverting the Historie to pure v1:
   ```bash
   curl -s "${auth[@]}" -X DELETE "$API/api/v1/admin/sites/$SITE/v2-entities/history-cutover"
   ```
   (Verified: buckets and totals are identical to before afterwards.)
3. **Entities — REQUIRED.** Delete every entity of the site:
   ```bash
   curl -s "${auth[@]}" "$API/api/v1/sites/$SITE/entities" | jq -r '.entities[].id' \
     | while read -r id; do
         curl -s "${auth[@]}" -X DELETE "$API/api/v1/admin/sites/$SITE/v2-entities/$id"
       done
   ```
   > **This is what actually restores the v1 face.** The entity rows are **not
   > inert**: on their own — flag off, cutover cleared, v1 edge — they still drive
   > the Steuerung modes, the Geräte page and, via topology, the whole cockpit and
   > Live-Daten view. Verified: deleting them brought back the v1 live view with
   > real values (`Solar 10,4 kW · Batterie 65 % · Haus 3,0 kW`), left the master
   > data and `asset.pv.pv_capacity_kwp` untouched, and left a v1-backed
   > producer / grid-meter `measurement_point` in place with `entity_type = NULL`
   > (so a later re-bootstrap re-composes the same row).
4. **Edge** — roll the device back to the digests recorded in the pre-flight:
   ```bash
   cd <edge deploy dir>
   ./update.sh --core-image    git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:<digest> \
               --nodered-image git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:<digest>
   # or, for a known-good published version:  ./update.sh --tag <tag>
   # release the pin again later with:        ./update.sh --latest
   ```
   The pin is persisted in the device's `.env`, so a later plain
   `docker compose up -d` does **not** silently jump back to `:latest`. The v1
   telemetry path is untouched, so the portal keeps working throughout.
5. **Cloud** — redeploy the previous `IMAGE_TAG`. **No DB down-migration**: every
   v2 change is additive and unread by the old code.

A site with the flag off, the cutover cleared, **the entities deleted** and a v1
edge image is back to the v1 experience — steps 1, 2 and 3 together, not 1 and 2
alone.

---

## Verification checklist (per site)

- [ ] Pre-flight done (backup, blank profile, flags, ACL `v2/#`, digests recorded).
- [ ] Preview reviewed; entity types / roles / guards match the physical plant.
- [ ] `gatewayDevice` resolved (not null).
- [ ] **Edge image updated FIRST**; `./update.sh` PASS; device online; digests noted.
- [ ] Apply done; `entities[]` == preview; registry `push.published` (or re-pushed).
- [ ] Live view / `:8484` back with real values within ~1 min (else: ACL `v2/#`).
- [ ] Site uuid added to `VOLTPILOT_V2_PLAN_SITES`; optimizer restarted; logs clean.
- [ ] v2 plan observed on `ems/{t}/{s}/{d}/v2/plan`; v1 `/schedule` unchanged.
- [ ] History cutover set (after real v2 telemetry); Historie continuous across it.
- [ ] Topology endpoint + portal adaptive view correct.
- [ ] Money view / earnings / Fahrplan unchanged (v1 behavior intact).
- [ ] Rollback rehearsed at least once on the rig — flag off + cutover cleared +
      **entities deleted** → v1 live view back with real values.

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
  (`PUT /api/v1/admin/sites/{id}/topology-roles`) — and **since U2 the customer
  can set them too**, via the identical RLS-fenced twin
  `PUT /api/v1/sites/{id}/topology-roles` behind the "Rollen & Zuordnung" card on
  `#/anlage/{id}/entitaeten`. A role is presentation-level and never widens
  control, so this needs no extra gate; it does mean a role you assign during the
  migration session may later be changed by the customer.
- **The real live cutover happens WITH the captain.** This runbook + its automated
  dry-run are the rehearsal; the production switch is a joint, supervised session.
