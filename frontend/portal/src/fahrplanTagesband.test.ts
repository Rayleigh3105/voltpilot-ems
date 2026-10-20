import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import { bandGeometrie, bandModell, bandTextBreite, energieFluss } from './fahrplanTagesband';

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

describe('bandModell · das Tagesband am Rechner', () => {
  const TAG = new Date(2026, 9, 20);
  const laeufe: [string, number][] = [
    ['eigenverbrauch', 38],
    ['warten', 4],
    ['pv_speichern', 6],
    ['warten', 21],
    ['eigenverbrauch', 4],
    ['verkaufen', 8],
    ['eigenverbrauch', 15],
  ];
  const slots: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) {
      const i = slots.length;
      slots.push({
        start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
        batteryKw: 0,
        socPct: 30 + i / 2,
        priceEurMwh: 100 + i,
        costEur: 0,
        baselineCostEur: 0,
        slotRole: rolle,
        slotFlags: i >= 50 && i <= 68 ? ['soc_max'] : null,
        storedValueCtKwh: 28,
        importPriceCtKwh: 30 + i / 4,
        exportValueCtKwh: 8,
        pvKw: i > 30 && i < 70 ? 4 : 0,
        measuredPvKw: i > 30 && i < 56 ? 4.2 : null,
      });
    }
  }
  const tag = tagModell({ slots, slotMinutes: 15, now: new Date(2026, 9, 20, 13, 57), plantKind: 'eigenverbrauch' });
  const g = bandGeometrie(1100);
  const ist = slots.map((_, i) => (i <= tag.jetztIndex ? 25 + i : null));

  it('stellt jede Phase als Block dar; breite tragen Wort und Zeit, schmale ihr Wort darüber', () => {
    const m = bandModell(tag, g, ist);
    expect(m.bloecke).toHaveLength(tag.phasen.length);
    expect(m.bloecke[0]).toMatchObject({ text: 'Verbrauch decken', zeit: '00:00–09:30' });
    const schmal = m.bloecke.filter((b) => b.text == null);
    expect(schmal.length).toBeGreaterThan(0);
    // Wörter über der Kopfzeile überdecken einander nie.
    const lagen = m.bloecke.filter((b) => b.ueber).map((b) => [b.ueber!.x, bandTextBreite(b.ueber!.text, 11.5)]);
    for (let a = 0; a < lagen.length; a++) {
      for (let b = a + 1; b < lagen.length; b++) {
        expect(Math.abs(lagen[a][0] - lagen[b][0])).toBeGreaterThan((lagen[a][1] + lagen[b][1]) / 2);
      }
    }
  });

  it('zeichnet links von jetzt die Messung, rechts den Plan, und setzt jetzt auf den gemessenen Punkt', () => {
    const m = bandModell(tag, g, ist);
    expect(m.istLinie).not.toBeNull();
    expect(m.planLinie).not.toBeNull();
    expect(m.planVorbeiLinie).toBeNull();
    expect(m.jetztPunkt).toMatchObject({ gemessen: true, pct: 25 + tag.jetztIndex });
  });

  it('zeigt ohne Messung den vergangenen Plan blass - nie als gemessen', () => {
    const m = bandModell(tag, g, []);
    expect(m.istLinie).toBeNull();
    expect(m.planVorbeiLinie).not.toBeNull();
    expect(m.jetztPunkt?.gemessen).toBe(false);
  });

  it('schreibt „voll" nicht an die Jetzt-Linie, wenn der Speicher schon voll ist', () => {
    expect(bandModell(tag, g, ist).marken.map((x) => x.art)).not.toContain('voll');
  });

  it('nennt den günstigsten und den teuersten Preis', () => {
    expect(bandModell(tag, g, ist).preisMarken.map((p) => p.art)).toEqual(['min', 'max']);
  });
});
