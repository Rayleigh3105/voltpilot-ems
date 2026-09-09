/**
 * Pure model operations: claim derivation (the D-13 TS twin, shared vectors
 * with the api's FlowClaims), edit operations, display derivations.
 */
import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  applyDerivedClaims,
  catalogType,
  customerVisible,
  diagnosticOnlyTypes,
  compatible,
  deriveClaims,
  lifecycleSteps,
  nodeSubtitle,
  removeEdge,
  removeNode,
  setParam,
  supportsVersion,
  type EditorEntity,
} from './model';
import { pilotTemplate } from './templates';

const ENTITIES: EditorEntity[] = [
  {
    id: 'batt-main',
    entityType: 'battery-hybrid',
    label: 'Speicher (Hybrid)',
    measure: ['soc_pct'],
    actuate: ['setpoint_kw'],
  },
];

describe('claim derivation (D-13)', () => {
  it('derives the delegated strategy claim and suppresses the plan-fed control', () => {
    const claims = deriveClaims(pilotTemplate('Pilot', 'batt-main'));
    expect(claims).toEqual([
      { nodeId: 'strat1', entityId: 'batt-main', commands: ['setpoint_kw'], delegated: true },
    ]);
  });

  it('keeps a DIRECT control claim when not plan-fed by the same entity', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    doc.nodes.push({
      id: 'c2',
      type: 'vp.entity.control',
      type_version: '1.0.0',
      parameters: { entity_id: 'heatrod', command: 'on_off' },
    });
    const claims = deriveClaims(doc);
    expect(claims).toHaveLength(2);
    expect(claims.find((c) => c.nodeId === 'c2')).toEqual({
      nodeId: 'c2', entityId: 'heatrod', commands: ['on_off'], delegated: false,
    });
  });

  it('applyDerivedClaims stamps exactly the derivation onto the nodes', () => {
    const doc = applyDerivedClaims(pilotTemplate('Pilot', 'batt-main'));
    const strategy = doc.nodes.find((n) => n.id === 'strat1');
    const control = doc.nodes.find((n) => n.id === 'ctl1');
    expect(strategy?.claims).toEqual([
      { entity_id: 'batt-main', commands: ['setpoint_kw'], delegated: true },
    ]);
    expect(control?.claims).toBeUndefined();
  });
});

describe('edit operations', () => {
  it('addNode generates a unique id and parameter defaults', () => {
    let doc = pilotTemplate('Pilot', 'batt-main');
    doc = addNode(doc, 'vp.logic.threshold');
    const added = doc.nodes[doc.nodes.length - 1];
    expect(added.id).toBe('schwelle1');
    expect(added.type_version).toBe('1.1.0');
    expect(added.parameters?.direction).toBe('above');
    doc = addNode(doc, 'vp.logic.threshold');
    expect(doc.nodes[doc.nodes.length - 1].id).toBe('schwelle2');
  });

  it('removeNode drops its edges and value-change triggers', () => {
    let doc = pilotTemplate('Pilot', 'batt-main');
    doc.triggers.push({ id: 't2', kind: 'value-change', source: { node: 'soc1', port: 'value' } });
    doc = removeNode(doc, 'soc1');
    expect(doc.nodes.some((n) => n.id === 'soc1')).toBe(false);
    expect(doc.edges.some((e) => e.from.node === 'soc1' || e.to.node === 'soc1')).toBe(false);
    expect(doc.triggers.some((t) => t.source?.node === 'soc1')).toBe(false);
  });

  it('addEdge replaces an existing connection into the same input', () => {
    let doc = pilotTemplate('Pilot', 'batt-main');
    doc = addNode(doc, 'vp.price.dayahead'); // preis1
    doc = addEdge(doc, { node: 'preis1', port: 'prices' }, { node: 'strat1', port: 'price_in' });
    const into = doc.edges.filter((e) => e.to.node === 'strat1' && e.to.port === 'price_in');
    expect(into).toHaveLength(1);
    expect(into[0].from.node).toBe('preis1');
  });

  it('removeEdge and setParam re-derive claims', () => {
    let doc = pilotTemplate('Pilot', 'batt-main');
    const planEdge = doc.edges.find((e) => e.to.port === 'plan')!;
    doc = removeEdge(doc, planEdge.id);
    // ctl1 is no longer plan-fed → it now claims directly (V-5 will flag it).
    const control = doc.nodes.find((n) => n.id === 'ctl1');
    expect(control?.claims).toEqual([{ entity_id: 'batt-main', commands: ['setpoint_kw'] }]);

    doc = setParam(doc, 'ctl1', 'entity_id', 'other-entity');
    expect(doc.nodes.find((n) => n.id === 'ctl1')?.claims).toEqual([
      { entity_id: 'other-entity', commands: ['setpoint_kw'] },
    ]);
    doc = setParam(doc, 'ctl1', 'entity_id', '');
    expect(doc.nodes.find((n) => n.id === 'ctl1')?.claims).toBeUndefined();
  });
});

