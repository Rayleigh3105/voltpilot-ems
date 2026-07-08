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

// ---- Weather "why" one-liner (report N3: turn numbers into a story) ----------

/** A weather point with the cloud-cover the "why" sentence reads. */
export interface CloudPoint {
  ts: string;
  cloudCoverPct: number | null;
  ghiWM2?: number | null;
}

/** Local daytime hours where solar generation actually matters. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 21;
/** Below this cloud cover an hour counts as sunny, above CLOUDY as overcast. */
const SUNNY_MAX_CLOUD = 40;
const CLOUDY_MIN_CLOUD = 65;

function isDaytime(iso: string): boolean {
  const h = new Date(iso).getHours();
  return h >= DAY_START_HOUR && h < DAY_END_HOUR;
}

/** Local full hour of an ISO instant ("16"). */
function localHour(iso: string): number {
  return new Date(iso).getHours();
}

/**
 * ONE plain-German weather sentence for the live zone (report N3): reads the
 * upcoming DAYTIME hours' cloud cover and tells the PV story - "Sonnig bis
 * 16 Uhr - gute PV-Erträge erwartet", "Ab 14 Uhr sonniger - dann mehr Solar",
 * "Meist bewölkt - heute wenig Solarertrag". Null when the forecast has no
 * usable upcoming daytime cloud data (nothing honest to say), so the caller
 * simply omits the line.
 */
export function weatherWhy(points: CloudPoint[], now: Date): string | null {
  const nowMs = now.getTime();
  const day = points.filter(
    (p) => new Date(p.ts).getTime() >= nowMs && isDaytime(p.ts) && p.cloudCoverPct != null,
  );
  if (day.length === 0) return null;

  const clouds = day.map((p) => p.cloudCoverPct as number);
  const firstSunny = clouds[0] <= SUNNY_MAX_CLOUD;

  if (firstSunny) {
    // Sunny now: find the first upcoming hour that clouds over.
    const cloudsOverIdx = day.findIndex((p) => (p.cloudCoverPct as number) >= CLOUDY_MIN_CLOUD);
    if (cloudsOverIdx > 0) {
      return `Sonnig bis ${localHour(day[cloudsOverIdx].ts)} Uhr - gute PV-Erträge erwartet.`;
    }
    return 'Überwiegend sonnig - gute PV-Erträge erwartet.';
  }

  // Cloudy now: does it clear up during the remaining daylight?
  const clearsIdx = day.findIndex((p) => (p.cloudCoverPct as number) <= SUNNY_MAX_CLOUD);
  if (clearsIdx > 0) {
    return `Ab ${localHour(day[clearsIdx].ts)} Uhr sonniger - dann bessere PV-Erträge.`;
  }
  const avg = clouds.reduce((s, c) => s + c, 0) / clouds.length;
  return avg >= CLOUDY_MIN_CLOUD
    ? 'Stark bewölkt - heute wenig Solarertrag.'
    : 'Wechselnd bewölkt - durchwachsene PV-Erträge.';
}
