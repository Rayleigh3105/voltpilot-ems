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
  overlay pins `pull_policy: never`. Since Verbrauchssteuerung Inkrement 3 it
  ALSO requires `go` on the host (it builds `cmd/vp-consumer-sim` and runs
  three instances against the host-mapped local bus) and appends the consumer
  scenarios C1-C4 (must-run executes+confirms+ends, power_ranges gap snap,
  cycle-guard hold, staleness failsafe).

## Verbrauchssteuerung Inkrement 3 (edge half): cycle guard + consumers heartbeat + simulator

Full picture in the root AGENTS.md "Steuerbare Verbraucher - Inkrement 3".
What must hold HERE:

- **`guards.CycleGuard`** (`internal/guards/cycleguard.go`) enforces min-on /
  min-off / max-starts-per-local-day / ramp as TEMPORAL invariants; the
  ARBITER owns one per consumer entState (`desired.entState.cycle`, synced in
  `SetEntities` from `entities.Entity.CycleLimits()` - a registry re-push
  updates limits WITHOUT resetting timing state) and applies it in
  `applyDecision` after the value clamps AND on the failsafe path
  (Geräteschutz > Failsafe: an 'off' failsafe during min-on HOLDS the
  previously granted state; a release failsafe calls `NoteUncommanded` - no
  command left to hold onto). Restrict-only in the temporal sense: it delays
  and holds, never raises beyond a previously granted level. A hold is part
  of the decision FINGERPRINT (`cycleFingerprint`) so its onset emits one
  arbitration event with the `guard:cycle_*` stage; steady state stays
  silent. Unknown limits = axis inactive, and a reboot deliberately forgets
  state (a pause the guard cannot know is not owed - no invented protection).
- **The heartbeat `consumers` block** (`cloud.ConsumersSummary`, built by
  `agent.consumersSummary()` in `internal/agent/consumers.go`): per
  CONTROLLABLE consumer entity (category consumer AND non-empty actuate - so
  the composed house-load never appears) `{state, reason_code, actual_kw,
  confirmed, requirement_progress}`. The edge claims only what it can know;
  `confirmed` is tri-state from `entReadback`, `actual_kw` only from FRESH own
  telemetry, the day counters come from `Arbiter.CycleStateFor`. A device
  without consumer entities sends NO block (heartbeat byte-identical) -
  pinned by `agent/consumers_summary_test.go`.
- **`internal/consumersim` + `cmd/vp-consumer-sim`** is the §23 generic
  consumer simulator (wallbox/heating-rod/pump/stepped-rod as CONFIGURATIONS
  of one model): consumes the retained entity command, snaps a wish onto the
  achievable set RESTRICT-ONLY (a `power_ranges_kw` gap wish snaps DOWN,
  never a value between ranges; an unavailable "vehicle" consumes nothing and
  reports the mismatch honestly), publishes the v1 all_match readback shape +
  per-entity telemetry. Rig/dev tool only - never part of a customer image;
  no vendor driver was prioritized (the go-e executor is untouched).

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

## Topology-Quellen-Fill über den Registry-Pin (D-17, vp-vier-erzeuger-p9 PR 4a)

Der Registry-Push-Descriptor trägt seit D-17 optional **`edge_source_id`** (den
Cloud-Adoptions-Pin). `Agent.Topology()` füllt damit Entitäten OHNE eigenes
Reading DISPLAY-ONLY aus den EIGENEN Quellen-Readings (`SourceLastReadings`,
Frische über `SourceStatuses`): Producer `pv_power_kw` ← Quelle-pv, `power_kw`
← signed grid bzw. Verbraucher-load (`sourceChannelValue`). Sobald mindestens
ein Producer so gefüllt wurde, zeigt der Hybrid sein **PRE-FOLD-Primär-pv**
(`Snapshot.LastReading`) statt des gefalteten Komposits — die PV-Rollen-Summe
bleibt exakt das Komposit, nie doppelt gezählt. Grenze wie `ComposeLocal`:
Topology speist NUR `:8484`/`/api/state` — nie Buffer, v2-Uplink oder das
Heartbeat-observed-Ist. Ohne Pins ist alles byte-for-byte wie vorher (alter
Cloud-Stand lässt das Feld weg, alte Edges ignorieren es). Beweise:
`agent/entities_sourcefill_test.go`, `entities_test.go` (Fixture-Pin),
api `ProvisioningClaimTest` (Re-Push trägt den Pin retained).

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

## The `:8484` web app: TWO pages + Technikmodus (concept `data/vp-edge-ux-concept/concept.html`)

The device page is **`Betrieb`** (start page, customer-grade - for a plant with
no cloud link this IS the plant view) and **`Einrichten`** (everything you set
up, one job on one page). There is no third page: `inverter.html` and
`einstellungen.html` survive ONLY as redirects into an area anchor of
`einrichten.html`, so bookmarks and printed install sheets never 404.

- **Technikmodus** (`static/technik.js`, `#techToggle` in the header of BOTH
  pages, persisted in `localStorage["vp.edge.technik"]`, default OFF) REVEALS,
  it does not AUTHORIZE. Nothing is gated by it: calibration mutations keep
  their own admin token (`calGuard` in `web.go`) and the data purge stays
  red-bordered + type-to-confirm in both modes. Technical blocks are `.tech-only`
  and sit AT THE PLACE THEY BELONG (registers under the control state, raw
  source values under the flow), never in a separate dump.
  Visibility rule: `html:not(.tech-on) .tech-only { display:none !important }` -
  a plain `.tech-only{display:none}` LOSES the cascade to any later
  single-class rule that sets a display (`.area-title{display:flex}` leaked a
  technical heading in normal mode exactly that way).
- **THE load-bearing rule: hidden content must never hide a CAUSE.** Two pure
  functions own every plain-German verdict, and each returns a `cause` string
  that is rendered in NORMAL mode - Technikmodus only ever adds detail beneath
  it: `static/status.js` `VPStatus.derive(state, nowMs)` (the Betrieb status
  hero) and `static/control.js` `VPControl.deriveState(state)` (the control
  sentence; its branch order - no inverter → uncertified → kill-switch off →
  `blocked`+`reason` → waiting → readback - is the pre-rebuild logic verbatim).
  `static/commissioning.js` `VPCommissioning.derive(state, sourceCount, nowMs)`
  applies the same rule to the four guided steps. Adding a new verdict means
  adding its cause.
- **Einrichten is FOUR accordion groups** (rework `data/vp-einrichten-rework/
  concept.html`, 2026-07-28): ① Anlage ② Steuerung ③ Datenfreigabe ④ Erweitert,
  each ONE `<button class="acc-head">` row (dot + title + summary,
  aria-expanded/-controls). THE rule: big what needs an action, one line for
  what is finished, folded away what is rare. NO accordion memory - healthy =
  all closed every visit; a group with a NEW non-OK state opens itself and
  nothing auto-closes (pure layer `static/groups.js` `VPGroups`: the four
  summaries + `shouldAutoOpen(prevKey, key)` + `groupForAnchor` - the legacy
  anchors `#wechselrichter`/`#quellen`/`#messwerte`/`#datenfreigabe`/… open
  their group via `revealHash` in einrichten.js, so the retired-page redirects
  keep landing). The register evidence table lives ONLY on Betrieb under
  Technikmodus (the calibration card links to `index.html#controlCard` via
  `#calRegisterLink` while armed/running); empty source categories are
  per-category "+ hinzufügen" rows (`erzAdd`/`netzAdd`/`verbAdd`, role
  preselected in the drawer - the global add CTA is gone); the Netzmessung
  expert exception lives in ④ Erweitert. Page-wide warning rule: ONE message,
  once, in its owning group, with the stable "seit HH:MM" stamp
  (control.js `trackStateSince`); the group row carries only the dot.
