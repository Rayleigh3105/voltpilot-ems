import { describe, expect, it } from 'vitest';
import type { Grundlast } from './api';
import { anteilWort, grundlastKachel, grundlastKarte, grundlastSatz, kwhRund, nachtTitel } from './grundlast';
import { watt } from './leitungsplan';

const NBSP = String.fromCharCode(160);
const n = (s: string) => s.replace(new RegExp(NBSP, 'g'), ' ');

/** Eine Woche mit sieben gewerteten Nächten (Bild v-uv-grund-karte). */
function woche(over: Partial<Grundlast> = {}): Grundlast {
  const tage = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
  return {
    z: 'woche',
    von: tage[0],
    bis: tage[6],
    hausverbrauchGemessen: true,
    typischW: 642,
    gewertet: 7,
    mindestens: 3,
    luecken: 0,
    naechte: tage.map((datum, i) => ({ datum, status: 'gewertet' as const, w: 620 + i * 5 })),
    monate: [],
    kwhAmTag: 15.41,
    anteil: 0.51,
    vorperiodeW: 588,
    stufe: null,
    teile: [
      { entityId: 'k', label: 'UV Keller', typLabel: 'Unterzähler', unterzaehler: true, w: 31 },
      { entityId: 'h', label: 'UV Halle', typLabel: 'Unterzähler', unterzaehler: true, w: 561 },
    ],
    rest: { w: 50, grund: null },
    ...over,
  };
}

describe('Grundlast · Schreibweise', () => {
  it('rundet Watt auf 10 W mit geschütztem Leerzeichen und Tausenderpunkt', () => {
    expect(watt(642)).toBe(`640${NBSP}W`);
    expect(watt(1244)).toBe(`1.240${NBSP}W`);
    expect(watt(3)).toBe(`0${NBSP}W`);
    expect(watt(null)).toBe('—');
  });

  it('rundet kWh am Tag unter 10 auf 0,5, darüber ganz', () => {
    expect(kwhRund(15.41)).toBe('15');
    expect(kwhRund(5.52)).toBe('5,5');
    expect(kwhRund(7.2)).toBe('7');
  });

  it('nennt den Anteil in sieben Stufen', () => {
    expect([0.08, 0.16, 0.21, 0.26, 0.34, 0.5, 0.7].map(anteilWort)).toEqual([
      'ein Zehntel', 'ein Sechstel', 'ein Fünftel', 'ein Viertel', 'ein Drittel', 'die Hälfte', 'mehr als die Hälfte',
    ]);
  });

  it('überschreibt den Zeitraum', () => {
    expect(nachtTitel('woche', '2026-08-31')).toBe('typische Nacht der Woche');
    expect(nachtTitel('monat', '2026-10-01')).toBe('typische Nacht im Monat');
    expect(nachtTitel('jahr', '2026-01-01')).toBe('typische Nacht im Jahr');
    expect(nachtTitel('tag', '2026-11-03')).toBe('in der Nacht zum 03.11.');
  });
});

