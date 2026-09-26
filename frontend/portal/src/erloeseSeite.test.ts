import { describe, expect, it } from 'vitest';
import type { HistoryBucket, SiteEarnings, SiteEarningsBucket } from './api';
import FIXTURES from './erloeseFixtures.json';
import {
  abrechnung,
  betrag,
  csvDateiname,
  erloesKennzahlen,
  mehrwertBand,
  geldCsv,
  geldDiagramm,
  geldTabelle,
  geldTon,
  lastspitzeKontext,
  stundenPreise,
  vergleichUnter,
} from './erloeseSeite';
import { speicherAussage } from './speicherAussage';
import type { ErloesVergleich } from './vergleichLaufend';

interface Fixture {
  id: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

const NB = ' ';
const nurText = (s: string) => s.replace(/ /g, ' ');

describe('betrag / geldTon', () => {
  it('schreibt das Vorzeichen als Zeichen und rundet kaufmännisch', () => {
    expect(nurText(betrag(12.345))).toBe('+ 12,35 €');
    expect(nurText(betrag(-1.585))).toBe('− 1,59 €');
    expect(nurText(betrag(0.004))).toBe('0,00 €');
    expect(betrag(null)).toBe('—');
    expect(betrag(Number.NaN)).toBe('—');
  });
  it('färbt erst ab einem halben Cent als Minus', () => {
    expect(geldTon(-0.004)).toBeNull();
    expect(geldTon(-0.005)).toBe('minus');
    expect(geldTon(null)).toBe('leer');
  });
});

describe('Abrechnung · Menge × Ø Preis = Betrag geht in jeder Fixture auf', () => {
  it.each(FX.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const a = abrechnung(f.money);
    expect(a.posten.map((p) => p.id)).toEqual(['eigenverbrauch', 'einspeisung', 'netzbezug']);
    for (const p of a.posten) {
      const m = /([\d.,]+)\s*kWh · Ø ([\d,]+)\s*ct\/kWh/.exec(nurText(p.unter ?? ''));
      const b = /([−+])?\s*([\d.,]+)\s*€/.exec(nurText(p.betrag));
      if (!m || !b) continue;
      const kwh = Number(m[1].replace(/\./g, '').replace(',', '.'));
      const ct = Number(m[2].replace(',', '.'));
      const eur = Number(b[2].replace(/\./g, '').replace(',', '.'));
      // Ø-Preis auf eine Stelle gerundet: die Probe hält ± 0,05 ct/kWh × Menge.
      expect(Math.abs((kwh * ct) / 100 - eur)).toBeLessThanOrEqual((kwh * 0.05) / 100 + 0.51);
    }
    // Netzbezug mindert das Ergebnis — er steht negativ, wo er einen Betrag hat.
    const nb = a.posten[2];
    if (f.money.stromkostenEur != null && f.money.stromkostenEur >= 0.005) {
      expect(nb.betrag.startsWith('−')).toBe(true);
      expect(nb.ton).toBe('minus');
    }
    expect(nurText(a.ergebnis.betrag)).toBe(nurText(betrag(f.money.nettoErgebnisEur)));
  });

  it('nennt fehlende Grundlagen mit Weg statt einer erfundenen Zahl', () => {
    const f = FX[0];
    const ohneTarif = { ...f.money, eigenverbrauchsWertEur: null } as SiteEarnings;
    const p = abrechnung(ohneTarif).posten[0];
    expect(p.betrag).toBe('—');
    expect(p.ton).toBe('leer');
    expect(p.hinweis?.link?.ziel).toBe('tarif');
  });

  it('führt die vermiedenen Leistungskosten unter dem Strich, nie im Ergebnis', () => {
    const f = FX.find((x) => x.money.peakShaving) ?? FX[0];
    const money = {
      ...f.money,
      peakShaving: {
        leistungspreisEurKw: 80,
        abrechnung: 'jahr',
        periodStart: '2026-01-01',
        peakKw: 8,
        baselinePeakKw: 11.5,
        avoidedKw: 3.5,
        avoidedEur: 280,
        history: [],
      },
    } as SiteEarnings;
    const a = abrechnung(money);
    expect(a.ausserhalb?.periode).toBe('Abrechnungsjahr 2026');
    expect(nurText(a.ausserhalb!.betrag)).toBe('+ 280,00 €');
    expect(nurText(a.ergebnis.betrag)).toBe(nurText(betrag(money.nettoErgebnisEur)));
    const k = lastspitzeKontext(money)!;
    expect(nurText(k.rechnung!)).toBe('3,5 kW × 80,00 €/kW');
    expect(Math.round(k.anteilPct!)).toBe(70);
  });
});

