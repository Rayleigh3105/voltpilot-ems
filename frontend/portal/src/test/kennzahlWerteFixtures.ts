import type {
  Kennzahl,
  KennzahlFassung,
  KennzahlPeriodeArt,
  KennzahlWert,
  KennzahlWertEntscheidung,
  KennzahlWerte,
  KennzahlWerteHistorie,
  KennzahlWertVersion,
  KennzahlwertHerkunftEingang,
} from '../api';
import { ApiError } from '../api';
import { schluesselVon, spanneVon, tagPlus } from '../bezugsPeriode';
import { periode as periodenUrteil, periodeText } from '../uemsKennzahl';
import { ahrenbergKennzahlen } from './kennzahlenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten der Kennzahl-Routen (UEMS AP-11 IP-5/IP-7) für die Welt „Kennzahlen“ (IP-13) — in der FORM der OpenAPI
 * `KennzahlWerte`, `KennzahlWerteHistorie` und `…/fassungen`. Jede Zahl, jedes Zustandswort, jedes Kennzeichen und
 * jede Herkunft ist der erwartete Wert eines Falls aus `docs/contracts/v2/kennzahl-vectors.json`:
 *  - K1  KZ-0001 Oktober 2026 = 0,15 kWh je Stück, vollständig, endgültig, Version 1;
 *  - K7  dieselbe Periode als Version 2 nach der Korrektur K-2026-0007 (0,1473) — und KZ-0003 Version 2 (0,2);
 *  - K8  KZ-0001 November 2026: keine Werte, Nenner fehlt;
 *  - K10 KZ-0007 am 05.11.2026: mindestens 30,83 kWh je Person (Untergrenze);
 *  - K11 KZ-0008 am 02.12.2026: höchstens 10,55 kWh je h (Obergrenze);
 *  - K2, K3 KZ-0002 und KZ-0003 Oktober 2026 (0,50 und 0,20).
 * `kennzahlKarte.test.ts` prüft sie gegen die Vektoren — weicht eine Zahl ab, ist der Test rot.
 *
 * KZ-0007 und KZ-0008 sind Annahmen der Vektoren (AP-11 §7 K10/K11, nicht im Referenzunternehmen), ihre Perioden
 * spricht der Zwilling `uemsKennzahl.periode`. Die Korrektur K-2026-0007 steht im Referenzunternehmen 1.4 (vorgeschlagen
 * und freigegeben von Ines Kaltenbach). Die Kennungen, die Herkunft von KZ-0002 und von KZ-0003 Version 2 (aus
 * K3/K7 zusammengesetzt) sowie die Zeitpunkte der Fassungen sind gestellt. Nur für Tests und E2E-Bühnen, nie ins
 * Produktionsbündel.
 */

export const ZONE = 'Europe/Berlin';

export const KZ = {
  kz1: 'c0de0000-0000-4000-8000-00000000a001',
  kz2: 'c0de0000-0000-4000-8000-00000000a002',
  kz3: 'c0de0000-0000-4000-8000-00000000a003',
  kz7: 'c0de0000-0000-4000-8000-00000000a007',
  kz8: 'c0de0000-0000-4000-8000-00000000a008',
} as const;

const UNTERNEHMEN_ID = 'c0de0000-0000-4000-8000-000000000001';
/** Geschütztes Leerzeichen (U+00A0) — so steht „1 h“ im Kennzeichen von K11. */
const NB = String.fromCharCode(160);
const K11_OBERGRENZE = `Obergrenze — Bezugsgröße unvollständig (Ladezeit: 1${NB}h ohne Statuswerte)`;
const IK = { name: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'kunde' as const };
const PH = { name: 'Peter Hollerbach', rolle: 'Bearbeiter', art: 'kunde' as const };

// ------------------------------------------------------------------ Schritte

