import { describe, expect, it } from 'vitest';
import { anzeige, ausMinuten, imBereich, inMinuten, naechsteZeile, raster, zeitLesen } from './zeit';

describe('die Zeit wird TOLERANT gelesen - die Schreibweise darf nicht entscheiden', () => {
  it('nimmt jede übliche Schreibweise', () => {
    for (const [ein, aus] of [
      ['18:30', '18:30'],
      ['18.30', '18:30'],
      ['18 30', '18:30'],
      ['1830', '18:30'],
      ['830', '08:30'],
      ['18', '18:00'],
      ['8', '08:00'],
      ['08:05', '08:05'],
      ['18:5', '18:05'],
      ['  18:30  ', '18:30'],
      ['18:30 Uhr', '18:30'],
    ] as const) {
      expect(zeitLesen(ein)).toBe(aus);
    }
  });

  it('RÄT NICHT bei einer unklaren Eingabe', () => {
    for (const ein of ['', 'abends', '25:00', '18:60', '99', '1:2:3', '-1', '12345']) {
      expect(zeitLesen(ein)).toBeNull();
    }
  });

  it('kennt Mitternacht und die letzte Minute des Tages', () => {
    expect(zeitLesen('0')).toBe('00:00');
    expect(zeitLesen('2359')).toBe('23:59');
  });
});

describe('Minuten und Uhrzeit', () => {
  it('rechnen verlustfrei ineinander', () => {
    expect(inMinuten('18:30')).toBe(1110);
    expect(ausMinuten(1110)).toBe('18:30');
    expect(ausMinuten(0)).toBe('00:00');
  });

  it('nehmen 24:00 als Tagesende an - die Verbraucher-Fenster tragen es', () => {
    expect(inMinuten('24:00')).toBe(1440);
    expect(inMinuten('24:01')).toBeNull();
  });

  it('lehnen Unbrauchbares ab', () => {
    expect(inMinuten('abends')).toBeNull();
    expect(inMinuten('25:00')).toBeNull();
  });
});

describe('das Raster ist ein VORSCHLAG, keine Validierung', () => {
  it('legt Viertelstunden über den Tag', () => {
    const r = raster();
    expect(r[0]).toBe('00:00');
    expect(r[1]).toBe('00:15');
    expect(r[r.length - 1]).toBe('23:45');
    expect(r).toHaveLength(96);
  });

  it('folgt einem anderen Schritt und endet auf dessen letztem Punkt', () => {
    expect(raster(60)).toHaveLength(24);
    expect(raster(60).at(-1)).toBe('23:00');
    expect(raster(30)).toHaveLength(48);
    expect(raster(30)[1]).toBe('00:30');
  });

  it('bleibt in den Grenzen des Aufrufers', () => {
    const r = raster(60, '06:00', '09:00');
    expect(r).toEqual(['06:00', '07:00', '08:00', '09:00']);
  });

  it('bietet einen Rand an, der NICHT auf dem Raster liegt - er war ausdrücklich genannt', () => {
    expect(raster(60, '00:00', '24:00').at(-1)).toBe('00:00');
    expect(raster(15, '06:00', '06:50').at(-1)).toBe('06:50');
  });

  it('ändert NICHT, welche Werte ein Formular annimmt', () => {
    // Ein Wert neben dem Raster bleibt gültig - das ist die ganze Zusage.
    expect(zeitLesen('06:07')).toBe('06:07');
    expect(raster()).not.toContain('06:07');
  });
});

describe('Grenzen und Anzeige', () => {
  it('vergleicht lexikografisch - `HH:MM` ist dafür gebaut', () => {
    expect(imBereich('06:00', '06:00', '22:00')).toBe(true);
    expect(imBereich('05:59', '06:00', null)).toBe(false);
    expect(imBereich('22:01', null, '22:00')).toBe(false);
  });

  it('sagt „Uhr" dazu - ein nacktes 18:30 könnte auch ein Zeitraum sein', () => {
    expect(anzeige('18:30')).toBe('18:30 Uhr');
    expect(anzeige('quatsch')).toBeNull();
  });
});

describe('die Liste holt den passenden Eintrag ins Bild', () => {
  it('findet den nächstgelegenen, auch neben dem Raster', () => {
    const r = raster();
    expect(r[naechsteZeile(r, '06:00')]).toBe('06:00');
    expect(r[naechsteZeile(r, '06:07')]).toBe('06:00');
    expect(r[naechsteZeile(r, '06:08')]).toBe('06:15');
  });

  it('behauptet nichts ohne brauchbaren Wert', () => {
    expect(naechsteZeile(raster(), 'quatsch')).toBe(-1);
    expect(naechsteZeile([], '06:00')).toBe(-1);
  });
});
