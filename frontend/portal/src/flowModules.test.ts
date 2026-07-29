import { describe, expect, it } from 'vitest';
import { flowModuleCards } from './flowModules';
import { NODE_ATYPICAL_GRID, NODE_MARKET, NODE_PEAKSHAVING } from './usageProfile';

describe('flowModuleCards', () => {
  it('Arbitrage: market runs (Eigenverbrauch ist kein Baustein mehr)', () => {
    const cards = flowModuleCards('arbitrage', [NODE_MARKET]);
    expect(cards.map((c) => c.title)).toEqual(['Marktoptimierung']);
    expect(cards.every((c) => c.state === 'active')).toBe(true);
  });

  it('Privat: market offered as a lock, kein Eigenverbrauchs-Baustein', () => {
    const cards = flowModuleCards('private', []);
    const market = cards.find((c) => c.title === 'Marktoptimierung')!;
    expect(market.state).toBe('gated');
    // Eigenverbrauch ist Grundverhalten, keine Karte (report §3.3).
    expect(cards.some((c) => c.title === 'Eigenverbrauch')).toBe(false);
    // peak-shaving is NOT offered to a private home.
    expect(cards.some((c) => c.title === 'Lastspitzenkappung')).toBe(false);
  });

  it('Peak: peak-shaving + market run, atypical grid offered as a lock', () => {
    const cards = flowModuleCards('peak', [NODE_PEAKSHAVING, NODE_MARKET]);
    const titles = cards.map((c) => c.title);
    expect(titles).toContain('Lastspitzenkappung');
    expect(titles).toContain('Marktoptimierung');
    const atyp = cards.find((c) => c.title === 'Atypische Netznutzung')!;
    expect(atyp.state).toBe('gated');
  });

  it('offers the market lock even with no active flow', () => {
    const cards = flowModuleCards('arbitrage', []);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(NODE_MARKET);
    expect(cards[0].state).toBe('gated');
  });

  it('never leaks optimizer-internal vocabulary into the copy', () => {
    const all = [
      ...flowModuleCards('peak', [NODE_PEAKSHAVING, NODE_MARKET, NODE_ATYPICAL_GRID]),
      ...flowModuleCards('private', []),
    ];
    const text = all.map((c) => `${c.title} ${c.line}`).join(' ').toLowerCase();
    for (const banned of ['milp', 'optimizer', 'modul', 'solver', 'node']) {
      expect(text).not.toContain(banned);
    }
  });
});
