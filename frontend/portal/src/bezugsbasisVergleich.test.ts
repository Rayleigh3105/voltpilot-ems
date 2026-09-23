import { describe, expect, it } from 'vitest';
import {
  band,
  bedingungText,
  deltaText,
  kannVergleich,
  menge,
  monatsOptionen,
  referenzperiodeText,
  standSatz,
  vergleichBild,
  zeitraumGueltig,
} from './bezugsbasisVergleich';
import { UEMS_BEZUGSBASIS_URTEILE } from './glossar';
import { vergleichLeer, vergleichMitMaerz, vergleichMitStand, vergleichR2 } from './test/bezugsbasisVergleichFixtures';

/** VG3 (E8 = A): an einer rohen Zahl steht kein Urteil-Wort und kein Pfeil. */
const URTEIL_ODER_PFEIL = /besser|schlechter|im Rahmen|nicht bewertbar|[↑↓▲▼⬆⬇]/u;

describe('AP-17 IP-20 · das Bild des Vergleichs (nur Anzeige, nichts gerechnet)', () => {
  it('R2 Dezember 2027: roh 8,8 % weniger ohne Urteil, bereinigt 69 098 kWh erwartet, 12,9 % mehr — schlechter (± 2 %)', () => {
    const bild = vergleichBild(vergleichR2());
    if (bild.art !== 'vergleich') throw new Error('Vergleich erwartet');
    const dez = bild.monate.find((m) => m.periode === '2027-12')!;
    expect(dez.roh).toEqual({
      gemessen: '78 000 kWh',
      veraenderung: '8,8 % weniger als im Vormonat',
      bedingung: 'Produktionsmenge: 21,9 % weniger',
      ohneUrteil: 'ohne Urteil',
    });
    for (const text of Object.values(dez.roh)) expect(text ?? '').not.toMatch(URTEIL_ODER_PFEIL);
    expect(dez.bereinigt).toMatchObject({
      art: 'zahl',
      bedingung: 'bei 250 000 kg',
      erwartet: '69 098 kWh',
      delta: '12,9 % mehr',
      urteil: UEMS_BEZUGSBASIS_URTEILE.schlechter,
      band: '± 2 %',
    });
    expect(dez.version).toBe('Version 1');
    // Der Satz ist der des Lesers — wörtlich §10.
    expect(dez.satz).toBe(
      'Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.',
    );
  });

  it('kein roher Text eines Monats trägt ein Urteil-Wort (U1), auch nicht bei gleicher Menge', () => {
    const bild = vergleichBild(vergleichMitMaerz());
    if (bild.art !== 'vergleich') throw new Error('Vergleich erwartet');
    for (const m of bild.monate) {
      for (const text of Object.values(m.roh)) expect(text ?? '', m.periode).not.toMatch(URTEIL_ODER_PFEIL);
    }
    expect(bild.monate[0].roh.veraenderung).toBeNull();
    expect(bild.monate[2].roh.veraenderung).toBe('gleich wie im Vormonat');
    expect(bild.monate[2].roh.bedingung).toBe('Produktionsmenge: 20,0 % mehr');
  });

  it('R11 Zeitraum: Σ ÷ Σ des Lesers — 323 000 kWh, 317 395 kWh (M5 kaufmännisch), 1,8 % mehr: im Rahmen (± 2 %)', () => {
    const bild = vergleichBild(vergleichR2());
    if (bild.art !== 'vergleich') throw new Error('Vergleich erwartet');
    expect(bild.zeitraum).toMatchObject({
      titel: 'November 2027 bis Februar 2028',
      gemessen: '323 000 kWh',
      erwartet: '317 395 kWh',
      delta: '1,8 % mehr',
      urteil: 'im Rahmen',
      band: '± 2 %',
      monate: null,
    });
    expect(bild.zeitraum.satz).toContain('1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate)');
  });

  it('G3 März 2028: Grund statt Zahl; der Zeitraum ist ohne Urteil mit „4 von 5 Monaten“ (U5)', () => {
    const bild = vergleichBild(vergleichMitMaerz());
    if (bild.art !== 'vergleich') throw new Error('Vergleich erwartet');
    const maerz = bild.monate.at(-1)!;
    expect(maerz.bereinigt).toMatchObject({ art: 'grund', grund: 'variable_ausserhalb' });
    expect(maerz.satz).toBe(
      'Modell nicht anwendbar: Produktionsmenge im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).',
    );
    expect(bild.zeitraum).toMatchObject({ urteil: 'ohne Urteil', monate: '4 von 5 Monaten' });
  });

  it('Basis-Zeile: Kennzeichen, Fassung, Methode als Kundenwort, Referenzperiode', () => {
    const bild = vergleichBild(vergleichR2());
    if (bild.art !== 'vergleich') throw new Error('Vergleich erwartet');
    expect(bild.basisZeile).toBe(
      'Bezugsbasis BB-0001 · Fassung 2 · Modell mit einer Einflussgröße · Referenzperiode November 2026 bis Oktober 2027',
    );
  });

  it('S5: ohne Stand der Satz des Lesers, mit Stand „Stand Nr. 1 vom 12.01.2028“', () => {
    expect(standSatz(vergleichR2())).toBe('ungesichert — noch kein Stand');
    expect(standSatz(vergleichMitStand())).toBe('Stand Nr. 1 vom 12.01.2028');
    expect(standSatz({ staende: [{ nummer: 1, am: '2028-01-12' }, { nummer: 2, am: '2028-02-03' }], stand_satz: '' })).toBe(
      'Stand Nr. 2 vom 03.02.2028',
    );
  });

  it('R10: ohne Bezugsbasis nur der Leer-Satz — kein Vergleich, kein Urteil', () => {
    const bild = vergleichBild(vergleichLeer());
    expect(bild.art).toBe('leer');
    if (bild.art !== 'leer') return;
    expect(bild.satz).toBe(
      'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.',
    );
    expect(bild.hinweis).toContain('Reiter „Bezugsbasis“');
  });

  it('Zahlen: Anzeige-Rundung M5, Dezimalkomma, Tausender mit Leerzeichen, Band ohne Null am Ende', () => {
    expect(menge('81984.5', 'kWh')).toBe('81 985 kWh');
    expect(menge(null, 'kWh')).toBe('—');
    expect(band('2.0')).toBe('± 2 %');
    expect(band('4.6')).toBe('± 4,6 %');
    expect(band(null)).toBeNull();
    expect(deltaText('-3.5', 'weniger')).toBe('3,5 % weniger');
    expect(deltaText(null, null)).toBeNull();
    expect(bedingungText([])).toBe('—');
    expect(
      bedingungText([
        { position: 2, quelle: 'bezugsgroesse', kennzeichen: 'BZ-5', name: 'Gradtagzahl', wert: '480.000', einheit: 'Kd', fassung: 1, version: 1, zustand: null },
        { position: 1, quelle: 'bezugsgroesse', kennzeichen: 'BZ-1', name: 'Produktionsmenge', wert: null, einheit: 'kg', fassung: 1, version: null, zustand: null },
      ]),
    ).toBe('bei Produktionsmenge ohne Wert und 480 Kd');
    expect(referenzperiodeText('2026-10/2026-10')).toBe('Oktober 2026');
  });

  it('Zeitraum-Wahl: Monate rückwärts über den Jahreswechsel, von nicht nach bis', () => {
    expect(monatsOptionen('2028-02', 3)).toEqual([
      { value: '2028-02', label: 'Februar 2028' },
      { value: '2028-01', label: 'Januar 2028' },
      { value: '2027-12', label: 'Dezember 2027' },
    ]);
    expect(zeitraumGueltig('2027-11', '2028-02')).toBe(true);
    expect(zeitraumGueltig('2028-03', '2028-02')).toBe(false);
    expect(zeitraumGueltig('2028-13', '2028-02')).toBe(false);
  });

  it('B2: der Reiter nur an Quotient und Zusammenfassung', () => {
    expect(kannVergleich({ rechenform: 'quotient' })).toBe(true);
    expect(kannVergleich({ rechenform: 'zusammenfassung' })).toBe(true);
    expect(kannVergleich({ rechenform: 'anteil' })).toBe(false);
  });
});
