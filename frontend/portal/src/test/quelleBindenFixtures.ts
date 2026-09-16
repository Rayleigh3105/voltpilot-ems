import type {
  Messkanal,
  Messstelle,
  MessstelleQuelle,
  MessstelleQuelleGroesse,
  MessstelleQuellenListe,
} from '../api';
import { KOMPONENTE_IDS } from './messstelleDialogFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten für „Quelle binden“ und die Quelle-Karte (UEMS AP-04 IP-14, E3 · Abnahmefall A8) —
 * NUR aus dem Referenzunternehmen `docs/contracts/v2/uems-referenzunternehmen.json`
 * (Kunststoffwerk Ahrenberg), Momentaufnahme 20.10.2026:
 *
 * - `kanaeleK3` — Netzzähler Halle 1 (GR-2): „Wirkleistung“ als VORZEICHEN-Wert (Katalog
 *   `import_export` — er hat keine eine Richtung), „Wirkenergie Bezug“ und „Wirkenergie Abgabe“
 *   als Zählerstände.
 * - `kanaeleK1` — Hybrid-Wechselrichter 100 kW (GR-1): „PV-Leistung“, „Einspeise-/Bezugsleistung am
 *   Wechselrichter“ (ebenfalls ein Vorzeichen-Wert), „Speicherleistung“, „Ladestand“.
 * - `quellenMs01` — A8: MS-01 liest die Wirkleistung führend aus K-3 (312,4 kW) und vergleicht sie
 *   mit der Netzmessung des Wechselrichters K-1 (309,8 kW, Zweck Plausibilität). KEINE Bewertung.
 * - `quellenMs06` — der Zählerwechsel vom 18.11.2026: Z-5a bis 10:40, Lücke bis 10:47, dann Z-5b.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const MS01_ID = '3e000000-0000-4000-8000-000000000001';
export const MS06_ID = '3e000000-0000-4000-8000-000000000006';
export const K1_ID = 'c0000000-0000-4000-8000-000000000001';
export const K3_ID = KOMPONENTE_IDS.k3;
export const K5_ID = KOMPONENTE_IDS.k5;
export const ANLAGE_AN1 = FIXTURE_IDS.an1;

export const JETZT = '2026-10-20T10:15:00+02:00';
/** Nach dem Zählerwechsel an MS-06 (§5.13): Z-5a endete 10:40, Z-5b begann 10:47. */
export const JETZT_NACH_WECHSEL = '2026-11-20T08:30:00+01:00';

const kanal = (k: Partial<Messkanal> & Pick<Messkanal, 'kanal' | 'anzeigename'>): Messkanal => ({
  einheit: null,
  wertart: null,
  groesse: null,
  richtung: null,
  direction: null,
  aktiv: true,
  kadenz_s: 900,
  speist: [],
  ...k,
});

/** Die drei Messwerte des Netzzählers Halle 1 (K-3 · GR-2). */
export function kanaeleK3(): Messkanal[] {
  return [
    kanal({
      kanal: 'sunspec.model_203.totwhimp',
      anzeigename: 'Wirkenergie Bezug',
      einheit: 'kWh',
      wertart: 'counter',
      groesse: 'Wirkenergie',
      richtung: 'Bezug',
      direction: 'import',
    }),
    kanal({
      kanal: 'sunspec.model_203.totwhexp',
      anzeigename: 'Wirkenergie Abgabe',
      einheit: 'kWh',
      wertart: 'counter',
      groesse: 'Wirkenergie',
      richtung: 'Abgabe',
      direction: 'export',
    }),
    // Ein Vorzeichen-Wert: der Katalog kennt für ihn KEINE eine Richtung (AP-08 IP-7, E15).
    kanal({
      kanal: 'sunspec.model_203.w',
      anzeigename: 'Wirkleistung',
      einheit: 'kW',
      wertart: 'gauge',
      groesse: 'Wirkleistung',
      richtung: null,
      direction: 'import_export',
      kadenz_s: 10,
    }),
    kanal({
      kanal: 'sunspec.model_203.phv',
      anzeigename: 'Spannung L1',
      einheit: 'V',
      wertart: 'gauge',
      groesse: null,
      richtung: null,
      direction: 'none',
      kadenz_s: 10,
    }),
  ];
}