/** Ein Schritt OHNE Zeile — so antwortet die Route für eine Periode, die (noch) nicht gebildet ist. */
export function ohneZeile(periode: KennzahlPeriodeArt, schluessel: string): KennzahlWert {
  const [von, bis] = spanneVon(schluessel, periode);
  return {
    von,
    bis,
    schluessel,
    beschriftung: periodeText(periode, schluessel),
    wert: null,
    zaehler: null,
    nenner: null,
    einheit: null,
    zustand: null,
    richtung: null,
    kennzeichen: [],
    abdeckung_prozent: null,
    fassung: null,
    endgueltig_ab: null,
    version: null,
    definition_fassung: null,
    berechnet_am: null,
    grund: 'noch_nicht_gebildet',
    herkunft: null,
    versionen: null,
  };
}

type Teil = Omit<KennzahlWert, 'von' | 'bis' | 'schluessel' | 'beschriftung' | 'endgueltig_ab' | 'definition_fassung'>;

function zeile(periode: KennzahlPeriodeArt, schluessel: string, t: Teil): KennzahlWert {
  return { ...ohneZeile(periode, schluessel), definition_fassung: 1, ...t };
}

const bz6: KennzahlwertHerkunftEingang = {
  rolle: 'nenner', art: 'bezugsgroesse', objekt: 'BZ-6', wert: '41000', zaehler: null, nenner: null, einheit: 'Stück',
  zustand: 'vollständig', abdeckung_prozent: '100', version: null, fassung: 1, kennzeichen: [],
};

/** K1 — Regel `wert` und `herkunft`. */
export const K1_OKTOBER: KennzahlWert = zeile('monat', '2026-10', {
  wert: '0.1488', zaehler: '6100', nenner: '41000', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null,
  kennzeichen: ['berechnet (Kennzahl)'], abdeckung_prozent: '100', fassung: 'endgueltig', version: 1,
  berechnet_am: '2026-11-01T00:20:00+01:00', grund: null, versionen: 1,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0001', rechenform: 'quotient', definition_fassung: 1,
      periode: { art: 'monat', schluessel: '2026-10' }, berechnet_am: '2026-11-01T00:20:00+01:00', version: 1, anlass: null,
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', objekt: 'MS-12', wert: '6100', zaehler: null, nenner: null, einheit: 'kWh',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: [] },
        bz6,
      ],
      ergebnis: { wert: '0.1488', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null, grund: null,
        abdeckung_prozent: '100', kennzeichen: ['berechnet (Kennzahl)'] },
    },
    fehlt: [],
  },
});

/** K7 — KZ-0001 Version 2 nach K-2026-0007 (MS-12 6 100 → 6 040 kWh). */
export const K7_OKTOBER: KennzahlWert = zeile('monat', '2026-10', {
  wert: '0.1473', zaehler: '6040', nenner: '41000', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null,
  kennzeichen: ['berechnet (Kennzahl)', 'korrigiert (Version 2)'], abdeckung_prozent: '100', fassung: 'endgueltig', version: 2,
  berechnet_am: '2026-11-12T10:05:33+01:00', grund: null, versionen: 2,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0001', rechenform: 'quotient', definition_fassung: 1,
      periode: { art: 'monat', schluessel: '2026-10' }, berechnet_am: '2026-11-12T10:05:33+01:00', version: 2,
      anlass: 'K-2026-0007 (freigegeben 12.11.2026)',
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', objekt: 'MS-12', wert: '6040', zaehler: null, nenner: null, einheit: 'kWh',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 2, fassung: null, kennzeichen: ['korrigiert (Version 2)'] },
        bz6,
      ],
      ergebnis: { wert: '0.1473', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null, grund: null,
        abdeckung_prozent: '100', kennzeichen: ['berechnet (Kennzahl)', 'korrigiert (Version 2)'] },
    },
    fehlt: [],
  },
});

/** K8 — BZ-6 November 2026 ist nicht eingegeben: keine Werte, nie 0; ohne Version keine Herkunft. */
export const K8_NOVEMBER: KennzahlWert = zeile('monat', '2026-11', {
  wert: null, zaehler: '6300', nenner: null, einheit: 'kWh/Stück', zustand: 'keine Werte', richtung: null,
  kennzeichen: [], abdeckung_prozent: '0', fassung: null, version: null,
  berechnet_am: '2026-12-01T00:20:00+01:00', grund: 'nenner_fehlt', herkunft: null, versionen: null,
});

