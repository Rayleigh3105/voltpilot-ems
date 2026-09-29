/**
 * Der Leitungsplan: die reine Ableitung hinter dem Cockpit-Energiefluss
 * (Konzept `docs/konzepte/cockpit-tagesfilm`, dritte Fassung).
 *
 * Vier feste Plätze: Sonne oben, Haus unten, Speicher links, Netz rechts. Jede
 * der sieben möglichen Verbindungen ist eine eigene Spur in der Farbe ihrer
 * HERKUNFT und so breit wie ihre Leistung (bzw. Energie bei „Heute“). Die
 * Spuren laufen gebündelt zum Hausanschluss in der Mitte und biegen dort ab.
 *
 * Diese Datei rechnet nur: Herkunft je Weg (bilanziell), Breiten, Pfade und
 * die Beschriftung in Worten. Die Komponente `Leitungsplan.tsx` rendert das
 * Ergebnis. Fehlend ist keine Null: fehlt eine Rolle, gibt es für sie weder
 * Spur noch erfundene Zahl.
 */
import { NBSP } from './format';

/** Unter diesem Betrag gibt es keine Spur (wie überall im Portal). */
export const TOTBAND_KW = 0.05;
export const TOTBAND_KWH = 0.05;

export type Rolle = 'pv' | 'batt' | 'grid' | 'load';
export type Paar =
  | 'pv>load'
  | 'pv>batt'
  | 'pv>grid'
  | 'batt>load'
  | 'batt>grid'
  | 'grid>load'
  | 'grid>batt';

export const PAARE: readonly Paar[] = [
  'pv>load',
  'pv>batt',
  'pv>grid',
  'batt>load',
  'batt>grid',
  'grid>load',
  'grid>batt',
];

/** Zeichenreihenfolge: die waagrechten Spuren zuerst, die senkrechte kreuzt darüber. */
export const ZEICHEN_REIHENFOLGE: readonly Paar[] = [
  'batt>grid',
  'grid>batt',
  'pv>load',
  'pv>batt',
  'pv>grid',
  'batt>load',
  'grid>load',
];

export const PAAR_TEXT: Record<Paar, string> = {
  'pv>load': 'Sonne ins Haus',
  'pv>batt': 'Sonne in den Speicher',
  'pv>grid': 'Sonne ins Netz',
  'batt>load': 'Speicher ins Haus',
  'batt>grid': 'Speicher ins Netz',
  'grid>load': 'Netz ins Haus',
  'grid>batt': 'Netz in den Speicher',
};

export function quelleVon(p: Paar): Exclude<Rolle, 'load'> {
  return p.split('>')[0] as Exclude<Rolle, 'load'>;
}

/**
 * Ein Moment des Flusses. Leistung in kW (jetzt, eine Viertelstunde) oder
 * Energie in kWh (heute bis jetzt) - die Rechnung ist dieselbe.
 * Vorzeichen wie `LiveSnapshot`: Speicher + = lädt, Netz + = Bezug.
 */
export interface FlussWerte {
  pv: number | null;
  load: number | null;
  /** + lädt, − gibt ab. */
  batt: number | null;
  /** + Bezug, − Einspeisung. */
  grid: number | null;
}

/** Energie getrennt nach Richtung (für „Heute“: Speicher und Netz fließen in beide Richtungen). */
export interface FlussEnergie {
  pv: number | null;
  load: number | null;
  laden: number | null;
  abgeben: number | null;
  bezug: number | null;
  einspeisung: number | null;
}

export type Herkunft = Record<Paar, number>;

function leer(): Herkunft {
  return {
    'pv>load': 0,
    'pv>batt': 0,
    'pv>grid': 0,
    'batt>load': 0,
    'batt>grid': 0,
    'grid>load': 0,
    'grid>batt': 0,
  };
}

/**
 * Herkunft bilanziell, mit Vorrang: Sonne zuerst ins Haus, dann in den
 * Speicher, dann ins Netz; Speicherentladung zuerst ins Haus; Netzbezug zuerst
 * ins Haus, dann in den Speicher. Alle Eingänge sind Beträge ≥ 0.
 */
