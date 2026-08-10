import { describe, expect, it } from 'vitest';
import {
  FLACH_GRUND,
  KEIN_SATZ_GRUND,
  ctReihe,
  fensterWort,
  preisFenster,
  preisKern,
  preisMarken,
  spanneWort,
} from './preisFenster';

/** 96 Viertelstunden mit einer Mulde mittags und einer Spitze abends. */
function tagesReihe(): number[] {
  return Array.from({ length: 96 }, (_, i) => {
    const h = i / 4;
    if (h >= 12 && h < 14.5) return -1; // die Gratis-Stunden
    if (h >= 18 && h < 20.5) return 21; // die Spitze
    return 12;
  });
}

/** Zeitstempel ab lokaler Mitternacht, 15-Minuten-Raster. */
function zeiten(n = 96): string[] {
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => new Date(d0.getTime() + i * 900_000).toISOString());
}

describe('spanneWort · das Fallenwort „Viertel" kommt nie vor', () => {
  it('benennt die Zeitspanne, nicht das Quartil', () => {
    expect(spanneWort(150)).toBe('2½ Stunden');
    expect(spanneWort(180)).toBe('3 Stunden');
    expect(spanneWort(60)).toBe('1 Stunde');
    expect(spanneWort(45)).toBe('45 Minuten');
  });

  it('nennt in KEINEM Fensterwort „Viertel"', () => {
    for (const art of ['guenstig', 'teuer', 'negativ'] as const) {
      expect(fensterWort(art, 10, 15)).not.toMatch(/Viertel/);
    }
  });
});

describe('preisFenster · zusammenhängend + benannt', () => {
  it('findet ein günstiges und ein teures Fenster, jedes als EIN Block', () => {
    const f = preisFenster(tagesReihe(), 15);
    const teuer = f.find((x) => x.art === 'teuer');
    expect(teuer).toBeTruthy();
    // 18:00-20:30 = Index 72..81; das 10-Slot-Fenster liegt vollständig darin.
    expect(teuer!.von).toBeGreaterThanOrEqual(72);
    expect(teuer!.bis).toBeLessThanOrEqual(81);
    expect(teuer!.bis - teuer!.von).toBe(9);
    expect(teuer!.wort).toBe('die teuersten 2½ Stunden');
  });

  it('lässt das Negativfenster das günstige ERSETZEN (nie zwei Bänder übereinander)', () => {
    const f = preisFenster(tagesReihe(), 15);
    expect(f.map((x) => x.art)).toContain('negativ');
    expect(f.map((x) => x.art)).not.toContain('guenstig');
    const neg = f.find((x) => x.art === 'negativ')!;
    expect(neg.von).toBe(48); // 12:00
    expect(neg.bis).toBe(57); // 14:15 (letzter Negativ-Slot)
    expect(neg.wort).toBe('Strom kostet nichts');
  });

  it('benennt ohne Negativpreise das günstige Fenster mit seiner Zeitspanne', () => {
    const reihe = tagesReihe().map((v) => (v < 0 ? 2 : v));
    const f = preisFenster(reihe, 15);
    const g = f.find((x) => x.art === 'guenstig');
    expect(g?.wort).toBe('die günstigsten 2½ Stunden');
    expect(f.some((x) => x.art === 'negativ')).toBe(false);
  });

  it('behauptet auf einem FLACHEN Tag gar nichts', () => {
    const flach = Array.from({ length: 96 }, (_, i) => 12 + (i % 3) * 0.5);
    expect(preisFenster(flach, 15)).toEqual([]);
  });

  it('behauptet ohne Preise nichts', () => {
    expect(preisFenster(new Array(96).fill(null), 15)).toEqual([]);
    expect(preisFenster([], 15)).toEqual([]);
  });

  it('benennt nichts, wenn ein Fenster den halben Zeitraum verschlucken würde', () => {
    // 12 Slots à 15 min = 3 h; ein 2½-h-Fenster wäre fast der ganze Zeitraum.
    const kurz = Array.from({ length: 12 }, (_, i) => (i < 6 ? 2 : 30));
    expect(preisFenster(kurz, 15)).toEqual([]);
  });

  it('überspringt einen Block mit Lücke, statt über sie hinweg zu mitteln', () => {
    const reihe: (number | null)[] = tagesReihe();
    reihe[50] = null; // mitten in der Gratis-Mulde
    const f = preisFenster(reihe, 15);
    for (const fenster of f) {
      for (let i = fenster.von; i <= fenster.bis; i++) {
        if (fenster.art !== 'negativ') expect(reihe[i]).not.toBeNull();
      }
    }
  });

  it('legt die zwei Fenster nie übereinander', () => {
    const f = preisFenster(tagesReihe(), 15);
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i];
        const b = f[j];
        expect(a.von <= b.bis && b.von <= a.bis).toBe(false);
      }
    }
  });
});

describe('preisMarken · höchstens zwei, jede mit Wort UND Zahl', () => {
  it('benennt Tief und Hoch', () => {
    const m = preisMarken(tagesReihe());
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ art: 'tief', text: 'gratis · -1,0 ct' });
    expect(m[1]).toMatchObject({ art: 'hoch', text: 'Hoch 21,0 ct' });
  });

  it('sagt bei positivem Tief „Tief", nicht „gratis"', () => {
    const m = preisMarken([5, 12, 30]);
    expect(m[0].text).toBe('Tief 5,0 ct');
  });

  it('markiert nichts, wenn Tief und Hoch derselbe Slot sind', () => {
    expect(preisMarken([7, null, null])).toEqual([]);
    expect(preisMarken([null, null])).toEqual([]);
  });
});

describe('preisKern · der Satz ist abgeleitet, sonst steht dort der Grund', () => {
  it('nennt Zeitraum und Aussage und hängt das Hoch als Anker an', () => {
    const cts = tagesReihe();
    const k = preisKern(cts, zeiten(), preisFenster(cts, 15));
    expect(k.satz).toMatch(/^Am günstigsten ist Strom zwischen 12:00 und 14:15 Uhr/);
    expect(k.satz).toMatch(/dann kostet er nichts\.$/);
    expect(k.anker).toMatch(/^Am teuersten um 18:00 Uhr mit 21,0 ct\.$/);
    expect(k.grund).toBeNull();
  });

  it('nennt ohne Negativpreise den mittleren Preis des günstigen Fensters', () => {
    const cts = tagesReihe().map((v) => (v < 0 ? 2 : v));
    const k = preisKern(cts, zeiten(), preisFenster(cts, 15));
    expect(k.satz).toMatch(/im Schnitt 2,0 ct\/kWh\.$/);
  });

  it('sagt bei flacher Kurve den GRUND statt eines erfundenen Satzes', () => {
    const flach = Array.from({ length: 96 }, () => 12);
    const k = preisKern(flach, zeiten(), preisFenster(flach, 15));
    expect(k.satz).toBeNull();
    expect(k.grund).toBe(FLACH_GRUND);
  });

  it('sagt ohne Preise den anderen Grund', () => {
    const leer = new Array(96).fill(null);
    const k = preisKern(leer, zeiten(), []);
    expect(k.satz).toBeNull();
    expect(k.grund).toBe(KEIN_SATZ_GRUND);
  });
});

describe('ctReihe · EUR/MWh ist die API-Einheit, ct/kWh die des Kunden', () => {
  it('rechnet um und lässt Lücken Lücken', () => {
    expect(ctReihe([120, null, -20, undefined])).toEqual([12, null, -2, null]);
  });
});
