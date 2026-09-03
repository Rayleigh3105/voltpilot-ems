import { describe, expect, it } from 'vitest';

import type { EnergieBilanz, EnergieSumme } from './energieBilanz';
import { messwerteQuoten, messwerteZeilen } from './messwerteZeilen';

/**
 * **Die Ledger-Ableitung des Reiters „Messwerte"** (Paket P3, Konzept
 * `vp-verlauf-sprache-konzept-v5` §3.2 V5 / §4.1).
 *
 * Sie prüft die vier Zusagen, die P3 macht: dieselben Zahlen wie vorher, ein
 * Balken auf EINER Skala, drei Farben statt sechs — und dass eine fehlende
 * Messung ein GRUND wird und nie eine 0.
 */

const S = (
  key: EnergieSumme['key'],
  label: string,
  kwh: number | null,
): EnergieSumme => ({ key, label, kwh, farbe: 'pv', hinweis: `Hinweis ${label}` });

function summen(werte: Partial<Record<EnergieSumme['key'], number | null>>): EnergieSumme[] {
  return [
    S('erzeugt', 'Erzeugt', werte.erzeugt ?? null),
    S('verbraucht', 'Verbraucht', werte.verbraucht ?? null),
    S('bezogen', 'Bezogen', werte.bezogen ?? null),
    S('eingespeist', 'Eingespeist', werte.eingespeist ?? null),
    S('geladen', 'Geladen', werte.geladen ?? null),
    S('entladen', 'Entladen', werte.entladen ?? null),
  ];
}

describe('P3 · die sechs Energien als Ledger-Zeilen', () => {
  it('trägt jede Zahl in de-DE mit geschütztem Leerzeichen vor der Einheit', () => {
    const [erzeugt] = messwerteZeilen(summen({ erzeugt: 1234.56 }), null, 'am Vortag');
    expect(erzeugt.wert).toBe('1.234,6 kWh');
  });

  it('misst den Balken gegen die GRÖSSTE Zeile, nie gegen sich selbst', () => {
    const z = messwerteZeilen(summen({ erzeugt: 10, verbraucht: 5, bezogen: 0 }), null, 'x');
    expect(z[0].anteil).toBe(1);
    expect(z[1].anteil).toBe(0.5);
    // Eine gemessene 0 ist ein WERT — sie bekommt ihre Zeile und einen leeren
    // Balken, nicht „nicht messbar".
    expect(z[2].wert).toBe('0 kWh');
    expect(z[2].anteil).toBe(0);
  });

  it('gibt drei Farben, nicht sechs — und EINE für den Speicher', () => {
    const z = messwerteZeilen(summen({ erzeugt: 1, verbraucht: 1, bezogen: 1, eingespeist: 1, geladen: 1, entladen: 1 }), null, 'x');
    const nach = Object.fromEntries(z.map((r) => [r.key, r.farbe]));
    expect(nach.erzeugt).toBe(nach.verbraucht);
    expect(nach.bezogen).toBe(nach.eingespeist);
    expect(nach.geladen).toBe(nach.entladen);
    expect(new Set(Object.values(nach)).size).toBe(3);
  });

  it('sagt bei einer Anlage ohne Netzzähler den GRUND und nie eine 0', () => {
    const z = messwerteZeilen(summen({ erzeugt: 8, verbraucht: 6 }), null, 'x');
    const bezogen = z.find((r) => r.key === 'bezogen')!;
    expect(bezogen.wert).toBeNull();
    expect(bezogen.grund).toBe('ohne Netzzähler nicht messbar');
    expect(bezogen.anteil).toBeNull();
  });

  it('behauptet ohne Grösstwert gar keinen Balken', () => {
    const z = messwerteZeilen(summen({ erzeugt: 0, verbraucht: 0 }), null, 'x');
    expect(z[0].anteil).toBeNull();
    expect(z[0].wert).toBe('0 kWh');
  });

  it('trägt das Δ je Zeile — und ohne Vorperiode gar keines', () => {
    const jetzt = summen({ erzeugt: 4 });
    const vorher = summen({ erzeugt: 3 });
    expect(messwerteZeilen(jetzt, null, 'dem Vortag')[0].delta).toBeNull();
    const mit = messwerteZeilen(jetzt, vorher, 'dem Vortag')[0].delta;
    // Der Wortlaut gehört `historieVergleich.delta` — hier zählt nur, dass die
    // Zeile IHR Δ trägt (und die 33 % aus 3 → 4 kWh).
    expect(mit?.pct).toBe(33);
    expect(mit?.richtung).toBe('mehr');
    expect(mit?.text).toContain('Vortag');
    // ⚠ NEUTRAL, nie „gut": auf einer gemessenen Fläche ist mehr Erzeugung eine
    // Tatsache, kein Urteil (§4.1 „neutral, nie grün/rot").
    expect(messwerteZeilen(jetzt, vorher, 'dem Vortag')[2].delta).toBeNull();
  });
});

describe('P3 · die zwei Quoten', () => {
  const bilanz = (a: number | null, e: number | null): EnergieBilanz => ({
    summen: summen({}),
    autarkiePct: a,
    eigenverbrauchPct: e,
    gridCostEur: null,
    gridCostHinweis: '',
    empty: false,
  });

  it('rundet auf ganze Prozent und nennt ihren Satz', () => {
    const [autarkie, eigen] = messwerteQuoten(bilanz(63.4, 41.6));
    expect(autarkie.wert).toBe('63 %');
    expect(eigen.wert).toBe('42 %');
    expect(autarkie.satz).toMatch(/selbst gedeckt/);
  });

  it('behauptet ohne berechenbare Quote keine Zahl', () => {
    const [autarkie] = messwerteQuoten(bilanz(null, null));
    expect(autarkie.wert).toBeNull();
  });
});
