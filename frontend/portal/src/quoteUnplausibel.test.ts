import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { History, HistoryTotals } from './api';
import { eigenverbrauchBlock } from './cockpit';
import { cockpitHero } from './cockpitWidgets';
import { energieBilanz, messwerteKernaussage } from './energieBilanz';
import { NBSP } from './format';
import { energieQuoten } from './energieSeite';
import { quoteSatz, quoteUnplausibel, quoteZahl } from './quoteUnplausibel';

/**
 * AP-10 E16 Nr. 5 — Autarkie und Eigenverbrauch außerhalb 0…100 % werden
 * GEMELDET, nie in den Bereich gebogen.
 *
 * Früher klemmte der Server auf 0…100 und der Hero-Ring noch einmal: eine 110
 * las sich als glatte, perfekte 100 %. Jetzt reist die Zahl ungeklemmt, und
 * jede Fläche, die eine Quote zeigt, sagt „Messwerte passen nicht zusammen" —
 * mit dem Satz aus dem Bilanz-Vertrag. Der Normalfall darf sich dabei um keine
 * Stelle bewegen.
 */

const MINUS = '−';
const NOW = new Date('2026-07-22T12:00:00+02:00');

const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/bilanz-vectors.json'), 'utf8'),
) as { saetze: Record<string, string> };

const TOTALS: HistoryTotals = {
  consumptionKwh: 18.4,
  pvGenerationKwh: 32.1,
  gridImportKwh: 3.2,
  gridExportKwh: 9.6,
  gridCostEur: 0.94,
  tarifArt: 'dynamisch',
  batterySavingsPlannedEur: 1.2,
  autarkiePct: 82,
  eigenverbrauchPct: 64,
  autarkieUnplausibel: false,
  eigenverbrauchUnplausibel: false,
};

function history(totals: HistoryTotals): History {
  return {
    range: 'month',
    from: '2026-07-01T00:00:00+02:00',
    to: '2026-08-01T00:00:00+02:00',
    bucketMinutes: 1440,
    buckets: [
      {
        start: '2026-07-01T00:00:00+02:00',
        pvKwh: 32.1,
        loadKwh: 18.4,
        gridImportKwh: 3.2,
        gridExportKwh: 9.6,
      },
    ],
    totals,
    protocol: [],
  } as unknown as History;
}

describe('der Satz kommt aus dem Bilanz-Vertrag', () => {
  it('ist `saetze.rest_negativ` wörtlich, mit der ungeklemmten Zahl', () => {
    expect(vectors.saetze.rest_negativ).toBe('Messwerte passen nicht zusammen ({zahl})');
    expect(quoteSatz(-20)).toBe(
      vectors.saetze.rest_negativ.replace('{zahl}', `${MINUS}20${NBSP}%`),
    );
    expect(quoteSatz(110)).toBe(`Messwerte passen nicht zusammen (110${NBSP}%)`);
  });

  it('zeigt eine Nachkommastelle, wo die ganze Zahl wie ein gültiger Anteil aussähe', () => {
    expect(quoteZahl(100.4)).toBe(`100,4${NBSP}%`);
    expect(quoteZahl(-0.3)).toBe(`${MINUS}0,3${NBSP}%`);
    expect(quoteZahl(-25)).toBe(`${MINUS}25${NBSP}%`);
  });

  it('Vorgabe AN: das Kennzeichen macht unplausibel, entschuldigt aber nie eine Zahl außerhalb 0…100', () => {
    expect(quoteUnplausibel(50, true)).toBe(true);
    expect(quoteUnplausibel(110, false)).toBe(true);
    // Ein älterer Server liefert kein Kennzeichen: dann zählt der Wertebereich.
    expect(quoteUnplausibel(110, undefined)).toBe(true);
    expect(quoteUnplausibel(-5, null)).toBe(true);
    // Die Ränder sind gültige Anteile.
    expect(quoteUnplausibel(0)).toBe(false);
    expect(quoteUnplausibel(100)).toBe(false);
  });
});

describe('Hero-Ring', () => {
  it('Normalfall unverändert: Bogen auf dem Wert, dieselbe Zahl, kein Satz', () => {
    const hero = cockpitHero({ totals: TOTALS, range: 'month', now: NOW });
    expect(hero.rings[0]).toMatchObject({ id: 'autarkie', pct: 82, valueText: `82${NBSP}%` });
    expect(hero.rings[1]).toMatchObject({ pct: 64, valueText: `64${NBSP}%` });
    expect(hero.rings.map((r) => r.hinweis)).toEqual([null, null]);
  });

  it('unplausibel: KEIN Bogen (vorher 100), die ungeklemmte Zahl und der Satz', () => {
    const hero = cockpitHero({
      totals: { ...TOTALS, autarkiePct: 110, autarkieUnplausibel: true },
      range: 'month',
      now: NOW,
    });
    const [autarkie, ev] = hero.rings;
    expect(autarkie.pct).toBeNull();
    expect(autarkie.valueText).toBe(`110${NBSP}%`);
    expect(autarkie.hinweis).toBe(`Messwerte passen nicht zusammen (110${NBSP}%)`);
    // Jede Quote trägt ihr eigenes Kennzeichen.
    expect(ev.pct).toBe(64);
    expect(ev.hinweis).toBeNull();
  });

  it('ein negativer Eigenverbrauch wird nicht zu 0 % (vorher: leerer Bogen, „-25 %")', () => {
    const hero = cockpitHero({
      totals: { ...TOTALS, eigenverbrauchPct: -25, eigenverbrauchUnplausibel: true },
      range: 'month',
      now: NOW,
    });
    expect(hero.rings[1]).toMatchObject({
      pct: null,
      valueText: `${MINUS}25${NBSP}%`,
      hinweis: `Messwerte passen nicht zusammen (${MINUS}25${NBSP}%)`,
    });
  });
});