describe('catalog helpers', () => {
  it('compatible implements exactly the two widenings', () => {
    expect(compatible('price', 'timeseries')).toBe(true);
    expect(compatible('number', 'timeseries')).toBe(true);
    expect(compatible('bool', 'number')).toBe(false);
    expect(compatible('timeseries', 'number')).toBe(false);
    expect(compatible('bool', 'event')).toBe(false);
    expect(compatible('plan', 'plan')).toBe(true);
  });

  it('supportsVersion is same-major, catalog >= requested', () => {
    expect(supportsVersion('vp.logic.threshold', '1.0.0')).toBe(true);
    expect(supportsVersion('vp.logic.threshold', '1.1.0')).toBe(true);
    expect(supportsVersion('vp.logic.threshold', '1.2.0')).toBe(false);
    expect(supportsVersion('vp.logic.threshold', '2.0.0')).toBe(false);
    expect(supportsVersion('vp.gibtsnicht.x', '1.0.0')).toBe(false);
  });

  it('the catalog carries the initial nodes (Eigenverbrauch ist kein Strategie-Knoten mehr)', () => {
    const expected = [
      'vp.price.dayahead', 'vp.forecast.pv', 'vp.entity.read', 'vp.logic.threshold',
      'vp.schedule.window', 'vp.logic.gate', 'vp.strategy.market',
      'vp.entity.control', 'vp.notify.push',
    ];
    for (const type of expected) {
      expect(catalogType(type), type).not.toBeNull();
    }
    // The removed self-consumption strategy node is gone (report §3.3).
    expect(catalogType('vp.strategy.selfconsumption')).toBeNull();
  });
});

describe('display derivation', () => {
  it('nodeSubtitle names the entity and key parameters in German', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    const read = doc.nodes.find((n) => n.id === 'soc1')!;
    expect(nodeSubtitle(read, ENTITIES)).toBe('Speicher (Hybrid) · soc_pct');
    const strategy = doc.nodes.find((n) => n.id === 'strat1')!;
    expect(nodeSubtitle(strategy, ENTITIES)).toBe('Speicher (Hybrid) · Ausgewogen');
  });

  it('lifecycleSteps renders the Entwurf → Simuliert → Aktiv rail', () => {
    expect(lifecycleSteps('draft').map((s) => s.state)).toEqual(['live', 'open', 'open']);
    expect(lifecycleSteps('simulated').map((s) => s.state)).toEqual(['done', 'live', 'open']);
    expect(lifecycleSteps('active').map((s) => s.state)).toEqual(['done', 'done', 'live']);
  });
});

/**
 * Audit N-1: „Benachrichtigung" is delivered NOWHERE - `vp-notify` publishes on
 * the local bus and no consumer exists - yet a customer could build, validate,
 * simulate and ACTIVATE it, after which the shelf reported "Läuft". The node
 * stays in the catalog (existing flows keep validating, compiling and running,
 * and the technical layer keeps it for diagnosis) but is flagged so no customer
 * surface offers it. Delete the flag the day a delivery channel ships.
 */
describe('customer visibility (audit N-1)', () => {
  it('flags exactly the not-offered nodes: undeliverable promises + the generated rule', () => {
    // vp.logic.gate / vp.notify.push: promises the platform cannot keep (N-1).
    // vp.consumer.reactive / vp.modbus.switch / vp.mqtt.read: GENERATED
    // (D-19/D-22) - valid only in server-stamped documents, never authorable.
    // The switch additionally exists ONLY after a per-device release, so
    // offering it would be a button that promises a write nothing has proven;
    // the MQTT read carries a field mapping the editor cannot yet render
    // (P5d), so offering it would be a form nobody can fill in.
    expect(diagnosticOnlyTypes().sort())
      .toEqual(['vp.consumer.reactive', 'vp.logic.gate', 'vp.modbus.switch',
        'vp.mqtt.read', 'vp.notify.push']);
  });

  it('treats an unflagged node as customer-visible (the default)', () => {
    expect(customerVisible(catalogType('vp.entity.control')!)).toBe(true);
    expect(customerVisible(catalogType('vp.entity.read')!)).toBe(true);
    expect(customerVisible({})).toBe(true);
    expect(customerVisible({ customer_visible: false })).toBe(false);
  });

  it('says what it is in its own label, so the technical layer cannot mistake it', () => {
    expect(catalogType('vp.notify.push')!.label).toMatch(/nur Diagnose/);
    expect(catalogType('vp.logic.gate')!.label).toMatch(/nur Diagnose/);
  });

  it('D3 vocabulary: the palette speaks of Messwerten und Geräten', () => {
    expect(catalogType('vp.entity.read')!.label).toBe('Messwert eines Geräts');
    expect(catalogType('vp.entity.control')!.label).toBe('Gerät steuern');
  });
});
