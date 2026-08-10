import type { Kernaussage } from './chartKopf';
import { ctFromEurMwh } from './marktpreise';

/**
 * Die EINE Preis-Grammatik — benannte, ZUSAMMENHÄNGENDE Preisfenster
 * (Chart-Redesign Stufe 4, M3'; Scout `vp-charts-verstaendlich-r2` §6 C).
 *
 * Sie ersetzt zwei Kodierungen, die beide eine Bedienungsanleitung brauchten
 * (K10) und deshalb aus dem Portal verschwinden:
 *
 *  - den **Ampel-`visualMap`** der Marktpreise (grün → orange → rot über 96
 *    Balken): eine Farbskala ohne Skala, also ein Rätsel;
 *  - den **JS-Farbverlauf** desselben Musters im Cockpit-Streifen.
 *
 * An ihrer Stelle steht die ruhige Preis-Linie plus höchstens drei benannte
 * Fenster, jedes MIT SEINEM WORT im Bild. Marktpreise-Seite und
 * Cockpit-Streifen lesen dieselbe Funktion, also können sie über denselben Tag
 * nichts Verschiedenes behaupten.
 *
 * Vier Regeln, die nicht wegoptimiert werden dürfen:
 *
 *  1. **Zusammenhängend, nie slot-weise.** Die Revision 1 schattierte jedes
 *     Quartil-Viertelstündchen einzeln und malte damit einen „Kamm aus grünen
 *     Strichen" (r2 §2 Befund ⑤). Ein Fenster ist hier immer EIN Block.
 *  2. **Das Fallenwort „Viertel" kommt nicht vor** (K4): im Energie-Portal
 *     liest es sich als Viertel*stunde*. Benannt wird die ZEITSPANNE („die
 *     günstigsten 2½ Stunden").
 *  3. **Kein Fenster ohne Substanz.** Zu wenige Slots, keine Preise, oder eine
 *     Tagesspanne unter {@link MIN_SPANNE_CT} → gar kein Fenster. Auf einem
 *     flachen Tag ist „die teuersten 2½ Stunden" eine Behauptung ohne Inhalt.
 *  4. **Überlappungsfrei.** Ein Negativfenster ERSETZT das günstige, wenn sie
 *     sich berühren — zwei Bänder übereinander wären wieder der Kamm.
 */

/** Die Länge eines benannten Fensters in Minuten (2½ Stunden). */
export const FENSTER_MINUTEN = 150;

/**
 * Unter dieser Tagesspanne (ct/kWh) gibt es kein „teuer"/„günstig" — dieselbe
 * Schwelle, mit der der Cockpit-Streifen sein Urteil zurückhält
 * (`strompreis.FLACH_SPANNE_CT`), damit die zwei Flächen nicht verschieden
 * streng sind.
 */
export const MIN_SPANNE_CT = 5;

export type FensterArt = 'guenstig' | 'teuer' | 'negativ';

export interface PreisFenster {
  art: FensterArt;
  /** Erster Slot-Index (einschließlich). */
  von: number;
  /** Letzter Slot-Index (EINSCHLIESSLICH). */
  bis: number;
  /** Das Wort, das IM Bild steht („die günstigsten 2½ Stunden"). */
  wort: string;
  /** Mittlerer Preis des Fensters in ct/kWh. */
  ct: number;
}

/**
 * „2½ Stunden" · „3 Stunden" · „45 Minuten" — die Zeitspanne als Wort. Nur
 * die halbe Stunde bekommt ihren Bruch, alles andere wird glatt benannt.
 */
export function spanneWort(minuten: number): string {
  if (minuten < 60) return `${minuten} Minuten`;
  const stunden = minuten / 60;
  if (Number.isInteger(stunden)) return `${stunden} Stunde${stunden === 1 ? '' : 'n'}`;
  const ganz = Math.floor(stunden);
  const rest = minuten - ganz * 60;
  if (rest === 30) return `${ganz}½ Stunden`;
  return `${(Math.round(stunden * 10) / 10).toLocaleString('de-DE')} Stunden`;
}

/** Das Wort eines Fensters — nie „Viertel" (K4). */
export function fensterWort(art: FensterArt, slots: number, slotMinuten: number): string {
  if (art === 'negativ') return 'Strom kostet nichts';
  const spanne = spanneWort(slots * slotMinuten);
  return art === 'guenstig' ? `die günstigsten ${spanne}` : `die teuersten ${spanne}`;
}

/** Mittel über einen Indexbereich; `null`, sobald eine Lücke darin liegt. */
function mittel(cts: readonly (number | null)[], von: number, bis: number): number | null {
  let summe = 0;
  for (let i = von; i <= bis; i++) {
    const v = cts[i];
    if (v == null) return null;
    summe += v;
  }
  return summe / (bis - von + 1);
}

