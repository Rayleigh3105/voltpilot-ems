import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type Device, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { GeraetSeiteSection } from '../src/pages/GeraetSeiteSection';
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
 * E2E-Bühne der GERÄTESEITE eines Heizstabs (Heizstab V1): die echte `GeraetSeiteSection` mit einem Shelly Pro 3,
 * dessen drei Ausgänge EIN Gerät `heating-rod` sind (2 kW je Phase, Stufen 1/2/3). Fiktive Anlage „Hof Seewiesen“.
 *
 * `?fall=` stellt den Zustand der Box:
 * - `heizt` (Standard): bestätigt L1 und L2 · 4,0 kW, der Regler heizt mit Überschuss;
 * - `abweichung`: bestätigt 2 Phasen, ein Ausgang steht seit 11:00 gegen den Befehl (HZ-4 B);
 * - `hand`: von Hand L1 und L3 gewählt bis 13:47, bestätigt ist erst L1;
 * - `still`: noch keine Rückmeldung der Box;
 * - `alt`: eine Box ohne `heizstab_phasen` - sie schaltet nur Stufen;
 * - `zusammen`: ein Stab „nur alle zusammen“ (ein Schalter);
 * - `ruht`: Smart ruht (Gerät pausiert), der Stab ist aus;
 * - `einrichtung`: der Stab wurde mit nur Ausgang 0 angelegt (Fall GATE) und wird unter „Technik“ repariert;
 * - `widerspruch` (Teil A, Captain-Befund 05.11.2026): bestätigt 3 Phasen · 6,0 kW, die gemessene
 *   Hausbilanz derselben Anlage gibt nur ≈0,3 kW her (PV 0,2 + Speicherentladung 0,1, Netz ausgeglichen) -
 *   der Thermostat des Stabs hat vermutlich selbst abgeschaltet.
 *
 * Die Uhr der Seite stellt die Spec (`page.clock`); belegt ist, was die Seite fragt, alles Übrige antwortet
 * „nichts da“. Die Bühne ruft nie eine Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const fall = frage.get('fall') ?? 'heizt';
const JETZT = new Date().toISOString();
const vor = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const site = {
  id: 'site-seewiesen',
  name: 'Hof Seewiesen',
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
  id: 'box-seewiesen',
  siteId: site.id,
  externalRef: 'edge-seewiesen',
  kind: 'inverter',
  name: 'Seewiesen',
  status: 'active',
  lastSeenAt: JETZT,
  createdAt: null,
};

const QUELLE = 'src-shelly-pro3-43';
const STAB = 'e-hz';

const stabEntity = {
  id: STAB,
  entityType: 'heating-rod',
  typeLabel: 'Heizstab',
  role: 'consumer',
  label: 'Heizstab Warmwasser',
  control: true,
  deviceId: box.id,
  capabilities: {
    measure: [{ channel: 'relay_on_0' }, { channel: 'relay_on_1' }, { channel: 'relay_on_2' }],
    actuate: [{ command: 'on_off' }, { command: 'setpoint_kw', min: 0, max: 6 }],
  },
  guards: { limits: { max_consumption_kw: 6 }, failsafe: { behavior: 'off' } },
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: QUELLE,
  brand: 'shelly',
  model: 'shelly_http',
  sourceKind: 'builtin',
};

const komponente = {
  id: STAB,
  role: 'consumer',
  entityType: 'heating-rod',
  label: 'Heizstab Warmwasser',
  brand: 'shelly',
  model: 'shelly_http',
  family: 'shelly_http',
  communication: 'shelly_http',
  connection: fall === 'einrichtung'
    ? { ip: '192.168.178.43', port: 80, channels: [0], output_kw: [2], stages: [1], rotation: 'daily', anschluss: 'stern_mit_n' }
    : { ip: '192.168.178.43', port: 80, channels: [0, 1, 2], output_kw: [2, 2, 2], stages: fall === 'zusammen' ? [3] : [1, 2, 3], rotation: 'daily', anschluss: 'stern_mit_n' },
  sourceKind: 'builtin',
  templateRef: 'builtin:shelly:shelly_http',
  templateVersion: 1,
  definitionVersion: 1,
  edgeSourceId: QUELLE,
  syncStatus: 'in_sync',
};

