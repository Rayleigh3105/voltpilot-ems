/**
 * UEMS AP-17 IP-24 (R8): der Leistungsvergleich Dezember 2027 für KZ-0004 „Stromeinsatz Spritzguss je kg“ gegen
 * BB-0001 Fassung 2 — angelegt und als Stand Nr. 1 am 12.01.2028 von Ines Kaltenbach freigegeben. Der Abzug hat die
 * Form des Vertrags 1.4 (`bericht.schema.json` `$defs/abzug`, dritter Zweig; `BerichtLeistungsvergleich`); der Monat
 * Dezember ist der des Vergleich-Lesers (`bezugsbasisVergleichFixtures.R2_DEZEMBER`: 78 000 kWh gemessen, 69 098 kWh
 * erwartet bei 250 000 kg — 12,9 % mehr: schlechter). Kennzeichen, Zeitpunkte und Prüfsummen sind gestellt.
 * Nur für Tests und die E2E-Bühne, nie ins Produktionsbündel.
 */
import { ApiError, type Bericht, type BerichtAnlegen, type BerichtDetail, type BerichtEntwurf, type BerichtStand, type Kennzahl } from '../api';
import type { LeistungsvergleichAbzug } from '../leistungsvergleichBericht';
import * as B from '../uemsBericht';
import { R2_DEZEMBER } from './bezugsbasisVergleichFixtures';
import { ahrenbergKennzahlen } from './kennzahlenFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

export const LV_ZONE = 'Europe/Berlin';
export const LV_KENNUNG = 'BR-2028-0001';
export const KZ4 = 'c0de0000-0000-4000-8000-00000000a004';
export const KZ6 = 'c0de0000-0000-4000-8000-00000000a006';
const UNTERNEHMEN_ID = 'c0de0000-0000-4000-8000-000000000001';
const BB1 = 'bb000000-0000-4000-8000-000000000001';
export const LV_ZEIT = { angelegt: '2028-01-12T08:30:00Z', freigegeben: '2028-01-12T09:02:00Z' } as const;
export const LV_PRUEFSUMME = 'sha256:4e2d9a1c7b3f60e85d2c1a4b9f7e3d6c5b8a2f1e0d9c8b7a6f5e4d3c2b1a0f9e';
const BASIS_PRUEFSUMME = 'sha256:631ad82b172485032428a9233d26ba2f8a1351ce425fba81133416349ba1344e';
const IK = { name: 'Ines Kaltenbach', rolle: 'energiemanager' };

type Register = Kennzahl;

/**
 * `GET /api/v1/kennzahlen` mit dem Register-Feld `bezugsbasis` (IP-8): KZ-0004 mit freigegebener Basis BB-0001
 * (Energieleistungskennzahl), KZ-0006 mit beantragter Basis und KZ-0001…0003 ohne Basis — nur KZ-0004 ist wählbar.
 */
export function lvKennzahlen(): Register[] {
  const [kz1, , kz3] = ahrenbergKennzahlen();
  return [
    ...ahrenbergKennzahlen().map((k) => ({ ...k, bezugsbasis: null })),
    {
      ...kz3,
      id: KZ4,
      kennzeichen: 'KZ-0004',
      name: 'Stromeinsatz Spritzguss je kg',
      einheit: 'kWh/kg',
      einheit_anzeige: 'kWh je kg',
      bezugsbasis: { kennzeichen: 'BB-0001', fassung: 2, freigabe_status: 'freigegeben', vorlaeufig: false },
    },
    {
      ...kz1,
      id: KZ6,
      kennzeichen: 'KZ-0006',
      name: 'Gaseinsatz Verwaltung je Gradtag',
      bezugsbasis: { kennzeichen: 'BB-0005', fassung: 1, freigabe_status: 'beantragt', vorlaeufig: false },
    },
  ];
}

