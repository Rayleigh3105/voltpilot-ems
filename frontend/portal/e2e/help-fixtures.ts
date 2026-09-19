import { rechteSeed, sichtbareListe } from '../src/test/rollenFixtures';
/**
 * Fictional, frozen teaching data. Imported ONLY by /e2e/help.tsx.
 * No production API/auth fallback: the application bundle never imports this.
 */
import { api, type Funktionen, type StandorteAmStichtag, type Unternehmen } from '../src/api';
import { entitiesApi } from '../src/entitiesApi';
import { consumersApi } from '../src/consumers/consumersApi';
import { keycloak } from '../src/auth';
import { derive } from '../src/topology';

export const NOW = '2026-09-10T10:00:00.000Z';
const DAY = '2026-09-09T22:00:00.000Z';
const ts = (i: number) => new Date(new Date(DAY).getTime() + i * 900_000).toISOString();
export const site = {
  id: 'help-site', name: 'Sonnenhof', biddingZone: 'DE-LU', latitude: 48.137, longitude: 11.575,
  plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', tarifParamCtKwh: 4.5, anzulegenderWertCtKwh: null,
  netzladenErlaubt: true, maxFeedInKw: 10, bezugspreisCtKwh: 29, einspeiseverguetungCtKwh: 8,
  leistungspreisEurKw: 80, abrechnung: 'jahr', socMinPct: 10, socMaxPct: 95,
};
export const sites = [site, { ...site, id: 'help-site-2', name: 'Werkstatt am Bach' }];
export const devices = sites.map((s, i) => ({
  id: i ? 'help-box-2' : 'help-box', siteId: s.id, externalRef: i ? 'VP-DEMO-0002' : 'VP-DEMO-0001',
  kind: 'inverter', name: 'VoltPilot Box', status: 'active', lastSeenAt: NOW, createdAt: '2026-08-01T10:00:00Z',
}));

const measures = [
  { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: 6.2 },
  { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: true, value: 2.2 },
  { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 64 },
  { channel: 'load_kw', unit: 'kW', role: 'consumer', primary: true, value: 4 },
];
const definitions = [
  { id: 'help-battery', entityType: 'battery-hybrid', typeLabel: 'Hybridspeicher', role: 'storage', category: 'storage', label: 'Speicher Scheune', control: true, measures },
  { id: 'help-grid', entityType: 'grid-meter', typeLabel: 'Netzanschluss', role: 'grid', category: 'meter', label: 'Netzanschluss', control: false,
    measures: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: 0 }] },
];
export const entities = definitions.map((d) => ({
  ...d, deviceId: 'help-box', capabilities: { measure: d.measures.map(({ channel, unit }) => ({ channel, unit })),
    ...(d.control ? { actuate: [{ command: 'set_power', min: -10, max: 10 }] } : {}) },
  guards: { limits: { soc_min_pct: 10, soc_max_pct: 95 }, failsafe: { behavior: 'self-consumption' } },
  syncStatus: 'in_sync', observed: { health: 'ok', lastTelemetryAt: NOW, reportedAt: NOW,
    channels: d.measures.map((m) => m.channel), appliedType: d.entityType }, edgeSourceId: null,
}));
const localSetup = [{ id: 'inverter', kind: 'inverter', role: 'storage', brand: 'deye', model: 'SUN-12K-SG04LP3-EU',
  family: 'deye-sg04lp3', label: 'Speicher Scheune', reportedAt: NOW, adoptedEntityId: 'help-battery',
  communication: 'solarman_v5', host: '192.0.2.10', port: 8899, serial: '1234567890' }];
const topology = {
  schemaVersion: '1.0', entities: definitions.map((d) => ({ ...d, health: 'ok', capabilities: d.measures })),
  topology: derive({ entities: definitions.map((d) => ({ ...d, type: d.entityType, health: 'ok', capabilities: d.measures })) }),
};
const asset = { id: 'help-asset', type: 'battery', deviceId: 'help-box', capacityKwh: 20,
  maxChargeKw: 10, maxDischargeKw: 10, roundtripEfficiencyPct: 92, speicherschonung: 'ausgewogen',
  pvCapacityKwp: null, moduleCount: null, azimuthDeg: null, tiltDeg: null, commissionedOn: null, registry: null, registryUnitId: null, registryFetchedAt: null };

