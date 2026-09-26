'use strict';

// K5 "Deye Überschuss-Übergabe": the pure charge-side module - the two
// candidates' bytes, the extended own-config precondition (decision table), the
// active ToU program, the pilot parser and Box ② (selectDeyeChargeSide).

const test = require('node:test');
const assert = require('node:assert');
const dcs = require('./deye-charge-side');
const routing = require('./inverter-control-routing');
const native = require('./unplanned-load-native');

const FACTS = routing.DEYE_CHARGE_SIDE_FACTS;
const REG = routing.DEYE_CONTROL_REG.hybrid_3p;
const cands = () => dcs.deyeChargeSideCandidates(FACTS, { reg: REG, writeFc: 16, watchdogS: 60 });
const KEY = { brand: 'deye', model: 'sun-30k-sg01hp3', firmware: native.DEYE_REMOTE_PR978_FIRMWARE };

// The own-configuration block as the executor caches it (0x008D..0x00B1).
function block({ workMode = 2, pattern = 1, solarSell = 1, tou = 0x00ff,
  times = [0, 500, 900, 1300, 1700, 2100], power = 3000, soc = 5, charge = 0 } = {}) {
  const spec = dcs.deyeOwnConfigBlockSpec(REG);
  const b = new Array(spec.count).fill(0);
  const set = (addr, v) => { b[addr - spec.addr] = v; };
  set(REG.energyPattern, pattern); set(REG.workMode, workMode);
  set(REG.solarSell, solarSell); set(REG.touEnable, tou);
  for (let i = 0; i < 6; i++) {
    set(REG.progTimeBase + i, times[i]);
    set(REG.progPowerBase + i, Array.isArray(power) ? power[i] : power);
    set(REG.progSocBase + i, Array.isArray(soc) ? soc[i] : soc);
    set(REG.progChargeBase + i, Array.isArray(charge) ? charge[i] : charge);
  }
  return b;
}
const own = (intent, b, { nowMin = 600, floor = 10, solarOnly = true } = {}) =>
  dcs.deyeOwnConfigPrecondition(FACTS, intent, { own_config: b, now_min: nowMin },
    { floorPct: floor, solarOnly, reg: REG });

test('the own-config block is ONE read: Energy Pattern .. Program 6 Charging (37 registers)', () => {
  assert.deepStrictEqual(dcs.deyeOwnConfigBlockSpec(REG), { role: 'own_config', fc: 3, addr: 0x008d, count: 37 });
});

test('grid_zero plans the certified order and states its heartbeat and PV side effect', () => {
  const g = cands().grid_zero;
  assert.deepStrictEqual(g.planned.map((w) => [w.addr, w.value]),
    [[0x044d, 60], [0x0455, 0], [0x0450, 2], [0x045b, 999], [0x044c, 1]]);
  assert.deepStrictEqual(g.planned.filter((w) => w.always).map((w) => w.addr), [0x044d, 0x0455, 0x044c],
    'the RAM kick: watchdog, target, enable - exactly like the ordinary remote plan');
  assert.ok(g.planned.filter((w) => !w.always).every((w) => w.reassert_s === FACTS.reassertS));
  assert.ok(g.heartbeat && g.curtailsOwnPv && !g.windowSupported);
  assert.ok(g.planned.every((w) => w.value !== 1000), '1115 is never 1000 (that throttles the own PV to 0)');
  // The bytes a release records are exactly these (drift = refusal).
  const e = native.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'x');
  assert.ok(native.certificateMatchesPlan(e, g.planned, g.readbacks));
  const o = cands().own_config;
  assert.ok(native.certificateMatchesPlan(native.releaseDeyeChargeSide('own_config', 'surplus_charge', 'x'), o.planned, o.readbacks));
  assert.ok(!o.heartbeat && !o.curtailsOwnPv);
});

test('an operator-tuned watchdog is a drift: the pilot measured 60 s', () => {
  const g = dcs.deyeChargeSideCandidates(FACTS, { reg: REG, writeFc: 16, watchdogS: 120 }).grid_zero;
  assert.ok(!native.certificateMatchesPlan(native.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'x'), g.planned, g.readbacks));
});

