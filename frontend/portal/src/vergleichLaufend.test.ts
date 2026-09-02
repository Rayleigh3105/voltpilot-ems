import { describe, expect, it } from 'vitest';
import { delta } from './historieVergleich';
import {
  berlinStunde,
  erloesVergleich,
  summeBisStunde,
  vergleichBisStunde,
  vollerVergleichsName,
  type VergleichsEimer,
} from './vergleichLaufend';

/**
 * P2 · „Vergleich gleicher Zeitpunkt" (Erlöse-Konzept
 * `data/vp-erloese-seite-konzept-e2` §3.7, E3 = a, Befund B3).
 *
 * **Die Vektoren sind die Fixtures des Konzepts** (`derived.json`,
 * `dv-tag-laufend` / `dv-tag-abgeschlossen` und `eeg-tag-laufend` /
 * `eeg-tag-abgeschlossen`): dieselben Stunden-Eimer, mit denen die Mockups
 * gerechnet wurden.
 *
 * **⚠ Eine bewusste Abweichung von `derived.json`:** dessen `neu.vergleich`
 * wurde mit `new Date(b.start).getHours()` erzeugt, also in der Zone der
 * MASCHINE (dort Europe/London) — daher steht darin „Bis 11 Uhr · 50,90 €"
 * statt der Berliner Wahrheit „Bis 12 Uhr · 50,66 €", und der erste Eimer
 * (22:00Z = 23 Uhr London) fiel aus der Summe. Der PROZENTSATZ ist in beiden
 * Lesarten derselbe (25 % bzw. 24 %), und der Auftrag nennt selbst „bis 14 Uhr"
 * für den 14:05-Fall — die Zone ist hier Europe/Berlin, wie überall im Portal.
 */

// --- Fixtures aus `derived.json` -------------------------------------------

/** `dv-tag-laufend` — Mi., 02.09.2026, Stand 12:19 (13 Stunden-Eimer). */
const DV_HEUTE: VergleichsEimer[] = [
  { start: '2026-09-01T22:00:00.000Z', nettoEur: -0.243 },
  { start: '2026-09-01T23:00:00.000Z', nettoEur: -0.243 },
  { start: '2026-09-02T00:00:00.000Z', nettoEur: -0.243 },
  { start: '2026-09-02T01:00:00.000Z', nettoEur: -0.243 },
  { start: '2026-09-02T02:00:00.000Z', nettoEur: -0.243 },
  { start: '2026-09-02T03:00:00.000Z', nettoEur: 0.574 },
  { start: '2026-09-02T04:00:00.000Z', nettoEur: 2.397 },
  { start: '2026-09-02T05:00:00.000Z', nettoEur: 5.478 },
  { start: '2026-09-02T06:00:00.000Z', nettoEur: 8.321 },
  { start: '2026-09-02T07:00:00.000Z', nettoEur: 10.446 },
  { start: '2026-09-02T08:00:00.000Z', nettoEur: 12.088 },
  { start: '2026-09-02T09:00:00.000Z', nettoEur: 12.57 },
  { start: '2026-09-02T10:00:00.000Z', nettoEur: 12.574 },
];
/** `dv-tag-laufend.money.nettoErgebnisEur` — das Ergebnis des halben Tages. */
const DV_HEUTE_NETTO = 63.233;