describe('Kennzahlen', () => {
  const f = FX[0];
  it('Ergebnis zuerst, Kosten negativ, Mengen als Unterzeile', () => {
    const k = erloesKennzahlen({ money: f.money, vergleich: null, vergleichVoll: null });
    expect(k.map((x) => x.id)).toEqual(['ergebnis', 'eigenverbrauch', 'einspeisung', 'netzbezug']);
    expect(k[3].wert.startsWith('−') || k[3].wert === `0,00${NB}€`).toBe(true);
    expect(k[1].unter).toMatch(/kWh$/);
  });

  it('führt die Steuerung weder als Kennzahl noch in der Abrechnung', () => {
    const money = { ...f.money, savedEur: 5, savedSpeicherEur: 3.2, savedSteuerungEur: 1.8 } as SiteEarnings;
    const k = erloesKennzahlen({ money, vergleich: null, vergleichVoll: null });
    expect(k.map((x) => x.id)).toEqual(['ergebnis', 'eigenverbrauch', 'einspeisung', 'netzbezug']);
    expect(Object.keys(abrechnung(money))).not.toContain('steuerung');
  });

  it('ohne Ergebnis steht der Grund, nicht „0,00 €"', () => {
    const money = { ...f.money, nettoErgebnisEur: null, reason: 'no_prices' } as SiteEarnings;
    const k = erloesKennzahlen({ money, vergleich: null, vergleichVoll: null });
    expect(k[0].wert).toBe('—');
    expect(k[0].ton).toBe('leer');
    expect(k[0].unter).toMatch(/Börsenpreise/);
  });
});

describe('mehrwertBand · die Kachel „VoltPilot-Steuerung"', () => {
  const f = FX[0];
  const jetzt = new Date('2026-09-20T12:00:00Z');
  const mit = (over: Partial<SiteEarnings>) => ({ ...f.money, savedEur: 5, savedSpeicherEur: 3.2, ...over }) as SiteEarnings;

  it('abgeschlossen und positiv: Betrag und Unterzeile lesen sich als ein Satz', () => {
    const b = mehrwertBand(speicherAussage(mit({ savedSteuerungEur: 1.8 }), { now: jetzt, laeuft: false }), 'month')!;
    expect(b.label).toBe('VoltPilot-Steuerung');
    expect(nurText(b.wert)).toBe('+ 1,80 €');
    expect(b.ton).toBe('ok');
    expect(b.unter).toBe('mehr als ohne smarte Steuerung');
    expect(b.info.join(' ')).toMatch(/lädt jeden Überschuss sofort/);
    expect(b.info.join(' ')).not.toMatch(/Einzelne Tage/);
    // Nie die Admin-Zahl gegen „ohne Speicher".
    expect(JSON.stringify(b)).not.toMatch(/5,00|3,20/);
  });

  it('laufender Tag: „bisher", neutral, mit dem Hinweis auf gespeicherte Energie im ⓘ', () => {
    const b = mehrwertBand(speicherAussage(mit({ savedSpeicherEur: 5.4, savedSteuerungEur: -0.4 }), { now: jetzt, laeuft: true }), 'day')!;
    expect(nurText(b.wert)).toBe('− 0,40 €');
    expect(b.ton).toBe('neutral');
    expect(b.unter).toBe('bisher weniger als ohne smarte Steuerung');
    expect(b.info.join(' ')).toMatch(/Einzelne Tage schwanken/);
  });

  it('ohne Speicherdaten: „—" und der Nachtrag-Weg, nie eine 0', () => {
    const b = mehrwertBand(
      speicherAussage(mit({ savedSpeicherEur: null, savedSteuerungEur: null, steuerungSplitReason: 'no_battery_data' }), {
        now: jetzt,
        laeuft: false,
      }),
      'month',
    )!;
    expect(b.wert).toBe('—');
    expect(b.ton).toBe('leer');
    expect(b.unter).toBe('Speicherdaten fehlen');
    expect(b.nachtrag).toBe(true);
  });

  it('älteres Backend ohne Felder: keine Kachel', () => {
    const money = { ...f.money, savedEur: 5 } as SiteEarnings;
    delete (money as Partial<SiteEarnings>).savedSteuerungEur;
    delete (money as Partial<SiteEarnings>).steuerungSplitReason;
    expect(mehrwertBand(speicherAussage(money, { now: jetzt, laeuft: false }), 'month')).toBeNull();
  });
});

