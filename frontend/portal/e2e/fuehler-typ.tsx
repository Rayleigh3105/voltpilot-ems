import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type SiteEntities, type SiteEntity, type SiteTopology } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { entitiesApi } from '../src/entitiesApi';
import { AufbauSection } from '../src/pages/AufbauSection';
import { gsAnlage, gsBox } from '../src/test/geraetesucheFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/GemeinsameSteuerungKarte.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean>; tokenParsed: unknown }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
// Nur der Plattform-Admin sieht "Komponente anlegen (technisch)" (auth.isPlatformAdmin liest realm_access.roles).
(keycloak as unknown as { tokenParsed: { realm_access: { roles: string[] } } }).tokenParsed =
  { realm_access: { roles: ['platform-admin'] } };

/**
 * E2E-Bühne „Fühler anlegen" (Steuerlogik-Konzept Stufe 1, vp-logik-s1-fuehler): der echte Aufbau einer
 * fiktiven Anlage, nur mit ihrer Box und dem Netzanschluss - genug, um „Komponente anlegen (technisch)"
 * zu öffnen. `?stand=vorher` liefert den Gerätetyp-Katalog OHNE „Fühler" (der Stand vor diesem Auftrag),
 * `?stand=nachher` (Standard) MIT ihm - für die Vorher/Nachher-Bilder im PR, nie eine echte Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const nachher = frage.get('stand') !== 'vorher';
const jetzt = Date.now();
const site = gsAnlage;
const box = gsBox(jetzt);

const netz: SiteEntity = {
  id: 'e-netz', entityType: 'grid-meter', typeLabel: 'Netzanschlusszähler', label: 'Netzanschluss',
  capabilities: { measure: [{ channel: 'power_kw', unit: 'kW', value: -1.2 }], actuate: [] },
  guards: null, syncStatus: 'in_sync', observed: null, edgeSourceId: 'src-netz',
} as unknown as SiteEntity;

const topology = {
  schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: ok({ registry: null, entities: [netz], localSetup: [], staleOnDevice: [] } as unknown as SiteEntities),
  topology: ok(topology),
  datenquellen: ok({ datenquellen: [] }),
  uemsGeraete: ok({ geraete: [] }),
  siteSources: ok([]),
  siteComponents: () => Promise.reject(new ApiError(404, 'Not Found')),
  siteComponentTemplates: ok([]),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok([]),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  listDevices: ok([box]),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  standorte: () => Promise.reject(new ApiError(404, 'Not Found')),
  overview: () => Promise.reject(new ApiError(503, 'Unavailable')),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]), status: ok([]) });
Object.assign(entitiesApi, {
  typeCatalog: ok({
    catalog_version: nachher ? '1.0.1' : '1.0.0',
    types: [
      { type: 'wallbox', label: 'Wallbox', category: 'consumer', controllable: true, composed: false, default_failsafe: 'release' },
      { type: 'grid-meter', label: 'Netzanschlusszähler', category: 'meter', controllable: false, composed: true, default_failsafe: 'measure-only' },
      { type: 'modbus-generic', label: 'Modbus-Gerät (generisch)', category: 'meter', controllable: false, composed: false, default_failsafe: 'measure-only' },
      ...(nachher
        ? [{ type: 'fuehler', label: 'Fühler', category: 'meter', controllable: false, composed: false, default_failsafe: 'measure-only' }]
        : []),
    ],
  }),
});

if (!window.location.hash) window.location.hash = `#/anlage/${site.id}/modell`;

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
