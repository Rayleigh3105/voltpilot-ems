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
 * E2E-Bühne „Zählerbaum: Liste" (Konzept `vp-zaehlerbaum-konzept`, Entscheide
 * E1-E5 = A vom 10.11.2026): der echte Aufbau über den Werten des vom
 * Captain gemeldeten Falls - Netzanschluss 8,1 kW Bezug, UV Halle 7,7 kW,
 * UV Keller 0,1 kW, abends ohne Sonne.
 *
 * `?kompressor=1` fügt einen Kompressor (3,2 kW) HINTER UV Halle ein
 * (`haengtAn`) - genau der Fall, den es vor dem Zählerbaum-Konzept nicht gab:
 * eine Maschine hinter einer Unterverteilung. Ohne den Parameter zeigt die
 * Bühne den Bestand unverändert (zeichengleich zu heute). Die Bühne ruft nie
 * eine Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const mitKompressor = frage.get('kompressor') === '1';
// `?ohneNetz=1`: keine Anlage mit Netzanschluss-Zähler - die Vorgabe (Vertrag
// §1) hat keine Wurzel zum Anhängen, die heutige flache Anzeige bleibt.
const ohneNetz = frage.get('ohneNetz') === '1';
const jetzt = Date.now();
const vor = (s: number) => new Date(jetzt - s * 1000).toISOString();

const SITE_ID = '6b0c1e2a-0000-4000-8000-00000000a001';
const BOX_ID = '6b0c1e2a-0000-4000-8000-00000000b001';
const site: Site = {
  id: SITE_ID,
  name: 'Haus am Mühlbach',
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
  id: BOX_ID, siteId: SITE_ID, externalRef: 'edge-muehlbach1', kind: 'edge', name: null, status: 'active',
  lastSeenAt: vor(16), createdAt: '2026-10-01T08:00:00Z',
};

interface Quelle {
  src: string;
  entity: string;
  label: string;
  rolle: 'grid-meter' | 'consumer';
  typ: string;
  typLabel: string;
  kw: number;
  haengtAn?: string;
}
const QUELLEN: Quelle[] = [
  ...(ohneNetz
    ? []
    : [{ src: 'src-netzanschluss', entity: 'e-netz', label: 'Netzanschluss', rolle: 'grid-meter' as const, typ: 'grid-meter', typLabel: 'Netzanschlusszähler', kw: 8.1 }]),
  { src: 'src-uv-halle', entity: 'e-uv-halle', label: 'UV Halle', rolle: 'consumer', typ: 'sub-meter', typLabel: 'Unterzähler', kw: 7.7 },
  { src: 'src-uv-keller', entity: 'e-uv-keller', label: 'UV Keller', rolle: 'consumer', typ: 'sub-meter', typLabel: 'Unterzähler', kw: 0.1 },
  ...(mitKompressor
    ? [{ src: 'src-kompressor', entity: 'e-kompressor', label: 'Kompressor', rolle: 'consumer' as const, typ: 'generic-load', typLabel: 'Verbraucher', kw: 3.2, haengtAn: 'e-uv-halle' }]
    : []),
];
const istNetz = (q: Quelle) => q.rolle === 'grid-meter';
const kanal = () => 'power_kw';

/**
 * Umhängen (Captain-Nachtrag, R5): die Bühne ist kein Standbild mehr - `PUT
 * .../haengt-an` schreibt hier wirklich um, und jeder folgende Abruf von
 * `entities`/`topology` liest den geänderten Stand. Ohne diese Karte würde
 * „Übernehmen" im Dialog zwar den Server-Aufruf zeigen, die Liste aber nie
 * ihre Zeilen umsortieren - das Durchklicken bliebe unbewiesen.
 */
const haengtAnJetzt = new Map<string, string | null>(QUELLEN.map((q) => [q.entity, q.haengtAn ?? null]));

