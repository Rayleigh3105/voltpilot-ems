/**
 * Gestellte Antworten der Bühne „Abrechnung prüfen“ (`abrechnung.tsx`): deterministische Tageswerte zweier
 * Haushalte aus `cockpit-privat-daten.ts` und daraus — wie der Server — `/history` (vier Zeiträume und der freie
 * Zeitraum) und `/abrechnung`.
 *
 * - **Haus Birkenweg** (privat, alle Geräte: PV 9,8 kWp, Speicher 10 kWh, Wärmepumpe, Netzzähler mit
 *   Zählerständen), gemessen seit dem 01.03.2025.
 * - **Haus am Mühlbach** (Beobachtung wie Schramm: vier Wechselrichter, zwei Unterverteilungen, kein Speicher,
 *   Zählerstände nur vom Shelly am Netzanschluss), gemessen seit dem 07.11.2026.
 *
 * `fall`: `zaehler` (Vorgabe), `summe` (kein Zähler, drei Lückentage 12.–14.02.2026), `nurbezug` (keine
 * Einspeisung). ⚠ Nur für E2E-Bühnen; das Produktionsbundle importiert dieses Modul nie.
 */
import type { Abrechnung, AbrechnungZeile, History, HistoryBucket, HistoryRange } from '../src/api';

export type Anlage = 'birkenweg' | 'muehlbach';
export type Fall = 'zaehler' | 'summe' | 'nurbezug';

/** „Jetzt“ der Bühne: Sa., 14.11.2026, 11:00 Uhr Berlin. */
export const JETZT_ISO = '2026-11-14T10:00:00Z';
export const HEUTE = '2026-11-14';

const MESSBEGINN: Record<Anlage, string> = { birkenweg: '2025-03-01', muehlbach: '2026-11-07' };
const KWP: Record<Anlage, number> = { birkenweg: 9.8, muehlbach: 74 };
/** Zählerstand am Ende des Tages vor dem Messbeginn (Bezug, Einspeisung). */
const STAND0: Record<Anlage, [number, number]> = { birkenweg: [9_871.4, 27_342.8], muehlbach: [42_612.3, 80_951.6] };
const LUECKE = new Set(['2026-02-12', '2026-02-13', '2026-02-14']);

interface Tag {
  pv: number;
  load: number;
  imp: number;
  exp: number;
  /** `null` ohne Speicher — fehlend ist keine Null. */
  chg: number | null;
  dis: number | null;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mitternacht Berlin eines Tages als UTC-Zeitstempel (MEZ/MESZ). */
export function berlin(iso: string, minuten = 0): string {
  const probe = new Date(`${iso}T12:00:00Z`);
  const off = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' })
      .formatToParts(probe)
      .find((p) => p.type === 'timeZoneName')
      ?.value.replace('GMT', '') || '1',
  );
  const t = Date.parse(`${iso}T00:00:00Z`) - off * 3_600_000 + minuten * 60_000;
  return new Date(t).toISOString();
}

function zufall(iso: string, salz: number): number {
  let h = salz;
  for (const c of iso) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 1000) + 0.5) / 1000;
}

/** Die Werte eines Tages, `null` vor dem Messbeginn, ab heute und an Lückentagen (Fall `summe`). */
export function tag(anlage: Anlage, iso: string, fall: Fall): Tag | null {
  if (iso < MESSBEGINN[anlage] || iso >= HEUTE) return null;
  if (fall === 'summe' && LUECKE.has(iso)) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
  const saison = 0.5 - 0.5 * Math.cos((2 * Math.PI * (doy - 10)) / 365);
  const wetter = 0.35 + 0.75 * zufall(iso, 7);
  const pv = KWP[anlage] * (0.35 + 4.4 * saison) * wetter;
  if (anlage === 'muehlbach') {
    const load = 210 + 60 * zufall(iso, 11) - 40 * saison;
    // Mittags läuft auch im Winter etwas ins Netz (Wochenende, Sonnenspitzen).
    const exp = pv * (0.12 + 0.3 * saison);
    const direkt = Math.min(pv - exp, load);
    return { pv: r3(pv), load: r3(load), imp: r3(load - direkt), exp: r3(pv - direkt), chg: null, dis: null };
  }
  const load = 19 + 16 * (1 - saison) + 6 * zufall(iso, 3);
  const direkt = Math.min(pv, load * 0.4);
  const chg = Math.min(pv - direkt, 9.5);
  const dis = chg * 0.9;
  const exp = pv - direkt - chg;
  const imp = Math.max(0, load - direkt - dis);
  return { pv: r3(pv), load: r3(load), imp: r3(imp), exp: r3(fall === 'nurbezug' ? 0 : exp), chg: r3(chg), dis: r3(dis) };
}

