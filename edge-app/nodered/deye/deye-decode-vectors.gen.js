'use strict';

/**
 * Erzeugt deye-decode-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * deye-decode.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/deyedecode (Edge Light).
 *
 * Das Muster des Hauses (goe-control-vectors.json, jcs-vectors.json): EINE
 * Datei, beide Seiten pruefen sich dagegen. Hier entstehen die erwarteten
 * Ausgaben aber nicht von Hand, sondern aus dem JS-Modul selbst - der Test
 * deye-decode-vectors.test.js rechnet sie bei jedem Lauf neu und schlaegt fehl,
 * sobald Modul und Datei auseinanderlaufen. Wer deye-decode.js aendert, fuehrt
 * dieses Skript aus und committet die neue Datei; der Go-Test zeigt dann, ob
 * der Zwilling mitgezogen werden muss.
 *
 *   node edge-app/nodered/deye/deye-decode-vectors.gen.js
 *
 * Bloecke stehen SPARSAM in der Datei ({start, count, set}) - ein 122er-Block
 * aus Nullen mit einer Handvoll gesetzter Register ist so lesbar. Beide Seiten
 * expandieren identisch (expandBlocks unten, expandBlocks im Go-Test).
 */

const fs = require('fs');
const path = require('path');
const D = require('./deye-decode.js');

const OUT = path.join(__dirname, 'deye-decode-vectors.json');

// --- Helfer fuer vorzeichenbehaftete Rohwerte ---------------------------------
const s16 = (v) => v & 0xffff; // -1500 -> 0xFA24
const lo32 = (v) => (v >>> 0) & 0xffff;
const hi32 = (v) => ((v >>> 0) >>> 16) & 0xffff;

function sparse(start, count, set) {
  const out = {};
  for (const [addr, val] of Object.entries(set || {})) out['0x' + Number(addr).toString(16).padStart(4, '0')] = val;
  return { start, count, set: out };
}

function expandBlocks(blocks) {
  return blocks.map((b) => {
    const regs = new Array(b.count).fill(0);
    for (const [k, v] of Object.entries(b.set)) {
      const off = parseInt(k, 16) - b.start;
      if (off < 0 || off >= b.count) throw new Error('Register ' + k + ' liegt nicht im Block ab 0x' + b.start.toString(16));
      regs[off] = v;
    }
    return { start: b.start, regs };
  });
}

// --- Die Bausteine der hybrid_3p-Karte ----------------------------------------
const DEV = (code) => sparse(0x0000, 1, { 0x0000: code });
const MEAS = (set) => sparse(0x024b, 0x007a, set);
const BMS_ABSENT = sparse(0x00d2, 0, {}); // optionaler Block, Firmware lehnt ab -> leer
const BMS = (set) => sparse(0x00d2, 0x000e, set);

// Ein typischer LV-Messblock (Entladung, Einspeisung am Netzanschlusspunkt).
const LV_LIVE = {
  0x024b: 5230, // Batteriespannung 52,30 V
  0x024c: 57, // SoC
  0x024e: s16(-1500), // Batterie -1,5 kW (Entladung)
  0x026b: lo32(-2300), // externer CT, low
  0x02c4: hi32(-2300), // externer CT, high
  0x0271: lo32(-2250), // Alias low
  0x02b2: hi32(-2250), // Alias high
  0x028d: 1800, // Last low
  0x0293: 0, // Last high
  0x02a0: 1000, // PV1
  0x02a1: 1200, // PV2
};

