/**
 * DER SATZBAUKASTEN — Regeln als Sätze (Prototyp `ui-regeln.js`).
 *
 * Eine Regel ist eine AUSNAHME vom Smart-Auftrag eines Geräts: „Wenn … dann
 * … einschalten". Gespeichert wird sie als gewöhnliche Regel der Box über den
 * geführten Baukasten (`flows/guidedBuilder.ts`) - es gibt kein zweites
 * Format, und was hier entsteht, öffnet auch der freie Editor.
 *
 * Bausteine, die der Baukasten heute ausdrücken kann: Börsenpreis,
 * Sonnen-Überschuss (Einspeisung am Netzanschluss), Ladestand des Speichers,
 * Uhrzeit. Die übrigen des Konzepts (günstigste Stunden, Außentemperatur,
 * anderes Gerät, Auto angesteckt) stehen mit „kommt noch“ da und sind nicht
 * wählbar - ein Baustein, der nichts bewirken kann, wird nicht angeboten.
 *
 * Rein und getestet (`regeln.test.ts`).
 */
import { liste } from './liste';
import type { EditorEntity } from '../flows/model';
import type { FlowSummary } from '../flows/flowsApi';
import { parseGuidedFlow } from '../flows/guidedBuilder';
import { istGenerierteVerbraucherregel } from '../regeln/zustand';
import type { GuidedCondition, GuidedRule } from '../flows/guidedBuilder';
import type { GeraetBild, Reihen } from './bild';
import { N, TAG, fCt, fKw, fPct, uhr, zahl1 } from './zeit';

export type VarId = 'preis' | 'rang' | 'sonne' | 'soc' | 'temp' | 'zeit' | 'geraet' | 'auto';
export type Op = 'unter' | 'ueber' | 'zwischen';

export interface Bedingung {
  v: VarId;
  op: Op;
  /** Zahl; bei `zeit` [von, bis) in Viertelstunden. */
  w: number | [number, number];
}

export type Tat = 'an' | 'voll';

export interface RegelEntwurf {
  name: string;
  wenn: Bedingung[];
  oder: boolean;
  dann: { g: string; a: Tat };
  /** Vorhandene Regel (Bearbeiten). */
  flowId?: string;
  version?: number;
}

export interface VarDef {
  kat: string;
  label: string;
  icon: string;
  einheit?: string;
  ops: Op[];
  min?: number;
  max?: number;
  schritt?: number;
  def: number | [number, number];
  /** `null` = wählbar; sonst der Grund, warum nicht. */
  gesperrt: string | null;
}

export interface Bezug {
  /** Der Netzanschluss-Zähler (für den Überschuss). */
  netzId: string | null;
  /** Der Speicher (für den Ladestand). */
  speicherId: string | null;
}

const KOMMT = 'kommt noch';

export function vars(b: Bezug): Record<VarId, VarDef> {
  return {
    preis: { kat: 'Preis', label: 'Börsenpreis', icon: 'euro', einheit: 'ct/kWh', ops: ['unter', 'ueber'], min: -5, max: 40, schritt: 0.5, def: 10, gesperrt: null },
    rang: { kat: 'Preis', label: 'Günstigste Stunden', icon: 'trend', einheit: 'Std', ops: ['unter'], min: 1, max: 8, schritt: 1, def: 3, gesperrt: KOMMT },
    sonne: { kat: 'Sonne', label: 'Sonnen-Überschuss', icon: 'sun', einheit: 'kW', ops: ['ueber', 'unter'], min: 0.5, max: 30, schritt: 0.5, def: 2, gesperrt: b.netzId ? null : 'kein Netzanschluss-Zähler' },
    soc: { kat: 'Speicher', label: 'Ladestand Speicher', icon: 'battery', einheit: '%', ops: ['unter', 'ueber'], min: 5, max: 100, schritt: 5, def: 90, gesperrt: b.speicherId ? null : 'kein Speicher' },
    temp: { kat: 'Wetter', label: 'Außentemperatur', icon: 'thermo', einheit: '°C', ops: ['ueber', 'unter'], min: -10, max: 35, schritt: 1, def: 24, gesperrt: KOMMT },
    zeit: { kat: 'Zeit', label: 'Uhrzeit', icon: 'clock', ops: ['zwischen'], def: [88, 24], gesperrt: null },
    geraet: { kat: 'Geräte', label: 'Anderes Gerät', icon: 'link', ops: ['ueber'], def: 0, gesperrt: KOMMT },
    auto: { kat: 'Geräte', label: 'Auto angesteckt', icon: 'car', ops: ['ueber'], def: 0, gesperrt: KOMMT },
  };
}

