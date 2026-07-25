# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Cloud host is re-read on reconnect; default portal is `portal.voltpilot.de`

Two prod-hardening facts baked into the enroll/config layer (branch
`fm/vp-prod-cert-env-hardening`, 2026-07-03 live-incident hardening):

- **`enroll.Reconcile` adopts a changed broker endpoint, not only a changed
  device_id.** The cloud link caches the broker host at connect time (paho
  `AddBroker`), so a late-provisioned / moved MQTT host is honored only by
  tearing the link down and rebuilding it. Reconcile returns `Changed=true`
  when `MqttHost`/`MqttPort` differ even if `device_id` is unchanged; the
  agent's `adoptIdentity` then rebuilds the link on the new endpoint. Do NOT
  narrow the change check back to device_id only - a paho auto-reconnect would
  keep dialing the stale cached host forever. Pinned by
  `enroll_test.go TestReconcileAdoptsChangedBrokerHost`.
- **`config.Defaults().PortalBaseURL` is `https://portal.voltpilot.de`** (the
  `portal.` subdomain), kept in lockstep with `edge-app/docker-compose.yml`
  `VP_PORTAL_BASE_URL` + `install.sh`. The bare apex `https://voltpilot.de` is
  NOT a working enrollment endpoint.

Prod-deploy cert/env hardening lives outside edge-app: `server.key` must be
emqx-readable (`docs/deploy.md` step 3), the deploy workflows chmod
`infra/mqtt/certs/*` + preflight-require `MQTT_DOMAIN` when enrollment is on
(`.forgejo/workflows/deploy*.yaml`, `.env.prod.example`).

## install.sh / update.sh: shared compose template (lockstep chain)

`update.sh` (the one-command edge updater) **sources** `install.sh` to reuse
`generate_compose()`, the `# @voltpilot-edge-install:` marker, and the shared
helpers - `install.sh` guards its `main "$@"` behind a `BASH_SOURCE` check for
exactly this, so there is ONE compose template, never a duplicated copy.
Consequences:

- `update.sh` requires `install.sh` in the same directory (script dir or CWD);
  it fails with a fetch hint otherwise.
- The lockstep chain is: repo `docker-compose.yml` -> `install.sh
  generate_compose()` (guarded by `test/install-selfcheck.sh`) -> `update.sh`
  (guarded by `test/update-selfcheck.sh`, which pins `update.sh
  --print-compose == install.sh --print-compose`).
- `update.sh` additionally embeds the **hostnet override template**
  (`generate_hostnet_compose()`), which must stay byte-identical (minus its
  marker first line) to the repo `docker-compose.hostnet.yml` -
  `test/update-selfcheck.sh` fails on drift. Changing
  `docker-compose.hostnet.yml` means updating `update.sh` too.
- Both self-checks are docker-free at their core (structural + behavioral via
  `update.sh --dry-run`, which deliberately degrades to file-only checks
  without docker); compose-config validity/equivalence run only when a modern
  `docker compose` v2 (one that understands the top-level `name:` key) is
  present.

## Node-RED SunSpec polls: never overlap, never silent (real device-down 2026-07-13)

A full SunSpec model-discovery walk on a REAL Fronius (many sequential FC3
round trips) can outlive the 5-s poll interval; the device's Modbus gateway
handles a second TCP connection by displacing the running one, so overlapping
poll ticks meant NO walk ever completed - "Verbindung testen" (one-shot,
test-read.js) worked while the ongoing source poll stayed `pending` forever.
Rules baked into `build-flows.js` (`sources-read` + `auto-sunspec`), pinned by
`flows-sync.test.js` and reproduced by the slow single-session server in
`sources-read.e2e.test.js`:

- **Skip-if-busy per poll node**: a tick that arrives while the previous read
  is in flight is SKIPPED (`context` flag, 120 s stale expiry) - never a second
  concurrent connection to the same device.
- **Mirror test-read.js's invocation**: a FRESH `makeSunspecReader` per read
  with explicit `connectTimeoutMs`/`readTimeoutMs` (8000, the test-read
  defaults).
- **Never swallow a failed read silently**: a null/failed source read emits a
  rate-limited (60 s) `node.warn` naming the source + why, plus node status.
  The old `.catch(() => null)` hid this bug for a full release cycle.
- A faithful poll regression test needs latency + single-session semantics +
  a multi-model image AND ticks driven at real cadence with a SHARED node
  context - a single fast happy-path read proves nothing about the poll.

## Node-RED source chain: palette validation is STRUCTURAL only, trace every decision (2nd real device-down 2026-07-13)

The SAME device stayed `pending` even after the overlap fix, with NO data and
NO warn in `docker compose logs nodered`: `vp-sources-config`'s `parse()`
carried a stale communication whitelist (solarman_v5 + modbus_tcp) and
silently dropped the `fronius_sunspec` source BEFORE the flow ever saw it -
the store planned nothing, the read node idled on "keine Quellen". The e2e
tests stayed green over the bug because they injected `msg.payload` straight
into the store node, bypassing the palette parse. Rules now baked in:

- **The palette config nodes validate STRUCTURE only** (id/communication/
  family/connection.ip) - they must NEVER whitelist communication values.
  `vp-inverter-config` had the SAME stale whitelist, making the auto tab's
  fronius_solar_api/fronius_sunspec PRIMARY router branches unreachable (fixed
  alongside). Deciding readability is the flow's job: the sources store node
  logs a loud `NICHT VERDRAHTET`/`ZURUECKGESTELLT` `node.warn` per unwired
  source; the inverter router goes idle with a named status.
