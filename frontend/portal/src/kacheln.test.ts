import { describe, expect, it } from 'vitest';
import type { History, HistoryTotals, SchedulePlan, ScheduleSlot } from './api';
import {
  autarkieKachel,
  eigenverbrauchKachel,
  fahrplanKachel,
  handelKachel,
  heuteKachel,
  naechsteSchritte,
  netzKachel,
  speicherAusblick,
  speicherKachel,
  steuerSpalten,
} from './kacheln';
import { tagAus } from './tagesleiste';

/** Die Texte setzen ein geschütztes Leerzeichen zwischen Zahl und Einheit. */
const txt = (x: string | null | undefined) => (x ?? '').replace(/[  ]/g, ' ');

const NOW = new Date(2026, 8, 10, 12, 0, 0);
const MITTERNACHT = new Date(2026, 8, 10, 0, 0, 0).getTime();
const iso = (i: number) => new Date(MITTERNACHT + i * 15 * 60 * 1000).toISOString();

function slot(i: number, over: Partial<ScheduleSlot>): ScheduleSlot {
  return {
    start: iso(i),
    batteryKw: 0,
    pvKw: 0,
    loadKw: 1,
    gridKw: 1,
    socPct: 50,
    priceEurMwh: 100,
    slotRole: 'warten',
    ...over,
  } as ScheduleSlot;
}

/** Ein Tag: 10–15 Uhr Sonne speichern, 18–21 Uhr Verbrauch decken, sonst warten. */
function plan(): SchedulePlan {
  const slots = Array.from({ length: 96 }, (_, i) => {
    const h = i / 4;
    if (h >= 10 && h < 15) return slot(i, { batteryKw: 2, pvKw: 5, socPct: Math.min(100, 40 + (h - 10) * 15), slotRole: 'pv_speichern' });
    if (h >= 18 && h < 21) return slot(i, { batteryKw: -2, socPct: 90 - (h - 18) * 20, slotRole: 'eigenverbrauch' });
    return slot(i, { pvKw: h > 6 && h < 20 ? 2 : 0, socPct: h < 10 ? 40 : h < 18 ? 100 : 30 });
  });
  return { slotMinutes: 15, slots } as unknown as SchedulePlan;
}

function history(): History {
  const buckets = Array.from({ length: 48 }, (_, i) => ({
    start: iso(i),
    pvKwh: i >= 28 ? 1 : 0,
    loadKwh: 0.5,
    gridImportKwh: i < 28 ? 0.5 : 0,
    gridExportKwh: i >= 40 ? 0.2 : 0,
    batteryChargeKwh: i >= 40 ? 0.3 : 0,
    batteryDischargeKwh: 0,
    socLastPct: 50,
    priceEurMwh: 80,
  }));
  return { bucketMinutes: 15, buckets } as unknown as History;
}

const TOTALS = {
  consumptionKwh: 24,
  pvGenerationKwh: 20,
  gridImportKwh: 14,
  gridExportKwh: 1.6,
  autarkiePct: 41.7,
  eigenverbrauchPct: 92,
} as unknown as HistoryTotals;

describe('Autarkie und Eigenverbrauch rechnen wie der Verlauf', () => {
  it('die Kennzahl ist die des Servers, der eigene Teil verteilt sich bilanziell', () => {
    const tag = tagAus(history(), plan(), NOW);
    const a = autarkieKachel(TOTALS, tag)!;
    expect(a.pct).toBe(41.7);
    const summe = a.teile.reduce((s, t) => s + t.pct, 0);
    expect(summe).toBeCloseTo(100);
    expect(a.teile.find((t) => t.key === 'grid')!.pct).toBeCloseTo(58.3);
    const e = eigenverbrauchKachel(TOTALS, tag)!;
    expect(e.pct).toBe(92);
    expect(e.teile.map((t) => t.key)).toEqual(['load', 'batt', 'grid']);
    expect(e.einspeisungKwh).toBe(1.6);
  });

  it('ohne Kennzahl keine Kachel (fehlend ist keine Null)', () => {
    expect(autarkieKachel({ ...TOTALS, autarkiePct: null } as HistoryTotals, null)).toBeNull();
    expect(eigenverbrauchKachel(null, null)).toBeNull();
    expect(netzKachel({ ...TOTALS, gridExportKwh: null } as HistoryTotals)).toBeNull();
    expect(netzKachel(TOTALS)).toEqual({ bezug: 14, einspeisung: 1.6 });
  });
});

