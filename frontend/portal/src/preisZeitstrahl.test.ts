import { describe, expect, it } from 'vitest';
import type { PriceBucket } from './api';
import {
  abstand,
  bisUhrzeit,
  blockZeit,
  ct1,
  FENSTER_VIERTEL,
  hatFolgetag,
  laufEnde,
  speicherPlan,
  stufe,
  stufeBei,
  tagWort,
  viertelReihe,
  VIERTEL_MS,
  zeitstrahl,
} from './preisZeitstrahl';

/** Dienstag, 20.10.2026, 00:00 Ortszeit (Europe/Berlin über vitest.config). */
const TAG = new Date(2026, 9, 20, 0, 0, 0, 0).getTime();
const um = (stunde: number, minute = 0, tag = 0) =>
  new Date(2026, 9, 20 + tag, stunde, minute, 0, 0);

/** Eine Reihe aus ct/kWh-Werten ab `start`, eine je Viertelstunde (API: EUR/MWh). */
function reihe(cts: readonly (number | null)[], start = TAG): PriceBucket[] {
  return cts.map((ct, i) => ({
    ts: new Date(start + i * VIERTEL_MS).toISOString(),
    avgEurMwh: ct == null ? null : ct * 10,
    minEurMwh: null,
    maxEurMwh: null,
  }));
}

/** Zwei Tage: nachts 17, mittags billig (14), abends teuer (26), morgen früh am teuersten (28). */
function zweiTage(): number[] {
  return Array.from({ length: 192 }, (_, i) => {
    const h = (i % 96) / 4;
    const morgen = i >= 96;
    if (!morgen && h >= 12 && h < 16) return 14;
    if (!morgen && h >= 17.5 && h < 20) return 26;
    if (morgen && h >= 7 && h < 9.5) return 28;
    if (morgen && h >= 2 && h < 5) return 16;
    return 20;
  });
}

describe('viertelReihe', () => {
  it('rechnet EUR/MWh in ct/kWh und füllt Lücken mit null, nie mit 0', () => {
    const b = reihe([10, 12, 14]);
    const ohneMitte = [b[0], b[2]];
    const v = viertelReihe(ohneMitte);
    expect(v.map((x) => x.ct)).toEqual([10, null, 14]);
    expect(v[1].start - v[0].start).toBe(VIERTEL_MS);
  });

  it('sortiert und ist ohne Werte leer', () => {
    expect(viertelReihe([])).toEqual([]);
    const b = reihe([1, 2, 3]);
    expect(viertelReihe([b[2], b[0], b[1]]).map((x) => x.ct)).toEqual([1, 2, 3]);
  });
});

describe('zeitstrahl · jetzt', () => {
  it('findet die laufende Viertelstunde', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 50))!;
    expect(z.jetzt).toBe(13 * 4 + 3);
    expect(z.ab).toBe(z.jetzt);
  });

  it('erfindet ohne laufende Viertelstunde kein jetzt', () => {
    // Die Reihe endet um 06:00 - jetzt ist 13:50.
    const z = zeitstrahl(reihe(zweiTage().slice(0, 24)), um(13, 50))!;
    expect(z.jetzt).toBe(-1);
    expect(z.ab).toBe(24);
    expect(z.tief).toBeNull();
    expect(z.guenstigste).toBeNull();
  });

  it('ist ohne Preise null', () => {
    expect(zeitstrahl([], um(12))).toBeNull();
  });
});

describe('zeitstrahl · Stufen im Vergleich der kommenden Stunden (E2 = A)', () => {
  it('rechnet nur über Kommendes: ein teurer Morgen von gestern zählt nicht', () => {
    const cts = zweiTage();
    const z = zeitstrahl(reihe(cts), um(13, 45))!;
    expect(z.tief).toBe(14);
    expect(z.hoch).toBe(28);
    expect(stufe(z, 14)).toBe('guenstig');
    expect(stufe(z, 28)).toBe('teuer');
    expect(stufe(z, -0.5)).toBe('negativ');
  });

  it('nennt Vergangenes „vorbei“ und eine Lücke null', () => {
    const cts: (number | null)[] = zweiTage();
    cts[60] = null;
    const z = zeitstrahl(reihe(cts), um(13, 45))!;
    expect(stufeBei(z, 10)).toBe('vorbei');
    expect(stufeBei(z, 60)).toBeNull();
    expect(stufeBei(z, z.jetzt)).toBe('guenstig');
  });

  it('kennt auf einem flachen Tag keine Stufen und keine Fenster', () => {
    const flach = Array.from({ length: 96 }, (_, i) => 20 + (i % 3));
    const z = zeitstrahl(reihe(flach), um(8))!;
    expect(z.flach).toBe(true);
    expect(stufe(z, 22)).toBe('mittel');
    expect(z.guenstigste).toBeNull();
    expect(z.teuerste).toBeNull();
  });

  it('teilt drei gleich große Gruppen genau in drei Stufen', () => {
    const cts = [...Array(8).fill(10), ...Array(8).fill(20), ...Array(8).fill(30)];
    const z = zeitstrahl(reihe(cts), new Date(TAG + 60_000))!;
    expect([stufe(z, 10), stufe(z, 20), stufe(z, 30)]).toEqual(['guenstig', 'mittel', 'teuer']);
  });

  it('läuft bis zum Wechsel der Stufe', () => {
    const cts = [...Array(8).fill(10), ...Array(8).fill(20), ...Array(8).fill(30)];
    const z = zeitstrahl(reihe(cts), new Date(TAG + 60_000))!;
    expect(laufEnde(z, 0)).toBe(8);
    expect(laufEnde(z, 8)).toBe(16);
    expect(laufEnde(z, 16)).toBe(24);
  });
});

