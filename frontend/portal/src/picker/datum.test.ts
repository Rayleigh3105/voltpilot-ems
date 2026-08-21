import { describe, expect, it } from 'vitest';
import {
  anzeige,
  blaettern,
  datumVon,
  imBereich,
  isoMonat,
  isoTag,
  isoWoche,
  kwNummer,
  monatsGitter,
  monatsTitel,
  montagDerWoche,
  tagWaehlbar,
  verschiebe,
  wertVon,
  WOCHENTAGE,
} from './datum';

const tag = (iso: string) => datumVon(iso, 'tag')!;

describe('die Woche beginnt am MONTAG', () => {
  it('sagt es schon in der Kopfzeile', () => {
    expect(WOCHENTAGE[0]).toBe('Mo');
    expect(WOCHENTAGE[6]).toBe('So');
  });

  it('holt den Montag jeder Woche - auch von einem Sonntag aus', () => {
    // 2026-08-23 ist ein Sonntag, sein Montag ist der 17.
    expect(isoTag(montagDerWoche(tag('2026-08-23')))).toBe('2026-08-17');
    expect(isoTag(montagDerWoche(tag('2026-08-17')))).toBe('2026-08-17');
  });
});

describe('die Kalenderwoche rechnet über den DONNERSTAG (ISO 8601)', () => {
  it('legt einen Januar-Tag in die letzte Woche des VORJAHRES', () => {
    // Der 1.1.2027 ist ein Freitag -> KW 53 von 2026.
    expect(isoWoche(tag('2027-01-01'))).toBe('2026-W53');
  });

  it('legt einen Dezember-Tag in die erste Woche des FOLGEJAHRES', () => {
    // Der 31.12.2024 ist ein Dienstag -> KW 1 von 2025.
    expect(isoWoche(tag('2024-12-31'))).toBe('2025-W01');
  });

  it('nummeriert die Wochen fortlaufend', () => {
    expect(kwNummer(tag('2026-08-21'))).toBe(34);
  });
});

describe('Wert und Datum sind verlustfrei ineinander überführbar', () => {
  it('Tag', () => {
    expect(wertVon(tag('2026-08-21'), 'tag')).toBe('2026-08-21');
    expect(isoTag(datumVon('2026-08-21', 'tag')!)).toBe('2026-08-21');
  });

  it('Monat', () => {
    expect(wertVon(tag('2026-08-21'), 'monat')).toBe('2026-08');
    expect(isoMonat(datumVon('2026-08', 'monat')!)).toBe('2026-08');
  });

  it('Woche - der Wert zeigt auf den Montag zurück', () => {
    expect(wertVon(tag('2026-08-21'), 'woche')).toBe('2026-W34');
    expect(isoTag(montagDerWoche(datumVon('2026-W34', 'woche')!))).toBe('2026-08-17');
  });

  it('nimmt eine unbrauchbare Eingabe NICHT an, statt zu raten', () => {
    for (const [w, a] of [
      ['', 'tag'],
      ['2026-13-01', 'tag'],
      ['2026-02-30', 'tag'],
      ['21.08.2026', 'tag'],
      ['2026-13', 'monat'],
      ['2026-W00', 'woche'],
      ['2026-W54', 'woche'],
    ] as const) {
      expect(datumVon(w, a)).toBeNull();
    }
  });

  it('lehnt eine 53. Woche ab, die es in diesem Jahr nicht gibt', () => {
    // 2025 hat 52 Wochen.
    expect(datumVon('2025-W53', 'woche')).toBeNull();
    expect(datumVon('2026-W53', 'woche')).not.toBeNull();
  });
});

