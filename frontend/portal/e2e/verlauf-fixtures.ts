/**
 * Fiktive, deterministische Verlaufsdaten für die Prüfbühne `verlauf.html`.
 *
 * Die Hilfe-Fixtures (`help-fixtures.ts`) kennen genau einen Tag; Woche,
 * Monat und Jahr lassen sich damit nicht im Browser prüfen. Dieses Modul
 * rechnet für die Anlage „Sonnenhof“ (10 kWp PV, 20-kWh-Speicher,
 * dynamischer Tarif, feste Einspeisevergütung) jede Viertelstunde von der
 * Inbetriebnahme bis „jetzt“ (10.09.2026, 12:00 Uhr Berlin) und verdichtet
 * sie so, wie es die Antworten von `GET …/history` und `GET …/earnings`
 * tun. Messlücken bleiben Lücken: fehlende Viertelstunden erscheinen als
 * fehlende Eimer, nie als Null.
 *
 * ⚠ Nur für E2E-Bühnen. Das Produktionsbundle importiert dieses Modul nie.
 */
import type { History, HistoryBucket, HistoryEvent, HistoryRange, SiteEarnings, SiteEarningsBucket, SiteEarningsRange } from '../src/api';

export const START = '2025-03-15';
export const TODAY = '2026-09-10';
export const NOW_SLOT = 48;
export const NOW_ISO = '2026-09-10T10:00:00.000Z';

const KWP = 10;
const CAP = 20;
const PMAX = 10;
const ETA = 0.95;
const FEED_CT = 8.0;
const MARKUP_CT = 20.8;

/** Lücken je Tag als Viertelstunden-Bereiche [von, bis). */
const GAPS: Record<string, [number, number][]> = {
  '2026-09-09': [[13, 16]],
  '2026-08-27': [[0, 96]],
  '2026-08-19': [[40, 46]],
};
/** Vorführtage: der 09.09. sonnig mit negativem Mittagspreis, der laufende 10.09. sonnig. */
const FORCE: Record<string, { kind: Wetter; clear: number; dip: number }> = {
  '2026-09-09': { kind: 'sonnig', clear: 0.97, dip: 11.5 },
  '2026-09-10': { kind: 'sonnig', clear: 0.95, dip: 7 },
};

type Wetter = 'sonnig' | 'wechselhaft' | 'bedeckt';
interface Slot {
  state: 'ok' | 'gap' | 'future';
  pv: number; load: number; bat: number; grid: number; soc: number; price: number; netzladen: boolean;
}
interface Day { iso: string; slots: Slot[]; steuFactor: number }

