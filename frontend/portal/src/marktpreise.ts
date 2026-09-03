import type { HistoryRange, PriceBucket, PriceHistory, PriceRangeSummary } from './api';
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
  negativ: { wort: 'unter Null', bedeutung: 'Einspeisen kostet gerade Geld' },
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
 * V3 · Heute/Morgen als **Segment**, nicht als Sprung-Chip.
 *
 * Bei 375 px liegen 96 (oder 192) Balken in ~343 px — die Kurve ist dann ein
 * Farbverlauf, kein Verlauf. Die Fläche zeigt deshalb EINEN Tag; das Segment
 * sagt zugleich, welcher zu sehen IST (der frühere Chip „Morgen ›" sagte nur,
 * wohin er springt).
 *
 * **Der Sonderzustand ist der eigentliche Gewinn** (§4.3): vor ~12:45 hat die
 * Börse den Folgetag noch nicht veröffentlicht. Bis P4 verschwand die Zeile
 * dann ersatzlos — der Kunde sah nicht, ob es morgen NICHT gibt oder ob die
 * Fläche es nur nicht zeigt. Jetzt steht dort der Grund.
 *
 * `null`, wenn es GAR NICHTS zu sagen gibt: ein vergangener Tag hat kein
 * „morgen", und ein einzelner Eintrag ohne Grund wäre ein Segment, das nichts
 * schaltet.
 */
export function tagWahl(
  buckets: readonly PriceBucket[],
  zeigtHeute: boolean,
): TagWahl | null {
  if (tagesGrenze(buckets) > 0) {
    return {
      optionen: [
        { id: 'heute', label: 'Heute' },
        { id: 'morgen', label: 'Morgen' },
      ],
      chip: null,
    };
  }
  if (!zeigtHeute) return null;
  return {
    optionen: [{ id: 'heute', label: 'Heute' }],
    chip: 'Morgen ab ca. 13 Uhr',
  };
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
