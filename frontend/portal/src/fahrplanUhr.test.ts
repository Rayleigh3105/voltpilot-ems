import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import {
  UHR_C,
  UHR_R,
  socRadius,
  uhrModell,
  uhrPunkt,
  uhrRing,
  uhrzeitAus,
} from './fahrplanUhr';

const TAG = new Date(2026, 8, 24);
const JETZT = new Date(2026, 8, 24, 14, 10);

function viertel(i: number, over: Partial<TagSlot> = {}): TagSlot {
  return {
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: 28,
    importPriceCtKwh: 30,
    exportValueCtKwh: 8,
    pvKw: 0,
    loadKw: 0.5,
    ...over,
  };
}

function tag(laeufe: [string, number][], over: (i: number) => Partial<TagSlot> = () => ({})): TagSlot[] {
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) out.push(viertel(out.length, { slotRole: rolle, ...over(out.length) }));
  }
  return out;
}

const LAUF: [string, number][] = [
  ['warten', 23],
  ['eigenverbrauch', 17],
  ['warten', 14],
  ['guenstig_laden', 4],
  ['pv_speichern', 12],
  ['eigenverbrauch', 26],
];

function modell(over: (i: number) => Partial<TagSlot> = () => ({}), now = JETZT) {
  return uhrModell(tagModell({ slots: tag(LAUF, over), slotMinutes: 15, now, plantKind: 'eigenverbrauch', tag: TAG }));
}

describe('Uhr-Geometrie · ein Tag ist ein Kreis', () => {
  it('legt Mitternacht nach unten, Mittag nach oben, 6 Uhr links, 18 Uhr rechts', () => {
    const nah = (a: { x: number; y: number }, x: number, y: number) => {
      expect(a.x).toBeCloseTo(x, 5);
      expect(a.y).toBeCloseTo(y, 5);
    };
    nah(uhrPunkt(100, 0), UHR_C, UHR_C + 100);
    nah(uhrPunkt(100, 720), UHR_C, UHR_C - 100);
    nah(uhrPunkt(100, 360), UHR_C - 100, UHR_C);
    nah(uhrPunkt(100, 1080), UHR_C + 100, UHR_C);
  });

  it('liest aus einer Zeigerposition die Uhrzeit und den Abstand zur Mitte zurück', () => {
    for (const minute of [0, 90, 360, 725, 1000, 1435]) {
      const p = uhrPunkt(150, minute);
      const r = uhrzeitAus(p.x - UHR_C, p.y - UHR_C);
      expect(r.minute).toBeCloseTo(minute, 5);
      expect(r.abstand).toBeCloseTo(150, 5);
    }
  });

  it('zeichnet einen ganzen Tag als zwei Halbbögen (ein SVG-Bogen kann keinen Vollkreis)', () => {
    expect(uhrRing(10, 20, 0, 1440).match(/M/g)).toHaveLength(2);
    expect(uhrRing(10, 20, 0, 60).match(/M/g)).toHaveLength(1);
  });

  it('bildet den Ladestand zwischen innerem und äußerem Rand ab', () => {
    expect(socRadius(0)).toBe(UHR_R.soc0);
    expect(socRadius(100)).toBe(UHR_R.soc1);
    expect(socRadius(140)).toBe(UHR_R.soc1);
  });
});

describe('uhrModell · was die Uhr zeichnet', () => {
  it('teilt die laufende Phase am Jetzt: vorne gedämpft, hinten kräftig', () => {
    const m = modell();
    const laufend = m.phasen.filter((p) => p.role === 'guenstig_laden');
    expect(laufend.map((p) => p.vorbei)).toEqual([true, false]);
    expect(m.phasen.filter((p) => p.role === 'pv_speichern').every((p) => !p.vorbei)).toBe(true);
    expect(m.phasen.find((p) => p.role === 'eigenverbrauch')?.vorbei).toBe(true);
  });

  it('gibt nur Phasen ab 45 Minuten ein Symbol - kürzer ist der Bogen schmaler als das Symbol', () => {
    const m = modell();
    // 4 Viertelstunden „Günstig laden" = 60 min → mit Symbol; alle anderen sind länger.
    expect(m.symbole.map((s) => s.role)).toEqual(['warten', 'eigenverbrauch', 'warten', 'guenstig_laden', 'pv_speichern', 'eigenverbrauch']);
    const kurz = uhrModell(tagModell({ slots: tag([['warten', 60], ['guenstig_laden', 2], ['eigenverbrauch', 34]]), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' }));
    expect(kurz.symbole.some((s) => s.role === 'guenstig_laden')).toBe(false);
  });

  it('färbt den Preisring von günstig bis teuer und markiert beide Enden', () => {
    const m = modell((i) => ({ importPriceCtKwh: i === 57 ? 19.3 : i === 78 ? 50.3 : 30 }));
    expect(m.preis[57].stufe).toBe(0);
    expect(m.preis[78].stufe).toBe(1);
    expect(m.preisMarken.map((p) => [p.art, p.ct])).toEqual([
      ['min', 19.3],
      ['max', 50.3],
    ]);
  });

  it('zeichnet gemessene Sonne nur für Vergangenes, erwartete für den ganzen Tag', () => {
    const m = modell((i) => ({ pvKw: i >= 30 && i < 76 ? 2 : 0, measuredPvKw: i >= 30 && i < 76 ? 1.5 : null }));
    const gemessen = m.strahlen.filter((s) => s.gemessen).length;
    const erwartet = m.strahlen.filter((s) => !s.gemessen).length;
    // 30..56 sind vorbei oder laufen (27 Viertelstunden), erwartet sind alle 46.
    expect(gemessen).toBe(27);
    expect(erwartet).toBe(46);
  });

  it('beschriftet alle drei Stunden, markiert jetzt - und an einem anderen Tag nicht', () => {
    const m = modell();
    expect(m.stunden).toHaveLength(24);
    expect(m.stunden.filter((s) => s.text).map((s) => s.text)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21']);
    expect(m.jetzt).not.toBeNull();
    expect(m.ladestand).not.toBeNull();
    expect(modell(() => ({}), new Date(2026, 8, 23, 20, 0)).jetzt).toBeNull();
  });

  it('zeichnet ohne Ladestand keine Fläche statt einer erfundenen', () => {
    expect(modell(() => ({ socPct: null })).ladestand).toBeNull();
  });
});
