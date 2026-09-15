import type {
  MessstelleRegisterAbdeckung,
  MessstelleRegisterZeile,
  MessstellenRegister,
  MessstellenRegisterAnfrage,
  MessstelleStellung,
  MessstelleVertragsform,
} from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/messstellen` (Register, AP-04 IP-4/IP-15) für die
 * Fläche „Messstellen“ (IP-5) — NUR aus dem Referenzunternehmen
 * `docs/contracts/v2/uems-referenzunternehmen.json` (Fassung 1.4 — die Messstellen MS-01 … MS-22 seit 1.3 unverändert):
 * Namen, Orte, Stellungen, Komponenten, Geräte, Einbauten und Beginn jeder
 * Zuordnung wie dort; heute = Momentaufnahme 20.10.2026 10:15.
 *
 * ⚠ Was die Datei nicht trägt, bleibt leer — nie eine erfundene Zahl: der
 * Zählerstand der Hauptgröße steht nicht darin, `letzter_wert` ist darum `null`;
 * die `momentanleistung_kw` der Momentaufnahme reist als Nebengröße
 * „Wirkleistung“ (MS-04 dazu „Ladestand“ 62 %). Die Ort-Zuordnungen beginnen mit
 * dem Unternehmens-Energiemanagement (01.10.2026, Lindach 15.10.2026), Stellung und
 * Quelle der Bestandsanlage AN-1 schon am 12.03.2024 (rückwirkende Übernahme).
 *
 * Der Filter emuliert die Route nur so weit, wie die Tests ihn brauchen (Standort,
 * Ort mit Teilbaum über den Pfad, Anlage, Zustand, ohne Quelle). Nur für Tests
 * und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const REGISTER_HEUTE = '2026-10-20';
export const REGISTER_ZEITPUNKT = '2026-10-20T08:15:00Z';

type OrtArt = 'standort' | 'gebaeude' | 'bereich';

const ORTE: Record<string, { id: string; art: OrtArt; name: string; pfad: string[] }> = {
  'ST-1': { id: FIXTURE_IDS.st1, art: 'standort', name: 'Werk Ahrenberg', pfad: ['ST-1'] },
  'ST-2': { id: FIXTURE_IDS.st2, art: 'standort', name: 'Werk Lindach', pfad: ['ST-2'] },
  'G-1': { id: '0e000000-0000-4000-8000-000000000101', art: 'gebaeude', name: 'Halle 1', pfad: ['G-1', 'ST-1'] },
  'G-2': { id: '0e000000-0000-4000-8000-000000000102', art: 'gebaeude', name: 'Halle 2', pfad: ['G-2', 'ST-1'] },
  'G-3': { id: '0e000000-0000-4000-8000-000000000103', art: 'gebaeude', name: 'Verwaltung', pfad: ['G-3', 'ST-1'] },
  'G-4': { id: '0e000000-0000-4000-8000-000000000104', art: 'gebaeude', name: 'Lagerhalle Lindach', pfad: ['G-4', 'ST-2'] },
  'G-5': { id: '0e000000-0000-4000-8000-000000000105', art: 'gebaeude', name: 'Montagehalle Lindach', pfad: ['G-5', 'ST-2'] },
  'B-1': { id: '0e000000-0000-4000-8000-000000000201', art: 'bereich', name: 'Halle 1 Nord', pfad: ['B-1', 'G-1', 'ST-1'] },
  'B-2': { id: '0e000000-0000-4000-8000-000000000202', art: 'bereich', name: 'Halle 1 Süd', pfad: ['B-2', 'G-1', 'ST-1'] },
  'B-3': { id: '0e000000-0000-4000-8000-000000000203', art: 'bereich', name: 'Halle 2 Montage', pfad: ['B-3', 'G-2', 'ST-1'] },
  'B-4': { id: '0e000000-0000-4000-8000-000000000204', art: 'bereich', name: 'Halle 2 Spritzguss', pfad: ['B-4', 'G-2', 'ST-1'] },
  'B-5': { id: '0e000000-0000-4000-8000-000000000205', art: 'bereich', name: 'Halle 2 Lager', pfad: ['B-5', 'G-2', 'ST-1'] },
};

export const REGISTER_ORT_IDS = Object.fromEntries(Object.entries(ORTE).map(([kz, o]) => [kz, o.id]));

const ANLAGEN: Record<string, { id: string; name: string }> = {
  'AN-1': { id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' },
  'AN-2': { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' },
  'AN-3': { id: FIXTURE_IDS.an3, name: 'Werk Lindach' },
};

/** Mitternacht am Standort (Europe/Berlin) der drei Anfangstage der Datei. */
const BEGINN: Record<string, string> = {
  '2024-03-12': '2024-03-12T00:00:00+01:00',
  '2026-10-01': '2026-10-01T00:00:00+02:00',
  '2026-10-15': '2026-10-15T00:00:00+02:00',
};

interface Quelle {
  komponente: string;
  name: string;
  kanal: string;
  geraet: string;
  einbau: string;
}

interface Def {
  kz: string;
  name: string;
  berechnet?: true;
  groesse?: [string, string, string, string];
  medium?: string;
  /** Kurzzeichen des Orts, `U` = Unternehmen, `null` = keiner. */
  ort: string | null;
  stellung?: [string, MessstelleStellung, string | null];
  /** Der erste Tag von Stellung und Quelle. */
  ab: string | null;
  quelle?: Quelle;
  kw?: number;
  ladestand?: number;
  lebenszyklus?: MessstelleRegisterZeile['lebenszyklus'];
}

const bezug: [string, string, string, string] = ['Wirkenergie', 'Bezug', 'kWh', 'Zählerstand'];

const DEFS: Def[] = [
  { kz: 'MS-01', name: 'Netzbezug Halle 1', ort: 'ST-1', stellung: ['AN-1', 'Hauptzähler', null], ab: '2024-03-12', quelle: { komponente: 'K-3', name: 'Netzzähler Halle 1', kanal: 'Wirkenergie Bezug', geraet: 'GR-2', einbau: 'GR-2' }, kw: 312.4 },
  { kz: 'MS-02', name: 'Netzeinspeisung Halle 1', groesse: ['Wirkenergie', 'Abgabe', 'kWh', 'Zählerstand'], ort: 'ST-1', stellung: ['AN-1', 'Hauptzähler', null], ab: '2024-03-12', quelle: { komponente: 'K-3', name: 'Netzzähler Halle 1', kanal: 'Wirkenergie Abgabe', geraet: 'GR-2', einbau: 'GR-2' }, kw: 0 },
  { kz: 'MS-03', name: 'PV-Erzeugung Dach Halle 1', groesse: ['Wirkenergie', 'Erzeugung', 'kWh', 'Zählerstand'], ort: 'G-1', stellung: ['AN-1', 'Erzeuger', null], ab: '2024-03-12', quelle: { komponente: 'K-1', name: 'Hybrid-Wechselrichter 100 kW', kanal: 'PV-Leistung', geraet: 'GR-1', einbau: 'GR-1' }, kw: 168.2 },
  { kz: 'MS-04', name: 'Speicher Halle 1', groesse: ['Wirkenergie', 'Laden / Entladen', 'kWh', 'Zählerstand'], ort: 'B-2', stellung: ['AN-1', 'Speicher', null], ab: '2024-03-12', quelle: { komponente: 'K-1', name: 'Hybrid-Wechselrichter 100 kW', kanal: 'Speicherleistung', geraet: 'GR-1', einbau: 'GR-1' }, kw: -40, ladestand: 62 },
  { kz: 'MS-05', name: 'Verwaltung gesamt', ort: 'G-3', stellung: ['AN-1', 'Unterzähler', 'MS-01'], ab: '2024-03-12', quelle: { komponente: 'K-4', name: 'Unterzähler Verwaltung', kanal: 'Wirkenergie Bezug', geraet: 'GR-3', einbau: 'GR-3' }, kw: 21.3 },
  { kz: 'MS-06', name: 'Spritzguss SG01–SG06', ort: 'B-1', stellung: ['AN-1', 'Unterzähler', 'MS-01'], ab: '2024-03-12', quelle: { komponente: 'K-5', name: 'Unterzähler Spritzguss SG01–SG06', kanal: 'Wirkenergie Bezug', geraet: 'GR-4', einbau: 'Z-5a' }, kw: 148.6 },
  { kz: 'MS-07', name: 'Druckluft Kompressoren K1+K2', ort: 'B-2', stellung: ['AN-1', 'Unterzähler', 'MS-01'], ab: '2024-03-12', quelle: { komponente: 'K-6', name: 'Unterzähler Druckluft', kanal: 'Wirkenergie Bezug', geraet: 'GR-5', einbau: 'GR-5' }, kw: 46 },
  { kz: 'MS-08', name: 'Kühlung Kaltwassersatz', ort: 'B-2', stellung: ['AN-1', 'Unterzähler', 'MS-01'], ab: '2024-03-12', quelle: { komponente: 'K-7', name: 'Unterzähler Kühlung', kanal: 'Wirkenergie Bezug', geraet: 'GR-6', einbau: 'GR-6' }, kw: 18.9 },
  { kz: 'MS-09', name: 'Halle 1 + Verwaltung nicht zugeordnet', berechnet: true, ort: 'G-1', stellung: ['AN-1', 'keine', null], ab: '2026-10-01' },
  { kz: 'MS-10', name: 'Netzbezug Halle 2', ort: 'G-2', stellung: ['AN-2', 'Hauptzähler', null], ab: '2026-10-01', quelle: { komponente: 'K-8.1', name: 'Zähler Energiekarte EK-1 (Hauptmessung Halle 2)', kanal: 'Wirkenergie Bezug', geraet: 'GR-7', einbau: 'C-1' }, kw: 96.5 },
  { kz: 'MS-11', name: 'Spritzguss SG07–SG10', ort: 'B-4', stellung: ['AN-2', 'Unterzähler', 'MS-10'], ab: '2026-10-01', quelle: { komponente: 'K-8.2', name: 'Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)', kanal: 'Wirkenergie Bezug', geraet: 'GR-7', einbau: 'C-1' }, kw: 61.2 },
  { kz: 'MS-12', name: 'Montage Linie M1', ort: 'B-3', stellung: ['AN-2', 'Unterzähler', 'MS-10'], ab: '2026-10-01', quelle: { komponente: 'K-8.3', name: 'Zähler Energiekarte EK-3 (Montage M1)', kanal: 'Wirkenergie Bezug', geraet: 'GR-7', einbau: 'C-1' }, kw: 14.8 },
  { kz: 'MS-13', name: 'Lager Halle 2 (Allgemein)', ort: 'B-5', stellung: ['AN-2', 'Unterzähler', 'MS-10'], ab: '2026-10-01', quelle: { komponente: 'K-8.4', name: 'Zähler Energiekarte EK-4 (Lager Halle 2)', kanal: 'Wirkenergie Bezug', geraet: 'GR-7', einbau: 'C-1' }, kw: 7.9 },
  { kz: 'MS-14', name: 'Ladepunkt Parkplatz Halle 2', ort: 'ST-1', stellung: ['AN-2', 'Unterzähler', 'MS-10'], ab: '2026-10-01', quelle: { komponente: 'K-9', name: 'Ladepunkt Parkplatz Halle 2 (22 kW)', kanal: 'OCPP-Zählerstand', geraet: 'GR-8', einbau: 'AHR-LP-01' }, kw: 11 },
  { kz: 'MS-15', name: 'Halle 2 nicht zugeordnet', berechnet: true, ort: 'G-2', stellung: ['AN-2', 'keine', null], ab: '2026-10-01' },
  { kz: 'MS-16', name: 'Netzbezug Lindach', ort: 'ST-2', stellung: ['AN-3', 'Hauptzähler', null], ab: '2026-10-15', quelle: { komponente: 'K-11', name: 'Netzzähler Lindach', kanal: 'Wirkenergie Bezug', geraet: 'GR-10', einbau: 'GR-10' }, kw: 38.7 },
  { kz: 'MS-17', name: 'Lagerhalle Lindach gesamt', ort: 'G-4', stellung: ['AN-3', 'Unterzähler', 'MS-16'], ab: '2026-10-15', quelle: { komponente: 'K-10.1', name: 'Zähler Energiekarte EK-5 (Logistik Lindach)', kanal: 'Wirkenergie Bezug', geraet: 'GR-9', einbau: 'C-2' }, kw: 17.2 },
  { kz: 'MS-18', name: 'Montagehalle Lindach gesamt', ort: 'G-5', stellung: ['AN-3', 'Unterzähler', 'MS-16'], ab: '2026-10-15', quelle: { komponente: 'K-10.2', name: 'Zähler Energiekarte EK-6 (Montage Lindach)', kanal: 'Wirkenergie Bezug', geraet: 'GR-9', einbau: 'C-2' }, kw: 15.1 },
  { kz: 'MS-19', name: 'Netzbezug gesamt Unternehmen', berechnet: true, ort: 'U', ab: null },
  { kz: 'MS-20', name: 'Prozess Spritzguss gesamt', berechnet: true, ort: null, ab: null },
  { kz: 'MS-21', name: 'Gas Heizung Verwaltung', medium: 'Gas', groesse: ['Volumen', 'Bezug', 'm³', 'Zählerstand'], ort: 'G-3', ab: null, lebenszyklus: 'eingerichtet' },
  { kz: 'MS-22', name: 'Lindach nicht zugeordnet', berechnet: true, ort: null, stellung: ['AN-3', 'keine', null], ab: '2026-10-15' },
];

const idVon = (kz: string) => `3e000000-0000-4000-8000-0000000000${kz.slice(3)}`;

/** Der Ort beginnt mit dem Unternehmens-Energiemanagement (bzw. mit Lindach). */
function ortAb(d: Def): string | null {
  if (d.ort === null) return null;
  const standort = d.ort === 'U' ? 'ST-1' : ORTE[d.ort].pfad.at(-1);
  return standort === 'ST-2' ? '2026-10-15' : '2026-10-01';
}

/** MS-06: Z-5a bis 18.11.2026 10:40, danach Z-5b (§5.13) — die Quelle gilt zum BEGINN des Stichtags. */
const WECHSEL_MS06 = '2026-11-18T10:40:00+01:00';

function bindung(d: Def, einbau: string, ab: string, bis: string | null) {
  const q = d.quelle!;
  return {
    id: `b0000000-0000-4000-8000-${d.kz.slice(3).padStart(8, '0')}${einbau === 'Z-5b' ? '0002' : '0001'}`,
    komponente: `c0000000-0000-4000-8000-0000000${q.komponente.replace(/\D/g, '').padStart(5, '0')}`,
    komponente_name: q.name,
    kanal: q.kanal,
    kanal_name: q.kanal,
    geraet: { id: `9e000000-0000-4000-8000-0000000000${q.geraet.slice(3).padStart(2, '0')}`, geraet: q.geraet, einbau, bezeichnung: null },
    gueltig_ab: ab,
    gueltig_bis: bis,
  };
}

function zeile(d: Def, tag: string): MessstelleRegisterZeile {
  const [groesse, richtung, einheit, wertart] = d.groesse ?? bezug;
  const oAb = ortAb(d);
  const o = d.ort && d.ort !== 'U' ? ORTE[d.ort] : null;
  const verortet = oAb !== null && tag >= oAb;
  const standortKz = o ? o.pfad.at(-1)! : null;
  const ort: MessstelleRegisterZeile['ort'] = !verortet
    ? { id: null, kennzeichen: null, ort_art: null, name: null, gueltig_ab: null, gueltig_bis: null, pfad: [], standort: null, standort_id: null, standort_name: null, grund: 'nicht_verortet' }
    : d.ort === 'U'
      ? { id: FIXTURE_IDS.u, kennzeichen: 'U', ort_art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH', gueltig_ab: oAb, gueltig_bis: null, pfad: [], standort: null, standort_id: null, standort_name: null, grund: 'am_unternehmen' }
      : { id: o!.id, kennzeichen: d.ort, ort_art: o!.art, name: o!.name, gueltig_ab: oAb, gueltig_bis: null, pfad: o!.pfad, standort: standortKz, standort_id: ORTE[standortKz!].id, standort_name: ORTE[standortKz!].name, grund: 'verortet' };
  const aktiv = d.ab !== null && tag >= d.ab;
  const stellung = d.stellung && aktiv
    ? { anlage: ANLAGEN[d.stellung[0]].id, anlage_name: ANLAGEN[d.stellung[0]].name, stellung: d.stellung[1], unterzaehler_von: d.stellung[2], gueltig_ab: d.ab!, gueltig_bis: null }
    : null;
  let quelle: MessstelleRegisterZeile['quelle'];
  if (d.berechnet) quelle = { stand: 'berechnet', fuehrend: null, davor: null, vergleichsquellen: 0 };
  else if (d.quelle && aktiv) {
    const nachWechsel = d.kz === 'MS-06' && tag > WECHSEL_MS06.slice(0, 10);
    quelle = nachWechsel
      ? { stand: 'gebunden', fuehrend: bindung(d, 'Z-5b', WECHSEL_MS06, null), davor: bindung(d, 'Z-5a', BEGINN[d.ab!], WECHSEL_MS06), vergleichsquellen: 0 }
      : { stand: 'gebunden', fuehrend: bindung(d, d.quelle.einbau, BEGINN[d.ab!], d.kz === 'MS-06' ? WECHSEL_MS06 : null), davor: null, vergleichsquellen: 0 };
  } else quelle = { stand: 'keine_datenquelle', fuehrend: null, davor: null, vergleichsquellen: 0 };
  const einbau = quelle.fuehrend?.geraet.einbau ?? null;
  const beobachtung: MessstelleRegisterZeile['beobachtung'] = d.berechnet
    ? null
    : quelle.stand === 'gebunden'
      ? { zustand: 'liefert', text: 'Liefert Daten', seit: null, toleranz_s: 300, kadenz_s: 60, geraet: einbau }
      : { zustand: 'keine_datenquelle', text: 'Keine Datenquelle', seit: null, toleranz_s: null, kadenz_s: null, geraet: null };
  const heute = tag === REGISTER_HEUTE && quelle.stand === 'gebunden';
  const neben = (g: string, r: string, e: string, w: string, wert: number) => ({
    id: `4e000000-0000-4000-8000-${d.kz.slice(3).padStart(8, '0')}${e === '%' ? '0002' : '0001'}`,
    groesse: { groesse: g, richtung: r, einheit: e, wertart: w },
    beobachtung,
    letzter_wert: { wert, text: null, einheit: e, zeitpunkt: REGISTER_ZEITPUNKT },
  });
  return {
    id: idVon(d.kz),
    kennzeichen: d.kz,
    name: d.name,
    art: d.berechnet ? 'berechnet' : 'gemessen',
    medium: d.medium ?? 'Strom',
    hauptgroesse: { groesse, richtung, einheit, wertart },
    ort,
    elektrische_stellung: stellung,
    quelle,
    lebenszyklus: d.lebenszyklus ?? 'aktiv',
    fehlt: [],
    angehalten_ab: null,
    archiviert_am: null,
    beobachtung,
    letzter_wert: null,
    nebengroessen: [
      ...(heute && d.kw !== undefined ? [neben('Wirkleistung', richtung, 'kW', 'Momentanwert', d.kw)] : []),
      ...(heute && d.ladestand !== undefined ? [neben('Ladestand', 'richtungslos', '%', 'Momentanwert', d.ladestand)] : []),
    ],
    berechnung: d.berechnet && (d.ab === null || tag >= d.ab)
      ? { zustand: 'vollstaendig', fehlend: [], seit: null, text: 'Vollständig' }
      : null,
  };
}

function vertrag(d: Def): MessstelleVertragsform {
  const oAb = ortAb(d);
  const quellen = d.quelle && d.ab
    ? d.kz === 'MS-06'
      ? [{ gueltig_ab: BEGINN[d.ab], gueltig_bis: WECHSEL_MS06 }, { gueltig_ab: WECHSEL_MS06, gueltig_bis: null }]
      : [{ gueltig_ab: BEGINN[d.ab], gueltig_bis: null }]
    : [];
  return {
    id: idVon(d.kz),
    kennzeichen: d.kz,
    orte: oAb ? [{ gueltig_ab: oAb, gueltig_bis: null }] : [],
    elektrische_stellung: d.stellung && d.ab ? [{ gueltig_ab: d.ab, gueltig_bis: null }] : [],
    fuehrende_quelle: quellen,
    vergleichsquellen: [],
    nebengroessen: [],
  };
}

function abdeckung(zeilen: MessstelleRegisterZeile[]): MessstelleRegisterAbdeckung {
  const gezaehlt = zeilen.filter((z) => z.beobachtung || z.berechnung);
  const erfuellt = gezaehlt.filter((z) => z.beobachtung?.zustand === 'liefert' || z.berechnung?.zustand === 'vollstaendig').length;
  const gesamt = gezaehlt.length;
  return { erfuellt, gesamt, text: `${erfuellt} von ${gesamt} ${gesamt === 1 ? 'Messstelle liefert' : 'Messstellen liefern'} Daten` };
}

function passt(z: MessstelleRegisterZeile, a: MessstellenRegisterAnfrage): boolean {
  if (a.standort && z.ort.standort_id !== a.standort) return false;
  if (a.ort) {
    const kz = Object.entries(ORTE).find(([, o]) => o.id === a.ort)?.[0];
    if (!kz || !z.ort.pfad.includes(kz)) return false;
  }
  if (a.anlage && z.elektrische_stellung?.anlage !== a.anlage) return false;
  if (a.zustand && z.lebenszyklus !== a.zustand) return false;
  if (a.ohneQuelle && !(z.art === 'gemessen' && z.quelle.stand === 'keine_datenquelle')) return false;
  return true;
}

/** Das Register des Referenzunternehmens — heute (20.10.2026) oder zu einem Stichtag, mit den Filtern der Route. */
export function ahrenbergRegister(anfrage: MessstellenRegisterAnfrage = {}): MessstellenRegister {
  const tag = anfrage.stichtag ?? REGISTER_HEUTE;
  const defs = DEFS.filter((d) => passt(zeile(d, tag), anfrage));
  const register = defs.map((d) => zeile(d, tag));
  const standorte = new Map<string, MessstelleRegisterZeile[]>();
  for (const z of register) if (z.ort.standort) standorte.set(z.ort.standort, [...(standorte.get(z.ort.standort) ?? []), z]);
  const sommer = tag >= '2026-03-29' && tag < '2026-10-25';
  return {
    messstellen: defs.map(vertrag),
    register,
    stichtag: tag,
    zeitpunkt: anfrage.stichtag ? `${tag}T00:00:00${sommer ? '+02:00' : '+01:00'}` : REGISTER_ZEITPUNKT,
    teilansicht: false,
    aggregat: {
      unternehmen: abdeckung(register),
      standorte: [...standorte.entries()].map(([kz, zeilen]) => ({ id: ORTE[kz].id, kurzzeichen: kz, name: ORTE[kz].name, ...abdeckung(zeilen) })),
    },
  };
}

/** Ein Kundenbereich ohne Messstelle (Standort eingerichtet, noch nichts angelegt). */
export function leeresRegister(tag = REGISTER_HEUTE): MessstellenRegister {
  return {
    messstellen: [],
    register: [],
    stichtag: tag,
    zeitpunkt: REGISTER_ZEITPUNKT,
    teilansicht: false,
    aggregat: { unternehmen: { erfuellt: 0, gesamt: 0, text: '0 von 0 Messstellen liefern Daten' }, standorte: [] },
  };
}
