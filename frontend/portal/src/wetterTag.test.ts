import { describe, expect, it } from 'vitest';
import type { HistoryBucket, WeatherPoint } from './api';
import { grad, gradSpanne, HIMMEL_WORT, pvBei, sonnenSatz, stundeBei, wetterModell } from './wetterTag';

/** Dienstag, 20.10.2026, Ortszeit (Europe/Berlin über vitest.config). */
const um = (h: number, m = 0, tag = 0) => new Date(2026, 9, 20 + tag, h, m, 0, 0);

/** Drei Tage Wetter je Stunde: hell von 8 bis 18 Uhr, die Bewölkung je Tag fest. */
function punkte(wolkenJeTag: number[], dni = true): WeatherPoint[] {
  const out: WeatherPoint[] = [];
  wolkenJeTag.forEach((wolken, tag) => {
    for (let h = 0; h < 24; h++) {
      const hell = h >= 8 && h < 18;
      out.push({
        ts: um(h, 0, tag).toISOString(),
        temperatureC: 8 + (hell ? h - 8 : 0) - tag,
        cloudCoverPct: wolken,
        ghiWM2: hell ? 400 : 0,
        dniWM2: dni ? (hell ? (wolken < 50 ? 300 : 40) : 0) : null,
        dhiWM2: null,
      });
    }
  });
  return out;
}

/** PV-Prognose je Viertelstunde: 4 kW in den hellen Stunden, sonst 0. */
function prognose(vonTag: number, bisTag: number, ab?: Date): { start: string; pvKw: number }[] {
  const out: { start: string; pvKw: number }[] = [];
  for (let tag = vonTag; tag <= bisTag; tag++) {
    for (let q = 0; q < 96; q++) {
      const t = um(0, q * 15, tag);
      if (ab && t < ab) continue;
      const h = q / 4;
      out.push({ start: t.toISOString(), pvKw: h >= 8 && h < 18 ? 4 : 0 });
    }
  }
  return out;
}

/** Gemessen heute bis `bis`: 2 kWh je Stunde in den hellen Stunden (= 2 kW). */
function messung(bis: Date): { buckets: HistoryBucket[]; bucketMinutes: number } {
  const buckets: HistoryBucket[] = [];
  for (let q = 0; q < 96; q++) {
    const t = um(0, q * 15);
    if (t.getTime() >= bis.getTime()) break;
    const h = q / 4;
    buckets.push({
      start: t.toISOString(),
      pvKwh: h >= 8 && h < 18 ? 0.5 : 0,
      loadKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      batteryChargeKwh: null,
      batteryDischargeKwh: null,
      socMinPct: null,
      socMaxPct: null,
      socLastPct: null,
      priceEurMwh: null,
      costEur: null,
    });
  }
  return { buckets, bucketMinutes: 15 };
}

describe('wetterModell · ein Wortsatz für den Himmel (Haus-Schwellen 40/65 %)', () => {
  it('nennt sonnig, wechselnd, bewölkt — und nachts klar oder bewölkt', () => {
    const m = wetterModell({ punkte: punkte([10, 50, 90]), prognose: [], messung: null, jetzt: um(13) });
    expect(m.tage.map((t) => t.art && HIMMEL_WORT[t.art])).toEqual(['sonnig', 'wechselnd', 'bewölkt']);
    expect(m.jetzt?.art).toBe('sonnig');
    const nacht = wetterModell({ punkte: punkte([10, 90, 90]), prognose: [], messung: null, jetzt: um(2) });
    expect(nacht.jetzt?.art).toBe('klar');
    expect(stundeBei(nacht.tage[1], um(2, 0, 1).getTime())?.art).toBe('nachtWolken');
    expect(HIMMEL_WORT.nachtWolken).toBe('bewölkt');
  });

  it('trägt drei Tage mit Wort, Temperaturspanne und hellen Stunden', () => {
    const m = wetterModell({ punkte: punkte([10, 50, 90]), prognose: [], messung: null, jetzt: um(13) });
    expect(m.tage.map((t) => t.wort)).toEqual(['Heute', 'Morgen', 'Do 22.10.']);
    expect(gradSpanne(m.tage[0].tmin, m.tage[0].tmax)).toBe('8–17°');
    expect(m.tage[0].hell).toEqual({ von: um(8).getTime(), bis: um(18).getTime() });
  });
});

