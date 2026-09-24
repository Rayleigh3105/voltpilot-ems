'use strict';

// Steuerprofile ↔ Adapter (K7, concept vp-wechselrichter-eigenregelung-k1 §4).
//
// The control profiles under catalog/control-profiles DESCRIBE what the adapters
// write; the write sequences themselves stay code in inverter-control-routing.js
// and sunspec/model-discovery.js. This test holds the two together: each
// `adapter.folgen` sequence of a profile must be exactly what the planner builds
// today (registers, order, fixed values, readbacks). A planner change without a
// profile update - or the reverse - fails here.
//
// ⚠ A profile never releases anything: the certificate stays the only release
// (CERTIFIED_NATIVE_CAPABILITIES, certificateMatchesPlan). The last tests only
// check that the certificate and the profile SAY the same thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./inverter-control-routing.js');
const U = require('./unplanned-load-native.js');
const sunspec = require('./sunspec/model-discovery.js');

const PROFILES = path.join(__dirname, '..', '..', 'catalog', 'control-profiles', 'profiles');
const profile = (id) => JSON.parse(fs.readFileSync(path.join(PROFILES, `${id}.json`), 'utf8'));

// --- fixtures (as in inverter-control-routing.test.js) ------------------------

function remoteBlock(over = {}) {
  const b = new Array(22).fill(0);
  b[1101 - 1100] = 0xffff;
  b[1105 - 1100] = 0x0002;
  b[1110 - 1100] = 0x0320;
  b[1115 - 1100] = 0x03e8;
  b[1116 - 1100] = 0xffff;
  for (const k of Object.keys(over)) b[Number(k) - 1100] = over[k];
  return b;
}
const REMOTE_CAP = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: remoteBlock() });
const TOU_CAP = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: remoteBlock({ 1100: 0x0500, 1101: 0x0500 }) });
const DEYE_TOU_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5',
  connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 },
};
const DEYE_REMOTE_SEL = {
  schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p', communication: 'solarman_v5',
  connection: { ip: '192.168.254.210', port: 8899, serial: '1127365518', mb_slave_id: 1 },
};
const PILOT_OPTS = {
  controlEnabled: true, deviceCertified: true, deye: REMOTE_CAP, effectiveFloorSocPct: 20,
  deyeOwnConfig: { tou_enable: 0x00ff, program_target_soc: 15, grid_charge_enable: 0 },
};
const KOSTAL_SEL = {
  schema_version: '1.0', brand: 'kostal', family: 'kostal_plenticore', communication: 'kostal_modbus',
  control_tier: 2, rated_kw: 10, connection: { ip: '192.168.0.30', port: 1502, unit_id: 71, byte_order: 'auto' },
};
const KACO_SEL = {
  schema_version: '1.0', brand: 'kaco', family: 'kaco_nh3', communication: 'kaco_modbus', control_tier: 1,
  connection: { ip: '192.168.0.31', port: 502, unit_id: 1 },
};

