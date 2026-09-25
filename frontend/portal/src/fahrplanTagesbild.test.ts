import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import {
  EINFUEHRUNG,
  einfuehrungFuer,
  ROLLEN_SYMBOL,
  ebenenSatz,
  indexImLauf,
  kopfsatz,
  ladestandText,
  lupe,
  momentBand,
  momentZeile,
  stationen,
  werteAmZeiger,
} from './fahrplanTagesbild';
import type { JetztHeldView } from './fahrplanJetzt';
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

  it('hat ohne treibenden Preis (fester Tarif) keine Preiszelle', () => {
    const fest = tagModell({ slots: tag(LAUF), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch', tarifArt: 'fest' });
    // Der Bezug ist den ganzen Tag 30 ct: flach, also keine Preiszelle.
    expect(werteAmZeiger(fest, 70).map((x) => x.ebene)).toEqual(['sonne', 'taetigkeit', 'ladestand']);
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

  it('erklärt nur Ringe, die es gibt: ohne Preis vier Schritte, bei der Börse ihr Name', () => {
    const mit = (tarifArt: 'fest' | 'dynamisch', plantKind: 'eigenverbrauch' | 'direktvermarktung', bezug?: (i: number) => number) =>
      tagModell({ slots: tag(LAUF, bezug ? (i) => ({ importPriceCtKwh: bezug(i) }) : undefined), slotMinutes: 15, now: JETZT, plantKind, tarifArt });
    expect(einfuehrungFuer(mit('fest', 'eigenverbrauch')).map((s) => s.ebene)).toEqual(['sonne', 'taetigkeit', 'ladestand', 'zeiger']);
    expect(einfuehrungFuer(mit('fest', 'direktvermarktung'))[1]).toEqual({ ebene: 'preis', titel: 'Börsenpreis' });
    expect(einfuehrungFuer(mit('dynamisch', 'eigenverbrauch', (i) => 20 + i / 10))).toBe(EINFUEHRUNG);
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

  it('nennt neben dem Börsenpreis auch, was Strom aus dem Netz kostet', () => {
    const dv = tagModell({ slots: tag(LAUF, () => ({ importPriceCtKwh: 25 })), slotMinutes: 15, now: JETZT, plantKind: 'direktvermarktung', tarifArt: 'fest' });
    const z = lupe(dv, 70)!.zeilen;
    expect(z.slice(0, 2)).toEqual([
      { label: 'Börsenpreis', wert: `10,0${NBSP}ct/kWh` },
      { label: 'Strom kostet', wert: `25,0${NBSP}ct/kWh` },
    ]);
  });
});

describe('kopfsatz · der Tag in einer Zeile (Prototyp)', () => {
  it('nennt die längsten Tätigkeiten nach Tageszeit, in der Reihenfolge des Tages', () => {
    expect(kopfsatz(modell())).toBe('Heute: morgens Verbrauch decken, nachmittags Sonne speichern, abends Verbrauch decken.');
  });

  it('fasst eine Tageszeit zusammen und schreibt Listenwörter im Satz klein', () => {
    const t = tagModell({
      slots: tag([['warten', 40], ['pv_speichern', 16], ['warten', 16], ['verkaufen', 4], ['eigenverbrauch', 12], ['warten', 8]]),
      slotMinutes: 15,
      now: JETZT,
      plantKind: 'direktvermarktung',
    });
    expect(kopfsatz(t)).toBe('Heute: mittags Sonne speichern, abends zum Spitzenpreis verkaufen und Verbrauch decken.');
  });

  it('sagt es, wenn der Speicher nur wartet - und schweigt ohne Phasen', () => {
    expect(kopfsatz(tagModell({ slots: tag([['warten', 96]]), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' }))).toBe(
      'Heute wartet der Speicher.',
    );
    expect(kopfsatz(modell((i) => (i === 3 ? { slotRole: null } : {})))).toBeNull();
  });
});

describe('momentBand · die Zeile zum Moment am Zeiger', () => {
  const held = {
    lead: 'Ihre Batterie speichert gerade Solarstrom',
    value: `2,2${NBSP}kW`,
    valueNote: 'in den Speicher',
    valueMissing: null,
    confirm: 'vom Wechselrichter bestätigt · geprüft vor 8 Sek.',
    why: 'Günstigster Strom des restlichen Tages.',
  } as unknown as JetztHeldView;

  it('lässt bei „jetzt" das Gerät sprechen: Ausführung und Bestätigung, getrennt vom Plan', () => {
    expect(momentBand(modell(), 56, true, held, 'Satz der Waage')).toEqual({
      kopf: 'Jetzt · 14:10',
      was: 'Ihre Batterie speichert gerade Solarstrom',
      role: 'guenstig_laden',
      zahl: `2,2${NBSP}kW in den Speicher · vom Wechselrichter bestätigt`,
      warum: 'Günstigster Strom des restlichen Tages.',
    });
  });

  it('nennt für eine andere Viertelstunde den Plan - Vergangenes als „war geplant"', () => {
    const t = modell((i) => ({ batteryKw: i === 80 ? -1.5 : 0, socPct: 40 + i / 4 }));
    expect(momentBand(t, 80, false, held, 'Satz der Waage')).toEqual({
      kopf: '20:00–20:15 Uhr · geplant',
      was: 'Verbrauch decken',
      role: 'eigenverbrauch',
      zahl: `abgeben mit 1,5${NBSP}kW · Ladestand danach 60${NBSP}%`,
      warum: 'Satz der Waage',
    });
    expect(momentBand(t, 30, false, held, null)).toMatchObject({
      kopf: '07:30–07:45 Uhr · war geplant',
      was: 'War geplant: Verbrauch decken',
      warum: null,
    });
  });
});

describe('stationen · der Tag in Stationen', () => {
  const t = modell((i) => ({ socPct: 40 + i / 4 }));
  const st = stationen(t, 'eigenverbrauch');

  it('sind dieselben Phasen wie Uhr und Bildfahrplan', () => {
    expect(st.map((s) => s.label)).toEqual(t.phasen.map((p) => p.label));
    expect(st.map((s) => s.zeit)).toEqual(['00:00–05:45', '05:45–10:00', '10:00–13:30', '13:30–14:30', '14:30–17:30', '17:30–24:00']);
    expect(st.find((s) => s.laeuft)?.label).toBe('Günstig aus dem Netz laden');
    expect(st[1].vorbei).toBe(true);
  });

  it('nennt den geplanten Ladestand von - bis, um Mitternacht nur das Ende', () => {
    expect(st[0].ladestand).toBe(`46${NBSP}%`);
    expect(st[1].ladestand).toBe(`46${NBSP}% → 50${NBSP}%`);
  });

  it('gibt jeder Tätigkeit den Satz ihrer Phasen-Karte - beim Warten keinen', () => {
    expect(st[0].grund).toBeNull();
    expect(st[1].grund).toBe('Der Speicher deckt den Verbrauch und vermeidet teuren Netzbezug.');
  });
});