describe('wetterModell · Sonnenstrom gemessen und erwartet', () => {
  it('heute: gemessen bis jetzt, danach erwartet - und die Summe nur mit Prognose für den Rest', () => {
    const m = wetterModell({
      punkte: punkte([10, 50, 90]),
      prognose: prognose(0, 1),
      messung: messung(um(13, 45)),
      jetzt: um(13, 50),
    });
    const heute = m.tage[0];
    expect(pvBei(heute, um(10).getTime())?.herkunft).toBe('gemessen');
    expect(pvBei(heute, um(10).getTime())?.kw).toBe(2);
    expect(pvBei(heute, um(15).getTime())?.herkunft).toBe('erwartet');
    // Gemessen 8:00-13:45 = 5,75 Std x 2 kW; erwartet 13:45-18:00 = 4,25 Std x 4 kW.
    expect(heute.kwhBisher).toBeCloseTo(11.5, 5);
    expect(heute.kwh).toBeCloseTo(11.5 + 17, 5);
    expect(m.pvJetzt?.kw).toBe(2);
    expect(m.pvJetzt?.herkunft).toBe('gemessen');
  });

  it('zählt die laufende Viertelstunde nie als gemessen', () => {
    const m = wetterModell({ punkte: punkte([10]), prognose: [], messung: messung(um(14)), jetzt: um(13, 50) });
    expect(pvBei(m.tage[0], um(13, 45).getTime())).toBeNull();
    expect(m.pvJetzt?.start).toBe(um(13, 30).getTime());
  });

  it('morgen: kWh nur, wenn die Prognose den hellen Tag deckt', () => {
    const voll = wetterModell({ punkte: punkte([10, 50, 90]), prognose: prognose(0, 1), messung: null, jetzt: um(13) });
    expect(voll.tage[1].kwh).toBeCloseTo(40, 5);
    // Die Prognose endet morgen um 12 Uhr: keine Summe, nie eine halbe.
    const halb = wetterModell({
      punkte: punkte([10, 50, 90]),
      prognose: prognose(0, 1).filter((p) => Date.parse(p.start) < um(12, 0, 1).getTime()),
      messung: null,
      jetzt: um(13),
    });
    expect(halb.tage[1].kwh).toBeNull();
    expect(halb.tage[1].mitStrom).toBe(true);
  });

  it('ohne Prognose: keine kWh, aber Sonnenstunden', () => {
    const m = wetterModell({ punkte: punkte([10, 50, 90]), prognose: [], messung: null, jetzt: um(13) });
    expect(m.tage[1].kwh).toBeNull();
    expect(m.tage[1].mitStrom).toBe(false);
    expect(m.tage.map((t) => t.sonnenStunden)).toEqual([10, 0, 0]);
    expect(wetterModell({ punkte: punkte([10], false), prognose: [], messung: null, jetzt: um(13) }).tage[0].sonnenStunden).toBeNull();
  });

  it('nennt eine alte Messung nicht „jetzt"', () => {
    const m = wetterModell({ punkte: punkte([10]), prognose: [], messung: messung(um(11)), jetzt: um(13, 50) });
    expect(m.pvJetzt).toBeNull();
  });
});

describe('sonnenSatz und Grad', () => {
  it('sagt, bis wann bzw. ab wann die Sonne scheint - und nachts nichts', () => {
    const bei = (h: number) => sonnenSatz(wetterModell({ punkte: punkte([10]), prognose: [], messung: null, jetzt: um(h) }));
    expect(bei(6)).toBe('Sonne ab ca. 8 Uhr');
    expect(bei(13)).toBe('Sonne bis ca. 18 Uhr');
    expect(bei(20)).toBeNull();
  });

  it('rundet auf ganze Grad mit echtem Minus', () => {
    expect(grad(16.4)).toBe('16');
    expect(grad(-2.6)).toBe('−3');
    expect(grad(-0.2)).toBe('0');
    expect(gradSpanne(null, 4)).toBeNull();
  });
});

describe('wetterModell · Stundenraster', () => {
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
        dniWM2: hell ? 300 : 0,
        dhiWM2: null,
      });
    }
    const m = wetterModell({ punkte: fein, prognose: [], messung: null, jetzt: um(13, 50) });
    expect(m.tage[0].stunden).toHaveLength(24);
    expect(m.tage[0].sonnenStunden).toBe(10);
    expect(m.jetzt?.start).toBe(um(13).getTime());
    expect(m.jetzt?.temp).toBeCloseTo(11.5, 5);
  });
});
