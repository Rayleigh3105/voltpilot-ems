import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket, SchedulePlan, ScheduleSlot } from './api';
import { energieBis, hoechsterBezug, tagAus, tagesSkala, uhrzeit, viertelProTag } from './tagesleiste';

const now = new Date(2026, 8, 29, 13, 52);
const mitternacht = new Date(2026, 8, 29, 0, 0).getTime();
const iso = (i: number) => new Date(mitternacht + i * 15 * 60000).toISOString();

function bucket(i: number, p: Partial<HistoryBucket>): HistoryBucket {
  return {
    start: iso(i), pvKwh: 0, loadKwh: 0, gridImportKwh: 0, gridExportKwh: 0, batteryChargeKwh: 0, batteryDischargeKwh: 0,
    socMinPct: null, socMaxPct: null, socLastPct: null, priceEurMwh: null, costEur: null, ...p,
  };
}
function history(buckets: HistoryBucket[]): History {
  return {
    range: 'day', from: iso(0), to: iso(96), bucketMinutes: 15, buckets,
    totals: {} as History['totals'], protocol: [], plan: [],
  };
}
function slot(i: number, p: Partial<ScheduleSlot>): ScheduleSlot {
  return { start: iso(i), batteryKw: 0, gridKw: 0, socPct: 50, priceEurMwh: null, slotRole: 'warten', pvKw: 0, loadKw: 0, ...p } as ScheduleSlot;
}

describe('Tagesleiste', () => {
  it('ein normaler Tag hat 96 Viertelstunden, jetzt liegt in der richtigen', () => {
    const t = tagAus(null, null, now);
    expect(t.viertel).toHaveLength(viertelProTag(now));
    expect(uhrzeit(t.viertel[t.jetzt].start)).toBe('13:45');
  });

  it('Messung wird zu mittlerer Leistung, Richtung als Vorzeichen', () => {
    const t = tagAus(history([bucket(28, { loadKwh: 0.7, gridImportKwh: 0.7 })]), null, now);
    expect(t.viertel[28].gemessen).toEqual({ pv: 0, load: 2.8, batt: 0, grid: 2.8 });
  });

  it('ohne Eimer bleibt die Viertelstunde leer, nie 0', () => {
    const t = tagAus(history([]), null, now);
    expect(t.viertel[10].gemessen).toBeNull();
  });

  it('der Plan trägt Tätigkeit, Preis und Leistung', () => {
    const p = { slotMinutes: 15, slots: [slot(76, { batteryKw: -150, gridKw: -135, loadKw: 15, slotRole: 'verkaufen', priceEurMwh: 242 })] } as SchedulePlan;
    const v = tagAus(null, p, now).viertel[76];
    expect(v.rolle).toBe('verkaufen');
    expect(v.planPreisCt).toBeCloseTo(24.2);
    expect(v.plan?.batt).toBe(-150);
  });

  it('Energie bis jetzt summiert Richtungen und Herkunft', () => {
    const h = history([
      bucket(0, { loadKwh: 0.5, gridImportKwh: 0.5 }),
      bucket(50, { pvKwh: 1.5, loadKwh: 1, batteryChargeKwh: 0.5 }),
    ]);
    const e = energieBis(tagAus(h, null, now), 55);
    expect(e.energie.bezug).toBeCloseTo(0.5);
    expect(e.energie.laden).toBeCloseTo(0.5);
    expect(e.herkunft['pv>batt']).toBeCloseTo(0.5);
    expect(e.herkunft['grid>load']).toBeCloseTo(0.5);
    expect(e.unvollstaendig).toBe(true);
    expect(tagesSkala(e)).toBeCloseTo(1.5);
  });

  it('höchster Netzbezug einer Viertelstunde', () => {
    const t = tagAus(history([bucket(24, { gridImportKwh: 75, loadKwh: 75 })]), null, now);
    expect(hoechsterBezug(t, 55)).toBe(300);
  });
});
