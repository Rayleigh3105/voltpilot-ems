import { describe, expect, it } from 'vitest';
import { leadArtifact, leadBlock, LEAD_CANDIDATES } from './leadSlot';
import { emphasisFor } from './usageProfile';
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

describe('leadArtifact - the U4 cockpit lead-slot switch', () => {
  it('peak profile leads with the Peak-Band', () => {
    expect(leadArtifact(emphasisFor('peak').peak)).toBe('peakband');
  });

  it('arbitrage profile leads with money (byte-identical to today)', () => {
    expect(leadArtifact(emphasisFor('arbitrage').peak)).toBe('money');
  });

  it('private profile leads with money', () => {
    expect(leadArtifact(emphasisFor('private').peak)).toBe('money');
  });

  it('only the literal "prominent" peak emphasis flips to the Peak-Band', () => {
    expect(leadArtifact('prominent')).toBe('peakband');
    expect(leadArtifact('secondary')).toBe('money');
    expect(leadArtifact('minimal')).toBe('money');
    expect(leadArtifact('hidden')).toBe('money');
  });

  it('null/undefined/unknown resolve to money (v1-safe fallback)', () => {
    expect(leadArtifact(null)).toBe('money');
    expect(leadArtifact(undefined)).toBe('money');
    expect(leadArtifact('nonsense')).toBe('money');
  });
});

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
    expect(LEAD_CANDIDATES).toEqual(['peak-band', 'erloes-komposition', 'energiefluss']);
  });
});