const verbraucher = {
  id: STAB,
  type: 'heating-rod',
  typeLabel: 'Heizstab',
  name: 'Heizstab Warmwasser',
  controlKind: 'stepped',
  ratedPowerKw: 6,
  minPowerKw: null,
  levelsKw: fall === 'einrichtung' ? [0, 2] : fall === 'zusammen' ? [0, 6] : [0, 2, 4, 6],
  resolutionKw: null,
  powerRangesKw: null,
  storageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'surplus_only',
  allowStorageDischarge: false,
  failsafe: 'off',
  enabled: true,
  version: 1,
  connection: 'connected',
  edgeSourceId: QUELLE,
  controlActivation: fall === 'ruht' ? 'paused' : 'active',
  hasDraftPolicy: false,
  draftPolicyVersion: null,
  confirmationChannel: 'relay_state',
};

const heizt = { commanded: 2, commanded_kw: 4, confirmed: 2, confirmed_kw: 4, outputs_on: [0, 1], mismatch_since: null, at: JETZT };
const aus = { commanded: 0, commanded_kw: 0, confirmed: 0, confirmed_kw: 0, outputs_on: [], mismatch_since: null, at: JETZT };
const stufe = {
  heizt,
  abweichung: { commanded: 1, commanded_kw: 2, confirmed: 2, confirmed_kw: 4, outputs_on: [0, 1], mismatch_since: vor(52), at: JETZT },
  hand: { commanded: 2, commanded_kw: 4, confirmed: 1, confirmed_kw: 2, outputs_on: [0], mismatch_since: null, at: vor(1) },
  still: null,
  alt: heizt,
  zusammen: aus,
  ruht: aus,
  einrichtung: aus,
  // Teil A (Captain-Befund 05.11.2026): 3 Phasen bestätigt (6,0 kW), die
  // gemessene Hausbilanz (siehe `topology` unten) gibt dafür keinen Raum.
  widerspruch: { commanded: 3, commanded_kw: 6, confirmed: 3, confirmed_kw: 6, outputs_on: [0, 1, 2], mismatch_since: null, at: JETZT },
}[fall] ?? null;

const regler = fall === 'still' || fall === 'hand' || fall === 'ruht' || fall === 'widerspruch'
  ? null
  : fall === 'abweichung'
    ? { stufe: 1, code: 'kein_ueberschuss', grund: 'Netzbezug - hält er 30 Sekunden an, folgt eine kleinere Stufe.' }
    : fall === 'zusammen' || fall === 'einrichtung'
      ? { stufe: 0, code: 'kein_ueberschuss', grund: 'Wartet auf Sonne · frei 0,8 von 6,0 kW.' }
      : { stufe: 2, code: 'ueberschuss', grund: 'Heizt mit Überschuss.' };

/**
 * Teil A: dieselben Anlagen-weiten Knoten wie das Dashboard (`pvKnoten`/
 * `netzKnoten`/`speicherKnoten`) - ≈0,3 kW Hausverbrauch gegen die
 * bestätigte Stufe 3 (≈6,0 kW in dieser Bühne). Jeder andere Fall bleibt
 * ohne Anlagen-Topologie (kein Plausibilitätsurteil nötig).
 */
const topology = fall === 'widerspruch'
  ? {
    schemaVersion: '1.0',
    entities: [
      { id: 'e-pv', entityType: 'inverter', typeLabel: 'Wechselrichter', label: 'Wechselrichter', category: 'producer', health: 'ok', capabilities: [] },
      { id: 'e-grid', entityType: 'meter', typeLabel: 'Zähler', label: 'Netzzähler', category: 'meter', health: 'ok', capabilities: [] },
      { id: 'e-batt', entityType: 'battery', typeLabel: 'Speicher', label: 'Speicher', category: 'storage', health: 'ok', capabilities: [] },
    ],
    topology: {
      schema_version: '1.0',
      nodes: [
        { role: 'pv', value_kw: 0.2, flow_active: true, direction: 'in', members: [{ entity_id: 'e-pv', label: 'Wechselrichter', primary: true, value_kw: 0.2 }] },
        { role: 'grid', value_kw: 0, flow_active: false, members: [{ entity_id: 'e-grid', label: 'Netzzähler', primary: true, value_kw: 0 }] },
        { role: 'storage', value_kw: 0.1, flow_active: true, direction: 'in', members: [{ entity_id: 'e-batt', label: 'Speicher', primary: true, value_kw: -0.1 }] },
      ],
    },
  }
  : { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } };

const status = fall === 'still'
  ? []
  : [{
    entityId: STAB,
    // Teil B (Captain-Befund 05.11.2026): ein Handeingriff heißt im
    // geschlossenen Vokabular `running_manual`, nie ein erfundenes Wort.
    state: fall === 'hand' ? 'running_manual' : 'running_optimized',
    actualKw: null,
    confirmed: stufe ? true : null,
    reportedAt: JETZT,
    stufe,
    heizstab: regler,
    stufeEnergieKwhHeute: fall === 'hand' ? null : 7.2,
  }];

