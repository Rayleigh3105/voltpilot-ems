# Verbrauchssteuerung Inkrement 4 (edge half): the generated reactive rule

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 11).


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