describe('Grundlast · Karte', () => {
  it('Woche mit Unterzählern: Zahl, Balken, Aufteilung, Satz', () => {
    const k = grundlastKarte(woche(), 'privat');
    expect(n(k.zahl)).toBe('640 W');
    expect(k.balken).toHaveLength(7);
    expect(k.balken.every((b) => b.art === 'wert')).toBe(true);
    expect(k.achse).toEqual(['Mo., 31.08.', 'So., 06.09.']);
    expect(k.teile.map((t) => [t.label, n(t.wert)])).toEqual([
      ['UV Halle', '560 W'],
      ['UV Keller', '30 W'],
      ['übriger Haushalt', '50 W'],
    ]);
    expect(n(k.satz)).toBe('Rund 15 kWh am Tag – etwa die Hälfte Ihres Verbrauchs. Vorwoche: 590 W.');
  });

  it('ohne Unterzähler keine Aufteilung; Gewerbe nennt den Rest anders', () => {
    expect(grundlastKarte(woche({ teile: [], rest: null })).teile).toEqual([]);
    expect(grundlastKarte(woche(), 'gewerbe').teile.at(-1)?.label).toBe('ohne eigenen Zähler');
  });

  it('Rest ohne Zahl: der Grund statt einer Zahl', () => {
    const k = grundlastKarte(woche({ rest: { w: null, grund: 'teile_mehr_als_haus' } }));
    expect(k.teile.at(-1)?.wert).toBe('passt nicht zusammen');
  });

  it('Lücken-Nächte: grauer Strich, der Satz nennt die Zahl statt Anteil und Vorwoche', () => {
    const g = woche({
      luecken: 2,
      gewertet: 5,
      naechte: woche().naechte.map((x, i) => (i === 2 || i === 3 ? { ...x, status: 'luecke' as const, w: null } : x)),
      kwhAmTag: 5.52,
    });
    const k = grundlastKarte(g);
    expect(k.balken[2]).toMatchObject({ art: 'ohne', hoehe: null });
    expect(n(k.satz)).toBe('Rund 5,5 kWh am Tag. 2 Nächte ohne Messwerte sind nicht gewertet.');
  });

  it('zu wenig Historie: Strich und „Noch 1 Nacht Messung …“', () => {
    const g = woche({
      typischW: null,
      kwhAmTag: null,
      anteil: null,
      vorperiodeW: null,
      gewertet: 2,
      teile: [],
      rest: null,
      naechte: woche().naechte.map((x, i) =>
        i < 4 ? { ...x, status: 'vorher' as const, w: null } : i === 6 ? { ...x, status: 'offen' as const, w: null } : x),
    });
    const k = grundlastKarte(g);
    expect(k.zahl).toBe('—');
    expect(k.satz).toBe('Noch 1 Nacht Messung, dann steht hier Ihre Grundlast.');
    // Ist der Zeitraum vorbei, kommt keine Nacht mehr dazu: das wird gesagt, nicht „noch 1 Nacht“.
    const vorbei = { ...g, naechte: g.naechte.map((x) => (x.status === 'offen' ? { ...x, status: 'gewertet' as const, w: 300 } : x)) };
    expect(grundlastSatz({ ...vorbei, gewertet: 2, naechte: vorbei.naechte.map((x, i) => (i === 6 ? { ...x, status: 'vorher' as const, w: null } : x)) }))
      .toBe('Erst 2 Nächte gemessen – für die typische Nacht braucht es 3.');
  });

  it('eine noch offene Nacht bleibt leer, keine Null', () => {
    const g = woche({ naechte: woche().naechte.map((x, i) => (i === 6 ? { ...x, status: 'offen' as const, w: null } : x)) });
    expect(grundlastKarte(g).balken[6]).toMatchObject({ art: 'offen', hoehe: null });
  });

  it('Monat mit Stufe nennt den Tag, keine Warnung', () => {
    const g = woche({ z: 'monat', von: '2026-10-01', bis: '2026-10-31', kwhAmTag: 6.9, stufe: { seit: '2026-10-17', vorherW: 222, nachherW: 284 } });
    const k = grundlastKarte(g);
    expect(k.achse).toEqual(['1. Okt.', '31. Okt.']);
    expect(n(k.satz)).toBe('Rund 7 kWh am Tag. Seit dem 17. Oktober rund 60 W mehr.');
  });

  it('Jahr: ein Balken je Monat, der niedrigste Monat im Satz', () => {
    const monate = Array.from({ length: 12 }, (_, i) => ({ monat: `2026-${String(i + 1).padStart(2, '0')}`, w: i === 6 ? 198 : 230 + i, gewertet: 28 }));
    const k = grundlastKarte(woche({ z: 'jahr', von: '2026-01-01', bis: '2026-12-31', naechte: [], monate, kwhAmTag: 5.52, teile: [], rest: null }));
    expect(k.balken).toHaveLength(12);
    expect(k.achse).toEqual(['Jan.', 'Dez.']);
    expect(n(k.satz)).toBe('Rund 5,5 kWh am Tag. Niedrigster Monat: Juli mit 200 W.');
  });

  it('Tag: keine Balken, der Wert dieser Nacht und die Nacht davor', () => {
    const g = woche({ z: 'tag', von: '2026-11-03', bis: '2026-11-03', naechte: [{ datum: '2026-11-03', status: 'gewertet', w: 300 }], typischW: 300, kwhAmTag: 7.2, anteil: 0.25, vorperiodeW: 280, mindestens: 1, teile: [], rest: null });
    const k = grundlastKarte(g);
    expect(k.balken).toEqual([]);
    expect(n(k.satz)).toBe('Rund 7 kWh am Tag – etwa ein Viertel Ihres Verbrauchs. Nacht davor: 280 W.');
  });

  it('ein vergangener Zeitraum ohne jede Messung sagt das, nicht „noch 3 Nächte“', () => {
    const g = woche({ typischW: null, gewertet: 0, naechte: woche().naechte.map((x) => ({ ...x, status: 'vorher' as const, w: null })) });
    expect(grundlastSatz(g)).toBe('In diesem Zeitraum wurde noch nicht gemessen.');
  });
});

describe('Grundlast · Kachel', () => {
  it('Zahl, „läuft immer“, vor einem Monat', () => {
    const k = grundlastKachel(woche({ z: 'aktuell', typischW: 312, vorperiodeW: 291 }));
    expect(k).toEqual({ zahl: '310', einheit: 'W', zustand: 'läuft immer', sub: `vor einem Monat 290${NBSP}W` });
  });

  it('zu wenig Historie: Strich und die fehlenden Nächte', () => {
    const k = grundlastKachel(woche({ z: 'aktuell', typischW: null, gewertet: 1 }));
    expect(k).toEqual({ zahl: '—', einheit: null, zustand: 'läuft immer', sub: 'noch 2 Nächte Messung' });
  });

  it('nie gemessen: keine Kachel', () => {
    expect(grundlastKachel(woche({ hausverbrauchGemessen: false }))).toBeNull();
    expect(grundlastKachel(null)).toBeNull();
  });
});
