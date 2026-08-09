/**
 * Portal v3 · **M2 — das Live-Cockpit** (`docs/portal-v3/M2-cockpit.md`,
 * Konzept-Tab „3 · Live-Cockpit").
 *
 * Die Anlagen-Startseite führt mit dem **bestehenden Energiefluss-Diagramm**
 * (groß, als Hero — `components/EnergyFlow.tsx` bzw. `AdaptiveEnergyFlow.tsx`;
 * ein neues „Energie-Rad" ist ausdrücklich abgelehnt, BUILD.md §2) und darunter
 * mit einem **Widget-Raster** der Geld-/Modus-Kacheln: Handel, Lastspitze,
 * Erlöse, Eigenverbrauch, Geräte-Automatik, Wetter.
 *
 * **Die vier FLUSS-Kacheln (Erzeugung/Speicher/Haus/Netz) sind seit dem
 * Cockpit+Live-Merge (Option A, `data/vp-cockpit-live-merge-design/report.md`
 * §3 R2) ersatzlos entfernt**: das Komponenten-Board im Cockpit ist die EINE
 * Live-Wert-Fläche — strikt reicher (Zustandswort, Health, Sparkline, alle
 * Messwerte), und seine Zeilen springen selbst in den Verlauf-Explorer.
 *
 * **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2,
 * `data/vp-portal-livedata-design/report.md` §1): ein Tipp navigiert direkt zum
 * `target` der Kachel — auf ihre Seite. Das frühere Detail-Modal ist ersatzlos
 * entfernt; die Werte-Zeilen leben auf den Zielseiten (Bilanz / Lastspitzen /
 * Fahrplan).
 *
 * Dieses Modul ist die **reine Ableitung** (der `cockpit.ts`/`live.ts`-
 * Präzedenzfall): kein React, kein Netzwerk, kein neuer Rechenkern. Es
 * KONSUMIERT das M0-Read-Model (`surface.ts`) und die bereits vorhandenen
 * Ableitungen (`cockpit.ts` Handel/Eigenverbrauch, `erloesKomposition.ts`,
 * `peakBand.ts`) — es rechnet nichts nach. Das Absprung-Ziel selbst kommt aus
 * dem reinen `verlaufTarget.ts` (`widgetTarget`).
 *
 * Drei Regeln sind hier Gesetz:
 *
 * 1. **Die Projektion entscheidet, WELCHE Kacheln es gibt** (BUILD.md §4.1):
 *    eine Kachel existiert nur, wenn ihr Block/Modus existiert UND eine Quelle
 *    da ist. Ohne Markt-Modus keine Handel-Kachel, ohne Lastspitzen-Modul keine
 *    Lastspitze-Kachel.
 * 2. **Die „—"-Disziplin** (BUILD.md §4.2): ein nicht berechenbarer Wert
 *    rendert `—`, **nie eine erfundene 0**; eine Kachel ganz ohne Quelle
 *    entfällt, statt leer dazustehen.
 * 3. **Die Reihenfolge ist kanonisch** — sie kommt aus der Blockordnung von M0
 *    (`CockpitBlock.order`, report §1.3). Die Führungsregel (`leadSlot.ts`
 *    `leadBlock`) markiert nur, was FÜHRT; sie sortiert nichts um.
 */

import type {
  CockpitMoney,
  EarningsRange,
  HistoryRange,
  HistoryTotals,
} from './api';
import { periodLabel } from './anlage';
import {
  eigenverbrauchBlock,
  handelBlock,
  type CockpitSlot,
  type EigenverbrauchBlockView,
  type HandelBlockView,
} from './cockpit';
import { DASH, erloesKomposition, steeringAttributionNote } from './erloesKomposition';
import { eurAmount, fmtNum } from './format';
import type { PeakBandView } from './peakBand';
import { planSentence, type PlanWordingKind } from './schedule';
import type { ActiveMode, CockpitBlock, CockpitBlockId, MoneyStream } from './surface';
import { widgetTarget, type WidgetTarget } from './verlaufTarget';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die Kacheln des Cockpits — deterministisch, nie erfunden. Die vier
 *  Fluss-Kacheln sind seit dem Cockpit+Live-Merge (R2) kein Teil davon. */
export type WidgetId =
  | 'lastspitze'
  | 'erloes'
  | 'handel'
  | 'eigenverbrauch'
  | 'automatik'
  | 'wetter';

