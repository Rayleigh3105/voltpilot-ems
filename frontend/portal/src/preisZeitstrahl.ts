import type { PriceBucket } from './api';
import { NBSP } from './format';
import { ctFromEurMwh } from './marktpreise';
import { MIN_SPANNE_CT } from './preisFenster';
import { SLOT_DEADBAND_KW } from './schedule';

/**
 * **Der Preis-Zeitstrahl** — die reinen Ableitungen der Preis-Seite
 * (Konzept „Preise und Wetter", Fassung 3; Entscheide E1 bis E8 = A vom
 * 20.10.2026, `data/vp-preise-wetter-konzept-f3`).
 *
 * Die Seite beantwortet in fünf Sekunden zwei Fragen: was kostet Strom JETZT,
 * und wann wird es billiger oder teurer? Dafür gelten vier Regeln, die hier
 * hart verdrahtet sind und die Darstellung nicht aufweichen darf:
 *
 *  1. **Jetzt ist die laufende Viertelstunde** `[start, start + 15 min)`.
 *     Läuft keine, gibt es kein „jetzt" — nie der zuletzt bekannte Preis
 *     (die Regel des früheren Statements).
 *  2. **Nur nach vorn.** Stufen, das günstigste und das teuerste Fenster
 *     rechnen über die KOMMENDEN Viertelstunden (ab jetzt bis zum letzten
 *     bekannten Preis). Ein Fenster, das schon vorbei ist, ist kein Rat.
 *  3. **Drei Stufen im Vergleich** (E2 = A): günstig, mittel, teuer sind je
 *     ein Drittel der kommenden Preise, unter null ist eine eigene Stufe.
 *     Unter {@link MIN_SPANNE_CT} Spanne gibt es keine Stufen und keine
 *     Fenster — auf einem flachen Tag wäre „teuer" eine Behauptung ohne Inhalt.
 *  4. **Fehlend ist keine Null.** Eine Lücke in der Reihe bleibt `null`;
 *     ein Fenster über eine Lücke gibt es nicht.
 */

/** Eine Viertelstunde in Millisekunden. */
export const VIERTEL_MS = 15 * 60_000;

/** Wie viele Viertelstunden das Bild am Telefon VOR jetzt zeigt (E1 = A: 2 Std). */
export const VORLAUF_VIERTEL = 8;

/** Die Länge der zwei Fenster „am günstigsten" und „am teuersten" (2 Std). */
export const FENSTER_VIERTEL = 8;

/** Ab wie vielen bekannten kommenden Preisen eine Stufe etwas aussagt. */
const MIN_STUFEN_WERTE = 8;

export type PreisStufe = 'negativ' | 'guenstig' | 'mittel' | 'teuer';

/** Das EINE Wort je Stufe — im Chip, in der Legende, im Erklär-Blatt. */
export const STUFE_WORT: Readonly<Record<PreisStufe, string>> = {
  negativ: 'unter null',
  guenstig: 'günstig',
  mittel: 'mittel',
  teuer: 'teuer',
};

export interface PreisViertel {
  /** Beginn der Viertelstunde (ms seit Epoche). */
  start: number;
  /** ct/kWh, vorzeichen-ehrlich; `null` = für diese Viertelstunde kein Preis. */
  ct: number | null;
}

export interface PreisBlock {
  /** Erster Index (einschließlich). */
  von: number;
  /** Erster Index NACH dem Block (ausschließlich). */
  bis: number;
  /** Mittlerer Preis in ct/kWh. */
  ct: number;
}

export interface Zeitstrahl {
  /** Lückenlos im 15-Minuten-Raster; Lücken der Reihe sind `null`. */
  viertel: PreisViertel[];
  /** Der Zeitpunkt, für den die Ableitung gilt. */
  jetztMs: number;
  /** Index der laufenden Viertelstunde, `-1` ohne. */
  jetzt: number;
  /** Erster Index, der als „kommend" zählt (jetzt bzw. die erste künftige). */
  ab: number;
  /** Tief und Hoch der kommenden bekannten Preise (Preisleiter), sonst `null`. */
  tief: number | null;
  hoch: number | null;
  /** Obergrenze des günstigen und Untergrenze des teuren Drittels. */
  grenzeGuenstig: number | null;
  grenzeTeuer: number | null;
  /** Keine Stufen: zu wenig Spanne oder zu wenige Werte. */
  flach: boolean;
  /** Die günstigsten bzw. teuersten {@link FENSTER_VIERTEL} ab jetzt. */
  guenstigste: PreisBlock | null;
  teuerste: PreisBlock | null;
}

/** Die Reihe der API (EUR/MWh) als lückenloses Viertelstunden-Raster in ct/kWh. */
export function viertelReihe(buckets: readonly PriceBucket[]): PreisViertel[] {
  const werte = new Map<number, number | null>();
  for (const b of buckets) {
    const start = Date.parse(b.ts);
    if (!Number.isFinite(start)) continue;
    werte.set(start, ctFromEurMwh(b.avgEurMwh));
  }
  if (werte.size === 0) return [];
  const starts = [...werte.keys()].sort((a, b) => a - b);
  const erster = starts[0];
  const letzter = starts[starts.length - 1];
  const out: PreisViertel[] = [];
  for (let t = erster; t <= letzter; t += VIERTEL_MS) {
    out.push({ start: t, ct: werte.has(t) ? (werte.get(t) as number | null) : null });
  }
  return out;
}

