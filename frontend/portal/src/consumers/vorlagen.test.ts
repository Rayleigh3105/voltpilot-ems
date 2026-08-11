import { describe, expect, it } from 'vitest';
import {
  CONSUMER_TEMPLATE_PREFILL,
  isConsumerRuleTemplate,
  parseVerbraucherParams,
  templateConsumer,
  verbraucherRegelHash,
  verbraucherVorlageHash,
} from './vorlagen';
import { CUSTOMER_TEMPLATES } from '../flows/customerTemplates';
import { buildPolicyDocument, type BuildOptions } from './policy';
import type { ConsumerDraft } from './questions';
import { isValid, validatePolicy } from './validate';

const BUILD_OPTS: BuildOptions = {
  entityId: '6f1d2c3b-4a59-4687-9abc-def012345678',
  requirementId: 'r-1',
  ctx: { controlKind: 'on_off', hasStorage: true, hasMeasurementChannel: true },
  controlProfile: { control_kind: 'on_off', rated_power_kw: 11 },
};

/** The builder's initial draft (mirrors VerbraucherSection.initialDraft). */
function baseDraft(): ConsumerDraft {
  return {
    intent: null,
    conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }],
    combinator: 'and',
    recurrence: { days: 'daily', from: '13:00', to: '14:00' },
    demandMode: 'runtime',
    runtimeMinutes: 60,
    energyKwh: null,
    contiguous: true,
    target: { kind: 'on_off', value: true },
    enforcement: 'must_run',
    gridEnergyPolicy: 'allow',
    storageRelation: 'consumer_first',
    allowStorageDischarge: false,
  };
}

describe('consumer-rule templates (D7)', () => {
  it('covers exactly the consumer templates of the automation gallery (lockstep)', () => {
    // Every gallery template whose requiresRoles is consumer-led must open the
    // Regelbaukasten - a new consumer template needs a prefill here.
    const consumerLed = CUSTOMER_TEMPLATES
      .filter((t) => t.requiresRoles.includes('consumer'))
      .map((t) => t.id)
      .sort();
    expect(Object.keys(CONSUMER_TEMPLATE_PREFILL).sort()).toEqual(consumerLed);
    for (const id of consumerLed) {
      expect(isConsumerRuleTemplate(id)).toBe(true);
    }
    expect(isConsumerRuleTemplate('marktoptimierung-pilot')).toBe(false);
  });

  it('every prefill completes into a VALID policy document via the builder pipeline', () => {
    for (const [id, prefill] of Object.entries(CONSUMER_TEMPLATE_PREFILL)) {
      const draft = { ...baseDraft(), ...prefill };
      expect(draft.intent, id).not.toBeNull();
      const doc = buildPolicyDocument(draft, BUILD_OPTS);
      const findings = validatePolicy(doc);
      expect(isValid(findings), `${id}: ${JSON.stringify(findings)}`).toBe(true);
    }
  });

  it('the PV-surplus prefill is a reactive LOCAL-signal rule with hysteresis', () => {
    const p = CONSUMER_TEMPLATE_PREFILL['pv-surplus-consumer'];
    expect(p.intent).toBe('react');
    expect(p.conditions?.[0].signal).toBe('site.pv_surplus_kw');
    expect(p.conditions?.[0].resetValue).toBeLessThan(p.conditions?.[0].value as number);
    // "Nur bei Überschuss" is an opportunity, never a Pflichtlauf with grid power.
    expect(p.enforcement).toBe('opportunistic');
  });

  it('the schedule prefill is a fixed daily window', () => {
    const p = CONSUMER_TEMPLATE_PREFILL['schedule-consumer'];
    expect(p.intent).toBe('schedule');
    expect(p.recurrence).toEqual({ days: 'daily', from: '11:00', to: '15:00' });
  });

  it('prefers the matching consumer type, falls back to the first, never invents one', () => {
    const wallbox = { id: 'c-wb', type: 'wallbox' };
    const rod = { id: 'c-rod', type: 'heating-rod' };
    expect(templateConsumer('pv-surplus-consumer', [rod, wallbox])).toBe(wallbox);
    expect(templateConsumer('schedule-consumer', [rod, wallbox])).toBe(rod);
    expect(templateConsumer('pv-surplus-consumer', [rod])).toBe(rod);
    expect(templateConsumer('pv-surplus-consumer', [])).toBeNull();
  });

  it('deep-link hashes round-trip through the parser', () => {
    const h1 = verbraucherVorlageHash('s-1', 'pv-surplus-consumer');
    expect(h1).toBe('#/anlage/s-1/steuerung?vorlage=pv-surplus-consumer');
    expect(parseVerbraucherParams(h1)).toEqual({ vorlage: 'pv-surplus-consumer', verbraucher: null });

    const h2 = verbraucherRegelHash('s-1', 'c-9');
    expect(parseVerbraucherParams(h2)).toEqual({ vorlage: null, verbraucher: 'c-9' });

    // No params = nothing claimed.
    expect(parseVerbraucherParams('#/anlage/s-1/steuerung'))
      .toEqual({ vorlage: null, verbraucher: null });
  });
});
