import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EarningsHero, type HeroMoney } from './FleetOverview';

/**
 * Der 14-Tage-Spark des Flotten-Helden trug ZWEI der gemessenen
 * Ehrlichkeitsfehler des Mini-Inventars zugleich (`vp-charts-filigran-c7` §4
 * Nr. 9): `Math.max(0, savedEur)` machte aus jedem VERLUSTTAG einen Nulltag,
 * und `Math.max(8, …)` zog jeden kleinen Tag auf 8 % hoch. Diese Suite hält
 * das Ergebnis fest — auf der Ebene, auf der es der Kunde sieht.
 */

const NOW = new Date('2026-07-06T12:00:00Z');

/**
 * jsdom kennt `matchMedia` nicht; der Held fragt es für die Zähl-Animation
 * (`prefers-reduced-motion`) und `useIsPhone`. Die Attrappe meldet den
 * Schreibtisch UND „Bewegung reduzieren" - eine Animation, die 800 ms lang
 * hochzählt, hätte in einem Test nur Flackern erzeugt.
 */
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  // Die Attrappe darf keine andere Datei erreichen.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

const MONEY: HeroMoney = {
  baselineEur: 40,
  actualEur: 25,
  savedEur: 15,
  arbitrageEur: null,
};

function hero(dailySaved: { day: string; savedEur: number }[]) {
  return render(
    <EarningsHero
      kind="eigenverbrauch"
      money={MONEY}
      dailySaved={dailySaved}
      range="month"
      onRange={() => {}}
      now={NOW}
    />,
  );
}

/** Ein Verlusttag am 03.07., sonst Gewinne — die Zahlen des Mockups. */
const MIT_VERLUSTTAG = [
  { day: '2026-07-02', savedEur: 2.2 },
  { day: '2026-07-03', savedEur: -0.4 },
  { day: '2026-07-04', savedEur: 3.1 },
  { day: '2026-07-05', savedEur: 3.4 },
  { day: '2026-07-06', savedEur: 3.6 },
];

describe('EarningsHero · der Verlusttag ist sichtbar und BENANNT', () => {
  it('zeichnet ihn unter einer echten Nulllinie, statt ihn auf 0 zu klemmen', () => {
    const { container } = hero(MIT_VERLUSTTAG);
    expect(container.querySelector('.vp-fleet-spark .vp-mini-zero')).not.toBeNull();
    const neg = container.querySelector<HTMLElement>('.vp-fleet-spark .vp-mini-bar.is-neg');
    expect(neg).not.toBeNull();
    // Geklemmt hiesse: gar kein negativer Balken - genau der alte Zustand.
    expect(neg!.style.height).not.toBe('');
  });

  it('BENENNT ihn im Bild (K6), statt ihn nur zu färben', () => {
    hero(MIT_VERLUSTTAG);
    expect(screen.getByText('Verlusttag -0,40 €')).toBeTruthy();
  });

  it('sagt den heutigen Wert MIT Vergleichsanker (K1/K8)', () => {
    hero(MIT_VERLUSTTAG);
    // testing-library normalisiert das NBSP aus `eurAmount` zu einem Space.
    expect(
      screen.getByText(/Heute \+3,60 € — etwa so viel wie gestern \(\+3,40 €\)/),
    ).toBeTruthy();
    expect(screen.getByText('heute')).toBeTruthy();
  });

  it('nennt ohne heutigen Wert den GRUND, statt einen Satz zu erfinden', () => {
    hero([
      { day: '2026-07-04', savedEur: 3.1 },
      { day: '2026-07-05', savedEur: 3.4 },
    ]);
    expect(screen.getByText('Für heute liegt noch kein Tageswert vor.')).toBeTruthy();
    // Ohne Wert auch keine „heute"-Fahne über einer Lücke.
    expect(screen.queryByText('heute')).toBeNull();
  });
});

describe('EarningsHero · keine Mindesthöhen-Fälschung mehr', () => {
  it('gibt einem winzigen Tag die STRICH-Form statt 8 % Höhe', () => {
    const { container } = hero([
      { day: '2026-07-05', savedEur: 40 },
      { day: '2026-07-06', savedEur: 0.01 },
    ]);
    const forms = [...container.querySelectorAll<HTMLElement>('.vp-fleet-spark .vp-mini-bar')].map(
      (b) => b.dataset.form,
    );
    expect(forms).toContain('tick');
  });

  it('zeichnet für einen Tag ohne Wert GAR NICHTS, nie einen Nullbalken', () => {
    const { container } = hero([
      { day: '2026-07-04', savedEur: 3.1 },
      // 05.07. fehlt - `sparkDays` füllt ihn als Lücke auf.
      { day: '2026-07-06', savedEur: 3.6 },
    ]);
    const cols = container.querySelectorAll('.vp-fleet-spark .vp-mini-col').length;
    const bars = container.querySelectorAll('.vp-fleet-spark .vp-mini-bar').length;
    expect(cols).toBe(14);
    expect(bars).toBe(2);
  });
});

describe('EarningsHero · der Spark liegt auf dem Marken-Verlauf', () => {
  it('trägt die on-gradient-Fassung', () => {
    const { container } = hero(MIT_VERLUSTTAG);
    expect(container.querySelector('.vp-fleet-spark .vp-mini-on-gradient')).not.toBeNull();
  });

  it('rendert gar keinen Spark, solange es nur einen Tag gibt', () => {
    const { container } = hero([{ day: '2026-07-06', savedEur: 3.6 }]);
    expect(container.querySelector('.vp-fleet-spark')).toBeNull();
  });
});
