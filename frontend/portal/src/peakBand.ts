// U4 - the Peak-Band lead artifact (design vp-ems-ui-overhaul §6 Face 2, AE0
// mockup `.peak`). A Lastspitzen (peak-shaving) Anlage leads its cockpit with
// the spitzen-defense band: the current ¼-hour mean grid IMPORT vs. the Ziel
// (progress bar + red limit marker), the month's avoided peak, and the saved
// Leistungskosten. All derivation is pure + unit-tested; the component renders.
//
// Data sources (all customer-reachable, no new endpoint):
//   - current ¼-h mean → derived HERE from the live telemetry window
//     (`quarterHourMeanImportKw`): import-only `power_kw` over the running
//     wall-clock quarter. The edge PS-3 tracker is edge-only; deriving from the
//     samples the portal already fetches is honest and cheap.
//   - Ziel → `schedule.peakTargetKw` (PS-1, the run's planned grid-import peak).
//   - avoided peak + saved Leistungskosten → the `earnings.peakShaving` block
//     (PS-4, already built).
//
// Never fabricated: a missing live value, a missing target and a not-yet-
// measured period each degrade to an honest null/note, never a 0.

import type { PeakShaving } from './api';
import { eurAmount, fmtNum, NBSP } from './format';

/** A 15-min billing quarter in ms; freshness window mirrors ONLINE_WINDOW_MS. */
const QUARTER_MS = 15 * 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;

/** Headroom above the larger of {current, Ziel} so both sit inside the bar. */
const BAR_HEADROOM = 1.2;

/** Below this the avoided peak reads as noise (the shared 0.05 kW deadband). */
const AVOIDED_NOISE_KW = 0.05;

/** One live telemetry sample (the subset the mean needs). */
export interface PowerSample {
  ts: string;
  powerKw: number | null;
}

/** The derived live ¼-hour mean import. */
export interface QuarterHourMean {
  /** Mean grid IMPORT (kW) over the running wall-clock quarter; null = no usable sample. */
  kw: number | null;
  /** The newest usable sample is within the freshness window. */
  fresh: boolean;
  /** How many samples the mean averaged (0 = none). */
  count: number;
}

/**
 * The current ¼-hour mean grid IMPORT, derived from the live telemetry window.
 * The billing peak is a 15-min mean of grid import, so this averages
 * `max(power_kw, 0)` over the RUNNING wall-clock quarter (:00/:15/:30/:45 →
 * now) - export never offsets an import peak. Quarter boundaries align across
 * whole-hour timezone offsets, so epoch-ms flooring matches Europe/Berlin.
 * Null (never 0) when the quarter has no usable sample yet.
 */
export function quarterHourMeanImportKw(
  samples: PowerSample[],
  now: Date,
): QuarterHourMean {
  const nowMs = now.getTime();
  const quarterStart = Math.floor(nowMs / QUARTER_MS) * QUARTER_MS;
  let sum = 0;
  let count = 0;
  let newest = -Infinity;
  for (const s of samples) {
    if (s.powerKw == null || !Number.isFinite(s.powerKw)) continue;
    const t = new Date(s.ts).getTime();
    if (!Number.isFinite(t) || t < quarterStart || t > nowMs) continue;
    sum += Math.max(s.powerKw, 0);
    count += 1;
    if (t > newest) newest = t;
  }
  if (count === 0) return { kw: null, fresh: false, count: 0 };
  return { kw: sum / count, fresh: nowMs - newest <= FRESH_MS, count };
}

/** "pro Jahr" / "pro Monat" for the configured billing-period kind. */
function abrechnungLabel(abrechnung: PeakShaving['abrechnung'] | null | undefined): string {
  return abrechnung === 'monat' ? 'pro Monat' : 'pro Jahr';
}

/** One rendered metric of the Peak-Band. */
export interface PeakBandMetric {
  label: string;
  value: string;
  /** 'good' turns the number green (a real avoided peak / saved cost). */
  tone?: 'good';
}