export const OP_WORT: Record<Op, string> = { unter: 'unter', ueber: 'über', zwischen: 'zwischen' };

/** Die Wenn-Hälfte eines Bausteins als Satzteil. */
export function bedingungSatz(c: Bedingung): string {
  const w = c.w;
  switch (c.v) {
    case 'preis':
      return `der Börsenpreis ${c.op === 'unter' ? 'unter' : 'über'} ${fCt(w as number)} liegt`;
    case 'sonne':
      return `${c.op === 'ueber' ? 'mehr als' : 'weniger als'} ${fKw(w as number)} Sonnenstrom übrig sind`;
    case 'soc':
      return `der Speicher ${c.op === 'unter' ? 'unter' : 'über'} ${fPct(w as number)} hat`;
    case 'zeit': {
      const [a, b] = w as [number, number];
      return `es zwischen ${uhr(a)} und ${uhr(b)} Uhr ist`;
    }
    default:
      return '…';
  }
}

/** Der Wert eines Bausteins als kurzer Text („10,0 ct/kWh“, „22:00–06:00“). */
export function wertText(c: Bedingung): string {
  if (c.v === 'zeit') {
    const [a, b] = c.w as [number, number];
    return `${uhr(a)}–${uhr(b)}`;
  }
  const w = c.w as number;
  if (c.v === 'preis') return fCt(w);
  if (c.v === 'sonne') return fKw(w);
  if (c.v === 'soc') return fPct(w);
  return zahl1(w);
}

export function tatWort(g: GeraetBild | null, a: Tat): string {
  if (g?.form === 'freigabe') return 'anheben';
  if (a === 'voll') return 'voll einschalten';
  return g?.eintrag.ladepunkt ? 'laden' : 'einschalten';
}

/** Welche Taten ein Gerät kennt (voll nur, wo es Leistung stufenweise kennt). */
export function tatenFuer(g: GeraetBild | null): [Tat, string][] {
  if (!g) return [['an', 'einschalten']];
  const out: [Tat, string][] = [['an', tatWort(g, 'an')]];
  if ((g.form === 'stufig' || g.form === 'stufenlos') && !g.eintrag.ladepunkt && g.nennKw) out.push(['voll', 'voll einschalten']);
  return out;
}

export function regelSatz(r: RegelEntwurf, g: GeraetBild | null): { wenn: string; dann: string } {
  const wenn = `Wenn ${r.wenn.map(bedingungSatz).join(r.oder ? ' oder ' : ' und ')}`;
  const dann = g ? `${g.name} ${tatWort(g, r.dann.a)}` : 'schaltet VoltPilot …';
  return { wenn, dann };
}

// ---------------------------------------------------------------------------
// Umwandlung in den geführten Baukasten und zurück
// ---------------------------------------------------------------------------

const TTL_S = 300;

export function zuGuided(r: RegelEntwurf, b: Bezug, g: GeraetBild | null): GuidedRule | null {
  const conditions: GuidedCondition[] = [];
  for (const c of r.wenn) {
    const w = c.w;
    if (c.v === 'preis') conditions.push({ kind: 'price', direction: c.op === 'unter' ? 'below' : 'above', threshold: w as number, hysteresis: 0.5 });
    else if (c.v === 'sonne') {
      if (!b.netzId) return null;
      // Überschuss = Einspeisung: der Netzanschluss zählt Einspeisung negativ.
      conditions.push({ kind: 'entity', entityId: b.netzId, channel: 'power_kw', direction: c.op === 'ueber' ? 'below' : 'above', threshold: -(w as number), hysteresis: 0.3 });
    } else if (c.v === 'soc') {
      if (!b.speicherId) return null;
      conditions.push({ kind: 'entity', entityId: b.speicherId, channel: 'soc_pct', direction: c.op === 'unter' ? 'below' : 'above', threshold: w as number, hysteresis: 2 });
    } else if (c.v === 'zeit') {
      const [a, e] = w as [number, number];
      conditions.push({ kind: 'schedule', from: uhr(a), to: uhr(e), days: 'alle' });
    } else return null;
  }
  if (!conditions.length) return null;
  const action = r.dann.a === 'voll' && g?.nennKw
    ? { kind: 'setpoint' as const, entityId: r.dann.g, value: g.nennKw, ttlS: TTL_S }
    : { kind: 'onoff' as const, entityId: r.dann.g, ttlS: TTL_S };
  return { conditions, combinator: r.oder ? 'or' : 'and', action };
}