- **The whole chain traces unconditionally** (rate-limited 60 s per key, a
  state CHANGE always logs) via `node.log`/`node.warn`: config receipt +
  per-source routing (store), no-plans / busy-skip / read start / result /
  publish / cycle summary (read node). One `docker compose logs nodered` is
  definitive about where a source dies.
- **Every per-source read runs against a hard overall `Promise.race` cap
  (30 s)** so `src_busy_since` is always cleared - a hang ends as a logged
  Gesamt-Timeout, never a permanent silent skip.
- A faithful repro must start from the retained `edge/sources/config` BYTES
  the core's `busEntry()` publishes and run them through the REAL
  `vp-sources-config` parse (see the REGRESSION test in
  `sources-read.e2e.test.js` + the aedes-bus test in vp-palette) - injecting a
  hand-built list into the store node proves nothing about the config path.
- The vp-palette `package-lock.json` pins a corporate npm mirror; on a clean
  machine temp-rewrite it to registry.npmjs.org, `npm ci`, then
  `git checkout package-lock.json`.

## `fronius_sunspec` PV source: AC only for a BATTERYLESS inverter (Model 124 gate)

`sunspec/sunspec-live.js decodeInverter` publishes `pv_power_kw` from the
inverter's **AC** `W` only while the discovery walk finds **no Model 124
(Storage)** — a batteryless string inverter (the live Fronius Ecos), where AC
output IS the PV, `max(0, W)` clamp included. With Model 124 present the device
is a **hybrid** (AC = PV + discharge − charge), so PV comes from the inverter
model's **DC** power (`DCW`, model 113 float / model 103 int+SF) with the
one-sided clamp DROPPED (a sign/scale error must be a visible negative, not a
silent 0); an unreadable `DCW` publishes NOTHING rather than an AC number. The
DCW offsets are the standard SunSpec definition but are **VERIFY-on-device** —
no hybrid Fronius exists on any live site (see `nodered/FRONIUS.md` §5b).
Consequence for fixtures: **never pad a SunSpec test image with model id 124** —
its presence means "hybrid" (`sources-read.e2e.test.js` `PAD` list). Pinned by
`sunspec/sunspec-live.test.js` (hybrid sweep / negative DCW / unreadable DCW /
batteryless unchanged) and, for the already-clean Deye, by the
`deye-decode.test.js` `0x024E` battery sweep. Background:
`firstmate/data/vp-pv-battery-bug/report.md` §7.

## House-consumption STANDARD (captain decree 2026-07-17) + battery-power sourcing

`Haus = Erzeugung − Einspeisung − Batterie` is THE rule for every vendor:
`agent.go onLocalTelemetry` folds in ONE order — pv-sum (Σ fresh Erzeuger) →
grid precedence (fresh Netz-Zähler > primary inverter grid reading) → measured
battery → `house = pv_total + grid − battery` overwrites `load_kw` BEFORE the
gates. It is **ON BY DEFAULT** (a single inverter trivially measures the
connection point; the captain's hybrid_3p External CT sees AC-coupled
Erzeugers too); `sources.BalanceSettings.PrimaryGridNotSiteTotal`
(`data_dir/balance.json`, `POST /api/balance`, `:8484` Netz-Zähler group) is
the expert OPT-OUT ("CT sitzt NICHT am Hausanschluss") — a legacy opt-in-era
balance.json migrates to standard-ON regardless of its value
(`BalanceStore.Load`). Rules:

- **Battery is READ, never computed** ("Register lesen … nicht berechnen!"):
  the balance term and the `:8484` battery line (history ring `Sample.BattKw`,
  wire key `batt`) are the measured `battery_power_kw` — or a physical 0 for a
  provably batteryless family (`inverter.FamilyBatteryless`). The balance
  derivation `BatteryKw()` survives ONLY as a drift-logged internal
  cross-check (`battDriftLogKw`; a persistent drift flags a wrong grid
  register — exactly how the captain's hybrid_3p alias bug showed).
- **Honesty per class** when the battery reading is missing: a PROVABLE hybrid
  (`FamilyHasBattery`) drops `load_kw` outright (chart gap — never pretend
  battery=0); an unknown family (no selection, generic Modbus, Fronius Solar
  API — P_Akku sign still verify-on-device, battery not forwarded) falls back
  to the raw-load path. The raw-load path (primary load register, with the
  #155 netting correction when Erzeuger exist: `load < −1 kW` proves
  netting → `load + Σac`, else `max(0, load − Σpv)`) survives ONLY without a
  usable site grid or for those unknown-family primaries.
- **`battery_power_kw` stays a LOCAL-BUS-ONLY field on `edge/telemetry`**
  (+charge/−discharge; flow decodes forward it, `vp-telemetrie.shape()`
  whitelists it): never a cloud measurement channel — the cloud keeps deriving
  battery from the balance, which with the standard house resolves to the
  measured value. Surfacing the register cloud-side = additive-field
  follow-up.
- **hybrid_3p grid = the External CT `0x026B`/`0x02C4`** (connection point;
  `0x0271` "Grid Power" is a config-dependent alias kept only as decode
  fallback) — rationale + captain's live falsification in
  `nodered/DEYE.md` §hybrid_3p.
- Tests: core `agent/house_balance_test.go` (the captain's live site as the
  canonical fixture: pv 23,7+22+26,9 = 72,6, grid −54,2, batt 0 → house 18,4;
  meter precedence, opt-out, per-class honesty, migration),
  `internal/history`, `deye/deye-decode.test.js` + `flows-sync.test.js`
  (External-CT decode + alias fallback). Docs: `nodered/CUSTOM-INVERTER.md`
  §1.3 (field table).

## Multi-source fold: composition changes are EXPLAINED steps (3rd real device bug 2026-07-17)

The captain's two-Fronius-at-one-Datamanager site (`nodered/FRONIUS.md` §5c has
the worked example + the unit-id convention) froze the PV tile at primary+WR1
while WR2 showed "Liefert Daten". Chain: the fixed 60-s source-freshness window
dropped the slowly-read (sequential double SunSpec walk) WR2 in and out of the
sum → the composite oscillated → every flip restarted the despiker's
confirmation candidate ("Streng" preset) → the tile never adopted the new
level. Rules now baked into `core/internal/agent/agent.go` (pinned by
`agent/source_agg_test.go` with the live numbers):

