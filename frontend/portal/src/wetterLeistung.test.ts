import { describe, expect, it } from 'vitest';
import {
  BEDECKT_MIN_PCT,
  MIN_BLOCK_STUNDEN,
  SONNIG_MAX_PCT,
  besteStunde,
  erwarteteLeistung,
  himmelBloecke,
  type PlanPvSlot,
  type WetterPunkt,
} from './wetterLeistung';
import { CLOUDY_MIN_CLOUD, SUNNY_MAX_CLOUD } from './weather';

/** Lokale Stunden-Punkte ab `tag` 00:00 - die Fläche spricht Lokalzeit. */
function stunden(tag: Date, n: number, wolken: (h: number) => number | null): WetterPunkt[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), i, 0, 0, 0);
    return { ts: d.toISOString(), cloudCoverPct: wolken(i % 24), temperatureC: 10 + (i % 24) / 2 };
  });
}

/** Viertelstunden-Plan-Slots mit einer PV-Glocke je Tag. */
function planSlots(tag: Date, stundenAnzahl: number, spitze = 12): PlanPvSlot[] {
  const out: PlanPvSlot[] = [];
  for (let i = 0; i < stundenAnzahl * 4; i++) {
    const d = new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), 0, 0, 0, 0);
    const t = new Date(d.getTime() + i * 900_000);
    const h = t.getHours() + t.getMinutes() / 60;
    const kw = h >= 7 && h <= 19 ? Math.max(0, spitze * Math.sin(((h - 7) / 12) * Math.PI)) : 0;
    out.push({ start: t.toISOString(), pvKw: Number(kw.toFixed(3)) });
  }
  return out;
}

const HEUTE = new Date(2026, 7, 10, 8, 15, 0, 0);

describe('erwarteteLeistung · die Prognose kommt aus dem FAHRPLAN, nichts wird umgerechnet', () => {
  it('mittelt die Plan-Viertelstunden auf das Stundenraster der Vorhersage', () => {
    const punkte = stunden(HEUTE, 24, () => 20);
    const slots: PlanPvSlot[] = [
      { start: new Date(2026, 7, 10, 12, 0).toISOString(), pvKw: 10 },
      { start: new Date(2026, 7, 10, 12, 15).toISOString(), pvKw: 12 },
      { start: new Date(2026, 7, 10, 12, 30).toISOString(), pvKw: 14 },
      { start: new Date(2026, 7, 10, 12, 45).toISOString(), pvKw: 16 },
    ];
    const kw = erwarteteLeistung(punkte, slots);
    expect(kw[12]).toBe(13);
    // Eine Stunde ohne einen einzigen Plan-Wert bleibt LUECKE, nie 0.
    expect(kw[11]).toBeNull();
    expect(kw[13]).toBeNull();
  });

  it('lässt die Linie enden, wo der Plan-Horizont endet', () => {
    const punkte = stunden(HEUTE, 60, () => 20);
    const kw = erwarteteLeistung(punkte, planSlots(HEUTE, 24));
    expect(kw.slice(0, 24).some((v) => v != null)).toBe(true);
    expect(kw.slice(24).every((v) => v == null)).toBe(true);
  });

  it('behauptet ohne Plan gar nichts', () => {
    const punkte = stunden(HEUTE, 24, () => 20);
    expect(erwarteteLeistung(punkte, []).every((v) => v == null)).toBe(true);
    expect(erwarteteLeistung([], planSlots(HEUTE, 24))).toEqual([]);
  });

  it('ignoriert Plan-Slots ohne Wert, statt sie als 0 zu mitteln', () => {
    const punkte = stunden(HEUTE, 24, () => 20);
    const slots: PlanPvSlot[] = [
      { start: new Date(2026, 7, 10, 9, 0).toISOString(), pvKw: 8 },
      { start: new Date(2026, 7, 10, 9, 15).toISOString(), pvKw: null },
    ];
    expect(erwarteteLeistung(punkte, slots)[9]).toBe(8);
  });
});

describe('himmelBloecke · benannt statt Wisch (K10)', () => {
  it('teilt nach DENSELBEN Schwellen wie der PV-Satz', () => {
    expect(SONNIG_MAX_PCT).toBe(SUNNY_MAX_CLOUD);
    expect(BEDECKT_MIN_PCT).toBe(CLOUDY_MIN_CLOUD);
  });

  it('fasst zusammenhängende Stunden zu EINEM benannten Block', () => {
    const punkte = stunden(HEUTE, 12, (h) => (h < 4 ? 10 : h < 8 ? 50 : 90));
    const b = himmelBloecke(punkte);
    expect(b.map((x) => x.art)).toEqual(['sonnig', 'wechselnd', 'bedeckt']);
    expect(b.map((x) => x.wort)).toEqual(['sonnig', 'wechselnd', 'bedeckt']);
    expect(b[0]).toMatchObject({ von: 0, bis: 3 });
    expect(b.reduce((s, x) => s + x.anteil, 0)).toBeCloseTo(1, 6);
  });

  it(`verschmilzt Blöcke unter ${MIN_BLOCK_STUNDEN} Stunden - kein Konfetti`, () => {
    const punkte = stunden(HEUTE, 8, (h) => (h === 3 ? 90 : 10));
    const b = himmelBloecke(punkte);
    expect(b).toHaveLength(1);
    expect(b[0].art).toBe('sonnig');
  });

  it('lässt eine Lücke den laufenden Block erben, statt sie zu behaupten', () => {
    const punkte = stunden(HEUTE, 8, (h) => (h === 3 ? null : 10));
    const b = himmelBloecke(punkte);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ von: 0, bis: 7 });
  });

  it('zeichnet ohne Bewölkungsdaten GAR KEINEN Streifen', () => {
    expect(himmelBloecke(stunden(HEUTE, 8, () => null))).toEqual([]);
    expect(himmelBloecke([])).toEqual([]);
  });
});

describe('besteStunde · eine Ansage, kein Rückblick (K6)', () => {
  it('markiert die stärkste KOMMENDE Stunde mit Wort und Zahl', () => {
    const punkte = stunden(HEUTE, 48, () => 20);
    const kw = erwarteteLeistung(punkte, planSlots(HEUTE, 48));
    const m = besteStunde(punkte, kw, HEUTE);
    expect(m).toBeTruthy();
    expect(new Date(punkte[m!.index].ts).getTime()).toBeGreaterThanOrEqual(HEUTE.getTime());
    expect(m!.text).toMatch(/^beste Stunde (heute|morgen|\w+) · \d+,\d kW$/);
  });

  it('markiert eine vergangene Spitze NICHT', () => {
    const punkte = stunden(HEUTE, 24, () => 20);
    const kw = punkte.map((_, i) => (i === 2 ? 30 : i === 14 ? 5 : null));
    expect(besteStunde(punkte, kw, HEUTE)?.index).toBe(14);
  });

  it('markiert ohne kommende Leistung gar nichts', () => {
    const punkte = stunden(HEUTE, 24, () => 20);
    expect(besteStunde(punkte, punkte.map(() => null), HEUTE)).toBeNull();
    expect(besteStunde(punkte, punkte.map(() => 0), HEUTE)).toBeNull();
  });
});