test('the active ToU program is the one with the latest start <= now (wrapping before the first)', () => {
  const t = [100, 500, 900, 1300, 1700, 2100];
  assert.strictEqual(dcs.deyeActiveProgram(t, 30), 5, '00:30 < 01:00 -> the day wraps to program 6');
  assert.strictEqual(dcs.deyeActiveProgram(t, 60), 0, 'from 01:00 program 1');
  assert.strictEqual(dcs.deyeActiveProgram(t, 9 * 60), 2);
  assert.strictEqual(dcs.deyeActiveProgram(t, 23 * 60 + 59), 5);
  assert.strictEqual(dcs.deyeActiveProgram([0, 0, 0, 0, 0, 0], 600), 5, 'ties: the later program governs');
  assert.strictEqual(dcs.deyeActiveProgram([0, 500, 2460, 1300, 1700, 2100], 600), -1, 'an impossible time is unreadable');
  assert.strictEqual(dcs.deyeActiveProgram(t, NaN), -1);
});

test('decision table: E-up (surplus_charge) on the own configuration', () => {
  assert.strictEqual(own('surplus_charge', block({ tou: 0x00fe })), null, 'ToU off: no discharge into the house (manual)');
  assert.strictEqual(own('surplus_charge', block({ power: 0 })), null, 'ToU on, active program power 0');
  assert.match(own('surplus_charge', block()), /Programm 3 erlaubt dem Wechselrichter zu entladen/);
  // Only the ACTIVE program counts: power 0 now (program 3 at 10:00), 3000 elsewhere.
  assert.strictEqual(own('surplus_charge', block({ power: [3000, 3000, 0, 3000, 3000, 3000] })), null);
  assert.match(own('surplus_charge', block({ power: [3000, 3000, 0, 3000, 3000, 3000] }), { nowMin: 14 * 60 }), /Programm 4/);
});

test('decision table: E (self_consumption) on the own configuration', () => {
  assert.strictEqual(own('self_consumption', block()), null, 'Zero Export To CT + Load First + Solar Sell + ToU covering to 5 %');
  assert.match(own('self_consumption', block({ workMode: 0 })), /Selling First/,
    'Herzogau: with ToU active the manual lets it sell battery energy');
  assert.match(own('self_consumption', block({ tou: 0x00fe })), /Time of Use/);
  assert.match(own('self_consumption', block({ power: 0 })), /keine Entladeleistung/);
  assert.match(own('self_consumption', block({ soc: 30 })), /Reserve-Untergrenze/);
  assert.match(own('self_consumption', block(), { floor: NaN }), /Reserve-Untergrenze der Anlage ist nicht bekannt/);
});

test('decision table: settings that are never a safe self-consumption', () => {
  assert.match(own('surplus_charge', block({ workMode: 1 })), /Zero Export To Load/);
  assert.match(own('surplus_charge', block({ workMode: 7 })), /Arbeitsmodus .*unbekannt/);
  assert.match(own('surplus_charge', block({ pattern: 0 })), /Battery First/);
  assert.match(own('surplus_charge', block({ pattern: 5 })), /Energiemuster .*unbekannt/);
  assert.match(own('surplus_charge', block({ workMode: 2, solarSell: 0 })), /Solar Sell/);
  assert.match(own('surplus_charge', block({ power: 0, charge: 1 })), /EEG-Anlage/);
  assert.strictEqual(own('surplus_charge', block({ power: 0, charge: 1 }), { solarOnly: false }), null,
    'grid charging is only a refusal on an EEG site');
  assert.match(own('surplus_charge', block({ times: [0, 500, 9999, 1300, 1700, 2100] })), /Zeitfenster-Programm gerade gilt/);
});

