/**
 * Fiktive Anlage „Werkhof Linde" für die Zeitbasis von Anlagenkopf und Gerätezeilen (Vitest `aufbauKopf.test.ts`,
 * Bühne `e2e/anlage-zeitbasis.tsx`). Aufbau wie ein echter Fall vom 07.11.2026: ein Netzzähler, drei PV-Erzeuger und
 * eine Unterverteilung, die die Box je als eigene Quelle liest, keine Netz-Zuordnung, eine Box. Die Hallenlast springt
 * in Sekunden um mehrere kW - darum las der Kopf (jüngster Rohwert der Übersicht) „Netz Bezug 5,4 kW", während die
 * Zeile des Netzzählers (30-s-Mittel der Topologie) „0,6 kW Einspeisung" zeigte, und PV 8,1 kW im Kopf gegen 7,9 kW
 * in der Summe der Zeilen. Namen und Kennungen sind erfunden.
 */
import type { Device, EntityLocalSetup, OverviewSite, SiteEntity, SiteSource, SiteTopology } from '../api';

export const ZB_SITE_ID = 'zb-werkhof';
export const ZB_SITE_NAME = 'Werkhof Linde';
export const ZB_BOX_ID = 'zb-box';
export const ZB_BOX_REF = 'edge-zb7linde';

/** Ein Stand der Anlage: was die Topologie (Zeilen) und was die Übersicht (alter Kopf) zur selben Zeit meldeten. */
export interface ZeitbasisStand {
  /** Netzzähler in der Topologie (30-s-Mittel), + = Bezug. */
  netzKw: number;
  /** Die drei PV-Erzeuger in der Topologie. */
  pvKw: [number, number, number];
  /** Unterverteilung „UV Halle" in der Topologie. */
  uvKw: number;
  /** Die Übersicht (jüngster Rohwert): PV und Netz. */
  uebersicht: { pvKw: number; gridKw: number };
  /** Wann die Box die Quellen las (`/sources.readAt`), ms. */
  gelesenAm: number;
  /** Zeitstempel des jüngsten Messpunkts der Übersicht, ms. */
  uebersichtAm: number;
}

/** Der Fall des Screenshots: Kopf alt „Netz Bezug 5,4 kW · PV 8,1 kW", Zeilen −0,6 und 2,6 + 2,6 + 2,7 = 7,9 kW. */
export const zbScreenshot = (jetzt: number): ZeitbasisStand => ({
  netzKw: -0.6,
  pvKw: [2.6, 2.6, 2.7],
  uvKw: 7.3,
  uebersicht: { pvKw: 8.1, gridKw: 5.4 },
  gelesenAm: jetzt - 17_000,
  uebersichtAm: jetzt - 6_000,
});

const ERZEUGER = [
  { id: 'zb-e-pv1', quelle: 'src-zbpv0001', label: 'PV Dach Ost' },
  { id: 'zb-e-pv2', quelle: 'src-zbpv0002', label: 'PV Dach Mitte' },
  { id: 'zb-e-pv3', quelle: 'src-zbpv0003', label: 'PV Dach West' },
] as const;
const NETZ = { id: 'zb-e-netz', quelle: 'src-zbnetz01', label: 'Netzanschluss' } as const;
const UV = { id: 'zb-e-uv', quelle: 'src-zbuvhal1', label: 'UV Halle' } as const;

const entitaet = (o: Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>): SiteEntity =>
  ({
    typeLabel: o.entityType,
    role: o.entityType,
    label: null,
    control: false,
    deviceId: ZB_BOX_ID,
    capabilities: { measure: [] },
    guards: null,
    syncStatus: 'in_sync',
    observed: null,
    edgeSourceId: null,
    sourceKind: 'adopted',
    ...o,
  }) as unknown as SiteEntity;

export const zbEntities: SiteEntity[] = [
  entitaet({
    id: NETZ.id, entityType: 'grid-meter', typeLabel: 'Netzanschlusszähler', label: NETZ.label, edgeSourceId: NETZ.quelle,
    capabilities: { measure: [{ channel: 'power_kw' }] },
  } as Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>),
  ...ERZEUGER.map((p) =>
    entitaet({
      id: p.id, entityType: 'producer', typeLabel: 'Erzeuger (PV)', label: p.label, edgeSourceId: p.quelle,
      capabilities: { measure: [{ channel: 'pv_power_kw' }] },
    } as Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>)),
  entitaet({
    id: UV.id, entityType: 'sub-meter', typeLabel: 'Unterzähler', label: UV.label, edgeSourceId: UV.quelle,
    capabilities: { measure: [{ channel: 'power_kw' }] },
  } as Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>),
  entitaet({ id: 'zb-e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', sourceKind: 'composed' } as Partial<SiteEntity> &
    Pick<SiteEntity, 'id' | 'entityType'>),
];

