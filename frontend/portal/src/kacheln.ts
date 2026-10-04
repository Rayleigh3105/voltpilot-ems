/**
 * Die **Kacheln unter der Bühne** (Konzept `docs/konzepte/cockpit-tagesfilm`,
 * „Kachelkatalog“) als reine Ableitungen. Die Komponenten in
 * `components/kacheln/` zeichnen nur, was hier steht.
 *
 * Regel des Hauses: **eine Zahl hat einen Ort** (R2). Eine Kachel wiederholt
 * nicht, was die Bühne schon zeigt - Ladestand, Leistung und Netzwert stehen an
 * den Knoten, die Geräte im Blatt des Verbrauchs. Die Kacheln sagen, was der
 * Fluss nicht sagt: den Tag (Autarkie, Eigenverbrauch, Netz heute), den Plan
 * (Speicher, Fahrplan, Handel) und die Umgebung (Sonne, Wetter).
 *
 * Fehlend ist keine Null: ohne Messung gibt es die Kachel nicht bzw. „—“.
 */
import type { HistoryTotals, WeatherPoint } from './api';
import { KNOWN_ROLES, roleLabel, type SlotRole } from './fahrplanWhy';
import { kw, prozent, TOTBAND_KW } from './leitungsplan';
import type { PlanWordingKind } from './schedule';
import { energieBis, uhrzeit, VIERTEL_MS, type Tag } from './tagesleiste';

const ROLLEN = new Set<string>(KNOWN_ROLES);
const n = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : x);

export function istRolle(r: string | null | undefined): r is SlotRole {
  return r != null && ROLLEN.has(r);
}

/* ------------------------------------------------------------ Anteile heute */

export interface AnteilTeil {
  key: 'pv' | 'batt' | 'grid' | 'load';
  label: string;
  pct: number;
}

export interface AnteilKachel {
  /** Die Kennzahl des Tages in Prozent (dieselbe wie im Verlauf). */
  pct: number;
  teile: AnteilTeil[];
}

/**
 * **Autarkie heute**: der Anteil des Verbrauchs, der nicht aus dem Netz kam -
 * dieselbe Rechnung wie der Verlauf (`1 − Bezug / Verbrauch`, `HistoryService`).
 * Der eigene Teil wird nach der bilanziellen Herkunft (Sonne zuerst ins Haus)
 * auf Sonne und Speicher verteilt; die Summe bleibt die Kennzahl.
 */
export function autarkieKachel(totals: HistoryTotals | null | undefined, tag: Tag | null): AnteilKachel | null {
  const pct = n(totals?.autarkiePct);
  if (pct == null) return null;
  const netz = Math.max(0, 100 - pct);
  const teile: AnteilTeil[] = [];
  const h = tag ? energieBis(tag, tag.jetzt).herkunft : null;
  const sonne = h ? h['pv>load'] : 0;
  const speicher = h ? h['batt>load'] : 0;
  if (h && sonne + speicher > 0) {
    teile.push({ key: 'pv', label: 'Sonne', pct: (pct * sonne) / (sonne + speicher) });
    teile.push({ key: 'batt', label: 'Speicher', pct: (pct * speicher) / (sonne + speicher) });
  } else {
    teile.push({ key: 'pv', label: 'selbst', pct });
  }
  teile.push({ key: 'grid', label: 'Netz', pct: netz });
  return { pct, teile };
}

/**
 * **Eigenverbrauch heute**: der Anteil der Erzeugung, der nicht ins Netz ging
 * (`1 − Einspeisung / Erzeugung`, wie im Verlauf). Der eigene Teil verteilt
 * sich bilanziell auf Haus und Speicher.
 */
