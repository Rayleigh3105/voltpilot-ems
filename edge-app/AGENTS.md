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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