function besterBlock(
  viertel: readonly PreisViertel[],
  ab: number,
  richtung: 'min' | 'max',
): PreisBlock | null {
  let treffer: PreisBlock | null = null;
  for (let von = ab; von + FENSTER_VIERTEL <= viertel.length; von++) {
    let summe = 0;
    let luecke = false;
    for (let i = von; i < von + FENSTER_VIERTEL; i++) {
      const ct = viertel[i].ct;
      if (ct == null) {
        luecke = true;
        break;
      }
      summe += ct;
    }
    if (luecke) continue;
    const ct = summe / FENSTER_VIERTEL;
    if (treffer == null || (richtung === 'min' ? ct < treffer.ct : ct > treffer.ct)) {
      treffer = { von, bis: von + FENSTER_VIERTEL, ct };
    }
  }
  return treffer;
}

/**
 * Der Zeitstrahl für `jetzt`. Ohne Preise gibt es keinen (`null`) — die
 * Seite zeigt dann ihren Leer-Zustand, nie ein leeres Bild.
 */
export function zeitstrahl(buckets: readonly PriceBucket[], jetzt: Date): Zeitstrahl | null {
  const viertel = viertelReihe(buckets);
  if (viertel.length === 0) return null;
  const jetztMs = jetzt.getTime();
  const laufend = viertel.findIndex((v) => jetztMs >= v.start && jetztMs < v.start + VIERTEL_MS);
  const ersteKuenftige = viertel.findIndex((v) => v.start > jetztMs);
  const ab = laufend >= 0 ? laufend : ersteKuenftige >= 0 ? ersteKuenftige : viertel.length;

  const kommend = viertel
    .slice(ab)
    .map((v) => v.ct)
    .filter((ct): ct is number => ct != null)
    .sort((a, b) => a - b);
  const tief = kommend.length > 0 ? kommend[0] : null;
  const hoch = kommend.length > 0 ? kommend[kommend.length - 1] : null;
  const flach =
    kommend.length < MIN_STUFEN_WERTE || tief == null || hoch == null || hoch - tief < MIN_SPANNE_CT;
  // Je ein Drittel der kommenden Preise: das günstige Drittel endet beim
  // k-ten Wert von unten, das teure beginnt beim k-ten von oben. So fallen drei
  // gleich große Gruppen auch genau auf drei Stufen.
  const k = Math.ceil(kommend.length / 3);

  // Zwei Fenster brauchen Platz: eins, das den ganzen Rest verschluckt, benennt nichts.
  const genugFuerFenster = !flach && viertel.length - ab >= 2 * FENSTER_VIERTEL;

  return {
    viertel,
    jetztMs,
    jetzt: laufend,
    ab,
    tief,
    hoch,
    grenzeGuenstig: flach ? null : kommend[k - 1],
    grenzeTeuer: flach ? null : kommend[kommend.length - k],
    flach,
    guenstigste: genugFuerFenster ? besterBlock(viertel, ab, 'min') : null,
    teuerste: genugFuerFenster ? besterBlock(viertel, ab, 'max') : null,
  };
}

/** Die Stufe eines Preises im Vergleich der kommenden Stunden. */
export function stufe(z: Zeitstrahl, ct: number): PreisStufe {
  if (ct < 0) return 'negativ';
  if (z.flach || z.grenzeGuenstig == null || z.grenzeTeuer == null) return 'mittel';
  if (ct <= z.grenzeGuenstig) return 'guenstig';
  if (ct >= z.grenzeTeuer) return 'teuer';
  return 'mittel';
}

/** Die Stufe der Viertelstunde `i`: `vorbei` vor jetzt, `null` ohne Preis. */
export function stufeBei(z: Zeitstrahl, i: number): PreisStufe | 'vorbei' | null {
  const v = z.viertel[i];
  if (!v || v.ct == null) return null;
  if (i < z.ab) return 'vorbei';
  return stufe(z, v.ct);
}

/**
 * Bis wohin die Stufe ab `i` gilt — der erste Index mit einer anderen Stufe
 * (oder einer Lücke). Er trägt „günstig · noch bis 15:30".
 */
export function laufEnde(z: Zeitstrahl, i: number): number {
  const s = stufeBei(z, i);
  let j = i;
  while (j < z.viertel.length && stufeBei(z, j) === s) j++;
  return j;
}

/** Ob die Reihe den Folgetag (nach der lokalen Mitternacht von jetzt) trägt. */
export function hatFolgetag(z: Zeitstrahl): boolean {
  const ende = z.viertel[z.viertel.length - 1].start + VIERTEL_MS;
  return ende > naechsteMitternacht(z.jetztMs);
}