/** Der zusammenhängende Block der Länge `len` mit dem kleinsten/größten Ø. */
function besterBlock(
  cts: readonly (number | null)[],
  len: number,
  richtung: 'min' | 'max',
): { von: number; bis: number; ct: number } | null {
  if (len <= 0 || cts.length < len) return null;
  let treffer: { von: number; bis: number; ct: number } | null = null;
  for (let i = 0; i + len <= cts.length; i++) {
    const m = mittel(cts, i, i + len - 1);
    if (m == null) continue;
    if (
      treffer == null ||
      (richtung === 'min' ? m < treffer.ct : m > treffer.ct)
    ) {
      treffer = { von: i, bis: i + len - 1, ct: m };
    }
  }
  return treffer;
}

/** Der LÄNGSTE zusammenhängende Lauf mit Preis < 0. */
function negativLauf(cts: readonly (number | null)[]): { von: number; bis: number } | null {
  let best: { von: number; bis: number } | null = null;
  let start = -1;
  for (let i = 0; i <= cts.length; i++) {
    const negativ = i < cts.length && cts[i] != null && (cts[i] as number) < 0;
    if (negativ) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const lauf = { von: start, bis: i - 1 };
      if (best == null || lauf.bis - lauf.von > best.bis - best.von) best = lauf;
      start = -1;
    }
  }
  return best;
}

/**
 * Die benannten Fenster einer Preisreihe (ct/kWh je Slot, Lücken als `null`).
 *
 * Höchstens ZWEI Bänder: das günstige (bzw. das negative, das es ersetzt) und
 * das teure. Ein Tag ohne Spanne bekommt gar keins.
 */