/** K10 — mindestens 5 550 kWh (MS-16 fehlt) ÷ 180 Mitarbeitende. */
export const K10_TAG: KennzahlWert = zeile('tag', '2026-11-05', {
  wert: '30.8333', zaehler: '5550', nenner: '180', einheit: 'kWh/Person', zustand: 'unvollständig', richtung: 'untergrenze',
  kennzeichen: ['berechnet (Kennzahl)', 'enthält berechnet (Summe)', 'Untergrenze — Menge unvollständig (MS-16 fehlt)', '2 von 3 Systemen'],
  abdeckung_prozent: '67', fassung: 'vorlaeufig', version: 1, berechnet_am: '2026-11-06T00:15:00+01:00', grund: null, versionen: 1,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0007', rechenform: 'quotient', definition_fassung: 1,
      periode: { art: 'tag', schluessel: '2026-11-05' }, berechnet_am: '2026-11-06T00:15:00+01:00', version: 1, anlass: null,
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', objekt: 'MS-19', wert: '5550', zaehler: null, nenner: null, einheit: 'kWh',
          zustand: 'unvollständig', abdeckung_prozent: '67', version: 1, fassung: null, kennzeichen: ['berechnet (Summe)', '2 von 3 Systemen'] },
        { rolle: 'nenner', art: 'bezugsgroesse', objekt: 'Mitarbeitende (U)', wert: '180', zaehler: null, nenner: null, einheit: 'Personen',
          zustand: 'vollständig', abdeckung_prozent: '100', version: null, fassung: null, kennzeichen: ['Stichtag 05.11.2026'] },
      ],
      ergebnis: { wert: '30.8333', einheit: 'kWh/Person', zustand: 'unvollständig', richtung: 'untergrenze', grund: null,
        abdeckung_prozent: '67',
        kennzeichen: ['berechnet (Kennzahl)', 'enthält berechnet (Summe)', 'Untergrenze — Menge unvollständig (MS-16 fehlt)', '2 von 3 Systemen'] },
    },
    fehlt: [],
  },
});

/** K11 — 52,4 kWh ÷ 4,9667 h Ladezeit (K-9, unvollständig 95,8 %). */
export const K11_TAG: KennzahlWert = zeile('tag', '2026-12-02', {
  wert: '10.5503', zaehler: '52.4', nenner: '4.9667', einheit: 'kWh/h', zustand: 'unvollständig', richtung: 'obergrenze',
  kennzeichen: ['berechnet (Kennzahl)', K11_OBERGRENZE],
  abdeckung_prozent: '95.8', fassung: 'vorlaeufig', version: 1, berechnet_am: '2026-12-03T00:15:00+01:00', grund: null, versionen: 1,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0008', rechenform: 'quotient', definition_fassung: 1,
      periode: { art: 'tag', schluessel: '2026-12-02' }, berechnet_am: '2026-12-03T00:15:00+01:00', version: 1, anlass: null,
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', objekt: 'MS-14', wert: '52.4', zaehler: null, nenner: null, einheit: 'kWh',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: [] },
        { rolle: 'nenner', art: 'bezugsgroesse', objekt: 'BZ-5', wert: '4.9667', zaehler: null, nenner: null, einheit: 'h',
          zustand: 'unvollständig', abdeckung_prozent: '95.8', version: null, fassung: 1,
          kennzeichen: ['aus Messkanal K-9 (Zustand = Charging)', 'gemessene Zeit 23:00 von 24:00 h'] },
      ],
      ergebnis: { wert: '10.5503', einheit: 'kWh/h', zustand: 'unvollständig', richtung: 'obergrenze', grund: null,
        abdeckung_prozent: '95.8',
        kennzeichen: ['berechnet (Kennzahl)', K11_OBERGRENZE] },
    },
    fehlt: [],
  },
});

