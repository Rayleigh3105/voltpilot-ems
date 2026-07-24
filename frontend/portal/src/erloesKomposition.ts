/**
 * M4 — die **Erlös-Komposition** ("Projektion", OpenProject #532, Epic #527).
 *
 * Geld ist eine **Komposition von Strömen**, kein neuer Rechenkern
 * (report §1.4): jeder aktive Modus benennt seinen Strom, und jeder Strom liest
 * aus **bestehenden** Earnings-Feldern —
 * Eigenverbrauch → `eigenverbrauchsWertEur` + `einspeiseErloesEur`,
 * Marktvermarktung → `savedEur`/`arbitrageEur` (+ Marktprämie im Kleingedruckten),
 * Lastspitzenkappung → `peakShaving.avoidedEur`,
 * Automationen → ein ehrliches **„—"** (eine €-Zurechnung je Regel gibt es
 * nicht, E15 ist nicht gebaut). Hier wird NICHTS neu gerechnet und NICHTS
 * erfunden.
 *
 * **Die Perioden-Ehrlichkeit ist die tragende Regel dieses Moduls**
 * (report §1.4 + §9): vermiedene Leistungskosten sind ein **Stand der
 * laufenden Abrechnungsperiode**, EV-/Handelswerte sind **Zeitraum**-Werte
 * (Tag/Monat/Jahr). Deshalb
 *  1. trägt JEDE Zeile ihr eigenes Perioden-Etikett,
 *  2. gibt es **eine Summe je Periode** — quer über Perioden wird NIE addiert,
 *  3. und sobald mehrere Perioden im Stapel stehen, sagt eine Zeile das laut.
 *
 * Reines Daten-/Logikmodul (der `live.ts`/`moduleSurface.ts`-Präzedenzfall):
 * kein React, kein Netzwerk. Es KONSUMIERT das M0-Read-Model
 * (`surface.ts` `moneyStreams(modes)`) und leitet Modi nicht neu ab.
 *
 * Die **Erlös-Historie** ist der Drill-in dieses Blocks (money-modus-gebunden)
 * und bleibt sauber getrennt von der **Telemetrie-Historie**, die zu
 * `base(entities)` gehört und in JEDEM Modus existiert (feedback.md Punkt 2).
 */

import type { EarningsRange, EarningsSite } from './api';
import { coveredSinceLabel, periodLabel } from './anlage';
import { eurAmount } from './format';
import type { MoneyStream, MoneyStreamId, StreamPeriod } from './surface';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/**
 * Warum eine Zeile keine Zahl zeigt:
 *  - `value` — eine echte, gemessene Zahl;
 *  - `unattributed` — es EXISTIERT keine Zurechnung (Automationen, E15);
 *  - `unavailable` — der Wert ist (noch) nicht berechenbar (keine Messwerte,
 *    kein Tarif hinterlegt, Modul erst frisch aktiv).
 * Beide Nicht-Zahl-Zustände rendern „—", niemals eine 0.
 */
export type StreamValueState = 'value' | 'unattributed' | 'unavailable';

/** Eine Zeile des Strom-Stapels — vollständig abgeleitet, render-fertig. */
export interface StreamRow {
  id: MoneyStreamId;
  label: string;
  /** Der Betrag in €; null in JEDEM Nicht-`value`-Zustand. */
  eur: number | null;
  /** "1.204,00 €" bzw. der Gedankenstrich. */
  valueText: string;
  state: StreamValueState;
  period: StreamPeriod;
  /** Das Perioden-Etikett DIESER Zeile ("Juli" / "Abrechnungsjahr 2026"). */
  periodLabel: string;
  /** Balkenanteil 0..1 — relativ zur größten Zeile DERSELBEN Periode. */
  barFraction: number;
  /** CSS-Farbe (Token-`var()`), damit Punkt und Balken zusammenpassen. */
  hue: string;
  /** Optionale ruhige Detailzeile (Arbitrage-Anteil, Marktprämie, Hinweis). */
  note: string | null;
}

/** Die Summe EINER Periode — es gibt bewusst keine periodenübergreifende. */
export interface PeriodTotal {
  period: StreamPeriod;
  /** "Juli gesamt" / "Abrechnungsjahr 2026 gesamt". */
  label: string;
  eur: number | null;
  valueText: string;
  /** Wie viele Zeilen wirklich in diese Summe eingegangen sind. */
  contributingRows: number;
}

/** Der Drill-in in die Geld-Tiefe — die **Erlös**-Historie. */
export interface ErloesDrillIn {
  label: string;
  /** Die Abgrenzung zur Telemetrie-Historie, sichtbar im UI. */
  hint: string;
}

