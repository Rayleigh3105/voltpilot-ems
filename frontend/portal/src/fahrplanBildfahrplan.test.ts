import { describe, expect, it } from 'vitest';
import { NBSP } from './format';
import { BILD_LINKS, BILD_RECHTS, bildGeometrie, bildModell, energieFluss } from './fahrplanBildfahrplan';
import { tagModell, type TagSlot } from './fahrplanTag';

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

describe('bildGeometrie · Zeit nach rechts, Ladestand nach oben', () => {
  const g = bildGeometrie(984);

  it('spannt den Tag zwischen Beschriftungsspalte und rechtem Rand auf', () => {
    expect(g.x(0)).toBe(BILD_LINKS);
    expect(g.x(1440)).toBe(984 - BILD_RECHTS);
    expect(g.minuteBei(g.x(600))).toBeCloseTo(600, 6);
    expect(g.minuteBei(20)).toBeNull();
  });

  it('legt „leer" nach unten und „voll" nach oben', () => {
    expect(g.y(0)).toBe(g.ladestand[1]);
    expect(g.y(100)).toBe(g.ladestand[0]);
    expect(g.y(50)).toBeCloseTo((g.ladestand[0] + g.ladestand[1]) / 2);
  });

  it('lässt die Preisspur samt Lücke weg, wenn kein Preis den Plan treibt', () => {
    const ohne = bildGeometrie(984, false);
    expect(ohne.preis[1] - ohne.preis[0]).toBe(0);
    expect(ohne.sonne[0]).toBe(g.preis[0]);
    expect(g.hoehe - ohne.hoehe).toBe(g.sonne[0] - g.preis[0]);
  });
});