/** K2 — KZ-0002 Oktober 2026 (Herkunft gestellt aus dem Eingang von K2). */
export const K2_OKTOBER: KennzahlWert = zeile('monat', '2026-10', {
  wert: '0.5', zaehler: '3600', nenner: '7200', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null,
  kennzeichen: ['berechnet (Kennzahl)', 'ab 15.10.2026'], abdeckung_prozent: '100', fassung: 'endgueltig', version: 1,
  berechnet_am: '2026-11-01T00:20:00+01:00', grund: null, versionen: 1,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0002', rechenform: 'quotient', definition_fassung: 1,
      periode: { art: 'monat', schluessel: '2026-10' }, berechnet_am: '2026-11-01T00:20:00+01:00', version: 1, anlass: null,
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', objekt: 'MS-18', wert: '3600', zaehler: null, nenner: null, einheit: 'kWh',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: [] },
        { rolle: 'nenner', art: 'bezugsgroesse', objekt: 'BZ-7', wert: '7200', zaehler: null, nenner: null, einheit: 'Stück',
          zustand: 'vollständig', abdeckung_prozent: '100', version: null, fassung: 1, kennzeichen: [] },
      ],
      ergebnis: { wert: '0.5', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null, grund: null,
        abdeckung_prozent: '100', kennzeichen: ['berechnet (Kennzahl)', 'ab 15.10.2026'] },
    },
    fehlt: [],
  },
});

const K3_KENNZEICHEN = ['berechnet (Kennzahl)', 'gewichtet (Summe ÷ Summe)', '2 von 2 Gebäuden', 'G-5 ab 15.10.2026'];
const paarKz2: KennzahlwertHerkunftEingang = {
  rolle: 'paar', art: 'kennzahl', objekt: 'KZ-0002', wert: '0.5', zaehler: '3600', nenner: '7200', einheit: 'kWh/Stück',
  zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: ['berechnet (Kennzahl)', 'ab 15.10.2026'],
};

/** K3 — KZ-0003 Oktober 2026 = (6 100 + 3 600) ÷ (41 000 + 7 200), gewichtet. */
export const K3_OKTOBER: KennzahlWert = zeile('monat', '2026-10', {
  wert: '0.2012', zaehler: '9700', nenner: '48200', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null,
  kennzeichen: K3_KENNZEICHEN, abdeckung_prozent: '100', fassung: 'endgueltig', version: 1,
  berechnet_am: '2026-11-01T00:20:00+01:00', grund: null, versionen: 1,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0003', rechenform: 'zusammenfassung', definition_fassung: 1,
      periode: { art: 'monat', schluessel: '2026-10' }, berechnet_am: '2026-11-01T00:20:00+01:00', version: 1, anlass: null,
      eingaenge: [
        { rolle: 'paar', art: 'kennzahl', objekt: 'KZ-0001', wert: '0.1488', zaehler: '6100', nenner: '41000', einheit: 'kWh/Stück',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 1, fassung: null, kennzeichen: ['berechnet (Kennzahl)'] },
        paarKz2,
      ],
      ergebnis: { wert: '0.2012', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null, grund: null,
        abdeckung_prozent: '100', kennzeichen: K3_KENNZEICHEN },
    },
    fehlt: [],
  },
});

