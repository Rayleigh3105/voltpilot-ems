/**
 * Bühne „Cockpit für private Haushalte“ (Konzept `vp-cockpit-privat-konzept`): drei Lagen eines privaten
 * Haushalts als stimmige Viertelstunden-Reihe (die Energiebilanz geht je Viertelstunde auf). Alle Namen und
 * Zahlen sind erfunden; „Haus am Mühlbach“ hat Aufbau und Größenordnung des Captain-Bildes vom 07.11.2026
 * 19:47 (vier Erzeuger, Netzzähler, Haus, UV Halle, UV Keller, kein Speicher).
 *
 *  - `abend`    Haus am Mühlbach, 19:47, keine Erzeugung, Netzbezug 3,6 kW (das Bild)
 *  - `mittag`   Haus am Mühlbach, 12:30, Sonne mit Überschuss (Mittagspause in der Halle)
 *  - `speicher` Haus Birkenweg, 19:47, Speicher 10 kWh entlädt, Wärmepumpe läuft
 */
import { derive } from '../src/topology';

export type Lage = 'abend' | 'mittag' | 'speicher';

export const TAG_BEGINN = Date.parse('2026-11-06T23:00:00Z'); // 07.11.2026 00:00 Berlin
const VIERTEL = 15 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const JETZT: Record<Lage, string> = {
  abend: '2026-11-07T18:47:00Z',
  mittag: '2026-11-07T11:30:00Z',
  speicher: '2026-11-07T18:47:00Z',
};

/** Sonnenglocke eines klaren Novembertags (Aufgang ~07:24, Untergang ~16:36). */
function glocke(h: number): number {
  if (h <= 7.4 || h >= 16.6) return 0;
  return Math.pow(Math.sin((Math.PI * (h - 7.4)) / 9.2), 1.5);
}

interface Viertel {
  start: number;
  h: number;
  pv: number;
  last: number;
  teile: Record<string, number>;
  batt: number; // + laden, - entladen (kW)
  soc: number | null;
  netz: number; // + Bezug, - Einspeisung
}

/** Haus am Mühlbach: Halle arbeitet 07:30-11:45 und 13:15-17:30, abends läuft sie mit 3 kW weiter. */
function muehlbachLast(h: number): Record<string, number> {
  const halle =
    h >= 7.5 && h < 11.75 ? 4.6 : h >= 11.75 && h < 13.25 ? 0.2 : h >= 13.25 && h < 17.5 ? 4.22 : h >= 17.5 && h < 22 ? 3.0 : 0.3;
  const keller = 0.1;
  const rest = 0.45 + (h >= 6.5 && h < 8.5 ? 0.3 : 0) + (h >= 17.5 && h < 22.5 ? 0.05 : 0);
  return { halle, keller, rest };
}

/** Haus Birkenweg: Familie, Wärmepumpe morgens und abends, kleiner Grundbedarf. */
function birkenLast(h: number): Record<string, number> {
  const wp = h >= 5.5 && h < 8.5 ? 1.4 : h >= 17 && h < 22.5 ? 1.1 : h >= 11 && h < 15 ? 0.6 : 0.25;
  const rest = 0.3 + (h >= 6.5 && h < 8.5 ? 0.6 : 0) + (h >= 11.5 && h < 13 ? 0.9 : 0) + (h >= 17.5 && h < 22.5 ? 0.6 : 0);
  return { wp, rest };
}

function reihe(lage: Lage): Viertel[] {
  const birken = lage === 'speicher';
  const pvSpitze = birken ? 3.15 : 4.3;
  const kap = 10; // kWh
  let soc = 22; // % um Mitternacht
  const out: Viertel[] = [];
  for (let i = 0; i < 96; i++) {
    const h = i / 4 + 0.125;
    const pv = pvSpitze * glocke(h);
    const teile = birken ? birkenLast(h) : muehlbachLast(h);
    const last = Object.values(teile).reduce((s, x) => s + x, 0);
    let batt = 0;
    if (birken) {
      const ueber = pv - last;
      if (ueber > 0.05 && soc < 95) batt = Math.min(ueber, 4.6, ((95 - soc) / 100) * kap * 4);
      else if (ueber < -0.05 && soc > 10 && h >= 16.5) batt = -Math.min(-ueber, 4.6, ((soc - 10) / 100) * kap * 4);
      soc = Math.min(95, Math.max(10, soc + (batt / 4 / kap) * 100 * (batt > 0 ? 0.95 : 1)));
    }
    out.push({ start: TAG_BEGINN + i * VIERTEL, h, pv, last, teile, batt, soc: birken ? soc : null, netz: last + batt - pv });
  }
  return out;
}

