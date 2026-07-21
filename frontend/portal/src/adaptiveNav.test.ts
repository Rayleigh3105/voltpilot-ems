import { describe, expect, it } from 'vitest';
import { navFor, type AnlagenTab } from './adaptiveNav';
import type { AnlagenSub } from './nav';

/** Labels of the VISIBLE tabs, in order (the §5.2 promoted ordering). */
function visibleLabels(tabs: AnlagenTab[]): string[] {
  return tabs.filter((t) => !t.overflow).map((t) => t.label);
}

/** The set of every sub reachable (visible + overflow), null = the cockpit. */
function reachableSubs(tabs: AnlagenTab[]): Set<AnlagenSub | null> {
  return new Set(tabs.map((t) => t.sub));
}

const ALL_SUBS: (AnlagenSub | null)[] = [
  null,
  'lastspitzen',
  'live',
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'entitaeten',
  'simulation',
  'steuerung',
];

describe('navFor - per-face ordering (§5.2)', () => {
  it('private → Übersicht · Geräte · Steuerung · Live · Historie', () => {
    expect(visibleLabels(navFor('private', 'endkunde'))).toEqual([
      'Übersicht',
      'Geräte',
      'Steuerung',
      'Live',
      'Historie',
    ]);
  });

  it('peak → Übersicht · Lastspitzen · Live · Steuerung · Geräte · Historie (U4 lead)', () => {
    expect(visibleLabels(navFor('peak', 'betreiber'))).toEqual([
      'Übersicht',
      'Lastspitzen',
      'Live',
      'Steuerung',
      'Geräte',
      'Historie',
    ]);
  });

  it('the peak "Lastspitzen" tab opens the lastspitzen sub', () => {
    const tab = navFor('peak', null).find((t) => t.label === 'Lastspitzen');
    expect(tab?.sub).toBe('lastspitzen');
    expect(tab?.overflow).toBe(false);
  });

  it('arbitrage → Übersicht · Erlöse · Fahrplan · Steuerung · Geräte', () => {
    expect(visibleLabels(navFor('arbitrage', 'betreiber'))).toEqual([
      'Übersicht',
      'Erlöse',
      'Fahrplan',
      'Steuerung',
      'Geräte',
    ]);
  });

  it('the arbitrage "Erlöse" tab is a promotion of the historie sub', () => {
    const arbErloese = navFor('arbitrage', null).find((t) => t.label === 'Erlöse');
    expect(arbErloese?.sub).toBe('historie');
  });
});

describe('navFor - invariants (never break a deep link; always findable)', () => {
  for (const profile of ['private', 'peak', 'arbitrage', null] as const) {
    it(`every AnlagenSub stays reachable on face ${profile ?? 'default'}`, () => {
      const tabs = navFor(profile, 'endkunde');
      const reachable = reachableSubs(tabs);
      for (const sub of ALL_SUBS) expect(reachable.has(sub)).toBe(true);
      // No duplicate: each sub appears exactly once (visible XOR overflow).
      expect(tabs).toHaveLength(ALL_SUBS.length);
    });

    it(`Geräte + Steuerung are in the VISIBLE set on face ${profile ?? 'default'}`, () => {
      const visible = navFor(profile, 'endkunde').filter((t) => !t.overflow);
      expect(visible.some((t) => t.sub === 'entitaeten')).toBe(true);
      expect(visible.some((t) => t.sub === 'steuerung')).toBe(true);
    });

    it(`Übersicht (the cockpit) leads face ${profile ?? 'default'} and is never in overflow`, () => {
      const tabs = navFor(profile, 'endkunde');
      expect(tabs[0].sub).toBe(null);
      expect(tabs[0].overflow).toBe(false);
      expect(tabs.filter((t) => t.sub === null && t.overflow)).toHaveLength(0);
    });
  }
});

describe('navFor - v1-safe default for null/unknown input', () => {
  it('a null profile yields the calm default order (Übersicht · Live · Fahrplan · Historie · Steuerung · Geräte · Einstellungen)', () => {
    expect(visibleLabels(navFor(null, 'endkunde'))).toEqual([
      'Übersicht',
      'Live',
      'Fahrplan',
      'Historie & Erlöse',
      'Steuerung',
      'Geräte',
      'Einstellungen',
    ]);
  });

  it('an unknown/garbage profile string falls back to the default order', () => {
    expect(visibleLabels(navFor('nonsense', null))).toEqual(visibleLabels(navFor(null, null)));
    expect(visibleLabels(navFor(undefined, undefined as never))).toEqual(
      visibleLabels(navFor(null, null)),
    );
  });

  it('a known profile with a null frame still gives that profile order (frame does not reorder)', () => {
    expect(visibleLabels(navFor('arbitrage', null))).toEqual(
      visibleLabels(navFor('arbitrage', 'betreiber')),
    );
  });

  it('overflow tabs are all marked overflow and carry a real sub', () => {
    const overflow = navFor('arbitrage', null).filter((t) => t.overflow);
    expect(overflow.length).toBeGreaterThan(0);
    for (const t of overflow) {
      expect(t.overflow).toBe(true);
      expect(t.sub).not.toBe(null);
    }
  });
});

describe('navFor - MEDIUM-3: a v1/un-migrated site keeps the calm default order', () => {
  // The api's profile deriver never returns null, so a plain eigenverbrauch v1
  // site derives 'private'. Without the migration gate its tab bar led with the
  // (empty) Geräte page and buried Fahrplan/Einstellungen in `Mehr ▾`.
  for (const profile of ['private', 'peak', 'arbitrage'] as const) {
    it(`${profile} on an un-migrated site renders the default order`, () => {
      expect(visibleLabels(navFor(profile, 'endkunde', false))).toEqual(
        visibleLabels(navFor(null, 'endkunde')),
      );
    });
  }

  it('the v1/fallback order leads with Übersicht, never with the empty Geräte page', () => {
    const visible = navFor('private', null, false).filter((t) => !t.overflow);
    expect(visible[0].sub).toBe(null);
    expect(visible[1].sub).not.toBe('entitaeten');
  });

  it('the everyday v1 subs (Fahrplan/Historie/Einstellungen) are visible, not buried', () => {
    const visible = navFor('private', null, false).filter((t) => !t.overflow);
    for (const sub of ['fahrplan', 'historie', 'technik'] as const) {
      expect(visible.some((t) => t.sub === sub)).toBe(true);
    }
  });

  it('Geräte + Steuerung stay in the visible set (always findable)', () => {
    const visible = navFor('private', null, false).filter((t) => !t.overflow);
    expect(visible.some((t) => t.sub === 'entitaeten')).toBe(true);
    expect(visible.some((t) => t.sub === 'steuerung')).toBe(true);
  });

  it('every sub stays reachable exactly once on the un-migrated face', () => {
    const tabs = navFor('peak', 'betreiber', false);
    expect(reachableSubs(tabs)).toEqual(new Set(ALL_SUBS));
    expect(tabs).toHaveLength(ALL_SUBS.length);
  });

  it('a MIGRATED site keeps its per-face order (§5.2 intact)', () => {
    expect(visibleLabels(navFor('peak', 'betreiber', true))).toEqual([
      'Übersicht',
      'Lastspitzen',
      'Live',
      'Steuerung',
      'Geräte',
      'Historie',
    ]);
  });
});
