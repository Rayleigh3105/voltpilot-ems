'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDocument } = require('./measurement-driver');
const { MeasurementRuntime } = require('./measurement-runtime');

const config = (selections, revision = 1) => ({
  revision, catalog_version: catalogDocument.catalog_version, selections,
});

test('Deye bench groups a block, runs control first and emits exact raw words', async () => {
  const order = []; const published = [];
  const io = { discovery:{}, readModbus: async ({ start, count }) => {
    order.push(`read:${start}:${count}`); return [250, 5200, 61];
  }};
  const runtime = new MeasurementRuntime(io, (topic, payload, retained) => published.push({ topic, payload, retained }),
    () => new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([
    { point_key:'deye.hybrid_1p.battery.battery-temperature', cadence_s:60 },
    { point_key:'deye.hybrid_1p.battery.battery-voltage', cadence_s:60 },
    { point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 },
  ]));
  runtime.enqueueControl(async () => order.push('control'));
  const samples = await runtime.tick();
  assert.deepEqual(order, ['control', 'read:182:3']);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].raw, 250);
  assert.equal(published.at(-1).topic, 'edge/measurements/samples');
  assert.equal(published.at(-1).retained, false);
});

test('silent/read-error bench emits no synthetic zero sample', async () => {
  const published = [];
  const runtime = new MeasurementRuntime({ discovery:{}, readModbus: async () => { throw new Error('offline'); } },
    (topic, payload) => published.push({ topic, payload }), () => new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 }]));
  assert.deepEqual(await runtime.tick(), []);
  assert.equal(published.filter((x) => x.topic === 'edge/measurements/samples').length, 0);
});

test('failed candidate never replaces the previously active poll plan', async () => {
  let reads = 0;
  const runtime = new MeasurementRuntime({ discovery:{}, readModbus: async () => { reads++; return [42]; } },
    () => {}, () => new Date('2026-08-25T12:00:00Z'));
  assert.equal(runtime.apply(config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 }], 1)).applied, true);
  const overload = Array.from({ length:601 }, (_, i) => ({ point_key:`missing.${i}`, cadence_s:1 }));
  const rejected = runtime.apply(config(overload, 2));
  // Unknown points are individually rejected, but the empty candidate is an
  // atomic valid plan. A hard budget failure, by contrast, keeps the old one.
  assert.equal(rejected.applied, true);
  const many = catalogDocument.points.filter((p) => p.address && p.source_kind === 'modbus_holding'
    && p.min_cadence_s <= 5).slice(0, 80).map((p) => ({ point_key:p.point_key, cadence_s:5 }));
  const hard = runtime.apply(config(many, 3));
  assert.equal(hard.applied, false);
  // Revision 2's deliberately empty plan is still active, not a half-applied
  // subset of revision 3.
  assert.deepEqual(await runtime.tick(), []);
  assert.equal(reads, 0);
});

test('SunSpec Model 160 bench uses discovery N and module-relative base', async () => {
  let request;
  const discovery = { models:{ 160:{ base:41000, moduleCount:2 } } };
  const runtime = new MeasurementRuntime({ discovery, readModbus: async (r) => { request=r; return [123]; } },
    () => {}, () => new Date('2026-08-25T12:00:00Z'));
  const result = runtime.apply(config([{ point_key:'sunspec.model_160.module[1].dcw', cadence_s:60 }]));
  assert.equal(result.applied, true);
  const samples = await runtime.tick();
  assert.equal(request.start, 41041);
  assert.equal(samples[0].raw, 123);
});