// Die Quoten der Energie-Seite (main 763b87f39, Verlauf-Rework P3) ersetzen die
// Messwerte-Zeilen (`messwerteZeilen.ts`, dort entfernt) — die Regel wandert mit.
describe('Energie-Seite: Quoten', () => {
  it('Normalfall unverändert: Zahl, Balken und erklärender Satz', () => {
    const [autarkie, ev] = energieQuoten(history(TOTALS));
    expect(autarkie).toMatchObject({
      key: 'autarkie',
      name: 'Autarkie',
      wert: `82${NBSP}%`,
      pct: 82,
      info: 'Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben — der Rest kam aus dem Netz.',
      unplausibel: false,
    });
    expect(autarkie.teile.map((t) => t.label)).toEqual(['aus eigener Anlage', 'aus dem Netz']);
    expect(ev.wert).toBe(`64${NBSP}%`);
    expect(ev.info).toBe('Anteil Ihrer Erzeugung, den Sie selbst genutzt statt eingespeist haben.');
  });

  it('unplausibel: die Zahl ungeklemmt, der Satz statt der Erklärung', () => {
    // Seit der Energie-Seite auch: kein Balken (eine Füllung bräuchte wieder eine Klemme).
    const [autarkie] = energieQuoten(history({ ...TOTALS, autarkiePct: -20, autarkieUnplausibel: true }));
    expect(autarkie).toMatchObject({
      wert: `${MINUS}20${NBSP}%`,
      info: `Messwerte passen nicht zusammen (${MINUS}20${NBSP}%)`,
      unplausibel: true,
      teile: [],
    });
  });

  it('Vorgabe AN auch hier: 105 % ohne Kennzeichen ist unplausibel', () => {
    const [, ev] = energieQuoten(history({ ...TOTALS, eigenverbrauchPct: 105, eigenverbrauchUnplausibel: undefined }));
    expect(ev).toMatchObject({ wert: `105${NBSP}%`, unplausibel: true, teile: [] });
  });
});

describe('Kernaussage über dem Verlauf', () => {
  it('Normalfall unverändert', () => {
    const kern = messwerteKernaussage(energieBilanz(history(TOTALS)), 'im Juli', {
      pct: 58,
      name: 'Juni',
    });
    expect(kern).toMatchObject({
      wert: '64 %',
      satz: 'Ihrer Sonne haben Sie im Juli selbst genutzt.',
      ton: 'ok',
      anker: 'Juni: 58 %.',
    });
  });

  it('unplausibel: keine Aussage über die Anlage, sondern der Satz', () => {
    const kern = messwerteKernaussage(
      energieBilanz(history({ ...TOTALS, eigenverbrauchPct: -25, eigenverbrauchUnplausibel: true })),
      'im Juli',
    );
    expect(kern.wert).toBeNull();
    expect(kern.satz).toBeNull();
    expect(kern.grund).toBe(`Messwerte passen nicht zusammen (${MINUS}25${NBSP}%).`);
  });

  it('ein unplausibler Vergleichszeitraum wird im Anker gesagt, nicht als Anteil genannt', () => {
    const kern = messwerteKernaussage(energieBilanz(history(TOTALS)), 'im Juli', {
      pct: 104,
      unplausibel: true,
      name: 'Juni',
    });
    expect(kern.anker).toBe(`Juni: Messwerte passen nicht zusammen (104${NBSP}%).`);
  });
});

describe('Eigenverbrauchs-Block', () => {
  it('Normalfall unverändert', () => {
    const view = eigenverbrauchBlock({
      autarkiePct: 82,
      eigenverbrauchPct: 64,
      autarkieUnplausibel: false,
      eigenverbrauchUnplausibel: false,
      gridImportKwh: 3.2,
      slots: [],
      now: NOW,
    });
    expect(view.tiles.slice(0, 2)).toEqual([
      { label: 'Autarkie heute', value: `82${NBSP}%`, sub: `3,2${NBSP}kWh aus dem Netz`, hue: 'pv' },
      { label: 'PV selbst genutzt', value: `64${NBSP}%`, sub: 'Rest gespeichert oder eingespeist', hue: 'batt' },
    ]);
  });

  it('unplausibel: die Kachel sagt den Satz statt „aus dem Netz"', () => {
    const view = eigenverbrauchBlock({
      autarkiePct: 110,
      eigenverbrauchPct: 64,
      autarkieUnplausibel: true,
      gridImportKwh: -1.8,
      slots: [],
      now: NOW,
    });
    expect(view.tiles[0]).toEqual({
      label: 'Autarkie heute',
      value: `110${NBSP}%`,
      sub: `Messwerte passen nicht zusammen (110${NBSP}%)`,
      hue: 'pv',
      unplausibel: true,
    });
  });
});