export function preisFenster(
  cts: readonly (number | null)[],
  slotMinuten: number,
): PreisFenster[] {
  const werte = cts.filter((v): v is number => v != null);
  if (werte.length === 0 || slotMinuten <= 0) return [];

  const len = Math.max(1, Math.round(FENSTER_MINUTEN / slotMinuten));
  // Ein Fenster, das den ganzen Zeitraum verschlucken würde, benennt nichts.
  if (cts.length < len * 2) return [];

  const spanne = Math.max(...werte) - Math.min(...werte);
  if (spanne < MIN_SPANNE_CT) return [];

  const out: PreisFenster[] = [];
  const guenstig = besterBlock(cts, len, 'min');
  const teuer = besterBlock(cts, len, 'max');
  const negativ = negativLauf(cts);

  // Das Negativfenster ist die STÄRKERE Tatsache und ersetzt das günstige,
  // sobald sie sich berühren - zwei Bänder übereinander wären der Kamm.
  const negativErsetzt =
    negativ != null &&
    guenstig != null &&
    negativ.von <= guenstig.bis &&
    guenstig.von <= negativ.bis;

  if (negativ != null) {
    const ct = mittel(cts, negativ.von, negativ.bis);
    if (ct != null) {
      out.push({
        art: 'negativ',
        von: negativ.von,
        bis: negativ.bis,
        wort: fensterWort('negativ', negativ.bis - negativ.von + 1, slotMinuten),
        ct,
      });
    }
  }
  if (guenstig != null && !negativErsetzt) {
    out.push({
      art: 'guenstig',
      von: guenstig.von,
      bis: guenstig.bis,
      wort: fensterWort('guenstig', len, slotMinuten),
      ct: guenstig.ct,
    });
  }
  // Ein teures Fenster, das sich mit dem günstigen überschneidet, gäbe es nur
  // auf einer Reihe ohne Struktur - dann sagt lieber keins etwas.
  if (
    teuer != null &&
    !out.some((f) => teuer.von <= f.bis && f.von <= teuer.bis)
  ) {
    out.push({
      art: 'teuer',
      von: teuer.von,
      bis: teuer.bis,
      wort: fensterWort('teuer', len, slotMinuten),
      ct: teuer.ct,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * K6 · Höchstens drei benannte Marken
 * ------------------------------------------------------------------------- */

export interface PreisMarke {
  art: 'tief' | 'hoch';
  index: number;
  /** „gratis · 0,0 ct" / „Hoch 21,3 ct" — Wort UND Zahl, nie nur ein Punkt. */
  text: string;
  ct: number;
}

/** „21,3" — eine Nachkommastelle, wie überall im Preis-Vokabular. */
function ct1(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * Tief und Hoch als benannte Marken (K6: höchstens drei, hier zwei). Ein
 * Extremwert, den es nicht gibt, erzeugt KEINE Marke; ein Tief bei ≤ 0 heißt
 * „gratis", weil das die Aussage ist, die zählt.
 */
export function preisMarken(cts: readonly (number | null)[]): PreisMarke[] {
  let tief = -1;
  let hoch = -1;
  cts.forEach((v, i) => {
    if (v == null) return;
    if (tief < 0 || v < (cts[tief] as number)) tief = i;
    if (hoch < 0 || v > (cts[hoch] as number)) hoch = i;
  });
  if (tief < 0 || hoch < 0 || tief === hoch) return [];
  const t = cts[tief] as number;
  const h = cts[hoch] as number;
  return [
    { art: 'tief', index: tief, ct: t, text: t <= 0 ? `gratis · ${ct1(t)} ct` : `Tief ${ct1(t)} ct` },
    { art: 'hoch', index: hoch, ct: h, text: `Hoch ${ct1(h)} ct` },
  ];
}

/* ---------------------------------------------------------------------------
 * K1 · Der Kernaussage-Satz über der Preis-Fläche
 * ------------------------------------------------------------------------- */

/** „12" → „12 Uhr"; die Uhrzeit eines Slot-Index über seine Zeitstempel. */
function stunde(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Der ehrliche Grund, wenn kein Satz belegbar ist. */
export const KEIN_SATZ_GRUND = 'Für diesen Zeitraum liegen noch keine Börsenpreise vor.';
/** Der Grund, wenn die Reihe zwar Preise, aber keine Struktur hat. */
export const FLACH_GRUND = 'In diesem Zeitraum schwankt der Börsenpreis kaum.';

/**
 * Die Kernaussage der Tages-Preisfläche — ABGELEITET, nie geschrieben
 * (chartKopf-Regel): „Am günstigsten ist Strom zwischen 12:00 und 14:30 Uhr —
 * dann kostet er nichts.", Anker „Am teuersten um 19:30 mit 21,3 ct."
 *
 * Ohne Fenster steht der ehrliche GRUND da, nie ein erfundener Satz.
 */
export function preisKern(
  cts: readonly (number | null)[],
  zeiten: readonly string[],
  fenster: readonly PreisFenster[],
): Kernaussage {
  const werte = cts.filter((v): v is number => v != null);
  if (werte.length === 0) {
    return { wert: null, satz: null, grund: KEIN_SATZ_GRUND, ton: 'calm' };
  }
  const guenstig = fenster.find((f) => f.art === 'negativ') ?? fenster.find((f) => f.art === 'guenstig');
  if (!guenstig) {
    return { wert: null, satz: null, grund: FLACH_GRUND, ton: 'calm' };
  }
  const von = stunde(zeiten[guenstig.von]);
  const bis = stunde(zeiten[guenstig.bis]);
  const zeitraum = von && bis ? `zwischen ${von} und ${bis} Uhr` : null;
  const schluss =
    guenstig.art === 'negativ'
      ? ' — dann kostet er nichts.'
      : ` — im Schnitt ${ct1(guenstig.ct)} ct/kWh.`;
  const satz = zeitraum
    ? `Am günstigsten ist Strom ${zeitraum}${schluss}`
    : `Am günstigsten ist Strom in ${fensterWort(guenstig.art, guenstig.bis - guenstig.von + 1, 15)}${schluss}`;

  const marken = preisMarken(cts);
  const hoch = marken.find((m) => m.art === 'hoch');
  const hochZeit = hoch ? stunde(zeiten[hoch.index]) : null;
  const anker =
    hoch && hochZeit ? `Am teuersten um ${hochZeit} Uhr mit ${ct1(hoch.ct)} ct.` : null;

  return { wert: null, satz, grund: null, ton: 'ok', anker };
}

/* ---------------------------------------------------------------------------
 * Bequemlichkeit für die zwei Aufrufer
 * ------------------------------------------------------------------------- */

/** Eine EUR/MWh-Reihe (die API-Einheit) als ct/kWh-Reihe (die Kunden-Einheit). */
export function ctReihe(
  eurMwh: readonly (number | string | null | undefined)[],
): (number | null)[] {
  return eurMwh.map((v) => ctFromEurMwh(v == null ? null : Number(v)));
}

/* ---------------------------------------------------------------------------
 * Die Wortzeile (K10) — beide Preis-Flächen rendern sie
 * ------------------------------------------------------------------------- */

export interface FensterZeile {
  art: FensterArt;
  /** „die günstigsten 2½ Stunden". */
  wort: string;
  /** „12:00–14:15" — WANN. */
  zeit: string;
}

/** „12:00" aus einem Zeitstempel; leer, wenn er unbrauchbar ist. */
function hhmm(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Die Fenster als Wortzeile — Wort UND Zeitraum. Sie steht unmittelbar unter
 * dem Bild statt IM Canvas: ein 2½-Stunden-Band ist auf einer 48-Stunden-Achse
 * ~40 px breit, sein Wort ~150 px, und zwei solche Etiketten überlappten sich
 * im ersten Bau prompt gegenseitig und die Datums-Beschriftung der
 * Tagesgrenze. Ein Fenster ohne brauchbare Zeitstempel wird ausgelassen, statt
 * eine leere Spanne zu behaupten.
 */
export function fensterZeilen(
  fenster: readonly PreisFenster[],
  zeiten: readonly string[],
): FensterZeile[] {
  const out: FensterZeile[] = [];
  for (const f of fenster) {
    const von = hhmm(zeiten[f.von]);
    const bis = hhmm(zeiten[f.bis]);
    if (!von || !bis) continue;
    out.push({ art: f.art, wort: f.wort, zeit: `${von}–${bis}` });
  }
  return out;
}
