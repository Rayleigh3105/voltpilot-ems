import { describe, expect, it } from 'vitest';
import type { HistoryCoverage } from './api';
import {
  abdeckungPct,
  abdeckungView,
  ankerAusWert,
  isoMonth,
  isoWeekValue,
  mitVergleich,
  parseVergleichModus,
  sprungFeld,
  sprungGrenzen,
  sprungJahre,
  sprungWert,
  streifenAnker,
  streifenSlots,
  zeigtStreifen,
} from './historieZeit';

const NOW = new Date(2026, 6, 30, 14, 7); // Do, 30.07.2026

function coverage(over: Partial<HistoryCoverage> = {}): HistoryCoverage {
  return {
    firstDataAt: '2026-06-19T00:00:00Z',
    lastDataAt: '2026-07-30T11:45:00Z',
    expectedFrom: '2026-06-30T22:00:00Z',
    expectedTo: '2026-07-30T11:45:00Z',
    expectedBuckets: 2000,
    measuredBuckets: 1880,
    gaps: 6,
    resolutionMinutes: 15,
    ...over,
  };
}

/**
 * F2 — der Zeitraum-Sprung. Der behobene Befund: vom 30.07. in den Januar waren
 * es 7 Klicks im Monatsmodus und 211 im Tagesmodus, weil es NUR den ‹-Knopf gab.
 */
describe('F2 · Zeitraum-Sprung', () => {
  it('wählt je Zeitraum das passende native Feld', () => {
    expect(sprungFeld('day')).toBe('date');
    expect(sprungFeld('week')).toBe('week');
    expect(sprungFeld('month')).toBe('month');
    // Für das Jahr gibt es kein natives Feld -> Auswahlliste.
    expect(sprungFeld('year')).toBe('year');
  });

  it('zeigt den Anker im Format des jeweiligen Felds', () => {
    const anchor = new Date(2026, 0, 15, 12); // Do, 15.01.2026 (KW 3)
    expect(sprungWert(anchor, 'day')).toBe('2026-01-15');
    expect(sprungWert(anchor, 'month')).toBe('2026-01');
    expect(sprungWert(anchor, 'year')).toBe('2026');
    expect(sprungWert(anchor, 'week')).toBe('2026-W03');
  });

  it('nennt beim Wochenfeld das ISO-WOCHENJAHR, nicht das Kalenderjahr', () => {
    // Der 01.01.2027 (Freitag) liegt in KW 53 von 2026 - ein naives
    // getFullYear() erzeugte „2027-W53", was kein Browser annimmt.
    expect(isoWeekValue(new Date(2027, 0, 1, 12))).toBe('2026-W53');
    expect(isoMonth(new Date(2026, 8, 3, 12))).toBe('2026-09');
  });

  it('springt aus jedem Feldwert auf den richtigen Anker - und NIE auf ein erfundenes Datum', () => {
    expect(ankerAusWert('2026-01-15', 'day')?.getMonth()).toBe(0);
    expect(ankerAusWert('2026-01-15', 'day')?.getDate()).toBe(15);
    expect(ankerAusWert('2026-01', 'month')?.getMonth()).toBe(0);
    expect(ankerAusWert('2025', 'year')?.getFullYear()).toBe(2025);
    // Woche -> Montag der ISO-Woche.
    const montag = ankerAusWert('2026-W03', 'week');
    expect(montag?.getDay()).toBe(1);
    expect(montag?.getDate()).toBe(12);

    // Leeres/halb getipptes Feld springt gar nicht.
    for (const kaputt of ['', '   ', '2026-1-5', '2026-W', '2026-W99', 'heute']) {
      expect(ankerAusWert(kaputt, 'day')).toBeNull();
      expect(ankerAusWert(kaputt, 'week')).toBeNull();
      expect(ankerAusWert(kaputt, 'month')).toBeNull();
      expect(ankerAusWert(kaputt, 'year')).toBeNull();
    }
  });

  it('der Anker liegt mittags - keine Zeitzone kippt ihn über eine Tagesgrenze', () => {
    expect(ankerAusWert('2026-01-15', 'day')?.getHours()).toBe(12);
    expect(ankerAusWert('2026-03', 'month')?.getHours()).toBe(12);
  });

  it('begrenzt den Sprung, wo wir es WISSEN - nie in die Zukunft, nie vor die ersten Daten', () => {
    const g = sprungGrenzen('day', NOW, coverage());
    expect(g.max).toBe('2026-07-30');
    expect(g.min).toBe('2026-06-19');

    // Ohne Abdeckungsdaten wird NICHTS geraten - nur die Zukunft bleibt zu.
    const ohne = sprungGrenzen('month', NOW, null);
    expect(ohne.max).toBe('2026-07');
    expect(ohne.min).toBeUndefined();
  });

  it('bietet nur Jahre an, in denen es Daten geben kann - und nie eine Sackgasse', () => {
    expect(sprungJahre(NOW, NOW, coverage({ firstDataAt: '2024-03-01T00:00:00Z' }))).toEqual([
      2026, 2025, 2024,
    ]);
    // Ohne Datenlage bleibt eine kurze Liste, damit sie nie leer ist.
    expect(sprungJahre(NOW, NOW, null)).toEqual([2026, 2025, 2024]);
    // Ein per Lesezeichen geöffnetes Jahr AUSSERHALB der Liste ist trotzdem
    // wählbar - sonst könnte man aus ihm nicht mehr herausklicken.
    expect(sprungJahre(new Date(2019, 5, 1), NOW, coverage())).toContain(2019);
  });
});

