'use strict';

// Geraeteseite Stufe 3c: a selection's component decides WHICH DEVICE the point
// is read over. These cover the planner + runtime halves of that; the rule
// itself is measurement-binding.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDocument } = require('./measurement-driver');
const { buildPlan } = require('./measurement-planner');
const { MeasurementRuntime } = require('./measurement-runtime');

const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
const cfg = (selections, revision = 1) => ({
  revision, catalog_version: catalogDocument.catalog_version, selections,
});
const custom = (address) => ({ label:'x', sourceKind:'modbus_holding', address, selector:'s',
  valueType:'uint16', widthBits:16, signed:false, endian:'big', scale:1, unit:'V',
  cadenceS:30, retentionClass:'power', readOnly:true, requestCostMs:400 });
const src = (id, ip) => ({ id, communication:'modbus_tcp', connection:{ ip, port:502 } });
const at = (ms) => () => new Date(ms);

test('a bound point is read over ITS component device, not the primary', async () => {
  const bindingContext = {
    entities:{ [A]:{ entity_type:'producer', edge_source_id:'src-a' } },
    sources:{ 'src-a':src('src-a', '10.0.0.9') },
  };
  const reads = [];
  const runtime = new MeasurementRuntime({
    readModbus: async (request) => { reads.push(request); return [7]; },
  }, () => {}, at(0));
  const plan = runtime.apply(cfg([
    { point_key:'custom.bound', cadence_s:30, entity_id:A, definition:custom(616) },
  ]), { binding:bindingContext });
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.accepted, ['custom.bound']);
  await runtime.tick();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].target, { key:'source:src-a', sourceId:'src-a' });
});

test('two devices reading the SAME register stay separate blocks and separate words', async () => {
  // One flat wire-word map would decode one device's register with the other's
  // point - the exact wrong-value-on-a-right-looking-point this stage prevents.
  const bindingContext = {
    entities:{
      [A]:{ entity_type:'producer', edge_source_id:'src-a' },
      [B]:{ entity_type:'producer', edge_source_id:'src-b' },
    },
    sources:{ 'src-a':src('src-a','10.0.0.9'), 'src-b':src('src-b','10.0.0.10') },
  };
  const samples = [];
  const runtime = new MeasurementRuntime({
    readModbus: async ({ target }) => [target.sourceId === 'src-a' ? 11 : 22],
  }, (topic, payload) => { if (topic.endsWith('/samples')) samples.push(...payload.samples); }, at(0));
  const plan = runtime.apply(cfg([
    { point_key:'custom.a', cadence_s:30, entity_id:A, definition:custom(616) },
    { point_key:'custom.b', cadence_s:30, entity_id:B, definition:custom(616) },
  ]), { binding:bindingContext });
  assert.equal(plan.applied, true);
  assert.equal(plan.blocks.length, 2, 'same family + register on two devices must not merge');
  assert.deepEqual(plan.blocks.map((b) => b.target.sourceId).sort(), ['src-a','src-b']);
  await runtime.tick();
  assert.deepEqual(samples.map((s) => [s.point_key, s.decoded]).sort(),
    [['custom.a', 11], ['custom.b', 22]]);
});

test('an unresolvable binding is refused and the device is never touched', async () => {
  let reads = 0;
  const statuses = [];
  const runtime = new MeasurementRuntime({ readModbus: async () => { reads++; return [1]; } },
    (topic, payload) => { if (topic.endsWith('/config-status')) statuses.push(payload); }, at(0));
  const plan = runtime.apply(cfg([
    { point_key:'custom.orphan', cadence_s:30, entity_id:A, definition:custom(616) },
  ]), { binding:{ entities:{}, sources:{} } });
  assert.equal(plan.applied, true, 'the rest of the plan still applies');
  assert.deepEqual(plan.accepted, []);
  assert.deepEqual(plan.rejected, [{ point_key:'custom.orphan', reason:'binding_unavailable' }]);
  assert.deepEqual(statuses[0].rejected, [{ point_key:'custom.orphan', reason:'binding_unavailable' }]);
  await runtime.tick();
  assert.equal(reads, 0, 'a refused point must not reach the wire');
});

test('one unresolvable point never takes the resolvable ones with it', async () => {
  const bindingContext = {
    entities:{ [A]:{ entity_type:'battery-hybrid', edge_source_id:'' } },
    sources:{},
  };
  const runtime = new MeasurementRuntime({ readModbus: async () => [5] }, () => {}, at(0));
  const plan = runtime.apply(cfg([
    { point_key:'custom.ok', cadence_s:30, entity_id:A, definition:custom(616) },
    { point_key:'custom.orphan', cadence_s:30, entity_id:B, definition:custom(700) },
  ]), { binding:bindingContext });
  assert.deepEqual(plan.accepted, ['custom.ok']);
  assert.deepEqual(plan.rejected, [{ point_key:'custom.orphan', reason:'binding_unavailable' }]);
});

