'use strict';

// AP-07 IP-18b Box-Schritt: the SHARED POINT (same point_key once per
// component, mqtt-measurement-config 2.0 x-point-key-rule). One read per
// (target, point) at the fastest cadence, one sample per component at its own
// cadence, and never more requests than the merged plan of today's cloud.

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDocument } = require('./measurement-driver');
const { buildPlan } = require('./measurement-planner');
const { MeasurementRuntime } = require('./measurement-runtime');

const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
const C = '00000000-0000-0000-0000-0000000000c3';
const PUNKT = 'deye.hybrid_1p.battery.battery';
const cfg = (selections, revision = 1) => ({
  revision, catalog_version:catalogDocument.catalog_version, selections,
});
// A and B are composed types: both read over the primary inverter.
const binding = {
  entities:{ [A]:{ entity_type:'battery-hybrid' }, [B]:{ entity_type:'grid-meter' },
    [C]:{ entity_type:'producer', edge_source_id:'src-c' } },
  sources:{ 'src-c':{ id:'src-c', communication:'modbus_tcp', connection:{ ip:'10.0.0.9', port:502 } } },
};
const geteilt = [
  { point_key:PUNKT, cadence_s:30, entity_id:A },
  { point_key:PUNKT, cadence_s:10, entity_id:B },
];
// Today's cloud merges the same point to ONE entry, fastest cadence, no component.
const zusammengelegt = [{ point_key:PUNKT, cadence_s:10 }];

async function eineMinute(selections) {
  let ms = 0; const reads = []; const published = [];
  const runtime = new MeasurementRuntime({
    readModbus:async (request) => { reads.push({ at:ms, target:request.target.key });
      return Array(request.count).fill(80); },
    binding,
  }, (topic, payload) => { if (topic === 'edge/measurements/local-batch') published.push(payload); },
  () => new Date(Date.UTC(2026, 8, 23, 10) + ms));
  const plan = runtime.apply(cfg(selections));
  assert.equal(plan.applied, true, JSON.stringify(plan.rejected));
  const samples = [];
  for (ms = 0; ms <= 60000; ms += 1000) samples.push(...await runtime.tick());
  return { plan, reads, samples };
}

const jeKomponente = (samples) => samples.reduce((n, s) => {
  n[s.entity_id || '-'] = (n[s.entity_id || '-'] || 0) + 1; return n;
}, {});

test('ein Lesen je Ziel und Punkt, ein Sample je Komponente in ihrer Kadenz', async () => {
  const neu = await eineMinute(geteilt);
  const heute = await eineMinute(zusammengelegt);
  // Anfragen je Tick steigen nicht: the same reads at the same moments.
  assert.deepEqual(neu.reads, heute.reads);
  assert.equal(neu.reads.length, 7);
  // B samples every 10 s, A every 30 s; both carry their component.
  assert.deepEqual(jeKomponente(neu.samples), { [A]:3, [B]:7 });
  assert.deepEqual(jeKomponente(heute.samples), { '-':7 });
  assert.ok(neu.samples.every((s) => s.point_key === PUNKT && s.raw === heute.samples[0].raw));
  assert.deepEqual(neu.plan.accepted, [PUNKT]);
  assert.deepEqual(neu.plan.rejected, []);
});

