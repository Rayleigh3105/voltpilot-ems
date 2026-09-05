# Deye REMOTE MODE (registers 1100-1121) is the PRIMARY Deye control path

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 36).


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