const overrides = fall === 'hand'
  ? [{
    entityId: STAB, kind: 'start', targetCommand: 'setpoint_kw', targetValue: 4, targetOutputs: [0, 2],
    endsAt: new Date(Date.now() + 115 * 60_000).toISOString(),
  }]
  : [];

const merke: Record<string, unknown> = {};
(window as unknown as { __gesendet: Record<string, unknown> }).__gesendet = merke;
const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: ok({
    registry: null,
    entities: [stabEntity],
    localSetup: [{
      id: QUELLE, kind: 'source', role: 'consumer', brand: 'shelly', model: 'shelly_http', family: 'shelly_http',
      label: 'Shelly Pro 3', reportedAt: JETZT, adoptedEntityId: STAB,
    }],
    staleOnDevice: [],
  }),
  topology: ok(topology),
  siteSources: ok([{
    deviceId: box.id, sourceId: QUELLE, kind: 'source', role: 'consumer', label: 'Shelly Pro 3', brand: 'shelly',
    model: 'shelly_http', pvKw: null, powerKw: null, loadKw: null, health: 'ok', readAt: JETZT, reportedAt: JETZT,
  }]),
  siteComponents: ok({ componentAuthority: 'portal', components: [komponente] }),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok(sichtbareListe([{
    deviceId: box.id, siteId: site.id, coreVersion: fall === 'alt' ? 'edge-2026.10.30' : 'edge-2026.11.05', paletteVersion: '0.9.0', reportedAt: JETZT,
    capabilities: fall === 'alt' ? ['data_sources', 'heizstab_regler'] : ['data_sources', 'heizstab_regler', 'heizstab_phasen'],
  }])),
  siteVerbraucher: ok({
    verbraucher: [{
      entityId: STAB, name: 'Heizstab Warmwasser', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false,
      steuerart: { quelle: 'ueberschuss', herkunft: 'policy' }, regeln: 0,
    }],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
    rangliste: [{ position: 1, art: 'verbraucher', entityId: STAB, name: 'Heizstab Warmwasser' }],
  }),
  testComponentConnection: (...a: unknown[]) => {
    merke.testComponentConnection = a.at(-1);
    return Promise.resolve({ requestId: 'r1', results: [{ id: 'verbindung', ok: true, samples: [{ channel: 'relay_on_0', raw: 0, value: 0, count: 1 }] }] });
  },
  updateComponent: (...a: unknown[]) => { merke.updateComponent = a.at(-1); return Promise.resolve({}); },
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  schedule: ok({ slots: [], generatedAt: null }),
  registerWriteTargets: ok([]),
  registerWriteHistory: ok([]),
  registerKnowledge: ok([]),
  geraetAenderungen: ok({ eintraege: [], achse: 'wirkung', von: null, bis: null, weiter: null }),
  commandHistory: ok({
    recordingSince: null, accuracySeconds: 60, from: vor(24 * 60), to: JETZT,
    entityId: STAB, entityLabel: 'Heizstab Warmwasser', writes: true, truncated: false, total: 0, entries: [],
  }),
};

const offen = api as unknown as Record<string, unknown>;

for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, {
  list: ok([verbraucher]),
  overrides: ok(overrides),
  status: ok(status),
  fulfillment: () => Promise.reject(new Error('E2E-Bühne: fulfillment ist nicht belegt')),
  startOverride: (...a: unknown[]) => { merke.startOverride = a.at(-1); return Promise.resolve({ pushed: true, phasenGenau: true }); },
  clearOverride: (...a: unknown[]) => { merke.clearOverride = a; return Promise.resolve({}); },
  pause: (...a: unknown[]) => { merke.pause = a; return Promise.resolve({ published: true, message: '' }); },
  resume: (...a: unknown[]) => { merke.resume = a; return Promise.resolve({ activated: true, reason: null, message: '', published: true, policyVersion: 1 }); },
  patch: (...a: unknown[]) => { merke.patch = a.at(-1); return Promise.resolve(verbraucher); },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content">
      <header className="vp-topbar">
        <div className="crumbs">{site.name}</div>
      </header>
      <main className="vp-main">
        <GeraetSeiteSection site={site} boxRef={box.externalRef} geraetId={QUELLE} devices={[box]} />
      </main>
    </div>
  </React.StrictMode>,
);
