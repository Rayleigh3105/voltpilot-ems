import { sichtbareListe } from '../src/test/rollenFixtures';
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type SiteEntities, type SiteEntity, type SiteTopology } from '../src/api';
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
  gsAktivitaet,
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
// Im echten Bundle steht dieses Blatt mit im Dokument: die Bühne muss es auch laden, sonst fängt sie Klassen-Kollisionen nicht.
import '../src/components/GemeinsameSteuerungKarte.css';

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
 * Die Box-Seite trägt in „Aktivität" die Suche und eine Übernahme aus ihr (d1, Folgepaket „Herkunft"); was Anlegen und
 * Bearbeiten an die API schicken, liegt für die Spec in `window.__gesendet`.
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

/**
 * `&heizstab=1`: der Live-Fall „Zuhause" (02.11.2026) - Netz und Haus über die Box zusammengesetzt, der Deye über
 * den Anlege-Weg angebunden (Vorlage, kein Pin; die Box meldet ihn als Wechselrichter), dazu ein eben angelegter
 * Heizstab am Shelly Pro 3 (Vorlage, Schreibfähigkeit, noch nicht von der Box als Quelle gemeldet). Der Aufbau
 * muss zwei Geräte zeigen: den Deye und den Heizstab als eigene Zeile.
 */
const heizstabFall = frage.get('heizstab') === '1' || frage.get('heizstab') === '2';
/**
 * `&heizstab=2`: derselbe Heizstab NACH der Erstbindung (Live-Fall „Zuhause", 05.11.2026): die Box meldet seine
 * Quelle `set:0,1,2`, die Komponente trägt den Pin, und der Pro 3 misst nicht - die Topologie kennt ihn mit
 * `never`. Der Aufbau darf ihn weder als „Neues Gerät gefunden" ein zweites Mal anbieten noch auf Daten warten lassen.
 */
