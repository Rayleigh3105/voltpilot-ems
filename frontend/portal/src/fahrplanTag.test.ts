import { describe, expect, it } from 'vitest';
import {
  bildPreisArt,
  ladestandPlan,
  minuteDesTages,
  phaseVon,
  tagModell,
  uhrzeit,
  viertelBei,
  type TagSlot,
} from './fahrplanTag';

/** Der Beispieltag: Donnerstag, 24.09.2026, lokale Mitternacht (keine Zeitumstellung). */
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

/** Ein Tag aus Rollen-Läufen: [Rolle, Anzahl Viertelstunden]. */
function tag(laeufe: [string, number][], over: (i: number) => Partial<TagSlot> = () => ({})): TagSlot[] {
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) out.push(viertel(out.length, { slotRole: rolle, ...over(out.length) }));
  }
  return out;
}

const TAGESLAUF: [string, number][] = [
  ['warten', 23],
  ['eigenverbrauch', 17],
  ['warten', 14],
  ['guenstig_laden', 4],
  ['pv_speichern', 11],
  ['warten', 1],
  ['eigenverbrauch', 23],
  ['warten', 3],
];

describe('tagModell · der Tag auf der Uhrzeit', () => {
  it('schneidet genau den Kalendertag heraus und legt ihn auf Minuten', () => {
    const gestern = { ...viertel(0), start: new Date(TAG.getTime() - 15 * 60_000).toISOString() };
    const morgen = { ...viertel(0), start: new Date(TAG.getTime() + 96 * 15 * 60_000).toISOString() };
    const t = tagModell({ slots: [gestern, ...tag(TAGESLAUF), morgen], slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(t.slots).toHaveLength(96);
    expect(t.viertel[0].von).toBe(0);
    expect(t.viertel[95].bis).toBe(1440);
    expect(t.datum.getTime()).toBe(TAG.getTime());
  });

  it('weiß, was vorbei ist und was gerade läuft', () => {
    const t = tagModell({ slots: tag(TAGESLAUF), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(t.jetzt).toBeCloseTo(14 * 60 + 10);
    expect(t.jetztIndex).toBe(56);
    expect(t.viertel[55].vorbei).toBe(true);
    expect(t.viertel[56].vorbei).toBe(false);
    expect(t.viertel[56].laeuft).toBe(true);
    expect(t.viertel[57].laeuft).toBe(false);
  });

  it('benennt die Phasen mit dem EINEN Wortschatz (E8)', () => {
    const t = tagModell({ slots: tag([...TAGESLAUF.slice(0, 7), ['abregeln', 3]]), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(t.phasen.map((p) => p.label)).toEqual([
      'Warten',
      'Verbrauch decken',
      'Warten',
      'Günstig aus dem Netz laden',
      'Sonne speichern',
      'Warten',
      'Verbrauch decken',
      'Einspeisung pausieren',
    ]);
    // Die eine Viertelstunde „Warten" zwischen zwei ungleichen Nachbarn ist
    // ein echter Übergang und bleibt - die Glättung kommt aus `phases()`.
    expect(t.phasen[3]).toMatchObject({ von: 13 * 60 + 30, bis: 14 * 60 + 30, laeuft: true, vorbei: false });
    expect(t.phasen[1].vorbei).toBe(true);
  });

  it('zeigt den Bezugspreis, mit dem entschieden wurde - und nur ohne ihn den Börsenpreis', () => {
    const mitBezug = tag(TAGESLAUF, (i) => ({ importPriceCtKwh: i === 57 ? 19.3 : i === 78 ? 50.3 : 30 }));
    const t = tagModell({ slots: mitBezug, slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(t.preis).toMatchObject({ art: 'bezug', min: 19.3, max: 50.3, iMin: 57, iMax: 78 });

    const ohne = tag(TAGESLAUF, (i) => ({ importPriceCtKwh: i === 3 ? null : 30, priceEurMwh: i === 10 ? -14 : 100 }));
    const b = tagModell({ slots: ohne, slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(b.preis?.art).toBe('boerse');
    expect(b.preis?.min).toBeCloseTo(-1.4);
    expect(b.preis?.ct[0]).toBeCloseTo(10);
  });

  it('zeigt den Preis, der den Plan treibt - ein flacher Preis erklärt nichts (D1)', () => {
    // Fester Bezug zu 25 ct, die Börse schwankt: genau die Anlage, deren
    // Spur vorher aus 96 gleich hohen Balken bestand.
    const fest = tag(TAGESLAUF, (i) => ({ importPriceCtKwh: 25, priceEurMwh: 40 + i }));
    const mit = (slots: TagSlot[], tarifArt: 'dynamisch' | 'fest' | 'ohne', plantKind: 'eigenverbrauch' | 'direktvermarktung') =>
      tagModell({ slots, slotMinutes: 15, now: JETZT, plantKind, tarifArt }).preis;

    // Flacher Bezug + Direktvermarktung: der Börsenpreis, zu dem verkauft wird.
    expect(mit(fest, 'fest', 'direktvermarktung')).toMatchObject({ art: 'boerse', min: 4, iMin: 0, iMax: 95 });
    // Flacher Bezug ohne Vermarktung: der Preis erklärt nichts - kein Preis im Bild.
    expect(mit(fest, 'fest', 'eigenverbrauch')).toBeNull();
    expect(mit(fest, 'ohne', 'eigenverbrauch')).toBeNull();

    // Ein Bezugspreis, der sich über den Tag ändert, treibt den Plan - der
    // dynamische Tarif ebenso wie ein Preisblatt mit Hoch- und Niedertarif.
    const nt = tag(TAGESLAUF, (i) => ({ importPriceCtKwh: i < 24 ? 21 : 31 }));
    expect(mit(nt, 'fest', 'eigenverbrauch')).toMatchObject({ art: 'bezug', min: 21, max: 31 });
    expect(mit(nt, 'dynamisch', 'direktvermarktung')?.art).toBe('bezug');

    // Ältere Läufe ohne Bezugspreis: die Börse - außer bei bekannt festem Tarif ohne Vermarktung.
    const alt = tag(TAGESLAUF, () => ({ importPriceCtKwh: null }));
    expect(mit(alt, 'dynamisch', 'eigenverbrauch')?.art).toBe('boerse');
    expect(mit(alt, 'fest', 'eigenverbrauch')).toBeNull();

    expect(bildPreisArt(fest, 'fest', 'direktvermarktung')).toBe('boerse');
    expect(bildPreisArt(nt, 'fest', 'eigenverbrauch')).toBe('bezug');
    expect(bildPreisArt(alt, null, 'eigenverbrauch')).toBe('boerse');
  });

  it('hat ohne vollständige Warum-Ebene kein Tagesbild - nie eine erfundene Tätigkeit', () => {
    const t = tagModell({ slots: tag(TAGESLAUF, (i) => (i === 40 ? { slotRole: null } : {})), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(t.hatWarum).toBe(false);
    expect(t.phasen).toEqual([]);
  });

  it('kennt kein „jetzt" an einem anderen Tag', () => {
    const t = tagModell({ slots: tag(TAGESLAUF), slotMinutes: 15, now: new Date(2026, 8, 23, 20, 0), plantKind: 'eigenverbrauch', tag: TAG });
    expect(t.jetzt).toBeNull();
    expect(t.jetztIndex).toBe(-1);
    expect(t.viertel.every((v) => !v.vorbei)).toBe(true);
  });
});

describe('tagModell · Helfer', () => {
  const t = tagModell({ slots: tag(TAGESLAUF), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });

  it('findet Viertelstunde und Phase zu einer Uhrzeit', () => {
    expect(viertelBei(t, 14 * 60 + 10)).toBe(56);
    expect(viertelBei(t, 1500)).toBe(-1);
    expect(phaseVon(t, 56)?.label).toBe('Günstig aus dem Netz laden');
  });

  it('liest den geplanten Ladestand je Viertelstunde, Lücken bleiben Lücken', () => {
    const mitLuecke = tagModell({ slots: tag(TAGESLAUF, (i) => ({ socPct: i === 5 ? null : 40 + i / 10 })), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    const soc = ladestandPlan(mitLuecke);
    expect(soc[4]).toBeCloseTo(40.4);
    expect(soc[5]).toBeNull();
  });

  it('schreibt Uhrzeiten wie die Uhr - Mitternacht am Tagesende ist 24:00', () => {
    expect(uhrzeit(0)).toBe('00:00');
    expect(uhrzeit(855)).toBe('14:15');
    expect(uhrzeit(1440)).toBe('24:00');
    expect(minuteDesTages(new Date(2026, 8, 24, 6, 45))).toBe(405);
  });
});
