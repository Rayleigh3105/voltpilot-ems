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
 * Fenster, jedes MIT SEINEM WORT im Bild. Der Cockpit-Streifen und die
 * Rückblick-Kurve der Preis-Seite lesen dieselbe Funktion.
 *
 * ⚠ **Die Hauptansicht der Preis-Seite zeigt seit dem 20.10.2026 Stufen**
 * (Konzept „Preise und Wetter" Fassung 3, Entscheid E2 = A): Balken in drei
 * Stufen im Vergleich der KOMMENDEN Stunden, mit Wort, Legende und
 * Preisleiter — keine Farbskala ohne Skala. Die Regeln dafür stehen in
 * `preisZeitstrahl.ts`; diese Datei bleibt die Grammatik der Linie.
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
 * Bequemlichkeit für die zwei Aufrufer
 * ------------------------------------------------------------------------- */

/** Eine EUR/MWh-Reihe (die API-Einheit) als ct/kWh-Reihe (die Kunden-Einheit). */
export function ctReihe(
  eurMwh: readonly (number | string | null | undefined)[],
): (number | null)[] {
  return eurMwh.map((v) => ctFromEurMwh(v == null ? null : Number(v)));
}

/**
 * K7 · Das Fenster, in dem EIN abgelesener Slot liegt — oder `null`.
 *
 * Damit sagt der Marktpreis-Tooltip nicht nur eine Zahl, sondern was sie
 * BEDEUTET („3,25 ct/kWh — die günstigsten 2½ Stunden"). Die Aussage ist
 * belegt, weil sie aus genau derselben {@link preisFenster}-Entscheidung
 * kommt, die das Band im Bild zeichnet: Tooltip und Schattierung können sich
 * nicht widersprechen.
 *
 * Ohne Fenster (flacher Tag, zu kurzer Ausschnitt) bleibt es `null` — dann
 * nennt der Tooltip nur den Preis, statt eine Einordnung zu erfinden.
 */
export function fensterFuerSlot(
  fenster: readonly PreisFenster[],
  index: number,
): PreisFenster | null {
  return fenster.find((f) => index >= f.von && index <= f.bis) ?? null;
}
