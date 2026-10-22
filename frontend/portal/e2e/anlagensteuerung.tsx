import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type Device, type Site, type SiteEntity } from '../src/api';
import { keycloak } from '../src/auth';
import { consumersApi } from '../src/consumers/consumersApi';
import { anlagensteuerungGeraetId } from '../src/geraetAdresse';
import { GeraetSeiteSection } from '../src/pages/GeraetSeiteSection';
import { TechnikSection } from '../src/pages/AnlageTechnik';
import { AnlagensteuerungKarten } from '../src/steuerung/AnlagensteuerungKarte';
import { VerlaufExplorer } from '../src/components/VerlaufExplorer';
import {
  buettner,
  buettnerNv,
  buettnerWerte,
  ENTITY_BUETTNER,
  ENTITY_GORE,
  gore,
  goreGeraet,
  goreNv,
  goreVerlauf,
  goreWerte,
  JETZT,
} from '../src/test/anlagensteuerungFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/steuerung/steuerung.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne UEMS EZ-10 „Steuerung, Anlage, Messwerte“: die vier Flächen einer Erzeugeranlage mit
 * Anlagensteuerung, belegt mit den fiktiven Anlagen Gore (PV) und Büttner (BHKW) aus
 * `src/test/anlagensteuerungFixtures.ts`. `?fall=gore|buettner`, `&flaeche=steuerung|geraet|einstellungen|verlauf`.
 * Belegt ist, was die Flächen fragen; alles Übrige antwortet „nichts da“ - die Bühne ruft nie eine Cloud.
 */
const frage = new URLSearchParams(window.location.search);
const fall = frage.get('fall') === 'buettner' ? 'buettner' : 'gore';
const flaeche = frage.get('flaeche') ?? 'steuerung';

const F = fall === 'gore'
  ? { s: gore(), w: goreWerte(), nv: goreNv(), entity: ENTITY_GORE, name: 'Gore' }
  : { s: buettner(), w: buettnerWerte(), nv: buettnerNv(), entity: ENTITY_BUETTNER, name: 'Büttner/Engelhard' };
// Die Werte altern nicht: die Bühne stellt ihre Lesungen auf „jetzt“.
const jetzt = Date.now();
const versatz = jetzt - Date.parse(JETZT);
const werte = {
  ...F.w,
  werte: F.w.werte.map((x) => ({ ...x, gemessen_am: x.gemessen_am ? new Date(Date.parse(x.gemessen_am) + versatz).toISOString() : null })),
};

const site = {
  id: `site-${fall}`,
  name: F.name,
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
} as unknown as Site;

const box: Device = {
  id: `box-${fall}`,
  siteId: site.id,
  externalRef: `edge-${fall}`,
  kind: 'inverter',
  name: `Box ${F.name}`,
  status: 'active',
  lastSeenAt: new Date(jetzt).toISOString(),
  createdAt: null,
};

