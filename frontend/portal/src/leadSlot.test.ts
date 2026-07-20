import { describe, expect, it } from 'vitest';
import { leadArtifact } from './leadSlot';
import { emphasisFor } from './usageProfile';

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
