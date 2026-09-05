# E2 flow platform core: arbitration + flow deployment (fm/vp2-e2-flow-core)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 8).


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

