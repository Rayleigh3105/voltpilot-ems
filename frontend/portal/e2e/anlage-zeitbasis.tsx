import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { entitiesApi } from '../src/entitiesApi';
import { AufbauSection } from '../src/pages/AufbauSection';
import { sichtbareListe } from '../src/test/rollenFixtures';
import {
  ZB_SITE_ID,
  ZB_SITE_NAME,
  zbBox,
  zbEntities,
  zbLocalSetup,
  zbOverviewSite,
  zbScreenshot,
  zbSources,
  zbTopology,
  type ZeitbasisStand,
} from '../src/test/zeitbasisFixtures';
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
 * E2E-Bühne „Zeitbasis der Anlage": der echte Aufbau über der fiktiven Anlage Werkhof Linde
 * (`src/test/zeitbasisFixtures.ts`). Die Übersicht meldet absichtlich einen ANDEREN Moment als Topologie und
 * `/sources` (der jüngste Rohwert bei springender Hallenlast) - der Kopf darf ihn nicht zeigen, solange es Zeilen gibt.
 *
 * Die Spec stellt die Phase (`window.__phase`; StrictMode lädt beim Öffnen doppelt, darum nie an der Abrufzahl):
 * 1 = Fall vom Screenshot (Netz −0,6 kW, Übersicht „Bezug 5,4"); 2 = die nächste Lesung (Netz +1,2 kW, Übersicht
 * „Einspeisung 4,0"); 3 = dieselben Werte, die Box liest aber nicht mehr neu (`readAt` bleibt bei der ersten Antwort
 * in Phase 2 stehen). Die Zahl der Abrufe je Route liegt für die Spec in `window.__abrufe`.
 */
const jetzt = Date.now();
const site: Site = {
  id: ZB_SITE_ID, name: ZB_SITE_NAME, biddingZone: 'DE-LU', latitude: null, longitude: null, plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
};
const box = zbBox(jetzt);

const abrufe: Record<string, number> = {};
const fenster = window as unknown as { __abrufe: Record<string, number>; __phase: number };
fenster.__abrufe = abrufe;
fenster.__phase = 1;
let zweiteLesung: number | null = null;
function stand(): ZeitbasisStand {
  const t = Date.now();
  if (fenster.__phase <= 1) return zbScreenshot(t);
  if (zweiteLesung == null || fenster.__phase === 2) zweiteLesung = t - 5_000;
  return { netzKw: 1.2, pvKw: [2.5, 2.6, 2.6], uvKw: 8.6, uebersicht: { pvKw: 7.0, gridKw: -4.0 }, gelesenAm: zweiteLesung, uebersichtAm: t - 3_000 };
}
const gezaehlt = <T,>(name: string, aus: (s: ZeitbasisStand) => T) => () => {
  abrufe[name] = (abrufe[name] ?? 0) + 1;
  return Promise.resolve(aus(stand()));
};
const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteEntities: ok({ registry: null, entities: zbEntities, localSetup: zbLocalSetup, staleOnDevice: [] }),
  topology: gezaehlt('topology', zbTopology),
  siteSources: gezaehlt('siteSources', zbSources),
  overview: gezaehlt('overview', (s) => ({ sites: [zbOverviewSite(s)], totals: null, dailySavings: [], teilansicht: null })),
  datenquellen: ok({ datenquellen: [] }),
  uemsGeraete: ok({ geraete: [] }),
  siteComponents: ok({ componentAuthority: 'portal', components: [] }),
  siteComponentTemplates: ok([]),
  componentTemplates: ok([]),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  listDevices: ok(sichtbareListe([box])),
  edgeVersions: ok(sichtbareListe([])),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]), status: ok([]) });
Object.assign(entitiesApi, { typeCatalog: ok({ types: [] }) });

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