- **Source freshness follows the ACHIEVED cadence** (`sourceFresh`:
  max(3·interval, 3·observed period, 60 s), capped 15 min). A delivering
  source must never drop out of the sum for being read slowly.
- **A changed fold composition resets the despiker/envelope baselines** of the
  affected channels (`noteSourceMix` → `ResetChannels`): the step is
  configuration, not a device spike. Without this, strict presets freeze on
  any source add/remove/flap.
- **A meaningfully negative primary load (< −1 kW) with Erzeuger PV proves the
  netting topology** (`load_reg = house − Σac`, the site-total-CT algebra) →
  house = load + Σac; the established `max(0, load − Σpv)` branch stays for
  load ≥ 0 (ambiguous). Both live ONLY on the raw-load fallback path since the
  2026-07-17 standard (see the house-consumption-standard section above).
- **A kWp-less Erzeuger disables the PV envelope bound** (no honest bound
  exists; a stated one would clip real power). Enter per-inverter kWp.
- The multi-inverter unit-ID auto-detection (`/api/probe-units` →
  `test-read.js makeProbeUnits`, bounded SID scan 1..10) is fronius_sunspec
  only; the UI offers per-unit source creation, never silent auto-add.

## E2 flow platform core: arbitration + flow deployment (fm/vp2-e2-flow-core)

