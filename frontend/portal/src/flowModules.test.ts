import { describe, expect, it } from 'vitest';
import { flowModuleCards } from './flowModules';
import {
  NODE_ATYPICAL_GRID,
  NODE_MARKET,
  NODE_PEAKSHAVING,
  NODE_SELFCONSUMPTION,
} from './usageProfile';

describe('flowModuleCards', () => {
  it('Arbitrage: market + self-consumption both run, no offers', () => {
    const cards = flowModuleCards('arbitrage', [NODE_MARKET, NODE_SELFCONSUMPTION]);
    expect(cards.map((c) => c.title)).toEqual(['Marktoptimierung', 'Eigenverbrauch']);
    expect(cards.every((c) => c.state === 'active')).toBe(true);
  });

  it('Privat: self-consumption runs, market offered as a lock', () => {
    const cards = flowModuleCards('private', [NODE_SELFCONSUMPTION]);
    const market = cards.find((c) => c.title === 'Marktoptimierung')!;
    const eigen = cards.find((c) => c.title === 'Eigenverbrauch')!;
    expect(eigen.state).toBe('active');
    expect(market.state).toBe('gated');
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
      ...flowModuleCards('private', [NODE_SELFCONSUMPTION]),
    ];
    const text = all.map((c) => `${c.title} ${c.line}`).join(' ').toLowerCase();
    for (const banned of ['milp', 'optimizer', 'modul', 'solver', 'node']) {
      expect(text).not.toContain(banned);
    }
  });
});
