import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type Device, type Site, type SiteEntities, type SiteEntity, type SiteTopology } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { entitiesApi } from '../src/entitiesApi';
import { AufbauSection } from '../src/pages/AufbauSection';
import { BoxSeiteSection } from '../src/pages/BoxSeiteSection';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Aufbau gruppiert“ (Konzept `vp-anlage-geraete-gruppiert`, GR-1 A · GR-2 A · GR-3 A): der echte Aufbau
 * und die echte Box-Seite über einer Anlage in den FORMEN des Mitschnitts einer Kundenanlage (07.11.2026 10:49Z:
 * drei Kaco, ein Shelly am Netzanschluss, zwei Shelly in Unterverteilungen) - Kennungen, Adressen und Namen der
 * Anlage sind ersetzt, die Werte stehen wie im Screenshot 12:23. Die Box meldet ihre Quellen in der Reihenfolge der
 * Quellkennung; genau diese Reihenfolge las sich wie Zufall.
 *
 * `?flaeche=aufbau|box`; die zwei Shelly sind Unterzähler (`sub-meter`, PR 1776, so steht die Anlage seit 07.11.2026),
 * `&uv=last` = wie im Mitschnitt noch als steuerbare Last; `&heizstab=1` = dazu ein Heizstab (mischt die Verbrauchsgruppe: keine Summe); `&hof=1` = eine zweite
 * Box „Hof“ nur mit zwei Ladepunkten (GR-2 A: dort kein Kopf); `&alt=1` = Kaco 2 meldet sich seit 20 min nicht
 * (keine Teilsumme). Die Bühne ruft nie eine Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const flaeche = frage.get('flaeche') ?? 'aufbau';
const unterzaehler = frage.get('uv') !== 'last';
const mitHeizstab = frage.get('heizstab') === '1';
const mitHof = frage.get('hof') === '1';
const kaco2Alt = frage.get('alt') === '1';
const jetzt = Date.now();
const vor = (s: number) => new Date(jetzt - s * 1000).toISOString();

const SITE_ID = '5b0c1e2a-0000-4000-8000-00000000a001';
const BOX_ID = '5b0c1e2a-0000-4000-8000-00000000b001';
const HOF_ID = '5b0c1e2a-0000-4000-8000-00000000b002';
const site: Site = {
  id: SITE_ID,
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};
const box: Device = {
  id: BOX_ID, siteId: SITE_ID, externalRef: 'edge-zuhause1', kind: 'edge', name: null, status: 'active',
  lastSeenAt: vor(29), createdAt: '2026-11-05T08:00:00Z',
};
const hof: Device = {
  id: HOF_ID, siteId: SITE_ID, externalRef: 'edge-hof01', kind: 'edge', name: 'Hof', status: 'active',
  lastSeenAt: vor(12), createdAt: '2026-11-06T08:00:00Z',
};
const boxen = mitHof ? [box, hof] : [box];

/** Eine Quelle der Box: Entität, gemeldete Quelle und Herzschlag - die Formen von `entities`, `localSetup`, `/sources`. */
interface Quelle {
  src: string;
  entity: string;
  label: string;
  rolle: 'pv-generation' | 'grid-meter' | 'consumer';
  typ: string;
  typLabel: string;
  model: string;
  brand: string;
  /** kW: PV positiv, Netz + = Bezug, Verbraucher positiv. */
  kw: number;
  alterS: number;
}
const uvTyp = unterzaehler ? { typ: 'sub-meter', typLabel: 'Unterzähler' } : { typ: 'generic-load', typLabel: 'Steuerbare Last' };
/** In der Reihenfolge der Quellkennung - so meldet die Box (`ORDER BY source, entity_id`). */
const QUELLEN: Quelle[] = [
  { src: 'src-5ahgajrq', entity: 'e-kaco3', label: 'Kaco 3', rolle: 'pv-generation', typ: 'producer', typLabel: 'Erzeuger (PV)', brand: 'kaco', model: 'powador-14.0-tl3', kw: 2.1, alterS: 26 },
  { src: 'src-hkxwbmu2', entity: 'e-netz', label: 'Netzanschluss', rolle: 'grid-meter', typ: 'grid-meter', typLabel: 'Netzanschlusszähler', brand: 'shelly', model: 'shelly-pro-3em', kw: -0.6, alterS: 17 },
  { src: 'src-sgw8hrpt', entity: 'e-kaco2', label: 'Kaco 2', rolle: 'pv-generation', typ: 'producer', typLabel: 'Erzeuger (PV)', brand: 'kaco', model: 'powador-20.0-tl3', kw: 2.9, alterS: kaco2Alt ? 1200 : 28 },
  { src: 'src-v76vttep', entity: 'e-uv-keller', label: 'UV Keller', rolle: 'consumer', ...uvTyp, brand: 'shelly', model: 'shelly-pro-3em', kw: 0.1, alterS: 17 },
  { src: 'src-wqng3qfp', entity: 'e-kaco1', label: 'Kaco 1', rolle: 'pv-generation', typ: 'producer', typLabel: 'Erzeuger (PV)', brand: 'kaco', model: 'powador-20.0-tl3', kw: 2.9, alterS: 16 },
  { src: 'src-zkscub8m', entity: 'e-uv-halle', label: 'UV Halle', rolle: 'consumer', ...uvTyp, brand: 'shelly', model: 'shelly-pro-3em', kw: 7.9, alterS: 25 },
  ...(mitHeizstab
    ? [{ src: 'src-x3hz0001', entity: 'e-heizstab', label: 'Heizstab', rolle: 'consumer' as const, typ: 'heating-rod', typLabel: 'Heizstab', brand: 'shelly', model: 'shelly-pro-3em', kw: 2.0, alterS: 14 }]
    : []),
];
const frisch = (q: Quelle) => q.alterS < 300;
const istPv = (q: Quelle) => q.rolle === 'pv-generation';
const kanal = (q: Quelle) => (istPv(q) ? 'pv_power_kw' : 'power_kw');

