import type {
  Device,
  FunktionStandort,
  Messstelle,
  MessstelleRegisterZeile,
  MessstelleStellung,
  MessstelleVorschlagGroesse,
  MessstelleVorschlagsliste,
  MessstelleVorschlagUebernehmen,
  MessstelleVorschlagUebernommen,
} from '../api';
import { messen as messenRegel } from '../uemsFunktion';
import {
  vorschlagsliste,
  type VorschlagEingang,
  type VorschlagKanal,
  type VorschlagKomponente,
  type VorschlagRolle,
} from '../uemsMessstelle';
import { funktionMessenEntwurf, funktionWerkAhrenberg } from './funktionenFixtures';
import { KOMPONENTE_IDS, registerZeile } from './messstelleDialogFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Die Schritte 3 bis 5 des Assistenten „Messen & Auswerten" (UEMS AP-01 IP-9b) —
 * NUR aus dem Referenzunternehmen `docs/contracts/v2/uems-referenzunternehmen.json`:
 *
 * - `eingangHalle2` — Werk Ahrenberg am 01.10.2026: Halle 2 (AN-2) mit dem
 *   WAGO-Controller C-1 und seinen vier Energiekarten K-8.1 … K-8.4 (Box Halle 2,
 *   VP-BOX-2026-0482); Halle 1 (AN-1) hat ihre Hauptzähler MS-01/MS-02 schon.
 * - `vorschlagHalle2` — die Antwort von `GET …/messstellen-vorschlag`, GEBILDET von
 *   der Regel `vorschlagsliste` (dem TS-Zwilling des Servers), nie abgeschrieben.
 * - `registerNachUebernahme` / `ahrenbergMessen` / `geraeteAhrenberg` — die Fakten der
 *   Prüfliste nach der Übernahme; der Zustand von „Messen & Auswerten" kommt aus `messen()`.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const C1_IDS = {
  k81: 'c0000000-0000-4000-8000-000000000081',
  k82: 'c0000000-0000-4000-8000-000000000082',
  k83: 'c0000000-0000-4000-8000-000000000083',
  k84: 'c0000000-0000-4000-8000-000000000084',
  boxHalle1: 'e0000000-0000-4000-8000-000000000001',
  boxHalle2: 'e0000000-0000-4000-8000-000000000002',
} as const;

/** Einbau des Controllers C-1 und Beginn der Speisung aller vier Energiekarten. */
export const C1_AB = '2026-10-01T00:00:00+02:00';

/** Die Energiekarten in der Referenzdatei — Kennzeichen, Name und die Messstelle, die sie heute speisen. */
export const ENERGIEKARTEN = [
  { id: C1_IDS.k81, kennzeichen: 'K-8.1', name: 'Zähler Energiekarte EK-1 (Hauptmessung Halle 2)', messstelle: 'MS-10', messstelleName: 'Netzbezug Halle 2', ort: 'G-2' },
  { id: C1_IDS.k82, kennzeichen: 'K-8.2', name: 'Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)', messstelle: 'MS-11', messstelleName: 'Spritzguss SG07–SG10', ort: 'B-4' },
  { id: C1_IDS.k83, kennzeichen: 'K-8.3', name: 'Zähler Energiekarte EK-3 (Montage M1)', messstelle: 'MS-12', messstelleName: 'Montage Linie M1', ort: 'B-3' },
  { id: C1_IDS.k84, kennzeichen: 'K-8.4', name: 'Zähler Energiekarte EK-4 (Lager Halle 2)', messstelle: 'MS-13', messstelleName: 'Lager Halle 2 (Allgemein)', ort: 'B-5' },
] as const;

/** Die Messwerte einer Energiekarte 750-494 (AP-05): Zählerstand Bezug und die Leistung in derselben Richtung. */
function kanaeleEnergiekarte(): VorschlagKanal[] {
  return [
    { kanal: 'Wirkenergie Bezug', anzeigename: 'Wirkenergie Bezug', groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'counter', direction: 'import', speist: null },
    { kanal: 'Wirkleistung', anzeigename: 'Wirkleistung', groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'gauge', direction: 'import', speist: null },
  ];
}