test('Budget: Anfragen und Tastgrad des geteilten Plans sind die des zusammengelegten - fuer jeden Katalogpunkt', () => {
  let verglichen = 0;
  for (const p of catalogDocument.points) {
    const takt = Math.max(p.min_cadence_s || 1, 10);
    const heute = buildPlan(cfg([{ point_key:p.point_key, cadence_s:takt }]), { binding });
    const neu = buildPlan(cfg([{ point_key:p.point_key, cadence_s:takt * 3, entity_id:A },
      { point_key:p.point_key, cadence_s:takt, entity_id:B }]), { binding });
    assert.equal(neu.applied, heute.applied, p.point_key);
    assert.deepEqual(neu.rejected.map((r) => r.reason).sort(),
      [...new Set(heute.rejected.map((r) => r.reason))].flatMap((r) => [r, r]).sort(), p.point_key);
    if (!heute.applied || !heute.selections.length) continue;
    assert.deepEqual(neu.blocks, heute.blocks, p.point_key);
    assert.deepEqual(neu.httpGroups, heute.httpGroups, p.point_key);
    assert.equal(neu.metrics.requestsPerMinute, heute.metrics.requestsPerMinute, p.point_key);
    assert.equal(neu.metrics.dutyPercent, heute.metrics.dutyPercent, p.point_key);
    // Samples are counted per component: A adds its own, never a request.
    assert.ok(neu.metrics.samplesPerMinute > heute.metrics.samplesPerMinute, p.point_key);
    verglichen++;
  }
  assert.ok(verglichen > 1000, `only ${verglichen} catalog points compared`);
});

test('Status je Komponente: nur die ungebundene Komponente wird abgelehnt', () => {
  const plan = buildPlan(cfg([{ point_key:PUNKT, cadence_s:30, entity_id:A },
    { point_key:PUNKT, cadence_s:10, entity_id:'00000000-0000-0000-0000-0000000000d4' }]), { binding });
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.accepted, [PUNKT]);
  assert.deepEqual(plan.rejected, [{ point_key:PUNKT, reason:'binding_unavailable',
    entity_id:'00000000-0000-0000-0000-0000000000d4' }]);
  // Without a shared point the status is the one of before: no entity_id.
  const einfach = buildPlan(cfg([{ point_key:PUNKT, cadence_s:10,
    entity_id:'00000000-0000-0000-0000-0000000000d4' }]), { binding });
  assert.deepEqual(einfach.rejected, [{ point_key:PUNKT, reason:'binding_unavailable' }]);
});

test('echte Duplikate bleiben abgewiesen, der geteilte Punkt nie zusammen mit einem ohne Komponente', () => {
  for (const selections of [
    [{ point_key:PUNKT, cadence_s:30, entity_id:A }, { point_key:PUNKT, cadence_s:10, entity_id:A }],
    [{ point_key:PUNKT, cadence_s:30, entity_id:A }, { point_key:PUNKT, cadence_s:10 }],
    [{ point_key:PUNKT, cadence_s:30 }, { point_key:PUNKT, cadence_s:10, entity_id:B }],
  ]) {
    const plan = buildPlan(cfg(selections), { binding });
    assert.equal(plan.selections.length, 1);
    assert.deepEqual(plan.rejected.map((r) => r.reason), ['unknown_point']);
  }
});

test('verschiedene Ziele lesen je Geraet einmal, jede Komponente ueber ihr Geraet', async () => {
  const neu = await eineMinute([{ point_key:PUNKT, cadence_s:10, entity_id:A },
    { point_key:PUNKT, cadence_s:10, entity_id:C }]);
  assert.deepEqual([...new Set(neu.reads.map((r) => r.target))].sort(), ['primary', 'source:src-c']);
  assert.equal(neu.reads.length, 14);
  assert.deepEqual(jeKomponente(neu.samples), { [A]:7, [C]:7 });
});

test('Mischbetrieb: heutiger zusammengelegter Plan an der neuen Box wie bisher', async () => {
  const heute = await eineMinute([{ point_key:PUNKT, cadence_s:10 },
    { point_key:'deye.hybrid_1p.battery.battery-power', cadence_s:30, entity_id:A }]);
  assert.deepEqual(heute.plan.accepted, [PUNKT, 'deye.hybrid_1p.battery.battery-power']);
  assert.deepEqual(jeKomponente(heute.samples), { '-':7, [A]:3 });
  // Two cadences are two poll groups, as before: 7 + 3 reads.
  assert.equal(heute.reads.length, 10);
});
