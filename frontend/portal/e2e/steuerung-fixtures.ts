/**
 * Fiktive Beispielanlage für die STEUERUNG - derselbe Tag wie im Prototyp
 * (`docs/konzepte/steuerung/prototyp.html`, Dienstag 29.09.2026, 13:10 Uhr).
 *
 * Die Reihen (Sonne, Preis, Netz, Speicher, je Gerät Leistung und Grund)
 * stammen aus der Simulation des Prototyps (`steuerung-daten.json`), damit
 * Prototyp und Portal Bild für Bild vergleichbar sind. Nur von
 * `e2e/steuerung.tsx` importiert; nie im Produktionsbündel.
 */
import { api } from '../src/api';
import { consumersApi } from '../src/consumers/consumersApi';
import { buildGuidedFlow } from '../src/flows/guidedBuilder';
import { installHelpFixtures } from './help-fixtures';
import D from './steuerung-daten.json';

/** Die Uhr der Aufnahmen: 13:10 Uhr in Berlin. */
export const JETZT = '2026-09-29T11:10:00.000Z';
const TAG0 = Date.parse('2026-09-28T22:00:00.000Z');
const ts = (i: number) => new Date(TAG0 + i * 900_000).toISOString();
const J = 52;
const SITE = 'help-site';

type Id = 'wb' | 'lp' | 'hs' | 'wp' | 'pool' | 'poolwp' | 'klima' | 'wama' | 'tr' | 'ir';
const KW = D.kw as Record<Id, number[]>;
const WHY = D.why as Record<Id, (string | null)[]>;

interface Def {
  id: Id | 'spuel' | 'lueft' | 'sauna';
  typ: string;
  typLabel: string;
  name: string;
  nenn: number | null;
  gemessen: boolean;
  steuerart: Record<string, unknown>;
  quellen: string[];
  ziele: string[];
  levels?: number[];
  schreibbar?: boolean;
  grund?: string;
  hilft?: boolean;
}