const cases = [
  {
    name: 'hybrid_3p LV: Entladung und Einspeisung',
    blocks: [DEV(0x0005), MEAS(LV_LIVE), BMS_ABSENT],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p HV (SG01HP3): Leistung und Spannung in der HV-Skala',
    blocks: [DEV(0x0008), MEAS({
      0x024b: 6360, 0x024c: 80, 0x024e: s16(2500),
      0x026b: lo32(-12000), 0x02c4: hi32(-12000),
      0x028d: 5000, 0x0293: 0,
      0x02a0: 1500, 0x02a1: 1400, 0x02a2: 1300, 0x02a3: 0,
    }), BMS_ABSENT],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: beide Vorzeichen invertiert',
    blocks: [DEV(0x0005), MEAS(LV_LIVE), BMS_ABSENT],
    config: { family: 'hybrid_3p', invert_grid_sign: true, invert_batt_sign: true },
  },
  {
    name: 'hybrid_3p: power_scale 10 schlaegt die LV-Kennung',
    blocks: [DEV(0x0005), MEAS(LV_LIVE), BMS_ABSENT],
    config: { family: 'hybrid_3p', power_scale: 10 },
  },
  {
    name: 'hybrid_3p: unbekannte Geraetekennung faellt auf Skala 1',
    blocks: [DEV(0x1234), MEAS(LV_LIVE), BMS_ABSENT],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: 32-Bit-Last ueber 32,7 kW (Hochwort gesetzt)',
    blocks: [DEV(0x0008), MEAS({ ...LV_LIVE, 0x028d: lo32(45000), 0x0293: hi32(45000) }), BMS_ABSENT],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: BMS gekoppelt, das Leitregister liefert den SoC',
    blocks: [DEV(0x0005), MEAS(LV_LIVE), BMS({
      0x00d2: 5600, 0x00d3: 4800, 0x00d4: 100, 0x00d5: 120, 0x00d6: 58,
      0x00d7: 5300, 0x00d8: s16(-25), 0x00da: 150, 0x00db: 150,
      0x00dc: 0, 0x00dd: 0, 0x00df: 0,
    })],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p HV: BMS-Strom mit HV-Faktor 0,1',
    blocks: [DEV(0x0008), MEAS({ ...LV_LIVE, 0x024b: 6400 }), BMS({
      0x00d2: 6800, 0x00d6: 61, 0x00d7: 6400, 0x00d8: s16(-255), 0x00df: 3,
    })],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: SoC fehlt, das gekoppelte BMS meldet ihn (ohne Opt-in)',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0 }), BMS({ 0x00d6: 64, 0x00d7: 5310 })],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: SoC fehlt ohne Opt-in -> Lesung verworfen',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0 }), BMS_ABSENT],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: SoC fehlt mit Opt-in -> Lesung ohne SoC',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0 }), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true },
  },
  {
    name: 'hybrid_3p: SoC fehlt mit Opt-in und Spannungsbereich -> Schaetzung',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0 }), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true, soc_from_voltage: { v_empty: 46, v_full: 54 } },
  },
  {
    name: 'hybrid_3p: Schaetzung wird auf 1 % geklemmt',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0, 0x024b: 4500 }), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true, soc_from_voltage: { v_empty: 46, v_full: 54 } },
  },
  {
    name: 'hybrid_3p: unsinniger Spannungsbereich schaetzt nichts',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 0 }), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true, soc_from_voltage: { v_empty: 54, v_full: 46 } },
  },
  {
    name: 'hybrid_3p: Leerantwort (alles 0) -> no_answer, auch mit Opt-in',
    blocks: [DEV(0x0005), MEAS({}), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true },
  },
  {
    name: 'hybrid_3p: SoC ausserhalb des Bereichs -> out_of_range',
    blocks: [DEV(0x0005), MEAS({ ...LV_LIVE, 0x024c: 1270 }), BMS_ABSENT],
    config: { family: 'hybrid_3p', allow_missing_soc: true },
  },
  {
    name: 'hybrid_3p: BMS-Block aus 14 Nullen ist keine Kopplung',
    blocks: [DEV(0x0005), MEAS(LV_LIVE), BMS({})],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_3p: schmaler Block ohne externes Hochwort -> Netz aus dem Alias',
    blocks: [DEV(0x0005), sparse(0x024b, 0x0068, {
      0x024b: 5230, 0x024c: 57, 0x024e: s16(-1500),
      0x0271: lo32(-2250), 0x02b2: hi32(-2250), 0x028d: 1800, 0x0293: 0, 0x02a0: 1000,
    })],
    config: { family: 'hybrid_3p' },
  },
  {
    name: 'hybrid_1p: niedrige Karte',
    blocks: [sparse(0x00a9, 0x0016, {
      0x00a9: s16(-800), 0x00b2: 900, 0x00b7: 5210, 0x00b8: 66,
      0x00ba: 2000, 0x00bb: 1500, 0x00be: s16(-300),
    })],
    config: { family: 'hybrid_1p' },
  },
  {
    name: 'string: 32-Bit-AC-Leistung x0,1',
    blocks: [sparse(0x0050, 2, { 0x0050: lo32(123456), 0x0051: hi32(123456) })],
    config: { family: 'string' },
  },
  {
    name: 'string: Nacht (0 W ist eine echte Messung)',
    blocks: [sparse(0x0050, 2, {})],
    config: { family: 'string' },
  },
  {
    name: 'micro: AC-Leistung x0,1',
    blocks: [sparse(0x0056, 2, { 0x0056: 7820, 0x0057: 0 })],
    config: { family: 'micro' },
  },
  {
    name: 'unbekannte Familie',
    blocks: [sparse(0x0050, 2, { 0x0050: 1 })],
    config: { family: 'gibt_es_nicht' },
  },
];

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const out = {
  _comment: [
    'GENERIERT von deye-decode-vectors.gen.js aus deye-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: deye-decode-vectors.test.js (JS) und edge-app/core/internal/deyedecode (Go, Edge Light).',
    'blocks stehen sparsam: {start, count, set:{"0xADDR": wort}}; nicht gesetzte Register sind 0.',
  ],
  plan_reads: {},
  soc_plausible: [-1, 0, 0.1, 1, 57, 100, 100.1, 1270].map((v) => ({ value: v, plausible: D.socPlausible(v) })),
  cases: [],
};

for (const fam of ['string', 'hybrid_1p', 'hybrid_3p', 'micro', 'gibt_es_nicht']) {
  out.plan_reads[fam] = D.planReads({ family: fam });
}

for (const c of cases) {
  const blocks = expandBlocks(c.blocks);
  out.cases.push({
    name: c.name,
    blocks: c.blocks,
    config: c.config,
    decode: clean(D.decode(blocks, c.config)),
    verbose: clean(D.decodeVerbose(blocks, c.config)),
  });
}

const text = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => text, expandBlocks, OUT };