/** `dv-tag-abgeschlossen` — Di., 01.09.2026, voll (24 Stunden-Eimer). */
const DV_VORTAG: VergleichsEimer[] = [
  { start: '2026-08-31T22:00:00.000Z', nettoEur: -0.143 },
  { start: '2026-08-31T23:00:00.000Z', nettoEur: -0.143 },
  { start: '2026-09-01T00:00:00.000Z', nettoEur: -0.143 },
  { start: '2026-09-01T01:00:00.000Z', nettoEur: -0.143 },
  { start: '2026-09-01T02:00:00.000Z', nettoEur: -0.143 },
  { start: '2026-09-01T03:00:00.000Z', nettoEur: 0.789 },
  { start: '2026-09-01T04:00:00.000Z', nettoEur: 2.97 },
  { start: '2026-09-01T05:00:00.000Z', nettoEur: 6.846 },
  { start: '2026-09-01T06:00:00.000Z', nettoEur: 10.731 },
  { start: '2026-09-01T07:00:00.000Z', nettoEur: 13.839 },
  { start: '2026-09-01T08:00:00.000Z', nettoEur: 16.162 },
  { start: '2026-09-01T09:00:00.000Z', nettoEur: 16.948 },
  { start: '2026-09-01T10:00:00.000Z', nettoEur: 16.948 },
  { start: '2026-09-01T11:00:00.000Z', nettoEur: 15.41 },
  { start: '2026-09-01T12:00:00.000Z', nettoEur: 13.087 },
  { start: '2026-09-01T13:00:00.000Z', nettoEur: 9.969 },
  { start: '2026-09-01T14:00:00.000Z', nettoEur: 6.083 },
  { start: '2026-09-01T15:00:00.000Z', nettoEur: 2.201 },
  { start: '2026-09-01T16:00:00.000Z', nettoEur: 0.578 },
  { start: '2026-09-01T17:00:00.000Z', nettoEur: -0.115 },
  { start: '2026-09-01T18:00:00.000Z', nettoEur: -0.145 },
  { start: '2026-09-01T19:00:00.000Z', nettoEur: -0.148 },
  { start: '2026-09-01T20:00:00.000Z', nettoEur: -0.15 },
  { start: '2026-09-01T21:00:00.000Z', nettoEur: -0.151 },
];
/** `dv-tag-abgeschlossen.money.nettoErgebnisEur`. */
const DV_VORTAG_NETTO = 135.224;

/** `eeg-tag-laufend` — Mi., 02.09.2026, Stand 14:05 (15 Stunden-Eimer). */
const EEG_HEUTE: VergleichsEimer[] = [
  { start: '2026-09-01T22:00:00.000Z', nettoEur: -0.065 },
  { start: '2026-09-01T23:00:00.000Z', nettoEur: -0.065 },
  { start: '2026-09-02T00:00:00.000Z', nettoEur: -0.065 },
  { start: '2026-09-02T01:00:00.000Z', nettoEur: -0.065 },
  { start: '2026-09-02T02:00:00.000Z', nettoEur: -0.065 },
  { start: '2026-09-02T03:00:00.000Z', nettoEur: -0.002 },
  { start: '2026-09-02T04:00:00.000Z', nettoEur: 0.129 },
  { start: '2026-09-02T05:00:00.000Z', nettoEur: 0.327 },
  { start: '2026-09-02T06:00:00.000Z', nettoEur: 0.485 },
  { start: '2026-09-02T07:00:00.000Z', nettoEur: 0.586 },
  { start: '2026-09-02T08:00:00.000Z', nettoEur: 0.669 },
  { start: '2026-09-02T09:00:00.000Z', nettoEur: 0.686 },
  { start: '2026-09-02T10:00:00.000Z', nettoEur: 0.686 },
  { start: '2026-09-02T11:00:00.000Z', nettoEur: 0.621 },
  { start: '2026-09-02T12:00:00.000Z', nettoEur: 0.538 },
];
const EEG_HEUTE_NETTO = 4.4;

/** `eeg-tag-abgeschlossen` — Di., 01.09.2026, voll. */
const EEG_VORTAG: VergleichsEimer[] = [
  { start: '2026-08-31T22:00:00.000Z', nettoEur: -0.084 },
  { start: '2026-08-31T23:00:00.000Z', nettoEur: -0.084 },
  { start: '2026-09-01T00:00:00.000Z', nettoEur: -0.084 },
  { start: '2026-09-01T01:00:00.000Z', nettoEur: -0.084 },
  { start: '2026-09-01T02:00:00.000Z', nettoEur: -0.084 },
  { start: '2026-09-01T03:00:00.000Z', nettoEur: -0.003 },
  { start: '2026-09-01T04:00:00.000Z', nettoEur: 0.167 },
  { start: '2026-09-01T05:00:00.000Z', nettoEur: 0.427 },
  { start: '2026-09-01T06:00:00.000Z', nettoEur: 0.635 },
  { start: '2026-09-01T07:00:00.000Z', nettoEur: 0.768 },
  { start: '2026-09-01T08:00:00.000Z', nettoEur: 0.877 },
  { start: '2026-09-01T09:00:00.000Z', nettoEur: 0.901 },
  { start: '2026-09-01T10:00:00.000Z', nettoEur: 0.901 },
  { start: '2026-09-01T11:00:00.000Z', nettoEur: 0.815 },
  { start: '2026-09-01T12:00:00.000Z', nettoEur: 0.706 },
  { start: '2026-09-01T13:00:00.000Z', nettoEur: 0.568 },
  { start: '2026-09-01T14:00:00.000Z', nettoEur: 0.351 },
  { start: '2026-09-01T15:00:00.000Z', nettoEur: 0.132 },
  { start: '2026-09-01T16:00:00.000Z', nettoEur: 0.033 },
  { start: '2026-09-01T17:00:00.000Z', nettoEur: -0.061 },
  { start: '2026-09-01T18:00:00.000Z', nettoEur: -0.083 },
  { start: '2026-09-01T19:00:00.000Z', nettoEur: -0.085 },
  { start: '2026-09-01T20:00:00.000Z', nettoEur: -0.086 },
  { start: '2026-09-01T21:00:00.000Z', nettoEur: -0.087 },
];
const EEG_VORTAG_NETTO = 6.603;