export function eigenverbrauchKachel(
  totals: HistoryTotals | null | undefined,
  tag: Tag | null,
): (AnteilKachel & { einspeisungKwh: number | null }) | null {
  const pct = n(totals?.eigenverbrauchPct);
  if (pct == null) return null;
  const h = tag ? energieBis(tag, tag.jetzt).herkunft : null;
  const haus = h ? h['pv>load'] : 0;
  const speicher = h ? h['pv>batt'] : 0;
  const teile: AnteilTeil[] = [];
  if (h && haus + speicher > 0) {
    teile.push({ key: 'load', label: 'Haus', pct: (pct * haus) / (haus + speicher) });
    teile.push({ key: 'batt', label: 'Speicher', pct: (pct * speicher) / (haus + speicher) });
  } else {
    teile.push({ key: 'load', label: 'selbst', pct });
  }
  teile.push({ key: 'grid', label: 'Netz', pct: Math.max(0, 100 - pct) });
  return { pct, teile, einspeisungKwh: n(totals?.gridExportKwh) };
}

/** **Netz heute**: Bezug und Einspeisung seit Mitternacht. */
export function netzKachel(totals: HistoryTotals | null | undefined): { bezug: number; einspeisung: number } | null {
  const bezug = n(totals?.gridImportKwh);
  const einspeisung = n(totals?.gridExportKwh);
  if (bezug == null || einspeisung == null) return null;
  return { bezug, einspeisung };
}

/* ---------------------------------------------------------------- Der Plan */

export interface PlanSchritt {
  /** Beginn der Viertelstunde, „16:30“. */
  ab: string;
  rolle: SlotRole;
  text: string;
}

/** Die nächsten Wechsel der Tätigkeit nach `jetzt` (höchstens `max`). */
export function naechsteSchritte(tag: Tag, kind: PlanWordingKind, max: number): PlanSchritt[] {
  const out: PlanSchritt[] = [];
  let akt = tag.viertel[tag.jetzt]?.rolle ?? null;
  for (let i = tag.jetzt + 1; i < tag.viertel.length && out.length < max; i++) {
    const r = tag.viertel[i].rolle;
    if (r == null || r === akt) continue;
    akt = r;
    if (istRolle(r)) out.push({ ab: uhrzeit(tag.viertel[i].start), rolle: r, text: roleLabel(r, kind) });
  }
  return out;
}

/**
 * Was der Speicher laut Plan als Nächstes erreicht - ein Satz mit Plan-Angabe:
 * „Voll gegen 16:30 (erwartet)“, „Reicht bis ca. 21:15 (Plan)“, „Ab 18:00:
 * Verbrauch decken (Plan)“. null ohne Plan.
 */
export function speicherAusblick(tag: Tag, kind: PlanWordingKind): string | null {
  const V = tag.viertel;
  const jetzt = V[tag.jetzt];
  const b = jetzt?.plan?.batt ?? null;
  if (b == null) return null;
  if (b > TOTBAND_KW) {
    for (let i = tag.jetzt + 1; i < V.length; i++) {
      const bi = V[i].plan?.batt;
      if (bi == null) break;
      if (bi <= TOTBAND_KW) {
        const soc = V[i - 1].planSocPct;
        return soc != null && soc >= 99
          ? `Voll gegen ${uhrzeit(V[i].start)} (erwartet)`
          : `Lädt laut Plan bis ${uhrzeit(V[i].start)}${soc != null ? ` auf ${prozent(soc)}` : ''}`;
      }
    }
    return 'Lädt laut Plan bis Mitternacht';
  }
  if (b < -TOTBAND_KW) {
    for (let i = tag.jetzt + 1; i < V.length; i++) {
      const bi = V[i].plan?.batt;
      if (bi == null) break;
      if (bi >= -TOTBAND_KW) {
        const soc = V[i - 1].planSocPct;
        return `Gibt laut Plan bis ${uhrzeit(V[i].start)} ab${soc != null ? `, dann ${prozent(soc)}` : ''}`;
      }
    }
    return 'Gibt laut Plan bis Mitternacht ab';
  }
  const nx = naechsteSchritte(tag, kind, 1)[0];
  return nx ? `Ab ${nx.ab}: ${nx.text} (Plan)` : 'Wartet laut Plan';
}