const slotAusHhmm = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Math.round((Number(m[1]) * 60 + Number(m[2])) / 15) % TAG : 0;
};

/** Eine gespeicherte Regel zurück in den Baukasten; `null`, wo er sie nicht fassen kann. */
export function ausGuided(regel: GuidedRule, b: Bezug, name: string): RegelEntwurf | null {
  if (regel.action.kind === 'notify') return null;
  const wenn: Bedingung[] = [];
  for (const c of regel.conditions) {
    if (c.kind === 'price') wenn.push({ v: 'preis', op: c.direction === 'below' ? 'unter' : 'ueber', w: c.threshold });
    else if (c.kind === 'schedule') wenn.push({ v: 'zeit', op: 'zwischen', w: [slotAusHhmm(c.from), slotAusHhmm(c.to)] });
    else if (c.kind === 'entity' && c.channel === 'power_kw' && c.entityId === b.netzId) {
      wenn.push({ v: 'sonne', op: c.direction === 'below' ? 'ueber' : 'unter', w: -c.threshold });
    } else if (c.kind === 'entity' && c.channel === 'soc_pct') {
      wenn.push({ v: 'soc', op: c.direction === 'below' ? 'unter' : 'ueber', w: c.threshold });
    } else return null;
  }
  return {
    name,
    wenn,
    oder: regel.combinator === 'or',
    dann: { g: regel.action.entityId, a: regel.action.kind === 'setpoint' ? 'voll' : 'an' },
  };
}

/** Der Satz einer gespeicherten Regel - auch dort, wo der Baukasten sie nicht bearbeiten kann. */
export function regelSatzAusFlow(regel: GuidedRule, namen: Record<string, string>, nurWenn = false): string {
  const teile = regel.conditions.map((c) => {
    if (c.kind === 'price') return `der Börsenpreis ${c.direction === 'below' ? 'unter' : 'über'} ${fCt(c.threshold)} liegt`;
    if (c.kind === 'schedule') return `es zwischen ${c.from} und ${c.to} Uhr ist`;
    if (c.channel === 'soc_pct') return `der Speicher ${c.direction === 'below' ? 'unter' : 'über'} ${fPct(c.threshold)} hat`;
    if (c.channel === 'power_kw' && c.threshold <= 0) {
      return `${c.direction === 'below' ? 'mehr als' : 'weniger als'} ${fKw(-c.threshold)} Sonnenstrom übrig sind`;
    }
    return `${namen[c.entityId] ?? 'ein Messwert'} ${c.direction === 'below' ? 'unter' : 'über'} ${zahl1(c.threshold)} liegt`;
  });
  const wenn = teile.join(regel.combinator === 'or' ? ' oder ' : ' und ');
  if (nurWenn) return wenn;
  if (regel.action.kind === 'notify') return `Wenn ${wenn}: Nachricht senden.`;
  const n = namen[regel.action.entityId] ?? 'Gerät';
  return `Wenn ${wenn}: ${n} ${regel.action.kind === 'setpoint' ? 'voll einschalten' : 'einschalten'}.`;
}

// ---------------------------------------------------------------------------
// Probelauf: wann greift die Regel heute und morgen?
// ---------------------------------------------------------------------------

/** Gilt eine Bedingung in Viertelstunde t? `null` = unbekannt (kein Wert). */
export function gilt(c: Bedingung, rh: Reihen, t: number): boolean | null {
  switch (c.v) {
    case 'preis': {
      const p = rh.preis[t];
      if (p == null) return null;
      return c.op === 'unter' ? p < (c.w as number) : p > (c.w as number);
    }
    case 'sonne': {
      const n = rh.netz[t];
      if (n == null) return null;
      const ueber = -n;
      return c.op === 'ueber' ? ueber > (c.w as number) : ueber < (c.w as number);
    }
    case 'soc': {
      const s = rh.soc[t];
      if (s == null) return null;
      return c.op === 'unter' ? s < (c.w as number) : s > (c.w as number);
    }
    case 'zeit': {
      const [a, b] = c.w as [number, number];
      const x = t % TAG;
      return a <= b ? x >= a && x < b : x >= a || x < b;
    }
    default:
      return null;
  }
}

