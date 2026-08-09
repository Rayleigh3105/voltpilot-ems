import type { PriceBucket, PriceHistory, PriceRangeSummary } from './api';
import { NBSP } from './format';

/**
 * Die Mobil-Fassung der Marktpreis-Seite (Konzept `data/vp-mobile-views-x1`
 * §7, Captain-Go 09.08.2026) — reine Ableitungen, der Render ist dünn.
 *
 * Der gemessene Befund war DOPPELUNG in zwei Einheiten: drei ct/kWh-Karten VOR
 * der Kurve und dieselbe Aussage noch einmal als Min/Ø/Max/Spanne in EUR/MWh
 * IM Chart-Block — vier Zahlen, zwei Einheiten, eine Botschaft. Und das
 * Wichtigste, **was Strom JETZT kostet**, stand nirgends zuerst.
 *
 * Drei Regeln, die hier hart verdrahtet sind:
 *
 *  1. **ct/kWh ist die Kunden-Einheit** (sie steht auf der Rechnung); EUR/MWh
 *     bleibt Profi-Detail hinter einem Aufklapper — der dokumentierte
 *     EUR/MWh-Grundsatz der Seite gilt weiter, er zieht nur um.
 *  2. **Kein erfundener Preis.** Ohne Viertelstunde, die JETZT läuft (Nacht vor
 *     der Veröffentlichung, Rückblick auf einen vergangenen Tag), gibt es
 *     keinen Helden — nie der zuletzt bekannte Wert als „jetzt".
 *  3. **Der Bezugspreis wird GELESEN, nie gerechnet.** Er kommt aus dem
 *     Fahrplan-Slot (`importPriceCtKwh`, die eine serverseitige Komposition),
 *     genau wie in `settingsSurface.bezugspreisVorschau` — aus Tarif-Feldern zu
 *     addieren wäre die zweite Preiswahrheit, die es nicht geben darf.
 */

/** EUR/MWh → ct/kWh. Die API rechnet in EUR/MWh, der Kunde liest ct/kWh. */
export function ctFromEurMwh(eurMwh: number | null | undefined): number | null {
  if (eurMwh == null) return null;
  const n = Number(eurMwh);
  return Number.isFinite(n) ? n / 10 : null;
}

/** „−2,04 ct/kWh" — Vorzeichen ehrlich, geschütztes Leerzeichen vor der Einheit. */
export function ctLabel(ct: number | null): string {
  if (ct == null) return '—';
  return `${ct.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}${NBSP}ct/kWh`;
}