/** Die fertige Erlös-Komposition. */
export interface ErloesKompositionView {
  /** Überschrift inkl. Zeitraum: "Ertrag · Juli — alle Ströme". */
  title: string;
  rows: StreamRow[];
  /** Eine Summe JE Periode (report §1.4). */
  totals: PeriodTotal[];
  /**
   * Der laute Hinweis, sobald der Stapel mehrere Perioden mischt — ohne ihn
   * wäre eine Gesamtzahl unehrlich.
   */
  periodNote: string | null;
  /** Erklärt das ehrliche „—" — nur wenn es eine solche Zeile gibt. */
  footnote: string | null;
  drillIn: ErloesDrillIn | null;
  /** true = es gibt nichts zu zeigen (kein Geld-Modus) → Block entfällt. */
  isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Der Gedankenstrich — die einzige erlaubte Nicht-Zahl. */
export const DASH = '—';

export const ERLOES_HISTORIE: ErloesDrillIn = {
  label: 'Erlöse im Detail',
  // Die Trennung aus feedback.md Punkt 2 steht sichtbar im UI, nicht nur im Code.
  hint: 'Erlös-Historie – getrennt vom Telemetrie-Verlauf.',
};

export const UNATTRIBUTED_FOOTNOTE =
  'Jeder Strom kommt aus einem Modus. Wo „—" steht, gibt es noch keine Zurechnung je Regel – erfunden wird nichts.';

/**
 * Die Earnings-Felder, aus denen eine Zeile liest. Das MUSS deckungsgleich mit
 * dem `sources`-Feld des M0-Manifests bleiben (drift-gesichert im Test) — das
 * Manifest ist die Wahrheit, hier steht nur die Auflösung.
 */
export const STREAM_SOURCES: Record<MoneyStreamId, string[]> = {
  eigenverbrauchswert: ['eigenverbrauchsWertEur'],
  einspeisung: ['einspeiseErloesEur'],
  handel: ['savedEur', 'arbitrageEur'],
  lastspitzen: ['peakShaving.avoidedEur'],
  automation: [],
};

/** Farbe je Strom — die `--vp-flow-*`-Kanalfarben, wie im Konzept-Mock. */
const STREAM_HUE: Record<MoneyStreamId, string> = {
  lastspitzen: 'var(--vp-flow-pv)',
  handel: 'var(--vp-flow-grid)',
  eigenverbrauchswert: 'var(--vp-flow-batt)',
  einspeisung: 'var(--vp-primary)',
  automation: 'var(--vp-flow-load)',
};

// ---------------------------------------------------------------------------
// Perioden-Etiketten
// ---------------------------------------------------------------------------

function isoYear(iso: string): string {
  return iso.slice(0, 4);
}

/**
 * Das Etikett der Abrechnungsperiode aus dem PS-4-Block. Ohne den Block bleibt
 * es beim neutralen "Abrechnungsperiode" — nie ein erfundener Zeitraum.
 */
export function billingPeriodLabel(money: EarningsSite | null | undefined): string {
  const ps = money?.peakShaving;
  if (!ps?.periodStart) return 'Abrechnungsperiode';
  if (ps.abrechnung === 'monat') {
    const d = new Date(`${ps.periodStart.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return 'Abrechnungsperiode';
    return `Abrechnungsmonat ${d.toLocaleDateString('de-DE', { month: 'long' })} ${isoYear(ps.periodStart)}`;
  }
  return `Abrechnungsjahr ${isoYear(ps.periodStart)}`;
}

// ---------------------------------------------------------------------------
// Wert-Auflösung je Strom
// ---------------------------------------------------------------------------

interface Resolved {
  eur: number | null;
  note: string | null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Die Zurechnungs-Zeile UNTER dem Erlös: was VoltPilots Steuerung an diesem
 * Erlös beigetragen hat (MIG §5). Sie ist bewusst **kein eigener Summand** —
 * `savedEur` ist das Delta gegenüber einer ungeregelten Anlage und steckt
 * bereits im Erlös. Null (kein Wert / rauschfrei 0) → keine Zeile, nie eine 0.
 */
export function steeringAttributionNote(savedEur: number | null | undefined): string | null {
  const eur = num(savedEur ?? null);
  if (eur == null || Math.abs(eur) < 0.005) return null;
  return eur > 0
    ? `davon ${eurAmount(eur)} durch VoltPilots Steuerung`
    : `VoltPilots Steuerung: ${eurAmount(eur)} in diesem Zeitraum`;
}

function resolve(stream: MoneyStream, money: EarningsSite | null): Resolved {
  if (!money) return { eur: null, note: null };
  switch (stream.id) {
    case 'eigenverbrauchswert':
      return { eur: num(money.eigenverbrauchsWertEur), note: null };
    case 'einspeisung': {
      // Die Marktprämie steckt bereits IM Einspeise-Erlös - das gehört ins
      // Kleingedruckte, nicht in eine eigene erfundene Zeile (report §1.4).
      const praemie =
        num(money.anzulegenderWertCtKwh) != null
          ? 'inkl. Marktprämie (anzulegender Wert hinterlegt)'
          : null;
      const steering =
        stream.attribution === 'steering' ? steeringAttributionNote(money.savedEur) : null;
      return {
        eur: num(money.einspeiseErloesEur),
        note: [steering, praemie].filter(Boolean).join(' · ') || null,
      };
    }
    case 'handel': {
      const saved = num(money.savedEur);
      const arbitrage = num(money.arbitrageEur);
      return {
        eur: saved,
        note: arbitrage != null ? `davon Netzladen: ${eurAmount(arbitrage)}` : null,
      };
    }
    case 'lastspitzen':
      return { eur: num(money.peakShaving?.avoidedEur), note: null };
    default:
      // Automationen: es gibt keine Quelle - der Zustand entscheidet, nicht der Wert.
      return { eur: null, note: null };
  }
}

// ---------------------------------------------------------------------------
// Die Komposition
// ---------------------------------------------------------------------------

export interface ErloesKompositionInput {
  /** Die Ströme der aktiven Modi — `moneyStreams(activeModes(site))` aus M0. */
  streams: MoneyStream[];
  /** Die Earnings-Zeile dieser Anlage; null = noch nicht geladen. */
  money: EarningsSite | null;
  /** Der gewählte Zeitraum der Seite. */
  range: EarningsRange;
  /** Der Anker des Zeitraums (angetippter Monat), Standard: jetzt. */
  at?: Date;
  now?: Date;
}

/**
 * Baut den Strom-Stapel. Reihenfolge = die Modus-Reihenfolge aus M0 (kanonisch,
 * nie €-gewichtet — kein tägliches Umsortieren, kein Flackern).
 */
export function erloesKomposition(input: ErloesKompositionInput): ErloesKompositionView {
  const now = input.now ?? new Date();
  const at = input.at ?? now;
  const rangeLabel = periodLabel(input.range, at, now);
  const billingLabel = billingPeriodLabel(input.money);
  const labelFor = (p: StreamPeriod) => (p === 'billing-period' ? billingLabel : rangeLabel);
  // V4/V13: „Gesamt gesamt" -> „seit 3. Juli 2026" (nennt zugleich, warum
  // Monat/Jahr/Gesamt auf einer jungen Anlage dieselbe Zahl tragen).
  const sinceLabel =
    input.range === 'all' ? coveredSinceLabel(input.money?.firstCoveredDate) : null;
  const totalCaption = (p: StreamPeriod) =>
    p === 'range' && sinceLabel ? sinceLabel : `${labelFor(p)} gesamt`;

  const rows: StreamRow[] = (input.streams ?? []).map((s) => {
    const { eur, note } = s.unattributed
      ? { eur: null, note: null }
      : resolve(s, input.money);
    const state: StreamValueState = s.unattributed
      ? 'unattributed'
      : eur == null
        ? 'unavailable'
        : 'value';
    return {
      id: s.id,
      label: s.label,
      eur: state === 'value' ? eur : null,
      valueText: state === 'value' ? eurAmount(eur as number) : DASH,
      state,
      period: s.period,
      periodLabel: labelFor(s.period),
      barFraction: 0,
      hue: STREAM_HUE[s.id] ?? 'var(--vp-primary)',
      note: state === 'value' ? note : state === 'unavailable' ? 'Noch keine Daten.' : null,
    };
  });

  // Balken NUR innerhalb einer Periode skalieren - ein Jahresstand darf einen
  // Monatswert nicht optisch erschlagen (und umgekehrt).
  for (const period of ['range', 'billing-period'] as StreamPeriod[]) {
    const group = rows.filter((r) => r.period === period && r.eur != null);
    const max = Math.max(0, ...group.map((r) => Math.abs(r.eur as number)));
    if (max <= 0) continue;
    for (const r of group) r.barFraction = Math.abs(r.eur as number) / max;
  }

  // Eine Summe JE Periode - quer wird nie addiert (report §1.4).
  const totals: PeriodTotal[] = [];
  for (const period of ['range', 'billing-period'] as StreamPeriod[]) {
    const group = rows.filter((r) => r.period === period);
    if (group.length === 0) continue;
    const contributing = group.filter((r) => r.eur != null);
    const sum = contributing.reduce((acc, r) => acc + (r.eur as number), 0);
    totals.push({
      period,
      label: totalCaption(period),
      eur: contributing.length > 0 ? sum : null,
      valueText: contributing.length > 0 ? eurAmount(sum) : DASH,
      contributingRows: contributing.length,
    });
  }

  const periodNote =
    totals.length > 1
      ? `Verschiedene Zeiträume: ${totals
          .map((t) => labelFor(t.period))
          .join(' und ')} werden getrennt ausgewiesen und nicht zu einer Summe addiert.`
      : null;

  const hasAttributed = rows.some((r) => r.state === 'value');

  return {
    title: `Ertrag · ${rangeLabel} — alle Ströme`,
    rows,
    totals,
    periodNote,
    footnote: rows.some((r) => r.state !== 'value') ? UNATTRIBUTED_FOOTNOTE : null,
    drillIn: hasAttributed ? ERLOES_HISTORIE : null,
    isEmpty: rows.length === 0,
  };
}
