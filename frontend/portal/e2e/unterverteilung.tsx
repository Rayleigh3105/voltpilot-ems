/**
 * Prüfbühne für Unterverteilungen (Konzept `vp-unterzaehler-anzeige`, Stufe 1): die ganze App mit
 * den fiktiven Hilfe-Fixtures („Sonnenhof“), dazu zwei Shelly-Unterzähler „UV Halle“ und „UV Keller“
 * und ein Hausverbrauch. Die kW-Werte sind die Größenordnung eines echten Falls (Haus 11,18 kW,
 * UV Halle 11,25 kW, UV Keller 0,07 kW, Rest in der Toleranz), Namen und Anlage sind fiktiv.
 *
 * Aufruf: `/e2e/unterverteilung.html#/anlage/help-site` (Cockpit), `…/messwerte` (Verlauf › Energie).
 * `?profil=gewerbe` setzt das Anwendungsprofil; `?vorher=1` zeigt die Unterzähler, wie sie bis
 * 07.11.2026 entstanden (`generic-load` „Steuerbare Last“, nur `power_kw`, keine Energie-Route).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api } from '../src/api';
import type { EntityEnergy, History, HistoryRange } from '../src/api';
import { derive } from '../src/topology';
import { installHelpFixtures } from './help-fixtures';
import { historyFor, TODAY } from './verlauf-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installHelpFixtures();

const q = new URLSearchParams(location.search);
const vorher = q.get('vorher') === '1';
const profil = q.get('profil') === 'gewerbe' ? 'gewerbe' : 'privat';
const NOW = new Date().toISOString();

const typ = vorher ? 'generic-load' : 'sub-meter';
const typLabel = vorher ? 'Steuerbare Last' : 'Unterzähler';
const kanaele = (kw: number, l: [number, number, number], bezug: number, rueck: number) =>
  vorher
    ? [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: false, value: kw }]
    : [
      { channel: 'power_kw', unit: 'kW', role: 'consumer', primary: false, value: kw },
      { channel: 'energy_kwh', unit: 'kWh', role: '', primary: false, value: bezug },
      { channel: 'energy_export_kwh', unit: 'kWh', role: '', primary: false, value: rueck },
      { channel: 'power_l1_kw', unit: 'kW', role: '', primary: false, value: l[0] },
      { channel: 'power_l2_kw', unit: 'kW', role: '', primary: false, value: l[1] },
      { channel: 'power_l3_kw', unit: 'kW', role: '', primary: false, value: l[2] },
    ];
const zusatz = [
  { id: 'uv-haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', label: 'Hausverbrauch', category: 'consumer',
    capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: true, value: 11.18 }] },
  { id: 'uv-halle', entityType: typ, typeLabel: typLabel, label: 'UV Halle', category: 'consumer',
    capabilities: kanaele(11.252, [3.89, 3.82, 3.54], 70802.308, 1.069) },
  { id: 'uv-keller', entityType: typ, typeLabel: typLabel, label: 'UV Keller', category: 'consumer',
    capabilities: kanaele(0.072, [0.057, 0.015, 0], 7647.388, 6.8) },
];

const topologyOrig = api.topology;
const siteEntitiesOrig = api.siteEntities;
const listSitesOrig = api.listSites;

/** Der Hausverbrauch je Eimer, aufgeteilt: UV Halle ~ 93 %, UV Keller ~ 3 %, der Rest im Haus. */
function energieFuer(entityId: string, range: HistoryRange, at: string): EntityEnergy {
  const h: History = historyFor(range, at || TODAY);
  const anteil = entityId === 'uv-halle' ? 0.93 : 0.03;
  const buckets = h.buckets
    .filter((b) => b.loadKwh != null)
    .map((b) => ({ start: b.start, kwh: (b.loadKwh as number) * anteil }));
  return {
    range, from: h.from, to: h.to, bucketMinutes: h.bucketMinutes, source: 'zaehler', buckets,
    totalKwh: buckets.length ? buckets.reduce((s, b) => s + (b.kwh ?? 0), 0) : null, counterFalls: false,
  };
}

