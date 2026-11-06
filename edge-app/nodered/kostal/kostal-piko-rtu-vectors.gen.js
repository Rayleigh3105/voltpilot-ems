'use strict';

/**
 * Erzeugt kostal-piko-rtu-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * kostal-piko-rtu-decode.js (Node-RED, Quelle der Wahrheit) und seinem
 * Go-Zwilling edge-app/core/internal/kostalrtu (Edge Light).
 *
 * Muster von kostal-dxs-vectors.gen.js / kaco-serial-vectors.gen.js: die
 * erwarteten Ausgaben entstehen aus dem JS-Modul selbst, nie von Hand.
 *
 *   node edge-app/nodered/kostal/kostal-piko-rtu-vectors.gen.js
 *
 * Eingabe jedes Falls sind gelesene Registerbloecke `{start, regs}` - so
 * pruefen beide Seiten dieselbe Adress-/Skalierungszuordnung (Report §3.2).
 */

const fs = require('fs');
const path = require('path');
const R = require('./kostal-piko-rtu-decode.js');

const OUT = path.join(__dirname, 'kostal-piko-rtu-vectors.json');

function block(start, regs) {
  return { start, regs };
}

/**
 * span - baut EINEN Block ueber [start, start+count) aus gezielt gesetzten
 * Werten (eine `address -> word`-Map), Luecken bleiben 0. Adressbasiert statt
 * handgezaehlter Arrays - die gleiche Disziplin, die der Decoder selbst
 * fuer das Lesen anwendet (`wordAt`), vermeidet einen Off-by-one beim
 * Zusammenbauen der Testdaten.
 */
function span(start, count, values) {
  const regs = new Array(count).fill(0);
  for (const [addr, v] of Object.entries(values)) regs[Number(addr) - start] = v;
  return block(start, regs);
}

// Ein voller Satz, angelehnt an das dxs-Beispiel (Report-Beispielwerte,
// dieselben physikalischen Groessen wie in kostal-dxs-vectors.gen.js) - jeder
// Wert ueber seine REG-Adresse gesetzt, wie TEST_BLOCKS[0] ihn liest.
const FULL_BLOCKS = [
  span(R.REG.DC1_V, R.REG.FREQUENCY - R.REG.DC1_V + 1, {
    [R.REG.DC1_V]: 3654, [R.REG.DC1_A]: 1210, [R.REG.DC1_W]: 4420,
    [R.REG.DC2_V]: 3649, [R.REG.DC2_A]: 1180, [R.REG.DC2_W]: 4280,
    [R.REG.L1_V]: 2312, [R.REG.L1_A]: 910, [R.REG.L1_W]: 2100,
    [R.REG.L2_V]: 2308, [R.REG.L2_A]: 900, [R.REG.L2_W]: 2080,
    [R.REG.L3_V]: 2315, [R.REG.L3_A]: 890, [R.REG.L3_W]: 2060,
    [R.REG.DC_TOTAL_W]: 12700, [R.REG.AC_TOTAL_W]: 31250,
    [R.REG.COS_PHI]: 100, [R.REG.FREQUENCY]: 500,
  }),
  block(R.REG.RATED_W, [20000]),
  span(R.REG.ENERGY_TOTAL_HI, R.REG.ENERGY_TODAY_WH - R.REG.ENERGY_TOTAL_HI + 1, {
    [R.REG.ENERGY_TOTAL_HI]: 503, [R.REG.ENERGY_TOTAL_LO]: 692,
    [R.REG.OPERATING_HOURS]: 33919, [R.REG.ENERGY_TODAY_WH]: 22207,
  }),
  asciiBlock(R.REG.NAME_START, 'PIKO20', R.REG.NAME_COUNT),
  asciiBlock(R.REG.SERIAL_START, '12345678', R.REG.SERIAL_COUNT),
];

/** asciiBlock - `count` Register ab `start`, zwei ASCII-Zeichen je Register (hohes Byte zuerst), mit Leerzeichen aufgefuellt. */
function asciiBlock(start, text, count) {
  const bytes = Buffer.from(text.padEnd(count * 2, ' '), 'ascii');
  const regs = new Array(count);
  for (let i = 0; i < count; i++) regs[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  return block(start, regs);
}

const cases = [
  { name: 'voller Satz (angelehnt an das Report-Beispiel)', blocks: FULL_BLOCKS },
  { name: 'nur die AC-Gesamtleistung (schneller Takt)', blocks: [block(R.REG.AC_TOTAL_W, [1234])] },
  { name: 'AC-Leistung fehlt -> decode liefert null', blocks: [block(30000, [1, 2, 3])] },
  { name: 'AC-Leistung 0', blocks: [block(R.REG.AC_TOTAL_W, [0])] },
  { name: 'kein Block -> alles abwesend', blocks: [] },
  { name: 'nur DC1 (ein String), Rest abwesend', blocks: [block(R.REG.DC1_V, [3654, 1210, 4420])] },
  { name: 'Gesamtertrag 32-Bit (503/692 -> 32965300 Wh)', blocks: [block(R.REG.ENERGY_TOTAL_HI, [503, 692])] },
  { name: 'Geraetename unvollstaendig (nur 1 von 13 Registern) -> abwesend', blocks: [block(R.REG.NAME_START, [0x5049])] },
];

const out = {
  _comment: [
    'GENERIERT von kostal-piko-rtu-vectors.gen.js aus kostal-piko-rtu-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: kostal-piko-rtu-decode.test.js (JS, direkt) und edge-app/core/internal/kostalrtu (Go, Edge Light).',
    'blocks sind gelesene Modbus-FC03-Registerbloecke {start, regs}; decode/decode_verbose sind die Modulfunktionen darauf.',
  ],
  constants: {
    default_port: R.DEFAULT_PORT,
    default_unit_id: R.DEFAULT_UNIT_ID,
    min_unit_id: R.MIN_UNIT_ID,
    max_unit_id: R.MAX_UNIT_ID,
    reg: R.REG,
    fast_block: R.FAST_BLOCK,
    test_blocks: R.TEST_BLOCKS,
  },
  cases: cases.map((c) => ({
    name: c.name,
    blocks: c.blocks,
    decode: R.decode(c.blocks),
    decode_verbose: R.decodeVerbose(c.blocks),
  })),
};

const textOut = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, textOut);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => textOut, OUT };