test('decision table: nothing read is a refusal, never an assumption', () => {
  const f = (cfg) => dcs.deyeOwnConfigPrecondition(FACTS, 'surplus_charge', cfg, { floorPct: 10, solarOnly: true, reg: REG });
  assert.match(f(undefined), /nicht bekannt/);
  assert.match(f({ now_min: 600 }), /konnte nicht gelesen werden/);
  assert.match(f({ own_config: block().slice(0, 20), now_min: 600 }), /konnte nicht gelesen werden/);
  assert.match(dcs.deyeOwnConfigPrecondition(FACTS, 'grid_charge', { own_config: block() }, { reg: REG }), /Unbekannte Absicht/);
});

// vp-wr-deye-tou-schreibbudget: E-down judges the SAME table (its E row) on the
// block read - not Program 1 alone, and not without the Work Mode.
const down = (b, opts) => own('cover_load', b, opts);
const HERZOGAU = { workMode: 0, pattern: 1, solarSell: 1, tou: 0x00ff };

test('E-down: the Herzogau setting (Selling First, ToU active) is refused - it may sell storage energy', () => {
  const r = down(block(HERZOGAU));
  assert.match(r, /Selling First/);
  assert.match(r, /Speicherenergie ins Netz verkaufen/);
  assert.match(r, /nur Verbrauch decken/, 'the sentence names what E-down promises');
  assert.strictEqual(dcs.deyeCoverLoadPrecondition(FACTS, { own_config: block(HERZOGAU), now_min: 600 },
    { floorPct: 10, solarOnly: true, reg: REG }), r, 'the exported E-down gate is exactly this row');
  // K5's own sentence for E is unchanged.
  assert.match(own('self_consumption', block(HERZOGAU)), /das ist kein Eigenverbrauch/);
});

test('E-down: a setting that cannot sell storage energy passes exactly as before', () => {
  // Zero Export To CT + Solar Sell (sells only PV), Load First, ToU on, discharge
  // allowed down to the floor, grid charging off.
  assert.strictEqual(down(block()), null);
  assert.strictEqual(down(block({ solarSell: 1, workMode: 2 }), { solarOnly: false }), null);
});

test('E-down: the program that governs NOW decides, not Program 1', () => {
  const times = [0, 500, 900, 1300, 1700, 2100];
  // 10:00 -> Program 3 (09:00). Program 1 would pass; Program 3 has no discharge power.
  const r = down(block({ times, power: [3000, 3000, 0, 3000, 3000, 3000] }), { nowMin: 600 });
  assert.match(r, /Programm 3 hat keine Entladeleistung/);
  // Program 1's target SoC above the floor no longer refuses while Program 3 governs.
  assert.strictEqual(down(block({ times, soc: [40, 5, 5, 5, 5, 5] }), { nowMin: 600 }), null);
  assert.match(down(block({ times, soc: [5, 5, 40, 5, 5, 5] }), { nowMin: 600 }), /Programm 3 \(40 %\) liegt über/);
  // EEG: the governing program's Charging flag.
  assert.match(down(block({ times, charge: [0, 0, 1, 0, 0, 0] }), { nowMin: 600 }), /EEG-Anlage: das gerade gültige Zeitfenster-Programm 3/);
});

test('E-down: every other row of the table refuses as for E', () => {
  assert.match(down(block({ tou: 0x0000 })), /nicht aktiv/);
  assert.match(down(block({ workMode: 1 })), /Zero Export To Load/);
  assert.match(down(block({ workMode: 7 })), /Arbeitsmodus des Wechselrichters \(7\) ist unbekannt/);
  assert.match(down(block({ pattern: 0 })), /Battery First/);
  assert.match(down(block({ solarSell: 0 })), /ohne „Solar Sell“/);
  assert.match(down(block(), { floor: null }), /Reserve-Untergrenze der Anlage ist nicht bekannt/);
  assert.match(dcs.deyeCoverLoadPrecondition(FACTS, { tou_enable: 0x00ff, program_target_soc: 5, grid_charge_enable: 0 },
    { floorPct: 10, reg: REG }), /konnte nicht gelesen werden/, 'the three Program-1 reads alone are no longer enough');
});

