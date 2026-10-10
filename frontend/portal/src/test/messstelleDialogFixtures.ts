import type {
  Messkanal,
  MesskanalListe,
  Messstelle,
  MessstelleRegisterZeile,
  MessstellenRegister,
  MessstelleStellung,
  SiteEntities,
  SiteEntity,
} from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten für den Messstellen-Dialog (UEMS AP-04 IP-6) — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json` (Fassung 1.1), Momentaufnahme 20.10.2026:
 *
 * - `registerHeute` — AN-1 Werk Ahrenberg – Halle 1: MS-01 Netzbezug Halle 1 und MS-02
 *   Netzeinspeisung Halle 1 (beide Hauptzähler an K-3), MS-06 Spritzguss SG01–SG06 (Unterzähler
 *   von MS-01); AN-2: MS-10 Netzbezug Halle 2, MS-11 Spritzguss SG07–SG10; AN-3: MS-16 Netzbezug
 *   Lindach.
 * - `komponentenHalle1` — K-3 Netzzähler Halle 1 und K-5 Unterzähler Spritzguss SG01–SG06.
 * - `kanaeleK5` — Wirkenergie Bezug (speist MS-06 führend), Wirkleistung, Wirkenergie Abgabe.
 * - `VORSCHLAG` — das nächste automatische Kennzeichen, wie in der FEHLER-Tabelle („MS-0022“).
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const VORSCHLAG = 'MS-0022';

export const KOMPONENTE_IDS = { k3: 'c0000000-0000-4000-8000-000000000003', k5: 'c0000000-0000-4000-8000-000000000005' } as const;

export function registerZeile(e: {
  kennzeichen: string;
  name: string;
  anlage: string | null;
  stellung?: MessstelleStellung;
  unterzaehlerVon?: string | null;
  richtung?: string;
  lebenszyklus?: MessstelleRegisterZeile['lebenszyklus'];
}): MessstelleRegisterZeile {
  return {
    id: `ms-${e.kennzeichen.toLowerCase()}`,
    kennzeichen: e.kennzeichen,
    name: e.name,
    art: 'gemessen',
    medium: 'Strom',
    hauptgroesse: { groesse: 'Wirkenergie', richtung: e.richtung ?? 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    ort: {
      id: null,
      kennzeichen: null,
      ort_art: null,
      name: null,
      gueltig_ab: null,
      gueltig_bis: null,
      pfad: [],
      standort: null,
      standort_id: null,
      standort_name: null,
      grund: 'nicht_verortet',
    },
    elektrische_stellung: e.anlage
      ? {
          anlage: e.anlage,
          anlage_name: null,
          stellung: e.stellung ?? 'Hauptzähler',
          unterzaehler_von: e.unterzaehlerVon ?? null,
          gueltig_ab: '2024-03-12',
          gueltig_bis: null,
        }
      : null,
    quelle: { stand: 'keine_datenquelle', fuehrend: null, davor: null, vergleichsquellen: 0 },
    lebenszyklus: e.lebenszyklus ?? 'aktiv',
    fehlt: [],
    angehalten_ab: null,
    archiviert_am: null,
    beobachtung: null,
    letzter_wert: null,
    nebengroessen: [],
    berechnung: null,
  };
}

export function registerHeute(): MessstelleRegisterZeile[] {
  const { an1, an2, an3 } = FIXTURE_IDS;
  return [
    registerZeile({ kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: an1 }),
    registerZeile({ kennzeichen: 'MS-02', name: 'Netzeinspeisung Halle 1', anlage: an1, richtung: 'Abgabe' }),
    registerZeile({ kennzeichen: 'MS-06', name: 'Spritzguss SG01–SG06', anlage: an1, stellung: 'Unterzähler', unterzaehlerVon: 'MS-01' }),
    registerZeile({ kennzeichen: 'MS-10', name: 'Netzbezug Halle 2', anlage: an2 }),
    registerZeile({ kennzeichen: 'MS-11', name: 'Spritzguss SG07–SG10', anlage: an2, stellung: 'Unterzähler', unterzaehlerVon: 'MS-10' }),
    registerZeile({ kennzeichen: 'MS-16', name: 'Netzbezug Lindach', anlage: an3 }),
  ];
}

/** `GET /api/v1/messstellen` mit dem Register von heute. */
export function registerAntwort(): MessstellenRegister {
  const register = registerHeute();
  return {
    messstellen: [],
    register,
    stichtag: '2026-10-20',
    zeitpunkt: '2026-10-20T09:00:00+02:00',
    teilansicht: false,
    aggregat: {
      unternehmen: { erfuellt: 0, gesamt: register.length, text: '0 von 6 Messstellen liefern Daten' },
      standorte: [],
    },
  };
}

function komponente(id: string, label: string, typeLabel: string): SiteEntity {
  return {
    id,
    entityType: 'modbus-generic',
    typeLabel,
    role: 'meter',
    label,
    control: false,
    deviceId: 'gr-4',
    capabilities: null,
    guards: null,
    syncStatus: 'in_sync',
    observed: null,
    edgeSourceId: null,
  };
}

/** `GET /api/v1/sites/{AN-1}/entities` — die beiden Zähler der Halle 1. */
export function komponentenHalle1(): SiteEntities {
  return {
    registry: null,
    localSetup: [],
    staleOnDevice: [],
    entities: [
      komponente(KOMPONENTE_IDS.k3, 'Netzzähler Halle 1', 'Zähler'),
      komponente(KOMPONENTE_IDS.k5, 'Unterzähler Spritzguss SG01–SG06', 'Zähler'),
    ],
  };
}

const speistMs06 = {
  messstelle_id: 'ms-ms-06',
  messstelle: 'MS-06',
  groesse: 'Wirkenergie',
  richtung: 'Bezug',
  rolle: 'fuehrend' as const,
  zweck: null,
  gueltig_ab: '2024-03-12T00:00:00+01:00',
  gueltig_bis: null,
};

/** Die drei Messwerte von K-5 — der erste speist MS-06 führend. */
export function kanaeleK5(): Messkanal[] {
  return [
    {
      kanal: 'active_energy_import',
      anzeigename: 'Wirkenergie Bezug',
      einheit: 'kWh',
      wertart: 'counter',
      groesse: 'Wirkenergie',
      richtung: 'Bezug',
      aktiv: true,
      kadenz_s: 900,
      speist: [speistMs06],
    },
    {
      kanal: 'active_power',
      anzeigename: 'Wirkleistung',
      einheit: 'kW',
      wertart: 'gauge',
      groesse: 'Wirkleistung',
      richtung: 'Bezug',
      aktiv: true,
      kadenz_s: 10,
      speist: [],
    },
    {
      kanal: 'active_energy_export',
      anzeigename: 'Wirkenergie Abgabe',
      einheit: 'kWh',
      wertart: 'counter',
      groesse: 'Wirkenergie',
      richtung: 'Abgabe',
      aktiv: true,
      kadenz_s: 900,
      speist: [],
    },
  ];
}

/** Ein zweiter Zähler an K-5 für die neue Messstelle: derselbe Messwert, noch von niemandem führend gelesen. */
export function kanaeleK5Frei(): MesskanalListe {
  return {
    site_id: FIXTURE_IDS.an1,
    komponente: KOMPONENTE_IDS.k5,
    inhaltsstand: null,
    messkanaele: kanaeleK5().map((k) => ({ ...k, speist: [] })),
  };
}

/** Die Antwort auf `POST /api/v1/messstellen`: ohne Ort ein Entwurf. */
export function messstelleAngelegt(over: Partial<Messstelle> = {}): Messstelle {
  return {
    id: 'ms-neu',
    kennzeichen: VORSCHLAG,
    name: 'Spritzguss SG01–SG06 Kühlung',
    art: 'gemessen',
    medium: 'Strom',
    lebenszyklus: 'entwurf',
    fehlt: ['ort'],
    notiz: null,
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' },
    nebengroessen: [],
    orte: [],
    elektrische_stellung: [],
    fuehrende_quelle: [],
    anschlussleistung_kw: null,
    ...over,
  };
}
