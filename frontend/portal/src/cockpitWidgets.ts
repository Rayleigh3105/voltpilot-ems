/**
 * Portal v3 · **M2 — das Live-Cockpit** (`docs/portal-v3/M2-cockpit.md`,
 * Konzept-Tab „3 · Live-Cockpit").
 *
 * Die Anlagen-Startseite führt mit dem **bestehenden Energiefluss-Diagramm**
 * (groß, als Hero — `components/EnergyFlow.tsx` bzw. `AdaptiveEnergyFlow.tsx`;
 * ein neues „Energie-Rad" ist ausdrücklich abgelehnt, BUILD.md §2) und darunter
 * mit einem **Widget-Raster**: Speicher · Erzeugung · Haus · Netz, dazu
 * profil-abhängig Handel, Lastspitze, Erlöse und Geräte-Automatik.
 *
 * **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2,
 * `data/vp-portal-livedata-design/report.md` §1): ein Tipp navigiert direkt zum
 * `target` der Kachel — Fluss-Kacheln in den Verlauf-Explorer, Geld-/Modus-
 * Kacheln auf ihre Seite. Das frühere Detail-Modal ist ersatzlos entfernt; die
 * Werte-Zeilen leben auf den Zielseiten (Live-Board / Bilanz / Lastspitzen /
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
 *    Lastspitze-Kachel, ohne Speicher-Kanal keine Speicher-Kachel.
 * 2. **Die „—"-Disziplin** (BUILD.md §4.2): ein nicht berechenbarer Wert
 *    rendert `—`, **nie eine erfundene 0**; eine Kachel ganz ohne Quelle
 *    entfällt, statt leer dazustehen.
 * 3. **Die Reihenfolge ist kanonisch** — sie kommt aus der Blockordnung von M0
 *    (`CockpitBlock.order`, report §1.3). Die Führungsregel (`leadSlot.ts`
 *    `leadBlock`) markiert nur, was FÜHRT; sie sortiert nichts um.
 */

import type {
  EarningsRange,
  EarningsSite,
  HistoryRange,
  HistoryTotals,
  SiteTopology,
} from './api';
import { energyLabel, periodLabel } from './anlage';
import {
  eigenverbrauchBlock,
  handelBlock,
  type CockpitSlot,
  type EigenverbrauchBlockView,
  type HandelBlockView,
} from './cockpit';
import { DASH, erloesKomposition, steeringAttributionNote } from './erloesKomposition';
import { eurAmount, fmtNum } from './format';
import type { LiveSnapshot } from './live';
import type { PeakBandView } from './peakBand';
import { planSentence, SLOT_DEADBAND_KW, type PlanWordingKind } from './schedule';
import type { ActiveMode, CockpitBlock, CockpitBlockId, MoneyStream } from './surface';
import { widgetTarget, type WidgetTarget } from './verlaufTarget';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die Kacheln des Cockpits — deterministisch, nie erfunden. */
export type WidgetId =
  | 'lastspitze'
  | 'erloes'
  | 'erzeugung'
  | 'speicher'
  | 'haus'
  | 'netz'
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
// Konstanten
// ---------------------------------------------------------------------------

/** Der Telemetriekanal, der eine Fluss-Kachel überhaupt erst entstehen lässt. */
const FLOW_CHANNELS: Record<'erzeugung' | 'speicher' | 'haus' | 'netz', string[]> = {
  erzeugung: ['pv_power_kw'],
  speicher: ['soc_pct', 'battery_power_kw'],
  haus: ['load_kw'],
  netz: ['power_kw'],
};

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
  /** Alle angelegten Telemetriekanäle (`surface.base.telemetryChannels`). */
  channels?: string[] | null;
  /**
   * Das Topologie-Read-Model — löst die Fluss-Kacheln auf ihren maßgeblichen
   * Messwert im Verlauf-Explorer auf (`widgetTarget`). Null = kein Read-Model:
   * die Fluss-Kacheln springen dann ehrlich auf die Live-Daten-Seite.
   */
  topology?: SiteTopology | null;
  /** Der jüngste Live-Schnappschuss; null = noch keiner. */
  snapshot?: LiveSnapshot | null;
  /** Die Historie-Totals des heutigen Tages (serverseitig gerechnet). */
  dayTotals?: HistoryTotals | null;
  /** Die Earnings-Zeile dieser Anlage. */
  money?: EarningsSite | null;
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
      case 'energiefluss':
        for (const w of flowWidgets(input)) push(out, w, b.id === lead);
        break;
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

  const topology = input.topology ?? null;
  return out.map((w) => ({ ...w, target: widgetTarget(w.id, topology) }));
}

