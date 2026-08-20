import { describe, expect, it } from 'vitest';
import { leadBlock, LEAD_CANDIDATES } from './leadSlot';
import type { CockpitBlock, CockpitBlockId } from './surface';

const ORDER: Record<CockpitBlockId, number> = {
  status: 0,
  'peak-band': 10,
  'erloes-komposition': 20,
  energiefluss: 30,
  handel: 40,
  eigenverbrauch: 50,
  'geraete-automatik': 60,
  'toolbox-pointer': 99,
};

const blocks = (...ids: CockpitBlockId[]): CockpitBlock[] =>
  ids.map((id) => ({ id, title: id, order: ORDER[id], from: null }));

describe('leadBlock - the M3 N-ary lead rule (peak -> money -> flow)', () => {
  it('peak wins over money and flow', () => {
    expect(
      leadBlock(blocks('status', 'peak-band', 'erloes-komposition', 'energiefluss', 'handel')),
    ).toBe('peak-band');
  });

  it('money leads without peak', () => {
    expect(leadBlock(blocks('status', 'erloes-komposition', 'energiefluss', 'handel'))).toBe(
      'erloes-komposition',
    );
  });

  it('a pure private/flow Anlage leads with the hub', () => {
    expect(leadBlock(blocks('status', 'energiefluss', 'geraete-automatik'))).toBe('energiefluss');
  });

  it('an Anlage without any lead-capable block has no lead ("Neu / leer")', () => {
    expect(leadBlock([])).toBeNull();
    expect(leadBlock(null)).toBeNull();
    expect(leadBlock(undefined)).toBeNull();
    expect(leadBlock(blocks('status', 'toolbox-pointer'))).toBeNull();
  });

  it('is independent of the input order (it reads the SET, not the array)', () => {
    const b = blocks('energiefluss', 'peak-band', 'erloes-komposition');
    expect(leadBlock(b)).toBe('peak-band');
    expect(leadBlock([...b].reverse())).toBe('peak-band');
  });

  it('the candidate list IS the documented priority', () => {
    // `lade-budget` steht ZULETZT und führt damit nur, wenn es sonst nichts zu
    // führen gibt - die reine Ladepark-Anlage, die gar keinen Energiefluss-Block
    // bekommt (Lastmanagement Stufe 3, Mockups §2 Entscheidung 1).
    expect(LEAD_CANDIDATES).toEqual([
      'peak-band',
      'erloes-komposition',
      'energiefluss',
      'lade-budget',
    ]);
  });

  it('das Ladebudget führt NUR ohne anderen Kandidaten', () => {
    expect(leadBlock([{ id: 'lade-budget', title: 'Ladeleistung', order: 5, from: null }])).toBe(
      'lade-budget',
    );
    expect(
      leadBlock([
        { id: 'lade-budget', title: 'Ladeleistung', order: 5, from: null },
        { id: 'energiefluss', title: 'Energiefluss', order: 30, from: null },
      ]),
    ).toBe('energiefluss');
  });
});
