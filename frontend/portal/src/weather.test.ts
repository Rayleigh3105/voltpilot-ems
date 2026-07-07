// Pin the process to the platform timezone BEFORE any Date use: the regression
// scenario below is exactly the captain's screenshot (July = UTC+2), and these
// assertions must not depend on the CI machine's local timezone.
process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { axisHourLabel, hoursAhead, nextHourIndex, nowMarkerIndex, tooltipHeader } from './weather';

/** Hourly UTC points like the weather API returns (run day starts 00:00 UTC). */
function hourlyPoints(startIso: string, hours: number) {
  const start = new Date(startIso).getTime();
  return Array.from({ length: hours }, (_, i) => ({
    ts: new Date(start + i * 3_600_000).toISOString().replace('.000Z', 'Z'),
  }));
}

describe('nextHourIndex (the hero "naechste Stunde" selection)', () => {
  // The captain's screenshot: Mon 2026-07-06 22:36 Berlin = 20:36 UTC. The run
  // series starts at 00:00 UTC - the OLD code showed points[0] (02:00 Berlin,
  // ~22h stale); the hero must pick the upcoming hour 21:00 UTC = 23:00 Berlin.
  const points = hourlyPoints('2026-07-06T00:00:00Z', 48);
  const nowMs = Date.parse('2026-07-06T20:36:00Z');

  it('picks the upcoming hour, never points[0]', () => {
    const idx = nextHourIndex(points, nowMs);
    expect(idx).toBe(21);
    expect(points[idx].ts).toBe('2026-07-06T21:00:00Z');
  });

  it('is -1 when the horizon is exhausted', () => {
    expect(nextHourIndex(points, Date.parse('2026-07-08T00:00:00Z'))).toBe(-1);
  });

  it('picks an exact full-hour boundary as the next hour', () => {
    expect(nextHourIndex(points, Date.parse('2026-07-06T21:00:00Z'))).toBe(21);
  });
});

describe('nowMarkerIndex (the "Jetzt" markLine)', () => {
  const points = hourlyPoints('2026-07-06T00:00:00Z', 48);

  it('marks the last elapsed hour', () => {
    expect(nowMarkerIndex(points, Date.parse('2026-07-06T20:36:00Z'))).toBe(20);
  });

  it('is -1 when every point is in the future', () => {
    expect(nowMarkerIndex(points, Date.parse('2026-07-05T00:00:00Z'))).toBe(-1);
  });
});

describe('hoursAhead (the honest Vorhersagehorizont)', () => {
  it('counts only future hours, not the elapsed part of the run', () => {
    const points = hourlyPoints('2026-07-06T00:00:00Z', 48);
    expect(hoursAhead(points, Date.parse('2026-07-06T20:36:00Z'))).toBe(27);
    expect(hoursAhead(points, Date.parse('2026-07-05T00:00:00Z'))).toBe(48);
  });
});

describe('local-time rendering (UTC never reaches the user)', () => {
  it('tooltip header renders 21:00 UTC as Monday 23:00 German local time', () => {
    // The captain's tooltip showed the raw "2026-07-06T23:00:00Z" - which READS
    // as 23 Uhr but is 01:00 Berlin. The header must be local German time.
    expect(tooltipHeader('2026-07-06T21:00:00Z')).toBe('Mo., 23:00 Uhr');
    expect(tooltipHeader('2026-07-06T23:00:00Z')).toBe('Di., 01:00 Uhr');
  });

  it('axis label shifts the raw UTC hour into Berlin local', () => {
    expect(axisHourLabel('2026-07-06T21:00:00Z')).toContain('23');
    expect(axisHourLabel('2026-07-06T21:00:00Z')).toContain('Mo');
  });

  it('never crashes on a malformed timestamp', () => {
    expect(tooltipHeader('garbage')).toBe('garbage');
    expect(axisHourLabel('garbage')).toBe('garbage');
  });
});
