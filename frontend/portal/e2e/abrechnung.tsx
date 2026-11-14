/**
 * Bühne „Abrechnung prüfen“ (Bedienkonzept `vp-privatkunde-bedienkonzept` §7, Variante A): das echte Portal auf
 * gestellten Antworten — keine API, kein Keycloak. Die zwei Haushalte der Cockpit-Bühne (`cockpit-privat-daten.ts`)
 * mit Tageswerten über mehr als ein Jahr (`abrechnung-daten.ts`).
 *
 * `?anlage=birkenweg|muehlbach` (Vorgabe birkenweg), `?fall=zaehler|summe|nurbezug` (Vorgabe zaehler). Die Zahlen
 * „laut Rechnung“ liegen im `sessionStorage` des Tabs — wie auf dem Server überleben sie ein Neuladen. Die Uhr
 * stellt die Spec (`abrechnung.spec.ts`): Sa., 14.11.2026, 11:00 Uhr Berlin.
 */
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api, type AbrechnungPruefung, type HistoryRange } from '../src/api';
import { entitiesApi } from '../src/entitiesApi';
import { consumersApi } from '../src/consumers/consumersApi';
import { installHelpFixtures } from './help-fixtures';
import { lageDaten } from './cockpit-privat-daten';
import { abrechnungFuer, historyFuer, historyZeitraum, JETZT_ISO, type Anlage, type Fall } from './abrechnung-daten';
import { sichtbareListe } from '../src/test/rollenFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const q = new URLSearchParams(location.search);
const anlage: Anlage = q.get('anlage') === 'muehlbach' ? 'muehlbach' : 'birkenweg';
const fallParam = q.get('fall');
const fall: Fall = fallParam === 'summe' || fallParam === 'nurbezug' ? fallParam : 'zaehler';

installHelpFixtures();
const result = (value: unknown) => async () => structuredClone(value);
const d = lageDaten(anlage === 'birkenweg' ? 'speicher' : 'abend');
if (anlage === 'birkenweg') Object.assign(d.site, { profil: 'privat' });

const SPEICHER = `vp-abrechnung-${anlage}-${fall}`;
function pruefungen(): AbrechnungPruefung[] {
  try {
    return JSON.parse(sessionStorage.getItem(SPEICHER) ?? '[]') as AbrechnungPruefung[];
  } catch {
    return [];
  }
}
function merke(liste: AbrechnungPruefung[]) {
  try {
    sessionStorage.setItem(SPEICHER, JSON.stringify(liste));
  } catch {
    // ohne Speicher bleibt die Eingabe nur bis zum Neuladen
  }
}

const box = { id: `${d.site.id}-box`, siteId: d.site.id, externalRef: `VP-${String(d.site.id).toUpperCase().slice(0, 4)}-0001`, kind: 'inverter', name: 'VoltPilot Box', status: 'active', lastSeenAt: JETZT_ISO, createdAt: '2025-03-01T10:00:00Z' };
const typen = ['producer', 'grid-meter', 'house-load', 'sub-meter', 'battery-hybrid'];
Object.assign(api, {
  cockpitLayout: result({ surface: 'cockpit', profil: 'privat', presetLayout: null, tenantVorgabe: null, siteVorgabe: null, eigen: null, bausteine: [], darfVorgabe: false }),
  listSites: result(sichtbareListe([d.site])),
  listDevices: result(sichtbareListe([box])),
  tenantContext: result({ tenantId: 'help-tenant', name: 'Familie Beispiel', betriebsart: 'endkunde' }),
  overview: result(d.overview),
  earnings: result({ range: 'day', from: d.money.from, to: d.money.to, sites: [d.money], totals: d.money }),
  siteEarnings: result(d.money),
  history: async (_site: string, range: HistoryRange, at: string) => historyFuer(anlage, fall, range, at),
  historyZeitraum: async (_site: string, von: string, bis: string) => historyZeitraum(anlage, fall, von, bis),
  abrechnung: async (_site: string, von: string, bis: string) => ({
    ...abrechnungFuer(anlage, fall, von, bis),
    rechnung: pruefungen().find((p) => p.von === von && p.bis === bis) ?? null,
  }),
  abrechnungPruefungen: async () => [...pruefungen()].sort((a, b) => b.bis.localeCompare(a.bis) || b.von.localeCompare(a.von)),
  abrechnungPruefungSpeichern: async (
    _site: string,
    von: string,
    bis: string,
    werte: { bezugKwh: number | null; einspeisungKwh: number | null },
  ) => {
    const rest = pruefungen().filter((p) => p.von !== von || p.bis !== bis);
    if (werte.bezugKwh == null && werte.einspeisungKwh == null) {
      merke(rest);
      return undefined;
    }
    const p: AbrechnungPruefung = { von, bis, ...werte, geaendertAm: JETZT_ISO };
    merke([...rest, p]);
    return p;
  },
  schedule: result(d.plan),
  weather: result(d.weather),
  topology: result(d.topology),
  siteSources: result(d.sources),
  siteEntities: result({ registry: { revision: '1', composedAt: JETZT_ISO, deviceId: box.id, reportedRevision: '1', reportedAt: JETZT_ISO }, entities: d.entities, localSetup: [], staleOnDevice: [] }),
  siteAssets: result([]),
  usageProfile: result({ usageProfile: 'private', derivedProfile: 'private', override: null, emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' }, signals: d.usageSignals }),
  controlStatus: result(d.control),
  curtailmentStatus: result(null),
  siteChargers: async () => {
    throw new Error('Keine Ladepunkte an dieser Anlage');
  },
  siteVerbraucher: result({ verbraucher: [], ladepunkte: null, rangliste: [] }),
  siteProfiles: result({ profiles: [], weitere: [] }),
  telemetry: result([]),
  entityEnergy: async () => ({ range: 'month', from: d.money.from, to: d.money.to, bucketMinutes: 1440, source: 'zaehler', buckets: [], totalKwh: null, counterFalls: false }),
});
Object.assign(entitiesApi, {
  typeCatalog: result({ catalog_version: '1.0', types: typen.map((t) => ({ type: t, label: t, category: 'consumer', controllable: t === 'battery-hybrid', composed: false, default_failsafe: 'release' })) }),
});
Object.assign(consumersApi, { options: result({ types: [], signals: [], intents: [], hasStorage: anlage === 'birkenweg', reportedSources: [] }), list: result([]), status: result([]), overrides: result([]), fulfillment: result([]) });

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
