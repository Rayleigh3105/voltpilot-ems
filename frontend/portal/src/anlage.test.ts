import { describe, expect, it } from 'vitest';
import { coveredSinceLabel, DEFAULT_EARNINGS_RANGE } from './anlage';
import type { EarningsMonth, EarningsSeriesPoint, EarningsSite, Site } from './api';
import { NBSP } from './format';
import {
  bestBucket,
  bestBucketText,
  buildSitePayload,
  bucketAxisLabel,
  eigenverbrauchProvenance,
  einspeiseProvenance,
  energyLabel,
  energyTiles,
  ertragTitle,
  expectedMarketValueLine,
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
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
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

describe('DEFAULT_EARNINGS_RANGE', () => {
  it('ist „Heute" - die EINE Voreinstellung des Zeitraum-Umschalters', () => {
    // Captain 2026-07-30: „immer auf heute standardmäßig stellen statt Monat".
    // Cockpit-Bilanz-Leiste und Flotten-Übersicht lesen dieselbe Konstante.
    expect(DEFAULT_EARNINGS_RANGE).toBe('day');
    const now = new Date('2026-07-30T10:00:00Z');
    expect(periodLabel(DEFAULT_EARNINGS_RANGE, now, now)).toBe('Heute');
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

  // ⚠ A1 (audit vp-review-eeg-r1): an EEG plant values its feed-in at the feste
  // Vergütung, not at spot - the report's `alt` plant: 1,5 kWh × 8,11 ct =
  // 0,12165 €, so the effective rate is 8,11 ct, NOT the spot 5,0 ct.
  it('A1 · EEG plant: names the feste Einspeisevergütung with its effective ct-rate, never Börsenpreis', () => {
    const t = einspeiseProvenance(
      makeMoney({
        plantKind: 'eigenverbrauch',
        exportVerguetungPriced: true,
        einspeiseErloesEur: 0.12165,
        eingespeistKwh: 1.5,
        realizedExportCtKwh: 5.0,
      }),
    );
    expect(t).toContain(`Eingespeiste 1,5${NBSP}kWh`);
    expect(t).toContain('Ø 8,1 ct/kWh');
    expect(t).toContain('feste Einspeisevergütung');
    expect(t).not.toContain('Börsenpreis');
    // NICHT die falsche Spot-Nachrechnung 1,5 kWh × 5,0 ct = 0,075 €.
    expect(t).not.toContain('5,0 ct/kWh');
  });

  it('A1 · EEG plant without fed-in kWh: honest sentence at feste Vergütung, no fabricated rate', () => {
    const t = einspeiseProvenance(
      makeMoney({
        plantKind: 'eigenverbrauch',
        exportVerguetungPriced: true,
        einspeiseErloesEur: 12.3,
        eingespeistKwh: null,
      }),
    );
    expect(t).toBe(
      'Erlös aus dem ins Netz eingespeisten Solarstrom, bewertet zu Ihrer festen Einspeisevergütung.',
    );
  });

  it('A1 · without the flag it is byte-identical to before (Börsenpreis), incl. Direktvermarktung', () => {
    // Flag missing → conservative Börsenpreis wording (unchanged).
    expect(einspeiseProvenance(makeMoney())).toContain('Börsenpreis Ihrer Einspeise-Zeiten');
    // Direktvermarktung is never exportVerguetungPriced → stays spot + Marktprämie.
    const dv = einspeiseProvenance(
      makeMoney({ plantKind: 'direktvermarktung', anzulegenderWertCtKwh: 8.11 }),
    );
    expect(dv).toContain('Börsenpreis Ihrer Einspeise-Zeiten');
    expect(dv).toContain('Marktprämie');
    expect(dv).not.toContain('feste Einspeisevergütung');
  });
});

describe('eigenverbrauchProvenance (E7: ONE Bezugspreis je Karte)', () => {
  it('tariff-priced: names the Bezugspreis AND the real effective average, no formula', () => {
    // 91.70 EUR over 820 kWh -> 11,2 ct/kWh average, computed from the two numbers.
    const t = eigenverbrauchProvenance(
      makeMoney({
        tarifArt: 'dynamisch',
        tarifParamCtKwh: 18,
        tarifPriced: true,
        eigenverbrauchsWertEur: 91.7,
        selbstverbrauchKwh: 820,
      }),
    );
    expect(t).toContain('Selbst verbrauchte 820 kWh');
    expect(t).toContain('Ihr Bezugspreis');
    expect(t).toContain('im Schnitt 11,2 ct/kWh');
    // Since E7 a Preisblatt can compose the price, so naming "Boersenpreis +
    // 18 ct Aufschlag" would be a formula the portal cannot verify.
    expect(t).not.toContain('Aufschlag');
  });
  it('ohne Tarif-Bewertung: says Boersenpreis and names the way to the tariff', () => {
    const t = eigenverbrauchProvenance(
      makeMoney({
        tarifArt: 'ohne',
        tarifParamCtKwh: null,
        tarifPriced: false,
        eigenverbrauchsWertEur: 82,
        selbstverbrauchKwh: 820,
      }),
    );
    expect(t).toContain('Börsenpreis');
    expect(t).toContain('im Schnitt 10,0 ct/kWh');
    // D2 (Captain, 31.07.2026): die Seite heißt „Einstellungen“ — und seit E1
    // steht der Stromtarif dort auch wirklich, der Verweis führt also irgendwohin.
    expect(t).toContain('Einstellungen');
  });
  it('fest: names the fixed price', () => {
    const t = eigenverbrauchProvenance(
      makeMoney({ tarifArt: 'fest', tarifParamCtKwh: 32.5, eigenverbrauchsWertEur: 266.5, selbstverbrauchKwh: 820 }),
    );
    expect(t).toContain('32,5 ct/kWh');
    expect(t).toContain('fester Strompreis');
  });
  it('no euro value at all: says so, never promises a tariff would produce one', () => {
    const t = eigenverbrauchProvenance(makeMoney({ tarifArt: 'ohne', eigenverbrauchsWertEur: null }));
    expect(t).toContain('kein Euro-Wert');
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
  it('saved provenance names the tariff valuation exactly when it applies (Stufe 3)', () => {
    // tarifPriced = the backend really valued avoided import at the tariff.
    expect(savedProvenance(makeMoney({ tarifPriced: true }))).toContain(
      'zu Ihrem Stromtarif bewertet',
    );
    // Without the flag (bare-spot site or older backend) no tariff is claimed.
    expect(savedProvenance(makeMoney())).not.toContain('Stromtarif');
    expect(savedProvenance(makeMoney({ tarifPriced: false }))).not.toContain('Stromtarif');
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

describe('expectedMarketValueLine (forward Marktwert Solar, captain 2026-07-09)', () => {
  const NBSP = ' ';

  it('formats the ct/kWh value and derives the horizon from the covered window', () => {
    const line = expectedMarketValueLine(
      makeMoney({
        expectedMarketValueSolarCtKwh: 15.1111,
        // first slot start -> last slot start; +15 min for the last slot span.
        expectedMarketValueFrom: '2026-07-09T08:00:00Z',
        expectedMarketValueTo: '2026-07-10T07:45:00Z',
        expectedMarketValueSlots: 96,
      }),
    );
    expect(line).not.toBeNull();
    expect(line!.value).toBe(`15,1${NBSP}ct/kWh`);
    // 23:45 span + 0:15 last slot = 24 h.
    expect(line!.horizon).toBe(`nächste 24${NBSP}h`);
    expect(line!.info).toContain('PV-Prognose');
    expect(line!.info).toContain('Day-Ahead');
  });

  it('rounds a short horizon and never claims less than an hour', () => {
    const line = expectedMarketValueLine(
      makeMoney({
        expectedMarketValueSolarCtKwh: 7.2,
        expectedMarketValueFrom: '2026-07-09T08:00:00Z',
        expectedMarketValueTo: '2026-07-09T11:00:00Z',
        expectedMarketValueSlots: 13,
      }),
    );
    expect(line!.horizon).toBe(`nächste 3${NBSP}h`);
  });

  it('falls back to "kommende Stunden" when the bounds are missing', () => {
    const line = expectedMarketValueLine(
      makeMoney({ expectedMarketValueSolarCtKwh: 9.9, expectedMarketValueFrom: null, expectedMarketValueTo: null }),
    );
    expect(line!.horizon).toBe('kommende Stunden');
  });

  it('is hidden (null) when there is no forward figure - never a fake 0', () => {
    expect(expectedMarketValueLine(makeMoney({ expectedMarketValueSolarCtKwh: null }))).toBeNull();
  });

  it('includes a negative expected value honestly (negative prices pull it down)', () => {
    const line = expectedMarketValueLine(
      makeMoney({
        expectedMarketValueSolarCtKwh: -1.4,
        expectedMarketValueFrom: '2026-07-09T08:00:00Z',
        expectedMarketValueTo: '2026-07-09T14:00:00Z',
        expectedMarketValueSlots: 25,
      }),
    );
    expect(line!.value).toBe(`-1,4${NBSP}ct/kWh`);
  });
});

describe('buildSitePayload (v3.1-M3 full-representation guard)', () => {
  const fullSite: Site = {
    id: 's-1',
    name: 'Solarpark Dachau',
    biddingZone: 'DE-LU',
    latitude: 48.26,
    longitude: 11.43,
    plantKind: 'direktvermarktung',
    anzulegenderWertCtKwh: 8.11,
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    netzladenErlaubt: true,
    maxFeedInKw: 75,
  };

  it('carries EVERY site field through unchanged when overriding a single one', () => {
    // The move split the site's fields across two edit surfaces (mode containers
    // vs. the general Technik page). Both go through here, so a focused save of
    // one field can never blank the others - the load-bearing regression guard.
    expect(buildSitePayload(fullSite, { netzladenErlaubt: false })).toEqual({
      name: 'Solarpark Dachau',
      biddingZone: 'DE-LU',
      latitude: 48.26,
      longitude: 11.43,
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      netzladenErlaubt: false,
      maxFeedInKw: 75,
    });
  });

  it('a Technik-side override (name/maxFeedIn) keeps the moved money fields', () => {
    const payload = buildSitePayload(fullSite, { name: 'Neu', maxFeedInKw: 100 });
    expect(payload.name).toBe('Neu');
    expect(payload.maxFeedInKw).toBe(100);
    // The mode-container-owned fields are untouched.
    expect(payload.netzladenErlaubt).toBe(true);
    expect(payload.anzulegenderWertCtKwh).toBe(8.11);
    expect(payload.tarifArt).toBe('dynamisch');
    expect(payload.tarifParamCtKwh).toBe(18);
  });

  it('a container-side override (tariff) keeps the Technik fields', () => {
    const payload = buildSitePayload(fullSite, { tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    expect(payload.tarifArt).toBe('fest');
    expect(payload.tarifParamCtKwh).toBe(32.5);
    expect(payload.name).toBe('Solarpark Dachau');
    expect(payload.maxFeedInKw).toBe(75);
    expect(payload.plantKind).toBe('direktvermarktung');
  });
});


describe('coveredSinceLabel — V4: name the covered range on „Gesamt"', () => {
  it('turns the first covered day into a caption', () => {
    expect(coveredSinceLabel('2026-07-03')).toBe('seit 3. Juli 2026');
  });

  it('stays null without a known start — never an invented date', () => {
    expect(coveredSinceLabel(null)).toBeNull();
    expect(coveredSinceLabel(undefined)).toBeNull();
    expect(coveredSinceLabel('   ')).toBeNull();
    expect(coveredSinceLabel('nonsense')).toBeNull();
  });
});
