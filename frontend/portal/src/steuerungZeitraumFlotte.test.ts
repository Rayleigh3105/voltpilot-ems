import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Earnings, EarningsDaily, EarningsSite, Overview, OverviewSite } from './api';
import { cockpitHero } from './cockpitWidgets';
import { anlagenZeilen, leistenZellen, portfolioKennzahlen } from './portfolioCockpit';
import { erloeseAggregat } from './portfolioHistorie';
import { portfolioSteuerungMonat } from './portfolioSeite';
import { flotteMitBestand, tagPlus } from './steuerungZeitraum';
import VEKTOREN from './speicherAussage.vektoren.json';

/**
 * **Überall dieselbe Zählweise** (Bedienkonzept `vp-herzogau-p3-kachel-konzept`,
 * Captain 14.10.2026 P3-4 A): Übersicht (Kachel „Mehrerlös“, Spalte,
 * Kunden-Übersicht), Anlagen-Cockpit und „Erlöse aller Anlagen“ zeigen die
 * Steuerung mit Bestand — vorn der Monat, daneben die letzten 7 Tage, nie die
 * Tageszahl vorn. Die Tageswerte kommen aus dem Vertrag
 * (`docs/contracts/steuerung-tag-vectors.json`, Block `mit_bestand`), so wie die
 * Mandanten-Route sie als `dailySaved[].mitBestandEur` liefert.
 */
const OKT = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), '../../docs/contracts/steuerung-tag-vectors.json'), 'utf8'),
  ) as {
    mit_bestand: {
      oktober: { tage: { tag: string; steuerung_eur: number; erwartet: { mit_bestand_eur: number } }[] };
    };
  }
).mit_bestand.oktober;

const nb = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

/** Die 14-Tage-Reihe der Mandanten-Route bis `heute` (ohne heute, wenn `heuteEur` null ist). */
function reihe(heute: string, heuteEur: number | null): EarningsDaily[] {
  const tage: EarningsDaily[] = OKT.tage
    .filter((t) => t.tag < heute && t.tag >= tagPlus(heute, -13))
    .map((t) => ({ day: t.tag, savedEur: 0, savedSteuerungEur: t.steuerung_eur, mitBestandEur: t.erwartet.mit_bestand_eur }));
  if (heuteEur != null) tage.push({ day: heute, savedEur: 0, savedSteuerungEur: -8, mitBestandEur: heuteEur });
  return tage;
}

const HERZOGAU_OV = {
  id: 'herzogau',
  name: 'Pilsting / Herzogau',
  plantKind: 'direktvermarktung',
  netzladenErlaubt: false,
  batteryWithoutDevice: false,
  deviceCount: 3,
  onlineCount: 3,
  waitingCount: 0,
  worstStatus: 'online',
  lastSeenAt: '2026-10-13T06:19:00Z',
  live: { ts: '2026-10-13T06:19:00Z', pvKw: 0, loadKw: 9, gridKw: 9, socPct: 5 },
  plannedSavingsTodayEur: null,
} as unknown as OverviewSite;
const MIENBACH_OV = { ...HERZOGAU_OV, id: 'mienbach', name: 'Mienbach', plantKind: 'eigenverbrauch' } as unknown as OverviewSite;
const OVERVIEW = { sites: [MIENBACH_OV, HERZOGAU_OV], totals: {}, dailySavings: [] } as unknown as Overview;

function herzogau(heute: string, monat: number, heuteEur: number | null): EarningsSite {
  return {
    id: 'herzogau',
    name: 'Pilsting / Herzogau',
    plantKind: 'direktvermarktung',
    savedEur: -0.22,
    savedSpeicherEur: 7.78,
    savedSteuerungEur: -8,
    savedSteuerungMitBestandEur: heuteEur,
    steuerungMonatMitBestandEur: monat,
    reason: null,
    dailySaved: reihe(heute, heuteEur),
  } as unknown as EarningsSite;
}
const MIENBACH_E = {
  id: 'mienbach',
  name: 'Mienbach',
  plantKind: 'eigenverbrauch',
  savedEur: null,
  savedSteuerungEur: null,
  savedSteuerungMitBestandEur: null,
  steuerungMonatMitBestandEur: null,
  reason: 'no_data',
  dailySaved: [],
} as unknown as EarningsSite;

function earnings(site: EarningsSite): Earnings {
  return { range: 'day', from: null, to: null, sites: [MIENBACH_E, site], totals: {} } as unknown as Earnings;
}