const NBSP = ' ';

// --- Die Stunde ------------------------------------------------------------

describe('berlinStunde', () => {
  it('liest die Berliner Wanduhr, nicht die des Browsers', () => {
    // Der Testlauf steht in Europe/London: `getHours()` gäbe hier 23 bzw. 11.
    expect(berlinStunde('2026-09-01T22:00:00.000Z')).toBe(0);
    expect(berlinStunde('2026-09-02T10:00:00.000Z')).toBe(12);
    expect(berlinStunde(new Date('2026-09-02T12:19:00+02:00'))).toBe(12);
  });

  it('bildet die Zeitumstellung ab: im März fehlt die 2, im Oktober gibt es sie zweimal', () => {
    expect(berlinStunde('2026-03-29T00:00:00Z')).toBe(1);
    expect(berlinStunde('2026-03-29T01:00:00Z')).toBe(3);
    expect(berlinStunde('2026-10-25T00:00:00Z')).toBe(2);
    expect(berlinStunde('2026-10-25T01:00:00Z')).toBe(2);
  });

  it('behauptet nichts über einen kaputten Zeitstempel', () => {
    expect(berlinStunde('kein Datum')).toBeNull();
    expect(berlinStunde(null)).toBeNull();
  });
});

describe('summeBisStunde', () => {
  it('summiert nur abgeschlossene Stunden und lässt die laufende draußen', () => {
    // 12 Eimer (Berliner Stunden 0…11) — der 13. ist die laufende Stunde 12.
    expect(summeBisStunde(DV_HEUTE, 12)).toBeCloseTo(50.659, 3);
    expect(summeBisStunde(DV_HEUTE, 13)).toBeCloseTo(63.233, 3);
  });

  it('ist null ohne Grundlage — nie eine erfundene 0', () => {
    expect(summeBisStunde(DV_HEUTE, 0)).toBeNull();
    expect(summeBisStunde([], 12)).toBeNull();
    expect(summeBisStunde(null, 12)).toBeNull();
    expect(summeBisStunde([{ start: '2026-09-02T00:00:00Z', nettoEur: null }], 12)).toBeNull();
  });
});

// --- Der Kern: L4 --------------------------------------------------------------

