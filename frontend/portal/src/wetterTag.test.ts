import { describe, expect, it } from 'vitest';
import type { WeatherPoint } from './api';
import { art, stundenRaster } from './wetterTag';

/** Dienstag, 20.10.2026, Ortszeit (Europe/Berlin über vitest.config). */
const um = (h: number, m = 0, tag = 0) => new Date(2026, 9, 20 + tag, h, m, 0, 0);

describe('art · ein Wortsatz für den Himmel (Haus-Schwellen 40/65 %)', () => {
  it('nennt sonnig, wechselnd, bewölkt tagsüber', () => {
    expect(art(10, 400)).toBe('sonnig');
    expect(art(50, 400)).toBe('wechselnd');
    expect(art(90, 400)).toBe('bewoelkt');
  });

  it('nennt nachts klar oder bewölkt - nie sonnig/wechselnd', () => {
    expect(art(10, 0)).toBe('klar');
    expect(art(90, 0)).toBe('nachtWolken');
    expect(art(null, 400)).toBeNull();
  });
});

describe('stundenRaster', () => {
  it('fasst eine feinere Reihe je Stunde zusammen, statt Sonnenstunden zu vervielfachen', () => {
    const fein: WeatherPoint[] = [];
    for (let q = 0; q < 96; q++) {
      const h = q / 4;
      const hell = h >= 8 && h < 18;
      fein.push({
        ts: um(0, q * 15).toISOString(),
        temperatureC: 10 + (q % 4),
        cloudCoverPct: 10,
        ghiWM2: hell ? 400 : 0,
        dniWM2: null,
        dhiWM2: null,
        dniNormalWM2: hell ? 300 : 0,
      });
    }
    const stunden = stundenRaster(fein);
    expect(stunden).toHaveLength(24);
    // Je Stunde das Mittel der vier Viertelstunden (10, 11, 12, 13 -> 11,5).
    expect(stunden[0].temp).toBeCloseTo(11.5, 5);
    expect(stunden.filter((s) => s.art === 'sonnig')).toHaveLength(10);
    expect(stunden.filter((s) => s.art === 'klar' || s.art === 'nachtWolken')).toHaveLength(14);
  });

  it('lässt eine Größe ohne Wert `null` - nie eine erfundene Null', () => {
    const ohneDni: WeatherPoint = {
      ts: um(10).toISOString(),
      temperatureC: 15,
      cloudCoverPct: 20,
      ghiWM2: 400,
      dniWM2: null,
      dhiWM2: null,
      dniNormalWM2: null,
    };
    expect(stundenRaster([ohneDni])[0].dni).toBeNull();
  });
});
