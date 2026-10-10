'use strict';

/**
 * deye-grid-target.test.js - der netzseitige Drossel-Slot (Konzept
 * vp-deye-netzseitig-drossel-k2, Paket P3) auf der MODUL-Ebene: die Registerfolge,
 * die +50-W-Klemme, die Modell-Freigabe und die Hebel-Meldung. Der Draht steht in
 * deye-control.e2e.test.js, die Inline-Kopie des Flows in flows-sync.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const gt = require('./deye-grid-target');
const routing = require('./inverter-control-routing');

const CTX = Object.assign({ writeFc: 16, watchdogS: 60, ratedKw: 30 }, routing.DEYE_GRID_TARGET_FACTS);
const PILOT = { brand: 'deye', model: 'sun-30k-sg01hp3' };
const roles = (plan) => plan.planned.map((w) => w.role);

// The owner's live probe (2026-07-27) - the PR-978 layout.
function ownerCap() {
  const b = new Array(22).fill(0);
  b[1] = 0xffff; b[5] = 0x0002; b[10] = 0x0320; b[15] = 0x03e8; b[16] = 0xffff;
  return routing.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: b });
}
const SEL = {
  schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
  communication: 'solarman_v5', control_tier: 3, rated_kw: 30,
  connection: { ip: '192.168.254.210', port: 8899, serial: '1127365518', mb_slave_id: 1 },
};
const setpoint = (extra = {}) => ({
  battery_setpoint_kw: 5, source: 'schedule', ts: new Date().toISOString(),
  control_enabled: true, device_certified: true, soc_min_pct: 20, soc_max_pct: 95,
  battery_mode: 'grid_target', grid_target_kw: 0, pv_limit_kw: 12, ...extra,
});
const route = (sp, sel = SEL) => routing.controlRoute(sel, sp, { ratedKw: sel.rated_kw, deye: ownerCap() });

test('parseGridTarget ist streng: nur das Wort UND ein brauchbares Ziel', () => {
  assert.deepStrictEqual(gt.parseGridTarget(setpoint()), { targetKw: 0, neutralize: false });
  assert.deepStrictEqual(gt.parseGridTarget(setpoint({ grid_target_neutralize: true })), { targetKw: 0, neutralize: true });
  for (const sp of [
    null, {}, setpoint({ battery_mode: 'setpoint' }), setpoint({ battery_mode: 'native' }),
    setpoint({ grid_target_kw: undefined }), setpoint({ grid_target_kw: '0' }), setpoint({ grid_target_kw: NaN }),
    setpoint({ grid_target_kw: Infinity }),
  ]) {
    assert.strictEqual(gt.parseGridTarget(sp), null, JSON.stringify(sp));
  }
  // `neutralize` ist nur mit einem echten true ein Neutralschritt.
  assert.strictEqual(gt.parseGridTarget(setpoint({ grid_target_neutralize: 'true' })).neutralize, false);
});

test('das Ziel geht nie ueber +50 W - beim Lesen UND nach dem Runden auf Register-Einheiten', () => {
  for (const kw of [0.05, 0.051, 1, 30, 1e9]) {
    assert.strictEqual(gt.parseGridTarget(setpoint({ grid_target_kw: kw })).targetKw, 0.05);
  }
  assert.strictEqual(gt.parseGridTarget(setpoint({ grid_target_kw: -12.5 })).targetKw, -12.5, 'Einspeise-Ziele bleiben');
  for (const rated of [5, 8, 12, 30, 50, 80]) {
    const u = gt.gridTargetUnits(0.05, rated, CTX);
    assert.ok(u.units >= 0 && (u.units / CTX.unitsPerRated) * rated <= 0.05 + 1e-9,
      rated + ' kW: ' + u.units + ' Einheiten waeren ueber +50 W');
  }
  // 30 kW: 0,05 kW = 1,67 Einheiten -> 1 (30 W), nicht 2 (60 W).
  assert.strictEqual(gt.gridTargetUnits(0.05, 30, CTX).units, 1);
  // Einspeisung: direkt (nicht negiert), an der Registergrenze geklemmt.
  assert.deepStrictEqual(gt.gridTargetUnits(-24.9, 30, CTX), { units: -830, raw: (-830) & 0xffff, clamped: false });
  assert.deepStrictEqual(gt.gridTargetUnits(-90, 30, CTX), { units: -1200, raw: (-1200) & 0xffff, clamped: true });
  assert.strictEqual(gt.gridTargetUnits(0, 30, CTX).raw, 0, 'Null-Einspeisung ist eine glatte 0, kein -0');
});

test('die REIHENFOLGE ist die Sicherheit: Totmann, (Neutral), 1115, 1104, Ziel, Enable', () => {
  const first = gt.deyeGridTargetPlan({ targetKw: 0, neutralize: true }, CTX);
  assert.deepStrictEqual(roles(first),
    ['remote_watchdog', 'grid_neutral', 'pv_max_permille', 'power_control_mode', 'grid_power', 'remote_mode']);
  assert.deepStrictEqual(first.planned.map((w) => [w.addr, w.value]),
    [[0x044d, 60], [0x0455, 0], [0x045b, 999], [0x0450, 2], [0x0455, 0], [0x044c, 1]]);
  const held = gt.deyeGridTargetPlan({ targetKw: 0, neutralize: false }, CTX);
  assert.deepStrictEqual(roles(held), ['remote_watchdog', 'pv_max_permille', 'power_control_mode', 'grid_power', 'remote_mode']);
  // Der Neutralschritt steht VOR dem Seitenwechsel und wird nicht zurueckgelesen.
  assert.ok(roles(first).indexOf('grid_neutral') < roles(first).indexOf('power_control_mode'));
  assert.ok(!first.readbacks.some((r) => r.role === 'grid_neutral'));
  assert.deepStrictEqual(first.readbacks.map((r) => r.role), roles(held));
  // E5: die PV-Kappe steht vor dem Umschalten, und nie 1000 oder darueber.
  assert.ok(roles(first).indexOf('pv_max_permille') < roles(first).indexOf('power_control_mode'));
  assert.strictEqual(gt.GRID_TARGET_PV_MAX_PERMILLE, 999);
});

test('Kadenz: Totmann, Ziel und Enable jeden Takt - die Konfiguration nur bei Bedarf', () => {
  const p = gt.deyeGridTargetPlan({ targetKw: 0, neutralize: true }, CTX).planned;
  const byRole = Object.fromEntries(p.map((w) => [w.role, w]));
  for (const r of ['remote_watchdog', 'grid_neutral', 'grid_power', 'remote_mode']) {
    assert.strictEqual(byRole[r].always, true, r);
  }
  for (const r of ['pv_max_permille', 'power_control_mode']) {
    assert.strictEqual(byRole[r].always, undefined, r);
    assert.strictEqual(byRole[r].reassert_s, routing.DEYE_GRID_TARGET_FACTS.reassertS, r);
  }
  // RAM-Register: kein dwell, kein min_change (der Schreibvorgang IST der Totmann-Tritt).
  assert.ok(p.every((w) => w.dwell_s === 0 && w.min_change === 0));
});

test('die Rueckmeldung dekodiert das Ziel als NETZ-Leistung (nicht negiert)', () => {
  const p = gt.deyeGridTargetPlan({ targetKw: -3, neutralize: false }, CTX);
  const rb = p.readbacks.find((r) => r.role === 'grid_power');
  assert.deepStrictEqual(rb.decode, { kind: 'grid_power_permille', rated_kw: 30 });
  assert.strictEqual(rb.expect, (-100) & 0xffff);
  assert.strictEqual(rb.tolerance, 1);
});

test('die Freigabe ist modellbezogen und traegt ihren Pruefnachweis', () => {
  assert.ok(gt.gridTargetRelease(PILOT, 'pr978'));
  assert.ok(gt.gridTargetRelease({ brand: ' Deye ', model: 'SUN-30K-SG01HP3' }, 'pr978'), 'Schreibweise normalisiert');
  for (const [sel, layout] of [
    [{ brand: 'deye', model: 'sun-50k-sg01hp3' }, 'pr978'], // dieselbe Familie, anderes Modell
    [{ brand: 'deye', model: 'sun-12k-sg04lp3' }, 'pr978'],
    [PILOT, 'v105_1'], // eine andere Registerlage
    [PILOT, ''], [PILOT, undefined], [{ brand: 'deye' }, 'pr978'], [null, 'pr978'],
    [{ brand: 'fronius', model: 'sun-30k-sg01hp3' }, 'pr978'],
  ]) {
    assert.strictEqual(gt.gridTargetRelease(sel, layout), null, JSON.stringify([sel, layout]));
  }
  assert.ok(Object.isFrozen(gt.GRID_TARGET_RELEASES));
  for (const e of gt.GRID_TARGET_RELEASES) {
    assert.ok(Object.isFrozen(e));
    assert.match(e.benchRecord, /\d{2}\.\d{2}\.\d{4}/, 'ohne datierten Pruefnachweis keine Freigabe');
    assert.ok(e.benchRecord.length > 80);
  }
});

test('controlRoute: der Kern-Sollwert faehrt den netzseitigen Zweig - nur fuer das freigegebene Modell', () => {
  const plan = route(setpoint({ grid_target_neutralize: true }));
  assert.strictEqual(plan.controlPath, 'remote');
  assert.deepStrictEqual(plan.gridTarget, { target_kw: 0, neutralize: true, pv_cap_permille: 999 });
  assert.deepStrictEqual(plan.writes.map((w) => w.role),
    ['remote_watchdog', 'grid_neutral', 'pv_max_permille', 'power_control_mode', 'grid_power', 'remote_mode']);
  assert.ok(plan.writes.every((w) => w.bench_pending === undefined), 'ausfuehrbare Schreibvorgaenge tragen keinen Anzeige-Marker');
  assert.ok(!plan.writes.some((w) => w.role === 'battery_power' || w.role === 'battery_strategy'),
    'netzseitig wird KEIN Batterie-Sollwert geschrieben');
  assert.strictEqual(plan.pvLimitNote, undefined, 'der Deye drosselt hier seine eigene PV - kein "nicht moeglich"');
  assert.match(plan.reason, /Netzseitiger Drossel-Slot/);

  // Ein anderes Modell derselben Familie: der gewoehnliche Batterie-Plan, mit Hinweis.
  const other = route(setpoint(), Object.assign({}, SEL, { model: 'sun-50k-sg01hp3', rated_kw: 50 }));
  assert.strictEqual(other.gridTarget, undefined);
  assert.ok(other.writes.some((w) => w.role === 'battery_power'));
  assert.strictEqual(other.writes.find((w) => w.role === 'power_control_mode').value, 1);
  assert.match(other.gridTargetNote, /nicht freigegeben/);
});

test('controlRoute: kein Tor wird umgangen - Not-Aus, Zertifikat, Kalibrierung', () => {
  const off = route(setpoint({ control_enabled: false }));
  assert.deepStrictEqual(off.writes, []);
  assert.deepStrictEqual(off.readbacks, []);
  assert.match(off.reason, /Not-Aus/);
  assert.ok(off.planned.length > 0, 'die geplante Folge bleibt sichtbar');

  const uncert = route(setpoint({ device_certified: false }));
  assert.deepStrictEqual(uncert.writes, []);
  assert.match(uncert.reason, /noch nicht freigegeben/);

  // Die First-Light-Kalibrierung umgeht das Zertifikat des BATTERIE-Sollwerts -
  // diesen Zweig oeffnet sie nicht.
  const cal = route(setpoint({ device_certified: false, calibration: true }));
  assert.deepStrictEqual(cal.writes, []);
});

test('controlRoute: ohne das Wort des Kerns ist der Plan Zeichen fuer Zeichen der gewohnte', () => {
  const base = setpoint({ battery_mode: 'setpoint' });
  const a = route(base);
  const b = route(Object.assign({}, base, { grid_target_kw: 0, grid_target_neutralize: true }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)),
    'grid_target_kw ohne battery_mode "grid_target" bewegt nichts');
  assert.strictEqual(a.gridTarget, undefined);
  assert.strictEqual(a.gridTargetNote, undefined);
});

test('die Hebel-Meldung nennt grid_target nur fuer das freigegebene, zertifizierte Geraet', () => {
  const caps = (sel, opts) => routing.nativeCapabilityReport(sel, Object.assign({ deye: ownerCap() }, opts));
  assert.deepStrictEqual(caps(SEL, { deviceCertified: true }),
    { intents: ['cover_load', 'grid_target'], window: false, persistent: false });
  assert.deepStrictEqual(caps(SEL, { deviceCertified: false }), { intents: [], window: false, persistent: false });
  assert.ok(!caps(Object.assign({}, SEL, { model: 'sun-50k-sg01hp3' }), { deviceCertified: true }).intents.includes('grid_target'));
  // Der ToU-Pfad (kein Fernsteuerblock) hat den Hebel nicht.
  assert.strictEqual(routing.nativeCapabilityReport(SEL, { deviceCertified: true, deye: { present: false, supported: false, definitive: true } }), null);
  // withGridTargetLever: null bleibt null, doppelt wird nicht doppelt.
  assert.strictEqual(gt.withGridTargetLever(null, true), null);
  const once = gt.withGridTargetLever({ intents: ['grid_target'], window: false, persistent: false }, true);
  assert.deepStrictEqual(once.intents, ['grid_target']);
  const untouched = { intents: ['cover_load'], window: true, persistent: false };
  assert.strictEqual(gt.withGridTargetLever(untouched, false), untouched);
});

// --- Die gemeinsamen Vertragsvektoren (docs/contracts/v2/grid-target-vectors.json) ---
//
// Dieselbe Datei lesen der Go-Kern (Regel + Herzschlag) und die api. Hier bindet
// sich Layer 1: die Woerter, die es vom Kern liest und ihm meldet, die Grenzen
// und - Fall fuer Fall - die REGISTERFOLGE, die aus einem Kern-Sollwert wird.
const fs = require('node:fs');
const path = require('node:path');
const VECTORS = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'contracts', 'v2', 'grid-target-vectors.json'), 'utf8'));

test('Vertragsvektoren: Woerter und Grenzen sind die des Moduls', () => {
  const w = VECTORS.woerter;
  assert.strictEqual(w.battery_mode, gt.GRID_TARGET_MODE);
  assert.strictEqual(w.hebel, gt.GRID_TARGET_MODE);
  // Die drei Sollwert-Felder: genau diese Namen liest parseGridTarget.
  const sp = { battery_mode: w.battery_mode, [w.setpoint_ziel]: -1, [w.setpoint_neutralschritt]: true };
  assert.deepStrictEqual(gt.parseGridTarget(sp), { targetKw: -1, neutralize: true });
  assert.strictEqual(VECTORS.grenzen.ziel_max_kw, gt.GRID_TARGET_MAX_KW);
  assert.strictEqual(VECTORS.grenzen.pv_max_permille, gt.GRID_TARGET_PV_MAX_PERMILLE);
  assert.strictEqual(VECTORS.grenzen.regelseite_netz, routing.DEYE_GRID_TARGET_FACTS.gridSide);
  // Die zwei Rollen, an denen der Kern die Uebernahme erkennt.
  const rb = gt.deyeGridTargetPlan({ targetKw: 0, neutralize: false }, CTX).readbacks.map((r) => r.role);
  assert.ok(rb.includes(w.rueckmeldung_rolle_regelseite) && rb.includes(w.rueckmeldung_rolle_ziel));
});

test('Vertragsvektoren: aus dem Kern-Sollwert wird GENAU die genannte Registerfolge', () => {
  const a = VECTORS.sollwert.auswahl;
  const sel = Object.assign({}, SEL, { brand: a.brand, model: a.model, family: a.family, rated_kw: a.rated_kw });
  assert.ok(VECTORS.sollwert.faelle.length >= 3);
  for (const f of VECTORS.sollwert.faelle) {
    const plan = route(setpoint(Object.assign({ grid_target_neutralize: undefined }, f.setpoint)), sel);
    assert.ok(plan.gridTarget, f.name + ': der netzseitige Zweig laeuft');
    assert.deepStrictEqual(plan.writes.map((w) => [w.addr, w.value]), f.folge, f.name + ': Folge');
    assert.deepStrictEqual(plan.readbacks.map((r) => r.role), f.rueckmeldung, f.name + ': Rueckmeldung');
    assert.ok(plan.gridTarget.target_kw <= VECTORS.grenzen.ziel_max_kw, f.name + ': nie ein Bezugs-Ziel');
  }
});
