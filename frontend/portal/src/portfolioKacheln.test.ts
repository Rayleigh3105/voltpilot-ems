import { describe, expect, it } from 'vitest';
import { portfolioKacheln } from './portfolioKacheln';
import type { PortfolioKpi } from './api';

function kpi(over: Partial<PortfolioKpi> = {}): PortfolioKpi {
  return {
    periode: { von: '2026-09-01', bis: '2026-09-30', jahr: 2026, monat: 9 },
    verbrauch: { kwh: 199500, kwh_vorjahr: 207000, vollstaendig: true },
    kosten: { eur: 48000, eur_vorjahr: 47000, tarif_hinterlegt: true },
    lastspitze: { kw: 412, vereinbart_kw: 550, anteil_prozent: 75, anlage: 'Werk Ahrenberg – Halle 1' },
    leit: {
      kennzeichen: 'KZ-0004',
      name: 'Stromeinsatz Spritzguss je kg',
      wert: 0.2837,
      einheit: 'kWh/kg',
      jahr: 2026,
      monat: 9,
      zustand: 'vollständig',
      ziel_prozent: 5,
      zielperiode: '2028-01/2028-12',
      ziel_wortlaut: '5 % unter Bezugsbasis',
      trend_prozent: -3.4,
      urteil: 'besser',
    },
    ...over,
  };
}

describe('portfolioKacheln', () => {
  it('formatiert die vier Kacheln mit Vergleich (de-DE, AP-08)', () => {
    const r = portfolioKacheln(kpi());
    expect(r.periodeWort).toBe('September 2026');

    expect(r.verbrauch).toMatchObject({ wert: '199.500', einheit: 'kWh', leer: false });
    // 199.500 ggü. 207.000 = −3,6 % → runter, gerundet 4 %
    expect(r.verbrauch.trend).toMatchObject({ richtung: 'runter', prozent: '4', bezug: 'ggü. Vorjahr' });

    expect(r.kosten).toMatchObject({ wert: '48.000', einheit: '€', leer: false });
    expect(r.kosten.trend).toMatchObject({ richtung: 'rauf', prozent: '2' });

    expect(r.lastspitze).toMatchObject({ wert: '412', einheit: 'kW', leer: false, fuellProzent: 75 });
    expect(r.lastspitze.satz).toBe('von 550 kW vereinbart');

    expect(r.leit).toMatchObject({ kennzeichen: 'KZ-0004', wert: '0,28', einheit: 'kWh/kg', leer: false });
    expect(r.leit?.ziel).toBe('Ziel: 5 % unter Bezugsbasis');
    expect(r.leit?.stand).toBe('Stand September 2026');
    expect(r.leit?.urteil).toMatchObject({ wort: 'besser als die Bezugsbasis', ton: 'ok' });
    expect(r.leit?.trend).toMatchObject({ richtung: 'runter', prozent: '3', bezug: 'ggü. Vormonat' });
  });

  it('fehlende Werte stehen als „–" ohne Einheit mit ehrlichem Satz (nie 0)', () => {
    const r = portfolioKacheln(
      kpi({
        verbrauch: { kwh: null, kwh_vorjahr: null, vollstaendig: true },
        kosten: { eur: null, eur_vorjahr: null, tarif_hinterlegt: false },
        lastspitze: { kw: null, vereinbart_kw: null, anteil_prozent: null, anlage: null },
        leit: null,
      }),
    );
    expect(r.verbrauch).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null });
    expect(r.kosten).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'kein Tarif hinterlegt', trend: null });
    expect(r.lastspitze).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'keine Lastdaten im Zeitraum', fuellProzent: null });
    expect(r.leit).toBeNull();
  });

  it('kein Tarif → keine Kosten, aber der Verbrauch bleibt sichtbar', () => {
    const r = portfolioKacheln(kpi({ kosten: { eur: null, eur_vorjahr: null, tarif_hinterlegt: false } }));
    expect(r.verbrauch.wert).toBe('199.500');
    expect(r.kosten.leer).toBe(true);
    expect(r.kosten.satz).toBe('kein Tarif hinterlegt');
  });

  it('unter einem halben Prozent zeigt keinen Pfeil (keine Scheingenauigkeit)', () => {
    const r = portfolioKacheln(kpi({ verbrauch: { kwh: 100000, kwh_vorjahr: 100200, vollstaendig: true } }));
    expect(r.verbrauch.trend).toBeNull();
  });

  it('kein Vorjahr → kein Vergleich, aber der Wert steht', () => {
    const r = portfolioKacheln(kpi({ verbrauch: { kwh: 199500, kwh_vorjahr: null, vollstaendig: true } }));
    expect(r.verbrauch.wert).toBe('199.500');
    expect(r.verbrauch.trend).toBeNull();
  });

  it('Lastspitze ohne vereinbarte Leistung nennt die gemessene Spitze', () => {
    const r = portfolioKacheln(
      kpi({ lastspitze: { kw: 300, vereinbart_kw: null, anteil_prozent: null, anlage: 'A' } }),
    );
    expect(r.lastspitze.wert).toBe('300');
    expect(r.lastspitze.satz).toBe('gemessene Spitze');
    expect(r.lastspitze.fuellProzent).toBeNull();
  });
});
