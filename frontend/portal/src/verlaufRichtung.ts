/**
 * Richtung statt Vorzeichen in der Kennzahlen-Reihe des Verlaufs
 * (`VerlaufExplorer`: Minimum · Maximum · Durchschnitt · Letzter Wert).
 *
 * Ein Netzwert „−9,1 kW“ verstand der Kunde nicht: das Minus ist die
 * Vertragsregel „Bezug positiv, Einspeisung negativ“. Für eine Größe MIT
 * Vorzeichen-Regel sagt die Reihe deshalb die Richtung in Worten und den Betrag
 * ohne Minus; die Extreme heißen nach ihrer Bedeutung („Höchster Bezug“,
 * „Höchste Einspeisung“).
 *
 * Die Regeln stehen in den Verträgen, nie geraten:
 * - Netz: `docs/contracts/mqtt-telemetry.schema.json` (`power_kw`: „Positive =
 *   import, negative = export“) und `docs/contracts/v2/edge-entity.schema.json`
 *   `x-semantics.signs` („grid power_kw + = import, - = export“); die v1-Reihe
 *   `netz` IST „Bezug − Einspeisung“ (`verlauf.ts` `V1_CHANNELS`).
 * - Speicher: dieselben `signs` („battery_power_kw + = charge, - = discharge“).
 * Jede andere Größe bleibt, wie sie ist (kein Richtungswort, Zahl unverändert).
 *
 * Nur zur Anzeige: Werte, Rundung (eine Stelle) und CSV bleiben unberührt.
 * Rein und ohne React; geprüft in `verlaufRichtung.test.ts`.
 */
import type { ComponentRole } from './komponenten';
import { fmtNum } from './format';
import type { VerlaufStats } from './verlauf';

/** Welche Vorzeichen-Regel eine Reihe trägt. */
export type VorzeichenRegel = 'netz' | 'batterie';

/**
 * Die Vorzeichen-Regel einer Reihe aus Kanal und Rolle der Komponente, oder
 * null (Größe ohne Vorzeichen-Regel). `power_kw` ist nur am Netzanschluss die
 * Netzleistung - an einem Verbraucher oder Ladepunkt hat es keine Richtung.
 */
export function vorzeichenRegel(channel: string, role: ComponentRole): VorzeichenRegel | null {
  if (channel === 'grid_power_kw' || channel === 'netz') return 'netz';
  if (channel === 'power_kw' && role === 'grid') return 'netz';
  if (channel === 'battery_power_kw') return 'batterie';
  return null;
}

/** Positiv / negativ in Worten je Regel (Glossar: Bezug, Einspeisung, Laden/Entladen). */
const WORT: Record<VorzeichenRegel, { plus: string; minus: string }> = {
  netz: { plus: 'Bezug', minus: 'Einspeisung' },
  batterie: { plus: 'Laden', minus: 'Entladen' },
};

/**
 * Die Seite eines Werts NACH der Anzeige-Rundung: was als „0,0“ erscheint, hat
 * keine Richtung (sonst stünde „0,0 kW Einspeisung“ oder „−0,0 kW“ da).
 */
function seite(v: number, digits: number): 1 | -1 | 0 {
  const gerundet = Math.round(Math.abs(v) * 10 ** digits);
  if (gerundet === 0) return 0;
  return v > 0 ? 1 : -1;
}

/** Ein Wert mit Richtung: Betrag (ohne Minus) und Richtungswort. */
export interface RichtungsWert {
  /** „0,5 kW“ - der Betrag im UEMS-Format, nie mit Minus. */
  betrag: string;
  /** „Einspeisung“ / „Bezug“ / „Laden“ / „Entladen“, oder null bei 0,0. */
  wort: string | null;
}

/** Betrag und Richtungswort eines Werts unter einer Regel. Fehlend bleibt „-“. */
export function richtungsWert(
  v: number | null | undefined,
  unit: string,
  regel: VorzeichenRegel,
  digits = 1,
): RichtungsWert {
  if (v == null) return { betrag: fmtNum(v, unit, digits), wort: null };
  const s = seite(v, digits);
  const w = WORT[regel];
  return {
    betrag: fmtNum(Math.abs(v), unit, digits),
    wort: s === 1 ? w.plus : s === -1 ? w.minus : null,
  };
}

