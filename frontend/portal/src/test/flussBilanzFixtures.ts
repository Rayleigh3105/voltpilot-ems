/**
 * Fiktive Anlage „Hof Erlenbach“ für die Bilanz des Cockpit-Flusses (Vitest `flussBilanz.test.ts`,
 * `CockpitHero.test.tsx`, Bühne `e2e/cockpit-fluss-bilanz.tsx`). Aufbau und Zahlen wie der echte Fall vom
 * 07.11.2026, 14:20: reines Monitoring ohne Hauptgerät, drei KACO und ein KOSTAL PIKO als Erzeuger mit
 * eigenen Werten, ein Netzzähler, zwei Unterverteilungen, eine Box. Eine PV-Zuordnung nennt nur den PIKO
 * (in der Technik-Ansicht „maßgeblich“ gesetzt). Bis dahin zeigte das Cockpit „Erzeugung 1,2 kW · Bezug
 * 5,9 kW · Verbrauch 9,6 kW“ und „Sonne deckt 12 % des Verbrauchs“ - die drei KACO (2,5 kW) steckten im
 * Haus, aber nicht in der Sonne. Namen und Kennungen sind erfunden.
 */
import type { RollenKanonischerWert, SiteEntity, SiteSource, SiteTopology, TopologyEntity } from '../api';
import type { LiveSnapshot } from '../live';
import { derive } from '../topology';

export const EB_SITE_ID = 'eb-hof-erlenbach';
export const EB_SITE_NAME = 'Hof Erlenbach';
export const EB_BOX_ID = 'eb-box';
export const EB_STAND = '2026-11-07T13:20:03Z';

/** kW wie im Screenshot: 1,18 + 2,50 + 5,94 = 9,62 (die Box bildet das Haus genau so). */
export const EB_KW = {
  piko: 1.18,
  kacoOst: 0.92,
  kacoMitte: 0.88,
  kacoWest: 0.7,
  netz: 5.94,
  haus: 9.62,
  uvHalle: 7.87,
  uvKeller: 0.07,
} as const;

interface Geraet {
  id: string;
  quelle: string;
  typ: string;
  typLabel: string;
  label: string | null;
  kategorie: string;
  kanal: string;
  rolle: string;
  kw: number;
}