/** K7 — KZ-0003 Version 2 = (6 040 + 3 600) ÷ 48 200 = 0,2 (Herkunft aus K3 und K7 zusammengesetzt). */
export const K7_UNTERNEHMEN_OKTOBER: KennzahlWert = zeile('monat', '2026-10', {
  wert: '0.2', zaehler: '9640', nenner: '48200', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null,
  kennzeichen: [...K3_KENNZEICHEN, 'korrigiert (Version 2)'], abdeckung_prozent: '100', fassung: 'endgueltig', version: 2,
  berechnet_am: '2026-11-12T10:05:33+01:00', grund: null, versionen: 2,
  herkunft: {
    satz: {
      art: 'kennzahl', kennzahl: 'KZ-0003', rechenform: 'zusammenfassung', definition_fassung: 1,
      periode: { art: 'monat', schluessel: '2026-10' }, berechnet_am: '2026-11-12T10:05:33+01:00', version: 2,
      anlass: 'K-2026-0007 (freigegeben 12.11.2026)',
      eingaenge: [
        { rolle: 'paar', art: 'kennzahl', objekt: 'KZ-0001', wert: '0.1473', zaehler: '6040', nenner: '41000', einheit: 'kWh/Stück',
          zustand: 'vollständig', abdeckung_prozent: '100', version: 2, fassung: null,
          kennzeichen: ['berechnet (Kennzahl)', 'korrigiert (Version 2)'] },
        paarKz2,
      ],
      ergebnis: { wert: '0.2', einheit: 'kWh/Stück', zustand: 'vollständig', richtung: null, grund: null,
        abdeckung_prozent: '100', kennzeichen: [...K3_KENNZEICHEN, 'korrigiert (Version 2)'] },
    },
    fehlt: [],
  },
});

// ------------------------------------------------------------------ Kennzahlen und Fassungen

function annahme(over: Pick<Kennzahl, 'id' | 'kennzeichen' | 'name' | 'einheit' | 'grundperiode' | 'perioden'> & Partial<Kennzahl>): Kennzahl {
  return {
    rechenform: 'quotient',
    geltung_art: 'unternehmen',
    geltung_id: UNTERNEHMEN_ID,
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
    rechte_geltung: 'unternehmen',
    standort_id: null,
    kennung: 'kennzahl.unternehmen_definieren',
    verantwortlich_name: 'Ines Kaltenbach',
    zweck: null,
    fassung: 1,
    einheit_anzeige: null,
    hat_werte: true,
    archiviert_am: null,
    angelegt_am: '2026-11-03T09:00:00+01:00',
    ...over,
  };
}

const perioden = (grund: KennzahlPeriodeArt, eingaenge: Parameters<typeof periodenUrteil>[1]) => {
  const u = periodenUrteil(grund, eingaenge);
  return { grundperiode: u.grundperiode as KennzahlPeriodeArt, perioden: u.perioden as KennzahlPeriodeArt[] };
};

/** KZ-0007 „Netzbezug je Mitarbeitenden“ — Annahme von K10 (Geltung Unternehmen). */
export const KZ_0007: Kennzahl = annahme({
  id: KZ.kz7,
  kennzeichen: 'KZ-0007',
  name: 'Netzbezug je Mitarbeitenden',
  einheit: 'kWh/Person',
  ...perioden('tag', [
    { art: 'messstelle', objekt: 'MS-19', name: 'Netzbezug gesamt Unternehmen', wertart: null, periode_art: 'tag' },
    { art: 'bezugsgroesse', objekt: 'Mitarbeitende (U)', name: null, wertart: 'stammdatum', periode_art: null },
  ]),
});

/** KZ-0008 „Stromabgabe je Ladestunde“ — Annahme von K11 (Geltung Messstelle MS-14). */
export const KZ_0008: Kennzahl = annahme({
  id: KZ.kz8,
  kennzeichen: 'KZ-0008',
  name: 'Stromabgabe je Ladestunde',
  einheit: 'kWh/h',
  geltung_art: 'messstelle',
  geltung_id: 'c0de0000-0000-4000-8000-0000000ms014',
  geltung_name: 'Ladepunkt Parkplatz Halle 2',
  rechte_geltung: 'standort',
  standort_id: FIXTURE_IDS.st1,
  kennung: 'kennzahl.standort_definieren',
  ...perioden('tag', [
    { art: 'messstelle', objekt: 'MS-14', name: 'Ladepunkt Parkplatz Halle 2', wertart: null, periode_art: 'tag' },
    { art: 'bezugsgroesse', objekt: 'BZ-5', name: 'Ladezeit Ladepunkt Halle 2', wertart: 'periodenwert', periode_art: 'tag' },
  ]),
});