const steuerungEntity = {
  id: F.entity,
  entityType: 'anlagensteuerung',
  typeLabel: 'Anlagensteuerung',
  role: null,
  label: F.s.bezeichnung ?? 'Anlagensteuerung',
  control: false,
  deviceId: null,
  capabilities: { measure: [] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
} as unknown as SiteEntity;

const geraet = fall === 'gore'
  ? goreGeraet()
  : {
      ...goreGeraet(),
      id: F.s.geraet_id,
      kennzeichen: F.s.kennzeichen,
      einbau_kennzeichen: F.s.einbau_kennzeichen,
      bezeichnung: F.s.bezeichnung,
      typ: F.s.typ,
      komponenten: [{ entity_id: F.entity, gueltig_ab: F.s.eingebaut_am, gueltig_bis: null }],
      teile: F.s.einheiten.map((e) => ({
        id: e.teil_id, teilart: 'erzeugungseinheit', steckplatz: null, bezeichnung: e.bezeichnung, typ: e.typ,
        seriennummer: null, eingebaut_am: e.eingebaut_am, ausgebaut_am: null, te_nr: e.te_nr, einheit_art: e.einheit_art,
        nennleistung_kw: e.nennleistung_kw, registry_unit_id: e.registry_unit_id, typ_bild: e.typ_bild,
      })),
    };

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
let nv = F.nv;
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  anlagensteuerungen: ok({ einrichtung: { moeglich: true, grund: null, boxen: [] }, steuerungen: [F.s] }),
  anlagensteuerungWerte: ok(werte),
  anlagensteuerungVerlauf: ok(goreVerlauf()),
  netzVermarktung: (async () => structuredClone(nv)) as never,
  netzVermarktungAendern: (async (_s: string, b: Record<string, unknown>) =>
    structuredClone((nv = { ...nv, ...b, revision: nv.revision + 1 } as typeof nv))) as never,
  erzeugungseinheitAendern: (async (_g: string, n: number, b: Record<string, unknown>) =>
    ({ ...F.s.einheiten.find((e) => e.te_nr === n), ...b })) as never,
  siteEntities: ok({ registry: null, entities: [steuerungEntity], localSetup: [], staleOnDevice: [] }),
  topology: ok({ schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
  siteSources: ok([]),
  siteComponents: ok({ componentAuthority: 'portal', components: [] }),
  controlStatus: ok(null),
  curtailmentStatus: ok(null),
  edgeVersions: ok(sichtbareListe([])),
  siteChargers: ok({ budget: null, chargers: [] }),
  entityStrategies: ok({}),
  siteInterventions: ok({ automationPaused: false, pausedUntil: null, interventions: [] }),
  schedule: ok({ slots: [], generatedAt: null }),
  registerWriteTargets: ok([]),
  registerWriteHistory: ok([]),
  registerKnowledge: ok([]),
  uemsGeraete: ok({ geraete: [geraet] }),
  komponenteMesskanaele: ok({ messkanaele: [] }),
  geraetEinstellungen: ok({ gueltig: [], historie: [] }),
  geraetAenderungen: ok({ eintraege: [], achse: 'wirkung', von: null, bis: null, weiter: null }),
  entityHistory: ok({ range: 'day', from: '', to: '', bucketMinutes: 15, channels: {} }),
  siteAssets: ok([]),
  history: ok({ range: 'day', from: '', to: '', bucketMinutes: 15, buckets: [] }),
  // Wie der Server: `as-…` ist ihm kein Gerät (`DeviceScopes`), die Seite fragt über die Komponente.
  commandHistory: (async (_s: string, q: { device?: string | null }) => {
    if (q.device?.startsWith('as-')) throw new ApiError(404, 'Gerät nicht gefunden.');
    return {
      recordingSince: null, accuracySeconds: 60, from: new Date(jetzt - 86_400_000).toISOString(), to: new Date(jetzt).toISOString(),
      entityId: F.entity, entityLabel: F.s.bezeichnung, writes: false, truncated: false, total: 0, entries: [],
    };
  }) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}
Object.assign(consumersApi, { list: ok([]), overrides: ok([]), status: ok([]) });

function Flaeche() {
  if (flaeche === 'geraet') {
    return <GeraetSeiteSection site={site} boxRef={box.externalRef} geraetId={anlagensteuerungGeraetId(F.entity)} devices={[box]} />;
  }
  if (flaeche === 'einstellungen') {
    return <TechnikSection site={site} devices={[box]} sites={[site]} onReload={() => {}} onSiteSaved={() => {}} onSiteDeleted={() => {}} />;
  }
  if (flaeche === 'verlauf') {
    return (
      <VerlaufExplorer
        site={site}
        range="day"
        anchor={new Date()}
        initialTargets={[{ entityId: `erzeuger-${F.s.geraet_id}`, channel: 'erzeuger.te[1].t_p_ist_w' }]}
      />
    );
  }
  return (
    <div className="stn">
      <div className="stn-main">
        <AnlagensteuerungKarten siteId={site.id} />
      </div>
    </div>
  );
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