describe('vergleichUnter · Wertung nur, wo sie ehrlich ist', () => {
  const basis: ErloesVergleich = {
    modus: 'ganze_periode',
    chip: { richtung: 'mehr', wertung: 'gut', pct: 18, text: '18 % mehr als im Juli', titel: '' },
    betraege: null,
    satz: null,
    bisStunde: null,
    jetztEur: 118,
    vorherEur: 100,
  };
  it('abgeschlossen: Prozent mit Richtung', () => {
    expect(vergleichUnter(basis, null)).toEqual({ text: '18 % mehr als im Juli', pfeil: '↑' });
  });
  it('laufender Tag: gleiche Stunde', () => {
    const v = { ...basis, modus: 'gleicher_zeitpunkt' as const, bisStunde: 12, chip: { ...basis.chip!, richtung: 'weniger' as const, text: '25 % weniger' } };
    expect(vergleichUnter(v, null)).toEqual({ text: '25 % weniger als gestern bis 12 Uhr', pfeil: '↓' });
  });
  it('laufender Monat: nur der Betrag der ganzen Vergleichsperiode, kein Prozent', () => {
    const v = { ...basis, modus: 'nur_betraege' as const, chip: null };
    const u = vergleichUnter(v, 'ganzer August')!;
    expect(nurText(u.text)).toBe('ganzer August: + 100,00 €');
    expect(u.text).not.toMatch(/%/);
    expect(u.pfeil).toBeNull();
  });
});

