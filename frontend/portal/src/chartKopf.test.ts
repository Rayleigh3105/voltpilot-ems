import { describe, expect, it } from 'vitest';
import {
  DIRECT_LABEL_MAX_SERIES,
  DIRECT_LABEL_MIN_PX,
  endsCollide,
  kopfView,
  useDirectLabels,
  type Kernaussage,
} from './chartKopf';

/**
 * K1 ist die Regel mit dem grössten Umsetzungsrisiko (r2 §10): ein falsch
 * abgeleiteter Satz wäre schlimmer als kein Satz. Diese Suite nagelt deshalb
 * vor allem fest, was der Kopf NICHT tut.
 */
describe('kopfView (K1/M11 · der Kernaussage-Kopf)', () => {
  const voll: Kernaussage = {
    wert: '9,84 €',
    satz: 'Mittags laden, abends verkaufen (17–20 Uhr).',
    grund: null,
    ton: 'ok',
    anker: 'Ohne Speicher wären es 3,10 €.',
  };

  it('zeigt Zahl, Satz und Vergleichsanker, wenn es sie gibt', () => {
    expect(kopfView(voll)).toEqual({
      modus: 'aussage',
      wert: '9,84 €',
      text: 'Mittags laden, abends verkaufen (17–20 Uhr).',
      anker: 'Ohne Speicher wären es 3,10 €.',
      // Das BESTANDSKONTO ist optional: ohne Angabe wird nichts behauptet.
      bestand: null,
      ton: 'ok',
    });
  });

  it('reicht die Bestandszeile durch — aber nur, wo es auch einen Satz gibt', () => {
    const bestand = {
      text: 'dazu 44,2 kWh im Speicher für später — nach dem Plan ≈ +8,35 €',
      badge: 'Geplant',
      titel: 'Bewertet mit dem Speicherwert dieser Viertelstunde.',
    };
    expect(kopfView({ ...voll, bestand }).bestand).toEqual(bestand);
    // Ohne Kasse daneben wäre ein Bestand eine Aussage ohne ihren Bezug.
    expect(
      kopfView({ ...voll, satz: null, grund: 'Noch nicht berechenbar.', bestand }).bestand,
    ).toBeNull();
  });

  it('sagt ohne Satz den GRUND - und lässt die Zahl dann weg', () => {
    const v = kopfView({ ...voll, satz: null, grund: 'Für heute liegt noch kein Fahrplan vor.' });
    expect(v.modus).toBe('grund');
    expect(v.text).toBe('Für heute liegt noch kein Fahrplan vor.');
    // Eine Zahl neben einem Grund läse sich, als belege sie ihn.
    expect(v.wert).toBeNull();
    expect(v.anker).toBeNull();
  });

  it('rendert GAR NICHTS, wenn weder Satz noch Grund da sind - nie ein nacktes „—"', () => {
    expect(kopfView({ wert: '9,84 €', satz: null, grund: null, ton: 'ok' }).modus).toBe('nichts');
    expect(kopfView(null).modus).toBe('nichts');
    expect(kopfView(undefined).modus).toBe('nichts');
  });

  it('behandelt einen leeren/whitespace-Satz wie einen fehlenden', () => {
    expect(kopfView({ ...voll, satz: '   ', grund: 'Noch kein Fahrplan.' }).modus).toBe('grund');
    // Leerer Satz UND leerer Grund: der Kopf schweigt, statt „—" hinzustellen.
    expect(kopfView({ ...voll, satz: '', grund: '  ' }).modus).toBe('nichts');
  });

  it('lässt einen fehlenden Anker weg, statt ihn zu erfinden', () => {
    expect(kopfView({ ...voll, anker: null }).anker).toBeNull();
    expect(kopfView({ ...voll, anker: undefined }).anker).toBeNull();
  });

  it('reicht den Ton durch - er entscheidet nur die Farbe der Zahl', () => {
    expect(kopfView({ ...voll, ton: 'warn' }).ton).toBe('warn');
    expect(kopfView({ ...voll, ton: 'calm' }).ton).toBe('calm');
  });
});

describe('useDirectLabels (K2/M12 · wann direkt beschriftet wird)', () => {
  const breit = DIRECT_LABEL_MIN_PX + 100;

  it('beschriftet die drei Reihen des Grundzustands direkt', () => {
    expect(useDirectLabels(3, breit)).toBe(true);
  });

  it('fällt ab fünf Reihen auf die Legende zurück (K2 nennt genau diese Grenze)', () => {
    expect(useDirectLabels(DIRECT_LABEL_MAX_SERIES, breit)).toBe(true);
    expect(useDirectLabels(DIRECT_LABEL_MAX_SERIES + 1, breit)).toBe(false);
  });

  it('fällt bei zusammenfallenden Kurvenenden auf die Legende zurück', () => {
    expect(useDirectLabels(3, breit, true)).toBe(false);
  });

  it('beschriftet am Telefon nicht - dort ist rechts kein Rand (K11)', () => {
    expect(useDirectLabels(3, DIRECT_LABEL_MIN_PX - 1)).toBe(false);
  });

  it('beschriftet nichts, wenn es nichts zu beschriften gibt', () => {
    expect(useDirectLabels(0, breit)).toBe(false);
  });
});

describe('endsCollide (die Kollisionsprüfung im Werte-Raum)', () => {
  it('meldet eine Kollision, sobald zwei Enden zu nah beieinander liegen', () => {
    // Spannweite 10, Abstand 0,2 = 2 % - deutlich unter dem Mindestabstand.
    expect(endsCollide([4, 4.2], 10)).toBe(true);
  });

  it('meldet KEINE Kollision bei sauber getrennten Enden', () => {
    expect(endsCollide([1, 5, 9], 10)).toBe(false);
  });

  it('braucht mindestens zwei bekannte Enden und eine echte Spannweite', () => {
    expect(endsCollide([4], 10)).toBe(false);
    expect(endsCollide([4, null], 10)).toBe(false);
    // Eine Achse ohne Spannweite kann nichts trennen - dann wird auch nichts
    // behauptet (lieber beschriften als eine erfundene Kollision).
    expect(endsCollide([4, 4], 0)).toBe(false);
  });

  it('ignoriert fehlende Werte, statt sie als 0 zu lesen', () => {
    expect(endsCollide([null, 1, null, 9], 10)).toBe(false);
  });
});