// A live SunSpec discovery over a minimal register image (Common, Nameplate
// 12 kW, Immediate Controls SF -2, optionally Storage 10 kW).
function sunspecDiscovery(withStorage) {
  const base = sunspec.DEFAULT_BASE;
  const img = new Map();
  img.set(base, (sunspec.SID >>> 16) & 0xffff);
  img.set(base + 1, sunspec.SID & 0xffff);
  let addr = base + 2;
  const put = (id, body) => {
    img.set(addr, id & 0xffff);
    img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  };
  const np = new Array(26).fill(0);
  np[sunspec.M120.WRtg] = 12000;
  const ctl = new Array(sunspec.M123.LENGTH).fill(0);
  ctl[sunspec.M123.WMaxLimPct_SF] = -2 & 0xffff;
  put(sunspec.MODEL.COMMON, new Array(66).fill(0));
  put(sunspec.MODEL.NAMEPLATE, np);
  put(sunspec.MODEL.IMMEDIATE_CONTROLS, ctl);
  if (withStorage) {
    const st = new Array(sunspec.M124.LENGTH).fill(0);
    st[sunspec.M124.WChaMax] = 1000; st[sunspec.M124.WChaMax_SF] = 1;
    st[sunspec.M124.InOutWRte_SF] = -2 & 0xffff;
    st[sunspec.M124.MinRsvPct_SF] = -2 & 0xffff;
    put(sunspec.MODEL.STORAGE, st);
  }
  img.set(addr, sunspec.END_MODEL_ID); img.set(addr + 1, 0);
  return sunspec.discover((a, count) => {
    const out = [];
    for (let i = 0; i < count; i++) { const w = img.get(a + i); if (w === undefined) break; out.push(w); }
    return out;
  });
}
const DISCOVERY = sunspecDiscovery(true);
const SUNSPEC_POINTS = { 123: sunspec.M123, 124: sunspec.M124 };

// --- comparison ---------------------------------------------------------------

function addrOf(ziel) {
  if (Object.prototype.hasOwnProperty.call(ziel, 'register')) return ziel.register;
  const [model, point] = ziel.sunspec.split('.');
  const m = DISCOVERY.models.find((x) => x.id === Number(model));
  assert.ok(m && SUNSPEC_POINTS[model] && Number.isInteger(SUNSPEC_POINTS[model][point]), `SunSpec-Punkt ${ziel.sunspec}`);
  return m.bodyAddr + SUNSPEC_POINTS[model][point];
}

// Registers and order must match exactly; a NUMERIC profile value must be the
// planned value, a text value ("planwert", "planabhängig") depends on the plan.
function assertSteps(label, steps, ops, valueKey) {
  assert.deepEqual(ops.map((o) => o.addr), steps.map((s) => addrOf(s.ziel)), `${label}: Register und Reihenfolge`);
  steps.forEach((s, i) => {
    const want = valueKey === 'expect' ? s.erwartet : s.wert;
    if (typeof want === 'number') assert.equal(ops[i][valueKey], want, `${label}: Wert an ${ops[i].addr}`);
  });
}
const assertWrites = (label, folge, planned) => assertSteps(label, folge.schreibfolge, planned, 'value');
function assertReadbacks(label, folge, readbacks) {
  if (folge.beleg === null) return;
  assertSteps(`${label} (Beleg)`, folge.beleg, readbacks, 'expect');
}

const setpoint = (kw) => ({ battery_setpoint_kw: kw, control_enabled: true, device_certified: true });

// --- Deye --------------------------------------------------------------------------

test('Deye Fernsteuer-Block: Profil deye_hp3_remote = heutiger Plan von deyeRemoteControl', () => {
  const p = profile('deye_hp3_remote');
  const f = p.adapter.folgen;
  for (const kw of [3, -3]) {
    const r = C.controlRoute(DEYE_REMOTE_SEL, setpoint(kw), { ratedKw: 30, deye: REMOTE_CAP });
    assertWrites(`sollwert ${kw} kW`, f.sollwert, r.planned);
    assertReadbacks(`sollwert ${kw} kW`, f.sollwert, r.readbacks);
    assert.ok(r.planned.every((o) => o.dwell_s === p.adapter.schreibabstand_s));
  }
  const hold = C.controlRoute(DEYE_REMOTE_SEL, setpoint(0), { ratedKw: 30, deye: REMOTE_CAP });
  assertWrites('halten', f.halten, hold.planned);
  assertReadbacks('halten', f.halten, hold.readbacks);

  const native = C.nativeSelfConsumption(DEYE_REMOTE_SEL, PILOT_OPTS);
  assertWrites('uebergabe', f.uebergabe, native.planned);
  assertReadbacks('uebergabe', f.uebergabe, native.readbacks);
  assert.deepEqual(p.uebergabe.schreibfolge, f.uebergabe.schreibfolge);
  assert.deepEqual(p.uebergabe.beleg, f.uebergabe.beleg);

  assertWrites('rueckgabe', f.rueckgabe, C.controlRelease(DEYE_REMOTE_SEL, { deye: REMOTE_CAP }).planned);

  assert.equal(p.totmann.sekunden, C.DEYE_REMOTE_WATCHDOG_DEFAULT_S);
  assert.equal(p.totmann.ziel.register, C.DEYE_REMOTE_REG.watchdog);
  assert.equal(p.firmware_bedingung.wert, U.DEYE_REMOTE_PR978_FIRMWARE);
  assert.equal(REMOTE_CAP.layout, C.DEYE_REMOTE_LAYOUT_PR978, 'die Firmware-Bedingung ist das Sonden-Urteil');
  for (const b of p.bindung) assert.equal(b.steuerpfad, C.DEYE_PATH_REMOTE);
});

