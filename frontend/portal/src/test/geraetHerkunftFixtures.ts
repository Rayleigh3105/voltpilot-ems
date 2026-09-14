/**
 * Die Antworten der Routen für die ergänzte Geräteseite (UEMS AP-04 IP-12) —
 * am Referenzunternehmen Ahrenberg (`docs/contracts/v2/uems-referenzunternehmen.json`
 * Fassung 1.1). Geteilt von Vitest und der E2E-Bühne `e2e/geraet-herkunft`.
 *
 * - **GR-4** „Unterzähler Spritzguss“ nach dem Zählerwechsel Z-5a → Z-5b am
 *   18.11.2026 10:40 (A1): Komponente K-5, Messstelle MS-06 mit Hauptgröße
 *   Wirkenergie Bezug und Nebengröße Wirkleistung, Kadenz 60 s.
 * - **GR-7** WAGO-Controller C-1 mit EK-1…EK-4 auf den Steckplätzen 2…5;
 *   K-8.2 (EK-2) speist MS-11; der Wandler 250/5 → 400/5 A ab 01.02.2027,
 *   tatsächlich getauscht am 20.01.2027 (A5), eingetragen am 25.01.2027.
 *
 * Nicht in der Referenz und deshalb ERFUNDEN (je Stelle benannt): die
 * Katalog-Namen der Kanäle (`energy_import_kwh` …), „Wirkenergie Abgabe“ an K-5
 * als nicht gebundener Kanal, die Wandler an K-8.1/K-8.3 als Fassung 1 aus der
 * Einrichtung, der Eintragszeitpunkt 25.01.2027 09:00 und die Begründung.
 */
import type {
  EinstellungFassung,
  GeraetEinstellungen,
  MesskanalListe,
  MesskanalSpeist,
  UemsGeraet,
} from '../api';

export const SITE_HALLE_1 = 'site-an-1';
export const SITE_HALLE_2 = 'site-an-2';
export const K5 = 'k-5';
export const K8 = ['k-8-1', 'k-8-2', 'k-8-3', 'k-8-4'] as const;

/** Stand der Ansicht GR-4: zwei Tage nach dem Zählerwechsel. */
export const JETZT_GR4 = '2026-11-20T09:00:00+01:00';
/** Stand der Ansicht C-1: der Wandler ist eingetragen, gilt aber erst ab 01.02.2027. */
export const JETZT_C1 = '2027-01-25T09:15:00+01:00';

const WECHSEL = '2026-11-18T10:40:00+01:00';
const C1_EINBAU = '2026-10-01T00:00:00+02:00';

export function gr4Z5b(): UemsGeraet {
  return {
    id: 'g-z5b',
    kennzeichen: 'GR-4',
    einbau_kennzeichen: 'Z-5b',
    geraeteart: 'zaehler',
    hersteller: null,
    typ: null,
    seriennummer: '88231',
    bezeichnung: null,
    eingebaut_am: WECHSEL,
    ausgebaut_am: null,
    aus_bestand: false,
    komponenten: [{ entity_id: K5, gueltig_ab: WECHSEL, gueltig_bis: null }],
    teile: [],
    vorgaenger: [
      {
        id: 'g-z5a',
        einbau_kennzeichen: 'Z-5a',
        hersteller: null,
        typ: null,
        seriennummer: '4471023',
        eingebaut_am: '2024-03-12T00:00:00+01:00',
        ausgebaut_am: WECHSEL,
      },
    ],
  };
}

/** Z-5a steht in der Anlagen-Liste als eigener, ausgebauter Einbau — die Fläche darf ihn nicht wählen. */
export function gr4Z5a(): UemsGeraet {
  return {
    ...gr4Z5b(),
    id: 'g-z5a',
    einbau_kennzeichen: 'Z-5a',
    seriennummer: '4471023',
    eingebaut_am: '2024-03-12T00:00:00+01:00',
    ausgebaut_am: WECHSEL,
    komponenten: [{ entity_id: K5, gueltig_ab: '2024-03-12T00:00:00+01:00', gueltig_bis: WECHSEL }],
    vorgaenger: [],
  };
}

export function c1(): UemsGeraet {
  return {
    id: 'g-c1',
    kennzeichen: 'GR-7',
    einbau_kennzeichen: 'C-1',
    geraeteart: 'controller',
    hersteller: 'WAGO',
    typ: 'PFC200 750-8212',
    seriennummer: null,
    bezeichnung: null,
    eingebaut_am: C1_EINBAU,
    ausgebaut_am: null,
    aus_bestand: false,
    komponenten: K8.map((entity_id) => ({ entity_id, gueltig_ab: C1_EINBAU, gueltig_bis: null })),
    teile: K8.map((_, i) => ({
      id: `t-ek-${i + 1}`,
      teilart: 'energiekarte',
      steckplatz: i + 2,
      bezeichnung: `EK-${i + 1}`,
      typ: '750-494/000-001 (5 A)',
      seriennummer: null,
      eingebaut_am: C1_EINBAU,
      ausgebaut_am: null,
    })),
    vorgaenger: [],
  };
}

