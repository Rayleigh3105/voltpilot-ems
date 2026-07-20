import { describe, expect, it } from 'vitest';
import {
  buildGuidedFlow,
  isGuidedFlow,
  parseGuidedFlow,
  type GuidedRule,
} from './guidedBuilder';
import { CUSTOMER_TEMPLATES } from './customerTemplates';
import type { EditorEntity, FlowDocument } from './model';
import { isValid, validateFlow } from './validate';

const ENTITIES: EditorEntity[] = [
  { id: 'wb', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off', 'setpoint_kw'] },
  { id: 'gm', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
  { id: 'bat', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
];

const RULES: Array<{ name: string; rule: GuidedRule }> = [
  {
    name: 'entity condition -> on/off',
    rule: {
      conditions: [{ kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'below', threshold: -2, hysteresis: 0.5 }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
    },
  },
  {
    name: 'price condition -> on/off',
    rule: {
      conditions: [{ kind: 'price', direction: 'below', threshold: 10 }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 600 },
    },
  },
  {
    name: 'schedule condition -> on/off',
    rule: {
      conditions: [{ kind: 'schedule', from: '11:00', to: '15:00', days: 'alle' }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
    },
  },
  {
    name: 'compound AND (entity + schedule) -> on/off',
    rule: {
      conditions: [
        { kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'below', threshold: -2 },
        { kind: 'schedule', from: '11:00', to: '15:00', days: 'werktage' },
      ],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
    },
  },
  {
    name: 'compound OR (price + entity) -> on/off',
    rule: {
      conditions: [
        { kind: 'price', direction: 'below', threshold: 8 },
        { kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'below', threshold: -3 },
      ],
      combinator: 'or',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
    },
  },
  {
    name: 'three conditions AND -> setpoint',
    rule: {
      conditions: [
        { kind: 'price', direction: 'below', threshold: 8 },
        { kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'below', threshold: -3 },
        { kind: 'schedule', from: '10:00', to: '16:00', days: 'alle' },
      ],
      combinator: 'and',
      action: { kind: 'setpoint', entityId: 'wb', value: 11, ttlS: 300 },
    },
  },
  {
    name: 'entity condition -> notify',
    rule: {
      conditions: [{ kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'above', threshold: 5 }],
      combinator: 'and',
      action: { kind: 'notify', message: 'Hohe Einspeisung.' },
    },
  },
];

describe('guided rule builder', () => {
  for (const { name, rule } of RULES) {
    it(`${name}: builds a document that validates clean`, () => {
      const doc = buildGuidedFlow(rule, name, 'site-1');
      const findings = validateFlow(doc, ENTITIES);
      expect(isValid(findings)).toBe(true);
      // FREE nodes only - a guided rule never carries a gated strategy node.
      expect(doc.nodes.some((n) => n.type.startsWith('vp.strategy.'))).toBe(false);
    });

    it(`${name}: round-trips (parse of the built document reproduces the rule)`, () => {
      const doc = buildGuidedFlow(rule, name, 'site-1');
      expect(isGuidedFlow(doc)).toBe(true);
      expect(parseGuidedFlow(doc)).toEqual(rule);
    });
  }

  it('the two E3b customer templates are builder-openable (golden cases)', () => {
    for (const tpl of CUSTOMER_TEMPLATES) {
      const res = tpl.resolve(ENTITIES, 'site-1');
      expect('doc' in res).toBe(true);
      if ('doc' in res) {
        const rule = parseGuidedFlow(res.doc);
        expect(rule).not.toBeNull();
        // Re-building from the parsed rule and re-parsing is stable.
        const rebuilt = buildGuidedFlow(rule!, 'x', 'site-1');
        expect(parseGuidedFlow(rebuilt)).toEqual(rule);
        expect(isValid(validateFlow(rebuilt, ENTITIES))).toBe(true);
      }
    }
  });

  it('the PV-surplus template parses to the expected entity rule', () => {
    const tpl = CUSTOMER_TEMPLATES.find((t) => t.id === 'pv-surplus-consumer')!;
    const res = tpl.resolve(ENTITIES, 'site-1');
    if (!('doc' in res)) throw new Error('expected a doc');
    expect(parseGuidedFlow(res.doc)).toEqual({
      conditions: [{ kind: 'entity', entityId: 'gm', channel: 'power_kw', direction: 'below', threshold: -2, hysteresis: 0.5 }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
    });
  });

  it('the Heizstab template parses to the expected schedule rule', () => {
    const tpl = CUSTOMER_TEMPLATES.find((t) => t.id === 'schedule-consumer')!;
    const res = tpl.resolve(ENTITIES, 'site-1');
    if (!('doc' in res)) throw new Error('expected a doc');
    expect(parseGuidedFlow(res.doc)).toEqual({
      conditions: [{ kind: 'schedule', from: '11:00', to: '15:00', days: 'alle' }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'wb', ttlS: 600 },
    });
  });

  it('returns null for a document outside the builder subset', () => {
    // The pilot flow (a delegated strategy chain) is not a Wenn/Dann rule.
    const strategyDoc: FlowDocument = {
      schema_version: '1.0',
      name: 'Pilot',
      runtime: 'edge',
      site_id: 'site-1',
      nodes: [
        { id: 'price1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
        { id: 'strat1', type: 'vp.strategy.market', type_version: '1.0.0', parameters: { entity_id: 'bat' }, claims: [{ entity_id: 'bat', commands: ['setpoint_kw'], delegated: true }] },
        { id: 'ctl1', type: 'vp.entity.control', type_version: '1.0.0', parameters: { entity_id: 'bat', command: 'setpoint_kw', ttl_s: 180 } },
      ],
      edges: [
        { id: 'e1', from: { node: 'price1', port: 'prices' }, to: { node: 'strat1', port: 'price_in' } },
        { id: 'e2', from: { node: 'strat1', port: 'wunsch' }, to: { node: 'ctl1', port: 'plan' } },
      ],
      triggers: [{ id: 't1', kind: 'slot-boundary' }],
    };
    expect(parseGuidedFlow(strategyDoc)).toBeNull();
    expect(isGuidedFlow(strategyDoc)).toBe(false);
  });

  it('returns null for a stray unaccounted node', () => {
    const doc = buildGuidedFlow(RULES[0].rule, 'x', 'site-1');
    doc.nodes.push({ id: 'strayn', type: 'vp.forecast.pv', type_version: '1.0.0', parameters: {} });
    expect(parseGuidedFlow(doc)).toBeNull();
  });

  it('returns null for a mixed AND/OR combinator tree', () => {
    // Hand-build a mixed tree: (a AND b) fed into an OR node.
    const doc: FlowDocument = {
      schema_version: '1.0',
      name: 'mixed',
      runtime: 'edge',
      site_id: 'site-1',
      nodes: [
        { id: 'z1', type: 'vp.schedule.window', type_version: '1.0.0', parameters: { from: '10:00', to: '12:00', days: 'alle' } },
        { id: 'z2', type: 'vp.schedule.window', type_version: '1.0.0', parameters: { from: '13:00', to: '15:00', days: 'alle' } },
        { id: 'z3', type: 'vp.schedule.window', type_version: '1.0.0', parameters: { from: '16:00', to: '18:00', days: 'alle' } },
        { id: 'and1', type: 'vp.logic.and', type_version: '1.0.0', parameters: {} },
        { id: 'or1', type: 'vp.logic.or', type_version: '1.0.0', parameters: {} },
        { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0', parameters: { entity_id: 'wb', command: 'on_off', ttl_s: 300 }, claims: [{ entity_id: 'wb', commands: ['on_off'] }] },
      ],
      edges: [
        { id: 'e1', from: { node: 'z1', port: 'active' }, to: { node: 'and1', port: 'a' } },
        { id: 'e2', from: { node: 'z2', port: 'active' }, to: { node: 'and1', port: 'b' } },
        { id: 'e3', from: { node: 'and1', port: 'result' }, to: { node: 'or1', port: 'a' } },
        { id: 'e4', from: { node: 'z3', port: 'active' }, to: { node: 'or1', port: 'b' } },
        { id: 'e5', from: { node: 'or1', port: 'result' }, to: { node: 'c1', port: 'value' } },
      ],
      triggers: [{ id: 't1', kind: 'slot-boundary' }],
    };
    expect(parseGuidedFlow(doc)).toBeNull();
  });
});