/** Lokale Mitternacht NACH `ms`. */
export function naechsteMitternacht(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/** Lokale Mitternacht VOR (oder an) `ms`. */
export function tagesBeginn(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/* ---------------------------------------------------------------------------
 * Speicher laut Plan (E4 = A) — ein schmaler Streifen unter den Balken
 * ------------------------------------------------------------------------- */

export type PlanTun = 'laedt' | 'gibtAb';

export interface PlanSlot {
  start: string;
  batteryKw: number | null;
}

/**
 * Was der Speicher laut Plan je Viertelstunde tut — ausgerichtet auf die
 * Viertel des Zeitstrahls, nur ab jetzt (ein Plan sagt über die Vergangenheit
 * nichts). Vorzeichen wie im ganzen Fahrplan (`schedule.chargeKind`):
 * positiv lädt, negativ gibt ab; dazwischen die Totzone {@link SLOT_DEADBAND_KW}.
 *
 * `null`, wenn der Plan in den gezeigten Stunden gar nichts tut — dann gibt
 * es keinen Streifen und keine Legende, statt einer leeren Zeile.
 */
export function speicherPlan(
  z: Zeitstrahl,
  slots: readonly PlanSlot[],
  slotMinuten: number,
): (PlanTun | null)[] | null {
  if (slots.length === 0 || slotMinuten <= 0) return null;
  const laenge = slotMinuten * 60_000;
  const plan = slots
    .map((s) => ({ start: Date.parse(s.start), kw: s.batteryKw == null ? null : Number(s.batteryKw) }))
    .filter((s) => Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  let irgendwas = false;
  let k = 0;
  const out = z.viertel.map((v, i) => {
    if (i < z.ab) return null;
    while (k < plan.length && plan[k].start + laenge <= v.start) k++;
    const s = plan[k];
    if (!s || s.start > v.start || s.kw == null || !Number.isFinite(s.kw)) return null;
    if (s.kw > SLOT_DEADBAND_KW) {
      irgendwas = true;
      return 'laedt' as const;
    }
    if (s.kw < -SLOT_DEADBAND_KW) {
      irgendwas = true;
      return 'gibtAb' as const;
    }
    return null;
  });
  return irgendwas ? out : null;
}

/* ---------------------------------------------------------------------------
 * Wörter und Zeiten
 * ------------------------------------------------------------------------- */

/** „13:45" in Ortszeit. */
export function uhrzeit(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Das ENDE einer Spanne: an Mitternacht „24:00", sonst die Uhrzeit. */
export function bisUhrzeit(ms: number): string {
  return tagesBeginn(ms) === ms ? '24:00' : uhrzeit(ms);
}

/** „Mi 21.10." */
export function wochentagDatum(ms: number): string {
  const d = new Date(ms);
  const tag = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
  const datum = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `${tag} ${datum}`;
}

/** „Mittwoch, 21.10." */
export function langerTag(ms: number): string {
  const d = new Date(ms);
  const tag = d.toLocaleDateString('de-DE', { weekday: 'long' });
  const datum = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `${tag}, ${datum}`;
}

/** „heute" · „morgen" · „Do 22.10." — der Tag einer Viertelstunde, von jetzt aus. */
export function tagWort(ms: number, jetztMs: number): string {
  const heute = tagesBeginn(jetztMs);
  const tag = tagesBeginn(ms);
  if (tag === heute) return 'heute';
  if (tag === tagesBeginn(naechsteMitternacht(jetztMs))) return 'morgen';
  return wochentagDatum(ms);
}

/** „in 45 Min" · „in 2½ Std" · „vor 1 Std" · „jetzt" — der Abstand zu jetzt. */
export function abstand(ms: number, jetztMs: number): string {
  const min = Math.round((ms - jetztMs) / 60_000);
  if (Math.abs(min) < 1) return 'jetzt';
  const betrag = Math.abs(min);
  let text: string;
  if (betrag < 60) text = `${Math.max(5, Math.round(betrag / 5) * 5)}${NBSP}Min`;
  else {
    const std = Math.round((betrag / 60) * 2) / 2;
    text = `${Math.floor(std)}${std % 1 ? '½' : ''}${NBSP}Std`;
  }
  return min > 0 ? `in ${text}` : `vor ${text}`;
}

/** „jetzt bis 15:45" · „heute 18:00–20:00" · „morgen 07:15–09:15". */
export function blockZeit(z: Zeitstrahl, b: PreisBlock): { tag: string; zeit: string } {
  const von = z.viertel[b.von].start;
  const bis = z.viertel[b.bis - 1].start + VIERTEL_MS;
  if (b.von === z.jetzt) return { tag: 'jetzt bis', zeit: bisUhrzeit(bis) };
  return { tag: tagWort(von, z.jetztMs), zeit: `${uhrzeit(von)}–${bisUhrzeit(bis)}` };
}

/** „14,5" — eine Nachkommastelle, echtes Minus (UEMS-Zahlenformat). */
export function ct1(ct: number): string {
  const text = Math.abs(ct).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return ct < 0 && text !== '0,0' ? `−${text}` : text;
}
