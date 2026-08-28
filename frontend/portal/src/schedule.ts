/**
 * Pure Fahrplan-slot logic (unit-tested; ScheduleChart only renders it).
 *
 * The grid-charging switch (site.netzladen_erlaubt) makes it matter WHERE a
 * charging slot's energy comes from: a slot whose charge EXCEEDS the PV
 * available in that slot is a grid-charge slot ("Laden aus dem Netz") and gets
 * its own cyan color in the chart - on an EEG site that color can never
 * appear, so the chart itself is the visible proof that only solar is stored.
 * The kind is DERIVED from the persisted plan: since FK3 (PV-bus semantics)
 * an EEG site legitimately charges solar WHILE the house imports its load, so
 * "charging while net-importing" alone is no longer grid-charging - grid
 * energy enters the battery only when battery_kw > pv_kw - curtail_kw (the
 * solver's own solar-only bound). Slots without a PV value (pre-pvKw runs)
 * fall back to the old import-based derivation.
 */

import type { Kernaussage } from './chartKopf';
import { storageMark, type StorageMark } from './chartStyle';
import type { ChartTheme } from './chartTheme';
import { proofAnchor } from './fleet';
import { eurAmount, fmtNum, NBSP } from './format';

/** Matches the chart's "hält" deadband (0.05 kW) so tiny solver noise stays idle. */
export const SLOT_DEADBAND_KW = 0.05;

/**
 * How far the charge must exceed the slot's available PV before it counts as
 * grid-fed - forecast jitter and persisted rounding must not flicker a solar
 * charge cyan (the EEG solver binds charge == pv exactly on cloudy days).
 */
export const PV_SOURCE_DEADBAND_KW = 0.1;

export type ChargeKind = 'netzladen' | 'solarladen' | 'entladen' | 'ruhe';

/** What one plan slot does with the battery, energy-source-honest. */
export function chargeKind(
  batteryKw: number | null,
  gridKw: number | null,
  pvKw?: number | null,
  curtailKw?: number | null,
): ChargeKind {
  // Coerce defensively (API decimals arrive as JSON numbers, but the chart
  // code wraps every value in Number() - mirror that convention here).
  const batt = batteryKw == null ? null : Number(batteryKw);
  const grid = gridKw == null ? null : Number(gridKw);
  if (batt == null || Math.abs(batt) <= SLOT_DEADBAND_KW) return 'ruhe';
  if (batt < 0) return 'entladen';
  // Charging: grid energy can only flow INTO the battery while the slot
  // net-imports - an exporting slot's charge is covered by PV by definition.
  if (grid == null || grid <= SLOT_DEADBAND_KW) return 'solarladen';
  const pv = pvKw == null ? null : Number(pvKw);
  if (pv == null || !Number.isFinite(pv)) {
    // No PV data (pre-pvKw runs): the old, coarser import-based rule.
    return 'netzladen';
  }
  // PV-bus semantics (FK3): the battery may charge up to the PV actually
  // produced (pv minus planned curtailment) while the house imports its load
  // in parallel - only charge BEYOND that draws grid energy.
  const curtail = curtailKw == null ? 0 : Math.max(Number(curtailKw), 0);
  const available = Math.max(pv - curtail, 0);
  return batt > available + PV_SOURCE_DEADBAND_KW ? 'netzladen' : 'solarladen';
}

/** Whether any slot of the plan charges from the grid (drives the legend entry). */
export function hasGridCharge(
  slots: {
    batteryKw: number | null;
    gridKw: number | null;
    pvKw?: number | null;
    curtailKw?: number | null;
  }[],
): boolean {
  return slots.some((s) => chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw) === 'netzladen');
}

/**
 * Die MARKE eines Plan-Slots (Farbe + Form) aus der geteilten Chart-Sprache:
 * grün gefüllt = Solarladen, türkis gefüllt = Netzladen, beere gefüllt =
 * Entladen. Die Richtung tragen zusätzlich Position (über/unter Null) und Wort.
 * Begründung + Messung in `chartStyle.ts` `storageMark`.
 *
 * Entladen nimmt weiterhin ausdrücklich NICHT das rote `discharge` (Audit F5):
 * die Batterie in eine teure Stunde zu entleeren ist die Art, wie die Anlage
 * verdient - Rot bleibt echten Kosten und Warnungen vorbehalten.
 */
export function slotBarMark(kind: ChargeKind, t: ChartTheme): StorageMark {
  if (kind === 'netzladen') return storageMark('netzladen', t);
  if (kind === 'entladen') return storageMark('entladen', t);
  return storageMark('laden', t);
}

/** Nur die Farbe derselben Marke - für Flächen ohne eigene Form (CSS-Punkte). */
export function slotBarColor(kind: ChargeKind, t: ChartTheme): string {
  return slotBarMark(kind, t).color;
}

// ---- Plan freshness (audit F2) ----------------------------------------------

/**
 * The optimizer re-plans every 15 minutes, so a plan older than this is not
 * "the current plan" any more - something upstream stopped (no new prices, no
 * telemetry, optimizer down). Two hours is eight missed runs: generous enough
 * that a single hiccup stays quiet, tight enough that a day-old plan can never
 * be presented as today's.
 */
export const PLAN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * ONE honest German banner line for a stale plan (audit F2): a plan generated
 * yesterday was shown as "So plant Ihr Speicher den Tag" with a date-less
 * x-axis, so the customer believed they were looking at today. States only
 * what is verifiable from the plan itself - WHEN it was made and that no newer
 * one exists - and never guesses the cause (device offline / prices missing /
 * optimizer down are indistinguishable from here). Null = fresh plan (or no
 * generation timestamp), and the page then renders exactly as before.
 */
export function planStaleNote(
  generatedAt: string | null | undefined,
  slots: { start: string }[],
  now: Date,
  slotMinutes = 15,
): string | null {
  if (!generatedAt) return null;
  const gen = new Date(generatedAt);
  const genMs = gen.getTime();
  if (!Number.isFinite(genMs)) return null;
  if (now.getTime() - genMs < PLAN_STALE_AFTER_MS) return null;

  const time = gen.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const when =
    gen.toDateString() === now.toDateString()
      ? `von heute, ${time} Uhr`
      : gen.toDateString() === yesterday.toDateString()
        ? `von gestern, ${time} Uhr`
        : `vom ${gen.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}, ${time} Uhr`;

  const note = `Dieser Fahrplan stammt ${when} – seitdem wurde kein neuer Fahrplan berechnet.`;
  return planCoversNow(slots, now, slotMinutes)
    ? note
    : `${note} Die Balken zeigen einen bereits vergangenen Zeitraum, nicht den heutigen Tag.`;
}

/** Whether `now` falls inside the plan's horizon (first slot .. last slot end). */
export function planCoversNow(
  slots: { start: string }[],
  now: Date,
  slotMinutes = 15,
): boolean {
  if (slots.length === 0) return false;
  const first = new Date(slots[0].start).getTime();
  const end = new Date(slots[slots.length - 1].start).getTime() + slotMinutes * 60_000;
  const t = now.getTime();
  return t >= first && t < end;
}

// ---- Planned state of charge (audit F4) -------------------------------------

/**
 * The planned Ladestand band of the plan (min/max in %). The SoC line rides a
 * secondary 0-100 axis over a kW axis, so without a readable scale it appears
 * to dip "below zero"; naming the band in plain text makes the trajectory
 * readable without hovering (which touch devices cannot do at all). Null when
 * the plan carries no SoC values - never a fabricated 0.
 */