/** Kurzform ohne Einheit für die Chips („−2,60"). */
export function ctShort(ct: number | null): string {
  if (ct == null) return '—';
  return ct.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** „13:15" — die Viertelstunde, in der ein Extremwert lag. */
export function slotTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Das EINE Wort über dem Preis. Die Schwellen sind bewusst grob und in der
 * Rechnungs-Einheit gedacht: unter null zahlt die Börse fürs Abnehmen, bis
 * `GUENSTIG_CT` ist Strom billig, ab `TEUER_CT` teuer — dazwischen ist er
 * eben normal, und dann wird auch nichts behauptet.
 */
export const GUENSTIG_CT = 5;
export const TEUER_CT = 15;

export type PreisTon = 'negativ' | 'guenstig' | 'normal' | 'teuer';

export interface JetztPreis {
  /** ct/kWh, vorzeichen-ehrlich. */
  ct: number;
  ton: PreisTon;
  /** „Negativpreis" · „Günstig" · „Normal" · „Teuer" — das eine Wort. */
  wort: string;
  /** Was das Wort bedeutet, in einem Halbsatz. */
  bedeutung: string;
  /** Die Viertelstunde, für die der Preis gilt („14:15"). */
  zeit: string | null;
}

function tonVon(ct: number): PreisTon {
  if (ct < 0) return 'negativ';
  if (ct <= GUENSTIG_CT) return 'guenstig';
  if (ct >= TEUER_CT) return 'teuer';
  return 'normal';
}

const WORT: Record<PreisTon, { wort: string; bedeutung: string }> = {
  negativ: { wort: 'Negativpreis', bedeutung: 'Einspeisen kostet gerade Geld' },
  guenstig: { wort: 'Günstig', bedeutung: 'gute Zeit zum Laden' },
  normal: { wort: 'Normal', bedeutung: 'im üblichen Bereich' },
  teuer: { wort: 'Teuer', bedeutung: 'gute Zeit zum Entladen' },
};

/**
 * Der Börsenpreis der Viertelstunde, die JETZT läuft — `[start, start + len)`,
 * dieselbe Semantik wie `settingsSurface.aktuellerPreisSlot` und der Edge.
 *
 * Null, sobald der Zeitraum das Jetzt nicht abdeckt (Rückblick, Lücke in der
 * Reihe, Bucket ohne Wert). **Der zuletzt bekannte Preis wird NIE als „jetzt"
 * ausgegeben** — dann sagt die Fläche lieber, dass sie es nicht weiß.
 */
export function jetztPreis(history: PriceHistory | null, now: Date): JetztPreis | null {
  if (!history || history.bucket !== 'PT15M') return null;
  const len = 15 * 60_000;
  const t = now.getTime();
  for (const b of history.buckets) {
    const start = Date.parse(b.ts);
    if (!Number.isFinite(start)) continue;
    if (t >= start && t < start + len) {
      const ct = ctFromEurMwh(b.avgEurMwh);
      if (ct == null) return null;
      const ton = tonVon(ct);
      return { ct, ton, ...WORT[ton], zeit: slotTime(b.ts) };
    }
  }
  return null;
}

/**
 * „Ihr Bezugspreis 32,5 ct" — der Halbsatz neben dem Börsenpreis, der ihn
 * einordnet. **Gelesen, nicht gerechnet** (siehe Kopfkommentar); ohne Wert
 * entfällt er ersatzlos, statt eine Zahl zu erfinden.
 */
export function bezugspreisNote(importPriceCtKwh: number | null | undefined): string | null {
  if (importPriceCtKwh == null) return null;
  const n = Number(importPriceCtKwh);
  if (!Number.isFinite(n)) return null;
  return `Ihr Bezugspreis ${ctLabel(n)}`;
}

export interface PreisChip {
  id: 'tief' | 'hoch' | 'schnitt';
  label: string;
  ton: 'gut' | 'teuer' | 'neutral';
}

/**
 * Tief/Hoch/Ø als Chips UNTER der Kurve statt als drei Karten davor — dieselben
 * drei Zahlen, ein Fünftel der Höhe, und sie stehen dort, wo man sie nach dem
 * Blick auf die Kurve sucht.
 *
 * Eine Zahl, die der Zeitraum nicht trägt, bekommt KEINEN Chip (ein „—"-Chip
 * wäre eine Behauptung über eine Messung, die es nicht gibt).
 */
export function preisChips(summary: PriceRangeSummary | null, withTime: boolean): PreisChip[] {
  if (!summary) return [];
  const chips: PreisChip[] = [];
  const tief = ctFromEurMwh(summary.minEurMwh);
  const hoch = ctFromEurMwh(summary.maxEurMwh);
  const schnitt = ctFromEurMwh(summary.avgEurMwh);
  const zeit = (iso: string | null) => (withTime ? slotTime(iso) : null);

  if (tief != null) {
    const t = zeit(summary.cheapestTs);
    chips.push({ id: 'tief', label: `Tief ${ctShort(tief)} ct${t ? ` · ${t}` : ''}`, ton: 'gut' });
  }
  if (hoch != null) {
    const t = zeit(summary.mostExpensiveTs);
    chips.push({ id: 'hoch', label: `Hoch ${ctShort(hoch)} ct${t ? ` · ${t}` : ''}`, ton: 'teuer' });
  }
  if (schnitt != null) {
    chips.push({ id: 'schnitt', label: `Ø ${ctShort(schnitt)} ct`, ton: 'neutral' });
  }
  return chips;
}

/**
 * Der Index der ersten Viertelstunde des FOLGETAGS — die Tagesgrenze, die bei
 * 375 px sonst niemand findet (rotierte Achsenbeschriftung mitten im Canvas).
 * `-1`, wenn die Reihe den Tageswechsel nicht enthält.
 */
export function tagesGrenze(buckets: readonly PriceBucket[]): number {
  for (let i = 1; i < buckets.length; i++) {
    const a = new Date(buckets[i - 1].ts);
    const b = new Date(buckets[i].ts);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) continue;
    if (a.toDateString() !== b.toDateString()) return i;
  }
  return -1;
}

/** Welchen Tag die Kurve am Telefon gerade zeigt. */
export type TagFokus = 'heute' | 'morgen';

export interface FokusUmschalter {
  /** Der Chip rechts unter der Kurve („Morgen ›" / „‹ Heute"). */
  label: string;
  ziel: TagFokus;
  /** Die Beschriftung links („Heute" / „Morgen") — was gerade zu sehen ist. */
  aktuell: string;
}

/**
 * Bei 375 px liegen 96 (oder 192) Balken in ~343 px — die Kurve ist dann ein
 * Farbverlauf, kein Verlauf. Am Telefon zeigt sie deshalb EINEN Tag und der
 * Chip springt zum anderen; die Tagesgrenze ist damit nicht nur sichtbar,
 * sondern begehbar.
 *
 * Null, wenn die Reihe gar keinen Folgetag enthält — dann gibt es nichts
 * umzuschalten und der Chip erschiene ins Leere.
 */
export function fokusUmschalter(
  buckets: readonly PriceBucket[],
  fokus: TagFokus,
): FokusUmschalter | null {
  if (tagesGrenze(buckets) <= 0) return null;
  return fokus === 'heute'
    ? { label: 'Morgen ›', ziel: 'morgen', aktuell: 'Heute' }
    : { label: '‹ Heute', ziel: 'heute', aktuell: 'Morgen' };
}

/**
 * Das Index-Fenster, das die Kurve am Telefon zeigt. `null` = alles (Rückblick,
 * kein Folgetag, oder Desktop) — der Aufrufer setzt dann keinen Zoom.
 */
export function fokusFenster(
  buckets: readonly PriceBucket[],
  fokus: TagFokus,
): { start: number; end: number } | null {
  const grenze = tagesGrenze(buckets);
  if (grenze <= 0) return null;
  return fokus === 'heute'
    ? { start: 0, end: grenze - 1 }
    : { start: grenze, end: buckets.length - 1 };
}
