import { describe, expect, it } from 'vitest';
import type { ForecastResponse, ForecastValue, HistoryBucket, RueckblickKind, WeatherPoint } from './api';
import {
  gesternSatz,
  mengenSatz,
  morgenSatz,
  prognoseModell,
  reichtSatz,
  rueckblickSatz,
  rueckblickZeilen,
  uebrigSatz,
  verbrauchsSpitzeSatz,
  type PrognoseEingaben,
} from './prognoseSeite';

/** Mittwoch, 11.11.2026, Ortszeit (Europe/Berlin über vitest.config). */
const um = (h: number, m = 0, tag = 0) => new Date(2026, 10, 11 + tag, h, m, 0, 0);

/** Viertelstündliche Reihe (Sonne oder Verbrauch) über mehrere Tage, hell 8–18 Uhr. */
function viertel(vonTag: number, bisTag: number, kwHell: number, kwDunkel = 0): ForecastValue[] {
  const out: ForecastValue[] = [];
  for (let tag = vonTag; tag <= bisTag; tag++) {
    for (let q = 0; q < 96; q++) {
      const t = um(0, q * 15, tag);
      const h = q / 4;
      out.push({ ts: t.toISOString(), valueKw: h >= 8 && h < 18 ? kwHell : kwDunkel });
    }
  }
  return out;
}

/** Stündliche Reihe (der Wochen-Ausblick) über mehrere Tage, hell 8–18 Uhr. */
function stunden(vonTag: number, bisTag: number, kwHell: number, kwDunkel = 0): ForecastValue[] {
  const out: ForecastValue[] = [];
  for (let tag = vonTag; tag <= bisTag; tag++) {
    for (let h = 0; h < 24; h++) {
      out.push({ ts: um(h, 0, tag).toISOString(), valueKw: h >= 8 && h < 18 ? kwHell : kwDunkel });
    }
  }
  return out;
}

function forecast(partial: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    activePvModel: 'pv-physical',
    activeLoadModel: 'load-persistence',
    pvRunAt: um(0).toISOString(),
    pvKw: [],
    loadRunAt: um(0).toISOString(),
    loadKw: [],
    yesterdayExpected: { pvRunAt: null, pvKw: [], loadRunAt: null, loadKw: [] },
    weekly: { pvRunAt: null, pvKw: [], loadRunAt: null, loadKw: [] },
    ...partial,
  };
}

/** Gemessen bis `bis`: `kw` in den hellen Stunden, sonst 0. */
function messung(bis: Date, pvKw: number, verbrauchKw: number): PrognoseEingaben['messung'] {
  const buckets: HistoryBucket[] = [];
  for (let q = 0; q < 96; q++) {
    const t = um(0, q * 15);
    if (t.getTime() >= bis.getTime()) break;
    const h = q / 4;
    buckets.push({
      start: t.toISOString(),
      pvKwh: (h >= 8 && h < 18 ? pvKw : 0) * 0.25,
      loadKwh: verbrauchKw * 0.25,
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

const keinWetter: WeatherPoint[] = [];

describe('prognoseModell · Grundform', () => {
  it('baut heute/morgen aus Viertelstunden, den Ausblick aus der Woche', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 1, 4), loadKw: viertel(0, 1, 1, 0.3), weekly: { pvRunAt: null, pvKw: stunden(2, 6, 3), loadRunAt: null, loadKw: stunden(2, 6, 1), } }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(m.tage).toHaveLength(7);
    expect(m.tage[0].wort).toBe('Heute');
    expect(m.tage[0].ausblick).toBe(false);
    expect(m.tage[1].wort).toBe('Morgen');
    expect(m.tage[2].ausblick).toBe(true);
    expect(m.mitPv).toBe(true);
  });

  it('erkennt eine Anlage ohne PV (alle Sonnenwerte 0)', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 1, 0), loadKw: viertel(0, 1, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(m.mitPv).toBe(false);
  });

  it('lässt einen Ausblick-Tag ohne Werte einfach aus (WEATHER_FORECAST_DAYS=3 in Produktion)', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 1, 4), loadKw: viertel(0, 1, 1), weekly: { pvRunAt: null, pvKw: stunden(2, 2, 3), loadRunAt: null, loadKw: stunden(2, 2, 1) } }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    // Nur heute, morgen und EIN Ausblick-Tag (Tag 2) - Tag 3-6 fehlen ohne Daten, keine Null-Zeile.
    expect(m.tage).toHaveLength(3);
  });

  it('deckt eine Tagessumme erst ab 90 % der benötigten Stunden (Fehlend ist keine Null)', () => {
    // Tag 1 (morgen) nur bis 18 Uhr geliefert: 18 von 24 Stunden = 75 % - keine Summe.
    const unvollstaendig = viertel(0, 1, 4).filter((p, i) => i < 96 + 72);
    const m = prognoseModell({
      forecast: forecast({ pvKw: unvollstaendig, loadKw: viertel(0, 1, 1) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(20),
    });
    expect(m.tage[1].sonneKwh).toBeNull();
  });

  it('zählt "schon erzeugt/verbraucht" nur aus abgeschlossenen Messungen', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 1, 4), loadKw: viertel(0, 1, 1) }),
      weather: keinWetter,
      messung: messung(um(13, 45), 2, 0.5),
      jetzt: um(13, 50),
    });
    // Gemessen 8:00-13:45 = 5,75 Std x 2 kW.
    expect(m.tage[0].sonneBisherKwh).toBeCloseTo(11.5, 5);
    expect(m.tage[0].verbrauchBisherKwh).toBeCloseTo(13.75 * 0.5, 5);
  });
});

