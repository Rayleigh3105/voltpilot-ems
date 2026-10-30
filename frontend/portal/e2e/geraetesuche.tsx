import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type SiteEntity, type SiteTopology } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { entitiesApi } from '../src/entitiesApi';
import { aufbauHash } from '../src/nav';
import { AufbauSection } from '../src/pages/AufbauSection';
import { BoxSeiteSection } from '../src/pages/BoxSeiteSection';
import {
  GS_BOX_ID,
  GS_SUCH_ID,
  GS_TEMPLATES,
  geraetesucheFaelle,
  gsAnlage,
  gsBox,
  gsVerlauf,
  gsWallboxZeile,
  type GeraetesucheFall,
} from '../src/test/geraetesucheFixtures';
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
 * E2E-Bühne „Geräte suchen“ (Konzept vp-portal-geraetesuche-konzept, Paket 4 Portal): der echte Aufbau und die echte
 * Box-Seite über der fiktiven Anlage Hof Seewiesen (`src/test/geraetesucheFixtures.ts`). Die Routen der Gerätesuche
 * antworten aus den Fällen der Fixture; die Bühne ruft nie eine Cloud.
 *
 * `?flaeche=aufbau|box` (Standard aufbau: öffnet `?neu=suche&box=…`), `&fall=` einer der Fälle (`laeuft`, `fertig`,
 * `breit`, `hinweis`, `nichts`, `abgebrochen`, `keineAntwort`, `abgelehnt`, `fehlgeschlagen`, `fremd`, `ablauf` = läuft,
 * dann fertig) oder eine Ablehnung beim Start (`offline`, `update`, `zuoft`, `laeuftschon`); `&ansicht=verlauf`;
 * `&geraete=0` = die Box ohne Geräte (m1); `&box=offline|update|laeuft` stellt die Lage des Knopfs auf der Box-Seite.
 */
const frage = new URLSearchParams(window.location.search);
const flaeche = frage.get('flaeche') ?? 'aufbau';
const fall = frage.get('fall') ?? 'fertig';
const ohneGeraete = frage.get('geraete') === '0';
const boxLage = frage.get('box');
const jetzt = Date.now();
const F = geraetesucheFaelle(jetzt);
const site = gsAnlage;
const box = gsBox(jetzt, boxLage === 'offline' ? { lastSeenAt: new Date(jetzt - 47 * 60_000).toISOString() } : {});

const wechselrichter = {
  id: 'e-wr', entityType: 'battery-hybrid', typeLabel: 'Wechselrichter', role: 'inverter', label: 'Wechselrichter',
  control: false, deviceId: GS_BOX_ID, capabilities: { measure: [] }, guards: null, syncStatus: 'in_sync', observed: null,
  edgeSourceId: 'src-solarman-3115580613', brand: 'deye', model: 'sun-30k-sg01hp3',
} as unknown as SiteEntity;
const topology = {
  schemaVersion: '1.0',
  entities: ohneGeraete ? [] : [{ id: 'e-wr', entityType: 'battery-hybrid', typeLabel: 'Wechselrichter', label: 'Wechselrichter',
    category: 'battery', health: 'ok', capabilities: [] }],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const nein = (status: number, body: Record<string, unknown>) => () =>
  Promise.reject(new ApiError(status, String(body.message ?? 'abgelehnt'), {
    suchId: null, zuletztGesehen: null, wiederAb: null, message: '', ...body,
  }));
const suche = (F as Record<string, unknown>)[fall === 'ablauf' ? 'laeuft' : fall] as (typeof F)[GeraetesucheFall] | undefined;
let abfragen = 0;
const starten = fall === 'offline'
  ? nein(409, { code: 'box_offline', message: 'Box offline', zuletztGesehen: new Date(jetzt - 47 * 60_000).toISOString() })
  : fall === 'update'
    ? nein(409, { code: 'nicht_unterstuetzt', message: 'Update nötig' })
    : fall === 'zuoft'
      ? nein(429, { code: 'zu_oft', message: 'zu oft', wiederAb: new Date(jetzt + 9 * 60_000).toISOString() })
      : fall === 'laeuftschon'
        ? nein(409, { code: 'laeuft_schon', message: 'läuft schon', suchId: GS_SUCH_ID })
        : ok(suche ?? F.fertig);
const lesen = async () => {
  abfragen += 1;
  if (fall === 'ablauf') return structuredClone(abfragen >= 2 ? F.fertig : F.laeuft);
  if (fall === 'laeuftschon') return structuredClone(F.fremd);
  return structuredClone(suche ?? F.fertig);
};
const verlauf = gsVerlauf(jetzt).map((e, i) =>
  boxLage === 'laeuft' && i === 0 ? { ...e, zustand: 'laeuft' as const, gestartetAm: new Date(jetzt - 12_000).toISOString(), gestartetVon: F.fremd.gestartetVon, dauerMs: null } : e);

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: ok({ registry: null, entities: ohneGeraete ? [] : [wechselrichter], localSetup: [], staleOnDevice: [] }),
  topology: ok(topology),
  datenquellen: ok({ datenquellen: [] }),
  uemsGeraete: ok({ geraete: [] }),
  siteSources: ok([]),
  siteComponents: ok({ componentAuthority: 'portal', components: [gsWallboxZeile] }),
  siteComponentTemplates: ok([]),
  componentTemplates: ok(GS_TEMPLATES),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok(sichtbareListe([{
    deviceId: GS_BOX_ID, siteId: site.id, coreVersion: 'edge-2026.11.0', paletteVersion: null,
    reportedAt: new Date(jetzt - 20_000).toISOString(),
    capabilities: boxLage === 'update' ? ['data_sources'] : ['data_sources', 'geraetesuche'],
  }])),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  listDevices: ok(sichtbareListe([box])),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  geraetesucheStarten: starten as never,
  geraetesuche: lesen as never,
  geraetesucheAbbrechen: ok(F.abgebrochen),
  geraetesucheVerlauf: ok({ suchen: verlauf }),
  testComponentConnection: ok({ results: [{ ok: true, reading: { value: 3.2, unit: 'kW' } }] }),
  matchComponent: ok(undefined),
  createComponent: ok({ componentAuthority: 'portal', components: [gsWallboxZeile] }),
  updateComponent: ok({ componentAuthority: 'portal', components: [gsWallboxZeile] }),
  admitChargePoint: ok({}),
  commandHistory: ok({
    recordingSince: null, accuracySeconds: 60, from: new Date(jetzt - 86_400_000).toISOString(), to: new Date(jetzt).toISOString(),
    entityId: null, entityLabel: null, writes: false, truncated: false, total: 0, entries: [],
  }),
  registerWriteTargets: ok([]),
  registerWriteHistory: ok([]),
  registerKnowledge: ok([]),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]), status: ok([]) });
Object.assign(entitiesApi, { typeCatalog: ok({ types: [] }) });

if (flaeche === 'aufbau' && !window.location.hash) {
  window.location.hash = frage.get('neu') === '0'
    ? `#/anlage/${site.id}/modell`
    : aufbauHash(site.id, 'suche', { box: GS_BOX_ID, verlauf: frage.get('ansicht') === 'verlauf' });
}

function Flaeche() {
  if (flaeche === 'box') {
    return <BoxSeiteSection site={site} boxRef={box.externalRef} devices={[box]} devicesFetchedAt={jetzt} />;
  }
  return <AufbauSection site={site} sites={[site]} devices={[box]} devicesFetchedAt={jetzt} />;
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