/** Die vier Messwerte des Hybrid-Wechselrichters (K-1 · GR-1). */
export function kanaeleK1(): Messkanal[] {
  return [
    kanal({
      kanal: 'sunspec.model_160.dcw',
      anzeigename: 'PV-Leistung',
      einheit: 'kW',
      wertart: 'gauge',
      groesse: 'Wirkleistung',
      richtung: 'Erzeugung',
      direction: 'generation',
      kadenz_s: 10,
    }),
    kanal({
      kanal: 'sunspec.model_701.w',
      anzeigename: 'Einspeise-/Bezugsleistung am Wechselrichter',
      einheit: 'kW',
      wertart: 'gauge',
      groesse: 'Wirkleistung',
      richtung: null,
      direction: 'import_export',
      kadenz_s: 10,
    }),
    kanal({
      kanal: 'sunspec.model_802.w',
      anzeigename: 'Speicherleistung',
      einheit: 'kW',
      wertart: 'gauge',
      groesse: 'Wirkleistung',
      richtung: 'Laden / Entladen',
      direction: 'charge_discharge',
      kadenz_s: 10,
    }),
    kanal({
      kanal: 'sunspec.model_802.soc',
      anzeigename: 'Ladestand',
      einheit: '%',
      wertart: 'gauge',
      groesse: 'Ladestand',
      richtung: 'richtungslos',
      direction: 'none',
      kadenz_s: 60,
    }),
  ];
}

interface QuelleEingabe {
  id: string;
  messstelleId?: string;
  groesse: string;
  richtung: string;
  rolle: 'fuehrend' | 'vergleich';
  zweck?: string | null;
  komponente: string;
  komponenteName: string;
  kanal: string;
  kanalName: string;
  wertart?: string;
  herleitung?: MessstelleQuelle['herleitung'];
  geraet: string;
  einbau?: string;
  ab: string;
  bis?: string | null;
  anteil?: 'positiv' | 'negativ' | null;
  wert?: number | null;
  einheit?: string | null;
  stand?: string;
  status?: MessstelleQuelle['status'];
}

export function quelle(e: QuelleEingabe): MessstelleQuelle {
  return {
    id: e.id,
    messstelle_id: e.messstelleId ?? MS01_ID,
    groesse: e.groesse,
    richtung: e.richtung,
    rolle: e.rolle,
    zweck: e.zweck ?? null,
    komponente: e.komponente,
    komponente_name: e.komponenteName,
    anlage: ANLAGE_AN1,
    kanal: e.kanal,
    kanal_name: e.kanalName,
    kanal_wertart: e.wertart ?? 'gauge',
    herleitung: e.herleitung ?? 'momentanwert',
    geraet: { id: `g-${e.geraet}`, geraet: e.geraet, einbau: e.einbau ?? e.geraet },
    gueltig_ab: e.ab,
    gueltig_bis: e.bis ?? null,
    status: e.status ?? (e.bis ? 'beendet' : 'gilt'),
    anfangsstand: null,
    endstand: null,
    rueckwirkend: false,
    herkunft: null,
    eingetragen_am: e.ab,
    eingetragen_von: 'Ines Kaltenbach',
    anteil: e.anteil ?? null,
    letzter_wert:
      e.wert === undefined || e.wert === null
        ? null
        : { wert: e.wert, text: null, einheit: e.einheit ?? 'kW', zeitpunkt: e.stand ?? JETZT },
  };
}

const groesse = (
  g: Partial<MessstelleQuelleGroesse> & Pick<MessstelleQuelleGroesse, 'groesse' | 'richtung' | 'einheit' | 'wertart'>,
): MessstelleQuelleGroesse => ({
  hauptgroesse: false,
  lebenszyklus: 'aktiv',
  fuehrend: null,
  vergleich: [],
  zeitstrahl: [],
  ...g,
});

/**
 * A8 — MS-01 „Netzbezug Halle 1“: die Hauptgröße liest den Zählerstand aus K-3; die Nebengröße
 * Wirkleistung liest den Bezugs-Teil des Vorzeichen-Werts aus K-3 (312,4 kW) und hat dazu die
 * Netzmessung des Wechselrichters als Vergleichsquelle (309,8 kW, Plausibilität).
 */
export function quellenMs01(): MessstelleQuellenListe {
  const ab = '2024-03-12T00:00:00+01:00';
  const vergleichAb = '2026-10-15T09:00:00+02:00';
  const haupt = quelle({
    id: 'q-ms01-energie',
    groesse: 'Wirkenergie',
    richtung: 'Bezug',
    rolle: 'fuehrend',
    komponente: K3_ID,
    komponenteName: 'Netzzähler Halle 1',
    kanal: 'sunspec.model_203.totwhimp',
    kanalName: 'Wirkenergie Bezug',
    wertart: 'counter',
    herleitung: 'zaehlerstand',
    geraet: 'GR-2',
    ab,
    wert: 1284912.4,
    einheit: 'kWh',
  });
  const leistung = quelle({
    id: 'q-ms01-leistung',
    groesse: 'Wirkleistung',
    richtung: 'Bezug',
    rolle: 'fuehrend',
    komponente: K3_ID,
    komponenteName: 'Netzzähler Halle 1',
    kanal: 'sunspec.model_203.w',
    kanalName: 'Wirkleistung',
    geraet: 'GR-2',
    ab,
    anteil: 'positiv',
    wert: 312.4,
  });
  const vergleich = quelle({
    id: 'q-ms01-vergleich',
    groesse: 'Wirkleistung',
    richtung: 'Bezug',
    rolle: 'vergleich',
    zweck: 'Plausibilität',
    komponente: K1_ID,
    komponenteName: 'Hybrid-Wechselrichter 100 kW',
    kanal: 'sunspec.model_701.w',
    kanalName: 'Einspeise-/Bezugsleistung am Wechselrichter',
    geraet: 'GR-1',
    ab: vergleichAb,
    anteil: 'positiv',
    wert: 309.8,
  });
  return {
    messstelle_id: MS01_ID,
    kennzeichen: 'MS-01',
    stichtag: JETZT,
    groessen: [
      groesse({
        groesse: 'Wirkenergie',
        richtung: 'Bezug',
        einheit: 'kWh',
        wertart: 'Zählerstand',
        hauptgroesse: true,
        fuehrend: haupt,
        zeitstrahl: [{ von: ab, bis: null, quelle: haupt.id }],
      }),
      groesse({
        groesse: 'Wirkleistung',
        richtung: 'Bezug',
        einheit: 'kW',
        wertart: 'Momentanwert',
        fuehrend: leistung,
        vergleich: [vergleich],
        zeitstrahl: [{ von: ab, bis: null, quelle: leistung.id }],
      }),
    ],
    quellen: [haupt, leistung, vergleich],
  };
}

