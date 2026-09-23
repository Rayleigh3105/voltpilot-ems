/**
 * UEMS AP-17 IP-20: Antworten des Vergleich-Lesers (IP-19, `bezugsbasis.md` §16) für Tests und die E2E-Bühne — die
 * Zahlen aus R2/R11 (`bezugsbasis-vectors.json`, §10): BB-0001 Fassung 2, Modell mit einer Einflussgröße
 * (10 523 kWh + 0,2343 kWh je kg, Streuung ± 0,8 %, Toleranz 2 %). Dezember 2027 roh 8,8 % weniger ohne Urteil,
 * bereinigt 69 098 kWh erwartet, 12,9 % mehr: schlechter; Zeitraum November 2027 bis Februar 2028 1,8 % im Rahmen.
 * Der März 2028 (390 000 kg, außerhalb der Spannweite) steht nur in der Fassung `mitMaerz` — ein Grund statt Zahl.
 * Auf der Bühne hängt die Antwort an KZ-0001; die Kennzahl selbst liest der Reiter nicht.
 */
import type { BezugsbasisVergleich, BezugsbasisVergleichMonat } from '../bezugsbasisVergleich';

const KZ1 = 'c0de0000-0000-4000-8000-00000000a001';
const KENNZAHL = { id: KZ1, kennzeichen: 'KZ-0001', name: 'Stromeinsatz Montage je Stück — Halle 2', einheit: 'kWh/Stück', einheit_anzeige: 'kWh je Stück' };
const FASSUNG_2 = {
  fassung: 2,
  methode: 'regression_eine_variable' as const,
  referenzperiode: '2026-11/2027-10',
  datenlage: 'vollstaendig' as const,
  gilt_ab: '2027-11-01',
  gilt_bis: null,
};
const KENNZEICHEN = ['bereinigt um Produktionsmenge (Modell mit einer Einflussgröße, Bezugsbasis BB-0001, Fassung 2; Streuung ± 0,8 %)'];
const LEER = 'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';

const bedingung = (wert: string) => [
  { position: 1 as const, quelle: 'bezugsgroesse' as const, kennzeichen: 'BZ-1', name: 'Produktionsmenge', wert, einheit: 'kg', fassung: 1, version: 1, zustand: 'vollstaendig' },
];

function monat(
  periode: string,
  beschriftung: string,
  roh: Pick<BezugsbasisVergleichMonat['roh'], 'gemessen' | 'vorher' | 'delta_prozent' | 'richtung' | 'variable_delta_prozent'>,
  b: Partial<BezugsbasisVergleichMonat['bereinigt']> & { variable: string },
  satz: string,
): BezugsbasisVergleichMonat {
  const { variable, ...rest } = b;
  return {
    periode,
    beschriftung,
    roh: { ...roh, urteil: 'ohne_urteil' },
    bereinigt: {
      fassung: FASSUNG_2,
      gemessen: { wert: roh.gemessen, einheit: 'kWh', version: 1, zustand: 'vollstaendig' },
      bedingung: bedingung(variable),
      erwartet: null,
      delta_prozent: null,
      band_prozent: '2.0',
      richtung: null,
      urteil: 'nicht_anwendbar',
      grund: null,
      kennzeichen: KENNZEICHEN,
      ...rest,
    },
    satz,
  };
}

export const R2_NOVEMBER = monat(
  '2027-11', 'November 2027',
  { gemessen: '85500', vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null },
  { variable: '320000', erwartet: '85499', delta_prozent: '0.0', richtung: 'mehr', urteil: 'im_rahmen' },
  'November 2027: 85 500 kWh gemessen, 85 499 kWh erwartet bei 320 000 kg — 0,0 % mehr: im Rahmen (± 2 %).',
);
export const R2_DEZEMBER = monat(
  '2027-12', 'Dezember 2027',
  { gemessen: '78000', vorher: '85500', delta_prozent: '-8.8', richtung: 'weniger', variable_delta_prozent: '-21.9' },
  { variable: '250000', erwartet: '69098', delta_prozent: '12.9', richtung: 'mehr', urteil: 'schlechter' },
  'Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.',
);
export const R2_JANUAR = monat(
  '2028-01', 'Januar 2028',
  { gemessen: '78000', vorher: '78000', delta_prozent: '0.0', richtung: 'gleich', variable_delta_prozent: '20.0' },
  { variable: '300000', erwartet: '80813', delta_prozent: '-3.5', richtung: 'weniger', urteil: 'besser' },
  'Januar 2028: 78 000 kWh gemessen, 80 813 kWh erwartet bei 300 000 kg — 3,5 % weniger: besser.',
);
export const R2_FEBRUAR = monat(
  '2028-02', 'Februar 2028',
  { gemessen: '81500', vorher: '78000', delta_prozent: '4.5', richtung: 'mehr', variable_delta_prozent: '1.7' },
  { variable: '305000', erwartet: '81984.5', delta_prozent: '-0.6', richtung: 'weniger', urteil: 'im_rahmen' },
  'Februar 2028: 81 500 kWh gemessen, 81 985 kWh erwartet bei 305 000 kg — 0,6 % weniger: im Rahmen (± 2 %).',
);
/** G3: März 2028 mit 390 000 kg außerhalb [254 000 × 0,9; 341 000 × 1,1] — kein erwarteter Wert, der Satz des Lesers. */
export const G3_MAERZ = monat(
  '2028-03', 'März 2028',
  { gemessen: '99000', vorher: '81500', delta_prozent: '21.5', richtung: 'mehr', variable_delta_prozent: '27.9' },
  { variable: '390000', band_prozent: null, grund: 'variable_ausserhalb', kennzeichen: [...KENNZEICHEN, 'Produktionsmenge außerhalb der Basis-Spannweite (254 000–341 000 kg)'] },
  'Modell nicht anwendbar: Produktionsmenge im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).',
);

