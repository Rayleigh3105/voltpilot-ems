import { describe, expect, it } from 'vitest';
import evFest51a from './fahrplanVektoren/laeufe/ev-fest-51a-tag.json';
import { preisRolle } from './preisRolle';
import { tagModell, type TagSlot } from './fahrplanTag';
import type { WhySlot } from './fahrplanWhy';
import {
  BLICK_MIN,
  SONNE_R,
  SYMBOL_AB_MIN,
  sonnenBogen,
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

describe('sonnenBogen (Konzept vp-fahrplan-eigenverbrauch-konzept §4.3)', () => {
  /** Ein Tag mit PV nur von 08:00 bis 18:00 (Rampe hoch, Spitze, Rampe runter). */
  function pvSlots(start: Date): TagSlot[] {
    const out: TagSlot[] = [];
    for (let i = 0; i < 96; i++) {
      const stunde = i / 4;
      const pv = stunde < 8 || stunde >= 18 ? 0 : 5 - Math.abs(stunde - 13);
      out.push({
        start: new Date(start.getTime() + i * 15 * 60_000).toISOString(),
        batteryKw: 0,
        socPct: 50,
        priceEurMwh: 100,
        costEur: 0,
        baselineCostEur: 0,
        slotRole: 'eigenverbrauch',
        slotFlags: null,
        pvKw: Math.max(0, pv),
      });
    }
    return out;
  }

  it('reicht von Sonnenaufgang (08:00) bis Sonnenuntergang (18:00), nichts davor oder danach', () => {
    const t = tagModell({ slots: pvSlots(TAG), slotMinutes: 15, now: new Date(2026, 9, 20, 6, 0), plantKind: 'eigenverbrauch' });
    const ph = uhrPhasen(t);
    const f = uhrFenster(t, ph, 'vormittag');
    const stuecke = sonnenBogen(t, f);
    expect(stuecke.length).toBeGreaterThan(0);
    expect(Math.min(...stuecke.map((s) => s.von))).toBeGreaterThanOrEqual(8 * 60);
    expect(Math.max(...stuecke.map((s) => s.bis))).toBeLessThanOrEqual(18 * 60);
  });

  it('heute beginnt der Bogen erst ab jetzt, nie rückwirkend vor dem Zeiger', () => {
    // Jetzt = 10:00, mitten in der Sonne (08:00-18:00): der Bogen darf die
    // Morgenstunden 08:00-10:00 nicht zeigen.
    const jetzt10 = new Date(2026, 9, 20, 10, 0);
    const t = tagModell({ slots: pvSlots(TAG), slotMinutes: 15, now: jetzt10, plantKind: 'eigenverbrauch' });
    const ph = uhrPhasen(t);
    const f = uhrFenster(t, ph, 'vormittag');
    expect(f.zeiger).toBe(10 * 60);
    const stuecke = sonnenBogen(t, f);
    expect(Math.min(...stuecke.map((s) => s.von))).toBeGreaterThanOrEqual(10 * 60);
  });

  it('ist kräftig bei viel Sonne, blass bei wenig - nie unter dem Mindestgewicht', () => {
    const t = tagModell({ slots: pvSlots(TAG), slotMinutes: 15, now: new Date(2026, 9, 20, 6, 0), plantKind: 'eigenverbrauch' });
    const ph = uhrPhasen(t);
    const f = uhrFenster(t, ph, 'vormittag');
    const stuecke = sonnenBogen(t, f);
    const mittag = stuecke.find((s) => s.von === 13 * 60);
    const morgens = stuecke.find((s) => s.von === 8 * 60 + 15);
    expect(mittag?.gewicht).toBe(1); // die Tagesspitze selbst.
    expect(morgens!.gewicht).toBeLessThan(mittag!.gewicht);
    expect(morgens!.gewicht).toBeGreaterThanOrEqual(0.15);
  });

  it('liegt außerhalb des Tätigkeits-Rings und innerhalb der Außenmarken', () => {
    expect(SONNE_R.innen).toBeGreaterThan(138);
    expect(SONNE_R.aussen).toBeLessThan(154);
  });

  it('schraffiert genau die Stunden ohne Vergütung (§ 51a, echter Lauf ev-fest-51a-tag)', () => {
    const lauf = evFest51a as { slots: WhySlot[] };
    const rolle = preisRolle({ slots: lauf.slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.nullstunden).toHaveLength(19);
    const zeiten = new Set(rolle.nullstunden.map((i) => lauf.slots[i].start));

    const tagDatum = new Date(2026, 9, 27); // derselbe lokale Kalendertag wie der Lauf.
    const t = tagModell({
      slots: lauf.slots as unknown as TagSlot[],
      slotMinutes: 15,
      now: new Date(2026, 9, 28), // ein anderer Tag: kein Jetzt, der ganze Vor-/Nachmittag zählt.
      plantKind: 'eigenverbrauch',
      tag: tagDatum,
    });
    const ph = uhrPhasen(t);
    // 10:00-12:00 liegt im Vormittag, 12:00-14:45 im Nachmittag (lokale Zeit, CET).
    const vormittag = sonnenBogen(t, uhrFenster(t, ph, 'vormittag'), zeiten);
    const nachmittag = sonnenBogen(t, uhrFenster(t, ph, 'nachmittag'), zeiten);
    const alle = [...vormittag, ...nachmittag];
    const schraffiert = alle.filter((s) => s.schraffiert);
    const frei = alle.filter((s) => !s.schraffiert && s.von >= 8 * 60 && s.bis <= 16 * 60);
    expect(schraffiert.length).toBeGreaterThan(0);
    // Jedes schraffierte Stück liegt zwischen 10:00 und 14:45 (die bekannte Spanne).
    for (const s of schraffiert) {
      expect(s.von).toBeGreaterThanOrEqual(10 * 60);
      expect(s.bis).toBeLessThanOrEqual(14 * 60 + 45);
    }
    expect(frei.length).toBeGreaterThan(0);
  });
});