export interface LageDaten {
  lage: Lage;
  now: string;
  site: Record<string, unknown>;
  overview: Record<string, unknown>;
  history: Record<string, unknown>;
  plan: Record<string, unknown>;
  weather: Record<string, unknown>;
  money: Record<string, unknown>;
  topology: Record<string, unknown>;
  entities: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  control: Record<string, unknown> | null;
  usageSignals: Record<string, unknown>;
  geraeteHeute: Record<string, number>;
  /** Die gemessene Reihe je Unterzähler (kW je Viertelstunde bis jetzt) für `/entities/{id}/history`. */
  serien: Record<string, { start: string; kw: number }[]>;
  summen: Record<string, number>;
}

export function lageDaten(lage: Lage): LageDaten {
  const now = JETZT[lage];
  const nowMs = Date.parse(now);
  const birken = lage === 'speicher';
  const v = reihe(lage);
  const jetztI = Math.floor((nowMs - TAG_BEGINN) / VIERTEL);
  const vorbei = v.slice(0, jetztI);
  const j = v[jetztI];

  // Live: der Moment (Mittag in der Pause, Abend mit Halle auf 3 kW).
  const pvJetzt = j.pv;
  const teileJetzt = j.teile;
  const hausJetzt = j.last;
  const battJetzt = j.batt;
  const netzJetzt = hausJetzt + battJetzt - pvJetzt;

  const sum = (f: (x: Viertel) => number) => vorbei.reduce((s, x) => s + f(x) / 4, 0);
  const pvKwh = sum((x) => x.pv);
  const lastKwh = sum((x) => x.last);
  const bezug = sum((x) => Math.max(0, x.netz));
  const einsp = sum((x) => Math.max(0, -x.netz));
  const laden = sum((x) => Math.max(0, x.batt));
  const entladen = sum((x) => Math.max(0, -x.batt));
  const selbst = lastKwh - bezug;
  const autarkie = (100 * selbst) / lastKwh;
  const eigen = pvKwh > 0 ? (100 * (pvKwh - einsp)) / pvKwh : null;

  const site = birken
    ? { id: 'birkenweg', name: 'Haus Birkenweg', plantKind: 'eigenverbrauch', tarifArt: 'fest', tarifParamCtKwh: 32, netzladenErlaubt: false, maxFeedInKw: null, bezugspreisCtKwh: 32, socMinPct: 10, socMaxPct: 95, profil: null }
    : { id: 'muehlbach', name: 'Haus am Mühlbach', plantKind: 'eigenverbrauch', tarifArt: 'fest', tarifParamCtKwh: 24.3, netzladenErlaubt: false, maxFeedInKw: null, bezugspreisCtKwh: 24.3, profil: null };
  Object.assign(site, { biddingZone: 'DE-LU', latitude: 49.0, longitude: 11.1, anzulegenderWertCtKwh: null, leistungspreisEurKw: null });

  // Geräte: vier Erzeuger (Mühlbach) bzw. ein Hybrid-Wechselrichter mit Speicher (Birkenweg).
  type G = { id: string; typ: string; typLabel: string; label: string | null; kategorie: string; kanal: string; rolle: string; kw: number; quelle: string | null; primary?: boolean };
  const anteil = [0.29, 0.25, 0.24, 0.22];
  const erzeuger: G[] = birken
    ? []
    : [
        { id: 'mb-piko', typ: 'producer', typLabel: 'Erzeuger', label: 'Kostal PIKO Scheune', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: pvJetzt * anteil[0], quelle: 'src-mbpiko01', primary: true },
        { id: 'mb-kaco-ost', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco Ost', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: pvJetzt * anteil[1], quelle: 'src-mbkaco01' },
        { id: 'mb-kaco-mitte', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco Mitte', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: pvJetzt * anteil[2], quelle: 'src-mbkaco02' },
        { id: 'mb-kaco-west', typ: 'producer', typLabel: 'Erzeuger', label: 'Kaco West', kategorie: 'producer', kanal: 'pv_power_kw', rolle: 'pv', kw: pvJetzt * anteil[3], quelle: 'src-mbkaco03' },
      ];
  const netz: G = { id: `${site.id}-netz`, typ: 'grid-meter', typLabel: 'Netzzähler', label: 'Netzanschluss', kategorie: 'meter', kanal: 'power_kw', rolle: 'grid', kw: netzJetzt, quelle: `src-${site.id}netz`, primary: true };
  const haus: G = { id: `${site.id}-haus`, typ: 'house-load', typLabel: 'Hausverbrauch', label: null, kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: hausJetzt, quelle: null, primary: true };
  const uv: G[] = birken
    ? [{ id: 'bw-wp', typ: 'sub-meter', typLabel: 'Unterzähler', label: 'Wärmepumpe', kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: teileJetzt.wp, quelle: 'src-bwwp01' }]
    : [
        { id: 'mb-uv-halle', typ: 'sub-meter', typLabel: 'Unterzähler', label: 'UV Halle', kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: teileJetzt.halle, quelle: 'src-mbuvha01' },
        { id: 'mb-uv-keller', typ: 'sub-meter', typLabel: 'Unterzähler', label: 'UV Keller', kategorie: 'consumer', kanal: 'power_kw', rolle: 'consumer', kw: teileJetzt.keller, quelle: 'src-mbuvke01' },
      ];
  const topoEntities: Record<string, unknown>[] = [];
  const cap = (g: G) => [{ channel: g.kanal, unit: 'kW', role: g.rolle, primary: g.primary === true, value: r3(g.kw) }];
  for (const g of [netz, haus, ...erzeuger, ...uv]) {
    topoEntities.push({ id: g.id, entityType: g.typ, typeLabel: g.typLabel, label: g.label, category: g.kategorie, health: 'ok', capabilities: cap(g) });
  }
  if (birken) {
    topoEntities.push({
      id: 'bw-speicher', entityType: 'battery-hybrid', typeLabel: 'Hybridspeicher', label: 'Speicher Keller', category: 'storage', health: 'ok',
      capabilities: [
        { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: r3(pvJetzt) },
        { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: true, value: r3(battJetzt) },
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: Math.round(j.soc ?? 0) },
      ],
    });
  }
  const topology = {
    schemaVersion: '1.0',
    entities: topoEntities,
    topology: derive({
      entities: topoEntities.map((e) => ({
        id: e.id as string,
        type: e.entityType as string,
        label: (e.label as string | null) ?? '',
        category: e.category as string,
        health: 'ok',
        capabilities: (e.capabilities as { channel: string; role: string; primary: boolean; value: number }[]).map((c) => ({ channel: c.channel, role: c.role, primary: c.primary, value: c.value })),
      })),
    }),
  };
  const gepinnt = [...erzeuger, netz, ...uv];
  const sources = gepinnt.map((g) => ({
    deviceId: `${site.id}-box`, sourceId: g.quelle, kind: 'source',
    role: g.rolle === 'pv' ? 'pv-generation' : g.rolle === 'grid' ? 'grid-meter' : 'consumer',
    label: g.label, brand: g.id.includes('piko') ? 'kostal' : g.rolle === 'pv' ? 'kaco' : 'shelly', model: null,
    pvKw: g.rolle === 'pv' ? r3(g.kw) : null, powerKw: g.rolle === 'grid' ? r3(g.kw) : null, loadKw: g.rolle === 'consumer' ? r3(g.kw) : null,
    health: 'ok', readAt: now, reportedAt: now,
  }));
  const entities = [
    ...gepinnt.map((g) => ({
      id: g.id, entityType: g.typ, typeLabel: g.typLabel, role: g.rolle, category: g.kategorie, label: g.label, control: false,
      deviceId: `${site.id}-box`, capabilities: { measure: [{ channel: g.kanal, unit: 'kW' }] },
      guards: null, syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: now, reportedAt: now, channels: [g.kanal], appliedType: g.typ },
      edgeSourceId: g.quelle, orphanedPin: false,
    })),
    ...(birken
      ? [{
          id: 'bw-speicher', entityType: 'battery-hybrid', typeLabel: 'Hybridspeicher', role: 'storage', category: 'storage', label: 'Speicher Keller', control: true,
          deviceId: 'birkenweg-box',
          capabilities: { measure: ['pv_power_kw', 'battery_power_kw', 'soc_pct'].map((c) => ({ channel: c, unit: c === 'soc_pct' ? '%' : 'kW' })), actuate: [{ command: 'set_power', min: -4.6, max: 4.6 }] },
          guards: { limits: { soc_min_pct: 10, soc_max_pct: 95 }, failsafe: { behavior: 'self-consumption' } }, syncStatus: 'in_sync',
          observed: { health: 'ok', lastTelemetryAt: now, reportedAt: now, channels: ['pv_power_kw', 'battery_power_kw', 'soc_pct'], appliedType: 'battery-hybrid' },
          edgeSourceId: null, orphanedPin: false,
        }]
      : []),
  ];

  // Verlauf (bis jetzt) und Plan (der ganze Tag; rechts von jetzt ist er die Prognose).
  const buckets = vorbei.map((x) => ({
    start: iso(x.start), pvKwh: x.pv / 4, loadKwh: x.last / 4,
    gridImportKwh: Math.max(0, x.netz) / 4, gridExportKwh: Math.max(0, -x.netz) / 4,
    batteryChargeKwh: birken ? Math.max(0, x.batt) / 4 : null, batteryDischargeKwh: birken ? Math.max(0, -x.batt) / 4 : null,
    socMinPct: x.soc, socMaxPct: x.soc, socLastPct: x.soc, priceEurMwh: 92, costEur: null,
  }));
  const bezugspreis = birken ? 32 : 24.3;
  const totals = {
    consumptionKwh: r2(lastKwh), pvGenerationKwh: r2(pvKwh), gridImportKwh: r2(bezug), gridExportKwh: r2(einsp),
    batteryChargeKwh: birken ? r2(laden) : null, batteryDischargeKwh: birken ? r2(entladen) : null,
    gridCostEur: r2((bezug * bezugspreis) / 100), tarifArt: 'fest', batterySavingsPlannedEur: null,
    autarkiePct: r2(autarkie), eigenverbrauchPct: eigen == null ? null : r2(eigen),
  };
  const ende = TAG_BEGINN + 96 * VIERTEL;
  const history = {
    range: 'day', from: iso(TAG_BEGINN), to: iso(ende), bucketMinutes: 15, buckets, totals, protocol: [], plan: [], events: [],
    coverage: { firstDataAt: '2026-05-01T10:00:00Z', lastDataAt: now, expectedFrom: iso(TAG_BEGINN), expectedTo: now, expectedBuckets: jetztI, measuredBuckets: jetztI, gaps: 0, resolutionMinutes: 15 },
  };
  // Der Plan reicht bis morgen 24:00 (die Prognose für morgen: ein etwas trüberer Tag).
  const slots = [] as Record<string, unknown>[];
  // Um 12:30 sind die Preise für morgen noch nicht veröffentlicht (~12:45): der Plan endet um 24 Uhr.
  const planViertel = lage === 'mittag' ? 96 : 192;
  for (let i = 0; i < planViertel; i++) {
    const x = v[i % 96];
    const morgen = i >= 96;
    const pv = morgen ? x.pv * 0.82 : x.pv;
    const last = x.last;
    const rolle = !birken ? null : x.batt > 0.05 ? 'pv_speichern' : x.batt < -0.05 ? 'eigenverbrauch' : 'warten';
    slots.push({
      start: iso(TAG_BEGINN + i * VIERTEL), batteryKw: birken ? x.batt : null, pvKw: pv, loadKw: last, gridKw: last + (birken ? x.batt : 0) - pv,
      socPct: birken ? x.soc : null, priceEurMwh: 92, costEur: 0, baselineCostEur: 0, curtailKw: 0, slotRole: rolle,
      measuredLoadKw: null, measuredPvKw: null,
    });
  }
  const plan = {
    planId: `${site.id}-plan`, deviceId: birken ? `${site.id}-box` : null, generatedAt: now, slotMinutes: 15, savingsEur: birken ? 0.4 : null, bankedValueEur: null,
    socStartPct: birken ? 22 : null, socEndPct: birken ? 22 : null, peakTargetKw: null, effectiveFloorSocPct: birken ? 10 : null, fallback14a: false, slots,
  };
  const weather = {
    runAt: now,
    points: Array.from({ length: 72 }, (_, k) => {
      const ms = TAG_BEGINN + k * 3600_000;
      const h = (k % 24) + 0.5;
      const morgen = k >= 24;
      const g = glocke(h) * (morgen ? 360 : 430);
      return { ts: iso(ms), temperatureC: r2(4 + 6 * Math.max(0, Math.sin((Math.PI * (h - 8)) / 12)) - (morgen ? 1 : 0)), cloudCoverPct: morgen ? 45 : 8, ghiWM2: r2(g), dniWM2: r2(g * 0.8), dhiWM2: r2(g * 0.2) };
    }),
  };

  // Geld des Tages wie im Bild: Unterm Strich = Einspeise-Erlös + Wert des Eigenverbrauchs − Stromkosten.
  const einspEur = (einsp * 7.9) / 100;
  const evEur = (selbst * bezugspreis) / 100;
  const stromEur = (bezug * bezugspreis) / 100;
  const netto = einspEur + evEur - stromEur;
  const money = {
    siteId: site.id, id: site.id, name: site.name, range: 'day', from: iso(TAG_BEGINN), to: iso(ende),
    plantKind: 'eigenverbrauch', tarifArt: 'fest', tarifParamCtKwh: bezugspreis, tarifPriced: true,
    coveredSlots: jetztI, firstCoveredDate: '2026-05-01', reason: null,
    einspeiseErloesEur: r2(einspEur), eigenverbrauchsWertEur: r2(evEur), stromkostenEur: r2(stromEur), nettoErgebnisEur: r2(r2(einspEur) + r2(evEur) - r2(stromEur)),
    savedEur: birken ? 1.86 : 0.0, baselineEur: null, actualEur: null, arbitrageEur: null, pvShiftEur: null,
    savedSpeicherEur: birken ? 1.71 : null, savedSteuerungEur: birken ? 0.15 : null,
    steuerungSplitReason: birken ? null : 'no_battery_data',
    marktpraemieEur: null, bezugspreisCtKwh: bezugspreis, realizedExportCtKwh: 7.9, marketValueSolarCtKwh: null, marketValueProvisional: true,
    bezogenKwh: r2(bezug), eingespeistKwh: r2(einsp), selbstverbrauchKwh: r2(selbst), batterieBewegtKwh: birken ? r2(entladen) : null,
    gesamtertragEur: r2(einspEur + evEur), peakShaving: null, batteryCapacityKwh: birken ? 10 : null, socPct: birken ? Math.round(j.soc ?? 0) : null,
    series: [], daily: [], dailySaved: [], months: [], batteryInvestmentEur: null, paybackYears: null,
  };
  const control = birken
    ? { deviceId: 'birkenweg-box', commandedKw: r2(battJetzt), confirmedKw: r2(battJetzt), allMatch: true, controlEnabled: true, certified: true, mismatchRoles: null, slotStart: now, checkedAt: now, controlSource: 'schedule', executionMode: 'plan', executionPlannedKw: r2(battJetzt) }
    : null;
  const overview = {
    sites: [{
      ...site, deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: now, batteryWithoutDevice: false,
      live: { ts: now, pvKw: r3(pvJetzt), loadKw: r3(hausJetzt), gridKw: r3(netzJetzt), socPct: birken ? Math.round(j.soc ?? 0) : null },
      plannedSavingsTodayEur: null,
      roleCounts: { pv: birken ? 1 : 4, storage: birken ? 1 : 0, consumer: birken ? 2 : 3, grid: 1 },
      energyToday: { pvKwh: r2(pvKwh), loadKwh: r2(lastKwh), gridImportKwh: r2(bezug), gridExportKwh: r2(einsp) },
      anwendungen: birken ? ['speicher_fahrplan', 'monitoring'] : ['monitoring'],
    }],
    totals: { sites: 1, devices: 1, online: 1, liveSitesCovered: 1, plannedSavingsTodayEur: null, storageCapacityKwh: birken ? 10 : 0, storagePowerKw: birken ? 4.6 : 0 },
    dailySavings: [],
  };
  const geraeteHeute: Record<string, number> = {};
  for (const k of Object.keys(j.teile)) geraeteHeute[k] = r2(vorbei.reduce((s, x) => s + x.teile[k] / 4, 0));
  const serieVon = (k: string) => vorbei.map((x) => ({ start: iso(x.start), kw: r3(x.teile[k]) }));
  const serien: Record<string, { start: string; kw: number }[]> = birken
    ? { 'bw-wp': serieVon('wp') }
    : { 'mb-uv-halle': serieVon('halle'), 'mb-uv-keller': serieVon('keller') };
  return {
    lage, now, site, overview, history, plan, weather, money, topology, entities, sources, control,
    usageSignals: { hasStorage: birken, hasPv: true, hasControllableConsumer: false, hasEvCharger: false, hasChargePoint: false, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
    geraeteHeute,
    serien,
    summen: { pvKwh: r2(pvKwh), lastKwh: r2(lastKwh), bezug: r2(bezug), einsp: r2(einsp), laden: r2(laden), entladen: r2(entladen), selbst: r2(selbst), autarkie: r2(autarkie), eigen: eigen == null ? NaN : r2(eigen), netto: r2(r2(einspEur) + r2(evEur) - r2(stromEur)), einspEur: r2(einspEur), evEur: r2(evEur), stromEur: r2(stromEur), pvJetzt: r3(pvJetzt), hausJetzt: r3(hausJetzt), netzJetzt: r3(netzJetzt), battJetzt: r3(battJetzt), soc: j.soc ?? NaN },
  };
}
