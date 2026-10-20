import type { HistoryRange, PriceBucket, PriceRangeSummary } from './api';
import { NBSP } from './format';

/**
 * Die Ableitungen des Rückblicks der Preis-Seite (Tag, Woche, Monat, Jahr) —
 * Kennzahl-Zeilen in ct/kWh, das Profi-Detail in EUR/MWh und die Tagesgrenze
 * der Rückblick-Kurve. Die Hauptansicht (Antwort, Stufen, Fenster nach vorn)
 * rechnet seit Fassung 3 des Konzepts „Preise und Wetter" `preisZeitstrahl.ts`.
 *
 * **ct/kWh ist die Kunden-Einheit** (sie steht auf der Rechnung); EUR/MWh
 * bleibt Profi-Detail.
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

/** „13:15" — die Viertelstunde, in der ein Extremwert lag. */
export function slotTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export interface PreisZeile {
  id: string;
  name: string;
  /** Der fertige Wert samt Einheit. */
  wert: string;
  /** WANN bzw. WORAUF — die ruhige Zeile darunter. */
  sekundaer?: string;
}

/** „14:15 Uhr" · „Mo, 01.09., 14:15 Uhr" · „01.09.2026" — je nach Zeitraum. */
function zeitpunkt(iso: string | null, range: HistoryRange): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const uhr = () => `${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
  if (range === 'day') return uhr();
  if (range === 'week') {
    return `${d.toLocaleDateString('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    })}, ${uhr()}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Wie ein Abschnitt des Zeitraums heisst — für die Abdeckungs-Zeile. */
function abschnittWort(bucket: string, n: number): string {
  if (bucket === 'PT15M') return n === 1 ? 'Viertelstunde' : 'Viertelstunden';
  if (bucket === 'PT1H') return n === 1 ? 'Stunde' : 'Stunden';
  return n === 1 ? 'Tag' : 'Tage';
}

/**
 * Tief / Hoch / Ø als **Ledger-Zeilen** (V5) statt als KPI-Karten (Rechner) und
 * Chips (Telefon) — dieselben drei Zahlen, EINE Form, und sie stehen dort, wo
 * man sie nach dem Blick auf die Kurve sucht.
 *
 * Der Rückblick trägt zusätzlich die **Abdeckung**: der Sammler holt nur heute
 * und morgen, ein Jahresfenster füllt sich also Tag für Tag — wie viel davon
 * wirklich gemessen ist, gehört neben die drei Zahlen und nicht in eine
 * Fußnote (§4.3, „die vier Kennzahlen als V5-Zeilen").
 *
 * Eine Zahl, die der Zeitraum nicht trägt, bekommt KEINE Zeile — ein „—" wäre
 * eine Behauptung über eine Messung, die es nicht gibt.
 */
export function preisZeilen(
  summary: PriceRangeSummary | null,
  range: HistoryRange,
  bucket: string,
): PreisZeile[] {
  if (!summary) return [];
  const zeilen: PreisZeile[] = [];
  const tief = ctFromEurMwh(summary.minEurMwh);
  const hoch = ctFromEurMwh(summary.maxEurMwh);
  const schnitt = ctFromEurMwh(summary.avgEurMwh);
  const istTag = range === 'day';

  // Am Tag führt das Tief (die Frage lautet „wann laden?"), im Rückblick der
  // Durchschnitt (die Frage lautet „wie teuer war der Zeitraum?").
  const tiefHoch: PreisZeile[] = [];
  if (tief != null) {
    tiefHoch.push({
      id: 'tief',
      name: 'Günstigste Zeit',
      wert: ctLabel(tief),
      sekundaer: zeitpunkt(summary.cheapestTs, range) ?? undefined,
    });
  }
  if (hoch != null) {
    tiefHoch.push({
      id: 'hoch',
      name: 'Teuerste Zeit',
      wert: ctLabel(hoch),
      sekundaer: zeitpunkt(summary.mostExpensiveTs, range) ?? undefined,
    });
  }
  const mittel: PreisZeile[] =
    schnitt == null
      ? []
      : [{ id: 'schnitt', name: 'Ø im Zeitraum', wert: ctLabel(schnitt) }];

  zeilen.push(...(istTag ? [...tiefHoch, ...mittel] : [...mittel, ...tiefHoch]));

  if (!istTag && summary.count != null && summary.count > 0) {
    const n = Number(summary.count);
    zeilen.push({
      id: 'abdeckung',
      name: 'Abdeckung',
      wert: `${n.toLocaleString('de-DE')}${NBSP}${abschnittWort(bucket, n)}`,
      sekundaer: summary.coverageStart
        ? `Preise ab ${zeitpunkt(summary.coverageStart, 'year')}`
        : undefined,
    });
  }
  return zeilen;
}

/**
 * Das Profi-Detail (V7/V8): dieselben vier Zahlen in EUR/MWh, die der Reiter
 * seit je führt — nur nicht mehr als offenes `Stat`-Raster über der Kurve.
 *
 * Der EUR/MWh-Grundsatz der Seite bleibt: ct/kWh ist die Kunden-Einheit,
 * EUR/MWh das Profi-Detail. Es zieht nur um.
 */
export function profiZeilen(summary: PriceRangeSummary | null): PreisZeile[] {
  if (!summary) return [];
  const zahl = (v: number | null | undefined): string | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n)
      ? n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;
  };
  const spanne =
    summary.minEurMwh == null || summary.maxEurMwh == null
      ? null
      : Number(summary.maxEurMwh) - Number(summary.minEurMwh);
  const roh: [string, string, string | null][] = [
    ['min', 'Minimum', zahl(summary.minEurMwh)],
    ['avg', 'Ø im Zeitraum', zahl(summary.avgEurMwh)],
    ['max', 'Maximum', zahl(summary.maxEurMwh)],
    ['spanne', 'Spanne', zahl(spanne)],
  ];
  return roh
    .filter(([, , w]) => w != null)
    .map(([id, name, w]) => ({ id, name, wert: `${w as string}${NBSP}EUR/MWh` }));
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

/** Welchen Tag die Kurve gerade zeigt. */
export type TagFokus = 'heute' | 'morgen';

export interface TagWahl {
  /** Die Segment-Einträge — einer, wenn es morgen noch nicht gibt. */
  optionen: readonly { id: TagFokus; label: string }[];
  /**
   * Statt des Eintrags „Morgen" der ehrliche GRUND, warum es ihn nicht gibt.
   * `null`, sobald die Reihe den Folgetag trägt.
   */
  chip: string | null;
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
