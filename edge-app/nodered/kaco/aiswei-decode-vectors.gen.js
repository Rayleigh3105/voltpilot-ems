'use strict';

/**
 * Erzeugt aiswei-decode-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * KACO-NH3-Leser der Docker-Box ueber die AISWEI-Registerkarte
 * (aiswei-decode.js, Quelle der Wahrheit; der Flow bettet das Modul ein) und
 * seinem Go-Zwilling in Edge Light (edge-app/core/internal/aiswei).
 *
 * Festgehalten: der Leseplan mit Funktionscode je Block (planReads) und fuer
 * jeden Fall die Bloecke, wie der Leser sie gelesen hat (ein abgelehnter Block
 * fehlt), die Optionen und das Ergebnis von decode().
 *
 *   node edge-app/nodered/kaco/aiswei-decode-vectors.gen.js
 */

const fs = require('fs');
const path = require('path');
const A = require('./aiswei-decode.js');

const OUT = path.join(__dirname, 'aiswei-decode-vectors.json');

const u32 = (x) => [Math.floor((x >>> 0) / 0x10000) & 0xffff, (x >>> 0) & 0xffff];

// image(o) -> die drei Bloecke des Plans, gefuellt wie ein NH3.
function image(o) {
  const dev = new Array(28).fill(0);
  dev[0] = o.devType === undefined ? 3 : o.devType;
  dev[1] = 3;
  for (let i = 0; i < 16; i++) dev[2 + i] = 0x4141 + i; // Seriennummer (ASCII, wird nicht dekodiert)
  dev[27] = o.rated === undefined ? 10000 : o.rated;
  const meas = new Array(25).fill(0);
  [meas[0], meas[1]] = u32(o.pv === undefined ? 4200 : o.pv);
  [meas[4], meas[5]] = u32(o.eTotal === undefined ? 123456 : o.eTotal);
  meas[7] = o.bstate === undefined ? 2 : o.bstate;
  meas[16] = o.vb === undefined ? 512 : o.vb;
  meas[17] = (o.ab === undefined ? -12 : o.ab) & 0xffff;
  [meas[18], meas[19]] = u32(o.pb === undefined ? -2500 : o.pb);
  meas[21] = o.soc === undefined ? 6250 : o.soc;
  meas[22] = o.soh === undefined ? 98 : o.soh;
  const grid = u32(o.grid === undefined ? -1800 : o.grid);
  const regs = { '4:1000': dev, '4:1600': meas, '3:6433': grid };
  return A.planReads({ family: 'kaco_nh3' }).map((r) => ({ fc: r.fc, start: r.start, regs: regs[r.fc + ':' + r.start] }));
}

const raws = [
  ['NH3 tagsueber, laedt, Einspeisung', {}],
  ['entlaedt, Netzbezug', { pb: 3100, grid: 2200, pv: 0, soc: 2350 }],
  ['SoC 0 faellt weg', { soc: 0 }],
  ['SoC 100,00 gilt', { soc: 10000 }],
  ['SoC 100,01 faellt weg', { soc: 10001 }],
  ['SoC 0,04 rundet auf 0', { soc: 4 }],
  ['SoC 33,35', { soc: 3335 }],
  ['PV gross (U32)', { pv: 0x00012345 }],
  ['Batterie S32 Minimum', { pb: -2147483648 }],
  ['Batterie S32 Maximum', { pb: 2147483647 }],
  ['Netz S32 negativ halb', { grid: -1 }],
  ['Batteriestrom S16 negativ', { ab: -32768 }],
  ['Energie gesamt gross', { eTotal: 4294967295 }],
];

const cases = [];
for (const [name, o] of raws) {
  for (const flags of [{}, { invertGridSign: true, invertBattSign: true }]) {
    const blocks = image(o);
    cases.push({ name, blocks, opts: flags, decode: A.decode(blocks, flags) });
  }
}
// Abgelehnte Bloecke: es fehlen genau ihre Kanaele.
const full = image({});
const pick = (keep) => full.filter((b) => keep.includes(b.fc + ':' + b.start));
for (const [name, keep] of [
  ['nur Geraeteblock -> keine Messung', ['4:1000']],
  ['ohne Netzblock', ['4:1000', '4:1600']],
  ['nur Netzblock', ['3:6433']],
  ['ohne Messblock', ['4:1000', '3:6433']],
  ['kein Block', []],
]) {
  const blocks = pick(keep);
  cases.push({ name, blocks, opts: {}, decode: A.decode(blocks, {}) });
}
// Dieselbe Adresse in der falschen Tabelle zaehlt nicht (Input und Holding sind getrennt).
const wrongTable = [{ fc: 3, start: 1600, regs: full[1].regs }, { fc: 4, start: 6433, regs: full[2].regs }];
cases.push({ name: 'Bloecke in der falschen Tabelle', blocks: wrongTable, opts: {}, decode: A.decode(wrongTable, {}) });

const out = {
  _comment: [
    'GENERIERT von aiswei-decode-vectors.gen.js aus aiswei-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: aiswei-decode-vectors.test.js (JS) und edge-app/core/internal/aiswei (Go, Edge Light).',
  ],
  families: Object.keys(A.FAMILIES),
  default_port: A.DEFAULT_PORT,
  default_unit_id: A.DEFAULT_UNIT_ID,
  plan: A.planReads({ family: 'kaco_nh3' }),
  cases,
};

const text = JSON.stringify(out) + '\n';
if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + cases.length + ' Faelle, ' + Math.round(text.length / 1024) + ' KiB)');
}
module.exports = { build: () => text, OUT };
