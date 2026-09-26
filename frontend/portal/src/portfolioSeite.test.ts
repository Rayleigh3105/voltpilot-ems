import { describe, expect, it } from 'vitest';
import type { EarningsSite, History, HistoryBucket } from './api';
import { erloeseAggregat, type PortfolioHistoryInput } from './portfolioHistorie';
import {
  energieAnlagen,
  energieAnlagenCsv,
  energieAnlagenTabelle,
  erloeseAnlagen,
  erloeseAnlagenCsv,
  erloeseAnlagenTabelle,
  portfolioCsvName,
  portfolioGeldKennzahlen,
  portfolioSteuerung,
  verbundHistory,
} from './portfolioSeite';
import { speicherAussage } from './speicherAussage';

const nb = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

function eimer(start: string, pv: number, load: number, imp: number): HistoryBucket {
  return {
    start,
    pvKwh: pv,
    loadKwh: load,
    gridImportKwh: imp,
    gridExportKwh: 1,
    batteryChargeKwh: 2,
    batteryDischargeKwh: 1,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
  };
}

function hist(buckets: HistoryBucket[], autarkiePct: number | null = 75): History {
  return {
    range: 'month',
    from: '',
    to: '',
    bucketMinutes: 1440,
    buckets,
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: null,
      autarkiePct,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
  };
}

const EINGABEN: PortfolioHistoryInput[] = [
  { siteId: 'k', name: 'Klein', history: hist([eimer('2026-07-01T00:00:00Z', 5, 4, 1)], 75) },
  { siteId: 'g', name: 'Groß', history: hist([eimer('2026-07-01T00:00:00Z', 20, 10, 2)], 80) },
  { siteId: 'l', name: 'Leer', history: hist([]) },
  { siteId: 'f', name: 'Fehler', history: null, fehler: true },
];

describe('verbundHistory', () => {
  it('hängt die Eimer aller Anlagen hintereinander — Summen über Eimer sind Summen über Anlagen', () => {
    const v = verbundHistory(EINGABEN)!;
    expect(v.buckets).toHaveLength(2);
    expect(verbundHistory([{ siteId: 'x', name: 'x', history: null }])).toBeNull();
  });
});

describe('energieAnlagen · Erzeugung je Anlage', () => {
  it('sortiert nach Erzeugung, Balken relativ zur größten, Quote je Anlage', () => {
    const z = energieAnlagen(EINGABEN);
    expect(z.map((x) => x.name)).toEqual(['Groß', 'Klein', 'Fehler', 'Leer']);
    expect(nb(z[0].wert)).toBe('20,0 kWh');
    expect(z[0].anteilPct).toBe(100);
    expect(z[1].anteilPct).toBe(25);
    expect(nb(z[1].unter)).toBe('Verbrauch 4,0 kWh · 75 % selbst versorgt');
  });

  it('eine Quote außerhalb 0…100 % heißt nie „selbst versorgt“ — sie trägt den Satz des Bilanz-Vertrags (AP-10 E16 Nr. 5)', () => {
    const [z] = energieAnlagen([{ siteId: 'u', name: 'Unplausibel', history: hist([eimer('2026-07-01T00:00:00Z', 5, 4, 1)], -20) }]);
    expect(nb(z.unter)).toBe('Verbrauch 4,0 kWh · Messwerte passen nicht zusammen (−20 %)');
  });

  it('eine Anlage ohne Werte ist nie 0 — sie trägt ihren Grund', () => {
    const z = energieAnlagen(EINGABEN);
    const leer = z.find((x) => x.id === 'l')!;
    expect(leer.wert).toBe('—');
    expect(leer.anteilPct).toBeNull();
    expect(leer.hinweis).toBe('Keine Messwerte in diesem Zeitraum');
    expect(z.find((x) => x.id === 'f')!.hinweis).toBe('Konnte nicht geladen werden');
  });

  it('Tabelle und CSV: Summe nur über Anlagen mit Werten, Lücken bleiben leer', () => {
    const t = energieAnlagenTabelle(EINGABEN);
    expect(t.zeilen.find((z) => z.id === 'l')!.leer).toBe('keine Messwerte');
    expect(t.zeilen.find((z) => z.id === 'f')!.leer).toBe('konnte nicht geladen werden');
    expect(nb(t.summe!.zellen![0].text)).toBe('25,0 kWh');
    const csv = energieAnlagenCsv(EINGABEN).split('\r\n');
    expect(csv[0]).toBe(
      'Anlage;Erzeugung kWh;Verbrauch kWh;Netzbezug kWh;Einspeisung kWh;Speicher geladen kWh;Speicher entladen kWh',
    );
    expect(csv[1]).toBe('"Klein";5,000;4,000;1,000;1,000;2,000;1,000');
    expect(csv[3]).toBe('"Leer";;;;;;');
  });
});

