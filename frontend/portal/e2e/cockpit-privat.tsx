/**
 * Bühne „Cockpit für private Haushalte“ (Konzept `vp-cockpit-privat-konzept`, Entscheide E1–E4 = A): das
 * echte Portal mit einem privaten Haushalt auf gestellten Antworten - keine API, kein Keycloak.
 * `?lage=abend|mittag|speicher` (siehe `cockpit-privat-daten.ts`, Anlagen `muehlbach` bzw. `birkenweg`),
 * `?lage=gewerbe` (die Hilfe-Anlage `help-site` mit Lastspitzenkappung). Uhr fest: abends 18:47 UTC,
 * mittags 11:30 UTC (07.11.2026), Gewerbe 10:00 UTC (10.09.2026).
 */
import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api } from '../src/api';
import { entitiesApi } from '../src/entitiesApi';
import { consumersApi } from '../src/consumers/consumersApi';
import { installHelpFixtures } from './help-fixtures';
import { installAnlagenCheck } from './anlagen-check-fixtures';
import { lageDaten, type Lage } from './cockpit-privat-daten';
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
const lageParam = q.get('lage') ?? 'abend';

installHelpFixtures();
const result = (value: unknown) => async () => structuredClone(value);

if (lageParam === 'gewerbe') {
  // Die Hilfe-Anlage als Betrieb mit Lastspitzenkappung (Leistungspreis 80 €/kW).
  const profile = await api.siteProfiles('help-site');
  const nutzung = await api.usageProfile('help-site');
  const geld = await api.siteEarnings('help-site', 'day');
  Object.assign(api, {
    // Das laufende Viertelstunden-Mittel des Servers, passend zum Satz der Bühne (Netzbezug 0,0 kW):
    // ohne es zeigte die Lastspitzen-Kachel nur „—“ und „Aktueller Live-Wert liegt gerade nicht vor“.
    siteEarnings: result({ ...geld, peakShaving: geld.peakShaving ? { ...geld.peakShaving, currentQuarterMeanKw: 0 } : null }),
    // Leistungspreis + Lastspitzenkappung: das abgeleitete Nutzungsprofil ist `peak` (Vertrag usage-profile-vectors).
    usageProfile: result({ ...nutzung, usageProfile: 'peak', derivedProfile: 'peak', emphasis: { money: 'secondary', peak: 'prominent', flow: 'secondary', devices: 'secondary' } }),
    siteProfiles: result({
      ...profile,
      profiles: profile.profiles.map((p) => {
        const an = p.id === 'lastspitzenkappung';
        return { ...p, active: an, state: an ? 'an' : 'aus', derivedActive: an };
      }),
    }),
  });
} else {
  const d = lageDaten(lageParam as Lage);
  // `?profil=privat`: das Anwendungs-Preset ist gesetzt (Preset-Schicht: Leitung „energiefluss“).
  // `?stern=erloes-komposition`: der Kunde hat im „Cockpit anpassen“ den Stern auf „Unterm Strich“ gesetzt.
  const profilParam = q.get('profil');
  if (profilParam) Object.assign(d.site, { profil: profilParam });
  const stern = q.get('stern');
  const layoutAntwort = {
    surface: 'cockpit', profil: profilParam, presetLayout: null, tenantVorgabe: null, siteVorgabe: null,
    eigen: stern ? { document: { order: [], hidden: [], shown: [], lead: stern }, updatedBy: 'Familie Beispiel', updatedAt: d.now } : null,
    bausteine: [], darfVorgabe: false,
  };
  const box = { id: `${d.site.id}-box`, siteId: d.site.id, externalRef: `VP-${String(d.site.id).toUpperCase().slice(0, 4)}-0001`, kind: 'inverter', name: 'VoltPilot Box', status: 'active', lastSeenAt: d.now, createdAt: '2026-05-01T10:00:00Z' };
  const typen = ['producer', 'grid-meter', 'house-load', 'sub-meter', 'battery-hybrid'];
  Object.assign(api, {
    cockpitLayout: result(layoutAntwort),
    listSites: result(sichtbareListe([d.site])),
    listDevices: result(sichtbareListe([box])),
    tenantContext: result({ tenantId: 'help-tenant', name: 'Familie Beispiel', betriebsart: 'endkunde' }),
    overview: result(d.overview),
    earnings: result({ range: 'day', from: d.money.from, to: d.money.to, sites: [d.money], totals: d.money }),
    siteEarnings: result(d.money),
    history: result(d.history),
    schedule: result(d.plan),
    weather: result(d.weather),
    topology: result(d.topology),
    siteSources: result(d.sources),
    siteEntities: result({ registry: { revision: '1', composedAt: d.now, deviceId: box.id, reportedRevision: '1', reportedAt: d.now }, entities: d.entities, localSetup: [], staleOnDevice: [] }),
    siteAssets: result(d.lage === 'speicher' ? [{ id: 'bw-asset', type: 'battery', deviceId: box.id, capacityKwh: 10, maxChargeKw: 4.6, maxDischargeKw: 4.6, roundtripEfficiencyPct: 92, speicherschonung: 'ausgewogen', pvCapacityKwp: null, moduleCount: null, azimuthDeg: null, tiltDeg: null, commissionedOn: null, registry: null, registryUnitId: null, registryFetchedAt: null }] : []),
    usageProfile: result({ usageProfile: 'private', derivedProfile: 'private', override: null, emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' }, signals: d.usageSignals }),
    controlStatus: result(d.control),
    curtailmentStatus: result(null),
    siteChargers: async () => { throw new Error('Keine Ladepunkte an dieser Anlage'); },
    siteVerbraucher: result({ verbraucher: [], ladepunkte: null, rangliste: [] }),
    siteProfiles: result({ profiles: [], weitere: [] }),
    telemetry: result([]),
    einspeiseverguetung: result({ zustand: 'eeg', wirksamCtKwh: 7.9, angegebenCtKwh: null, inbetriebnahmeAbSolarspitzengesetz: null, hergeleitetCtKwh: 7.9, hergeleitetGenaehert: false, inbetriebnahme: '2021-04-01', leistungKwp: 19.8, eegEndeAm: '2041-12-31', ohneVerguetungBeiNegativpreis: false, anzulegenderWertCtKwh: null }),
    entityHistory: async (_site: string, entityId: string) => ({
      range: 'day', from: d.money.from, to: d.money.to, bucketMinutes: 15,
      channels: { power_kw: (d.serien[entityId] ?? []).map((p) => ({ start: p.start, avg: p.kw, min: p.kw, max: p.kw, last: p.kw, n: 15 })) },
    }),
    entityEnergy: async (_site: string, entityId: string) => {
      const map: Record<string, string> = { 'mb-uv-halle': 'halle', 'mb-uv-keller': 'keller', 'bw-wp': 'wp' };
      const k = map[entityId];
      return { range: 'day', from: d.money.from, to: d.money.to, bucketMinutes: 15, source: 'zaehler', buckets: [], totalKwh: k ? d.geraeteHeute[k] : null, counterFalls: false };
    },
  });
  Object.assign(entitiesApi, {
    typeCatalog: result({ catalog_version: '1.0', types: typen.map((t) => ({ type: t, label: t, category: 'consumer', controllable: t === 'battery-hybrid', composed: false, default_failsafe: 'release' })) }),
  });
  Object.assign(consumersApi, { options: result({ types: [], signals: [], intents: [], hasStorage: d.lage === 'speicher', reportedSources: [] }), list: result([]), status: result([]), overrides: result([]), fulfillment: result([]) });
}

// Anlagen-Check (`?solar=…`, `?bilanz=…`, `?einheiten=wr`): nur wenn die Adresse einen Fall nennt.
installAnlagenCheck();

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
