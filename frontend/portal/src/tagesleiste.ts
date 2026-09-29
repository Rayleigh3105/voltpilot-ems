/**
 * Die Tagesleiste des Cockpits (Konzept `docs/konzepte/cockpit-tagesfilm`):
 * der heutige Tag in Viertelstunden. Bis „jetzt“ stehen Messwerte aus
 * `/history?range=day`, danach der Plan aus `/schedule`. Reine Ableitung; die
 * Komponente `Tagesleiste.tsx` zeichnet sie.
 *
 * Messung und Plan bleiben getrennt: eine Viertelstunde hat `gemessen` ODER
 * `plan` (oder beides, dann gilt bis jetzt die Messung). Fehlt ein Wert, steht
 * er als `null` da - nie als erfundene 0.
 */
import type { History, HistoryBucket, SchedulePlan, ScheduleSlot } from './api';
import {
  herkunftMoment,
  herkunftSumme,
  PAARE,
  type FlussEnergie,
  type FlussWerte,
  type Herkunft,
} from './leitungsplan';

export const VIERTEL_MS = 15 * 60 * 1000;

export interface Viertel {
  i: number;
  start: number;
  /** Mittlere Leistung der gemessenen Viertelstunde (kW), null = keine Messung. */
  gemessen: FlussWerte | null;
  /** Energie der gemessenen Viertelstunde, nach Richtung getrennt (kWh). */
  energie: FlussEnergie | null;
  socPct: number | null;
  preisCt: number | null;
  /** Geplante Leistung (kW) laut Fahrplan, null = kein Plan. */
  plan: FlussWerte | null;
  planSocPct: number | null;
  planPreisCt: number | null;
  /** Tätigkeit des Plans (slotRole), null = unbekannt. */
  rolle: string | null;
}

export interface Tag {
  beginn: number;
  viertel: Viertel[];
  /** Index der Viertelstunde, in der „jetzt“ liegt. */
  jetzt: number;
  /** Größte Leistung des Tages (Messung und Plan) - Maßstab der Spuren. */
  maxKw: number;
}

function mitternacht(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Anzahl Viertelstunden des lokalen Tages (Sommerzeit-Wechsel: 92 bzw. 100). */
export function viertelProTag(now: Date): number {
  const a = mitternacht(now);
  const b = new Date(a.getTime());
  b.setDate(b.getDate() + 1);
  return Math.round((b.getTime() - a.getTime()) / VIERTEL_MS);
}

const n = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : x);

function energieAus(b: HistoryBucket, teil: number): FlussEnergie {
  const s = (x: number | null) => (x == null ? null : x * teil);
  return {
    pv: s(n(b.pvKwh)),
    load: s(n(b.loadKwh)),
    laden: s(n(b.batteryChargeKwh)),
    abgeben: s(n(b.batteryDischargeKwh)),
    bezug: s(n(b.gridImportKwh)),
    einspeisung: s(n(b.gridExportKwh)),
  };
}

function leistungAus(e: FlussEnergie): FlussWerte {
  const k = 4; // kWh je Viertelstunde → mittlere kW
  const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : (a - b) * k);
  return {
    pv: e.pv == null ? null : e.pv * k,
    load: e.load == null ? null : e.load * k,
    batt: diff(e.laden, e.abgeben),
    grid: diff(e.bezug, e.einspeisung),
  };
}

function planAus(s: ScheduleSlot): FlussWerte {
  return { pv: n(s.pvKw), load: n(s.loadKw), batt: n(s.batteryKw), grid: n(s.gridKw) };
}

