import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import {
  BLICK_MIN,
  SYMBOL_AB_MIN,
  uhrFenster,
  uhrModell,
  uhrPhasen,
  uhrUnterschrift,
  uhrWinkel,
} from './fahrplanUhr';

const TAG = new Date(2026, 9, 20);
const MORGEN = new Date(2026, 9, 21);

function slots(start: Date, laeufe: [string, number][]): TagSlot[] {
  const out: TagSlot[] = [];
  for (const [rolle, n] of laeufe) {
    for (let k = 0; k < n; k++) {
      out.push({
        start: new Date(start.getTime() + out.length * 15 * 60_000).toISOString(),
        batteryKw: 0,
        socPct: 50,
        priceEurMwh: 100,
        costEur: 0,
        baselineCostEur: 0,
        slotRole: rolle,
        slotFlags: null,
        storedValueCtKwh: 28,
        importPriceCtKwh: 30,
        exportValueCtKwh: 8,
      });
    }
  }
  return out;
}

// Der Demo-Tag vom 20.10.2026, 13:57 Uhr.
const HEUTE: [string, number][] = [
  ['eigenverbrauch', 38],
  ['warten', 4],
  ['pv_speichern', 6],
  ['warten', 21],
  ['eigenverbrauch', 4],
  ['verkaufen', 8],
  ['eigenverbrauch', 15],
];
const jetzt = new Date(2026, 9, 20, 13, 57);
const heute = tagModell({ slots: slots(TAG, HEUTE), slotMinutes: 15, now: jetzt, plantKind: 'eigenverbrauch' });
const morgen = tagModell({
  slots: slots(MORGEN, [['eigenverbrauch', 27], ['verkaufen', 1], ['warten', 68]]),
  slotMinutes: 15,
  now: jetzt,
  plantKind: 'eigenverbrauch',
  tag: MORGEN,
});

describe('uhrWinkel · eine Uhr wie am Handgelenk', () => {
  it('stellt 12 Uhr oben, 3 Uhr rechts - am Vormittag wie am Nachmittag', () => {
    expect(uhrWinkel(0)).toBe(0);
    expect(uhrWinkel(3 * 60)).toBe(90);
    expect(uhrWinkel(15 * 60)).toBe(90);
    expect(uhrWinkel(18 * 60)).toBe(180);
  });

  it('zeigt um 13:57 knapp vor die Zwei - nicht dorthin, wo eine Uhr 1 Uhr zeigt', () => {
    expect(uhrWinkel(13 * 60 + 57)).toBeCloseTo(58.5, 5);
  });
});

describe('uhrPhasen · der Tag, über Mitternacht weiter mit dem Folgetag', () => {
  it('legt den Folgetag hinter Mitternacht und macht aus gleicher Tätigkeit EINEN Bogen', () => {
    const p = uhrPhasen(heute, morgen);
    const ueberNacht = p.find((x) => x.von === 20 * 60 + 15)!;
    expect(ueberNacht).toMatchObject({ label: 'Verbrauch decken', quelle: 'tag', bis: 1440 + 6 * 60 + 45 });
    expect(p[p.length - 1]).toMatchObject({ quelle: 'folgetag', label: 'Warten', von: 1440 + 7 * 60 });
  });

  it('endet ohne Folgetag um Mitternacht', () => {
    expect(uhrPhasen(heute).at(-1)?.bis).toBe(1440);
  });
});

describe('uhrFenster · was auf der Uhr liegt', () => {
  it('zeigt heute elf Stunden ab jetzt, mit dem Zeiger auf jetzt', () => {
    expect(uhrFenster(heute, uhrPhasen(heute, morgen), 'vormittag')).toEqual({
      von: 13 * 60 + 57,
      bis: 13 * 60 + 57 + BLICK_MIN,
      zeiger: 13 * 60 + 57,
    });
  });

  it('endet am Plan, wenn der Folgetag noch nicht geplant ist', () => {
    expect(uhrFenster(heute, uhrPhasen(heute), 'vormittag').bis).toBe(1440);
  });

  it('zeigt an einem Tag ohne Jetzt den Vor- oder Nachmittag, ohne Zeiger', () => {
    const p = uhrPhasen(morgen);
    expect(uhrFenster(morgen, p, 'vormittag')).toEqual({ von: 0, bis: 720, zeiger: null });
    expect(uhrFenster(morgen, p, 'nachmittag')).toEqual({ von: 720, bis: 1440, zeiger: null });
  });
});

describe('uhrModell · Bögen, Wechselzeiten, Zeiger', () => {
  const p = uhrPhasen(heute, morgen);
  const m = uhrModell(p, uhrFenster(heute, p, 'vormittag'));

  it('zeichnet nur, was im Fenster liegt - der erste Bogen beginnt am Zeiger', () => {
    expect(m.boegen.map((b) => b.phase.label)).toEqual(['Warten', 'Verbrauch decken', 'Einspeisen', 'Verbrauch decken']);
    expect(m.boegen[0].von).toBe(13 * 60 + 57);
    expect(m.boegen.at(-1)?.bis).toBe(13 * 60 + 57 + BLICK_MIN);
  });

  it('gibt nur Bögen ab einer Dreiviertelstunde ein Symbol', () => {
    for (const b of m.boegen) expect(b.symbol != null).toBe(b.bis - b.von >= SYMBOL_AB_MIN);
  });

  it('schreibt die Uhrzeit jedes Wechsels außen an den Ring', () => {
    expect(m.marken.map((x) => x.text)).toEqual(['17:15', '18:15', '20:15']);
  });

  it('lässt zu enge Wechselzeiten weg, statt sie übereinander zu schreiben', () => {
    // Drei Wechsel binnen einer halben Stunde liegen 7,5° auseinander: nur der erste steht da.
    const t = tagModell({
      slots: slots(TAG, [['warten', 60], ['eigenverbrauch', 1], ['verkaufen', 1], ['warten', 34]]),
      slotMinutes: 15,
      now: new Date(2026, 9, 20, 14, 0),
      plantKind: 'eigenverbrauch',
    });
    const eng = uhrPhasen(t);
    expect(uhrModell(eng, uhrFenster(t, eng, 'vormittag')).marken.map((x) => x.text)).toEqual(['15:00']);
  });

  it('hat heute einen Zeiger, an einem Tag ohne Jetzt keinen', () => {
    expect(m.zeiger).not.toBeNull();
    const pm = uhrPhasen(morgen);
    expect(uhrModell(pm, uhrFenster(morgen, pm, 'vormittag')).zeiger).toBeNull();
  });
});

describe('uhrUnterschrift', () => {
  it('nennt das Ende des Blicks auf die Viertelstunde abgerundet', () => {
    expect(uhrUnterschrift({ von: 837, bis: 837 + BLICK_MIN, zeiger: 837 })).toBe('Ab jetzt bis 00:45');
    expect(uhrUnterschrift({ von: 837, bis: 1440, zeiger: 837 })).toBe('Ab jetzt bis 24:00');
  });

  it('nennt ohne Jetzt die Tageshälfte', () => {
    expect(uhrUnterschrift({ von: 0, bis: 720, zeiger: null })).toBe('Vormittag · 0 bis 12 Uhr');
    expect(uhrUnterschrift({ von: 720, bis: 1440, zeiger: null })).toBe('Nachmittag · 12 bis 24 Uhr');
  });
});