// K5: the two charge-side candidates are described in the profile (E cell +
// adapter.folgen) exactly as deye-charge-side.js plans them, and each prepared
// (commented) release entry attests those bytes with a RAM hand-over.
test('Deye Ladeseite (K5): Profilfolgen = Kandidaten des Planers, vorbereitete Zertifikate passen', () => {
  const p = profile('deye_hp3_remote');
  const f = p.adapter.folgen;
  // The pilot's natural window needs the nameplate (the fixture has none).
  const sel = { ...DEYE_REMOTE_SEL, rated_kw: 30 };
  const win = { nativeMode: 'native_window', intent: 'self_consumption', windowMinKw: -30, windowMaxKw: 30 };
  const cfg = { ...PILOT_OPTS.deyeOwnConfig, grid_charge_enable: 0 };
  const gz = C.nativeSelfConsumption(sel, { ...PILOT_OPTS, ...win, deyeOwnConfig: cfg,
    pilot: { candidate: 'grid_zero', intent: 'self_consumption' } });
  assert.equal(gz.candidate, 'grid_zero', gz.reason);
  assertWrites('ladeseite_netz_null', f.ladeseite_netz_null, gz.planned);
  assertReadbacks('ladeseite_netz_null', f.ladeseite_netz_null, gz.readbacks);
  assert.equal(p.absichten.E.adapter_folge, 'ladeseite_netz_null');
  // own_config: its plan is the same one write whether or not the device's
  // configuration passes - the bytes come from the candidate itself.
  const cands = require('./deye-charge-side.js').deyeChargeSideCandidates(C.DEYE_CHARGE_SIDE_FACTS,
    { reg: C.DEYE_CONTROL_REG.hybrid_3p, writeFc: 16, watchdogS: 60 });
  assertWrites('ladeseite_eigenkonfiguration', f.ladeseite_eigenkonfiguration, cands.own_config.planned);
  assertReadbacks('ladeseite_eigenkonfiguration', f.ladeseite_eigenkonfiguration, cands.own_config.readbacks);
  const toPairs = (steps) => steps.map((s) => ({ addr: addrOf(s.ziel), value: s.wert }));
  const toChecks = (b) => b.map((x) => ({ addr: addrOf(x.ziel), expect: x.erwartet }));
  for (const [cand, folge] of [['grid_zero', f.ladeseite_netz_null], ['own_config', f.ladeseite_eigenkonfiguration]]) {
    for (const intent of ['surplus_charge', 'self_consumption']) {
      const e = U.releaseDeyeChargeSide(cand, intent, 'Test');
      assert.deepEqual(e.chargeBlockWrites, toPairs(folge.schreibfolge), `${cand}/${intent}: Bytes`);
      assert.deepEqual(e.readbackChecks, toChecks(folge.beleg), `${cand}/${intent}: Beleg`);
      assert.equal(e.persistent === true, folge.schreibfolge.some((s) => s.speicher === 'dauerspeicher'));
      assert.equal(e.watchdogSpec.timeoutS, p.totmann.sekunden);
      assert.equal(e.firmware, p.firmware_bedingung.wert);
    }
  }
});