test('E-down reads the three Program-1 registers plus the block', () => {
  assert.deepStrictEqual(dcs.deyeCoverLoadPreconditions(FACTS, REG).map((p) => [p.role, p.addr, p.count || 1]),
    [['tou_enable', 0x0092, 1], ['program_target_soc', 0x00a6, 1], ['grid_charge_enable', 0x00ac, 1], ['own_config', 0x008d, 37]]);
  assert.deepStrictEqual(dcs.deyeCoverLoadPreconditions(FACTS, REG), cands().own_config.preconditions,
    'the same reads as the own_config candidate - one cache serves both');
});

test('grid_zero precondition: known config, known floor, EEG proof', () => {
  const g = (cfg, o) => dcs.deyeGridZeroPrecondition(FACTS, cfg, o);
  assert.match(g(undefined, { floorPct: 10 }), /nicht bekannt/);
  assert.match(g({ grid_charge_enable: 0 }, { floorPct: undefined }), /Reserve-Untergrenze/);
  assert.match(g({ grid_charge_enable: 1 }, { floorPct: 10, solarOnly: true }), /EEG-Anlage/);
  assert.match(g({}, { floorPct: 10, solarOnly: true }), /EEG-Anlage/, 'an unread charge enum is not a proof');
  assert.strictEqual(g({ grid_charge_enable: 0 }, { floorPct: 10, solarOnly: true }), null);
  assert.strictEqual(g({ grid_charge_enable: 1 }, { floorPct: 10, solarOnly: false }), null);
});

test('parseNativePilot accepts only a known candidate with a charge-side intent', () => {
  assert.deepStrictEqual(dcs.parseNativePilot({ candidate: 'grid_zero', intent: 'self_consumption', run: 'r1' }),
    { candidate: 'grid_zero', intent: 'self_consumption', run: 'r1' });
  assert.strictEqual(dcs.parseNativePilot({ candidate: 'grid_one', intent: 'self_consumption' }), null);
  assert.strictEqual(dcs.parseNativePilot({ candidate: 'own_config', intent: 'cover_load' }), null);
  assert.strictEqual(dcs.parseNativePilot(null), null);
  assert.strictEqual(dcs.parseNativePilot('grid_zero'), null);
});

test('Box ② on the Deye charge side: no entry, pilot, entry, drift, fallback to the next entry', () => {
  const precond = { deyeOwnConfig: { grid_charge_enable: 0, own_config: block({ workMode: 0 }), now_min: 600 },
    effectiveFloorSocPct: 10, solarOnlyCharge: true };
  const sel = (catalog, extra = {}) => dcs.selectDeyeChargeSide(Object.assign({
    native, catalog, key: KEY, intent: 'self_consumption', candidates: cands(), windowNarrower: false, pilot: null, precond,
  }, extra));
  assert.match(sel(native.CERTIFIED_NATIVE_CAPABILITIES).refusal, /Prüfstand/, 'production: nothing released yet');
  const p = sel(native.CERTIFIED_NATIVE_CAPABILITIES, { pilot: { candidate: 'grid_zero', intent: 'self_consumption' } });
  assert.strictEqual(p.name, 'grid_zero'); assert.strictEqual(p.entry, null);
  assert.match(sel([], { pilot: { candidate: 'grid_zero', intent: 'surplus_charge' } }).refusal, /passt nicht/);
  // Both entries released, own_config first in the catalog: its precondition
  // refuses the Herzogau "Selling First" -> the next entry (grid_zero) is chosen.
  const both = [native.releaseDeyeChargeSide('own_config', 'self_consumption', 'x'),
    native.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'y')];
  const r = sel(both);
  assert.strictEqual(r.name, 'grid_zero'); assert.strictEqual(r.entry.benchRecord, 'y');
  // Only own_config released -> its refusal is the answer.
  assert.match(sel(both.slice(0, 1)).refusal, /Selling First/);
  // A narrower window has no lever on either candidate.
  assert.match(sel(both, { windowNarrower: true }).refusal, /enger/);
  // Drift: an entry whose bytes differ from the adapter's refuses.
  const drifted = Object.freeze({ ...both[1], chargeBlockWrites: [{ addr: 0x044c, value: 1 }] });
  assert.match(sel([drifted]).refusal, /stimmen nicht/);
});