const slots = Array.from({ length: 96 }, (_, i) => {
  const hour = i / 4;
  const pvKw = Math.max(0, Math.sin((hour - 6) * Math.PI / 12)) * 8;
  const loadKw = 1.2 + (hour > 17 && hour < 22 ? 2.2 : 0.8);
  const batteryKw = hour >= 10 && hour < 15 ? 2.2 : hour >= 18 && hour < 22 ? -2.2 : 0;
  const priceEurMwh = 65 + 35 * Math.cos((hour - 19) * Math.PI / 12);
  return { start: ts(i), batteryKw, pvKw, loadKw, gridKw: loadKw + batteryKw - pvKw,
    socPct: Math.min(92, Math.max(24, 28 + (hour >= 10 ? Math.min(hour - 10, 5) * 12 : 0) - Math.max(0, hour - 18) * 10)),
    priceEurMwh, costEur: 0.08, baselineCostEur: 0.11, curtailKw: 0, slotRole: batteryKw > 0 ? 'pv_speichern' : batteryKw < 0 ? 'eigenverbrauch' : 'warten',
    measuredLoadKw: i <= 48 ? loadKw : null, measuredPvKw: i <= 48 ? pvKw : null };
});
const plan = { planId: 'help-plan', deviceId: 'help-box', generatedAt: NOW, slotMinutes: 15,
  savingsEur: 2.88, bankedValueEur: 0.6, socStartPct: 28, socEndPct: 28, peakTargetKw: 8,
  effectiveFloorSocPct: 10, fallback14a: false, slots };
const buckets = slots.slice(0, 49).map((s) => ({
  start: s.start, pvKwh: s.pvKw / 4, loadKwh: s.loadKw / 4,
  gridImportKwh: Math.max(0, s.gridKw) / 4, gridExportKwh: Math.max(0, -s.gridKw) / 4,
  batteryChargeKwh: Math.max(0, s.batteryKw) / 4, batteryDischargeKwh: Math.max(0, -s.batteryKw) / 4,
  socMinPct: s.socPct, socMaxPct: s.socPct, socLastPct: s.socPct, priceEurMwh: s.priceEurMwh, costEur: s.costEur,
}));
const history = { range: 'day', from: DAY, to: '2026-09-10T22:00:00Z', bucketMinutes: 15, buckets,
  totals: { consumptionKwh: 25, pvGenerationKwh: 30.5, gridImportKwh: 8.7, gridExportKwh: 5.2,
    gridCostEur: 2.52, tarifArt: 'dynamisch', batterySavingsPlannedEur: 2.88, autarkiePct: 65.2, eigenverbrauchPct: 82.9 },
  protocol: [], plan: [],
  coverage: { firstDataAt: '2026-08-01T10:00:00Z', lastDataAt: NOW, expectedFrom: DAY, expectedTo: NOW,
    expectedBuckets: 49, measuredBuckets: 49, gaps: 0, resolutionMinutes: 15 },
};
const peak = { leistungspreisEurKw: 80, abrechnung: 'jahr', periodStart: '2026-01-01', peakKw: 8,
  baselinePeakKw: 11.5, avoidedKw: 3.5, avoidedEur: 280,
  history: [{ periodStart: '2026-01-01', peakKw: 8, baselinePeakKw: 11.5, avoidedKw: 3.5, avoidedEur: 280 }] };
