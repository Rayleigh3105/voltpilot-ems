import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import {
  EINFUEHRUNG,
  ROLLEN_SYMBOL,
  ebenenSatz,
  indexImLauf,
  ladestandText,
  lupe,
  momentZeile,
  werteAmZeiger,
} from './fahrplanTagesbild';
import { NBSP } from './format';

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

function modell(over: (i: number) => Partial<TagSlot> = () => ({})) {
  return tagModell({ slots: tag(LAUF, over), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
}

describe('momentZeile · die Zeile zur Viertelstunde am Zeiger', () => {
  const t = modell((i) => ({ batteryKw: i === 56 ? 2.2 : i === 30 ? -1.5 : 0, socPct: 40 + i / 4 }));

  it('nennt jetzt mit Uhrzeit, das Wort der Phase und die geplanten Zahlen', () => {
    expect(momentZeile(t, 56, true)).toEqual({
      art: 'jetzt',
      zeit: 'Jetzt · 14:10',
      was: 'Günstig aus dem Netz laden',
      role: 'guenstig_laden',
      plan: `Geplant: laden mit 2,2${NBSP}kW · Ladestand danach 54${NBSP}%`,
    });
  });

  it('sagt bei Vergangenem, dass es der Plan WAR - nie eine Messung', () => {
    const z = momentZeile(t, 30, false)!;
    expect(z.art).toBe('vorbei');
    expect(z.zeit).toBe('07:30–07:45 Uhr');
    expect(z.plan).toBe(`War geplant: abgeben mit 1,5${NBSP}kW · Ladestand danach 48${NBSP}%`);
  });

  it('sagt „kein Laden, kein Abgeben" statt einer 0 - und lässt Fehlendes weg', () => {
    const ohne = modell(() => ({ batteryKw: 0, socPct: null }));
    expect(momentZeile(ohne, 70, false)!.plan).toBe('Geplant: kein Laden, kein Abgeben');
    const nichts = modell(() => ({ batteryKw: null, socPct: null }));
    expect(momentZeile(nichts, 70, false)!.plan).toBeNull();
    expect(momentZeile(ohne, 200, false)).toBeNull();
  });
});

describe('werteAmZeiger · die ablesbare Legende', () => {
  it('liest Sonne gemessen für Vergangenes, erwartet für Kommendes', () => {
    const t = modell((i) => ({ pvKw: 3, measuredPvKw: i < 57 ? 2.5 : 9 }));
    const vorbei = werteAmZeiger(t, 50);
    expect(vorbei[0]).toEqual({
      ebene: 'sonne',
      label: 'Sonne',
      wert: `2,5${NBSP}kW`,
      herkunft: 'gemessen',
      satz: `Sonne: 2,5${NBSP}kW, gemessen`,
    });
    // Eine „Messung" in der Zukunft gibt es nicht.
    expect(werteAmZeiger(t, 70)[0]).toMatchObject({ wert: `3,0${NBSP}kW`, herkunft: 'erwartet' });
  });

  it('nennt den Börsenpreis beim Namen, wenn der Bezugspreis fehlt', () => {
    const t = modell((i) => ({ importPriceCtKwh: i === 3 ? null : 30, priceEurMwh: 120 }));
    expect(werteAmZeiger(t, 70)[1]).toEqual({
      ebene: 'preis',
      label: 'Preis',
      wert: `12,0${NBSP}ct`,
      herkunft: 'Börse',
      satz: `Börsenpreis: 12,0${NBSP}ct/kWh`,
    });
    expect(werteAmZeiger(modell(), 70)[1].herkunft).toBe('Bezug');
  });

  it('sagt beim Speicher, was geplant ist - „war geplant" für Vergangenes', () => {
    const t = modell((i) => ({ batteryKw: i === 30 ? -1.5 : 2 }));
    expect(werteAmZeiger(t, 30)[2]).toMatchObject({
      wert: `1,5${NBSP}kW`,
      herkunft: 'war geplant',
      satz: `Speicher: gibt ab 1,5${NBSP}kW, war geplant`,
    });
    expect(werteAmZeiger(t, 70)[2]).toMatchObject({
      wert: `2,0${NBSP}kW`,
      herkunft: 'geplant',
      satz: `Speicher: lädt 2,0${NBSP}kW, geplant`,
    });
    expect(werteAmZeiger(modell(() => ({ batteryKw: 0 })), 70)[2]).toMatchObject({ wert: 'ruht', herkunft: 'geplant' });
  });

  it('zeigt „–" statt einer erfundenen 0', () => {
    const t = modell(() => ({ pvKw: null, socPct: null, batteryKw: null }));
    const w = werteAmZeiger(t, 70);
    expect(w.map((x) => x.wert)).toEqual(['–', `30,0${NBSP}ct`, '–', '–']);
    expect(w[0].herkunft).toBeNull();
  });
});

describe('Einführung und Ebenen-Sätze (E11)', () => {
  it('führt in fünf Schritten Ring für Ring, zuletzt der Zeiger', () => {
    expect(EINFUEHRUNG.map((s) => s.ebene)).toEqual(['sonne', 'preis', 'taetigkeit', 'ladestand', 'zeiger']);
  });

  it('nennt günstigste und teuerste Viertelstunde mit Uhrzeit', () => {
    const t = modell((i) => ({ importPriceCtKwh: i === 57 ? 19.3 : i === 78 ? 50.3 : 30 }));
    expect(ebenenSatz(t, 'preis')).toBe(
      `Der blaue Ring ist Ihr Strompreis je Viertelstunde: hell günstig, dunkel teuer. Heute am günstigsten um 14:15 Uhr (19,3${NBSP}ct/kWh), am teuersten um 19:30 Uhr (50,3${NBSP}ct/kWh).`,
    );
  });

  it('hat für jede Ebene einen Satz', () => {
    const t = modell();
    for (const s of EINFUEHRUNG) expect(ebenenSatz(t, s.ebene).length).toBeGreaterThan(40);
  });
});

describe('Helfer', () => {
  it('findet eine Viertelstunde im jüngsten Lauf über ihre Startzeit, nie über den Index', () => {
    const lauf = [{ start: '2026-09-24T12:00:00Z' }, { start: '2026-09-24T12:15:00Z' }];
    expect(indexImLauf('2026-09-24T14:15:00+02:00', lauf)).toBe(1);
    expect(indexImLauf('2026-09-24T11:45:00Z', lauf)).toBe(-1);
  });

  it('beschreibt den Ladestand für Screenreader', () => {
    expect(ladestandText(52.4, false)).toBe(`Ladestand 52${NBSP}% geplant`);
    expect(ladestandText(52.4, true)).toBe(`Ladestand 52${NBSP}% war geplant`);
  });

  it('gibt jeder Tätigkeit ein Symbol', () => {
    expect(Object.keys(ROLLEN_SYMBOL).sort()).toEqual(
      ['abregeln', 'eigenverbrauch', 'guenstig_laden', 'pv_speichern', 'reserve_halten', 'spitze_kappen', 'verkaufen', 'warten'].sort(),
    );
  });
});

describe('lupe · eine Viertelstunde im Detail', () => {
  it('zeigt den geplanten Energiefluss und die Preise hinter der Entscheidung', () => {
    const t = modell((i) => (i === 60 ? { pvKw: 3, loadKw: 1, batteryKw: 1.5, socPct: 61 } : {}));
    const l = lupe(t, 60)!;
    expect(l.zeit).toBe('15:00–15:15 Uhr');
    expect(l.art).toBe('geplant');
    expect(l.was).toBe('Sonne speichern');
    expect(l.fluss).toEqual([
      { von: 'sonne', nach: 'haus', kw: 1 },
      { von: 'sonne', nach: 'speicher', kw: 1.5 },
      { von: 'sonne', nach: 'netz', kw: 0.5 },
    ]);
    expect(l.zeilen.map((z) => z.label)).toEqual([
      'Strompreis',
      'Einspeisewert',
      'Wert gespeicherter Energie',
      'Sonne erwartet',
      'Verbrauch erwartet',
      'Ladestand danach',
    ]);
  });

  it('nennt Gemessenes nur für Vergangenes', () => {
    const t = modell((i) => ({ measuredPvKw: 1.2, measuredLoadKw: 0.7, pvKw: 2 }));
    expect(lupe(t, 30)!.zeilen.map((z) => z.label)).toContain('Sonne gemessen');
    expect(lupe(t, 70)!.zeilen.map((z) => z.label)).toContain('Sonne erwartet');
  });
});
