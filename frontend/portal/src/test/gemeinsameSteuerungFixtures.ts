import type {
  Device,
  UemsDatenquelle,
  UemsGemeinsameSteuerungEinrichten,
  UemsGemeinsameSteuerungZustand,
  UemsVerlustSumme,
} from '../api';
import { C1_IDS } from './messenAssistentFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * AP-15 IP-23 — die Gemeinsame Steuerung V-1 an AN-1 (Werk Ahrenberg – Halle 1) aus der Referenzdatei 1.5
 * (`docs/contracts/v2/uems-referenzunternehmen.json`, `gemeinsame_steuerungen[]`, `geraete_rueckfaelle[]`):
 * E-1 Box Halle 1 führt (Messpunkt DQ-2, Netzzähler), E-4 Box Verwaltung steuert mit (Messpunkt DQ-10,
 * Abgangszähler PV und Ladepark Verwaltung). Grenzen NA-1: Einspeisung 100 kW, Bezug 550 kW; Vorbehalt Bezug
 * 1,1 × 430 = 473 kW. Auslegung: Einspeisung 40 / 60 kW, Bezug 0 / 77 kW, beide `passt`.
 * API-förmig, nur für Tests und die E2E-Bühne, nie ins Produktionsbündel.
 */
export const GS_IDS = {
  e1: C1_IDS.boxHalle1,
  e4: 'e0000000-0000-4000-8000-000000000004',
  dq1: 'd9000000-0000-4000-8000-000000000001',
  dq2: 'd9000000-0000-4000-8000-000000000002',
  dq8: 'd9000000-0000-4000-8000-000000000008',
  dq9: 'd9000000-0000-4000-8000-000000000009',
  dq10: 'd9000000-0000-4000-8000-000000000010',
  k1: 'c0000000-0000-4000-8000-000000000001',
  k2: 'c0000000-0000-4000-8000-000000000002',
  k3: 'c0000000-0000-4000-8000-000000000003',
  k12: 'c0000000-0000-4000-8000-000000000012',
  k14: 'c0000000-0000-4000-8000-000000000014',
  k13: (n: number) => `c0000000-0000-4000-8000-0000000013${String(n).padStart(2, '0')}`,
} as const;

const LADEPUNKTE = [1, 2, 3, 4, 5, 6];

/** Die zwei Boxen von AN-1; `verwaltungSeit` = letzter Herzschlag von E-4 (für A1). */
export function gsBoxen(jetzt: Date, opts: { halle1Seit?: number; verwaltungSeit?: number } = {}): Device[] {
  const vor = (s: number) => new Date(jetzt.getTime() - s * 1000).toISOString();
  const box = (id: string, ref: string, name: string, s: number, fuehrt: boolean): Device =>
    ({ id, siteId: FIXTURE_IDS.an1, externalRef: ref, kind: 'edge', name, status: 'claimed', lastSeenAt: vor(s),
      createdAt: '2027-05-03T08:00:00Z', fuehrtAnlage: fuehrt }) as Device;
  return [
    box(GS_IDS.e1, 'VP-BOX-2024-0117', 'Box Halle 1', opts.halle1Seit ?? 40, true),
    box(GS_IDS.e4, 'VP-BOX-2027-0211', 'Box Verwaltung', opts.verwaltungSeit ?? 35, false),
  ];
}

export function gsDatenquellen(): UemsDatenquelle[] {
  const q = (id: string, kennzeichen: string, name: string, box: string, boxName: string) =>
    ({ id, kennzeichen, name, anlage: FIXTURE_IDS.an1, protokoll: 'modbus_tcp', adresse: '192.168.40.10:502', geraete_ids: [1],
      netz: null, mehrere_leser: false, steuerquelle: false, vergleichsquelle: false, kadenz_s: 5, archiviert_am: null,
      zustaendige_box: { id: box, name: boxName, heimat_anlage: FIXTURE_IDS.an1 }, zeitraeume: [] }) as UemsDatenquelle;
  return [
    q(GS_IDS.dq1, 'DQ-1', 'Hybrid-Wechselrichter Halle 1', GS_IDS.e1, 'Box Halle 1'),
    q(GS_IDS.dq2, 'DQ-2', 'Netzzähler Halle 1', GS_IDS.e1, 'Box Halle 1'),
    q(GS_IDS.dq8, 'DQ-8', 'PV-Wechselrichter Verwaltung', GS_IDS.e4, 'Box Verwaltung'),
    q(GS_IDS.dq9, 'DQ-9', 'Ladepark Verwaltung', GS_IDS.e4, 'Box Verwaltung'),
    q(GS_IDS.dq10, 'DQ-10', 'Abgangszähler PV und Ladepark Verwaltung', GS_IDS.e4, 'Box Verwaltung'),
  ];
}

