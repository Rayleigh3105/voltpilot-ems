// U4 - the Peak-Band lead artifact (design vp-ems-ui-overhaul §6 Face 2, AE0
// mockup `.peak`). A Lastspitzen (peak-shaving) Anlage leads its cockpit with
// the spitzen-defense band: the current ¼-hour mean grid IMPORT vs. the Ziel
// (progress bar + red limit marker), the month's avoided peak, and the saved
// Leistungskosten. All derivation is pure + unit-tested; the component renders.
//
// Data sources (all customer-reachable, no new endpoint):
//   - current ¼-h mean → the SERVER (Alerting Scheibe 4, Konzept
//     vp-alerting-konzept-m1 §6.10 Punkt 3: `AnlagenflussWerteLeser.
//     netzLastspitzeLaufend`, the same number the "Lastspitze droht"
//     Überwachung reads), on `siteEarnings.peakShaving.currentQuarterMeanKw`
//     (`serverQuarterHourMean`). Until Scheibe 4 this was derived HERE from a
//     dedicated 30 s telemetry poll (`quarterHourMeanImportKw`, kept below as
//     a pure, still-tested derivation - just no longer the portal's own
//     source of truth, so the browser and the Überwachung can't disagree).
//   - Ziel → `schedule.peakTargetKw` (PS-1, the run's planned grid-import peak).
//   - avoided peak + saved Leistungskosten → the `earnings.peakShaving` block
//     (PS-4, already built).
//
// Never fabricated: a missing live value, a missing target and a not-yet-
// measured period each degrade to an honest null/note, never a 0.

import type { PeakShaving } from './api';
import { eurAmount, fmtNum, NBSP } from './format';

/** Headroom above the larger of {current, Ziel} so both sit inside the bar. */
const BAR_HEADROOM = 1.2;

/** Below this the avoided peak reads as noise (the shared 0.05 kW deadband). */
const AVOIDED_NOISE_KW = 0.05;

/** The live ¼-hour mean import, as the band needs it. */
export interface QuarterHourMean {
  /** Mean grid IMPORT (kW) over the running wall-clock quarter; null = no usable sample. */
  kw: number | null;
  /** Whether the value is live right now (false only when it is unavailable). */
  fresh: boolean;
  /** How many samples the server's mean averaged; always 0 or 1 for a single server value. */
  count: number;
}

/**
 * Wraps the server-computed running ¼-hour mean (`PeakShaving.currentQuarterMeanKw`,
 * Alerting Scheibe 4) into the shape {@link peakBand} needs. `fresh` is simply
 * "a value is present": the server only computes it from samples inside the
 * running quarter in the first place, so there is no separate staleness check
 * to repeat here - a stale server value is null, never a number to second-guess.
 */
export function serverQuarterHourMean(kw: number | null | undefined): QuarterHourMean {
  const value = kw ?? null;
  return { kw: value, fresh: value != null, count: value != null ? 1 : 0 };
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