/**
 * F2 — der Monatsstreifen als Sprungbrett. Er ist derselbe Baustein wie in der
 * Geld-Ansicht, hier aber ein reiner Navigator: die Historie kennt keine
 * Monatswerte, also trägt kein Chip eine Zahl.
 */
describe('F2 · Monatsstreifen', () => {
  it('steht dort, wo Blättern weh tut (Tag und Monat)', () => {
    expect(zeigtStreifen('day')).toBe(true);
    expect(zeigtStreifen('month')).toBe(true);
    expect(zeigtStreifen('week')).toBe(false);
    expect(zeigtStreifen('year')).toBe(false);
  });

  it('zeigt zwölf Monate ohne erfundene Zahlen und markiert den laufenden', () => {
    const slots = streifenSlots(NOW, coverage());
    expect(slots).toHaveLength(12);
    expect(slots[11]).toMatchObject({ month: '2026-07-01', label: 'Jul', isCurrent: true });
    expect(slots[0]).toMatchObject({ month: '2025-08-01', label: 'Aug', isCurrent: false });
    // KEINE Werte - die Historie kennt sie nicht, und erfinden wäre keine Option.
    expect(slots.every((s) => s.value === null)).toBe(true);
  });

  it('markiert Monate ohne Daten - und lässt sie unbekannt, wenn wir es nicht wissen', () => {
    const slots = streifenSlots(NOW, coverage());
    const key = (m: string) => slots.find((s) => s.month === m);
    expect(key('2026-05-01')?.hasData).toBe(false); // vor der ersten Messung
    expect(key('2026-06-01')?.hasData).toBe(true);
    expect(key('2026-07-01')?.hasData).toBe(true);

    // Ohne Abdeckungsdaten bleibt es UNBEKANNT (undefined), nie „keine Daten".
    for (const s of streifenSlots(NOW, null)) expect(s.hasData).toBeUndefined();
  });

  it('führt ein Tipp im Monatsmodus in den Monat, im Tagesmodus auf einen Tag darin', () => {
    expect(streifenAnker('2026-01-01', 'month', NOW)?.getMonth()).toBe(0);
    // Tagesmodus: der erste Tag des Monats...
    const jan = streifenAnker('2026-01-01', 'day', NOW);
    expect(jan?.getMonth()).toBe(0);
    expect(jan?.getDate()).toBe(1);
    // ...aber im LAUFENDEN Monat ist „heute" die nützlichere Antwort als „der 1.".
    const jetzt = streifenAnker('2026-07-01', 'day', NOW);
    expect(jetzt?.getDate()).toBe(30);
  });
});

/**
 * F4 — die Datenlage. Der behobene Vertrauensschaden: ein „Jahr", das sechs
 * Wochen Balken zeigt, ohne es zu sagen, und eine Lücke, die von einer
 * gemessenen Null nicht unterscheidbar ist.
 */