export interface SpeicherKachelView {
  /** Ladestand jetzt (%); null = nicht gemessen. */
  socPct: number | null;
  /** Was der Speicher gerade tut, als Wort mit Leistung: „lädt 1,9 kW“. */
  zustand: string;
  laedt: boolean;
  /** Die Tätigkeit jetzt laut Plan; null = kein Plan für jetzt. */
  taetigkeit: string | null;
  ausblick: string | null;
  naechster: PlanSchritt | null;
}

/**
 * **Speicher** (wie im Prototyp): Ladestand, was er gerade tut, was der Plan
 * als Nächstes vorhat. Ohne Ladestand und ohne Plan keine Kachel.
 */
export function speicherKachel(tag: Tag | null, kind: PlanWordingKind, socPct: number | null, battKw: number | null): SpeicherKachelView | null {
  const r = tag ? tag.viertel[tag.jetzt]?.rolle : null;
  const ausblick = tag ? speicherAusblick(tag, kind) : null;
  if (socPct == null && !istRolle(r) && ausblick == null) return null;
  const zustand =
    battKw == null ? 'ohne Leistungsmessung' : battKw > TOTBAND_KW ? `lädt ${kw(battKw)}` : battKw < -TOTBAND_KW ? `entlädt ${kw(battKw)}` : 'ruht';
  return {
    socPct,
    zustand,
    laedt: battKw != null && battKw > TOTBAND_KW,
    taetigkeit: istRolle(r) ? roleLabel(r, kind) : null,
    ausblick,
    naechster: tag ? naechsteSchritte(tag, kind, 1)[0] ?? null : null,
  };
}

export interface FahrplanKachelView {
  /** Je Viertelstunde die Rolle (null = kein Plan) und ob sie nach jetzt liegt. */
  ring: { rolle: SlotRole | null; spaeter: boolean }[];
  jetztIndex: number;
  jetzt: string | null;
  schritte: PlanSchritt[];
  legende: { rolle: SlotRole; text: string }[];
  ausblick: string | null;
}

/** **Fahrplan** als Tagesuhr: was der Speicher laut Plan in jeder Viertelstunde tut. */
export function fahrplanKachel(tag: Tag | null, kind: PlanWordingKind): FahrplanKachelView | null {
  if (!tag || !tag.viertel.some((v) => istRolle(v.rolle))) return null;
  const zahl = new Map<SlotRole, number>();
  const ring = tag.viertel.map((v, i) => {
    const rolle = istRolle(v.rolle) ? v.rolle : null;
    if (rolle) zahl.set(rolle, (zahl.get(rolle) ?? 0) + 1);
    return { rolle, spaeter: i > tag.jetzt };
  });
  const r = tag.viertel[tag.jetzt]?.rolle;
  return {
    ring,
    jetztIndex: tag.jetzt,
    jetzt: istRolle(r) ? roleLabel(r, kind) : null,
    schritte: naechsteSchritte(tag, kind, 3),
    legende: [...zahl.entries()].filter(([, c]) => c > 1).map(([rolle]) => ({ rolle, text: roleLabel(rolle, kind) })),
    ausblick: speicherAusblick(tag, kind),
  };
}

export interface HandelFenster {
  von: string;
  bis: string;
  art: 'laden' | 'verkaufen';
  text: string;
  /** Energie im Fenster (kWh) aus Messung bzw. Plan; null = unbekannt. */
  kwh: number | null;
  /** Mittlerer Börsenpreis, gewichtet mit der Energie (ct/kWh). */
  preisCt: number | null;
  stand: 'erledigt' | 'läuft' | 'geplant';
}

/**
 * **Handel**: die Lade- und Verkaufsfenster des Tages mit Energie und mittlerem
 * Preis. Bis jetzt gilt die Messung, danach der Plan. null ohne Fenster.
 */