/** Die Bezeichnung eines Extrems nach Seite und Rang („Höchster Bezug“). */
function extremName(regel: VorzeichenRegel, s: 1 | -1, hoch: boolean): string {
  if (regel === 'netz') {
    if (s === 1) return hoch ? 'Höchster Bezug' : 'Niedrigster Bezug';
    return hoch ? 'Höchste Einspeisung' : 'Niedrigste Einspeisung';
  }
  if (s === 1) return hoch ? 'Höchste Ladeleistung' : 'Niedrigste Ladeleistung';
  return hoch ? 'Höchste Entladeleistung' : 'Niedrigste Entladeleistung';
}

/** Eine Kachel der Kennzahlen-Reihe. */
export interface StatKachel {
  label: string;
  /** Die Zahl mit Einheit (bei einer Regel ohne Minus). */
  wert: string;
  /** Das Richtungswort hinter der Zahl, oder null. */
  wort: string | null;
}

/**
 * Die vier Kacheln einer Reihe. Ohne Regel: „Minimum“, „Maximum“,
 * „Durchschnitt“, „Letzter Wert“ mit der Zahl wie bisher.
 *
 * Mit Regel heißen die Extreme nach ihrer Bedeutung. Das Maximum ist die
 * größte Zahl: über null der höchste Bezug (das stärkste Laden), unter null die
 * niedrigste Einspeisung. Das Minimum spiegelbildlich. Ein Extrem, das als
 * „0,0“ erscheint, liegt auf der Seite des anderen Extrems („Niedrigster Bezug
 * 0,0 kW“); sind beide 0,0, bleiben „Minimum“ und „Maximum“. Kreuzt die Reihe
 * null, nennt sie beide Richtungen - jede Kachel liest sich für sich richtig.
 */
export function statKacheln(
  stats: VerlaufStats,
  unit: string,
  regel: VorzeichenRegel | null,
  digits = 1,
): { min: StatKachel; max: StatKachel; avg: StatKachel; last: StatKachel } {
  if (regel == null) {
    return {
      min: { label: 'Minimum', wert: fmtNum(stats.min?.value, unit, digits), wort: null },
      max: { label: 'Maximum', wert: fmtNum(stats.max?.value, unit, digits), wort: null },
      avg: { label: 'Durchschnitt', wert: fmtNum(stats.avg, unit, digits), wort: null },
      last: { label: 'Letzter Wert', wert: fmtNum(stats.last, unit, digits), wort: null },
    };
  }
  const sMin = stats.min ? seite(stats.min.value, digits) : 0;
  const sMax = stats.max ? seite(stats.max.value, digits) : 0;
  const extrem = (
    e: VerlaufStats['min'],
    eigene: 1 | -1 | 0,
    andere: 1 | -1 | 0,
    istMax: boolean,
    neutral: string,
  ): StatKachel => {
    const wert = fmtNum(e == null ? null : Math.abs(e.value), unit, digits);
    const s = eigene !== 0 ? eigene : andere;
    if (e == null || s === 0) return { label: neutral, wert, wort: null };
    // Auf der Plus-Seite ist das Maximum das Höchste, auf der Minus-Seite das Minimum.
    const hoch = s === 1 ? istMax : !istMax;
    return { label: extremName(regel, s, hoch), wert, wort: null };
  };
  const mitWort = (label: string, v: number | null): StatKachel => {
    const r = richtungsWert(v, unit, regel, digits);
    return { label, wert: r.betrag, wort: r.wort };
  };
  return {
    min: extrem(stats.min, sMin, sMax, false, 'Minimum'),
    max: extrem(stats.max, sMax, sMin, true, 'Maximum'),
    avg: mitWort('Durchschnitt', stats.avg),
    last: mitWort('Letzter Wert', stats.last),
  };
}