const heizstabGebunden = frage.get('heizstab') === '2';
const STAB_PIN = 'src-7q7pdrwh';
const zuhause = (() => {
  const basis = { control: false, capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] }, guards: null, syncStatus: 'in_sync', observed: null, edgeSourceId: null };
  const netz = { ...basis, id: 'e-netz', entityType: 'grid-meter', typeLabel: 'Netzanschluss', role: 'grid-meter', label: null, deviceId: GS_BOX_ID, sourceKind: 'composed' };
  const haus = { ...basis, id: 'e-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', role: 'consumer', label: null, deviceId: GS_BOX_ID, sourceKind: 'composed' };
  const deye = { ...wechselrichter, label: 'SUN-29.9K-SG01HP3-EU', edgeSourceId: null, sourceKind: 'builtin', model: 'sun-29.9k-sg01hp3' };
  const heizstab = {
    id: 'e-hz', entityType: 'heating-rod', typeLabel: 'Heizstab', role: 'consumer', label: 'Heizstab', control: true, deviceId: null,
    capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }], actuate: [{ command: 'on_off' }, { command: 'setpoint_kw', min: 0, max: 6 }, { command: 'limit_kw', max: 6 }] },
    guards: { limits: { max_consumption_kw: 6 }, failsafe: { behavior: 'off' } }, syncStatus: heizstabGebunden ? 'in_sync' : 'pending', observed: null,
    edgeSourceId: heizstabGebunden ? STAB_PIN : null, sourceKind: 'builtin',
  };
  const stabQuelle = {
    id: STAB_PIN, kind: 'source', role: 'consumer', brand: 'shelly', model: 'shelly_http', label: 'Heizstab',
    reportedAt: new Date(jetzt - 20_000).toISOString(), adoptedEntityId: heizstabGebunden ? 'e-hz' : null,
  };
  const gemeldet = {
    id: 'inverter', kind: 'inverter', role: null, brand: 'deye', model: 'sun-29.9k-sg01hp3', label: 'SUN-29.9K-SG01HP3-EU',
    reportedAt: new Date(jetzt - 20_000).toISOString(), adoptedEntityId: null,
  };
  const zeile = {
    id: 'e-hz', role: 'consumer', entityType: 'heating-rod', label: 'Heizstab', brand: 'shelly', model: 'shelly_http', family: 'shelly_http',
    communication: 'shelly_http', connection: { ip: '192.168.178.43', port: 80, channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3], anschluss: 'stern_mit_n' },
    sourceKind: 'builtin', templateRef: 'builtin:shelly:shelly_http', templateVersion: 1, definitionVersion: 1,
    edgeSourceId: heizstabGebunden ? STAB_PIN : null, syncStatus: heizstabGebunden ? 'in_sync' : 'pending',
  };
  return {
    entities: [netz, haus, deye, heizstab] as unknown as SiteEntity[],
    localSetup: (heizstabGebunden ? [gemeldet, stabQuelle] : [gemeldet]) as unknown as SiteEntities['localSetup'],
    komponenten: [zeile],
  };
})();
const topology = {
  schemaVersion: '1.0',
  entities: ohneGeraete ? [] : [{ id: 'e-wr', entityType: 'battery-hybrid', typeLabel: 'Wechselrichter', label: 'Wechselrichter',
    category: 'battery', health: 'ok', capabilities: [] },
  ...(heizstabGebunden ? [{ id: 'e-hz', entityType: 'heating-rod', typeLabel: 'Heizstab', label: 'Heizstab', category: 'consumer',
    health: 'never', capabilities: [] }] : [])],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
/** Merkt sich den Rumpf (für die Spec: reist der Bezug auf die Suche mit?) und antwortet wie `ok`. */
const gesendet: Record<string, unknown> = {};
(window as unknown as { __gesendet: Record<string, unknown> }).__gesendet = gesendet;
const merke = <T,>(name: string, wert: T) => (...args: unknown[]) => {
  gesendet[name] = structuredClone(args[args.length - 1]);
  return Promise.resolve(structuredClone(wert));
};
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
  siteEntities: ok(heizstabFall
    ? { registry: null, entities: zuhause.entities, localSetup: zuhause.localSetup, staleOnDevice: [] }
    : { registry: null, entities: ohneGeraete ? [] : [wechselrichter], localSetup: [], staleOnDevice: [] }),
  topology: ok(topology),
  datenquellen: ok({ datenquellen: [] }),
  uemsGeraete: ok({ geraete: [] }),
  siteSources: ok([]),
  siteComponents: ok({ componentAuthority: 'portal', components: heizstabFall ? zuhause.komponenten : [gsWallboxZeile] }),
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
  // Heizstab V1: eine Ausgangsmenge antwortet wie der Pro 3 - je Ausgang relay_on_<kanal> und `ausgaenge`.
  testComponentConnection: ((_site: string, body: { connection: Record<string, unknown> }) => {
    gesendet.testComponentConnection = structuredClone(body);
    return Promise.resolve(Array.isArray(body.connection.channels)
      ? {
        results: [{
          ok: true,
          samples: [0, 1, 2].map((k) => ({ channel: `relay_on_${k}`, raw: 0, value: 0, count: 1 })),
          ausgaenge: [
            { kanal: 0, ein: false, nach_stromausfall: 'match_input' },
            { kanal: 1, ein: false, nach_stromausfall: 'restore_last' },
            { kanal: 2, ein: false, nach_stromausfall: 'off' },
          ],
        }],
      }
      : { results: [{ ok: true, reading: { value: 3.2, unit: 'kW' } }] });
  }) as never,
  nachStromausfallAus: ok({ results: [{ ok: true, ausgaenge: [0, 1, 2].map((k) => ({ kanal: k, nach_stromausfall: 'off' })) }] }),
  matchComponent: ok(undefined),
  createComponent: merke('createComponent', { componentAuthority: 'portal', components: [gsWallboxZeile] }),
  updateComponent: merke('updateComponent', { componentAuthority: 'portal', components: [gsWallboxZeile] }),
  admitChargePoint: ok({}),
  commandHistory: ok({
    recordingSince: null, accuracySeconds: 60, from: new Date(jetzt - 86_400_000).toISOString(), to: new Date(jetzt).toISOString(),
    entityId: null, entityLabel: null, writes: false, truncated: false, total: ohneGeraete ? 0 : 2,
    entries: ohneGeraete ? [] : gsAktivitaet(jetzt),
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
