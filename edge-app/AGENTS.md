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
- **The guided commissioning flow** (Einrichten, four steps ending at "Daten
  kommen an"; releasing CONTROL is deliberately its OWN block below it) is
  DERIVED from the existing APIs - no new endpoint, no persisted wizard
  progress. It recedes to one green line once all four are done.
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

- **Two paths, DETECTED not assumed.** `inverter-control-routing.js`
  `deyeCapabilityProbeSpec` (two FC3 READS: the LV/HV identity register `0x0000`
  + the block `0x044C..0x0461`) and `classifyDeyeCapability` decide; the
  EXECUTOR performs the probe, caches the verdict per logger in the VOLATILE
  flow context (`deyeCapabilityKey`, 6 h / 15 min on a transport error, so a
  restart re-checks) and the PLAN node reads it back. A Deye firmware update has
  removed remote mode from a user's inverter before and a later one restored it.
  Absent / all-zero / Modbus exception / the older V105.1 AC-side layout all fall
  back to the ToU path; `connection.remote_mode = 'off'` forces it.
- **The path INTERLOCK is the "never write into the void" rule:** the plan is
  built from whatever capability the plan node saw, so if the probe just changed
  the answer the executor writes NOTHING that tick and lets the next one re-plan.
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
