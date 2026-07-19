# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

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
- **Flow deployment** (`core/internal/flowdeploy`, `agent/flows.go`):
  retained `…/v2/flows` set → verify (hash / semver gates / capabilities;
  palette version LIVE from NR `GET /nodes`, never an env) → per-flow Admin
  API materialization of `@vp-flow` tabs → heartbeat `flows` acks. Needs
  `VP_NODERED_ADMIN_URL` (+ the NR adminAuth credentials) on the CORE;
  unset = verified + persisted but acked `error` naming the setting.
- **Reseed coexistence (D-12)**: `nodered/reseed-merge-flows.js` + the
  entrypoint merge — vendor tab group from the image, `@vp-flow` tabs
  byte-identical; degradation to wholesale only with a loud WARN (the
  retained deployment self-heals). Per the #117/#119 law, changes here need
  the REAL-image proof: `reseed-flows.docker.test.sh` (+ `reseed.test.sh`
  cases 6/7, `reseed-merge.test.js`).
- **Rig host caveat**: `test/e2e-v2-compose.sh` pre-builds images with plain
  `docker build` (old-buildx hosts cannot run `compose build`) and its
  overlay pins `pull_policy: never`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