- **The guided commissioning flow** (Einrichten, four steps ending at "Daten
  kommen an"; releasing CONTROL is deliberately its OWN block below it) is
  DERIVED from the existing APIs - no new endpoint, no persisted wizard
  progress. Once all four are done it DISAPPEARS entirely (no green banner -
  Betrieb's status hero is the single health voice) and returns only when a
  step regresses. The Portal-Kopplung card follows the pairing itself: visible
  while unpaired, `.tech-only` once paired (the reference then lives in the
  Technikmodus identity block, next to the version).
- **Design tokens are a COPY.** `static/tokens.css` duplicates
  `frontend/portal/designsystem/tokens/*` + the portal's `--vp-flow-*` hues
  because the edge has no build step and cannot import from the portal bundle -
  keep them in sync. `dashboard.css` derives its own aliases from them;
  `shell.css` owns the shell (top bar, page nav, Technikmodus, status hero,
  guided steps, `.pill`). NO webfont import: the device may have no internet.
- **Tests:** `internal/web/jstest/ui.test.js` (`node --test`, vm-realm loading
  like `nodered/flows-sync.test.js`) unit-tests the three pure derivations +
  the Technikmodus store; `jsunit_test.go` runs it inside `go test ./...`.
  Go page-structure tests pin the //go:embed contract, the retired-URL
  redirects, and that a `reason`-carrying refusal renders outside any
  `.tech-only` block.
- `static/*` is `//go:embed`-ed — **rebuild the core binary after any edit**.

## AE6 :8484 adaptive energy picture (edge half of AE2/AE3)

`static/dashboard.js` renders the topology block: `createFlow($("flowWrap"))`
routes the energy diagram between the ADAPTIVE topology diagram (v2 entities
present) and the fixed 4-node `buildV1Flow` (v1 fallback), and `renderKpis`
swaps the fixed `#kpis` cards for entity/role-driven `#kpisAdaptive` tiles
(`renderAdaptiveTiles`/`deriveTiles`). Both are read-only ports of the portal's
pure derivations, so the :8484 view matches the portal AE2/AE3 (same
lightning-hub / soft-circle-node / animated-dashed-spoke look,
`--pv/--load/--grid-c/--batt` role hues). **Since PR 4b (vp-vier-erzeuger-p9)
the adaptive diagram is the portal A1 picture: ONE circle per ROLE**
(`ROLE_NODE_LABEL` pv/storage/consumer/grid, `subLabelFor` verbatim from
`adaptiveFlow.ts` — „N Geräte" on a multi-device PV = the click affordance,
else the state in words), CONSTANT viewBox (1 or 6 inverters draw the same
picture), and the per-device breakdown behind a click on the PV circle
(`.flow-comp`, a SIBLING of the flow wrap after the legend — inside the wrap it
overlaps the legend because the SVG keeps 100 % height; a device without an own
value is NAMED with its reason, never a bare „–" ring). Keep `ROLE_NODE_LABEL`/
`subLabelFor` in lockstep with the portal. A device with NO topology stays
byte-identical v1 (`hasTopology` gates it). `static/*` is `//go:embed`-ed —
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
  (`static/sources.js` + `einrichten.html`) offers a **Verbraucher** role card
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
- **A proven result stays confirmable for a grace window; the test ladder scales to the inverter; the mutations can be admin-gated (fm/vp-calib-ux-t6, 2026-07-27).** Live-pilot UX fixes on the working remote-mode path. (1) **Grace window (Defect 1):** the evidence gate is unchanged (a confirmation still needs a readback-matched test with an OBSERVED same-direction movement), but the movement is a fact about the DEVICE, not about whether the bounded command is still active. `calibration.Session` now LATCHES the best attributable movement while active (`ObserveReading`, also called from `Snapshot`) and keeps it confirmable for `ConfirmGrace` (3 min) after the test auto-reverts - before this the ~2 s revert locked the boxes instantly. `ConfirmSign/ConfirmScale` take `now` (not the live `after`) and confirm against the captured evidence; it invalidates on a new test, abort, disarm, correction (`ResetConfirmations` clears it) or expiry (`ErrEvidenceExpired`). Snapshot carries `evidence_valid`/`evidence_age_seconds`; the card shows "Ergebnis des letzten Tests (vor N s)". `StartTest` now also resets prior confirmations (a new test = fresh proof). (2) **Rated-relative ladder (Defect 2):** `TestStepsForRated(ratedKw, maxKw)` offers ~1/3/5 % of nameplate (rounded 0,1 kW, capped by the authoritative `VP_CALIBRATION_MAX_KW`); on a 30 kW unit 0,3 kW (~1 %) moved nothing. Rated comes from `inverter.Selection.RatedKw` (already published). `NextStepAbove` names the next larger rung in the not-moving hint; unknown rated -> fixed fallback + a card note. (3) **Admin gate (owner scope-change):** `VP_CALIBRATION_ADMIN_SECRET` (`config.CalibrationAdminSecret`) - when set, ONLY the calibration mutation endpoints require the `X-VP-Calibration-Token` header (constant-time compared in the `calGuard` wrapper in `web.go`, 401 before the handler); GET + every other surface stay open; empty = open (non-bricking default). The card prompts for it (sessionStorage, tab-scoped). The TTL/watchdog/magnitude-cap/kill-switch safety net is independent of the token. Proofs: `calibration_test.go` (grace confirm/expiry/invalidation, ladder, next-step), `web_test.go TestCalibrationAdminGate`.

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

## Quellen-Identität ist DETERMINISTISCH; Umbenennen ist label-only (vp-vier-erzeuger-p9)

`sources.DeterministicID` leitet die Quellen-ID aus der TRANSPORT-IDENTITÄT ab
(role + communication + ip/port + unit_id bzw. serial+mb_slave_id), sodass
Löschen + Neu-Anlegen desselben physischen Geräts auf DIESELBE `src-`ID
konvergiert — tragend für die Cloud: das Portal pinnt eine übernommene Entität
an die Quellen-ID (`measurement_point.edge_source_id`); mit Zufalls-IDs machte
jede Neuanlage dasselbe Gerät zum „Neuen Gerät" und die Re-Adoption erzeugte
eine ZWEITE Entität (der Pilsting-Geister-Erzeuger). Regeln, die halten müssen:

- Label/Intervall/kWp sind NIE Teil der Identität (Umbenennen darf die ID nicht
  ändern); die Rolle IST Teil der Identität (ein als Netz re-addiertes Gerät
  darf keinen Erzeuger-Pin wiederbeleben — das wird ehrlich als verwaister Pin
  sichtbar). Kollision mit einer EXISTIERENDEN Quelle (identische Identität
  doppelt angelegt) → Fallback `NewID()` + lauter Warn, nie ein Crash.
- **Umbenennen läuft über `PUT /api/sources/{id}`** (`Agent.RenameSource`,
  label-only, 1–64 Zeichen; Inline-Edit-Stift in `static/sources.js` — Enter
  speichert, Esc/Blur bricht ab). Niemals wieder eine Lösch+Neuanlege-UI als
  Umbenennen-Ersatz anbieten.
- Bestehende Zufalls-IDs bleiben unangetastet (die ID wird nur bei POST
  vergeben); erst ein Löschen+Neuanlegen wandert auf die deterministische ID.

Beweise: `sources_test.go TestDeterministicID…`, `agent/sources_id_test.go`
(Konvergenz nach delete+re-add, Kollisions-Fallback, Rename hält die ID),
`web_test.go TestSourcesRenameIsLabelOnly`.

## Der Build-Stempel reist IMMER mit (OTA Stufe 0 „Sehen")

Bis dahin ritt `core_version` NUR im `flows`-Ack-Block — und den baut der Deployer
erst, nachdem er je einen Deployment-Satz gesehen hat (`Deployer.Summary()`
liefert vorher nil). Eine Box, auf der nie eine Automation ausgerollt wurde,
meldete der Cloud also GAR KEINE Version. Zwei additive Dinge beheben das; es
gibt in dieser Stufe KEINEN Apply-Pfad und keinen Downlink.

- **`version` ist ein LINK-Feld, kein Aufruf-Argument** (`cloud.Options.Version`
  → `Link.version`, gesetzt aus `agent.Version` beim Bau des Links). Es steht
  damit in JEDEM `PublishStatus` — strukturell unvergesslich und an nichts
  gekoppelt. Eine leere Version wird WEGGELASSEN, nie als `""` gesendet (die
  Cloud muss „unbekannt" von „eine Version namens ''" unterscheiden können).
  `/health` trägt sie ebenfalls (aus `Snapshot.Version`) — das ist der
  maschinenlesbare Endpunkt, den `install.sh`/`update.sh` ohnehin abfragen.
- **`agent/ota.go updateSummary()`** baut den additiven `update`-Block:
  `backend: "compose"`, `current` = der Stempel VERBATIM (ein Bestands-Build
  trägt eine nackte 12-stellige SHA — sie umzuformatieren erfände ein
  Release-Tag), `state: "idle"`. **Alles, was die Box nicht ehrlich wissen kann,
  BLEIBT WEG:** `current_seq`/`target*`/`channel` gibt es erst mit dem
  Cloud-Register bzw. einer Soll-Zuweisung (Stufe 2), und ein
  `last_known_good` hat nur, wer je ein Update angewandt hat — die aktuelle
  Version als solches auszugeben, erfände ein Rollback-Ziel. Eine erfundene
  Sequenznummer wäre besonders teuer: die Cloud ordnet Releases genau danach.
- **`Link.PublishUpdateState` ist VORARBEIT und wird in Stufe 0 von nichts
  aufgerufen.** Sie meldet EINE Zustandsänderung durabel (QoS1, wartet auf den
  Ack) und existiert jetzt, weil der Zweck sich nicht nachrüsten lässt: ein
  Updater muss `applying` als LETZTE Handlung melden, BEVOR er den Stack
  stoppt — nur dann ist „im Update verstummt" ein eigener Zustand statt
  ununterscheidbar von „die Box ist einfach weg". Der 15-s-Herzschlag kann das
  nicht tragen (der Prozess verschwindet gerade).
- Beweise: `internal/cloud/status_test.go` (echter In-Process-Broker: `version`
  MIT und OHNE `flows`-Block, die weggelassenen Felder, der durable Bericht),
  `agent/ota_test.go`, `web` `TestHealthCarriesBuildVersion`. Cloud-Seite +
  Release-Register: root `AGENTS.md` „OTA Stufe 0".

## OTA Stufe 1: das Geraet PRUEFT ein Release - und wendet weiterhin nichts an

`internal/otaverify` (rein, nur Standardbibliothek - der Core bekommt dafuer
KEINE neue Abhaengigkeit) + `agent/ota.go`. Vollstaendiges Bild inkl. Zeremonie:
root `AGENTS.md` „OTA Stufe 1" und [`docs/ota-signing.md`](../docs/ota-signing.md).
Was hier gelten muss:

- **Die Reihenfolge in `Verify` ist bindend:** gebackene Wurzel -> Trust-Set
  gegen die Wurzel -> Manifest gegen den Release-Schluessel -> ERST DANN parsen
  -> ERST DANN Politik. Die zu pruefenden Bytes gehen NIE durch einen Parser,
  bevor die Signatur stimmt, und ein `rejected` reicht das Manifest nicht weiter.
- **`otaverify.SigningInput` ist die EINZIGE Stelle**, an der die zu
  signierenden Bytes entstehen (`kontext || dateibytes`). Signierwerkzeug
  (`cmd/vp-ota`) und Geraet rufen dieselbe Funktion - wer hier etwas
  normalisiert, bricht beide Seiten gleichzeitig und lautlos.
- **`rootkeys.json` wird per `go:embed` eingebacken** und ist bis zur Zeremonie
  LEER = fail-closed. Kein env-Schalter, kein Pfad, keine Laufzeit-Injektion im
  Produktionspfad: der Agent hat NUR `a.otaRoots` als TEST-Naht (nil = die
  gebackene Wurzel). Ein env-gesetzter Vertrauensanker waere genau die
  Vertrauensuebernahme, gegen die die kalt/heiss-Trennung gebaut ist.
- **`agent/ota.go` liest Dateien und bildet eine Meinung - mehr nicht.**
  `<data_dir>/ota/{release,trust-set}.json(.sig)`, 30-s-Takt, mtime+Groesse als
  Stempel (eine unveraenderte Datei wird nicht neu geprueft). Ergebnis: der
  bestehende `update`-Block (`state` zurueck auf `idle` + deutscher `reason`)
  plus `ota_state`/`ota_reason` in `/health` - der Endpunkt, den ein
  beaufsichtigter Test OHNE Cloud-Verbindung abfragt.
- **`current.json` wird nur GELESEN.** Nichts auf dem Geraet schreibt den
  eigenen Release-Stand, bevor ein Update wirklich angewandt und bestaetigt
  wurde (Stufe 3) - fehlt er, meldet der Verifizierer ehrlich „Boden nicht
  bewertbar" statt eine Sequenznummer zu erfinden. Stufe 3 darf ihn nur je
  ERHOEHEN.
- **`updateSummary()` erfindet weiterhin nichts**: kein `current_seq` (auch
  nicht aus `current.json` - das ist ein lokaler Boden-Eingang, nicht die
  Ordnung des Cloud-Registers), kein Ziel, kein `last_known_good`. Und der
  Zustand bleibt nach der Pruefung `idle`: `verifying` ist TRANSIENT, ihn
  danach zu melden behauptete eine laufende Taetigkeit.
- Beweise: `internal/otaverify/verify_test.go`, `cmd/vp-ota/main_test.go`,
  `internal/agent/ota_verify_test.go`.


## OTA Stufe 2: das Geraet EMPFAENGT sein Ziel - und wendet es weiterhin nicht selbst an

`internal/otatarget` (rein: Umschlag parsen + ablegen) + `agent/ota_target.go`.
Cloud-Seite, Tabellen und Rollout-Logik: root `AGENTS.md` „OTA Stufe 2";
Betreiber-Ablauf: `docs/ota-signing.md` §6b. Was hier gelten muss:

- **Der Downlink ist ein TRANSPORTWEG, keine Autoritaet.** Die
  Vertrauensentscheidung faellt unveraendert auf dem Geraet gegen die
  EINGEBACKENE Wurzel (`internal/otaverify`, Stufe 1); die Cloud prueft die
  Signatur bewusst nicht. Der Umschlag ist UNSIGNIERT - `release`/`release_seq`/
  `channel` sind Routing und Diagnose, und sobald ein Manifest geprueft ist,
  gewinnt AUSSCHLIESSLICH dieses.
- **Abgelegt werden die ROHEN Umschlag-Bytes in EINER Datei**
  (`<data_dir>/ota/target.json`, atomar tmp+rename). Ein Umschlag, den wir
  zerlegen und neu zusammensetzen, koennte die Manifest-Bytes veraendern - und
  die Signatur geht ueber genau sie. Eine LEERE retained Nachricht nimmt die
  Zuweisung zurueck (Unclaim), dann verschwindet auch die Datei.
- **PRAEZEDENZ:** eine Cloud-Zuweisung gewinnt vor dem beaufsichtigten
  Dateipfad der Stufe 1 (`<data_dir>/ota/release.json`), der als Weg fuer den
  TOFU-Test und fuer eine Box ohne Cloud-Link bleibt. Es darf nur EIN Urteil im
  Herzschlag stehen.
- **Das Trust-Set kommt NICHT ueber den Downlink** (Widerrufs-Anker - derselbe
  Kanal waere eine Kreisabhaengigkeit); ohne abgelegtes Trust-Set lehnt der
  Verifizierer fail-closed ab und nennt das als Grund.
- **Die Zustaende, die diese Stufe meldet:** `deferred` + `target_verdict:"ok"`
  = geprueft, wartet auf den Menschen (der NORMALFALL, kein Fehler);
  `deferred` + `"deferred"` = Politik (Boden, Backend); `failed` +
  `"rejected"` = gebrochene Kette, also ein SICHERHEITS-Ereignis - und genau
  das Signal, auf das der Rollout im Portal automatisch anhaelt; `succeeded` =
  Ist == Soll, BELEGT aus dem laufenden Build-Stempel statt aus einer
  Buchfuehrung geglaubt.
- **`current_seq` wird nur gemeldet, wenn der aufgezeichnete Stand WIRKLICH
  laeuft** (`otaverify.ReleaseIsRunning` gegen `Version`) - eine von Hand
  hingelegte `current.json` eines fremden Standes faerbt die Flottensicht
  nicht ein. `last_known_good` bleibt weiterhin LEER: es gibt keinen
  Rollback-Mechanismus, und die laufende Version als solches auszugeben
  erfaende ein Rueckfallziel.
- **Der beaufsichtigte Anwendungspfad** ist `update.sh --from-target`: er liest
  ueber `GET /api/ota/target` genau die Artefakt-Digests, die DIESES Geraet
  verifiziert hat - bei `verdict != ok` gibt der Core sie GAR NICHT heraus, ein
  Lauf kann also nie etwas Ungeprueftes anwenden. Danach meldet er ueber
  `POST /api/ota/applied` zurueck; dieser Aufruf kann ausschliesslich
  BESTAETIGEN, was nachweislich laeuft (Release muss zur Build-Stempelung
  passen), und hebt den Anti-Rollback-Boden nur je AN - deshalb braucht er
  keine eigene Berechtigung. **Es gibt weiterhin keinen `:8484`-Knopf und
  keinen autonomen Apply** (Stufe 3).
- Beweise: `internal/otatarget/otatarget_test.go`,
  `internal/agent/ota_target_test.go` (u. a. bytegleiches Durchreichen,
  Idempotenz bei retained Wiederzustellung, gebrochene Kette = `failed` OHNE
  Digests, Boden = `deferred`, fremde Identitaet verworfen, Ruecknahme,
  Aufzeichnen nur des nachweislich Laufenden), Kontrakt-Beispiele PER PFAD.

## OTA Stufe 3: das Geraet wendet SELBST an - gebaut, nirgends eingeschaltet

`internal/otaapply` (rein) + `internal/otaupdater` (Docker) + `cmd/vp-edge-updater`
(der Sidecar) + `agent/ota_autonomy.go` (die Kern-Haelfte). Vollstaendiges Bild
inkl. Betreiber-Ablauf: root `AGENTS.md` „OTA Stufe 3" und
[`docs/ota-autonomie.md`](../docs/ota-autonomie.md). Was HIER gelten muss:

- **ZWEI unabhaengige Tore, beide zu.** Das Compose-Profil `ota` (ohne
  `--profile ota` laeuft der Container gar nicht) UND der Schalter je Geraet
  (`<data>/ota/autonomy.json`, Vorgabe AUS; `VP_OTA_AUTONOMOUS` ist der Not-Ein
  fuer den Laborstand). Ohne beides ist die Box zeichengleich wie vorher -
  `TestWithAutonomyOffNotASingleDockerCommandRuns` und der Matrix-Fall
  `autonomy_off` nageln das fest.
- **Der Sidecar glaubt dem Kern NICHTS.** Er liest die Manifest-Bytes selbst
  und verifiziert gegen SEINE eingebackene Wurzel und SEINEN Boden. Die EINE
  Stelle, die beide aufrufen, ist `otaapply.VerifyManifest` - „unabhaengig
  verifizieren" heisst zwei PROZESSE, nicht zwei Implementierungen derselben
  Regel. **Es gibt keinen env-/Pfad-Schalter fuer die Wurzel** (genau die
  Uebernahme, gegen die die kalt/heiss-Trennung gebaut ist); `Options.Roots` ist
  ausschliesslich die Test-Naht, nil laedt die eingebackene.
- **Nur der KERN darf bezeugen, was laeuft** - deshalb schreibt nur er
  `current.json`, und zwar nur gegen seine eigene Build-Stempelung. Der Sidecar
  hat Container getauscht; ob danach der richtige Stand LAEUFT, kann er nicht
  wissen.
- **Das Protokoll ist ein DATEI-Kanal in `/data/ota`, jede Datei mit GENAU EINEM
  Schreiber** (Kern: `target.json`/`current.json`/`self-test.json`/`core-signal.json`;
  Sidecar: `updater-state.json`/`pending-confirm.json`/`lkg.json`/`failed.json`;
  Betreiber: `autonomy.json`). Alles tmp+rename. Der Sidecar hat kein Netz und
  keinen Port - er KANN den Kern nicht anrufen.
- **Sequenziert, nie beide Failsafe-Kopien zugleich weg:** getauscht wird nur,
  was sich UNTERSCHEIDET, und immer nur EINE Komponente je Durchlauf (`core`,
  dann `nodered`). Gepinnt wird ueber denselben `.env`-Hebel wie
  `update.sh apply_image_pin`, gestartet mit `--pull never` (die Images sind
  vorher geholt UND gegen ihren Digest geprueft; beim ZURUECKNEHMEN waere ein
  Pull sogar ein Fehler - ein Rueckfall muss ohne Registry gehen).
- **Das Rueckfallziel ist DREIFACH gesichert:** `:lkg`-Tag, ein GESTOPPTER
  Halter-Container (`docker create`, nie gestartet - genau das verschont ein
  `docker system prune -a`, ein blosser Tag NICHT; die Matrix belegt die Regel
  mit einem label-gefilterten echten `prune -a`) und ein `docker save`-Archiv.
  **⚠ Ein Archiv kann keinen Registry-Digest zurueckbringen** (live
  nachgemessen: `docker load` legt das Image ohne RepoDigest ab) - nach einem
  echten Aufraeumen wird deshalb auf den lokalen `:lkg`-TAG gepinnt, und der
  Grund sagt das.
- **⚠ Der Plattenwaechter rechnet mit `f_frsize`, nicht mit `f_bsize`**
  (`otaupdater/disk_linux.go`): `f_bavail` zaehlt in `f_frsize`-Einheiten. Auf
  ext4 sind beide 4096, auf einem virtiofs-Mount meldet `f_bsize` 256 KiB - der
  Waechter sah dort 9,5 TiB statt 38 GiB freien Platz.
- **Der Selbsttest ist nie vakuum:** `agent.otaSyntheticControlDryRun` faehrt
  die ECHTE `guards.Clamp`-Kette dieses NEUEN Binaers gegen ihre tragenden
  Zusagen (Nennband, SoC-Decke/-Boden, EEG-Solar-Klemme, §14a-Huelle) - immer,
  auch nachts und im Leerlauf. **⚠ `guards.Reading`s Nullwert
  `GridLimitKw: 0` heisst „§14a-Grenze 0 kW", nicht „unbekannt"** (unbekannt ist
  `guards.Unknown()`); eine mit `{}` gebaute Messung laesst den Envelope-Guard
  gegen eine Null-Grenze rechnen - im Trockenlauf genau so aufgefallen.
- **Der Interlock + `state.ModeOtaNeutral`:** solange ein von neutral
  abweichender Sollwert laeuft, wird verschoben; ein EILIGES Release
  (`urgent` im SIGNIERTEN Manifest) laesst den Kern die Anlage zuerst bewusst
  neutral stellen. `otaNeutralOverride` sitzt in `applySetpoint` NACH der
  Kalibrierung (ein First-Light-Test gewinnt) und hat einen harten Deckel von
  10 min plus eine 60-s-TTL auf die Bitte - ein verschwundener Sidecar parkt die
  Anlage nie.
- **Was einmal zurueckgerollt wurde, laeuft NIE wieder von selbst an**
  (`failed.json`). Ohne das begann der naechste Takt denselben Tausch von vorn -
  die Zuweisung liegt ja noch. In der Fehlerinjektions-Matrix aufgefallen.
- **⚠ Eine Sperre wird GENANNT - je AENDERUNG, nie je Takt** (Canary-Soak
  04.08.2026): jedes geschlossene Tor traegt seit dem einen maschinenlesbaren
  Namen (`Decision.Blocker` -> `UpdaterState.Blocker`, Vokabular
  `otaapply.Blocker*`), `Engine.report` protokolliert eine WARN-Zeile bei jeder
  Aenderung von Blocker ODER Grund (und eine INFO beim Aufheben), und
  `agent.otaUpdaterOverlay` laesst eine STEHENDE Sperre im `update`-Block VOR
  jeder anderen Ueberlagerung gewinnen - mit `otaapply.BlockedPrefix`
  („Autonomie blockiert: …"), damit „wartet" und „blockiert" nirgends gleich
  aussehen. Vorher schrieb der Sidecar den Grund brav in die Zustandsdatei,
  protokollierte aber NICHTS, und der Herzschlag trug weiter den freundlichen
  Satz des Verifizierers: der Betreiber sah „wartet" ohne jede Chance zu
  erfahren, worauf. Wer ein neues Tor einbaut, gibt ihm einen Blocker-Namen und
  einen Grund, der den HEBEL nennt (bei der Neutral-Zeit: Familie +
  `VP_OTA_NEUTRAL_VERIFIED`). Beweise: `otaupdater/blocker_test.go`,
  `otaapply/decide_test.go`, `agent/ota_autonomy_test.go`; Betreiber-Sicht:
  `docs/ota-autonomie.md` §3.
  - **Seit dem Admin-UX-Umbau (05.08.2026) reist der NAME zusaetzlich in die
    Cloud:** `cloud.UpdateSummary.Blocker` (`blocker`, `omitempty`) traegt ihn
    NEBEN dem deutschen `reason` - dieselbe Begruendung, aus der
    `target_verdict` neben `state` steht: die Cloud konnte „blockiert" sonst
    nicht von „unterwegs" trennen, ohne einen deutschen Satz nach Stichworten
    zu durchsuchen, und ein stehender Blocker landete portalseitig im
    Fortschritts-Ton. Er wird NUR gesetzt, solange der Sidecar wirklich
    blockiert (`up.Blocked()`), also bleibt der Herzschlag einer gesunden Box
    byte-gleich. Das frueher hier stehende „Cloud/Portal unveraendert" gilt
    damit nicht mehr - die Cloud-Seite steht in der Root-`AGENTS.md`
    („Admin-UX-Umbau P1"), inklusive des Uebergangs fuer Baende ohne das Feld
    (`RolloutStates.BLOCKED_PREFIX` ist der gepinnte Zwilling von
    `otaapply.BlockedPrefix` - **beide zusammen aendern**).
- **`update.sh` muss das `ota`-Profil kennen:** `up -d --remove-orphans` wuerde
  den Sidecar sonst als Waise ENTFERNEN und einer eingerichteten Box
  stillschweigend die Autonomie nehmen. `detect_ota_profile` erkennt ihn,
  `--ota` erzwingt es bei gestoppten Containern.
- **Der Sidecar tauscht sich NIE selbst** (`otaapply.TargetRefs` laesst
  `updater` aus, `ReleaseNamesUpdater` protokolliert es laut); seine eigenen
  Updates sind beaufsichtigt und out-of-band.
- **⚠ Er raeumt seine abgeloesten Abbilder NACH einem bestaetigten Tausch weg -
  und die Nie-entfernen-Menge ist der ganze Punkt** (Pilsting 09.08.2026:
  `docker system df` meldete 58 Abbilder, 3 in Benutzung, 5,8 GB
  rueckgewinnbar, und der Plattenwaechter verweigerte deshalb einen legitimen
  Rollout - die Verweigerung war richtig, der Grund war unser Muell). Regel
  rein in `otaapply.PlanPrune`, Wirkung in `otaupdater/prune.go`, aufgerufen
  ausschliesslich am ENDE von `Engine.commit` - nie vorher, nie mitten drin,
  nach einer Ruecknahme GAR NICHT (dort ist jedes Abbild potenziell das
  Rueckfallziel). Was die Sicherheit traegt:
  - **„auf das ein Container zeigt" ist die allgemeine Regel, nicht eine Liste
    von Ausnahmen** (`docker ps -aq` + `docker inspect --format {{.Image}}`):
    sie deckt core/nodered/updater UND die GESTOPPTEN `vp-edge-lkg-*`-Halter
    ab, also genau den Mechanismus, mit dem das Rueckfall-Image ein
    `prune -a` ueberlebt. Das `docker save`-Archiv ist eine DATEI und per
    Konstruktion ausser Reichweite. Dazu: der Rueckfall-Namensraum
    (`otaapply.LKGTagPrefix`, geteilt mit `lkgTag`/`lkgHolder`) ist auch ohne
    Halter tabu - **docker schuetzt hier NICHT**, einen Tag abzuhaengen gelingt
    trotz Container, solange ein anderer Name bleibt.
  - **Entfernt wird je NAME (`docker image rm <ref>`), nie mit `-f`, nie
    pauschal.** `-f` haebelte die dritte Sicherungsebene aus (docker verweigert
    die Loeschung, solange ein Container haelt), und `image prune -a` naehme
    ein vorab geholtes naechstes Ziel sowie jedes von aussen abgelegte Abbild
    mit. Ein Abbild mit Tag UND Digest braucht BEIDE Namen, sonst ueberlebt es
    unter der jeweils anderen Referenz.
  - **Die Kandidatenmenge sind nur die Repositories, die dieses Geraet selbst
    getauscht hat** (`prunableRepos`; `imageRepo` trennt Tag/Digest ab, aber nie
    den Port einer Registry). Der Sidecar steht nicht darin - seine alten
    Abbilder bleiben liegen, die vorsichtige Richtung.
  - **⚠ Nur was AELTER ist als der laufende Stand** (der ANKER je Repository =
    die juengste Bau-Zeit unter den gehaltenen Abbildern). Entfernt werden
    „Abbilder FRUEHERER Releases"; was juenger ist, ist etwas voraus
    Bereitgelegtes. **In der Fehlerinjektions-Matrix aufgefallen, nicht im
    Unit-Test:** ohne diese Regel sammelte ein frueherer Fall die Stellvertreter
    ein, die die Matrix fuer spaetere Faelle vorab angelegt hatte. Unbekannte
    Bau-Zeit = jung = bleibt; unbekannter ANKER = die Regel greift nicht (sonst
    schaltete ein unlesbares Zeitformat das Aufraeumen still ganz ab), dann
    traegt allein die Kulanz.
  - **Kulanz JE REPOSITORY** (`VP_OTA_PRUNE_KEEP`, Vorgabe 1): global gezaehlt
    behielte „eines aufheben" den Vorgaenger von core und entfernte den von
    nodered.
  - **Nicht-fatal, aber nie ratend:** jeder Fehlschlag wird nur protokolliert
    (die Reinigung ist die Kuer, der Tausch die Pflicht); eine unvollstaendige
    Sicht (`docker images`/`docker ps` antwortet nicht) bricht das Aufraeumen AB,
    statt auf einer Luecke zu entscheiden.
  - Schalter: `VP_OTA_PRUNE`/`VP_OTA_PRUNE_KEEP` (in BEIDEN Composes -
    Lockstep!) und `<data>/ota/prune.json` je Geraet. **Die Vorzeichen sind
    ANDERS als bei der Autonomie:** fehlende Datei = Vorgabe AN (das
    Nicht-Aufraeumen war der Defekt), UNLESBARE Datei = nichts entfernen.
  - **Bekannte Grenze:** eine Box, die der Plattenwaechter schon blockiert,
    kommt hierueber nicht frei (ohne Tausch kein Aufraeumen) - dort einmal von
    Hand `docker image prune -a`, was durch den Halter-Container nachweislich
    sicher ist. Betreiber-Handbuch: `docs/ota-autonomie.md` §5b.
- Beweise: `internal/otaapply` (die Tore + Wiederaufnahme + Sequenz + Snapshot +
  Schalter + `prune_test.go`: die Regel inkl. Halter, Namensraum, Kulanz je
  Repository, alle Namen einer Kennung, Schalter-Vorzeichen), `internal/otaupdater`
  (die Orchestrierung gegen eine geschriebene docker-Welt; `prune_test.go`:
  Rueckfallebene ueberlebt, Ruecknahme raeumt nicht, vorab geholtes Ziel bleibt,
  ein Reinigungs-Fehlschlag kippt keinen bestaetigten Tausch),
  `agent/ota_autonomy_test.go`, `internal/web/jstest/ui.test.js`
  (die Neutral-Aussage) und die Matrix `test/ota-soak/run.sh` (11 Faelle gegen
  echten Docker, echte Signaturkette, echte Registry - `image_cleanup` faehrt
  ZWEI bestaetigte Updates und prueft danach Stueck fuer Stueck, was weg ist
  und was steht).

## Das Trust-Set kommt beim EINRICHTEN mit - nie zur Laufzeit

Captain-Order 04.08.2026 (der erste Live-Rollout wurde mit „Das Vertrauens-Set
oder seine Signatur fehlt." abgelehnt). Cloud-Seite, Endpunkte und die volle
Begruendung: root `AGENTS.md` „Trust-Set-Bereitstellung beim Einrichten" +
[`docs/ota-signing.md`](../docs/ota-signing.md) §6.0. Was HIER gelten muss:

- **`install.sh` holt und legt ab, `update.sh` NENNT nur den Weg.** Die
  Installation ist ein sanktionierter TOFU-Moment (die Box hat sich ihre IMAGES
  ueber denselben Kanal geholt und prueft die Root-Signatur weiterhin SELBST);
  eine LAUFENDE Box holt sich nie ein Trust-Set ueber das Netz - das waere der
  Widerrufs-Anker ueber den Kanal, den er widerruft. Der CORE kennt die Route
  gar nicht, und `update-selfcheck.sh` nagelt fest, dass in `update.sh` weder
  ein Download noch die Route vorkommt.
- **⚠ Es werden DATEIEN kopiert, nie das VERZEICHNIS.** `docker cp` eines
  Verzeichnisses setzt den Besitzer des ZIELVERZEICHNISSES auf die uid des
  Hosts (nachgemessen `root:root` / `501:root`); `/data/ota` gehoerte danach
  nicht mehr dem unprivilegierten `voltpilot`-Benutzer des Images, und der
  koennte weder `target.json` noch `current.json` schreiben - OTA waere still
  tot. `place_trust_set()` kopiert deshalb je Datei in ein BESTEHENDES
  Verzeichnis, und `agent/ota.go otaCheckLoop` legt `<data>/ota` beim Start
  selbst an (damit es dem Core gehoert, auch ohne `exec`). Die Regel gilt fuer
  JEDE Datei, die kuenftig von aussen in ein Container-Volume wandert.
- **`--refresh-trust` ist der Bestandsbox-Pfad** (nur holen + ablegen, kein
  Login, kein Pull, kein `up -d`, keine `.env`-Aenderung) - eine ausdrueckliche
  Handlung des Betreibers an DIESER Box, der Ersatz fuer den scp-Zweizeiler,
  kein Flotten-Fan-out.
- **Ein fehlendes Set ist KEIN Installationsfehler:** laute Warnung + Handpfad,
  Installation gilt als erfolgreich. Eine Box ohne Trust-Set arbeitet
  vollstaendig, sie kann nur (noch) kein Release anwenden.
- Beweis (echter Docker, mutationsgetestet - die naive Verzeichnis-Kopie faellt
  durch): `test/install-selfcheck.sh` Abschnitte 2b/2c.

## OTA Stufe 4: das Vertrauen wird MELDBAR - und ein Knopf ersetzt SSH

Zwei additive Dinge, beide ohne jeden neuen Wirkpfad zum Wechselrichter. Cloud-
Seite + Portal: root `AGENTS.md` „OTA Stufe 4"; Rotations-Drill:
[`docs/ota-signing.md`](../docs/ota-signing.md) §7.1.

- **Der Herzschlag traegt die VERTRAUENS-IDENTITAET** (`cloud.TrustSummary` im
  `update`-Block, gebaut in `agent/ota.go otaRefreshTrust`, zwischengespeichert
  mit eigenem mtime-Stempel - die Ed25519-Pruefung laeuft nur bei geaendertem
  Trust-Set). Sie beantwortet „traegt diese Box ein schluesseltragendes Image?"
  (TOFU) und „hat sie das neue Trust-Set schon gesehen?" (Rotation), und sie
  gilt UNABHAENGIG von einem Release - genau die Box ohne Zuweisung ist die,
  deren Crossover-Stand der Betreiber wissen muss.
  - **`otaverify.InspectTrust` ist die EINE Quelle** und faehrt die ersten zwei
    Schritte von `Verify`: ein Trust-Set, das die eingebackene Wurzel NICHT
    unterschrieben hat, wird NICHT berichtet. Werkzeug (`vp-ota trust`) und
    Geraet rufen dieselbe Funktion - zwei Quellen fuer „welches Set faehrt
    diese Box" waeren zwei Wahrheiten.
  - **⚠ ABWESEND und LEER sind verschiedene Aussagen.** Ein aelterer Stand
    sendet den Block gar nicht („unbekannt"); ein Image OHNE Wurzel sendet ihn
    mit LEERER `root_key_ids` (`[]`, nie `null` - deshalb das explizite
    `append([]string{}, ...)`), und das heisst „Crossover offen" - der
    dokumentierte Vor-TOFU-Zustand, kein Fehler.
- **`:8484` „Jetzt anwenden"** (`agent/ota_apply.go`, `static/ota.js`, Karte in
  ④ Erweitert): der Kern legt hinter dem BESTEHENDEN Betreiber-Passwort
  (`calGuard`, `X-VP-Calibration-Token`) eine EINMALIGE Freigabe ab
  (`otaapply.ApplyRequest`); angewandt wird sie vom Stufe-3-Sidecar.
  - **Es ist KEINE Autonomie.** Sie oeffnet ausschliesslich das ERSTE Tor von
    `otaapply.Decide` - fuer GENAU EINEN Vorgang (Token, quittiert in
    `UpdaterState.AppliedRequestToken`, damit jede Datei GENAU EINEN Schreiber
    behaelt) und GENAU EIN Release (die Freigabe gilt dem Stand, den der Mensch
    SAH; eine inzwischen eingetroffene Zuweisung ist nicht mitfreigegeben) -
    und sie verfaellt nach `ApplyRequestWindow` (15 min). Jedes weitere Tor
    gilt unveraendert; `TestAnApprovalNeverSkipsAnyLaterGate` vergleicht dafuer
    freigegeben gegen autonom Fall fuer Fall. `autonomy.json` bleibt unberuehrt
    AUS.
  - **Ohne laufenden Sidecar rendert die Karte NICHT** und der Endpunkt lehnt
    mit dem ehrlichen Grund ab (dann bleibt `update.sh --from-target` der Weg) -
    eine Karte, die nur sagen kann „geht hier nicht", ist Laerm.
  - `static/*` ist `//go:embed`-ed - Kern nach jeder Aenderung neu bauen.

- **Dieselbe Freigabe kommt seit dem Admin-UX-Umbau P3 auch aus dem PORTAL**
  (`agent/ota_apply_downlink.go`, Kontrakt
  `docs/contracts/mqtt-ota-apply.schema.json`) - und das ist ausdruecklich
  KEIN zweiter Weg zum Anwenden:
  - **Beide muenden in `OtaRequestApplyWithToken`.** Die `:8484`-Taste erzeugt
    ihren Token selbst, das Portal bringt einen mit (damit es SEINEN Vorgang
    spaeter wiedererkennt); alles danach ist woertlich derselbe Code. Wer hier
    einen zweiten Pfad einzieht, muss jedes Tor ein zweites Mal absichern.
  - **⚠ NICHT-retained, und das ist die tragende Entscheidung.** Der Abonnent
    liegt auf `v2/apply`, ausdruecklich NICHT auf dem retained
    Zuweisungs-Slot `v2/update`: retained wird bei jedem Reconnect erneut
    zugestellt, eine Einmal-Freigabe waere damit keine. **Das allein genuegt
    aber nicht** - der Link haelt eine DAUERHAFTE Sitzung
    (`cleanSession=false`), der Broker darf eine QoS1-Nachricht also
    nachliefern. Die zweite Haelfte ist deshalb `requested_at`: der Stempel
    des UMSCHLAGS ist der Beginn des 15-Minuten-Fensters, nicht der
    Empfangs-Zeitpunkt, also ist eine nachgelieferte Freigabe bei ihrer
    Ankunft schon abgelaufen und wird abgelehnt statt abgelegt. Die Cloud
    zeigt dafuer „Freigabe nicht abgeholt".
  - **Verworfen wird STUMM zum Broker und LAUT im Protokoll:** falsche Form,
    fremde Identitaet (die Regel von Telemetrie/purge_data/Zuweisung), und -
    der eigene Fall dieses Pfades - eine Freigabe, die ein ANDERES als das
    zugewiesene Release nennt. Eine Zustimmung gilt fuer das, was der Mensch
    SAH.
  - **`update.can_apply` im Herzschlag** (`cloud.UpdateSummary.CanApply`) ist
    die FAEHIGKEIT, nie eine Erlaubnis: laeuft hier ein Sidecar, und ist die
    Zuweisung geprueft? Sie wird bewusst OHNE `omitempty` gesendet - ein
    Build, der die Frage kennt, beantwortet sie IMMER, damit „abwesend"
    cloud-seitig nur „aelterer Build" heissen kann.

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
- **The write WINS the socket by WAITING OUT an in-flight read, not by bouncing to the
  next ~10 s setpoint tick (`fm/vp-calib-evidence-u4`, Defect 2).** Announcing intent
  alone lost in practice: a 5 s read tick already in flight when the write arrived forced
  the write to `return null` and retry a full setpoint cycle later ("Schreiben auf den
  naechsten Takt verschoben", 3×/2.5 min live). The executor now ANNOUNCES intent (durable,
  `sv5_write_cal` for a calibration test = a STRONGER claim) then `acquire()`s the socket
  with a bounded async wait (`ACQUIRE_MS`, 9 s normal / 14 s calibration, both > the read's
  8 s socket timeout) — the read yields, so once the in-flight read frees `sv5_busy` the
  write claims it; worst-case latency ≈ one read duration, never a ~10 s bounce. The reader
  yields for at most `maxSkips` consecutive ticks (3 normal / 6 calibration, `sv5_read_skips`)
  then FORCES a read and warns ("Lesezyklus … erzwungen") so telemetry can never starve; a
  write that can't win the socket within its budget DEFERS, increments `sv5_write_defers`
  (reset on a landed write in `finish()`) and, past 2 in a row, WARNs the running count
  ("N Takte in Folge verschoben") so the failure is never invisible. `ACQUIRE_MS`/`POLL_MS`
  are overridable via flow context (`sv5_acquire_ms`/`sv5_acquire_poll_ms`) for deterministic
  tests only — never set in production. Proven by the multi-tick coordination tests in
  `deye-control.e2e.test.js` (win-by-waiting, bounded skip + forced read, calibration higher
  bound, counted-and-reported deferral). `flows-sync.test.js` covers neither node — this
  behaviour is proven only by `deye-control.e2e.test.js`.
- **The First-Light register readback evidence is VISIBLE on the `:8484` control card even
  for an UNCERTIFIED family (`fm/vp-calib-evidence-u4`, Defect 1).** The calibration write's
  readback (`state.Control`, `source=="calibration"`) is already on `/api/state`; `control.js`
  used to short-circuit to the read-only banner on `control_certified===false`, hiding the
  commanded-vs-actual table exactly when the operator/firstmate need it to judge sign/scale.
  It now renders the table (reframed as a Kalibrier-Test) whenever an uncertified device has
  a register readback — production writes nothing to an uncertified device, so a readback
  there can only be a calibration test. Showing evidence certifies nothing (the server-side
  gate is untouched). Pinned by `web_test.go TestControlCardShowsCalibrationEvidenceForUncertifiedModel`
  + `agent/calibration_test.go TestCalibrationReadbackDetailSurfacesForUncertifiedFamily`.
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
- **The V5 WRITE response is parsed at the SAME offset 25 as reads, and a short payload means the inverter did not answer - NOT a wrong offset (fm/vp-deye-v5write-z4).** `deye/solarman-v5.js parseV5Response` slices the embedded Modbus reply at `V5_RESPONSE_MODBUS_OFFSET=25` for reads AND writes (pysolarmanv5 uses 25 for both; a normal FC6 echo is 8 bytes and fits). The live Pilsting logger ACCEPTS the write frame but its V5 response carries a Modbus payload `<5` bytes - it framed a reply the inverter did not (properly) answer. The parser now NAMES each case instead of a bare "zu kurz": empty payload ("der Wechselrichter hat auf die Schreibanfrage nicht geantwortet"), a 1-4-byte stub (with its hex), a stub shaped like a Modbus exception (decoded), and validates the frame-type byte (offset 11, must be `0x02`=Wechselrichter) + reads the status byte (offset 12). `parseWriteResponse`/`parseModbusResponse` map every Modbus exception code to plain German (`MODBUS_EXCEPTIONS`; **0x0B = "gateway target failed to respond"** = the logger IS a TCP<->RS485 gateway, so it was reached but the inverter was not). A failed parse attaches `err.v5` (parsed header) + `err.frameHex`; the write executor (`build-flows.js controlExecSolarmanFunc`) logs the RAW request+response hex + header via a rate-limited `diagRL` (write-path ONLY, never the hot read poll) so ONE `docker compose logs nodered` line settles what a real logger returns. New helpers `hexdump`/`describeV5Frame`/`v5FrameTypeLabel`/`modbusExceptionText` are exported. The happy path (frame type `0x02` + a `>=5`-byte reply) is byte-identical, so reads never regress. This PR REVEALS the write-failure reason; it does not by itself make the inverter accept the write (a short/empty reply means the ToU registers/sequence or bus state, not the transport, is at fault). Proof: `deye/solarman-v5.test.js` (write-response cases + helpers), `deye-control.e2e.test.js` (short-reply named+logged through the real flow; deferred write is loud+lands). Do NOT add a write path to `deye/solarman-probe.js` (read-only diagnostic; a script must never write to a real inverter).
- **The corrected DISCHARGE plan forces export; it never just permits it (`fm/vp-deye-discharge-p3`, report `vp-deye-tou-dir-q5` §8).** Strategy A (ToU target-SoC floor + power cap + grid-charge off) is CORRECT for CHARGE but fundamentally INCOMPLETE for DISCHARGE: on a Deye the ToU target-SoC is a discharge FLOOR (a permission), not a command, and Export/Selling-First charges the battery from surplus BEFORE exporting - so "discharge to floor" never FORCES export while the inverter charges instead (the live −0,3 kW commanded / +12 kW charged symptom). `deyeControl` now synthesises a real discharge with the missing levers, in report §8 order with ACTIVATION (`touEnable`) STRICTLY LAST: `energyPattern 0x008D ← Load First(1)` + `workMode ← Export First` + `solarSell 0x0091 ← ON` + progCharge/progSoc-floor (permissions) + **`maxSellPower 0x008F ← X`** (the gentle "6b" export/sell-power forcing lever the owner chose) + progPower(N1-scaled) + `touEnable ← 0x00FF`. CHARGE keeps Strategy A plus `energyPattern ← Battery First(0)` and restores `maxSellPower` from the snapshot. **The heavier "6a" max-charge-current clamp (`0x006C`) is DELIBERATELY NOT wired** (owner decision) - the code is structured so 6a can be a later fallback if the bench shows 6b unhonoured; do not wire it live. `invert_control_sign` is a RED HERRING for this (direction is target-SoC-encoded, not a signed value; at a full battery a flip is a silent no-op masquerading as a fix) - keep it OFF for Deye discharge. **Deye has NO revert timer**, so the new installer-level levers (energyPattern/solarSell/maxSellPower) would LATCH in EEPROM: the executor SNAPSHOTS the installer's pre-control register values via FC3 BEFORE its first write (the union `controlRoute` lists in `ctrl.snapshotPlan`), persists them DURABLY (`settings.js contextStorage` `file` store under `/data/context`, survives restart + re-seed; `default` stays in-memory so nothing else changes), and `controlRelease` RESTORES them on EVERY hand-back (TTL/abort/disarm/control-off/loss all funnel into the same `controlRelease(sel,{snapshot})` at the plan node; a startup `auto-control-recover` node handles crash recovery from a leftover snapshot, self-contained so it works before the retained config reloads), `touEnable` restored LAST; a successful release CLEARS the snapshot; no snapshot ⇒ the old `tou_enable=0` release. **N1**: progPower AND maxSellPower use `power_scale` consistently ([1,10]; HV=10); an unconfirmed scale flags `powerScaleConfirmed=false` and the executor WARNs (never silently 10x wrong). **N2**: the executor reads all 6 program start-times at snapshot time and WARNs + flags `active_slot_conflict` when a later Program (2-6) governs "now" - we NEVER rewrite Programs 2-6 (a one-time commissioning step sets the slot grid). All levers stay `bench_pending`; `hybrid_3p`/`hybrid_1p` stay OUT of `CERTIFIED_CONTROL_FAMILIES`. On `hybrid_1p` `maxSellPower == exportLimit` (both `0x00F5`) so the 6b lever and the curtailment cap collapse to ONE op (tighter/min value); on `hybrid_3p` they are distinct (`0x008F` vs `0x00E7`). Discharge is unobservable at 100 % SoC - the bench draws the battery to ≈40-70 % first (CONTROL-BENCH.md §2). Proof: `inverter-control-routing.test.js` (synthesis/order/N1 HV+LV/N2/snapshot-restore), `flows-sync.test.js` (inline==module incl. snapshot threading), `deye-control.e2e.test.js` (real Solarman-V5: snapshot capture-before-write, release restore + clear, crash recovery, N1/N2 warns, cadence). Docs: DEYE.md "Korrigierter ENTLADE-Schreibplan" + CONTROL-BENCH.md §2.
- **Deye control writes go out as FC16 (write-multiple, 0x10) by DEFAULT; FC6 is a per-connection flip-back (`fm/vp-deye-fc16-y7`).** The z4 diagnostics revealed the live-Pilsting blocker precisely: the logger ACCEPTS an FC6 (0x06, write-single) write frame but the inverter never answers it and the register does not change (a 2-byte stub where the FC6 echo belongs). Many Deye hybrid firmwares only answer **FC16 (0x10, write-multiple)** - the Deye integrations that demonstrably write over the SAME Solarman-V5 logger use FC16 for every register even a single one: **deye-controller** (`githubDante/deye-controller`) writes exclusively via `write_multiple_holding_registers(addr, [value])`, **ha-solarman** (`davidrapan/ha-solarman`, our register-map source) via pysolarmanv5's FC16 path; community consensus (DIY-Solar / ha-solarman issues) is that FC6 "reports success but makes no change". So `inverter-control-routing.js deyeControl`/`controlRelease` stamp every Deye WriteOp with `fc = resolveDeyeWriteFc(conn)` (FC16 unless `connection.control_write_fc === 6`), and the executor (`build-flows.js controlExecSolarmanFunc`) DISPATCHES on `w.fc`: FC16 -> `__SV5.buildWriteMultipleRequest({startReg, values:[v]})` + `expectFn 0x10`, FC6 -> `buildWriteSingleRequest` + `expectFn 0x06`. It stays a **1-register write per WriteOp** (NOT a contiguous block): the EEPROM write-on-change discipline (`dwell_s`/`min_change`) is unchanged so write frequency does NOT increase, and block-writing this scattered ToU map would touch unrelated registers and risks the adjacent-SoC clobber (evcc #27458). The codec (`deye/solarman-v5.js`) already had `writeMultipleRegistersRequest`/`buildWriteMultipleRequest` + `parseWriteResponse` handling of the fn-0x10 echo `{startReg,count}` - this PR only ROUTES through them, so `solarman-v5.js` is unchanged. The switch is the `control_write_fc` select on `solarmanFields()` (Go `inverter.Connection.ControlWriteFc`, validated {0,6,16}, published in `BusPayload`, cleared on non-Deye transports), surfaced on the `:8484` inverter form (catalog-driven, no JS change); `0`/absent = auto = FC16. **This PR is the write-side FIX (FC16 makes the inverter answer), whereas z4 only REVEALED the reason.** SunSpec/generic-Modbus control (the certified `sunspec` family, `controlExecFunc`, addr 40/41/42) is a DIFFERENT transport and stays FC6 - untouched. The executor also logs ONE known-good FC3 readback frame per process (`Rueckleseframe OK`, write-path only, never the hot read poll) so a good read vs a bad write reply can be compared. Proof: `inverter-control-routing.test.js` (FC16 default / FC6 flip / release honors it), `deye-control.e2e.test.js` (wire-fc audit: default FC16 lands+reads-back, `control_write_fc:6` lands over FC6, good-readback-frame logged; the in-process logger now honours FC16), `solarman-v5.test.js` (FC16 V5-request shape + FC16 exception), Go `inverter_test.go TestControlWriteFcIsPreservedAndPublished`, `flows-sync.test.js` (inline==module).

## Deye REMOTE MODE (registers 1100-1121) is the PRIMARY Deye control path

Deye protocol **V105.1+** added a "Customized register" block that is a real
external-EMS interface, and it supersedes the Time-of-Use hack (scout
`firstmate/data/vp-deye-approach-w8`; the operator picture is
`nodered/DEYE.md` §"Batteriesteuerung: ZWEI Pfade"). **PROVEN present on the
owner's SUN-30K-SG01HP3-EU** (live read-only probe 2026-07-27): `1101=0xFFFF`,
`1104=0`, `1105=2` → the PR #978 layout, setpoint at **1109**.

- **Two paths, DETECTED not assumed - and the decision is STICKY (live regression
  Pilsting 2026-07-28, PR fm/vp-remote-probe-d4).** `inverter-control-routing.js`
  `deyeCapabilityProbeSpec` (two FC3 READS: the LV/HV identity register `0x0000`
  + the block `0x044C..0x0461`) and `classifyDeyeCapability` decide; the
  EXECUTOR performs the probe and the PLAN node reads the result back. A Deye
  firmware update has removed remote mode from a user's inverter before and a
  later one restored it. THE RESTART REGRESSION taught three laws:
  (1) **Evidence classes.** The shape check accepts a ONCE-DRIVEN register state
  (`1101 = 60`, our own watchdog value, is a plausible watchdog - the factory
  `0xFFFF` is not required). DEFINITIVE "absent" = a remote-less firmware's own
  register values, the v105_1 layout, or the request-indicting Modbus exceptions
  0x01/0x02/0x03 (`deyeProbeErrorDefinitive`). TRANSIENT (60 s retry, NEVER a
  path change) = the ALL-ZERO logger stub ("inverter did not answer", the
  soc_pct=0 class), the gateway exceptions 0x0A/0x0B, and transport errors -
  the old code cached a restart-window stub as the definitive "Firmware ohne
  Fernsteuerung" for 6 h and the certified pilot silently swapped to EEPROM
  ToU writes that fought the inverter (max_sell_power 0 vs installer 7182).
  (2) **The path is decided ONCE and kept durably** (`deye_path:<target>` in the
  'file' flow context, `deyeUpdateSticky`): it flips only after
  `DEYE_PATH_CONTRARY_N = 3` consecutive DEFINITIVE contrary verdicts or an
  operator action (`remote_mode = 'off'`), never per probe tick - the fix for
  the per-tick card flap. A landed remote write records `everRemote` durably;
  the core seeds the decision via `device_certified_path` on edge/setpoint (the
  grant carries the path its First-Light evidence was produced on,
  `calibration-certified.json` `paths` - ADDITIVE, no version bump).
  (3) **Certified ToU only engages DELIBERATELY** (the gate in `deyeControl`):
  a definitive verdict, `remote_mode='off'`, or a calibration test - never a
  failed probe; and a remote-proven device (everRemote / grant path) NEVER
  auto-engages ToU, it holds off loudly (`pathHold: 'remote_proven'|'unconfirmed'`,
  blocked + reason) until remote answers again. Only ever narrows - uncertified
  devices and every gate are untouched. An IDLE (0 kW) ToU slot restores
  max_sell_power from the snapshot instead of commanding 0 (the live fight).
  Proofs: the sticky/hold/idle units in `inverter-control-routing.test.js`, the
  three PILSTING e2e tests in `deye-control.e2e.test.js` (plan node -> executor
  -> in-process logger: grant-path drives through a zeros-probe restart; old-core
  hold -> bounded retry -> remote resumes; one contrary verdict never flaps),
  and the sticky flows-sync pins.
- **The path INTERLOCK is the "never write into the void" rule:** the plan is
  built from whatever DECISION the plan node saw, so if the probe just changed
  the decided path the executor writes NOTHING that tick and lets the next one
  re-plan (the comparison is against the sticky decision, not the raw verdict).
- **The write order is load-bearing:** `1101` watchdog FIRST (arm the dead-man's
  switch before anything can move) → `1104=1` BATTERY-side (AC-/grid-side
  throttles PV) → `1105` strategy (DEFAULT **2** = Power; **5** = Power+SOC only
  when `conn.remote_battery_strategy=5`) → `1108` SoC belt (**strategy 5 ONLY** -
  omitted on the default) → `1109` signed setpoint → `1100=1` ENABLE LAST.
- **DEFAULT strategy is 2 (Power), NOT 5 (`resolveDeyeRemoteStrategy`, fm/vp-deye-strategy-v2).**
  On the live SUN-30K-SG01HP3-EU (2026-07-27) strategy 5 + `1108`=5 % with the
  battery at 100 % SoC drove the battery TOWARD 5 % as a TARGET (every register
  echoed, yet ~-8,0 kW measured on a commanded -1,0 kW), so the power value was not
  the binding rate. The default now writes ONLY the setpoint (no `1108`); strategy 5
  + the belt is an opt-in re-test lever (`connection.remote_battery_strategy=5`,
  plumbed through Go `Connection.RemoteBatteryStrategy` + `BusPayload`). Dropping the
  on-device belt does NOT weaken SoC protection - `guards.Clamp` is the SoC authority
  either way (charge→0 at/above SocMax, discharge→0 at/below SocMin, every tick).
- **`always: true` + `dwell_s: 0` on every remote WriteOp is NOT optional.** RAM
  registers have no wear cost and re-asserting every ~10 s tick IS the watchdog
  kick; the executor's EEPROM write-on-change filter would otherwise skip an
  unchanged value and let the watchdog expire mid-operation (and leave a reverted
  `1100` un-re-enabled).
- **Conversion:** `units = -round(kw / ratedKw * 1000)`, clamped ±1200. The sign
  FLIPS (our contract is `+ = charge`, the register is `- = charge`) and
  `ratedKw` comes from the CATALOG (`inverter.Model.RatedKw`, published as
  `rated_kw` on `edge/inverter/config`) - never hardcoded; unknown rating =
  refuse. ~30 W resolution on a 30 kW unit, so a commanded 1 kW reads back 0,99.
- **Release is trivial and that is the point:** `1100 <- 0`, and simply STOPPING
  is the failsafe of last resort (the inverter's own watchdog reverts it with
  nothing changed). The path touches **no installer setting at all**, so there is
  no snapshot to restore - `snapshotPlan` is deliberately absent, and a LEFTOVER
  ToU snapshot is restored only after remote is disabled.
- **⚠ The SoC guard is SAFETY-CRITICAL here.** One field report says the
  inverter's own min/max-SoC protection may NOT apply in remote mode, so
  `guards.Clamp`'s band is the authority (the adapter writes the already-clamped
  kW verbatim and never widens it): it clamps charge→0 at/above `SocMaxPct` and
  discharge→0 at/below `SocMinPct`, re-evaluated every tick (`guards.go` step 2).
  Since the strategy default flipped to 2 the on-device `1108` belt is NO LONGER
  written by default (it was mishandled as a target - see the strategy bullet);
  the guard band is now the ONLY SoC protection on the default path, which is why
  the guard is the load-bearing safety argument. `edge/setpoint` still carries
  `soc_max_pct`, used by the opt-in strategy-5 belt.
- **Curtailment is NOT on this path** (`pvLimitSupported:false`, reported never
  silently dropped): the Deye feed-in cap is an EEPROM installer register.
- `1121` (remote status) is an **observation**, carried in `plan.observations` →
  `remote_status_raw`, deliberately OUT of `readbacks` so it can never fabricate
  or break `all_match`. The active path rides `control_path` on the readback →
  `state.ControlInfo` → the `:8484` card → `cloud.ControlSummary`.
- Deye stays OUT of `CERTIFIED_CONTROL_FAMILIES`; First-Light calibration is the
  one certification-only bypass and `VP_CONTROL_ENABLED` still wins. Bench
  procedure: `nodered/CONTROL-BENCH.md` §"Deye zuerst".
- Proof: `inverter-control-routing.test.js` (capability vectors incl. the owner's
  live probe, the conversion on 12/20/30/50 kW units, order, RAM cadence,
  "touches only 1100-1121", release), `flows-sync.test.js` (the inline plan-node
  copy == the module for both directions + the release), `deye-control.e2e.test.js`
  (the REAL executor against an in-process Solarman-V5 logger: probe → interlock →
  ordered FC16 writes → readback + the 1121 observation → release).

## A register READBACK is not a value comparison: semantics, then debounce

The hold check ("hat der Wechselrichter den Sollwert übernommen?") has THREE layers
since the live flap of 2026-07-30, and mixing them up is what produced a warning
every ~10 s tick on a plant that was demonstrably following the setpoint. Full
live protocol + the three measured mechanisms: `nodered/DEYE.md` → "Die
Rückmeldung: was ein Register-Ist-Wert BEDEUTET".

1. **`nodered/readback-verify.js` owns the SEMANTICS** (pure, self-contained,
   `embedModule`-ed VERBATIM into the Deye executor - no synced copy exists, so it
   cannot drift). Per register `held | mismatch | unread`, per cycle
   `held | mismatch | unconfirmed`. The rules that are NOT a value comparison:
   a value OUTSIDE the register's documented range (`VALUE_RANGE`) is a
   logger/gateway FILLER, i.e. no answer (the live `65535` on 1100/1104/1105 - the
   `socPlausible` discipline applied to control); a dynamic register is judged by
   its own rule (the watchdog 1101 counting our armed value down is HELD; only 0 =
   expired and 0xFFFF = off are refusals); the tolerance is measured on the 16-bit
   RING (`regDistance`), because a signed setpoint reading -1 against a commanded 0
   is inside a 1-unit tolerance, not 65535 away. `unread` is NEVER a mismatch, and
   a mismatch WINS over unread registers in the same cycle.
2. **The executor never fabricates.** No `regs[0] || 0`: a read that yields no
   value stays null (`actual_raw: null` all the way to the card, the Modbus mirror
   and the First-Light evidence), a bad read is RETRIED ONCE on the socket already
   held, and a frame-level failure publishes an honest UNCONFIRMED cycle instead of
   aborting the tick and leaving a stale verdict on screen.
3. **The CORE decides when a run of cycles is a warning** (`agent.applyControlConfirm`
   → `state.ControlInfo.Confirm`): `held` / `checking` / `not_held` (3 consecutive
   real deviations) / `no_answer` (6 consecutive answer-less cycles - silence is
   named, never dressed up as healthy) / `pending`. An unconfirmed cycle keeps the
   last known verdict and touches no counter, so it can neither raise nor clear an
   alarm; registers are NAMED only once `not_held` is confirmed. `control.js` /
   `status.js` / `groups.js` / `calibration.js` all key on `confirm`, and the
   heartbeat carries the DEBOUNCED verdict so the portal stays calm without a cloud
   change. A readback carrying only the old `match`/`all_match` booleans keeps its
   exact two-state meaning, so core and Node-RED images can be deployed separately.

**`edge/control/readback` carries TWO payload FAMILIES** - the primary inverter's
control readback and the per-unit PV curtailment readback (`curtail: true`).
`vp-control-readback.shape()` must pass the curtail family through VERBATIM: its
field whitelist used to drop `curtail`/`source_id`/`unit_key`/`enforcement`, so the
curtailment state never reached `Snapshot.CurtailUnits` AND every curtailment cycle
clobbered the battery control card (measured live at 09:35:48Z between two healthy
remote cycles). When adding a field to either family, ask the AGENTS.md question
first: observation or gate?

**Write cadence on the remote path is scoped, not blanket.** `always: true` (every
~10 s tick) belongs to the three ops where the re-write IS the mechanism - watchdog
kick 1101, the setpoint 1109, the enable 1100. The configuration registers
1104/1105 (+ the opt-in belt 1108) carry `reassert_s` (300 s) and are re-written
IMMEDIATELY when a readback shows them not held (the executor drops their
write-cache entry). Not a wear argument - 1100-1121 is RAM - but a SOCKET argument:
the Solarman logger takes one client, and a starved/displaced readback is what
produced the false alarms.

## Deye N1: an UNKNOWN HV/LV power scale now REFUSES the whole ToU plan

The live 10x bug (report §2.3): `power_scale` "Automatisch" fell back to 1, so an
HV SG01HP3 was written **10x too large** - a 0,3 kW command became a ~15 kW export
ceiling and the plant exported 14,6 kW. `resolveDeyePowerScale(conn, cap)` now
resolves explicit config → the DEVICE-DETECTED class from the capability probe
(register `0x0000`, the read path's own auto-detect) → **refuse**. With the scale
unknown the ENTIRE ToU plan is withheld (`powerScaleSuppressed`, planned/writes/
readbacks all empty), because emitting it minus the power ops would arm ToU +
Export-First + Solar-Sell against the installer's own sell-power ceiling - the same
accident. **Consequence for tests: a Deye fixture that exercises the ToU mapping
must state `power_scale`** (or supply a capability with a `scaleClass`). The remote
path derives its scaling from rated power and cannot inherit `power_scale` at all.

## Die Zertifizierung hat ZWEI Hälften: Flotten-Allowlist + Laufzeit-Freigabe pro Gerät

Der Schreib-Gate im Executor lautet
`controlEnabled && (CERTIFIED_CONTROL_FAMILIES.has(family) || setpoint.device_certified === true || calibration)`.

- **Flottenweit** = `CERTIFIED_CONTROL_FAMILIES` in `inverter-control-routing.js`
  (heute nur `sunspec`): eine am Prüfstand für die ganze Modellklasse belegte
  Familie. Diese Liste NICHT „reparieren", indem man eine auf EINEM Gerät
  freigegebene Familie einträgt.
- **Pro Gerät** = die First-Light-Freigabe, die der Kern als **`device_certified`**
  auf `edge/setpoint` mitschickt (`Agent.controlCertified` = env-Allowlist MERGED
  mit `data_dir/calibration-certified.json`). Vorher erreichte diese Freigabe
  Layer 1 nur eingefaltet in `control_enabled` — ein Wert, der AUCH beim reinen
  Not-Aus false ist. Der Executor konnte „freigegeben, Steuerung an" nicht von
  „nicht freigegeben" unterscheiden und plante auf dem freigegebenen Piloten
  (`hybrid_3p`) dauerhaft `writes: []`: **der Fahrplan erreichte den
  Wechselrichter nie, nur der Kalibrier-Bypass schrieb** — First-Light war für
  den Realbetrieb wirkungslos.

Regeln, die dabei bleiben: `controlEnabled` ist auf BEIDEN Seiten das äußere AND;
`guards.Clamp` bleibt vorgelagert autoritativ und der Adapter darf nur VERENGEN;
SoC-Band, Magnitudenkappung, Remote-Watchdog (1101) und die Schreib-REIHENFOLGE
(Watchdog zuerst, Enable zuletzt) sind unberührt; die Beweisführung der Freigabe
(readback-bestätigter Test mit gemessener Bewegung) ist unverändert — geändert hat
sich NUR, wen die Freigabe erreicht.

`controlRelease` nimmt dieselbe Freigabe (`opts.deviceCertified`) — **tragend**:
was gefahren werden darf, muss auch zurückgegeben werden können, sonst übernähme
ein freigegebenes Gerät die Steuerung und gäbe sie bei Not-Aus/stillem Kern nie
zurück. `certified` bleibt bewusst EINE Variable (Gate, deutscher Grund,
Readback-Stempel, `dualControllerSignal` meinen alle „dieses Gerät darf live
geschrieben werden") — genau das, was der Kern rechnet, womit der Readback jetzt
mit dem Kern übereinstimmt statt by design zu divergieren.

**Ein `device_certified`-Feld nützt nur, wenn es auch ankommt:** `vp-sollwert`
reicht das Kommando VOLLSTÄNDIG durch (kein Feld-Whitelist wie
`vp-telemetrie.shape()`) — durch `nodes_spec.js` gepinnt. Beide Images müssen
deployt werden: der Kern sendet das Feld, der Flow liest es.

Beweise: `agent/control_test.go` (Setpoint trägt die Freigabe; Kill-Switch bleibt
außen), `inverter-control-routing.test.js` (granted/ungranted/absent, nur ein
echtes `true` zählt, Release-Symmetrie, N1/Nennleistung weiterhin verweigert),
`flows-sync.test.js` (Inline-Kopie == Modul für den granted-Fahrplan + den
durchgereichten Release) und `deye-control.e2e.test.js` „FAHRPLAN e2e" (echter
Plan-Node aus flows.json -> echter Executor -> in-process Solarman-V5-Logger, OHNE
Allowlist-Mutation und OHNE Kalibrier-Flag).

## Gate-Flags im Heartbeat kommen aus dem KERN, nie aus einem Readback-Stempel

Ein Readback-Stempel ist eine Layer-1-BEOBACHTUNG und niemals die Autorität für
ein Gate-Flag. Zwei Live-Defekte derselben Klasse haben das bewiesen — beide
zeigten sich als eine dauerhaft falsche Aussage im Portal, während `:8484`
korrekt war:

- **`certified`**: der Node-RED-Flow stempelt es aus seiner STATISCHEN
  Familien-Allowlist (`inverter-control-routing.js` `CERTIFIED = {sunspec}`), die
  die per-Gerät erteilte **First-Light**-Freigabe gar nicht kennen kann → ein
  freigegebener Deye (`hybrid_3p`) meldete dauerhaft `certified:false`.
- **`control_enabled`**: der Exec-Node stempelt `!!ctrl.controlEnabled`, und
  `controlRelease()` setzte `controlEnabled` gar nicht → `!!undefined` = `false`.
  Nach JEDEM First-Light-Test feuert der TTL-Auto-Revert einen RELEASE, dieser
  Readback ist damit der LETZTE, den die Cloud auf einer unzertifizierten Familie
  sieht, und jeder folgende Heartbeat wiederholte `control_enabled:false` — das
  Portal sagte auf Dauer „Die Wechselrichter-Steuerung ist ausgeschaltet".

`agent.controlSummary` liest deshalb BEIDE Flags aus dem Snapshot
(`snap.ControlCertified` / `snap.ControlEnabled`, gepflegt von
`applySetpoint`/`calibration.go` — genau die Werte der lokalen Karte). Das ändert
NUR, was BERICHTET wird: wer schreiben darf, entscheiden weiterhin das
`control_enabled` auf `edge/setpoint` und die Allowlist des Executors. Den
`CERTIFIED`-Map des Flows nicht „reparieren": First-Light ist bewusst eine
Laufzeit-Freigabe pro Gerät. Weichen Kern und Readback ab, nennt
`logControlGateDivergence` beide Werte einmal pro 10 min im Log statt still zu
überschreiben. `controlRelease` trägt `opts.controlEnabled` inzwischen auf jedem
Zweig durch (Defence in Depth — der Readback lügt nicht mehr strukturell, ersetzt
den Kern-Fix aber nicht: beim Calibration-Revert ist `control_enabled:false`
ehrlich). Beweis: `agent/control_test.go
TestHeartbeatCertifiedFollowsTheCoreNotTheFlowAllowlist` +
`TestHeartbeatControlEnabledFollowsTheCoreNotTheReleaseReadback` (je beide
Richtungen — ein Flow, der ein Gate BEHAUPTET, gewinnt nie),
`inverter-control-routing.test.js` + `flows-sync.test.js`.

**Beim nächsten Feld im Heartbeat zuerst fragen: Beobachtung oder Gate?**
Beobachtungen (`all_match`, `mismatch_roles`, `commanded/confirmed_kw`,
`control_path`, `remote_status_raw`, `possible_conflict`) gehören zum Readback;
Gate-Flags gehören in den Kern.

## Modbus-Datenspiegel: read-only LAN Modbus slave, NEVER a socket consumer

`core/internal/mirror` + `agent/mirror.go` serve every register on the LAN
(container 1502, host `${VP_MIRROR_PORT:-502}`; unit = `mb_slave_id` -> native
Deye pass-through, unit 100 -> the frozen VoltPilot map v1) - full operator
doc + register tables in `edge-app/MODBUS-SPIEGEL.md`, Loxone sensor list in
`docs/loxone-voltpilot-map.md`. Rules that must hold when touching it:

- **THE invariant: a consumer request never causes I/O.** Answers come only
  from caches fed over the local bus (retained `edge/registers/raw` from the
  Deye poll, the gated composite at `onLocalTelemetry`, control readbacks for
  the 1100-1121 window). Consumer demand may only steer what OUR poll fetches:
  the learned want set rides retained `edge/registers/want`, and the router
  merges AT MOST ONE learned block (<= 64 regs, <= 8 blocks, LRU) per 5-s
  cycle, AFTER the primary blocks, inside the unchanged sv5 lock that yields
  to control writes. Never widen these caps; the watchdog argument rests on
  them.
- The control window 1100-1121 is readable (from readbacks) but must NEVER
  enter the learned set/poll; FC3/FC4 are the only dispatched function codes
  (no write path exists in the package).
- Staleness keys on the PAYLOAD ts of `edge/registers/raw` (poll time), so a
  stale retained message after a core restart serves nothing fresh; native
  blocks answer 0x0B when stale, the VP map surfaces age/quality in-map.
- Default OFF (`mirror.json`); disabled = no listener AND an empty retained
  want set. The Einrichten card (`static/mirror.js`, `#mirrorCard`) is a
  NORMAL-mode customer control (owner decision) - toggle + copy-ready address;
  only the register detail is Technik-gated. `VP_MIRROR_PORT` is display+
  mapping only (compose lockstep incl. `install.sh generate_compose()`).
- Proofs: `internal/mirror` units (framing/fuzz/learner/staleness),
  `agent/mirror_integration_test.go` (bus->TCP byte-match, learn->deliver,
  /api/mirror toggle), `nodered/mirror-poll.e2e.test.js` (real poll +
  in-process Solarman logger: learned-after-primary, refusal isolation,
  write-intent skip), `test/e2e-compose.sh` (unit 100 vs /api/state, FC6
  refused). A learned block the inverter refuses ('Modbus-Ausnahme') is
  dropped + answered 0x02 - keep that error string stable across the
  auto-solarman copy and `mirror.UpdateRaw`.

## `.env`-Schalter müssen in der Compose auch WEITERGEREICHT werden

`edge-app/docker-compose.yml` gibt dem `core` nur eine explizite Env-Liste mit —
ein vom Core gelesener `VP_*`-Schalter, der dort fehlt, ist über die `.env`
UNERREICHBAR (live bestätigt: `docker compose exec core env | grep VP_CONTROL`
war leer, obwohl CONTROL-BENCH.md das Setzen von `VP_CONTROL_ENABLED`
beschreibt). Prüfen mit `docker compose config` bzw. gegen die Liste aus
`grep -oE '"VP_[A-Z0-9_]+"' core/internal/config/config.go`. Lockstep: derselbe
Block steht in `install.sh generate_compose()` (Guard:
`test/install-selfcheck.sh`); `update.sh` sourced install.sh und folgt
automatisch. Default-Werte in der Compose IMMER auf `config.Defaults()` setzen,
damit das Weiterreichen nichts verändert. Weiterhin NICHT weitergereicht (bewusst
oder noch offen, siehe PR fm/vp-control-enabled-y3):
`VP_CONTROL_CERTIFIED_FAMILIES` (Zertifizierungs-Allowlist bleibt von der
`.env`-Oberfläche fern), `VP_CALIBRATION_*`, `VP_GRID_CHARGE_ALLOWED`,
`VP_NODERED_ADMIN_URL/USER/PASSWORD` auf dem CORE (E2-Flow-Deployment),
`VP_FLOW_NODE_STATUS_ENABLED`, `VP_SETPOINT_INTERVAL_SECONDS`,
`VP_RECONCILE_INTERVAL_SECONDS`, `VP_DEV_INSECURE`.

## PV-Abregelung (Fronius Increment 3): Quellen-Schreibpfad, Freigabe JE EINHEIT, Wirkung > Register

Die Fahrplan-Phase "Abregeln" wird auf **fronius_sunspec-ERZEUGER-QUELLEN**
physisch ausgefuehrt (Pilsting: zwei Fronius hinter EINER IP, Unit-IDs 1+2).
Operator-Doku: `nodered/FRONIUS.md` par.6b + `nodered/CONTROL-BENCH.md`
"Checkliste Fronius PV-Abregelung". Regeln, die halten muessen:

- **EIN Planungs-Truth: `nodered/sunspec/curtail.js`** (pure; model-discovery
  wird INJIZIERT wie bei sunspec-live) - Aufteilung der Anlagen-Begrenzung
  (proportional zur Nennleistung, Wasserfall, minus gemessenem
  unkontrollierbarem Anteil), Gates, Release, Override-Erkennung. Die
  Flow-Knoten "PV-Abregelung / Schreibplan"+Executor im QUELLEN-Tab betten es
  ein (flows-sync pinnt); der Go-Zwilling ist NUR der unitKey
  (`agent/curtail.go curtailUnitKey` == `curtail.js unitKey`, byte-identisch).
- **Der `curtail`-Block am edge/setpoint traegt den ROHEN Kill-Switch** -
  bewusst NICHT das Top-Level-`control_enabled` (das ist mit der Freigabe des
  PRIMAER-Wechselrichters verundet und darf nie ein anderes Geraet gaten).
  Dazu `pv_uncontrolled_kw` (Composite-PV minus Fronius-Quellen-PV) + je
  Quelle `certified`/`capacity_kwp`/`test`. Auch der Kalibrier-Override
  (calibration.go) publiziert den Block, damit ein Batterie-First-Light die
  Caps nicht kurz aufhebt.
- **Freigabe JE PHYSISCHER EINHEIT** (`ip:port#unit_id`,
  `data_dir/curtail-certified.json`, versioniert wie
  calibration-certified.json): Evidenz = Register-Readback bestaetigt UND
  gemessene Leistung auf die Begrenzung gefallen (internal/curtailcal;
  80-%-Test, min. 5 kW, TTL 120 s, 3 min Confirm-Grace, Abort invalidiert).
  Register allein reichen NIE - Modbus hat auf Fronius die NIEDRIGSTE
  Prioritaet (lokale Einstellung/Solar.web/Smart Meter uebersteuern still),
  deshalb prueft der Executor die WIRKUNG nach 90 s Settle und meldet
  "moeglicher Override" (:8484 + Heartbeat `curtailment`-Block).
- **Readbacks je Einheit reiten edge/control/readback mit `curtail:true`** -
  der Core routet sie in `Snapshot.CurtailUnits`, NIE in `Snapshot.Control`
  (das Primaer-Geraet). Der Heartbeat-`curtailment`-Block traegt die
  Faehigkeit (Einheiten/freigegeben/Kill-Switch aus dem KERN) + die
  Beobachtungen (aktiv/bestaetigt/Override) - so unterscheidet die Cloud
  "geplant und ausgefuehrt" von "geplant, Anlage kann es (noch) nicht".
  Die Cloud LIEST ihn seit PR 3 der Pilsting-Analyse (api-Listener
  `CurtailmentStatusListener` -> `device_curtailment_status` ->
  `GET /sites/{id}/curtailment-status`, Portal-Drei-Stufen-Wortlaut);
  Edge-seitig aendert das NICHTS - der Block ist unveraendert.
- **Socket-Disziplin im Quellen-Tab = die BEGRENZTE Schreib-Lease**
  (`nodered/sunspec/curtail-lease.js`, von Poll UND Executor eingebettet;
  Live-Vorfall Pilsting 2026-07-28: der unbegrenzte Vorgaenger - Anspruch auf
  JEDEM Takt auch fuers reine Beobachten, Walk-Retry ohne Backoff, kein
  Zyklus-Deadline, Poll wich bedingungslos aus - liess beide Quellen 15+ min
  verhungern, das seltene freie Fenster fiel immer an Quelle #1). Regeln, die
  halten muessen: der Executor beansprucht `curtail_want:<ip:port>` NUR wenn
  der Takt wirklich schreibt oder eine Discovery ansteht (reines Ruecklesen:
  kein Anspruch, weicht `src_reading:` aus, max. 1x/OBSERVE_MIN_MS je
  Gateway); die Lease wird zwischen Ops NEU gestempelt (Herzschlag) und in
  JEDEM Ausgang (finally) freigegeben; ein Gateway-Zyklus laeuft unter
  EXEC_DEADLINE_MS (Op-Timeouts aufs Restbudget gekappt); eine
  FEHLGESCHLAGENE Discovery wird `{failed:true, reason}` mit
  DISC_FAIL_BACKOFF_MS gecacht (Erfolg: 1 h). Der Poll weicht einer frischen
  Lease max. MAX_CLAIM_SKIPS Ticks je Quelle aus, ERZWINGT dann die Lesung
  (Warn "Telemetrie darf nicht verhungern"), verwirft eine Lease ohne
  Herzschlag nach CLAIM_TTL_MS laut (verwaister Executor) und ROTIERT den
  Zyklus-Start ueber die Quellen. Fehlgruende erreichen die Karte:
  `curtailcal.UnitView.last_error` traegt den letzten blocked-Readback-Grund
  (< 15 min, gesundes Readback loescht). `src_last:` (Messwert-Stash fuer
  Split + Wirkungs-Pruefung), One-Shot-Release (`curtail_was:`) und der
  native `WMaxLimPct_RvrtTms`-Totmann (60 s) sind unveraendert - aufhoeren
  zu schreiben IST der Failsafe. Beweise: `curtail-lease.e2e.test.js` (echte
  Node-Bodies gegen In-Process-Gateways incl. hang), `curtail-lease.test.js`,
  flows-sync-Pins. Test-Override `flow.curtail_deadline_ms` nur fuer Tests
  (sv5_acquire_ms-Praezedenz).
- `CERTIFIED_CONTROL_FAMILIES` bleibt unveraendert; Batterie-Steuerung, alle
  Deye-Pfade (`deyeRemoteControl` haelt `pvLimitSupported:false`) und
  guards.Clamp sind unberuehrt.

## First-Light-Härtung der PV-Abregelung: Auffrischung, Klemm-Plateau-Beweis, Ena-Quirk (06.08.2026, live Pilsting)

Vier belegte Live-Defekte am selben Tag (`nodered/FRONIUS.md` §6b/CONTROL-BENCH.md
für den Betreiber-Ablauf) führten zu einer HÄRTUNG der Freigabe-Prüfung, NICHT
zu einer Lockerung - restrict-only, Kill-Switch, Freigabe je Einheit und der
native Totmann bleiben unangetastet.

- **Einmal-Schreiben reichte nicht: der Cap braucht eine AUFFRISCHUNG.**
  `sunspec/curtail.js` `writeDecision`/`noteWrite`/`noteVerdict` sind die reine
  Zustandsmaschine (Flow-Kontext `curtail_cmd:<unitKey>`), die eine AKTIVE
  Begrenzung alle `REFRESH_MS` (20 s) neu anwendet, bevor der native
  `WMaxLimPct_RvrtTms` (60 s) sie aufheben kann - die KETTE
  `REFRESH_MS < DEFAULT_RVRT_TMS < DefaultTTL` (20 s < 60 s < 120 s) ist auf
  BEIDEN Seiten gepinnt (`curtail.test.js` + Go `curtailcal_test.go
  TestTheRefreshRevertTTLChainHolds`) - ändere sie nur zusammen. Ein laufender
  First-Light-Test frischt JEDEN Takt auf (sein Beweisfenster ist kurz, seine
  Anspruchslast durch die 120-s-TTL begrenzt).
- **Der Datamanager verschluckt Befehle - bounded Retry, dann eine EHRLICHE
  Ursache.** Eine deviante Rücklesung wird SOFORT einmal neu geschrieben,
  begrenzt auf `REWRITE_MAX_ATTEMPTS` (3) Versuche derselben Signatur; danach
  stoppt der Executor `REWRITE_COOLDOWN_MS` (60 s) lang und nennt
  `REJECTED_REASON` (deutscher Text, benennt den EVU-Editor / die IO-Regel
  "100 %" als wahrscheinlichste Ursache + den Hebel: die Regel deaktivieren,
  NICHT Prioritäten umbauen) statt weiter zu schreiben - nie eine heiße
  Schleife, nie ein stilles Aufgeben.
- **Der Klemm-Plateau-Beweis ersetzt die alte "Minimum ≤ Cap"-Regel
  (`internal/curtailcal`).** Zwei live Fehlpositive (Cap 17,4 → gemessen
  12,9 kW; Cap 9,7 → gemessen 9,5 kW - beides Wolken, keine Klemmung) zeigten:
  ein echter Cap KLEMMT die Leistung AM Cap (Plateau), er drückt sie nicht
  darunter. `Session.CanCertify` verlangt jetzt `PlateauSamples` (3)
  aufeinanderfolgende, register-gedeckte (`RegisterHoldFresh`, 45 s) Messwerte
  IN BAND um den Cap, WÄHREND der geschätzte Ambient-Wert klar über dem Cap
  liegt (`ambientMargin`). Eine Schwester-Einheit am selben Standort (Pilsting
  WR1/WR2) dient als Ambient-Referenz (Verhältnis bei Test-Start eingefroren -
  fällt NUR die getestete Einheit relativ zur Referenz aufs Cap-Niveau, ist es
  der Cap; fallen beide proportional, ist es die Wolke); ohne Referenz ist der
  eigene Vor-Test-Wert die (konservative) Schätzung, abgesichert durch die
  Kopfraum-Pflicht beim Teststart (`Start` verweigert einen Test ohne
  genügend Marge zum Cap). Verdikte: `bestanden` / `nicht_beweisbar` (die
  Ambient-Schätzung sank auf/unter den Cap - eine Aussage über das WETTER, nie
  über den Wechselrichter) / `kein_nachweis` / `laeuft`.
- **Die Ena-Kennung (`WMaxLim_Ena`) ist ein bekannter Firmware-Quirk, kein
  Fehler.** Dieser Datamanager beantwortet einen befohlenen `Ena=0` dauerhaft
  mit `1`. `sunspec/curtail.js` `evaluateReadback` toleriert das EINSEITIG
  (befohlen 0 / ist 1 = Quirk, weil das bindende Register `WMaxLimPct` bei
  einer Freigabe ohnehin auf 100 % steht und nichts mehr drosselt; befohlen 1 /
  ist 0 bleibt ein ECHTER Mismatch - genau der Fall, den das Rücklesen fangen
  soll). Der Quirk reist als `quirk_roles`/`quirk_note` getrennt vom
  `mismatch_roles`/`last_error`-Pfad bis auf die `:8484`-Karte
  (`curtail.js` UI: "Hinweis: …", nie das Warndreieck).
- Beweise: `sunspec/curtail.test.js` (Auffrisch-/Retry-/Cooldown-Zustandsmaschine,
  Ena-Toleranz), `curtail-lease.e2e.test.js` (SCHLUCKER/REVERTER/KLEMMER/
  ENA-QUIRK gegen einen In-Process-SunSpec-Server mit den drei Fehlerarten),
  Go `internal/curtailcal/curtailcal_test.go` (Plateau, Ambient-Referenz,
  beide live Fehlpositive als Regressionstests, Register-Frische) +
  `agent/curtail_test.go` (First-Light-Reise: Register allein reicht nie,
  eine einzelne Cap-Messung reicht nie, erst das Plateau zertifiziert).

## ⚠ Die PV-Abregelung wird als EIN FC16-Block geschrieben - ein Einzelregister wird gespeichert, aber nicht ÜBERNOMMEN (09.08.2026, live Pilsting)

Die Begrenzung geht seither als EINE Modbus-Transaktion (fn 0x10) über die fünf
ZUSAMMENHÄNGENDEN Register `WMaxLimPct .. WMaxLim_Ena` hinaus. Betreiber-Bild +
Messwerte: `nodered/FRONIUS.md` §6e. Was hier gelten muss:

- **Der Befund, weil die Fehlerform wiederkommt:** drei einzelne FC6-Schreibbefehle
  wurden ANGENOMMEN, der Wert stand die vollen 120 s im Register
  (`register_confirmed: true`) - und die Leistung folgte NICHT (Cap 13,1 kW,
  gemessen 13,8-17,5 kW bei 20,4 kW Ambient-Referenz, Plateau 0/3). Gleichzeitig
  kam `pv_limit_revert_tms` (befohlen 60) nie an und las dauerhaft 12000, den
  Wert des Vorgänger-Reglers. **Ein bestätigtes Register ist kein aktiver
  Befehl** - genau dafür existiert der Klemm-Plateau-Beweis.
- **Zwei unabhängige Quellen tragen den Fix**, er ist nicht geraten: das
  Fronius-Modbus-Handbuch („All 5 registers … can be written with one command",
  fn 0x10) und Victrons produktive Umsetzung (`victronenergy/dbus-fronius`,
  `sunspec_updater.cpp` `SunspecLimiter::writePowerLimit`: EIN
  `writeMultipleHoldingRegisters` mit `[pct, 0, timeout, 0, 1]` auf
  Modell-123-KOPF + 5). Victrons Adresse ist byte-für-byte unsere
  (Kopf + 5 = Rumpf + 3 = `WMaxLimPct`) - die Adress-Arithmetik war also richtig,
  nur die SCHREIBFORM war es nicht. Dieselbe Fehlerklasse wie bei Deye
  (dort ebenfalls FC6 angenommen und still ignoriert).
- **`WinTms`/`RmpTms` werden AUSDRÜCKLICH als 0 mitgeschrieben** (wie bei
  Victron): sie gehören zum Satz, und Reste eines Fremdreglers dürfen unsere
  Begrenzung nicht verzögern. Wer den Block kürzt, macht wieder ein „partielles"
  Kommando daraus.
- **⚠ `WMaxLimPct_RvrtTms = 0` heißt NICHT „kein Timeout", sondern „aktiv bis
  MANUELL deaktiviert"** (Fronius: „die Dauer, die der Betriebsmodus aktiv
  bleibt", 0..28800 s, Timer startet mit jeder neuen Modbus-Nachricht neu). Der
  Vorgänger-Regler hinterließ 12000 s, und als er verstummte, hingen BEIDE
  Wechselrichter 3,3 h bei ~0,135 kW fest. Nie 0 schreiben; die Kette
  `REFRESH_MS 20 s < DEFAULT_RVRT_TMS 60 s < Test-TTL 120 s` gilt unverändert.
- **Der Rückfall ist konfigurierbar, nie der Default:**
  `connection.curtail_write_fc` (0/absent = FC16, 6 = die alte Einzelregister-
  Form) - der Zwilling von `control_write_fc` für den ANDEREN Steuerpfad.
  **Er muss DREI Whitelists überleben**, sonst ist er unerreichbar: Go
  `sources.busEntry` → der `sunspec_live`-Zweig des `sources-store`-Knotens in
  `build-flows.js` → `sunspec/curtail.js`, das ihn an `planCurtailment` reicht.
  Er reitet bewusst auf der QUELLEN-Konfiguration, weil ein Fronius als
  Erzeuger-QUELLE abgeregelt wird, nicht als Primär-Wechselrichter.
- **`plan.writes` hat jetzt ZWEI Formen** - ein Block-Op trägt `values` (+ `parts`
  als die eine Beschreibung der fünf Register), ein Legacy-Op `value`. Wer
  `writes` konsumiert, muss beide kennen: `curtail.commandSignature` faltet
  DESHALB jedes Register des Blocks (signierte es nur das erste, läse ein
  geänderter Timer oder ein umgelegtes Enable als „unverändert" und würde nie
  neu angewandt). `writes[0].encode.sf` bleibt für die kW-Rückrechnung erreichbar.
- **Es wurde KEINE Anlagen-Adresse erfunden.** In SunSpec gibt es kein
  anlagenweites Modell 123, das Handbuch kennt nur Wechselrichter- und
  Zähler-Adressen, und Victron schreibt pro Wechselrichter. Dass beide Geräte
  gleichzeitig klemmten, erklärt der gemessene Register-Zustand vollständig
  (beide trugen den gelatchten Zustand des Vorgängers). Die Anlagen-Semantik
  macht weiterhin `splitPlantCap`.
- Beweise: `curtail-lease.e2e.test.js` „PILSTING" (In-Process-Gateway mit
  `transactionalOnly`: FC6 wird bestätigt UND gespeichert, aber nur ein
  FC16-Block übernommen - der Block-Pfad regelt wirklich, der FC6-Rückfall
  reproduziert das Feld-Symptom „Register bestätigt, nichts übernommen"), dazu
  der FC16-Verweigerungsfall, `modbus-tcp.test.js` (Rahmenformat + Ausnahmen),
  `sunspec/model-discovery.test.js`, `sunspec/curtail.test.js`, Go
  `inverter_test.go` / `sources_test.go`.

## ⚠ Dynamische Einspeisebegrenzung: der EINE Guard, der blind NICHT stillhält (`guards.ExportLimiter`)

Der Echtzeit-Wächter am Netzverknüpfungspunkt (06.08.2026, live Pilsting): er
regelt die STEUERBAREN Erzeuger gegen die GEMESSENE Netzleistung, damit die
Einspeisegrenze der Anlage hält, egal was das Haus tut — die Aufgabe, die dort
bis dahin eine kundeneigene Loxone übernahm („sonst schiesst der drüber wenn ein
Auto abgesteckt wird"). Betreiber-Ablauf: `nodered/FRONIUS.md` §6d,
Umstellungs-Choreografie in `nodered/CONTROL-BENCH.md`.

- **Die Arbeitsteilung ist die des Hauses, nur mit anderem Absender:** der SOLL
  kommt aus der Cloud (`site.max_feed_in_kw`/FK1 → additives Top-Level-Feld
  `grid_export_limit_kw` im `mqtt-schedule`-Kontrakt), die REGELUNG läuft auf der
  Box. Der Plan konnte diese Grenze nie HALTEN: sie wird mit dem Haus geteilt,
  also hebt ein abgestecktes Auto die Einspeisung INNERHALB des Slots um dessen
  Leistung. **Ohne gepflegte Grenze ist der Wächter inaktiv und sagt das** — eine
  Grenze wird nie erfunden.
- **Das Regelgesetz ist eine Proportionalschleife mit Verstärkung 1**:
  `cap = pv_gesamt + (grenze − einspeisung) − marge`. Haus, Wallboxen und
  Batterie sind automatisch mitverrechnet, weil sie in der Netzmessung schon
  drinstecken — genau das ist der Vorteil gegenüber der Planung. Ergebnis ist eine
  ANLAGEN-Kappe, dieselbe Größe wie `pv_limit_kw`, also teilt der bestehende
  Executor (`sunspec/curtail.js splitPlantCap`) sie unverändert auf die Einheiten
  auf und zieht den nicht steuerbaren Anteil selbst ab.
- **⚠ DIE FAIL-SAFE-REGEL IST DIE UMKEHRUNG ALLER ANDEREN GUARDS.** Trim,
  Load-Follower, Surplus-Charger und Peak-Guard gelten „blind ⇒ INAKTIV, nie
  blind regeln" — eine verpasste Korrektur kostet Geld, nie Sicherheit. Bei einer
  COMPLIANCE-Grenze dreht sich das um: blind darf nicht „unbegrenzt" heißen.
  Deshalb Stufen statt Freigabe: frisch → Schleife; Messlücke ≤
  `ExportHoldWindow` → die letzte Kappe **einfrieren**; darüber → über
  `ExportContractWindow` linear auf die **sichere statische Kappe**
  zusammenziehen; nie gemessen → sofort diese Kappe. **Eine Kontraktion HEBT die
  Kappe nie an.**
- **Die sichere statische Kappe ist `Grenze − befohlene Entladung`** und braucht
  keinen Messwert: `export = pv + entladung − last − ladung ≤ pv + entladung ≤
  grenze`. Sie wird im Sollwert-Pfad gebildet (`agent.exportSafeStaticCap`), weil
  nur dort der endgültige Sollwert bekannt ist.
- **Komposition ist ein MINIMUM.** Der Wächter und die geplante Abregelung
  (Negativpreis/FK1) komponieren most-restrictive-wins; er lockert eine geplante
  Drosselung nie, kommandiert nie die Batterie (das wäre eine Optimierer-
  Entscheidung — `guards.SurplusCharger`) und rührt §14a/EEG/SoC/Nennband nicht an.
- **Sofort verschärfen, langsam freigeben.** Verschärfen ist unbedingt; freigeben
  ist ratenbegrenzt (`ExportReleaseWindow` für den vollen Bereich), damit die
  Schleife nicht ihrer eigenen Stellbewegung (`WMaxLimPct_WinTms`) hinterherjagt.
  `Observe` meldet einen DRINGENDEN Messwert zurück, worauf `onLocalTelemetry`
  den Sollwert sofort neu veröffentlicht — der Executor hängt am Sollwert, und
  eine geänderte Kappe schreibt er ohne das 20-s-Auffrischfenster abzuwarten.
- **Was die Marge NICHT kann:** einen LASTSPRUNG abfangen. 11 kW Wallbox
  verschieben den Arbeitspunkt um 11 kW; das beantwortet nur die Reaktionszeit
  (ein Mess- + Schreibzyklus). Die Marge deckt Rauschen, Rampe und
  Register-Quantisierung. Der eigentliche Schutz zwischen zwei Messwerten ist,
  dass die Kappe IM Wechselrichter steht und dort laufend durchgesetzt wird.
- **Wirkungslosigkeit ist eine LAUTE Aussage, kein Detail** (`Effective`/`Reach`
  in `state.ExportGuardInfo`, gebildet in `agent.exportGuardInfo`): ohne
  abregelbare Einheit, mit Not-Aus oder ohne Freigabe wird die Kappe berechnet
  und NIRGENDWO geschrieben. Der Betreiber steht kurz davor, seinen eigenen
  Regler abzuklemmen — eine Wache, auf die man sich fälschlich verlässt, wäre
  gefährlicher als gar keine. Auch der TEIL-Fall (n von m freigegeben) wird
  genannt.
- **Der deutsche Satz wird EINMAL geschrieben** (im Guard, neben dem
  maschinenlesbaren `State` — das `target_verdict`-neben-`state`-Muster) und
  reist verbatim auf die `:8484`-Karte (PV-Abregelung, NORMAL-Modus) und in den
  Herzschlag (`curtailment.export_guard`). Zwei Renderings desselben Urteils
  könnten es sonst verschieden formulieren. Cloud-seitig braucht das KEINE
  Änderung (der api-Listener liest den Herzschlag als `JsonNode`); bekannte
  Grenze: der `curtailment`-Block wird nur bei ≥ 1 Einheit gesendet, der Fall
  „Grenze ohne abregelbares Gerät" steht deshalb lokal (Karte + Log), nicht in
  der Flottensicht.
- Beweise: `internal/guards/exportlimit_test.go` (abgestecktes Auto → Grenze hält
  ab dem nächsten Zyklus; Freigabe ratenbegrenzt + konvergent; Wolke ohne
  Überschwingen beim Aufreißen; Halten → Zusammenziehen → sichere Kappe, NIE
  Freigabe; jeder Zustand nennt seinen Grund), `internal/agent/export_limit_test.go`
  (Verdrahtung, Komposition in beide Richtungen, die vier Wirkungslos-Fälle,
  Herzschlag == Karte), `curtail-lease.e2e.test.js` EINSPEISE-WACHE (Zustellung
  an echte SunSpec-Register, Aufteilung, unfreigegebene Einheit).

## Der Edge rechnet NIE mit Preisen — er setzt die Preis-Entscheidung der Wolke durch (`guards.PriceTrimmer`)

Die preisbewusste Begrenzung innerhalb der Viertelstunde (2026-07-30, Captain-Beobachtung Pilsting) ist die dritte
ökonomische Schutzschicht neben `PeakShave` und den Compliance-Clamps — mit derselben Arbeitsteilung wie überall:
**die Wolke entscheidet, ob ein Slot teuer ist** (per-Slot-Flag `charge_from_surplus_only` im
mqtt-schedule-Contract; die Regel steht in `services/optimization/.../slot_trim.py`), **der Edge begrenzt nur**.
Volles Bild inkl. Ökonomie in der Root-AGENTS.md „Price-aware in-slot trim". Was hier gelten muss:

- **Reihenfolge:** `guards.PriceTrimmer.Apply` läuft in `applySetpoint` NACH `Clamp` und NACH dem
  Arbiter-Override, VOR `PeakShave` — beide sind restrict-only, also ist die Komposition ein Minimum.
  Der Trim braucht deshalb kein `Limits`: sein Ergebnis liegt strikt in `[0, kw]`.
- **Sicherheit per Algebra, nicht per Prüfung:** nach dem Trim ist die vorhergesagte Netzleistung
  `max(load − pv, 0) ≥ 0` — die Anlage wird nie in die Einspeisung gedrückt, also kann der §14a-EXPORT-Deckel
  (der `Clamp` sogar Ladeleistung ERHÖHEN darf) nicht verletzt werden, und der Import-Deckel galt für einen
  Wert, den der Trim nur weiter senkt. FK3 (Laden ≤ gemessene PV-PRODUKTION) bleibt die regulatorische
  Obergrenze und ist per Konstruktion lockerer als der Überschuss.
- **Ehrlichkeit:** unbekanntes pv/load ⇒ INAKTIV (nie blind regeln — die PeakShave-Konvention); Entladen und
  Ruhe sind unberührt; der Eigenverbrauchs-Rückfall IST der Überschuss, dort ist der Trim ein No-op.
- **Kein Zappeln, asymmetrisch:** Eingreifen sofort (eine durchziehende Wolke ist genau das, was nicht gekauft
  werden darf), Loslassen erst nach `TrimReleaseDwell` (90 s) ruhigem Unterschreiten; die angewandte Kappung
  folgt einem FALLENDEN Überschuss sofort, einem steigenden nur in `TrimStepKw`-Schritten.
- **Eine Begrenzung ist KEIN misslungener Schreibvorgang:** veröffentlicht wird der BEGRENZTE Wert, also passt
  der Register-Readback dazu und die entprellte Bestätigungslogik kann daraus nie „Sollwert nicht übernommen"
  machen. Sie wird als EIGENER Zustand gezeigt (`state.TrimInfo` → `control.js VPControl.deriveTrim` → die
  Begründungszeile `#ctrlReason` der Steuerungs-Karte, NORMAL-Modus) — eine unbenannte Begrenzung liest sich
  wie ein Defekt. Die per-Slot-Fahrplan-Begründung (Rollen, Wasserwert) bleibt bewusst in der WOLKE und wird
  vom Portal gerendert; auf `:8484` gibt es dafür keine zweite Erklär-Logik.
- Beweise: `guards/slottrim_test.go`, `agent/slot_trim_test.go`, `plan/plan_test.go` (nur ein explizites
  `true` trägt die Pflicht; die eingecheckten Contract-Fixtures werden per PFAD geparst),
  `web/jstest/ui.test.js`.

**Die ENTLADE-Seite derselben Lücke = `guards.LoadFollower` (`guards/loadfollow.go`, P1 der
Pilsting-Nachtanalyse `firstmate/data/vp-netzbezug-nacht-s3`; seit P1b BEIDSEITIG).** Der Sollwert
einer Viertelstunde stammt aus einer Viertelstunden-LASTPROGNOSE, also wird ihr Fehler am Netz
verrechnet — in BEIDE Richtungen, beide live gemessen am 30.07.: 21:22 Plan −4,332 kW gegen ein
7,117-kW-Haus → 2,79 kW zu ~32,5 ct GEKAUFT bei 77 % SoC (~4,9 € in EINER Nacht); 23:12 spiegelbildlich
Plan −6,7 kW gegen ein 5,1-kW-Haus → 1,4 kW zu ~21 ct VERSCHENKT, während dieselbe kWh später ~32,5 ct
wert war. Per-Slot-Flag **`cover_load_from_battery`**, Regel in `slot_trim.py`
(`import_price > lambda/eta + wear + margin`), eigener Kill-Switch `OPTIMIZER_LOAD_FOLLOW_ENABLED`.
**In einem Flag-Slot ist das Ziel `Entladung = max(load − pv, 0)`, also Netz ≈ 0** — anheben, wenn der
Plan zu wenig entlädt, begrenzen, wenn er zu viel entlädt. Was zusätzlich zum Trim gilt:

- **Die ANHEBE-Hälfte ist `PeakShave` mit Import-Ziel 0 plus Hysterese** — der Guard RUFT
  `PeakShave(kw, 0, …)` auf, statt die Schranken nachzubauen: Nennband, SoC-Boden und „senkt nur"
  kommen damit aus EINER bewiesenen Arithmetik.
- **Sicherheit per Algebra, EINE Invariante für beide Richtungen:** der Guard schiebt die
  vorhergesagte Netzleistung immer nur ZUM Nullpunkt HIN — nie darüber hinaus, nie weiter weg. Also
  nie Export (§14a-Exportgrenze/Einspeisedeckel unberührt) und nie mehr Import als das, was
  hereinkam (dafür galt der Import-Deckel schon). Wo er greift, hört die BATTERIE auf, am Netzpunkt
  mitzuwirken: exakt 0 bei Hausdefizit, sonst der verbleibende PV-Überschuss (den aufzunehmen wäre
  ein LADEN, also eine Preisentscheidung, die dieser Guard nie trifft).
- **Die BEGRENZEN-Hälfte braucht keine eigene Schranke:** sie verkleinert nur den Entlade-BETRAG
  (Nennband/SoC-Boden trivial erfüllt), rührt SoC-Decke und EEG-Solar-Clamp nicht an, hat einen
  HARTEN Boden bei 0 (nie ein Laden, nie ein Richtungswechsel — deckt PV die Last, geht der Sollwert
  auf 0) und kann den nachfolgenden Peak-Guard nicht aushebeln (sie landet bei Import 0 ≤ jeder
  Freigabe ≥ 0). Ein kommandiertes LADEN bleibt weiterhin unangetastet.
- **UNMARKIERTE Slots bleiben byte-identisch — in beiden Richtungen.** Die Unterscheidung
  „absichtlicher Handel vs. Prognose-Abweichung" trifft die WOLKE, nie der Edge: der Edge bekommt nur
  den Sollwert, nie die Prognose-Netzleistung des Plans. Deshalb markiert `slot_trim.py` seit P1b nur
  noch den echten „Netz ≈ 0"-Knick — **echte Entladung UND `|grid_kw| <= 0,05 kW`** —, also weder
  einen geplanten Kauf (Rolle `warten`) noch einen geplanten Verkauf (Rolle `verkaufen`, z. B. das
  ±30-kW-Fenster). Die Sicherheit hängt aber NICHT daran: ein Gerät an einer ÄLTEREN Wolke kann noch
  einen markierten Slot mit kleinem Export sehen — dort begrenzt der Guard, die Energie BLEIBT im
  Speicher (≥ Wasserwert) und wird vom nächsten 15-Minuten-Replan neu disponiert (begrenzte,
  selbstkorrigierende Verschiebung, anders als der unbepreiste Export, den die Korrektur verhindert).
- **Die Peak-RESERVE begrenzt nur das ANHEBEN** (`reserveSocPct` hebt den SoC-Boden): gewöhnliches
  Lastdecken ist genau das, was die Reserve überleben muss — dieselbe Regel wie im Rückfall-Pfad. Die
  Peak-VERTEIDIGUNG darf weiterhin darunter (sie läuft danach mit den unveränderten Limits). Das
  BEGRENZEN schont die Reserve ohnehin und wird von ihr nie gebremst.
- **Hysterese symmetrisch um das Netz-0-Ziel:** Eingreifen sofort in beide Richtungen
  (`|predicted| > FollowEngageMarginKw`), Loslassen erst, wenn der PLAN-EIGENE Wert das Defizit
  `FollowReleaseDwell` lang innerhalb der Marge trifft; ein Richtungswechsel behält den
  eingerasteten Zustand (eine Anlage, deren Last durch den Sollwert schwingt, zappelt nicht).
- **Bewusste Abweichung vom Trim: KEIN Schritt-Folger auf dem angewandten Wert.** Beide Richtungen
  sind hier Lastnachführung (Ziel = pv − load); ein gehaltener tieferer Entladewert bei
  SCHRUMPFENDEM Defizit IST genau das 23:12-Symptom. Die Schreib-Entprellung gehört in den
  Layer-1-Executor (`dwell_s`/`min_change`), nicht hierher.
- Anzeige: `state.FollowInfo` (mit `direction` = `deepen`|`reduce`) → `control.js
  VPControl.deriveFollow` → dieselbe `#ctrlReason`-Zeile, die die RICHTUNG benennt („… – Entladung
  angehoben" / „Folgt dem gemessenen Hausverbrauch … – Entladung begrenzt", jeweils mit der eigenen
  ehrlichen Ursache; Trim gewinnt, beide schließen sich per Konstruktion aus). Ein älteres Gerät ohne
  `direction` bekommt die neutrale Formulierung — nie eine Richtung behaupten, die nicht gemeldet
  wurde. Der VERÖFFENTLICHTE Wert ist der nachgeführte, also passt der Readback und die entprellte
  Bestätigung meldet auch bei einer BEGRENZUNG nie „nicht übernommen".
- Beweise: `guards/loadfollow_test.go` (u. a. „schiebt nur zum Nullpunkt hin", Begrenzen auf das
  gemessene Haus, Boden 0 statt Laden, unmarkierter Slot beidseitig unberührt, Reserve, Rated-Band,
  SoC-Boden, blind=inaktiv, Hysterese beidseitig, Richtungswechsel ohne Loslassen, Komposition mit
  dem Peak-Guard), `agent/load_follow_test.go` (inkl. der 23:12-Konstellation und der EINGECHECKTEN
  Contract-Bytes), `plan/plan_test.go`, `web/jstest/ui.test.js`,
  `services/optimization/tests/test_load_follow.py` (Regel + echter Solver: die Nacht-Slots werden
  markiert, die billigen Kauf-Stunden UND ein bewusster 28-kW-Export nicht — der Export-Fall ist
  bewusst NICHT vakuum: er belegt, dass genau diese `verkaufen`-Slots ökonomisch markiert WORDEN
  WÄREN, Setpoints byte-identisch).

**Und die Korrektur reist jetzt in die CLOUD (`cloud.ExecutionSummary`, Fahrplan-Konzept
`vp-fahrplan-kunde-konzept` §5, PR 3, 2026-08-02).** `FollowInfo`/`TrimInfo` lebten NUR auf der Box,
der Heartbeat trug sie nicht — das Portal sah also `commanded_kw` (den KORRIGIERTEN Wert) neben
einem Fahrplan-Balken mit einer anderen Zahl und konnte nur sagen, dass „irgendetwas angepasst"
wurde. `agent.executionSummary(snap)` faltet sie als additiven `execution`-Block IN die
`control`-Struktur des Heartbeats (Präzedenz: die `sources`/`flows`-Blöcke; `schema_version` bleibt
"1.0", MQTT-Kontrakte unberührt):

- `mode` = `plan` | `follow` | `trim` | `absorb` | `fallback`, dazu `direction` (`deepen`/`reduce`,
  NUR bei `follow`), `planned_kw` (der Sollwert VOR der Korrektur) und der GEMESSENE Wert, dem
  gefolgt wird (`deficit_kw` bei follow, `surplus_kw` bei trim UND absorb). Die Reihenfolge der
  Prüfung ist die UMGEKEHRTE Kette: `absorb` zuerst, weil es zuletzt läuft — wo es gegriffen hat,
  ist sein Wert der veröffentlichte. Ein Modus, den die Wolke nicht kennt, wird dort verworfen
  (der strikte Filter im `ControlStatusListener`), ein älteres Portal fällt also sauber auf seine
  generische Formulierung zurück.
- **Ein Modus, der nicht sauber auf das Vokabular passt, macht GAR KEINE Aussage:** nur
  `ModeSchedule` → `plan` und `ModeSelfConsume` → `fallback`; ein v2-Wunsch auf der Batterie
  (`ModeDesired`), eine Kalibrierung oder ein Gerät ohne Messwerte lassen den Block weg statt sich
  falsch zu etikettieren. Genau deshalb ist das top-level `control_source` NICHT das präzise Signal
  — es fasst all das zu `default` zusammen.
- Ein nicht gemessener Wert bleibt ABWESEND (nie eine erfundene 0); ohne Readback gibt es weiterhin
  gar keinen `control`-Block, der Vertrag für ein Gerät, das nichts bestätigt, ist byte-gleich.
- Beweise: `agent/execution_summary_test.go` (beide Richtungen mit den Live-Konstellationen 21:22 /
  23:12, Trim, plan-vs-fallback, unmapped-Modus ohne Aussage, `omitempty`-Drahtform).
  Cloud-Seite: api-Migration `V20260802000000` + `ControlStatusListener` + `ControlStatusDto`
  (siehe Root-`AGENTS.md` „Inverter control"), Portal: `control.ts executionNote`.

**Die LADESEITE, die ANHEBT = `guards.SurplusCharger` (`guards/surpluscharge.go`, Report
`firstmate/data/vp-pilsting-abregeln` §5b, 02.08.2026).** Trim senkt nur eine Ladung, der Follower
wirkt nur auf eine Entladung — einen NICHT PROGNOSTIZIERTEN PV-Überschuss konnte deshalb nichts in
den Speicher bringen. Genau das war das Geld des Vormittags in Pilsting: PV 23,9 · Haus 4,3 ·
**16,6 kW EINSPEISUNG bei negativem Preis**, stundenlang, bei **7 % SoC** — weil der Solver nur den
PROGNOSTIZIERTEN Überschuss lädt (`charge ≤ pv_forecast − curtail`) und es keinen Nowcast gibt, der
den laufenden Slot korrigiert. Per-Slot-Flag **`charge_surplus_to_battery`**, Regel in
`slot_trim.py` (`η·λ − wear > export_value + margin`), eigener Kill-Switch
`OPTIMIZER_SURPLUS_CHARGE_ENABLED`. Was hier gilt:

- **Es ist der EINZIGE Guard der Kette, der einen Sollwert ANHEBT** — und genau deshalb läuft sein
  Ziel noch einmal durch das autoritative `guards.Clamp` (Nennband, SoC-Decke, EEG-Solar-Clamp,
  §14a-Hülle), statt eigene Schranken nachzubauen (dieselbe Technik wie die ANHEBE-Hälfte des
  Followers, die `PeakShave` ruft). Er kann damit strukturell nicht an einem Guard vorbeischreiben
  und keinen aufweichen; er schlägt nur Werte vor, die die Kette schon akzeptiert hat.
- **Sicherheit per Algebra:** begrenzt auf den GEMESSENEN Überschuss ist die vorhergesagte
  Netzleistung `load + min(kw, Überschuss) − pv ≤ 0` — es entsteht also NIE ein zusätzlicher Import
  (§14a-Import und das Peak-Viertelstundenziel bleiben unberührt), und ein Export wird immer nur
  Richtung 0 verkleinert (§14a-Export und Einspeisedeckel erst recht erfüllt).
- **Nur ein NICHT-NEGATIVES Kommando wird angehoben** — nie ein Richtungswechsel aus einer Entladung
  heraus. Das ist zugleich, was ihn per Konstruktion vom Follower trennt.
- Unbekanntes pv/load ⇒ INAKTIV; der Eigenverbrauchs-Rückfall lädt ohnehin pv − load, dort ist er
  ein No-op. Hysterese gespiegelt zum Trim (sofort eingreifen, `AbsorbReleaseDwell` zum Loslassen;
  ein SCHRUMPFENDER Überschuss wird sofort, ein wachsender in `AbsorbStepKw`-Schritten gefolgt).
- Anzeige: `state.AbsorbInfo` → `control.js VPControl.deriveAbsorb` → dieselbe `#ctrlReason`-Zeile
  („Lädt den gemessenen Solarüberschuss … – Ladung angehoben"). Ein ANGEHOBENER Sollwert ist eine
  bewusste Nachführung: veröffentlicht wird der angehobene Wert, der Readback passt dazu.
- Beweise: `guards/surpluscharge_test.go` (Überschuss laden, nie ein Import, kein Richtungswechsel,
  SoC-Decke/Nennband/EEG-Clamp/§14a binden auf dem ANGEHOBENEN Wert, blind=inaktiv, Hysterese,
  Komposition mit dem Peak-Guard), `agent/surplus_charge_test.go` (die Live-Konstellation und die
  EINGECHECKTEN Contract-Bytes), `plan/plan_test.go`, `web/jstest/ui.test.js`,
  `services/optimization/tests/test_surplus_charge.py`. Die argumentierte Abweichung von der
  Report-Formel (ein geplanter IMPORT wird NICHT ausgeschlossen) steht in der Root-`AGENTS.md`
  „In-slot surplus absorption" und in der Docstring der Regel.

## Wer etwas ANDERES entwertet, nennt die Folge VORHER (`static/consequences.js`)

Die Nebenwirkungs-Regel des Settings-Umbaus (E3; Ist-Analyse
`firstmate/data/vp-settings-ux-konzept/report.md` §4 „Wunde 2"): ein Bedienelement,
das anderswo einen **freigegebenen, bestätigten oder aufgezeichneten** Zustand
entwertet, nennt genau diese Folge in seiner eigenen Rückfrage - vorher.
Ausgelöst hatte es die Kalibrier-Korrektur: „Steuer-Vorzeichen umkehren" nahm die
Steuerungs-Freigabe zurück (`agent/calibration.go CalibrationCorrection`:
`ResetConfirmations` + `delete(a.calCert, family)`), ohne es zu sagen - fachlich
richtig, denn nach einer Vorzeichenänderung ist der Beweis wertlos, aber der
Knopf sagte nur „umkehren", und ohne Freigabe steuert der Fahrplan diesen
Wechselrichter nicht mehr.

`static/consequences.js` (`window.VPConsequences`) ist die EINE, reine
Textschicht dafür (kein DOM, kein fetch, kein Zustand); `ask()` ist die einzige
Stelle, an der daraus eine Rückfrage wird (`window.confirm`, das Bestandsmuster
aus `sources.js`). Regeln, die halten müssen:

- **Kein Text ⇒ keine Rückfrage.** Entwertet eine Aktion nachweislich nichts,
  liefert der Builder `null` und die Aktion läuft byte-gleich wie vorher durch -
  ein Dialog ohne Folge wäre Lärm, einer mit erfundener Folge eine Lüge.
- **⚠ Die Freigabe hat ZWEI Hälften, und nur EINE wird zurückgenommen.**
  `Snapshot.Certified` ist die VEREINIGUNG aus der flottenweiten Allowlist
  (`VP_CONTROL_CERTIFIED_FAMILIES`, per Default `sunspec` - und `sunspec` IST
  kalibrierbar) und der auf diesem Gerät per First-Light erteilten Freigabe;
  Korrektur und „Freigabe zurücknehmen" entfernen nur die zweite. Jede Aussage
  über eine Rücknahme keyt deshalb auf das additive
  **`Snapshot.DeviceCertified`** (`json:"device_certified"`,
  `agent.deviceCertified`), nie auf `certified`. Live nachgemessen: mit gesetzter
  Allowlist blieb `certified` nach der Korrektur wahr - die erste Fassung des
  Dialogs hätte dort eine Rücknahme versprochen, die ausbleibt.
- **Zwei Wege an dieselben Werte.** Das Wechselrichter-Formular
  (`inverter.js`) bearbeitet Vorzeichen/Leistungsskalierung/Schreib-Funktionscode/
  Fernsteuerung ebenfalls - dort setzt der Server aber NICHTS zurück. Deshalb
  unterscheidet `inverterChange` ehrlich: Modellwechsel = die Freigabe gilt für
  das bisherige Modell (Fahrplan steuert nicht mehr), gleiche Familie mit
  geänderten Steuerwerten = die Freigabe BLEIBT, ihr Nachweis ist nur veraltet.
  Dass ein Familienwechsel die Freigabe nicht mitnimmt, ist eine Beobachtung
  über den Bestand, keine Änderung daran - Backend unangetastet.
- Weitere Aufrufer: `calibration.js` (drei Korrekturen + „Freigabe
  zurücknehmen"), `curtail.js` (Abregelungs-Freigabe je Einheit), `sources.js`
  (eine freigegebene Fronius-Quelle zu löschen beendet ihre Abregelung).
- **`consequences.js` muss VOR seinen Konsumenten geladen werden**
  (`einrichten.html`); `static/*` ist `//go:embed`-ed - Kern nach jeder Änderung
  neu bauen.
- Beweise: `internal/web/jstest/ui.test.js` (reine Texte inkl. der
  Zwei-Hälften-Regel PLUS ein Klick-Test gegen den ECHTEN `calibration.js`-Pfad:
  Abbrechen POSTet nichts, Bestätigen führt aus, nicht-entwertende Knöpfe fragen
  nie) und `internal/web` `TestDevaluingActionsAskBeforeActing` (Struktur-Wächter:
  Modul wird ausgeliefert, Ladereihenfolge stimmt, jede entwertende Aufrufstelle
  fragt). Gegen das echte Binary nachgemessen (Deye hybrid_3p, `:8484`):
  Allowlist-Freigabe → keine Behauptung; First-Light-Freigabe → Abbrechen ändert
  am Server nichts, Bestätigen kippt das Vorzeichen UND leert
  `calibration-certified.json`.

## Neutral-Zeit-Test: T wird MESSBAR statt behauptet (`internal/neutralcal`)

Bis hierher war die Inverter-Neutral-Zeit T (root `AGENTS.md` "OTA Stufe 3" §3,
`docs/ota-autonomie.md` §3) nur am Pruefstand mit physisch getrenntem Kabel zu
belegen. `internal/neutralcal` (rein, keine I/O - dieselbe Disziplin wie
`internal/calibration`/`internal/curtailcal`) macht T zu einer MESSBAREN
Eigenschaft, die die Box am `:8484`-Card „Neutral-Zeit messen" selbst
ermittelt: ein kleiner, klar von neutral abweichender Sollwert wird
geschrieben und bestaetigt (Register-Ruecklesung + gemessene Batterieleistung
zeigt die Abweichung), dann hoert die Box **bewusst auf zu schreiben** -
KEINE weitere Nachricht auf `edge/setpoint`, nicht einmal eine
Neutral-Freigabe - und der GEWOEHNLICHE Telemetrie-Lesepfad (unveraendert,
nichts wird gestoppt) beobachtet, wie lange es dauert, bis die gemessene
Batterieleistung von selbst - dreimal in Folge, frisch - ins Neutralband
zurueckkehrt.

- **Das Verdikt ist eines von vier, NIE eine erfundene Zahl:** `bestanden`
  (beide Haelften bewiesen - Register UND die Ruecklkehr), `nicht_beweisbar`
  (die Anlage hat sich nie messbar von neutral entfernt, z. B. SoC-Grenze -
  oder es fehlen Messwerte: eine Aussage ueber den LAUF, nie ueber T),
  `kein_nachweis` (Register nie bestaetigt, oder keine Rueckkehr im
  Zeitfenster - bitte wiederholen), `laeuft`.
- **T wird KONSERVATIV berichtet, nie optimistisch** (`measuredSeconds` in
  `neutralcal.go`): verankert auf den letzten Messwert, der NACHWEISLICH noch
  AUSSERHALB des Neutralbands lag, nie auf den ersten, der zufaellig schon
  eingeschwungen aussah - eine ueberschaetzte Zahl waere die gefaehrliche
  Richtung, denn die Wachhund-Frist (`otaapply.WatchdogDeadline`) muss strikt
  darunter bleiben.
- **Sicherheitsnetz:** `DepartureTimeout` (90 s) bindet die Schreibphase
  enger als die Gesamt-TTL (`DefaultTTL`, 6 min); ein `time.AfterFunc`-Wachhund
  (`agent/neutral.go`, analog `calWatchdog`/`curtailWatchdog`) nimmt die
  Steuerung unabhaengig vom Oberflaechen-Takt wieder auf; jederzeit per Knopf
  abbrechbar (`NeutralAbort`); ein laufender Test bricht SELBST ab, sobald
  eine EILIGE OTA-Aktualisierung die Anlage neutral parken will
  (`otaNeutralRequestPending`, sonst wuerde `otaNeutralOverride` bis zu 6 min
  verhungern) oder eine Kalibrierung startet (`neutralPreflight` refuses
  waehrend `a.cal.Engaged`). Derselbe `X-VP-Calibration-Token`-Gate wie
  Kalibrierung/Abregelung; die Guard-Kette (`guards.Clamp`) laeuft
  UNVERAENDERT ueber jeden geschriebenen Wert.
- **Ein bestandener Test traegt sich in `ota/neutral-verified.json` ein**
  (`otaapply.SaveNeutralRecord`, je Familie eine Zeile, Schema-versioniert wie
  `calibration-certified.json`). `otaapply.NeutralTable.ForWithMeasured`
  zieht ihn GLEICHWERTIG zu `VP_OTA_NEUTRAL_VERIFIED` heran - **die
  Umgebungsvariable gewinnt IMMER**, auch mit einer kleineren Zahl (ein
  Betreiber, der die konservative Pruefstands-Messung bereits gemacht hat,
  wird nie ueberstimmt); der Sidecar (`otaupdater.Engine.Tick`) laedt die
  Datei JEDEN Takt frisch (wie `CoreSignal`/`Autonomy`), weil der laufende
  Kern sie waehrend des Sidecar-Betriebs neu schreiben kann.
- **Wiring:** `neutralTestOverride` sitzt in `applySetpoint` NACH
  `calibrationOverride` und VOR `otaNeutralOverride` (dieselbe Prioritaet wie
  Kalibrierung: „ein First-Light-Test gewinnt"); `onLocalTelemetry` speist
  `neutralObserve` mit der gemessenen `battery_power_kw` (derselbe Wert, den
  `lastBattKw` fuer die Kalibrier-Gegenprobe haelt); `onControlReadback`
  routet einen Readback mit `source:"neutral_test"` in `NoteRegister` (ein
  neuer Discriminator neben `"calibration"`, nicht `"ota_neutral"`). Ein
  additiver `neutral_verified`-Block im Herzschlag (`cloud.UpdateSummary`,
  `agent.neutralVerifiedSummary`) traegt den Nachweis der AKTUELLEN Familie
  als reine TATSACHE mit - er entscheidet cloud-seitig nichts, die Torkette
  laeuft ausschliesslich auf dem Geraet.
- Beweise: `internal/neutralcal` (die Regel-Tests: Verdikte, Grenzfaelle,
  konservative Verankerung, Abort-Invarianz, TTL/Departure-Timeout-Grenzen),
  `internal/otaapply` (Vorrang der Env-Variable, Datei-Rundlauf, Schema-
  Versions-Ablehnung), `internal/otaupdater` (Sidecar-Ebene: der gemessene
  Nachweis oeffnet das Tor, eine kuerzere Env-Zahl gewinnt trotzdem, zu kurz/
  unlesbar/veraltete Version sperrt weiterhin), `internal/agent`
  (Override-Verdrahtung, Interlock, Record/Abort), `internal/web`
  (`/api/neutral/*`-Endpunkte + der Admin-Gate, Seiten-Struktur).

## Teil C: eine frische Installation bringt den Aktualisierer gleich mit

`install.sh`s `pull_and_up()` zieht und startet seit dieser Aenderung
IMMER mit `--profile ota` (`dc --profile ota pull core nodered updater` /
`dc --profile ota up -d`) - **nur das COMPOSE-PROFIL (Tor 1)**. Der
GERAETE-Schalter (`ota/autonomy.json`, Tor 2) bleibt bewusst bei seiner
Vorgabe AUS (`VP_OTA_AUTONOMOUS: ${VP_OTA_AUTONOMOUS:-false}` in
`generate_compose()` unveraendert) - eine frische Box beobachtet und meldet
also von Anfang an, wendet aber nichts an, bis ein Betreiber den Schalter
bewusst setzt. `update.sh` ist davon NICHT betroffen: seine eigene
`detect_ota_profile()` erkennt weiterhin den TATSAECHLICH laufenden Zustand
einer Bestandsbox und nimmt `--profile ota` nur auf, wenn der Sidecar dort
schon lief - eine vor dieser Aenderung installierte Box bekommt das neue
Verhalten also NICHT rueckwirkend durch ein blosses Update, nur eine neue
Installation. Der Schalter selbst ist jetzt zusaetzlich OHNE SHELL setzbar:
`:8484` → Einrichten → „Automatische Aktualisierung" (`GET`/`POST
/api/ota/autonomy`, hinter demselben `X-VP-Calibration-Token` wie jede
andere physische Steuer-Mutation - `agent.OtaSetAutonomy` schreibt
AUSSCHLIESSLICH die eine Datei, die der Sidecar ohnehin jeden Takt liest).
Beweise: `edge-app/test/install-selfcheck.sh` (docker-frei: die Pull-/Up-
Zeilen tragen `--profile ota`; die generierte Compose haelt
`VP_OTA_AUTONOMOUS` weiterhin bei `false`) + `internal/web`
(Admin-Gate + Seiten-Struktur fuer den Schalter).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