// The chart and ledger use the same fictional totals.
const moneySeries = buckets.map((b) => {
  const einspeiseErloesEur = .42 * b.gridExportKwh / buckets.reduce((sum, row) => sum + row.gridExportKwh, 0);
  const eigenverbrauchsWertEur = 4.73 * b.loadKwh / buckets.reduce((sum, row) => sum + row.loadKwh, 0);
  const stromkostenEur = 2.52 * b.gridImportKwh / buckets.reduce((sum, row) => sum + row.gridImportKwh, 0);
  return { start: b.start, einspeiseErloesEur, eigenverbrauchsWertEur, stromkostenEur,
    nettoEur: einspeiseErloesEur + eigenverbrauchsWertEur - stromkostenEur };
});
const money = { siteId: site.id, id: site.id, name: site.name, range: 'day', from: DAY, to: NOW,
  plantKind: site.plantKind, tarifArt: site.tarifArt, tarifParamCtKwh: 4.5, tarifPriced: true,
  coveredSlots: 49, firstCoveredDate: '2026-08-01', reason: null, einspeiseErloesEur: 0.42,
  eigenverbrauchsWertEur: 4.73, stromkostenEur: 2.52, nettoErgebnisEur: 2.63, savedEur: 2.88,
  baselineEur: 5.4, actualEur: 2.52, arbitrageEur: 0.7, pvShiftEur: 2.18,
  marktpraemieEur: null, bezugspreisCtKwh: 29, realizedExportCtKwh: 8, marketValueSolarCtKwh: 6,
  marketValueProvisional: true, bezogenKwh: 8.7, eingespeistKwh: 5.2, selbstverbrauchKwh: 16.3, batterieBewegtKwh: 4.4,
  gesamtertragEur: 5.15, peakShaving: peak, batteryCapacityKwh: 20, socPct: 64,
  series: moneySeries,
  daily: [], dailySaved: [{ day: '2026-09-10', savedEur: 2.88 }], months: [], batteryInvestmentEur: null, paybackYears: null };
const overview = { sites: sites.map((s) => ({ ...s, deviceCount: 1, onlineCount: 1, waitingCount: 0,
  worstStatus: 'online', lastSeenAt: NOW, batteryWithoutDevice: false,
  live: { ts: NOW, pvKw: 6.2, loadKw: 4, gridKw: 0, socPct: 64 }, plannedSavingsTodayEur: 2.88,
  roleCounts: { pv: 1, storage: 1, consumer: 1, grid: 1 }, energyToday: { pvKwh: 30.5, loadKwh: 25, gridImportKwh: 8.7, gridExportKwh: 5.2 },
  anwendungen: ['speicher_fahrplan', 'monitoring', 'marktoptimierung'] })),
  totals: { sites: 2, devices: 2, online: 2, liveSitesCovered: 2, plannedSavingsTodayEur: 5.76, storageCapacityKwh: 40, storagePowerKw: 20 }, dailySavings: [] };
const charging = { budget: { deviceId: 'help-box', enabled: true, controlEnabled: true, connectorCount: 2,
  gridLimitKw: 22, effLimitKw: 22, marginPct: 10, minPowerKw: 1.4, budgetKw: 17.2, allocatedKw: 1.4,
  measuredKw: 1.4, reservedKw: 0, siteLoadKw: 2.6, siteGridKw: 0, budgetMode: 'metered',
  budgetNote: 'Die verfügbare Anschlussleistung wird auf die Ladepunkte verteilt.', safeDefaultKw: 3.7,
  safeDefaultHolds: true, safeWorstCaseKw: 10, maxHouseLoadKw: 2.6, surplusPolicy: 'sonne_zuerst',
  surplusKw: 1.4, surplusTotalKw: 3.6, surplusBatteryKw: 2.2, surplusActive: true, storagePriority: 'speicher_vor_auto', reportedAt: NOW },
  chargers: ['Carport', 'Werkstatt'].map((name, i) => ({
    deviceId: 'help-box', chargePointId: 'CP-' + name.toUpperCase(), label: 'Wallbox ' + name, priority: i === 0,
    connected: true, ready: true, vendor: 'KEBA', model: 'P30', lastSeen: NOW, reportedAt: NOW,
    connectors: [{ connectorId: 1, status: i ? 'Available' : 'Charging', charging: i === 0,
      allocatedKw: i ? 0 : 1.4, powerKw: i ? 0 : 1.4, energyKwh: 123.4, sessionKwh: i ? null : 1.05,
      meteredAt: NOW, sessionSince: i ? null : '2026-09-10T09:15:00Z', readback: 'confirmed', commandStatus: 'accepted',
      reasonText: i ? 'Kein Fahrzeug angeschlossen.' : 'Ladevorgang läuft.' }],
  })),
};