const setup = (id: string, role: string, entity: string, label: string, brand: string, model: string): EntityLocalSetup =>
  ({ id, kind: 'source', role, brand, model, label, reportedAt: null, adoptedEntityId: entity }) as EntityLocalSetup;

export const zbLocalSetup: EntityLocalSetup[] = [
  setup(NETZ.quelle, 'grid-meter', NETZ.id, NETZ.label, 'shelly', 'shelly-pro-3em'),
  ...ERZEUGER.map((p) => setup(p.quelle, 'pv-generation', p.id, p.label, 'kaco', 'kaco-sunspec')),
  setup(UV.quelle, 'consumer', UV.id, UV.label, 'shelly', 'shelly-pro-3em'),
];

const iso = (ms: number) => new Date(ms).toISOString();

/** `/sources`: dieselben Werte wie die Topologie, gelesen um `gelesenAm`. */
export function zbSources(s: ZeitbasisStand): SiteSource[] {
  const quelle = (sourceId: string, role: string, label: string, werte: Partial<SiteSource>): SiteSource =>
    ({
      deviceId: ZB_BOX_ID, sourceId, kind: 'source', role, label, brand: 'shelly', model: null,
      pvKw: null, powerKw: null, loadKw: null, health: 'ok', readAt: iso(s.gelesenAm), reportedAt: iso(s.gelesenAm), bms: null,
      ...werte,
    }) as SiteSource;
  return [
    quelle(NETZ.quelle, 'grid-meter', NETZ.label, { powerKw: s.netzKw }),
    ...ERZEUGER.map((p, i) => quelle(p.quelle, 'pv-generation', p.label, { pvKw: s.pvKw[i] })),
    quelle(UV.quelle, 'consumer', UV.label, { loadKw: s.uvKw }),
  ];
}

/** `/topology`: alle Entitäten liefern (`health: ok`), Leistungen als 30-s-Mittel. */
export function zbTopology(s: ZeitbasisStand): SiteTopology {
  const kanal = (channel: string, role: string, value: number) => ({ channel, unit: 'kW', role, primary: true, value });
  const e = (id: string, entityType: string, label: string | null, category: string, caps: unknown[]) =>
    ({ id, entityType, typeLabel: entityType, label, category, health: 'ok', connection: null, capabilities: caps });
  const haus = s.pvKw.reduce((a, b) => a + b, 0) + s.netzKw;
  return {
    schemaVersion: '1.0',
    entities: [
      e(NETZ.id, 'grid-meter', NETZ.label, 'meter', [kanal('power_kw', 'grid', s.netzKw)]),
      e('zb-e-haus', 'house-load', null, 'consumer', [kanal('power_kw', 'consumer', haus)]),
      ...ERZEUGER.map((p, i) => e(p.id, 'producer', p.label, 'producer', [kanal('pv_power_kw', 'pv', s.pvKw[i])])),
      e(UV.id, 'sub-meter', UV.label, 'consumer', [kanal('power_kw', 'consumer', s.uvKw)]),
    ],
    topology: { schema_version: '1.0', nodes: [] },
  } as unknown as SiteTopology;
}

/** `/overview` der Anlage: der jüngste Rohwert, wie ihn der alte Kopf las. */
export function zbOverviewSite(s: ZeitbasisStand): OverviewSite {
  return {
    id: ZB_SITE_ID,
    name: ZB_SITE_NAME,
    onlineCount: 1,
    live: {
      ts: iso(s.uebersichtAm),
      pvKw: s.uebersicht.pvKw,
      gridKw: s.uebersicht.gridKw,
      loadKw: s.uebersicht.pvKw + s.uebersicht.gridKw,
      socPct: null,
    },
  } as OverviewSite;
}

export const zbBox = (jetzt: number): Device =>
  ({
    id: ZB_BOX_ID,
    siteId: ZB_SITE_ID,
    externalRef: ZB_BOX_REF,
    kind: 'inverter',
    name: null,
    status: 'active',
    lastSeenAt: iso(jetzt - 5_000),
    createdAt: null,
  }) as Device;
