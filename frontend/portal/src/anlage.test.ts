import { describe, expect, it } from 'vitest';
import type { EarningsMonth, EarningsSeriesPoint, EarningsSite } from './api';
import {
  bestBucket,
  bestBucketText,
  bucketAxisLabel,
  eigenverbrauchProvenance,
  einspeiseProvenance,
  energyLabel,
  energyTiles,
  ertragTitle,
  gesamtertragProvenance,
  monthLong,
  monthShort,
  periodLabel,
  savedProvenance,
  stripSlots,
  stripValueLabel,
} from './anlage';

/** A computable EarningsSite with sensible defaults, overridable per test. */
function makeMoney(over: Partial<EarningsSite> = {}): EarningsSite {
  return {
    id: 's-1',
    name: 'Anlage',
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: 7.6,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: 38.42,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 100,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    einspeiseErloesEur: 421.1,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: 421.1,
    selbstverbrauchKwh: 820,
    eingespeistKwh: 5550,
    batterieBewegtKwh: 1610,
    series: [],
    monthlyStrip: [],
    ...over,
  };
}

describe('energyLabel', () => {
  it('shows MWh from a megawatt-hour up, kWh below, and never a fake zero', () => {
    expect(energyLabel(null)).toBe('–');
    expect(energyLabel(undefined)).toBe('–');
    expect(energyLabel(5550)).toBe('5,55 MWh');
    expect(energyLabel(820)).toBe('820 kWh');
    expect(energyLabel(9.4)).toBe('9,4 kWh');
    expect(energyLabel(0)).toBe('0,0 kWh');
  });
});

describe('month labels', () => {
  it('are the German short/long month names of the ISO month', () => {
    expect(monthShort('2026-07-01')).toBe('Jul');
    expect(monthShort('2026-03-01')).toBe('Mär');
    expect(monthLong('2026-07-01')).toBe('Juli');
  });
});

describe('periodLabel', () => {
  const now = new Date('2026-07-07T10:00:00Z');
  it('names the selected instance per range', () => {
    expect(periodLabel('day', now, now)).toBe('Heute');
    expect(periodLabel('month', now, now)).toBe('Juli');
    expect(periodLabel('year', now, now)).toBe('2026');
    expect(periodLabel('all', now, now)).toBe('Gesamt');
  });
  it('adds the year to a month of another year (a strip tap into the past)', () => {
    const march2025 = new Date('2025-03-15T12:00:00');
    expect(periodLabel('month', march2025, now)).toBe('März 2025');
  });
});

describe('stripSlots', () => {
  const now = new Date('2026-07-07T10:00:00Z');
  it('builds a fixed 12-month axis ending this month, filling missing months with null', () => {
    const strip: EarningsMonth[] = [
      { month: '2026-07-01', gesamtertragEur: 512.8 },
      { month: '2026-06-01', gesamtertragEur: 830 },
    ];
    const slots = stripSlots(strip, now);
    expect(slots).toHaveLength(12);
    // Oldest first, ending on the current month.
    expect(slots[0].month).toBe('2025-08-01');
    expect(slots[11].month).toBe('2026-07-01');
    expect(slots[11].isCurrent).toBe(true);
    expect(slots[11].value).toBe(512.8);
    expect(slots[11].label).toBe('Jul');
    expect(slots[10].value).toBe(830);
    // A month with no computable value carries null, not a fake zero.
    expect(slots[0].value).toBeNull();
  });
});

describe('stripValueLabel', () => {
  it('is a compact signed integer, never "-0"', () => {
    expect(stripValueLabel(null)).toBe('–');
    expect(stripValueLabel(104.4)).toBe('+104');
    expect(stripValueLabel(-7.2)).toBe('-7');
    expect(stripValueLabel(-0.001)).toBe('0');
  });
});

describe('bucketAxisLabel', () => {
  it('formats the bucket start per range (Berlin-local)', () => {
    // 2026-07-07 12:00 UTC = 14:00 Berlin (CEST).
    expect(bucketAxisLabel('2026-07-07T12:00:00Z', 'day')).toBe('14');
    // Berlin day start of the 7th.
    expect(bucketAxisLabel('2026-07-06T22:00:00Z', 'month')).toBe('7.');
    // Berlin month start of July.
    expect(bucketAxisLabel('2026-06-30T22:00:00Z', 'year')).toBe('Jul');
  });
});

describe('bestBucket / bestBucketText', () => {
  const series: EarningsSeriesPoint[] = [
    // Berlin day starts (CEST = UTC+2): 22:00Z is the next Berlin day's 00:00.
    { start: '2026-07-05T22:00:00Z', gesamtertragEur: 12.5 }, // Berlin 6. Juli
    { start: '2026-07-06T22:00:00Z', gesamtertragEur: 48.2 }, // Berlin 7. Juli (best)
    { start: '2026-07-07T22:00:00Z', gesamtertragEur: 30 }, // Berlin 8. Juli
  ];
  it('finds the highest-Gesamtertrag bucket', () => {
    expect(bestBucket(series)?.gesamtertragEur).toBe(48.2);
    expect(bestBucket([])).toBeNull();
  });
  it('names the best day with its amount, and stays silent when nothing is positive', () => {
    expect(bestBucketText(series, 'month')).toBe('Bester Tag: 7. Juli · +48,20 €');
    expect(bestBucketText([{ start: '2026-07-07T22:00:00Z', gesamtertragEur: 0 }], 'month')).toBeNull();
    expect(bestBucketText([], 'month')).toBeNull();
  });
});