export function socRange(
  slots: { socPct: number | null }[],
): { min: number; max: number } | null {
  const values = slots
    .map((s) => (s.socPct == null ? null : Number(s.socPct)))
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** "Geplanter Ladestand: 12 % bis 88 %." - null when the plan has no SoC. */
export function socRangeLine(slots: { socPct: number | null }[]): string | null {
  const range = socRange(slots);
  if (!range) return null;
  const pct = (v: number) => `${Math.round(v).toLocaleString('de-DE')}${NBSP}%`;
  return range.max - range.min < 1
    ? `Geplanter Ladestand: durchgehend rund ${pct(range.min)}.`
    : `Geplanter Ladestand: ${pct(range.min)} bis ${pct(range.max)} im Tagesverlauf.`;
}

// ---- Forecast lines: PV + Verbrauch over the plan (captain 2026-07-29) ------

/**
 * The two forecast INPUTS the optimizer planned each slot with (`schedule.pv_kw`
 * / `schedule.load_kw`). They are drawn as thin dotted lines over the battery
 * bars because they EXPLAIN the plan: "warum hält er abends? da liegt die
 * Nachtlast", "warum lädt er mittags? da ist die PV-Spitze".
 *
 * The labels ARE the echarts series names AND the legend keys, so a legend
 * toggle maps to a hidden series without a second mapping table.
 */
export const PV_FORECAST_LABEL = 'PV-Prognose';
export const LOAD_FORECAST_LABEL = 'Verbrauchsprognose';

/**
 * P3 "Ist-Last sichtbar" (report vp-netzbezug-nacht-s3 §6): the MEASURED house
 * consumption next to its forecast. It shares the forecast's colour (same
 * quantity) but is drawn SOLID while the forecast stays dotted, so the gap
 * between the two - the forecast error the plan settled at the grid - is the
 * thing you see. Only slots that already happened carry a value.
 */
export const MEASURED_LOAD_LABEL = 'Verbrauch (gemessen)';

/**
 * The mirror of the Ist-Last line for the OTHER forecast the plan runs on: the
 * MEASURED PV production next to its dotted PV-Prognose. Same convention -
 * gepunktet = Prognose, durchgezogen = gemessen, gleiche Farbe je Größe - so
 * two things become checkable instead of merely computable: the PV forecast
 * error, and the Solarladen-Regel "Laden <= gemessene PV" (an EEG plant's
 * charge bar may never exceed this line).
 */
export const MEASURED_PV_LABEL = 'PV (gemessen)';

export interface PlanLine {
  /** The series/legend name (see the label constants). */
  label: string;
  /** One point per slot, `null` where the run carries no value for it. */
  values: (number | null)[];
  /** True when at least ONE slot carries a value - else the line is omitted. */
  present: boolean;
  /** Largest value on the line (for the kW axis headroom); null when absent. */
  maxKw: number | null;
  /** How many slots actually carry a value (drives the point markers). */
  count: number;
}

export interface ForecastLines {
  pv: PlanLine;
  load: PlanLine;
}

function forecastLine(label: string, raw: (number | null | undefined)[]): PlanLine {
  const values = raw.map((v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
  const nums = values.filter((v): v is number => v != null);
  return {
    label,
    values,
    present: nums.length > 0,
    maxKw: nums.length ? Math.max(...nums) : null,
    count: nums.length,
  };
}

/**
 * The PV + load forecast series of a plan, slot-aligned with the bars.
 *
 * Honesty: an absent value stays absent (`null` -> gap in the line), never a
 * fabricated 0 - a pre-feature run simply has no forecast lines, and a plan
 * that carries only PV shows only the PV line.
 */
export function forecastLines(
  slots: { pvKw?: number | null; loadKw?: number | null }[],
): ForecastLines {
  return {
    pv: forecastLine(PV_FORECAST_LABEL, slots.map((s) => s.pvKw)),
    load: forecastLine(LOAD_FORECAST_LABEL, slots.map((s) => s.loadKw)),
  };
}

/**
 * The MEASURED consumption line (P3): `schedule.measuredLoadKw`, the
 * quarter-hour mean of the metered house load, slot-aligned with the bars.
 *
 * Honesty, identical to the forecast lines: an absent measurement stays absent
 * (`null` -> gap, `connectNulls: false`), never a fabricated 0 - a future slot,
 * a slot the device did not report and a site with no load channel all simply
 * have no point. A backend that does not serve the field yields no line at all.
 */
export function measuredLoadLine(slots: { measuredLoadKw?: number | null }[]): PlanLine {
  return forecastLine(MEASURED_LOAD_LABEL, slots.map((s) => s.measuredLoadKw));
}

/**
 * The MEASURED PV line - `schedule.measuredPvKw`, the quarter-hour mean of the
 * metered PV production, slot-aligned with the bars and built exactly like its
 * load twin.
 *
 * Honesty, identical: an absent measurement stays absent (`null` -> gap), never
 * a fabricated 0 - a site whose device reports no PV channel simply has no
 * line, which must not read as "die Sonne schien nicht".
 */
export function measuredPvLine(slots: { measuredPvKw?: number | null }[]): PlanLine {
  return forecastLine(MEASURED_PV_LABEL, slots.map((s) => s.measuredPvKw));
}

/**
 * True when the measured line is so short that a plain stroke would be
 * invisible (the normal case: an MPC plan starts at the running quarter hour,
 * so only one or two slots are in the past). The chart then draws point markers
 * instead of relying on the stroke - showing the value, never hiding it.
 */
export function needsPointMarkers(line: PlanLine): boolean {
  return line.count > 0 && line.count <= 4;
}

/**
 * Why a measured line is missing, in ONE plain-German sentence covering both
 * channels - shown only when there is genuinely something to explain:
 *
 * - the plan must HAVE slots in the past (before that there is nothing to
 *   compare yet, and claiming a gap would be noise), and
 * - the channel must carry a FORECAST on this plan. The note explains the
 *   missing twin of a drawn Prognose line; a plant whose plan has no
 *   PV-Prognose (no PV at all, or a pre-feature run) is never told its PV
 *   measurements are missing.
 *
 * Null = every drawn forecast has its measured twin, or there is nothing to
 * compare yet.
 */
export function measuredNote(
  slots: {
    start: string;
    pvKw?: number | null;
    loadKw?: number | null;
    measuredLoadKw?: number | null;
    measuredPvKw?: number | null;
  }[],
  now: Date,
  slotMinutes = 15,
): string | null {
  const cutoff = now.getTime() - slotMinutes * 60_000;
  const elapsed = slots.some((s) => new Date(s.start).getTime() <= cutoff);
  if (!elapsed) return null;
  const forecast = forecastLines(slots);
  const loadMissing = forecast.load.present && !measuredLoadLine(slots).present;
  const pvMissing = forecast.pv.present && !measuredPvLine(slots).present;
  const what =
    loadMissing && pvMissing
      ? 'von Verbrauch und PV-Erzeugung'
      : loadMissing
        ? 'des Verbrauchs'
        : pvMissing
          ? 'der PV-Erzeugung'
          : null;
  if (!what) return null;
  return `Für die bereits vergangenen Viertelstunden liegen keine Messwerte ${what} vor.`;
}

/* -------------------------------------------------------------------------
 * Duty-Vorschau: die zwei IN-SLOT-PFLICHTEN im PLAN (Konzept
 * `vp-fahrplan-kunde-konzept` §5/§8 „PR 4").
 *
 * Seit den In-Slot-Pflichten ist der Watt-Wert eines markierten Slots eine
 * VORHERSAGE, kein Befehl: die Box führt in der Viertelstunde den GEMESSENEN
 * Hausverbrauch nach (Entladeseite) bzw. lädt nur den GEMESSENEN
 * Solar-Überschuss (Ladeseite). Bisher erfuhr der Kunde das erst IM Slot (aus
 * dem Ausführungs-Block des Herzschlags); jetzt steht es schon im Plan.
 *
 * Hier liegen die WORTE dafür - EINMAL, geteilt von Film und Diagramm-Tooltip,
 * damit dieselbe Pflicht nie zwei Namen bekommt.
 * ---------------------------------------------------------------------- */

/** Welche der beiden Pflichten ein Slot trägt. */
export type SlotDuty = 'verbrauch-folgen' | 'ueberschuss-laden';

/** Das Minimum, das eine Pflicht-Ableitung von einem Slot braucht. */
export interface DutySlotLike {
  coverLoadFromBattery?: boolean | null;
  chargeFromSurplusOnly?: boolean | null;
}

const DUTY_LABEL: Record<SlotDuty, string> = {
  'verbrauch-folgen': 'folgt dem gemessenen Verbrauch',
  'ueberschuss-laden': 'lädt nur den Solar-Überschuss',
};

const DUTY_LABEL_PARTIAL: Record<SlotDuty, string> = {
  'verbrauch-folgen': 'folgt zeitweise dem gemessenen Verbrauch',
  'ueberschuss-laden': 'lädt zeitweise nur den Solar-Überschuss',
};

/** Der ausführliche Satz (Tipp/`title`) - warum der Watt-Wert nicht fix ist. */
export const DUTY_HINT: Record<SlotDuty, string> = {
  'verbrauch-folgen':
    'Der Wert dieser Phase ist eine Vorhersage: Ihre Batterie deckt in der ' +
    'Viertelstunde genau den gemessenen Verbrauch, damit kein Netzstrom nötig wird.',
  'ueberschuss-laden':
    'Der Wert dieser Phase ist eine Vorhersage: Ihre Batterie lädt in der ' +
    'Viertelstunde nur den gemessenen Solar-Überschuss, statt Strom dazuzukaufen.',
};

/**
 * Das Wort der Pflicht. `partial` = nur ein TEIL der Viertelstunden einer
 * Phase trägt sie (das ist der Normalfall, weil der Optimierer die Pflicht nur
 * auf Slots ohne geplanten Netzhandel setzt) - dann sagt die Zeile „zeitweise"
 * statt pauschal für die ganze Phase zu sprechen.
 */
export function dutyLabel(kind: SlotDuty, partial = false): string {
  return (partial ? DUTY_LABEL_PARTIAL : DUTY_LABEL)[kind];
}

/** Die eine Zeile für den Diagramm-Tooltip einer Viertelstunde. */
export function dutyTooltip(kind: SlotDuty): string {
  return `Vorhersage, kein fester Befehl — ${DUTY_LABEL[kind]}`;
}

/**
 * Die Pflicht EINES Slots, oder null.
 *
 * Streng auf `=== true`: die Spalten sind DREIWERTIG - `null`/`undefined` =
 * gar nicht bewertet (älterer Lauf, Schalter aus), `false` = bewertet und
 * keine Pflicht. Beides darf nichts markieren, sonst wäre die Vorschau
 * geraten. Die zwei Pflichten schließen sich physikalisch aus (Entladen vs.
 * Laden); käme je beides an, gewinnt die Entladeseite, statt zu raten.
 */
export function slotDuty(slot: DutySlotLike): SlotDuty | null {
  if (slot.coverLoadFromBattery === true) return 'verbrauch-folgen';
  if (slot.chargeFromSurplusOnly === true) return 'ueberschuss-laden';
  return null;
}

/**
 * Toggle one series in the hidden set (the legend rows are toggle buttons).
 * Returns a NEW set so React state updates are honest.
 */
export function toggleSeries(hidden: ReadonlySet<string>, label: string): Set<string> {
  const next = new Set(hidden);
  if (!next.delete(label)) next.add(label);
  return next;
}

// ---- Die drei Serien-GRUPPEN des Fahrplan-Diagramms (Captain-Entscheid D4) --

/**
 * Der Kern des Diagramms — Balken + Preis + Jetzt — ist immer da. Alles
 * Weitere ist eine bewusst zugeschaltete SCHICHT statt einer Dauerlast:
 * sieben Reihen gleichzeitig (darunter DREI blaue Linien) waren nur für den
 * Autor lesbar, und neun Einzel-Pills kosteten am Telefon allein 339 px.
 */
export type SeriesGroup = 'prognosen' | 'gemessen' | 'ladestand';

export interface SeriesGroupDef {
  id: SeriesGroup;
  /** Die Beschriftung des Schalters. */
  label: string;
  /** Die Serien-/Legenden-Schlüssel dieser Gruppe (die echarts-Namen). */
  members: readonly string[];
}

/** Das Ladestand-Label ist zugleich der echarts-Seriennamen der SoC-Linie. */
export const SOC_LABEL = 'Ladestand';

/**
 * Die drei Gruppen in Anzeigereihenfolge. Die `members` SIND die
 * Legenden-/Serien-Schlüssel, also braucht der Umschalter keine zweite
 * Zuordnungstabelle (dieselbe Disziplin wie bei den Prognose-Labels).
 */
export const SERIES_GROUPS: readonly SeriesGroupDef[] = [
  { id: 'prognosen', label: 'Prognosen', members: [PV_FORECAST_LABEL, LOAD_FORECAST_LABEL] },
  { id: 'gemessen', label: 'Gemessen', members: [MEASURED_PV_LABEL, MEASURED_LOAD_LABEL] },
  { id: 'ladestand', label: 'Ladestand', members: [SOC_LABEL] },
];

/**
 * Der ruhige Standard: KEINE Gruppe an. Wer vergleichen will, schaltet
 * bewusst eine Schicht dazu (§6.4) - die Kollision dreier blauer Linien
 * verschwindet damit aus dem Normalbild.
 */
export function defaultHiddenGroups(): Set<SeriesGroup> {
  return new Set<SeriesGroup>(SERIES_GROUPS.map((g) => g.id));
}

/** Eine Gruppe ein-/ausschalten; liefert ein NEUES Set (ehrliche Zustände). */
export function toggleGroup(
  hidden: ReadonlySet<SeriesGroup>,
  group: SeriesGroup,
): Set<SeriesGroup> {
  const next = new Set(hidden);
  if (!next.delete(group)) next.add(group);
  return next;
}

/**
 * Die versteckten SERIEN-Schlüssel zu einem Gruppen-Zustand - die Brücke zu
 * allem, was weiterhin über Labels arbeitet (`powerAxisMax`, die Legende).
 */
export function hiddenLabels(hidden: ReadonlySet<SeriesGroup>): Set<string> {
  const out = new Set<string>();
  for (const g of SERIES_GROUPS) {
    if (hidden.has(g.id)) for (const m of g.members) out.add(m);
  }
  return out;
}

/**
 * Upper bound of the chart's kW axis: the battery peak, plus whatever VISIBLE
 * line reaches higher (a 60-kW PV forecast - or a measured load spike - must
 * not be clipped by a 15-kW battery scale), plus the optional peak-shaving
 * target. Always >= 1 so an all-idle plan still gets a sane axis. Accepts the
 * {@link ForecastLines} pair or an explicit list of lines.
 */
export function powerAxisMax(
  batteryPeakKw: number,
  lines: ForecastLines | readonly PlanLine[],
  hidden: ReadonlySet<string>,
  targetKw?: number | null,
): number {
  const all: readonly PlanLine[] = Array.isArray(lines)
    ? lines
    : [(lines as ForecastLines).pv, (lines as ForecastLines).load];
  const candidates = [batteryPeakKw, 1];
  for (const line of all) {
    if (line.present && !hidden.has(line.label) && line.maxKw != null) candidates.push(line.maxKw);
  }
  if (targetKw != null && targetKw > 0) candidates.push(targetKw);
  return Math.max(...candidates);
}

// ---- The chart takeaway sentence (audit F3) ---------------------------------

/** One piece of the takeaway sentence; `strong` renders bold in the chart. */
export interface InsightPart {
  text: string;
  strong?: boolean;
}

/** Weighted-average ct/kWh over the slots where `weight(batteryKw)` is positive. */
export function weightedPriceCt(
  slots: { batteryKw: number | null; priceEurMwh: number | null }[],
  weight: (batteryKw: number) => number,
): number | null {
  let num = 0;
  let den = 0;
  for (const s of slots) {
    if (s.batteryKw == null || s.priceEurMwh == null) continue;
    const w = weight(Number(s.batteryKw));
    if (w <= 0) continue;
    num += w * (Number(s.priceEurMwh) / 10);
    den += w;
  }
  return den > 0 ? num / den : null;
}

function ctLabel(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${NBSP}ct/kWh`;
}

/** The slot fields the idle-reason derivation reads (all optional: a plan from
 * a pre-why optimizer simply carries none of them). */
export interface IdleSlotLike {
  batteryKw: number | null;
  priceEurMwh?: number | null;
  slotRole?: string | null;
  slotFlags?: string[] | null;
  storedValueCtKwh?: number | null;
}

/**
 * Why an idle stretch of the plan is idle - taken from what the optimizer
 * RECORDED, never guessed.
 *
 * `null` means the reason was not computed (a plan from before the why-layer,
 * or a run whose explain pass failed). Callers must then say only that the
 * battery is idle and stop: the whole point of this function is that an
 * uncomputed cause stays absent instead of being invented.
 *
 * Background: the previous copy asserted "die Preisunterschiede lohnen kein
 * Laden und Entladen" as a blanket fallback that inspected no price at all.
 * That is what hid the flat-tariff freeze (scout vp-fahrplan-idle-n7) for as
 * long as it lasted - the plan was idle over a 20 ct spread and told its owner
 * the spread was too small. Had it named the real cause ("stored energy is
 * valued at 28.3 ct/kWh, above the 20 ct peak") it would have pointed straight
 * at the terminal value.
 */
export type IdleReason =
  | { kind: 'reserve'; driver: 'notstrom' | 'lastspitze' | null }
  | { kind: 'stored_value_above_peak'; storedCt: number; bestCt: number }
  | { kind: 'warten' };

export function idleReason(slots: IdleSlotLike[]): IdleReason | null {
  const idle = slots.filter(
    (s) => Math.abs(Number(s.batteryKw ?? 0)) < SLOT_DEADBAND_KW,
  );
  const roles = idle.map((s) => s.slotRole).filter((r): r is string => !!r);
  if (roles.length === 0) return null; // not computed - say nothing

  const counts = new Map<string, number>();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  let dominant = roles[0];
  for (const [role, n] of counts) {
    if (n > (counts.get(dominant) ?? 0)) dominant = role;
  }

  const flagged = (flag: string) =>
    idle.some((s) => s.slotRole === dominant && (s.slotFlags ?? []).includes(flag));

  if (dominant === 'reserve_halten') {
    if (flagged('reserve_backup')) return { kind: 'reserve', driver: 'notstrom' };
    if (flagged('reserve_peak')) return { kind: 'reserve', driver: 'lastspitze' };
    return { kind: 'reserve', driver: null };
  }

  if (dominant === 'warten') {
    // The diagnostic that would have exposed the freeze: stored energy valued
    // above anything the window can pay for it. Compared on the SHOWN (0.1 ct)
    // precision so the sentence's "mehr als" is always literally true - equal
    // values are a tie, and a tie is honestly just "waiting".
    const stored = idle
      .map((s) => s.storedValueCtKwh)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const prices = slots
      .map((s) => s.priceEurMwh)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (stored.length > 0 && prices.length > 0) {
      const storedCt = round1(Math.max(...stored));
      const bestCt = round1(Math.max(...prices) / 10);
      if (storedCt > bestCt) {
        return { kind: 'stored_value_above_peak', storedCt, bestCt };
      }
    }
    return { kind: 'warten' };
  }

  // Any other role on an idle stretch (or a vocabulary we do not know yet):
  // no verified claim to make.
  return null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** The idle reason as bold/plain parts, or the bare "in Ruhe" statement when
 * the optimizer recorded no reason. */
function idleParts(slots: IdleSlotLike[]): InsightPart[] {
  const reason = idleReason(slots);
  if (reason == null) {
    // Not computed -> state the observation, claim no cause.
    return [
      { text: 'Der Speicher bleibt in diesem Zeitraum ' },
      { text: 'in Ruhe', strong: true },
      { text: '.' },
    ];
  }
  if (reason.kind === 'reserve') {
    const tail =
      reason.driver === 'notstrom'
        ? ' als Notstrom-Reserve zurück.'
        : reason.driver === 'lastspitze'
          ? ' als Reserve für die Lastspitzenkappung zurück.'
          : ' als Reserve zurück.';
    return [
      { text: 'Der Speicher ' },
      { text: 'hält seine Ladung', strong: true },
      { text: tail },
    ];
  }
  if (reason.kind === 'stored_value_above_peak') {
    return [
      { text: 'Der Speicher ' },
      { text: 'hält seine Ladung', strong: true },
      {
        text:
          ` - die gespeicherte Energie ist mit ${ctLabel(reason.storedCt)} bewertet, ` +
          `mehr als der höchste Preis im Zeitraum (${ctLabel(reason.bestCt)}).`,
      },
    ];
  }
  // BEOBACHTEND, nicht kausal (Erklärbarkeit Stufe 0): der `warten`-Zweig hat
  // strukturell mehrere Treiber, und nur zwei davon sind exportiert (voll,
  // Reserve). Der λ-über-Fenster-Treiber steht als eigener Zweig darüber.
  return [
    { text: 'Der Speicher ' },
    { text: 'wartet', strong: true },
    { text: ' - weder Laden noch Entladen ist in diesem Zeitraum eingeplant.' },
  ];
}

/**
 * The chart's takeaway in plain German, as bold/plain parts (audit F3).
 *
 * The clauses are MUTUALLY EXCLUSIVE by construction: the "flacher
 * Preisverlauf - der Speicher bleibt in Ruhe" ending may only appear when the
 * plan really is idle. Before this it was the else-branch of the savings
 * clause, so a plant that visibly cycled over a 3 → 17 ct curve was told its
 * price curve was flat whenever today's planned saving happened to be <= 0
 * (bank days, or a plan that does not cover today at all).
 *
 * Null = nothing honest to say (no priced slots at all).
 */
export function planInsightParts(
  slots: {
    start: string;
    batteryKw: number | null;
    gridKw: number | null;
    pvKw?: number | null;
    curtailKw?: number | null;
    priceEurMwh: number | null;
    costEur: number | null;
    baselineCostEur: number | null;
    /** Why-layer facts; absent on plans from before the explain layer. */
    slotRole?: string | null;
    slotFlags?: string[] | null;
    storedValueCtKwh?: number | null;
  }[],
  now: Date,
): InsightPart[] | null {
  const chargeCt = weightedPriceCt(slots, (kw) => Math.max(kw, 0));
  const dischargeCt = weightedPriceCt(slots, (kw) => Math.max(-kw, 0));
  const gridCharging = hasGridCharge(slots);
  const saved = savingsTodayEur(slots, now);
  const parts: InsightPart[] = [];

  if (chargeCt != null && dischargeCt != null) {
    parts.push({ text: 'Der Speicher ' });
    parts.push({ text: 'lädt günstig', strong: true });
    if (gridCharging) parts.push({ text: ' - auch aus dem Netz (türkis)' });
    parts.push({ text: ` (Ø ${ctLabel(chargeCt)}) und ` });
    parts.push({ text: 'entlädt teuer', strong: true });
    parts.push({ text: ` (Ø ${ctLabel(dischargeCt)}), um den Verbrauch aus dem Speicher zu decken` });
    if (saved != null && saved > 0.005) {
      parts.push({ text: ' - das spart heute rund ' });
      parts.push({ text: eurAmount(saved), strong: true });
      parts.push({ text: ' gegenüber einem Betrieb ohne Speicher.' });
    } else {
      parts.push({ text: '.' });
    }
    return parts;
  }

  if (chargeCt != null) {
    parts.push({ text: 'Der Speicher ' });
    parts.push({ text: 'lädt', strong: true });
    parts.push({
      text: ` in diesem Zeitraum nur (Ø ${ctLabel(chargeCt)}) und hält die Energie für später zurück.`,
    });
    return parts;
  }

  if (dischargeCt != null) {
    parts.push({ text: 'Der Speicher ' });
    parts.push({ text: 'entlädt', strong: true });
    parts.push({
      text: ` in diesem Zeitraum nur (Ø ${ctLabel(dischargeCt)}) und deckt damit den Verbrauch.`,
    });
    return parts;
  }

  if (slots.some((s) => s.priceEurMwh != null)) {
    return idleParts(slots);
  }
  return null;
}

// ---- Fahrplan mini preview (the Anlagen-Seite's "Fahrplan · heute" card) -------

/** The slot fields the mini-preview derivations need. */
export interface PlanSlotLike {
  start: string;
  batteryKw: number | null;
  gridKw: number | null;
  /** PV forecast the slot planned with (kW); absent = pre-pvKw fallback. */
  pvKw?: number | null;
  /** Planned PV curtailment (kW held back, >= 0). */
  curtailKw?: number | null;
  /** Why-layer facts, used only to name the reason an all-idle day is idle
   * (absent on plans from before the explain layer). */
  priceEurMwh?: number | null;
  slotRole?: string | null;
  slotFlags?: string[] | null;
  storedValueCtKwh?: number | null;
}

/** The plan's slots that fall on the local calendar day of `now`. */
export function todaySlots<T extends { start: string }>(slots: T[], now: Date): T[] {
  const day = now.toDateString();
  return slots.filter((s) => new Date(s.start).toDateString() === day);
}

/** Was der Fahrplan für heute an Geld vorsieht - drei Zahlen EINER Rechnung. */
export interface PlannedDayCosts {
  /** Geplante Stromkosten mit VoltPilot (signierte Kosten, negativ = Erlös). */
  actualEur: number;
  /** Dieselben Slots ohne Speicher (signierte Kosten). */
  baselineEur: number;
  /** `baselineEur - actualEur` - die Ersparnis, also die DIFFERENZ der zwei. */
  savedEur: number;
}

/**
 * Die drei Geld-Zahlen des heutigen Plans, über die GLEICHE Slot-Menge
 * gerechnet: nur Viertelstunden, die BEIDE Kosten tragen.
 *
 * ⚠ Genau darin liegt der Punkt. Die Ersparnis über den Slots mit beiden
 * Werten zu summieren, den Anker aber über alle Slots MIT Baseline, mischt
 * zwei verschiedene Zeitfenster in einen Vergleich - dieselbe Äpfel-Birnen-
 * Klasse wie „Ersparnis gegen Kosten". Es gibt deshalb nur diese eine
 * Ableitung, und der Anker rechnet nie eigenständig nach.
 *
 * Null, wenn keine Viertelstunde von heute Kosten trägt - „kein Fahrplan"
 * darf nie als ±0,00 € erscheinen.
 */
export function plannedDayCosts(
  slots: { start: string; costEur: number | null; baselineCostEur: number | null }[],
  now: Date,
): PlannedDayCosts | null {
  const priced = todaySlots(slots, now).filter(
    (s) => s.costEur != null && s.baselineCostEur != null,
  );
  if (priced.length === 0) return null;
  const actualEur = priced.reduce((sum, s) => sum + (s.costEur ?? 0), 0);
  const baselineEur = priced.reduce((sum, s) => sum + (s.baselineCostEur ?? 0), 0);
  return { actualEur, baselineEur, savedEur: baselineEur - actualEur };
}

/**
 * Today's planned saving vs. the no-battery baseline, summed over the slots
 * with cost data. Null when no slot of today carries costs - "no plan" must
 * never render as a fake ±0,00 €.
 */
export function savingsTodayEur(
  slots: { start: string; costEur: number | null; baselineCostEur: number | null }[],
  now: Date,
): number | null {
  return plannedDayCosts(slots, now)?.savedEur ?? null;
}

/**
 * Der Halbsatz, der die Zahl BENENNT - mit ihrer Richtung im WORT, nie im
 * Vorzeichen (die `proofLine`/`bankedValueLine`-Disziplin des Hauses: Beträge
 * sind absolut, die Beschriftung trägt die Richtung).
 *
 * Eine negative Ersparnis ist ein realer Fall (der Fahrplan legt Energie in
 * den Folgetag, oder er hat an diesem Tag wirklich Geld gekostet) und wird
 * hier ausgesprochen, nie als Gewinn getönt - der Ton bleibt dafür `calm`.
 */
export function plannedSavingLabel(kind: PlanWordingKind, savedEur: number): string {
  if (savedEur >= 0) {
    return kind === 'direktvermarktung'
      ? 'verdient der Fahrplan heute mehr'
      : 'spart der Fahrplan heute ein';
  }
  return kind === 'direktvermarktung'
    ? 'holt der Fahrplan heute weniger heraus als eine ungeregelte Anlage'
    : 'kostet der Fahrplan heute mehr als ohne Speicher';
}

/** Kleinschreibung des ersten Zeichens, damit ein Satz eingebettet werden kann. */
function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * K1/M11 · Die KERNAUSSAGE des Fahrplan-Diagramms — die Zahl, die zählt, plus
 * ihr Satz, plus der Vergleichsanker (K8).
 *
 * ⚠ Sie ist ZUSAMMENGESETZT, nicht neu gerechnet: die Aktivität ist
 * {@link planSentence}, die Zahlen sind {@link plannedDayCosts}, der Anker ist
 * das `fleet.proofAnchor`-Paar. Es entsteht hier KEINE zweite Wahrheit — genau
 * das ist die Auflage aus r2 §10, weil ein falsch abgeleiteter Satz schlimmer
 * wäre als kein Satz.
 *
 * ⚠ DIE REGEL, an der die zwei Felder hängen (Kundenbefund 11.08.2026): der
 * ANKER vergleicht dieselbe Größe wie sich selbst - Kosten gegen Kosten -, und
 * der SATZ benennt, dass die Zahl darüber die ERSPARNIS ist. Vorher stand über
 * „Ohne Speicher wären es 1,90 €." die Ersparnis 0,35 €, was sich las, als
 * mache der Speicher es schlechter. Beide Zahlen waren richtig, der Vergleich
 * war es nicht. Wer hier eine Zahl ergänzt, sagt dazu, WAS sie ist.
 *
 * Ohne planbare Aussage bleibt `satz` null und `grund` trägt den ehrlichen
 * Grund — nie ein erfundener Satz, nie eine erfundene 0.
 */
export function planKernaussage(
  slots: (PlanSlotLike & { costEur: number | null; baselineCostEur: number | null })[],
  kind: PlanWordingKind,
  now: Date,
  slotMinutes = 15,
): Kernaussage {
  const aktivitaet = planSentence(slots, kind, now, slotMinutes);
  if (aktivitaet == null) {
    return {
      wert: null,
      satz: null,
      grund: 'Für heute liegt noch kein Fahrplan vor.',
      ton: 'calm',
    };
  }
  const geld = plannedDayCosts(slots, now);
  // Eine Ersparnis unter dem Totband ist Solver-Rauschen, keine Aussage: dann
  // bleibt es bei der reinen Aktivität, ohne Zahl und ohne Anker (ein Paar
  // ohne Kopfzahl wäre Rauschen, kein Beleg).
  const zaehlt = geld != null && Math.abs(geld.savedEur) >= BANKED_DEADBAND_EUR;
  if (!zaehlt) {
    return { wert: null, satz: aktivitaet, grund: null, ton: 'calm', anker: null };
  }
  const { savedEur, baselineEur, actualEur } = geld;
  return {
    wert: eurAmount(Math.abs(savedEur)),
    satz: `${plannedSavingLabel(kind, savedEur)} — ${lowerFirst(aktivitaet)}`,
    grund: null,
    ton: savedEur > 0 ? 'ok' : 'calm',
    // K8: keine Zahl ohne Vergleichsanker - und der Anker ist das exakte Paar,
    // dessen DIFFERENZ die Zahl oben ist.
    anker: proofAnchor(kind, baselineEur, actualEur),
  };
}

// ---- Banked terminal value + horizon-edge honesty (FK2) ----------------------

/** Below this the banked value is solver/rounding noise, not a real bank. */
export const BANKED_DEADBAND_EUR = 0.005;

/**
 * ONE calm German line making the savings figure honest on bank days (audit
 * vp-solver-xlsx-f2 §4.3): when the plan stores energy into the next day the
 * headline savings read small or negative although real value was banked -
 * without this line the CORRECT plan looks broken. Positive = energy stored
 * for tomorrow; negative = the plan draws down previously stored energy
 * (sign-honest, worded as a withdrawal, never a fake "gespeichert"). Null
 * hides the line: no data (pre-FK2 runs, no battery) or noise-level values.
 */
export function bankedValueLine(bankedValueEur: number | null | undefined): string | null {
  if (bankedValueEur == null) return null;
  const v = Number(bankedValueEur);
  if (!Number.isFinite(v) || Math.abs(v) < BANKED_DEADBAND_EUR) return null;
  if (v > 0) return `davon in den Folgetag gespeichert: +${eurAmount(v)}`;
  return `aus dem Vortag entnommen: ${eurAmount(-v)}`;
}

export const HORIZON_HINT =
  'Der Fahrplan reicht bis zum Tagesende – sobald die Börsenpreise für morgen ' +
  'vorliegen (ab ca. 13 Uhr), plant VoltPilot darüber hinaus.';

/**
 * The horizon-edge honesty hint (FK2 part b): before the day-ahead price
 * publication (~13:00) the plan's horizon ends at today's midnight, so the
 * morning Fahrplan shows an evening "hold" that flips to discharge in the
 * afternoon - users must not learn to distrust the plan. Derived purely from
 * the plan's own slot range: the hint shows while the horizon end lies within
 * today (still ahead of `now`); a plan reaching into tomorrow - or an entirely
 * stale plan, which is a different problem - gets no hint.
 */
export function horizonHint(
  slots: { start: string }[],
  now: Date,
  slotMinutes = 15,
): string | null {
  if (slots.length === 0) return null;
  // Slots come time-ordered from the API; the horizon ends after the last one.
  const last = new Date(slots[slots.length - 1].start).getTime();
  const horizonEnd = last + slotMinutes * 60_000;
  if (horizonEnd <= now.getTime()) return null;
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return horizonEnd <= endOfToday ? HORIZON_HINT : null;
}

/* ---------------------------------------------------------------------------
 * M4 · Das SPANNENBAND des Preis-Panels (Chart-Redesign Stufe 2)
 *
 * Das Portal HAT beide Größen je Viertelstunde (`importPriceCtKwh` /
 * `exportValueCtKwh`, die eine serverseitige `SlotEconomics`-Komposition) und
 * zeigte sie nirgends als Kurvenpaar - gezeichnet wurde der nackte Börsenpreis,
 * also genau die Zahl, mit der der Optimierer NICHT entscheidet.
 *
 * Die Fläche zwischen beiden IST der Grund fürs Laden und Entladen: eine
 * gespeicherte Kilowattstunde lohnt sich, wenn sie den Bezugspreis vermeidet
 * statt zum Einspeisewert wegzugehen. Deshalb trägt sie ihr Wort im Bild (K10)
 * und ist eine F3-AUSNAHME (die Fläche trägt die Aussage, nicht nur Kontext).
 * ------------------------------------------------------------------------- */

/** Unter dieser Spanne ist die Fläche Rauschen und bekommt kein Namensschild. */
export const SPREAD_DEADBAND_CT = 0.05;

export interface PriceSpread {
  /** Bezugspreis je Slot (ct/kWh); `null` = für diesen Slot nicht bewertbar. */
  importCt: (number | null)[];
  /** Einspeisewert je Slot (ct/kWh); `null` = nicht bewertbar. */
  exportCt: (number | null)[];
  /**
   * Untere Kante der Fläche = das MINIMUM der beiden Linien. Bewusst nicht
   * „der Einspeisewert": bei einem negativen Börsenpreis kann er über dem
   * Bezugspreis liegen, und eine gestapelte Fläche mit negativer Höhe zeichnete
   * sich nach unten aus dem Band heraus. Das Band ist definiert als „zwischen
   * den beiden Linien", in jeder Reihenfolge.
   */
  base: (number | null)[];
  /** Die Höhe darüber, sodass `base + delta` exakt die obere Linie trifft. */
  delta: (number | null)[];
  /** True, sobald mindestens EIN Slot beide Werte trägt - sonst gibt es kein Band. */
  present: boolean;
  /** Der Slot mit der größten Spanne - dort hängt das Namensschild (K10/K6). */
  widestIndex: number | null;
  /** Die größte Spanne in ct/kWh. */
  widestCt: number | null;
  /** Ihre Mitte auf der Preisachse - die y-Koordinate des Namensschilds. */
  widestMidCt: number | null;
}

function ctOrNull(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Das Kurvenpaar Bezugspreis/Einspeisewert plus die Fläche dazwischen.
 *
 * Ehrlichkeit wie bei jeder Plan-Linie: ein fehlender Wert bleibt eine LÜCKE
 * (`null`), nie eine erfundene 0 - ein älterer Lauf ohne die zwei Spalten
 * liefert damit gar kein Band, und die Fläche entsteht ausschließlich in
 * Slots, die BEIDE Werte tragen.
 */
export function priceSpread(
  slots: { importPriceCtKwh?: number | null; exportValueCtKwh?: number | null }[],
): PriceSpread {
  const importCt: (number | null)[] = [];
  const exportCt: (number | null)[] = [];
  const base: (number | null)[] = [];
  const delta: (number | null)[] = [];
  let present = false;
  let widestIndex: number | null = null;
  let widestCt: number | null = null;
  let widestMidCt: number | null = null;

  slots.forEach((s, i) => {
    const imp = ctOrNull(s.importPriceCtKwh);
    const exp = ctOrNull(s.exportValueCtKwh);
    importCt.push(imp);
    exportCt.push(exp);
    if (imp == null || exp == null) {
      base.push(null);
      delta.push(null);
      return;
    }
    present = true;
    const lo = Math.min(imp, exp);
    const hi = Math.max(imp, exp);
    base.push(lo);
    delta.push(hi - lo);
    if (hi - lo > (widestCt ?? SPREAD_DEADBAND_CT)) {
      widestIndex = i;
      widestCt = hi - lo;
      widestMidCt = (hi + lo) / 2;
    }
  });

  return { importCt, exportCt, base, delta, present, widestIndex, widestCt, widestMidCt };
}

/** Below this the curtailment is solver noise, not a real feed-in cap. */
export const CURTAIL_DEADBAND_KW = 0.01;

/**
 * Legend label of the orange curtailment colour. Der Wortlaut folgt dem
 * PLAN-Wortlaut der Abregelung (Fix 1, `fahrplanWhy.PLANNED_TAG`): die Cloud
 * kennt heute keinen Ausführungs-Beleg, also verspricht auch die Legende nur
 * die Planung.
 */
export const CURTAIL_LEGEND_LABEL = 'Abregeln — geplant';

/**
 * Whether the plan actually curtails PV somewhere. DAS EINE GATE für alles
 * Orange am Fahrplan-Diagramm: Band, Sockel-Ticks, gedrosselte Fläche UND die
 * Legenden-Zeile hängen daran (Scout `vp-pilsting-abregeln` Frage 4). Vorher
 * prüfte es nur die DATEN und schaltete allein die Legende frei - das Canvas
 * zeigte die beworbene Farbe nie, weil ihr Träger der Batterie-Balken war und
 * der im Abregeln-Slot 0 kW hoch ist.
 */
export function hasCurtailment(slots: { curtailKw?: number | null }[]): boolean {
  return slots.some((s) => s.curtailKw != null && Number(s.curtailKw) > CURTAIL_DEADBAND_KW);
}

/** True wenn dieser Slot wirklich abregelt (über dem Totband). */
function curtails(slot: { curtailKw?: number | null }): boolean {
  return slot.curtailKw != null && Number(slot.curtailKw) > CURTAIL_DEADBAND_KW;
}

/** Ein zusammenhängender Abregel-Block als Slot-Indexspanne (beide inklusiv). */
export interface CurtailSpan {
  from: number;
  to: number;
}

/**
 * Die zusammenhängenden Abregel-Blöcke eines Plans - die Geometrie des orangen
 * Bands (`markArea`, das Muster der Vergangenheits-Schattierung im selben
 * Chart).
 *
 * Eine Spanne von einem Index auf sich selbst wäre auf der KATEGORIE-Achse
 * null Pixel breit (dieselbe Falle wie bei der Historie-Ereignis-Spur), deshalb
 * wird ein Ein-Slot-Block auf einen Nachbarn verbreitert. Die exakte
 * Slot-Wahrheit trägt der Sockel-Tick ({@link curtailTickData}), das Band ist
 * die weiche Hinterlegung.
 */
export function curtailSpans(slots: { curtailKw?: number | null }[]): CurtailSpan[] {
  const spans: CurtailSpan[] = [];
  let start = -1;
  for (let i = 0; i < slots.length; i++) {
    if (curtails(slots[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      spans.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ from: start, to: slots.length - 1 });
  const last = slots.length - 1;
  return spans.map(({ from, to }) => {
    if (from !== to) return { from, to };
    if (to < last) return { from, to: to + 1 };
    if (from > 0) return { from: from - 1, to };
    return { from, to };
  });
}

/**
 * Die Sockel-Ticks am Nullpunkt: `0` genau in den abregelnden Slots, sonst
 * `null` (das `:8484`-Ticks-Muster). Der Wert ist bewusst die Null - der Tick
 * bekommt seine Höhe in PIXELN vom Symbol, ist damit unabhängig von der
 * kW-Skala und kann nie eine Leistung behaupten, die er nicht misst.
 */
export function curtailTickData(slots: { curtailKw?: number | null }[]): (number | null)[] {
  return slots.map((s) => (curtails(s) ? 0 : null));
}

/** Das Wort am orangen Band - K5: Farbe nie allein, das Band trägt seinen Namen. */
export const CURTAIL_BAND_WORD = 'Sonne wird gedrosselt';

/** Der Zusatz, wenn ALLE abregelnden Slots wirklich unter null notieren. */
export const CURTAIL_BAND_CAUSE = ' · Preis unter 0';

/**
 * Die Beschriftung des orangen Abregel-Bands im Leistungs-Panel.
 *
 * Der GRUND wird nur genannt, wenn er belegt ist: der Optimierer regelt bei
 * negativen Preisen ab - aber auch an einer statischen Einspeisegrenze (FK1,
 * `site.max_feed_in_kw`). „Preis unter 0" auf einer eingespeise-gedeckelten
 * Anlage wäre eine falsche Ursache, also steht dort nur das Wort. Bewertet wird
 * der Einspeisewert des Slots, ersatzweise der Börsenpreis; ohne jedes
 * Preissignal wird nichts behauptet.
 */
export function curtailBandLabel(
  slots: {
    curtailKw?: number | null;
    priceEurMwh?: number | null;
    exportValueCtKwh?: number | null;
  }[],
): string {
  const curtailing = slots.filter(curtails);
  if (curtailing.length === 0) return CURTAIL_BAND_WORD;
  const negative = curtailing.every((s) => {
    const exp = s.exportValueCtKwh == null ? null : Number(s.exportValueCtKwh);
    if (exp != null && Number.isFinite(exp)) return exp < 0;
    const spot = s.priceEurMwh == null ? null : Number(s.priceEurMwh);
    if (spot != null && Number.isFinite(spot)) return spot < 0;
    return false;
  });
  return negative ? `${CURTAIL_BAND_WORD}${CURTAIL_BAND_CAUSE}` : CURTAIL_BAND_WORD;
}

/** Das Label der zuschaltbaren Abregel-Fläche (zugleich echarts-Serienname). */
export const CURTAIL_AREA_LABEL = 'Gedrosselte Menge';

/**
 * Die gedrosselte Menge als Fläche zwischen Einspeise-Cap und PV-Prognose -
 * gestapelt aus zwei Reihen (die übliche echarts-Band-Technik):
 *
 * - `cap`   = untere Kante = `pvKw - curtailKw` (der Cap, den der Plan sendet),
 * - `delta` = die Höhe darüber, sodass `cap + delta === pvKw` exakt gilt.
 *
 * Sie erklärt, WARUM die PV-Prognose über dem Cap liegt. Ehrlichkeit wie bei
 * allen Plan-Linien: ohne PV-Wert oder ohne Abregelung bleibt der Slot `null`
 * (Lücke), nie eine erfundene 0; ein negativer Cap wird auf 0 geklemmt.
 */
export interface CurtailArea {
  cap: (number | null)[];
  delta: (number | null)[];
  /** True sobald mindestens ein Slot die Fläche füllen kann. */
  present: boolean;
}

export function curtailArea(
  slots: { pvKw?: number | null; curtailKw?: number | null }[],
): CurtailArea {
  const cap: (number | null)[] = [];
  const delta: (number | null)[] = [];
  let present = false;
  for (const s of slots) {
    const pv = s.pvKw == null ? null : Number(s.pvKw);
    if (!curtails(s) || pv == null || !Number.isFinite(pv)) {
      cap.push(null);
      delta.push(null);
      continue;
    }
    const lower = Math.max(pv - Number(s.curtailKw), 0);
    cap.push(lower);
    delta.push(pv - lower);
    present = true;
  }
  return { cap, delta, present };
}

/** Zahlenformat der Abregel-Tooltip-Zeile (nur Ziffern + Trennzeichen). */
function curtailKwText(v: number): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

/**
 * Die EINE Tooltip-Zeile des Abregeln-Slots: "Abregeln geplant: X kW
 * (Einspeise-Cap Y kW)". Null, wenn der Slot nicht abregelt.
 *
 * XSS-Regel der Chart-Formatter: der Rückgabewert landet per innerHTML im
 * Tooltip, deshalb besteht er ausschließlich aus KONSTANTEN plus
 * `toLocaleString`-Zahlen - nie aus einem API-/kundenkontrollierten String.
 * Der Cap-Teil entfällt ohne PV-Wert, statt eine 0 zu behaupten.
 */
export function curtailTooltip(slot: {
  curtailKw?: number | null;
  pvKw?: number | null;
}): string | null {
  if (!curtails(slot)) return null;
  const head = `Abregeln geplant: ${curtailKwText(Number(slot.curtailKw))} kW`;
  const pv = slot.pvKw == null ? null : Number(slot.pvKw);
  if (pv == null || !Number.isFinite(pv)) return head;
  const capKw = Math.max(pv - Number(slot.curtailKw), 0);
  return `${head} (Einspeise-Cap ${curtailKwText(capKw)} kW)`;
}

/**
 * K7 · Was der Plan in DIESER Viertelstunde vorhat — als Satz, nicht als
 * Wertepaar.
 *
 * Er steht im Fahrplan-Tooltip GANZ OBEN, direkt unter der Uhrzeit: die
 * Handlung ist die Antwort, die Zahlen darunter sind ihr Beleg. Bis Stufe 5
 * stand dieselbe Aussage als letzte von neun Zeilen — nach acht Wertzeilen,
 * die man erst verrechnen musste.
 *
 * ⚠ Die Quellen-Zuordnung („eigenen Solarstrom" / „günstigen Strom aus dem
 * Netz") ist hier BELEGT und keine erfundene Bilanz-Zerlegung: sie kommt aus
 * {@link chargeKind}, das die geplante Ladeleistung gegen die geplante PV
 * DIESES Slots prüft (FK3-Semantik) — es ist die Aussage des Optimierers über
 * seinen eigenen Plan, nicht eine Schätzung über eine Messung. Genau deshalb
 * darf der Fahrplan einen Satz sagen, den der Live-Verlauf nicht sagen darf.
 *
 * Der Rückgabewert landet per `innerHTML` im Tooltip: ausschließlich
 * Konstanten plus `toLocaleString`-Zahlen (die XSS-Regel der Formatter).
 */
export function slotAktionSatz(slot: {
  batteryKw?: number | null;
  gridKw?: number | null;
  pvKw?: number | null;
  curtailKw?: number | null;
}): string | null {
  const bat = slot.batteryKw == null ? null : Number(slot.batteryKw);
  if (bat == null || !Number.isFinite(bat)) return null;
  const kind = chargeKind(slot.batteryKw ?? null, slot.gridKw ?? null, slot.pvKw, slot.curtailKw);
  const menge = `${Math.abs(bat).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`;
  switch (kind) {
    case 'netzladen':
      return `Speichert ${menge} günstigen Strom aus dem Netz.`;
    case 'solarladen':
      return `Speichert ${menge} eigenen Solarstrom.`;
    case 'entladen':
      return `Deckt den Verbrauch mit ${menge} aus dem Speicher.`;
    case 'ruhe':
    default:
      // „hält" ist die ehrliche Aussage über einen Slot ohne Bewegung - eine
      // Menge dazu wäre 0,0 kW und damit Rauschen.
      return 'Der Speicher hält seine Ladung.';
  }
}

/**
 * Today's PLANNED PV curtailment: how much energy the optimizer plans to hold
 * back and the negative-price loss that WOULD avoid. At negative day-ahead
 * prices exporting COSTS money, so each curtailed kWh in a negative-price slot
 * avoids paying |price| for it. Null when today has no curtailing slot - the
 * line then stays hidden, never a fake "0 kWh abgeregelt".
 *
 * **Beides ist Plan, nicht Ergebnis** (Scout `vp-pilsting-abregeln` Frage 3):
 * `schedule.curtail_kw` ist die Entscheidung des Optimierers, und ob die
 * Anlage sie ausführt, weiß die Cloud heute nicht. Deshalb formuliert
 * `curtailmentPlannedLine` im Konjunktiv und benutzt KEIN realisiertes
 * Euro-Verb ("vermieden") - das käme erst mit einem Ausführungs-Beleg.
 */
export interface CurtailmentToday {
  /** Total curtailed energy today (kWh). */
  curtailedKwh: number;
  /** Euro loss the plan would avoid by not exporting in negative-price slots (>= 0). */
  avoidedLossEur: number;
}

/** Ab hier lohnt es, den vermiedenen Verlust überhaupt zu beziffern. */
const CURTAIL_EUR_DEADBAND = 0.005;

/**
 * Die EINE Formulierung der geplanten Abregelung ("Heute geplant: X kWh
 * abregeln (würde rund Y € Verlust vermeiden)"). Der Euro-Teil entfällt
 * unter dem Totband - nie ein aufgerundetes "0,00 €".
 */
export function curtailmentPlannedLine(
  curtail: CurtailmentToday,
  energy: (kwh: number) => string,
  eur: (v: number) => string,
): string {
  const head = `Heute geplant: ${energy(curtail.curtailedKwh)} abregeln`;
  return curtail.avoidedLossEur > CURTAIL_EUR_DEADBAND
    ? `${head} (würde rund ${eur(curtail.avoidedLossEur)} Verlust bei negativen Preisen vermeiden).`
    : `${head}.`;
}

export function curtailmentToday(
  slots: { start: string; curtailKw: number | null; priceEurMwh: number | null }[],
  now: Date,
  slotMinutes = 15,
): CurtailmentToday | null {
  const hours = slotMinutes / 60;
  let curtailedKwh = 0;
  let avoidedLossEur = 0;
  for (const s of todaySlots(slots, now)) {
    const kw = s.curtailKw == null ? 0 : Number(s.curtailKw);
    if (!(kw > CURTAIL_DEADBAND_KW)) continue;
    const kwh = kw * hours;
    curtailedKwh += kwh;
    const price = s.priceEurMwh == null ? 0 : Number(s.priceEurMwh);
    if (price < 0) {
      // EUR/MWh -> EUR/kWh: /1000; negative price => positive avoided loss.
      avoidedLossEur += kwh * (-price / 1000);
    }
  }
  if (curtailedKwh <= CURTAIL_DEADBAND_KW * hours) return null;
  return { curtailedKwh, avoidedLossEur };
}

/** One bar of the hourly mini chart; kw null = no plan data for that hour. */
export interface PlanHourBar {
  hour: number;
  kind: ChargeKind;
  /** Mean |battery power| of the hour's dominant direction, for bar height. */
  kw: number | null;
}

/**
 * Today's plan condensed to 24 hourly bars (the phone-calm resolution of the
 * mini preview): per hour the dominant battery direction by energy and its
 * mean power. A charging hour is 'netzladen' when most of its charge energy
 * is grid-fed (the chart's cyan proof carries over to the preview).
 */
export function planHourBars(slots: PlanSlotLike[], now: Date): PlanHourBar[] {
  const byHour = new Map<number, PlanSlotLike[]>();
  for (const s of todaySlots(slots, now)) {
    const h = new Date(s.start).getHours();
    const list = byHour.get(h);
    if (list) list.push(s);
    else byHour.set(h, [s]);
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const list = byHour.get(hour);
    if (!list || list.length === 0) return { hour, kind: 'ruhe' as ChargeKind, kw: null };
    let charge = 0;
    let gridCharge = 0;
    let discharge = 0;
    for (const s of list) {
      const kind = chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw);
      const kw = Math.abs(Number(s.batteryKw ?? 0));
      if (kind === 'entladen') discharge += kw;
      else if (kind === 'solarladen') charge += kw;
      else if (kind === 'netzladen') {
        charge += kw;
        gridCharge += kw;
      }
    }
    if (charge <= SLOT_DEADBAND_KW && discharge <= SLOT_DEADBAND_KW) {
      return { hour, kind: 'ruhe' as ChargeKind, kw: 0 };
    }
    if (discharge > charge) {
      return { hour, kind: 'entladen' as ChargeKind, kw: discharge / list.length };
    }
    return {
      hour,
      kind: (gridCharge > charge / 2 ? 'netzladen' : 'solarladen') as ChargeKind,
      kw: charge / list.length,
    };
  });
}

/* ---------------------------------------------------------------------------
 * K1 · Die Maßstabs-Zeile des Cockpit-Ministreifens
 *
 * Ein 40-px-Streifen kann seine Leistungen nicht beschriften — genau dort
 * steckt aber die Zahl, nach der ein Betreiber fragt („wie viel denn?").
 * Der Satz nennt die Spitzen BEIDER Richtungen. Die Farbzuteilung selbst steht
 * direkt am Streifen als „lädt ↑" / „gibt ab ↓" (K5: Farbe nie ohne Wort).
 * ------------------------------------------------------------------------- */

/**
 * „Höchstens 10,9 kW laden · höchstens 7,0 kW abgeben" — die Maßstabs-Zeile
 * unter dem Ministreifen.
 *
 * Genannt wird nur, was der Plan wirklich vorsieht: ein Tag ohne Entladung
 * bekommt keinen Abgabe-Halbsatz, und ein Tag ohne jede Bewegung `null`
 * (der Streifen sagt dann nichts, statt „höchstens 0,0 kW" zu behaupten).
 */
export function planStreifenSkala(bars: PlanHourBar[]): string | null {
  let laden = 0;
  let abgeben = 0;
  for (const b of bars) {
    const kw = b.kw ?? 0;
    if (kw <= SLOT_DEADBAND_KW) continue;
    if (b.kind === 'entladen') abgeben = Math.max(abgeben, kw);
    else if (b.kind === 'solarladen' || b.kind === 'netzladen') laden = Math.max(laden, kw);
  }
  const teile: string[] = [];
  if (laden > 0) teile.push(`höchstens ${fmtNum(laden, 'kW')} laden`);
  if (abgeben > 0) teile.push(`höchstens ${fmtNum(abgeben, 'kW')} abgeben`);
  if (teile.length === 0) return null;
  teile[0] = teile[0].charAt(0).toUpperCase() + teile[0].slice(1);
  return teile.join(' · ');
}

/**
 * Die Stunden-Ticks des Ministreifens: WO auf der Breite eine Stunde steht.
 *
 * Vorher standen 0/6/12/18/24 per `space-between` — die Beschriftung lag
 * damit NEBEN ihrer Stunde statt darüber (Befund §3b Nr. 15). Der Anteil ist
 * die linke KANTE der Stundensäule (`hour/24`), also markiert „6" wirklich
 * den Beginn der 6. Stunde; die 24 ist der rechte Rand des Tages.
 */
export function planStreifenTicks(stunden: readonly number[] = [0, 6, 12, 18, 24]): {
  hour: number;
  pct: number;
}[] {
  return stunden.map((hour) => ({ hour, pct: (hour / 24) * 100 }));
}

/** Plant kind steering the discharge verb (mirrors api.ts PlantKind). */
export type PlanWordingKind = 'direktvermarktung' | 'eigenverbrauch';

interface PlanRun {
  dir: 'laden' | 'entladen';
  from: Date;
  to: Date;
  energy: number;
  gridEnergy: number;
  /**
   * Die NETTO-Netzenergie des Laufs in kWh, mit dem Vorzeichen des Fahrplans
   * (+ = Bezug, − = Einspeisung). Sie entscheidet, ob eine Entladung wirklich
   * VERKAUFT — siehe {@link netExports}.
   */
  gridNetEnergy: number;
  /** At least one discharge slot really exports / does not export. */
  hasExportSlot: boolean;
  hasNonExportSlot: boolean;
}

/**
 * Kilowattstunden-Totband der Netto-Netzbilanz eines Laufs. Unterhalb davon ist
 * der Netzanschluss ausgeglichen und es wird nichts verkauft; abgeleitet aus
 * dem kW-Totband des Hauses über eine Viertelstunde.
 */
const NET_EXPORT_DEADBAND_KWH = 0.05;

/**
 * Verkauft dieser Lauf wirklich? Nur, wenn er NETTO einspeist.
 *
 * **Der behobene Anzeige-Defekt (Herzogau 17.08.2026, Report
 * `vp-nacht-ruhe-warum-q8` §0):** Bei Direktvermarktung hieß JEDE Entladung
 * „verkaufen" — auch eine reine Lastdeckung. Die drei Nacht-Balken der Anlage
 * lagen weit UNTER dem Hausverbrauch, der Fahrplan plante in genau diesen
 * Slots also Netz-BEZUG; die Kopfzeile sagte trotzdem „nachts verkaufen".
 * Verkauft wird, was den Netzanschluss verlässt, nicht was die Batterie
 * verlässt — und das steht im geplanten `gridKw`, nicht im `batteryKw`.
 *
 * Ohne verwertbares `gridKw` (ältere Plan-Zeilen) bleibt die Netto-Bilanz 0,
 * der Lauf gilt also NICHT als Verkauf: lieber die vorsichtigere, immer wahre
 * Aussage „Verbrauch decken" als ein behaupteter Erlös.
 */
function netExports(run: PlanRun): boolean {
  return run.gridNetEnergy < -NET_EXPORT_DEADBAND_KWH;
}

/**
 * ONE plain-German sentence describing today's plan (the Anlagen-Seite's
 * Fahrplan preview, captain mockup: "Mittags laden, abends verkaufen
 * (17–20 Uhr)."): the dominant charge and discharge windows by energy, worded
 * by daypart. Direktvermarktung discharges to "verkaufen" only when the window
 * NET EXPORTS (else "den Verbrauch decken" — see {@link netExports}),
 * Eigenverbrauch to "nutzen"; a mostly grid-fed charge window says "günstig
 * laden". Null when
 * today has no plan slots; an all-idle day says the battery holds its charge.
 */
export function planSentence(
  slots: PlanSlotLike[],
  kind: PlanWordingKind,
  now: Date,
  slotMinutes = 15,
): string | null {
  const today = [...todaySlots(slots, now)].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  if (today.length === 0) return null;

  const runs = planRuns(today, slotMinutes);
  const charge = dominantRun(runs, 'laden');
  const discharge = dominantRun(runs, 'entladen');
  // „verkaufen" nur, wenn der Lauf NETTO einspeist (siehe `netExports`) - eine
  // Entladung unterhalb des Hausverbrauchs deckt den Verbrauch, sie verkauft
  // nichts. Eigenverbrauch sagt unverändert „nutzen".
  const verb =
    kind === 'direktvermarktung'
      ? discharge?.hasExportSlot && discharge.hasNonExportSlot
        ? 'den Verbrauch decken und Überschuss verkaufen'
        : discharge && netExports(discharge)
          ? 'verkaufen'
          : 'den Verbrauch decken'
      : 'nutzen';

  if (charge && discharge) {
    const chargeWord = charge.gridEnergy > charge.energy / 2 ? 'günstig laden' : 'laden';
    return `${cap(daypart(midHour(charge)))} ${chargeWord}, ${daypart(midHour(discharge))} ${verb} (${hourRange(discharge)}).`;
  }
  if (charge) {
    const chargeWord = charge.gridEnergy > charge.energy / 2 ? 'günstig laden' : 'laden';
    return `${cap(daypart(midHour(charge)))} ${chargeWord} (${hourRange(charge)}).`;
  }
  if (discharge) {
    return `${cap(daypart(midHour(discharge)))} ${verb} (${hourRange(discharge)}).`;
  }
  // An all-idle day: name the reason the optimizer recorded, or state only the
  // observation when it recorded none (never a fabricated cause - the same
  // discipline as planInsightParts).
  const reason = idleReason(today);
  if (reason == null) return 'Der Speicher hält heute seine Ladung.';
  if (reason.kind === 'reserve') {
    return reason.driver === 'notstrom'
      ? 'Der Speicher hält seine Ladung heute als Notstrom-Reserve zurück.'
      : reason.driver === 'lastspitze'
        ? 'Der Speicher hält seine Ladung heute als Reserve für die Lastspitzenkappung zurück.'
        : 'Der Speicher hält seine Ladung heute als Reserve zurück.';
  }
  if (reason.kind === 'stored_value_above_peak') {
    return (
      `Der Speicher hält heute seine Ladung - sie ist mit ${ctLabel(reason.storedCt)} ` +
      `bewertet, mehr als der höchste Preis heute (${ctLabel(reason.bestCt)}).`
    );
  }
  // Beobachtend wie `idleParts` - ohne exportierten Treiber keine Ursache.
  return 'Der Speicher wartet heute - weder Laden noch Entladen ist eingeplant.';
}

/** Contiguous same-direction windows; gaps of up to 30 min idle are bridged. */
function planRuns(sorted: PlanSlotLike[], slotMinutes: number): PlanRun[] {
  const maxGapMs = (2 * slotMinutes + 1) * 60_000;
  const runs: PlanRun[] = [];
  let current: PlanRun | null = null;
  for (const s of sorted) {
    const k = chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw);
    if (k === 'ruhe') continue;
    const dir = k === 'entladen' ? 'entladen' : 'laden';
    const start = new Date(s.start);
    const end = new Date(start.getTime() + slotMinutes * 60_000);
    const kw = Math.abs(Number(s.batteryKw ?? 0));
    const energy = (kw * slotMinutes) / 60;
    // Netto-Netzenergie MIT Vorzeichen (+ Bezug / − Einspeisung). Ein Slot ohne
    // geplanten Netzwert zählt 0 - er behauptet weder Bezug noch Einspeisung.
    const gridKw = s.gridKw == null || !Number.isFinite(s.gridKw) ? 0 : Number(s.gridKw);
    const gridNet = (gridKw * slotMinutes) / 60;
    const gridKnown = s.gridKw != null && Number.isFinite(s.gridKw);
    const exports = dir === 'entladen' && gridKnown && gridKw < -0.05;
    const doesNotExport = dir === 'entladen' && gridKnown && gridKw >= -0.05;
    if (current && current.dir === dir && start.getTime() - current.to.getTime() <= maxGapMs) {
      current.to = end;
      current.energy += energy;
      current.gridNetEnergy += gridNet;
      current.hasExportSlot ||= exports;
      current.hasNonExportSlot ||= doesNotExport;
      if (k === 'netzladen') current.gridEnergy += energy;
    } else {
      current = {
        dir,
        from: start,
        to: end,
        energy,
        gridEnergy: k === 'netzladen' ? energy : 0,
        gridNetEnergy: gridNet,
        hasExportSlot: exports,
        hasNonExportSlot: doesNotExport,
      };
      runs.push(current);
    }
  }
  return runs;
}

function dominantRun(runs: PlanRun[], dir: PlanRun['dir']): PlanRun | null {
  return runs
    .filter((r) => r.dir === dir)
    .reduce<PlanRun | null>((best, r) => (best == null || r.energy > best.energy ? r : best), null);
}

function midHour(run: PlanRun): number {
  const mid = new Date((run.from.getTime() + run.to.getTime()) / 2);
  return mid.getHours() + mid.getMinutes() / 60;
}

/** German daypart of a local decimal hour. */
export function daypart(hour: number): string {
  if (hour < 5 || hour >= 23) return 'nachts';
  if (hour < 11) return 'morgens';
  if (hour < 15) return 'mittags';
  if (hour < 18) return 'nachmittags';
  return 'abends';
}

/** "17–20 Uhr": start hour floored, end hour ceiled to the full hour. */
function hourRange(run: PlanRun): string {
  const startH = run.from.getHours();
  const endH = run.to.getMinutes() > 0 ? run.to.getHours() + 1 : run.to.getHours();
  return `${startH}–${endH === 0 ? 24 : endH} Uhr`;
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