const p2 = (n: number) => String(n).padStart(2, '0');
const toD = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => { const d = toD(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
const ymd = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (iso: string) => (toD(iso).getUTCDay() + 6) % 7;
const doy = (iso: string) => Math.round((toD(iso).getTime() - Date.UTC(ymd(iso).y, 0, 1)) / 864e5) + 1;
const bump = (x: number, c: number, w: number) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

function lastSunday(y: number, month: number): string {
  const d = new Date(Date.UTC(y, month, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return toIso(d);
}
function isDst(iso: string): boolean {
  const { y } = ymd(iso);
  return iso >= lastSunday(y, 3) && iso < lastSunday(y, 10);
}
/** Berliner Wanduhr → UTC-ISO. */
export function berlinToUtc(iso: string, slot = 0): string {
  const { y, m, d } = ymd(iso);
  const off = isDst(iso) ? 2 : 1;
  return new Date(Date.UTC(y, m - 1, d, 0, slot * 15) - off * 3600e3).toISOString();
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

function genDay(iso: string, soc0: number): { day: Day; socEnd: number } {
  const r = mulberry32(seedOf('sonnenhof:' + iso));
  const s = 0.5 + 0.5 * Math.cos((2 * Math.PI * (doy(iso) - 172)) / 365);
  const L = 8.3 + 7.9 * s;
  const noon = isDst(iso) ? 13.3 : 12.3;
  const rise = noon - L / 2;
  const w = r();
  const F = FORCE[iso];
  const kind: Wetter = F?.kind ?? (w < 0.16 + 0.34 * (1 - s) ? 'bedeckt' : w < 0.55 + 0.1 * (1 - s) ? 'wechselhaft' : 'sonnig');
  const clear0 = kind === 'sonnig' ? 0.92 + 0.08 * r() : kind === 'wechselhaft' ? 0.55 + 0.25 * r() : 0.13 + 0.17 * r();
  const clear = F?.clear ?? clear0;
  const peak = KWP * (0.3 + 0.52 * s) * clear;
  const dips: { c: number; w: number; a: number }[] = [];
  const nd = kind === 'sonnig' ? (r() < 0.35 ? 1 : 0) : kind === 'wechselhaft' ? 3 + Math.floor(r() * 3) : 1;
  for (let k = 0; k < nd; k++) dips.push({ c: rise + 1 + r() * (L - 2), w: 0.25 + r() * 0.7, a: 0.2 + r() * 0.45 });
  const we = dow(iso) >= 5;
  const wash = r() < 0.45 ? { st: 9.5 + r() * 4, du: 1.5, p: 1.8 } : null;
  const ev = r() < 0.33 ? (kind !== 'bedeckt' ? { st: 11 + r() * 2, du: 1.5 + r() * 1.5, p: 3.7 } : { st: 18 + r() * 2, du: 1.75, p: 7.2 }) : null;
  const heat = 1.7 * (1 - s) * (kind === 'bedeckt' ? 1.15 : 1);
  const pBase = 8.2 + 3.4 * (1 - s) + (r() - 0.5) * 1.8;
  const dipDepth = F?.dip ?? (2.8 + 8.2 * s) * (kind === 'sonnig' ? 1 : kind === 'wechselhaft' ? 0.6 : 0.2) * (we ? 1.4 : 1);
  const raw: { pv: number; load: number; price: number }[] = [];
  for (let i = 0; i < 96; i++) {
    const t = i / 4 + 0.125;
    let pv = 0;
    const x = (t - rise) / L;
    if (x > 0 && x < 1) {
      pv = peak * Math.pow(Math.sin(Math.PI * x), 1.25);
      for (const dp of dips) pv *= 1 - dp.a * bump(t, dp.c, dp.w);
      pv *= 1 + (r() - 0.5) * 0.06;
    }
    let load = 0.27 + 0.06 * r();
    load += 0.95 * bump(t, 7.1, 0.6) + 1.25 * bump(t, 12.4, 0.45) + 1.35 * bump(t, 19.2, 1.3) + 0.45 * bump(t, 21.6, 0.7);
    load += heat * (0.55 + 0.45 * bump(t, 6.8, 2.6) + 0.45 * bump(t, 19.5, 2.6));
    if (wash && t >= wash.st && t < wash.st + wash.du) load += wash.p * (0.6 + 0.4 * r());
    if (ev && t >= ev.st && t < ev.st + ev.du) load += ev.p;
    if (r() < 0.02) load += 1.2 + r() * 0.9;
    const price = Math.round((pBase + 3.6 * bump(t, 8, 1.1) + 7.2 * bump(t, 19.4, 1.6) - dipDepth * bump(t, 13.3, 2.1) + (r() - 0.5) * 0.9) * 100) / 100;
    raw.push({ pv, load, price });
  }
  let soc = soc0;
  const slots: Slot[] = [];
  for (let i = 0; i < 96; i++) {
    const { pv, load, price } = raw[i];
    const t = i / 4;
    let bat = 0;
    let netzladen = false;
    const surplus = pv - load;
    if (surplus > 0) bat = Math.min(surplus, PMAX, Math.max(0, (((95 - soc) / 100) * CAP * 4) / ETA));
    else {
      const evening = t >= 16.5 || t < 7.5;
      const pricey = price >= pBase + 1.2;
      const avail = Math.max(0, ((soc - 10) / 100) * CAP);
      if (evening || pricey) bat = -Math.min(-surplus, PMAX, avail * 4 * ETA);
    }
    if (price < 0 && soc < 88) {
      const extra = Math.min(4, PMAX - Math.max(bat, 0), Math.max(0, (((90 - soc) / 100) * CAP * 4) / ETA));
      if (extra > 0.3) { bat += extra; netzladen = true; }
    }
    soc += bat > 0 ? ((bat / 4) * ETA * 100) / CAP : ((bat / 4 / ETA) * 100) / CAP;
    soc = clamp(soc, 5, 100);
    slots.push({ state: 'ok', pv, load, bat, grid: load + bat - pv, soc, price, netzladen });
  }
  const gaps = GAPS[iso] ?? [];
  slots.forEach((sl, i) => {
    if (iso === TODAY && i >= NOW_SLOT) sl.state = 'future';
    else if (gaps.some(([a, b]) => i >= a && i < b)) sl.state = 'gap';
  });
  return { day: { iso, slots, steuFactor: 0.052 + (r() - 0.35) * 0.05 }, socEnd: soc };
}

let DAYS: Map<string, Day> | null = null;
function days(): Map<string, Day> {
  if (DAYS) return DAYS;
  DAYS = new Map();
  let soc = 30;
  for (let iso = START; iso <= TODAY; iso = addDays(iso, 1)) {
    const g = genDay(iso, soc);
    DAYS.set(iso, g.day);
    soc = g.socEnd;
  }
  return DAYS;
}

/** Tage eines Zeitraums (Berliner Kalender), Woche ab Montag. */
export function periodDates(range: SiteEarningsRange, at: string): string[] {
  const { y, m } = ymd(at);
  if (range === 'day') return [at];
  if (range === 'week') { const mo = addDays(at, -dow(at)); return Array.from({ length: 7 }, (_, i) => addDays(mo, i)); }
  if (range === 'month') return Array.from({ length: dim(y, m) }, (_, i) => `${y}-${p2(m)}-${p2(i + 1)}`);
  const out: string[] = [];
  if (range === 'year') { for (let d = `${y}-01-01`; d <= `${y}-12-31`; d = addDays(d, 1)) out.push(d); return out; }
  for (let d = START; d <= TODAY; d = addDays(d, 1)) out.push(d);
  return out;
}

interface Acc {
  pv: number; load: number; imp: number; exp: number; chg: number; dis: number;
  ev: number; einsp: number; kosten: number; selfc: number; meas: number; expected: number;
  socMin: number | null; socMax: number | null; socLast: number | null; priceSum: number; priceN: number;
}
const zero = (): Acc => ({ pv: 0, load: 0, imp: 0, exp: 0, chg: 0, dis: 0, ev: 0, einsp: 0, kosten: 0, selfc: 0, meas: 0, expected: 0, socMin: null, socMax: null, socLast: null, priceSum: 0, priceN: 0 });
function add(acc: Acc, sl: Slot) {
  acc.priceSum += sl.price; acc.priceN++;
  if (sl.state === 'future') return;
  acc.expected++;
  if (sl.state !== 'ok') return;
  acc.meas++;
  const bp = Math.max(sl.price + MARKUP_CT, 4);
  const imp = Math.max(sl.grid, 0) / 4;
  const exp = Math.max(-sl.grid, 0) / 4;
  const selfc = Math.max(sl.load / 4 - imp, 0);
  acc.pv += sl.pv / 4; acc.load += sl.load / 4; acc.imp += imp; acc.exp += exp;
  acc.chg += Math.max(sl.bat, 0) / 4; acc.dis += Math.max(-sl.bat, 0) / 4;
  acc.kosten += (imp * bp) / 100; acc.einsp += (exp * FEED_CT) / 100; acc.ev += (selfc * bp) / 100; acc.selfc += selfc;
  acc.socMin = acc.socMin == null ? sl.soc : Math.min(acc.socMin, sl.soc);
  acc.socMax = acc.socMax == null ? sl.soc : Math.max(acc.socMax, sl.soc);
  acc.socLast = sl.soc;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function bucketMinutesFor(range: HistoryRange): number {
  return range === 'day' ? 15 : range === 'week' ? 60 : 1440;
}

/** Die Antwort von `GET /sites/{id}/history` für einen Zeitraum. */
export function historyFor(range: HistoryRange, at: string): History {
  const D = days();
  const dates = periodDates(range, at);
  const bm = bucketMinutesFor(range);
  const per = bm / 15;
  const buckets: HistoryBucket[] = [];
  const total = zero();
  const events: HistoryEvent[] = [];
  for (const iso of dates) {
    const d = D.get(iso);
    if (!d) continue;
    for (let i = 0; i < 96; i += per) {
      const acc = zero();
      for (let k = i; k < i + per; k++) { add(acc, d.slots[k]); add(total, d.slots[k]); }
      if (acc.meas === 0) continue;
      const priceAvg = acc.priceN ? acc.priceSum / acc.priceN : null;
      buckets.push({
        start: berlinToUtc(iso, i), pvKwh: r3(acc.pv), loadKwh: r3(acc.load), gridImportKwh: r3(acc.imp), gridExportKwh: r3(acc.exp),
        batteryChargeKwh: r3(acc.chg), batteryDischargeKwh: r3(acc.dis), socMinPct: acc.socMin, socMaxPct: acc.socMax,
        socLastPct: acc.socLast == null ? null : Math.round(acc.socLast * 10) / 10,
        priceEurMwh: priceAvg == null ? null : Math.round(priceAvg * 100) / 10, costEur: r3(acc.kosten),
      });
    }
    // Ereignis-Spur: Lücken, negativer Börsenpreis, Laden aus dem Netz.
    const runs = (pred: (s: Slot) => boolean) => {
      const out: [number, number][] = []; let a = -1;
      for (let i = 0; i <= 96; i++) { const ok = i < 96 && pred(d.slots[i]); if (ok && a < 0) a = i; if (!ok && a >= 0) { out.push([a, i]); a = -1; } }
      return out;
    };
    runs((s) => s.state === 'gap').forEach(([a, b]) => events.push({ type: 'datenluecke', start: berlinToUtc(iso, a), end: berlinToUtc(iso, b), text: b - a >= 96 ? 'Keine Messwerte, die Box war nicht verbunden' : 'Keine Messwerte' }));
    runs((s) => s.price < 0).forEach(([a, b]) => events.push({ type: 'negativpreis', start: berlinToUtc(iso, a), end: berlinToUtc(iso, b), text: 'Börsenpreis negativ' }));
    runs((s) => s.state === 'ok' && s.netzladen).forEach(([a, b]) => events.push({ type: 'netzladen', start: berlinToUtc(iso, a), end: berlinToUtc(iso, b), text: 'Speicher lädt aus dem Netz' }));
  }
  const first = dates[0];
  const last = dates[dates.length - 1];
  const expectedTo = last >= TODAY ? NOW_ISO : berlinToUtc(addDays(last, 1));
  const has = total.meas > 0;
  return {
    range, from: berlinToUtc(first), to: berlinToUtc(addDays(last, 1)), bucketMinutes: bm, buckets,
    totals: {
      consumptionKwh: has ? r2(total.load) : null, pvGenerationKwh: has ? r2(total.pv) : null,
      gridImportKwh: has ? r2(total.imp) : null, gridExportKwh: has ? r2(total.exp) : null,
      gridCostEur: has ? r2(total.kosten) : null, tarifArt: 'dynamisch', tarifPriced: true,
      batterySavingsPlannedEur: null, steuerungPlannedEur: null,
      autarkiePct: has && total.load > 0 ? Math.round((1 - total.imp / total.load) * 1000) / 10 : null,
      eigenverbrauchPct: has && total.pv > 0 ? Math.round((1 - total.exp / total.pv) * 1000) / 10 : null,
    },
    protocol: [], plan: [],
    coverage: { firstDataAt: berlinToUtc(START), lastDataAt: NOW_ISO, expectedFrom: berlinToUtc(first), expectedTo,
      expectedBuckets: total.expected, measuredBuckets: total.meas, gaps: events.filter((e) => e.type === 'datenluecke').length, resolutionMinutes: 15 },
    events,
  };
}

/** Die Antwort von `GET /sites/{id}/earnings` für einen Zeitraum. */
export function earningsFor(siteId: string, name: string, range: SiteEarningsRange, at: string): SiteEarnings {
  const D = days();
  const dates = periodDates(range, at);
  const total = zero();
  let steu = 0;
  const series: SiteEarningsBucket[] = [];
  const pushBucket = (start: string, acc: Acc) => {
    if (acc.meas === 0) return;
    series.push({ start, einspeiseErloesEur: r2(acc.einsp), eigenverbrauchsWertEur: r2(acc.ev), stromkostenEur: r2(acc.kosten), nettoEur: r2(acc.einsp + acc.ev - acc.kosten) });
  };
  if (range === 'day') {
    const d = D.get(at);
    if (d) for (let hh = 0; hh < 24; hh++) {
      const acc = zero();
      for (let k = hh * 4; k < hh * 4 + 4; k++) { add(acc, d.slots[k]); add(total, d.slots[k]); }
      steu += acc.ev * d.steuFactor;
      pushBucket(berlinToUtc(at, hh * 4), acc);
    }
  } else if (range === 'week' || range === 'month') {
    for (const iso of dates) {
      const d = D.get(iso); if (!d) continue;
      const acc = zero();
      d.slots.forEach((s) => { add(acc, s); add(total, s); });
      steu += acc.ev * d.steuFactor;
      pushBucket(berlinToUtc(iso), acc);
    }
  } else {
    const months = new Map<string, Acc>();
    for (const iso of dates) {
      const d = D.get(iso); if (!d) continue;
      const key = iso.slice(0, 7) + '-01';
      const acc = months.get(key) ?? zero();
      d.slots.forEach((s) => { add(acc, s); add(total, s); });
      const one = zero(); d.slots.forEach((s) => add(one, s));
      steu += one.ev * d.steuFactor;
      months.set(key, acc);
    }
    [...months.entries()].sort().forEach(([k, acc]) => pushBucket(berlinToUtc(k), acc));
  }
  const has = total.meas > 0;
  const n = (v: number) => (has ? r2(v) : null);
  const netto = total.einsp + total.ev - total.kosten;
  return {
    siteId, name, range, from: berlinToUtc(dates[0]), to: dates[dates.length - 1] >= TODAY ? NOW_ISO : berlinToUtc(addDays(dates[dates.length - 1], 1)),
    plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', tarifParamCtKwh: MARKUP_CT, tarifPriced: true, exportVerguetungPriced: true,
    anzulegenderWertCtKwh: null, coveredSlots: total.meas, firstCoveredDate: START, reason: has ? null : 'no_data',
    einspeiseErloesEur: n(total.einsp), eigenverbrauchsWertEur: n(total.ev), stromkostenEur: n(total.kosten), nettoErgebnisEur: n(netto),
    savedEur: has ? r2(r2(steu * 2.1) + r2(steu)) : null, savedSpeicherEur: n(steu * 2.1), savedSteuerungEur: n(steu), steuerungSplitReason: null,
    arbitrageEur: null, pvShiftEur: null, baselineEur: n(total.kosten - total.einsp + steu * 3.1), actualEur: n(total.kosten - total.einsp),
    marktpraemieEur: null, bezugspreisCtKwh: has && total.imp > 0 ? Math.round((total.kosten / total.imp) * 1000) / 10 : null,
    realizedExportCtKwh: has && total.exp > 0 ? FEED_CT : null, marketValueSolarCtKwh: null, marketValueProvisional: null,
    bezogenKwh: n(total.imp), eingespeistKwh: n(total.exp), selbstverbrauchKwh: n(total.selfc), batterieBewegtKwh: n(total.chg + total.dis),
    gesamtertragEur: n(total.einsp + total.ev), expectedMarketValueSolarCtKwh: null, expectedMarketValueFrom: null, expectedMarketValueTo: null, expectedMarketValueSlots: null,
    speicherDeltaKwh: null, speicherWertCtKwh: null, speicherWertEur: null, speicherWertBasis: null,
    series,
    peakShaving: { leistungspreisEurKw: 80, abrechnung: 'jahr', periodStart: '2026-01-01', peakKw: 8, baselinePeakKw: 11.5, avoidedKw: 3.5, avoidedEur: 280,
      history: [{ periodStart: '2025-01-01', peakKw: 8.6, baselinePeakKw: 11.9, avoidedKw: 3.3, avoidedEur: 264 }, { periodStart: '2026-01-01', peakKw: 8, baselinePeakKw: 11.5, avoidedKw: 3.5, avoidedEur: 280 }] },
  };
}