const karte = (id: string, name: string, rolle: VorschlagRolle): VorschlagKomponente => ({
  id,
  anlage: FIXTURE_IDS.an2,
  name,
  rolle,
  verlaufsbeginn: C1_AB,
  speisungAb: C1_AB,
  messkanaele: kanaeleEnergiekarte(),
});

/**
 * Die Eingänge der Vorschlagsregel für Werk Ahrenberg am 01.10.2026. `hauptzaehlerHalle2`
 * setzt einen Hauptzähler, den es an Halle 2 schon gibt (von Hand angelegt, ohne Quelle).
 */
export function eingangHalle2(opts: { hauptzaehlerHalle2?: string } = {}): VorschlagEingang {
  return {
    standort: { kennzeichen: 'ST-1', name: 'Werk Ahrenberg', beginn: '2024-03-12', zeitzone: 'Europe/Berlin' },
    anlagen: [
      {
        id: FIXTURE_IDS.an1,
        name: 'Werk Ahrenberg – Halle 1',
        netzanschluss: true,
        hauptzaehler: [
          { messstelle: 'MS-01', richtung: 'Bezug', komponente: KOMPONENTE_IDS.k3, seit: '2024-03-12' },
          { messstelle: 'MS-02', richtung: 'Abgabe', komponente: KOMPONENTE_IDS.k3, seit: '2024-03-12' },
        ],
      },
      {
        id: FIXTURE_IDS.an2,
        name: 'Werk Ahrenberg – Halle 2',
        netzanschluss: true,
        hauptzaehler: opts.hauptzaehlerHalle2
          ? [{ messstelle: opts.hauptzaehlerHalle2, richtung: 'Bezug', komponente: null, seit: '2026-10-01' }]
          : [],
      },
    ],
    komponenten: [
      karte(C1_IDS.k81, ENERGIEKARTEN[0].name, 'netzmessung'),
      karte(C1_IDS.k82, ENERGIEKARTEN[1].name, 'zaehler'),
      karte(C1_IDS.k83, ENERGIEKARTEN[2].name, 'zaehler'),
      karte(C1_IDS.k84, ENERGIEKARTEN[3].name, 'zaehler'),
    ],
    zaehler: 0,
    belegt: ['MS-01', 'MS-02', 'MS-03', 'MS-04', 'MS-05', 'MS-06', 'MS-07', 'MS-08', 'MS-09', ...(opts.hauptzaehlerHalle2 ? [opts.hauptzaehlerHalle2] : [])],
  };
}

/** `GET /api/v1/standorte/{ST-1}/messstellen-vorschlag` — das Urteil der Regel in der Form der Schnittstelle. */
export function vorschlagHalle2(opts: { hauptzaehlerHalle2?: string } = {}): MessstelleVorschlagsliste {
  const e = eingangHalle2(opts);
  const l = vorschlagsliste(e);
  const anlage = (id: string) => e.anlagen.find((a) => a.id === id)?.name ?? null;
  const komponente = (id: string) => e.komponenten.find((k) => k.id === id)?.name ?? null;
  const quelle = (q: (typeof l.vorschlaege)[number]['quelle']) => ({
    kanal: q.kanal,
    anzeigename: q.anzeigename,
    kanal_wertart: q.kanalWertart as 'counter' | 'gauge',
    herleitung: q.herleitung,
  });
  return {
    standort: FIXTURE_IDS.st1,
    standort_kennzeichen: 'ST-1',
    standort_name: 'Werk Ahrenberg',
    vorschlaege: l.vorschlaege.map((z) => ({
      kennzeichen: z.kennzeichen,
      name: z.name,
      anlage: z.anlage,
      anlage_name: anlage(z.anlage),
      komponente: z.komponente,
      komponente_name: komponente(z.komponente),
      hauptgroesse: z.hauptgroesse as MessstelleVorschlagGroesse,
      quelle: quelle(z.quelle),
      nebengroessen: z.nebengroessen.map((n) => ({ groesse: n.groesse as MessstelleVorschlagGroesse, quelle: quelle(n.quelle) })),
      stellung: z.stellung as MessstelleStellung | null,
      unterzaehler_von: z.unterzaehlerVon,
      ort: z.ort,
      ab: z.ab,
      stellung_ab: z.stellungAb,
      hinweise: z.hinweise,
    })),
    ausgelassen: l.ausgelassen.map((a) => ({
      anlage: a.anlage,
      komponente: a.komponente,
      komponente_name: komponente(a.komponente),
      kanal: a.kanal,
      grund: a.grund,
      zu: a.zu,
      text: a.text,
    })),
    leer: l.leer,
    text: l.text,
  };
}

