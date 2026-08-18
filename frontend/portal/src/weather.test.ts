// Pin the process to the platform timezone BEFORE any Date use: the regression
// scenario below is exactly the captain's screenshot (July = UTC+2), and these
// assertions must not depend on the CI machine's local timezone.
process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import {
  axisHourLabel,
  hoursAhead,
  nextHourIndex,
  nowMarkerIndex,
  tooltipHeader,
  weatherWhy,
  weatherWhyTomorrow,
} from './weather';

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

describe('weatherWhy (the live-zone PV "why" one-liner)', () => {
  const NOW = new Date(2026, 6, 7, 10, 0); // 10:00 Berlin local

  /** Cloud points at local hours of NOW's day (cloudCoverPct per hour). */
  function clouds(from: number, list: (number | null)[]) {
    return list.map((c, i) => ({
      ts: new Date(2026, 6, 7, from + i, 0).toISOString(),
      cloudCoverPct: c,
    }));
  }

  it('is null when no upcoming daytime cloud data exists', () => {
    expect(weatherWhy([], NOW)).toBeNull();
    // Only past hours (< now) and night hours -> nothing to say.
    expect(weatherWhy(clouds(6, [10, 20]), NOW)).toBeNull();
  });

  it('sunny now, clouding over later -> "Sonnig bis H Uhr"', () => {
    const pts = clouds(10, [10, 15, 20, 80, 90]); // clear until 13:00, then cloudy
    expect(weatherWhy(pts, NOW)).toBe('Sonnig bis 13 Uhr - gute PV-Erträge erwartet.');
  });

  it('sunny all remaining day -> "Überwiegend sonnig"', () => {
    expect(weatherWhy(clouds(10, [10, 20, 15, 25, 30]), NOW)).toBe(
      'Überwiegend sonnig - gute PV-Erträge erwartet.',
    );
  });

  it('cloudy now, clearing later -> "Ab H Uhr sonniger"', () => {
    const pts = clouds(10, [90, 85, 30, 20]); // clears at 12:00
    expect(weatherWhy(pts, NOW)).toBe('Ab 12 Uhr sonniger - dann bessere PV-Erträge.');
  });

  it('overcast all day -> "Stark bewölkt"', () => {
    expect(weatherWhy(clouds(10, [90, 85, 95, 80]), NOW)).toBe(
      'Stark bewölkt - heute wenig Solarertrag.',
    );
  });
});

describe('weatherWhyTomorrow (Erklärbarkeit Stufe 2: das Wetter-WORT für morgen)', () => {
  const NOW = new Date(2026, 6, 7, 20, 45); // 7. Juli, 20:45 Berlin

  /** Bewölkung je Tagstunde eines Tages (`day` = Tag im Juli). */
  function clouds(day: number, from: number, list: (number | null)[]) {
    return list.map((c, i) => ({
      ts: new Date(2026, 6, day, from + i, 0).toISOString(),
      cloudCoverPct: c,
    }));
  }

  it('liefert das Wort aus den MORGIGEN Tagstunden', () => {
    expect(weatherWhyTomorrow(clouds(8, 8, [10, 15, 20, 25, 30]), NOW)).toBe('sonnig');
    expect(weatherWhyTomorrow(clouds(8, 8, [95, 90, 100, 88, 92]), NOW)).toBe('bewoelkt');
    expect(weatherWhyTomorrow(clouds(8, 8, [50, 55, 45, 60, 50]), NOW)).toBe('wechselnd');
  });

  it('nutzt DIESELBEN Schwellen wie der Heute-Satz', () => {
    // Genau auf der Sonnen-Schwelle ist es noch sonnig, ein Prozent darüber nicht.
    expect(weatherWhyTomorrow(clouds(8, 8, [40, 40, 40, 40]), NOW)).toBe('sonnig');
    expect(weatherWhyTomorrow(clouds(8, 8, [41, 41, 41, 41]), NOW)).toBe('wechselnd');
    // Und genau auf der Wolken-Schwelle ist es bewölkt.
    expect(weatherWhyTomorrow(clouds(8, 8, [65, 65, 65, 65]), NOW)).toBe('bewoelkt');
  });

  it('sagt über morgen NICHTS, wenn die Vorhersage nicht so weit reicht', () => {
    expect(weatherWhyTomorrow([], NOW)).toBeNull();
    // Nur HEUTE - der morgige Tag ist unbekannt.
    expect(weatherWhyTomorrow(clouds(7, 8, [10, 10, 10, 10, 10]), NOW)).toBeNull();
    // Zu wenige bewertete Stunden von morgen.
    expect(weatherWhyTomorrow(clouds(8, 8, [10, 10]), NOW)).toBeNull();
    // Punkte ohne Bewölkung zählen nicht.
    expect(weatherWhyTomorrow(clouds(8, 8, [null, null, null, null, null]), NOW)).toBeNull();
  });

  it('wertet nur die TAGSTUNDEN von morgen - die Nacht sagt nichts über Solar', () => {
    // Nachts klar, tagsüber dicht: das Urteil ist bewölkt.
    const nacht = clouds(8, 0, [0, 0, 0, 0, 0, 0]);
    const tag = clouds(8, 8, [95, 95, 95, 95]);
    expect(weatherWhyTomorrow([...nacht, ...tag], NOW)).toBe('bewoelkt');
    // Nur Nachtstunden: kein Urteil.
    expect(weatherWhyTomorrow(nacht, NOW)).toBeNull();
  });
});
