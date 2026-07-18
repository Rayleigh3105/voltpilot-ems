/** Templates + list-card chain derivation. */
import { describe, expect, it } from 'vitest';
import type { EditorEntity } from './model';
import { batteryEntity, emptyFlow, flowChain, pilotTemplate } from './templates';
import { validateFlow } from './validate';

const SITE = '00000000-0000-0000-0000-000000000002';

const ENTITIES: EditorEntity[] = [
  {
    id: 'batt-1',
    entityType: 'battery-hybrid',
    label: 'Speicher',
    measure: ['soc_pct'],
    actuate: ['setpoint_kw', 'limit_kw'],
  },
  { id: 'pv-1', entityType: 'producer', label: 'PV', measure: ['pv_power_kw'], actuate: ['limit_kw'] },
];

describe('pilotTemplate', () => {
  it('builds the acceptance chain and validates clean', () => {
    const doc = pilotTemplate('Marktoptimierung', 'batt-1', SITE);
    expect(doc.nodes.map((n) => n.type)).toEqual([
      'vp.price.dayahead', 'vp.forecast.pv', 'vp.entity.read',
      'vp.strategy.market', 'vp.entity.control',
    ]);
    const errors = validateFlow(doc, ENTITIES).filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('emptyFlow', () => {
  it('carries a default slot-boundary trigger', () => {
    const doc = emptyFlow('Neu');
    expect(doc.triggers).toEqual([{ id: 't1', kind: 'slot-boundary' }]);
    expect(doc.nodes).toEqual([]);
  });
});

describe('batteryEntity', () => {
  it('finds the battery-hybrid entity or null', () => {
    expect(batteryEntity(ENTITIES)?.id).toBe('batt-1');
    expect(batteryEntity(ENTITIES.slice(1))).toBeNull();
  });
});

describe('flowChain', () => {
  it('walks the pilot chain in topological order', () => {
    const chain = flowChain(pilotTemplate('Pilot', 'batt-1'));
    expect(chain.map((c) => c.label)).toEqual([
      'Strompreis', 'PV-Prognose', 'Entität lesen', 'Marktoptimierung',
    ]);
    expect(flowChain(pilotTemplate('Pilot', 'batt-1'), 3)).toHaveLength(3);
  });
});