function entities(): SiteEntity[] {
  return [
    {
      id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', role: 'house-load', label: null, control: false,
      deviceId: BOX_ID, capabilities: { measure: [{ unit: 'kW', channel: 'power_kw' }] }, guards: { failsafe: { behavior: 'measure-only' } },
      syncStatus: 'in_sync', observed: { health: 'never', lastTelemetryAt: null, channels: null, appliedType: 'house-load', reportedAt: vor(0) },
      edgeSourceId: null, orphanedPin: null, capacityKwp: null, sourceKind: 'composed', certificationStatus: null,
    },
    ...QUELLEN.map((q) => ({
      id: q.entity, entityType: q.typ, typeLabel: q.typLabel, role: q.rolle, label: q.label, control: false,
      deviceId: istNetz(q) ? BOX_ID : null, capabilities: { measure: [{ unit: 'kW', channel: kanal() }] },
      guards: { failsafe: { behavior: 'measure-only' } }, syncStatus: 'in_sync',
      observed: { health: istNetz(q) ? 'ok' : 'never', lastTelemetryAt: istNetz(q) ? vor(16) : null, channels: istNetz(q) ? [kanal()] : null, appliedType: q.typ, reportedAt: vor(0) },
      edgeSourceId: q.src, orphanedPin: false, capacityKwp: null, sourceKind: 'builtin', certificationStatus: null,
      haengtAn: haengtAnJetzt.get(q.entity) ?? null,
    })),
  ] as unknown as SiteEntity[];
}

const localSetup = QUELLEN.map((q, i) => ({
  id: q.src, kind: 'source', role: q.rolle, brand: 'shelly', model: 'shelly-pro-3em', label: q.label, reportedAt: vor(0),
  adoptedEntityId: q.entity, communication: 'shelly_em_http', family: 'shelly_em_triphase',
  host: `192.0.2.${110 + i}`, port: 80, unitId: null, serial: null, intervalS: 5,
})) as unknown as SiteEntities['localSetup'];

const sources = QUELLEN.map((q) => ({
  deviceId: BOX_ID, sourceId: q.src, kind: 'source', role: q.rolle, label: q.label, brand: 'shelly', model: 'shelly-pro-3em',
  pvKw: null, powerKw: istNetz(q) ? q.kw : null, loadKw: !istNetz(q) ? q.kw : null,
  health: 'ok', readAt: vor(16), reportedAt: vor(0), bms: null,
}));

function topology(): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities: [
      { id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', label: null, category: 'consumer', health: 'ok', connection: null,
        capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: true, value: 8.1 }] },
      ...QUELLEN.map((q) => ({
        id: q.entity, entityType: q.typ, typeLabel: q.typLabel, label: q.label,
        category: istNetz(q) ? 'meter' : 'consumer', health: istNetz(q) ? 'ok' : 'never', connection: null,
        capabilities: [{
          channel: kanal(), unit: 'kW', role: istNetz(q) ? 'grid' : 'consumer',
          primary: istNetz(q), value: istNetz(q) ? q.kw : null, haengt_an: haengtAnJetzt.get(q.entity) ?? undefined,
        }],
      })),
    ],
    topology: { schema_version: '1.0', nodes: [] },
  } as unknown as SiteTopology;
}

const overview = {
  sites: [{
    id: SITE_ID, name: site.name, plantKind: 'eigenverbrauch', netzladenErlaubt: false, batteryWithoutDevice: false,
    deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: vor(0),
    live: { ts: vor(7), pvKw: 0, loadKw: 8.1, gridKw: ohneNetz ? null : 8.1, socPct: null },
    plannedSavingsTodayEur: null,
    roleCounts: { pv: 0, storage: 0, consumer: QUELLEN.filter((q) => !istNetz(q)).length, grid: QUELLEN.filter(istNetz).length },
    usageProfile: 'private',
    lastPlanGeneratedAt: null, storageCapacityKwh: null, energyToday: null, chargePointCount: 0,
    anwendungen: ['monitoring'], standort: null,
  }],
  totals: { sites: 1, devices: 1, online: 1, plannedSavingsTodayEur: null, liveSitesCovered: 1, storageCapacityKwh: null, storagePowerKw: null },
  dailySavings: [],
  teilansicht: { sichtbar: 1, gesamt: 1 },
};

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: () =>
    Promise.resolve(
      structuredClone({
        registry: { revision: 'r-1', composedAt: vor(3600), deviceId: BOX_ID, reportedRevision: 'r-1', reportedAt: vor(20) },
        entities: entities(),
        localSetup,
        staleOnDevice: [],
      }),
    ),
  topology: () => Promise.resolve(structuredClone(topology())),
  // Umhängen (Captain-Nachtrag, R5): schreibt wirklich um, damit das Durchklicken beweisbar ist.
  haengtAnSetzen: (_siteId: string, entityId: string, body: { haengtAn: string | null }) => {
    haengtAnJetzt.set(entityId, body.haengtAn ?? null);
    return Promise.resolve({ componentAuthority: 'portal', components: [] });
  },
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
    deviceId: BOX_ID, siteId: SITE_ID, coreVersion: 'edge-2026.11.0', paletteVersion: null, reportedAt: vor(16),
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