describe('geldDiagramm', () => {
  const b = (start: Date, netto: number): SiteEarningsBucket => ({
    start: start.toISOString(),
    einspeiseErloesEur: 1,
    eigenverbrauchsWertEur: netto,
    stromkostenEur: 1,
    nettoEur: netto,
  });
  const money = (series: SiteEarningsBucket[]) =>
    ({ ...FX[0].money, series, firstCoveredDate: '2026-08-02' }) as SiteEarnings;

  it('legt den ganzen Monat an, markiert Lücke, Zukunft und die Zeit vor der ersten Messung', () => {
    const series = [b(new Date(2026, 8, 2), 2), b(new Date(2026, 8, 3), 3), b(new Date(2026, 8, 5), 1)];
    const m = { ...money(series), firstCoveredDate: '2026-09-02' } as SiteEarnings;
    const d = geldDiagramm({ money: m, anchor: new Date(2026, 8, 15, 12), range: 'month', now: new Date(2026, 8, 6, 12) });
    expect(d.achse).toHaveLength(30);
    expect(d.netto.slice(0, 5)).toEqual([null, 2, 3, null, 1]);
    // Kosten stehen negativ.
    expect(d.kosten[1]).toBe(-1);
    // Summe seit Beginn: Lücke hält den Stand, Zukunft endet.
    // Der laufende Tag (6.) trägt den Stand bis jetzt, danach endet die Linie.
    expect(d.kumuliert.slice(0, 7)).toEqual([null, 2, 5, 5, 6, 6, null]);
    expect(d.baender).toEqual([
      { von: 0, bis: 0, art: 'vorher' },
      { von: 3, bis: 3, art: 'luecke' },
      { von: 6, bis: 29, art: 'zukunft' },
    ]);
    expect(d.drill).toBe('tag');
    expect(d.leer).toBe(false);
  });

  it('richtet den Vergleich nach Position aus', () => {
    const series = [b(new Date(2026, 7, 1), 2)];
    const vorher = money([b(new Date(2026, 6, 1), 4), b(new Date(2026, 6, 2), 1)]);
    const d = geldDiagramm({
      money: money(series),
      anchor: new Date(2026, 7, 15, 12),
      range: 'month',
      now: new Date(2026, 8, 10),
      vorher,
      vorherAnker: new Date(2026, 6, 15, 12),
    });
    expect(d.vergleichNetto!.slice(0, 3)).toEqual([4, 1, null]);
    expect(d.vergleichKumuliert!.slice(0, 3)).toEqual([4, 5, 5]);
  });

  it('Tabelle: Lücken als „keine Messwerte", Summe aus der Antwort', () => {
    const series = [b(new Date(2026, 8, 7), 2), b(new Date(2026, 8, 9), 1)];
    const m = money(series);
    const d = geldDiagramm({ money: m, anchor: new Date(2026, 8, 9, 12), range: 'week', now: new Date(2026, 8, 10, 12) });
    const t = geldTabelle(d, m);
    expect(t.zeilen.map((z) => z.kopf)).toEqual(['Mo., 07.09.', 'Di., 08.09.', 'Mi., 09.09.', 'Do., 10.09. · läuft']);
    expect(t.zeilen[1].zellen).toBeNull();
    expect(t.zeilen[1].leer).toBe('keine Messwerte');
    expect(t.zeilen[3].leer).toBe('noch keine Werte');
    expect(t.summe?.kopf).toBe('Summe');
    const csv = geldCsv(d, m).split('\r\n');
    expect(csv[0]).toBe('Beginn;Zeitraum;Eigenverbrauch EUR;Einspeisung EUR;Netzbezug EUR;Ergebnis EUR');
    expect(csv[1]).toBe('2026-09-07T00:00;"Mo., 07.09.";2,00;1,00;-1,00;2,00');
    expect(csv[2]).toBe('2026-09-08T00:00;"Di., 08.09.";;;;');
  });
});

describe('stundenPreise', () => {
  it('mittelt die Viertelstunden je Stunde und lässt fehlende Stunden leer', () => {
    const h = (hh: number, mm: number, p: number | null): HistoryBucket =>
      ({ start: new Date(2026, 8, 9, hh, mm).toISOString(), priceEurMwh: p }) as HistoryBucket;
    const d = geldDiagramm({ money: null, anchor: new Date(2026, 8, 9, 12), range: 'day', now: new Date(2026, 8, 10) });
    const p = stundenPreise([h(0, 0, 100), h(0, 15, 120), h(0, 30, 80), h(0, 45, 100), h(1, 0, null)], d.zellen);
    expect(p).toHaveLength(24);
    expect(p[0]).toBe(10);
    expect(p[1]).toBeNull();
  });
});

describe('csvDateiname', () => {
  it('bleibt ASCII', () => {
    expect(csvDateiname('erloese', 'Sonnenhof Süd', 'month', '2026-08-15')).toBe('erloese_sonnenhof-sued_monat_2026-08-15.csv');
    expect(csvDateiname('energie', '', 'day', '2026-09-09')).toBe('energie_anlage_tag_2026-09-09.csv');
  });
});