describe('L4 · der laufende Tag rechnet gegen die GLEICHE Stunde des Vortags', () => {
  const now = new Date('2026-09-02T12:19:00+02:00');
  const anchor = new Date('2026-09-02T12:19:00+02:00');

  it('IST-Zustand (der Befund B3): der volle Vortag ergibt „53 % weniger" und wertet rot', () => {
    // Nicht vakuum: das ist der Vergleich, den die Karte heute rechnet.
    const alt = delta(DV_HEUTE_NETTO, DV_VORTAG_NETTO, true, 'dem Vortag');
    expect(alt?.text).toBe('53 % weniger als am Vortag');
    expect(alt?.wertung).toBe('schlecht');
  });

  it('um 12 Uhr KEIN „53 % weniger", sondern 25 % gegen den Vortag bis 12 Uhr', () => {
    const v = erloesVergleich({
      range: 'day',
      anchor,
      now,
      jetztEur: DV_HEUTE_NETTO,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: DV_HEUTE,
      vorherSeries: DV_VORTAG,
    })!;
    expect(v.modus).toBe('gleicher_zeitpunkt');
    expect(v.bisStunde).toBe(12);
    expect(v.jetztEur).toBeCloseTo(50.659, 3);
    expect(v.vorherEur).toBeCloseTo(67.57, 3);
    expect(v.chip?.text).toBe('25 % weniger');
    expect(v.chip?.text).not.toContain('53');
  });

  it('wertet einen laufenden Tag NICHT — die Richtung ist die Tatsache, der Ton wäre eine Behauptung', () => {
    const v = erloesVergleich({
      range: 'day',
      anchor,
      now,
      jetztEur: DV_HEUTE_NETTO,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: DV_HEUTE,
      vorherSeries: DV_VORTAG,
    })!;
    expect(v.chip?.wertung).toBe('neutral');
    expect(v.chip?.richtung).toBe('weniger');
  });

  it('nennt beide Beträge und erklärt den Schnitt (Ebene 1)', () => {
    const v = erloesVergleich({
      range: 'day',
      anchor,
      now,
      jetztEur: DV_HEUTE_NETTO,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: DV_HEUTE,
      vorherSeries: DV_VORTAG,
    })!;
    expect(v.betraege).toBe(`Bis 12 Uhr: heute 50,66${NBSP}€ · gestern 67,57${NBSP}€`);
    expect(v.satz).toBe(
      'Verglichen wird bis 12 Uhr — der Vortag ebenfalls bis 12 Uhr; die laufende Stunde bleibt bei beiden draußen.',
    );
  });

  it('EEG-Anlage um 14:05: 24 % gegen den Vortag bis 14 Uhr (statt 33 % gegen den ganzen Tag)', () => {
    const jetzt = new Date('2026-09-02T14:05:00+02:00');
    expect(delta(EEG_HEUTE_NETTO, EEG_VORTAG_NETTO, true, 'dem Vortag')?.text).toBe(
      '33 % weniger als am Vortag',
    );
    const v = erloesVergleich({
      range: 'day',
      anchor: jetzt,
      now: jetzt,
      jetztEur: EEG_HEUTE_NETTO,
      vorherEur: EEG_VORTAG_NETTO,
      jetztSeries: EEG_HEUTE,
      vorherSeries: EEG_VORTAG,
    })!;
    expect(v.bisStunde).toBe(14);
    expect(v.chip?.text).toBe('24 % weniger');
    expect(v.betraege).toBe(`Bis 14 Uhr: heute 3,86${NBSP}€ · gestern 5,07${NBSP}€`);
  });
});

// --- Zeitumstellung --------------------------------------------------------

/** Eimer aus Berliner Stunden bauen — die UTC-Starts sind Kalender-Tatsachen. */
const eimer = (starts: string[], wert = 1): VergleichsEimer[] =>
  starts.map((start) => ({ start, nettoEur: wert }));