const BASIS = { id: 'c0de0000-0000-4000-8000-0000000bb001', kennzeichen: 'BB-0001', beendet_zum: null, beendet_grund: null };

/** R2/R11: November 2027 bis Februar 2028. */
export function vergleichR2(): BezugsbasisVergleich {
  return {
    kennzahl: KENNZAHL,
    bezugsbasis: BASIS,
    von: '2027-11',
    bis: '2028-02',
    zeitzone: 'Europe/Berlin',
    monate: [R2_NOVEMBER, R2_DEZEMBER, R2_JANUAR, R2_FEBRUAR],
    zeitraum: {
      fassung: 2,
      gemessen: '323000',
      erwartet: '317394.5',
      delta_prozent: '1.8',
      band_prozent: '2.0',
      richtung: 'mehr',
      urteil: 'im_rahmen',
      grund: null,
      monate: '4 von 4',
      kennzeichen: KENNZEICHEN,
      satz: 'November 2027 bis Februar 2028: 323 000 kWh gemessen, 317 395 kWh erwartet — 1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate).',
    },
    staende: [],
    stand_satz: 'ungesichert — noch kein Stand',
    satz: null,
  };
}

/** Bis März 2028: ein Monat fehlt (G3) — der Zeitraum ist `ohne_urteil` mit „4 von 5“ (U5). */
export function vergleichMitMaerz(): BezugsbasisVergleich {
  const v = vergleichR2();
  return {
    ...v,
    bis: '2028-03',
    monate: [...v.monate, G3_MAERZ],
    zeitraum: {
      ...v.zeitraum,
      urteil: 'ohne_urteil',
      monate: '4 von 5',
      kennzeichen: [...KENNZEICHEN, '4 von 5 Monaten'],
      satz: 'November 2027 bis März 2028: 323 000 kWh gemessen, 317 395 kWh erwartet — 1,8 % mehr; ohne Urteil: 4 von 5 Monaten mit Vergleich.',
    },
  };
}

/** S5: mit gesichertem Stand (IP-21b füllt `staende`). */
export function vergleichMitStand(): BezugsbasisVergleich {
  return { ...vergleichR2(), staende: [{ nummer: 1, am: '2028-01-12' }] };
}

/** R10: ohne Bezugsbasis — jeder Monat `basis_fehlt`, nur der Leer-Satz. */
export function vergleichLeer(): BezugsbasisVergleich {
  const monate = ['2027-11', '2027-12'].map((p, i) => ({
    ...monat(p, i === 0 ? 'November 2027' : 'Dezember 2027',
      { gemessen: null, vorher: null, delta_prozent: null, richtung: null, variable_delta_prozent: null },
      { variable: '0', grund: 'basis_fehlt', band_prozent: null, kennzeichen: [] }, LEER),
  }));
  return {
    kennzahl: KENNZAHL,
    bezugsbasis: null,
    von: '2027-11',
    bis: '2027-12',
    zeitzone: 'Europe/Berlin',
    monate: monate.map((m) => ({ ...m, bereinigt: { ...m.bereinigt, fassung: null, bedingung: [] } })),
    zeitraum: {
      fassung: null, gemessen: null, erwartet: null, delta_prozent: null, band_prozent: null, richtung: null,
      urteil: 'nicht_anwendbar', grund: 'basis_fehlt', monate: '0 von 2', kennzeichen: [],
      satz: 'November 2027 bis Dezember 2027: nicht bewertbar — kein Monat mit Vergleich.',
    },
    staende: [],
    stand_satz: 'ungesichert — noch kein Stand',
    satz: LEER,
  };
}