/**
 * Der Zählerwechsel an MS-06 (§5.13, A1–A3): Z-5a bis 18.11.2026 10:40, die Lücke bis 10:47, dann
 * Z-5b. Die Lücke bleibt SICHTBAR — sie wird nie aufgefüllt.
 */
export function quellenMs06(): MessstelleQuellenListe {
  const ab = '2024-03-12T00:00:00+01:00';
  const ende = '2026-11-18T10:40:00+01:00';
  const neu = '2026-11-18T10:47:00+01:00';
  const alt = quelle({
    id: 'q-ms06-z5a',
    messstelleId: MS06_ID,
    groesse: 'Wirkenergie',
    richtung: 'Bezug',
    rolle: 'fuehrend',
    komponente: K5_ID,
    komponenteName: 'Unterzähler Spritzguss SG01–SG06',
    kanal: 'sunspec.model_203.totwhimp',
    kanalName: 'Wirkenergie Bezug',
    wertart: 'counter',
    herleitung: 'zaehlerstand',
    geraet: 'GR-4',
    einbau: 'Z-5a',
    ab,
    bis: ende,
  });
  const jung = quelle({
    id: 'q-ms06-z5b',
    messstelleId: MS06_ID,
    groesse: 'Wirkenergie',
    richtung: 'Bezug',
    rolle: 'fuehrend',
    komponente: K5_ID,
    komponenteName: 'Unterzähler Spritzguss SG01–SG06',
    kanal: 'sunspec.model_203.totwhimp',
    kanalName: 'Wirkenergie Bezug',
    wertart: 'counter',
    herleitung: 'zaehlerstand',
    geraet: 'GR-4',
    einbau: 'Z-5b',
    ab: neu,
    wert: 1483.6,
    einheit: 'kWh',
    stand: JETZT_NACH_WECHSEL,
  });
  return {
    messstelle_id: MS06_ID,
    kennzeichen: 'MS-06',
    stichtag: JETZT_NACH_WECHSEL,
    groessen: [
      groesse({
        groesse: 'Wirkenergie',
        richtung: 'Bezug',
        einheit: 'kWh',
        wertart: 'Zählerstand',
        hauptgroesse: true,
        fuehrend: jung,
        zeitstrahl: [
          { von: ab, bis: ende, quelle: alt.id },
          { von: ende, bis: neu, quelle: null },
          { von: neu, bis: null, quelle: jung.id },
        ],
      }),
    ],
    quellen: [alt, jung],
  };
}

/**
 * MS-01 „Netzbezug Halle 1“ als Stammsatz der Messstellen-Seite: Hauptgröße Wirkenergie · Bezug,
 * Nebengröße Wirkleistung · Bezug (die Größe, die den Vergleich trägt), Ort ST-1, Hauptzähler.
 */
export function ms01(): Messstelle {
  return {
    id: MS01_ID,
    kennzeichen: 'MS-01',
    name: 'Netzbezug Halle 1',
    art: 'gemessen',
    medium: 'Strom',
    lebenszyklus: 'aktiv',
    fehlt: [],
    notiz: null,
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    nebengroessen: [
      { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert', lebenszyklus: 'aktiv' },
    ],
    orte: [{ ort_art: 'standort', kennzeichen: 'ST-1', gueltig_ab: '2024-03-12', gueltig_bis: null }] as never,
    elektrische_stellung: [
      { anlage: ANLAGE_AN1, stellung: 'Hauptzähler', unterzaehler_von: null, gueltig_ab: '2024-03-12', gueltig_bis: null },
    ] as never,
    fuehrende_quelle: [
      { komponente: K3_ID, kanal: 'sunspec.model_203.totwhimp', gueltig_ab: '2024-03-12T00:00:00+01:00', gueltig_bis: null },
    ],
    anschlussleistung_kw: null,
  };
}
