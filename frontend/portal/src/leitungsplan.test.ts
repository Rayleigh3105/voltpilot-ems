import { describe, expect, it } from 'vitest';
import {
  anteile,
  geometrie,
  herkunftMoment,
  knotenTexte,
  PAARE,
  satz,
  spurBild,
  verteile,
  zielAnteil,
} from './leitungsplan';

/** Die Texte setzen ein geschütztes Leerzeichen zwischen Zahl und Einheit. */
const txt = (x: unknown): unknown =>
  typeof x === 'string' ? x.replace(/[\u00a0\u202f]/g, ' ') : Array.isArray(x) ? x.map(txt) : x;

describe('Herkunft bilanziell', () => {
  it('Sonne zuerst ins Haus, dann in den Speicher', () => {
    const h = herkunftMoment({ pv: 6.6, load: 4.7, batt: 1.9, grid: 0 })!;
    expect(h['pv>load']).toBeCloseTo(4.7);
    expect(h['pv>batt']).toBeCloseTo(1.9);
    expect(h['grid>load']).toBe(0);
  });

  it('Speicher lädt aus Netz und Sonne (Marktoptimierung)', () => {
    const h = herkunftMoment({ pv: 101.3, load: 44.2, batt: 105, grid: 47.9 })!;
    expect(h['pv>load']).toBeCloseTo(44.2);
    expect(h['pv>batt']).toBeCloseTo(57.1);
    expect(h['grid>batt']).toBeCloseTo(47.9);
  });

  it('Speicher gibt ins Haus und ins Netz ab', () => {
    const h = herkunftMoment({ pv: 0, load: 15.1, batt: -150, grid: -134.9 })!;
    expect(h['batt>load']).toBeCloseTo(15.1);
    expect(h['batt>grid']).toBeCloseTo(134.9);
  });

  it('die Summe je Quelle geht nie über die Quelle hinaus', () => {
    const h = verteile(3, 10, 0, 2, 5, 0);
    expect(h['pv>load'] + h['pv>batt'] + h['pv>grid']).toBeLessThanOrEqual(3);
    expect(h['batt>load'] + h['batt>grid']).toBeLessThanOrEqual(2);
    expect(h['grid>load'] + h['grid>batt']).toBeLessThanOrEqual(5);
  });

  it('meldet der Speicher keine Leistung, wird sie nicht aus der Bilanz erfunden', () => {
    expect(herkunftMoment({ pv: 168.2, load: 148.6, batt: null, grid: 312.4 })).toBeNull();
  });

  it('fehlt Sonne, Haus oder Netz, gibt es keine Aufteilung (fehlend ist keine Null)', () => {
    expect(herkunftMoment({ pv: null, load: 3, batt: 0, grid: 3 })).toBeNull();
    expect(herkunftMoment({ pv: 1, load: null, batt: 0, grid: 3 })).toBeNull();
    expect(herkunftMoment({ pv: 1, load: 3, batt: 0, grid: null })).toBeNull();
  });
});

describe('Spuren', () => {
  const g = geometrie(330);

  it('unter dem Totband gibt es keine Spur', () => {
    const a = anteile(herkunftMoment({ pv: 0.03, load: 2, batt: 0, grid: 1.97 }), 7, 0.05);
    expect(a['pv>load']).toBe(0);
    expect(a['grid>load']).toBeGreaterThan(0);
  });

  it('Breite folgt der Leistung, die breiteste Spur ist die größte Leistung des Tages', () => {
    const a = anteile(herkunftMoment({ pv: 7, load: 7, batt: 0, grid: 0 }), 7, 0.05);
    const b = spurBild(a, g);
    expect(b.spuren).toHaveLength(1);
    expect(b.spuren[0].breite).toBe(g.maxBreite);
  });

  it('Sonne → Haus bleibt senkrecht in der Mitte', () => {
    const b = spurBild(anteile(herkunftMoment({ pv: 4, load: 4, batt: 0, grid: 0 }), 7, 0.05), g);
    expect(b.spuren[0].d).toBe(`M${g.cx},${g.sonneY}V${g.hausY}`);
  });

  it('kreuzen sich senkrechte und waagrechte Spur, bekommt die senkrechte einen hellen Rand', () => {
    const b = spurBild(anteile(herkunftMoment({ pv: 101, load: 44, batt: 105, grid: 48 }), 160, 0.05), g);
    expect(b.kreuzung).not.toBeNull();
    const ohne = spurBild(anteile(herkunftMoment({ pv: 4, load: 4, batt: 0, grid: 0 }), 7, 0.05), g);
    expect(ohne.kreuzung).toBeNull();
  });

  it('Pfade laufen von der Quelle zum Ziel', () => {
    const b = spurBild(anteile(herkunftMoment({ pv: 0, load: 3, batt: -1, grid: 2 }), 7, 0.05), g);
    const bl = b.spuren.find((s) => s.paar === 'batt>load')!;
    expect(bl.d.startsWith(`M${g.speicherX},`)).toBe(true);
    expect(bl.d.endsWith(`V${g.hausY}`)).toBe(true);
    const gl = b.spuren.find((s) => s.paar === 'grid>load')!;
    expect(gl.d.startsWith(`M${g.netzX},`)).toBe(true);
  });

  it('dünne Spuren tragen keine Punkte (sie sähen wie eine Planlinie aus)', () => {
    const b = spurBild(anteile(herkunftMoment({ pv: 0.2, load: 7, batt: 0, grid: 6.8 }), 7, 0.05), g);
    expect(b.spuren.find((s) => s.paar === 'pv>load')!.punkte).toBe(false);
    expect(b.spuren.find((s) => s.paar === 'grid>load')!.punkte).toBe(true);
  });

  it('drei Stufen: eng, Telefon, breit', () => {
    expect(geometrie(260).stufe).toBe('eng');
    expect(geometrie(330).stufe).toBe('telefon');
    expect(geometrie(700).stufe).toBe('breit');
  });

  it('alle sieben Wege haben einen Pfad', () => {
    const a = Object.fromEntries(PAARE.map((p) => [p, 0.3])) as Record<(typeof PAARE)[number], number>;
    expect(spurBild(a, g).spuren).toHaveLength(7);
  });
});