export function verteile(
  pv: number,
  load: number,
  laden: number,
  abgeben: number,
  bezug: number,
  einspeisung: number,
): Herkunft {
  const P = leer();
  let a = Math.max(pv, 0);
  let L = Math.max(load, 0);
  let C = Math.max(laden, 0);
  let E = Math.max(einspeisung, 0);
  let D = Math.max(abgeben, 0);
  let I = Math.max(bezug, 0);
  let v = Math.min(a, L); P['pv>load'] = v; a -= v; L -= v;
  v = Math.min(a, C); P['pv>batt'] = v; a -= v; C -= v;
  v = Math.min(a, E); P['pv>grid'] = v; a -= v; E -= v;
  v = Math.min(D, L); P['batt>load'] = v; D -= v; L -= v;
  v = Math.min(D, E); P['batt>grid'] = v; D -= v; E -= v;
  v = Math.min(I, L); P['grid>load'] = v; I -= v; L -= v;
  v = Math.min(I, C); P['grid>batt'] = v;
  return P;
}

/**
 * Herkunft eines Moments (kW oder kWh einer Viertelstunde). null = unvollständig:
 * fehlt eine Rolle (auch die Speicherleistung), erfindet der Fluss keine
 * Aufteilung. Eine Anlage OHNE Speicher trägt dort 0, nicht null.
 */
export function herkunftMoment(w: FlussWerte): Herkunft | null {
  const x = w;
  if (x.pv == null || x.load == null || x.grid == null || x.batt == null) return null;
  return verteile(
    x.pv,
    x.load,
    Math.max(x.batt, 0),
    Math.max(-x.batt, 0),
    Math.max(x.grid, 0),
    Math.max(-x.grid, 0),
  );
}

/** Summe der Herkunft über mehrere Viertelstunden (Energie „heute“). */
export function herkunftSumme(teile: (Herkunft | null)[]): Herkunft {
  const s = leer();
  for (const t of teile) {
    if (!t) continue;
    for (const p of PAARE) s[p] += t[p];
  }
  return s;
}

/* ------------------------------------------------------------------ Geometrie */

export interface Geometrie {
  /** Breite der Fläche in px. */
  w: number;
  h: number;
  /** Knotenradius (Sonne, Netz, Haus). */
  r: number;
  /** Speicher als Batterie: Breite und Höhe. */
  bw: number;
  bh: number;
  cx: number;
  sonneY: number;
  hubY: number;
  hausY: number;
  speicherX: number;
  netzX: number;
  /** Breiteste Spur in px (bei der größten Leistung des Tages). */
  maxBreite: number;
  luecke: number;
  radius: number;
  /** Abstand der Beschriftung neben Sonne und Haus. */
  abstand: number;
  stufe: 'eng' | 'telefon' | 'breit';
}

/** Die Lage der Knoten: am Telefon eng, am Rechner breiter. */
export function geometrie(breitePx: number): Geometrie {
  const w = Math.max(220, Math.round(breitePx));
  const cx = Math.round(w / 2);
  if (w >= 560) {
    return {
      w, cx, stufe: 'breit', r: 32, bw: 36, bh: 56, sonneY: 48, hubY: 180, hausY: 318, h: 364,
      speicherX: Math.round(w * 0.17), netzX: Math.round(w * 0.83), maxBreite: 16, luecke: 3, radius: 22, abstand: 12,
    };
  }
  if (w < 300) {
    return {
      w, cx, stufe: 'eng', r: 22, bw: 26, bh: 40, sonneY: 34, hubY: 138, hausY: 280, h: 312,
      speicherX: 24, netzX: w - 24, maxBreite: 10, luecke: 2, radius: 12, abstand: 8,
    };
  }
  return {
    w, cx, stufe: 'telefon', r: 26, bw: 30, bh: 46, sonneY: 40, hubY: 150, hausY: 272, h: 306,
    speicherX: 34, netzX: w - 34, maxBreite: 12, luecke: 2, radius: 16, abstand: 12,
  };
}

/**
 * Breite je Spur als Anteil der größten Leistung des Tages (bei „Heute“ des
 * größten Tageswerts): so bleiben Spuren über den Tag vergleichbar.
 * Ergebnis 0..1; 0 = keine Spur (unter dem Totband).
 */
export function anteile(h: Herkunft | null, skala: number, totband: number): Record<Paar, number> {
  const out = {} as Record<Paar, number>;
  for (const p of PAARE) {
    const x = h ? h[p] : 0;
    out[p] = x > totband && skala > 0 ? Math.min(1, x / skala) : 0;
  }
  return out;
}

export interface Spur {
  paar: Paar;
  d: string;
  breite: number;
  /** Punkte nur auf Spuren, die breit genug sind (sonst wirken sie wie eine gestrichelte Planlinie). */
  punkte: boolean;
  punktBreite: number;
}