describe('Übersicht · „Mehrerlös diesen Monat“ (P3-4 A)', () => {
  it('13.10., 08:20: + 25,86 € vorn, eingeordnet durch letzte 7 Tage + 9,45 € und heute + 0,01 €', () => {
    const jetzt = new Date('2026-10-13T08:20:00+02:00');
    const k = portfolioKennzahlen(OVERVIEW, earnings(herzogau('2026-10-13', 25.86, 0.01)), jetzt);
    expect(k.geldMitBestand).toBe(true);
    const zelle = leistenZellen({ order: ['erloese'], kennzahlen: k, anlagen: 2, tonalitaet: 'direktvermarktung' })[0];
    expect(zelle.label).toBe('Mehrerlös diesen Monat');
    expect(zelle.wert).toBe('+25,86');
    expect(nb(zelle.einordnung)).toBe('letzte 7 Tage + 9,45 € · heute + 0,01 €');
    expect(zelle.unterzeile).toBe('gegenüber Speicher ohne Steuerung · Bestand mitgezählt · 1 von 2 Anlagen');
    // Die Tageszahl der Kassenrechnung (− 8,00 €) steht nirgends.
    expect(JSON.stringify(zelle)).not.toMatch(/8,00/);
  });

  it('14.10., vor dem ersten Eimer: die 7 Tage 7.–13.10. ehrlich bei − 0,29 €', () => {
    const jetzt = new Date('2026-10-14T00:10:00+02:00');
    const site = { ...herzogau('2026-10-14', 23.53, null) };
    site.dailySaved = [
      ...reihe('2026-10-14', null),
    ];
    const k = portfolioKennzahlen(OVERVIEW, earnings(site), jetzt);
    expect(k.erloesMonatEur).toBe(23.53);
    expect(nb(k.erloesMonatEinordnung)).toBe('letzte 7 Tage − 0,29 €');
  });

  it('die Spalte heißt „Monat“ und trägt den Monat mit Bestand je Anlage', () => {
    const zeilen = anlagenZeilen({
      overview: OVERVIEW,
      earnings: earnings(herzogau('2026-10-13', 25.86, 0.01)),
      dichte: 'komfortabel',
      now: new Date('2026-10-13T08:20:00+02:00'),
    });
    expect(zeilen.find((z) => z.id === 'herzogau')!.monatEur).toBe(25.86);
    expect(zeilen.find((z) => z.id === 'mienbach')!.monatEur).toBeNull();
  });

  it('eine Lücke in den 7 Tagen leert die Zeile „letzte 7 Tage“, nie eine Teilsumme', () => {
    const site = herzogau('2026-10-13', 25.86, 0.01);
    site.dailySaved = site.dailySaved.map((d) => (d.day === '2026-10-09' ? { ...d, mitBestandEur: null } : d));
    const f = flotteMitBestand([site], '2026-10-13');
    expect(f.siebenEur).toBeNull();
    expect(f.monatEur).toBe(25.86);
  });

  it('Kunden-Übersicht: „VoltPilot-Steuerung“ zeigt den Monat und darunter die 7 Tage', () => {
    const f = flotteMitBestand([MIENBACH_E, herzogau('2026-10-13', 25.86, 0.01)], '2026-10-13');
    const s = portfolioSteuerungMonat(f, 2)!;
    expect(nb(s.wert)).toBe('+ 25,86 €');
    expect(s.ton).toBe('neutral');
    expect(nb(s.unter)).toBe('diesen Monat · mehr als ohne smarte Steuerung · letzte 7 Tage + 9,45 € · 1 von 2 Anlagen');
  });

  it('ein älteres Backend (Felder fehlen) behält die Tageszahl — keine erfundene Monatszahl', () => {
    const alt = { ...herzogau('2026-10-13', 25.86, 0.01) } as Partial<EarningsSite>;
    delete alt.steuerungMonatMitBestandEur;
    const f = flotteMitBestand([alt as EarningsSite], '2026-10-13');
    expect(f.mitBestand).toBe(false);
    expect(portfolioSteuerungMonat(f, 1)).toBeNull();
  });
});

describe('Erlöse aller Anlagen · eine Zählweise je Zeitraum (P3-2 A, P3-4 A)', () => {
  it('die Summe der Steuerung zählt mit Bestand; eine Lücke (null) ist nie die Kasse', () => {
    const a = { ...herzogau('2026-10-13', 25.86, 0.01), savedSteuerungEur: 29.37, savedSteuerungMitBestandEur: 23.53, nettoErgebnisEur: 100, series: [], coveredSlots: 96 } as unknown as EarningsSite;
    const b = { ...a, id: 'b', name: 'B', savedSteuerungEur: 5, savedSteuerungMitBestandEur: null } as unknown as EarningsSite;
    const agg = erloeseAggregat([a, b]);
    expect(agg.steuerungEur).toBeCloseTo(23.53, 6);
    expect(agg.steuerungAnlagen).toBe(1);
  });
});

describe('Anlagen-Cockpit · Kachel „Unterm Strich“ (P3-4 A)', () => {
  const money = (
    VEKTOREN as unknown as { faelle: { name: string; money: Record<string, unknown> }[] }
  ).faelle.find((f) => f.name.startsWith('Oktober Herzogau mit Bestand · Di 13.10., 08:15'))!.money;

  it('„Steuerung diesen Monat + 25,86 €“ statt „Zwischenstand Steuerung − 8,00 €“', () => {
    const hero = cockpitHero({
      money: { ...money, nettoErgebnisEur: -8.22 } as never,
      range: 'day',
      now: new Date('2026-10-13T08:20:00+02:00'),
    });
    expect(nb(hero.money?.attribution)).toBe('Steuerung diesen Monat + 25,86 €');
    expect(nb(hero.money?.attributionZweit)).toBe('letzte 7 Tage + 9,45 € · heute bis 08:15 + 0,01 €');
    expect(hero.money?.attributionInterim).toBe(true);
    expect(nb(hero.money?.attribution)).not.toContain('8,00');
    expect(hero.money?.zeitraumKarte?.tag.label).toBe('Heute bis 08:15');
  });
});
