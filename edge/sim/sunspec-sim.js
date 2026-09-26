/**
 * Simulated SunSpec-style Modbus TCP inverter + battery.
 *
 * There is no real hardware in dev, so this stands in for a SunSpec-capable
 * inverter (Modbus TCP) and lets the Node-RED edge run end-to-end:
 *   - Acquisition polls holding registers (FC3) for power / PV / load / SoC and
 *     the *observed effective* §14a active-power limit (WMaxLimPct).
 *   - Guards / Schedule-Exec write the battery setpoint (FC6) which this model
 *     obeys, so slot-wise schedule execution is observable.
 *
 * It is intentionally a COMPACT, documented register map (not a byte-exact full
 * SunSpec model dump). Every value is a 16-bit register; signed values use
 * two's-complement. Scale factors are fixed and documented below so the
 * Node-RED decode stays honest. The mapping to SunSpec models is noted per row.
 *
 *  Addr | Name                | Enc.                    | SunSpec ref
 *  -----+---------------------+-------------------------+-------------------------
 *   0   | grid_power          | int16, 0.01 kW, +import | meter model 203 W
 *   1   | pv_power            | int16, 0.01 kW, >=0     | inverter model 103 DCW
 *   2   | load_power          | int16, 0.01 kW, >=0     | derived / site meter
 *   3   | battery_power       | int16, 0.01 kW, +charge | storage model 124 W
 *   4   | soc                 | uint16, 0.1 %           | storage model 124 ChaState
 *   5   | wmax_lim_pct        | uint16, 0.01 % (sf -2)  | control model 123 WMaxLimPct
 *   6   | grid_conn_nameplate | uint16, 0.01 kW         | nameplate model 120 WRtg
 *   7   | energy_import_hi    | uint16, high word Wh    | meter model 203 TotWhImp
 *   8   | energy_import_lo    | uint16, low word  Wh    | meter model 203 TotWhImp
 *
 * Writable (edge -> inverter):
 *  Addr | Name                | Enc.                    | SunSpec ref
 *  -----+---------------------+-------------------------+-------------------------
 *   40  | batt_setpoint       | int16, 0.01 kW, +charge | control model 124 (WChaGra)
 *   41  | setpoint_enable     | uint16, 1 = EMS control | control model 123 conn
 *        |                     | 0 = the inverter regulates ITSELF (self-consumption)
 *   42  | pv_limit            | uint16, 0.01 kW,        | control model 123 WMaxLim
 *        |                     | 0xFFFF = no limit       | (PV curtailment cap)
 *   43  | native_charge_limit | uint16, 0.01 kW,        | storage model 124 WChaMax
 *        |                     | 0xFFFF = no limit       | (own-mode window, K4b)
 *   44  | native_discharge_   | uint16, 0.01 kW,        | storage model 124 WDisChaMax
 *        |   limit             | 0xFFFF = no limit       | (own-mode window, K4b)
 *
 * pv_limit caps the simulated PV output (negative-price curtailment from the
 * schedule contract's optional pv_limit_kw). It can only ever REDUCE
 * generation - the model takes min(diurnal PV, limit) and a limit above the
 * current output changes nothing. 0xFFFF (the power-on default) disables it.
 *
 * SELF-CONSUMPTION (the NATIVE self-regulation the edge can hand control to):
 * while setpoint_enable is 0 the model does what every real hybrid does on its
 * own - it follows the house: battery = pv - load, clamped to the rated band and
 * the SoC window, so grid ~ 0. Only with setpoint_enable = 1 does it obey the
 * commanded setpoint. That distinction is the whole point of the register, and
 * without it the simulator could not stand in for a device the edge stops
 * writing to (it used to obey the last commanded value forever and merely LOG
 * the flag, so "we handed over" and "we died" were literally the same state).
 *
 * THE WINDOW OF THE OWN MODE (K4b, 24.09.2026): registers 43/44 bound the
 * charge/discharge power the device may use WHILE it regulates itself, so the
 * edge can hand over "charge only the surplus, never discharge" (E-up: 43 = rated,
 * 44 = 0), "self-consumption with a throttled charge" (E~: 43 = x) and so on. They
 * do nothing under EMS control (41 = 1).
 *
 * DEAD TIMES (K4b, concept §8): SIM_MEASURE_INTERVAL_S (register refresh cadence,
 * Deye 5-25 s), SIM_FOLLOW_DELAY_S (a written setpoint takes effect after N s,
 * Deye 15-20 s) and SIM_SELF_DEAD_TIME_S (the device's own loop, default 1 s).
 * Unset, the first two keep the old behaviour. The model itself is the pure
 * module sim-model.js - this file is only its Modbus TCP server.
 *
 * grid_limit_kw (the value the contract carries) is derived by the edge as
 * wmax_lim_pct/100 * grid_conn_nameplate. §14a is enforced by the grid
 * operator's own parallel device; the EMS only OBSERVES this envelope.
 */

