import { describe, expect, it } from 'vitest';
import { portfolioKacheln } from './portfolioKacheln';
import type { PortfolioKpi } from './api';

function kpi(over: Partial<PortfolioKpi> = {}): PortfolioKpi {
  return {
    periode: { von: '2026-09-01', bis: '2026-09-30', jahr: 2026, monat: 9 },
    verbrauch: { kwh: 199500, kwh_vorjahr: 207000, vollstaendig: true },
    kosten: { eur: 48000, eur_vorjahr: 47000, tarif_hinterlegt: true },
    lastspitze: {
      kw: 412,
      vereinbart_kw: 550,
      anteil_prozent: 75,
      anlage: 'Werk Ahrenberg – Halle 1',
      zeitpunkt: '2026-10-05T18:15:00Z',
      zeitraum: '2026',
    },
    datenlage: { aktuell: 10, gesamt: 10 },
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
    // Punkt 4: der Bezugszeitraum steht in der Kachel.
    expect(r.verbrauch.satz).toBe('Netzbezug · September 2026');

    expect(r.kosten).toMatchObject({ wert: '48.000', einheit: '€', leer: false });
    expect(r.kosten.trend).toMatchObject({ richtung: 'rauf', prozent: '2' });
    expect(r.kosten.satz).toBe('aus Tarif · September 2026');

    // Review R2 §B4: gemessene kW mit 1 Nachkommastelle (AP-08). §B3: die Kachel nennt die Anlage (eigene Zeile).
    expect(r.lastspitze).toMatchObject({ wert: '412,0', einheit: 'kW', leer: false, fuellProzent: 75 });
    expect(r.lastspitze.satz).toBe('von 550,0 kW vereinbart');
    // Pixel-Review R2: Anlage in eigener Zeile, letzter Namensteil gegen Umbruch geschützt („Halle 1").
    expect(r.lastspitze.anlage).toBe('Werk Ahrenberg – Halle 1');
    // Review PR3 §1: Abrechnungszeitraum + Zeitpunkt der Spitze (Europe/Berlin: 18:15 UTC → 20:15).
    expect(r.lastspitze.wann).toBe('höchste Spitze 2026 · 05.10. 20:15');

    // Review PR3 §2: Datenlage-Kachel.
    expect(r.datenlage).toMatchObject({ wert: '10/10', einheit: 'Messstellen', satz: 'vollständig · aktuell', ton: 'ok' });

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
        lastspitze: { kw: null, vereinbart_kw: null, anteil_prozent: null, anlage: null, zeitpunkt: null, zeitraum: null },
        datenlage: null,
        leit: null,
      }),
    );
    expect(r.verbrauch).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'noch keine Ablesung', trend: null });
    expect(r.kosten).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'kein Tarif hinterlegt', trend: null });
    expect(r.lastspitze).toMatchObject({ wert: '–', einheit: '', leer: true, satz: 'keine Lastdaten', anlage: null, fuellProzent: null, wann: null });
    expect(r.datenlage).toBeNull();
    expect(r.leit).toBeNull();
  });

  it('kein Tarif → keine Kosten, aber der Verbrauch bleibt sichtbar', () => {
    const r = portfolioKacheln(kpi({ kosten: { eur: null, eur_vorjahr: null, tarif_hinterlegt: false } }));
    expect(r.verbrauch.wert).toBe('199.500');
    expect(r.kosten.leer).toBe(true);
    expect(r.kosten.satz).toBe('kein Tarif hinterlegt');
  });

  it('unter einem halben Prozent zeigt keinen Pfeil, sondern „unverändert" (Punkt 4)', () => {
    const r = portfolioKacheln(kpi({ verbrauch: { kwh: 100000, kwh_vorjahr: 100200, vollstaendig: true } }));
    expect(r.verbrauch.trend).toBeNull();
    expect(r.verbrauch.vergleich).toBe('unverändert ggü. Vorjahr');
  });

  it('kein Vorjahr → ehrlich „Vorjahr noch nicht verfügbar", aber der Wert steht (Punkt 4)', () => {
    const r = portfolioKacheln(kpi({ verbrauch: { kwh: 199500, kwh_vorjahr: null, vollstaendig: true } }));
    expect(r.verbrauch.wert).toBe('199.500');
    expect(r.verbrauch.trend).toBeNull();
    expect(r.verbrauch.vergleich).toBe('Vorjahr noch nicht verfügbar');
  });

  it('unvollständig gemessen → kein Vorjahrespfeil, sondern „unvollständig gemessen" (Review R2 §B2)', () => {
    const r = portfolioKacheln(
      kpi({
        verbrauch: { kwh: 120000, kwh_vorjahr: 207000, vollstaendig: false },
        kosten: { eur: 29000, eur_vorjahr: 47000, tarif_hinterlegt: true },
      }),
    );
    // Der Wert bleibt sichtbar, aber die Teilmenge wird nicht gegen ein volles Vorjahr gestellt.
    expect(r.verbrauch.wert).toBe('120.000');
    expect(r.verbrauch.trend).toBeNull();
    expect(r.verbrauch.vergleich).toBe('unvollständig gemessen');
    expect(r.verbrauch.vollstaendig).toBe(false);
    // Kosten = Menge × Tarif: erbt die Unvollständigkeit der Menge.
    expect(r.kosten.wert).toBe('29.000');
    expect(r.kosten.trend).toBeNull();
    expect(r.kosten.vergleich).toBe('unvollständig gemessen');
    expect(r.kosten.vollstaendig).toBe(false);
  });

  it('Lastspitze ohne vereinbarte Leistung nennt die gemessene Spitze', () => {
    const r = portfolioKacheln(
      kpi({ lastspitze: { kw: 300, vereinbart_kw: null, anteil_prozent: null, anlage: 'A', zeitpunkt: null, zeitraum: '2026' } }),
    );
    expect(r.lastspitze.wert).toBe('300,0');
    expect(r.lastspitze.satz).toBe('gemessene Spitze');
    expect(r.lastspitze.anlage).toBe('A');
    expect(r.lastspitze.fuellProzent).toBeNull();
    // Ohne Zeitpunkt bleibt nur der Abrechnungszeitraum.
    expect(r.lastspitze.wann).toBe('höchste Spitze 2026');
  });

  it('Lastspitze bei Monatsabrechnung trägt das Monats-Label (Review PR3 §1)', () => {
    const r = portfolioKacheln(
      kpi({ lastspitze: { kw: 300, vereinbart_kw: 550, anteil_prozent: 55, anlage: 'A', zeitpunkt: '2026-10-05T18:15:00Z', zeitraum: 'Oktober 2026' } }),
    );
    expect(r.lastspitze.wann).toBe('höchste Spitze Oktober 2026 · 05.10. 20:15');
  });

  it('Datenlage: nicht alle Messstellen aktuell → Warnung (Review PR3 §2)', () => {
    const r = portfolioKacheln(kpi({ datenlage: { aktuell: 8, gesamt: 10 } }));
    expect(r.datenlage).toMatchObject({ wert: '8/10', einheit: 'Messstellen', satz: '2 ohne aktuelle Daten', ton: 'warn' });
  });

  it('Datenlage: ohne Messstellen keine Kachel', () => {
    expect(portfolioKacheln(kpi({ datenlage: null })).datenlage).toBeNull();
    expect(portfolioKacheln(kpi({ datenlage: { aktuell: 0, gesamt: 0 } })).datenlage).toBeNull();
  });
});