test('the reads that ride on a charge-side plan: the union over the candidates in play', () => {
  const c = cands();
  assert.deepStrictEqual(dcs.deyeChargeSidePreconditions(c, ['grid_zero']).map((p) => p.role),
    ['tou_enable', 'program_target_soc', 'grid_charge_enable']);
  assert.deepStrictEqual(dcs.deyeChargeSidePreconditions(c, ['grid_zero', 'own_config']).map((p) => p.role),
    ['tou_enable', 'program_target_soc', 'grid_charge_enable', 'own_config']);
  assert.deepStrictEqual(dcs.deyeChargeSidePreconditions(c, []), []);
});

test('the certificate side: prepared, not released - and a release needs its evidence', () => {
  const words = native.CERTIFIED_NATIVE_CAPABILITIES.filter((e) => e.brand === 'deye').map((e) => e.capability);
  assert.deepStrictEqual(words, ['native_charge_block_discharge_auto'],
    'K5 ships NO Deye charge-side entry - the pilot decides (captain triggers each window)');
  assert.throws(() => native.releaseDeyeChargeSide('grid_zero', 'self_consumption', native.DEYE_CHARGE_SIDE_BENCH_PLACEHOLDER), /Prüfnachweis/);
  assert.throws(() => native.releaseDeyeChargeSide('grid_zero', 'self_consumption', '  '), /Prüfnachweis/);
  assert.throws(() => native.releaseDeyeChargeSide('grid_one', 'self_consumption', 'x'), /Kandidat/);
  assert.throws(() => native.releaseDeyeChargeSide('grid_zero', 'cover_load', 'x'), /Ladeseiten/);
  const e = native.releaseDeyeChargeSide('grid_zero', 'surplus_charge', 'Pilot 2026-10-01 F11');
  assert.strictEqual(e.capability, 'native_surplus_charge');
  assert.strictEqual(e.interlockLifted, 'deye');
  assert.strictEqual(e.windowLimits, false, 'no volatile limit inside the own mode: E~ stays the box\'s');
  assert.ok(Object.isFrozen(e));
  assert.strictEqual(native.exactCapability(KEY, [e], 'native_surplus_charge'), e);
  assert.strictEqual(native.exactCapability({ ...KEY, model: 'sun-12k-sg04lp3' }, [e], 'native_surplus_charge'), null);
});

test('the commented release lines in the catalog are exactly the four prepared entries', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'unplanned-load-native.js'), 'utf8');
  const lines = src.split('\n').filter((l) => /^\s*\/\/ releaseDeyeChargeSide\(/.test(l));
  assert.strictEqual(lines.length, 4);
  for (const l of lines) {
    assert.ok(l.includes(native.DEYE_CHARGE_SIDE_BENCH_PLACEHOLDER), 'each carries the placeholder, so a bare uncomment throws');
  }
});

test('nativeLevers counts an intent once its FIRST matching entry is found', () => {
  const both = [native.releaseDeyeChargeSide('own_config', 'surplus_charge', 'x'),
    native.releaseDeyeChargeSide('grid_zero', 'surplus_charge', 'y')];
  const c = cands();
  const seen = [];
  const r = native.nativeLevers(KEY, both, (intent, entry) => {
    seen.push(entry && entry.candidate);
    // own_config's plan "drifted": only grid_zero can still count.
    if (entry && entry.candidate === 'own_config') return { planned: [], readbacks: [] };
    const k = entry && c[entry.candidate];
    return k ? { planned: k.planned, readbacks: k.readbacks } : null;
  });
  assert.deepStrictEqual(r, { intents: ['surplus_charge'], window: false, persistent: false });
  assert.deepStrictEqual(seen, ['own_config', 'grid_zero']);
});