test('a SunSpec point on a bound source uses THAT device discovery, never the primary base', () => {
  const bindingContext = {
    entities:{ [A]:{ entity_type:'producer', edge_source_id:'src-a' } },
    sources:{ 'src-a':src('src-a','10.0.0.9') },
  };
  const selections = [{ point_key:'sunspec.model_160.module[*].dcw', cadence_s:60, entity_id:A }];
  const primaryOnly = { discovery:{ models:{ 160:{ base:41000, moduleCount:2 } } },
    binding:bindingContext };
  // Without its OWN discovery the bound source has no address: refusing is the
  // honest answer; borrowing the primary's model base would be a WRONG address
  // on the right device.
  const refused = buildPlan(cfg(selections), primaryOnly);
  assert.deepEqual(refused.rejected,
    [{ point_key:'sunspec.model_160.module[*].dcw', reason:'driver_unavailable' }]);

  const own = buildPlan(cfg(selections), Object.assign({}, primaryOnly, {
    discoveries:{ 'source:src-a':{ models:{ 160:{ base:52000, moduleCount:1 } } } },
  }));
  assert.equal(own.applied, true);
  assert.deepEqual(own.blocks.map((b) => b.start), [52021]);
  assert.deepEqual(own.blocks.map((b) => b.target.sourceId), ['src-a']);
});

test('an unbound plan is byte-identical to the pre-3c plan', () => {
  // The whole compatibility promise: an older cloud (no entity_id anywhere)
  // plans exactly as before, whatever the box knows about components.
  const selections = [{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:30 },
    { point_key:'goe.api_v2.nrg', cadence_s:30 }];
  const before = buildPlan(cfg(selections), {});
  const after = buildPlan(cfg(selections), { binding:{
    entities:{ [A]:{ entity_type:'producer', edge_source_id:'src-a' } },
    sources:{ 'src-a':src('src-a','10.0.0.9') } } });
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  assert.ok(before.blocks.every((b) => b.target.key === 'primary'));
  assert.ok(before.httpGroups.every((g) => g.target.key === 'primary'));
});

test('an HTTP group belongs to its target, so two devices are two requests', async () => {
  const bindingContext = {
    entities:{
      [A]:{ entity_type:'consumer', edge_source_id:'src-a' },
      [B]:{ entity_type:'consumer', edge_source_id:'src-b' },
    },
    sources:{
      'src-a':{ id:'src-a', communication:'goe_http_api', connection:{ ip:'10.0.0.9', port:80 } },
      'src-b':{ id:'src-b', communication:'goe_http_api', connection:{ ip:'10.0.0.10', port:80 } },
    },
  };
  const plan = buildPlan(cfg([
    { point_key:'goe.api_v2.nrg', cadence_s:30, entity_id:A },
    { point_key:'goe.api_v2.eto', cadence_s:30, entity_id:B },
  ]), { binding:bindingContext });
  assert.equal(plan.applied, true);
  assert.equal(plan.httpGroups.length, 2);
  assert.deepEqual(plan.httpGroups.map((g) => g.target.sourceId).sort(), ['src-a','src-b']);

  const requests = [];
  const runtime = new MeasurementRuntime({
    readJSON: async (request) => { requests.push(request); return { nrg:[0,0,0,0,0,0,0,0,0,0,0,4200] }; },
  }, () => {}, at(0));
  runtime.apply(cfg([
    { point_key:'goe.api_v2.nrg', cadence_s:30, entity_id:A },
    { point_key:'goe.api_v2.eto', cadence_s:30, entity_id:B },
  ]), { binding:bindingContext });
  await runtime.tick();
  assert.deepEqual(requests.map((r) => r.target.sourceId).sort(), ['src-a','src-b']);
});

test('byte order is resolved per target, not taken from the primary', () => {
  const bindingContext = {
    entities:{ [A]:{ entity_type:'producer', edge_source_id:'src-a' } },
    sources:{ 'src-a':src('src-a','10.0.0.9') },
  };
  const selections = [{ point_key:'kostal_plenticore.grid-power', cadence_s:60, entity_id:A }];
  // The primary's configured order must not silence the bound device's own
  // byte-order probe register.
  const plan = buildPlan(cfg(selections), { binding:bindingContext, byteOrder:'little' });
  assert.ok(plan.applied);
  assert.ok(plan.blocks.some((b) => b.start === 5), 'bound target still probes register 5');
  const configured = buildPlan(cfg(selections),
    { binding:bindingContext, byteOrder:'little', byteOrders:{ 'source:src-a':'big' } });
  assert.ok(!configured.blocks.some((b) => b.start === 5), 'its own configured order skips the probe');
});
