import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type Device, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { GeraetSeiteSection } from '../src/pages/GeraetSeiteSection';
import {
  c1,
  c1Einstellungen,
  c1EinstellungenVorA5,
  gr4Einstellungen,
  gr4Z5a,
  gr4Z5b,
  K5,
  K8,
  K8_NAMEN,
  k5Kanaele,
  k82Kanaele,
  SITE_HALLE_1,
  SITE_HALLE_2,
} from '../src/test/geraetHerkunftFixtures';
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
 * E2E-Bühne der ergänzten GERÄTESEITE (UEMS AP-04 IP-12): die ECHTE
 * `GeraetSeiteSection` im Inhaltsrahmen der Schale, deren Abrufe hier mit den
 * Antworten des Referenzunternehmens Ahrenberg belegt sind
 * (`src/test/geraetHerkunftFixtures.ts`). `?fall=gr4` zeigt GR-4 nach dem
 * Zählerwechsel (K-5 → MS-06), `?fall=ek2` die Energiekarte EK-2 am Controller
 * C-1 mit dem angekündigten Wandler 400/5 A (K-8.2 → MS-11), `&vor=a5` denselben
 * Stand vor dem Eintrag.
 *
 * Belegt ist, was die Seite fragt; alles Übrige antwortet „nichts da“ — die
 * Seite ist darauf gebaut (fail-soft), und die Bühne ruft nie eine Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const fall = frage.get('fall') === 'ek2' ? 'ek2' : 'gr4';
/** `?vor=a5`: C-1 VOR dem Eintrag des neuen Wandlers — der Stand, an dem der Dialog A5 beginnt. */
const vorA5 = frage.get('vor') === 'a5';
const JETZT = new Date().toISOString();

const F = {
  gr4: {
    site: { id: SITE_HALLE_1, name: 'Werk Ahrenberg – Halle 1' },
    box: { id: 'box-e1', ref: 'edge-ahr-h1', name: 'Box Halle 1' },
    quelle: 'src-gr4',
    entity: K5,
    label: 'Unterzähler Spritzguss SG01–SG06',
    powerKw: 38.4,
    geraete: () => [gr4Z5a(), gr4Z5b()],
    kanaele: k5Kanaele,
    einstellungen: gr4Einstellungen,
  },
  ek2: {
    site: { id: SITE_HALLE_2, name: 'Werk Ahrenberg – Halle 2' },
    box: { id: 'box-e2', ref: 'edge-ahr-h2', name: 'Box Halle 2' },
    quelle: 'src-ek2',
    entity: K8[1],
    label: K8_NAMEN[K8[1]],
    powerKw: 61.2,
    geraete: () => [c1()],
    kanaele: k82Kanaele,
    einstellungen: vorA5 ? c1EinstellungenVorA5 : c1Einstellungen,
  },
}[fall];

const site = {
  ...F.site,
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
} as Site;

const box: Device = {
  id: F.box.id,
  siteId: F.site.id,
  externalRef: F.box.ref,
  kind: 'inverter',
  name: F.box.name,
  status: 'active',
  lastSeenAt: JETZT,
  createdAt: null,
};

const ok = <T,>(wert: T) => () => Promise.resolve(wert);
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: ok({
    registry: null,
    entities: [
      {
        id: F.entity,
        entityType: 'grid-meter',
        typeLabel: 'Zähler',
        role: 'grid',
        label: F.label,
        control: false,
        deviceId: box.id,
        capabilities: { measure: [{ channel: 'power_kw' }] },
        guards: null,
        syncStatus: 'in_sync',
        observed: null,
        edgeSourceId: F.quelle,
      },
    ],
    localSetup: [
      {
        id: F.quelle,
        kind: 'source',
        role: 'grid-meter',
        brand: null,
        model: null,
        family: 'modbus-generic',
        label: null,
        reportedAt: JETZT,
        adoptedEntityId: F.entity,
      },
    ],
    staleOnDevice: [],
  }),
  topology: ok({ schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
  siteSources: ok([
    {
      deviceId: box.id,
      sourceId: F.quelle,
      kind: 'source',
      role: 'grid-meter',
      label: null,
      brand: null,
      model: null,
      pvKw: null,
      powerKw: F.powerKw,
      loadKw: null,
      health: 'ok',
      readAt: JETZT,
      reportedAt: JETZT,
    },
  ]),
  siteComponents: ok({ componentAuthority: 'portal', components: [] }),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok([{ deviceId: box.id, siteId: site.id, coreVersion: 'edge-2026.09.10', paletteVersion: '0.9.0', reportedAt: JETZT }]),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  schedule: ok({ slots: [], generatedAt: null }),
  registerWriteTargets: ok([]),
  registerWriteHistory: ok([]),
  registerKnowledge: ok([]),
  measurementSelection: ok({
    deviceId: box.id, siteId: site.id, desiredRevision: 0, catalogVersion: '2026.08.26.3',
    status: 'idle', statusReason: 'Keine zusätzlichen Messwerte ausgewählt.',
    activationNotice: '', disableNotice: '', selections: [],
    volumeEstimate: { enabledPointCount: 0, samplesPerMinute: 0, requestsPerMinute: 0, dutyCyclePercent: 0,
      softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0, longTermGbPerYear: 0,
      totalGbPerYear: 0, retentionSummary: '' },
  }),
  measurementCatalog: ok({
    catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased', customPointActionLabel: 'Eigenen Messwert hinzufügen',
    total: 0, offset: 0, limit: 100, groups: [], semanticStatuses: [], points: [],
  }),
  uemsGeraete: ok({ geraete: F.geraete() }),
  komponenteMesskanaele: ok(F.kanaele()),
  geraetEinstellungen: ok(F.einstellungen()),
  geraetAenderungen: ok({ eintraege: [], achse: 'wirkung', von: null, bis: null, weiter: null }),
};

const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]) });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">{site.name}</div>
      </header>
      <main className="vp-main">
        <GeraetSeiteSection site={site} boxRef={box.externalRef} geraetId={F.quelle} devices={[box]} />
      </main>
    </div>
  </React.StrictMode>,
);