function bucket(start: string, t: Tag, teil = 1, soc: number | null = null): HistoryBucket {
  return {
    start,
    pvKwh: r3(t.pv * teil),
    loadKwh: r3(t.load * teil),
    gridImportKwh: r3(t.imp * teil),
    gridExportKwh: r3(t.exp * teil),
    batteryChargeKwh: t.chg == null ? null : r3(t.chg * teil),
    batteryDischargeKwh: t.dis == null ? null : r3(t.dis * teil),
    socMinPct: soc,
    socMaxPct: soc,
    socLastPct: soc,
    priceEurMwh: null,
    costEur: null,
  };
}

function summe(bs: HistoryBucket[], f: keyof HistoryBucket): number | null {
  let s: number | null = null;
  for (const b of bs) {
    const v = b[f];
    if (typeof v === 'number') s = (s ?? 0) + v;
  }
  return s == null ? null : Math.round(s * 1000) / 1000;
}

function antwort(
  anlage: Anlage,
  range: History['range'],
  von: string,
  bisExkl: string,
  bucketMinutes: number,
  buckets: HistoryBucket[],
  tageMitDaten: number,
): History {
  const load = summe(buckets, 'loadKwh');
  const pv = summe(buckets, 'pvKwh');
  const imp = summe(buckets, 'gridImportKwh');
  const exp = summe(buckets, 'gridExportKwh');
  const erwartetVon = von < MESSBEGINN[anlage] ? MESSBEGINN[anlage] : von;
  const erwartetBis = bisExkl > HEUTE ? HEUTE : bisExkl;
  const erwartet = Math.max(0, Math.round((Date.parse(erwartetBis) - Date.parse(erwartetVon)) / 86_400_000)) * 96;
  return {
    range,
    from: berlin(von),
    to: berlin(bisExkl),
    bucketMinutes,
    buckets,
    totals: {
      consumptionKwh: load,
      pvGenerationKwh: pv,
      gridImportKwh: imp,
      gridExportKwh: exp,
      gridCostEur: null,
      tarifArt: 'fest',
      tarifPriced: true,
      batterySavingsPlannedEur: null,
      steuerungPlannedEur: null,
      autarkiePct: load && imp != null ? Math.round((1 - imp / load) * 1000) / 10 : null,
      eigenverbrauchPct: pv && exp != null ? Math.round((1 - exp / pv) * 1000) / 10 : null,
    },
    protocol: [],
    plan: [],
    coverage: {
      firstDataAt: berlin(MESSBEGINN[anlage]),
      lastDataAt: JETZT_ISO,
      expectedFrom: berlin(erwartetVon),
      expectedTo: berlin(erwartetBis),
      expectedBuckets: erwartet,
      measuredBuckets: Math.min(erwartet, tageMitDaten * 96),
      gaps: tageMitDaten * 96 < erwartet ? 1 : 0,
      resolutionMinutes: 15,
    },
    events: [],
  } as History;
}