describe('Zeitumstellung — verglichen wird der `start`, nie der Index', () => {
  it('letzter Sonntag im März (23 Stunden): der Tag hat vor 12 Uhr eine Stunde WENIGER', () => {
    // 29.03.2026: 00, 01, dann 03…11 (die 2 gibt es nicht) = 11 Eimer vor 12.
    const heute = eimer([
      '2026-03-28T23:00:00Z', // 00 Uhr CET
      '2026-03-29T00:00:00Z', // 01 Uhr CET
      '2026-03-29T01:00:00Z', // 03 Uhr CEST — die 2 fehlt
      '2026-03-29T02:00:00Z',
      '2026-03-29T03:00:00Z',
      '2026-03-29T04:00:00Z',
      '2026-03-29T05:00:00Z',
      '2026-03-29T06:00:00Z',
      '2026-03-29T07:00:00Z',
      '2026-03-29T08:00:00Z',
      '2026-03-29T09:00:00Z', // 11 Uhr
      '2026-03-29T10:00:00Z', // 12 Uhr — die laufende Stunde
    ]);
    // 28.03.2026 ist ein normaler CET-Tag: Stunde h = UTC (h−1), also 00…12.
    const vortag = eimer([
      '2026-03-27T23:00:00Z', // 00 Uhr CET
      '2026-03-28T00:00:00Z',
      '2026-03-28T01:00:00Z', // 02 Uhr — die es heute nicht gibt
      '2026-03-28T02:00:00Z',
      '2026-03-28T03:00:00Z',
      '2026-03-28T04:00:00Z',
      '2026-03-28T05:00:00Z',
      '2026-03-28T06:00:00Z',
      '2026-03-28T07:00:00Z',
      '2026-03-28T08:00:00Z',
      '2026-03-28T09:00:00Z',
      '2026-03-28T10:00:00Z', // 11 Uhr
      '2026-03-28T11:00:00Z', // 12 Uhr — die laufende Stunde
    ]);
    const now = new Date('2026-03-29T12:00:00+02:00');
    const v = vergleichBisStunde(heute, vortag, now)!;
    expect(v.bisStunde).toBe(12);
    expect(v.jetztEur).toBe(11); // 11 abgeschlossene Stunden
    expect(v.vorherEur).toBe(12); // 12 abgeschlossene Stunden
    expect(v.delta?.richtung).toBe('weniger');
    expect(v.delta?.pct).toBe(8);
    // Über den INDEX gerechnet wären es 12 gegen 12 gewesen — also „etwa wie",
    // und die fehlende Stunde verschwände lautlos.
    expect(heute.slice(0, 12).length).toBe(vortag.slice(0, 12).length);
  });

  it('letzter Sonntag im Oktober (25 Stunden): die 2 zählt zweimal', () => {
    // 25.10.2026: 00, 01, 02 (CEST), 02 (CET), 03…11 = 13 Eimer vor 12.
    const heute = eimer([
      '2026-10-24T22:00:00Z', // 00 Uhr CEST
      '2026-10-24T23:00:00Z', // 01 Uhr CEST
      '2026-10-25T00:00:00Z', // 02 Uhr CEST
      '2026-10-25T01:00:00Z', // 02 Uhr CET — dieselbe Wanduhr-Stunde
      '2026-10-25T02:00:00Z', // 03 Uhr CET
      '2026-10-25T03:00:00Z',
      '2026-10-25T04:00:00Z',
      '2026-10-25T05:00:00Z',
      '2026-10-25T06:00:00Z',
      '2026-10-25T07:00:00Z',
      '2026-10-25T08:00:00Z',
      '2026-10-25T09:00:00Z',
      '2026-10-25T10:00:00Z', // 11 Uhr
      '2026-10-25T11:00:00Z', // 12 Uhr — die laufende Stunde
    ]);
    // 24.10.2026 ist ein normaler CEST-Tag: Stunde h = UTC (h−2).
    const vortag = eimer([
      '2026-10-23T22:00:00Z',
      '2026-10-23T23:00:00Z',
      '2026-10-24T00:00:00Z',
      '2026-10-24T01:00:00Z',
      '2026-10-24T02:00:00Z',
      '2026-10-24T03:00:00Z',
      '2026-10-24T04:00:00Z',
      '2026-10-24T05:00:00Z',
      '2026-10-24T06:00:00Z',
      '2026-10-24T07:00:00Z',
      '2026-10-24T08:00:00Z',
      '2026-10-24T09:00:00Z',
      '2026-10-24T10:00:00Z',
    ]);
    const now = new Date('2026-10-25T12:00:00+01:00');
    const v = vergleichBisStunde(heute, vortag, now)!;
    expect(v.bisStunde).toBe(12);
    expect(v.jetztEur).toBe(13); // die doppelte 2 zählt mit
    expect(v.vorherEur).toBe(12);
    expect(v.delta?.richtung).toBe('mehr');
    expect(v.delta?.pct).toBe(8);
  });
});

// --- Laufende Woche / Monat / Jahr -----------------------------------------

describe('laufende Woche / Monat / Jahr — zwei Beträge, KEIN Prozent', () => {
  const now = new Date('2026-09-02T14:05:00+02:00');

  it('Woche: „bisher … · ganze Vorwoche …" ohne Wertung', () => {
    const v = erloesVergleich({
      range: 'week',
      anchor: now,
      now,
      jetztEur: 39.3,
      vorherEur: 41.1,
    })!;
    expect(v.modus).toBe('nur_betraege');
    expect(v.chip).toBeNull();
    expect(v.betraege).toBe(`bisher 39,30${NBSP}€ · ganze Vorwoche 41,10${NBSP}€`);
    expect(v.satz).toContain('läuft noch');
  });

  it('Monat und Jahr ebenso — die Vorperiode kann kürzer sein, ein Prozent wäre eine Behauptung', () => {
    const monat = erloesVergleich({ range: 'month', anchor: now, now, jetztEur: 63.2, vorherEur: 192.7 })!;
    expect(monat.chip).toBeNull();
    expect(monat.betraege).toBe(`bisher 63,20${NBSP}€ · ganzer August 192,70${NBSP}€`);
    const jahr = erloesVergleich({ range: 'year', anchor: now, now, jetztEur: 1080.3, vorherEur: 1500 })!;
    expect(jahr.chip).toBeNull();
    expect(jahr.betraege).toBe(`bisher 1.080,30${NBSP}€ · ganzes Jahr 2025 1.500,00${NBSP}€`);
  });

  it('ein laufender Tag OHNE Stunden-Eimer fällt auf denselben Anker zurück, nie auf ein Prozent', () => {
    const v = erloesVergleich({
      range: 'day',
      anchor: now,
      now,
      jetztEur: EEG_HEUTE_NETTO,
      vorherEur: EEG_VORTAG_NETTO,
      jetztSeries: [],
      vorherSeries: [],
    })!;
    expect(v.modus).toBe('nur_betraege');
    expect(v.chip).toBeNull();
    expect(v.betraege).toBe(`bisher 4,40${NBSP}€ · ganzer Vortag 6,60${NBSP}€`);
  });
});

