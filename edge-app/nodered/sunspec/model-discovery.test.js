'use strict';

/**
 * Offline tests for the real SunSpec model-discovery walker + the Model 123
 * curtailment mapping. No hardware, no sockets: we build a fixture SunSpec
 * register image and a synchronous readBlock over it, exactly the reader shape
 * production passes (a Modbus-TCP FC3 reader). Safety-critical - these pin that a
 * missing/truncated list or an absent Model 123 fails IDLE-SAFE (no fabricated
 * address, no write plan).
 *
 * Run: node --test edge-app/nodered/sunspec/model-discovery.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const D = require('./model-discovery.js');

// --- fixture builder ---------------------------------------------------------

// Build a sparse register image (Map addr->u16) laid out as a real SunSpec device
// would: [SID hi, SID lo] at base, then each model as [id, len, ...body], then the
// [0xFFFF, 0] end marker. `models` = [{ id, body:[...words] }] in list order.
function buildImage(base, models) {
  const img = new Map();
  img.set(base, (D.SID >>> 16) & 0xffff);
  img.set(base + 1, D.SID & 0xffff);
  let addr = base + 2;
  for (const m of models) {
    const body = m.body || [];
    img.set(addr, m.id & 0xffff);
    img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  }
  img.set(addr, D.END_MODEL_ID);
  img.set(addr + 1, 0);
  return img;
}

// A reader that returns a SHORT array past the image end (a gap) - so a truncated
// list surfaces exactly as an unreadable header, the way a finite register file
// on a real device behaves.
function readerOver(img) {
  return (addr, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = img.get(addr + i);
      if (w === undefined) break;
      out.push(w);
    }
    return out;
  };
}

// A model-120 nameplate body with WRtg + WRtg_SF at the standard offsets. Uses
// WRtg=1200, SF=1 -> 12000 W = 12 kW, so the test also exercises the scale factor.
function nameplateBody(wRtg, wRtgSf) {
  const body = new Array(26).fill(0);
  body[D.M120.WRtg] = wRtg & 0xffff;
  body[D.M120.WRtg_SF] = wRtgSf & 0xffff;
  return body;
}

// A model-123 immediate-controls body with the WMaxLimPct scale factor set.
function controlsBody(sf) {
  const body = new Array(D.M123.LENGTH).fill(0);
  body[D.M123.WMaxLimPct_SF] = sf & 0xffff; // signed sunssf, stored as u16
  return body;
}

const commonBody = () => new Array(66).fill(0);
const invBody = () => new Array(50).fill(0);
const storageBody = () => new Array(D.M124.LENGTH).fill(0);

// A model-124 storage body with WChaMax + the InOutWRte/MinRsvPct scale factors
// set, so finalize() reads the live scalars for the kW<->% conversion. Defaults:
// WChaMax=1000, SF=1 -> 10000 W = 10 kW; InOutWRte_SF=-2; MinRsvPct_SF=-2.
function storageBodyWith(opts) {
  opts = opts || {};
  const body = new Array(D.M124.LENGTH).fill(0);
  body[D.M124.WChaMax] = (opts.wChaMax != null ? opts.wChaMax : 1000) & 0xffff;
  body[D.M124.WChaMax_SF] = (opts.wChaMaxSf != null ? opts.wChaMaxSf : 1) & 0xffff;
  body[D.M124.InOutWRte_SF] = (opts.inOutWRteSf != null ? opts.inOutWRteSf : -2) & 0xffff;
  body[D.M124.MinRsvPct_SF] = (opts.minRsvPctSf != null ? opts.minRsvPctSf : -2) & 0xffff;
  return body;
}

// A full, realistic GEN24-shaped list (report §1.3 sequence).
function fullDeviceModels(inverterId, sf) {
  return [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: inverterId, body: invBody() },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(1200, 1) }, // 12 kW
    { id: D.MODEL.BASIC_SETTINGS, body: new Array(30).fill(0) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controlsBody(sf) },
    { id: D.MODEL.MPPT, body: new Array(48).fill(0) },
    { id: D.MODEL.STORAGE, body: storageBody() },
  ];
}

// --- discovery ---------------------------------------------------------------

test('discover walks the list and resolves Model 120/123/124 addresses from the discovered base', () => {
  const base = D.DEFAULT_BASE;
  const models = fullDeviceModels(103, -2);
  const img = buildImage(base, models);
  const r = D.discover(readerOver(img));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.base, base);
  assert.strictEqual(r.truncated, false);

  // The model-123 body base is discovered, not hard-coded; field addresses are
  // that base + the fixed standard offsets.
  const m123 = r.byId[123];
  assert.ok(m123, 'model 123 located');
  assert.strictEqual(r.controls.present, true);
  assert.strictEqual(r.controls.wMaxLimPctAddr, m123.bodyAddr + D.M123.WMaxLimPct);
  assert.strictEqual(r.controls.wMaxLimEnaAddr, m123.bodyAddr + D.M123.WMaxLim_Ena);
  assert.strictEqual(r.controls.wMaxLimPctRvrtTmsAddr, m123.bodyAddr + D.M123.WMaxLimPct_RvrtTms);
  assert.strictEqual(r.controls.wMaxLimPctSfAddr, m123.bodyAddr + D.M123.WMaxLimPct_SF);

  // Nameplate resolved + the live scalars read: 1200 * 10^1 / 1000 = 12 kW.
  assert.strictEqual(r.nameplate.present, true);
  assert.ok(Math.abs(r.nameplateKw - 12) < 1e-9);
  assert.strictEqual(r.wMaxLimPctSf, -2);

  // Storage (124) located for increment-2 awareness (no writes built here).
  assert.strictEqual(r.storage.present, true);
  assert.strictEqual(r.storage.bodyAddr, r.byId[124].bodyAddr);

  // int+SF inverter classified.
  assert.deepStrictEqual(r.inverter, { id: 103, type: 'int_sf', phases: 'three' });
});

test('discover is order-independent: models in a shuffled list still resolve', () => {
  const base = D.DEFAULT_BASE;
  // Storage before controls, controls before nameplate, inverter last.
  const models = [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.STORAGE, body: storageBody() },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controlsBody(-2) },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(12000, 0) }, // 12 kW, SF 0
    { id: 111, body: invBody() },
  ];
  const r = D.discover(readerOver(buildImage(base, models)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.controls.present, true);
  assert.strictEqual(r.nameplate.present, true);
  assert.strictEqual(r.storage.present, true);
  assert.ok(Math.abs(r.nameplateKw - 12) < 1e-9);
});

test('discover classifies a FLOAT inverter model, and Model 123 is identical to the int+SF case', () => {
  const base = D.DEFAULT_BASE;
  const intImg = buildImage(base, fullDeviceModels(103, -2));
  const floatImg = buildImage(base, fullDeviceModels(113, -2));
  const ri = D.discover(readerOver(intImg));
  const rf = D.discover(readerOver(floatImg));
  assert.strictEqual(ri.inverter.type, 'int_sf');
  assert.strictEqual(rf.inverter.type, 'float');
  assert.strictEqual(rf.inverter.phases, 'three');
  // Same list composition -> the Model 123 offsets land at the same addresses:
  // the int/float distinction does NOT change the Immediate-Controls model.
  assert.strictEqual(ri.controls.wMaxLimPctAddr, rf.controls.wMaxLimPctAddr);
  assert.strictEqual(ri.controls.wMaxLimEnaAddr, rf.controls.wMaxLimEnaAddr);
});

test('discover finds the SID at a non-default base (50000) via the common-base sweep', () => {
  const base = 50000;
  const r = D.discover(readerOver(buildImage(base, fullDeviceModels(103, -2))));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.base, 50000);
  assert.strictEqual(r.controls.present, true);
});

test('discover: Model 123 absent -> controls.present false (no fabricated address)', () => {
  const base = D.DEFAULT_BASE;
  const models = [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 103, body: invBody() },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(1200, 1) },
    // NO model 123
  ];
  const r = D.discover(readerOver(buildImage(base, models)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.controls.present, false);
  assert.strictEqual(r.byId[123], undefined);
});

test('discover: no SunS marker -> ok:false with a reason (idle-safe)', () => {
  const img = new Map();
  img.set(D.DEFAULT_BASE, 0x1234);
  img.set(D.DEFAULT_BASE + 1, 0x5678);
  const r = D.discover(readerOver(img), { base: D.DEFAULT_BASE });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /SunS/);
});

test('discover: a truncated list (header runs off the register file) stops idle-safe', () => {
  const base = D.DEFAULT_BASE;
  // Build a valid image, then DROP the tail so the walk hits a gap mid-list.
  const img = buildImage(base, fullDeviceModels(103, -2));
  // Find the highest address and lop off everything from the nameplate onward by
  // deleting a chunk in the middle of the list.
  const cut = base + 2 + 2 + 66 + 2 + 50 + 5; // partway into the nameplate body
  for (const k of Array.from(img.keys())) if (k >= cut) img.delete(k);
  const r = D.discover(readerOver(img), { base });
  assert.strictEqual(r.ok, true, 'partial walk still ok');
  assert.strictEqual(r.truncated, true);
  // Model 123 sits past the cut, so it is NOT located -> curtailment idle-safe.
  assert.strictEqual(r.controls.present, false);
});

test('discover: an implausibly long model length is treated as corruption, stops idle-safe', () => {
  const base = D.DEFAULT_BASE;
  const img = new Map();
  img.set(base, (D.SID >>> 16) & 0xffff);
  img.set(base + 1, D.SID & 0xffff);
  // A first model header claiming a 40000-register length = corrupt stream.
  img.set(base + 2, D.MODEL.COMMON);
  img.set(base + 3, 40000);
  const r = D.discover(readerOver(img), { base });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.models.length, 0);
  assert.strictEqual(r.controls.present, false);
});

// --- Model 123 curtailment mapping ------------------------------------------

function fullDiscovery(sf) {
  return D.discover(readerOver(buildImage(D.DEFAULT_BASE, fullDeviceModels(103, sf))));
}

test('planCurtailment writes the limit as ONE FC16 transaction over the discovered block', () => {
  const disc = fullDiscovery(-2); // 12 kW nameplate, SF -2
  const plan = D.planCurtailment({ discovery: disc, pvLimitKw: 6 }); // 6 of 12 kW = 50 %
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.pct, 50);
  assert.strictEqual(plan.pctRaw, 5000); // 50 % / 10^-2
  assert.strictEqual(plan.ena, D.WMAX_LIM_ENA.ENABLED);

  // THE fix (live Pilsting 09.08.2026): the Datamanager only adopts the limit as
  // a closed SET. Three separate FC6 writes were accepted and ignored; the
  // Fronius manual and Victron's dbus-fronius both write these five registers
  // with ONE function-code-0x10 command.
  assert.strictEqual(plan.writes.length, 1, 'exactly ONE write op - the block');
  const blk = plan.writes[0];
  assert.strictEqual(blk.fc, 16);
  assert.strictEqual(blk.role, 'pv_limit_block');
  assert.strictEqual(blk.addr, disc.controls.wMaxLimPctAddr, 'the block starts AT WMaxLimPct');
  assert.strictEqual(blk.addr, disc.controls.limitBlockAddr);
  assert.strictEqual(blk.values.length, 5);
  assert.strictEqual(disc.controls.limitBlockCount, 5);

  // The payload is the five registers in ADDRESS order: value, window, revert,
  // ramp, enable. WinTms/RmpTms are written EXPLICITLY as 0 (act immediately) so
  // a foreign controller's leftovers can never delay our limit.
  assert.deepStrictEqual(blk.values, [5000, 0, D.DEFAULT_RVRT_TMS, 0, D.WMAX_LIM_ENA.ENABLED]);
  assert.deepStrictEqual(blk.parts.map((p) => p.role),
    ['pv_limit_pct', 'pv_limit_window_tms', 'pv_limit_revert_tms', 'pv_limit_ramp_tms', 'pv_limit_enable']);

  // The span is CONTIGUOUS and ends at the enable - that is what makes it one
  // legal Modbus block, and it pins the address arithmetic Victron uses
  // (model-123 header + 5 = body + 3 = WMaxLimPct).
  blk.parts.forEach((p, i) => assert.strictEqual(p.addr, blk.addr + i, p.role + ' is contiguous'));
  assert.strictEqual(blk.parts[4].addr, disc.controls.wMaxLimEnaAddr);
  assert.strictEqual(blk.parts[2].addr, disc.controls.wMaxLimPctRvrtTmsAddr);
  assert.strictEqual(blk.parts[3].addr, disc.controls.wMaxLimPctRmpTmsAddr);

  // The kW back-conversion metadata stays reachable at writes[0].encode.
  assert.strictEqual(blk.encode.sf, -2);
  assert.strictEqual(blk.encode.rated_kw, 12);

  // Readbacks stay PER REGISTER (fn 0x03) - the write echo proves nothing on
  // this device. RvrtTms is deliberately verified: a revert timer that does not
  // take is the signature of a non-transactional write.
  const rb = Object.fromEntries(plan.readbacks.map((op) => [op.role, op]));
  assert.strictEqual(rb.pv_limit_pct.fc, 3);
  assert.strictEqual(rb.pv_limit_pct.expect, 5000);
  assert.strictEqual(rb.pv_limit_revert_tms.expect, D.DEFAULT_RVRT_TMS);
  assert.strictEqual(rb.pv_limit_enable.expect, D.WMAX_LIM_ENA.ENABLED);
});

test('planCurtailment flips back to the legacy per-register FC6 writes on request', () => {
  const disc = fullDiscovery(-2);
  const plan = D.planCurtailment({ discovery: disc, pvLimitKw: 6, writeFc: 6 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.writeFc, 6);
  assert.deepStrictEqual(plan.writes.map((op) => op.role),
    ['pv_limit_pct', 'pv_limit_revert_tms', 'pv_limit_enable']);
  plan.writes.forEach((op) => assert.strictEqual(op.fc, 6));
  // Ordering still puts value + dead-man timer ahead of the enable.
  const w = Object.fromEntries(plan.writes.map((op) => [op.role, op]));
  assert.strictEqual(w.pv_limit_pct.value, 5000);
  assert.strictEqual(w.pv_limit_revert_tms.value, D.DEFAULT_RVRT_TMS);
  assert.strictEqual(w.pv_limit_enable.value, D.WMAX_LIM_ENA.ENABLED);

  // Anything that is not an explicit 6 is the FC16 default - a garbage value
  // must never silently produce the form that is proven not to work.
  for (const v of [undefined, null, 0, 16, 3, 'sechs']) {
    assert.strictEqual(D.planCurtailment({ discovery: disc, pvLimitKw: 6, writeFc: v }).writeFc, 16,
      'writeFc ' + JSON.stringify(v) + ' -> FC16');
  }
});

test('planCurtailment DISABLES the limit when there is no cap (uncurtailed slot)', () => {
  const disc = fullDiscovery(-2);
  const plan = D.planCurtailment({ discovery: disc, pvLimitKw: null });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.pct, 100);
  assert.strictEqual(plan.ena, D.WMAX_LIM_ENA.DISABLED);
  const blk = plan.writes[0];
  // The release is the SAME transaction with the enable cleared and the value
  // back at 100 % - so a released unit can never be left holding a foreign
  // controller's stale 0 % cap (the Pilsting stranding shape).
  assert.strictEqual(blk.fc, 16);
  assert.deepStrictEqual(blk.values, [10000, 0, D.DEFAULT_RVRT_TMS, 0, D.WMAX_LIM_ENA.DISABLED]);
  const parts = Object.fromEntries(blk.parts.map((p) => [p.role, p]));
  assert.strictEqual(parts.pv_limit_enable.value, D.WMAX_LIM_ENA.DISABLED);
  assert.strictEqual(parts.pv_limit_enable.encode.curtailing, false);
});

test('planCurtailment clamps the percentage into [0,100]', () => {
  const disc = fullDiscovery(-2);
  // 20 kW cap on a 12 kW inverter can only be 100 %.
  const hi = D.planCurtailment({ discovery: disc, pvLimitKw: 20 });
  assert.strictEqual(hi.pct, 100);
  assert.strictEqual(hi.pctRaw, 10000);
  // 0 kW cap -> full curtailment, 0 %.
  const lo = D.planCurtailment({ discovery: disc, pvLimitKw: 0 });
  assert.strictEqual(lo.pct, 0);
  assert.strictEqual(lo.pctRaw, 0);
  assert.strictEqual(lo.ena, D.WMAX_LIM_ENA.ENABLED);
});

test('planCurtailment honours override nameplate/SF and a custom revert timeout', () => {
  const disc = fullDiscovery(-2);
  // Override nameplate to 10 kW, SF to 0 (register holds the raw percent).
  const plan = D.planCurtailment({ discovery: disc, pvLimitKw: 2.5, nameplateKw: 10, wMaxLimPctSf: 0, rvrtTms: 120 });
  assert.strictEqual(plan.pct, 25);
  assert.strictEqual(plan.pctRaw, 25); // SF 0 -> raw = pct
  assert.strictEqual(plan.rvrtTms, 120);
  assert.deepStrictEqual(plan.writes[0].values, [25, 0, 120, 0, D.WMAX_LIM_ENA.ENABLED]);
  assert.strictEqual(plan.readbacks.find((op) => op.role === 'pv_limit_revert_tms').expect, 120);
});

test('planCurtailment never writes RvrtTms 0 by default - 0 would LATCH the limit', () => {
  // Fronius: RvrtTms is "the duration the operating mode remains active" and 0
  // means "until manually deactivated". That latch is exactly what stranded both
  // Pilsting inverters at ~0.135 kW when the previous controller went silent.
  const disc = fullDiscovery(-2);
  assert.ok(D.DEFAULT_RVRT_TMS > 0, 'the shipped default must be a real timeout');
  const plan = D.planCurtailment({ discovery: disc, pvLimitKw: 6 });
  assert.strictEqual(plan.writes[0].values[2], D.DEFAULT_RVRT_TMS);
  assert.ok(plan.writes[0].values[2] > 0);
});

test('planCurtailment is IDLE-SAFE when discovery failed / Model 123 absent / nameplate unknown', () => {
  // No discovery at all.
  const a = D.planCurtailment({ discovery: null, pvLimitKw: 5 });
  assert.strictEqual(a.ok, false);
  assert.deepStrictEqual(a.writes, []);
  assert.deepStrictEqual(a.readbacks, []);
  assert.match(a.reason, /nicht erkannt/);

  // Discovery ok but no Model 123.
  const noCtl = D.discover(readerOver(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(1200, 1) },
  ])));
  const b = D.planCurtailment({ discovery: noCtl, pvLimitKw: 5 });
  assert.strictEqual(b.ok, false);
  assert.deepStrictEqual(b.writes, []);
  assert.match(b.reason, /123/);

  // Model 123 present but nameplate rating unknown (no model 120).
  const noNp = D.discover(readerOver(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controlsBody(-2) },
  ])));
  const c = D.planCurtailment({ discovery: noNp, pvLimitKw: 5 });
  assert.strictEqual(c.ok, false);
  assert.deepStrictEqual(c.writes, []);
  assert.match(c.reason, /Nennleistung|Nameplate/);
});

// --- Model 124 storage discovery + planStorage (increment 2) -----------------

// A full GEN24-shaped list whose storage body carries a real WChaMax (10 kW) and
// scale factors, so discovery reads the scalars planStorage needs.
function storageDeviceModels(sf) {
  return [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 103, body: invBody() },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(1200, 1) }, // 12 kW inverter
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controlsBody(sf != null ? sf : -2) },
    { id: D.MODEL.STORAGE, body: storageBodyWith({ wChaMax: 1000, wChaMaxSf: 1 }) }, // 10 kW battery
  ];
}
function storageDiscovery() {
  return D.discover(readerOver(buildImage(D.DEFAULT_BASE, storageDeviceModels(-2))));
}

test('discover resolves Model 124 addresses and reads WChaMax + storage scale factors live', () => {
  const r = storageDiscovery();
  assert.strictEqual(r.ok, true);
  const m124 = r.byId[124];
  assert.ok(m124, 'model 124 located');
  // Field addresses = discovered body base + fixed standard offsets (never hardcoded).
  assert.strictEqual(r.storage.present, true);
  assert.strictEqual(r.storage.inWRteAddr, m124.bodyAddr + D.M124.InWRte);
  assert.strictEqual(r.storage.outWRteAddr, m124.bodyAddr + D.M124.OutWRte);
  assert.strictEqual(r.storage.storCtlModAddr, m124.bodyAddr + D.M124.StorCtl_Mod);
  assert.strictEqual(r.storage.minRsvPctAddr, m124.bodyAddr + D.M124.MinRsvPct);
  assert.strictEqual(r.storage.chaGriSetAddr, m124.bodyAddr + D.M124.ChaGriSet);
  assert.strictEqual(r.storage.inOutWRteRvrtTmsAddr, m124.bodyAddr + D.M124.InOutWRte_RvrtTms);
  // Live scalars: WChaMax 1000 * 10^1 / 1000 = 10 kW, SFs read from the body.
  assert.ok(Math.abs(r.wChaMaxKw - 10) < 1e-9);
  assert.strictEqual(r.inOutWRteSf, -2);
  assert.strictEqual(r.minRsvPctSf, -2);
});

test('planStorage maps a CHARGE setpoint -> InWRte % + StorCtl_Mod charge bit at discovered addresses', () => {
  const disc = storageDiscovery(); // 10 kW WChaMax, SF -2
  const plan = D.planStorage({ discovery: disc, batterySetpointKw: 5, socMinPct: 10 }); // 5 of 10 kW = 50 %
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.ratePct, 50);
  assert.strictEqual(plan.rateRaw, 5000); // 50 % / 10^-2
  assert.strictEqual(plan.mode, D.STORCTL_MOD.CHARGE);

  const w = Object.fromEntries(plan.writes.map((op) => [op.role, op]));
  assert.strictEqual(w.battery_in_rate.addr, disc.storage.inWRteAddr);
  assert.strictEqual(w.battery_in_rate.value, 5000);
  assert.strictEqual(w.battery_out_rate.value, 0, 'discharge channel idle while charging');
  assert.strictEqual(w.battery_storage_mode.addr, disc.storage.storCtlModAddr);
  assert.strictEqual(w.battery_storage_mode.value, D.STORCTL_MOD.CHARGE);
  // MinRsvPct floor from soc_min = 10 %, SF -2 -> 1000.
  assert.strictEqual(w.battery_min_reserve.addr, disc.storage.minRsvPctAddr);
  assert.strictEqual(w.battery_min_reserve.value, 1000);

  // Ordering is safety-relevant: rate values + reserve + grid + revert BEFORE the
  // StorCtl_Mod (the direction-enable bits) is armed LAST.
  assert.strictEqual(plan.writes[plan.writes.length - 1].role, 'battery_storage_mode');
  assert.deepStrictEqual(plan.writes.map((op) => op.role), [
    'battery_in_rate', 'battery_out_rate', 'battery_min_reserve',
    'battery_grid_charge', 'battery_revert_tms', 'battery_storage_mode',
  ]);

  // Readbacks mirror the writes at the same addresses.
  const rb = Object.fromEntries(plan.readbacks.map((op) => [op.role, op]));
  assert.strictEqual(rb.battery_in_rate.fc, 3);
  assert.strictEqual(rb.battery_in_rate.expect, 5000);
  assert.strictEqual(rb.battery_storage_mode.expect, D.STORCTL_MOD.CHARGE);
});

test('planStorage maps a DISCHARGE setpoint -> OutWRte % + StorCtl_Mod discharge bit', () => {
  const disc = storageDiscovery();
  const plan = D.planStorage({ discovery: disc, batterySetpointKw: -2.5 }); // 2.5 of 10 kW = 25 %
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.ratePct, 25);
  assert.strictEqual(plan.mode, D.STORCTL_MOD.DISCHARGE);
  const w = Object.fromEntries(plan.writes.map((op) => [op.role, op]));
  assert.strictEqual(w.battery_out_rate.addr, disc.storage.outWRteAddr);
  assert.strictEqual(w.battery_out_rate.value, 2500);
  assert.strictEqual(w.battery_in_rate.value, 0, 'charge channel idle while discharging');
  assert.strictEqual(w.battery_storage_mode.value, D.STORCTL_MOD.DISCHARGE);
});

test('planStorage kW->% conversion uses WChaMax and clamps to [0,100]', () => {
  const disc = storageDiscovery(); // 10 kW
  // 20 kW command on a 10 kW battery can only be 100 %.
  const hi = D.planStorage({ discovery: disc, batterySetpointKw: 20 });
  assert.strictEqual(hi.ratePct, 100);
  assert.strictEqual(hi.rateRaw, 10000);
  // An override WChaMax of 5 kW makes a 2.5 kW charge 50 %.
  const ovr = D.planStorage({ discovery: disc, batterySetpointKw: 2.5, wChaMaxKw: 5, inOutWRteSf: 0 });
  assert.strictEqual(ovr.ratePct, 50);
  assert.strictEqual(ovr.rateRaw, 50); // SF 0 -> raw = pct
});

test('planStorage idle setpoint (0 kW) RELEASES control: StorCtl_Mod = NONE, both rates 0', () => {
  const disc = storageDiscovery();
  const plan = D.planStorage({ discovery: disc, batterySetpointKw: 0 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.mode, D.STORCTL_MOD.NONE);
  const w = Object.fromEntries(plan.writes.map((op) => [op.role, op]));
  assert.strictEqual(w.battery_in_rate.value, 0);
  assert.strictEqual(w.battery_out_rate.value, 0);
  assert.strictEqual(w.battery_storage_mode.value, 0);
});

test('planStorage grid-charge is EEG-gated: ChaGriSet = PV unless permitted AND charging', () => {
  const disc = storageDiscovery();
  const grid = (p) => p.writes.find((op) => op.role === 'battery_grid_charge').value;
  // Charging, not permitted -> PV (grid charging OFF, the EEG-safe default).
  assert.strictEqual(grid(D.planStorage({ discovery: disc, batterySetpointKw: 5 })), D.CHA_GRI_SET.PV);
  // Charging, permitted -> GRID.
  assert.strictEqual(grid(D.planStorage({ discovery: disc, batterySetpointKw: 5, gridChargeAllowed: true })), D.CHA_GRI_SET.GRID);
  // Discharging, even when permitted -> PV (grid charging is irrelevant on discharge).
  assert.strictEqual(grid(D.planStorage({ discovery: disc, batterySetpointKw: -5, gridChargeAllowed: true })), D.CHA_GRI_SET.PV);
});

test('planStorage honours a custom revert timeout (the storage dead-man switch)', () => {
  const disc = storageDiscovery();
  const plan = D.planStorage({ discovery: disc, batterySetpointKw: 5, rvrtTms: 120 });
  assert.strictEqual(plan.writes.find((op) => op.role === 'battery_revert_tms').value, 120);
  const dflt = D.planStorage({ discovery: disc, batterySetpointKw: 5 });
  assert.strictEqual(dflt.writes.find((op) => op.role === 'battery_revert_tms').value, D.DEFAULT_STORAGE_RVRT_TMS);
});

test('planStorage is IDLE-SAFE when discovery failed / Model 124 absent / WChaMax unknown / bad setpoint', () => {
  // No discovery.
  const a = D.planStorage({ discovery: null, batterySetpointKw: 5 });
  assert.strictEqual(a.ok, false);
  assert.deepStrictEqual(a.writes, []);
  assert.deepStrictEqual(a.readbacks, []);
  assert.match(a.reason, /nicht erkannt/);

  // Discovery ok but no Model 124 (a batteryless inverter).
  const noStore = D.discover(readerOver(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.NAMEPLATE, body: nameplateBody(1200, 1) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controlsBody(-2) },
  ])));
  const b = D.planStorage({ discovery: noStore, batterySetpointKw: 5 });
  assert.strictEqual(b.ok, false);
  assert.deepStrictEqual(b.writes, []);
  assert.match(b.reason, /124|Storage/);

  // Model 124 present but WChaMax unknown (all-zero storage body -> WChaMax 0).
  const noWCha = D.discover(readerOver(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.STORAGE, body: storageBody() }, // WChaMax = 0
  ])));
  const c = D.planStorage({ discovery: noWCha, batterySetpointKw: 5 });
  assert.strictEqual(c.ok, false);
  assert.deepStrictEqual(c.writes, []);
  assert.match(c.reason, /WChaMax|Nennladeleistung/);

  // Non-finite setpoint.
  const d = D.planStorage({ discovery: storageDiscovery(), batterySetpointKw: NaN });
  assert.strictEqual(d.ok, false);
  assert.deepStrictEqual(d.writes, []);
});
