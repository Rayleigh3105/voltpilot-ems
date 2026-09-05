# A register READBACK is not a value comparison: semantics, then debounce

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 37).


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

