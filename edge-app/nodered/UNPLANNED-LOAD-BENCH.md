# Bench gate: native self-regulation (charge block + autonomous discharge)

VoltPilot executes an economically authorized covering slot through the portable
10-second exact-setpoint `follow` / `idle_follow` path. The optional capability
`native_charge_block_discharge_auto` is a stronger claim: the SETPOINT ITSELF is
handed back to the inverter, charging is blocked, and the device is left free to
cover a newly appearing local load with its own loop. It is never inferred from a
product family or protocol.

Production's native capability catalog is intentionally empty. In particular,
**Deye native behavior is disabled**. The existing Deye remote/ToU write path is
not evidence that its firmware can hold charge off while autonomous discharge,
reserve enforcement, export prevention and the watchdog all remain correct.

## What an entry releases, and what it does NOT

An entry names an exact manufacturer, model, firmware and register-map tuple. It
ATTESTS the bytes the shipped adapter plans - it does not define them: the
sequence lives in `inverter-control-routing.js` `nativeSelfConsumption`, and
`certificateMatchesPlan` refuses when the two have drifted apart. Two sources for
one truth would otherwise let a firmware-specific result bless a sequence nobody
measured.

It releases NOTHING about supervision: the core keeps taking the battery back at
the reserve floor, on a threatened billing peak, on a lost measurement or
readback, at the end of the slot, on plant rest and when the mode is not
confirmed (`guards/nativemode.go`).

## Criteria

An entry may be added only after a no-grid-export bench run records all of the
following:

1. charge-block and safe-default release write bytes plus independent readback
   bytes for both transitions, including reboot;
2. spontaneous-load response within 2 seconds and removal within 2 seconds;
3. no added battery export above 0.2 kW across PV/load crossover;
4. stop at `max(technical floor, backup reserve, peak reserve)` and rated power;
5. stale/unknown SOC, load or PV, E-stop, missing First-Light grant, rejected or
   lost readback, watchdog expiry and communication loss all produce zero native
   writes and return to the safe configured default;
6. deliberate charge and sale slots are never reinterpreted;
7. the readback watchdog is independently observed for at least 100 cycles;
8. **THE TRANSITION IS PROVEN IN BOTH DIRECTIONS, AND MEASURED.** Record, with
   timestamps: the write bytes of the hand-over, the FIRST readback that shows
   the device's own state register in the native value, and the LATENCY between
   them; then the same for the return (the ordinary setpoint plan) - the write,
   the first readback confirming the commanded value, and the latency. Criterion
   2 measures the device's regulation; this one measures how long VoltPilot needs
   to TAKE THE BATTERY BACK, which is what the supervision's floor margin
   (`guards.NativeFloorMarginPct`) is sized against. Nothing here is measured on
   any device yet.
9. **THE STATE REGISTER REALLY DISTINGUISHES THE TWO MODES.** Read the proof
   register in BOTH states and show it differs. Where it does not - KOSTAL is the
   known case, where register 1080 reads 2 whether the external setpoint is
   active or expired - the proof is BEHAVIOURAL and must be recorded as such:
   observe the battery power (582) follow the house with no write from us, for at
   least 5 minutes across a load change. A family whose mode cannot be
   distinguished at all must not be entered.
10. **ON AN EEG PLANT: the grid-charge ban is readable.** With the device in its
    native mode, read the charging-source register the adapter names
    (`gridChargeProof`) and show it says "not from grid". A family with no such
    register is refused on EEG sites by construction - do not enter one and hope.

## Per-adapter: sequence in, sequence out, proof register

All four are PLANNED-ONLY today (`writes: []`); the tables are the artefact a
session verifies.

| Adapter | Into native | Back out | Proof register | Watchdog |
|---|---|---|---|---|
| **Deye remote** (`solarman_v5`, firmware V105.1+) | `1100 <- 0` (disable remote mode; the inverter then runs its own Work-Mode/ToU configuration) | the ordinary remote write plan (`1101` watchdog, `1104`, `1105`, `1109`, `1100 <- 1` LAST) | `1100 == 0`; `1121` is an OBSERVATION only. EEG: Program-1 charging enum `progChargeBase + 0 == 0` (Disabled) | the device's own (1101). Not writing IS the failsafe |
| **Deye ToU** (no remote firmware) | **not supported, deliberately** | - | - | - |
| **Fronius GEN24** (SunSpec Model 124) | `planStorage(0)`: rates 0, `StorCtl_Mod <- 0` LAST = "release control -> the inverter self-consumes" | `planStorage(kw)` | `StorCtl_Mod == 0` at the DISCOVERED address. EEG: `ChaGriSet == PV` | `InOutWRte_RvrtTms` is written, but its behaviour on 124 is UNDOCUMENTED - bench point |
| **KOSTAL PLENTICORE** | **nothing at all** - stopping the writes IS the hand-over (webserver timeout, 30-60 s) | resume writing `1034` | none distinguishes the modes: `1080` reads 2 in both. BEHAVIOURAL only (582 follows the house). No EEG proof -> refused on EEG sites | the device's own (webserver timeout) |
| **KACO NH3** (AISWEI) | `41104 <- 2` (Eigenverbrauch) | `41104 <- 4` + flag + power + SoC bounds | `41104 == 2`. No charging-source register -> refused on EEG sites | **none documented** - the failsafe is ours, and the native write IS it |
| **generic SunSpec / simulator** | `41 <- 0` (clear EMS control), `40 <- 0` | `40 <- kw`, `41 <- 1` | `41 == 0`, `40 == 0`. No EEG proof -> refused on EEG sites | none (simulator) |

The slot's PV feed-in cap (`42` / `pv_limit_kw`) is NOT part of the hand-over on
any adapter: the mode concerns the battery, and freezing a curtailment would let
it outlive its slot. Where the tier carries one it rides along as an ordinary
write, gated by the ordinary control gate.

`unplanned-load-native.js` is a pure activate/release write-plan and readback
planner plus the release point. Its tests use only a fictional certificate and
the SIMULATOR-ONLY entry (which names a piece of software, not a device), and
assert that Deye yields no native writes. **No test or documentation procedure in
this repository writes to a live device.**