const entities = [
  {
    id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', role: 'house-load', label: null, control: false,
    deviceId: BOX_ID, capabilities: { measure: [{ unit: 'kW', channel: 'power_kw' }] }, guards: { failsafe: { behavior: 'measure-only' } },
    syncStatus: 'in_sync', observed: { health: 'never', lastTelemetryAt: null, channels: null, appliedType: 'house-load', reportedAt: vor(0) },
    edgeSourceId: null, orphanedPin: null, capacityKwp: null, sourceKind: 'composed', certificationStatus: null,
  },
  ...QUELLEN.map((q) => ({
    id: q.entity, entityType: q.typ, typeLabel: q.typLabel, role: q.rolle, label: q.label, control: false,
    deviceId: q.rolle === 'grid-meter' ? BOX_ID : null, capabilities: { measure: [{ unit: 'kW', channel: kanal(q) }] },
    guards: { failsafe: { behavior: istPv(q) ? 'release' : 'measure-only' } }, syncStatus: 'in_sync',
    observed: {
      health: istPv(q) ? (frisch(q) ? 'ok' : 'stale') : 'never', lastTelemetryAt: istPv(q) ? vor(q.alterS) : null,
      channels: istPv(q) ? [kanal(q)] : null, appliedType: q.typ, reportedAt: vor(0),
    },
    edgeSourceId: q.src, orphanedPin: false, capacityKwp: null, sourceKind: 'builtin', certificationStatus: null,
  })),
] as unknown as SiteEntity[];

const localSetup = QUELLEN.map((q, i) => ({
  id: q.src, kind: 'source', role: q.rolle, brand: q.brand, model: q.model, label: q.label, reportedAt: vor(0),
  adoptedEntityId: q.entity, communication: istPv(q) ? 'sunspec_tcp' : 'shelly_em_http',
  family: istPv(q) ? 'sunspec_live' : 'shelly_em_triphase', host: `192.0.2.${101 + i}`, port: istPv(q) ? 502 : 80,
  unitId: istPv(q) ? 1 : null, serial: null, intervalS: 5,
})) as unknown as SiteEntities['localSetup'];

const sources = QUELLEN.map((q) => ({
  deviceId: BOX_ID, sourceId: q.src, kind: 'source', role: q.rolle, label: q.label, brand: q.brand, model: q.model,
  pvKw: istPv(q) ? q.kw : null, powerKw: q.rolle === 'grid-meter' ? q.kw : null, loadKw: q.rolle === 'consumer' ? q.kw : null,
  health: frisch(q) ? 'ok' : 'stale', readAt: vor(q.alterS), reportedAt: vor(0), bms: null,
}));