test('Deye ToU: Profil deye_tou = heutiger Plan von deyeControl, jeder Schritt Dauerspeicher', () => {
  const p = profile('deye_tou');
  const f = p.adapter.folgen;
  for (const [name, kw] of [['laden', 3], ['halten', 0], ['entladen', -3]]) {
    const r = C.controlRoute(DEYE_TOU_SEL, setpoint(kw), { deye: TOU_CAP });
    assertWrites(name, f[name], r.planned);
    assertReadbacks(name, f[name], r.readbacks);
    assert.ok(r.planned.every((o) => o.dwell_s === p.adapter.schreibabstand_s), `${name}: Schreibabstand`);
    assert.ok(f[name].schreibfolge.every((s) => s.speicher === 'dauerspeicher'), `${name}: EEPROM`);
  }
  assertWrites('rueckgabe', f.rueckgabe, C.controlRelease(DEYE_TOU_SEL, { deye: TOU_CAP }).planned);
  assert.equal(p.schreibbudget.speicher, 'dauerspeicher');
  assert.equal(p.daempfung.box_regelt, false, 'Dauerspeicher-Hebel: keine Box-Regelung (§6.5)');
  for (const b of p.bindung) assert.equal(b.steuerpfad, C.DEYE_PATH_TOU);
});

// --- KOSTAL / KACO -----------------------------------------------------------------

test('KOSTAL: Profil kostal = heutiger Plan von kostalControl (1034, Vorbedingung 1080)', () => {
  const p = profile('kostal');
  const f = p.adapter.folgen;
  for (const [name, kw] of [['sollwert', 3], ['sollwert', -3], ['halten', 0]]) {
    const r = C.controlRoute(KOSTAL_SEL, setpoint(kw), {});
    assertWrites(`${name} ${kw} kW`, f[name], r.planned);
    const gate = p.adapter.vorbedingung.map((v) => ({ addr: addrOf(v.ziel), expect: v.erwartet }));
    assert.deepEqual({ addr: r.mgmt_gate.addr, expect: r.mgmt_gate.expect }, gate[0]);
    const reads = r.readbacks.filter((rb) => !gate.some((g) => g.addr === rb.addr));
    assertReadbacks(`${name} ${kw} kW`, f[name], reads);
  }
  assert.equal(C.KOSTAL_REG.SETPOINT, p.absichten.N.schreibfolge[0].ziel.register);
  assertWrites('rueckgabe', f.rueckgabe, C.controlRelease(KOSTAL_SEL, {}).planned);
  assert.deepEqual(p.absichten.E.schreibfolge, [], 'Eigenverbrauch = Schreiben einstellen');
});

test('KACO NH3: Profil kaco_nh3 = heutiger Plan von kacoNh3Control, Schreiben hart gesperrt', () => {
  const p = profile('kaco_nh3');
  const f = p.adapter.folgen;
  for (const [name, kw] of [['laden', 3], ['halten', 0], ['entladen', -3]]) {
    const r = C.controlRoute(KACO_SEL, setpoint(kw), {});
    assertWrites(name, f[name], r.planned);
    assert.deepEqual(r.writes, [], 'ausfuehrbar: false - auch mit Zertifikat keine Schreibvorgänge');
  }
  assert.equal(p.adapter.ausfuehrbar, false);
  assertWrites('uebergabe', f.uebergabe, C.nativeSelfConsumption(KACO_SEL, { controlEnabled: true, deviceCertified: true }).planned);
  assertWrites('rueckgabe', f.rueckgabe, C.controlRelease(KACO_SEL, {}).planned);
  assert.equal(C.KACO_NH3_CONTROL_REG.MODE_SELF_CONSUMPTION, p.uebergabe.schreibfolge[0].wert);
});