describe('zeitstrahl · zwei Fenster nur nach vorn', () => {
  it('beginnt das günstigste Fenster jetzt, wenn jetzt am günstigsten ist', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 45))!;
    expect(z.guenstigste).toEqual({ von: z.jetzt, bis: z.jetzt + FENSTER_VIERTEL, ct: 14 });
    expect(blockZeit(z, z.guenstigste!)).toEqual({ tag: 'jetzt bis', zeit: '15:45' });
  });

  it('nennt den Tag: das teuerste Fenster liegt morgen früh', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 45))!;
    expect(z.teuerste!.ct).toBe(28);
    expect(blockZeit(z, z.teuerste!)).toEqual({ tag: 'morgen', zeit: '07:00–09:00' });
  });

  it('nennt nie ein vergangenes Fenster', () => {
    // Um 21:00 ist das Mittagstief vorbei; das günstigste kommt morgen nachts.
    const z = zeitstrahl(reihe(zweiTage()), um(21))!;
    expect(z.guenstigste!.von).toBeGreaterThanOrEqual(z.jetzt);
    expect(blockZeit(z, z.guenstigste!).tag).toBe('morgen');
    expect(z.guenstigste!.ct).toBe(16);
  });

  it('legt kein Fenster über eine Lücke', () => {
    const cts: (number | null)[] = zweiTage();
    for (let i = 55; i < 62; i++) cts[i] = null;
    const z = zeitstrahl(reihe(cts), um(13, 45))!;
    const g = z.guenstigste!;
    for (let i = g.von; i < g.bis; i++) expect(z.viertel[i].ct).not.toBeNull();
  });

  it('gibt kurz vor Mitternacht ohne Folgetag keine Fenster (zu wenig Rest)', () => {
    const z = zeitstrahl(reihe(zweiTage().slice(0, 96)), um(22, 30))!;
    expect(z.guenstigste).toBeNull();
    expect(hatFolgetag(z)).toBe(false);
  });
});

describe('speicherPlan (E4 = A)', () => {
  const plan = (start: number, kws: number[]) =>
    kws.map((kw, i) => ({ start: new Date(start + i * VIERTEL_MS).toISOString(), batteryKw: kw }));

  it('richtet den Plan auf die Viertel aus: positiv lädt, negativ gibt ab', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 45))!;
    const p = speicherPlan(z, plan(um(13, 45).getTime(), [2, 0.01, -3]), 15)!;
    expect(p[z.jetzt]).toBe('laedt');
    expect(p[z.jetzt + 1]).toBeNull();
    expect(p[z.jetzt + 2]).toBe('gibtAb');
  });

  it('sagt nichts über die Vergangenheit', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 45))!;
    const p = speicherPlan(z, plan(TAG, Array.from({ length: 192 }, () => 2)), 15)!;
    expect(p[z.jetzt - 1]).toBeNull();
    expect(p[z.jetzt]).toBe('laedt');
  });

  it('trägt Stunden-Slots auf alle vier Viertel', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(14))!;
    const p = speicherPlan(z, [{ start: um(14).toISOString(), batteryKw: -1 }], 60)!;
    expect([p[56], p[57], p[58], p[59], p[60]]).toEqual(['gibtAb', 'gibtAb', 'gibtAb', 'gibtAb', null]);
  });

  it('ist null, wenn der Plan nichts tut', () => {
    const z = zeitstrahl(reihe(zweiTage()), um(13, 45))!;
    expect(speicherPlan(z, plan(um(13, 45).getTime(), [0, 0.02, -0.04]), 15)).toBeNull();
    expect(speicherPlan(z, [], 15)).toBeNull();
  });
});

describe('Wörter und Zeiten', () => {
  it('schreibt das Ende einer Spanne an Mitternacht als 24:00', () => {
    expect(bisUhrzeit(um(0, 0, 1).getTime())).toBe('24:00');
    expect(bisUhrzeit(um(15, 45).getTime())).toBe('15:45');
  });

  it('nennt heute, morgen, sonst Wochentag und Datum', () => {
    const jetzt = um(13, 45).getTime();
    expect(tagWort(um(18).getTime(), jetzt)).toBe('heute');
    expect(tagWort(um(7, 0, 1).getTime(), jetzt)).toBe('morgen');
    expect(tagWort(um(7, 0, 2).getTime(), jetzt)).toBe('Do 22.10.');
  });

  it('rundet den Abstand auf halbe Stunden, darunter auf 5 Minuten', () => {
    const jetzt = um(13, 45).getTime();
    expect(abstand(um(14, 25).getTime(), jetzt)).toBe('in 40 Min');
    expect(abstand(um(16, 15).getTime(), jetzt)).toBe('in 2½ Std');
    expect(abstand(um(7, 15, 1).getTime(), jetzt)).toBe('in 17½ Std');
    expect(abstand(um(12, 45).getTime(), jetzt)).toBe('vor 1 Std');
    expect(abstand(jetzt, jetzt)).toBe('jetzt');
  });

  it('schreibt Preise mit einer Stelle und echtem Minus', () => {
    expect(ct1(14.48)).toBe('14,5');
    expect(ct1(-2.94)).toBe('−2,9');
    expect(ct1(-0.01)).toBe('0,0');
  });
});