describe('Beschriftung in Worten', () => {
  it('Richtung als Wort, nie als Minus', () => {
    const t = knotenTexte({ ansicht: 'jetzt', zeit: 'live', werte: { pv: 0, load: 3, batt: -2.2, grid: -1.2 }, socPct: 64 });
    expect(txt(t.batt.zeilen[0])).toBe('entlädt 2,2 kW');
    expect(txt(t.grid.wert)).toBe('1,2 kW');
    expect(t.grid.zeilen[0]).toBe('Einspeisung');
    expect(JSON.stringify(t)).not.toMatch(/−|-\d/);
  });

  it('fehlende Werte stehen als „—“, nie als 0', () => {
    const t = knotenTexte({ ansicht: 'jetzt', zeit: 'live', werte: { pv: null, load: null, batt: null, grid: null }, socPct: null });
    expect(t.pv.wert).toBe('—');
    expect(t.batt.wert).toBe('—');
    expect(txt(t.grid.wert)).toBe('—');
  });

  it('Plan heißt „erwartet“ bzw. „· Plan“', () => {
    const t = knotenTexte({ ansicht: 'jetzt', zeit: 'plan', werte: { pv: 0, load: 2, batt: -2, grid: 0 }, socPct: 78 });
    expect(t.pv.zeilen[0]).toBe('keine Erzeugung erwartet');
    expect(txt(t.batt.zeilen[0])).toBe('entlädt 2,0 kW · Plan');
  });

  it('Heute zeigt Energie in beide Richtungen', () => {
    const t = knotenTexte({
      ansicht: 'heute', zeit: 'gemessen', werte: { pv: 24.8, load: 22.5, batt: null, grid: null }, socPct: 65,
      energie: { pv: 24.8, load: 22.5, laden: 9.1, abgeben: 1.5, bezug: 5.8, einspeisung: 0.6 },
    });
    expect(txt(t.batt.zeilen)).toEqual(['geladen 9,1 kWh', 'abgegeben 1,5 kWh']);
    expect(txt(t.grid.wert)).toBe('5,8 kWh');
  });

  it('Lastspitzenkappung: Ziel am Netz und Skala', () => {
    const t = knotenTexte({ ansicht: 'jetzt', zeit: 'live', werte: { pv: 73.6, load: 376, batt: -2.7, grid: 300 }, socPct: 80, zielKw: 300 });
    expect(txt(t.grid.zeilen)).toContain('Ziel 300,0 kW');
    expect(zielAnteil(300, 300)).toBe(1);
    expect(zielAnteil(null, 300)).toBeNull();
  });
});

describe('Der Satz', () => {
  it('Eigenverbrauch mittags', () => {
    const w = { pv: 6.6, load: 4.7, batt: 1.9, grid: 0 };
    expect(txt(satz({ betrieb: 'eigenverbrauch', ansicht: 'jetzt', zeit: 'live', werte: w, herkunft: herkunftMoment(w), uhr: '13:52' })))
      .toBe('Die Sonne deckt den ganzen Verbrauch. Der Überschuss geht in den Speicher.');
  });

  it('Marktoptimierung nennt Herkunft und Preis', () => {
    const w = { pv: 101.3, load: 44.2, batt: 105, grid: 47.9 };
    expect(txt(satz({ betrieb: 'markt', ansicht: 'jetzt', zeit: 'live', werte: w, herkunft: herkunftMoment(w), uhr: '13:52', preisCt: 1.4 })))
      .toBe('Der Speicher lädt mit 105,0 kW aus Netz und Sonne. Börsenpreis 1,4 ct/kWh.');
  });

  it('ohne vollständige Messung kein Satz', () => {
    const w = { pv: null, load: 3, batt: 0, grid: 3 };
    expect(txt(satz({ betrieb: 'eigenverbrauch', ansicht: 'jetzt', zeit: 'live', werte: w, herkunft: null, uhr: '13:52' }))).toBeNull();
  });
});