export interface SpurBild {
  spuren: Spur[];
  /** Heller Rand der senkrechten Spur über der waagrechten Kreuzung, null = keine Kreuzung. */
  kreuzung: { d: string; breite: number } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Spuren legen: Sonne → Haus bleibt in der senkrechten Mitte, Speicher ↔ Netz
 * in der waagrechten. Die übrigen liegen außen daneben und biegen am
 * Hausanschluss mit Radius ab. Pfadrichtung = Flussrichtung (Quelle → Ziel).
 */
export function spurBild(a: Record<Paar, number>, g: Geometrie): SpurBild {
  const W = {} as Record<Paar, number>;
  for (const p of PAARE) W[p] = a[p] > 0.0005 ? Math.max(1.5, g.maxBreite * a[p]) : 0;
  const gp = g.luecke;
  const cx = g.cx;
  const hy = g.hubY;
  const wpl = W['pv>load'];
  const wbg = W['batt>grid'];
  const wgb = W['grid>batt'];
  const vL = wpl ? cx - wpl / 2 - gp : cx - gp / 2;
  const vR = wpl ? cx + wpl / 2 + gp : cx + gp / 2;
  const M = wbg + wgb + (wbg && wgb ? gp : 0);
  const hT = M ? hy - M / 2 - gp : hy - gp / 2;
  const hB = M ? hy + M / 2 + gp : hy + gp / 2;
  const D = {} as Record<Paar, string>;
  D['pv>load'] = `M${cx},${g.sonneY}V${g.hausY}`;
  D['batt>grid'] = `M${g.speicherX},${r1(hy - M / 2 + wbg / 2)}H${g.netzX}`;
  D['grid>batt'] = `M${g.netzX},${r1(hy + M / 2 - wgb / 2)}H${g.speicherX}`;
  let w = W['pv>batt'];
  let x = r1(vL - w / 2);
  let y = r1(hT - w / 2);
  let r = g.radius + w / 2;
  D['pv>batt'] = `M${x},${g.sonneY}V${r1(y - r)}Q${x},${y} ${r1(x - r)},${y}H${g.speicherX}`;
  w = W['pv>grid']; x = r1(vR + w / 2); y = r1(hT - w / 2); r = g.radius + w / 2;
  D['pv>grid'] = `M${x},${g.sonneY}V${r1(y - r)}Q${x},${y} ${r1(x + r)},${y}H${g.netzX}`;
  w = W['batt>load']; x = r1(vL - w / 2); y = r1(hB + w / 2); r = g.radius + w / 2;
  D['batt>load'] = `M${g.speicherX},${y}H${r1(x - r)}Q${x},${y} ${x},${r1(y + r)}V${g.hausY}`;
  w = W['grid>load']; x = r1(vR + w / 2); y = r1(hB + w / 2); r = g.radius + w / 2;
  D['grid>load'] = `M${g.netzX},${y}H${r1(x + r)}Q${x},${y} ${x},${r1(y + r)}V${g.hausY}`;
  const spuren: Spur[] = [];
  for (const p of ZEICHEN_REIHENFOLGE) {
    if (!W[p]) continue;
    spuren.push({
      paar: p,
      d: D[p],
      breite: r1(W[p]),
      punkte: W[p] >= 2.5,
      punktBreite: r1(Math.min(3, Math.max(1.2, W[p] * 0.4))),
    });
  }
  const kreuzung =
    wpl && M
      ? { d: `M${cx},${r1(hy - M / 2 - 0.5)}V${r1(hy + M / 2 + 0.5)}`, breite: r1(wpl + 2 * gp + 1) }
      : null;
  return { spuren, kreuzung };
}

/* ------------------------------------------------------------ Beschriftung */

const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Betrag mit einer Nachkommastelle wie überall im Portal. Richtung steht nie als Minus. */
export function zahl(x: number): string {
  return NF1.format(Math.abs(x));
}
export function kw(x: number | null): string {
  return x == null ? '—' : `${zahl(x)}${NBSP}kW`;
}
export function kwh(x: number | null): string {
  return x == null ? '—' : `${zahl(x)}${NBSP}kWh`;
}
export function prozent(x: number | null): string {
  return x == null ? '—' : `${NF0.format(x)}${NBSP}%`;
}

export type Ansicht = 'jetzt' | 'heute';
/** Was die Uhrzeit zeigt: jetzt (live), gemessen (zurückgezogen) oder Plan (nach jetzt). */
export type Zeitbezug = 'live' | 'gemessen' | 'plan';

export interface KnotenText {
  rolle: Rolle;
  /** Der fette Wert. */
  wert: string;
  /** Zeilen darunter, in Worten. */
  zeilen: string[];
  /** Für Vorlesen und Titel. */
  aria: string;
  /** Sonne ohne Erzeugung wird grau. */
  ruhig: boolean;
}

export interface KnotenEingabe {
  ansicht: Ansicht;
  zeit: Zeitbezug;
  /** Jetzt: kW; Heute: kWh. */
  werte: FlussWerte;
  /** Nur „Heute“: Energie getrennt nach Richtung. */
  energie?: FlussEnergie | null;
  socPct: number | null;
  /** Lastspitzenkappung: Ziel für den Netzbezug in kW. */
  zielKw?: number | null;
  /** Marktoptimierung: Börsenpreis der Viertelstunde in ct/kWh. */
  preisCt?: number | null;
  /** Der Wechselrichter hat den Fahrplan-Sollwert bestätigt. */
  bestaetigt?: boolean;
}

function ct(x: number): string {
  return `${NF1.format(x)}${NBSP}ct/kWh`;
}

export function knotenTexte(e: KnotenEingabe): Record<Rolle, KnotenText> {
  const w = e.werte;
  const heute = e.ansicht === 'heute';
  const f = heute ? kwh : kw;
  const erw = e.zeit === 'plan' ? ' erwartet' : '';
  const plan = e.zeit === 'plan' ? ' · Plan' : '';
  const t = (rolle: Rolle, name: string, wert: string, zeilen: string[], ruhig = false): KnotenText => ({
    rolle,
    wert,
    zeilen,
    ruhig,
    aria: `${name}: ${wert}, ${zeilen.join(', ')}`,
  });
  const pvAn = w.pv != null && w.pv > TOTBAND_KW;
  const pv = t(
    'pv',
    'Sonne',
    f(w.pv),
    [heute ? 'erzeugt' : w.pv == null ? 'Erzeugung' : (pvAn ? 'Erzeugung' : 'keine Erzeugung') + erw],
    !heute && w.pv != null && !pvAn,
  );
  const load = t('load', 'Haus', f(w.load), [heute ? 'verbraucht' : 'Verbrauch' + erw]);
  let batt: KnotenText;
  if (heute) {
    const en = e.energie;
    batt = t('batt', 'Speicher', prozent(e.socPct), [
      `geladen ${kwh(en?.laden ?? null)}`,
      `abgegeben ${kwh(en?.abgeben ?? null)}`,
    ]);
  } else {
    const b = w.batt;
    const zustand =
      b == null ? 'ohne Messung' : b > TOTBAND_KW ? `lädt ${kw(b)}` : b < -TOTBAND_KW ? `entlädt ${kw(b)}` : 'ruht';
    const zeilen = [zustand + plan];
    if (e.bestaetigt && e.zeit === 'live' && b != null && Math.abs(b) > TOTBAND_KW) zeilen.push('Sollwert bestätigt');
    batt = t('batt', 'Speicher', prozent(e.socPct), zeilen);
  }
  let grid: KnotenText;
  if (heute) {
    const en = e.energie;
    grid = t('grid', 'Netz', kwh(en?.bezug ?? null), ['bezogen', `${kwh(en?.einspeisung ?? null)} eingespeist`]);
  } else {
    const g = w.grid;
    const wort = g == null ? 'ohne Messung' : g > TOTBAND_KW ? 'Bezug' : g < -TOTBAND_KW ? 'Einspeisung' : 'ausgeglichen';
    const zeilen = [wort + plan];
    if (e.zielKw != null) zeilen.push(`Ziel ${kw(e.zielKw)}`);
    if (e.preisCt != null) zeilen.push(`Börse ${ct(e.preisCt)}`);
    grid = t('grid', 'Netz', g == null ? '—' : kw(Math.abs(g)), zeilen);
  }
  return { pv, load, batt, grid };
}

/** Füllung der Ziel-Skala am Netz (0..1): Bezug im Verhältnis zum Ziel. */
export function zielAnteil(gridKw: number | null, zielKw: number | null | undefined): number | null {
  if (gridKw == null || zielKw == null || zielKw <= 0) return null;
  return Math.min(1, Math.max(0, gridKw) / zielKw);
}

/* --------------------------------------------------------------- Der Satz */

export type Betrieb = 'eigenverbrauch' | 'markt' | 'spitze';

export interface SatzEingabe {
  betrieb: Betrieb;
  ansicht: Ansicht;
  zeit: Zeitbezug;
  werte: FlussWerte;
  herkunft: Herkunft | null;
  energie?: FlussEnergie | null;
  /** „bis 13:52“ bzw. „13:52“ */
  uhr: string;
  zielKw?: number | null;
  /** Höchste Viertelstunde heute (Lastspitze), kW. */
  hoechsteKw?: number | null;
  preisCt?: number | null;
}

/** Ein Satz zum Moment. Er beschreibt, was gemessen (oder geplant) ist - nie eine erfundene Ursache. */
export function satz(e: SatzEingabe): string | null {
  const w = e.werte;
  const P = e.herkunft;
  if (e.ansicht === 'heute') {
    const en = e.energie;
    if (!en) return null;
    if (e.betrieb === 'markt') {
      return `Bis ${e.uhr} in den Speicher geladen: ${kwh(en.laden)}, abgegeben: ${kwh(en.abgeben)}. Erzeugt: ${kwh(en.pv)}.`;
    }
    if (e.betrieb === 'spitze') {
      return `Bis ${e.uhr} aus dem Netz: ${kwh(en.bezug)}.` +
        (e.hoechsteKw != null ? ` Höchste Viertelstunde: ${kw(e.hoechsteKw)}` + (e.zielKw != null ? `, Ziel ${kw(e.zielKw)}.` : '.') : '');
    }
    return `Bis ${e.uhr} erzeugt: ${kwh(en.pv)}, verbraucht: ${kwh(en.load)}, davon aus dem Netz: ${kwh(en.bezug)}.`;
  }
  if (!P || w.pv == null || w.load == null || w.grid == null || w.batt == null) return null;
  const pre = e.zeit === 'plan' ? 'Plan: ' : '';
  const chg = Math.max(w.batt, 0);
  const dis = Math.max(-w.batt, 0);
  const imp = Math.max(w.grid, 0);
  const exp = Math.max(-w.grid, 0);
  const T = TOTBAND_KW;
  if (e.betrieb === 'spitze') {
    const s = `${pre}Netzbezug ${kw(imp)}` + (e.zielKw != null ? `, Ziel ${kw(e.zielKw)}.` : '.');
    if (dis > T) return `${s} Der Speicher gibt ${kw(dis)} ab.`;
    if (chg > T) return `${s} Der Speicher lädt mit ${kw(chg)} nach.`;
    return `${s} Der Speicher wartet.`;
  }
  if (e.betrieb === 'markt') {
    const pr = e.preisCt != null ? ` Börsenpreis ${ct(e.preisCt)}.` : '';
    if (chg > T) {
      const aus = P['grid>batt'] > T ? (P['pv>batt'] > T ? ' aus Netz und Sonne' : ' aus dem Netz') : ' mit Sonnenstrom';
      return `${pre}Der Speicher lädt mit ${kw(chg)}${aus}.${pr}`;
    }
    if (dis > T) {
      return `${pre}Der Speicher gibt ${kw(dis)} ab` + (P['batt>grid'] > T ? `, ${kw(P['batt>grid'])} davon gehen ins Netz.` : '.') + pr;
    }
    return `${pre}Der Speicher wartet.` + (exp > T ? ' Sonnenstrom geht ins Netz.' : '') + pr;
  }
  const p2 = e.zeit === 'plan' ? (chg > T || dis > T ? 'Plan: ' : 'Erwartet: ') : '';
  if (w.pv > T && P['pv>load'] >= w.load - T) {
    const ziel: string[] = [];
    if (chg > T) ziel.push('in den Speicher');
    if (exp > T) ziel.push('ins Netz');
    return `${p2}Die Sonne deckt den ganzen Verbrauch.` + (ziel.length ? ` Der Überschuss geht ${ziel.join(' und ')}.` : '');
  }
  if (w.pv > T) {
    const eigen = w.load > 0 ? (100 * (P['pv>load'] + P['batt>load'])) / w.load : 0;
    return `${p2}Sonne${dis > T ? ' und Speicher decken ' : ' deckt '}${prozent(eigen)} des Verbrauchs` +
      (imp > T ? ', der Rest kommt aus dem Netz.' : '.');
  }
  if (dis > T) {
    return `${p2}Der Speicher deckt ` + (imp > T ? 'einen Teil des Verbrauchs, der Rest kommt aus dem Netz.' : 'den Verbrauch.');
  }
  if (w.load <= T) return `${p2}Gerade fließt kaum Strom.`;
  return `${p2}Das Netz deckt den Verbrauch.`;
}
