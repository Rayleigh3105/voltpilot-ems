'use strict';

/**
 * Erzeugt huawei-decode-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * huawei-decode.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/huaweidecode (Edge Light).
 *
 * Das Muster von deye-decode-vectors.gen.js: Die erwarteten Ausgaben entstehen
 * nicht von Hand, sondern aus dem JS-Modul selbst. huawei-decode-vectors.test.js
 * rechnet sie bei jedem Lauf neu und schlaegt fehl, sobald Modul und Datei
 * auseinanderlaufen. Wer huawei-decode.js aendert, fuehrt dieses Skript aus
 * und committet die neue Datei; der Go-Test zeigt dann, ob der Zwilling
 * mitziehen muss.
 *
 *   node edge-app/nodered/huawei/huawei-decode-vectors.gen.js
 *
 * Bloecke stehen so in der Datei, wie der Leser sie dem Decoder gibt
 * ({start, regs}); Rohwerte sind u16. Vorzeichenbehaftete 32-Bit-Werte sind
 * nach der Huawei-Doku Big-Endian mit dem High-Word zuerst.
 */

const fs = require('fs');
const path = require('path');
const H = require('./huawei-decode.js');

const OUT = path.join(__dirname, 'huawei-decode-vectors.json');

// i32 -> [hiWord, loWord], Big-Endian, High-Word zuerst (die dokumentierte Falle).
function i32words(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

// image(regs) baut die vier Bloecke des Leseplans aus einem Registerbild
// (absolute Adresse -> u16); ungesetzte Adressen im Block lesen als 0.
// opts.omit laesst Bloecke weg (abgelehnter Block = fehlender Kanal).
function image(regs, opts) {
  opts = opts || {};
  const blocks = [];
  for (const b of H.planReads({ family: 'huawei_sun2000_luna' })) {
    if (opts.omit && opts.omit.includes(b.start)) continue;
    const out = [];
    for (let i = 0; i < b.count; i++) {
      const v = regs[b.start + i];
      out.push(v === undefined ? 0 : v & 0xffff);
    }
    blocks.push({ start: b.start, regs: out });
  }
  return blocks;
}

// regs(...) setzt ein Registerbild: i32-Werte als zwei Woerter, u16 direkt.
function regs(set) {
  const r = {};
  for (const [addr, v] of Object.entries(set)) {
    const a = Number(addr);
    if (Array.isArray(v)) {
      r[a] = v[0];
      r[a + 1] = v[1];
    } else {
      r[a] = v;
    }
  }
  return r;
}

const R = H.REG;

// Das gesunde Bild: PV 2,5 kW (DC), AC 1,8 kW (die LUNA laedt), Zaehler +300 W
// (Huawei-Register: + = Einspeisung, der Decoder dreht es auf VoltPilots
// + = Bezug, also -0,3 kW), SoC 62,5 %, Batterie laedt 0,7 kW, Status 2 (running).
const HEALTHY = {
  [R.INPUT_POWER_W]: i32words(2500),
  [R.ACTIVE_POWER_W]: i32words(1800),
  [R.METER_ACTIVE_POWER_W]: i32words(300),
  [R.BATTERY_SOC_PCT_X10]: 625,
  [R.BATTERY_RUNNING_STATUS]: 2,
  [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(700),
};

// Das Bild des Stand-ins der Kundenanlage (vp-kundenanlage-drei-geraete,
// huawei_sim.py): 11 kW Wallbox am Netzpunkt, Bezug 9,9 kW.
const KUNDE = {
  [R.INPUT_POWER_W]: i32words(2692),
  [R.ACTIVE_POWER_W]: i32words(1792),
  [R.METER_ACTIVE_POWER_W]: i32words(-9908),
  [R.BATTERY_SOC_PCT_X10]: 686,
  [R.BATTERY_RUNNING_STATUS]: 2,
  [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(900),
};

const NONE = {};
const INV_GRID = { invertGridSign: true };
const INV_BATT = { invertBattSign: true };
const INV_BOTH = { invertGridSign: true, invertBattSign: true };

const cases = [
  // --- das gesunde Bild und die Vorzeichen ------------------------------------
  { name: 'gesundes Bild (PV 2,5 kW DC, Zaehler-Register +300 W = Einspeisung -> power_kw -0,3, SoC 62,5 %, Batterie laedt 0,7)', blocks: image(regs(HEALTHY)), opts: NONE },
  { name: 'gesundes Bild, Netz-Vorzeichen-Klappe (Sensor verkehrt): Rohvorzeichen durchgereicht', blocks: image(regs(HEALTHY)), opts: INV_GRID },
  { name: 'gesundes Bild, Batterie-Vorzeichen invertiert', blocks: image(regs(HEALTHY)), opts: INV_BATT },
  { name: 'gesundes Bild, beide Klappen', blocks: image(regs(HEALTHY)), opts: INV_BOTH },
  { name: 'Entladung 0,7 kW liest negativ; Zaehler-Register -300 W = Bezug -> power_kw +0,3', blocks: image(regs({ ...HEALTHY, [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(-700), [R.METER_ACTIVE_POWER_W]: i32words(-300) })), opts: NONE },
  { name: 'Entladung/Bezug mit beiden Klappen', blocks: image(regs({ ...HEALTHY, [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(-700), [R.METER_ACTIVE_POWER_W]: i32words(-300) })), opts: INV_BOTH },
  { name: 'Kundenanlage: 11 kW Wallbox am Netzpunkt (Huawei-Register -9908 W = Bezug -> power_kw +9,908)', blocks: image(regs(KUNDE)), opts: NONE },
  { name: 'Kundenanlage mit Haken "Netz-Vorzeichen invertieren" (nur bei verkehrt angeschlossenem Sensor)', blocks: image(regs(KUNDE)), opts: INV_GRID },
  // --- Ladestand: nur (0, 100] ist eine Tatsache -----------------------------
  { name: 'SoC 0,0 % wird verworfen (Komm-Artefakt), Rest bleibt', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 0 })), opts: NONE },
  { name: 'SoC 0,1 % ist plausibel', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 1 })), opts: NONE },
  { name: 'SoC 100,0 % ist plausibel', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 1000 })), opts: NONE },
  { name: 'SoC 101,0 % wird verworfen', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 1010 })), opts: NONE },
  { name: 'SoC 1270,0 % wird verworfen', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 12700 })), opts: NONE },
  { name: 'SoC 0xFFFF wird verworfen', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 0xffff })), opts: NONE },
  { name: 'SoC 55,5 % (eine Nachkommastelle bleibt)', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 555 })), opts: NONE },
  // --- abwesend ist keine Null: je Block degradieren ---------------------------
  { name: 'ohne Zaehler-Block (kein Smart Power Sensor): power_kw fehlt', blocks: image(regs(HEALTHY), { omit: [R.METER_ACTIVE_POWER_W] }), opts: NONE },
  { name: 'ohne Batterie-Block: SoC und battKw fehlen, PV bleibt', blocks: image(regs(HEALTHY), { omit: [R.BATTERY_SOC_PCT_X10] }), opts: NONE },
  { name: 'ohne PV-Block: pv_power_kw fehlt', blocks: image(regs(HEALTHY), { omit: [R.INPUT_POWER_W] }), opts: NONE },
  { name: 'ohne AC-Block: nur meta.active_power_w fehlt', blocks: image(regs(HEALTHY), { omit: [R.ACTIVE_POWER_W] }), opts: NONE },
  { name: 'nur der AC-Block: nichts decodiert -> null (Meta allein ist kein Messwert)', blocks: image(regs(HEALTHY), { omit: [R.INPUT_POWER_W, R.METER_ACTIVE_POWER_W, R.BATTERY_SOC_PCT_X10] }), opts: NONE },
  { name: 'nur der Batterie-Block mit unplausiblem SoC: battKw allein traegt', blocks: image(regs({ ...HEALTHY, [R.BATTERY_SOC_PCT_X10]: 0 }), { omit: [R.INPUT_POWER_W, R.ACTIVE_POWER_W, R.METER_ACTIVE_POWER_W] }), opts: NONE },
  { name: 'keine Bloecke -> null', blocks: [], opts: NONE },
  // --- Blockgrenzen: der Leser liefert, was das Geraet antwortete ------------
  { name: 'Batterie-Block zu kurz (5 Register): SoC da, battKw fehlt', blocks: [{ start: R.INPUT_POWER_W, regs: i32words(2500) }, { start: R.BATTERY_SOC_PCT_X10, regs: [625, 0, 2, 0, 0] }], opts: NONE },
  { name: 'Batterie-Block um ein Register zu kurz (6): das High-Word allein reicht nicht', blocks: [{ start: R.BATTERY_SOC_PCT_X10, regs: [625, 0, 2, 0, 0, 0] }], opts: NONE },
  { name: 'ein Block, der vor dem Register beginnt, deckt es trotzdem', blocks: [{ start: R.INPUT_POWER_W - 4, regs: [0, 0, 0, 0, ...i32words(3210), 0] }], opts: NONE },
  { name: 'Bloecke in anderer Reihenfolge', blocks: image(regs(HEALTHY)).reverse(), opts: NONE },
  { name: 'doppelt gelieferter Block: der erste gewinnt', blocks: [{ start: R.INPUT_POWER_W, regs: i32words(1000) }, { start: R.INPUT_POWER_W, regs: i32words(2000) }], opts: NONE },
  { name: 'leerer Block zaehlt nicht', blocks: [{ start: R.INPUT_POWER_W, regs: [] }, { start: R.METER_ACTIVE_POWER_W, regs: i32words(-50) }], opts: NONE },
  // --- Zahlenraender -----------------------------------------------------------
  { name: 'PV 1 W = 0,001 kW; Zaehler -1 W; Batterie 1 W', blocks: image(regs({ [R.INPUT_POWER_W]: i32words(1), [R.METER_ACTIVE_POWER_W]: i32words(-1), [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(1) })), opts: NONE },
  { name: 'alle Werte 0 (Nacht, Batterie ruht): echte Nullen, SoC 0 verworfen', blocks: image(regs({})), opts: NONE },
  { name: 'alle Werte 0 mit Klappen: -0 wird als 0 geschrieben', blocks: image(regs({})), opts: INV_BOTH },
  { name: 'groesste positive I32 (2147483647 W)', blocks: image(regs({ [R.INPUT_POWER_W]: i32words(2147483647), [R.METER_ACTIVE_POWER_W]: i32words(2147483647), [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(2147483647) })), opts: NONE },
  { name: 'kleinste negative I32 (-2147483648 W)', blocks: image(regs({ [R.INPUT_POWER_W]: i32words(-2147483648), [R.METER_ACTIVE_POWER_W]: i32words(-2147483648), [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: i32words(-2147483648) })), opts: INV_BOTH },
  { name: 'nur das High-Word gesetzt (65536 W)', blocks: image(regs({ [R.INPUT_POWER_W]: [1, 0] })), opts: NONE },
  { name: 'High-Word 0xFFFF, Low-Word 0xFFFF = -1 W (kein 4294967295)', blocks: image(regs({ [R.INPUT_POWER_W]: [0xffff, 0xffff], [R.BATTERY_CHARGE_DISCHARGE_POWER_W]: [0xffff, 0xffff] })), opts: NONE },
  { name: 'Wortreihenfolge-Falle: ein Little-Endian-Geraet laese 300 W als 19660800 W', blocks: image(regs({ [R.INPUT_POWER_W]: [300, 0] })), opts: NONE },
  { name: 'AC-Leistung negativ (Bezug der Elektronik) und Status 4 (sleep)', blocks: image(regs({ ...HEALTHY, [R.ACTIVE_POWER_W]: i32words(-35), [R.BATTERY_RUNNING_STATUS]: 4 })), opts: NONE },
];

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const out = {
  _comment: [
    'GENERIERT von huawei-decode-vectors.gen.js aus huawei-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: huawei-decode-vectors.test.js (JS) und edge-app/core/internal/huaweidecode (Go, Edge Light).',
    'blocks sind die beantworteten FC3-Bloecke ({start, regs} mit u16); decode ist das Ergebnis von decode(blocks, opts) oder null.',
  ],
  constants: {
    reg: H.REG,
    default_port: H.DEFAULT_PORT,
    default_unit_id: H.DEFAULT_UNIT_ID,
    families: Object.keys(H.FAMILIES),
  },
  plan_reads: {
    huawei_sun2000_luna: H.planReads({ family: 'huawei_sun2000_luna' }).map((b) => [b.start, b.count]),
    kostal_plenticore: H.planReads({ family: 'kostal_plenticore' }).map((b) => [b.start, b.count]),
    ohne_familie: H.planReads({}).map((b) => [b.start, b.count]),
  },
  soc_plausible: [0, 0.05, 0.1, 50, 99.9, 100, 100.1, 101, 1270, 6553.5, -1, NaN, Infinity].map((v) => ({
    soc: Number.isFinite(v) ? v : String(v),
    ok: H.socPlausible(v),
  })),
  cases: cases.map((c) => ({ name: c.name, blocks: c.blocks, opts: c.opts, decode: clean(H.decode(c.blocks, c.opts)) })),
};

const text = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => text, OUT };