/** The render-ready Peak-Band view. */
export interface PeakBandView {
  /** The live ¼-h mean (kW), formatted; "—" when unavailable. */
  currentLabel: string;
  /** True when the live mean is present and recent (else the bar/number dims). */
  fresh: boolean;
  /** The Ziel (grid-import target, kW), formatted; null when unknown. */
  targetLabel: string | null;
  /**
   * Whether a Ziel exists at all. Without one the bar has NO reference and is
   * therefore not rendered (G7): a filled bar with no marker and no scale
   * cannot be read - the customer gets the number plus an honest note instead.
   */
  hasTarget: boolean;
  /** Bar fill position as % of the bar max; null when no bar is shown. */
  fillPct: number | null;
  /** Red limit marker position as % of the bar max; null when no target. */
  limitPct: number | null;
  /** The bar's upper end, formatted - the scale that makes the fill readable. */
  scaleMaxLabel: string | null;
  /** The current mean exceeds the Ziel (over the limit → the bar goes red). */
  breach: boolean;
  /** Vermiedene Spitze + ersparte Leistungskosten; empty until measured. */
  metrics: PeakBandMetric[];
  /** Calm note when live and/or period data is missing; null otherwise. */
  note: string | null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/**
 * Build the Peak-Band view from the live mean, the Ziel and the PS-4 block.
 * Degrades honestly: no live sample → "—" + note; no target → no marker; no
 * measured period → the avoided-peak metrics drop out (never fabricated 0).
 */
export function peakBand(input: {
  current: QuarterHourMean;
  targetKw: number | null | undefined;
  peak: PeakShaving | null | undefined;
}): PeakBandView {
  const { current, peak } = input;
  const targetKw = input.targetKw ?? null;
  const currentKw = current.kw;

  // A bar only means something against a reference. Without a Ziel there is
  // neither a marker nor a scale, so no bar is built at all (G7).
  const hasTarget = targetKw != null;
  const peakOfBoth = Math.max(currentKw ?? 0, targetKw ?? 0);
  const barMax = hasTarget && peakOfBoth > 0 ? peakOfBoth * BAR_HEADROOM : null;
  const fillPct =
    barMax != null && currentKw != null ? clampPct((currentKw / barMax) * 100) : null;
  const limitPct = barMax != null && targetKw != null ? clampPct((targetKw / barMax) * 100) : null;
  const breach = currentKw != null && targetKw != null && currentKw > targetKw;

  const metrics: PeakBandMetric[] = [];
  if (peak != null && peak.avoidedKw != null && peak.avoidedEur != null) {
    if (peak.avoidedKw > AVOIDED_NOISE_KW) {
      metrics.push({
        label: `Vermiedene Spitze (${abrechnungLabel(peak.abrechnung)})`,
        value: `+${fmtNum(peak.avoidedKw, 'kW')}`,
        tone: 'good',
      });
      metrics.push({
        label: 'Ersparte Leistungskosten',
        value: `+${eurAmount(peak.avoidedEur)}`,
        tone: 'good',
      });
    }
  }

  const note =
    currentKw == null
      ? 'Aktueller Live-Wert liegt gerade nicht vor.'
      : !hasTarget
        ? 'Ziel für den Netzbezug: wird von VoltPilot eingerichtet. Sobald es steht, ' +
          'sehen Sie hier, wie weit die laufende ¼-Stunde davon entfernt ist.'
        : peak != null && peak.peakKw == null
          ? 'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.'
          : null;

  return {
    currentLabel: currentKw != null ? fmtNum(currentKw, 'kW', 0) : '—',
    fresh: current.fresh,
    targetLabel: targetKw != null ? `Ziel${NBSP}${fmtNum(targetKw, 'kW', 0)}` : null,
    hasTarget,
    fillPct,
    limitPct,
    scaleMaxLabel: barMax != null ? fmtNum(barMax, 'kW', 0) : null,
    breach,
    metrics,
    note,
  };
}
