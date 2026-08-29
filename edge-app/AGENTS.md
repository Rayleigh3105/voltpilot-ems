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

## Verbrauchssteuerung Inkrement 6 (edge half): the deadline fallback

Full picture in the root AGENTS.md "Steuerbare Verbraucher - Inkrement 6".
What must hold HERE:

- **`internal/flexfallback` is the PURE half** (the otaapply/calibration
  discipline: every function takes `now`, no I/O) and **embeds Go tzdata**
  (`_ "time/tzdata"`) - the core's Alpine image ships NO zoneinfo, and the
  recurrence windows are wall-clock in the SITE timezone (E7, DST-correct;
  overnight windows anchor on the FROM day). Never move the window arithmetic
  onto the device clock's zone.
- **The trigger is a floor, not a scheduler:** `latestStart = deadline −
  remaining need − StartMargin` (one 15-min slot, the ONLY earliness ever
  taken). Refusal order is load-bearing: outside window → `plan_fresh` →
  `progress_unknown` → `fulfilled` → `not_yet_due`. Unknown progress (the
  entity's own telemetry stale/never, or no `power_kw` channel) starts
  NOTHING - kein erfundener Lauf; past the deadline the duty is honestly
  missed, never run outside its window.
- **Progress is a CONFIRMED lower bound** (`flexfallback.Tracker`): hold-last
  accrual from the entity's OWN measured `power_kw` at/above
  `RunThresholdKw` (10 % of run power, 50-W floor), gaps beyond
  `MaxSampleGap` accrue nothing (evidence, not extrapolation). Persisted
  throttled to `<data>/flexfallback.json` (agent/flexfallback.go) so a reboot
  keeps the day's accrued runtime/energy; a new instance key resets it.
- **The wish enters the NORMAL chain as class `deadline-fallback` (rank 50,
  D-20), NEVER override**, source kind `deadline-fallback` via
  `SubmitInternal` only - `desired.Parse` rejects both externally. Rank 50 is
  the seamless-takeover mechanism: a fresh plan's market desire (60) and a
  reactive Pflichtregel (flow override, 70) SUPERSEDE the fallback holder
  directly (no failsafe blip); a plain flow wish (40) does not outrank the
  due duty. Consumer clamp + cycle guard bind unchanged - a Mindestpause
  HOLDS the self-start with the honest `guard_min_off`.
- **Everything is gated on `VP_CONSUMER_CONTROL_ENABLED`** (default OFF):
  with the flag off there are no desires, no trackers, no file - pinned by
  `agent/flex_fallback_test.go TestFlagOffIsByteIdentical`. The heartbeat's
  consumers block reports a fallback run as `running_optimized` +
  `flex_deadline_fallback` (agent/consumers.go); the cloud listener and the
  portal map know the word.
- Proofs: `internal/flexfallback` units,
  `internal/desired/deadline_fallback_test.go`,
  `agent/flex_fallback_test.go`, rig C7 in `test/e2e-v2-compose.sh` (which
  also sets `VP_CONSUMER_CONTROL_ENABLED` in `test/docker-compose.e2e-v2.yml`).

## Verbrauchssteuerung Inkrement 4 (edge half): the generated reactive rule

Full picture in the root AGENTS.md "Steuerbare Verbraucher - Inkrement 4".
What must hold HERE:

- **`vp-palette/lib/reactive-eval.js` is the PURE evaluation engine** the
  generated `vp-consumer-policy` node (palette 0.5.0) consumes - Kleene
  3-state logic (`unknown` NEVER starts a consumer; a stale signal per its
  `max_age_s` is unknown, never 0), hysteresis via `reset_value`, off-delay
  debounce (ENDING only - starting is immediate and only ever from `true`),
  and precompiled UTC windows where AFTER the last window = unknown (an
  expired window never restarts a rule). Booleans ride entity telemetry as
  0/1 channels (`entitySignals` keeps only finite numbers - a boolean-typed
  JSON value is deliberately dropped, the compiler emits 0/1 leaves).
- **The node publishes, it never decides:** while the merged condition holds
  it renews a class-'flow' desired with the SHORT TTL the compiler validated
  (`renew_s <= ttl_s/2`, flowc-enforced), `override` stamped exactly from an
  ACTIVE must_run requirement; a telemetry-driven evaluation publishes only on
  CHANGE, the compiled interval trigger is the renewal cadence (so a 5-s
  telemetry loop cannot multiply the renewal rate). Withdrawal is the ABSENCE
  of renewal - desires are never retained, there is no release message to
  lose. The core's arbitration chain stays authoritative:
  `internal/desired/reactive_chain_test.go` pins that the override preempts
  the PLAN and never grid/contract, the 4-h cap end to end, and that the
  consumer clamp + cycle guard hold word for word on an override wish.
- **Rig C5** (`test/e2e-v2-compose.sh`): the flowc-compiled, origin-stamped
  reactive rule is deployed via the retained flows set; vehicle connect (a
  0/1 entity-telemetry channel) -> override desired -> the 22-kW wish lands
  CLAMPED at the 11-kW consumer band -> heartbeat reports the D9-HONEST
  `clamped`/`guard_rated_power` (the clamp outranks the run word in
  `agent/consumers.go`; the FORCED half shows as `holder:"flow"` in the same
  heartbeat's arbitration block - an unclamped forced run would read
  `running_forced`, the D8 trigger's §13.4 input, proven in the api trigger
  tests) -> disconnect -> off-delay -> withdrawal by TTL (retained clear).
  ⚠ Rig timing lesson (real flake, 2026-08-09): the
  SunSpec sim simulates a §14a dimming window for 30 s of every 120 s
  (wmaxLimPct 40 % -> grid limit 20 kW), so any battery-scenario probe whose
  exact write value the rig asserts must carry a TTL LONGER than one dimming
  window - otherwise the desire expires before the holder re-clamp ever
  writes the asserted value (the P2 probe now uses 65 s).

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
- **DER PICKER DER BOX: `static/vppicker.js` + `pickerregeln.js` + `vppicker.css`**
  (Welle 3 des Konzepts `data/vp-picker-system`, Captain: „alle Picker … eigene
  Komponenten erstellen wo man drin suchen kann. Ich will nichts
  Browser-Standard-Zeug."). Die leichtgewichtige Zwillings-Fassung des
  Portal-VpPicker: **kein React, keine Abhängigkeit** — die Box liefert
  `static/*` direkt aus `//go:embed` und hat keine Bau-Kette.
  - **Seit Welle 3 trägt KEINE `:8484`-Seite ein natives `<select>`** und kein
    Skript baut eines zur Laufzeit; der Wächter dafür ist der Testfall „Die
    Einrichten-Seite trägt KEIN natives Auswahlfeld mehr" in `jstest/ui.test.js`
    (mutationsgeprüft in beide Richtungen). Ersetzt sind: Marke
    (Wechselrichter-Formular), Marke + Modell (Quellen-Drawer), Testleistung
    (Kalibrierung) und JEDES Verbindungsfeld vom Katalog-Typ `select`.
  - **⚠ Die REGELN wohnen rein in `pickerregeln.js`** (`window.VPPickerRegeln`,
    das `VPModellSuche`/`VPControl`-Muster): Filtern, Gruppieren, die
    Tastatur-Arithmetik (`naechster`/`ersteAktive`/`tippSprung`) und die
    Ansage. „Der Eigenbau darf dem nativen Select in NICHTS nachstehen" ist nur
    prüfbar, wenn die Bewegung eine FUNKTION ist — deshalb ohne DOM.
  - **⚠ Die SUCH-TOLERANZ kommt aus `modellsuche.js`, nie ein zweites Mal.**
    Zwei Toleranzen auf einer Seite fänden dieselbe Eingabe verschieden. Die
    Suche blendet sich unter `SUCHE_AB` (8) Zeilen von selbst aus — darunter ist
    sie Ballast; darüber (die 47 Deye-Modelle) ist sie der Weg.
  - **⚠ Das Panel hängt an `document.body` mit FESTEN Koordinaten** (Kollisions-
    Umschlag nach oben, waagerecht geklemmt, `MIN_PANEL_PX` 240) — nie
    `absolute` im Feld: `.card`, `.drawer-body` und die Gruppen tragen Scroll-
    und Überlauf-Grenzen, dort wäre es abgeschnitten. `platziere` ist nach
    aussen gelegt, damit die Geometrie ohne Browser prüfbar ist.
  - **Am Telefon (≤ 640 px) ist es ein BOTTOM-SHEET** mit Verdunkelung, Griff
    und Wisch-Schliessen (`WISCH_ZU_PX` 90 — ein kurzer Zupfer schliesst NICHT,
    sonst fiele es bei jedem Scroll-Versuch zu), 52-px-Zeilen und 16-px-Suchfeld
    (kein iOS-Zoom).
  - **⚠ KEIN verstecktes natives Element als Krücke.** Der Wert wohnt im Griff
    (`.wert()`) und — für die Formular-Sammlung der Verbindungsfelder — im
    `data-value` des Wirts; `collect()` liest ihn dort statt aus `.value`.
  - **⚠ Ohne gesetzten Wert steht die ERSTE Zeile** (`ohneVorwahl: true` ist das
    ausdrückliche Opt-out): genau das tut ein `<select>`, sobald es seine
    Optionen bekommt, und `onBrandChange` fände sonst gar keine Marke.
  - **⚠ Die Beschriftung wird ERST beim Montieren verknüpft** (`labelEl` bzw.
    `labelledBy` → `label.htmlFor`). Ein `for` im Markup zeigte bis dahin ins
    Leere (Chrome: „Incorrect use of `<label for=…>`", Klick fokussiert nichts —
    dieselbe Falle wie im Portal-`VpPanel`), und die Beschriftung eines dynamisch
    gebauten Feldes hängt beim Montieren noch gar nicht im Dokument. Aus dem
    zweiten Grund werden die zwei Drawer-Picker SCHON BEIM LADEN gebaut, nicht
    erst beim Öffnen.
  - **⚠ Nicht zu verwechseln mit der always-open Modell-Liste** (`.picker*` in
    `inverter.css`, siehe den nächsten Punkt): die bleibt, was sie ist — der
    dauerhaft offene primäre Weg zum Modell. Beide teilen Tokens und Optik,
    nicht die Klassen (`.vpp*` gegen `.picker*`).
- **Die MODELL-SUCHE ist der PRIMÄRE Weg zum Wechselrichter** (Geräteseiten
  Stufe 2, Scout `data/vp-geraeteseite-rev-b8` NACHTRAG 5; die Regeln stehen in
  der Root-`AGENTS.md`). Ihre reine Hälfte ist `static/modellsuche.js`
  (`window.VPModellSuche`, das `VPControl`/`VPStatus`-Muster), `inverter.js`
  zeichnet nur.
  - **Sie sucht über ALLE Marken** und gruppiert nach Marke — wer den Namen vom
    Typenschild abtippt, muss die Katalog-Marke nicht raten („Fronius" oder
    „Fronius (Modbus / SunSpec)"?). Das Marken-Stufenmenü darüber BLEIBT der
    Stöber-Weg, und beide schöpfen aus demselben `GET /api/inverter`-Katalog.
  - **⚠ Ein Treffer einer ANDEREN Marke stellt erst die MARKE um, dann das
    Modell** (`waehleUeberMarken`): die Marke entscheidet Anbindung und
    Verbindungsfelder — ohne den ersten Schritt stünde unter dem gewählten
    Modell das Formular der vorigen Marke.
  - **⚠ Der frühere `SEARCH_THRESHOLD` ist ERSATZLOS entfallen** (Suchzeile erst
    ab 7 Modellen EINER Marke). Sie ist der primäre Weg, nicht die Hilfe für
    lange Listen; die Zeile steht immer.
  - **⚠ Verglichen wird normalisiert, hervorgehoben im ORIGINAL.** Der alte
    Filter verglich ROH und fand „sun 30k"/„sun30k" nicht, obwohl das Gerät im
    Katalog stand.
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
  → **Neutral** (hands control back, never a stuck forced current — the §4.2 `release`
  failsafe for native wallboxes); kill-switch off → **no writes, readback still runs**.
  Plus `evalReadback` (commanded-vs-actual match from `/api/status` frc/amp/psm;
  car/nrg[11]/acu/alw/pnp informational) and `makeExecutor(deps)` (the deps-injected
  HTTP set→readback loop, the `test-read.js makeReadOnce` pattern). Tests
  `goe/goe-control.test.js` (offline + in-process HTTP server: match/mismatch/unreachable/
  kill-switch).
- **⚠ `psm` (phaseSwitchMode: Auto=0/Force_1=1/Force_3=2) IS settable — the earlier
  "not a settable v2 key" claim was a DOCS-vs-REALITY gap** (corrected with the D4
  phase-switch build): psm is absent from the official `apikeys-en.md`, but evcc
  (`charger/go-e.go phases1p3p`: psm=1/2) and Home Assistant (`marq24/ha-goecharger-api2`
  Config filter) provably phase-switch go-e chargers with it, and the official docs
  DO document the surrounding machinery (`fsp` R/W, `mptwt`, `psh`, `pnp` R) - the
  ha-solarman/Victron secondary-source discipline. Whether a given model actually
  moves its contactor on psm stays VERIFY-on-device (CONTROL-BENCH.md → go-e).
- **D4 phase switching is a per-device CONFIG opt-in (`phase_switching`), never
  assumed.** The driver derives the two non-convex power ranges from the DEVICE's
  current band (`goe.Ranges`: 1p ≈1.38–3.68 / 3p ≈4.14–11.04 kW at 6–16 A @230 V),
  picks the range from the setpoint (a GAP wish snaps DOWN restrict-only - no value
  between the ranges ever reaches the device), and paces switches with the stateful
  **`goe.PhaseSwitcher`** (the CycleGuard pattern: 60 s dwell = the new desired range
  must be stable, 300 s minimum pause between switches - `phase_switch_dwell_s`/
  `phase_switch_pause_s`, conservative + config-adjustable, on TOP of the charger's
  own `mptwt`). A paced switch holds restrict-only in the ACTIVE range (1p: its max;
  3p below its min: Off) with the honest reason `guard_phase_switch` / "wartet -
  Phasenumschaltpause" - carried in the readback payload, the heartbeat consumers
  block (state `clamped`; the api listener + portal map know the word) and the plan
  fingerprint. UNKNOWN phase position (no readback yet) converts restrict-safe at 3
  phases and NEVER writes psm blind; the position adopts from the psm/pnp readback
  (psm Force_1/Force_3 outright, pnp while psm=Auto). A reboot forgets pacing state
  deliberately (a pause the switcher cannot know is not owed); a failed write never
  burns the pause budget (`NoteSwitchExecuted` only after a transport-error-free set).
- **The D11 self-service control check** rides "Verbindung testen": a go-e test with
  `control_test:true` (sources.js sets it for the go-e brand) makes the CORE re-write
  the charger's CURRENT `amp` value and read it back (`goe.ControlCheck` -
  non-disruptive by construction, a value-identical write; frc/psm NEVER touched;
  no amp readable → honestly "nicht prüfbar", never a guessed write). Result =
  `testconn.Result.ControlCheck`, rendered by verify.js ("Steuer-Schreibtest
  bestätigt"). Deliberately INDEPENDENT of the control flags - the wizard proves the
  write path BEFORE an operator arms them; a plain test (no flag) never writes.
- **The physical writer lives in the GO CORE** (`internal/goe` = the Go twin of
  goe-control.js, pinned to the SAME golden vectors `goe/goe-control-vectors.json` — the
  refCheckChar/EdgeRef + SocPlausible cross-language lockstep; `TestSharedVectors` on both
  sides). Chosen as the **single writer** (avoids a dual-writer on the same wallbox HTTP
  socket): the E2 arbiter already owns the clamped consumer command + the entity `Driver`
  block (go-e ip) + the readback plumbing, and go-e is HTTP-native. `agent/consumer_control.go`
  reads `arb.DecisionFor(id).Granted` for each go-e-backed wallbox entity (driver
  `communication:"goe_http_api"`), runs `goe.Execute`, and publishes `edge/entities/{id}/readback`
  (the v1 all_match shape the arbitration layer's `onEntityReadback` already folds into the
  heartbeat; a FAILED execute publishes its `error_code` in the payload - an honest status,
  never a silent success, and `confirmed` stays tri-state nil). **Gated on
  `VP_CONTROL_ENABLED` AND `VP_CONSUMER_CONTROL_ENABLED`: OFF (default) = ZERO HTTP** — a
  read-only deployment (the two live sites) is never touched, and with the flags off the
  whole driver incl. D4 is byte-identical inert. Periodic re-assert (60 s) so a rebooted
  wallbox re-adopts; change-detected so an unchanged command is not re-written every tick.
  Proof: `agent/consumer_control_test.go` (desired 22 kW → arbiter clamps to the 11 kW band
  → go-e set frc=On/amp=15 @ 3×230 → readback all_match on the bus; kill-switch-off = no HTTP;
  non-go-e entity skipped; the D4 scenario on a synthetic clock: unknown→readback→dwell
  hold→psm Force_3 lands→pause holds the down-switch at Off→psm Force_1 lands; gap wish
  never reaches the device; cycle-guard composition; failsafe release; named write error;
  consumer-flag-off byte-identical).
- **Node-RED is deliberately NOT the go-e writer** (single-writer). `goe-control.js` stays
  the canonical JS reference (embedding-ready) but is not embedded into a flow; `flows.json`
  is unchanged and `flows-sync.test.js` stays green. If the captain prefers a flow-side
  executor, embed `goe-control.js` via `build-flows.js` and retire the Go path — do not run
  both.
- **VERIFY-on-device** on the first real wallbox (frc/amp semantics + the REAL phase
  behaviour: contactor switch, vehicle re-negotiation, `mptwt` interplay) is the honest
  final step — see `nodered/CONTROL-BENCH.md` → "go-e Charger" (incl. the defined
  closure: the consumer-TYPE certification flip of `wallbox` in the api entitytypes
  catalog is a SEPARATE mini-PR after the captain's bench session, D11 — the type stays
  `simulator_only` until then; the EDGE control-family certification is orthogonal).
  Operator prerequisites (local HTTP API v2 on, fixed IP/mDNS, phase-capable models,
  config fields): `nodered/GOE.md`. Control safety: off by default, upstream guard
  authoritative (executor never widens the clamped setpoint; the arbiter's cycle guard
  composes upstream), fail-safe neutral/release, readback published.

## Shelly relay CONTROL driver (consumer, core-owned socket, dead-man timer)

The SECOND real consumer control path after go-e (D10; pilot: Heizstab hinter
Shelly). `internal/shelly` owns transport + mapping; `agent/shelly_control.go`
wires the executor pass (in the shared consumerControlLoop next to the go-e
pass), the SOURCE POLL and the D11 connection test. Operator doc:
`nodered/SHELLY.md`; bench: `nodered/CONTROL-BENCH.md` -> "Shelly". Rules that
must hold:

- **The CORE owns the WHOLE Shelly socket - single-writer across read AND
  write.** Unlike go-e (Node-RED reads, core writes - two stateless HTTP
  endpoints) the shelly dialect is STATEFUL (detected once, persisted), so
  source poll (`runShellySourcePass`, 30 s), connection test (`shellyTest`,
  in-process - never the Node-RED test-read round trip) and executor all live
  in the core. `sources.BusConfig` EXCLUDES shelly sources from the retained
  Node-RED config (a forwarded entry would only produce the sources store's
  permanent NICHT-VERDRAHTET warn); Node-RED must never grow a shelly reader
  without retiring the core paths.
- **Two generation dialects, DETECTED never configured** (`shelly.Detect`:
  GET /shelly answers unauthenticated on every gen - `gen`>=2 = the RPC
  dialect covering Gen2/3/4, `type` without `gen` = Gen1 REST). Persisted in
  `data_dir/shelly-devices.json` (schema-versioned store; a foreign-schema
  file is ignored wholesale). A dialect-level invalid_response DROPS the
  cached identity so the next pass re-detects exactly once (firmware/device
  swap self-heal, never a loop). A password-protected Shelly (Gen1 basic /
  Gen2 digest) is REFUSED with the honest German message - auth is
  deliberately unsupported in v1.
- **Metering is a DEVICE fact, never a model pick** (D3): Gen2 = `apower`
  present in Switch.GetStatus (the documented Plus1-vs-Plus1PM difference, the
  HA discipline); Gen1 = `meters[ch].is_valid` (aioshelly discipline,
  VERIFY-on-device). A metering readback publishes the measured power as
  per-entity telemetry (`edge/entities/{id}/telemetry`) - the normal E1b chain
  carries it into observed health, consumers actual_kw, the buffered v2 uplink
  and with it the fulfilment ledger's Stufe-2 (INTEGRATED) evidence. A
  non-metering Shelly NEVER publishes a power value (the ledger then honestly
  stays Stufe 3 "angenommen" = Nennleistung x Zeit); its source reading
  carries only the REAL fact `relay_on` (which is what keeps its freshness
  alive - `onSourceTelemetry` accepts it as a usable field).
- **The cloud capability hint rides `device_source_status.load_kw`:** the
  metering poll always publishes `load_kw` (real values incl. 0.0), the bare
  relay never does - so cloud-side `load_kw IS NOT NULL` = proven measurement,
  and `ConsumerService.create` derives `consumer_profile.confirmation_channel`
  from it on edge-source bind (`power_kw` = Stufe 2 / `relay_state` = Stufe 3 /
  unbound = NULL, Stufe 4). The portal's Ink1 rule (kWh goals only with
  measurement) keys on the echoed `confirmationChannel`
  (`consumers/questions.ts consumerHasMeasurement`, type-heuristic fallback
  for older rows - unknown is never "no").
- **THE §4.2 failsafe is `off` AND on-device:** every ON write carries the
  documented one-shot flip-back timer (Gen2 `toggle_after`, Gen1 `timer`;
  `DefaultOnTimerS` 180 s = 3x the 60-s re-assert that re-arms it; config
  `on_timer_s`, -1 disables with documented risk). Stop writing - edge dead,
  WLAN gone - and the relay falls off by itself: aufhoeren zu schreiben IST
  der Failsafe (the WMaxLimPct_RvrtTms discipline). Staleness additionally
  writes an ACTIVE off - deliberately NOT the go-e neutral (a relay has no own
  logic to release into). Timer fidelity per firmware is bench_pending.
- **Restrict-only on a bare setpoint:** a relay delivers 0 or RATED - a
  sub-rated setpoint (rated known via `rated_power_kw`) snaps DOWN to off with
  the honest reason; the sanctioned command paths for on_off consumers carry
  an explicit `on_off` anyway. The arbiter's consumer clamp + cycle guard bind
  UPSTREAM unchanged (the Mindestpause is the central protection of a heating
  rod).
- **D11 "Verbindung testen"** (`:8484` sources drawer, brand Shelly -
  `sources.js` sets `control_test` for every consumer brand): identify (gen +
  metering - the honest Stufe-2/3 consequence is named in the wizard via
  `verify.js shellyCapabilityLine`), read state, and the switch test ONLY
  while the relay is OFF (a value-identical off-write; a running heat cycle is
  NEVER interrupted - then read-only + `ControlCheck.Skipped` with the honest
  note). Independent of the control flags like the go-e check.
- **Golden vectors** `internal/shelly/testdata/shelly-control-vectors.json`
  pin PlanFor/SetURL/EvalReadback (Go-only today; a future JS twin must read
  the SAME file - the goe-control-vectors discipline).
- **Gates:** executor gated on `VP_CONTROL_ENABLED` AND
  `VP_CONSUMER_CONTROL_ENABLED` (both default OFF = zero HTTP + no state file,
  byte-identical); the TYPES heating-rod/generic-load stay `simulator_only` in
  the cloud catalog until the captain's bench session flips them (D11, its own
  mini-PR). The source poll is the READ path and runs regardless (like every
  other source reader) - adding the source is the opt-in.
- Proofs: `internal/shelly` units (vectors, both-gen stubs, auth refusal,
  controlcheck write-only-while-off, store round-trip),
  `agent/shelly_control_test.go` (plan slot -> executor -> HTTP -> readback ->
  confirmed over the REAL plan path; Stufe-2 power telemetry vs Stufe-3
  none; cycle-guard hold named in the consumers block; staleness failsafe
  off; dialect detected once across restart; flag-off byte-identical; source
  poll honesty; D11 via the real TestConnection dispatch), api
  `ConsumerApiTest.consumerCreationDerivesTheConfirmationChannelFromTheReportedSource`
  + `ConsumerRequirementLedgerWriterTest` (the D3 level mapping), portal
  `questions.test.ts` (consumerHasMeasurement).

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

## Probe-Kanal: eine Vorschau darf dem Poll nie den Socket wegnehmen (Stufe 0b)

Vollstaendiges Bild (Vertrag, api-Route, Regeln): root `AGENTS.md` „Probe-Kanal".
Was HIER gelten muss:

- **`internal/probe` ist die REINE Haelfte** (kein Socket, kein Bus, keine Uhr -
  jede zeitabhaengige Funktion nimmt `now`, das
  otaapply/calibration/curtailcal-Muster); `agent/probe.go` ist ausschliesslich
  die Verdrahtung. Wer eine Regel ergaenzt, ergaenzt sie dort - dann ist sie
  ohne einen einzigen Container pruefbar.
- **⚠ Der CORE oeffnet KEINEN eigenen Modbus-Socket.** Die Lesung geht ueber den
  lokalen Bus (`edge/probe/request|result`) an den Palette-Knoten
  `vp-modbus-probe`, weil dort `lib/modbus-conn.js` wohnt: EIN in-flight-Vorgang
  je (host, port) ueber ALLE vp-modbus-Knoten hinweg. Viele Kundengeraete
  (Solarman-Logger, billige Gateways) bedienen genau einen TCP-Client und
  verdraengen den laufenden - eine Vorschau mit eigener Verbindung waere also
  nicht „eine Lesung mehr", sondern der Abbruch des Polls genau des Geraets, auf
  das der Kunde gerade schaut. `TestProbeNeverDialsTheDeviceFromTheCore` haelt
  das an einem echten Listener fest, der NIE verbunden werden darf.
- **Der Knoten ist selbststaendig** (0 Ein-/Ausgaenge, keine Verdrahtung im Tab
  „Verbindung testen") und traegt KEINE eingebettete Kopie - anders als der
  test-read-Funktionsknoten gibt es hier also nichts, was driften koennte. Seine
  Ops laufen NACHEINANDER (sie zielen meist auf dasselbe Geraet; parallel liesse
  der Fehlschlag eines Schritts den seiner Nachbarn aussehen).
- **Die Fehler-Klassifikation keyt auf die GESCHLOSSENE Fehlermenge der zwei
  Module, die uns gehoeren** (`modbus-conn` + `parseReadResponse`) - nicht auf
  unscharfe Regex ueber errno-Texte. Wird eine dieser Meldungen umformuliert,
  faellt das in `probe_spec.js` auf, nicht beim Kunden.
- **Nur Lesen.** Der im Vertrag vorgesehene `switch_test` wird vom CORE mit
  `not_supported` abgelehnt und erreicht den Bus gar nicht - es gibt auf diesem
  Pfad keinen Schreibbefehl.
- Palette **0.6.0**. Die Version hebt nur an, was das Geraet MELDET, also
  erfuellt sie jede bestehende `min_palette_version` weiterhin; der Knoten ist
  kein flowc-Katalogtyp, es aendert sich also kein gepinnter Hash.

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

## Der Katalog hat DREI Dimensionen: Geraetetyp · Marke · Modell (und der WEG gehoert dem Modell)

Katalog-Neustruktur (Konzept `data/vp-anlegen-rework/konzept.md`, Stufe 1;
Captain-Entscheide 22.08.2026). Sie ist eine PRAESENTATIONS-Neuordnung: kein
Bestandsgeraet aendert Verhalten oder Identitaet.

- **⚠ DER VERBINDUNGSWEG IST EINE EIGENSCHAFT DES MODELLS, NIE DES MARKENNAMENS.**
  `Brand.Transports` sind die Wege einer Marke, `Model.Transports` die eines
  Geraets (erster = Vorgabe). Das loeste den zweiten Fronius-Eintrag auf: ein Eco
  27 spricht SunSpec Modbus, ein GEN24 die Solar API, und beide sind ein Fronius.
  **Die Familie folgt dabei dem WEG, wo das Modell keine eigene nennt**
  (Fronius/generisch: ein Decode-Profil je Weg); bei Deye/KOSTAL gehoert die
  Registerkarte dem Produkt, dort traegt `Model.Family` sie weiter. Ein gesetztes
  `Model.Family` auf einem Mehrweg-Modell machte den Ausweg still wirkungslos.
- **Der Experten-Ausweg ist `Connection.Transport`** - ein reines ANFRAGE-Feld:
  `Normalize` loest ihn zu `Selection.Communication` auf und LOESCHT ihn
  (die `Channel`-Regel an derselben Stelle). Er wird nie persistiert, nie
  veroeffentlicht und steht in keinem `BusPayload`; die Oberflaeche leitet ihn
  beim Wiederanzeigen aus `Selection.Communication` ab. Ein Weg, den das MODELL
  nicht nennt, ist eine Ablehnung, nie ein stiller Rueckfall.
- **⚠ ALIAS-EBENE: `Brand.Hidden` + `Brand.SupersededBy`.** Die frueher
  eigenstaendige Marke `fronius_sunspec` ist VERSTECKT und inhaltlich
  EINGEFROREN (`froniusSunspec*()`): sie wird nicht mehr angeboten, aber jede
  Nachfrage - `Normalize`, `Backfill`, `RatedKw`, der Vorlagen-Export und damit
  die cloud-seitige Aufloesung ueber Marke+Modell - beantwortet sie unveraendert.
  Daran haengen die zwei Fronius Eco der Anlage Herzogau. **Hier nichts
  „aufraeumen"**: jede Aenderung dort ist eine Aenderung an einer laufenden
  Kundenanlage. Der Beweis ist `catalog_struct_test.go`
  (`TestEveryLegacySelectionStillResolvesUnchanged` - das Muster aus PR 425).
- **`Brand.DeviceType`** (inverter · wallbox · switch, plus das reservierte
  Vokabular meter/charge_point/custom) ersetzt die Klammer-Kategorien in den
  Markennamen („go-e (Wallbox)"). Die Oberflaeche filtert damit je Rolle
  (`sources.js brandsForRole`), NICHT mehr an der Anbindung - eine Marke daran zu
  erkennen waere ab dem ersten Modell mit zweitem Weg falsch.
- **`resolveCatalog` fuellt die ABGELEITETEN Felder** (`Brand.Communication`/
  `CommLabel`/`Fields` spiegeln den Vorgabe-Transport; `Model.Fields` NUR bei
  mehreren Wegen, sonst blaehte die Kopie je Modell den Baum um ein Vielfaches
  auf). Die `:8484`-Seite hat dafuer die Zwillings-Helfer `transportsOf`/
  `transportOf`/`familyOf`/`fieldsFor` in `inverter.js` UND `sources.js` - **wer
  die Regeln in `inverter.go` aendert, aendert beide mit.**
- **⚠ Ein Wechsel des Verbindungswegs zeichnet das Formular NEU.** Die Felder
  haengen am WEG (Port 80 gegen 502, Unit-Id gegen keine); eine gemeinsame
  Feldmenge haette Vorgaben des falschen Wegs gezeigt. Ebenso ein MODELL-Wechsel.
- Beweise: `catalog_struct_test.go` (Typ-Dimension, EIN Fronius, Ausweg wirkt,
  Ausweg-Ablehnung, kein Auswahlfeld ohne Wahl, Duplikat-Fix, Kontinuitaet,
  Alias-Ebene, jeder Alias hat einen Nachfolger) · `inverter_test.go` ·
  `web/jstest/ui.test.js` (die versteckte Marke taucht in der Suche nie auf).

## ⚠ Wer `DefaultCatalog()` ändert, exportiert die Vorlagen neu

Seit Einheitsmodell Stufe 0a existiert der Geräte-Katalog ZUSÄTZLICH als
cloud-seitige Daten: `internal/inverter/templates.go` leitet aus
`DefaultCatalog()` eine Vorlage je Marke+Modell ab, und
`cmd/vp-template-export` schreibt sie in die eingecheckte Datei
`services/api/src/main/resources/componenttemplates/builtin.json`, aus der die
api ihr Vorlagen-Register füllt.

**Der Katalog hier bleibt die Wahrheit** (er entscheidet, was die Box wirklich
lesen kann) — die Datei ist nur seine Darstellung. Nach jedem Katalog-Edit:

```bash
(cd edge-app/core && go run ./cmd/vp-template-export)   # oder --check
```

`TestBuiltinTemplateExportMatchesTheCommittedFile` vergleicht Katalog und Datei
BYTEWEISE, ein vergessener Export ist also ein roter `go test ./...`-Lauf, kein
stiller Kunden-Defekt. Der Export ist deterministisch und trägt bewusst KEINEN
Zeitstempel — sonst wäre der Byte-Vergleich unmöglich. Details + die
Ehrlichkeitsregel (`channels`/`writes` sind `null`, nie `[]`, weil die Kanäle im
Decode-Profil und der Schreibweg im Steuer-Adapter wohnen) stehen in der
Wurzel-`AGENTS.md` unter „Einheitsmodell Stufe 0a".

## Eine Batterie OHNE gekoppeltes BMS: das SoC-Gate wird PRÄZISE, nicht weich

Live-Fall Mühlfeldweg 2 (21.08.2026): ein Deye-Hybrid mit Eigenbau-Batterie, deren
BMS nicht am Wechselrichter hängt. `0x024C` liest dauerhaft exakt 0, alles andere
(Spannung/Strom/Leistung/Temperatur) einwandfrei — `deye-decode.decode()` verwarf
damit JEDE Lesung, die Anlage blieb für immer stumm und war nicht anlegbar.

- **`decodeVerbose()` sagt jetzt, WAS es verworfen hat** (`drop = {channel, rule,
  raw, value}`), und `decode()` ist seine dünne Hülle. Die drei Regeln:
  **`no_answer`** (der ganze Messblock 0 = die dokumentierte Leerantwort des
  Loggers, der Juli-2026-Fall) · **`out_of_range`** (Wert ausserhalb (0,100] = ein
  kaputter/verschobener Rahmen) · **`missing`** (`blockAlive()`: irgendein
  Nicht-SoC-Register des Familien-Maps ist ungleich 0, UND der Ladestand liest
  exakt 0 = das BMS meldet nichts).
- **Nur `missing` ist übergehbar**, und nur mit dem Opt-in
  `connection.allow_missing_soc` — die Lesung wird dann OHNE `soc_pct` behalten,
  nie mit einer erfundenen 0, also bleibt der SoC-Achsen-Spike strukturell
  unmöglich. Die anderen zwei verwerfen weiterhin alles, **auch mit Opt-in**.
- **Seit dem 24.08.2026 kann derselbe Fall den Ladestand aus der GEMESSENEN
  Batteriespannung SCHÄTZEN** (`connection.soc_from_voltage = {v_empty, v_full}`,
  die zwei Eckpunkte aus dem Datenblatt; Register `0x024B` hybrid_3p mit der
  `[0,01/0,1]`-LV/HV-Skala, `0x00B7` hybrid_1p ×0,01 — der hybrid_3p-Leseblock ist
  dafür um EINE Adresse nach unten auf `0x024B..0x02C4` (122 Register) geweitet).
  Vier Regeln, alle mutationsgeprüft: nur bei `missing`, nie über einen echten
  BMS-Wert, auf **`[1,100]` geklemmt** (die exakte 0 ist die Leerantwort-Signatur,
  die beide Tore verwerfen — eine geschätzte 0 wäre unveröffentlichbar), und eine
  unlesbare/0-Spannung schätzt NICHTS.
  - **⚠ DIE SICHERHEITS-AUSSAGE: eine Schätzung schaltet NIE die Steuerung
    scharf.** Der Verbindungstest setzt das Opt-in nie (`test-read.js`) und meldet
    den fehlenden Kanal UNVERÄNDERT — er trägt die Schätzung nur additiv als
    `finding.estimate` daneben (Vertrag `mqtt-probe.schema.json`). Die Komponente
    braucht damit weiterhin die ausdrückliche Zustimmung, behält ihren
    `reading_override`-Stempel, und `ControlCertificationService.activate` lehnt
    unverändert ab: die SoC-Klemme von `guards.Clamp` läuft nie auf einer groben
    Schätzung (bei LiFePO4 ist die Kennlinie im mittleren Bereich fast flach).
  - **⚠ `blockAlive` urteilt bewusst NICHT über `battVolt`** — die
    no_answer/missing-Grenze bleibt exakt, was sie war (ein Nachtblock, dessen
    Leistungskanäle alle 0 sind, während der Pack Spannung hält, ist weiterhin die
    Leerantwort). Widerum eine Regel, die man beim Aufräumen zerstören würde.
  - **⚠ Die Zahlen-Grenzen leben DREIMAL** (api `SocFromVoltageBounds`, Box
    `inverter.SocFromVoltage.validate`, Portal `src/socSchaetzung.ts`) — das
    LAN-Regel-Muster. **Alle drei zusammen ändern.** Das Band ist bewusst weit
    (10..1000 V), weil weder api noch Box die Bauart besser kennen als der Kunde.
  - Eingetragen wird sie im PORTAL (Anlege-Assistent, im „Trotzdem
    fortfahren"-Kasten); auf `:8484` gibt es bewusst KEIN Feld dafür.
- **⚠ `blockAlive` urteilt NIE über das Identitäts-Register `0x0000`** — ein
  Logger kann es aus dem Cache beantworten, während der Messblock tot ist.
- **Der Weg des Flags** (ohne ihn wäre das Opt-in wirkungslos, weil das Gate im
  DECODER sitzt): Portal → `driver.connection` im Registry-Push →
  `inverter.Connection.AllowMissingSoc` → `Selection.BusPayload()` bzw.
  `sources.busEntry()` → `edge/inverter/config` → Router (`inverter-routing.js`,
  `build-flows.js`) → Decode-Config. `Normalize` LÖSCHT es für jeden anderen
  Transport an EINER Stelle (neben der `Channel`-Regel) — jeder andere Decoder
  lässt einen unplausiblen Kanal ohnehin weg, statt die Lesung zu verwerfen.
- **Der Verbindungstest wird ehrlich, nicht nachsichtig:** `test-read.js` gibt bei
  einem Drop `reading` (die übrigen Kanäle) UND `finding` zurück; der Kern reicht
  beides über `testconn.Result.Finding` in den Probe-Kanal
  (`probe.FailedReading`). Der TEST selbst setzt das Opt-in NIE — er sagt immer
  die Wahrheit, und ob sie hinnehmbar ist, entscheidet der Mensch im Portal.
- **⚠ Die BOX-OBERFLÄCHE zeigt den Befund seit dem 24.08.2026 auch** (Diagnose
  `vp-wr-eigenbau-soc-d4`): sie BERECHNETE die ganze Diagnose und lieferte sie
  über `POST /api/test-connection` aus — `verify.js` las im Fehlerzweig aber nur
  `error_code`+`message` und warf `reading` UND `finding` weg, also stand vor dem
  Installateur der feste, ursachenlose Zweizeiler „Verbindung ok, aber die Werte
  ergeben keinen Sinn. Bitte Modell/Anschluss prüfen." — im `missing`-Fall
  nachweislich FALSCH (Modell und Anschluss stimmen, das BMS fehlt). `verify.js`
  hat dafür die reine `VP.fehlerAnsicht(res)`: gelesene Werte (`readingChips`,
  dieselben Chips wie das Erfolgs-Panel) → benannter Befund (`befundText`) → der
  Weg (`portalWegText`).
- **⚠ ZWILLING: `verify.js befundText` ⟷ `frontend/portal/src/komponentenAssistent.ts
  regelText`** — dieselben Sätze, zwei Laufzeiten, KEIN geteilter Code (derselbe
  Mensch liest beide Flächen, derselbe Gerätezustand darf dort nicht anders
  heißen). **Beide zusammen ändern**; die Vektoren sind beidseitig gepinnt
  (`internal/web/jstest/ui.test.js` ⟷ `komponentenAssistent.test.ts`). Ein
  unbekanntes (Kanal, Regel)-Paar erzeugt KEINEN Satz.
- **⚠ Die Box VERWEIST, sie entscheidet nicht:** `portalWegText` gibt bei
  `rule === 'missing'` genau einen Satz („… im VoltPilot-Portal anlegen — nur
  lesend."), bei jeder anderen Regel NICHTS. Es gibt auf `:8484` weiterhin kein
  „Trotzdem fortfahren" und kein Setzen von `allow_missing_soc` — die
  Design-Grenze bleibt, nur ihre Unsichtbarkeit fällt weg.
- **Beweise:** `deye/deye-decode.test.js` · `flows-sync.test.js` (die INLINE-Kopie
  im Flow stimmt in allen drei Fällen mit dem Modul überein) ·
  `internal/probe` (Kontrakt-Fixture per PFAD) · `agent/testconn_test.go` ·
  `internal/web/jstest/ui.test.js` (die sechs Fälle der Fläche, mutationsgeprüft)
  · `internal/web/web_test.go` (//go:embed-Vertrag: die drei Anker reisen wirklich
  mit dem Binär).

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

## Die Signaturkette: das Geraet PRUEFT ein Release gegen seine eingebackene Wurzel

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


## Der Downlink: das Geraet EMPFAENGT sein Ziel (und wendet es seit 26.08.2026 selbst an)

`internal/otatarget` (rein: Umschlag parsen + ablegen) + `agent/ota_target.go`.
Cloud-Seite, Tabellen und Rollout-Logik: root `AGENTS.md` „Edge-Updates: EIN
Schritt"; Betreiber-Ablauf: `docs/ota-autonomie.md`. Was hier gelten muss:

- **Der Downlink ist ein TRANSPORTWEG, keine Autoritaet.** Die
  Vertrauensentscheidung faellt unveraendert auf dem Geraet gegen die
  EINGEBACKENE Wurzel (`internal/otaverify`, Stufe 1); die Cloud prueft die
  Signatur bewusst nicht. Der Umschlag ist UNSIGNIERT - `release`/`release_seq`
  sind Routing und Diagnose, und sobald ein Manifest geprueft ist, gewinnt
  AUSSCHLIESSLICH dieses.
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

## Das Geraet wendet SELBST an - ohne Tor, ohne Schalter, ohne Menschen

`internal/otaapply` (rein) + `internal/otaupdater` (Docker) + `cmd/vp-edge-updater`
(der Sidecar) + `agent/ota_autonomy.go` (die Kern-Haelfte). Vollstaendiges Bild
inkl. Betreiber-Ablauf: root `AGENTS.md` „Edge-Updates: EIN Schritt" und
[`docs/ota-autonomie.md`](../docs/ota-autonomie.md). Was HIER gelten muss:

- **⚠ Seit dem 26.08.2026 gibt es KEIN Tor mehr ueber den Zustand der Anlage.**
  Compose-Profil, Geraete-Schalter (`autonomy.json`/`VP_OTA_AUTONOMOUS`),
  Neutral-Zeit T, Interlock, Eil-Pfad und die Einmal-Freigabe sind ERSATZLOS
  entfallen (Code, nicht nur Vorgaben). Was ein Anwenden noch verhindern kann,
  sind ausschliesslich Eigenschaften des SIGNIERTEN Release - Kette,
  Anti-Rollback-Boden, `compat.backends`, `state_schema` - und die physische
  Plattengrenze. Das Sicherheits-Argument: der bis dahin gesegnete Handpfad
  `update.sh --from-target` tauscht **roh**, ohne Selbsttest und ohne Ruecknahme;
  der autonome Pfad ist strikt sicherer als das.
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
  Betreiber: `prune.json`). Alles tmp+rename. Der Sidecar hat kein Netz und
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
  **Die Selbsttest-Beobachtung ist DAUERHAFT, nicht nur ein Blick beim Boot:**
  der neue Core startet beim sequenziellen Tausch noch in `swap_core`, und bei
  einem reinen Node-RED-Update startet er gar nicht neu. `otaSelfTestLoop`
  wartet deshalb auf `self_test`, bindet sein Urteil an den weiterhin
  laufenden Token und prueft jeden Token hoechstens einmal.
- **Docker-Neustarts zaehlen nur SEIT diesem Vorgang.** `pending-confirm.json`
  traegt je Komponente `container_id` + absoluten Startwert. Solange die ID
  gleich ist, sieht der Wachhund die Differenz; ein neu angelegter Container
  beginnt mit seinem eigenen absoluten Zaehler. Ohne diese Baseline konnte ein
  alter `RestartCount >= 3` einen frischen Tausch vor dem ersten Swap
  zuruecknehmen. Alte Brotkrumen ohne das additive Feld behalten Frist,
  Running- und Healthcheck-Pruefung, loesen aber keinen historischen
  Crashloop-Fehlalarm aus.
- **Ist == Soll gewinnt vor den Apply-Toren.** Ein gueltig signiertes Release,
  das laut Build-Stempel bereits laeuft, bleibt `succeeded`, auch nachdem sein
  eigener `current.json`-Boden auf dieselbe Sequenz angehoben wurde. Backend,
  `min_from_seq` und Rueckschritt sind Tore fuer einen noch ausstehenden
  Tausch, nicht Gruende, einen bereits bewiesenen Stand im naechsten Takt als
  `politik` zu melden.
- **Was einmal zurueckgerollt wurde, laeuft nicht von selbst wieder an**
  (`failed.json`). Ohne das begann der naechste Takt denselben Tausch von vorn -
  die Zuweisung liegt ja noch. In der Fehlerinjektions-Matrix aufgefallen.
  **⚠ Seit dem Ein-Schritt-Umbau gilt die Sperre der ZUWEISUNG, nicht dem
  Release fuer immer:** eine NEUE Zuweisung - auch desselben Release - startet
  einen neuen Versuch (Blocker `zurueckgenommen`). Die Dauersperre war das eine
  Tor, das nur ueber eine Shell zu loesen war.
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
  einen Grund, der den HEBEL nennt (beim Plattenwaechter: aufraeumen bzw.
  `VP_OTA_DISK_GUARD_MB`). Beweise: `otaupdater/blocker_test.go`,
  `otaapply/decide_test.go`, `agent/ota_autonomy_test.go`; Betreiber-Sicht:
  `docs/ota-autonomie.md` §2.
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
    („Edge-Updates: EIN Schritt"), inklusive des Uebergangs fuer Baende ohne das Feld
    (`RolloutStates.BLOCKED_PREFIX` ist der gepinnte Zwilling von
    `otaapply.BlockedPrefix` - **beide zusammen aendern**).
- **Der Sidecar ist ein NORMALER Dienst** (kein Profil mehr), also nimmt
  `up -d --remove-orphans` ihn selbstverstaendlich mit. Genau das ist der Weg
  fuer Bestandsboxen: EIN `./update.sh` je Box holt ihn dauerhaft dazu.
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
    sicher ist. Betreiber-Handbuch: `docs/ota-autonomie.md` §4.
- Beweise: `internal/otaapply` (die Tore + Wiederaufnahme + Sequenz + Snapshot +
  Schalter + `prune_test.go`: die Regel inkl. Halter, Namensraum, Kulanz je
  Repository, alle Namen einer Kennung, Schalter-Vorzeichen), `internal/otaupdater`
  (die Orchestrierung gegen eine geschriebene docker-Welt; `prune_test.go`:
  Rueckfallebene ueberlebt, Ruecknahme raeumt nicht, vorab geholtes Ziel bleibt,
  ein Reinigungs-Fehlschlag kippt keinen bestaetigten Tausch),
  `agent/ota_autonomy_test.go` und die Matrix `test/ota-soak/run.sh` (10 Faelle gegen
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

## Die VERTRAUENS-IDENTITAET im Herzschlag

Additiv, ohne jeden neuen Wirkpfad zum Wechselrichter. Cloud-Seite + Portal:
root `AGENTS.md` „Edge-Updates: EIN Schritt"; Rotations-Drill:
[`docs/ota-signing.md`](../docs/ota-signing.md) §7.1.

- **Der Herzschlag traegt die Vertrauens-Identitaet** (`cloud.TrustSummary` im
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
- **⚠ ENTFALLEN am 26.08.2026: die Einmal-Freigabe.** Sowohl die
  `:8484`-Taste „Jetzt anwenden" (`agent/ota_apply.go`, `static/ota.js`) als
  auch ihr Portal-Zwilling (`agent/ota_apply_downlink.go`, Kontrakt
  `mqtt-ota-apply.schema.json`, Topic `v2/apply`) sind ERSATZLOS weg. Sie
  existierten nur, weil die Autonomie per Vorgabe AUS war; ohne dieses Tor
  haben sie keinen Gegenstand mehr. **Wer je wieder einen zweiten Weg zum
  Anwenden einzieht, muss jedes Tor ein zweites Mal absichern** - der Grund,
  aus dem es damals genau EINEN gemeinsamen Kern gab
  (`OtaRequestApplyWithToken`).

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

## Teil C: JEDE Installation bringt den Aktualisierer mit - ohne Flag

`install.sh`s `pull_and_up()` zieht und startet den ganzen Stapel
(`dc pull` / `dc up -d`) - der `updater` ist seit dem 26.08.2026 ein
GEWOEHNLICHER Dienst ohne Compose-Profil, also braucht es dafuer keine
Sonderbehandlung mehr. `update.sh` bringt ihn aus demselben Grund auf einer
BESTANDSBOX mit: `up -d --remove-orphans` startet ihn wie jeden anderen
Dienst. **Das ist der EINE Handgriff je Bestandsbox** (`cd <deploy-dir> &&
./update.sh`), danach nie wieder.

Der frueher noetige GERAETE-Schalter (`ota/autonomy.json`,
`VP_OTA_AUTONOMOUS`) und sein `:8484`-Knopf sind ERSATZLOS entfallen: es gibt
nichts mehr einzuschalten. Beweis: `edge-app/test/install-selfcheck.sh`
(docker-frei: die generierte Compose traegt GAR KEIN Profil und keinen
Autonomie-Schalter mehr, und `pull`/`up -d` laufen ohne `--profile`).


## Die Steuerungs-Zertifizierung hat jetzt DREI Quellen - die dritte ist die Plattform

`agent.controlCertified` (`internal/agent/calibration.go`) ist die EINE Stelle,
an der sie ODER-verknuepft werden:

  1. die flottenweite env-Allowlist (`config.ControlCertified`, auf die FAMILIE),
  2. die First-Light-Freigabe DIESER Box (`calibration-certified.json`, Familie),
  3. das PLATTFORM-Register (`internal/controlcert` + `agent/controlcert.go`,
     auf brand+MODELL - einmal am Pruefstand, danach flottenweit).

Weil sie ODER-verknuepft sind, kann Quelle 3 nur HINZUFUEGEN: eine Box mit
First-Light-Grant behaelt ihn auch bei leerem Register und bei retained-clear
(`agent/controlcert_test.go TestAPlatformDocumentNeverRemovesAnExistingLocalGrant`).
Volles Bild (Migration, Endpunkte, Portal): Root-`AGENTS.md`
„Steuerungs-Zertifizierung: das PLATTFORM-Register".

- **Die ENTSCHEIDUNG faellt hier, nicht in der Cloud.** Das retained Dokument auf
  `.../v2/control-certification` sagt, WELCHE Modelle gedeckt sind und ob DIESE
  Anlage scharfgeschaltet ist; `controlcert.Match` vergleicht das mit der
  EIGENEN Auswahl (brand + model + family, und - falls der Pruefstand sie nennt -
  die `invert_control_sign`-Konvention). Dieselbe Disziplin wie beim
  OTA-Sidecar, der dem Kern nichts glaubt.
- **⚠ Beides ist noetig:** `activated` allein steuert nichts, ein Register ohne
  Scharfschaltung auch nicht. Und ein SCHWESTER-Modell derselben Familie ist
  NICHT gedeckt - der Schluessel ist bewusst das Modell.
- **Vier Urteile, weil sie verschiedene Saetze sind** (`granted` ·
  `covered_not_activated` · `not_covered` · `unknown`). ⚠ `unknown` (kein
  Dokument, geloescht, unparsbar, kein Wechselrichter gewaehlt) darf NIE als
  „nicht zertifiziert" gelesen werden.
- **Fail-closed durchgehend:** unbekannte Vertragsversion, kaputtes JSON,
  unvollstaendige Identitaet und ein widersprochenes Vorzeichen geben NICHTS
  frei und protokollieren LAUT. Eine einzelne kaputte Registerzeile wird
  verworfen, nie das ganze Register.
- **Zustand + Bericht:** `platform-cert.json` im Datenverzeichnis (tmp+rename,
  damit eine offline bootende Box einen legitimen Grant behaelt, bis die
  retained Zustellung wieder konvergiert), `Snapshot.PlatformCert` +
  `Snapshot.ControlCertSource`, und im Herzschlag additiv
  `control.cert_source` + `control.platform_cert` - **aus dem KERN, nie aus
  einem Readback-Stempel** (die Regel, an der schon zwei Live-Defekte hingen).
  Ein Geraet ohne Dokument sendet den Block GAR NICHT.
- **⚠ Lock-Reihenfolge:** `invMu` (die Wechselrichter-Auswahl) wird IMMER vor
  `pcMu` genommen, nie umgekehrt - jede Funktion in `agent/controlcert.go` haelt
  sich daran.
- Ein Wechsel der Wechselrichter-Auswahl bewertet das Register neu
  (`refreshPlatformCertAfterSelectionChange`): das Register hat sich nicht
  geaendert, aber das, worauf es angewandt wird.
- Der proven Steuerpfad des Registers speist `device_certified_path`, wenn diese
  Box keine eigene First-Light-Evidenz hat - genau der Fakt, mit dem Layer 1
  seinen sticky Pfad-Entscheid vorsetzen will.

## Einheitsmodell Stufe 1: der Box-Applier — das Portal wird der SCHREIBER der lokalen Dateien

`internal/componentapply` (rein, keine I/O — jede zeitabhaengige Funktion nimmt `now`, das
otaapply/calibration/probe-Muster) + `agent/component_apply.go` (ausschliesslich Verdrahtung).
Cloud-Seite, Migration und die Autoritaets-Regel: Root-`AGENTS.md` „Einheitsmodell Stufe 1".
Was HIER gelten muss:

- **⚠ DER APPLIER GREIFT NUR AUF EINER PORTAL-VERWALTETEN ANLAGE.** `componentapply.IsPortalManaged`
  liest `registry.component_authority`, und **ABSENT heisst BOX** (`Authority`: alles, was nicht
  woertlich `portal` ist). Ein aelterer Cloud-Stand, ein Push ohne das Feld und jede Bestandsanlage
  laufen damit ZEICHENGLEICH wie vorher — festgenagelt von
  `TestABoxManagedPlantIsByteIdenticalUnderEveryPush` (keine Datei geschrieben, keine Auswahl
  geaendert, keine retained Veroeffentlichung).
- **NIE partiell anwenden.** `Derive` baut den GANZEN Plan (Wechselrichter + Quellen) und verweigert
  ihn als Ganzes bei zwei Wechselrichtern, doppelten deterministischen IDs oder einer unentscheidbaren
  Rolle; erst danach schreibt `writeComponentPlan` BEIDE Speicher, und erst danach wird retained
  veroeffentlicht. Ein halb angewandtes Soll waere ein Geraet, das gegen eine Konfiguration liest, die
  nirgends steht.
- **Ein leeres Soll ist KEIN Soll** (`ErrNoConfiguration`): ein Push ohne eine einzige
  `driver.connection` loescht nichts — er wird als „hier steht nichts zu tun" abgelehnt. Sonst nähme
  ein unvollstaendiger Push einer laufenden Anlage ihren Lesepfad.
- **Die angewandte Revision wird PROTOKOLLIERT** (`componentapply.Store` → `<data>/components-applied.json`,
  atomar tmp+rename, Schema-versioniert wie `calibration-certified.json`; ein Satz aus einer ZUKUENFTIGEN
  `StateVersion` wird ganz ignoriert). Sie ueberlebt Neustart und Cloud-Ausfall und reist im Herzschlag
  (`cloud.ComponentApplySummary`) — **eine Ablehnung steht NEBEN der angewandten Revision, nie an ihrer
  Stelle**: was laeuft, ist weiterhin die zuletzt wirklich angewandte Fassung.
- **Der lokale Bus ist UNVERAENDERT.** Geschrieben wird durch die BESTEHENDEN `invStore`/`srcStore` und
  `publishInverterConfig`/`publishSourcesConfig`; `edge/inverter/config`, `edge/sources/config`, das
  Self-Wiring und die Telemetrie sind byte-identisch — nur der SCHREIBER wechselt. `sources.DeterministicID`
  bleibt die Identitaet, damit die Uebernahme einer Bestandsbox (Stufe 2) ein No-op ist.
- **Auf einer portal-verwalteten Anlage lehnt `:8484` die lokale Bearbeitung ab** (`refuseIfPortalManaged`
  auf `SetInverter`/`AddSource`/`DeleteSource`/`RenameSource`, mit `portalManagedHint`) — **aber erst,
  nachdem wirklich ein Portal-Push angewandt wurde** (`PortalManagedComponents`), sonst haette eine
  frisch eingerichtete Box weder das eine noch das andere und stuende in einer Sackgasse.
- **`probe.OpTestConnection`** ist die Stufe-1-Erweiterung des Probe-Kanals: der Assistent testet eine
  NOCH NICHT gespeicherte Verbindung ueber dieselbe `Agent.TestConnection`-Maschinerie, die die
  `:8484`-Taste seit je benutzt — kein zweiter Test, der etwas anderes sagen koennte als das Geraet.
  Die vier Zulassungsregeln des Kanals (Identitaet, Verfall, privates Ziel, Ratenbegrenzung) gelten
  woertlich weiter.
- Beweise: `internal/componentapply` (19, inkl. der Kontrakt-Fixture per PFAD) ·
  `agent/component_apply_test.go` (8) · `agent/probe_test.go`.

## ⚠ Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben

Der Live-Defekt, der die Regel erzwungen hat (Anlage Pilsting/Herzogau, Update
edge-2026.08.5 -> .10): dieselben zwei Fronius lieferten weiter Messwerte, aber
ihre Komponenten im Portal lasen „nicht mehr mit einem gemeldeten Gerät
verbunden" und dieselben Wechselrichter meldeten sich daneben als „Neues Gerät
gefunden". Ursache war KEIN geänderter Fingerabdruck, sondern eine
Vergabe-Lücke:

- **`sources.DeterministicID` wurde ohne Migration eingeführt** (PR 270,
  29.07.2026) - bewusst, denn eine Migration hätte genau die Portal-Pins
  gerissen, die sie schützen sollte. Die Kennung wird ausschliesslich bei
  `AddSource` vergeben. **Jede vor diesem Tag eingerichtete Anlage trägt bis
  heute ZUFÄLLIGE Kennungen.**
- **`componentapply.Derive` leitete die Kennung dagegen jedes Mal neu ab** - und
  auf so einer Anlage kam eine ANDERE heraus. Die Bestands-Übernahme (Stufe 2)
  schrieb damit `sources.json` neu, veröffentlichte `edge/sources/config` neu und
  die Box meldete ab dem nächsten Herzschlag fremde Kennungen. Die Zusage „die
  Übernahme ist ein No-op" galt nur für Anlagen ab PR 270.

Die Regel: **`Derive` bekommt die LAUFENDE Geräteliste als Eingabe und behält
die Kennung jedes Geräts, dessen Transport-Identität sie wiedererkennt** - ganz
gleich, wie diese Kennung aussieht. Eine Kennung wird nur noch für ein Gerät
GEBILDET, das diese Box noch nie gefahren hat. Dazu gehört:

- **`sources.TransportIdentity` ist die EINE Stelle, an der „welches Gerät ist
  das?" beantwortet wird**; `DeterministicID` ist nur noch ihr Hash. Wer den
  Identitäts-Begriff ändert, ändert genau diese Funktion - beide Konsumenten
  ziehen mit.
- **Der Kollisions-Schutz keyt seither auf den FINGERABDRUCK, nicht auf die
  abgeleitete Kennung** („zwei Geräte mit derselben Verbindung"). Sonst könnten
  zwei Entitäten desselben Geräts über zwei geerbte Kennungen aneinander
  vorbeirutschen.
- **Mehrdeutigkeit wird nie geraten:** zwei laufende Quellen mit identischer
  Transport-Identität (nur über den lauten Kollisions-Fallback von `AddSource`
  möglich) übernehmen nichts - ausser die eine, die ohnehin schon die
  deterministische Kennung trägt.
- Cloud-Hälfte (die schon gerissenen Anlagen heilen sich selbst):
  root `AGENTS.md` „Die RE-PIN-BRÜCKE".
- Beweise: `componentapply/continuity_test.go` (die 08.5-Identität gegen das neue
  Schema, die zwei Einheiten hinter EINER IP, ein Rollenwechsel erbt nie,
  Mehrdeutigkeit) + `agent/component_continuity_test.go` (die ECHTE Übernahme
  schreibt `sources.json` byte-gleich nicht neu und wirft keine Messwerte weg) -
  beide mutationsgeprüft.

## Einheitsmodell Stufe 2: die Box MELDET ihre Verbindungen — und wird zum Spiegel

Cloud-Seite, Migration und die Uebernahme-Regeln: Root-`AGENTS.md`
„Einheitsmodell Stufe 2". Was HIER gelten muss:

- **`local_setup` traegt seit dieser Stufe die VERBINDUNG** (`agent.localSetupSummary`
  -> `cloud.LocalSetupEntry`, Vertrag `docs/contracts/v2/edge-entity-config.md` §5.1):
  `family`, `communication`, `connection` (VERBATIM als `json.RawMessage` — das
  `entities.Entity.Driver`-Muster, damit die Bytes unterwegs nicht umgeformt werden und
  ein neues Feld in `inverter.Connection` ohne zweite Zuordnungstabelle mitreist),
  `interval_s`, `capacity_kwp`, `registry_unit_id`. Das sind GENAU die Felder, die
  `sources.Source`/`inverter.Selection` speichern — weniger, und die Uebernahme waere
  kein No-op mehr.
- **Was die Box nicht hat, wird WEGGELASSEN** (`omitempty`), nie als 0/"" gesendet: nur so
  kann die Cloud „nicht gemeldet" von „ist 0" unterscheiden, und nur so heisst ein
  fehlendes `connection` „diese Box meldet noch keine Verbindungen" statt „dieses Geraet
  hat keine".
- **⚠ DER BEWEIS, dass die Uebernahme nichts aendert, lebt hier:**
  `agent/component_adopt_test.go` faehrt die ECHTE Kette
  `localSetupSummary -> (Cloud-Treiberblock) -> componentapply.Derive -> Plan.SameAs`
  an einer Pilsting-artigen Anlage. `SameAs` ist eine STRUKTURGLEICHHEIT ueber ALLE
  Felder — wer `componentapply.Driver`, `sources.Source` oder `inverter.Connection`
  erweitert, muss das neue Feld auch MELDEN und PUSHEN, sonst faellt der Beweis um (er
  ist mutationsgeprueft).
- **`componentapply.Driver` traegt jetzt `registry_unit_id`** und `Derive` reicht es an
  `sources.Normalize` weiter — ohne das verloere eine Uebernahme die MaStR-Referenz des
  Betreibers beim ersten Rueckschreiben.
- **`:8484` ist auf einer portal-verwalteten Anlage ein read-only SPIEGEL.** Bis Stufe 1
  lehnte nur die API ab (`refuseIfPortalManaged`) und die Seite bot die Knoepfe weiter an
  — ein Klick lief in eine Ablehnung. Jetzt tragen `/api/inverter` und `/api/sources`
  additiv `portal_managed` (aus `InverterController.PortalManagedComponents`), und
  `VP.setPortalManaged` blendet JEDE mit `data-vp-edit` markierte Bedienung aus und zeigt
  EINEN ruhigen Satz. **Gesperrt wird ausschliesslich das AENDERN** — Sehen, „Verbindung
  testen", Koppeln, Netzwerk, Steuerungs-Freigabe, Not-Aus, Modbus-Spiegel und
  Messwert-Aufbereitung bleiben lokal und unberuehrt (§4.3). Ein neuer Bearbeiten-Knopf in
  der Anlage-Karte braucht `data-vp-edit`, sonst ueberlebt er die Uebernahme sichtbar.
- `static/*` ist `//go:embed`-ed — Kern nach jeder Aenderung neu bauen.
- Beweise: `agent/component_adopt_test.go` (6) · `internal/web` (`portal_managed` +
  Spiegel-Struktur) · `internal/web/jstest/ui.test.js` (4 reine Faelle).

## ⚠ Ein SELBSTBAU-Gerät darf den Registry-Push nie scheitern lassen (Einheitsmodell Stufe 3)

`componentapply.Derive` ist alles-oder-nichts, und `roleFor` kennt den Typ
`modbus-generic` nicht. Ohne einen ausdrücklichen Skip hätte **EIN** vom Kunden
selbst definiertes Modbus-Gerät den GANZEN Push scheitern lassen — die Anlage
verlöre also mit ihrem ersten eigenen Gerät die Anwendung ihres Wechselrichters
und aller Quellen. Der Skip sitzt deshalb in `ParseDriver`, **vor** der
Marken-Prüfung (ein Selbstbau-Gerät trägt per Konstruktion keine Marke), und
liefert `ok=false` = „dieses Gerät liest diese Box nicht" — dieselbe Semantik wie
beim Vor-Stufe-1-Treiber ohne Verbindung.

- `componentapply.CommunicationSelfBuild` (`modbus_baukasten`) ist wörtlich mit
  der Cloud geteilt (`SelfBuildDefinition.COMMUNICATION`) — **beide zusammen
  ändern**, sonst beginnt die Box Pushes abzulehnen, die sie ignorieren sollte.
- Sein LESEPLAN reist im FLOW, nicht in `sources.json`: je Kanal ein
  `vp-modbus-read`, das seine Telemetrie selbst je Entität publiziert. Der
  `driver`-Block trägt hier nur Anzeige/Kontext.
- Eine Anlage mit AUSSCHLIESSLICH Selbstbau-Geräten ergibt `ErrNoConfiguration` —
  der dokumentierte „leeres Soll löscht nichts"-Fall, kein Fehler des Kunden.
- **Der Palette-Knoten prüft die LAN-Regel unabhängig noch einmal**
  (`vp-palette/lib/private-host.js`, verdrahtet in `vp-modbus-read.js`): ein
  ausgerollter Flow ist eine Anweisung von aussen, und wer eine Verbindung
  öffnet, prüft ihr Ziel selbst (die OTA-Sidecar-Disziplin). Ein nicht
  nachweisbar privates Ziel wird gar nicht erst angeklopft — der Knoten liest
  NICHTS und sagt laut warum. Es ist der vierte Zwilling derselben Regel; alle
  vier lesen `docs/contracts/lan-host-vectors.json`.
- Beweise: `componentapply_test.go` (der Skip rettet Wechselrichter + Quellen,
  „nur Selbstbau ⇒ ErrNoConfiguration"), `vp-palette/test/private_host_spec.js`.

## Der SCHALT-Test und der Schalt-Executor (Einheitsmodell Stufe 4)

Der Weg, auf dem ein selbst gebautes Modbus-Gerät schaltbar wird. Die Regeln, die Verträge und die
Portal-Seite stehen in der Root-`AGENTS.md`; hier nur, was am Gerät gilt.

- **⚠ DIE REIHENFOLGE IST DIE SICHERHEIT: `agent/switchtest.go` armiert das automatische Aus, BEVOR
  es schreibt** (`armSwitchWatchdog` → `switchExchange`), nicht nachdem der Schreibvorgang gelungen
  ist — das Kalibrier-Muster `time.AfterFunc`. Daraus folgt die Regel, die man beim Aufräumen
  zerstören würde: **ein FEHLGESCHLAGENER Test behält seinen armierten Wachhund**, denn der
  Schreibvorgang kann angekommen sein und nur seine Antwort verloren haben. Ein `switch_cancel`
  entwaffnet ihn und schreibt den Sicherheitswert sofort — und **er trägt das Register vollständig
  mit**, statt sich auf einen gemerkten Zustand der Box zu verlassen (ein Neustart darf einen
  Abbruch nicht verschlucken).
- **Der Core öffnet KEINEN Modbus-Socket** — auch hier nicht. Der Test reist über ein EIGENES
  Bus-Topic-Paar `edge/switch/request|result` zum Palette-Knoten `vp-modbus-switch-test`; das
  Lese-Paar der Vorschau (`edge/probe/*`, `vp-modbus-probe`) bleibt damit per KONSTRUKTION
  schreibfrei, statt per Konvention. Gepinnt von `TestProbeNeverDialsTheDeviceFromTheCore`.
- **Ein Socket, eine Warteschlange:** Test-Knoten UND Executor schreiben über `lib/modbus-conn.js`
  (neu `writeValue`/`readCoils` neben `readRegisters`), also durch dieselbe in-flight-Sperre je
  (host, port) wie jeder Lesevorgang. Nie ein zweiter TCP-Pfad zum selben Gerät.
- **Der Anlagen-Not-Aus erreicht Node-RED über `edge/control/gate`** (retained, vom Kern
  veröffentlicht: `VP_CONTROL_ENABLED ∧ VP_CONSUMER_CONTROL_ENABLED`). Er ist ein EIGENES Topic,
  weil das `control_enabled` des Entitäts-Kommandos die WECHSELRICHTER-Zertifizierung trägt und
  hier die falsche Frage beantwortet. Der Executor ist fail-closed: ohne Dokument schreibt er nicht.
- **Der Executor `vp-modbus-switch` ist GENERIERT und schreibt nur Freigegebenes:** Ein/Aus nur die
  zwei Konstanten, Sollwert nur innerhalb der Klemme — und **der Sicherheitswert wird NICHT ins
  Betriebsband geklemmt** (`safeValue` nutzt `rawOf`, nicht `toRaw`), sonst würde aus „aus" ein
  „lauf langsam weiter". Er re-assertiert im 60-s-Takt und schreibt bei Kommando-Rückzug oder
  Staleness (180 s) AKTIV den Aus-/Sicherheitswert; das optionale Watchdog-Register des Geräts
  bedient er im selben Takt. Readback publiziert er selbst auf `edge/entities/{id}/readback` im
  v1-all_match-Format (**nicht mit `vp-control-readback` verwechseln** — das bedient den
  Primär-Wechselrichter).
- **Eine Spule ist das EINE Modbus-Objekt, dessen Drahtform nicht ihr Wert ist** (`0xFF00` = EIN):
  `buildWriteCoilRequest` nimmt deshalb einen BOOLEAN. FC16 ist die Vorauswahl fürs Register, nicht
  FC6 (die Fronius-/Deye-Lektion).
- **Beweise:** `internal/probe` (Zulassung erbt jede Lese-Regel + FC↔Registerart, Spulen-Werte 0/1,
  TTL-Grenzen) · `agent/switchtest.go`-Fälle · Palette `test/switch_spec.js` (die GETEILTE
  Warteschlange gegen ein in-process-Gateway; „ein Gerät, das den Schreibvorgang schluckt, fällt am
  Rücklesen auf, nicht am Echo") · `modbus-tcp` Coil-Frames.

## Die Einspeisegrenze IM GERÄT wird GELESEN — höchstens einmal am Tag, auf dem BESTEHENDEN Leseplan

„Grenzen & Wächter" Stufe 0 / Vierer #4 (Cloud-Seite + Feldnamen: Root-`AGENTS.md`;
Anlass: Herzogau Runde 2 §3 K1 — der Deye hielt 33,0 kW in `0x00E7`, während im
Portal 70 kW hinterlegt waren, und das war zwei Untersuchungsrunden lang
unsichtbar, weil niemand das Register las). Was hier gelten muss:

- **⚠ EIN SOCKET-GESETZ, und deshalb hat dieser Pfad KEINE eigene I/O.** Der
  Router (`nodered/inverter-routing.js` `DEYE_EXPORT_LIMIT` /
  `shouldReadExportLimit`, verdrahtet im `auto-router`-Knoten) hängt das Register
  als EINEN zusätzlichen FC3-Umlauf an den vorhandenen Leseplan — dieselbe
  Disziplin wie die gelernten Spiegel-Blöcke (höchstens einer je Zyklus, NACH den
  Primärblöcken, innerhalb derselben sv5-Sperre, die Steuer-Schreibvorgängen
  weicht). Der Wert kommt in der retained `edge/registers/raw` an, die der Poll
  ohnehin veröffentlicht; `agent/exportlimit.go` ist damit nur ein weiterer LESER
  von Bytes, die schon auf dem Bus lagen — kein neuer TCP-Pfad, kein neues
  Bus-Topic, kein neuer Palette-Knoten, kein Extra-Takt.
- **⚠ Die REGISTERKARTE ist ein cross-side Zwilling:** `DEYE_EXPORT_LIMIT` (JS,
  baut den Leseplan) ⟷ `inverter.exportLimitRegisters` (Go, DEKODIERT das Wort).
  Adresse UND Skala müssen übereinstimmen, sonst ist die Kundenzahl 10x falsch;
  `TestExportLimitRegisterMatchesTheNodeRedTable` liest die JS-Datei per PFAD und
  vergleicht. **Beide zusammen ändern.** Der Router bekommt die Tabelle beim
  Generieren aus dem Modul eingesetzt (`build-flows.js` `require`t es), damit die
  inline Kopie nicht driften kann.
- **⚠ `hybrid_1p` wird AUSDRÜCKLICH nicht gelesen — das ist die Ehrlichkeitsregel
  des Features, keine Auslassung.** Dort IST die Einspeisegrenze „Max Sell Power"
  (`0x00F5`), das Register, das unser EIGENER Entlade-Hebel schreibt
  (`inverter-control-routing.js` `DEYE_CONTROL_REG.hybrid_1p`); es zurückzulesen
  hieße, unseren Befehl als „Grenze des Geräts" zu melden. Eine Familie, die wir
  nicht ehrlich lesen können, meldet NICHTS, und jede Fläche sagt dann
  „unbekannt".
- **Der Zeitstempel wird beim VERSUCH gesetzt** (der Router sieht das Ergebnis
  nicht) — ein Fehlschlag wird morgen erneut versucht, die Lastgarantie bleibt
  „ein Umlauf pro Tag". Ein Node-RED-Neustart leert den Flow-Kontext, nach jedem
  Neustart kommt also ein frischer Wert; eine RÜCKWÄRTS gesprungene Uhr (ein Pi
  ohne gepufferte Uhr beim ersten NTP-Abgleich) sperrt die Lesung nicht aus.
- **Was NICHTS liest, behauptet NICHTS** (`agent.noteDeviceExportLimit` → `nil`):
  keine Auswahl, eine Familie ohne belastbares Register, ein Block mit
  Lesefehler, ein Block von einem ANDEREN Slave, oder das Register war in diesem
  Zyklus gar nicht dabei (der Normalfall). `nil` heißt „wir wissen es nicht", nie
  „das Gerät hat keine Grenze" — und der VORHERIGE Wert bleibt stehen. Ein
  gelesenes **0 kW ist ein WERT** („darf gar nicht einspeisen"), keine Lücke.
- **Anzeige:** `Snapshot.DeviceExportLimit` → additiv im `curtailment`-Block des
  Herzschlags (mit EIGENEM `device_export_limit_read_at` — `checked_at` ist der
  Rücklese-Stempel der Abregel-Einheiten und wäre hier eine falsche
  Frischezusage) und als Zeile auf der PV-Abregelungs-Karte
  (`control.js VPControl.deriveDeviceExportLimit`; die AUSSAGE steht immer, das
  REGISTER ist der Beleg und bleibt Technikmodus). `static/*` ist
  `//go:embed`-ed — Kern nach jeder Änderung neu bauen.
- Beweise: `internal/inverter/exportlimit_test.go` · `internal/agent/device_export_limit_test.go`
  (die Herzogau-Lesung durch den ECHTEN Bus-Handler + jede Schweige-Regel) ·
  `nodered/mirror-poll.e2e.test.js` (echter Solarman-Logger: der Umlauf findet
  statt, byte-getreu, und nur täglich) · `inverter-routing.test.js` /
  `flows-sync.test.js` · `internal/web/jstest/ui.test.js` + `web_test.go`.

## Der EINE Fernschreibpfad auf ein Installateur-Register: `0x00E7`

Die Einspeisegrenze, die der Wechselrichter SELBST hält („Grid Max Export
power", dez. 231, Skala ×10 → W), ist aus der Ferne anhebbar - und sonst
nichts. Anlass ist Herzogau: 33,0 kW im Gerät gegen 70 kW im Portal, und das
Anheben kostete einen Vor-Ort-Termin. Betreiber-Ablauf + curl-Beispiele:
[`nodered/DEYE.md`](nodered/DEYE.md) „Einspeisegrenze aus der Ferne anheben".

- **⚠ DREI SCHICHTEN, und die Trennung IST das Design** (Portal-Konzept
  `vp-reg-schreib-konzept-p8` §1.1): **POLITIK** = `installerwrite.Admit`
  (Allowlist, Wertgrenze, Zwei-Stufen-Bestätigung) → **MECHANISMUS** =
  `Agent.WriteOnce(Target, AdmittedWrite)`, trigger-agnostisch: lesen,
  höchstens EINMAL schreiben, zurücklesen, `{before, after, adopted}` melden →
  **TRIGGER** = heute der `:8484`-Adapter `Agent.InstallerWrite`. Ein späterer
  Portal-Downlink ist ein ZWEITER ADAPTER neben `InstallerWrite`, kein Umbau:
  er ruft dieselbe Politik und denselben Mechanismus. `WriteOnce` kennt weder
  Allowlist noch HTTP noch das Protokoll.
- **Der enge Umfang bleibt am LOKALEN Trigger.** `installerwrite.AdmittedWrite`
  hat ausschließlich unexportierte Felder; `Admit` baut für die `:8484`-Taste
  weiterhin nur `0x00E7` mit dem 7000er-Deckel. Der gemeinsame
  Node-RED-Transport `vp-installer-write-request` darf diese enge Regel aber
  NICHT noch einmal anwenden: seit Stufe 2 fährt auch der bereits über
  `AdmitExpert` geprüfte freie PORTAL-Umfang über denselben Solarman-Socket.
  Dort wird deshalb nur die gemeinsame 16-Bit-Holding-FORM nachgeprüft.
- **⚠ Die Familien-Allowlist ist die READ-seitige Ehrlichkeitstabelle**
  (`inverter.ExportLimitRegisterFor`), bewusst KEINE neue: dort ist schon
  kodiert, dass `0x00E7` nur auf `hybrid_3p` eine EIGENSTÄNDIGE Grenze ist,
  während auf `hybrid_1p` die Einspeisegrenze `0x00F5` IST - das Register, das
  unser EIGENER Entlade-Hebel schreibt. Eine Familie, die wir nicht ehrlich
  LESEN dürfen, dürfen wir erst recht nicht SCHREIBEN.
- **Ein Socket, wie überall.** Der Kern öffnet nichts: die Anfrage reist über
  `edge/installer-write/request` (nicht retained) in den **`tab-auto`**-Tab und
  teilt sich dort die Flow-Kontext-Sperre `sv5_busy:`/`sv5_write_want:` mit Poll
  und Steuer-Executor. **Der Knoten MUSS in diesem Tab liegen** - Node-REDs
  `flow`-Kontext ist PRO TAB, ein Knoten anderswo hätte seine EIGENE Sperre und
  damit einen ZWEITEN TCP-Client auf einem Logger, der genau einen bedient.
  Belegter Logger ⇒ `busy`, nichts geschrieben - verschieben, nicht drängeln.
- **Genau EIN Versuch je Bestätigung.** Kein Retry, kein Auffrischen: `0x00E7`
  liegt im EEPROM. Eine verlorene Antwort ist `write_unconfirmed` („kann
  angekommen sein"), nie ein zweiter Schreibvorgang hinter dem Rücken des
  Betreibers. Der Einmal-Wächter (`installerBusy`) sitzt im MECHANISMUS, weil er
  das GERÄT schützt und nicht den Trigger.
- **FC16, nicht FC6** - dieselbe gemessene Deye-Lektion wie im Steuerpfad
  (`resolveDeyeWriteFc`); `control_write_fc: 6` schaltet zurück.
- **Die optionale Vorbedingung `expected_before` wird AUF DEM GERÄT geprüft**,
  innerhalb derselben Socket-Sitzung, die auch liest und schreibt - im Kern
  geprüft wäre es ein Lesen, ein Zurückgeben und ein zweites Beanspruchen, also
  genau das Fenster, in das ein anderer Schreiber schlüpft.
  **⚠ Das Sentinel heißt `vpCode`/`vpMsg`, NICHT `code`:** ein Node-Socket-Fehler
  trägt bereits `err.code` (`ECONNREFUSED`), und der wäre sonst als
  `error_code` an den Kunden durchgereicht worden (im e2e aufgefallen).
- **`before`/`after` sind ZEIGER, durch alle Schichten** (Bus, Ergebnis,
  Protokoll, HTTP): „nicht gelesen" und „als 0 gelesen" sind verschiedene
  Tatsachen, und 0 ist ein WERT dieses Registers („darf gar nicht einspeisen").
- **Das Audit-Protokoll überlebt den Neustart** (`<data>/installer-write.json`,
  tmp+rename, gedeckelt, neueste zuerst) und zeichnet **jeden bestätigten
  Versuch** auf - auch Fehlschlag und Nicht-Übernahme, denn genau das ist der
  Eintrag, den eine spätere Untersuchung braucht. Ein Probelauf wird NICHT
  protokolliert (es gibt kein „nachher", und ein Log der Lesevorgänge begrübe
  die Schreibvorgänge).
- **⚠ ES GIBT KEIN FEATURE-FLAG MEHR (Captain-Korrektur 20.08.2026, D2
  KORRIGIERT).** `VP_INSTALLER_WRITE_ENABLED` ist ERSATZLOS entfallen - im
  Go-Core, in BEIDEN Composes und in `install.sh`: der Einmal-Schreibpfad ist
  auf **jeder** Box verfügbar, für BEIDE Türen, ohne Armierung und ohne
  `404`-Zustand. Das Flag gehörte zur Canary-Phase (der Portal-Konsument
  existiert ohnehin erst ab dem Kunden-Release) und war nie das, was den Pfad
  sicher macht. **Unverändert tragen ihn die INHALTLICHEN Tore:** die
  Zwei-Schritt-Strecke (Probelauf → wörtliche Bestätigung), `expected_before`,
  die Einmaligkeit, die Register-Allowlist + Wertgrenze bzw. die Lane-Politik
  des Portal-Wegs (Wertgrenzen, Selbstkonflikt-Sperre, LAN-only), das
  **Betreiber-Kennwort** am lokalen Schreib-Aufruf (`calGuard`,
  `X-VP-Calibration-Token`; die Nur-Lese-Sicht bleibt offen wie
  `GET /api/calibration`), Identität + `requested_at`-Fenster + RLS/JWT auf dem
  Portal-Weg, das Box-Audit + der D6-Uplink - und der **Cloud-Not-Aus der
  Plattform** (`voltpilot.register-write.enabled` am api) als Betriebs-Notbremse,
  die mit deutschem Grund refüsiert statt zu schweigen.
- **⚠ `gate_disabled` bleibt trotzdem im KONTRAKT** (`error_code`-Enum,
  `registerwrite.ErrGateDisabled`) und in der Cloud-Whitelist: eine Box mit
  ÄLTEREM Image kann das Wort noch senden, und die Cloud muss es weiter
  verstehen. Kein aktueller Build erzeugt es.
- **Eine bestätigte Rücklesung frischt `Snapshot.DeviceExportLimit` auf** -
  dasselbe Feld, das sonst der tägliche Lesevorgang füllt (EINE Wahrheit über
  die Grenze des Geräts, aufgefrischt von dem, der zuletzt gelesen hat).
- **Der Datenspiegel auf `:502` ist unberührt** und bleibt strukturell nur
  lesend (`MODBUS-SPIEGEL.md`): dieser Pfad läuft NICHT über ihn.
- Beweise: `internal/installerwrite` (Politik + Protokoll, u. a. „nur `Admit`
  baut einen `AdmittedWrite`") · `agent/installerwrite_test.go` (Probelauf vs.
  Bestätigung, GENAU ein Versuch, Nicht-Übernahme, stilles Gerät, gesperrte
  Familie erreicht den Bus nie, Einmal-Wächter, `WriteOnce` ist
  trigger-agnostisch und protokolliert NICHTS, veraltete Vorbedingung) ·
  `internal/web` (die Routen existieren OHNE Armierung, Kennwort-Tor,
  Fehler-Abbildung) · `internal/config` (es gibt keinen Umgebungs-Schalter mehr:
  jeder Wert lässt die Konfiguration byte-gleich) ·
  `nodered/inverter-control-routing.test.js` +
  `flows-sync.test.js` (die eingebettete Kopie == das Modul, Adresse/Obergrenze
  gepinnt, gleicher Tab wie der Poll) · `nodered/deye-control.e2e.test.js`
  (echter In-Process-Solarman-Logger: Probelauf schreibt nichts, die Bestätigung
  landet EINMAL als FC16 und liest 70,0 kW zurück, verschluckter Schreibvorgang,
  Ablehnungen ohne Geräte-Kontakt, belegter Socket, unerreichbar, veraltete
  Vorbedingung) · `vp-palette/test/nodes_spec.js`.

## Der EINE Wechselrichter-Socket hat seit dem 20.08.2026 eine WARTESCHLANGE

`edge-app/nodered/bus-arbitration.js` (rein, unit-getestet) ist die Quelle der
Schluessel und der Zeitfenster; die drei Knoten des Tabs „Wechselrichter
(automatisch)" tragen sie als Literale und `flows-sync.test.js` pinnt sie gegen
das Modul. Der Anlass ist ein Produktionsvorfall (Anlage Pilsting/Herzogau, Box
edge-45gz7da, 20:08-20:10Z): eine Einmal-LESUNG aus dem Portal verhungerte am
Bus, der Kern gab nach 30 s auf und die Cloud meldete `timeout` auf einer
kerngesunden Anlage. Drei Befunde, alle reproduziert:

1. **EINE Absichts-Fahne fuer ZWEI Schreiber.** Steuer-Executor und
   Einmal-Auftrag benutzten beide `sv5_write_want:`; der Steuer-Executor setzt
   sie am Ende JEDER Runde (und beim Verschieben) auf 0 - und loeschte damit die
   Absicht eines noch WARTENDEN Einmal-Auftrags. Der Lese-Poll, der genau auf
   diese Fahne zuruecktritt, nahm sich den Socket danach wieder.
2. **Keine UEBERGABE.** Wer freigab, entliess den Socket ins Rennen: der
   naechste Inject-Takt (Lesen 5 s, Steuern ~10 s) prueft EINMAL synchron und
   greift zu, waehrend ein Wartender nur alle 300 ms nachsah. Es gab keine
   Reihenfolge und damit keine endliche Zusage.
3. **⚠ DIE ZEITFENSTER-KETTE WAR GERISSEN.** Der Einmal-Knoten durfte 12 s
   warten UND danach 25 s am Socket verbringen - zusammen 37 s, waehrend der
   Kern nach 30 s aufgibt. Seine spaetere, korrekte Antwort fiel in einen
   laengst vergessenen Wartenden.

**Die Regel, in einem Satz:** ein Einmal-Auftrag RESERVIERT den Bus
(`sv5_oneshot:<host:port>`, EIGENER Schluessel - kein anderer Schreiber fasst
ihn an); wer den Socket haelt, UEBERGIBT ihn beim Beenden an diese Reservierung
(`sv5_grant:`); Lese-Poll und Steuer-Executor behandeln die Uebergabe wie
„belegt" und warten sie AB. Damit steht zwischen einem Einmal-Auftrag und seinem
Slot HOECHSTENS EINE laufende Socket-Runde.

- **⚠ STEUER-VORRANG BLEIBT DAS PRINZIP.** Eine Reservierung bricht NIE eine
  laufende Steuerrunde ab und weist NIE einen Steuer-Schreibvorgang zurueck; der
  Steuer-Executor wartet eine Uebergabe innerhalb seines EIGENEN, unveraenderten
  Budgets ab (9 s / 14 s calibration) und verschiebt im schlimmsten Fall einen
  Takt - genau das, was er heute schon tut, wenn der Lese-Poll den Socket haelt.
- **Der Lese-Poll tritt fuer eine Reservierung zurueck, aber GEBUNDEN**
  (`ONESHOT_READ_YIELD_TICKS`, 6 × 5 s = 30 s ≥ dem ganzen Worst Case eines
  Einmal-Auftrags): er erzwingt also nie mitten in einem legitimen Auftrag, und
  eine haengende Reservierung kann die Telemetrie trotzdem nicht aushungern (das
  Erzwingen bleibt hoerbar).
- **Reservierung und Uebergabe VERFALLEN** (20 s bzw. 5 s); die Reservierung
  wird bei jedem Wartetakt aufgefrischt, gilt also genau so lange, wie wirklich
  gewartet wird. Ein abgestuerzter Auftrag kann den Bus nie festhalten.
- **⚠ Die drei Zahlen sind eine KETTE**
  (`ONESHOT_ACQUIRE_MS + ONESHOT_SOCKET_MS ≤ installerWriteTimeout <
  voltpilot.register-write.read-timeout`, heute 15 s + 12 s ≤ 30 s < PT40S) und
  `ONESHOT_ACQUIRE_MS > CONTROL_SOCKET_MS`, damit der Auftrag EINE volle
  Steuerrunde ueberdauern kann. Gepinnt in `flows-sync.test.js` („die
  Zeitfenster-Kette", liest die Go-Datei per PFAD),
  `agent.TestTheCoreOutwaitsTheNodesOwnBudget` und - fuer die Cloud-Haelfte -
  `RegisterWriteBudgetTest`.
- **Der lokale `:8484`-Weg und der Portal-Downlink teilen sich das alles**: sie
  rufen denselben `Agent.WriteOnce` und damit denselben Knoten. Der Vormittag
  war nur deshalb schnell, weil die Anlage damals NICHT steuerte - der
  Unterschied war die LAST, nie der Ausloeser.
- **Eine verspaetete Antwort wird BENANNT** (`onInstallerWriteResult` warnt bei
  einer Antwort ohne Wartenden), sonst ist aus dem Geraeteprotokoll allein „zu
  spaet" nicht von „nie geantwortet" zu unterscheiden.
- **⚠ Der Timeout-Satz folgt dem MODUS.** `Agent.WriteOnce` weiß über
  `AdmittedWrite.Apply()`, ob der Auftrag nur las oder wirklich schrieb: beim
  Probelauf ist „Es wurde nichts geschrieben“ belegbar, beim Schreibauftrag
  bleibt der Zustand unbekannt. Den alten, mode-blinden Satz („nicht sicher, ob
  geschrieben wurde“) auch bei einer Lesung zu zeigen, war eine falsche
  Gerätewirkung und wird von
  `TestASilentDeviceGetsModeSpecificHonestFailureAndOnlyWritesAreAudited`
  verhindert.
- Beweise: `bus-arbitration.test.js` (die reinen Regeln) · `flows-sync.test.js`
  (die drei Knoten sprechen EINE Warteschlangen-Sprache, die Kette, der
  gebundene Rueckzug) · `deye-control.e2e.test.js` („EINMAL-LESUNG UNTER
  STEUERLAST" - Lese-Poll und Steuer-Executor takten ohne Pause gegen einen
  Ein-Klient-Logger, die Lesung kommt trotzdem durch; die zwei BEFUND-Tests und
  „eine TOTE Reservierung kann den Bus nicht festhalten"). Der Lasttest FAELLT
  auf dem alten Stand mit `busy` nach 12 s um - er ist der Repro, nicht nur die
  Zusage.

## ⚠ Ein ANGENOMMENER Register-Auftrag endet IMMER mit genau EINEM Ergebnis

Derselbe Vorfall, zweiter Befund: fuer einen angenommenen Auftrag
(491de871…, 20:08:55Z) stand im Protokoll eine „Auftrag angenommen"-Zeile und
danach NICHTS. Aus der Cloud ist das ununterscheidbar von „die Box hat den
Auftrag nie bekommen". `agent.runRegisterWrite` ist seither eine HUELLE
(`answer`-Closure + `defer` mit `recover`), die drei Faelle abdeckt, die ein
neuer Zweig sonst still wieder aufreissen koennte: ein `return` ohne Antwort,
ein doppeltes Antworten (der Kontrakt kennt GENAU EIN Ergebnis je `request_id`)
und ein PANIC. Die Ausfuehrung selbst wohnt in `executeRegisterWrite`, die
Test-Naht ist die Paket-Variable `registerExecute` (das
`installerWriteTimeout`/`registerWriteWindow`-Muster).

**⚠ Der PANIC wird bewusst aufgefangen** - eine Abwaegung, keine Bequemlichkeit:
ohne `recover` risse ein Panic in dieser Goroutine den GANZEN Edge-Kern einer
Kundenanlage mit sich (Telemetrie, Fahrplan-Ausfuehrung, Schutzgrenzen), wegen
eines Register-Vorschau-Klicks. Er wird deshalb LAUT protokolliert (ERROR mit
dem Panic-Wert) und ehrlich quittiert (`MsgCrashed`), statt verschluckt zu
werden. Beweis: `agent.TestAnAcceptedOrderAlwaysEndsWithExactlyOneReceipt`
(mutationsgeprueft).

## Der ZWEITE Trigger auf denselben Einmal-Schreib-Kern: der Portal-Downlink

`internal/registerwrite` (rein) + `agent/register_write.go` (nur Verdrahtung).
Vertrag, Journal und Portal-Seite: root `AGENTS.md` „Register schreiben über
das Portal, Stufe 1". Was HIER gelten muss:

- **⚠ ES IST EIN ADAPTER, KEIN ZWEITER SCHREIBWEG.** Er ruft dieselbe POLITIK
  (`installerwrite.Admit` - Allowlist `0x00E7`, Wertdeckel 7000, Bestätigungs-
  Regel, `expected_before`) und denselben MECHANISMUS (`Agent.WriteOnce`) wie
  die `:8484`-Taste. Ein `installerwrite.AdmittedWrite` entsteht nirgendwo
  sonst und hat ausschliesslich unexportierte Felder - kein Adapter kann den
  Mechanismus auf ein Register seiner Wahl richten. Wer hier einen eigenen
  Schreibpfad einzieht, muss jedes Tor ein zweites Mal absichern.
- **⚠ Nur noch EINE Ablehnung ist STUMM: eine fremde Identität** (eine Antwort
  bestätigte einem falsch adressierten Absender die Existenz dieses Geräts).
  Alles andere wird BEANTWORTET - eine Ablehnung, die niemand sieht, ist ein
  Rätsel (die Canary-Soak-Lehre): eine nicht ausgeführte Lane antwortet
  `not_supported`, die Politik `refused_policy` mit dem deutschen Satz VERBATIM
  aus `Admit`. (`gate_disabled` gibt es seit dem Wegfall des Flags nur noch im
  Kontrakt - siehe oben.)
- **⚠ Ein VERFALLENER Auftrag wird seit dem 20.08.2026 BEANTWORTET, aber
  weiterhin NICHT AUSGEFÜHRT.** Die Ausführungssperre ist der EEPROM-Schutz
  gegen eine nachgelieferte QoS1-Nachricht; die frühere STILLE schützte nichts
  und versteckte die eine Ursache, die von der Cloud aus gar nicht sichtbar ist
  - zwei auseinandergelaufene Uhren. Die Antwort (`invalid_request`) nennt
  deshalb BEIDE Uhren (`registerwrite.ExpiredMessage`). Dieselbe Regel für eine
  kaputte FORM, dort aber nur, wo die Cloud die Antwort einordnen KANN
  (`Request.Answerable`: eigene Identität + gültige Kennung + bekannter Modus) -
  sonst wäre die Antwort Rauschen, das die Cloud ohnehin verwirft.
- **⚠ `installerWriteTimeout = 30 s` ist eine VERTRAGSGRÖSSE, keine interne
  Zahl** (`agent/installerwrite.go`). Die Cloud MUSS länger warten als die Box
  sich selbst gibt; sie tat es nicht (20 s), und damit lief das Portal-Lesen auf
  jeder Anlage ins Leere, deren Modbus-Warteschlange gerade belegt war - die
  Box antwortete korrekt, nur zu spät für die Cloud. Wer die 30 s ändert, ändert
  `voltpilot.register-write.{read,write}-timeout` mit (root `AGENTS.md`
  „Zeitfenster-Invariante", `RegisterWriteBudgetTest`).
- **Drei Sicherungen gegen ein Replay**, nicht eine: nicht-retained (Vertrag),
  das `requested_at`-Fenster (60 s, ab dem Stempel des Umschlags - nicht ab dem
  Empfang) und der `request_id`-Merker (gegen eine Doppelzustellung INNERHALB
  des Fensters). Auf einem EEPROM-Register ist jede davon einen Schreibzyklus
  wert.
- **⚠ Der teure Teil läuft in EINER eigenen Goroutine**, nicht auf dem
  Router-Faden des Links: paho ist mit `SetOrderMatters(true)` konfiguriert,
  ein blockierender Handler stallt also JEDEN anderen Downlink (Plan,
  Registry, Flows, OTA-Zuweisung, Freigabe) für die Dauer eines Schreibvorgangs.
  Synchron bleibt nur, was nichts kostet und nichts starten darf: Parsen,
  Identität, Verfall, Replay, Rate.
- **Die SELBSTKONFLIKT-SPERRE liest den Beleg, nicht eine Vermutung**
  (`registerOwnedByControl`): die Adressen des NEUESTEN Steuer-Rücklesens plus
  die Frage, ob die Steuerung überhaupt schreibt (Not-Aus + Zertifizierung, im
  KERN und im Rücklesen). Ohne Rücklesen wird NICHTS behauptet - ein erfundener
  Konflikt verweigerte einen legitimen Schreibvorgang.
- **D6:** ein LOKALER Schreibvorgang mintet sich in `recordInstallerWrite` seine
  eigene `request_id` - sonst wäre genau der Vorgang unkorrelierbar, den
  niemand in der Cloud sieht. Der Herzschlag trägt das Buch additiv
  (`registerWritesSummary`, höchstens 5 Einträge des letzten Tages), eine Box
  ohne Schreibvorgang sendet GAR KEINEN Block.
- Beweise: `internal/registerwrite` (14, inkl. der Kontrakt-Fixtures per PFAD
  und der drei Bedingungen von `Answerable`) · `agent/register_write_test.go`
  (8, darunter „der Pfad braucht keinen Armierungs-Schritt" samt Struktur-
  Wächter gegen ein wieder eingeführtes Konfigurations-Feld, „fremd bleibt
  stumm, verfallen wird beantwortet aber nie ausgeführt" und „eine kaputte Form
  wird beantwortet, wo die Cloud sie versteht") ·
  `internal/cloud/status_test.go`.

## ⚠ Ein Auftrag OHNE Abonnent ist spurlos - und eine VORSCHAU hinterlaesst nie eine Spur

Produktionsvorfall 20.08.2026 („der Downlink kommt auf der Box nie an").
Cloud-Haelfte + die Adressierungs-Regel: root `AGENTS.md` „DIE ADRESSE IST NICHT
DAS ZIEL". Was HIER gelten muss:

- **Die Box abonniert GENAU EIN Topic** (`Link.topic("v2/register-write")`), und
  der Auftrag ist NICHT-retained: landet er auf der Kennung einer anderen
  Geraete-Zeile, gibt es keinen Abonnenten, keine Ablehnung und keine Zeile - auf
  keiner der beiden Seiten. Das ist der Preis der Einmal-Semantik und der Grund,
  warum die Adresse aus dem ZIEL abgeleitet werden muss und nicht aus einer
  Behauptung des Aufrufers.
- **⚠ EINE VORSCHAU WIRD NICHT AUDITIERT** (`runRegisterWrite`:
  `if admitted.Apply()`) - genauso wenig wie die `:8484`-Taste einen Probelauf
  protokolliert (es gibt kein „nachher", und ein Log der Lesevorgaenge begruebe
  die Schreibvorgaenge, fuer die es das Buch gibt). Folge, die eine Untersuchung
  sonst in die falsche Richtung schickt: **eine leere
  `GET /api/installer-write`-Liste beweist NICHT, dass ein Auftrag nicht
  angekommen ist** - bei einer funktionierenden Vorschau sieht sie exakt genauso
  aus.
- **Deshalb protokolliert die Box jetzt den GLUECKLICHEN Pfad**: eine INFO-Zeile,
  wenn ein Auftrag ANGENOMMEN wird (id, Modus, Lane, Register), und eine, wenn
  das Ergebnis hinausgeht. Bis dahin loggten nur Ablehnungen - „ist der Auftrag
  ueberhaupt angekommen?" war aus dem Geraet heraus unbeantwortbar. Es ist die
  Kehrseite derselben Regel, aus der jede Ablehnung sichtbar sein muss: Stille
  ist kein Beleg.
- **⚠ Ein Test, der den TOPIC beweisen soll, darf den Handler nicht direkt
  aufrufen.** `agent/register_write_test.go` ruft `a.onRegisterWrite(payload)` -
  das Abonnement des Cloud-Links kommt darin gar nicht vor, eine vertauschte
  Kennung waere dort strukturell unsichtbar.
  `agent/register_write_integration_test.go` schliesst das Gelenk: echter Agent,
  echter Broker, der Auftrag auf dem WOERTLICH gebauten Vertrags-Topic - und die
  Gegenprobe mit einer VIERTEN Kennung, die nichts ausloesen darf.

## Stufe 2 „Freie Register": die Allowlist wird durch LANE-Regeln abgeloest

Die harte `0x00E7`-Allowlist des Portal-Kanals ist WEG - angekuendigt, nicht
unterlaufen: der Vorgaenger-PR schrieb selbst, ein weiteres Register sei „eine
Code-Aenderung hier, mit eigenem Review". Cloud-Seite (Register-Wissen,
Geraete-Picker, Warnklassen): root `AGENTS.md`. Was HIER gelten muss:

- **⚠ ZWEI UMFAENGE, EINE POLITIK-SCHICHT.** `installerwrite.Admit` bleibt der
  ENGE Umfang der `:8484`-Taste (genau das Export-Limit-Register, Deckel 7000,
  kW-Kopie - ihre Oberflaeche ist ein Werkzeug fuer EINE Zahl); `AdmitExpert`
  (`installerwrite/expert.go`) ist der Umfang des PORTAL-Kanals (freies
  Holding-Register bzw. Spule, Wert 0..65535, Spule 0/1, Funktionscode passend
  zur Registerart). Beide bauen DIESELBE `AdmittedWrite` mit unexportierten
  Feldern und teilen Bestaetigungs-Token, `expected_before`-Schranke und
  Einmaligkeit WOERTLICH - es gibt weiterhin genau zwei Konstruktoren und keinen
  Weg an ihnen vorbei.
- **⚠ Ein Probelauf hat KEINEN Schreibwert** (Produktionsbefund 28.08.2026,
  Palette **0.9.1**): der Cloud-Vertrag verbietet `value` bei `mode=lesen`, der
  Core serialisiert die Abwesenheit auf dem lokalen Bus als harmlose `0`. Der
  alte Palette-Eingang prüfte dort noch die enge `:8484`-Regel `1..7000` und
  verwarf deshalb JEDE Portal-Lesung still; der Core lief nach 30 s in den
  Timeout, während Beobachtungen über den Poll normal funktionierten.
  `vp-installer-write-request.parse` akzeptiert jetzt Dry-Runs ohne Wert bzw.
  mit `0` und den freien Holding-Umfang 0..65535. Gepinnt in `nodes_spec.js`
  plus `TestThePortalTriggerPreviewsThenWritesOnceThroughTheSharedCore` (der
  Bus-Auftrag trägt bei der Vorschau ausdrücklich `Value=0`).
- **DREI LANES, UND DIE ASYMMETRIE IST DIE SICHERHEIT** (`agent.resolveRegisterTarget`):
  `primary` - die Cloud nennt NICHTS, die Box nimmt ihren eigenen konfigurierten
  Wechselrichter; `entity` - die Cloud nennt nur eine Kennung, den Endpunkt loest
  die Box aus IHRER angewandten Registry auf; `lan` - nur hier reist der
  Endpunkt, und nur hier muss die Box ihn deshalb selbst beurteilen
  (`probe.IsPrivateHost`, der FUENFTE Konsument von
  `docs/contracts/lan-host-vectors.json` - kein fuenfter Zwilling, und der
  Palette-Knoten prueft es vor dem Waehlen ein ZWEITES Mal).
- **⚠ Die Entitaets-Aufloesung geht bewusst NICHT ueber
  `componentapply.ParseDriver`:** der SKIPPT ein Selbstbau-Geraet (sein Leseplan
  reist als generierter Flow), und genau so ein Geraet will ein Kunde
  beschreiben. Eine Komponente am SOLARMAN-Logger wird BENANNT auf die primaere
  Lane verwiesen - dieser Socket gehoert dem Wechselrichter-Tab, ein zweiter
  Anspruch darauf ist genau das, was das Ein-Socket-Gesetz verbietet.
- **⚠ Die SELBSTKONFLIKT-SPERRE gilt dem GERAET, nicht der Zahl**
  (`agent.targetIsPrimary`): das Steuer-Rueckelesen nennt die Register, die
  unser Executor auf dem PRIMAER-Wechselrichter schreibt; dieselbe Nummer auf
  einem eigenen Modbus-Geraet des Kunden ist ein voellig anderes Register, und
  sie zu verweigern waere ein erfundener Konflikt.
- **Die Spulen-Regel ist eine Eigenschaft der LANE**: die Solarman-V5-Rahmen
  kennen nur die Holding-Funktionen (`not_supported`, ehrlich benannt), auf
  schlichtem Modbus-TCP gibt es FC1/FC5 und eine Spule ist ein Objekt wie jedes
  andere.
- **Der MECHANISMUS bekam einen zweiten Transport, keinen zweiten Pfad**:
  `Agent.WriteOnce` verzweigt auf `edge/installer-write/*` (Solarman, der
  Flow-Kontext-Lock des Wechselrichter-Tabs) bzw. das NEUE Paar
  `edge/register-write/*` (Palette-Knoten `vp-register-write`, Palette 0.9.0).
  Die Nachrichten-FORM ist byte-gleich, `onInstallerWriteResult` bedient beide -
  eine spaeter ergaenzte Lane kann keine zweite Korrelations-Mechanik bekommen.
- **⚠ `vp-register-write` ist die Stufe-4-Schreibmechanik OHNE Auto-Aus**, und
  deshalb ein EIGENER Knoten neben `vp-modbus-switch-test`: dort ist das
  Zuruecklaufen der Zweck, hier das Stehenbleiben. Ein Auto-Aus-Flag auf EINER
  Funktion waere einen Tastendruck davon entfernt, eine Installateurs-
  Einstellung still zurueckzudrehen. Beide gehen durch `lib/modbus-conn.js`
  (EIN Socket je Ziel) und teilen `switch-write.classify`.
- **Ein Register ohne bekannte Skala bekommt KEINE erfundene Einheit** - weder
  im Plan (`installerWriteRoute` setzt `scale`/`kw` nur fuer das Register, dessen
  Skala die READ-Tabelle der Familie nennt) noch im Audit-Protokoll
  (`Entry.Kw` ist ein ZEIGER und fehlt dann).
- Beweise: `internal/installerwrite/expert_test.go` (5) ·
  `internal/registerwrite` (die drei Lanes, die LAN-Whitelist, die Spulen-Regel,
  die Kontrakt-Vorgaben, zwei neue Fixtures per PFAD) ·
  `agent/register_write_test.go` (+6: freies Register, jedes Registerwort, die
  Entitaets-Aufloesung, die benannte Solarman-Komponente, die freie LAN-Lane,
  die geraete-bezogene Sperre) · `vp-palette/test/register_write_spec.js` (10) ·
  `nodered/inverter-control-routing.test.js` + `flows-sync.test.js`.

## OCPP-Ladepunkte: das CSMS läuft auf der BOX (`internal/csms`)

Stufe 0 des Lastmanagement-Konzepts (`data/vp-ocpp-lastmgmt-konzept-w4`,
Captain-Entscheide E1–E5). Die Box ist das **Central System** — die Ladesäulen
wählen SIE an, nicht umgekehrt. Der Grund ist der Konzept-Kern: die
Anschlussgrenze ist eine PHYSISCHE Grenze, ihr Wächter darf nicht am WAN
hängen. Die Cloud bekommt (wie überall) Sichtbarkeit, nie Steuerung.

- **⚠ HERSTELLERNEUTRAL ist eine Konstruktions-Eigenschaft, kein Versprechen**
  (Konzept §0, VERBINDLICH): die Identität einer Säule ist ihre
  **OCPP-ChargePointId** und sonst nichts. `vendor`/`model`/`firmware`/`serial`
  werden als SELBSTAUSKUNFT der Station aufgezeichnet und nur ANGEZEIGT — kein
  Code verzweigt auf sie. `TestVendorStringsNeverReachTheMechanism` nagelt das
  fest: zwei Stationen mit völlig verschiedenen Herstellerangaben erzeugen nach
  dem Ausblenden der Anzeige-Felder einen **byte-gleichen** Zustand.
  `DataTransfer` — die Tür, durch die Hersteller-Logik in ein CSMS kommt —
  antwortet deshalb ausdrücklich `UnknownVendorId`.
- **Die Bibliothek wohnt in GENAU zwei Dateien.** `lorenzodonini/ocpp-go` (MIT)
  wird ausschließlich in `internal/csms/ocppmap.go` (+ dem Options-Durchreichen
  in `csms.go`) importiert; alles darüber sieht nur einfache Go-Typen
  (`csms.Snapshot`). Ein Versions-Sprung oder der spätere 2.0.1-Adapter (E3:
  1.6J zuerst) ist damit eine Änderung INNERHALB dieses Pakets — das
  `DayAheadPriceSource`/`PlantRegistryClient`-Muster des Hauses.
- **⚠ Der `ocpp-go`-CLIENT hängt seine eigene Id an die Basis-URL an**
  (`ocppj.Client.Start`), eine ECHTE Säule wird dagegen mit der VOLLEN URL
  konfiguriert. Deshalb gibt es beides: `Endpoint(host)` (Basis, für den
  in-process-Testclient) und `EndpointFor(host, id)` (das Kopier-Feld der
  Einrichtungs-Fläche).
- **Pairing = Freigabeliste, nie TOFU.** Nur eine vom Betreiber EINGETRAGENE
  ChargePointId wird zugelassen, und zwar schon beim Websocket-Upgrade
  (`SetNewChargingStationValidationHandler`) — eine unbekannte Station erreicht
  keinen einzigen Handler und wird LAUT protokolliert. `Remove` ist ein
  Widerruf: die Verbindung wird gekappt und ein Wiederverbinden scheitert.
- **⚠ Ein Verbindungsabriss löscht die aufgezeichnete Sitzung NICHT.** Ein
  toter Socket sagt nichts darüber, was die Säule physisch tut; „alles gestoppt"
  wäre eine Behauptung, die niemand gemessen hat. Sicher ist das durch den
  OCPP-EIGENEN Totmann (die `duration` des TxProfile) — die Säule fällt von
  selbst auf ihr hinterlegtes Default zurück. Es wechselt nur `Connected`,
  worauf jede Fläche schlüsselt.
- **⚠ Transaktions-Ids werden PERSISTIERT** (`chargers.json` trägt neben der
  Freigabeliste den Zähler). Eine Box, die sie beim Neustart vergisst, vergibt
  eine Id neu, die eine Säule für eine LAUFENDE Sitzung noch hält.
- **Der Messwert-Parser ist rein und kennt die Fallen** (`meter.go`,
  Vektor-Tests): ein FEHLENDES `measurand` IST das Energieregister
  (Spec-Vorgabe), eine fehlende Einheit ist W bzw. Wh (nie „kilo"), ein
  PRO-PHASE-Wert ist nicht die Summe (ein unphasierter Wert gewinnt immer,
  sonst werden genau L1+L2+L3 summiert), und ein unbrauchbarer Wert wird
  VERWORFEN und GEZÄHLT, nie als 0 gespeichert. **Die SoC-Bandbreite ist hier
  `[0,100]`, nicht `(0,100]` wie beim Batterie-Wechselrichter** — ein Auto
  kommt legitim mit 0 % an, während dort die 0 „Logger erreicht das Gerät
  nicht" hieß.
- **⚠ Flags: `VP_OCPP_ENABLED` ist seit dem 24.08.2026 ein OPT-OUT (Vorgabe AN,
  Captain-Order „ich will das auf der Box OCPP immer angeschalten ist
  automatisch, ohne .env brauch ich nicht"), `VP_OCPP_PORT` bleibt 8887.** Ein
  ausdrückliches `false` gewinnt weiterhin (das `VP_OTA_PRUNE`-Muster). Die
  frühere Begründung „eine Box ohne Ladepunkt zahlt nichts" war eine
  RESSOURCEN-Aussage, keine Sicherheits-Aussage — der Preis ist ein
  Websocket-Listener auf einer LAN-Schnittstelle, und das TOR war nie dieses
  Flag, sondern die Freigabeliste (eine unbekannte Kennung wird beim
  Verbindungsaufbau abgewiesen und protokolliert). Bewusst UNABHÄNGIG von
  `VP_CONTROL_ENABLED`/`VP_CONSUMER_CONTROL_ENABLED`: die zwei sperren SCHREIB-
  Pfade auf ein Gerät, dieser einen SERVER, den Stationen anwählen — **und an
  dieser Unabhängigkeit hat sich NICHTS geändert**, die lebende Zuteilung bleibt
  hinter beiden.
- **⚠ LAN-only ist Umgebung, nicht Code:** die Bibliothek bindet `:port` auf
  allen Schnittstellen (keine Bind-Adresse wählbar) — die Grenze sind
  Compose-Port-Mapping + Host-Firewall, genau wie bei `:8484` und dem
  Node-RED-Editor, plus die Freigabeliste.
- **Scope-Zaun (E4): Lastmanagement pur.** `Authorize` akzeptiert JEDEN Tag —
  es gibt keine Abrechnung, kein Eichrecht, kein Roaming und keine
  Nutzerverwaltung, auf die sich eine Entscheidung stützen könnte, und ein
  erfundenes „Invalid" hielte ein Kundenauto aus einem Grund an, den wir
  erfunden haben. Sitzungen sind BETRIEBS-, keine Abrechnungsdaten.

### OCPP-Datenjournal (Slice 10): unter dem Typ-System, vor der ersten Platte

- **`csms/journal.go` sitzt am Websocket-Rand und sieht ALLES:** der Wrapper in
  `ocppmap.go` protokolliert Call, CallResult und CallError in beide Richtungen,
  bevor ein typisierter Handler ein unbekanntes/fehlerhaftes Ereignis verlieren
  könnte. Connect/Disconnect werden als interne Events ergänzt. Die Library-
  Kapsel bleibt trotzdem intakt: `journal.go` importiert `ocpp-go` nicht.
- **⚠ Privacy gilt VOR dem ersten `WriteFile`:** `idTag`/`parentIdTag` werden
  mit dem gerätespezifischen, 0600-geschützten `ocpp-privacy.key` zu stabilen
  `tagref_*`; `AuthorizationKey` und secret-/password-/token-artige Vendor-Keys,
  Diagnose-/Firmware-URLs und untypisierte `DataTransfer.data` werden redigiert.
  Der völlig unstrukturierte `CallError.error_description` wird immer auf den
  festen Anwesenheitsmarker `[redacted-call-error-description]` reduziert;
  selektives Erkennen wäre für URL-Token/idTag/Vendor-Secrets nicht vollständig.
  `privacySafeProtocolError` erzwingt denselben Marker auch im funktionalen
  Callback-/Status-/Log-Pfad von `ocpp-go`, nicht nur im Wire-Journal.
  `location` ist NUR bei Diagnose/Firmware eine URL — bei `MeterValues` ist
  `Outlet`/`EV` eine unverzichtbare Messdimension und darf nie redigiert werden.
- **Der Spool ist crashfest und geordnet:** eine atomisch umbenannte Datei je
  Event unter `data/ocpp-journal`; erst ein erfolgreicher MQTT-QoS1-Publish auf
  `ems/{t}/{s}/{d}/v2/ocpp-events` löscht genau diese Datei. Der Upload-Loop in
  `agent/ocpp.go` ist reine Sichtbarkeit und stellt keinen Downlink/Command-Pfad
  bereit. `Journal.Close` ist die Lifecycle-Barriere gegen verspätete
  Disconnect-Callbacks beim Shutdown. Davor blockiert `transport.stop` neue
  Reconnects und drainiert zugelassene WebSockets begrenzt auf
  `commandSocketWriteWait + 1s`; im Normalpfad sind danach Register und Pumps
  leer, bei einer nicht kooperierenden Dependency übernimmt der synchronisierte
  `Server.Stop` als bounded Fallback (niemals eine unbegrenzte Stop-Schleife).
  Auch `StopConnection` selbst darf nicht inline in der Deadline-Schleife
  liegen: genau ein Close-Worker versucht alle Sockets einmal, die Hauptroutine
  prüft unabhängig ihre monotone Frist, ruft dann den synchronisierten Fallback
  auf und joint den Worker wiederum begrenzt. So kann ein Mutex-stauender Close
  weder die Frist umgehen noch pro Poll neue Shutdown-Goroutinen erzeugen.
  Der Core pinnt dazu den ersten
  offiziellen post-v0.19-Upstream-Stand mit per-Socket-Mutex: v0.19.0 hatte
  sowohl `writePump.error` gegen `errC`-Close als auch `StopConnection` gegen
  `cleanupConnection`/`closeC` ungeschützt. Diese Reihenfolge und den Pin nicht
  auf v0.19.0 oder `Stop()`-direkt zurückbauen.
- **Ein voller Spool darf nie wie Vollständigkeit aussehen:** Kapazitäts-
  Evictions und Event-Write-/Rename-/Encode-Fehler landen im separaten,
  atomischen `data/ocpp-journal-gaps.json` mit monotonem Gesamtzähler und
  Event-/Zeitbereich. `Next()` liefert den stabilen `JournalGap` vor normalen
  Events; erst sein QoS1-ACK entfernt ihn. Neue Drops während eines in-flight
  Gaps beginnen eine neue Generation, sodass ein ACK nie ungesehene Verluste
  mitlöscht. `PurgeProtocolEventsThrough` entfernt bewusst gelöschte Events
  ohne einen falschen Verlustbeleg zu erzeugen. Beim All-Data-Purge werden auch
  korruptes JSON, nicht lesbare Dateien und Events ohne dekodierbaren Zeitstempel
  konservativ gelöscht; ein Remove-/Gap-Ledger-Commitfehler bleibt retrybar.
  `agent/purge.go` persistiert deshalb die Cloud-Löschabsicht mit
  `local_cleanup_pending=true` VOR dieser falliblen Bereinigung, wiederholt sie
  beim nächsten Start vor dem Cloud-Reconnect und sendet denselben Zeitstempel
  nach Reconnect erneut. Nie lokale Teil-Löschung ohne restart-festen Cloudauftrag.
- **Das GetConfiguration-Inventar ist absichtlich VOLLSTÄNDIG:**
  `CapabilityKeys()` ist wieder die gezielte, lasttragende Abfrage der vier
  Smart-Charging-Sicherheitswerte. NACH installierten Schutzprofilen fragt
  `InventoryKeys()` best-effort mit leerer OCPP-Keyliste (= alle Schlüssel).
  Eine Säule, die die Vollabfrage verweigert, bleibt damit sicher commissioned;
  bei Erfolg bewahrt das Wire-Journal readonly, unknownKey,
  SupportedFeatureProfiles und Vendor-Keys. Es entsteht keine neue Aktion.

## Das Compose-Rig `test/e2e-compose.sh`: zwei Regeln, ohne die es in CI nicht laeuft

Es beweist die ganze Kette (SunSpec-Sim -> Node-RED/vp-palette -> Kern -> Stand-in-Cloud
-> Fahrplan -> Sollwert -> Rueckmeldung -> Modbus-Datenspiegel) gegen ECHTE Container.
Seit dem 26.08.2026 (Forgejo-Lauf 281) haelt es zusaetzlich zwei Regeln ein, die der
containerisierte Runner erzwingt — Begruendung und die ganze Klasse stehen in der
Wurzel-`AGENTS.md` unter „Einen ROTEN CI-Lauf untersuchen".

- **⚠ KEIN Bind-Mount aus dem Arbeitsverzeichnis.** Der Daemon loest ihn gegen SEIN
  Dateisystem auf; laeuft der Job im Container, gibt es den Workspace-Pfad dort nicht.
  Der Stand-in-Broker traegt seine Konfiguration deshalb EINGEBACKEN
  (`test/Dockerfile.broker` — ein Build-Kontext wird gestreamt, ein Bind nicht), und
  der OTA-Sidecar mit seinem `.:/deploy` ist ueber ein nicht angefordertes `profiles:`
  aus dem Rig heraus (er ist kein Glied der bewiesenen Kette; dass er im GERAETE-Compose
  ohne Profil mitlaeuft, ist Sache von `test/install-selfcheck.sh`).
- **⚠ KEINE Anfrage an einen veroeffentlichten Port.** Jede HTTP- und jede
  Modbus-Anfrage laeuft in einem Seitenwagen INNERHALB des Compose-Netzes und erreicht
  die Dienste bei ihrem Namen (`core:8484`, `core:1502`). Die `ports:` bleiben nur, damit
  das Rig nie mit einem laufenden Stack kollidiert — benutzt werden sie nicht mehr.
- **Der Waechter laeuft VOR dem `up`**: das aufgeloeste Compose wird auf Bind-Mounts
  geprueft, und ein Treffer nennt Dienst, Quelle, Ziel und die REGEL. Mutationsgeprueft
  in beide Richtungen. Ohne ihn kostet der naechste Bind wieder zwei Untersuchungsrunden.

## Das Lastmanagement-Rig `test/e2e-ocpp.sh`: Docker-frei, und es misst

Die Faelle L1-L12 des Konzepts (§6.2 + Datenfundament + Command-Gateway) gegen den ECHTEN Kern und ECHTE
OCPP-Ladesaeulen (`cmd/vp-ocpp-sim`) ueber ECHTE Websockets.

- **⚠ Jede Zusicherung liest, was eine Saeule ZIEHEN WUERDE**, abgeleitet aus
  den Ladeprofilen, die der Kern ihr wirklich installiert hat — nie eine
  Quittung. Der Simulator loest den OCPP-Profil-Stapel selbst auf
  (`internal/ocppsim`), also ist „das Budget wird gehalten" eine MESSUNG.
- **⚠ Bewusst OHNE Docker** (anders als die `e2e-*-compose.sh`-Rigs): hier
  laeuft alles als Prozess, das Rig ist also auf jedem Rechner mit Go
  reproduzierbar und braucht kein gebautes Image. Die Cloud-URL zeigt bewusst
  ins Leere — das Lastmanagement ist per Konstruktion offline-faehig, und das
  Rig zeigt genau das. **Diese Eigenschaft ist seit dem 26.08.2026
  auch eine CI-Eigenschaft und soll bleiben:** der Forgejo-Runner faehrt den Job
  selbst in einem Container am Docker-Socket des HOSTS, also funktioniert dort
  weder ein Bind-Mount aus dem Workspace noch eine Anfrage an einen
  veroeffentlichten Port. Ein docker-freies Rig ist von der ganzen Klasse nicht
  betroffen; das Compose-Rig musste dafuer umgebaut werden (naechster
  Abschnitt).
- **⚠ Das Rig prueft die ZUSAGE, nie die BESETZUNG.** WELCHE zwei Fahrzeuge
  bedient werden, entscheidet die Rotation; ein Rig, das eine bestimmte Saeule
  festnagelt, prueft einen Zufall und wird flakey (genau so beim ersten Lauf
  passiert). Geprueft wird deshalb: „genau zwei laden", „keiner haengt unter
  der Mindestleistung", „der Standort bleibt unter dem Budget", „der Wartende
  nennt seinen Grund".
- **L6 ist der Stufe-2-Beweis und er misst genauso.** Der simulierte
  Netz-Zaehler (`cmd/vp-netz-sim`) meldet den VERKNUEPFUNGSPUNKT auf dem
  lokalen Bus — Gebaeudelast plus das, was die Saeulen ziehen, und er LIEST
  ihren Zug ueber ihre Status-Endpunkte, wie ein echter Zaehler ihn sieht. Das
  Rig muss die beiden also nicht von Hand synchron halten, und es gibt keinen
  Test-Hebel: der Weg ist der echte (`edge/telemetry` -> `onLocalTelemetry` ->
  `agent.ocppObserve`). Geprueft wird die ganze Kette: das Budget folgt der
  Messung, ein Lastsprung im Gebaeude regelt die Fahrzeuge herunter UND der
  Verknuepfungspunkt bleibt unter der planbaren Leistung, der Zaehler faellt
  aus -> GEHALTEN statt freigegeben -> zusammengezogen auf das sichere Budget.
- **⚠ Der Lastsprung im Rig ist bewusst REALISTISCH gewaehlt** (20 -> 100 kW
  Gebaeude bei 2-s-Kadenz), nicht maximal: die Despike-Schwelle der Box haelt
  einen groesseren Sprung ein paar Messwerte lang zurueck, und dann prueft das
  Rig das Despike-Tor statt des Lastmanagements. Wer die Zahlen anhebt, misst
  etwas anderes als er glaubt.
- **L7-L9 sind der Stufe-4-Beweis, und sie messen an den SAEULEN.** Der
  Netz-Zaehler bekam dafuer genau zwei Dinge: eine NEGATIVE Gebaeudelast (so
  speist der Standort ein, waehrend nichts laedt — das ist die PV des Rigs) und
  ein optionales `battery_power_kw`. **⚠ Die Vorgabe des Batterie-Flags ist
  NaN, nicht 0:** eine gemessene Null ist die Aussage „der Speicher nimmt
  nichts", und genau die braucht „Auto vor Speicher"; nur ein ABWESENDER Kanal
  heisst unbekannt.
  - **L7** deckelt bei „Nur Sonnenstrom" auf den gemessenen Ueberschuss,
    waehrend die physische Bahn weit offen steht — und der Verknuepfungspunkt
    steht danach bei 0 kW: es wurde nachweislich kein Netzstrom gekauft.
  - **L8** legt die Prioritaet um und misst dieselbe Sonne zweimal:
    80 -> 120 kW an den Saeulen. **⚠ Der Zaehler bildet den Speicher NICHT
    nach, wie er auf die Klemme reagiert** — das Rig ist kein Physik-Simulator;
    es misst, wie viel die Box den AUTOS zugesteht.
  - **L9** uebersteuert GENAU EINEN Ladevorgang: er zieht aus der physischen
    Bahn hoch, der andere ist nicht mitfreigegeben (er behaelt hoechstens
    seinen Sonnen-Anteil, und wenn nichts mehr uebrig ist, PAUSIERT er mit
    genanntem Grund statt zu hungern), der Anschluss haelt, und die Ruecknahme
    stellt die Prioritaet des Kunden wieder her.
  - **L10** liest den echten, wegen der absichtlich toten Cloud-Verbindung noch
    nicht quittierten Disk-Spool: Boot/Status/Auth/Start/Stop/Meter/Diagnose/
    Firmware/GetConfiguration samt Vendorfeldern, `transactionData`, Stopgrund
    und den zwei nur durch L1-N/L2-N getrennten Messdimensionen sind vorhanden;
    `RIG-TAG` und der simulierte AuthorizationKey fehlen im Klartext.
  - **L11/L12** führen zusätzlich die vollständige Command-Fläche gegen den
    echten lokalen Websocket-Stack aus: persistentes Replay/Reconnect-Dedup,
    Deadline/Enrollment-Identität, Crash+umgekehrte gleichartige Antworten und
    ChangeConfiguration → CallResult → gezielter GetConfiguration-Readback.
  - **⚠ Grosszuegige Fristen mit Grund:** der Rest des Standorts wird als
    MAXIMUM ueber 60 s genommen, und waehrend die Fahrzeuge herunterfahren
    liest der Zaehler ihren Zug kurz zu hoch. Beides UNTERSCHAETZT den
    Ueberschuss — die Bahn ist konservativ, nie grosszuegig; geprueft wird der
    Zustand, in dem die Anlage zur Ruhe kommt.
- **⚠ Und L8 hat einen echten Defekt gefunden, den KEIN Unit-Test sehen
  konnte:** die Speicher-Arbitrierung las `battery_power_kw` aus der
  Messwert-Karte — aber `onLocalTelemetry` legt diesen Kanal dort BEWUSST NIE
  hinein (er ist ein interner Kanal, kein veroeffentlichter Messwert). Die
  Arbitrierung war damit auf JEDER echten Box tot, waehrend die Tests ihre
  Karte von Hand fuellten und gruen blieben. Der Wert wird seither als
  ARGUMENT uebergeben (`ocppObserve(ts, measurements, battKw)`), und
  `TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath` faehrt
  dafuer den ECHTEN Weg. **Wer einen Kanal aus `measurements` liest, prueft
  zuerst, ob er dort ueberhaupt ankommt.**
- **⚠ Ein Testfall, der den VOLLEN Agenten braucht** (nur er hat die Gates des
  Telemetrie-Pfads), braucht einen KUENDBAREN Kontext fuer `startOcpp`:
  `Stop()` wartet auf die Goroutinen des Agenten, und die OCPP-Schleife endet
  allein an ihrem Kontext — mit `context.Background()` haengt der Test.
- **L4 ist der Totmann-Beweis und er dauert:** der Kern wird GETOETET, dann
  laeuft das TxProfile (120 s) ab und die Saeule faellt VON SELBST auf ihr
  Sicherheitsprofil. Die zweite Haelfte ist genauso wichtig — sie laedt
  WEITER: ein Totmann, der den Ladevorgang abwuergt, waere kein Schutz,
  sondern ein Ausfall.

## Die `:8484`-Ladepunkt-Flaeche ist die EINZIGE bedingte Accordion-Gruppe

- **⚠ Die Gruppe „Ladepunkte" wird `hidden` AUSGELIEFERT und von `ocpp.js`
  eingeblendet.** Die VIER festen Gruppen sind die Zusage der Seite („eine
  fertig eingerichtete gesunde Anlage zeigt vier ruhige Zeilen") — eine fuenfte
  Zeile auf jeder Anlage OHNE Ladesaeulen waere genau das Rauschen, das der
  Umbau beseitigt hat. `TestEinrichtenAccordionIsFourClosedGroups` zaehlt sie
  deshalb heraus und nagelt zugleich fest, dass sie versteckt ausgeliefert wird.
- **⚠ Das Einblende-SIGNAL ist seit dem 24.08.2026 ein anderes, und genau
  deshalb haelt die Zusage weiter.** Vorher genuegte „der Server laeuft"
  (`ocpp.enabled`) — mit `VP_OCPP_ENABLED` als Opt-out laeuft er auf JEDER Box,
  die Gruppe waere also die staendige fuenfte Zeile geworden. `VPOcpp.zeigeGruppe`
  fragt seither, ob es wirklich LADEPUNKTE gibt: eingetragene Kennungen ODER
  gemeldete Saeulen — plus den Tiefenlink `#ladepunkte`, damit ein Verweis von
  aussen nie ins Leere fuehrt. **Wer das Signal wieder auf `enabled` verkuerzt,
  bricht die Vier-Gruppen-Zusage; wer die Deep-Link-Haelfte streicht, bricht den
  Verweis.** Beides steht als eigener Fall in `jstest/ui.test.js`.
- **⚠ Der Host im Kopier-Feld kommt aus der ADRESSZEILE des Browsers, der Port
  von der Box.** Die Box weiss nicht, unter welchem Namen das LAN sie
  erreicht; ein erfundener Hostname auf einem Kopier-Feld ist schlimmer als
  keiner. Der Port ist dagegen die eigene Einstellung der Box.
  (`VPOcpp.endpointFor`, rein + getestet.)
- **READ + SETUP, kein Befehlspfad.** Es gibt bewusst KEINE Route, die eine
  Ladegrenze setzt — Grenzen kommen allein aus dem Lastmanagement, damit diese
  Flaeche nie ein zweiter, unarbitrierter Schreiber auf eine Kundenanlage wird.
  `TestThereIsNoRouteThatCommandsAChargingLimit` ist der strukturelle Waechter.
- **⚠ Die Stufen-Zeile (Stufe 2) WIEDERHOLT den Satz der Box, sie formuliert
  ihn nie neu** (`VPOcpp.budgetSourceLine` reicht `budget_note` durch): der
  deutsche Satz wird EINMAL geschrieben, in `lastmgmt/budget.go`, wie beim
  Einspeise-Waechter — zwei Renderings desselben Urteils koennten es sonst
  verschieden sagen, und nur die Box kennt die Zahlen dahinter. `budgetSourceTone`
  faerbt nur: jede BLINDE Stufe ist eine Warnung, „statisch" ist ehrlich und
  kein Fehler, und ein unbekanntes Wort wird nie zu einer erfundenen Warnung.
- **Die Einrichten-Seite zeigt das LEBENDE Budget** (`ocpp.budget_kw`), nicht
  das, was die Einstellungen allein ergaeben (`settings.budget_kw`) — seit
  Stufe 2 sind das zwei Zahlen, und eine Einrichtungsseite, die eine andere
  nennt als die Betriebskarte, waeren zwei Wahrheiten ueber eine Groesse.
- Jede Ableitung liegt rein in `window.VPOcpp` (`jstest/ui.test.js`): die
  Budget-Zeile behauptet nie einen Messwert, den niemand gemeldet hat; die
  Ausfall-Zeile zeigt die RECHNUNG statt einer nackten Zahl und wiederholt
  ohne berechenbaren Wert den GRUND; eine getrennte Saeule nennt die FOLGE
  („behaelt ihr Sicherheitsprofil"), nicht nur die Tatsache; und das
  Entfernen sagt vorher, was BLEIBT.
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Aenderung den Core neu bauen.**

## OCPP-Executor: ZWEI Tore, und das eine schuetzt ohne das andere (`agent/ocpp.go`)

Die Verdrahtung zwischen der reinen Verteilung (`internal/lastmgmt`) und den
OCPP-Profilen (`internal/csms`). Sie enthaelt keine Verteilungsregel und kein
OCPP-Vokabular — sie ist bewusst duenn.

- **⚠ Die zwei Tore sind verschieden, und der Unterschied ist tragend:**
  `VP_OCPP_ENABLED` startet den SERVER und hinterlegt die zwei SCHUETZENDEN
  Profile (Saeulen-Kappe + sicheres Default) — die REDUZIEREN nur, machen eine
  Anlage also sicherer, nie gesteuerter. Die LEBENDE Zuteilung braucht
  zusaetzlich `VP_CONTROL_ENABLED ∧ VP_CONSUMER_CONTROL_ENABLED` (Konzept
  §7.5). Ohne sie laeuft die Anlage auf `n × Sicherheitsprofil`, was per
  Konstruktion unter der Anschlussgrenze liegt — **sicher, nur nicht
  optimiert — und die Oberflaeche SAGT das** (`ControlNote`; eine Verweigerung,
  die niemand sieht, ist ein Raetsel — die Canary-Soak-Lehre).
- **⚠ WAS WIR NICHT SEHEN, ZIEHT TROTZDEM.** Eine Saeule mit totem Websocket
  laedt nicht nichts: sie haelt ihr eigenes Sicherheitsprofil, und ihre Autos
  nehmen es womoeglich. Das volle Budget an die ERREICHBAREN zu verteilen
  gaebe dieselbe Leistung zweimal aus. Der Anteil der unerreichbaren Stecker
  wird deshalb aus dem Budget RESERVIERT (`ReservedKw` auf der Oberflaeche) —
  der Import-Zwilling der exportlimit-Doktrin „blind heisst nie unbegrenzt".
  Bewusst pessimistisch: ein nicht belegter Stecker an einer toten Saeule
  reserviert Leistung, die er nicht braucht, und das ist die richtige
  Richtung, in der man falsch liegt.
- **⚠ Die Auffrischung ist BEDINGUNGSLOS.** Auch eine unveraenderte Grenze
  wird jeden Takt neu geschrieben, denn es ist der SCHREIBVORGANG, der den
  Totmann neu spannt. Das Verhaeltnis `ocppTickInterval : csms.TxProfileDuration`
  (20 s : 120 s) IST die Zahl der verpassten Takte, die ein ladendes Fahrzeug
  ueberlebt. Die Schonung gegen sinnloses Hin und Her passiert eine Schicht
  hoeher, am WERT (`lastmgmt.Pacing`), nie am Schreibvorgang.
- **Das Sicherheitsprofil ist eine ANLAGEN-Groesse**, also wird bei jeder
  Aenderung der Steckerzahl (eine Saeule kommt dazu) JEDE Saeule neu
  eingerichtet. Der Fingerabdruck enthaelt zusaetzlich die
  Verbindungs-Generation, damit eine neu gestartete Saeule ihre Profile
  wiederbekommt.
- **Eine beendete Sitzung verliert ihre Grenze** (`ClearLimit`): OCPP sagt,
  eine Saeule verwirft ein TxProfile mit seiner Transaktion — eine Firmware,
  die es behaelt, liesse das NAECHSTE Fahrzeug still die Grenze des vorigen
  erben.
- Fehler werden **je Schluessel gedrosselt** protokolliert (5 min): eine seit
  einer Stunde unerreichbare Saeule schreibt sonst 180 identische Zeilen.
- **`internal/ocppsim`** ist der Ladesaeulen-Simulator (das
  `consumersim`-Gegenstueck): eine reine Haelfte loest den OCPP-Profil-Stapel
  und den Ablauf auf und rechnet die simulierte Leistung daraus, eine zweite
  bindet sie an eine echte ocpp-go-Ladesaeule. **Damit ist „das Budget wird
  gehalten" an den simulierten Zaehlerwerten beweisbar, nicht nur an den
  Quittungen.** Dev-/Rig-Werkzeug, nie in einem Kunden-Image.

## OCPP: der Totmann ist OCPPs eigener, nicht unserer (`csms/profiles.go`)

Die Smart-Charging-Hälfte des CSMS (Konzept §3.1/§4.3). Drei Profile, und die
Arbeitsteilung zwischen ihnen IST die Ausfallsicherheit:

    ChargePointMaxProfile  harte Kappe der ganzen Säule, PERMANENT
    TxDefaultProfile       sicherer Vorgabewert je Stecker, PERMANENT
    TxProfile              die LEBENDE Zuteilung, mit kurzer `duration`,
                           alle paar Sekunden aufgefrischt

- **⚠ Stirbt die Box, läuft das TxProfile AUF DER SÄULE ab und sie fällt von
  selbst auf ihr gespeichertes Default zurück — dafür muss NICHTS von uns
  funktionieren.** Genau deshalb ist der Rückfall der OCPP-Mechanismus und kein
  Wachhund, den wir schreiben. `TestThePermanentProfilesNeverExpireAndTheLiveOneAlways`
  nagelt beide Hälften fest; `TestTheLiveLimitExpiresOnItsOwn` beweist es gegen
  eine simulierte Station, die den Profil-Stapel und den Ablauf wirklich
  auflöst (der in-process-Zwilling der SAP-Simulator-Semantik).
- **Eine PAUSE ist ein Limit von 0, kein fehlendes Limit.** Das Profil zu
  LÖSCHEN nähme die Beschränkung weg und das Fahrzeug zöge den Default — das
  Gegenteil von „pausieren".
- **⚠ Profil-Ids sind je Stecker verschieden** (`TxProfileID(connector)`): ein
  `SetChargingProfile` mit bekannter Id ERSETZT das Profil, zwei Stecker mit
  derselben Id überschrieben also gegenseitig ihre Grenze.
- **Erst FRAGEN, dann befehlen** (die Anti-Deye-Disziplin vor dem ersten
  Schreibvorgang statt nach der ersten Überraschung): `GetConfiguration` liest
  `ChargingScheduleAllowedChargingRateUnit`, `ChargeProfileMaxStackLevel`,
  `ChargingScheduleMaxPeriods`, `MaxChargingProfilesInstalled`. **Ein FEHLENDER
  Einheiten-Schlüssel gilt als „W erlaubt"** — er ist in 1.6 optional und viel
  Firmware lässt ihn weg, während sie Watt-Grenzen anstandslos nimmt; die
  Antwort der Säule auf `SetChargingProfile` bleibt das echte Urteil.
- **⚠ Nur WATT in dieser Stufe.** kW in Ampere umzurechnen braucht Spannung UND
  Phasenzahl, und OCPP nennt beides nicht. Genau so überschreitet ein
  Lastmanagement einen Anschluss — deshalb wird eine Ampere-only-Säule BENANNT
  abgelehnt und bekommt GAR KEIN Profil (statt einer geratenen Grenze).
  Ampere mit betreiber-erklärter Spannung/Phasenzahl ist die erste Folgearbeit
  und ein Bench-Punkt je Säulen-Typ.
- **Rücklesen ist Pflicht, und Schweigen ist keine Zustimmung**
  (`GetCompositeSchedule` → `CompareReadback`): `ok` · `abweichend` ·
  `unbekannt`. Ein angenommener Befehl ist kein Befehl in Kraft — die
  PR-280-/Deye-Lehre auf OCPP übertragen. Eine Antwort in AMPERE wird nicht
  umgerechnet, sondern bleibt ehrlich `unbekannt`.
- **`Commission` läuft bei JEDEM (Wieder-)Verbinden**, nicht einmal beim
  Koppeln: eine Säule, die neu gestartet hat, kann ihr Sicherheitsprofil
  verloren haben, und eine Anlage mit geänderten Grenzen muss die neuen lernen.
  Ein Fehlschlag wird protokolliert UND zurückgegeben — nie bleibt eine Säule
  „eingerichtet" aussehend zurück.
- **⚠ Für TESTS mit einer simulierten Station: EINE Uhr.** Der Profil-Start
  kommt vom Server, den Ablauf beurteilt die Station — zwei auseinanderlaufende
  Uhren lassen ein Profil im Moment des Schreibens abgelaufen aussehen
  (`startServerWithClock`). Und `connectStation` WARTET, bis das CSMS die
  Verbindung verbucht hat: die Bibliothek meldet den Dial fertig, bevor ihr
  Server-Callback gelaufen ist.

## OCPP-Lastmanagement: die Verteilung ist REIN (`internal/lastmgmt`)

Stufe 1 des Konzepts (`vp-ocpp-lastmgmt-konzept-w4` §4.1/§4.2) plus die zwei
Produkt-Details, die erst die abgenommenen Mockups festgeschrieben haben
(`vp-ocpp-mockups-r5` §2.7/§2.8). Kein I/O, keine eigene Uhr (jede
zeitabhängige Funktion nimmt ihr `now`), kein OCPP-Import — das
`Tagesprotokoll`/`FleetPflege`/`otaapply`-Muster, also ist jede Regel ohne
Websocket, Station oder Container beweisbar.

- **⚠ Die Reihenfolge der Budget-Rechnung ist NICHT vertauschbar:** der
  Sicherheitsabstand kommt von der ANSCHLUSSGRENZE, und erst was danach übrig
  bleibt teilt sich mit dem Gebäude — `277 → nie über 249,3 geplant → 249,3 −
  167 = 82,3 kW Ladebudget` (die Mockup-Arithmetik). Den Abstand vom REST zu
  nehmen ergäbe 99 kW und damit ein drittes ladendes Fahrzeug, das nicht laden
  darf. Der Abstand schützt den ANSCHLUSS, also wird er am Anschluss genommen.
- **Pausieren schlägt Aushungern** (die D4-Regel auf n Fahrzeuge): unter der
  Mindestleistung wird GAR NICHTS zugeteilt — ein Wert zwischen 0 und dem
  Minimum ist kein langsamerer Ladevorgang, sondern gar keiner, das Budget wäre
  also für nichts ausgegeben. Wer wartet, WECHSELT im festen Takt
  (wall-clock-ausgerichtete Epochen ⇒ zustandslos und reproduzierbar), und die
  Zeile trägt ihren geschätzten Termin (`NextTurnAt` — aus derselben Rotation
  abgeleitet, nie erfunden; `0` heißt „der Termin käme nie" und die Fläche sagt
  dann nichts).
- **⚠ Die site-weite Mindestleistung wird auf die Steckdose GEKLEMMT.** 30 kW
  (eine DC-Park-Zahl) darf eine 11-kW-AC-Box nicht unbedienbar machen — 11 kW
  IST ihre volle Leistung. Ein Gerät-eigenes Minimum steht auf der `Session`
  und schlägt die Vorgabe.
- **Vorrang ist ein RANG, kein Freibrief** (Captain-Entscheid): die
  Vorrang-Gruppe wird ZUERST und auf ihre VOLLE Nachfrage bedient, der Rest
  teilt fair (inkl. Rotation) — aber sie wird selbst wassergefüllt und selbst
  vom Budget gedeckelt, kann den Anschluss also so wenig überschreiten wie
  jede andere. Die Folge (die anderen warten länger) ist echt, und die Fläche
  ist verpflichtet, sie zu nennen.
- **⚠ Mindestleistung und Ausfall-Profil sind ZWEI Zahlen** (Mockups §2.8):
  die eine ist Zuteilungs-Politik, die andere Notbetrieb. `DeriveSafeDefault`
  rechnet `(Grenze − höchste Gebäudelast) ÷ Steckerzahl` und liefert die
  TERME mit, damit die Fläche dem Kunden die Rechnung zeigen kann
  (`6 × 15 kW + 180 kW = 270 < 277 ✓`). Wer die beiden gleichsetzt, macht die
  Rechnung auf genau den Anlagen unmöglich, für die es das Produkt gibt
  (`TestMindestleistungAndAusfallProfilAreDifferentNumbers` rechnet das
  Gegenbeispiel vor).
- **⚠ Die Ausfall-Zahl wird ABGERUNDET, nie kaufmännisch.** Aufrunden liess
  `Stecker × Wert` das Freie um Haaresbreite überschreiten (277 kW auf 6
  Stecker → 16,167 → 277,002). Vom Sweep-Test gefunden, nicht beim Lesen der
  Formel; die Invariante wird jetzt an der Erzeugungsstelle geprüft, nicht nur
  im Test. **Ein Sicherheitswert rundet nie auf.**
- **Pacing hält nur ERHÖHUNGEN.** Jede Verringerung (und jedes Pausieren /
  Fortsetzen) geht sofort durch — sie schützt den Anschluss, und ein
  aufgeschobener Schutz ist keiner. Der Halt erneuert sich nicht selbst
  (`ChangedAt` wandert mit), sonst hinge eine kleine Erhöhung für immer fest.
- **Einstellungen** in `lastmgmt.json` (das `despike.json`/`balance.json`-Muster,
  tmp+rename, PATCH-Semantik: ein abwesendes Feld BEHÄLT den Wert). Ohne
  hinterlegte Anschlussgrenze ist das Budget 0 und es lädt nichts — der
  ehrliche Zustand einer Box, die niemand eingerichtet hat.

## Stufe 2: das Ladebudget FOLGT dem gemessenen Netzanschluss (`lastmgmt/budget.go`)

Der Import-ZWILLING von `guards/exportlimit.go`, mit derselben Arbeitsteilung
und derselben umgekehrten Fail-Safe-Regel. Konzept §4.2 Nr. 2. Alles ist
additiv: eine Anlage, die ihren Netzanschluss nie misst, rechnet weiter
byte-gleich mit den gepflegten Zahlen (`TestWithoutAMeasurementTheBudgetIsByteForByteStufe1`).

    rest   = gemessener Netzbezug − gemessene Ladeleistung
    budget = planbar − rest

- **⚠ Die gemessene LADELEISTUNG muss zurückaddiert werden, sonst schwingt die
  Schleife.** Die Säulen stecken schon im gemessenen Netzbezug: `planbar − netz`
  würde das Budget genau um die Leistung kürzen, die es gerade vergeben hat,
  die Autos kappen, den Netzbezug fallen sehen, wieder vergeben — eine Dauer-
  Schwingung im Takt der Schleife. Es ist derselbe Grund, aus dem der
  Einspeise-Wächter `pv_gesamt` wieder addiert.
- **⚠ Eine UNVOLLSTÄNDIGE Messung ist keine Messung.** Meldet ein Stecker, dem
  wir Leistung zugeteilt haben, keinen frischen Messwert
  (`csms.Snapshot.ChargingTotal`), wird die Probe VERWORFEN und die Stufen-
  Kette übernimmt — genau der Fall, aus dem sonst die Schwingung würde. Eine
  getrennte Säule macht sie NICHT unvollständig: deren Zug steckt im Netzbezug
  und zählt damit als Gebäudelast (konservativ und stabil).
- **⚠ Die Fail-Safe-Regel ist die UMKEHRUNG jedes ökonomischen Guards:** frisch
  → Schleife · kurze Lücke → das letzte Budget HALTEN · längere Lücke → auf das
  SICHERE Budget zusammenziehen · nie gemessen → das hinterlegte (Stufe-1-)
  Budget. Eine Kontraktion HEBT nie an. Das sichere Budget rechnet mit
  `max(HouseReserveKw, MaxHouseLoadKw)` und liegt damit nie über dem statischen.
- **⚠ Die Trägheit steckt an GENAU EINER Stelle und ist asymmetrisch:** die
  Standortlast wird als MAXIMUM über ein nachlaufendes Fenster
  (`BudgetSmoothWindow`, 60 s) genommen. Ein Lastsprung verkleinert das Budget
  im nächsten Messwert, ein Lastabfall vergrößert es erst, wenn das Fenster
  durch ist. Ein Mechanismus, beide Aufgaben.
- **⚠ Über die Anschlussgrenze hinaus wird NIE geplant**, auch nicht, während
  die Anlage einspeist und die Arithmetik es hergäbe: der PV-Überschuss ist
  hinter einer Wolke in Sekunden weg, und kein Sekunden-Regelkreis (und kein
  rampendes Fahrzeug) folgt dem. Der Überschuss senkt weiterhin den Bezug, er
  hebt nur nicht das Budget.
- **§14a ist most-restrictive-wins und gilt in JEDEM Modus** (es ist Gesetz,
  keine Optimierung) — aber nur eine WIRKLICH gemeldete Hülle zählt: `0` heißt
  null Kilowatt, nur ein ABWESENDER Kanal heißt unbekannt (die dokumentierte
  `guards.Reading`-Falle). Eine einmal beobachtete Hülle wird gehalten, nicht
  gealtert — genau wie beim Batterie-Guard. Sie bindet die LEBENDE Zuteilung,
  NIE die zwei permanenten Profile (ein Dimm-Ereignis ist vorübergehend und darf
  keine Sicherheits-Vorgabe überleben, die es an der Säule tut).
- **⚠ Die Reserve für unerreichbare Säulen entfällt im gemessenen Modus** — ihr
  Zug steckt schon in der Messung, sie ein zweites Mal abzuziehen wäre eine
  Über-Vorsicht, die keine Fläche erklären kann. Jede blinde Stufe bekommt sie
  zurück.
- **Der Schalter heißt `static_budget` und ist NEGATIV formuliert**, damit sein
  Nullwert die gewollte Vorgabe ist („nimm die Messung, wenn es eine gibt") —
  ohne Zeiger, ohne `WithDefaults`-Eintrag, also kann ein ausdrückliches „aus"
  des Betreibers nie überschrieben werden.
- **⚠ Die Fläche RECHNET dieselbe Ableitung, sie liest kein zwischengespeichertes
  Ergebnis** (`agent.ocppBudget`, geteilt von `ocppStep` und `ocppInfo`). Ein
  gespeichertes Urteil war beim ersten Wurf drin und zeigte nach jedem Speichern
  der Einstellungen bis zu einen Takt lang die alte Zahl — im Rig als „Budget ist
  0 kW" aufgefallen. `Budget()` ist für einen Zeitpunkt idempotent, ein Rendern
  wertet also genau das aus, was der nächste Takt täte.
- Gefüttert wird der Tracker am EINEN Telemetrie-Chokepoint
  (`agent.ocppObserve` aus `onLocalTelemetry`, derselbe gefilterte Komposit-Wert
  `power_kw`, den jeder andere Guard liest) — und beide Hälften des Regelgesetzes
  werden DORT gepaart, nicht erst zur Entscheidungszeit: die Netzmessung enthält
  den Zug der Säulen von genau diesem Moment. Ein Messwert, der ein deutlich
  kleineres Budget verlangt, weckt den Executor sofort (`rt.wake`); die Schwelle
  ist die halbe Ingenieurs-Marge, denn genau die absorbiert einen ungeplanten
  Bezug zwischen zwei Entscheidungen.
- Beweise: `internal/lastmgmt/budget_test.go` (18 reine Fälle) ·
  `internal/csms/chargingtotal_test.go` (7) ·
  `internal/agent/ocpp_dynamic_test.go` (7 — an den SÄULEN gemessen: die
  gepflegte Reserve wird durch die Messung ersetzt und das dritte Fahrzeug lädt;
  das Vergeben des Budgets schrumpft es nicht; ein Stecker ohne Messwert fällt
  zurück statt zu schwingen; die Reserve wird nicht doppelt abgezogen; §14a
  erreicht die Säule; der Lastsprung weckt sofort).

## Stufe 3: der Herzschlag trägt die Ladepunkte, und das Tor kennt sie

Die Box-Hälfte des eigenständigen Modus (Konzept `vp-ocpp-lastmgmt-konzept-w4`
§5, PR 9/10). Beides ist ADDITIV: eine Box ohne eine einzige eingetragene
Ladesäule sendet einen BYTE-GLEICHEN Herzschlag und sieht dieselben vier
Einrichtungs-Schritte wie vorher.

- **Der `chargers`-Block ist das ACHTE Geschwister** (`cloud.ChargersSummary`,
  gebaut von `agent.chargersSummary()` aus GENAU der Sicht, die die
  `:8484`-Karte rendert). Er **wiederholt die Worte der Box**, er formuliert
  nie neu: Budget, Ausfall-Profil, Zuteilungs-Gründe und jeder deutsche Satz
  entstehen EINMAL in `internal/lastmgmt` — zwei Renderings desselben Urteils
  könnten es sonst verschieden sagen, und nur die Box kennt die Zahlen dahinter.
  Gedeckelt (16 Säulen × 8 Stecker), fehlende Messwerte bleiben ABWESEND statt
  0, und `safe_default_holds` reist mit: ein `false` ist eine ANLAGEN-Tatsache,
  die kein Ladeprofil reparieren kann, und „hält" wäre eine bequeme Lüge über
  die Sicherung eines Kunden.
- **⚠ Das Einrichtungs-Tor fragt seit dieser Stufe „liefert IRGENDEINE
  Komponente Daten", nicht „liefert der Wechselrichter"** (Konzept §5.1): ein
  Ladepark hat gar keinen Wechselrichter, das alte Tor hätte ihn also für immer
  von der Kopplung ausgesperrt (`web.go` `deriveOnboarding` +
  `charge_point_connected` im Umschlag, `commissioning.js` Schritt 1/4). Die
  Regel wohnt EINMAL, als `state.Snapshot.HasReportedChargePoint()`, damit
  Weboberfläche und Herzschlag nicht in zwei Antworten auf eine Frage
  auseinanderlaufen.
- **⚠ Sie keyt auf „hat sich JE gemeldet", nicht auf den lebenden Socket:** ein
  Schritt, der bestanden war, darf nicht wieder zufallen, weil eine Verbindung
  flatterte — und eine BootNotification IST der Verbindungsnachweis einer
  Ladesäule (der „Verbindungstest" des Assistenten ist genau das).
- **Schritt 4 („Messwerte prüfen") liest auf einem Ladepark die SÄULEN**, nicht
  `last_telemetry`: dort misst kein Wechselrichter, das Feld bliebe für immer
  leer, und „noch keine Messwerte" wäre die falscheste aller Aussagen über eine
  Anlage, die gerade Autos lädt. Ohne Ladevorgang sagt es ehrlich „keine
  Ladevorgänge — keine Messwerte" statt einen Fehler zu behaupten.
- Beweise: `agent/ocpp_heartbeat_test.go` (die Reise über den ECHTEN Executor,
  „ohne Ladepunkte KEIN Block", abwesende Messwerte werden weggelassen statt
  genullt, die EINE Tor-Regel) · `web/web_test.go` (der Ladepark kommt durch
  das Tor OHNE je einen Wechselrichter zu behaupten, ein flatternder Socket
  sperrt nicht zu, eine Wechselrichter-Anlage bleibt byte-gleich) ·
  `web/jstest/ui.test.js` (die drei Schritt-Fälle inkl. „ohne Ladepunkte ändert
  sich KEIN Wort").
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Änderung den Core neu bauen.**

## Stufe 4: PV-ÜBERSCHUSSLADEN — die zweite Bahn desselben Verteilers

Der ZWEITE Eingang des EINEN Verteil-Mechanismus (Konzept §8 Stufe 4 / PR 13,
Mockups §2a/§2b): das Ladepark-Lastmanagement liefert die OBERGRENZE
(physisch, `budget.go`), das PV-Überschussladen die QUELLEN-Politik
(wirtschaftlich, `internal/lastmgmt/surplus.go`). **Die niedrigere Grenze
gewinnt, und keine von beiden kann die andere aufweichen.**

- **⚠ DIE VORGABE IST `schnell` = GAR KEINE QUELLEN-BAHN**, und das ist die
  Kompatibilitätszusage der ganzen Stufe: eine Anlage, deren Kunde die Karte
  nie geöffnet hat, verteilt byte-gleich wie in Stufe 1-3.
  `NormalizePolicy("")` und `NormalizePolicy("<unbekannt>")` liefern beide den
  NEUTRALEN Wert — eine Wahl, die wir nicht lesen können, darf weder eine
  RESTRIKTION erfinden (das strandete eine Flotte wegen eines kaputten Bytes)
  noch ein VERSPRECHEN. Der Schreibpfad (`Settings.Apply`) lehnt ein unbekanntes
  Wort dagegen BENANNT ab: dort tippt ein Betreiber, und ein stiller Rückfall
  ließe ihn glauben, er hätte etwas eingestellt.
- **⚠ Der Überschuss ist das `rest` des Budget-Trackers, keine zweite
  Messung.** `budget.go` paart Netz- und Ladeleistung längst; ist
  `rest = Netz − Laden` negativ, würde die Anlage einspeisen, und genau das ist
  der Überschuss: `max(0, −rest)`. PV, Gebäude und Speicher sind automatisch
  verrechnet, weil sie in dieser EINEN Zahl stecken. Dasselbe nachlaufende
  Fenster dient beiden Zwecken: ein MAXIMUM des Rests ist ein MINIMUM des
  Überschusses — konservativ in beide Richtungen mit einem Mechanismus.
- **⚠ Blind fällt in ENTGEGENGESETZTE Richtungen, je Politik**, weil die
  Versprechen entgegengesetzt sind: ohne frische Messung PAUSIERT „Nur
  Sonnenstrom" (wir können keinen Überschuss belegen), während „Sonne zuerst"
  gar nicht deckelt (sein Versprechen ist „zuerst", nicht „nur"). Beide sagen
  es in ihrem eigenen deutschen Satz. Nichts davon rührt die physische Bahn an.
- **Die Speicher-Arbitrierung ist EINE Subtraktion EINER gemessenen Größe:**
  `S = max(0, batt − rest)` ist der GANZE Überschuss, unabhängig von der
  aktuellen Aufteilung; `speicher_vor_auto` (Vorgabe = der gemessene Status
  quo) gibt den Fahrzeugen `max(0, −rest)`, `auto_vor_speicher` gibt ihnen `S`.
- **⚠ „Auto vor Speicher" ist nur eine REGEL, weil der Speicher geklemmt wird**
  (`BudgetTracker.StorageChargeCap` → `Agent.OcppBatteryChargeCap` →
  `applySetpoint`). Ohne die zweite Hälfte beanspruchten Speicher und Autos
  dieselben Kilowatt und die Anlage kaufte die Differenz — genau das, was „Nur
  Sonnenstrom" verspricht nie zu tun. Die Klemme ist **restrict-only und
  lade-only** (hebt nichts an, rührt keine Entladung an, dreht keine Richtung
  um), also halten Nennband, SoC-Fenster, EEG-Solar-Klemme und §14a erst recht;
  sie läuft NACH `guards.SurplusCharger` (mit cars-first gehört dieser
  Überschuss nicht dem Speicher) und ist ohne Kundenwahl, ohne ladendes
  Fahrzeug oder ohne frische/vollständige Messung INAKTIV — eine blinde Klemme
  wäre eine Vermutung über den Speicher eines Kunden. Sie wird auf der
  Steuerungs-Karte BENANNT (`control.js deriveCarsFirst`): eine unbenannte
  Begrenzung liest sich wie ein Defekt.
- **„Jetzt voll laden" übersteuert die ÖKONOMIE, nie die PHYSIK.**
  `Session.BoostUntil` nimmt eine Sitzung von der Quellen-Bahn aus; Budget,
  Sicherheitsabstand, §14a und das Ausfall-Profil binden sie unverändert. Sie
  ändert den Vorrang-RANG NICHT — weil sie aber gar nicht um denselben Topf
  konkurriert, wird sie innerhalb ihres Ranges zuerst bedient (das „wirkt wie
  temporärer Vorrang mit Quelle-egal" der Mockups). Sie gilt GENAU EINER
  Transaktion (eine neue Sitzung am selben Stecker ist ein anderes Fahrzeug und
  erbt sie nie), höchstens `lastmgmt.BoostMaxDuration` (4 h), und sie wird
  **bewusst NICHT persistiert**: eine Box, die nach einem Neustart Stunden
  später still weiter Netzstrom kauft, gäbe ein Versprechen, das niemand
  gemacht hat.
- **Ein pausierendes Fahrzeug nennt den HEBEL:** `ReasonNoSurplus` ist ein
  eigenes Wort neben `ReasonBudget` (die Anschlussgrenze WÜRDE es bedienen —
  es ist die eigene Priorität des Kunden), und `lastmgmt.TextFor` hängt die
  gewählte Priorität an den Satz.
- **Die Fläche zeigt BEIDE Wahrheiten** (`ocpp.js sourceCapLine`): „110 kW aus
  Sonnenüberschuss · physisch möglich 197 kW" — ohne beide läse die Drosselung
  an einem freien Anschluss wie ein Defekt.
- Beweise: `internal/lastmgmt/surplus_test.go` (12) + `source_test.go` (11) ·
  `internal/agent/ocpp_surplus_test.go` (7, AN DEN SÄULEN gemessen) ·
  `internal/web/jstest/ui.test.js` + `web_test.go` (Seiten-Struktur, Route).
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Änderung den Core neu bauen.**

## Stufe 3: die Anschlussgrenze kann aus dem PORTAL kommen (`internal/chargingcfg`)

Der Konsument des retained Dokuments `ems/{t}/{s}/{d}/v2/charging-config`
(Kontrakt `docs/contracts/mqtt-charging-config.schema.json`). Additiv: eine Box,
der niemand ein Dokument schickt, verhält sich zeichengleich wie vorher.

- **Es kommt eine EINSTELLUNG an, nie eine Grenze.** Der Verteiler rechnet
  danach wie immer in `internal/lastmgmt` — die Anschlussgrenze ist eine
  physische Grenze, ihr Wächter darf nicht am WAN hängen (E1). `agent/
  charging_config.go` ist reine Verdrahtung: jede Regel liegt im reinen
  `internal/chargingcfg` (Parsen + Plausibilität) bzw. in `lastmgmt`.
- **⚠ PATCH-Semantik: ein ABWESENDES Feld behält den Wert der Box.** Das Portal
  besitzt heute nur die Anschlussgrenze und die Vorrang-Wahl; Sicherheitsabstand,
  Mindestleistung und die höchste bekannte Gebäudelast bleiben `:8484`-
  Einstellungen. Eine LEERE Vorrang-Liste ist dagegen eine AUSSAGE („keine Säule
  hat Vorrang") und wird angewandt — sonst wäre „niemand mehr" unaussprechbar.
- **Eine Grenze ≤ 0 wird ABGELEHNT, nicht angewandt:** ohne Grenze ist das
  Budget 0 und es lädt nichts, und das käme dann aus einem Tippfehler. Ebenso
  fail-closed: eine fremde Vertragsversion, unlesbare Bytes, eine fremde
  Identität (Topic == Payload, die Regel jedes Downlinks; stumm zum Broker,
  laut im Protokoll).
- **Die RÜCKNAHME (leere retained Nachricht) lässt die übernommenen Werte
  STEHEN.** Sie zurückzusetzen wäre eine Änderung an einer laufenden Anlage, die
  niemand angeordnet hat — und die Box wüsste auch nicht, worauf. Von da an gilt
  wieder allein, was auf `:8484` gepflegt wird.
- **Bekannte Grenze:** `:8484` bleibt editierbar, es gilt also last-writer-wins,
  und ein retained Dokument setzt sich beim nächsten Verbindungsaufbau wieder
  durch. Ein Nur-Lese-Spiegel wie bei der Komponenten-Autorität ist Folgearbeit.
- Beweise: `internal/chargingcfg` (7, inkl. der Kontrakt-Fixtures per PFAD) ·
  `agent/charging_config_test.go` (3: die PATCH-Wirkung samt Vorrang-Rücknahme,
  fremdes/kaputtes Dokument ändert NICHTS, eine Box ohne OCPP überlebt es).
- **Seit Stufe 4 trägt dasselbe Dokument die QUELLEN-Wahl** (`surplus_policy`
  / `storage_priority`, beide additiv und OPTIONAL). **⚠ `nil` heißt „das Portal
  sagt dazu nichts" und ist NIE `schnell`** — sonst nähme das erste gespeicherte
  Dokument einer Box still ihre auf `:8484` gepflegte Politik weg; ein
  unbekanntes Wort lehnt dagegen das GANZE Dokument ab (fail-closed wie jede
  andere Form-Verletzung). Angewandt wird beides über EINEN
  `OcppSaveSettings`-Aufruf zusammen mit der Grenze — zwei Aufrufe wären zwei
  Zwischenzustände.
- **Seit Geräteseiten Stufe 3 (E1) trägt dasselbe Dokument die ALLOWLIST**
  (`charge_points[]`, additiv und OPTIONAL): das Portal ist damit ein zweiter
  PFLEGE-Ort für die Kennungen, unter denen `internal/csms` eine Säule überhaupt
  annimmt. **Es ist KEIN Anlern-Fenster** — eine unbekannte Kennung wird
  weiterhin abgewiesen und protokolliert.
  - **⚠ `applyChargePoints` FÜGT NUR HINZU** (`agent/charging_config.go`): keine
    bekannte Kennung wird überschrieben, und ein WEGGELASSENER Eintrag entfernt
    nie etwas. Das ist der Grund, warum eine Rücknahme AUSDRÜCKLICH sein muss
    (nächster Punkt): eine Box, die beim Speichern offline war, darf ihre
    Kennungen nicht verlieren, weil ein späteres Dokument sie nicht aufzählt.
    Ein abgewiesener Eintrag (Rate, Form) wird protokolliert und übersprungen,
    nie stillschweigend verschluckt.
  - **⚠ Die RÜCKNAHME ist eine eigene Liste — `removed_charge_point_ids`, seit
    dem 24.08.2026** (Captain-Order; additiv, `schema_version` bleibt 1.0).
    `applyChargePointRemovals` läuft NACH `applyChargePoints` und VOR dem
    Vorrang, entfernt nur, was diese Box wirklich KENNT (`csms.Remove` trennt
    die Verbindung, ein Wiederverbinden wird abgewiesen), protokolliert jede
    Rücknahme und ist idempotent — der Grabstein reist in JEDEM folgenden
    Dokument mit und darf nicht bei jedem Takt etwas tun.
  - **⚠ Bei einem WIDERSPRUCH gewinnt die Rücknahme:** steht eine Kennung in
    beiden Listen, streicht `chargingcfg.Parse` sie aus `ChargePoints`, BEVOR
    irgendetwas zugelassen wird — ein Dokument, das eine gerade gelöschte
    Kennung wieder einträgt, darf sie nicht durch die Hintertür zurückbringen.
  - **Ein ÄLTERER Box-Stand tut nichts Falsches:** Gos `encoding/json` überliest
    das unbekannte Feld, die Säule bleibt zugelassen — der vorige Zustand, nie
    eine falsche Handlung. Die Rücknahme wirkt damit erst mit dem NÄCHSTEN
    Edge-Release, und das Portal sagt das auch.
  - **⚠ Die Allowlist wird VOR dem Vorrang angewandt**, sonst bekäme eine gerade
    eingetragene Säule den Vorrang DESSELBEN Dokuments erst beim nächsten
    Speichern. Deshalb trägt der Umschlag auch kein `priority` je Zeile: die
    Vorrang-MENGE ist die ganze Aussage, zwei Wahrheiten über denselben Rang
    wären eine zu viel.
  - **Eine LEERE Liste ist hier KEINE Aussage** (anders als beim Vorrang, der
    eine Menge ERSETZT) — sie wird deshalb gar nicht erst gesendet.
- **Der Herzschlag nennt seit E1 den EIGENEN Anschluss** (`ocpp_port`/`url_path`
  im `chargers`-Block, aus `csms.Snapshot`): daraus baut das Portal die
  `ws://`-Adresse zum Kopieren. **⚠ Beide werden WEGGELASSEN, solange der Server
  nicht lauscht** — ein Anschluss, unter dem niemand antwortet, wäre schlimmer
  als gar keiner.

## Stufe 4: die FAHRPLAN-Bahn — der Plan reicht eine OBERGRENZE herunter

Die dritte Bahn desselben Verteilers (Captain-Entscheid „Weg A" vom
20.08.2026). Physisch begrenzt der Anschluss (`budget.go`), wirtschaftlich die
Quellen-Wahl (`surplus.go`) — und der FAHRPLAN reicht ein Ziel herunter, das
die Box allein nicht kennen kann. **Alle drei komponieren
most-restrictive-wins, und keine kann eine andere aufweichen.**

- **⚠ STRIKT FAIL-OPEN, und das ist die tragende Zusage:** kein Plan, ein
  VERALTETER Plan, kein Ziel im Plan, kein Lastspitzen-Zähler oder keine
  Messung am Netzanschluss ⇒ die Bahn wird ABGERÄUMT und die lokale Logik gilt
  unverändert. **Ein Fahrzeug darf NIE wegen eines fehlenden Plans stehen
  bleiben; im Zweifel lädt es.** Die Ablauffrist (`PlanLimitFreshWindow`) ist
  die zweite Hälfte davon: ein Deckel, den niemand mehr auffrischt, ist keiner
  — ein steckengebliebener Aufrufer kann keine Anlage drosseln.
- **⚠ Die Frische-Regel weicht BEWUSST von der des Batterie-Wächters ab.**
  `plan.PeakImportLimit` ist dort staleness-UNABHÄNGIG, weil das Verteidigen
  eines alten Ziels dort nichts kostet (es verschiebt nur Batterieleistung).
  Hier könnte dasselbe alte Ziel ein Auto stehen lassen — also gilt es nur,
  solange der Plan frisch ist (`p.Fresh(now)`, dieselbe Staleness wie der
  Plan-Ausführer: „der Plan gilt" heisst auf dieser Box EINE Sache).
- **Getragen wird genau EINE Grösse: das Lastspitzen-ZIEL.** Anschlussgrenze
  und §14a-Hülle hat die Box längst selbst (Einstellung + beobachtete Hülle),
  und die Einspeisegrenze ist eine Export-Schranke und kann das Laden gar
  nicht begrenzen. Das Ziel dagegen kennt nur die Cloud — und ohne diese Bahn
  konnte der Ladepark genau die Spitze sprengen, die die Batterie daneben
  teuer hält (PS-3).
- **Die Umrechnung ist geteilt, nicht nachgebaut:**
  `guards.PeakTracker.AllowedImport` macht aus dem Viertelstunden-MITTEL, was
  der Standort im REST dieser Viertelstunde noch ziehen darf — dieselbe
  Projektion, die der Batterie-Wächter benutzt, also verteidigen beide
  Instrumente EINE Zahl. Der Anteil der Fahrzeuge daran ist
  `max(0, erlaubt − Rest des Standorts)`, wortgleich die Rechnung der
  physischen Bahn.
- **⚠ Der Deckel wirkt NUR im gemessenen Zweig und nur nach unten.** Die
  statischen und blinden Stufen bleiben unberührt (fail-open by construction),
  ein weiterer Deckel hebt nichts an, und eine unlesbare Zahl räumt die Bahn ab
  statt „null Kilowatt" zu bedeuten.
- **Er NENNT sich** (`budget_note` + `ocpp.js planCapLine`), aber nur wenn er
  wirklich bindet: eine Begrenzung ohne Namen liest sich wie ein Defekt (die
  Canary-Soak-Lehre), und eine, die gerade nicht greift, ist keine Auskunft.
- **Bewusst NICHT dabei:** das v2-Plan-Ziel (`peakTargetV2`) — die v2-Planung
  ist ein Schattenlauf ohne eine einzige geflaggte Anlage, und der
  Batterie-Wächter verteidigt es ohnehin. Wer sie scharfschaltet, nimmt sie
  hier mit auf, mit ihrer EIGENEN Frische.
- **⚠ Ein Test über diese Bahn hängt AN DER UHR, wenn man ihn naiv schreibt.**
  Die Projektion ist `(Ziel·900 s − bisher Bezogenes) / Restsekunden`: eine
  RUHIGE Viertelstunde erlaubt kurz vor ihrem Ende völlig zu Recht ein
  Vielfaches des Ziels (der MITTELWERT ist die Grösse, nicht der Augenblick),
  also band der Deckel je nach Tageszeit oder eben nicht — zwei Paket-Timeouts,
  bis es auffiel. Der Ausweg ist physikalisch statt kosmetisch: läuft der
  Standort die bisherige Viertelstunde GENAU auf dem Ziel, kürzt sich der
  Fortschritt heraus und die Projektion ist exakt das Ziel, an jeder Sekunde
  (`feedAtTheTarget`, belegt von
  `TestTheProjectionIsExactlyTheTargetWhenTheSiteRanAtIt` samt Gegenprobe).
  **Wer hier einen Fall ergänzt, füttert den Zähler so — oder prüft etwas, das
  nicht an der Projektion hängt.**
- Beweise: `internal/lastmgmt/planlane_test.go` (7 reine Fälle: verengt,
  hebt nie an, Abräumen, Ablauf, blinde Stufen unberührt, überzogene
  Viertelstunde pausiert statt negativ, kaputte Zahl fällt offen aus) ·
  `internal/agent/ocpp_planlane_test.go` (4 an den SÄULEN: der Deckel kommt am
  Ladeprofil an, ein VERALTETER Plan hält kein Fahrzeug zurück, ein Plan ohne
  Ziel ist byte-gleich, ohne Messung greift er nie) — die zwei tragenden Regeln
  (fail-open bei Staleness, restrict-only) sind mutationsgeprüft, und die
  Uhr-Unabhängigkeit ist ein eigener Fall.

## Stufe 4: „Jetzt voll laden" kommt als EINMAL-Freigabe aus dem Portal (`internal/chargingboost`)

Der Konsument von `ems/{t}/{s}/{d}/v2/charging-boost` (Kontrakt
`docs/contracts/mqtt-charging-boost.schema.json`). Er fügt **keinen neuen
Mechanismus** hinzu: er ruft `Agent.OcppBoost` — genau das, was die
`:8484`-Taste ruft.

- **⚠ NICHT-RETAINED, und `requested_at` ist die zweite Hälfte.** Eine retained
  Übersteuerung würde bei JEDEM Verbindungsaufbau erneut zugestellt und wäre
  keine Einmal-Freigabe; weil die Box eine DAUERHAFTE Sitzung hält, darf der
  Broker sie zusätzlich nachliefern — also übernimmt die Box den Stempel als
  Beginn ihres Fensters (`chargingboost.Window`, 2 min) statt des
  Empfangs-Zeitpunkts. Eine nachgelieferte Freigabe ist bei der Ankunft
  ABGELAUFEN und wird abgelehnt statt ausgeführt (das OTA-Apply-Muster).
- **Vier Ablehnungen, alle stumm zum Broker und laut im Protokoll:** fremde
  Identität (Topic == Payload), abgelaufenes Fenster, fremde Vertragsversion,
  unlesbare Bytes. `ExpiredMessage` nennt BEIDE Uhren — eine auseinander
  gelaufene Uhr ist sonst strukturell unsichtbar.
- **Die POLITIK bleibt auf der Box:** ob es diesen Stecker gibt, ob dort eine
  Sitzung läuft und wie lange die Freigabe höchstens gilt
  (`lastmgmt.BoostMaxDuration`, 4 h), entscheidet `Agent.OcppBoost` — die Cloud
  nennt nur Stecker, Wunsch und Dauer. `cancel: true` nimmt sie zurück.
- Beweise: `internal/chargingboost` (7, inkl. der Kontrakt-Fixtures per PFAD) ·
  `agent/charging_boost_test.go` (5: der Durchlauf durch den GETEILTEN Kern,
  die vier Ablehnungen, die Rücknahme).

## Die Box meldet ihre Adresse im KUNDEN-LAN — getrennt vom Zugriffsweg

`internal/netinfo` + `agent/network.go` (Konzept `data/vp-anlagen-zentrale-konzept-h6`
D5). Sie beantwortet die eine Frage, die der Container über sich selbst nie
sagen konnte: unter welcher Host-Adresse ist er im Kundennetz erreichbar? **Reine
ANZEIGE — es entsteht kein Schreibweg und keine Entscheidung.**

- **⚠ `net.Interfaces()` ist hier die FALSCHE Antwort.** Der Core läuft in einem
  bridge-vernetzten Container mit veröffentlichten Ports, seine Schnittstelle
  trägt also die Docker-Bridge-Adresse (172.x) — wahr über den Container,
  nutzlos für den Kunden. Sie als „Adresse Ihrer Box" zu melden wäre eine
  erfundene Antwort. Gemeldet wird sie deshalb NUR, wenn der Prozess NICHT in
  einem Container läuft (`/.dockerenv` bzw. cgroup), und bei mehreren
  Kandidaten GAR KEINE.
- **Die Antwort kommt vom HOST:** `install.sh` liest zuerst die Source-Adresse
  der IPv4-Default-Route, verwirft WireGuard-/Tunnel-/Tailscale-/Docker-Interfaces
  und schreibt sie samt Web-Port als `VP_LAN_HOST`. Der Betreiber darf den Wert
  fuer statische/ungewoehnliche Netze explizit setzen. Core UND Updater erhalten
  ihn, damit ein autonomes Compose-Update ihn nicht verliert.
- **Der HTTP-`Host`-Kopf ist nur noch ein Legacy-Fallback:** Dockers DNAT laesst
  ihn zwar unveraendert, aber ein Supporter kann `:8484` ueber das VPN aufrufen.
  Dieser Zugriff ist dann wahr, aber fuer den Kunden unbrauchbar.
  `agent.WebObserver` speichert ihn weiter getrennt; ein beobachtetes
  `10.10.x.x` darf `VP_LAN_HOST=192.168.x.x:8484` nie ueberschreiben.
- **`network.lan_host` wird strenger gefiltert:** nur private/link-lokale
  IPv4/IPv6-Adressen oder `.local`/`.lan`/`.home.arpa`-Namen inklusive gueltigem
  Port. **Beim beobachteten Host verworfen wird, was kein Zweiter tippen kann:** Loopback und `localhost`
  (genau das schickt der Installer-Selbsttest bei jedem Start), ein leerer Wert
  und ein PUNKTLOSER Hostname (`voltpilot` — er löst nur in fremden Suchdomänen
  auf). Alles andere reist VERBATIM inklusive Port.
- **`<data>/network.json` (tmp+rename, EIN Schreiber)** lässt die Adresse einen
  Neustart überleben — sonst wäre sie nach jedem Update genau dann unbekannt,
  wenn jemand sie sucht. Älter als 14 Tage gilt sie nicht mehr: eine falsche
  Adresse schickt einen Menschen auf eine Seite, die nicht antwortet.
- **Der Block hängt am LINK, nicht an einem Aufruf-Argument** (`cloud.Options.NetworkFn`,
  das `Version`-Muster) — kein künftiger Aufrufer kann ihn vergessen, und die
  Antwort ändert sich (DHCP, oder der erste Aufruf der lokalen Oberfläche).
  `NetworkSummary` traegt `lan_host` und den beobachteten `host` GETRENNT.
  **Weiß die Box nichts, wird GAR KEIN Block gesendet** und der Herzschlag
  bleibt byte-gleich zu vorher.
- **Bewusst NICHT gebaut:** die `:8484`-Fläche zeigt die Adresse nicht (wer dort
  ist, hat sie gerade benutzt). Die naheliegende Folgearbeit ist der
  OCPP-Anbinden-Dialog, der bis heute keine Box-Adresse nennen kann.
- Beweise: `internal/netinfo/netinfo_test.go` · `agent/network_test.go` (LAN
  gewinnt gegen VPN-Serviceaufruf) ·
  `cloud/status_test.go` (die Draht-Form gegen einen echten In-Process-Broker).

## ⚠ `Bus.Close()` umgeht mochi-mqtts SHUTDOWN-DEADLOCK (echter CI-Ausfall 2026-08-26)

`mochi-mqtt/server/v2` verklemmt seinen EIGENEN Shutdown, sobald ein Client
abfällt, während `Server.Close()` läuft - in v2.7.9 **und in jeder früher
veröffentlichten Fassung**, es gibt also nichts, worauf man hochziehen könnte:
`Clients.GetByListener` hält die Lese-Sperre der Client-Karte und ruft darin
`Clients.Len()`, das dieselbe Sperre ERNEUT nimmt. Gos `sync.RWMutex` verbietet
genau diese Rekursion, sobald ein Schreiber wartet (sonst könnte man ihn
aushungern) - und der Schreiber ist das völlig gewöhnliche
`Clients.Delete` NACH dem Verbindungsabbruch eines beliebigen Clients. Beide
Goroutinen warten dann FÜR IMMER.

- **Das ist kein Test-Problem.** Denselben `Close()` ruft `Agent.Stop()` auf
  jedem Gerät, mit Node-RED als dem abfallenden Client.
- **Der Ausweg nimmt die deadlockende Aufrufstelle aus dem Spiel, statt ihr
  Rennen zu umgehen** (`internal/localbus` `Bus.Close`): erst den Listener
  SELBST schließen und seine Clients über einen Lauf trennen, der nie
  rekursiv sperrt (`Clients.GetAll` kopiert unter EINER RLock) - `TCP.Close`
  schützt seinen Client-Lauf mit `CompareAndSwapUint32(&l.end, 0, 1)`, also
  überspringt der danach laufende Bibliotheks-`Close()` `GetByListener`
  vollständig. Auf die Client-Goroutinen wartet er weiterhin
  (`Listeners.CloseAll` endet in `ClientsWg.Wait()`), es leckt also nichts, und
  jeder Client bekommt sein gewohntes „server shutting down"-DISCONNECT.
- **Der Wächter prüft die REIHENFOLGE, nicht den Hänger**
  (`TestCloseShutsTheListenerDownBeforeHandingOverToTheLibrary`): die Klemme
  selbst braucht eine Entfernung in einem nanosekundenschmalen Fenster, ein
  Test darauf allein wäre also ein Münzwurf. Beobachtbar ist dagegen exakt,
  worauf der Fix beruht - die Bibliothek protokolliert „gracefully stopping
  server" als ERSTES in ihrem `Close()` und schliesst den Netz-Listener erst
  weiter unten. Mit dem Fix nimmt zu dieser Zeile schon nichts mehr an; mit
  einem nackten `b.server.Close()` steht der Port offen, und genau in diesem
  Zustand kann ein abfallender Client die Abschaltung endgültig verklemmen.
  Daneben steht `TestCloseReturnsWhileClientsAreDropping` als
  Lebendigkeits-Probe.
- **⚠ Dieselbe Bibliothek hat ZUSÄTZLICH ein Datenrennen zwischen ANNEHMEN und
  `Close()`** (`Server.NewClient` liest `s.done` in server.go:401, `Close`
  schliesst es in server.go:1499) - von diesem Fix unberührt. Wer hier einen
  Test schreibt, der WÄHREND der Abschaltung neue Verbindungen aufbaut, wird
  unter `-race` sporadisch rot, und zwar aus diesem fremden Grund; die Wächter
  hängen ihre Clients deshalb VORHER an.
- **Symptom-Erkennung im CI:** ein `panic: test timed out` im Paket
  `internal/agent`, dessen Stapel `localbus.(*Bus).Close` in einem `t.Cleanup`
  zeigt (`inverter_test.go` `startBusOnlyAgent`), plus eine zweite Goroutine in
  `attachClient` → `Clients.Delete`. Das ist DIESER Deadlock, kein langsamer
  Testlauf.

## Wechselrichter-Automatik: der Sollwert wird ABGEGEBEN, die Aufsicht NIE

Der Selbstregel-Modus (Konzept: firstmate `vp-verbrauch-decken-selbstregel`;
Captain-Entscheide 26.08.2026). In einem Slot, den die WOLKE als „Verbrauch
decken lohnt sich" markiert, hört die Box auf, alle 10 s einen Sollwert zu
schreiben, und übergibt die Regelung an die Eigenverbrauchs-Schleife des
Wechselrichters. **Kein Vertragsfeld** — die Wolke sagt längst, OB Decken
ökonomisch ist; WIE es ausgeführt wird, war immer eine Edge-Entscheidung.

- **⚠ DER SATZ, an dem alles hängt: „selbst regeln" heisst SOLLWERT WEGLASSEN,
  NICHT AUFSICHT WEGLASSEN.** Die Guard-Kette schützt einen Wert, den wir
  KOMMANDIEREN; ohne kommandierten Wert wird jeder Guard, der bisher über den
  Sollwert biss, zu einer BEOBACHTUNG mit RÜCKNAHME. Die Regel ist rein
  (`core/internal/guards/nativemode.go`, jede Funktion nimmt ihr `now` — das
  `otaapply`/`calibration`-Muster), `agent/native.go` ist nur Verdrahtung.
- **⚠ DIE ZWEITE TEILUNG, INNERHALB der Edge, ist der Grund für die
  Beweis-Schleife:** der KERN kennt Slot-Pflicht, Messwerte, Reserve-Boden und
  Lastspitzen-Budget — aber nur LAYER 1 kennt die Registerkarte und damit, ob
  dieses Modell+diese Firmware überhaupt eine Prüfstand-Freigabe hat
  (`nodered/unplanned-load-native.js`). Der Kern veröffentlicht deshalb eine
  ABSICHT (`battery_mode: "native"` auf `edge/setpoint`, additiv — ABWESEND =
  `setpoint` = byte-identisch zu vorher), und Layer 1 antwortet mit einem BELEG
  (`mode: "native"` auf `edge/control/readback`). **Eine Absicht, die nie
  bestätigt wird, wird nach einer begrenzten Frist ZURÜCKGENOMMEN** — sonst wären
  „wir haben aufgehört zu schreiben" und „wir sind tot" derselbe Zustand
  (Risiko 5 des Scouts). Nur ein BESTÄTIGTER Modus wird der Cloud als
  `execution.mode = autonomous_discharge` gemeldet.
- **Die Rücknahme-Gründe sind ein GESCHLOSSENES Vokabular mit je einem deutschen
  Satz** (`guards.NativeReasonText`) — eine Verweigerung, die niemand benennt,
  liest sich wie ein Defekt (die Canary-Soak-Lehre, auf den Sollwert-Pfad
  angewandt).
- **⚠ RÜCKNAHME vs. VERWEIGERUNG, und der Unterschied ist absichtlich:** eine
  RÜCKNAHME (Reserve-Boden, veraltete Messung, verlorenes Rücklesen, bedrohte
  Lastspitze, fehlender Nachweis) ist ein EREIGNIS auf einem flatternden Kanal
  und wird für den REST DES SLOTS gemerkt — ein Wiedereintritt würde den Modus
  des Geräts im 10-Sekunden-Takt umschalten. Eine VERWEIGERUNG (Anlagen-Pause,
  der Betreiber-Schalter) ist ein ZUSTAND, den jemand bewusst gesetzt hat: fällt
  er weg, ist sofortiges Wiederaufnehmen genau das Gewollte.
- **⚠ Die Lastspitzen-Frage keyt auf den ZÄHLER, nicht auf eine Korrektur**
  (`guards.NativePeakThreat` + `PeakTracker.HeldImport`): „würde PeakShave den
  Referenzwert senken?" könnte in einem Deckungs-Slot nie feuern (der Referenzwert
  treibt das Netz ohnehin auf 0), die Aufsicht wäre also dekorativ.
- **⚠ EEG: die Netzlade-Sperre wandert in die GERÄTE-Konfiguration**, sobald wir
  aufhören zu kommandieren. Das Gerät muss es also BELEGEN (`gridChargeProof` je
  Adapter, im Rücklesen als `native.grid_charge_blocked`); Schweigen zählt als
  NICHT belegt. Ein Tier ohne solches Register wird auf einer EEG-Anlage
  verweigert, statt zu hoffen.
- **Der Adapter-Primitive ist der RELEASE-Plan seines Tiers PLUS ein
  Zustands-Rücklesen als Beleg — einmal schreiben, dann nur lesen**
  (`nodered/inverter-control-routing.js` `nativeSelfConsumption`; Sequenzen,
  Beleg-Register und was der Prüfstand noch beweisen muss: die vier Adapter-Docs
  + `UNPLANNED-LOAD-BENCH.md`). **Deye ToU ist bewusst NICHT unterstützt**
  (EEPROM-Wechsel, ~20 s Latenz — „nativ" kostete dort mehr, als es spart).
- **⚠ Die ABREGELUNG ist NICHT Teil der Übergabe:** der Modus betrifft die
  BATTERIE; die Einspeise-Kappe des Slots ist ein eigenes, wolken-eigenes
  Kommando, und sie einzufrieren liesse eine Drosselung ihren Slot überleben.
  Sie reitet als GEWÖHNLICHER Schreibbefehl mit (am gewöhnlichen Steuer-Tor, nie
  am Zertifikat) und gehört zur Einmal-Signatur, damit eine GEÄNDERTE Kappe neu
  geschrieben wird.
- **Das Zertifikat ATTESTIERT die Bytes des Adapters, es definiert sie nicht**
  (`certificateMatchesPlan`): driften Prüfstands-Aufzeichnung und ausgelieferter
  Adapter auseinander, wurde an diesem Gerät nichts gemessen ⇒ Verweigerung. Der
  Deye-Interlock fällt nur per Eintrag, mit `interlockLifted: 'deye'` UND einem
  benannten `benchRecord` — nie durch Löschen des Zweigs.
- **⚠ `SIMULATOR_NATIVE_CAPABILITIES` zertifiziert SOFTWARE, nie ein Gerät.** Sein
  Tripel (`generic_modbus` / `sunspec-sim` / `sim`) kann nur den Simulator treffen,
  und er ist ausschliesslich im SIMULATOR-Tab verdrahtet (dessen Auswahl ein
  fester Literal ist). Der Auto-Tab reicht den PRODUKTIONS-Katalog durch.
- **⚠ DER PRODUKTIONS-KATALOG TRÄGT SEIT DEM 26.08.2026 GENAU EINEN EINTRAG: den
  Deye-Piloten** (Captain-Entscheid „kein separater Prüfstand — der Pilot IST der
  Prüfstand"). Gebunden an `deye` + die KATALOG-MODELL-ID `sun-30k-sg01hp3` + die
  vom GERÄT gesondete PR-978-Registerlage — **nicht an die Familie und nicht an
  einen getippten Firmware-String**: `nativeSelectionKey` nimmt die
  `firmwareEvidence` des Tiers (`DEYE_REMOTE_PR978_FIRMWARE`) VOR
  `connection.firmware`, also stoppt ein Firmware-Update, das den Block 1100-1121
  entfernt, die Freigabe von selbst, und ein alter String im gespeicherten
  Verbindungssatz kann sie weder erschleichen noch blockieren. Der Deye-Interlock
  ist damit NICHT gefallen — er ist per Eintrag gehoben (`interlockLifted` +
  `benchRecord`), jedes andere Deye-Modell fällt weiter durch ihn.
- **⚠ Und die Freigabe allein reicht nicht: `deyeNativePrecondition` verweigert
  zur LAUFZEIT**, wenn die EIGENE Konfiguration des Wechselrichters die Deckung
  nicht hergibt — Zeitfenster-Programm nicht aktiv (Deye-Handbuch: ohne ToU
  entlädt er nicht in die Hausanschlüsse), Ziel-Ladeniveau über der
  Reserve-Untergrenze, oder auf einer EEG-Anlage eine Program-1-Charging-Enum
  ungleich `Disabled`. **Unbekannt zählt als Verweigerung** — die Aufsicht könnte
  diesen Fall nicht fangen (das Gerät meldet den Modus korrekt, es deckt nur
  nicht). Die Registerliste dafür steht als `preconditions` auf dem Ergebnis: ein
  Executor liest sie VOR der Übergabe und reicht die Werte als `deyeOwnConfig`
  zurück.
- **DER DEYE-AUSFÜHRUNGSPFAD (26.08.2026): `nativePlanDeye` + die zwei Lesungen
  des Executors.** Der Plan-Knoten deckt seit dieser Runde ZWEI Tiers ab —
  `nativePlanGeneric` (modbus_tcp/SunSpec) und `nativePlanDeye` (die
  Fernsteuer-Registerlage), beide synchron gehaltene Kopien von
  `nativeSelfConsumption` und beide von `flows-sync.test.js` gegen das Modul
  gepinnt. HINEIN = **ein** Schreibvorgang `1100 <- 0`, danach nur noch Lesen;
  HINAUS = der unveränderte gewöhnliche Fernsteuer-Plan (`1101`, `1104`, `1105`,
  `1109`, `1100 <- 1` ZULETZT). Es gibt keine zweite Rücknahme-Sequenz.
- **⚠ DIE VORBEDINGUNG GREIFT VOR DER ÜBERGABE, und sie braucht eine Lesung, die
  ein Plan-Knoten nicht machen kann.** Deshalb liest der **Executor** die drei
  Register (`0x0092` Zeitfenster-Freigabe, `0x00A6` Ziel-Ladeniveau, `0x00AC`
  Program-1-Charging) auf jedem Takt, an dem eine Absicht auf Selbstregelung
  steht — **vor jedem Schreibvorgang dieses Zyklus** — und legt sie je Logger
  unter `deye_native_cfg:<host:port>` (flüchtig, wie `deye_cap:`) ab; der
  Plan-Knoten urteilt daraus mit der synchron gehaltenen Kopie von
  `deyeNativePrecondition`. **Nicht gelesen = nicht bekannt = Verweigerung**, mit
  deutschem Grund. Folge, die man kennen muss: der ERSTE Takt eines Decken-Slots
  verweigert ehrlich („die eigene Konfiguration … ist nicht bekannt"), der zweite
  schaltet um — weit innerhalb der Nachweisfrist des Kerns (~60 s). Und der Stand
  ist nie älter als EIN Takt, weil er in jedem native-Takt neu gelesen wird; ein
  Wechsel der Geräte-Konfiguration innerhalb dieser 10 s wird also erst vom
  nächsten Takt bemerkt, der die Batterie dann zurückholt.
- **⚠ `mode: "native"` wird NUR gemeldet, wenn `1100` wirklich 0 zurückliest.**
  Alles andere ist kein Beleg und wird als gewöhnlicher Zyklus veröffentlicht —
  der Kern sieht keine Bestätigung und nimmt die Batterie nach seiner Frist
  zurück (`nachweis_fehlt`). Nur ein belegter Takt liest zusätzlich den
  `gridChargeProof` und veröffentlicht ihn als `native.grid_charge_blocked`;
  sein FEHLEN heißt „das Gerät hat nichts gesagt" und zählt auf einer EEG-Anlage
  als nicht belegt (dieselbe Dreiwertigkeit wie im generischen Executor).
- **Ein stehender Grund wird EINMAL gesagt, nicht alle 10 s.** Der Plan-Knoten
  merkt sich den letzten Verweigerungs-Grund und schreibt nur bei einer
  ÄNDERUNG eine Zeile — ein Wechselrichter mit abgeschaltetem Zeitfenster-Programm
  füllte sonst das Protokoll für den ganzen Slot und begrübe genau die Zeilen,
  die die Beobachtungs-Checkliste liest. Der Knoten-Status trägt den Zustand
  ohnehin durchgehend.
- **Die `:8484`-Betriebsseite nennt den Modus** (`control.js deriveNative`): die
  Begründungszeile liest „Wechselrichter-Automatik (hält)" bzw. „… angefordert",
  hält also „gewollt" und „bestätigt" auseinander, und sie steht **an erster
  Stelle** der Begründungskette — solange die Automatik hält, wird gar kein
  Sollwert geschrieben, und eine Zeile über Nachführung/Begrenzung erklärte einen
  Wert, den niemand gesendet hat.
- **Der Simulator hat dafür ein Eigenverbrauchs-Modell bekommen**
  (`edge/sim/sunspec-sim.js`): bei `setpoint_enable = 0` folgt die Batterie
  `pv - load`, sonst dem Sollwert. Vorher gehorchte er ewig dem letzten Wert und
  LOGGTE das Flag nur — „übergeben" und „tot" waren dort buchstäblich derselbe
  Zustand, und der Modus wäre nicht beweisbar gewesen.
- **Schalter:** `VP_NATIVE_SELF_REGULATION_ENABLED` (Vorgabe AN, ein OPT-OUT wie
  `VP_OCPP_ENABLED`) — das echte Tor ist der Zertifikats-Katalog, dieser Schalter
  ist der Hebel, EINE Anlage ohne Image-/Zertifikats-/Plan-Änderung auf die
  bewiesene Nachführung zurückzunehmen.
- Beweise: `guards/nativemode_test.go` · `agent/native_mode_test.go` (die vier
  Fragen: Bestandsanlage byte-identisch, Übergabe nur bestätigt, jede
  Aufsichts-Bedingung nimmt zurück + rastet, EEG) ·
  `nodered/inverter-control-routing.test.js` (die Sequenz + das Beleg-Register je
  Adapter) · `nodered/unplanned-load-native.test.js` (Interlock, Drift, Simulator)
  · `nodered/flows-sync.test.js` (die inline Kopie == das Modul; jedes nicht
  abgedeckte Tier VERWEIGERT statt zu improvisieren) ·
  **`nodered/native-selfregulation.e2e.test.js`** (docker-frei, die ECHTEN
  Knoten-Bodies aus `flows.json` gegen einen selbst-regelnden In-Process-Server:
  Decken-Slot → nativ → EIN Schreibvorgang → keine Sollwert-Writes mehr → Netz ≈ 0
  ohne unser Zutun → Rücknahme im nächsten Takt; ohne Zertifikat bleibt es bei
  der Nachführung, und der Rücklese-`mode` behauptet NIE einen Zustand, in dem
  das Gerät nicht ist).

## Defizit-Deckung: gekauft wird nichts, worauf die Anlage steht

Cloud-Seite, Kontrakt und die Begründung: root `AGENTS.md` „Defizit-Deckung im
Fahrplan-Modus". Was HIER gelten muss:

- **`core/internal/guards/deficitcover.go` ist eine reine Entscheidung je Tick**
  (zustandslos - die einzige Hysterese, auf die es ankommt, ist das symmetrische
  Engage/Release-Dwell des `LoadFollower` auf dem Defizit). Sie läuft am
  GLEICHEN Ort wie die beiden Wolken-Pflichten: nach jeder Compliance-Klemme,
  nach der Holder-Übersteuerung, VOR dem Peak-Guard.
- **⚠ DEEPEN-ONLY.** Der Follower kennt seither drei Autorisierungen:
  `coverLoad` (Wolke, beidseitig), `unplannedLoad` (Wolke, nur aus echter Ruhe)
  und `deficitCover` (lokal, aus JEDEM nicht-ladenden Befehl, aber nur
  vertiefend). Eine Entladung zu BEGRENZEN ist ein Preis-Entscheid; er bleibt
  bei `cover_load_from_battery`, sonst schnitte die Box einen Verkauf zurück,
  den niemand als Fehler gemeldet hat.
- **Ein Befehl, ein Boden:** die Entscheidung und der Follower bekommen
  DIESELBE Zahl (`effective_floor` mit dem Peak-Reserve-Rückfall), damit sie
  nicht über den Boden streiten können. Der `PeakShave`-Aufruf im
  Deepen-Zweig liefert weiterhin Nennband, Boden und Nie-anheben.
- **Die Freigabe verlangt dieselben Tore wie jede lokal GESTARTETE Richtung:**
  `VP_CONTROL_ENABLED`, die Zertifizierung der Familie UND ein frisch gehaltenes
  Rücklesen (`idleReadbackHealthy`). Ohne sie fällt der Tick auf den 0-kW-Wert
  des Plans zurück.
- **⚠ Die enge Vollakku-Entlastung ist ENTFALLEN** (`HighSocRelief` samt
  `high_soc_follow`): ihr Eintritt ab `soc_max − 1` und ihr Fünf-Punkte-Boden
  sind in der allgemeinen Regel enthalten, deren Boden der volle Reserve-Stapel
  ist. **Die LADE-Hälfte `guards.HighSocCharge` (`high_soc_charge`) ist am
  29.08.2026 denselben Weg gegangen** und in `guards.StoreSurplus`
  (`surplus_store`) aufgegangen - siehe „Überschuss-Einlagerung" weiter unten.
  Die native Automatik wird während einer solchen Nachladung weiterhin
  zurückgenommen, weil ihr Beleg nur autonome ENTLADUNG zertifiziert.
- **⚠ Die lokale Regel autorisiert die native Automatik NICHT.**
  `nativeDutyFor` liest weiterhin ausschließlich die zwei Wolken-Pflichten: der
  native Modus ist eine prüfstand-gegatete Gerätefähigkeit, keine Folge einer
  Vertrauensregel.
- Heartbeat/API/Portal nennen die Richtung als **`deficit_cover` /
  „Live-Lastdeckung"**. Regressionsvektoren: 92 % / 1,3 / 2,7 -> −1,4 kW bis zum
  Reserve-Boden (0 Netz), 91 % / 11,4 / 2,9 -> +8,5 kW bis 95 %.

## Überschuss-Einlagerung: verschenkt wird nichts, was die Anlage erzeugt

Der SPIEGEL der Defizit-Deckung eine Sektion darüber, und der Ladeboden unter
den Wolken-Pflichten. Cloud-Seite und Begründung: root `AGENTS.md`
„Überschuss-Einlagerung im Fahrplan-Modus". Was HIER gelten muss:

- **`core/internal/guards/surplusstore.go` ist eine reine Entscheidung je Tick**
  (zustandslos - die einzige Hysterese, auf die es ankommt, ist das
  Engage/Release-Dwell des `SurplusCharger` auf dem Überschuss). Sie läuft am
  GLEICHEN Ort wie die drei anderen In-Slot-Pflichten: nach jeder
  Compliance-Klemme, nach der Holder-Übersteuerung, nach dem Follower und VOR
  dem Peak-Guard.
- **⚠ ZWEI EINTRITTE, und ihr Unterschied IST das Sicherheits-Argument.**
  **(B1) Der Plan LÄDT BEREITS** - die Speicher-gegen-Verkauf-Entscheidung hat
  die Wolke getroffen, korrigiert wird nur die MENGE; **kein Diskriminator
  nötig**, es gibt keinen Verkauf, den sie umdrehen könnte. **(B2) Der Plan
  RUHT** - das könnte auch „bewusst zum Spitzenpreis einspeisen" heissen, also
  gilt der EINE richtige Diskriminator der Wolke: `cover_load_from_battery`
  (Netz ≈ 0, nie ein Verkaufsslot), plus die Tore jeder lokal GESTARTETEN
  Richtung (`portableReady`).
- **⚠ Die SoC-Bandgrenze der engen Ladeseite ist ENTFALLEN** (`HighSocCharge`
  samt `high_soc_charge`): sie griff nur zwischen `soc_max − 5` und `soc_max`
  und verweigerte deshalb den Live-Fall 10:14 (Speicher **19 %**, PV 39,354,
  Haus 16,383, 22,8 kW ins Netz, Plan-Slot −7,17 kW vom Follower auf 0,0
  begrenzt). Der ENTLADE-Zwilling hatte diese Grenze am 28.08. bereits fallen
  lassen - die Ladeseite hat den Schritt jetzt nachgeholt. `highsoc.go` ist
  ersatzlos in `surplusstore.go` aufgegangen; das Wort bleibt in api/Portal
  lesbar, kein aktueller Build erzeugt es.
- **⚠ Ehrlicher Rest-Einwand (B2):** ein UNERWARTETER Überschuss in einem
  Abend-Deckungsslot wird eingelagert statt verkauft. Auszuschliessen wäre das
  nur mit dem Exportwert je Slot im Fahrplan-Kontrakt - Captain-Entscheid
  29.08.2026: die EINFACHE Variante, kein Vertragsfeld.
- **Sie autorisiert den BESTEHENDEN `SurplusCharger`**, statt einen zweiten
  Anhebe-Pfad zu bauen: der angehobene Zielwert läuft damit erneut durch die
  autoritative `guards.Clamp` (Nennband, SoC-Decke, EEG-Solarladen, §14a) und
  kann an keinem Wächter vorbeischreiben.
- **⚠ B1 ist MAGNITUDEN-ONLY, also OHNE gehaltenes Rücklesen** - anders als B2
  und die anderen Regeln, die eine Richtung aus der Ruhe STARTEN
  (`unplannedLoad`/`deficitCover`, die `portableReady` fordern). Die Box
  schreibt diese Richtung ohnehin schon; eine strengere Bedingung als die der
  größeren Wolken-Absorption daneben wäre nicht zu begründen.
- **Die native Automatik wird während einer Einlagerung zurückgenommen**
  (ihr Beleg zertifiziert nur autonome ENTLADUNG) - unverändert die Regel der
  abgelösten engen Ladeseite.
- **Ladung ≤ gemessener Überschuss ⇒ vorhergesagtes Netz ≤ 0:** sie kann keinen
  Import erzeugen oder erhöhen (§14a-Import und das Peak-Ziel bleiben unberührt)
  und bewegt einen Export nur in Richtung null - Einspeisegrenze und
  §14a-Export halten a fortiori.
- **Nie ein Richtungswechsel:** ein Verkauf und ein bloß ruhender Befehl liegen
  beide ausserhalb ihrer Eintrittsbedingung.
- **Wo die WOLKE autorisiert hat, behält sie ihren Namen** (`absorb`): die
  lokale Regel etikettiert nie eine Entscheidung um, die der Plan getroffen hat.
- Heartbeat/API/Portal nennen die Richtung als **`surplus_store` /
  „Live-Überschussladung"**. Regressionsvektoren (Herzogau 29.08.2026, aus den
  Box-Snapshots): **10:53** Plan +9,82 / PV 56,907 / Haus 29,013 / SoC 38 →
  **+27,894 kW**, Netz 0,000 (gemessen ~18 kW Export bei NEGATIVEM Preis);
  **10:14** Plan −7,17 (Follower → 0,0) / PV 39,354 / Haus 16,383 / SoC 19 →
  **+22,971 kW**, Netz 0,000 (gemessen 22,8 kW Export). Der abgelöste
  91-%-Vektor (11,4 / 2,9 → +8,5 kW) läuft unverändert durch dieselbe Regel.

## Ein Messpunkt wird ueber SEINE Komponente gelesen (Geraeteseite Stufe 3c)

Cloud-Seite, Kontrakt und die Server-Haelfte: root `CLAUDE.md` „Mess-Selektion
JE KOMPONENTE" + „Geraeteseite Stufe 3c". Was HIER gelten muss:

- **⚠ DIE LEITREGEL: eine Bindung, die die Box nicht aufloesen kann, wird
  VERWEIGERT — nie gegen den primaeren Wechselrichter gelesen.** Bis zu dieser
  Stufe pollte `vp-measurements.js` JEDEN Punkt gegen `edge/inverter/config`;
  ein auf einem zweiten Fronius oder einer Wallbox gewaehltes Register wurde
  also von der Deye-Adresse gelesen — ein falscher Wert auf einem richtig
  aussehenden Punkt. Genau deshalb blieben 3a/3b ehrlich eingeschraenkt.
- **Die Regel ist rein** (`measurements/measurement-binding.js`, ohne I/O und
  ohne Uhr — das `otaapply`/`probe`-Muster): `entity_id` → der Pin
  `edge_source_id` aus der per-Entitaets-Registry → eine Quelle in
  `edge/sources/config`. Der Knoten abonniert dafuer zusaetzlich `edge/sources/config`
  und `edge/entities/+/config` und ist ausschliesslich Verdrahtung.
- **⚠ Die KOMPONIERTEN Typen (`battery-hybrid`/`grid-meter`/`house-load`) sind
  die eine Ausnahme ohne Pin** — sie SIND die Kanaele des primaeren
  Wechselrichters (`core/internal/entities/compose.go` `composedType`), also ist
  ihre Aufloesung auf den Primaeren die eigene Komposition der Box und zugleich
  byte-identisch zum Vor-3c-Verhalten. Die Liste ist gegen die Go-Datei gepinnt
  — **beide zusammen aendern.**
- **⚠ Der TARGET gehoert in den Gruppierungs-Schluessel.** Zwei Geraete hinter
  EINER Box koennen dieselbe Familie und dasselbe Register tragen; ein
  gemeinsamer Block laese die Adressen des einen ueber die Verbindung des
  anderen. Aus demselben Grund haelt die Runtime die gelesenen Woerter PRO
  TARGET (eine flache Karte dekodierte Geraet A mit den Woertern von B).
- **⚠ Die VERBINDUNG wird zur LESEZEIT aufgeloest** (`resolveDevice`), nie in
  den Plan eingebacken: eine Quelle, die zwischen Plan und Poll verschwindet,
  ergibt eine Luecke in der Zeit — nie eine Lesung des Primaeren.
- **Ein SunSpec-Punkt braucht die Discovery SEINES Geraets** (Adressen sind
  modell-relativ). Ein Target ohne eigene Discovery wird als
  `driver_unavailable` verweigert, statt die Modell-Basis des Primaeren zu
  borgen. Der Knoten laeuft die Discovery je sunspec-Target, serialisiert.
- **Die Verweigerung heilt sich selbst:** Registry und Messplan sind zwei
  unabhaengige retained Dokumente; welches zuletzt landet, loest ein
  Neu-Anwenden aus, also veroeffentlicht ein spaeterer Push einen korrigierten
  Status (`binding_unavailable` ist im Status-Kontrakt UND in der geschlossenen
  `REASONS`-Menge der api — ein Wort, das der Server nicht kennt, verwirft die
  GANZE Quittung).
- **⚠ Ein (Wieder-)Verbinden spielt JEDES retained Dokument auf einmal ein** —
  eine Entitaets-Konfiguration je Komponente. Die bindungs-getriebenen
  Neu-Anwendungen werden deshalb GEBUENDELT; ein neuer PLAN wird weiterhin
  synchron angewandt, weil sein Status die Quittung ist, auf die die Cloud
  wartet. Ohne die Buendelung wird aus einem normalen Reconnect ein
  Status-Sturm, den der Kern eins zu eins in die Cloud weiterreicht.
- **OCPP hat keine Verbindung**, eine Bindung waehlt und verweigert dort also
  nichts; die Zuordnung eines Measurands bleibt geraeteweit. Ebenso trägt der
  SAMPLE-Pfad weiterhin nur `point_key` — „welche Komponente hat das gemessen"
  beantwortet die Auswahl in der Cloud, nicht die Probe.
- **Wirksam mit dem naechsten Edge-Release** — eine laufende Box behaelt ihr
  Image und pollt bis dahin jeden Punkt gegen den Primaeren.
- Beweise: `measurements/measurement-binding.test.js` (die Regel + der
  Lockstep gegen `compose.go`) · `measurement-target.test.js` (Planer/Runtime:
  eigenes Geraet, zwei Geraete auf demselben Register, Verweigerung ohne
  Lesung, eigene SunSpec-Basis, ein ungebundener Plan ist byte-identisch) ·
  `measurement-node.test.js` (die Verdrahtung des Knotens gegen einen
  In-Process-RED/mqtt-Ersatz) · Go `internal/measurements` +
  `agent/measurement_binding_test.go` (die Bindung erreicht Layer 1
  BYTE-IDENTISCH; eine kaputte Kennung erreicht ihn nie).

## Ein Ladepunkt ist eine MESSENDE Komponente (Cockpit Phase 1 / E1+E2)

Cloud-Seite, Portal und die volle Begruendung: root `CLAUDE.md`
„Cockpit Phase 1 / E1+E2". Was HIER gelten muss:

- **⚠ Die Zuordnung Ladesaeule -> Komponente kommt AUSSCHLIESSLICH aus dem
  Registry-Push** (`entities.Entity.ChargePointID`, additiv). Ohne sie
  veroeffentlicht `publishOcppEntityTelemetry` GAR NICHTS - es gibt keinen
  Rueckfall, der Messwerte auf die falsche Komponente pinnen koennte, und eine
  Box an einer aelteren Cloud ist byte-identisch zum Vor-Phase-1-Stand.
- **`ocppEntityReadings` ist die REINE Regel** (kein Bus, keine Uhr - das
  `probe`/`otaapply`-Muster); `publishOcppEntityTelemetry` haengt am Ende von
  `ocppStep` neben `publishOcppState`, also formen Karte, Herzschlag und
  Entitaets-Reihe sich aus DERSELBEN Momentaufnahme.
- **Es entsteht KEIN zweiter Uplink**: von `edge/entities/{id}/telemetry` an
  traegt die bestehende E1b-Kette alles weiter (Identitaetspruefung ->
  store-and-forward -> v2-Uplink), byte-gleich wie bei einem messenden Shelly.
- **⚠ Eine TEIL-Summe ist keine Messung:** ein Stecker, der NIE gemessen hat,
  gehoert nicht zur Summe; einer, der gemessen HAT und verstummt ist, macht die
  Saeulen-Summe unvollstaendig - dann veroeffentlicht die GANZE Saeule nichts
  (die `ChargingTotal`-„complete"-Disziplin, eine Ebene hoeher).
- **⚠ `soc_pct` wird NIE publiziert** (der Ladestand des AUTOS;
  `topology.DefaultRole` bildet ihn kategorie-unabhaengig auf den SPEICHER-Knoten
  ab). Wer den Kanal ergaenzt, faellt in genau diese Falle.
- **E2:** `state.OcppConnector` traegt `SessionKwh` (Register minus
  `Session.MeterStartWh`; ein RUECKWAERTS gesprungenes Register liefert KEINE
  Bilanz statt einer negativen) und `MeteredAtMs`; beides reist additiv im
  `chargers`-Block. Eine Box ohne MeterValues sendet BEIDES nicht.
- Beweise: `agent/ocpp_entities_test.go`, `agent/ocpp_heartbeat_test.go`.

## Eine Saeule kann auf einem EIGENEN Anschluss haengen (Cockpit Phase 1 / C1)

Konzept `data/vp-verbraucher-cockpit-k1` §8.4 Punkt 5, Captain-Entscheid E5.
Das Budget-Gesetz `budget = planbar - (Netzbezug - Ladeleistung)` gilt nur
HINTER dem Haus; eine Saeule mit eigenem Zaehler war bis hierher nicht
unterscheidbar und wurde deshalb faelschlich zurueckaddiert. Repo-weite Regeln
in `../AGENTS.md` „Cockpit Phase 1 / C1"; die Box-Seite in vier Punkten:

- **`csms.Charger.Connection`** (`ConnectionHaus`/`ConnectionEigen`) kommt
  AUSSCHLIESSLICH aus dem retained Konfigurations-Dokument — auf `:8484` gibt es
  dafuer keine Oberflaeche. Nie den rohen String vergleichen: `ConnectionOrHaus()`
  loest ihn auf, `OwnConnection()` fragt ihn. **Leer heisst `haus`** (die
  PATCH-Semantik und die sichere Lesart in einem).
- **⚠ `Snapshot.ChargingTotal` UEBERSPRINGT eine Saeule auf eigenem Anschluss** —
  sie war nie in der Netzmessung, kann die Summe also auch nicht unvollstaendig
  machen (`complete` bleibt unberuehrt). Das ist der EINE Rueckaddier-Ort, den
  `agent/ocpp.go` und `agent/ocpp_surplus.go` teilen; wer einen zweiten baut,
  baut das Loch neu.
- **⚠ `applyChargePoints` zieht den Anschluss auch auf einer SCHON BEKANNTEN
  Saeule nach** — die einzige Ausnahme von der Nie-ueberschreiben-Regel, weil es
  auf der Box nichts zu schuetzen gibt. Sagt das Portal nichts (`""`) oder
  dasselbe wie bisher, passiert GAR NICHTS (kein Schreibvorgang, kein Log je
  Zustellung des retained Dokuments).
- **⚠ Ein unbekanntes Wort ueberspringt den EINTRAG** (`chargingcfg.Parse`) und
  wird beim Anlegen abgelehnt (`csms.NormalizeAdd`) — nie auf `haus` aufgeloest:
  waere die Wahrheit `eigen`, fiele das Budget zu GROSS aus. Die Vorsicht liegt
  also im Ueberspringen; eine bekannte Saeule behaelt dann, was sie hat.
- Beweise: `internal/chargingcfg` (die Kontrakt-Fixture PER PFAD),
  `internal/csms/chargingtotal_test.go` (der Skip, und „ohne Angabe zaehlt es
  exakt wie vorher"), `agent/charging_config_test.go`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