/** Den heutigen Tag aus Verlauf und Fahrplan zusammensetzen. */
export function tagAus(history: History | null, plan: SchedulePlan | null, now: Date = new Date()): Tag {
  const beginn = mitternacht(now).getTime();
  const anzahl = viertelProTag(now);
  const viertel: Viertel[] = Array.from({ length: anzahl }, (_, i) => ({
    i,
    start: beginn + i * VIERTEL_MS,
    gemessen: null,
    energie: null,
    socPct: null,
    preisCt: null,
    plan: null,
    planSocPct: null,
    planPreisCt: null,
    rolle: null,
  }));
  const idx = (iso: string) => Math.floor((Date.parse(iso) - beginn) / VIERTEL_MS);
  if (history) {
    const je = Math.max(1, Math.round((history.bucketMinutes || 15) / 15));
    for (const b of history.buckets) {
      const i0 = idx(b.start);
      for (let k = 0; k < je; k++) {
        const v = viertel[i0 + k];
        if (!v) continue;
        const e = energieAus(b, 1 / je);
        const leer = Object.values(e).every((x) => x == null);
        if (leer) continue;
        v.energie = e;
        v.gemessen = leistungAus(e);
        v.socPct = n(b.socLastPct);
        v.preisCt = b.priceEurMwh == null ? null : b.priceEurMwh / 10;
      }
    }
  }
  if (plan) {
    const je = Math.max(1, Math.round((plan.slotMinutes || 15) / 15));
    for (const s of plan.slots) {
      const i0 = idx(s.start);
      for (let k = 0; k < je; k++) {
        const v = viertel[i0 + k];
        if (!v) continue;
        v.plan = planAus(s);
        v.planSocPct = n(s.socPct);
        v.planPreisCt = s.priceEurMwh == null ? null : s.priceEurMwh / 10;
        v.rolle = s.slotRole ?? null;
      }
    }
  }
  const jetzt = Math.min(anzahl - 1, Math.max(0, Math.floor((now.getTime() - beginn) / VIERTEL_MS)));
  let maxKw = 0;
  for (const v of viertel) {
    for (const w of [v.gemessen, v.plan]) {
      if (!w) continue;
      for (const x of [w.pv, w.load, w.batt, w.grid]) if (x != null) maxKw = Math.max(maxKw, Math.abs(x));
    }
  }
  return { beginn, viertel, jetzt, maxKw };
}

export interface TagesEnergie {
  energie: FlussEnergie;
  herkunft: Herkunft;
  /** Mindestens eine Viertelstunde bis dahin ohne vollständige Messung. */
  unvollstaendig: boolean;
}

/** Energie des Tages bis einschließlich Viertelstunde `bis` (nur Messwerte). */
export function energieBis(tag: Tag, bis: number): TagesEnergie {
  const s: FlussEnergie = { pv: null, load: null, laden: null, abgeben: null, bezug: null, einspeisung: null };
  const teile: (Herkunft | null)[] = [];
  let unvollstaendig = false;
  for (const v of tag.viertel.slice(0, bis + 1)) {
    if (!v.energie) { unvollstaendig = true; continue; }
    for (const k of Object.keys(s) as (keyof FlussEnergie)[]) {
      const x = v.energie[k];
      if (x != null) s[k] = (s[k] ?? 0) + x;
    }
    const h = herkunftMoment({
      pv: v.energie.pv,
      load: v.energie.load,
      batt: v.energie.laden == null || v.energie.abgeben == null ? null : v.energie.laden - v.energie.abgeben,
      grid: v.energie.bezug == null || v.energie.einspeisung == null ? null : v.energie.bezug - v.energie.einspeisung,
    });
    if (!h) unvollstaendig = true;
    teile.push(h);
  }
  return { energie: s, herkunft: herkunftSumme(teile), unvollstaendig };
}

/** Größter Tageswert (Energie) - Maßstab der Spuren bei „Heute“. */
export function tagesSkala(e: TagesEnergie): number {
  const x = e.energie;
  const w = [x.pv, x.load, (x.laden ?? 0) + (x.abgeben ?? 0), (x.bezug ?? 0) + (x.einspeisung ?? 0)];
  let m = 0;
  for (const v of w) if (v != null) m = Math.max(m, v);
  for (const p of PAARE) m = Math.max(m, e.herkunft[p]);
  return m;
}

/** „13:45“ für eine Viertelstunde. */
export function uhrzeit(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Höchster gemessener Netzbezug einer Viertelstunde bis `bis` (kW). */
export function hoechsterBezug(tag: Tag, bis: number): number | null {
  let m: number | null = null;
  for (const v of tag.viertel.slice(0, bis + 1)) {
    const g = v.gemessen?.grid;
    if (g != null) m = Math.max(m ?? 0, g);
  }
  return m;
}
