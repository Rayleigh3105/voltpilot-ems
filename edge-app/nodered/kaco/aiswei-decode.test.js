'use strict';

// aiswei-decode - die AISWEI-native Registerkarte des KACO hybrid NH3.
// Offline, ohne Geraet: die Blocke werden gebaut wie ein echter FC4/FC3-Lauf
// sie liefern wuerde.

const test = require('node:test');
const assert = require('node:assert');
const A = require('./aiswei-decode');

// Einen Block bauen: `set` ist { Doku-Nummer: Wert(e) }.
function block(fc, startDoc, count, set) {
  const base = fc === 4 ? A.inputAddr(startDoc) : A.holdingAddr(startDoc);
  const regs = new Array(count).fill(0);
  for (const [doc, val] of Object.entries(set)) {
    const addr = (fc === 4 ? A.inputAddr(Number(doc)) : A.holdingAddr(Number(doc))) - base;
    const vals = Array.isArray(val) ? val : [val];
    vals.forEach((v, k) => { regs[addr + k] = v & 0xffff; });
  }
  return { fc, start: base, count, regs };
}

// Ein 32-Bit-Wert als [hi, lo] (ABCD - hohes Wort zuerst).
function w32(v) {
  const u = v >>> 0;
  return [(u >>> 16) & 0xffff, u & 0xffff];
}

function measure(set) { return block(4, A.REG.PV_TOTAL_W, 25, set); }
function identity(set) { return block(4, A.REG.DEVICE_TYPE, 28, set); }
function grid(w) { return block(3, A.REG.GRID_TOTAL_W, 2, { 46434: w32(w) }); }

test('die Modicon-Umrechnung ist die eine Stelle, an der gerechnet wird', () => {
  assert.strictEqual(A.inputAddr(31001), 1000);
  assert.strictEqual(A.inputAddr(31601), 1600);
  assert.strictEqual(A.inputAddr(31619), 1618);
  assert.strictEqual(A.inputAddr(31622), 1621);
  assert.strictEqual(A.holdingAddr(46434), 6433);
});

test('planReads traegt seinen FUNKTIONSCODE mit - die Karte mischt Input und Holding', () => {
  const plan = A.planReads({ family: 'kaco_nh3' });
  assert.strictEqual(plan.length, 3);
  assert.deepStrictEqual(plan.map((p) => p.fc), [4, 4, 3]);
  assert.deepStrictEqual(plan[1], { fc: 4, start: 1600, count: 25 });
  assert.deepStrictEqual(plan[2], { fc: 3, start: 6433, count: 2 });
  for (const p of plan) assert.ok(p.count <= 125, 'unter der FC-Grenze');
  // Eine unbekannte Familie plant NICHTS (idle-sicher).
  assert.deepStrictEqual(A.planReads({ family: 'sunspec_live' }), []);
});

test('die volle Messung eines ladenden NH3', () => {
  const out = A.decode([
    identity({ 31001: 3, 31002: 3, 31028: 12000 }),
    measure({
      31601: w32(5400), // 5,4 kW PV (DC)
      31617: 3850, 31618: 62,
      31619: w32(-3000), // AISWEI: - = laden
      31622: 7825, // 78,25 %
      31623: 99,
      31605: w32(4952), // 495,2 kWh
    }),
    grid(-500), // 0,5 kW Einspeisung
  ], {});
  assert.deepStrictEqual(out.reading, { pv_power_kw: 5.4, power_kw: -0.5, soc_pct: 78.3 });
  assert.strictEqual(out.battKw, 3); // laden -> POSITIV in VoltPilot
  assert.strictEqual(out.meta.device_type, 3);
  assert.strictEqual(out.meta.modbus_address, 3);
  assert.strictEqual(out.meta.rated_power, 12000);
  assert.strictEqual(out.meta.soh_pct, 99);
  assert.strictEqual(out.meta.energy_total_kwh, 495.2);
});

test('entladen wird negativ, Bezug positiv', () => {
  const out = A.decode([measure({ 31619: w32(2800), 31622: 4100 }), grid(3200)], {});
  assert.strictEqual(out.battKw, -2.8);
  assert.strictEqual(out.reading.power_kw, 3.2);
});

test('die beiden Vorzeichen-Ausweg sind die der First-Light-Pruefung', () => {
  const blocks = [measure({ 31619: w32(-3000) }), grid(-500)];
  const out = A.decode(blocks, { invertBattSign: true, invertGridSign: true });
  assert.strictEqual(out.battKw, -3);
  assert.strictEqual(out.reading.power_kw, 0.5);
});

test('ein SoC ausserhalb (0,100] faellt WEG - nie eine erfundene 0', () => {
  for (const raw of [0, 10001, 65535]) {
    const out = A.decode([measure({ 31601: w32(1000), 31622: raw })], {});
    assert.strictEqual('soc_pct' in out.reading, false, 'roh ' + raw);
  }
  assert.strictEqual(A.decode([measure({ 31622: 10000 })], {}).reading.soc_pct, 100);
});

test('ein FEHLENDER Block laesst genau seine Kanaele weg (Netz-Block nicht gelesen)', () => {
  const out = A.decode([measure({ 31601: w32(5400), 31622: 5000 })], {});
  assert.deepStrictEqual(out.reading, { pv_power_kw: 5.4, soc_pct: 50 });
  assert.strictEqual('power_kw' in out.reading, false);
});

test('Input und Holding sind GETRENNTE Adressraeume - dieselbe Zahl meint Verschiedenes', () => {
  // Ein Holding-Block, dessen Draht-Adressen zufaellig im Input-Bereich der
  // Messwerte laegen, darf die PV NICHT liefern.
  const fake = { fc: 3, start: 1600, count: 25, regs: new Array(25).fill(0x1234) };
  assert.strictEqual(A.decode([fake], {}), null);
});

test('gar nichts Lesbares ergibt null - der Flow bleibt idle-sicher', () => {
  assert.strictEqual(A.decode([], {}), null);
  assert.strictEqual(A.decode(null, {}), null);
  assert.strictEqual(A.decode([identity({ 31001: 3 })], {}), null); // nur Identitaet: keine Messung
});

test('die Familie erklaert, dass sie eine Batterie fuehrt', () => {
  assert.strictEqual(A.FAMILIES.kaco_nh3.hasBattery, true);
  assert.strictEqual(A.DEFAULT_PORT, 502);
  assert.strictEqual(A.DEFAULT_UNIT_ID, 1);
});
