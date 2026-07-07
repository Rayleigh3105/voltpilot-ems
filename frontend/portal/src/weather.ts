/**
 * Pure time logic for the weather view (unit-tested; the chart/page only render).
 *
 * The weather API returns the latest collector run's FULL hourly series in UTC
 * (ISO timestamps with 'Z'), starting at 00:00 UTC of the run day - so the
 * array begins with hours that are already in the past. Everything here renders
 * those UTC instants in the user's local time (DACH customers = Europe/Berlin)
 * and picks the honest "next hour" point instead of points[0], which was the
 * real prod bug: the hero showed the run's first hour (02:00 local, up to a day
 * old) as "Temperatur (naechste Stunde)".
 */

export interface TimedPoint {
  ts: string;
}

/**
 * Index of the upcoming full hour: the first point at/after `nowMs`.
 * -1 when the forecast horizon is exhausted (no future point).
 */
export function nextHourIndex(points: TimedPoint[], nowMs: number): number {
  for (let i = 0; i < points.length; i++) {
    if (new Date(points[i].ts).getTime() >= nowMs) return i;
  }
  return -1;
}

/**
 * Index for the "Jetzt" markLine: the last point at/before `nowMs`
 * (same convention as ScheduleChart/HistoryChart). -1 when every point is
 * in the future (fresh run reaching only forward).
 */
export function nowMarkerIndex(points: TimedPoint[], nowMs: number): number {
  let idx = -1;
  for (let i = 0; i < points.length; i++) {
    if (new Date(points[i].ts).getTime() <= nowMs) idx = i;
    else break;
  }
  return idx;
}

/** Hours of forecast still ahead of `nowMs` (the honest "Vorhersagehorizont"). */
export function hoursAhead(points: TimedPoint[], nowMs: number): number {
  return points.reduce((n, p) => (new Date(p.ts).getTime() >= nowMs ? n + 1 : n), 0);
}

/**
 * Tooltip header: German LOCAL time ("Mo., 23:00 Uhr"), never the raw
 * UTC ISO string (which read as "23 Uhr" while actually being 01:00 local -
 * the captain's screenshot confusion).
 */
export function tooltipHeader(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('de-DE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })} Uhr`;
}

/** Axis label: local weekday + hour ("Mo., 23 Uhr"). */
export function axisHourLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit' });
}