describe('Der Plan in Worten', () => {
  const tag = tagAus(history(), plan(), NOW);

  it('nennt die nächsten Wechsel der Tätigkeit', () => {
    const s = naechsteSchritte(tag, 'eigenverbrauch', 3);
    expect(s.map((x) => x.ab)).toEqual(['15:00', '18:00', '21:00']);
  });

  it('sagt, wann der Speicher laut Plan voll ist - mit Plan-Angabe', () => {
    expect(speicherAusblick(tag, 'eigenverbrauch')).toBe('Voll gegen 15:00 (erwartet)');
    const k = speicherKachel(tag, 'eigenverbrauch', 64, 2)!;
    expect(k.laedt).toBe(true);
    expect(k.naechster?.ab).toBe('15:00');
  });

  it('die Tagesuhr trägt jede Viertelstunde und nur Rollen, die mehr als einmal vorkommen, in der Legende', () => {
    const f = fahrplanKachel(tag, 'eigenverbrauch')!;
    expect(f.ring).toHaveLength(96);
    expect(f.ring[tag.jetzt + 1].spaeter).toBe(true);
    expect(f.legende.map((l) => l.rolle).sort()).toEqual(['eigenverbrauch', 'pv_speichern', 'warten']);
  });

  it('ohne Plan: der Speicher zeigt nur, was gemessen ist; ohne Ladestand und Plan keine Kachel', () => {
    const leer = tagAus(history(), null, NOW);
    const k = speicherKachel(leer, 'eigenverbrauch', 50, -1.2)!;
    expect(k.taetigkeit).toBeNull();
    expect(k.ausblick).toBeNull();
    expect(txt(k.zustand)).toBe('entlädt 1,2 kW');
    expect(speicherKachel(leer, 'eigenverbrauch', null, null)).toBeNull();
    expect(speicherKachel(tag, 'eigenverbrauch', 64, null)!.zustand).toBe('ohne Leistungsmessung');
    expect(fahrplanKachel(leer, 'eigenverbrauch')).toBeNull();
  });
});

describe('Handel', () => {
  it('Fenster mit Energie, Ø-Preis und Stand', () => {
    const p = plan();
    p.slots.forEach((s, i) => {
      const h = i / 4;
      if (h >= 2 && h < 4) Object.assign(s, { slotRole: 'guenstig_laden', batteryKw: 4, priceEurMwh: 20 });
      if (h >= 19 && h < 20) Object.assign(s, { slotRole: 'verkaufen', batteryKw: -4, priceEurMwh: 300 });
    });
    const h = handelKachel(tagAus(null, p, NOW), 'direktvermarktung')!;
    expect(h.fenster).toHaveLength(2);
    expect(h.fenster[0]).toMatchObject({ von: '02:00', bis: '04:00', art: 'laden', stand: 'erledigt' });
    expect(h.fenster[0].kwh).toBeCloseTo(8);
    expect(h.fenster[0].preisCt).toBeCloseTo(2);
    expect(h.fenster[1]).toMatchObject({ von: '19:00', bis: '20:00', art: 'verkaufen', stand: 'geplant' });
    expect(h.spanneCt).toBeCloseTo(28);
  });

  it('ohne Lade- oder Verkaufsfenster keine Kachel', () => {
    expect(handelKachel(tagAus(null, plan(), NOW), 'eigenverbrauch')).toBeNull();
  });
});

