/**
 * Client-side validator vectors - MIRRORED from the api's
 * FlowGraphValidatorTest (the EdgeRef shared-vector precedent): the same
 * broken flows must trip the same V-rules on both sides, and the contract
 * example fixtures (docs/contracts/v2/examples) must validate identically.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditorEntity, FlowDocument } from './model';
import { deriveClaims } from './model';
import { pilotTemplate } from './templates';
import { isValid, validateFlow, type FlowFinding } from './validate';

const SITE = '00000000-0000-0000-0000-000000000002';

const ENTITIES: EditorEntity[] = [
  {
    id: 'batt-main',
    entityType: 'battery-hybrid',
    label: 'Speicher',
    measure: ['soc_pct', 'battery_power_kw'],
    actuate: ['setpoint_kw', 'limit_kw'],
  },
  { id: 'grid-meter-1', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
  { id: 'wallbox-1', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off', 'setpoint_kw'] },
  { id: 'heatrod-cellar', entityType: 'producer', label: 'Heizstab', measure: [], actuate: ['on_off'] },
  { id: 'pv-roof-east', entityType: 'producer', label: 'PV Ost', measure: ['pv_power_kw'], actuate: ['limit_pct'] },
  { id: 'modbus-meter-1', entityType: 'modbus-generic', label: 'Zähler', measure: ['leistung_kw'], actuate: [] },
];

const EXAMPLES = resolve(process.cwd(), '../../docs/contracts/v2/examples');
const haveFixtures = existsSync(EXAMPLES);

function fixture(name: string): FlowDocument {
  return JSON.parse(readFileSync(resolve(EXAMPLES, name), 'utf8')) as FlowDocument;
}

function errors(findings: FlowFinding[]): string[] {
  return findings.filter((f) => f.severity === 'error').map((f) => f.rule);
}

function shell(): FlowDocument {
  return {
    schema_version: '1.0',
    name: 'Testflow',
    runtime: 'edge',
    site_id: '00000000-0000-0000-0000-000000000002',
    nodes: [],
    edges: [],
    triggers: [{ id: 'trig1', kind: 'slot-boundary' }],
  };
}

describe('contract fixtures (executable contract)', () => {
  it.skipIf(!haveFixtures)('market-battery fixture validates clean', () => {
    const findings = validateFlow(fixture('flow-graph.valid.market-battery.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });

  it.skipIf(!haveFixtures)('pv-surplus-heatrod fixture validates clean', () => {
    const findings = validateFlow(fixture('flow-graph.valid.pv-surplus-heatrod.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });

  it.skipIf(!haveFixtures)('notify-threshold fixture validates clean', () => {
    // #518: the editor accepts Schwellwert -> Wenn/Dann-gate -> Benachrichtigung
    // (it always did); the drift was flowc lacking the gate compile entry, which
    // made activation compiler_reject this exact flow.
    const findings = validateFlow(fixture('flow-graph.valid.notify-threshold.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });

  it.skipIf(!haveFixtures)('unknown-trigger fixture fails exactly on V-7', () => {
    const findings = validateFlow(fixture('flow-graph.invalid.unknown-trigger.json'), ENTITIES);
    expect(errors(findings)).toEqual(['V-7']);
    expect(findings[0].message).toContain('cron');
  });

  it.skipIf(!haveFixtures)('compound-wallbox fixture validates clean (U3 AND + schedule)', () => {
    const findings = validateFlow(fixture('flow-graph.valid.compound-wallbox.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });

  it.skipIf(!haveFixtures)('price-wallbox fixture validates clean (U3 price condition)', () => {
    const findings = validateFlow(fixture('flow-graph.valid.price-wallbox.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });
});

describe('U3 combinator + price condition', () => {
  it('the AND combinator joins two conditions (each input takes one edge)', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'grid-meter-1', channel: 'power_kw' } },
      { id: 't1', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: -2, direction: 'below' } },
      { id: 'z1', type: 'vp.schedule.window', type_version: '1.0.0', parameters: { from: '11:00', to: '15:00', days: 'alle' } },
      { id: 'and1', type: 'vp.logic.and', type_version: '1.0.0', parameters: {} },
      { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0', parameters: { entity_id: 'wallbox-1', command: 'on_off', ttl_s: 300 }, claims: [{ entity_id: 'wallbox-1', commands: ['on_off'] }] },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'r1', port: 'value' }, to: { node: 't1', port: 'input' } },
      { id: 'e2', from: { node: 't1', port: 'result' }, to: { node: 'and1', port: 'a' } },
      { id: 'e3', from: { node: 'z1', port: 'active' }, to: { node: 'and1', port: 'b' } },
      { id: 'e4', from: { node: 'and1', port: 'result' }, to: { node: 'c1', port: 'value' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual([]);
  });

  it('vp.price.current feeds a threshold as a number', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'p1', type: 'vp.price.current', type_version: '1.0.0', parameters: {} },
      { id: 't1', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 10, direction: 'below' } },
      { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0', parameters: { entity_id: 'wallbox-1', command: 'on_off', ttl_s: 600 }, claims: [{ entity_id: 'wallbox-1', commands: ['on_off'] }] },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'p1', port: 'value' }, to: { node: 't1', port: 'input' } },
      { id: 'e2', from: { node: 't1', port: 'result' }, to: { node: 'c1', port: 'value' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual([]);
  });
});

describe('the pilot flow', () => {
  it('validates clean with exactly one delegated claim', () => {
    const doc = pilotTemplate('Marktoptimierung', 'batt-main', SITE);
    expect(errors(validateFlow(doc, ENTITIES))).toEqual([]);
    const claims = deriveClaims(doc);
    expect(claims).toEqual([
      { nodeId: 'strat1', entityId: 'batt-main', commands: ['setpoint_kw'], delegated: true },
    ]);
  });
});

describe('V-1 port compatibility + required inputs', () => {
  it('refuses incompatible port types (bool → number)', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'grid-meter-1', channel: 'power_kw' } },
      { id: 't1n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 3 } },
      { id: 't2n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 5 } },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'r1', port: 'value' }, to: { node: 't1n', port: 'input' } },
      { id: 'e2', from: { node: 't1n', port: 'result' }, to: { node: 't2n', port: 'input' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual(['V-1']);
  });

  it('requires connected required inputs and refuses double connections', () => {
    const unconnected = shell();
    unconnected.nodes = [
      { id: 't1n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 3 } },
    ];
    expect(errors(validateFlow(unconnected, ENTITIES))).toContain('V-1');

    const doubled = shell();
    doubled.nodes = [
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'grid-meter-1', channel: 'power_kw' } },
      { id: 'r2', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'grid-meter-1', channel: 'power_kw' } },
      { id: 't1n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 3 } },
    ];
    doubled.edges = [
      { id: 'e1', from: { node: 'r1', port: 'value' }, to: { node: 't1n', port: 'input' } },
      { id: 'e2', from: { node: 'r2', port: 'value' }, to: { node: 't1n', port: 'input' } },
    ];
    expect(errors(validateFlow(doubled, ENTITIES))).toEqual(['V-1']);
  });

  it('entity control needs at least one connected input', () => {
    const doc = shell();
    doc.nodes = [{
      id: 'c1',
      type: 'vp.entity.control',
      type_version: '1.0.0',
      parameters: { entity_id: 'heatrod-cellar', command: 'on_off' },
      claims: [{ entity_id: 'heatrod-cellar', commands: ['on_off'] }],
    }];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual(['V-1']);
  });

  it('allows the two declared widenings (number→timeseries, price→timeseries)', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'p1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'batt-main', channel: 'soc_pct' } },
      {
        id: 's1',
        type: 'vp.strategy.market',
        type_version: '1.0.0',
        parameters: { entity_id: 'batt-main' },
        claims: [{ entity_id: 'batt-main', commands: ['setpoint_kw'], delegated: true }],
      },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'p1', port: 'prices' }, to: { node: 's1', port: 'price_in' } },
      { id: 'e2', from: { node: 'r1', port: 'value' }, to: { node: 's1', port: 'soc' } },
      { id: 'e3', from: { node: 'p1', port: 'prices' }, to: { node: 's1', port: 'pv_forecast' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual([]);
  });
});

describe('V-2 cycles', () => {
  it('refuses undeclared cycles, accepts declared feedback', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'a', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 1 } },
      { id: 'b', type: 'vp.logic.gate', type_version: '1.0.0', parameters: {} },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'a', port: 'result' }, to: { node: 'b', port: 'wenn' } },
      { id: 'e2', from: { node: 'b', port: 'dann' }, to: { node: 'a', port: 'input' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-2');

    doc.edges[1].feedback = true;
    expect(errors(validateFlow(doc, ENTITIES))).not.toContain('V-2');
  });
});

describe('V-3 ids and references', () => {
  it('refuses duplicate node ids and dangling edge references', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'n1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
      { id: 'n1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
    ];
    doc.edges = [
      { id: 'e1', from: { node: 'ghost', port: 'prices' }, to: { node: 'n1', port: 'nope' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-3');
  });
});

describe('V-4 catalog resolution', () => {
  it('refuses unknown types and unsupported versions', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'x1', type: 'vp.magic.wand', type_version: '1.0.0', parameters: {} },
      { id: 'p1', type: 'vp.price.dayahead', type_version: '9.0.0', parameters: {} },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toEqual(['V-4', 'V-4']);
  });

  it('validates required parameters, enums and number bounds', () => {
    const doc = shell();
    doc.nodes = [
      { id: 't1n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: {} },
      { id: 't2n', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: { threshold: 1, direction: 'sideways' } },
      {
        id: 'c1',
        type: 'vp.entity.control',
        type_version: '1.0.0',
        parameters: { entity_id: 'heatrod-cellar', command: 'on_off', ttl_s: 5 },
        claims: [{ entity_id: 'heatrod-cellar', commands: ['on_off'] }],
      },
    ];
    const v4 = errors(validateFlow(doc, ENTITIES)).filter((r) => r === 'V-4');
    expect(v4).toHaveLength(3);
  });
});

describe('V-5 exclusive resources + claim derivation', () => {
  it('refuses two claims on one entity', () => {
    const doc = pilotTemplate('Konflikt', 'batt-main', SITE);
    doc.nodes.push({
      id: 'c2',
      type: 'vp.entity.control',
      type_version: '1.0.0',
      parameters: { entity_id: 'batt-main', command: 'setpoint_kw' },
      claims: [{ entity_id: 'batt-main', commands: ['setpoint_kw'] }],
    });
    doc.nodes.push({
      id: 'z1', type: 'vp.schedule.window', type_version: '1.0.0',
      parameters: { from: '08:00', to: '12:00' },
    });
    doc.edges.push({ id: 'e9', from: { node: 'z1', port: 'active' }, to: { node: 'c2', port: 'value' } });
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-5');
  });

  it('refuses hand-edited claims that disagree with the derivation', () => {
    const doc = pilotTemplate('Manipuliert', 'batt-main', SITE);
    doc.nodes = doc.nodes.map((n) => (n.id === 'strat1' ? { ...n, claims: [] } : n));
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-5');
  });

  it('refuses a claim held by another ACTIVE flow', () => {
    const doc = pilotTemplate('Zweitflow', 'batt-main', SITE);
    const findings = validateFlow(doc, ENTITIES, [
      { entityId: 'batt-main', flowId: 'f-1', flowName: 'Anderer Flow' },
    ]);
    expect(errors(findings)).toContain('V-5');
    expect(findings.find((f) => f.rule === 'V-5')?.message).toContain('Anderer Flow');
  });
});

describe('V-6 capability match', () => {
  it('refuses unknown entities and unsupported channels', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'p1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
      {
        id: 's1', type: 'vp.strategy.market', type_version: '1.0.0',
        parameters: { entity_id: 'nirvana' },
        claims: [{ entity_id: 'nirvana', commands: ['setpoint_kw'], delegated: true }],
      },
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'batt-main', channel: 'geheimkanal' } },
    ];
    doc.edges = [
      { id: 'e0', from: { node: 'p1', port: 'prices' }, to: { node: 's1', port: 'price_in' } },
    ];
    const v6 = errors(validateFlow(doc, ENTITIES)).filter((r) => r === 'V-6');
    expect(v6).toHaveLength(2);
  });

  it('hints at the bootstrap when the site has no v2 entities yet', () => {
    const doc = pilotTemplate('Ohne Registry', 'batt-main', SITE);
    const findings = validateFlow(doc, []);
    expect(findings.some((f) => f.message.includes('Bootstrap'))).toBe(true);
  });
});

// MB-M1 vp.modbus.read - the MIRROR of the api FlowGraphValidatorTest modbus
// vectors: host kind (V-4), mapping both-or-neither (V-4), mapped-read
// capability + composed refusal (V-6), in-flow duplicate mapping (V-5).
describe('MB-M1 vp.modbus.read', () => {
  function modbusFlow(params: Record<string, unknown>): FlowDocument {
    const doc = shell();
    doc.nodes = [
      { id: 'mb1', type: 'vp.modbus.read', type_version: '1.0.0', parameters: params },
    ];
    return doc;
  }
  const BASE = { host: '192.168.40.17', address: 100 };

  it.skipIf(!haveFixtures)('modbus-read fixture validates clean', () => {
    const findings = validateFlow(fixture('flow-graph.valid.modbus-read.json'), ENTITIES);
    expect(errors(findings)).toEqual([]);
  });

  it('validates the host kind (V-4): IPv4 and hostnames pass, garbage fails', () => {
    expect(errors(validateFlow(modbusFlow(BASE), ENTITIES))).toEqual([]);
    expect(errors(validateFlow(modbusFlow({ host: 'zaehler.keller.local', address: 0 }),
      ENTITIES))).toEqual([]);
    expect(errors(validateFlow(modbusFlow({ host: 'kein host!', address: 0 }), ENTITIES)))
      .toEqual(['V-4']);
    expect(errors(validateFlow(modbusFlow({ host: '-bad.example', address: 0 }), ENTITIES)))
      .toEqual(['V-4']);
    expect(errors(validateFlow(modbusFlow({ address: 0 }), ENTITIES))).toEqual(['V-4']);
  });

  it('mapping is both-or-neither (V-4)', () => {
    expect(errors(validateFlow(modbusFlow({ ...BASE, channel: 'leistung_kw' }), ENTITIES)))
      .toEqual(['V-4']);
    expect(errors(validateFlow(modbusFlow({ ...BASE, entity_id: 'modbus-meter-1' }), ENTITIES)))
      .toEqual(['V-4']);
    expect(errors(validateFlow(modbusFlow(
      { ...BASE, entity_id: 'modbus-meter-1', channel: 'leistung_kw' }), ENTITIES))).toEqual([]);
  });

  it('refuses mapping onto a COMPOSED entity (guard integrity, V-6)', () => {
    const findings = validateFlow(modbusFlow(
      { ...BASE, entity_id: 'batt-main', channel: 'soc_pct' }), ENTITIES);
    expect(errors(findings)).toEqual(['V-6']);
    expect(findings[0].message).toContain('Stammdaten');
  });

  it('refuses an undeclared channel and an unknown entity (V-6)', () => {
    expect(errors(validateFlow(modbusFlow(
      { ...BASE, entity_id: 'modbus-meter-1', channel: 'geheimkanal' }), ENTITIES)))
      .toEqual(['V-6']);
    expect(errors(validateFlow(modbusFlow(
      { ...BASE, entity_id: 'nirvana', channel: 'leistung_kw' }), ENTITIES)))
      .toEqual(['V-6']);
  });

  it('refuses two reads recording the same (entity, channel) (V-5)', () => {
    const doc = shell();
    doc.nodes = [
      { id: 'mb1', type: 'vp.modbus.read', type_version: '1.0.0',
        parameters: { ...BASE, entity_id: 'modbus-meter-1', channel: 'leistung_kw' } },
      { id: 'mb2', type: 'vp.modbus.read', type_version: '1.0.0',
        parameters: { host: 'other.local', address: 7, entity_id: 'modbus-meter-1', channel: 'leistung_kw' } },
    ];
    const findings = validateFlow(doc, ENTITIES);
    expect(errors(findings)).toEqual(['V-5']);
    expect(findings[0].nodeIds).toEqual(['mb1', 'mb2']);
  });
});

describe('V-7 trigger sanity', () => {
  it('checks interval bounds and value-change sources', () => {
    const doc = shell();
    doc.nodes = [{ id: 'p1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} }];
    doc.triggers = [
      { id: 't1', kind: 'interval', every_s: 0 },
      { id: 't2', kind: 'value-change', source: { node: 'p1', port: 'nope' } },
    ];
    const v7 = errors(validateFlow(doc, ENTITIES)).filter((r) => r === 'V-7');
    expect(v7).toHaveLength(2);
  });
});

describe('V-8 runtime whitelist', () => {
  it('refuses edge-only nodes in a cloud flow', () => {
    const doc = shell();
    doc.runtime = 'cloud';
    delete doc.site_id;
    doc.nodes = [
      { id: 'r1', type: 'vp.entity.read', type_version: '1.0.0', parameters: { entity_id: 'grid-meter-1', channel: 'power_kw' } },
    ];
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-8');
  });
});

describe('vp.logic.function (D-16 code node) - the twin of FlowGraphValidatorTest', () => {
  function codeFlow(parameters: Record<string, unknown>) {
    const doc = shell();
    doc.nodes = [
      { id: 'code1', type: 'vp.logic.function', type_version: '1.0.0', parameters },
    ];
    return doc;
  }

  it('caps the source length and refuses an empty one (V-4)', () => {
    expect(errors(validateFlow(codeFlow({ code: '   ' }), ENTITIES))).toContain('V-4');
    expect(errors(validateFlow(codeFlow({ code: 'x'.repeat(4001) }), ENTITIES))).toContain('V-4');
    // A well-formed code param produces no PARAMETER finding (the unconnected
    // required input is a separate, expected V-1).
    const findings = validateFlow(codeFlow({ code: 'return wert * 2;' }), ENTITIES);
    expect(findings.filter((f) => f.rule === 'V-4')).toEqual([]);
  });

  it('is edge-only: the cloud never executes customer code (V-8)', () => {
    const doc = codeFlow({ code: 'return wert;' });
    doc.runtime = 'cloud';
    delete doc.site_id;
    expect(errors(validateFlow(doc, ENTITIES))).toContain('V-8');
  });
});

describe('isValid', () => {
  it('is the blocking verdict', () => {
    expect(isValid([])).toBe(true);
    expect(isValid([{ rule: 'x', severity: 'warning', nodeIds: [], edgeIds: [], message: '' }])).toBe(true);
    expect(isValid([{ rule: 'x', severity: 'error', nodeIds: [], edgeIds: [], message: '' }])).toBe(false);
  });
});