/** Die Kennzahlen der Welt: KZ-0001 … KZ-0003 aus dem Referenzunternehmen, KZ-0007 und KZ-0008 aus den Vektoren. */
export function kennzahlenDerWelt(): Kennzahl[] {
  return [...ahrenbergKennzahlen(), structuredClone(KZ_0007), structuredClone(KZ_0008)];
}

type Eingang = KennzahlFassung['eingaenge'][number];
const ein = (rolle: Eingang['rolle'], art: Eingang['art'], kennzeichen: string, name: string | null): Eingang => ({
  rolle,
  art,
  id: `c0de0000-0000-4000-8000-${kennzeichen.replace(/[^0-9A-Z]/g, '').toLowerCase().padStart(12, '0').slice(-12)}`,
  kennzeichen,
  name,
});

function fassung1(k: Kennzahl, von: typeof IK | typeof PH, eingaenge: Eingang[]): KennzahlFassung {
  return {
    nummer: 1,
    gueltig_ab: null,
    gueltig_bis: null,
    aufgehoben_am: null,
    herkunft: 'anlage',
    rueckwirkend: false,
    abzeichen: null,
    begruendung: null,
    eingetragen_von: von,
    eingetragen_am: k.angelegt_am,
    rechenform: k.rechenform,
    einheit: k.einheit ?? '',
    einheit_anzeige: (k.einheit ?? '').replace('/', ' je '),
    komplement: false,
    eingaenge,
  };
}

/** `GET /api/v1/kennzahlen/{id}/fassungen` — je Kennzahl Fassung 1 „gilt seit Beginn“. */
export function fassungenVon(id: string): KennzahlFassung[] {
  const k = kennzahlenDerWelt().find((x) => x.id === id);
  if (!k) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
  const eingaenge: Record<string, Eingang[]> = {
    'KZ-0001': [ein('zaehler', 'messstelle', 'MS-12', 'Montage Linie M1'), ein('nenner', 'bezugsgroesse', 'BZ-6', 'Gutteile Montage Halle 2')],
    'KZ-0002': [ein('zaehler', 'messstelle', 'MS-18', 'Montagehalle Lindach gesamt'), ein('nenner', 'bezugsgroesse', 'BZ-7', 'Gutteile Montage Lindach')],
    'KZ-0003': [
      ein('paar', 'kennzahl', 'KZ-0001', 'Stromeinsatz Montage je Stück — Halle 2'),
      ein('paar', 'kennzahl', 'KZ-0002', 'Stromeinsatz Montage je Stück — Montagehalle Lindach'),
    ],
    'KZ-0007': [ein('zaehler', 'messstelle', 'MS-19', 'Netzbezug gesamt Unternehmen'), ein('nenner', 'bezugsgroesse', 'Mitarbeitende (U)', null)],
    'KZ-0008': [ein('zaehler', 'messstelle', 'MS-14', 'Ladepunkt Parkplatz Halle 2'), ein('nenner', 'bezugsgroesse', 'BZ-5', 'Ladezeit Ladepunkt Halle 2')],
  };
  return [fassung1(k, k.kennzeichen === 'KZ-0002' ? PH : IK, eingaenge[k.kennzeichen])];
}

// ------------------------------------------------------------------ Antworten der Werte-Routen

const EINTRAEGE: { id: string; periode: KennzahlPeriodeArt; wert: KennzahlWert }[] = [
  { id: KZ.kz1, periode: 'monat', wert: K1_OKTOBER },
  { id: KZ.kz1, periode: 'monat', wert: K7_OKTOBER },
  { id: KZ.kz1, periode: 'monat', wert: K8_NOVEMBER },
  { id: KZ.kz2, periode: 'monat', wert: K2_OKTOBER },
  { id: KZ.kz3, periode: 'monat', wert: K3_OKTOBER },
  { id: KZ.kz3, periode: 'monat', wert: K7_UNTERNEHMEN_OKTOBER },
  { id: KZ.kz7, periode: 'tag', wert: K10_TAG },
  { id: KZ.kz8, periode: 'tag', wert: K11_TAG },
];