describe('F4 · Datenabdeckung', () => {
  it('rundet NIE auf 100 % auf', () => {
    expect(abdeckungPct(1996, 2000)).toBe(99); // 99,8 % bleibt 99
    expect(abdeckungPct(2000, 2000)).toBe(100);
    expect(abdeckungPct(2001, 2000)).toBe(100);
    expect(abdeckungPct(0, 2000)).toBe(0);
    expect(abdeckungPct(5, 0)).toBeNull();
  });

  it('sagt ab wann es Daten gibt, wie viel gemessen wurde und wie viele Lücken', () => {
    const v = abdeckungView(coverage())!;
    expect(v.abText).toBe('Daten ab 19.06.2026');
    expect(v.balkenPct).toBe(94);
    expect(v.satz).toBe('94 % der Viertelstunden gemessen');
    expect(v.luecken).toBe('6 Lücken');
    expect(v.titel).toContain('1.880 von 2.000 Viertelstunden');
  });

  it('spricht bei einer einzigen Lücke im Singular und schweigt ohne Lücke', () => {
    expect(abdeckungView(coverage({ gaps: 1 }))!.luecken).toBe('1 Lücke');
    const voll = abdeckungView(coverage({ measuredBuckets: 2000, gaps: 0 }))!;
    expect(voll.luecken).toBeNull();
    expect(voll.satz).toBe('durchgehend gemessen');
  });

  it('behauptet ohne Abdeckungsdaten GAR KEINE Abdeckung', () => {
    // Älteres Backend / nie gemessene Anlage -> die Zeit-Leiste zeigt nichts.
    expect(abdeckungView(undefined)).toBeNull();
    expect(abdeckungView(null)).toBeNull();
  });

  it('zeigt bei einem noch nicht gelaufenen Zeitraum nur die Herkunft, keinen Balken', () => {
    const v = abdeckungView(coverage({ expectedBuckets: 0, measuredBuckets: 0, gaps: 0 }))!;
    expect(v.abText).toBe('Daten ab 19.06.2026');
    expect(v.balkenPct).toBeNull();
    expect(v.satz).toBeNull();
  });
});

/**
 * **F8 — der Vergleichs-Zustand reist in der Adresse.** Er gehört zur
 * Zeit-Leiste wie Zeitraum und Anker, also teilt er sich deren Vokabular: EIN
 * Parameter, den beide Welten lesen (der Welt-Wechsel nimmt ihn mit).
 */
describe('F8 · der Vergleich im Hash', () => {
  it('liest den Modus aus der Adresse - unbekanntes ist „Aus"', () => {
    expect(parseVergleichModus('#/anlage/s-1/messwerte?z=monat&v=vorjahr')).toBe('vorjahr');
    expect(parseVergleichModus('#/anlage/s-1/erloese?v=vorperiode')).toBe('vorperiode');
    expect(parseVergleichModus('#/anlage/s-1/messwerte?z=monat')).toBe('aus');
    expect(parseVergleichModus('#/anlage/s-1/messwerte?v=quatsch')).toBe('aus');
    expect(parseVergleichModus('')).toBe('aus');
  });

  it('hängt sich an das bestehende Vokabular an, statt ein zweites zu erfinden', () => {
    expect(mitVergleich('#/anlage/s-1/messwerte?z=monat&at=2026-07-01', 'vorjahr')).toBe(
      '#/anlage/s-1/messwerte?z=monat&at=2026-07-01&v=vorjahr',
    );
    expect(mitVergleich('#/anlage/s-1/erloese', 'vorperiode')).toBe(
      '#/anlage/s-1/erloese?v=vorperiode',
    );
  });

  it('schreibt für „Aus" NICHTS - ein Link ohne Vergleich bleibt zeichengleich', () => {
    const ohne = '#/anlage/s-1/messwerte?z=monat';
    expect(mitVergleich(ohne, 'aus')).toBe(ohne);
  });

  it('ist mit sich selbst konsistent (Bauen -> Lesen)', () => {
    for (const m of ['aus', 'vorperiode', 'vorjahr'] as const) {
      expect(parseVergleichModus(mitVergleich('#/anlage/s-1/messwerte?z=tag', m))).toBe(m);
    }
  });
});
