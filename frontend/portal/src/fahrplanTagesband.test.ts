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

  it('sonne = false (Vorgabe) lässt sonneNachZiel null - die Preis-Erzählung bleibt unverändert', () => {
    const m = bandModell(tag, g, ist);
    expect(m.sonneNachZiel).toBeNull();
    // Dieselbe flache Spur wie vor der Umstellung - keine sichtbare Änderung.
    expect(bandModell(tag, g, ist, false)).toEqual(m);
  });
});

describe('bandModell · Sonnenspur nach Ziel (Konzept vp-fahrplan-eigenverbrauch-konzept §4.6, sonne = true)', () => {
  const TAG = new Date(2026, 9, 27);
  // Vormittag (gemessen, vorbei): Sonne deckt das Haus UND lädt den Speicher voll - kein Überschuss ins Netz.
  // Nachmittag (geplant, ab jetzt): weniger Sonne, kein Speicherbedarf mehr - sie deckt das Haus UND speist den Rest ins Netz.
  const slots: TagSlot[] = Array.from({ length: 40 }, (_, i) => ({
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: i < 20 ? 3 : 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'eigenverbrauch',
    slotFlags: null,
    pvKw: i < 20 ? 4 : 2,
    loadKw: 1,
    measuredPvKw: i < 20 ? 4.1 : null,
    measuredLoadKw: i < 20 ? 1.1 : null,
  }));
  const tag = tagModell({ slots, slotMinutes: 15, now: new Date(2026, 9, 27, 5, 0), plantKind: 'eigenverbrauch' });
  const g = bandGeometrie(1100);

  it('stapelt Haus, Speicher und Netz - gemessen für die vorbei-Viertelstunden, geplant für den Rest', () => {
    const m = bandModell(tag, g, [], true);
    expect(m.sonneNachZiel).not.toBeNull();
    const z = m.sonneNachZiel!;
    // Jedes Band trägt eine Fläche für beide Tageshälften - auch wo ein Ziel
    // einmal nichts bekommt (Überschuss/Speicherbedarf = 0), bleibt die Fläche
    // bestehen (nur ohne Höhe an der Stelle): `energieFluss` selbst trägt dort
    // einen echten Wert (0), keine Lücke - eine Lücke bedeutet „kein Fakt",
    // nicht „nichts floss".
    for (const band of [z.haus, z.speicher, z.netz]) {
      expect(band.gemessen, 'gemessener Vormittag').not.toBeNull();
      expect(band.erwartet, 'geplanter Nachmittag').not.toBeNull();
    }
    // Die Spitze des Vormittags (viel Sonne, Speicher lädt) und des Nachmittags
    // (weniger Sonne, Einspeisung) unterscheiden sich tatsächlich der Höhe nach -
    // sonst wäre „nach Ziel gestapelt" nur eine leere Behauptung.
    expect(z.speicher.gemessen).not.toBe(z.speicher.erwartet);
    expect(z.netz.gemessen).not.toBe(z.netz.erwartet);
  });

  it('ohne Verbrauch oder Speicherwert (keine Warum-Fakten) liefert jedes Band null, statt einen Fluss zu erfinden', () => {
    // energieFluss() selbst verweigert sich ohne loadKw/batteryKw (siehe dessen eigene Tests) -
    // dieselbe Ehrlichkeit gilt für die gestapelte Spur.
    const ohneFakten: TagSlot[] = slots.map((s) => ({ ...s, loadKw: undefined, batteryKw: null, measuredLoadKw: undefined }));
    const t = tagModell({ slots: ohneFakten, slotMinutes: 15, now: new Date(2026, 9, 27, 5, 0), plantKind: 'eigenverbrauch' });
    const m = bandModell(t, g, [], true);
    expect(m.sonneNachZiel).toEqual({
      haus: { gemessen: null, erwartet: null },
      speicher: { gemessen: null, erwartet: null },
      netz: { gemessen: null, erwartet: null },
    });
  });
});