function speist(messstelle: string, groesse: string, gueltigAb: string): MesskanalSpeist {
  return {
    messstelle_id: `ms-${messstelle}`,
    messstelle,
    groesse,
    richtung: 'Bezug',
    rolle: 'fuehrend',
    zweck: null,
    gueltig_ab: gueltigAb,
    gueltig_bis: null,
  };
}

export function k5Kanaele(): MesskanalListe {
  return {
    site_id: SITE_HALLE_1,
    komponente: K5,
    inhaltsstand: '2026.09.11.1',
    messkanaele: [
      {
        kanal: 'energy_import_kwh',
        anzeigename: 'Wirkenergie Bezug',
        einheit: 'kWh',
        wertart: 'counter',
        groesse: 'Wirkenergie',
        richtung: 'Bezug',
        aktiv: true,
        kadenz_s: 60,
        speist: [speist('MS-06', 'Wirkenergie', WECHSEL)],
      },
      {
        kanal: 'active_power_kw',
        anzeigename: 'Wirkleistung',
        einheit: 'kW',
        wertart: 'gauge',
        groesse: 'Wirkleistung',
        richtung: 'Bezug',
        aktiv: true,
        kadenz_s: 60,
        speist: [speist('MS-06', 'Wirkleistung', WECHSEL)],
      },
      {
        // Erfunden: ein gelesener, aber nicht gebundener Kanal.
        kanal: 'energy_export_kwh',
        anzeigename: 'Wirkenergie Abgabe',
        einheit: 'kWh',
        wertart: 'counter',
        groesse: 'Wirkenergie',
        richtung: 'Abgabe',
        aktiv: true,
        kadenz_s: 900,
        speist: [],
      },
    ],
  };
}

export function k82Kanaele(): MesskanalListe {
  return {
    site_id: SITE_HALLE_2,
    komponente: K8[1],
    inhaltsstand: '2026.09.11.1',
    messkanaele: [
      {
        kanal: 'energy_import_kwh',
        anzeigename: 'Wirkenergie Bezug',
        einheit: 'kWh',
        wertart: 'counter',
        groesse: 'Wirkenergie',
        richtung: 'Bezug',
        aktiv: true,
        kadenz_s: 60,
        speist: [speist('MS-11', 'Wirkenergie', C1_EINBAU)],
      },
      {
        kanal: 'active_power_kw',
        anzeigename: 'Wirkleistung gesamt',
        einheit: 'kW',
        wertart: 'gauge',
        groesse: 'Wirkleistung',
        richtung: 'Bezug',
        aktiv: true,
        kadenz_s: 60,
        speist: [],
      },
    ],
  };
}

export function gr4Einstellungen(): GeraetEinstellungen {
  return { geraet_id: 'g-z5b', geraet: 'GR-4', einbau: 'Z-5b', stichtag: JETZT_GR4, gueltig: [], historie: [] };
}

function wandler(entity: string, primaer: number, over: Partial<EinstellungFassung> = {}): EinstellungFassung {
  return {
    id: `f-${entity}-${primaer}`,
    entity_id: entity,
    kanal: null,
    art: 'wandler_strom',
    art_kundenwort: 'Wandlerverhältnis Strom',
    wert: { primaer_a: primaer, sekundaer_a: 5 },
    wert_text: `${primaer}/5 A`,
    anwendung: 'angewendet',
    anwendung_text: 'angewendet — mit der Verbindung zugestellt',
    zustellung: 'verbindung',
    herkunft: 'bestand',
    gueltig_ab: C1_EINBAU,
    gueltig_bis: null,
    status: 'gueltig',
    tatsaechlich_ab: null,
    rueckwirkend: false,
    begruendung: null,
    eingetragen: { am: C1_EINBAU, von: 'VoltPilot', rolle: null, art: null },
    ...over,
  };
}

export function c1Einstellungen(): GeraetEinstellungen {
  const ab = '2027-02-01T00:00:00+01:00';
  const historie = [
    wandler(K8[0], 400),
    wandler(K8[1], 250, { gueltig_bis: ab }),
    wandler(K8[1], 400, {
      anwendung_text: 'angewendet — Zustellung ausstehend',
      zustellung: 'ausstehend',
      herkunft: 'eintrag',
      gueltig_ab: ab,
      status: 'geplant',
      tatsaechlich_ab: '2027-01-20T00:00:00+01:00',
      begruendung: 'Wandler SG07–SG10 getauscht',
      eingetragen: { am: '2027-01-25T09:00:00+01:00', von: 'Ines Kaltenbach', rolle: 'Energiemanager', art: 'benutzer' },
    }),
    wandler(K8[2], 100),
    wandler(K8[3], 60),
  ];
  return {
    geraet_id: 'g-c1',
    geraet: 'GR-7',
    einbau: 'C-1',
    stichtag: JETZT_C1,
    gueltig: historie.filter((f) => f.status === 'gueltig'),
    historie,
  };
}

/** Die Namen der vier Energiekarten-Komponenten aus der Referenz. */
export const K8_NAMEN: Record<string, string> = {
  [K8[0]]: 'Zähler Energiekarte EK-1 (Hauptmessung Halle 2)',
  [K8[1]]: 'Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)',
  [K8[2]]: 'Zähler Energiekarte EK-3 (Montage M1)',
  [K8[3]]: 'Zähler Energiekarte EK-4 (Lager Halle 2)',
};