'use strict';

const ModbusRTU = require('modbus-serial');
const { R, NUM_REGS, s16ToKw, createSimModel, optionsFromEnv } = require('./sim-model');

const HOST = process.env.SIM_HOST || '0.0.0.0';
const PORT = parseInt(process.env.SIM_PORT || '502', 10);
const UNIT_ID = parseInt(process.env.SIM_UNIT_ID || '1', 10);

// Battery nameplate (mirrors infra/local/timescale seed asset row) and the K4b
// dead times - all from SIM_* env vars, see sim-model.js optionsFromEnv.
const OPTS = optionsFromEnv();
const nowS = () => Date.now() / 1000;
const model = createSimModel({ ...OPTS, startS: nowS() - 1 });

setInterval(() => model.step(1, nowS()), 1000);
model.step(1, nowS());

const vector = {
  getHoldingRegister: (addr) => model.getRegister(addr),
  getInputRegister: (addr) => model.getRegister(addr),
  setRegister: (addr, value) => {
    if (addr < 0 || addr >= NUM_REGS) return;
    // Prominent log so slot-wise schedule execution is observable end-to-end.
    const line = model.setRegister(addr, value);
    if (line) console.log(line);
  },
};

const server = new ModbusRTU.ServerTCP(vector, {
  host: HOST,
  port: PORT,
  unitID: UNIT_ID,
  debug: false,
});

server.on('socketError', (err) => console.error('[sim] socket error:', err && err.message));
server.on('serverError', (err) => console.error('[sim] server error:', err && err.message));

console.log(
  `[sim] SunSpec Modbus TCP simulator listening on ${HOST}:${PORT} (unit ${UNIT_ID})\n` +
  `[sim] battery ${OPTS.capacityKwh}kWh, +/-${OPTS.maxChargeKw}/${OPTS.maxDischargeKw}kW, ` +
  `grid conn ${OPTS.gridConnKw}kW, PV peak ${OPTS.pvPeakKw}kW | ` +
  `measure every ${OPTS.measureIntervalS}s, setpoint follow ${OPTS.followDelayS}s, own loop ${OPTS.selfDeadTimeS}s`
);

// Periodic heartbeat so the operator can see the model is alive.
setInterval(() => {
  const reg = model.getRegister;
  console.log(
    `[sim] grid=${s16ToKw(reg(R.GRID)).toFixed(2)}kW pv=${s16ToKw(reg(R.PV)).toFixed(2)}kW ` +
    `load=${s16ToKw(reg(R.LOAD)).toFixed(2)}kW batt=${s16ToKw(reg(R.BATT)).toFixed(2)}kW ` +
    `soc=${(reg(R.SOC) / 10).toFixed(1)}% wMaxLim=${(reg(R.WMAXLIM) / 100).toFixed(0)}%`
  );
}, 15000);