function tage(von: string, bisEinschl: string): string[] {
  const out: string[] = [];
  for (let d = von; d <= bisEinschl; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Die Antwort von `GET …/history?range=&at=`. */
export function historyFuer(anlage: Anlage, fall: Fall, range: HistoryRange, at: string): History {
  const a = new Date(`${at}T12:00:00Z`);
  let von: string;
  let bisExkl: string;
  if (range === 'day') {
    von = at;
    bisExkl = addDays(at, 1);
  } else if (range === 'week') {
    von = addDays(at, -((a.getUTCDay() + 6) % 7));
    bisExkl = addDays(von, 7);
  } else if (range === 'month') {
    von = `${at.slice(0, 7)}-01`;
    bisExkl = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  } else {
    von = `${at.slice(0, 4)}-01-01`;
    bisExkl = `${Number(at.slice(0, 4)) + 1}-01-01`;
  }
  const buckets: HistoryBucket[] = [];
  let n = 0;
  for (const iso of tage(von, addDays(bisExkl, -1))) {
    const t = tag(anlage, iso, fall);
    if (!t) continue;
    n++;
    if (range === 'day' || range === 'week') {
      const schritt = range === 'day' ? 15 : 60;
      const anzahl = 1440 / schritt;
      for (let i = 0; i < anzahl; i++) {
        const stunde = (i * schritt) / 60;
        const sonne = Math.max(0, Math.sin(((stunde - 6) / 12) * Math.PI));
        const pvTeil = sonne / (anzahl * (2 / Math.PI) * 0.5);
        const lastTeil = 1 / anzahl;
        buckets.push({
          ...bucket(berlin(iso, i * schritt), t, lastTeil),
          pvKwh: r3(t.pv * pvTeil),
          gridExportKwh: r3(t.exp * pvTeil),
          batteryChargeKwh: t.chg == null ? null : r3(t.chg * pvTeil),
        });
      }
    } else {
      buckets.push(bucket(berlin(iso), t, 1, anlage === 'birkenweg' ? 55 : null));
    }
  }
  return antwort(anlage, range, von, bisExkl, range === 'day' ? 15 : range === 'week' ? 60 : 1440, buckets, n);
}

/** Die Antwort von `GET …/history?from=&to=`: Tage bis 92, sonst Monate (`bucketMinutes = 0`). */
export function historyZeitraum(anlage: Anlage, fall: Fall, von: string, bis: string): History {
  const liste = tage(von, bis);
  const jeTag: HistoryBucket[] = [];
  for (const iso of liste) {
    const t = tag(anlage, iso, fall);
    if (t) jeTag.push(bucket(berlin(iso), t, 1, anlage === 'birkenweg' ? 55 : null));
  }
  let buckets = jeTag;
  if (liste.length > 92) {
    const monate = new Map<string, HistoryBucket[]>();
    for (const b of jeTag) {
      const key = new Date(b.start).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7);
      monate.set(key, [...(monate.get(key) ?? []), b]);
    }
    buckets = [...monate.entries()].map(([m, bs]) => {
      const start = `${m}-01` < von ? berlin(von) : berlin(`${m}-01`);
      return {
        start,
        pvKwh: summe(bs, 'pvKwh'),
        loadKwh: summe(bs, 'loadKwh'),
        gridImportKwh: summe(bs, 'gridImportKwh'),
        gridExportKwh: summe(bs, 'gridExportKwh'),
        batteryChargeKwh: summe(bs, 'batteryChargeKwh'),
        batteryDischargeKwh: summe(bs, 'batteryDischargeKwh'),
        socMinPct: bs[0].socMinPct,
        socMaxPct: bs[0].socMaxPct,
        socLastPct: bs[bs.length - 1].socLastPct,
        priceEurMwh: null,
        costEur: null,
      };
    });
  }
  return antwort(anlage, 'zeitraum', von, addDays(bis, 1), liste.length > 92 ? 0 : 1440, buckets, jeTag.length);
}

/** Die Antwort von `GET …/abrechnung` — dieselbe Regel wie `AbrechnungRegel` auf dem Server. */
export function abrechnungFuer(anlage: Anlage, fall: Fall, von: string, bis: string): Abrechnung {
  const beginn = MESSBEGINN[anlage];
  const zeile = (feld: 'imp' | 'exp', stand0: number): AbrechnungZeile => {
    // Stand am Ende des Vortags: Startstand + alles seit Messbeginn bis dahin.
    let vorher = stand0;
    for (let d = beginn; d < von; d = addDays(d, 1)) vorher += tag(anlage, d, fall)?.[feld] ?? 0;
    let menge: number | null = null;
    let erster: string | null = null;
    const luecken: { von: string; bis: string }[] = [];
    for (const d of tage(von, bis)) {
      const t = tag(anlage, d, fall);
      if (t) {
        menge = (menge ?? 0) + t[feld];
        erster ??= d;
      } else if (d >= beginn && d < HEUTE) {
        const letzte = luecken[luecken.length - 1];
        if (letzte && addDays(letzte.bis, 1) === d) letzte.bis = d;
        else luecken.push({ von: d, bis: d });
      }
    }
    const fehlend = luecken.reduce((n, l) => n + Math.round((Date.parse(l.bis) - Date.parse(l.von)) / 86_400_000) + 1, 0);
    if (menge == null) {
      return { mengeKwh: null, herkunft: null, standVonKwh: null, standBisKwh: null, zaehlerFaellt: false, fehlendeTage: fehlend, luecken };
    }
    if (fall === 'summe') {
      return { mengeKwh: r3(menge), herkunft: 'summe', standVonKwh: null, standBisKwh: null, zaehlerFaellt: false, fehlendeTage: fehlend, luecken };
    }
    return { mengeKwh: r3(menge), herkunft: 'zaehler', standVonKwh: r3(vorher), standBisKwh: r3(vorher + menge), zaehlerFaellt: false, fehlendeTage: 0, luecken: [] };
  };
  const vorBeginn = beginn > von ? Math.min(Math.round((Date.parse(beginn) - Date.parse(von)) / 86_400_000), Math.round((Date.parse(bis) - Date.parse(von)) / 86_400_000) + 1) : 0;
  return {
    von,
    bis,
    tage: Math.round((Date.parse(bis) - Date.parse(von)) / 86_400_000) + 1,
    messbeginn: beginn,
    tageVorMessbeginn: vorBeginn,
    bezug: zeile('imp', STAND0[anlage][0]),
    einspeisung: fall === 'nurbezug' ? null : zeile('exp', STAND0[anlage][1]),
    rechnung: null,
  };
}