/**
 * Die Antwort von `POST …/uebernehmen` auf eine Anfrage: je Zeile eine Messstelle mit dem
 * Kennzeichen des Vorschlags, am Standort ST-1 ab dem Tag des Verlaufsbeginns.
 */
export function uebernommen(
  liste: MessstelleVorschlagsliste,
  anfrage: MessstelleVorschlagUebernehmen,
): MessstelleVorschlagUebernommen<Messstelle> {
  return {
    neu: anfrage.vorschlaege.length,
    unveraendert: 0,
    messstellen: anfrage.vorschlaege.map((b) => {
      const v = liste.vorschlaege.find((x) => x.komponente === b.komponente && x.quelle.kanal === b.kanal)!;
      return {
        id: `ms-${v.kennzeichen.toLowerCase()}`,
        kennzeichen: v.kennzeichen,
        name: b.name ?? v.name,
        art: 'gemessen',
        medium: 'Strom',
        lebenszyklus: 'aktiv',
        fehlt: [],
        notiz: null,
        orte: [{ ort_art: 'standort', kennzeichen: v.ort, gueltig_ab: v.stellung_ab, gueltig_bis: null }],
      };
    }),
  };
}

/** Der Zeitpunkt der Momentaufnahme (wie `funktionMessenEntwurf`). */
export const JETZT = '2026-10-20T08:15:30Z';

type Beobachtung = 'liefert' | 'wartet';

/**
 * `GET /api/v1/messstellen?standort=ST-1` nach der Übernahme — MS-01 (Hauptzähler Halle 1) und
 * die vier Messstellen aus C-1 mit den Namen der Referenzdatei. `wartet` nennt die Kennzeichen,
 * die noch auf erste Daten warten (Referenz: „MS-12 wartet auf erste Daten — EK-3"); `ohne`
 * lässt Messstellen weg (etwa den Hauptzähler von Halle 2).
 */
export function registerNachUebernahme(opts: { wartet?: string[]; ohne?: string[] } = {}): MessstelleRegisterZeile[] {
  const { an1, an2, st1 } = FIXTURE_IDS;
  const zeile = (
    kennzeichen: string,
    name: string,
    anlage: string,
    stellung: MessstelleStellung,
    unterzaehlerVon: string | null,
    karte: (typeof ENERGIEKARTEN)[number] | null,
  ): MessstelleRegisterZeile => {
    const z = registerZeile({ kennzeichen, name, anlage, stellung, unterzaehlerVon });
    const b: Beobachtung = opts.wartet?.includes(kennzeichen) ? 'wartet' : 'liefert';
    return {
      ...z,
      ort: { ...z.ort, kennzeichen: 'ST-1', ort_art: 'standort', name: 'Werk Ahrenberg', standort: 'ST-1', standort_id: st1, standort_name: 'Werk Ahrenberg', grund: 'verortet' },
      quelle: karte
        ? {
            stand: 'gebunden',
            fuehrend: {
              id: `q-${kennzeichen.toLowerCase()}`,
              komponente: karte.id,
              komponente_name: karte.name,
              kanal: 'Wirkenergie Bezug',
              kanal_name: 'Wirkenergie Bezug',
              geraet: { id: 'gr-7', geraet: 'GR-7', einbau: 'C-1', bezeichnung: 'WAGO-Controller C-1' },
              gueltig_ab: C1_AB,
              gueltig_bis: null,
            },
            davor: null,
            vergleichsquellen: 0,
          }
        : { stand: 'gebunden', fuehrend: null, davor: null, vergleichsquellen: 0 },
      beobachtung:
        b === 'liefert'
          ? { zustand: 'liefert', text: 'Liefert Daten', seit: null, toleranz_s: 300, kadenz_s: 60, geraet: null }
          : { zustand: 'wartet_auf_erste_daten', text: 'Wartet auf erste Daten', seit: null, toleranz_s: 300, kadenz_s: 60, geraet: null },
    };
  };
  return [
    zeile('MS-01', 'Netzbezug Halle 1', an1, 'Hauptzähler', null, null),
    zeile('MS-0001', ENERGIEKARTEN[0].messstelleName, an2, 'Hauptzähler', null, ENERGIEKARTEN[0]),
    zeile('MS-0002', ENERGIEKARTEN[1].messstelleName, an2, 'Unterzähler', 'MS-0001', ENERGIEKARTEN[1]),
    zeile('MS-0003', ENERGIEKARTEN[2].messstelleName, an2, 'Unterzähler', 'MS-0001', ENERGIEKARTEN[2]),
    zeile('MS-0004', ENERGIEKARTEN[3].messstelleName, an2, 'Unterzähler', 'MS-0001', ENERGIEKARTEN[3]),
  ].filter((z) => !opts.ohne?.includes(z.kennzeichen));
}

