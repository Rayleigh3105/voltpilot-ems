import { describe, expect, it } from 'vitest';
import { flowMode, hasStrategyNode, paletteFilterFor } from './steuerung';
import { catalog, type FlowDocument } from './model';
import { pilotTemplate } from './templates';
import { buildGuidedFlow } from './guidedBuilder';

function types(mode: 'strategie' | 'automation'): string[] {
  return catalog.types.filter(paletteFilterFor(mode)).map((t) => t.type);
}

describe('steuerung mode classification', () => {
  it('a flow with a strategy node is a Strategie', () => {
    const doc = pilotTemplate('Marktoptimierung', 'bat', 'site-1');
    expect(hasStrategyNode(doc)).toBe(true);
    expect(flowMode(doc)).toBe('strategie');
  });

  it('a device automation (no strategy node) is an Automation', () => {
    const doc = buildGuidedFlow(
      {
        conditions: [{ kind: 'schedule', from: '11:00', to: '15:00', days: 'alle' }],
        combinator: 'and',
        action: { kind: 'onoff', entityId: 'wb', ttlS: 300 },
      },
      'Zeitplan',
      'site-1',
    );
    expect(hasStrategyNode(doc)).toBe(false);
    expect(flowMode(doc)).toBe('automation');
  });

  it('an empty document is an Automation (no strategy node)', () => {
    const empty: FlowDocument = {
      schema_version: '1.0', name: 'x', runtime: 'edge', nodes: [], edges: [], triggers: [],
    };
    expect(flowMode(empty)).toBe('automation');
  });
});

describe('palette pre-filter per mode', () => {
  it('Automationen hides every strategy node', () => {
    const t = types('automation');
    expect(t.some((x) => x.startsWith('vp.strategy.'))).toBe(false);
    expect(t).toContain('vp.logic.and');
    expect(t).toContain('vp.price.current');
    expect(t).toContain('vp.entity.control');
  });

  it('Strategien shows strategy nodes plus data + action feeds, hides pure logic', () => {
    const t = types('strategie');
    expect(t).toContain('vp.strategy.market');
    expect(t).toContain('vp.price.dayahead');
    expect(t).toContain('vp.entity.control');
    // Automation-only logic (threshold/schedule/and) is not in the strategy palette.
    expect(t).not.toContain('vp.logic.and');
    expect(t).not.toContain('vp.logic.threshold');
  });
});