/**
 * Die Viertelstunden, in denen die Regel greift. UNBEKANNT ZÄHLT NICHT: ohne
 * Preis für morgen greift eine Preisregel dort nicht - genau wie die Box, die
 * ohne Preis nicht schaltet.
 */
export function greift(r: RegelEntwurf, rh: Reihen, von = 0, bis = N): boolean[] {
  const out: boolean[] = [];
  for (let t = von; t < bis; t++) {
    const w = r.wenn.map((c) => gilt(c, rh, t));
    out.push(r.oder ? w.some((x) => x === true) : w.length > 0 && w.every((x) => x === true));
  }
  return out;
}

export interface Probelauf {
  bits: boolean[];
  treffer: number;
  /** Viertelstunden, in denen das Gerät durch die Regel zusätzlich läuft. */
  mehr: number;
  kwh: number;
  netzKwh: number;
  eur: number;
  unbekannt: boolean;
  niedrigsterPreis: number | null;
}

export function probelauf(r: RegelEntwurf, rh: Reihen, g: GeraetBild | null, von: number): Probelauf {
  const bits = greift(r, rh, von, N);
  const kw = g?.nennKw ?? null;
  let mehr = 0;
  let kwh = 0;
  let netzKwh = 0;
  let eur = 0;
  bits.forEach((b, i) => {
    if (!b) return;
    const t = von + i;
    const schon = (g?.kw[t] ?? 0) > 0.02;
    if (schon) return;
    mehr++;
    if (kw == null) return;
    const e = kw / 4;
    kwh += e;
    // Was die Regel zusätzlich einschaltet, deckt zuerst der Überschuss;
    // der Rest kommt aus dem Netz.
    const frei = Math.max(0, -(rh.netz[t] ?? 0)) / 4;
    const netz = Math.max(0, e - frei);
    netzKwh += netz;
    const p = rh.preis[t];
    if (p != null) eur += (netz * p) / 100;
  });
  const preisBaustein = r.wenn.some((c) => c.v === 'preis');
  const unbekannt = preisBaustein && !rh.morgenBekannt;
  let niedrigster: number | null = null;
  for (let t = von; t < N; t++) {
    const p = rh.preis[t];
    if (p != null && (niedrigster == null || p < niedrigster)) niedrigster = p;
  }
  return { bits, treffer: bits.filter(Boolean).length, mehr, kwh, netzKwh, eur, unbekannt, niedrigsterPreis: niedrigster };
}

// ---------------------------------------------------------------------------
// Vorlagen
// ---------------------------------------------------------------------------

export interface Vorlage {
  id: string;
  titel: string;
  satz: string;
  icon: string;
  farbe: 'price' | 'neg' | 'pv' | 'batt' | 'navy';
  wenn: Bedingung[];
  /** Welche Geräte bevorzugt: Typen in dieser Reihenfolge. */
  typen: string[];
}

export const VORLAGEN: Vorlage[] = [
  { id: 'negativ', titel: 'Negativpreise mitnehmen', satz: 'Wenn der Börsenpreis unter 0 ct liegt: Heizstab einschalten', icon: 'down', farbe: 'neg', wenn: [{ v: 'preis', op: 'unter', w: 0 }], typen: ['heating-rod', 'generic-load', 'pump', 'modbus-load'] },
  { id: 'guenstig', titel: 'Günstig heizen', satz: 'Wenn der Börsenpreis unter 10 ct liegt: Heizstab einschalten', icon: 'euro', farbe: 'price', wenn: [{ v: 'preis', op: 'unter', w: 10 }], typen: ['heating-rod', 'heat-pump-sgready', 'generic-load'] },
  { id: 'mittag', titel: 'Mittagssonne nutzen', satz: 'Wenn mehr als 2 kW Sonnenstrom übrig sind: Pumpe einschalten', icon: 'sun', farbe: 'pv', wenn: [{ v: 'sonne', op: 'ueber', w: 2 }], typen: ['pump', 'generic-load', 'modbus-load', 'heating-rod'] },
  { id: 'voll', titel: 'Speicher voll? Weiter', satz: 'Wenn der Speicher über 90 % hat: Heizstab einschalten', icon: 'battery', farbe: 'batt', wenn: [{ v: 'soc', op: 'ueber', w: 90 }], typen: ['heating-rod', 'generic-load', 'pump'] },
  { id: 'nacht', titel: 'Nachts laufen lassen', satz: 'Wenn es zwischen 22:00 und 06:00 Uhr ist: Gerät einschalten', icon: 'moon', farbe: 'navy', wenn: [{ v: 'zeit', op: 'zwischen', w: [88, 24] }], typen: ['pump', 'generic-load', 'modbus-load'] },
];