/**
 * „Messen & Auswerten" für Werk Ahrenberg aus den Fakten des Registers und der Boxen — Zustand,
 * `fehlt` und Datenlage aus der Regel `messen()`, nie abgeschrieben.
 */
export function ahrenbergMessen(
  register: MessstelleRegisterZeile[],
  opts: { boxHalle2Verbunden?: boolean; jetzt?: string } = {},
): FunktionStandort {
  const jetzt = opts.jetzt ?? JETZT;
  const hauptzaehler = (anlage: string) =>
    register.filter((z) => z.elektrische_stellung?.anlage === anlage && z.elektrische_stellung.stellung === 'Hauptzähler').length;
  const m = messenRegel({
    standort: 'Werk Ahrenberg',
    angelegt: true,
    standortEingerichtet: true,
    standortArchiviertAm: null,
    eingerichtetAm: null,
    boxen: [
      { name: 'Box Halle 1', verbunden: true },
      { name: 'Box Halle 2', verbunden: opts.boxHalle2Verbunden ?? true },
    ],
    messstellen: register.map((z) => ({
      kennzeichen: z.kennzeichen,
      manuell: false,
      quelleVorhanden: true,
      letzterGuterWert: z.beobachtung?.zustand === 'liefert' ? jetzt : null,
      jeEinWert: z.beobachtung?.zustand === 'liefert',
      kadenzS: 60,
    })),
    anlagen: [
      { name: 'Werk Ahrenberg – Halle 1', hauptzaehlerAnzahl: hauptzaehler(FIXTURE_IDS.an1) },
      { name: 'Werk Ahrenberg – Halle 2', hauptzaehlerAnzahl: hauptzaehler(FIXTURE_IDS.an2) },
    ],
    jetzt,
    zeitzone: 'Europe/Berlin',
  });
  const fs = funktionMessenEntwurf(funktionWerkAhrenberg('bestand'));
  return { ...fs, messen: { zustand: m.zustand, seit: m.seit, text: m.text, fehlt: m.fehlt, datenlage: m.datenlage } };
}

type BoxStand = 'online' | 'offline' | 'wartet';

/** `GET /api/v1/devices` — Box Halle 1 (E-1) und Box Halle 2 (E-2), gemessen an `jetzt`. */
export function geraeteAhrenberg(jetzt: Date, halle2: BoxStand = 'online'): Device[] {
  const vor = (s: number) => new Date(jetzt.getTime() - s * 1000).toISOString();
  const box = (id: string, siteId: string, externalRef: string, name: string, lastSeenAt: string | null): Device =>
    ({ id, siteId, externalRef, kind: 'edge', name, status: 'claimed', lastSeenAt, createdAt: '2026-09-30T08:00:00Z' }) as Device;
  return [
    box(C1_IDS.boxHalle1, FIXTURE_IDS.an1, 'VP-BOX-2024-0117', 'Box Halle 1', vor(40)),
    box(
      C1_IDS.boxHalle2,
      FIXTURE_IDS.an2,
      'VP-BOX-2026-0482',
      'Box Halle 2',
      halle2 === 'online' ? vor(55) : halle2 === 'offline' ? vor(2 * 3600) : null,
    ),
  ];
}