export function handelKachel(tag: Tag | null, kind: PlanWordingKind): { fenster: HandelFenster[]; spanneCt: number | null } | null {
  if (!tag) return null;
  const V = tag.viertel;
  const fenster: HandelFenster[] = [];
  let i = 0;
  while (i < V.length) {
    const r = V[i].rolle;
    if (r !== 'guenstig_laden' && r !== 'verkaufen') { i++; continue; }
    const a = i;
    let e = 0;
    let pe = 0;
    let bekannt = false;
    let preisBekannt = true;
    while (i < V.length && V[i].rolle === r) {
      const v = V[i];
      const b = i <= tag.jetzt ? v.gemessen?.batt ?? v.plan?.batt : v.plan?.batt;
      const p = i <= tag.jetzt ? v.preisCt ?? v.planPreisCt : v.planPreisCt;
      if (b != null) {
        const x = (Math.abs(b) * VIERTEL_MS) / 3_600_000;
        e += x;
        bekannt = true;
        if (p != null) pe += x * p;
        else preisBekannt = false;
      }
      i++;
    }
    fenster.push({
      von: uhrzeit(V[a].start),
      bis: uhrzeit(V[i - 1].start + VIERTEL_MS),
      art: r === 'guenstig_laden' ? 'laden' : 'verkaufen',
      text: roleLabel(r, kind),
      kwh: bekannt ? e : null,
      preisCt: bekannt && preisBekannt && e > 0 ? pe / e : null,
      stand: i - 1 < tag.jetzt ? 'erledigt' : a <= tag.jetzt ? 'läuft' : 'geplant',
    });
  }
  if (fenster.length === 0) return null;
  const preise = V.map((v) => v.preisCt ?? v.planPreisCt).filter((p): p is number => p != null);
  return { fenster, spanneCt: preise.length > 1 ? Math.max(...preise) - Math.min(...preise) : null };
}

/* ------------------------------------------------------------------- Sonne */

export interface SonneKachelView {
  /** Sonnenstärke jetzt in W/m² (Wettervorhersage am Standort); null = unbekannt. */
  ghi: number | null;
  /** 0..1: Lage der Sonne zwischen erstem und letztem Tageslicht. */
  bogen: number | null;
  /** PV heute gemessen (kWh). */
  heuteKwh: number | null;
  /** Gemessen bis jetzt + Plan danach (kWh); null ohne Plan. */
  erwartetKwh: number | null;
}

/** Die Wetterpunkte des heutigen Tages mit Sonnenstärke. */
function heutePunkte(points: WeatherPoint[], now: Date): WeatherPoint[] {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(a); b.setDate(b.getDate() + 1);
  return points.filter((p) => { const t = Date.parse(p.ts); return t >= a.getTime() && t < b.getTime(); });
}

/** **Sonne**: Sonnenstärke am Standort und die Erzeugung des Tages (gemessen und erwartet). */
export function sonneKachel(points: WeatherPoint[] | null, now: Date, totals: HistoryTotals | null | undefined, tag: Tag | null): SonneKachelView | null {
  const heuteKwh = n(totals?.pvGenerationKwh);
  let ghi: number | null = null;
  let bogen: number | null = null;
  if (points && points.length) {
    const heute = heutePunkte(points, now);
    let best: WeatherPoint | null = null;
    for (const p of heute) {
      if (Date.parse(p.ts) <= now.getTime() && (best == null || Date.parse(p.ts) > Date.parse(best.ts))) best = p;
    }
    ghi = n(best?.ghiWM2);
    const hell = heute.filter((p) => (p.ghiWM2 ?? 0) > 5).map((p) => Date.parse(p.ts));
    if (hell.length > 1) {
      const a = Math.min(...hell);
      const b = Math.max(...hell);
      bogen = Math.min(1, Math.max(0, (now.getTime() - a) / (b - a || 1)));
    }
  }
  let erwartetKwh: number | null = null;
  if (tag && heuteKwh != null) {
    let rest = 0;
    let plan = false;
    for (let i = tag.jetzt + 1; i < tag.viertel.length; i++) {
      const p = tag.viertel[i].plan?.pv;
      if (p != null) { rest += (p * VIERTEL_MS) / 3_600_000; plan = true; }
    }
    if (plan) erwartetKwh = heuteKwh + rest;
  }
  if (ghi == null && heuteKwh == null) return null;
  return { ghi, bogen, heuteKwh, erwartetKwh };
}