/** Die Topologie: PV und Netz mit 30-s-Mittel; die Shelly in Unterverteilungen hat sie nie (`never`). */
const pvKw = QUELLEN.filter((q) => istPv(q) && frisch(q)).reduce((s, q) => s + q.kw, 0);
const topology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', label: null, category: 'consumer', health: 'ok', connection: null,
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: true, value: 7.3 }] },
    ...QUELLEN.map((q) => ({
      id: q.entity, entityType: q.typ, typeLabel: q.typLabel, label: q.label,
      category: istPv(q) ? 'producer' : q.rolle === 'grid-meter' ? 'meter' : 'consumer',
      health: q.rolle === 'consumer' ? 'never' : frisch(q) ? 'ok' : 'stale', connection: null,
      capabilities: [{
        channel: kanal(q), unit: 'kW', role: istPv(q) ? 'pv' : q.rolle === 'grid-meter' ? 'grid' : 'consumer',
        primary: q.label === 'Kaco 3' || q.rolle === 'grid-meter', value: q.rolle === 'consumer' || !frisch(q) ? null : q.kw,
      }],
    })),
  ],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const overview = {
  sites: [{
    id: SITE_ID, name: 'Zuhause', plantKind: 'eigenverbrauch', netzladenErlaubt: false, batteryWithoutDevice: false,
    deviceCount: boxen.length, onlineCount: boxen.length, waitingCount: 0, worstStatus: 'online', lastSeenAt: vor(0),
    live: { ts: vor(7), pvKw, loadKw: 7.3, gridKw: -0.6, socPct: null },
    plannedSavingsTodayEur: null, roleCounts: { pv: 3, storage: 0, consumer: 3, grid: 1 }, usageProfile: 'private',
    lastPlanGeneratedAt: null, storageCapacityKwh: null, energyToday: null, chargePointCount: mitHof ? 2 : 0,
    anwendungen: ['monitoring'], standort: null,
  }],
  totals: { sites: 1, devices: boxen.length, online: boxen.length, plannedSavingsTodayEur: null, liveSitesCovered: 1, storageCapacityKwh: null, storagePowerKw: null },
  dailySavings: [],
  teilansicht: { sichtbar: 1, gesamt: 1 },
};

/** `&hof=1`: zwei Ladepunkte an der Box „Hof“ - der eine lädt, der andere ist frei. */
const chargers = mitHof
  ? [
    { deviceId: HOF_ID, chargePointId: 'HOF-2', label: 'Ladepunkt 2', priority: false, connected: true, ready: true, lastSeen: vor(9),
      connectors: [{ connectorId: 1, charging: false, status: 'Available' }] },
    { deviceId: HOF_ID, chargePointId: 'HOF-1', label: 'Ladepunkt 1', priority: false, connected: true, ready: true, lastSeen: vor(9),
      connectors: [{ connectorId: 1, charging: true, powerKw: 11, status: 'Charging' }] },
  ]
  : [];

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  // Die Registry geht an die erste Box - sie führt die Anlage; die Quellen liest sie.
  siteEntities: ok({
    registry: { revision: 'r-1', composedAt: vor(3600), deviceId: BOX_ID, reportedRevision: 'r-1', reportedAt: vor(20) },
    entities,
    localSetup,
    staleOnDevice: [],
  }),
  topology: ok(topology),
  siteSources: ok(sources),
  overview: ok(overview),
  datenquellen: ok({ datenquellen: [] }),
  uemsGeraete: ok({ geraete: [] }),
  siteComponents: ok({ componentAuthority: 'portal', components: [] }),
  siteComponentTemplates: ok([]),
  componentTemplates: ok([]),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok(sichtbareListe(boxen.map((b) => ({
    deviceId: b.id, siteId: SITE_ID, coreVersion: 'edge-2026.11.0', paletteVersion: null, reportedAt: vor(20),
    capabilities: ['data_sources', 'geraetesuche'],
  })))),
  siteChargers: ok({ budget: null, chargers }),
  entityStrategies: ok({}),
  listDevices: ok(sichtbareListe(boxen)),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  commandHistory: ok({
    recordingSince: null, accuracySeconds: 60, from: vor(86_400), to: vor(0), entityId: null, entityLabel: null,
    writes: false, truncated: false, total: 0, entries: [],
  }),
  registerWriteTargets: ok([]),
  registerWriteHistory: ok([]),
  registerKnowledge: ok([]),
  geraetesucheVerlauf: ok({ suchen: [] }),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]), status: ok([]) });
Object.assign(entitiesApi, { typeCatalog: ok({ types: [] }) });

if (flaeche === 'aufbau' && !window.location.hash) window.location.hash = `#/anlage/${SITE_ID}/modell`;

function Flaeche() {
  if (flaeche === 'box') {
    return <BoxSeiteSection site={site} boxRef={box.externalRef} devices={boxen} devicesFetchedAt={jetzt} />;
  }
  return <AufbauSection site={site} sites={[site]} devices={boxen} devicesFetchedAt={jetzt} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">{site.name}</div>
      </header>
      <main className="vp-main">
        <Flaeche />
      </main>
    </div>
  </React.StrictMode>,
);