describe('bildModell · die Spuren des Tages', () => {
  const g = bildGeometrie(984);
  const modell = (over: (i: number) => Partial<TagSlot> = () => ({}), laeufe = LAUF) =>
    bildModell(tagModell({ slots: tag(laeufe, over), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' }), g);

  it('zeichnet je Viertelstunde einen Preisbalken ab null, beschriftet günstigste und teuerste', () => {
    const m = modell((i) => ({ importPriceCtKwh: i === 57 ? 19.3 : i === 78 ? 50.3 : 30 }));
    expect(m.preis).toHaveLength(96);
    expect(m.preisNull).toBeNull();
    expect(m.preisMarken.map((p) => [p.art, p.ct])).toEqual([
      ['min', 19.3],
      ['max', 50.3],
    ]);
    const hoch = m.preis[78].h;
    const tief = m.preis[57].h;
    expect(hoch / tief).toBeCloseTo(50.3 / 19.3, 1);
  });

  it('zieht die Null-Linie ein, sobald der Börsenpreis darunter fällt', () => {
    const m = modell((i) => ({ importPriceCtKwh: null, priceEurMwh: i === 60 ? -12 : 80 }));
    expect(m.preisNull).not.toBeNull();
    const negativ = m.preis.find((b) => b.i === 60)!;
    expect(negativ.y).toBeCloseTo(m.preisNull!, 5);
  });

  it('misst Sonne und Verbrauch nur für Vergangenes und lässt die Prognose dort weg', () => {
    const m = modell((i) => ({
      pvKw: i >= 30 && i < 76 ? 2 : 0,
      measuredPvKw: i < 57 ? (i >= 30 ? 1.5 : 0) : 9,
      measuredLoadKw: i < 57 ? 0.6 : 9,
    }));
    expect(m.sonneGemessen).not.toBeNull();
    expect(m.verbrauchGemessen).not.toBeNull();
    // Eine „Messung" in der Zukunft (9 kW ab 14:15) wird nie gezeichnet: die
    // Spitze ist die Prognose von 2 kW, nicht 9.
    expect(m.sonneSpitze?.kw).toBe(2);
    expect(m.sonneSpitze?.gemessen).toBe(false);
  });

  it('beschriftet „voll" und „leer" nur, wo der Plan die Grenze als bindend trägt', () => {
    const ohne = modell();
    expect(ohne.ladestandMarken.map((m) => m.art)).toEqual(['ende']);
    const mit = modell((i) => ({
      slotFlags: i === 69 ? ['soc_max'] : i === 30 ? ['soc_floor'] : null,
      socPct: i === 69 ? 95 : i === 30 ? 10 : 50,
    }));
    expect(mit.ladestandMarken.map((m) => [m.art, m.text])).toEqual([
      ['voll', 'voll 17:15'],
      ['leer', 'leer 07:30'],
      ['ende', `50${NBSP}%`],
    ]);
  });

  it('färbt die Fahrlinie nach Phase und dämpft, was vorbei ist', () => {
    const m = modell((i) => ({ socPct: 20 + i * 0.5 }));
    expect(m.ladestandLinie.some((s) => s.vorbei)).toBe(true);
    expect(m.ladestandLinie.some((s) => !s.vorbei && s.role === 'pv_speichern')).toBe(true);
    expect(m.ladestandFlaeche).not.toBeNull();
  });

  it('schreibt das Wort nur in Bänder, die es fassen - sonst Symbol oder nichts', () => {
    const m = modell(() => ({}), [['warten', 60], ['guenstig_laden', 3], ['eigenverbrauch', 2], ['pv_speichern', 31]]);
    // 45 Minuten sind bei 984 px rund 25 px breit: Platz für das Symbol, nicht für das Wort.
    const kurz = m.baender.find((b) => b.role === 'guenstig_laden')!;
    expect(kurz.text).toBeNull();
    expect(kurz.symbol).toBe(true);
    // 30 Minuten (rund 16 px) tragen nicht einmal das Symbol.
    const winzig = m.baender.find((b) => b.role === 'eigenverbrauch')!;
    expect(winzig.text).toBeNull();
    expect(winzig.symbol).toBe(false);
    expect(m.baender[0].text).toBe('Warten');
  });

  it('setzt die Jetzt-Linie auf die Uhrzeit', () => {
    expect(modell().jetztX).toBeCloseTo(g.x(14 * 60 + 10));
  });
});

describe('energieFluss · wohin die Energie einer Viertelstunde fließt', () => {
  it('versorgt erst das Haus mit Sonne, dann den Speicher, der Rest geht ins Netz', () => {
    expect(energieFluss({ pvKw: 3, loadKw: 1, batteryKw: 1.5 })).toEqual([
      { von: 'sonne', nach: 'haus', kw: 1 },
      { von: 'sonne', nach: 'speicher', kw: 1.5 },
      { von: 'sonne', nach: 'netz', kw: 0.5 },
    ]);
  });

  it('lädt aus dem Netz, was die Sonne nicht liefert', () => {
    expect(energieFluss({ pvKw: 0, loadKw: 0.5, batteryKw: 4 })).toEqual([
      { von: 'netz', nach: 'haus', kw: 0.5 },
      { von: 'netz', nach: 'speicher', kw: 4 },
    ]);
  });

  it('deckt das Haus aus dem Speicher, ein Überschuss daraus geht ins Netz', () => {
    expect(energieFluss({ pvKw: 0, loadKw: 1.5, batteryKw: -2 })).toEqual([
      { von: 'speicher', nach: 'haus', kw: 1.5 },
      { von: 'speicher', nach: 'netz', kw: 0.5 },
    ]);
  });

  it('lässt abgeregelte Leistung nicht fließen und schweigt ohne Verbrauch oder Speicherwert', () => {
    expect(energieFluss({ pvKw: 5, loadKw: 1, batteryKw: 0, curtailKw: 4 })).toEqual([
      { von: 'sonne', nach: 'haus', kw: 1 },
    ]);
    expect(energieFluss({ pvKw: 5, loadKw: null, batteryKw: 0 })).toBeNull();
    expect(energieFluss({ pvKw: 5, loadKw: 1, batteryKw: null })).toBeNull();
  });
});
