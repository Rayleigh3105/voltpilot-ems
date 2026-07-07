/**
 * Pure, framework-free logic for the money-centric "Meine Anlage" v2 view
 * (captain 2026-07-07, modelled on the Deye Copilot app). The page's period
 * tabs govern the whole page; this module derives every label, the tappable
 * 12-month strip, the Ertrag-chart axis labels and the "bester Tag" line - the
 * components only render it, and anlage.test.ts pins the numbers.
 *
 * All calendar reasoning is Europe/Berlin (the v1 platform timezone), matching
 * the backend's earnings buckets.
 */
import type { EarningsMonth, EarningsRange, EarningsSeriesPoint } from './api';
import { eurAmount, NBSP } from './format';

const ZONE = 'Europe/Berlin';

/** A moment as its Europe/Berlin ISO day ("2026-07-07"). */
function berlinDay(at: Date): string {
  return at.toLocaleDateString('sv-SE', { timeZone: ZONE });
}

/** Parse an ISO day ("2026-07-01") into a Date at local noon (no tz surprises). */
function isoNoon(isoDay: string): Date {
  return new Date(`${isoDay.slice(0, 10)}T12:00:00`);
}

/**
 * German energy label: kWh below a megawatt-hour, MWh above (the Deye-style
 * calm big-number unit). Null/undefined -> "–", never a fake zero.
 */
export function energyLabel(kwh: number | null | undefined): string {
  if (kwh == null) return '–';
  const abs = Math.abs(kwh);
  if (abs >= 1000) {
    return `${(kwh / 1000).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}${NBSP}MWh`;
  }
  const digits = abs >= 100 ? 0 : 1;
  return `${kwh.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${NBSP}kWh`;
}

/** Short German month name of an ISO month/day string ("2026-07-01" -> "Jul"). */
export function monthShort(monthIso: string): string {
  return isoNoon(monthIso).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
}

/** Full German month name ("2026-07-01" -> "Juli"). */
export function monthLong(monthIso: string): string {
  return isoNoon(monthIso).toLocaleDateString('de-DE', { month: 'long' });
}

/**
 * The period headline of the money hero, from the SELECTED instance: "Heute"
 * for the day range, the month name ("Juli", "Juli 2025" across years) for
 * month, the year for year, "Gesamt" for all. `at` is the effective date the
 * range is anchored on (the strip's tapped month or today).
 */
export function periodLabel(range: EarningsRange, at: Date, now: Date = new Date()): string {
  const thisYear = berlinDay(now).slice(0, 4);
  const atYear = at.toLocaleDateString('en-CA', { timeZone: ZONE, year: 'numeric' });
  switch (range) {
    case 'day':
      return berlinDay(at) === berlinDay(now)
        ? 'Heute'
        : at.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: ZONE });
    case 'month': {
      const name = at.toLocaleDateString('de-DE', { month: 'long', timeZone: ZONE });
      return atYear === thisYear ? name : `${name} ${atYear}`;
    }
    case 'year':
      return atYear;
    default:
      return 'Gesamt';
  }
}

/** One slot of the fixed 12-month strip (oldest first, ending this month). */
export interface StripSlot {
  /** First day of the Berlin month ("2026-07-01") - the `at` for a tap. */
  month: string;
  /** Short month name ("Jul"). */
  label: string;
  /** Gesamtertrag of the month, or null when it had no computable slot. */
  value: number | null;
  /** True for the current Berlin month. */
  isCurrent: boolean;
}

/**
 * The tappable 12-month strip: a FIXED axis of the last `count` Berlin months
 * ending this month, so a partial history still renders month-wide chips (like
 * the earnings spark). Months without a computable value carry null - a glance
 * navigator, never a fake zero.
 */
export function stripSlots(strip: EarningsMonth[], now: Date, count = 12): StripSlot[] {
  const byMonth = new Map(strip.map((m) => [m.month.slice(0, 7), m.gesamtertragEur]));
  const currentKey = berlinDay(now).slice(0, 7);
  // Walk months back from the current one using UTC arithmetic on year/month.
  const [y, m] = currentKey.split('-').map(Number);
  const slots: StripSlot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthIso = `${key}-01`;
    slots.push({
      month: monthIso,
      label: monthShort(monthIso),
      value: byMonth.get(key) ?? null,
      isCurrent: key === currentKey,
    });
  }
  return slots;
}

/** Compact strip-chip value ("+104" / "-7" / "0" / "–"). */
export function stripValueLabel(value: number | null): string {
  if (value == null) return '–';
  const rounded = Math.round(value);
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  // Only a gain carries the "+"; zero stays bare, a loss keeps its own minus.
  return `${safe > 0 ? '+' : ''}${safe.toLocaleString('de-DE')}`;
}

/** Ertrag-chart section title per range ("Ertrag pro Tag" etc.). */
export function ertragTitle(range: EarningsRange): string {
  switch (range) {
    case 'day':
      return 'Ertrag pro Stunde';
    case 'month':
      return 'Ertrag pro Tag';
    default:
      return 'Ertrag pro Monat';
  }
}

/** X-axis label of one chart bucket given the range (Berlin-local). */
export function bucketAxisLabel(startIso: string, range: EarningsRange): string {
  const d = new Date(startIso);
  switch (range) {
    case 'day':
      return d
        .toLocaleTimeString('de-DE', { hour: '2-digit', hour12: false, timeZone: ZONE })
        .replace(/\D/g, '');
    case 'month':
      return `${d.toLocaleDateString('de-DE', { day: 'numeric', timeZone: ZONE })}.`;
    default:
      return d.toLocaleDateString('de-DE', { month: 'short', timeZone: ZONE }).replace('.', '');
  }
}

/** Full tooltip label of one chart bucket (Berlin-local). */
export function bucketTooltipLabel(startIso: string, range: EarningsRange): string {
  const d = new Date(startIso);
  switch (range) {
    case 'day':
      return `${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: ZONE })} Uhr`;
    case 'month':
      return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: ZONE });
    default:
      return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: ZONE });
  }
}

/** The best (highest-Gesamtertrag) bucket of a series, or null when empty. */
export function bestBucket(series: EarningsSeriesPoint[]): EarningsSeriesPoint | null {
  let best: EarningsSeriesPoint | null = null;
  for (const p of series) {
    if (best == null || p.gesamtertragEur > best.gesamtertragEur) best = p;
  }
  return best;
}

/**
 * The "bester Tag/Monat/Stunde" line under the Ertrag chart: names the best
 * bucket and its Gesamtertrag. Null when the series is empty or the best value
 * is not positive (nothing worth highlighting - honest, no "Bester Tag: 0 €").
 */
export function bestBucketText(series: EarningsSeriesPoint[], range: EarningsRange): string | null {
  const best = bestBucket(series);
  if (best == null || best.gesamtertragEur <= 0) return null;
  const lead = range === 'day' ? 'Beste Stunde' : range === 'month' ? 'Bester Tag' : 'Bester Monat';
  return `${lead}: ${bucketTooltipLabel(best.start, range)} · +${eurAmount(best.gesamtertragEur)}`;
}
