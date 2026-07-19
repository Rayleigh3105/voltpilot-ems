import { describe, it, expect } from 'vitest';
import { moneyPresentation, moneyLayout } from './moneyEmphasis';

describe('moneyPresentation', () => {
  it('arbitrage emphasis (prominent) → prominent', () => {
    expect(moneyPresentation('prominent')).toBe('prominent');
  });

  it('peak emphasis (secondary) → secondary', () => {
    expect(moneyPresentation('secondary')).toBe('secondary');
  });

  it('private emphasis (minimal) → hidden', () => {
    expect(moneyPresentation('minimal')).toBe('hidden');
  });

  it('the explicit hidden level also → hidden', () => {
    expect(moneyPresentation('hidden')).toBe('hidden');
  });

  it('un-migrated / profile-less site (null|undefined) falls back to prominent', () => {
    expect(moneyPresentation(null)).toBe('prominent');
    expect(moneyPresentation(undefined)).toBe('prominent');
  });

  it('an unknown level falls back to prominent (never de-emphasises unexpectedly)', () => {
    expect(moneyPresentation('bogus')).toBe('prominent');
    expect(moneyPresentation('')).toBe('prominent');
  });
});

describe('moneyLayout', () => {
  it('prominent (arbitrage/fallback): full money, no de-emphasis - byte-identical to today', () => {
    expect(moneyLayout('prominent')).toEqual({
      presentation: 'prominent',
      showFullMoney: true,
      nachweis: false,
      hiddenFromHero: false,
    });
    // The fallback (un-migrated site) must be identical to the arbitrage layout.
    expect(moneyLayout(null)).toEqual(moneyLayout('prominent'));
  });

  it('secondary (peak): full money kept but framed as Nachweis, not hidden', () => {
    expect(moneyLayout('secondary')).toEqual({
      presentation: 'secondary',
      showFullMoney: true,
      nachweis: true,
      hiddenFromHero: false,
    });
  });

  it('hidden (private): money out of the hero, reachable via detail', () => {
    expect(moneyLayout('minimal')).toEqual({
      presentation: 'hidden',
      showFullMoney: false,
      nachweis: false,
      hiddenFromHero: true,
    });
    expect(moneyLayout('hidden')).toEqual(moneyLayout('minimal'));
  });

  it('showFullMoney is true for exactly prominent + secondary', () => {
    expect(moneyLayout('prominent').showFullMoney).toBe(true);
    expect(moneyLayout('secondary').showFullMoney).toBe(true);
    expect(moneyLayout('minimal').showFullMoney).toBe(false);
  });
});