describe('Heute (Konzept vp-cockpit-privat-konzept, E1 = A)', () => {
  const summe = (t: { kwh: number }[]) => t.reduce((x, y) => x + y.kwh, 0);

  it('zeigt die Autarkie des Servers und die kWh, aus denen sie entsteht', () => {
    const h = heuteKachel(TOTALS, tagAus(history(), plan(), NOW), true)!;
    expect(h.autarkiePct).toBe(41.7);
    expect(h.eigenverbrauchPct).toBe(92);
    expect(h.verbrauchtKwh).toBe(24);
    // Woher: Sonne (Viertelstunden ab 7 Uhr) und Netz (davor); kein Speicher-Anteil ohne Entladung.
    expect(h.herkunft.map((t) => [t.key, t.label])).toEqual([['pv', 'Sonne'], ['grid', 'Netz']]);
    expect(summe(h.herkunft)).toBeCloseTo(24, 6);
    // Wohin: ins Haus, in den Speicher, ins Netz - und mittags der noch erwartete Rest des Plans.
    expect(h.sonne.map((t) => t.key)).toEqual(['load', 'batt', 'grid', 'plan']);
    expect(h.sonne.find((t) => t.key === 'batt')?.kwh).toBeCloseTo(2.4, 6);
    expect(h.sonne.find((t) => t.key === 'grid')?.kwh).toBeCloseTo(1.6, 6);
    expect(h.sonne.find((t) => t.key === 'plan')?.label).toBe('noch erwartet');
  });

  it('ohne Speicher-Messung rechnet er aus den Tagessummen: was nicht bezogen wurde, kam von der Sonne', () => {
    const ohne = history();
    for (const b of ohne.buckets) Object.assign(b, { batteryChargeKwh: null, batteryDischargeKwh: null });
    const tag = tagAus(ohne, null, NOW);
    const h = heuteKachel(TOTALS, tag, false)!;
    expect(h.herkunft).toEqual([
      { key: 'pv', label: 'Sonne', kwh: 10 },
      { key: 'grid', label: 'Netz', kwh: 14 },
    ]);
    expect(h.sonne).toEqual([
      { key: 'load', label: 'im Haus', kwh: 18.4 },
      { key: 'grid', label: 'ins Netz', kwh: 1.6 },
    ]);
    // Mit Speicher, aber ohne Herkunft je Viertelstunde, wird nichts erfunden: „selbst“.
    expect(heuteKachel(TOTALS, tag, true)!.herkunft[0].label).toBe('selbst');
  });

  it('nach Sonnenuntergang kein „noch erwartet“, ohne Verbrauch kein Block (fehlend ist keine Null)', () => {
    const abends = new Date(2026, 8, 10, 21, 0, 0);
    const h = heuteKachel(TOTALS, tagAus(history(), plan(), abends), true)!;
    expect(h.sonne.some((t) => t.key === 'plan')).toBe(false);
    expect(heuteKachel({ ...TOTALS, consumptionKwh: null } as unknown as HistoryTotals, null, false)).toBeNull();
  });

  it('ohne Erzeugung gibt es keinen zweiten Balken und keinen Eigenverbrauch', () => {
    const h = heuteKachel({ ...TOTALS, pvGenerationKwh: 0, gridExportKwh: 0 } as unknown as HistoryTotals, null, false)!;
    expect(h.erzeugtKwh).toBeNull();
    expect(h.sonne).toEqual([]);
    expect(h.eigenverbrauchPct).toBeNull();
  });
});

// Die Kachel "Prognose" (ehemals "Sonne") liest seit `vp-prognosen-konzept`
// direkt `prognoseModell()` - ihre Ableitung ist in `prognoseSeite.test.ts`
// geprüft, nicht hier.

describe('Die Steuerzeile: Auftrag, Gerät und Wirkung getrennt', () => {
  const basis = {
    commandedKw: 2.2,
    confirmedKw: 2.2,
    allMatch: true,
    checkedAt: new Date(2026, 8, 10, 11, 58).toISOString(),
    stale: false,
    automatik: false,
    gemessenKw: 2.1,
  };

  it('wie beauftragt: die Wirkung wiederholt die Zahl des Speicher-Knotens nicht', () => {
    const s = steuerSpalten(basis);
    expect(s.map((x) => txt(x.text))).toEqual(['Speicher laden 2,2 kW', 'bestätigt 11:58', 'wie beauftragt gemessen']);
  });

  it('weicht die Wirkung ab, steht die gemessene Leistung mit Richtung als Wort da', () => {
    const s = steuerSpalten({ ...basis, gemessenKw: -0.5 });
    expect(txt(s[2].text)).toBe('entlädt 0,5 kW gemessen');
    expect(s[2].ton).toBe('warn');
  });

  it('veraltet und abweichend sagen es in der Gerät-Spalte', () => {
    expect(steuerSpalten({ ...basis, stale: true })[1].text).toBe('zuletzt bestätigt 11:58');
    expect(txt(steuerSpalten({ ...basis, allMatch: false, confirmedKw: 0 })[1].text)).toBe('meldet pausieren');
    expect(steuerSpalten({ ...basis, gemessenKw: null })[2].text).toBe('nicht gemessen');
  });
});