The v2 runtime slice on top of E1a. Read `docs/contracts/v2/` first (binding;
E2's additive clarifications are logged in its README decision log). The
authoritative implementations + their proofs:

- **Arbitration** (`core/internal/desired`, wired in `agent/arbitration.go`):
  desires on `edge/entities/{id}/desired` → priority classes → per-entity
  guard chain (`entities.ClampCommandsTraced` composing the v1 device limits,
  most restrictive wins) → retained `…/command` + arbitration events. The
  ARBITER owns the entity command topic since E2 (the E1a applySetpoint
  mirror is retired); the entity's HOLDER also drives the physical
  `edge/setpoint` write (`applySetpoint` consults `arb.HolderCommand`) — the
  registry FAILSAFE deliberately stays with the v1 fallback computation.
  Plan injection precedence: a fresh v1 plan controls the battery (shadow
  phase); the v2 plan (`internal/plan2`, `…/v2/plan`) drives the rest.
  Proofs: `desired` units, `agent/arbitration_integration_test.go` (P1–P6
  in-process), `edge-app/test/e2e-v2-compose.sh` (compose rig).
- **flowc compiler** (`nodered/flowc`): deterministic graph→NR-tabs with an
  RFC 8785 content hash. THE LOCKSTEP: `canonicalize.js` ⟷
  `core/internal/flowdeploy/jcs.go` share `flowc/jcs-vectors.json`, and the
  committed `flowc/testdata/*.artifact.json` is verified by the Go deployer
  (`crosscheck_test.go`) — never change one side alone. `pinned-hash.txt`
  pins compiler output; a deliberate output change must update the pin (it
  invalidates deployed content hashes). ALSO a CLOUD consumer now: `serve.js`
  wraps `compile()` as the `flowc-serve` HTTP sidecar the JVM api calls during
  flow activation (root AGENTS.md "flowc-serve bridge"); `serve.test.js` pins
  the graph→artifact→pinned-hash path. Keep the module dependency-free —
  `serve.js`/`Dockerfile` copy only `canonicalize.js`/`catalog.js`/`compile.js`.
  **U3 (#514) added to `catalog.js`:** `vp.logic.and`/`.or` (bool combinators,
  two `a`/`b` inputs → `result`; since #519 the generated body keys on a
  COMPILE-TIME per-edge discriminator — the compiler emits a tag node per
  incoming edge setting `msg._vp_src` to the graph port name — because the old
  `msg.topic` key collapsed two topic-less branches into one slot and computed
  the WRONG boolean), `vp.price.current` (→ `vp-feed` `feed:'price_current'`,
  now in the palette's `FEEDS` whitelist so the node is idle-safe "keine Daten"
  instead of dead; the node is `gated` in the api/portal catalogs until the E4
  price down-channel exists), and
  `vp.schedule.window` now accepts the editor's ENUM `days`
  (`alle`/`werktage`/`wochenende` → day-number array via `scheduleDays()`); the
  old `0..6`-array-only rule made EVERY schedule flow un-compilable. New fixtures
  `flow-graph.valid.{compound,price}-wallbox.json` + `pinned-{compound,price}-hash.txt`.
  The type SET stays synced with the api/portal catalogs (the `compile.test.js`
  drift guard) — add a node to all three together.
- **Flow deployment** (`core/internal/flowdeploy`, `agent/flows.go`):
  retained `…/v2/flows` set → verify (hash / semver gates / capabilities;
  palette version LIVE from NR `GET /nodes`, never an env) → per-flow Admin
  API materialization of `@vp-flow` tabs → heartbeat `flows` acks. Needs
  `VP_NODERED_ADMIN_URL` (+ the NR adminAuth credentials) on the CORE;
  unset = verified + persisted but acked `error` naming the setting.
- **Read-only "Aktive Steuerung" strip (`:8484`, U6 `fm/vp-uo-u6-edge`, report
  §7)**: the edge shows the RESULT of the portal-composed flows, never the
  graph. `Agent.ActiveControl()` (`agent/arbitration.go`) reuses the SAME core
  facts the heartbeat carries — `flowsSummary()` (deployed `@vp-flow` acks +
  palette) + `arb.DecisionFor` per entity (winner holder/source/setpoint +
  readback) — enriched with the entity label/type; carried as the additive
  `cloud.ActiveControl` block on `/api/state` (`web.ActiveControlController`),
  rendered by `static/active-control.js`. Empty flows AND entities → the page
  empty state. NO write path, NO editor (composition stays 100% portal). Tests:
  `web_test.go TestStateEnvelopeCarriesActiveControl`/`TestActiveControlStripServed`,
  `arbitration_integration_test.go TestFlowDeploymentAppliedAndAcked`
  (`ActiveControl()` reflects the real deployed flow + battery winner).
- **Reseed coexistence (D-12)**: `nodered/reseed-merge-flows.js` + the
  entrypoint merge — vendor tab group from the image, `@vp-flow` tabs
  byte-identical; degradation to wholesale only with a loud WARN (the
  retained deployment self-heals). Per the #117/#119 law, changes here need
  the REAL-image proof: `reseed-flows.docker.test.sh` (+ `reseed.test.sh`
  cases 6/7, `reseed-merge.test.js`).
- **Rig host caveat**: `test/e2e-v2-compose.sh` pre-builds images with plain
  `docker build` (old-buildx hosts cannot run `compose build`) and its
  overlay pins `pull_policy: never`.

## E1b entity generalization (edge half): open types, capability guards, v2 buffering

Extends the E1a entity layer (root AGENTS.md "v2 entity model - generalization (E1b)"). Edge specifics:

- **Open types + category-inferred guards** (`internal/entities`): `ParseRegistryPush`
  accepts any well-formed kebab-case `entity_type` (skips only MALFORMED, never a
  known-vs-unknown gate). `Entity.category()` derives the guard semantics from
  what the entity DECLARES, not its name — pilots pinned; storage-shaped guard
  limits → the full battery chain incl. D-8; `max_generation_kw` → producer
  reduce-only; measure-only-failsafe / no actuate list → drop-everything;
  otherwise the CONSUMER clamp `[0, min(capability max, max_consumption_kw)]`
  (setpoint ≥ 0, on_off pass-through, `mode` validated against the declared set).
  So a wallbox/heating-rod/generic-load works with zero edge release; a real
  DRIVER for it is E6.
- **v2 uplink store-and-forward** (`internal/buffer` + `agent/entities.go`): the v2
  entity uplink rides the SAME disk ring as v1 (E1a was live-only, dropped on
  outage). `buffer.Entry` gained an optional `entity_id` discriminator (old JSONL
  stays v1 — no on-disk migration); `AppendEntity` enters accepted readings with
  their ORIGINAL ts; the ONE `publisherLoop` drains both eras confirm-then-ack,
  branching on `e.EntityID` to `PublishTelemetryV2(buffer.Entry)`; the purge
  watermark + unclaim-pause apply verbatim. The E1a `entityUplinkLoop`/`entUplink`
  channel are retired.
- **Bidirectional Ist in the heartbeat** (`cloud.EntitiesSummary`): the `entities`
  block gains `observed` (per-entity applied type + health ok|stale|never +
  last_telemetry_at + channels, from `entReadings` with a 5-min liveness window)
  and `local_setup` (the edge-authoritative `:8484` inverter selection + sources
  — the commissioning Ist the cloud reconciles but never auto-imports). Only ships
  once the device has v2 entities (a registry-less device stays byte-for-byte v1).
- **Proof**: `agent/entities_buffer_integration_test.go`
  `TestWallboxEntityBuffersUplinkAndArbitratesDesired` — the rig-level chain in
  one test: retained wallbox registry push → retained local config → buffered v2
  uplink → cloud outage → ordered original-ts replay → observed-health heartbeat →
  flow desired → E2 arbitration clamps 22→11 kW consumer band. Plus
  `internal/entities` consumer-clamp + open-type units, `internal/buffer` entity
  round-trip.

## Anlagen-Topologie-Read-Model (AE1, edge half)

`internal/topology` is the CANONICAL copy of the shared derivation (Go↔TS↔Java,
pinned to `docs/contracts/v2/topology-vectors.json`; contract
`docs/contracts/v2/topology-read-model.md`; full rules in the root AGENTS.md
"Anlagen-Topologie-Read-Model (AE1)" section). `Agent.Topology()`
(`internal/agent/entities.go`) builds it from the applied entity registry +
latest per-entity readings via `topology.Resolve` (default roles, first-of-role
= maßgeblich) → `topology.Derive`, and `web.Handler`'s `TopologyController`
carries it as an ADDITIVE `topology` block on `/api/state` + `/api/stream`. The
scalar `pv_kw`/`load_kw`/`grid_limit_kw`/`soc_pct` fields stay; a registry-less
device yields an empty topology (byte-for-byte v1).
`entities.Entity.Category()` is the exported category for default role
resolution. Tests: `internal/topology/topology_test.go`, `internal/web`
`TestStateEnvelopeCarriesTopology`.

## Local entity composition (M-B3-local): the :8484 view of a MIGRATED plant

A v1→v2 migrated plant gets its entity registry pushed, so `:8484` flips to the
entity tiles + adaptive Energiefluss — but its Layer-1 flows still publish only
the v1 composite site sample, so every tile read **"wartet auf Daten"**.
`entities.ComposeLocal` (`internal/entities/compose.go`) is the LOCAL twin of the
cloud's `ComposedEntityFanout`, called at the ONE `onLocalTelemetry` choke point
(`agent.composeEntities`, after the gates) and consulted by `Agent.Topology()`
through `entityReading` — a REAL per-entity publisher on
`edge/entities/{id}/telemetry` always WINS.

- Channel map (byte-for-byte the fan-out's, `data/vp-v2-entity-backfill/report.md`
  §3): battery-hybrid `soc_pct`/`pv_power_kw` + `battery_power_kw =
  power_kw − load_kw + pv_power_kw`; grid-meter `power_kw` (signed);
  house-load `power_kw ← load_kw`. Only COMPOSED types, only DECLARED measure
  channels, an absent site channel → NO value (never a fabricated 0; the derived
  battery needs all three inputs).
- **HARD BOUNDARY — display-only.** It never reaches `buffer.AppendEntity`, the
  v2 uplink, or the heartbeat's `observed` Ist. The cloud receives the same v1
  sample and fans it out itself; uplinking here would DOUBLE-WRITE `telemetry_v2`.
  Retiring the fan-out in favour of real edge v2 telemetry is a separate,
  coordinated step.
- `house-load` is **category-PINNED to consumer** in `Entity.category()`: it
  declares no actuate capability, so the "measure-only" inference made it a METER
  and the read-model folded the Hausverbrauch into the Netz node. This matches
  the cloud type catalog (`services/api .../entitytypes/catalog.json`) and is
  guard-safe (no actuate ⇒ the capability gate refuses every command).
- Tests: `internal/entities/compose_test.go` (channel map, NULL-channel rule,
  real-zero, composed-types-only, house-load category) and
  `internal/agent/entities_compose_test.go` (the symptom end to end + the
  uplink boundary + real-telemetry-wins).

## AE6 :8484 adaptive energy picture (edge half of AE2/AE3)

`static/dashboard.js` renders the topology block: `createFlow($("flowWrap"))`
routes the energy diagram between the ADAPTIVE N-node topology diagram (v2
entities present) and the fixed 4-node `buildV1Flow` (v1 fallback), and
`renderKpis` swaps the fixed `#kpis` cards for entity/role-driven `#kpisAdaptive`
tiles (`renderAdaptiveTiles`/`deriveTiles`). Both are read-only ports of the
portal's pure `adaptiveFlow.layoutFlow` + `adaptiveLive.deriveTiles`, so the
:8484 view matches the portal AE2/AE3 (same lightning-hub / soft-circle-node /
animated-dashed-spoke look, `--pv/--load/--grid-c/--batt` role hues). A device
with NO topology stays byte-identical v1 (`hasTopology` gates it). The edge
topology block carries only role nodes + members (NO entity-type list), so
consumers use the role home icon + member label — a new Wallbox/Heizstab still
appears automatically as its own node + tile. `static/*` is `//go:embed`-ed —
REBUILD the core binary after edits (any `go build`/`go test ./internal/web`
re-embeds). Test: `internal/web` `TestAdaptiveEnergyPictureServed`.

## go-e Charger read-only driver (consumer source, HTTP API v2)

A go-e wallbox is a READ-ONLY CONSUMER source (`fm/vp-goe-read-driver`). The
canonical decode is `nodered/goe/goe-api.js` (offline-tested `goe-api.test.js`):
ONE keyless GET `http://<ip>/api/status?filter=nrg,car,alw,amp,wh`, map
`nrg[11]` (total charging power) → `load_kw`. **`nrg[11]` is in WATTS in the v2
API** (per marq24/ha-goecharger-api2, which declares `nrg` idx 7..11 as
`UnitOfPower.WATT`; this DIFFERS from v1's 0.01 kW) — VERIFY-on-device like every
vendor scale. Absent-not-zero discipline: a real 0 W (unplugged/not charging) is
KEPT, an absent `nrg[11]` is OMITTED (never fabricated 0). `car` states 0..5 =
unknown/idle/charging/waiting/complete/error surface as honest status only.

Wiring (mirrors the Fronius Solar-API read-only precedent — never in a control
allowlist):
- Catalog: brand `go-e` / communication `goe_http_api` (`inverter.go`), one
  generic model, NO `RatedKw` (physical-envelope guard stays inactive). Served by
  `GET /api/inverter` + `GET /api/sources`.
- Source role `consumer` (`sources.RoleConsumer`, `sources-routing.js`
  `ROLE_CONSUMER`); its `load_kw` rides `edge/sources/{id}/telemetry` → the new
  `vp-verbraucher` palette node (output 3 of the "Energiequellen (automatisch)"
  read tab). The Go agent RECORDS consumer `load_kw` (`onSourceTelemetry` →
  `sourceReading.load` → `SourceLastReadings`) for freshness/status; its
  aggregation into the house balance / a consumer entity is topology-layer work.
- `test-read.js` gained a `goe_http_api` one-shot read path.
- `build-flows.js` embeds `goe/goe-api.js` into sources-read + test-read (rebuild
  `flows.json` via `build-flows.js`; `flows-sync.test.js` pins the embed).
- Proof: `goe/goe-api.test.js`, `test-read.test.js` (go-e HTTP cases),
  `sources-routing.test.js`, `flows-sync.test.js`, `sources-read.e2e.test.js`
  (real in-process HTTP server → publish on output 3), Go
  `inverter_test.go`/`sources_test.go`/`agent/source_agg_test.go`.
- UI-complete since U6 (`fm/vp-uo-u6-edge`): the `:8484` add-source picker
  (`static/sources.js` + `inverter.html`) offers a **Verbraucher** role card
  (`roleVerbraucher`), brand-by-role filtering (`brandsForRole` — a consumer
  picks the `goe_http_api` driver, Erzeuger/Netz never offer it), a Verbraucher
  list group (`verbList`/`verbEmpty`/`verbNote`) and the consumer `load_kw`
  reading line — so a go-e wallbox is addable end to end in the UI (no
  `POST /api/sources` step). Pinned by
  `web_test.go TestInverterPageServesModelPickerStructure`. The Go
  `sources.Normalize` already accepted `RoleConsumer`.

## go-e Charger CONTROL adapter (certified, arbiter-driven, single-writer)

The write/execution counterpart to the read-only go-e driver (`fm/vp-goe-control`).
Unlike Deye/Fronius (guessed firmware registers → `bench_pending`), go-e's HTTP API v2
is documented + deterministic, so the whole write→readback loop is software-provable and
the family is **CERTIFIED** (may go live behind the kill-switch `VP_CONTROL_ENABLED`).

- **Canonical mapping = `nodered/goe/goe-control.js`** (the write twin of `goe-api.js`):
  pure `controlPlan(config, command, opts)` — kW→A (`I = P/(phases·voltage)`, **FLOORED**
  so actual charge never exceeds the arbitrated setpoint) → tri-state `frc` (go-e
  forceState: Neutral=0/Off=1/On=2) + `amp` (requestedCurrent), clamped to the go-e
  current band [min≈6, max]. Below-min/zero/`on_off=false` → **Off**; stale/loss/no-command
  → **Neutral** (hands control back, never a stuck forced current); kill-switch off →
  **no writes, readback still runs**. Plus `evalReadback` (commanded-vs-actual match from
  `/api/status` frc/amp; car/nrg[11]/acu/alw informational) and `makeExecutor(deps)` (the
  deps-injected HTTP set→readback loop, the `test-read.js makeReadOnce` pattern). Keys
  quoted from go-e API v2 `apikeys-en.md` — **`psm`/phaseSwitchMode is NOT a settable v2
  key**, so phases is a config input for kW→A only, never written. Tests
  `goe/goe-control.test.js` (offline + in-process HTTP server: match/mismatch/unreachable/
  kill-switch).
- **The physical writer lives in the GO CORE** (`internal/goe` = the Go twin of
  goe-control.js, pinned to the SAME golden vectors `goe/goe-control-vectors.json` — the
  refCheckChar/EdgeRef + SocPlausible cross-language lockstep; `TestSharedVectors` on both
  sides). Chosen as the **single writer** (avoids a dual-writer on the same wallbox HTTP
  socket): the E2 arbiter already owns the clamped consumer command + the entity `Driver`
  block (go-e ip) + the readback plumbing, and go-e is HTTP-native. `agent/consumer_control.go`
  reads `arb.DecisionFor(id).Granted` for each go-e-backed wallbox entity (driver
  `communication:"goe_http_api"`), runs `goe.Execute`, and publishes `edge/entities/{id}/readback`
  (the v1 all_match shape the arbitration layer's `onEntityReadback` already folds into the
  heartbeat). **Gated on `VP_CONTROL_ENABLED`: OFF (default) = ZERO HTTP** — a read-only
  deployment (the two live sites) is never touched. Periodic re-assert (60 s) so a rebooted
  wallbox re-adopts; change-detected so an unchanged command is not re-written every tick.
  Proof: `agent/consumer_control_test.go` (desired 22 kW → arbiter clamps to the 11 kW band
  → go-e set frc=On/amp=15 @ 3×230 → readback all_match on the bus; kill-switch-off = no HTTP;
  non-go-e entity skipped).
- **Node-RED is deliberately NOT the go-e writer** (single-writer). `goe-control.js` stays
  the canonical JS reference (embedding-ready) but is not embedded into a flow; `flows.json`
  is unchanged and `flows-sync.test.js` stays green. If the captain prefers a flow-side
  executor, embed `goe-control.js` via `build-flows.js` and retire the Go path — do not run
  both.
- **VERIFY-on-device** on the first real wallbox (frc/amp semantics + phase behaviour) is
  the honest final step, but there is NO per-model bench gate — see `nodered/CONTROL-BENCH.md`
  → "go-e Charger". Control safety: off by default, upstream guard authoritative (executor
  never widens the clamped setpoint), fail-safe neutral, readback published.

## First-Light calibration: the guided, bounded first real write to a live battery

The safe on-device surface (`:8484` „Steuerung kalibrieren") that proves a battery
inverter's control **sign + scale** on the REAL hardware via small, observed,
auto-reverting test writes, BEFORE the family is certified (design
`data/vp-battery-control-deepdive/report.md` §5.7; operator flow
`nodered/CONTROL-BENCH.md` → „First-Light-Kalibrierung"). It is the mechanism for the
very first real write to a live customer battery, and the whole point is the safety
envelope — implemented exactly:

- **`internal/calibration`** is the PURE state machine + sign/scale/magnitude verdict
  (no I/O; every time-dependent method takes `now`, so the envelope is deterministically
  testable). `agent/calibration.go` wires it: the bounded write path, the auto-revert
  watchdog, the measured-battery cross-check, the persisted per-device certification, and
  the `web.CalibrationController` surface. Endpoints `GET /api/calibration` +
  `POST /api/calibration/{arm,test,abort,confirm,correction,certify}`; card `static/calibration.js`.
- **The bounded write path** (`Agent.calibrationOverride`, published on `edge/setpoint`):
  a test setpoint is magnitude-capped (`VP_CALIBRATION_MAX_KW`, default 1.0 kW) AND still
  run through `guards.Clamp` (never around it), auto-reverts to the neutral release after
  `VP_CALIBRATION_TTL_SECONDS` (default 30 s) via a controller-owned `time.AfterFunc`
  watchdog (independent of the UI — the write NEVER latches), is off by default (explicit
  arm required), and its `control_enabled` bypasses **ONLY the certification allowlist** —
  it is still ANDed with `VP_CONTROL_ENABLED`, so the global kill-switch stops it dead.
  `source:"calibration"` + `calibration:true` mark it; it never grid-charges (EEG-safe).
- **The executor bypass** (`inverter-control-routing.js` + the synced `build-flows.js`
  copies, pinned by `flows-sync.test.js`): `setpoint.calibration===true` (and
  `controlRelease(opts.calibration)`) let an UNCERTIFIED Deye emit its EXISTING mapped
  WriteOps with `dwell_s=0` (a bounded manual test, so the revert is never blocked by the
  900 s EEPROM dwell). It REUSES the executor/guards/readback/release — nothing widened.
  Production (no flag) is byte-identical read-only.
- **The certification hand-off** (`CalibrationCertify`): gated on the operator confirming
  BOTH sign and scale (`Passed`), it writes the family into a persisted per-device set
  (`data-dir/calibration-certified.json`) that `Agent.controlCertified` merges with the env
  allowlist — so a released family drives the optimizer/arbiter live with NO env change.
  Never auto-certifies; a sign/scale correction resets the confirmations and revokes it.
  The fleet-wide certification stays the `VP_CONTROL_CERTIFIED_FAMILIES` allowlist edit.
- **`invert_control_sign`** (the WRITE-path sign, separate from the read-path
  `invert_grid_sign`) is plumbed through `inverter.Connection` + `BusPayload` + `Normalize`
  so the calibration sign correction actually reaches the control adapter.
- Proofs: `internal/calibration` units, `agent/calibration_test.go` (cap, guard clamp,
  cert-bypass-without-kill-switch-bypass, auto-revert, persisted+merged cert, correction
  resets+decertifies), `web` endpoint + card-structure tests, `inverter-control-routing.test.js`
  + `deye-control.e2e.test.js` (real in-process Solarman-V5: a small calibration write
  lands + reads back + matches WITHOUT certifying; the revert disables ToU on the wire).
- **The verdict is only trustworthy from a QUIET baseline + a LANDED write (fm/vp-deye-sign-fix-v6, 2026-07-25).** Two live-Pilsting defects: (1) `Verdict` judged the ABSOLUTE measured battery power, so the battery's NATURAL activity (a ~31 kW PV-surplus charge) produced a confident verdict unrelated to the command. `calibration.Verdict` now flags `BaselineBusy` (no confident sign/scale) when `|before| > max(0.1, 0.5·|cmd|)` or the baseline is unknown - a ToU command sets absolute power, so absolute-after is fine ONLY from a near-idle baseline. The card also gates the "hat die Batterie sich bewegt?" ROW on `write_readback_ok` for the CURRENT test and marks an idle-phase (stale) test "nicht mehr aktuell" - a stale/never-landed test never shows a confident row again. This makes `CanConfirm*`/`CanCertify` STRICTER, never looser. (2) The MEASURED battery sign was INVERTED - see the read-sign footgun in the Deye-control-WRITE section.

## vp-modbus-read (MB-M1): generic Modbus flow read + the shared connection manager

Palette **0.3.0** adds `nodes/vp-modbus-read.js` (catalog type `vp.modbus.read`): a
trigger-driven generic Modbus-TCP register read (FC3/FC4, u16/s16/u32/s32/float32 ×
word order via the codec) that optionally records each reading as edge-entity
telemetry on `edge/entities/{id}/telemetry` - the normal E1b uplink carries it, no
edge release logic knows "modbus" specially. Rules that must hold:

- **`lib/modbus-conn.js` is the ONE Modbus I/O path for vp-modbus nodes** - it bakes
  the 2026-07-13 poll law in as a library (one in-flight op per (host, port) across
  ALL tabs, bounded drop-oldest queue, fresh socket, 8 s/8 s/30 s caps, never
  silent). A future vp-modbus-write must reuse it, never open its own sockets.
- **`lib/modbus-tcp.js` is a byte-identical synced copy** of
  `edge-app/nodered/modbus-tcp.js` (a palette package cannot require repo files);
  `test/modbus_spec.js` guards the drift - after editing the codec, re-copy the
  file AND re-run `nodered/build-flows.js` (the test-read flow node embeds a copy
  too, `flows-sync.test.js` guards that one).
- **READ-ONLY**: no write path exists in 0.3.0 (M2 is the gated write). The deadband
  gates the flow emission only; entity telemetry records every successful read; a
  failed read emits NOTHING (status + rate-limited warn).
- The artifact `min_palette_version` lifts to 0.3.0 for flows using the node - old
  devices ack `unsupported` with the palette-floor copy
  (`flowdeploy/crosscheck_test.go` pins it). Root AGENTS.md "Generic Modbus READ
  node (MB-M1)" has the full picture (catalogs, validators, D-15).

## Per-source status in the heartbeat (#524)

`agent.sourcesSummary()` (`internal/agent/entities.go`) folds an additive
`sources` block into the status heartbeat: the primary inverter plus every
configured source with its OWN latest reading + `ok|stale|never` health, so the
PORTAL can explain a multi-inverter site's composite PV instead of showing one
opaque number. It only REPORTS - the composite telemetry fold is untouched, and
the block rides the status channel, never telemetry. The primary's pv comes from
`Snapshot.LastReading` (captured BEFORE the multi-source fold - never the
composite); sources reuse the existing `SourceStatuses`/`SourceLastReadings`
freshness machinery. Bounded at 16 entries in `cloud.PublishStatus`. Cloud half
+ portal rendering: root AGENTS.md "Multi-source Anlage" → Increment 2.
Proof: `agent/sources_summary_test.go`.

## Deye control WRITE: bidirectional single-socket lock + First-Light evidence gate

The Solarman/LSW3 logger accepts only ONE TCP client, so the Deye READ poll and the
control WRITE executor MUST coordinate or the frequent short read displaces the long
write (5×FC6+5×FC3) mid-sequence and it never lands ("wartet · Noch keine Rückmeldung"
on the `:8484` card; the certified optimizer path fails identically). Non-negotiable
facts (branch `fm/vp-deye-write-fix-x2`, PR fixing the reproduced blocker):

- **The one-socket lock is BIDIRECTIONAL on the shared `tab-auto` flow context.** BOTH
  the read poll (`auto-solarman` in `flows.json`, a preserved-verbatim node) AND the
  write executor (`controlExecSolarmanFunc` in `build-flows.js`) set/clear
  `sv5_busy:<host:port>` and honor `sv5_write_want:<host:port>`. A real write ANNOUNCES
  intent (`sv5_write_want`, 15 s window) so the read yields it a clean window; both
  DEFER to an in-flight op (skip-if-busy, 30 s stale-expiry). Do NOT remove either side
  — the write-only lock (pre-fix) only serialized write-vs-write and left read-vs-write
  colliding. `auto-solarman` is edited directly in `flows.json` (its socket wrapper is
  flow-specific, not the `deye/solarman-v5.js` codec copy) then carried through by
  `build-flows.js`; re-run `node build-flows.js` after any change (idempotent).
- **Swallowed write errors are surfaced** via rate-limited `node.warn` (30 s/class) on
  the socket-error + busy-skip paths — a real hardware issue shows in
  `docker compose logs nodered`, not just node status.
- **Regression coverage** = a `maxConnections=1`/single-client in-process logger driven
  by the read poll AND write executor concurrently on a shared flow context
  (`deye-control.e2e.test.js`). The old stub used unlimited `net.createServer` + no
  concurrent poll, so it could never reproduce the contention.
- **First-Light certify is EVIDENCE-gated (report §7 Gap B), not a manual tick.** A TRUE
  `ConfirmSign`/`ConfirmScale` needs the current test's write→readback MATCH
  (`NoteWriteReadback` from `agent.onControlReadback` when `source=="calibration"` &&
  `mode!="release"`) AND the measured `Verdict.SignOK`/`MagnitudeOK`; `CanCertify()` =
  `Passed() && writeReadbackOK`. Snapshot carries `can_confirm_sign/_scale`/`can_certify`
  for the card. Evidence resets on StartTest/Abort/Correction.
- **`calibration-certified.json` is versioned (`calibrationCertVersion`).** A file below
  the current version (a pre-evidence-gate cert) is INVALIDATED once on load →
  read-only until a real First-Light re-certifies. CRITICAL: the live Pilsting Deye was
  certified via the old manual path, so on deploy it goes read-only until re-proven.
- **Gap A**: `POST /api/calibration/decertify` + "Freigabe zurücknehmen" button revoke
  the per-device grant (mirrors certify's persist rollback).
- **§6**: the Deye ToU plan writes `progTimeBase` (0x0094 hybrid_3p / 0x00fa hybrid_1p)
  = Program 1 start 00:00, so the commanded slot is the day's BASE window; without it a
  stale program time can leave Program 1 inactive at "now" and the inverter ignores the
  setpoint even though registers echo. Still `bench_pending` (Deye uncertified).
- **READ-side battery sign is `invert_batt_sign`, plumbed via `BusPayload` (fm/vp-deye-sign-fix-v6, 2026-07-25).** The raw Deye battery register (`0x024E` hybrid_3p) sign is FIRMWARE-DEPENDENT (DEYE.md §5; the live Pilsting SUN-30K-SG01HP3-EU HV reports CHARGE as NEGATIVE), so a self-wired Deye published a `battery_power_kw` inverted vs the documented `+ charge / − discharge` - which the balance-derived house AND the First-Light verdict both assume. FOOTGUN: `deye/deye-decode.js` + `inverter-routing.js` + `build-flows.js` + `flows.json` ALL already forwarded `conn.invert_batt_sign`, but the Go `inverter.Connection`/`BusPayload` never published it, so the whole self-wiring path (the manual "Deye (Vorlage)" tab is retired) silently used the raw sign. Fix = `Connection.InvertBattSign` published on `edge/inverter/config` (solarman_v5 only; cleared elsewhere) - the READ-side twin of `InvertControlSign`. It is an operator setup field + a "Mess-Vorzeichen der Batterie umkehren" toggle on the `:8484` calibration card (resets the proof + decertifies like a control-sign correction). If you add a hybrid READ transport, publish `invert_batt_sign` in `BusPayload` or its measured battery reads backwards on inverted firmwares.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