describe('mengenSatz · sieben Stufen', () => {
  it('folgt dem Verhältnis Sonne/Verbrauch', () => {
    expect(mengenSatz(68, 12)).toBe('viel mehr Sonne als Verbrauch'); // r ≈ 5,67
    expect(mengenSatz(28, 19)).toBe('etwas mehr Sonne als Verbrauch'); // r ≈ 1,47
    expect(mengenSatz(5.9, 30)).toBe('viel weniger Sonne als Verbrauch'); // r ≈ 0,197
    expect(mengenSatz(null, 10)).toBeNull();
    expect(mengenSatz(10, 0)).toBe('viel mehr Sonne als Verbrauch');
  });
});

describe('reichtSatz', () => {
  it('nennt das Deckungsfenster oder "reicht heute/<Tag> nicht"', () => {
    // Nachts etwas Grundlast (0,3 kW), sonst wäre "Sonne 0 ≥ Verbrauch 0" nachts trivial wahr.
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 4), loadKw: viertel(0, 0, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(reichtSatz(m.tage[0])).toBe('Sonne reicht 08:00–18:00');

    const ohne = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0), loadKw: viertel(0, 0, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(reichtSatz(ohne.tage[0])).toBe('Sonne reicht heute nicht');
  });
});

describe('uebrigSatz · der Tipp "Am meisten Sonne übrig"', () => {
  it('nennt das Zweistunden-Fenster mit dem größten Überschuss ab jetzt', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 4), loadKw: viertel(0, 0, 1) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    // Überschuss 3 kW konstant 13-18 Uhr - jedes Fenster ist gleich gut, das erste gewinnt.
    expect(uebrigSatz(m.tage[0])).toBe('Am meisten Sonne übrig 13:00–15:00');
  });

  it('zeigt an knappen Tagen nur die Menge, ganz ohne Überschuss gar nichts', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 1.2), loadKw: viertel(0, 0, 1) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(uebrigSatz(m.tage[0])).toMatch(/^Übrig bleiben heute rund \d+ kWh$/);

    const ohne = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0), loadKw: viertel(0, 0, 1) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(uebrigSatz(ohne.tage[0])).toBe('Heute bleibt keine Sonne übrig');
  });
});

describe('verbrauchsSpitzeSatz · ohne PV', () => {
  it('nennt die drei aufeinanderfolgenden Stunden mit dem meisten Verbrauch', () => {
    const last = viertel(0, 0, 0).map((p, i) => {
      const h = Math.floor(i / 4);
      return { ...p, valueKw: h >= 7 && h < 10 ? 5 : 1 };
    });
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0), loadKw: last }),
      weather: keinWetter,
      messung: null,
      jetzt: um(0),
    });
    expect(verbrauchsSpitzeSatz(m.tage[0])).toBe('Am meisten Verbrauch 7–10 Uhr');
  });
});

describe('morgenSatz', () => {
  it('nennt die Tagesmenge für morgen - Sonne mit PV, sonst Verbrauch', () => {
    const m = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 1, 4), loadKw: viertel(0, 1, 1) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(morgenSatz(m.tage[1], true)).toMatch(/^Morgen rund \d+ kWh Sonne$/);
    expect(morgenSatz(m.tage[1], false)).toMatch(/^Morgen rund \d+ kWh$/);
    expect(morgenSatz(undefined, true)).toBeNull();
  });
});