const KOMPONENTEN_E1 = [
  { komponente_id: GS_IDS.k1, name: 'Hybrid-Wechselrichter 100 kW', typ: 'battery-hybrid', schreibfreigabe: true, richtungen: ['einspeisung' as const], nenn_kw: 100 },
  // Ein Speicher hat im Bestand keine Nennleistung (Vertrag §6a) — die Folge fragt sie ab.
  { komponente_id: GS_IDS.k2, name: 'Batteriespeicher 200 kWh', typ: 'battery', schreibfreigabe: true, richtungen: ['bezug' as const], nenn_kw: null },
  { komponente_id: GS_IDS.k3, name: 'Netzzähler Halle 1', typ: 'grid-meter', schreibfreigabe: false, richtungen: [], nenn_kw: null },
];

const KOMPONENTEN_E4 = [
  { komponente_id: GS_IDS.k12, name: 'PV-Wechselrichter Verwaltung 60 kW', typ: 'pv-inverter', schreibfreigabe: true, richtungen: ['einspeisung' as const], nenn_kw: 60 },
  ...LADEPUNKTE.map((n) => ({
    komponente_id: GS_IDS.k13(n), name: `Ladepunkt AHR-LP-0${n + 1} Parkplatz Verwaltung (22 kW)`, typ: 'ev-charger',
    schreibfreigabe: true, richtungen: ['bezug' as const], nenn_kw: 22,
  })),
  { komponente_id: GS_IDS.k14, name: 'Abgangszähler PV und Ladepark Verwaltung', typ: 'meter', schreibfreigabe: false, richtungen: [], nenn_kw: null },
];

/** `GET …/einrichten` ohne Gemeinsame Steuerung: nur der Vorschlag (Fragen 1–5). */
export function gsVorschlag(opts: { netzzaehler?: boolean; grenzen?: boolean } = {}): UemsGemeinsameSteuerungEinrichten {
  return {
    eingerichtet: false,
    netzzaehler_box_id: opts.netzzaehler === false ? null : GS_IDS.e1,
    grenzen: opts.grenzen === false ? { einspeisung_kw: null, bezug_kw: null } : { einspeisung_kw: 100, bezug_kw: 550 },
    boxen: [
      { box_id: GS_IDS.e1, name: 'Box Halle 1', rolle: null, messpunkt_id: null, liest_netzzaehler: opts.netzzaehler !== false,
        komponenten: KOMPONENTEN_E1, geraete_erklaert: false, geraete: [], ungeregelt: [] },
      { box_id: GS_IDS.e4, name: 'Box Verwaltung', rolle: null, messpunkt_id: null, liest_netzzaehler: false,
        komponenten: KOMPONENTEN_E4, geraete_erklaert: false, geraete: [], ungeregelt: [] },
    ],
    ungesteuerte_erzeuger: null,
    vorbehalt: { aus_messwerten: { kw: 473, hoechstwert_kw: 430, messtage: 14 } },
    ergebnis: null,
    hinweise: opts.netzzaehler === false ? [{ wort: 'netzzaehler_nicht_gelesen' }] : [],
  };
}

/** `GET …/einrichten` nach dem Einrichten: die Erklärung mit Rückfällen (IP-6) und die Auslegung (Frage 6). */
export function gsEingerichtet(): UemsGemeinsameSteuerungEinrichten {
  const v = gsVorschlag();
  return {
    ...v,
    eingerichtet: true,
    boxen: [
      { ...v.boxen[0], rolle: 'fuehrt', messpunkt_id: GS_IDS.dq2, geraete_erklaert: true, geraete: [
        { komponente_id: GS_IDS.k1, richtung: 'einspeisung', nenn_kw: 100, schreibfreigabe: true, rueckfall: 'faellt_auf_wert', rueckfall_kw: 40, rueckfall_herkunft: 'am_geraet' },
        { komponente_id: GS_IDS.k2, richtung: 'bezug', nenn_kw: 100, schreibfreigabe: true, rueckfall: 'faellt_auf_wert', rueckfall_kw: 0, rueckfall_herkunft: 'am_geraet' },
      ] },
      { ...v.boxen[1], rolle: 'steuert_mit', messpunkt_id: GS_IDS.dq10, geraete_erklaert: true, geraete: [
        { komponente_id: GS_IDS.k12, richtung: 'einspeisung', nenn_kw: 60, schreibfreigabe: true, rueckfall: 'laeuft_frei', rueckfall_kw: 60, rueckfall_herkunft: 'katalog' },
        ...LADEPUNKTE.map((n) => ({ komponente_id: GS_IDS.k13(n), richtung: 'bezug' as const, nenn_kw: 22, schreibfreigabe: true,
          rueckfall: 'faellt_auf_wert', rueckfall_kw: 4.1, rueckfall_herkunft: 'katalog' as const })),
      ] },
    ],
    ungesteuerte_erzeuger: 'keine',
    vorbehalt: { einspeisung_kw: 0, bezug_kw: 473, bezug_herkunft: 'erklaert', aus_messwerten: { kw: 473, hoechstwert_kw: 430, messtage: 14 } },
    ergebnis: {
      einspeisung: { urteil: 'passt', grenze_kw: 100, vorbehalt_kw: 0, verteilbar_kw: 100, summe_rueckfall_kw: 100,
        anteile: [{ box_id: GS_IDS.e1, kw: 40 }, { box_id: GS_IDS.e4, kw: 60 }], ungenutzt_kw: 0 },
      bezug: { urteil: 'passt', grenze_kw: 550, vorbehalt_kw: 473, verteilbar_kw: 77, summe_rueckfall_kw: 24.6,
        anteile: [{ box_id: GS_IDS.e1, kw: 0 }, { box_id: GS_IDS.e4, kw: 77 }], ungenutzt_kw: 0 },
    },
    hinweise: [],
  };
}