describe('ertragTitle', () => {
  it('matches the range granularity', () => {
    expect(ertragTitle('day')).toBe('Ertrag pro Stunde');
    expect(ertragTitle('month')).toBe('Ertrag pro Tag');
    expect(ertragTitle('year')).toBe('Ertrag pro Monat');
    expect(ertragTitle('all')).toBe('Ertrag pro Monat');
  });
});

describe('einspeiseProvenance (decision 3)', () => {
  it('names the fed-in energy and the realized Ø Börsenpreis', () => {
    const t = einspeiseProvenance(makeMoney());
    expect(t).toContain('Eingespeiste 5,55 MWh');
    expect(t).toContain('Ø 7,6 ct/kWh');
    expect(t).toContain('Börsenpreis Ihrer Einspeise-Zeiten');
  });
  it('adds the Marktprämie note only for a Direktvermarktung site with an anzulegender Wert', () => {
    expect(einspeiseProvenance(makeMoney({ plantKind: 'direktvermarktung', anzulegenderWertCtKwh: 8.11 })))
      .toContain('Marktprämie');
    expect(einspeiseProvenance(makeMoney())).not.toContain('Marktprämie');
  });
  it('is null when there is no feed-in revenue', () => {
    expect(einspeiseProvenance(makeMoney({ einspeiseErloesEur: null }))).toBeNull();
  });
});

describe('eigenverbrauchProvenance (dynamic tariff, decision 1+3)', () => {
  it('dynamisch: names the spot price + Aufschlag AND the real effective average', () => {
    // 91.70 € over 820 kWh -> 11,2 ct/kWh average, computed from the two numbers.
    const t = eigenverbrauchProvenance(
      makeMoney({ tarifArt: 'dynamisch', tarifParamCtKwh: 18, eigenverbrauchsWertEur: 91.7, selbstverbrauchKwh: 820 }),
    );
    expect(t).toContain('Selbst verbrauchte 820 kWh');
    expect(t).toContain('dynamischer Börsenpreis + 18,0 ct/kWh Aufschlag');
    expect(t).toContain('im Schnitt 11,2 ct/kWh');
  });
  it('dynamisch without an Aufschlag says so (conservative)', () => {
    const t = eigenverbrauchProvenance(
      makeMoney({ tarifArt: 'dynamisch', tarifParamCtKwh: null, eigenverbrauchsWertEur: 82, selbstverbrauchKwh: 820 }),
    );
    expect(t).toContain('ohne Aufschlag');
    expect(t).not.toContain('+ ');
  });
  it('fest: names the fixed price', () => {
    const t = eigenverbrauchProvenance(
      makeMoney({ tarifArt: 'fest', tarifParamCtKwh: 32.5, eigenverbrauchsWertEur: 266.5, selbstverbrauchKwh: 820 }),
    );
    expect(t).toContain('32,5 ct/kWh');
    expect(t).toContain('fester Strompreis');
  });
  it('ohne: the honest "hinterlegen Sie Ihren Tarif" note, no fabricated euro', () => {
    const t = eigenverbrauchProvenance(makeMoney({ tarifArt: 'ohne', eigenverbrauchsWertEur: null }));
    expect(t).toContain('Technik & Einstellungen');
    expect(t).not.toContain('ct/kWh');
  });
});

describe('gesamtertrag / saved provenance', () => {
  it('gesamtertrag names its two parts with the real amounts', () => {
    const t = gesamtertragProvenance(
      makeMoney({ einspeiseErloesEur: 421.1, eigenverbrauchsWertEur: 91.7, gesamtertragEur: 512.8 }),
    );
    expect(t).toContain('Einspeise-Erlös 421,10');
    expect(t).toContain('Wert des Eigenverbrauchs 91,70');
  });
  it('saved provenance uses the plant-kind verb (gespart vs. mehr verdient)', () => {
    expect(savedProvenance(makeMoney())).toContain('gespart');
    expect(savedProvenance(makeMoney({ plantKind: 'direktvermarktung' }))).toContain('mehr verdient');
    expect(savedProvenance(makeMoney({ savedEur: null }))).toBeNull();
  });
});

describe('energyTiles (decision 4)', () => {
  it('renames the three tiles and gives each a plain-German hint', () => {
    const tiles = energyTiles(makeMoney());
    expect(tiles.map((t) => t.label)).toEqual(['Eingespeist', 'Selbst genutzt', 'Über Batterie']);
    expect(tiles.map((t) => t.hint)).toEqual([
      'ins Netz verkauft',
      'direkt im Haus verbraucht',
      'zwischengespeichert',
    ]);
    expect(tiles[2].value).toBe('1,61 MWh');
  });
  it('shows "–" instead of a fake zero when nothing is computable', () => {
    expect(energyTiles(null).map((t) => t.value)).toEqual(['–', '–', '–']);
  });
});