/** Der Abzug R8 — acht Abschnitte, Dezember 2027. */
export function abzugR8(): LeistungsvergleichAbzug & { kopf: { darstellung: Record<string, string>; regelwerk: Record<string, unknown> } } {
  const kennzeichen = R2_DEZEMBER.bereinigt.kennzeichen;
  return {
    kopf: {
      bericht: LV_KENNUNG,
      vorlage: 'leistungsvergleich',
      vorlage_fassung: 1,
      geltung: { art: 'unternehmen', kennzeichen: 'U-1', name_zum_datenstand: 'Kunststoffwerk Ahrenberg GmbH' },
      unternehmen: 'Kunststoffwerk Ahrenberg GmbH',
      sitz: 'Ahrenberg',
      zeitraum: { art: 'monat', schluessel: '2027-12', von: '2027-12-01T00:00:00+01:00', bis: '2028-01-01T00:00:00+01:00', zone: LV_ZONE },
      referenzperiode: { schluessel: '2026-11/2027-10', bezeichnung: 'November 2026 bis Oktober 2027' },
      bezugsbasis: { kennzeichen: 'BB-0001', fassung: 2 },
      grenz_satz: 'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.',
      kennzeichen,
      datenstand: '2028-01-12T09:30:00+01:00',
      quellenverzeichnis: ['BB-0001', 'BZ-1', 'KZ-0004', 'MS-20'],
      darstellung: { zeitzone: LV_ZONE, zahlenformat: 'de-DE', dezimal: ',', rundung: 'M5', sommerzeit: 'Z3' },
      regelwerk: { software: '1.0.0', vertraege: { bericht: '1.4' } },
    },
    kennzahl: { id: KZ4, kennzeichen: 'KZ-0004', name_zum_datenstand: 'Stromeinsatz Spritzguss je kg', rechenform: 'quotient', einheit: 'kWh/kg' },
    bezugsbasis: {
      id: BB1,
      kennzeichen: 'BB-0001',
      fassung: 2,
      methode: 'regression_eine_variable',
      referenzperiode: '2026-11/2027-10',
      datenlage: 'vollstaendig',
      gilt_ab: '2027-11-01',
      gilt_bis: null,
      basiswert: '0.2685',
      koeffizienten: { a: 10523, b: 0.2343 },
      r2: '0.991',
      streuung_prozent: '0.8',
      toleranz_prozent: '2.0',
      pruefsumme: BASIS_PRUEFSUMME,
      freigegeben_von: 'Ines Kaltenbach',
      freigegeben_rolle: 'energiemanager',
      freigegeben_am: '2027-11-24T10:00:00+01:00',
    },
    vergleich_je_periode: [R2_DEZEMBER],
    urteil: {
      fassung: 2,
      gemessen: '78000',
      erwartet: '69098',
      delta_prozent: '12.9',
      band_prozent: '2.0',
      richtung: 'mehr',
      urteil: 'schlechter',
      grund: null,
      monate: '1 von 1',
      kennzeichen,
      satz: R2_DEZEMBER.satz,
    },
    grenzen_und_vorbehalte: { datenlage: 'vollstaendig', toleranz_prozent: '2.0', streuung_prozent: '0.8', kennzeichen, nicht_anwendbar: [] },
    statische_faktoren: [],
    quellenverzeichnis: [
      { art: 'kennzahl', kennzeichen: 'KZ-0004', name_zum_datenstand: 'Stromeinsatz Spritzguss je kg', bezug: 'unmittelbar', version: 1, fassung: null, erster_tag: '2027-12-01', letzter_tag: '2027-12-31' },
      { art: 'messstelle', kennzeichen: 'MS-20', name_zum_datenstand: 'Spritzguss Halle 1', bezug: 'mittelbar', version: 1, fassung: null, erster_tag: '2027-12-01', letzter_tag: '2027-12-31' },
      { art: 'bezugsgroesse', kennzeichen: 'BZ-1', name_zum_datenstand: 'Produktionsmenge', bezug: 'mittelbar', version: null, fassung: 1, erster_tag: '2027-12-01', letzter_tag: '2027-12-31' },
      { art: 'bezugsbasis', kennzeichen: 'BB-0001', name_zum_datenstand: 'Bezugsbasis BB-0001', bezug: 'vergleich', version: null, fassung: 2, erster_tag: '2027-12-01', letzter_tag: '2027-12-31' },
    ],
  };
}

export function lvBericht(nr: number | null): Bericht {
  return {
    kennung: LV_KENNUNG,
    vorlage: 'leistungsvergleich',
    vorlage_fassung: 1,
    geltung_art: 'unternehmen',
    geltung_id: UNTERNEHMEN_ID,
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH',
    zeitraum_art: 'monat',
    zeitraum: '2027-12',
    zeitraum_text: 'Dezember 2027',
    zeitzone: LV_ZONE,
    angelegt_von: IK,
    angelegt_am: LV_ZEIT.angelegt,
    archiviert_am: null,
    stand_zeichen: nr === null ? 'entwurf' : 'berichtsstand',
    stand_text: nr === null ? null : B.berichtsstand(nr),
    neueste_nr: nr,
    entwurf_datenstand: abzugR8().kopf.datenstand,
  };
}