const Q_LAST = ['ueberschuss', 'guenstig', 'feste_zeiten', 'sofort'];
const DEFS: Def[] = [
  { id: 'wb', typ: 'ev-charger', typLabel: 'Ladepunkt', name: 'Wallbox Werkstatt', nenn: 11, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' }, quellen: ['ueberschuss', 'ueberschuss_speicher', 'guenstig', 'sofort'], ziele: ['bis_uhrzeit'] },
  { id: 'lp', typ: 'ev-charger', typLabel: 'Ladepunkt', name: 'Ladepunkt Carport', nenn: 11, gemessen: true, steuerart: { quelle: 'guenstig', herkunft: 'saeule', preisgrenzeCtKwh: 9, ziel: 'bis_uhrzeit', zielEnergieKwh: 30, zielFenster: { tage: 'daily', von: '', bis: '07:00' } }, quellen: ['ueberschuss', 'guenstig', 'sofort'], ziele: ['bis_uhrzeit'] },
  { id: 'hs', typ: 'heating-rod', typLabel: 'Heizstab', name: 'Heizstab Warmwasser', nenn: 3, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1 }, quellen: Q_LAST, ziele: ['laufzeit_bis'], levels: [1, 2, 3], hilft: false },
  { id: 'wp', typ: 'heat-pump-sgready', typLabel: 'Wärmepumpe (SG-Ready)', name: 'Wärmepumpe', nenn: 1.5, gemessen: false, steuerart: { quelle: 'freigabe_ueberschuss', herkunft: 'policy', schwelleKw: 2 }, quellen: ['freigabe_ueberschuss', 'freigabe_guenstig', 'sofort'], ziele: [] },
  { id: 'pool', typ: 'pump', typLabel: 'Pumpe', name: 'Poolpumpe', nenn: 0.75, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 0.75, ziel: 'laufzeit_bis', zielLaufzeitMinuten: 360, zielFenster: { tage: 'daily', von: '', bis: '20:00' } }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: true },
  { id: 'poolwp', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Pool-Wärmepumpe', nenn: 1.2, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1.2 }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: false },
  { id: 'klima', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Klimagerät Büro', nenn: 1.1, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1.1 }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: true },
  { id: 'wama', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Waschmaschine', nenn: 2.1, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 2, ziel: 'laufzeit_bis', zielLaufzeitMinuten: 120, zielAmStueck: true, zielFenster: { tage: 'daily', von: '', bis: '17:00' } }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: true },
  { id: 'tr', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Wäschetrockner', nenn: 2.2, gemessen: true, steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 2, ziel: 'laufzeit_bis', zielLaufzeitMinuten: 120, zielAmStueck: true, zielFenster: { tage: 'daily', von: '', bis: '19:30' } }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: true },
  { id: 'ir', typ: 'modbus-load', typLabel: 'Eigenes Schaltgerät (Modbus)', name: 'Infrarotheizung Werkstatt', nenn: 2, gemessen: false, steuerart: { quelle: 'feste_zeiten', herkunft: 'policy', fenster: { tage: 'weekdays', von: '06:30', bis: '08:30' } }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: false },
  { id: 'spuel', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Spülmaschine', nenn: 1.9, gemessen: true, steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' }, quellen: Q_LAST, ziele: ['laufzeit_bis'], hilft: true },
  { id: 'lueft', typ: 'modbus-load', typLabel: 'Eigenes Schaltgerät (Modbus)', name: 'Lüftung Werkstatt', nenn: null, gemessen: true, steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' }, quellen: [], ziele: [], schreibbar: false, grund: 'Misst nur. Schalten ist noch nicht freigegeben.' },
  { id: 'sauna', typ: 'generic-load', typLabel: 'Steuerbare Last', name: 'Sauna', nenn: 6, gemessen: false, steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' }, quellen: [], ziele: [], schreibbar: false, grund: 'Angelegt, aber nicht verbunden: Die Box findet den Shelly nicht.' },
];
const eid = (id: string) => `e-${id}`;
const LADE: Id[] = ['wb', 'lp'];
const GESTEUERT = DEFS.filter((d) => d.id in KW) as (Def & { id: Id })[];

const summe = (t: number) => GESTEUERT.reduce((s, d) => s + (KW[d.id][t] ?? 0), 0);
const gesamtLast = (t: number) => (D.last[t] ?? 0) + summe(t);

function optionen(d: Def) {
  const v: Record<string, unknown> = { schwelleKw: d.nenn, preisgrenzeCtKwh: 10, mindestlaufzeitMinuten: 10 };
  if (d.typ === 'heat-pump-sgready') Object.assign(v, { mindestlaufzeitMinuten: 30, sperrzeitMinuten: 20 });
  return {
    schreibbar: d.schreibbar !== false,
    nichtSchreibbarGrund: d.grund ?? null,
    quellen: d.quellen.map((id) => ({ id, gesperrt: false })),
    ziele: d.ziele.map((id) => ({ id, gesperrt: false })),
    vorgaben: v,
  };
}

const STATUS: Record<string, [string, string | null]> = {
  sonne: ['running_optimized', 'consumer_first'],
  'sonne-min': ['running_optimized', 'consumer_first'],
  freigabe: ['running_optimized', 'consumer_first'],
  frist: ['running_optimized', 'flex_deadline'],
  guenstig: ['running_optimized', 'price_below_threshold'],
  zeiten: ['running_forced', 'fixed_window'],
  'regel-an': ['running_forced', 'price_below_threshold'],
  'wartet-sonne': ['waiting', 'storage_first'],
  'frist-wartet': ['waiting', 'optimizer_selected_low_cost'],
  teuer: ['waiting', null],
  bedingung: ['waiting', null],
  danach: ['waiting', null],
  fertig: ['fulfilled', null],
  ziel: ['fulfilled', null],
};

export function installSteuerungFixtures() {
  installHelpFixtures();
  const result = (value: unknown) => async () => structuredClone(value);
  const pv = D.pv as number[];
  const netz = D.netz as number[];
  const sp = D.spKw as number[];
  const soc = D.soc as number[];
  const preis = D.preis as number[];

  const untergrenze = (i: number) => {
    const h = (i % 96) / 4;
    if (h >= 7 && h < 16) return 15;
    if (h >= 16) return Math.round(15 + (h - 16) * 6);
    return Math.max(15, Math.round(51 - h * 5));
  };
  const slots = Array.from({ length: 192 - J }, (_, k) => {
    const i = J + k;
    return {
      start: ts(i), pvKw: pv[i], loadKw: gesamtLast(i), gridKw: netz[i], batteryKw: sp[i], socPct: soc[i],
      priceEurMwh: preis[i] * 10, curtailKw: D.abgeregelt[i] ?? 0, costEur: 0, baselineCostEur: 0,
      slotRole: null, slotFlags: null, storedValueCtKwh: null, gridValueCtKwh: null, peakPressureEurKw: null,
      importPriceCtKwh: null, exportValueCtKwh: null, importPriceSource: null,
      // „Sonne + Speicher“: die Untergrenze je Viertelstunde - keine, wo der
      // Plan Netzstrom bezieht (dort handelt er); abends steigt sie für die Nacht.
      evReleaseFloorSocPct: netz[i] > 0.05 ? null : untergrenze(i),
    };
  });
  const plan = { planId: 'st-plan', deviceId: 'help-box', generatedAt: JETZT, slotMinutes: 15, savingsEur: 2.1,
    bankedValueEur: null, socStartPct: soc[J], socEndPct: soc[191], peakTargetKw: null, effectiveFloorSocPct: 10,
    fallback14a: false, slots };
  const buckets = Array.from({ length: J }, (_, i) => ({
    start: ts(i), pvKwh: pv[i] / 4, loadKwh: gesamtLast(i) / 4,
    gridImportKwh: Math.max(0, netz[i]) / 4, gridExportKwh: Math.max(0, -netz[i]) / 4,
    batteryChargeKwh: Math.max(0, sp[i]) / 4, batteryDischargeKwh: Math.max(0, -sp[i]) / 4,
    socMinPct: soc[i], socMaxPct: soc[i], socLastPct: soc[i], priceEurMwh: preis[i] * 10, costEur: 0,
  }));
  const verlauf = { range: 'day', from: ts(0), to: ts(96), bucketMinutes: 15, buckets,
    totals: { consumptionKwh: 20, pvGenerationKwh: 30, gridImportKwh: 3, gridExportKwh: 6, gridCostEur: 1,
      tarifArt: 'dynamisch', batterySavingsPlannedEur: 2, autarkiePct: 80, eigenverbrauchPct: 70 },
    protocol: [], plan: [], events: [] };

  const verbraucher = DEFS.map((d) => ({
    entityId: eid(d.id), name: d.name, typ: d.typ, typLabel: d.typLabel, ladepunkt: LADE.includes(d.id as Id),
    chargePointId: d.id === 'wb' ? 'CP-WERKSTATT' : d.id === 'lp' ? 'CP-CARPORT' : null,
    steuerart: d.steuerart, regeln: d.id === 'hs' ? 1 : 0, optionen: optionen(d),
  }));
  const rangliste = ['sp', 'wb', 'hs', 'wp', 'pool', 'poolwp', 'klima', 'lp', 'wama', 'tr', 'ir'].map((id, i) =>
    id === 'sp'
      ? { position: i + 1, art: 'speicher', entityId: null, name: 'Speicher Scheune' }
      : { position: i + 1, art: LADE.includes(id as Id) ? 'ladepunkt' : 'verbraucher', entityId: eid(id), name: DEFS.find((d) => d.id === id)?.name ?? id },
  );
  const rahmen = { netzanschlussKw: 22, gepflegteGrenzeKw: 22, effektivGrenzeKw: 22, hausLastKw: 0.6, hoechsteHausLastKw: 5.2,
    verteiltKw: KW.wb[J], budgetKw: 17.2, sicherheitsabstandPct: 10, mindestleistungKw: 1.4, modus: 'measured', blind: false, steckerAnzahl: 2, gemeldetAm: JETZT };

  const consumers = GESTEUERT.filter((d) => !LADE.includes(d.id)).concat(DEFS.filter((d) => ['spuel', 'lueft', 'sauna'].includes(d.id)) as never[])
    .map((d) => ({
      id: eid(d.id), type: d.typ, typeLabel: d.typLabel, name: d.name,
      controlKind: d.levels ? 'stepped' : 'on_off', ratedPowerKw: d.nenn ?? 0, minPowerKw: null, levelsKw: d.levels ?? null,
      resolutionKw: null, powerRangesKw: null, storageRelation: 'storage_first', defaultGridEnergyPolicy: 'avoid',
      allowStorageDischarge: d.hilft ?? false, failsafe: 'off', enabled: true, version: 1,
      connection: d.id === 'sauna' ? 'disconnected' : 'connected', edgeSourceId: `src-${d.id}`,
      controlActivation: ['spuel', 'lueft', 'sauna'].includes(d.id) ? 'not_activated' : 'active', hasDraftPolicy: false, draftPolicyVersion: null,
      confirmationChannel: d.gemessen ? 'power_kw' : 'relay_state',
      ioEntityId: d.id === 'hs' || d.id === 'wp' ? 'e-io' : null, ioChannel: d.id === 'hs' ? 1 : d.id === 'wp' ? 4 : null,
    }));
  const status = GESTEUERT.filter((d) => !LADE.includes(d.id)).map((d) => {
    const w = WHY[d.id][J] ?? 'aus';
    const [state, reasonCode] = STATUS[w] ?? ['ready', null];
    const kw = KW[d.id][J] ?? 0;
    return { entityId: eid(d.id), state: kw > 0 ? (state.startsWith('running') ? state : 'running_optimized') : state,
      reasonCode, actualKw: d.gemessen ? kw : null, confirmed: true, reportedAt: JETZT };
  });
  const connector = (id: Id, angesteckt: boolean) => ({
    connectorId: 1, status: angesteckt ? (KW[id][J] > 0 ? 'Charging' : 'SuspendedEVSE') : 'Available',
    charging: KW[id][J] > 0, allocatedKw: KW[id][J], powerKw: angesteckt ? KW[id][J] : 0, energyKwh: 812,
    sessionKwh: angesteckt ? 4.6 : null, meteredAt: JETZT, sessionSince: angesteckt ? ts(32) : null,
    readback: 'confirmed', commandStatus: 'accepted', tagRef: angesteckt ? 'tagref_07cd1234' : null,
    reason: angesteckt ? 'ueberschuss' : null, reasonText: angesteckt ? 'Sonnenstrom' : 'Kein Fahrzeug angeschlossen.',
  });
  const charging = { budget: { deviceId: 'help-box', enabled: true, controlEnabled: true, connectorCount: 2, gridLimitKw: 22,
    effLimitKw: 22, marginPct: 10, minPowerKw: 1.4, budgetKw: 17.2, allocatedKw: KW.wb[J], measuredKw: KW.wb[J], reservedKw: 0,
    siteLoadKw: 0.6, siteGridKw: netz[J], budgetMode: 'metered', surplusPolicy: 'nur_sonne', storagePriority: 'speicher_vor_auto', reportedAt: JETZT,
    storageRelease: { active: true, kw: 2.4, floorSocPct: 15, socPct: soc[J], mode: 'frei',
      note: 'Der Speicher gibt bis 2,4 kW für das Auto frei und darf bis 15 % entladen.' } },
  chargers: [
    { deviceId: 'help-box', chargePointId: 'CP-WERKSTATT', entityId: eid('wb'), label: 'Wallbox Werkstatt', priority: true, connected: true, ready: true, vendor: 'go-e', model: 'Charger', lastSeen: JETZT, reportedAt: JETZT, connectors: [connector('wb', true)] },
    { deviceId: 'help-box', chargePointId: 'CP-CARPORT', entityId: eid('lp'), label: 'Ladepunkt Carport', priority: false, connected: true, ready: true, vendor: 'KEBA', model: 'P30', lastSeen: JETZT, reportedAt: JETZT, connectors: [connector('lp', false)] },
  ] };
  const consumerPlan = { planId: 'st-plan', generatedAt: JETZT, slotMinutes: 15,
    entities: GESTEUERT.map((d) => ({ entityId: eid(d.id), name: d.name,
      slots: Array.from({ length: 192 - J - 1 }, (_, k) => ({ time: ts(J + 1 + k), command: 'setpoint_kw', targetValue: KW[d.id][J + 1 + k] ?? 0, reasonCode: null, requirementId: null })) })) };

  // Die Komponenten der Anlage, wie der freie Editor sie liest (Netzanschluss, Speicher, schaltbare Geräte).
  const komponente = (id: string, entityType: string, label: string, measure: string[], actuate: string[]) => ({
    id, entityType, typeLabel: label, role: entityType === 'grid-meter' ? 'grid' : entityType === 'battery-hybrid' ? 'storage' : 'consumer',
    label, control: actuate.length > 0, deviceId: 'help-box',
    capabilities: { measure: measure.map((channel) => ({ channel })), actuate: actuate.map((command) => ({ command })) },
    guards: null, syncStatus: 'in_sync', observed: { health: 'ok', lastTelemetryAt: JETZT, channels: measure, appliedType: entityType, reportedAt: JETZT }, edgeSourceId: null,
  });
  const entities = [
    komponente('help-battery', 'battery-hybrid', 'Speicher Scheune', ['soc_pct', 'battery_power_kw'], ['set_power']),
    komponente('help-grid', 'grid-meter', 'Netzanschluss', ['power_kw'], []),
    ...DEFS.map((d) => komponente(eid(d.id), d.typ, d.name, d.gemessen ? ['power_kw'] : [], d.schreibbar === false ? [] : LADE.includes(d.id as Id) ? ['limit_kw'] : ['on_off', ...(d.levels ? ['setpoint_kw'] : [])])),
    komponente('e-io', 'io-module', 'I/O-Modul Technikraum', [], []),
  ];

  // Eine aktive Regel: Negativpreise mitnehmen (Heizstab voll).
  const regelDoc = buildGuidedFlow({ conditions: [{ kind: 'price', direction: 'below', threshold: 0, hysteresis: 0.5 }], combinator: 'and',
    action: { kind: 'setpoint', entityId: eid('hs'), value: 3, ttlS: 300 } }, 'Negativpreise mitnehmen', SITE);
  const regelAus = buildGuidedFlow({ conditions: [{ kind: 'entity', entityId: 'help-battery', channel: 'soc_pct', direction: 'above', threshold: 90, hysteresis: 2 }], combinator: 'and',
    action: { kind: 'onoff', entityId: eid('klima'), ttlS: 300 } }, 'Speicher voll? Weiter', SITE);
  const flows = [
    { flowId: 'f-neg', name: 'Negativpreise mitnehmen', runtime: 'edge', latestVersion: 2, latestLifecycle: 'active', activeVersion: 2, updatedAt: JETZT, simulation: null, latestDocument: regelDoc, versions: [1, 2] },
    { flowId: 'f-voll', name: 'Speicher voll? Weiter', runtime: 'edge', latestVersion: 1, latestLifecycle: 'draft', activeVersion: null, updatedAt: JETZT, simulation: null, latestDocument: regelAus, versions: [1] },
  ];
  const ruleEvents = { recordingSince: '2026-09-01T00:00:00Z', countsToday: true, accuracySeconds: 15,
    rules: [{ ruleKind: 'flow', ruleRef: 'f-neg', switchedToday: 1, lastSwitchedAt: ts(52) }],
    events: [
      { id: 1, ruleKind: 'flow', ruleRef: 'f-neg', entityId: eid('hs'), kind: 'gestartet', state: null, previousState: null, reasonCode: 'price_below_threshold', actualKw: 3, detail: null, occurredAt: ts(52) },
    ] };

  let szene: { key: string; since: string; pausedEntityIds: string[] } | null = null;
  const vorSzene = new Map<string, (typeof status)[number]>();
  Object.assign(api, {
    schedule: result(plan),
    history: result(verlauf),
    telemetry: result([{ ts: JETZT, powerKw: netz[J], socPct: soc[J], pvPowerKw: pv[J], loadKw: gesamtLast(J), gridLimitKw: 22 }]),
    prices: result({ biddingZone: 'DE-LU', currency: 'EUR', resolution: 'PT15M', points: preis.map((p, i) => ({ ts: ts(i), end: ts(i + 1), priceEurMwh: p * 10 })) }),
    weather: result({ runAt: JETZT, points: (D.temp as number[]).map((t, i) => ({ ts: ts(i), temperatureC: t, cloudCoverPct: 10, ghiWM2: 0, dniWM2: 0, dhiWM2: 0 })) }),
    siteVerbraucher: result({ verbraucher, ladepunkte: { standard: { quelle: 'ueberschuss', herkunft: 'standard', ueberschussModus: 'pausieren' }, standardFolger: 0, gesamt: 2, rahmen }, rangliste }),
    saveRangliste: async (_s: string, eintraege: { art: string; entityId?: string }[]) => ({
      verbraucher, ladepunkte: { standard: null, standardFolger: 0, gesamt: 2, rahmen },
      rangliste: eintraege.map((e, i) => ({ position: i + 1, art: e.art, entityId: e.entityId ?? null, name: e.art === 'speicher' ? 'Speicher Scheune' : DEFS.find((d) => eid(d.id) === e.entityId)?.name ?? '' })),
    }),
    siteChargers: result(charging),
    chargingConfig: result({ gridLimitKw: 22, priorityChargePointIds: ['CP-WERKSTATT'], surplusPolicy: 'nur_sonne', storagePriority: 'speicher_vor_auto', frame: { rotationMinutes: 15 },
      storageReleaseReserveKwh: null, storageReleaseReserveStandardKwh: 1 }),
    saveStorageReleaseReserve: async (_s: string, reserveKwh: number | null) => ({ gridLimitKw: 22, priorityChargePointIds: ['CP-WERKSTATT'], surplusPolicy: 'nur_sonne',
      storagePriority: 'speicher_vor_auto', frame: { rotationMinutes: 15 }, storageReleaseReserveKwh: reserveKwh, storageReleaseReserveStandardKwh: 1 }),
    consumerSchedule: result(consumerPlan),
    siteInterventions: result({ automationPaused: false, pausedUntil: null, interventions: [] }),
    siteAssets: result([{ id: 'st-batt', type: 'battery', deviceId: 'help-box', capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5, roundtripEfficiencyPct: 92, speicherschonung: 'ausgewogen', pvCapacityKwp: null, moduleCount: null, azimuthDeg: null, tiltDeg: null, commissionedOn: null, registry: null, registryUnitId: null, registryFetchedAt: null }]),
    siteFahrzeuge: result({ fahrzeuge: [
      { tagRef: 'tagref_07cd1234', name: 'Kleinwagen', steuerart: { quelle: 'ueberschuss', herkunft: 'policy', ueberschussModus: 'pausieren' }, laedt: true, letzterLadepunkt: 'CP-WERKSTATT', letzteSichtungAm: JETZT },
      { tagRef: 'tagref_41ab5678', name: 'Familienauto', steuerart: { quelle: 'ueberschuss', herkunft: 'policy', ueberschussModus: 'mindestleistung', mindestleistungKw: 4.2 }, laedt: false, letzterLadepunkt: 'CP-CARPORT', letzteSichtungAm: ts(28) },
      { tagRef: 'tagref_99ff0000', name: null, steuerart: null, laedt: false, letzterLadepunkt: 'CP-CARPORT', letzteSichtungAm: '2026-09-20T15:00:00Z' },
    ] }),
    siteRuleEvents: result(ruleEvents),
    suggestionStates: result({ states: [] }),
    siteProfiles: result({ profiles: [
      ['marktvermarktung', 'Marktoptimierung', true], ['lastspitzenkappung', 'Lastspitzenkappung', false], ['atypische-netznutzung', 'Atypische Netznutzung', false],
    ].map(([id, label, moeglich]) => ({ id, label, active: false, state: 'aus', derivedActive: false, unlocks: { views: [], widgets: [], moneyStream: null },
      requirements: moeglich ? [] : [{ label: id === 'lastspitzenkappung' ? 'Leistungspreis' : 'Leistungsmessung', met: false }], blockedReason: null, origin: 'masterdata', flowRef: null,
      gatedNodeTypes: [], gatedNodesEnabled: true, exklusivGruppe: 'speicher', seit: null })), weitere: [] }),
    siteEntities: result({ registry: { revision: '1', composedAt: JETZT, deviceId: 'help-box', reportedRevision: '1', reportedAt: JETZT }, entities, localSetup: [], staleOnDevice: [] }),
    entityHistory: async (_s: string, entityId: string) => {
      const d = GESTEUERT.find((x) => eid(x.id) === entityId);
      const reihe = d && d.gemessen ? KW[d.id] : null;
      return { range: 'day', from: ts(0), to: ts(96), bucketMinutes: 15,
        channels: reihe ? { power_kw: Array.from({ length: J }, (_, i) => ({ start: ts(i), avg: reihe[i], min: reihe[i], max: reihe[i], last: reihe[i], n: 15 })) } : {} };
    },
    setzeSteuerart: async (_s: string, entityId: string, w: Record<string, unknown>) => {
      // Wie der Server: die Steuerart gilt danach (die Seite liest die Liste neu).
      const e = verbraucher.find((v) => v.entityId === entityId);
      if (e) e.steuerart = { ...w, herkunft: e.ladepunkt ? 'saeule' : 'policy' } as typeof e.steuerart;
      return { steuerart: { ...w, herkunft: 'policy' }, aktiv: true, entityId };
    },
    setSuggestionState: async (_s: string, key: string, state: string) => ({ key, state, mutedUntil: state === 'nur_messen' ? null : '2099-01-01T00:00:00Z', updatedAt: JETZT }),
    clearSuggestionState: async () => undefined,
    // Die Szene (E6): pausiert die gewählten Geräte, bis sie endet - wie `SzenenService`.
    scene: async () => ({ scene: szene, offen: [], message: null }),
    startScene: async (_s: string, key: string, ids: string[]) => {
      for (const c of consumers) if (ids.includes(c.id)) { c.controlActivation = 'paused'; c.enabled = false; }
      // Die Box meldet ein pausiertes Gerät im sicheren Zustand: aus.
      for (const st of status) if (ids.includes(st.entityId)) { vorSzene.set(st.entityId, { ...st }); Object.assign(st, { state: 'ready', reasonCode: null, actualKw: st.actualKw == null ? null : 0 }); }
      szene = { key, since: JETZT, pausedEntityIds: ids };
      return { scene: szene, offen: [], message: `Szene ist an. ${ids.length} Geräte pausiert; der sichere Zustand des Geräts gilt.` };
    },
    endScene: async () => {
      for (const c of consumers) if (szene?.pausedEntityIds.includes(c.id)) { c.controlActivation = 'active'; c.enabled = true; }
      for (const st of status) { const vor = vorSzene.get(st.entityId); if (vor) Object.assign(st, vor); }
      vorSzene.clear();
      szene = null;
      return { scene: null, offen: [], message: 'Szene beendet. Alles wieder wie vorher.' };
    },
    chargingBoost: async () => ({ chargePointId: 'CP-WERKSTATT', connectorId: 1, active: true, note: 'ok' }),
    pauseAutomation: async () => ({ applied: true, pushed: true, kind: 'pause', endsAt: null, effectivePowerKw: null, ttlRenewed: false, message: 'ok' }),
    startBatteryOverride: async () => ({ applied: true, pushed: true, kind: 'speicher_laden', endsAt: null, effectivePowerKw: 5, ttlRenewed: false, message: 'ok' }),
  });
  Object.assign(consumersApi, {
    list: result(consumers),
    status: result(status),
    overrides: result([]),
    startOverride: async () => ({ applied: true, pushed: true, kind: 'start', endsAt: null, effectivePowerKw: 3, gridImportPossible: true, ttlCapped: false, message: 'ok' }),
    clearOverride: async () => ({ applied: true, pushed: true, kind: 'clear', endsAt: null, effectivePowerKw: null, gridImportPossible: false, ttlCapped: false, message: 'ok' }),
    patch: async (_s: string, id: string) => consumers.find((c) => c.id === id),
  });

  // Die Regeln (`/flows`) laufen über fetch - dieselbe Abkürzung wie in den Hilfe-Beispieldaten.
  const vorher = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname.endsWith(`/sites/${SITE}/flows`) && (!init?.method || init.method === 'GET')) return json(flows);
    if (/\/flows\/[^/]+\/versions\/\d+\/activate$/.test(url.pathname)) return json({ activated: true, message: 'aktiv', published: true, lifecycle: 'active' });
    if (url.pathname.endsWith(`/sites/${SITE}/flows`) && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      return json({ flowId: 'f-neu', flowVersion: 1, siteId: SITE, name: body.name, runtime: 'edge', lifecycle: 'draft', document: body.document, simulation: null, createdAt: JETZT, updatedAt: JETZT, simulatedAt: null, activatedAt: null });
    }
    return vorher(input, init);
  };
}