// --- Abgeschlossene Zeiträume: unverändert ---------------------------------

describe('abgeschlossene Zeiträume bleiben unverändert', () => {
  const now = new Date('2026-09-02T12:19:00+02:00');
  const gestern = new Date('2026-09-01T12:00:00+02:00');

  it('rendert exakt das bestehende `delta()` — mit Wort UND Ton', () => {
    const v = erloesVergleich({
      range: 'day',
      anchor: gestern,
      now,
      jetztEur: DV_VORTAG_NETTO,
      vorherEur: 119.983,
      jetztSeries: DV_VORTAG,
      vorherSeries: DV_HEUTE,
    })!;
    expect(v.modus).toBe('ganze_periode');
    expect(v.chip).toEqual(delta(DV_VORTAG_NETTO, 119.983, true, 'dem Vortag'));
    expect(v.chip?.text).toBe('13 % mehr als am Vortag');
    expect(v.chip?.wertung).toBe('gut');
    expect(v.betraege).toBeNull();
    expect(v.satz).toBeNull();
  });
});

// --- Ehrlichkeitsregeln ----------------------------------------------------

describe('Ehrlichkeit', () => {
  const now = new Date('2026-09-02T12:19:00+02:00');

  it('ohne Vergleichsperiode gibt es gar keine Zeile', () => {
    expect(
      erloesVergleich({ range: 'day', anchor: now, now, jetztEur: 10, vorherEur: null }),
    ).toBeNull();
  });

  it('„nur, wenn er abweicht": unter 3 % kein Chip, die Beträge bleiben', () => {
    const flach = DV_VORTAG.map((b) => ({ ...b }));
    const v = erloesVergleich({
      range: 'day',
      anchor: now,
      now,
      jetztEur: DV_HEUTE_NETTO,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: flach,
      vorherSeries: flach,
    })!;
    expect(v.chip).toBeNull();
    expect(v.betraege).toContain('Bis 12 Uhr');
  });

  it('um 00:30 gibt es keine abgeschlossene Stunde — also kein Prozent', () => {
    const nacht = new Date('2026-09-02T00:30:00+02:00');
    expect(vergleichBisStunde(DV_HEUTE, DV_VORTAG, nacht)).toBeNull();
    const v = erloesVergleich({
      range: 'day',
      anchor: nacht,
      now: nacht,
      jetztEur: -0.24,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: DV_HEUTE,
      vorherSeries: DV_VORTAG,
    })!;
    expect(v.modus).toBe('nur_betraege');
    expect(v.chip).toBeNull();
  });

  it('eine Vergleichsbasis nahe null trägt kein Prozent, aber die Beträge', () => {
    const nullig = DV_VORTAG.map((b, i) => ({ ...b, nettoEur: i < 12 ? 0.001 : b.nettoEur }));
    const v = erloesVergleich({
      range: 'day',
      anchor: now,
      now,
      jetztEur: DV_HEUTE_NETTO,
      vorherEur: DV_VORTAG_NETTO,
      jetztSeries: DV_HEUTE,
      vorherSeries: nullig,
    })!;
    expect(v.modus).toBe('gleicher_zeitpunkt');
    expect(v.chip).toBeNull();
    expect(v.betraege).toContain('Bis 12 Uhr');
  });
});

describe('vollerVergleichsName', () => {
  const anchor = new Date('2026-09-02T12:00:00+02:00');
  it('nennt die Vorperiode als Ganzes', () => {
    expect(vollerVergleichsName(anchor, 'day')).toBe('ganzer Vortag');
    expect(vollerVergleichsName(anchor, 'week')).toBe('ganze Vorwoche');
    expect(vollerVergleichsName(anchor, 'month')).toBe('ganzer August');
    expect(vollerVergleichsName(anchor, 'year')).toBe('ganzes Jahr 2025');
    expect(vollerVergleichsName(anchor, 'month', 'vorjahr')).toBe('ganzer September 2025');
  });
});