describe('massstab · ein Maßstab, der ehrlich bleibt (Captain-Entscheid, Bericht 6.1)', () => {
  it('trübe Winterwoche bleibt niedrig - der Maßstab misst sich an der Anlage, nicht an ihrer eigenen Spitze', () => {
    // Eine trübe Woche: Sonne erreicht höchstens 0,5 kW, obwohl die Anlage 10 kWp hat.
    const truebe = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0.5), loadKw: viertel(0, 0, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
      anlagenleistungKwp: 10,
    });
    // 40 % von 10 kWp = 4 - weit über der beobachteten Spitze (1 kW) dieser Woche.
    expect(truebe.massstab).toBe(4);

    // Ohne bekannte Anlagenleistung bleibt der begründete Rückfall: die eigene Spitze der Woche.
    const ohneKwp = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0.5), loadKw: viertel(0, 0, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
    });
    expect(ohneKwp.massstab).toBeCloseTo(1, 5);
  });

  it('ein sehr sonniger Tag darf den 40-%-Maßstab überschreiten - die Balken dürfen nie über 100 % hinaus', () => {
    // Spitze 5 kW bei 10 kWp (50 % Modulwirkungsgrad-Spitze) - über dem 4-kW-Boden.
    const sonnig = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 5), loadKw: viertel(0, 0, 1, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
      anlagenleistungKwp: 10,
    });
    expect(sonnig.massstab).toBeCloseTo(5, 5);
  });

  it('ohne PV bleibt der Maßstab die stärkste Verbrauchsstunde - die Anlagenleistung gilt nur der Sonne', () => {
    const ohnePv = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 0), loadKw: viertel(0, 0, 2, 0.3) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
      anlagenleistungKwp: 10, // bewusst gesetzt, darf ohne PV nichts bewirken
    });
    expect(ohnePv.massstab).toBeCloseTo(2, 5);
  });

  it('mit bekannter kWp bleibt die Sonne bei sich - ein Gewerbebetrieb mit viel Verbrauch und wenig PV darf die Sonnen-Säulen nicht unsichtbar machen (captain-Befund vp-prognose-teppich-treue)', () => {
    // Gewerbe: Sonne höchstens 6 kW, Verbrauch bis 49 kW, Anlage 10,5 kWp -
    // der Teppich zeigt NUR die Sonne (`Teppich.wert` in `PrognoseTeppich.tsx`);
    // ein Maßstab, der vom (ungezeigten) Verbrauch dominiert wird, ließe jede
    // Sonnen-Säule auf unter 15 % Höhe schrumpfen.
    const gewerbe = prognoseModell({
      forecast: forecast({ pvKw: viertel(0, 0, 6), loadKw: viertel(0, 0, 49, 9) }),
      weather: keinWetter,
      messung: null,
      jetzt: um(13),
      anlagenleistungKwp: 10.5,
    });
    // 40 % von 10,5 kWp = 4,2 - die Sonnen-Spitze (6) liegt darüber und gewinnt.
    expect(gewerbe.massstab).toBeCloseTo(6, 5);
  });
});

describe('rueckblickZeilen/rueckblickSatz · das Blatt "Rückblick" (S3)', () => {
  function kind(p: Partial<RueckblickKind>): RueckblickKind {
    return { kind: 'load', model: 'load-persistence', tage: [], abweichungKwh: null, bewerteteTage: 0, ...p };
  }

  it('formt die Tage als lesbare Zeilen, älteste zuerst, wie geliefert', () => {
    const zeilen = rueckblickZeilen(
      kind({
        tage: [
          { day: '2026-11-09', erwartetKwh: 12.5, gemessenKwh: 11.1 },
          { day: '2026-11-10', erwartetKwh: 13.0, gemessenKwh: 13.8 },
        ],
      }),
    );
    expect(zeilen).toHaveLength(2);
    expect(zeilen[0]).toEqual({ tagWort: 'Mo 09.11.', erwartetKwh: 12.5, gemessenKwh: 11.1 });
    expect(zeilen[1].tagWort).toBe('Di 10.11.');
  });

  it('bleibt ohne jede Bewertung ehrlich bei "noch keine Bewertung"', () => {
    expect(rueckblickSatz(kind({ bewerteteTage: 0, abweichungKwh: null }))).toBe('Noch keine Bewertung.');
  });

  it('nennt unter zehn bewerteten Tagen den Stand, nie eine erfundene Zahl', () => {
    expect(rueckblickSatz(kind({ bewerteteTage: 4, abweichungKwh: null }))).toBe(
      'Noch keine Bewertung - erst ab 10 Tagen (bisher 4).',
    );
  });

  it('nennt ab zehn bewerteten Tagen den Rückblick-Satz - "8 von 10" ist die feste Redewendung', () => {
    expect(rueckblickSatz(kind({ bewerteteTage: 12, abweichungKwh: 1.8 }))).toBe(
      'An 8 von 10 Tagen höchstens 2 kWh daneben.',
    );
  });

  describe('gesternSatz · die Unterzeile der Rückblick-Zeile (wie im Konzeptbild)', () => {
    const rueckblick = (kinds: RueckblickKind[]) => ({ kinds });

    it('nennt den jüngsten Tag der passenden Art - Sonne mit PV, sonst Verbrauch', () => {
      const r = rueckblick([
        kind({ kind: 'pv', tage: [{ day: '2026-11-09', erwartetKwh: 259, gemessenKwh: 265 }, { day: '2026-11-10', erwartetKwh: 311, gemessenKwh: 321 }] }),
        kind({ kind: 'load', tage: [{ day: '2026-11-10', erwartetKwh: 333, gemessenKwh: 300 }] }),
      ]);
      expect(gesternSatz(r, true)).toBe('Gestern: 311 erwartet, 321 gekommen');
      expect(gesternSatz(r, false)).toBe('Gestern: 333 erwartet, 300 gekommen');
    });

    it('bleibt ohne Tage oder ohne Rückblick bei null - keine erfundene Zahl', () => {
      expect(gesternSatz(null, true)).toBeNull();
      expect(gesternSatz(rueckblick([kind({ kind: 'pv', tage: [] })]), true)).toBeNull();
      expect(gesternSatz(rueckblick([kind({ kind: 'load', tage: [] })]), true)).toBeNull();
    });
  });
});
