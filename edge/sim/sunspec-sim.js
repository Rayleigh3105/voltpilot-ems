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
 *
 * grid_limit_kw (the value the contract carries) is derived by the edge as
 * wmax_lim_pct/100 * grid_conn_nameplate. §14a is enforced by the grid
 * operator's own parallel device; the EMS only OBSERVES this envelope.
 */

'use strict';

const ModbusRTU = require('modbus-serial');

const HOST = process.env.SIM_HOST || '0.0.0.0';
const PORT = parseInt(process.env.SIM_PORT || '502', 10);
const UNIT_ID = parseInt(process.env.SIM_UNIT_ID || '1', 10);

// Battery nameplate (mirrors infra/local/timescale seed asset row).
const CAPACITY_KWH = parseFloat(process.env.SIM_CAPACITY_KWH || '100');
const MAX_CHARGE_KW = parseFloat(process.env.SIM_MAX_CHARGE_KW || '50');
const MAX_DISCHARGE_KW = parseFloat(process.env.SIM_MAX_DISCHARGE_KW || '50');
const GRID_CONN_KW = parseFloat(process.env.SIM_GRID_CONN_KW || '50');
const PV_PEAK_KW = parseFloat(process.env.SIM_PV_PEAK_KW || '25');
const LOAD_BASE_KW = parseFloat(process.env.SIM_LOAD_BASE_KW || '8');

// Register indices.
const R = {
  GRID: 0, PV: 1, LOAD: 2, BATT: 3, SOC: 4, WMAXLIM: 5, GRIDCONN: 6,
  EIMP_HI: 7, EIMP_LO: 8,
  SETPOINT: 40, ENABLE: 41,
};

const NUM_REGS = 64;
const regs = new Uint16Array(NUM_REGS);

// Mutable model state.
let soc = parseFloat(process.env.SIM_SOC_START || '55'); // percent
let energyImportWh = 0;
let commandedKw = 0;   // last battery setpoint written by the edge
let enabled = 0;       // 1 once the edge asserts control

const toU16 = (v) => v & 0xffff;
const s16ToKw = (raw) => (raw > 32767 ? raw - 65536 : raw) / 100;

function tick() {
  const dtS = 1;
  const t = Date.now() / 1000;

  // PV: ~2 min diurnal cycle so a short test sees generation come and go.
  const pv = Math.max(0, PV_PEAK_KW * Math.sin((2 * Math.PI * (t % 120)) / 120));
  // Load: base +/- a small swing.
  const load = LOAD_BASE_KW + 2 * Math.sin((2 * Math.PI * (t % 40)) / 40);

  // Battery obeys the last commanded setpoint, clamped by power and SoC limits.
  let batt = Math.max(-MAX_DISCHARGE_KW, Math.min(MAX_CHARGE_KW, commandedKw));
  if (soc >= 100 && batt > 0) batt = 0;
  if (soc <= 0 && batt < 0) batt = 0;

  // Integrate SoC (kWh -> % of capacity).
  soc += (batt * (dtS / 3600) / CAPACITY_KWH) * 100;
  soc = Math.max(0, Math.min(100, soc));

  // Grid coupling: positive = import.
  const grid = load + batt - pv;
  if (grid > 0) energyImportWh += (grid * 1000 * dtS) / 3600;

  // §14a observed limit: mostly 100 %, throttled to 40 % in every 4th 30 s window.
  const wmaxLimPct = Math.floor(t / 30) % 4 === 3 ? 40 : 100;

  regs[R.GRID] = toU16(Math.round(grid * 100));
  regs[R.PV] = toU16(Math.round(pv * 100));
  regs[R.LOAD] = toU16(Math.round(load * 100));
  regs[R.BATT] = toU16(Math.round(batt * 100));
  regs[R.SOC] = toU16(Math.round(soc * 10));
  regs[R.WMAXLIM] = toU16(Math.round(wmaxLimPct * 100));
  regs[R.GRIDCONN] = toU16(Math.round(GRID_CONN_KW * 100));
  const ewh = Math.round(energyImportWh);
  regs[R.EIMP_HI] = toU16((ewh >>> 16) & 0xffff);
  regs[R.EIMP_LO] = toU16(ewh & 0xffff);
}

setInterval(tick, 1000);
tick();

const vector = {
  getHoldingRegister: (addr) => (addr >= 0 && addr < NUM_REGS ? regs[addr] : 0),
  getInputRegister: (addr) => (addr >= 0 && addr < NUM_REGS ? regs[addr] : 0),
  setRegister: (addr, value) => {
    if (addr < 0 || addr >= NUM_REGS) return;
    regs[addr] = toU16(value);
    if (addr === R.SETPOINT) {
      commandedKw = s16ToKw(regs[addr]);
      // Prominent log so slot-wise schedule execution is observable end-to-end.
      console.log(
        `[sim] setpoint write: battery = ${commandedKw.toFixed(2)} kW ` +
        `(reg[${R.SETPOINT}]=${regs[addr]}) | soc=${soc.toFixed(1)}%`
      );
    } else if (addr === R.ENABLE) {
      enabled = regs[addr];
      console.log(`[sim] EMS control ${enabled ? 'ENABLED' : 'disabled'} (reg[${R.ENABLE}]=${enabled})`);
    }
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
  `[sim] battery ${CAPACITY_KWH}kWh, +/-${MAX_CHARGE_KW}/${MAX_DISCHARGE_KW}kW, ` +
  `grid conn ${GRID_CONN_KW}kW, PV peak ${PV_PEAK_KW}kW`
);

// Periodic heartbeat so the operator can see the model is alive.
setInterval(() => {
  console.log(
    `[sim] grid=${s16ToKw(regs[R.GRID]).toFixed(2)}kW pv=${s16ToKw(regs[R.PV]).toFixed(2)}kW ` +
    `load=${s16ToKw(regs[R.LOAD]).toFixed(2)}kW batt=${s16ToKw(regs[R.BATT]).toFixed(2)}kW ` +
    `soc=${(regs[R.SOC] / 10).toFixed(1)}% wMaxLim=${(regs[R.WMAXLIM] / 100).toFixed(0)}%`
  );
}, 15000);