function push(out: Omit<WidgetDef, 'target'>[], w: WidgetBase | null, lead: boolean): void {
  if (w) out.push({ ...w, lead });
}

// --- Fluss-Kacheln (base) ---------------------------------------------------

function flowWidgets(input: CockpitWidgetsInput): (WidgetBase | null)[] {
  return [erzeugungWidget(input), speicherWidget(input), hausWidget(input), netzWidget(input)];
}

function hasSource(
  input: CockpitWidgetsInput,
  key: keyof typeof FLOW_CHANNELS,
  values: (number | null | undefined)[],
): boolean {
  const declared = new Set(input.channels ?? []);
  if (FLOW_CHANNELS[key].some((c) => declared.has(c))) return true;
  return values.some((v) => num(v) != null);
}

function erzeugungWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const pv = num(input.snapshot?.pvKw);
  if (!hasSource(input, 'erzeugung', [pv])) return null;
  const generated = num(input.dayTotals?.pvGenerationKwh);
  return {
    id: 'erzeugung',
    label: 'Erzeugung',
    value: pv == null ? DASH : fmtNum(pv, 'kW'),
    sub: generated == null ? null : `${energyLabel(generated)} heute`,
    accent: 'pv',
  };
}

/** Der Zustandssatz des Speichers — Vorzeichen erreichen den Kunden nie. */
export function speicherStateLine(battKw: number | null | undefined): string | null {
  const v = num(battKw);
  if (v == null) return null;
  if (Math.abs(v) < SLOT_DEADBAND_KW) return 'ruht gerade';
  return v > 0 ? `lädt mit ${fmtNum(v, 'kW')}` : `entlädt mit ${fmtNum(Math.abs(v), 'kW')}`;
}

function speicherWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const soc = num(input.snapshot?.socPct);
  const batt = num(input.snapshot?.battKw);
  if (!hasSource(input, 'speicher', [soc, batt])) return null;
  const state = speicherStateLine(batt);
  return {
    id: 'speicher',
    label: 'Speicher',
    value: soc == null ? DASH : fmtNum(soc, '%', 0),
    sub: state,
    accent: 'batt',
  };
}

function hausWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const load = num(input.snapshot?.loadKw);
  if (!hasSource(input, 'haus', [load])) return null;
  const consumed = num(input.dayTotals?.consumptionKwh);
  return {
    id: 'haus',
    label: 'Haus',
    value: load == null ? DASH : fmtNum(load, 'kW'),
    sub: consumed == null ? null : `${energyLabel(consumed)} heute`,
    accent: 'load',
  };
}

/** „Bezug" / „Einspeisung" / „ausgeglichen" — nie ein Vorzeichen im UI. */
export function netzDirectionLabel(gridKw: number | null | undefined): string | null {
  const v = num(gridKw);
  if (v == null) return null;
  if (Math.abs(v) < SLOT_DEADBAND_KW) return 'ausgeglichen';
  return v > 0 ? 'Netzbezug' : 'Einspeisung';
}

function netzWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const grid = num(input.snapshot?.gridKw);
  if (!hasSource(input, 'netz', [grid])) return null;
  return {
    id: 'netz',
    label: 'Netz',
    value: grid == null ? DASH : fmtNum(Math.abs(grid), 'kW'),
    sub: netzDirectionLabel(grid),
    accent: 'grid',
  };
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
  money?: EarningsSite | null;
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