export function installHelpFixtures() {
  const params = new URLSearchParams(location.search);
  const empty = params.get('state') === 'empty';
  const error = params.get('state') === 'error';
  const single = params.get('state') === 'single';
  const admin = params.get('state') === 'admin';
  Object.assign(keycloak, { token: 'help-fixture-token', authenticated: true, updateToken: async () => false,
    tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', tenant_id: 'help-tenant', realm_access: { roles: [admin ? 'platform-admin' : 'operator'] } } });
  // All API methods are isolated, including mutation buttons in captured screens.
  for (const key of Object.keys(api)) (api as Record<string, unknown>)[key] = async () => { throw new Error('Missing help fixture: ' + key); };
  const result = (value: unknown) => async () => structuredClone(value);
  Object.assign(api, {
    selbstauskunft: result({ ...rechteSeed().me, standorte: [] }),
    funktionen: result({
      unternehmen: {
        messen: { laeuft_an: 0, standorte: 0, text: null },
        steuern: { laeuft_an: 0, standorte: 0, text: null },
      },
      standorte: [],
    } satisfies Funktionen),
    standorte: result({
      stichtag: '2026-09-10',
      standorte: [],
      nichtGezeigt: [],
      nochNichtZugeordnet: null,
    } satisfies StandorteAmStichtag),
    unternehmen: result({
      zustand: 'nicht_angelegt',
      id: null,
      name: null,
      kurzname: null,
      zeitzone: null,
      standortZahl: 0,
      anlagenZahl: 0,
      nochNichtZugeordnetZahl: 0,
    } satisfies Unternehmen),
    listSites: error ? async () => { throw new Error('Demo data unavailable'); } : result(sichtbareListe(empty || admin ? [] : single ? [site] : sites)),
    listDevices: result(sichtbareListe(empty || admin ? [] : single ? [devices[0]] : devices)),
    tenantContext: result({ tenantId: 'help-tenant', name: 'Beispielbetrieb', betriebsart: single || empty ? 'endkunde' : 'betreiber' }),
    overview: result(overview), earnings: result({ range: 'month', from: DAY, to: NOW, sites: sites.map((s) => ({ ...money, id: s.id, siteId: s.id, name: s.name })), totals: { ...money, coveredSlots: 98 } }),
    siteEarnings: result(money), history: result(history), schedule: result(plan), siteAssets: result([asset, { ...asset, id: 'help-pv', type: 'pv', capacityKwh: null, pvCapacityKwp: 10, moduleCount: 25 }]),
    siteEntities: result({ registry: { revision: '1', composedAt: NOW, deviceId: 'help-box', reportedRevision: '1', reportedAt: NOW }, entities, localSetup, staleOnDevice: [] }),
    topology: result(topology), usageProfile: result({ usageProfile: 'private', derivedProfile: 'private', override: null,
      emphasis: { money: 'prominent', peak: 'visible', flow: 'prominent', devices: 'prominent' },
      signals: { hasStorage: true, hasPv: true, hasControllableConsumer: true, hasEvCharger: true, activeStrategyNodeTypes: ['strategy_peak_shaving'], plantKind: site.plantKind, hasLeistungspreis: true } }),
    entityStrategies: result({}), cockpitLayout: result({ vorgabe: null, eigen: null }), tenantCockpitLayout: result({ vorgabe: null, eigen: null }),
    siteInterventions: result({ batteryOverride: null, automationPaused: false, interventions: [] }), suggestionStates: result({ states: {} }),
    siteRuleEvents: result([]), commandHistory: result({ entries: [], commands: [], total: 0 }), measurementPoints: result([]), componentTemplates: result([]), siteComponentTemplates: result([]),
    siteComponents: result({ componentAuthority: 'portal', sollRevision: '1', appliedRevision: '1', appliedAt: NOW, components: [{ id: 'help-battery', role: 'battery-hybrid', entityType: 'battery-hybrid', label: 'Speicher Scheune', brand: 'deye', model: 'sun-12k', family: 'deye-sg04lp3',
      communication: 'solarman_v5', connection: { ip: '192.0.2.10', port: 8899, serial: '1234567890' }, sourceKind: 'builtin', templateRef: 'builtin:deye:sun-12k', templateVersion: 1, definitionVersion: 1, syncStatus: 'in_sync' }] }),
    siteSources: result([]), edgeVersions: result(sichtbareListe([])), registerWriteHistory: result([]), registerKnowledge: result([]), registerWriteTargets: result([]),
    controlStatus: result({ deviceId: 'help-box', commandedKw: 2.2, confirmedKw: 2.2, allMatch: true, controlEnabled: true, certified: true, mismatchRoles: null, slotStart: NOW, checkedAt: NOW, controlSource: 'schedule', executionMode: 'plan', executionPlannedKw: 2.2 }), curtailmentStatus: result(null), eigeneAuswertung: result(null), autoStart: result(null),
    siteChargers: result(charging), chargingConfig: result({ siteId: site.id, gridLimitKw: 22, marginPct: 10, surplusPolicy: 'sonne_zuerst', storagePriority: 'speicher_vor_auto', priorityChargePointIds: ['CP-CARPORT'], chargePoints: [] }),
    siteVerbraucher: result({
      verbraucher: charging.chargers.map((c) => ({ entityId: c.chargePointId, name: c.label, typ: 'ev-charger', typLabel: 'Ladepunkt',
        ladepunkt: true, chargePointId: c.chargePointId, steuerart: { quelle: 'ueberschuss', herkunft: 'standard', ueberschussModus: 'pausieren' }, regeln: 0 })),
      ladepunkte: { standard: { quelle: 'ueberschuss', herkunft: 'standard', ueberschussModus: 'pausieren' }, standardFolger: 2, gesamt: 2,
        rahmen: { netzanschlussKw: 22, gepflegteGrenzeKw: 22, effektivGrenzeKw: 22, hausLastKw: 2.6, hoechsteHausLastKw: 2.6,
          verteiltKw: 1.4, budgetKw: 17.2, sicherheitsabstandPct: 10, mindestleistungKw: 1.4, modus: 'measured', blind: false, steckerAnzahl: 2, gemeldetAm: NOW } },
      rangliste: [{ position: 1, art: 'speicher', entityId: null, name: 'Speicher Scheune' },
        ...charging.chargers.map((c, i) => ({ position: i + 2, art: 'ladepunkt', entityId: c.chargePointId, name: c.label,
          mitglieder: [{ entityId: c.chargePointId, name: c.label }] }))],
    }),
    telemetry: result(slots.slice(0, 49).map((s) => ({ ts: s.start, powerKw: s.gridKw, pvPowerKw: s.pvKw, loadKw: s.loadKw, socPct: s.socPct, gridLimitKw: 22 }))),
    entityHistory: result({ range: 'day', from: DAY, to: NOW, bucketMinutes: 15, channels: Object.fromEntries(['pv_power_kw','battery_power_kw','soc_pct','load_kw','power_kw'].map((key) => [key, slots.slice(0, 49).map((s) => {
      const v = key === 'soc_pct' ? s.socPct : key === 'pv_power_kw' ? s.pvKw : key === 'battery_power_kw' ? s.batteryKw : key === 'load_kw' ? s.loadKw : s.gridKw;
      return { start: s.start, avg: v, min: v, max: v, last: v, n: 15 };
    })])) }),
    prices: result({ biddingZone: 'DE-LU', currency: 'EUR', resolution: 'PT15M', points: slots.map((s, i) => ({ ts: s.start, end: ts(i + 1), priceEurMwh: s.priceEurMwh })) }),
    priceHistory: result({ biddingZone: 'DE-LU', currency: 'EUR', bucket: 'PT15M', from: DAY, to: '2026-09-10T22:00:00Z',
      buckets: slots.map((s) => ({ ts: s.start, avgEurMwh: s.priceEurMwh, minEurMwh: s.priceEurMwh, maxEurMwh: s.priceEurMwh })), summary: { count: 96, coverageStart: DAY, coverageEnd: ts(96), cheapestTs: ts(28), mostExpensiveTs: ts(76), avgEurMwh: 65, minEurMwh: 30, maxEurMwh: 100 } }),
    weather: result({ runAt: NOW, points: slots.map((s, i) => ({ ts: s.start, temperatureC: 18 + 7 * Math.sin(i / 96 * Math.PI), cloudCoverPct: 15, ghiWM2: s.pvKw * 100, dniWM2: s.pvKw * 80, dhiWM2: s.pvKw * 20 })) }),
    forecastQuality: result({ activeLoadModel: 'load-persistence', activePvModel: 'pv-physical', models: [
      ['load-persistence', 'load', true], ['pv-physical', 'pv', true], ['load-xgb', 'load', false], ['pv-residual-xgb', 'pv', false],
    ].map(([model, kind, active]) => ({ model, kind, active, status: 'ready', daysCollected: 35, daysRequired: 14, trainedAt: NOW, trainRows: 3360, featureImportance: [], updatedAt: NOW })),
    accuracy: Array.from({ length: 7 }, (_, i) => ['load-persistence','pv-physical','load-xgb','pv-residual-xgb'].map((model, j) => ({
      day: '2026-09-0' + (i + 1), model, kind: j % 2 ? 'pv' : 'load', maeKw: .3 + .04 * i - (j > 1 ? .08 : 0), nmaePct: 10, biasKw: 0, skillVsBaseline: j > 1 ? .2 : null, nSlots: 96,
    }))).flat(), planAccuracy: [] }),
    siteForecastModels: result({ kinds: [], history: [] }), supplyPrice: result({ tarifArt: 'dynamisch', fixedPriceCtKwh: null, spotMarkupCtKwh: 4.5, gridFeeCtKwh: 8, taxesCtKwh: 2, vatPct: 19, source: 'manual' }),
    consumerSchedule: result({ planId: null, generatedAt: null, slotMinutes: 15, entities: [] }),
    siteProfiles: result({ profiles: [
      ['marktvermarktung','Marktoptimierung',!location.hash.includes('lastspitzen')], ['lastspitzenkappung','Lastspitzenkappung',location.hash.includes('lastspitzen')],
      ['atypische-netznutzung','Atypische Netznutzung',false], ['lastmanagement','Ladepark-Lastmanagement',true],
    ].map(([id,label,active]) => ({ id,label,active, state: active ? 'an' : 'aus', derivedActive: active,
      unlocks: { views: [], widgets: [], moneyStream: null }, requirements: [], blockedReason: null, origin: 'masterdata',
      flowRef: null, gatedNodeTypes: [], gatedNodesEnabled: true, exklusivGruppe: id === 'lastmanagement' ? null : 'speicher', seit: '2026-08-01T10:00:00Z' })), weitere: [] }),
    createSite: async (input: object) => ({ ...site, ...input }), claimDevice: result(devices[0]),
  });
  Object.assign(entitiesApi, { typeCatalog: result({ catalog_version: '1.0', types: definitions.map((d) => ({ type: d.entityType, label: d.typeLabel, category: d.category, controllable: d.control, composed: false, default_failsafe: 'release' })) }) });
  Object.assign(consumersApi, { options: result({ types: [], signals: [], intents: [], hasStorage: true, reportedSources: [] }), list: result([]), status: result([]), overrides: result([]), fulfillment: result([]) });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    let data: unknown = [];
    if (url.pathname.endsWith('/flow-node-governance')) data = { gatedNodes: [] };
    if (url.pathname.endsWith('/flow-node-status')) data = { nodes: [], reportedAt: NOW };
    if (url.pathname.endsWith('/v2-entities')) data = [];
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