/** Das Zielgerät einer Vorlage: das erste schaltbare Gerät des bevorzugten Typs. */
export function vorlagenZiel(v: Vorlage, ziele: GeraetBild[]): GeraetBild | null {
  for (const typ of v.typen) {
    const g = ziele.find((x) => x.typ === typ);
    if (g) return g;
  }
  return ziele[0] ?? null;
}

/** Vorlagen, die auf dieser Anlage gehen (Bausteine wählbar, ein Gerät da). */
export function vorlagenFuer(b: Bezug, ziele: GeraetBild[]): Vorlage[] {
  const v = vars(b);
  return VORLAGEN.filter((x) => x.wenn.every((c) => v[c.v].gesperrt == null) && vorlagenZiel(x, ziele) != null);
}

/** Die Geräte, die eine Regel schalten kann (an/aus über die Box). */
export function regelZiele(alle: GeraetBild[], editor: EditorEntity[] | null): GeraetBild[] {
  const schaltbar = new Set(liste(editor).filter((e) => e.actuate.includes('on_off') || e.actuate.includes('setpoint_kw')).map((e) => e.id));
  return alle.filter((g) => !g.eintrag.ladepunkt && (schaltbar.has(g.id) || !editor));
}

export function bezugAus(editor: EditorEntity[] | null): Bezug {
  const netz = liste(editor).find((e) => e.entityType === 'grid-meter' && e.measure.includes('power_kw')) ?? null;
  const sp = liste(editor).find((e) => e.measure.includes('soc_pct')) ?? null;
  return { netzId: netz?.id ?? null, speicherId: sp?.id ?? null };
}

export function neuerEntwurf(ziele: GeraetBild[], opts: { geraet?: string; vorlage?: string } = {}): RegelEntwurf {
  const v = opts.vorlage ? VORLAGEN.find((x) => x.id === opts.vorlage) : null;
  const g = opts.geraet ? ziele.find((x) => x.id === opts.geraet) ?? null : v ? vorlagenZiel(v, ziele) : ziele[0] ?? null;
  return {
    name: v ? v.titel : g ? `${g.name} bei günstigem Preis` : 'Neue Regel',
    wenn: v ? v.wenn.map((c) => ({ ...c })) : [{ v: 'preis', op: 'unter', w: 10 }],
    oder: false,
    dann: { g: g?.id ?? '', a: 'an' },
  };
}

// ---------------------------------------------------------------------------
// Die Regeln der Anlage als Karten
// ---------------------------------------------------------------------------

export interface RegelKarte {
  flowId: string;
  name: string;
  satz: { wenn: string; dann: string } | null;
  freiText: string;
  an: boolean;
  entwurf: RegelEntwurf | null;
  version: number;
}

export function regelKarten(flows: FlowSummary[] | null, bezug: Bezug, namen: Record<string, string>): RegelKarte[] {
  const out: RegelKarte[] = [];
  for (const f of liste(flows)) {
    if (istGenerierteVerbraucherregel(f.latestDocument)) continue;
    const guided = parseGuidedFlow(f.latestDocument);
    const entwurf = guided ? ausGuided(guided, bezug, f.name) : null;
    let satz: RegelKarte['satz'] = null;
    if (guided) {
      const s = regelSatzAusFlow(guided, namen);
      const i = s.indexOf(': ');
      satz = i > 0 ? { wenn: s.slice(0, i), dann: s.slice(i + 2).replace(/\.$/, '') } : { wenn: s, dann: '' };
    }
    out.push({
      flowId: f.flowId,
      name: f.name,
      satz,
      freiText: 'Im freien Editor gebaut',
      an: f.activeVersion != null,
      entwurf: entwurf ? { ...entwurf, flowId: f.flowId, version: f.latestVersion } : null,
      version: f.latestVersion,
    });
  }
  return out;
}

