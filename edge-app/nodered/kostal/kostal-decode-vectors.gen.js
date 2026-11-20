'use strict';

/**
 * Erzeugt kostal-decode-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * KOSTAL-PLENTICORE-Leser der Docker-Box (kostal-decode.js, Quelle der
 * Wahrheit; der Flow bettet das Modul ein) und seinem Go-Zwilling in Edge
 * Light (edge-app/core/internal/kostalplenticore).
 *
 * Festgehalten: der Leseplan (planReads) und fuer jeden Fall die Bloecke, wie
 * der Leser sie gelesen hat (ein abgelehnter Block fehlt), die Optionen und
 * das Ergebnis von decode().
 *
 *   node edge-app/nodered/kostal/kostal-decode-vectors.gen.js
 */

const fs = require('fs');
const path = require('path');
const K = require('./kostal-decode.js');

const OUT = path.join(__dirname, 'kostal-decode-vectors.json');

function f32words(x, order) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(x, 0);
  const hi = b.readUInt16BE(0);
  const lo = b.readUInt16BE(2);
  return order === 'big' ? [hi, lo] : [lo, hi];
}
function u32words(x, order) {
  const hi = Math.floor(x / 0x10000) & 0xffff;
  const lo = x & 0xffff;
  return order === 'big' ? [hi, lo] : [lo, hi];
}

// image(o) -> die fuenf Bloecke des Plans, gefuellt wie ein PLENTICORE BI.
function image(o) {
  const order = o.reg5 === 1 ? 'big' : 'little';
  const wo = o.wordsAs || order;
  const blocks = {
    5: [o.reg5 === undefined ? 0 : o.reg5],
    56: u32words(o.state === undefined ? 6 : o.state, wo),
    252: o.gridRaw || f32words(o.gridW === undefined ? 0 : o.gridW, wo),
    514: new Array(75).fill(0),
    1068: new Array(16).fill(0),
  };
  blocks[514][0] = o.soc === undefined ? 55 : o.soc;
  blocks[514][531 - 514] = o.maxPower === undefined ? 10000 : o.maxPower;
  blocks[514][582 - 514] = (o.battW === undefined ? 0 : o.battW) & 0xffff;
  blocks[514][588 - 514] = o.battType === undefined ? 0x0200 : o.battType;
  [blocks[1068][0], blocks[1068][1]] = f32words(o.capacity === undefined ? 10240 : o.capacity, wo);
  [blocks[1068][8], blocks[1068][9]] = f32words(o.maxCharge === undefined ? 5000 : o.maxCharge, wo);
  [blocks[1068][10], blocks[1068][11]] = f32words(o.maxDischarge === undefined ? 5500 : o.maxDischarge, wo);
  blocks[1068][12] = o.mgmt === undefined ? 0 : o.mgmt;
  blocks[1068][14] = o.sensor === undefined ? 0x03 : o.sensor;
  const skip = new Set(o.skip || []);
  return K.planReads({ family: 'kostal_plenticore' })
    .filter((r) => !skip.has(r.start))
    .map((r) => ({ start: r.start, regs: blocks[r.start].slice(0, r.count) }));
}

const raws = [
  ['Werkszustand little, KSEM, laedt 3,2 kW', { gridW: -1830.5, battW: -3200, soc: 62 }],
  ['big laut Register 5, entlaedt', { reg5: 1, gridW: 2412.25, battW: 4100, soc: 18 }],
  ['Register 5 = 1, Einstellung little', { reg5: 1, gridW: 1500, battW: 100 }, { byteOrder: 'little' }],
  ['Register 5 = 0, Einstellung big', { reg5: 0, gridW: 1500, battW: 100 }, { byteOrder: 'big' }],
  ['Register 5 unbekannt (7) -> little', { reg5: 7, gridW: 900 }],
  ['ohne Sensor kein Netzwert', { sensor: 0xff, gridW: 1234, battW: -500 }],
  ['Sensor 0 gilt als installiert', { sensor: 0, gridW: 321 }],
  ['SoC 0 faellt weg', { soc: 0, battW: 0 }],
  ['SoC 100 gilt', { soc: 100 }],
  ['SoC 101 faellt weg', { soc: 101, battW: 7 }],
  ['Netz-Float NaN', { gridRaw: [0x0000, 0x7fc0], battW: 10 }],
  ['Netz-Float unendlich', { gridRaw: [0x0000, 0x7f80], battW: 10 }],
  ['Batterie -32768', { battW: -32768 }],
  ['Batterie 32767', { battW: 32767 }],
  ['Rundung halb', { gridW: -0.5, battW: 1 }],
  ['Rundung SoC halb', { soc: 33 }],
  ['ohne Block 252', { gridW: 5000, skip: [252] }],
  ['ohne Block 514 (kein SoC, keine Batterie)', { gridW: 700, skip: [514] }],
  ['ohne Block 1068 (kein Sensortyp -> kein Netz)', { gridW: 700, skip: [1068] }],
  ['ohne Block 5 -> little', { gridW: 700, skip: [5] }],
  ['nur Block 5 -> keine Messung', { skip: [56, 252, 514, 1068] }],
  ['nur Block 1068 -> keine Messung', { skip: [5, 56, 252, 514] }],
  ['Status U32 gross', { state: 0x00010007, gridW: 1 }],
  ['falsche Wortfolge erzwungen', { gridW: 1500.75, battW: -20, wordsAs: 'big' }, { byteOrder: 'little' }],
  ['Management extern Modbus, BYD', { mgmt: 2, battType: 4, battW: -1000 }],
];

const cases = [];
for (const [name, o, opts0] of raws) {
  for (const flags of [{}, { invertGridSign: true, invertBattSign: true }]) {
    const opts = Object.assign({}, opts0 || {}, flags);
    const blocks = image(o);
    cases.push({ name, blocks, opts, decode: K.decode(blocks, opts) });
  }
}
const out = {
  _comment: [
    'GENERIERT von kostal-decode-vectors.gen.js aus kostal-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: kostal-decode-vectors.test.js (JS) und edge-app/core/internal/kostalplenticore (Go, Edge Light).',
  ],
  families: Object.keys(K.FAMILIES),
  default_port: K.DEFAULT_PORT,
  default_unit_id: K.DEFAULT_UNIT_ID,
  plan: K.planReads({ family: 'kostal_plenticore' }),
  plan_unknown: K.planReads({ family: 'kostal_piko' }),
  cases,
};

const text = JSON.stringify(out) + '\n';
if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + cases.length + ' Faelle, ' + Math.round(text.length / 1024) + ' KiB)');
}
module.exports = { build: () => text, OUT };
