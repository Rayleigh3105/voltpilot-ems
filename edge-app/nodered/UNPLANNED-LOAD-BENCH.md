# Bench gate: native charge block with autonomous discharge

VoltPilot executes an economically authorized idle-slot correction through the
portable 10-second exact-setpoint `idle_follow` path. The optional capability
`native_charge_block_discharge_auto` is a stronger claim: charging is blocked
while the inverter remains free to cover a newly appearing local load itself.
It is never inferred from a product family or protocol.

Production's native capability catalog is intentionally empty. In particular,
**Deye native behavior is disabled**. The existing Deye remote/ToU write path is
not evidence that its firmware can hold charge off while autonomous discharge,
reserve enforcement, export prevention, and the watchdog all remain correct.

An entry may be added only for an exact manufacturer, model, firmware and
register-map tuple after a no-grid-export bench run records all of the following:

1. charge-block and safe-default release write bytes plus independent readback
   bytes for both transitions, including reboot;
2. spontaneous-load response within 2 seconds and removal within 2 seconds;
3. no added battery export above 0.2 kW across PV/load crossover;
4. stop at `max(technical floor, backup reserve, peak reserve)` and rated power;
5. stale/unknown SOC, load or PV, E-stop, missing First-Light grant, rejected or
   lost readback, watchdog expiry and communication loss all produce zero native
   writes and return to the safe configured default;
6. deliberate charge and sale slots are never reinterpreted;
7. the readback watchdog is independently observed for at least 100 cycles.

`unplanned-load-native.js` is a pure activate/release write-plan and readback
planner. Its tests use only a fictional certificate and assert that Deye yields
no native writes. No test or documentation procedure in this repository writes
to a live device.