// --- Fronius -----------------------------------------------------------------------

test('Fronius PV: Profil fronius_pv = Model-123-Block von planCurtailment, Rückfall-Timer 60 s', () => {
  const p = profile('fronius_pv');
  const f = p.adapter.folgen.abregeln;
  const plan = sunspec.planCurtailment({ discovery: DISCOVERY, pvLimitKw: 6 });
  assert.equal(plan.writes.length, 1, 'ein FC16-Block');
  assertWrites('abregeln', f, plan.writes[0].parts);
  assertReadbacks('abregeln', f, plan.readbacks);
  assert.equal(p.totmann.sekunden, sunspec.DEFAULT_RVRT_TMS);
  assert.equal(p.adapter.ausfuehrbar, true);
});

test('Fronius GEN24: Profil fronius_gen24 hält den nur geplanten planStorage fest (Abweichungen benannt)', () => {
  const p = profile('fronius_gen24');
  const f = p.adapter.folgen;
  for (const [name, kw] of [['laden', 3], ['entladen', -3], ['halten', 0]]) {
    const plan = sunspec.planStorage({ discovery: DISCOVERY, batterySetpointKw: kw, gridChargeAllowed: false, socMinPct: 10 });
    assertWrites(name, f[name], plan.writes);
  }
  assert.equal(p.adapter.ausfuehrbar, false);
  assert.equal(p.bindung, null, 'GEN24 ist keine eigene Auswahl in der Box - K9');
  assert.ok(p.adapter.abweichungen.length > 0, 'planStorage weicht von der Fronius-Anleitung ab - benannt, nicht versteckt');
});

// --- Zertifikat und Profil sagen dasselbe - freigeben tut nur das Zertifikat -------

test('jedes Produktions-Zertifikat passt zu einem Profil mit gelesener Firmware-Bedingung', () => {
  const all = fs.readdirSync(PROFILES).filter((n) => n.endsWith('.json')).map((n) => profile(n.slice(0, -5)));
  for (const cert of U.CERTIFIED_NATIVE_CAPABILITIES) {
    const p = all.find((x) => x.firmware_bedingung && x.firmware_bedingung.wert === cert.firmware
      && (x.bindung || []).some((b) => b.marke === cert.brand));
    assert.ok(p, `Zertifikat ${cert.brand}/${cert.model}/${cert.firmware}: kein Profil`);
    assert.equal(p.firmware_bedingung.gelesen, true);
    assert.equal(p.freigabe, 'keine');
    const persistent = cert.persistent === true;
    assert.equal(persistent, p.uebergabe.speicher === 'dauerspeicher',
      `${cert.model}: persistent im Zertifikat vs. uebergabe.speicher im Profil`);
    if (cert.capability === 'native_charge_block_discharge_auto') {
      const toPairs = (steps) => steps.map((s) => ({ addr: addrOf(s.ziel), value: s.wert }));
      assert.deepEqual(cert.chargeBlockWrites, toPairs(p.uebergabe.schreibfolge));
      assert.deepEqual(cert.readbackChecks, p.uebergabe.beleg.map((b) => ({ addr: addrOf(b.ziel), expect: b.erwartet })));
      assert.deepEqual(cert.releaseWrites, toPairs(p.uebergabe.ruecknahme));
      assert.equal(cert.watchdogSpec.timeoutS, p.totmann.sekunden);
    }
  }
});

test('ein Profil gibt nichts frei: kein Profil trägt ein Zertifikatswort', () => {
  const words = new Set(['certified', 'capability', 'interlockLifted', 'benchRecord', 'chargeBlockWrites']);
  for (const name of fs.readdirSync(PROFILES).filter((n) => n.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(PROFILES, name), 'utf8');
    for (const w of words) assert.ok(!raw.includes(`"${w}"`), `${name}: ${w}`);
    assert.equal(JSON.parse(raw).freigabe, 'keine');
  }
});
