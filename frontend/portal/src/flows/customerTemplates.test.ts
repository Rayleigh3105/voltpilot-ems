import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_TEMPLATES,
  controllableConsumers,
  gridMeterEntity,
} from './customerTemplates';
import type { EditorEntity } from './model';
import { isValid, validateFlow } from './validate';

const ENTITIES: EditorEntity[] = [
  { id: 'wb', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off', 'setpoint_kw'] },
  { id: 'gm', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
  { id: 'hr', entityType: 'heating-rod', label: 'Heizstab', measure: ['power_kw'], actuate: ['on_off'] },
  { id: 'bat', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
];

describe('customer control templates', () => {
  it('controllableConsumers picks on/off consumers, never the battery', () => {
    const ids = controllableConsumers(ENTITIES).map((e) => e.id);
    expect(ids).toContain('wb');
    expect(ids).toContain('hr');
    expect(ids).not.toContain('bat');
    expect(ids).not.toContain('gm');
  });

  it('gridMeterEntity finds the grid meter', () => {
    expect(gridMeterEntity(ENTITIES)?.id).toBe('gm');
  });

  for (const tpl of CUSTOMER_TEMPLATES) {
    it(`${tpl.id} resolves to a document that validates clean against the client validator`, () => {
      const res = tpl.resolve(ENTITIES, 'site-1');
      expect('doc' in res).toBe(true);
      if ('doc' in res) {
        const findings = validateFlow(res.doc, ENTITIES);
        expect(isValid(findings)).toBe(true);
        // FREE nodes only - never a gated strategy node.
        expect(res.doc.nodes.some((n) => n.type.startsWith('vp.strategy.'))).toBe(false);
      }
    });
  }

  it('every template reports an honest reason when no controllable consumer exists', () => {
    const noConsumer = ENTITIES.filter((e) => !e.actuate.includes('on_off'));
    for (const tpl of CUSTOMER_TEMPLATES) {
      const res = tpl.resolve(noConsumer, 'site-1');
      expect('reason' in res).toBe(true);
    }
  });

  it('the PV-surplus template reports a reason when the grid meter is missing', () => {
    const noGrid: EditorEntity[] = [
      { id: 'wb', entityType: 'wallbox', label: 'Wallbox', measure: [], actuate: ['on_off'] },
    ];
    const tpl = CUSTOMER_TEMPLATES.find((t) => t.id === 'pv-surplus-consumer')!;
    expect('reason' in tpl.resolve(noGrid, 'site-1')).toBe(true);
  });
});