const ERZEUGER: Geraet[] = [
  { id: 'eb-kaco-ost', quelle: 'src-ebkaco01', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco Ost', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: EB_KW.kacoOst },
  { id: 'eb-kaco-mitte', quelle: 'src-ebkaco02', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco Mitte', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: EB_KW.kacoMitte },
  { id: 'eb-kaco-west', quelle: 'src-ebkaco03', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco West', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: EB_KW.kacoWest },
  { id: 'eb-piko', quelle: 'src-ebpiko01', typ: 'producer', typLabel: 'Erzeuger', label: 'Kostal PIKO Scheune', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: EB_KW.piko },
];
const NETZ: Geraet = { id: 'eb-netz', quelle: 'src-ebnetz01', typ: 'grid-meter', typLabel: 'Netzzähler', label: 'Netzanschluss', kategorie: 'meter', kanal: 'power_kw', rolle: 'grid', kw: EB_KW.netz };
const HAUS: Geraet = { id: 'eb-haus', quelle: '', typ: 'house-load', typLabel: 'Hausverbrauch', label: null, kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: EB_KW.haus };
const UV: Geraet[] = [
  { id: 'eb-uv-halle', quelle: 'src-ebuvha01', typ: 'sub-meter', typLabel: 'Unterzähler', label: 'UV Halle', kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: EB_KW.uvHalle },
  { id: 'eb-uv-keller', quelle: 'src-ebuvke01', typ: 'sub-meter', typLabel: 'Unterzähler', label: 'UV Keller', kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: EB_KW.uvKeller },
];

export interface EbFall {
  /** Welche Erzeuger die Box gerade NICHT liest (Quelle und Komponente veraltet). */
  veraltet?: readonly string[];
  /** Der Netzzähler meldet sich nicht (die Anlage lebt sonst). */
  netzVeraltet?: boolean;
  /** Die ganze Anlage schweigt. */
  stumm?: boolean;
  /** Die PV-Zuordnung: nur der PIKO (der Fall), alle vier mit einem Summenwert, oder keine. */
  zuordnung?: 'piko' | 'alle' | 'keine';
  /** Die PV-Zuordnung liefert gerade nicht (stumm). */
  zuordnungStumm?: boolean;
  /** Eine Verbrauchs-Zuordnung auf die UV Halle - ein Teilverbrauch. */
  teilverbrauch?: boolean;
}

export interface EbStand {
  topology: SiteTopology;
  sources: SiteSource[];
  pins: SiteEntity[];
  snapshot: LiveSnapshot;
  pvRollen: RollenKanonischerWert | null;
  verbrauchRollen: RollenKanonischerWert | null;
}

/** Ein Stand der Anlage. Die Box rechnet einen Erzeuger, den sie nicht liest, nicht ins Haus. */
export function ebStand(fall: EbFall = {}): EbStand {
  const veraltet = new Set(fall.veraltet ?? []);
  const health = (g: Geraet) =>
    fall.stumm || veraltet.has(g.id) || (g === NETZ && fall.netzVeraltet) ? 'stale' : 'ok';
  const fehlt = ERZEUGER.filter((g) => veraltet.has(g.id)).reduce((s, g) => s + g.kw, 0);
  const hausKw = Math.round((EB_KW.haus - fehlt) * 1000) / 1000;
  const alle = [NETZ, HAUS, ...ERZEUGER.slice(0, 3).reverse(), ...UV, ERZEUGER[3]];
  const entities: TopologyEntity[] = alle.map((g) => ({
    id: g.id,
    entityType: g.typ,
    typeLabel: g.typLabel,
    label: g.label,
    category: g.kategorie,
    health: health(g),
    capabilities: [{
      channel: g.kanal,
      unit: 'kW',
      role: g.rolle,
      // „maßgeblich setzen“ am PIKO (Technik-Ansicht) - für PV ohne Wirkung auf die Topologie-Summe.
      primary: g === NETZ || g === HAUS || g.id === 'eb-piko',
      value: g === HAUS ? hausKw : g.kw,
    }],
  }));
  const topology: SiteTopology = {
    schemaVersion: '1.0',
    entities,
    topology: derive({
      entities: entities.map((e) => ({
        id: e.id,
        type: e.entityType,
        label: e.label ?? '',
        category: e.category,
        health: e.health,
        capabilities: e.capabilities.map((c) => ({ channel: c.channel, role: c.role ?? '', primary: c.primary, value: c.value })),
      })),
    }),
  };
  const quelle = (g: Geraet): SiteSource => ({
    deviceId: EB_BOX_ID,
    sourceId: g.quelle,
    kind: 'source',
    role: g.rolle === 'pv' ? 'pv-generation' : g.rolle === 'grid' ? 'grid-meter' : 'consumer',
    label: g.label,
    brand: g.id === 'eb-piko' ? 'kostal' : g.rolle === 'pv' ? 'kaco' : 'shelly',
    model: null,
    pvKw: g.rolle === 'pv' ? g.kw : null,
    powerKw: g.rolle === 'grid' ? g.kw : null,
    loadKw: g.rolle === 'consumer' ? g.kw : null,
    health: health(g) === 'ok' ? 'ok' : 'stale',
    readAt: EB_STAND,
    reportedAt: EB_STAND,
  });
  const gepinnt = [...ERZEUGER, NETZ, ...UV];
  const pins = gepinnt.map((g) => ({ id: g.id, edgeSourceId: g.quelle, orphanedPin: false })) as unknown as SiteEntity[];
  const piko = ERZEUGER[3];
  const zuordnung = fall.zuordnung ?? 'piko';
  const stumm = fall.zuordnungStumm === true;
  const pvRollen: RollenKanonischerWert | null =
    zuordnung === 'keine'
      ? null
      : zuordnung === 'piko'
        ? {
          role: 'pv', zuordnung_vorhanden: true, wert: stumm ? null : piko.kw, einheit: 'kW', unvollstaendig: stumm,
          stand: stumm ? null : '2026-11-07T14:20:03+01:00',
          geraete: [{ entity_id: piko.id, name: piko.label, art: 'messkanal', wert: stumm ? null : piko.kw, liefernd: !stumm, grund: stumm ? 'veraltet' : null }],
        }
        : {
          // Ein Summenwert über alle vier, jedem Gerät zugeordnet, zählt einmal (der Server rechnet ihn).
          role: 'pv', zuordnung_vorhanden: true, wert: 3.7, einheit: 'kW', unvollstaendig: false, stand: '2026-11-07T14:20:03+01:00',
          geraete: ERZEUGER.map((g) => ({ entity_id: g.id, name: g.label, art: 'gesamtwert', wert: 3.7, liefernd: true, grund: null })),
        };
  const verbrauchRollen: RollenKanonischerWert | null = fall.teilverbrauch
    ? {
      role: 'consumer', zuordnung_vorhanden: true, wert: EB_KW.uvHalle, einheit: 'kW', unvollstaendig: false, stand: '2026-11-07T14:20:03+01:00',
      geraete: [{ entity_id: 'eb-uv-halle', name: 'UV Halle', art: 'messkanal', wert: EB_KW.uvHalle, liefernd: true, grund: null }],
    }
    : null;
  return {
    topology,
    sources: gepinnt.map(quelle),
    pins,
    // Die Übersicht trägt seit der Zuordnung die PV des PIKO (Server-Rolle), Netz und Haus der Box.
    snapshot: { pvKw: piko.kw, loadKw: hausKw, gridKw: EB_KW.netz, battKw: null, socPct: null, socAt: null },
    pvRollen,
    verbrauchRollen,
  };
}