/** Der Farbkanal einer Kachel — die `--vp-flow-*`-Token bzw. der Geld-Ton. */
export type WidgetAccent = 'pv' | 'batt' | 'grid' | 'load' | 'money';

/** Eine render-fertige Kachel. */
export interface WidgetDef {
  id: WidgetId;
  label: string;
  /** Die große Zahl der Kachel; `—`, wenn (noch) nicht berechenbar. */
  value: string;
  /** Die ruhige Zeile darunter; null = keine. */
  sub: string | null;
  accent: WidgetAccent;
  /** true = diese Kachel gehört zum führenden Block (`leadBlock`). */
  lead: boolean;
  /** Wohin ein Tipp springt: ein Verlauf-Messwert oder eine Seite. */
  target: WidgetTarget;
}

/** Eine Kachel vor dem Anhängen von `lead` + `target`. */
type WidgetBase = Omit<WidgetDef, 'lead' | 'target'>;

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

export interface CockpitWidgetsInput {
  /** Die Blöcke der Projektion (M0) — sie entscheiden, was es gibt. */
  blocks: CockpitBlock[] | null | undefined;
  /** Die aktiven Modi (für die Automatik-Kachel). */
  modes: ActiveMode[] | null | undefined;
  /** Der führende Block (`leadBlock`); markiert nur, sortiert nichts um. */
  lead?: CockpitBlockId | null;
  /** Die Historie-Totals des heutigen Tages (serverseitig gerechnet). */
  dayTotals?: HistoryTotals | null;
  /** Die Earnings-Zeile dieser Anlage. */
  money?: CockpitMoney | null;
  /** Die Geld-Ströme der aktiven Modi (M0 `moneyStreams`). */
  streams?: MoneyStream[] | null;
  range: EarningsRange;
  at?: Date;
  now: Date;
  /** Die Slots des persistierten Fahrplans. */
  slots?: CockpitSlot[] | null;
  slotMinutes?: number;
  plantKind?: PlanWordingKind;
  /** Die fertige Peak-Band-Sicht; null = kein Peak-Modul / keine Daten. */
  peak?: PeakBandView | null;
  /** Wetter am Standort; null = nichts geladen. */
  weather?: { nextHourTempC: number | null; why: string | null } | null;
}

// ---------------------------------------------------------------------------
// Die Kacheln
// ---------------------------------------------------------------------------

/**
 * Das Widget-Raster einer Anlage: eine Kachel je Cockpit-Block bzw. Modus, der
 * WIRKLICH etwas beisteuert, in der kanonischen Blockordnung. Eine Kachel ohne
 * Quelle entfällt; eine Kachel ohne aktuellen Wert zeigt `—`. Jede Kachel
 * bekommt ihr Absprung-`target` (Verlauf-Messwert bzw. Seite) angehängt.
 */
export function cockpitWidgets(input: CockpitWidgetsInput): WidgetDef[] {
  const blocks = [...(input.blocks ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const out: Omit<WidgetDef, 'target'>[] = [];
  const lead = input.lead ?? null;

  for (const b of blocks) {
    switch (b.id) {
      case 'peak-band':
        push(out, lastspitzeWidget(input), b.id === lead);
        break;
      case 'erloes-komposition':
        push(out, erloesWidget(input), b.id === lead);
        break;
      // 'energiefluss' steuert seit dem Merge KEINE Kacheln mehr bei: der Hero
      // (Diagramm) und das Komponenten-Board tragen die Live-Werte (R1/R2).
      case 'handel':
        push(out, handelWidget(input), b.id === lead);
        break;
      case 'eigenverbrauch':
        push(out, eigenverbrauchWidget(input), b.id === lead);
        break;
      case 'geraete-automatik':
        push(out, automatikWidget(input), b.id === lead);
        break;
      default:
        break;
    }
  }

  // Das Wetter hat keinen eigenen Modus und keinen Nav-Eintrag mehr — es ist
  // die ruhige Schluss-Kachel und ein Weg auf die Wetter-Seite (M2-6). Ohne
  // Projektion (nie migrierte Anlage) gibt es aber ÜBERHAUPT keine Kachel:
  // das Cockpit erscheint dann gar nicht (`projectionActive`), und diese
  // Funktion darf das nicht unterlaufen.
  if (blocks.length > 0) push(out, wetterWidget(input), false);

  return out.map((w) => ({ ...w, target: widgetTarget(w.id) }));
}

function push(out: Omit<WidgetDef, 'target'>[], w: WidgetBase | null, lead: boolean): void {
  if (w) out.push({ ...w, lead });
}

// --- Modus-Kacheln ----------------------------------------------------------

function lastspitzeWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const peak = input.peak;
  if (!peak) return null;
  return {
    id: 'lastspitze',
    label: 'Lastspitze',
    value: peak.currentLabel,
    sub: peak.targetLabel ? `Ziel ${peak.targetLabel}` : peak.note,
    accent: 'pv',
  };
}

function erloesWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const view = erloesKomposition({
    streams: input.streams ?? [],
    money: input.money ?? null,
    range: input.range,
    at: input.at,
    now: input.now,
  });
  if (view.isEmpty) return null;
  const total = view.totals[0] ?? null;
  return {
    id: 'erloes',
    label: 'Erlöse',
    value: total?.valueText ?? DASH,
    sub: total?.label ?? null,
    accent: 'money',
  };
}

function handelWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const view: HandelBlockView = handelBlock({
    money: input.money ?? null,
    slots: input.slots ?? [],
    now: input.now,
    slotMinutes: input.slotMinutes ?? 15,
    periodLabel: periodLabel(input.range, input.at ?? input.now, input.now),
  });
  if (view.isEmpty) return null;
  const first = view.tiles[0];
  return {
    id: 'handel',
    label: 'Handel',
    value: first.value,
    sub: first.label,
    accent: 'grid',
  };
}

function eigenverbrauchWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const view: EigenverbrauchBlockView = eigenverbrauchBlock({
    autarkiePct: input.dayTotals?.autarkiePct,
    eigenverbrauchPct: input.dayTotals?.eigenverbrauchPct,
    gridImportKwh: input.dayTotals?.gridImportKwh,
    slots: input.slots ?? [],
    now: input.now,
    slotMinutes: input.slotMinutes ?? 15,
  });
  if (view.isEmpty) return null;
  const first = view.tiles[0];
  return {
    id: 'eigenverbrauch',
    label: 'Eigenverbrauch',
    value: first.value,
    sub: first.label,
    accent: 'batt',
  };
}

function automatikWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const rows = (input.modes ?? []).filter((m) => m.kind === 'automation');
  if (rows.length === 0) return null;
  return {
    id: 'automatik',
    label: 'Geräte-Automatik',
    value: String(rows.length),
    sub: rows.length === 1 ? 'aktive Regel' : 'aktive Regeln',
    accent: 'load',
  };
}

function wetterWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const temp = num(input.weather?.nextHourTempC);
  const why = input.weather?.why ?? null;
  if (temp == null && !why) return null;
  return {
    id: 'wetter',
    label: 'Wetter',
    value: temp == null ? DASH : fmtNum(temp, '°C'),
    sub: why ?? 'Vorhersage am Standort Ihrer Anlage',
    accent: 'pv',
  };
}

// ---------------------------------------------------------------------------
// Der Hero
// ---------------------------------------------------------------------------

/** Eine Ring-Kennzahl neben dem Energiefluss. */
export interface HeroRing {
  id: 'autarkie' | 'eigenverbrauch';
  label: string;
  /** 0..100 — nur vorhanden, wenn der Tageswert wirklich gemessen wurde. */
  pct: number;
  valueText: string;
  /** CSS-Farbe (Token-`var()`). */
  hue: string;
}

/** Die Geld-Zeile des Hero — Zurechnung IMMER als Unterzeile (MIG §5). */
export interface HeroMoney {
  label: string;
  value: string;
  /** „davon X € durch VoltPilots Steuerung"; null = keine Zurechnung. */
  attribution: string | null;
}

export interface CockpitHeroView {
  rings: HeroRing[];
  /**
   * V13 (Audit): warum gerade KEIN Ring dasteht. Auf „Heute" und „Gesamt"
   * verschwanden die Ringe kommentarlos und die Seitenhöhe sprang bei jedem
   * Tab-Wechsel. Der Satz hält den Platz und erklärt ihn — nie ein Ring mit
   * einer erfundenen 0. null = es gibt Ringe.
   */
  ringsNote: string | null;
  money: HeroMoney | null;
  /** EINE deutsche Fahrplan-Zeile; null = kein Plan für heute. */
  planSentence: string | null;
}