/* ------------------------------------------------------------- Lastspitze */

/** Netzbezug je Viertelstunde bis jetzt (für die Tageslinie der Lastspitze). */
export function bezugKurve(tag: Tag | null): (number | null)[] {
  if (!tag) return [];
  return tag.viertel.map((v, i) => (i <= tag.jetzt ? v.gemessen?.grid ?? null : null));
}

/* --------------------------------------------------------------- Steuerung */

export interface SteuerSpalte {
  titel: 'Auftrag' | 'Gerät' | 'Wirkung';
  text: string;
  ton: 'ok' | 'warn' | 'ruhig';
}

/**
 * Die **Steuerzeile** am Fuß der Bühne: Auftrag, Geräteantwort und gemessene
 * Wirkung getrennt (Arbeitsregel „Plan, angenommener Auftrag, Registerantwort
 * und gemessene Wirkung getrennt halten“). Die gemessene Leistung steht am
 * Speicher-Knoten; die Wirkung nennt sie hier nur, wenn sie vom Auftrag
 * abweicht - sonst „wie beauftragt“.
 */
export function steuerSpalten(input: {
  commandedKw: number | null;
  confirmedKw: number | null;
  allMatch: boolean;
  checkedAt: string;
  stale: boolean;
  automatik: boolean;
  gemessenKw: number | null;
}): SteuerSpalte[] {
  const wort = (x: number | null) =>
    x == null ? '—' : x > TOTBAND_KW ? `laden ${kw(x)}` : x < -TOTBAND_KW ? `abgeben ${kw(x)}` : 'pausieren';
  const auftrag = input.automatik ? 'Wechselrichter regelt selbst' : `Speicher ${wort(input.commandedKw)}`;
  const zeit = uhrzeit(Date.parse(input.checkedAt));
  const geraet: SteuerSpalte = input.stale
    ? { titel: 'Gerät', text: `zuletzt bestätigt ${zeit}`, ton: 'ruhig' }
    : input.allMatch
      ? { titel: 'Gerät', text: `bestätigt ${zeit}`, ton: 'ok' }
      : { titel: 'Gerät', text: input.confirmedKw == null ? 'weicht ab' : `meldet ${wort(input.confirmedKw)}`, ton: 'warn' };
  let wirkung: SteuerSpalte;
  const g = input.gemessenKw;
  if (g == null) wirkung = { titel: 'Wirkung', text: 'nicht gemessen', ton: 'ruhig' };
  else if (input.automatik || input.commandedKw == null) wirkung = { titel: 'Wirkung', text: `${g > TOTBAND_KW ? 'lädt' : g < -TOTBAND_KW ? 'entlädt' : 'ruht'}${Math.abs(g) > TOTBAND_KW ? ` ${kw(g)}` : ''} gemessen`, ton: 'ruhig' };
  else {
    const soll = input.commandedKw;
    const abw = Math.abs(g - soll);
    const passt = abw <= Math.max(0.2, Math.abs(soll) * 0.1);
    wirkung = passt
      ? { titel: 'Wirkung', text: 'wie beauftragt gemessen', ton: 'ok' }
      : { titel: 'Wirkung', text: `${g > TOTBAND_KW ? 'lädt' : g < -TOTBAND_KW ? 'entlädt' : 'ruht'}${Math.abs(g) > TOTBAND_KW ? ` ${kw(g)}` : ''} gemessen`, ton: 'warn' };
  }
  return [{ titel: 'Auftrag', text: auftrag, ton: 'ruhig' }, geraet, wirkung];
}