function site(over: Partial<EarningsSite> & { id: string; name: string }): EarningsSite {
  return {
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: null,
    selbstverbrauchKwh: null,
    eingespeistKwh: null,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    monthlyStrip: [],
    ...over,
  };
}

// A: 10 + 20 − 5 = 25 € (actual = 5 − 10 = −5), Steuerung 2 €.
// B: 4 + 6 − 12 = −2 € (actual = 12 − 4 = 8), keine Speicherdaten.
const AGG = erloeseAggregat(
  [
    site({ id: 'a', name: 'A', einspeiseErloesEur: 10, eigenverbrauchsWertEur: 20, actualEur: -5, savedSteuerungEur: 2, savedEur: 5, selbstverbrauchKwh: 60, eingespeistKwh: 100 }),
    site({ id: 'b', name: 'B', einspeiseErloesEur: 4, eigenverbrauchsWertEur: 6, actualEur: 8, selbstverbrauchKwh: 20, eingespeistKwh: 40 }),
    site({ id: 'c', name: 'C', reason: 'no_prices' }),
  ],
  [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ],
);

describe('Portfolio-Erlöse', () => {
  it('Kennzahlen: Ergebnis aus den drei Posten, Mengen darunter', () => {
    const k = portfolioGeldKennzahlen({ aggregat: AGG, vergleich: null, vergleichVoll: null });
    expect(k.map((x) => x.id)).toEqual(['ergebnis', 'eigenverbrauch', 'einspeisung', 'netzbezug']);
    expect(nb(k[0].wert)).toBe('+ 23,00 €');
    expect(nb(k[1].unter)).toBe('80,0 kWh');
    expect(nb(k[3].wert)).toBe('− 17,00 €');
    expect(k[0].info.text).toMatch(/Summe über 2 Anlagen/);
  });

  it('VoltPilot-Steuerung: sagt, über wie viele Anlagen die Summe spricht', () => {
    const sp = speicherAussage(
      { savedEur: AGG.steuerungEur, savedSteuerungEur: AGG.steuerungEur, range: 'month' },
      { now: new Date('2026-09-20T12:00:00Z'), laeuft: false },
    );
    const s = portfolioSteuerung(sp, AGG)!;
    expect(nb(s.wert)).toBe('+ 2,00 €');
    expect(s.ton).toBe('ok');
    expect(s.unter).toBe('mehr als ohne smarte Steuerung · 1 von 2 Anlagen');
    expect(s.info.join(' ')).toMatch(/1 Anlage mit gepflegten Speicherdaten/);
    expect(portfolioSteuerung(null, AGG)).toBeNull();
  });

  it('Anlagen-Liste: Ergebnis als Balken, negatives Ergebnis als Minus, Grund statt 0', () => {
    const z = erloeseAnlagen(AGG);
    expect(z.map((x) => x.name)).toEqual(['A', 'B', 'C']);
    expect(nb(z[0].unter)).toBe('VoltPilot-Steuerung + 2,00 €');
    expect(z[1].ton).toBe('minus');
    expect(z[1].anteilPct).toBe(8);
    expect(z[1].unter).toBeNull();
    expect(z[2].wert).toBe('—');
    expect(z[2].hinweis).toBe('Noch keine Börsenpreise für den Zeitraum');
  });

  it('Tabelle und CSV: alle Posten je Anlage, Summe = Kennzahlen', () => {
    const t = erloeseAnlagenTabelle(AGG);
    expect(nb(t.zeilen[1].zellen![3].text)).toBe('− 12,00 €');
    expect(t.zeilen[1].zellen![4].text).toBe('—');
    expect(nb(t.summe!.zellen![0].text)).toBe('+ 23,00 €');
    const csv = erloeseAnlagenCsv(AGG).split('\r\n');
    expect(csv[1]).toBe('"A";25,00;20,00;10,00;-5,00;2,00');
    expect(csv[3]).toBe('"C";;;;;');
    expect(portfolioCsvName('erloese', 'month', '2026-08-15')).toBe('erloese_alle-anlagen_monat_2026-08-15.csv');
  });
});
