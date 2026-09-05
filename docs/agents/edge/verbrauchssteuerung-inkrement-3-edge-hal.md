# Verbrauchssteuerung Inkrement 3 (edge half): cycle guard + consumers heartbeat + simulator

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 9).


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