export function lvDetail(nr: number | null): BerichtDetail {
  return {
    bericht: lvBericht(nr),
    staende:
      nr === null
        ? []
        : [{ nr: 1, datenstand: abzugR8().kopf.datenstand, freigegeben_am: LV_ZEIT.freigegeben, freigegeben_von: IK, pruefsumme: LV_PRUEFSUMME, ersetzt_durch_nr: null, anlass_anstoss_id: null }],
    anstoesse: [],
  };
}

export function lvEntwurf(): BerichtEntwurf {
  const datenstand = abzugR8().kopf.datenstand;
  return {
    kennung: LV_KENNUNG,
    datenstand,
    gebildet_von: 'anlegen',
    neu_gebildet: false,
    pruefsumme: LV_PRUEFSUMME,
    kopf: B.kopf(datenstand, LV_ZONE, null),
    teilansicht: null,
    abzug: abzugR8() as unknown as BerichtEntwurf['abzug'],
  };
}

export function lvStand(): BerichtStand {
  const a = abzugR8();
  return {
    kennung: LV_KENNUNG,
    nr: 1,
    datenstand: a.kopf.datenstand,
    freigegeben_am: LV_ZEIT.freigegeben,
    freigegeben_von: IK,
    pruefsumme: LV_PRUEFSUMME,
    pruefsumme_geprueft: true,
    ersetzt_durch_nr: null,
    anlass_anstoss_id: null,
    vorlage_fassung: 1,
    kopf: B.kopf(a.kopf.datenstand, LV_ZONE, { nr: 1, freigegeben_am: LV_ZEIT.freigegeben, freigegeben_von: IK.name }),
    teilansicht: null,
    darstellung: a.kopf.darstellung,
    regelwerk: a.kopf.regelwerk,
    abzug: a as unknown as BerichtStand['abzug'],
  };
}

/** 422 `basis_fehlt` des Lesers: ohne freigegebene Fassung am letzten Tag wird nichts angelegt. */
export const basisFehlt = (): ApiError =>
  new ApiError(422, 'ungesichert — noch kein Stand: für KZ-0004 gilt am 31.12.2027 keine freigegebene Bezugsbasis.', { code: 'basis_fehlt', message: 'ungesichert — noch kein Stand' });

/**
 * Die Routen der Bühne: Anlegen (nur Leistungsvergleich mit `kennzahl`), Entwurf, Freigabe zu Nr. 1 und die Dateien.
 * `zustand.nr` merkt sich, ob schon freigegeben ist; `zustand.anlegen` die Körper, die das Portal schickte.
 */
export function lvBuehne(zustand: { nr: number | null; anlegen: BerichtAnlegen[]; dateien: string[] } = { nr: null, anlegen: [], dateien: [] }) {
  return {
    kennzahlen: async () => ({ kennzahlen: lvKennzahlen() }),
    berichte: async () => ({ berichte: [lvBericht(zustand.nr)] }),
    berichtAnlegen: async (body: BerichtAnlegen) => {
      zustand.anlegen.push(body);
      if (body.vorlage === 'leistungsvergleich' && !body.kennzahl) throw new ApiError(400, 'Die Kennzahl fehlt.', { code: 'anfrage_ungueltig' });
      return lvBericht(zustand.nr);
    },
    bericht: async () => lvDetail(zustand.nr),
    berichtEntwurf: async () => lvEntwurf(),
    berichtStand: async () => lvStand(),
    berichtFreigeben: async () => {
      zustand.nr = 1;
      return lvStand();
    },
    berichtDatei: async (_kennung: string, nr: number, format: 'pdf' | 'csv') => {
      zustand.dateien.push(`${nr}.${format}`);
      return new Blob([format === 'pdf' ? '%PDF-1.7' : 'bericht;vorlage'], { type: format === 'pdf' ? 'application/pdf' : 'text/csv' });
    },
    messstellenRegister: async () => ({ register: [] }),
  };
}

export const LV_STANDORT = FIXTURE_IDS.st1;
