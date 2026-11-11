import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type Device, type Site, type SiteEntities, type SiteEntity, type SiteTopology } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { entitiesApi } from '../src/entitiesApi';
import { AufbauSection } from '../src/pages/AufbauSection';
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
 * E2E-Bühne „Zählerbaum: Liste gewerblich" (Konzept `vp-zaehlerbaum-konzept`,
 * Entscheide E1-E5 = A vom 10.11.2026), die gewerbliche Gegenprobe zu
 * `zb-liste.html`: eine Werkhalle mit ZWEI Unterverteilungen und je mehreren
 * Maschinen dahinter (Bericht §3.1, „Werk Nord"): Netzanschluss 64,8 kW Bezug,
 * Dach-PV 22,4 kW, macht 87,2 kW im Werk.
 *
 * UV Halle 1 (58,6 kW) trägt die Laserschneidanlage (21,4), die Abkantpresse
 * (9,8) und den Schraubenkompressor (7,6) - 19,8 kW bleiben ohne eigenen
 * Zähler. UV Büro misst 9,1 kW für sich. UV Halle 2 (6,3 kW) trägt die
 * Absauganlage (4,1) - 2,2 kW bleiben ohne eigenen Zähler. Am Werk selbst
 * bleiben 13,2 kW ohne eigenen Zähler (87,2 − 58,6 − 9,1 − 6,3).
 *
 * Zeigt, dass der Zählerbaum GLEICH für gewerbliche Anlagen gilt (R1 je
 * Ebene, beliebig tief) - keine zweite Regel, kein zweiter Code. Die Bühne
 * ruft nie eine Cloud.
 */
const jetzt = Date.now();
const vor = (s: number) => new Date(jetzt - s * 1000).toISOString();

const SITE_ID = '7b0c1e2a-0000-4000-8000-00000000a001';
const BOX_ID = '7b0c1e2a-0000-4000-8000-00000000b001';
const site: Site = {
  id: SITE_ID,
  name: 'Werk Nord',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  // E3 A / UV-4 A: wählt das Wort des Rests an der Wurzel (`restWort`) - "ohne eigenen Zähler", nicht "übriger
  // Haushalt".
  profil: 'gewerbe',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};
const box: Device = {
  id: BOX_ID, siteId: SITE_ID, externalRef: 'edge-werknord1', kind: 'edge', name: null, status: 'active',
  lastSeenAt: vor(14), createdAt: '2026-09-01T08:00:00Z',
};

interface Quelle {
  src: string;
  entity: string;
  label: string;
  rolle: 'grid-meter' | 'consumer' | 'pv-generation';
  typ: string;
  typLabel: string;
  kw: number;
  haengtAn?: string;
}
/** In der Reihenfolge, in der die Box sie meldet (Quellkennung) - der Baum sortiert sie neu. */
const QUELLEN: Quelle[] = [
  { src: 'src-dachpv', entity: 'e-dachpv', label: 'Dach-PV', rolle: 'pv-generation', typ: 'producer', typLabel: 'Erzeuger (PV)', kw: 22.4 },
  { src: 'src-netzanschluss', entity: 'e-netz', label: 'Netzanschluss', rolle: 'grid-meter', typ: 'grid-meter', typLabel: 'Netzanschlusszähler', kw: 64.8 },
  { src: 'src-uv-halle1', entity: 'e-uv-halle1', label: 'UV Halle 1', rolle: 'consumer', typ: 'sub-meter', typLabel: 'Unterzähler', kw: 58.6 },
  { src: 'src-laser', entity: 'e-laser', label: 'Laserschneidanlage', rolle: 'consumer', typ: 'generic-load', typLabel: 'Verbraucher', kw: 21.4, haengtAn: 'e-uv-halle1' },
  { src: 'src-abkant', entity: 'e-abkant', label: 'Abkantpresse', rolle: 'consumer', typ: 'generic-load', typLabel: 'Verbraucher', kw: 9.8, haengtAn: 'e-uv-halle1' },
  { src: 'src-schraubkompr', entity: 'e-schraubkompr', label: 'Schraubenkompressor', rolle: 'consumer', typ: 'generic-load', typLabel: 'Verbraucher', kw: 7.6, haengtAn: 'e-uv-halle1' },
  { src: 'src-uv-buero', entity: 'e-uv-buero', label: 'UV Büro', rolle: 'consumer', typ: 'sub-meter', typLabel: 'Unterzähler', kw: 9.1 },
  { src: 'src-uv-halle2', entity: 'e-uv-halle2', label: 'UV Halle 2', rolle: 'consumer', typ: 'sub-meter', typLabel: 'Unterzähler', kw: 6.3 },
  { src: 'src-absaugung', entity: 'e-absaugung', label: 'Absauganlage', rolle: 'consumer', typ: 'generic-load', typLabel: 'Verbraucher', kw: 4.1, haengtAn: 'e-uv-halle2' },
];
const istNetz = (q: Quelle) => q.rolle === 'grid-meter';
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
    deviceId: istNetz(q) ? BOX_ID : null, capabilities: { measure: [{ unit: 'kW', channel: kanal(q) }] },
    guards: { failsafe: { behavior: istPv(q) ? 'release' : 'measure-only' } }, syncStatus: 'in_sync',
    observed: { health: istNetz(q) || istPv(q) ? 'ok' : 'never', lastTelemetryAt: istNetz(q) || istPv(q) ? vor(14) : null, channels: istNetz(q) || istPv(q) ? [kanal(q)] : null, appliedType: q.typ, reportedAt: vor(0) },
    edgeSourceId: q.src, orphanedPin: false, capacityKwp: istPv(q) ? 30 : null, sourceKind: 'builtin', certificationStatus: null,
    haengtAn: q.haengtAn ?? null,
  })),
] as unknown as SiteEntity[];