/** Die Zeilen einer Periode, die bis `jetzt` gebildet waren — älteste zuerst. */
const zeilenBis = (id: string, periode: KennzahlPeriodeArt, schluessel: string, jetzt: number): KennzahlWert[] =>
  EINTRAEGE.filter(
    (e) => e.id === id && e.periode === periode && e.wert.schluessel === schluessel && Date.parse(e.wert.berechnet_am as string) <= jetzt,
  ).map((e) => e.wert);

const kennzahlKopf = (id: string): KennzahlWerte['kennzahl'] => {
  const k = kennzahlenDerWelt().find((x) => x.id === id);
  if (!k) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
  return { id: k.id, kennzeichen: k.kennzeichen, name: k.name, rechenform: k.rechenform, einheit: k.einheit, einheit_anzeige: k.einheit_anzeige };
};

/** `GET /api/v1/kennzahlen/{id}/werte` zum Zeitpunkt `jetzt`: je Periode die neueste Zeile, sonst ein Schritt ohne Zeile. */
export function kennzahlWerteAntwort(id: string, periode: KennzahlPeriodeArt, von: string, bis: string, jetzt: number): KennzahlWerte {
  const kennzahl = kennzahlKopf(id);
  const werte: KennzahlWert[] = [];
  for (let tag = von; tag <= bis; ) {
    const schluessel = schluesselVon(tag, periode);
    const zeilen = zeilenBis(id, periode, schluessel, jetzt);
    werte.push(structuredClone(zeilen.length > 0 ? zeilen[zeilen.length - 1] : ohneZeile(periode, schluessel)));
    tag = tagPlus(spanneVon(schluessel, periode)[1], 1);
  }
  return { kennzahl, periode, von, bis, zeitzone: ZONE, version: null, werte };
}

/** Die Entscheidung hinter K-2026-0007 (Referenzunternehmen 1.4): vorgeschlagen und freigegeben von Ines Kaltenbach. */
const K_2026_0007: KennzahlWertEntscheidung = {
  vorgang: 'korrektur',
  kennung: 'K-2026-0007',
  fassung: 2,
  status: 'freigegeben',
  methode: null,
  art: 'wert_berichtigt',
  wer: IK,
  wann: '2026-11-12T10:05:33+01:00',
  warum: null,
  beleg: null,
  fehlt: ['warum'],
  angelegt: { wer: IK, wann: '2026-11-11T16:40:00+01:00', warum: 'Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)', beleg: null },
};

/** `GET /api/v1/kennzahlen/{id}/werte/versionen` zum Zeitpunkt `jetzt` — Version 1 zuerst. */
export function kennzahlWertVersionenAntwort(id: string, periode: KennzahlPeriodeArt, von: string, jetzt: number): KennzahlWerteHistorie {
  const kennzahl = kennzahlKopf(id);
  const schluessel = schluesselVon(von, periode);
  const [ab, bis] = spanneVon(schluessel, periode);
  const zeilen = zeilenBis(id, periode, schluessel, jetzt).filter((w) => w.version !== null);
  const versionen = zeilen.map((w, i): KennzahlWertVersion => {
    const anlass = w.herkunft?.satz?.anlass ?? null;
    return {
      version: w.version as number,
      wert_alt: i === 0 ? null : structuredClone(zeilen[i - 1]),
      wert_neu: structuredClone(w),
      gebildet_am: w.berechnet_am as string,
      nachgezogen_am: null,
      anlass: anlass === null ? null : { art: 'eingang', beleg: anlass },
      entscheidungen: anlass?.startsWith('K-2026-0007') ? [structuredClone(K_2026_0007)] : [],
    };
  });
  return {
    kennzahl,
    periode,
    von: ab,
    bis,
    zeitzone: ZONE,
    grund: versionen.length === 0 ? (zeilen.length === 0 ? 'noch_nicht_gebildet' : null) : null,
    versionen,
  };
}