describe('das Kalendergitter', () => {
  const g = monatsGitter(2026, 7); // August 2026

  it('hat IMMER sechs Zeilen - sonst springt das Panel beim Blättern', () => {
    expect(g).toHaveLength(6);
    expect(monatsGitter(2026, 1)).toHaveLength(6);
    expect(g.every((w) => w.tage.length === 7)).toBe(true);
  });

  it('beginnt am Montag VOR dem Monatsersten', () => {
    // Der 1.8.2026 ist ein Samstag -> die erste Zeile beginnt am 27.7.
    expect(g[0].tage[0].iso).toBe('2026-07-27');
    expect(g[0].tage[0].imMonat).toBe(false);
    expect(g[0].tage[5].iso).toBe('2026-08-01');
    expect(g[0].tage[5].imMonat).toBe(true);
  });

  it('trägt je Zeile ihre Kalenderwoche', () => {
    expect(g[0].kw).toBe(31);
    expect(g[0].woche).toBe('2026-W31');
  });

  it('benennt den Monat deutsch', () => {
    expect(monatsTitel(2026, 7)).toBe('August 2026');
  });
});

describe('die ANZEIGE ist deutsch, der WERT bleibt ISO', () => {
  it('Tag', () => {
    expect(anzeige('2026-08-21', 'tag')).toBe('21.08.2026');
  });

  it('Monat', () => {
    expect(anzeige('2026-08', 'monat')).toBe('August 2026');
  });

  it('Woche - mit ihrer Nummer UND ihrer Spanne', () => {
    expect(anzeige('2026-W34', 'woche')).toBe('KW 34 · 17.08.–23.08.2026');
  });

  it('behauptet nichts über einen unbrauchbaren Wert', () => {
    expect(anzeige('quatsch', 'tag')).toBeNull();
    expect(anzeige('', 'tag')).toBeNull();
  });
});

describe('die Grenzen', () => {
  it('vergleicht auf der Art des Wertes', () => {
    expect(imBereich('2026-08-21', '2026-01-01', '2026-12-31')).toBe(true);
    expect(imBereich('2025-12-31', '2026-01-01', null)).toBe(false);
    expect(imBereich('2027-01-01', null, '2026-12-31')).toBe(false);
  });

  it('urteilt über einen TAG in der Art, die gewählt wird', () => {
    // Ein Tag im August ist wählbar, wenn der MONAT August erlaubt ist -
    // auch wenn er selbst nach der Tages-Grenze läge.
    expect(tagWaehlbar('2026-08-31', 'monat', null, '2026-08')).toBe(true);
    expect(tagWaehlbar('2026-09-01', 'monat', null, '2026-08')).toBe(false);
  });

  it('lehnt einen unbrauchbaren Tag ab', () => {
    expect(tagWaehlbar('quatsch', 'tag')).toBe(false);
  });
});

describe('das Blättern und die Pfeiltasten', () => {
  it('blättert über den Jahreswechsel', () => {
    expect(blaettern(2026, 0, -1)).toEqual([2025, 11]);
    expect(blaettern(2026, 11, 1)).toEqual([2027, 0]);
  });

  it('bewegt sich um Tage und Wochen', () => {
    expect(verschiebe('2026-08-21', 1)).toBe('2026-08-22');
    expect(verschiebe('2026-08-21', -7)).toBe('2026-08-14');
    expect(verschiebe('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('klemmt einen Monatssprung auf den letzten Tag, statt überzulaufen', () => {
    // Der 31. März minus einen Monat wäre sonst der 3. März.
    expect(verschiebe('2026-03-31', 0, -1)).toBe('2026-02-28');
    expect(verschiebe('2026-01-31', 0, 1)).toBe('2026-02-28');
  });

  it('lässt einen unbrauchbaren Wert unverändert, statt zu raten', () => {
    expect(verschiebe('quatsch', 1)).toBe('quatsch');
  });
});

describe('die Sommerzeit kann keinen Tag kippen', () => {
  it('hält den Anker mittags über beide Umstellungen', () => {
    // 29.03.2026 (Beginn) und 25.10.2026 (Ende) - beide Male muss der Wert
    // exakt zurückkommen.
    for (const iso of ['2026-03-29', '2026-10-25']) {
      expect(wertVon(datumVon(iso, 'tag')!, 'tag')).toBe(iso);
      expect(verschiebe(iso, 1)).toBe(isoTag(new Date(
        Number(iso.slice(0, 4)),
        Number(iso.slice(5, 7)) - 1,
        Number(iso.slice(8, 10)) + 1,
        12,
      )));
    }
  });
});