const localSetup = QUELLEN.map((q, i) => ({
  id: q.src, kind: 'source', role: q.rolle, brand: 'shelly', model: 'shelly-pro-3em', label: q.label, reportedAt: vor(0),
  adoptedEntityId: q.entity, communication: 'shelly_em_http', family: 'shelly_em_triphase',
  host: `192.0.2.${120 + i}`, port: 80, unitId: null, serial: null, intervalS: 5,
})) as unknown as SiteEntities['localSetup'];

const sources = QUELLEN.map((q) => ({
  deviceId: BOX_ID, sourceId: q.src, kind: 'source', role: q.rolle, label: q.label, brand: 'shelly', model: 'shelly-pro-3em',
  pvKw: istPv(q) ? q.kw : null, powerKw: istNetz(q) ? q.kw : null, loadKw: !istNetz(q) && !istPv(q) ? q.kw : null,
  health: 'ok', readAt: vor(14), reportedAt: vor(0), bms: null,
}));

const topology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', label: null, category: 'consumer', health: 'ok', connection: null,
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: true, value: 87.2 }] },
    ...QUELLEN.map((q) => ({
      id: q.entity, entityType: q.typ, typeLabel: q.typLabel, label: q.label,
      category: istPv(q) ? 'producer' : istNetz(q) ? 'meter' : 'consumer',
      health: istNetz(q) || istPv(q) ? 'ok' : 'never', connection: null,
      capabilities: [{
        channel: kanal(q), unit: 'kW', role: istPv(q) ? 'pv' : istNetz(q) ? 'grid' : 'consumer',
        primary: istNetz(q) || istPv(q), value: istNetz(q) || istPv(q) ? q.kw : null, haengt_an: q.haengtAn ?? undefined,
      }],
    })),
  ],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const overview = {
  sites: [{
    id: SITE_ID, name: site.name, plantKind: 'eigenverbrauch', netzladenErlaubt: false, batteryWithoutDevice: false,
    deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: vor(0),
    live: { ts: vor(7), pvKw: 22.4, loadKw: 87.2, gridKw: 64.8, socPct: null },
    plannedSavingsTodayEur: null, roleCounts: { pv: 1, storage: 0, consumer: QUELLEN.length - 2, grid: 1 }, usageProfile: 'gewerbe',
    lastPlanGeneratedAt: null, storageCapacityKwh: null, energyToday: null, chargePointCount: 0,
    anwendungen: ['monitoring'], standort: null,
  }],
  totals: { sites: 1, devices: 1, online: 1, plannedSavingsTodayEur: null, liveSitesCovered: 1, storageCapacityKwh: null, storagePowerKw: null },
  dailySavings: [],
  teilansicht: { sichtbar: 1, gesamt: 1 },
};

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
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
  edgeVersions: ok(sichtbareListe([{
    deviceId: BOX_ID, siteId: SITE_ID, coreVersion: 'edge-2026.11.0', paletteVersion: null, reportedAt: vor(14),
    capabilities: ['data_sources', 'geraetesuche'],
  }])),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  listDevices: ok(sichtbareListe([box])),
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

if (!window.location.hash) window.location.hash = `#/anlage/${SITE_ID}/modell`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">{site.name}</div>
      </header>
      <main className="vp-main">
        <AufbauSection site={site} sites={[site]} devices={[box]} devicesFetchedAt={jetzt} />
      </main>
    </div>
  </React.StrictMode>,
);
