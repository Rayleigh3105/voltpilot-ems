/** Guard-bar chips: honest, never fabricated limits. */
import { describe, expect, it } from 'vitest';
import { guardChips } from './guardbar';

const NBSP = ' ';

describe('guardChips', () => {
  it('renders the full constraint set of a configured site', () => {
    const chips = guardChips({
      netzladenErlaubt: false,
      maxFeedInKw: 74,
      leistungspreisEurKw: 120,
      socMinPct: 5,
      socMaxPct: 95,
      backupReserveSocPct: 20,
    });
    const texts = chips.map((c) => c.text);
    expect(texts).toContain('§ 14a-Limit (beobachtet)');
    expect(texts).toContain(`Einspeisung ≤ 74${NBSP}kW`);
    expect(texts).toContain(`SoC 5–95${NBSP}%`);
    expect(texts).toContain(`Notstrom-Reserve 20${NBSP}%`);
    expect(texts).toContain('EEG: kein Netzladen-Verstoß');
    expect(texts).toContain(`Leistungspreis 120${NBSP}€/kW`);
  });

  it('omits unset constraints and flips the Netzladen wording', () => {
    const chips = guardChips({ netzladenErlaubt: true, maxFeedInKw: null });
    const texts = chips.map((c) => c.text);
    expect(texts).toContain('Netzladen erlaubt');
    expect(texts.some((t) => t.startsWith('Einspeisung'))).toBe(false);
    expect(texts.some((t) => t.startsWith('Leistungspreis'))).toBe(false);
  });

  it('renders nothing without a site', () => {
    expect(guardChips(null)).toEqual([]);
  });
});