const RING_HUE = {
  autarkie: 'var(--vp-flow-pv)',
  eigenverbrauch: 'var(--vp-flow-batt)',
} as const;

/**
 * Der Historie-Bereich, aus dem die Hero-Ringe ihre zeitraum-bezogene
 * Autarkie/Eigenverbrauch ziehen. Die Zeitraum-Tabs sprechen `EarningsRange`
 * (Heute/Monat/Jahr/Gesamt), die Historie kennt `HistoryRange`
 * (day/week/month/year) — hier die Abbildung. **„Gesamt" (`all`) hat keinen
 * All-Zeit-Historie-Endpunkt**, also `null`: der Aufrufer holt dann keine
 * Summen und die Ringe entfallen ehrlich (nie ein falscher Jahres-Wert unter
 * „Gesamt").
 */
export function historyRangeForCockpit(range: EarningsRange): HistoryRange | null {
  switch (range) {
    case 'day':
      return 'day';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return null;
  }
}

/**
 * Der Hero neben dem Energiefluss: **Autarkie** und **Eigenverbrauch** als
 * Ringe, die verdiente Summe des gewählten Zeitraums mit der Steuerungs-
 * Zurechnung als Unterzeile, und die eine Fahrplan-Zeile.
 *
 * Die Ring-Kennzahlen **folgen dem gewählten Zeitraum** (v3.2 M1): `totals`
 * sind die zeitraum-bezogenen Historie-Summen (Tag/Monat/Jahr), und das
 * Ring-Etikett trägt die Periode wie die Geld-Zeile (`Autarkie · Juli`) — nur
 * der Energiefluss selbst bleibt „jetzt gerade". „Gesamt" hat keinen All-Zeit-
 * Historie-Endpunkt, also übergibt der Aufrufer dann `totals: null` und es
 * erscheint **kein Ring** (nie ein falscher Zeitraum-Wert).
 *
 * Ehrlichkeit: ein Zeitraum-Wert, der nicht vorliegt, erzeugt **keinen Ring**
 * (nicht „0 %", M2-Akzeptanz 2); ohne berechenbaren Betrag entfällt die
 * Geld-Zeile. Die Steuerungs-Zurechnung ist NIE ein eigener Summand — sie
 * steckt bereits im Erlös und steht deshalb darunter.
 */
export function cockpitHero(input: {
  /** Die Historie-Summen des GEWÄHLTEN Zeitraums (nicht „heute"). */
  totals?: HistoryTotals | null;
  money?: CockpitMoney | null;
  range: EarningsRange;
  at?: Date;
  now: Date;
  slots?: CockpitSlot[] | null;
  slotMinutes?: number;
  plantKind?: PlanWordingKind;
}): CockpitHeroView {
  const label = periodLabel(input.range, input.at ?? input.now, input.now);
  const rings: HeroRing[] = [];
  const autarkie = num(input.totals?.autarkiePct);
  if (autarkie != null) {
    rings.push({
      id: 'autarkie',
      label: `Autarkie · ${label}`,
      pct: clampPct(autarkie),
      valueText: fmtNum(autarkie, '%', 0),
      hue: RING_HUE.autarkie,
    });
  }
  const ev = num(input.totals?.eigenverbrauchPct);
  if (ev != null) {
    rings.push({
      id: 'eigenverbrauch',
      label: `Eigenverbrauch · ${label}`,
      pct: clampPct(ev),
      valueText: fmtNum(ev, '%', 0),
      hue: RING_HUE.eigenverbrauch,
    });
  }

  const total = num(input.money?.gesamtertragEur) ?? num(input.money?.einspeiseErloesEur);
  const money: HeroMoney | null =
    total == null
      ? null
      : {
          label: `Verdient · ${label}`,
          value: eurAmount(total),
          attribution: steeringAttributionNote(input.money?.savedEur),
        };

  return {
    rings,
    ringsNote:
      rings.length > 0
        ? null
        : input.range === 'all'
          ? 'Autarkie und Eigenverbrauch gibt es je Zeitraum – wählen Sie Monat oder Jahr.'
          : `Autarkie und Eigenverbrauch liegen für ${label} noch nicht vor.`,
    money,
    planSentence: planSentence(
      input.slots ?? [],
      input.plantKind ?? 'eigenverbrauch',
      input.now,
      input.slotMinutes ?? 15,
    ),
  };
}

// ---------------------------------------------------------------------------

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}
