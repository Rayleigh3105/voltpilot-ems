import { describe, expect, it } from 'vitest';
import {
  consumerLayers,
  consumerShade,
  consumerSlotInfos,
  hasConsumerData,
  isPflicht,
  REASON_TEXT,
  reasonText,
  type ConsumerSchedule,
} from './consumerSchedule';

const T0 = '2026-08-10T12:00:00Z';
const T1 = '2026-08-10T12:15:00Z';
const T2 = '2026-08-10T12:30:00Z';

function schedule(overrides: Partial<ConsumerSchedule> = {}): ConsumerSchedule {
  return {
    planId: 'p-1',
    generatedAt: T0,
    slotMinutes: 15,
    entities: [
      {
        entityId: 'e-1',
        name: 'Stallpumpe',
        slots: [
          { time: T0, command: 'on_off', targetValue: 2.2, reasonCode: 'fixed_window', requirementId: 'r' },
          { time: T1, command: 'on_off', targetValue: 0, reasonCode: null, requirementId: null },
        ],
      },
    ],
    ...overrides,
  };
}

describe('reasonText', () => {
  it('maps every §15 code through the ONE table', () => {
    for (const [code, text] of Object.entries(REASON_TEXT)) {
      expect(reasonText(code)).toBe(text);
    }
  });

  it('never guesses an unknown code (the vocabulary may grow server-side first)', () => {
    expect(reasonText('brand_new_code')).toBeNull();
    expect(reasonText(null)).toBeNull();
    expect(reasonText(undefined)).toBeNull();
  });
});

describe('isPflicht', () => {
  it('marks only the compiled hard windows', () => {
    expect(isPflicht('fixed_window')).toBe(true);
    expect(isPflicht('price_below_threshold')).toBe(true);
    expect(isPflicht('optimizer_selected_low_cost')).toBe(false);
    expect(isPflicht(null)).toBe(false);
  });
});

describe('consumerLayers', () => {
  it('aligns by TIMESTAMP onto the battery plan grid - a missing slot is a gap, never 0', () => {
    const layers = consumerLayers(schedule(), [T0, T1, T2]);
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe('Stallpumpe');
    expect(layers[0].values).toEqual([2.2, 0, null]); // T2 not covered -> null
    expect(layers[0].pflicht).toEqual([true, false, false]);
    expect(layers[0].reasons).toEqual(['fixed_window', null, null]);
  });

  it('drops consumer slots outside the plan grid instead of mis-indexing', () => {
    const layers = consumerLayers(schedule(), [T1]);
    expect(layers[0].values).toEqual([0]);
  });

  it('falls back to a numbered name when the entity has no label', () => {
    const s = schedule();
    s.entities[0] = { ...s.entities[0], name: null };
    expect(consumerLayers(s, [T0])[0].name).toBe('Verbraucher 1');
  });

  it('renders nothing for an empty/absent schedule (the shadow default)', () => {
    expect(consumerLayers(null, [T0])).toEqual([]);
    expect(consumerLayers(schedule({ entities: [] }), [T0])).toEqual([]);
    expect(hasConsumerData([])).toBe(false);
  });

  it('hasConsumerData needs at least one aligned value', () => {
    expect(hasConsumerData(consumerLayers(schedule(), [T2]))).toBe(false);
    expect(hasConsumerData(consumerLayers(schedule(), [T0]))).toBe(true);
  });
});

describe('consumerShade', () => {
  it('keeps the base hue for the first consumer and lightens deterministically', () => {
    expect(consumerShade('#8b5cf6', 0)).toBe('#8b5cf6');
    const s1 = consumerShade('#8b5cf6', 1);
    expect(s1).not.toBe('#8b5cf6');
    expect(consumerShade('#8b5cf6', 1)).toBe(s1); // deterministic
  });

  it('passes a non-hex base through untouched', () => {
    expect(consumerShade('var(--x)', 2)).toBe('var(--x)');
  });
});

describe('consumerSlotInfos', () => {
  it('builds Ziel + Grund + Pflicht for the tapped slot', () => {
    const NBSP = ' ';
    const layers = consumerLayers(schedule(), [T0, T1, T2]);
    const on = consumerSlotInfos(layers, 0);
    expect(on).toEqual([
      {
        name: 'Stallpumpe',
        // House convention: NBSP before the unit (format.ts discipline).
        ziel: `Ziel: 2,2${NBSP}kW`,
        grund: 'Festes Zeitfenster (Pflichtlauf)',
        pflicht: true,
      },
    ]);
    // Off slot: honest "Aus", no reason claimed.
    expect(consumerSlotInfos(layers, 1)).toEqual([
      { name: 'Stallpumpe', ziel: 'Aus', grund: null, pflicht: false },
    ]);
    // Uncovered slot: the consumer does not appear at all.
    expect(consumerSlotInfos(layers, 2)).toEqual([]);
  });
});