export type GsLage = 'nicht_eingerichtet' | 'erklaert' | 'beobachtet' | 'anteile_aktiv' | 'angehalten' | 'angehalten_betreiber';

/** Die wirksamen Anteile je Box (quittiert); Vorgabe = die Auslegung 40/0 und 60/77. */
export type GsWirksam = { e1?: WirksameAnteile | null; e4?: WirksameAnteile | null };
type WirksameAnteile = { einspeisung_kw?: number | null; bezug_kw?: number | null };
const AUSLEGUNG: Required<GsWirksam> = { e1: { einspeisung_kw: 40, bezug_kw: 0 }, e4: { einspeisung_kw: 60, bezug_kw: 77 } };
/** R-G4: der Betreiber ist beim Scharfschalten abgewichen (innerhalb G2/G3) — 30/70 statt 40/60, Bezug 5/72. */
export const GS_ABWEICHEND: Required<GsWirksam> = { e1: { einspeisung_kw: 30, bezug_kw: 5 }, e4: { einspeisung_kw: 70, bezug_kw: 72 } };

/**
 * `GET …/gemeinsame-steuerung` je Lage; `verlust` = was E-4 heute gemeldet hat (IP-22). Mit Anteilen in Kraft trägt
 * jedes Mitglied seine wirksamen (quittierten) Anteile — Vorgabe die Auslegung — und mit `jetzt` seinen letzten
 * Herzschlag (`halle1Seit`/`verwaltungSeit` Sekunden davor; für A1/A2/A4).
 */
export function gsZustand(
  l: GsLage,
  verlust: UemsVerlustSumme | null = null,
  opts: { wirksam?: GsWirksam; jetzt?: Date; halle1Seit?: number; verwaltungSeit?: number } = {},
): UemsGemeinsameSteuerungZustand {
  if (l === 'nicht_eingerichtet') return { eingerichtet: false, zustand: 'nicht_eingerichtet', mitglieder: [], fehlt: [] };
  const zustand = l === 'angehalten_betreiber' ? 'angehalten' : l;
  const stufe = l === 'erklaert' ? 'S0' : l === 'beobachtet' ? 'S1' : l === 'anteile_aktiv' ? 'S3' : null;
  const inKraft = l === 'anteile_aktiv' || l === 'angehalten' || l === 'angehalten_betreiber';
  const wirksam = { ...AUSLEGUNG, ...(opts.wirksam ?? {}) };
  const gehoert = (s: number | undefined, vorgabe: number) =>
    opts.jetzt ? new Date(opts.jetzt.getTime() - (s ?? vorgabe) * 1000).toISOString() : null;
  return {
    eingerichtet: true,
    zustand,
    stufe,
    mitglieder: [
      { box_id: GS_IDS.e1, rolle: 'fuehrt', messpunkt_id: GS_IDS.dq2, vorgabe_signal: 'ja', verbraucher14a: 'ja', anteil_verlust: null,
        wirksame_anteile: inKraft ? wirksam.e1 : null, zuletzt_gehoert: gehoert(opts.halle1Seit, 40) },
      { box_id: GS_IDS.e4, rolle: 'steuert_mit', messpunkt_id: GS_IDS.dq10, vorgabe_signal: 'nein', verbraucher14a: 'ja',
        anteil_verlust: verlust ? { heute: verlust, monat: verlust } : null,
        wirksame_anteile: inKraft ? wirksam.e4 : null, zuletzt_gehoert: gehoert(opts.verwaltungSeit, 35) },
    ],
    naechster_schritt: l === 'angehalten_betreiber' ? 'vom_betreiber_angehalten' : l === 'beobachtet' ? 'anteile_aktiv' : null,
    fehlt: l === 'anteile_aktiv' || l === 'angehalten' || l === 'angehalten_betreiber' ? [] : [
      { wort: 'faehigkeit_fehlt', box_id: GS_IDS.e4 },
      { wort: 'nachweis_fehlt', box_id: GS_IDS.e1 },
      { wort: 'nachweis_fehlt', box_id: GS_IDS.e4 },
      { wort: 'vorgabe_signal_nicht_an_jeder_box', box_id: GS_IDS.e4 },
    ],
  };
}