Object.assign(api, {
  listSites: async () => {
    const l = await listSitesOrig();
    return { ...l, eintraege: l.eintraege.map((s) => (s.id === 'help-site' ? { ...s, profil } : s)) };
  },
  topology: async (siteId: string) => {
    const t = await topologyOrig(siteId);
    if (siteId !== 'help-site') return t;
    // Die Hilfe-Anlage führt ihren Hausverbrauch als `load_kw` des Speichers; hier misst ihn das Haus selbst.
    const basis = t.entities.map((e) => ({ ...e, capabilities: e.capabilities.filter((c) => c.role !== 'consumer') }));
    const entities = [...basis, ...zusatz.map((e) => ({ ...e, health: 'ok' }))];
    return {
      ...t,
      entities,
      topology: derive({ entities: entities.map((e) => ({ ...e, type: e.entityType, label: e.label ?? '', capabilities: e.capabilities.map((c) => ({ ...c, role: c.role ?? '' })) })) }),
    };
  },
  siteEntities: async (siteId: string) => {
    const d = await siteEntitiesOrig(siteId);
    if (siteId !== 'help-site') return d;
    const base = d.entities[1];
    const shelly = (id: string, label: string, entityId: string, host: string) => ({
      id, kind: 'source', role: 'consumer', brand: 'shelly', model: 'shelly-pro-3em', family: 'shelly_em_triphase', label,
      reportedAt: NOW, adoptedEntityId: entityId, communication: 'shelly_em_http', host, port: 80,
    });
    return {
      ...d,
      localSetup: [...d.localSetup, shelly('src-uv-halle', 'UV Halle', 'uv-halle', '192.0.2.111'),
        shelly('src-uv-keller', 'UV Keller', 'uv-keller', '192.0.2.121')],
      entities: [
        ...d.entities,
        ...zusatz.map((z) => ({
          ...base, id: z.id, entityType: z.entityType, typeLabel: z.typeLabel, role: z.entityType === 'house-load' ? 'house-load' : 'consumer',
          label: z.entityType === 'house-load' ? null : z.label, control: false,
          capabilities: { measure: z.capabilities.map(({ channel, unit }) => ({ channel, unit })) },
          guards: { limits: {}, failsafe: { behavior: 'measure-only' } },
          observed: { health: 'ok', lastTelemetryAt: NOW, reportedAt: NOW, channels: z.capabilities.map((c) => c.channel), appliedType: z.entityType },
          edgeSourceId: z.id === 'uv-halle' ? 'src-uv-halle' : z.id === 'uv-keller' ? 'src-uv-keller' : null,
        })),
      ],
    };
  },
  history: async (_siteId: string, range: HistoryRange, at: string) => historyFor(range, at || TODAY),
  // Die Box meldet die beiden Shelly-Zähler als Quellen; die Komponenten sind an sie gepinnt.
  siteSources: async () => [
    { deviceId: 'help-box', sourceId: 'src-uv-halle', kind: 'source', role: 'consumer', label: 'UV Halle', brand: 'shelly',
      model: 'shelly-pro-3em', pvKw: null, powerKw: null, loadKw: 11.252, health: 'ok', readAt: NOW, reportedAt: NOW },
    { deviceId: 'help-box', sourceId: 'src-uv-keller', kind: 'source', role: 'consumer', label: 'UV Keller', brand: 'shelly',
      model: 'shelly-pro-3em', pvKw: null, powerKw: null, loadKw: 0.072, health: 'ok', readAt: NOW, reportedAt: NOW },
  ],
  // Ein Haus ohne Ladepunkt - der Fall einer Anlage mit Unterverteilungen.
  siteChargers: async () => ({ siteId: 'help-site', chargers: [], budget: null }),
  entityEnergy: vorher
    ? async () => { throw new Error('404'); }
    : async (_siteId: string, entityId: string, range: HistoryRange, at?: string) => energieFuer(entityId, range, at ?? TODAY),
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
