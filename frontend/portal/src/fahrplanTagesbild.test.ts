import { describe, expect, it } from 'vitest';
import { tagModell, type TagSlot } from './fahrplanTag';
import {
  ROLLEN_SYMBOL,
  indexImLauf,
  jetztZeile,
  kopfsatz,
  kurzDatum,
  lupe,
  momentBand,
  stationen,
  tagDatum,
  tagesSchalter,
  tagOhneBild,
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

describe('Helfer', () => {
  it('findet eine Viertelstunde im jüngsten Lauf über ihre Startzeit, nie über den Index', () => {
    const lauf = [{ start: '2026-09-24T12:00:00Z' }, { start: '2026-09-24T12:15:00Z' }];
    expect(indexImLauf('2026-09-24T14:15:00+02:00', lauf)).toBe(1);
    expect(indexImLauf('2026-09-24T11:45:00Z', lauf)).toBe(-1);
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

describe('kopfsatz · der Tag in einem Satz', () => {
  it('nennt die Tätigkeiten, die am meisten Energie bewegen, jede nur einmal und in der Folge des Tages', () => {
    // Der Demo-Tag vom 20.10.2026: neun Stunden Verbrauch decken mit 0,4 kW
    // erzählen den Tag weniger als anderthalb Stunden Sonne speichern mit 4 kW.
    const leistung: Record<string, number> = { eigenverbrauch: -0.4, pv_speichern: 4, verkaufen: -12 };
    const demo = tagModell({
      slots: tag(
        [['eigenverbrauch', 38], ['warten', 4], ['pv_speichern', 6], ['warten', 21], ['eigenverbrauch', 4], ['verkaufen', 8], ['eigenverbrauch', 15]],
        (i) => ({ batteryKw: i >= 81 ? -2 : undefined }),
      ).map((x) => ({ ...x, batteryKw: x.batteryKw ?? leistung[x.slotRole as string] ?? 0 })),
      slotMinutes: 15,
      now: JETZT,
      plantKind: 'eigenverbrauch',
    });
    expect(kopfsatz(demo)).toBe('Heute: mittags Sonne speichern, abends einspeisen, nachts Verbrauch decken.');
  });

  it('wählt ohne Leistungswerte die längsten Tätigkeiten', () => {
    expect(kopfsatz(modell())).toBe(
      'Heute: nachmittags günstig aus dem Netz laden und Sonne speichern, abends Verbrauch decken.',
    );
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

  it('nennt den Tag des Tagesschalters - gestern auch im Warten in der Vergangenheit', () => {
    expect(kopfsatz(modell(), 'gestern')).toMatch(/^Gestern: nachmittags günstig aus dem Netz laden/);
    expect(kopfsatz(modell(), 'morgen')).toMatch(/^Morgen: /);
    const warten = tagModell({ slots: tag([['warten', 96]]), slotMinutes: 15, now: JETZT, plantKind: 'eigenverbrauch' });
    expect(kopfsatz(warten, 'gestern')).toBe('Gestern wartete der Speicher.');
    expect(kopfsatz(warten, 'morgen')).toBe('Morgen wartet der Speicher.');
  });
});

describe('jetztZeile · wer was tut, darunter höchstens drei Stichworte', () => {
  const t = modell((i) => ({ batteryKw: i === 56 ? 2.2 : i === 80 ? -1.5 : 0, socPct: 40 + i / 4, slotFlags: i === 56 ? ['soc_max'] : null }));
  const bestaetigt = {
    state: 'planmaessig',
    tone: 'ok',
    lead: 'Ihre Batterie speichert gerade Solarstrom',
    value: `2,2${NBSP}kW`,
    status: 'Läuft wie vorgesehen - nichts zu tun',
    valueMissing: null,
  } as unknown as JetztHeldView;
  const unbestaetigt = {
    state: 'wird_vorbereitet',
    tone: 'off',
    lead: 'Geplant ist gerade: Günstig aus dem Netz laden',
    value: null,
    status: 'Die Steuerung wird vorbereitet.',
    valueMissing: 'Noch keine aktuelle Rückmeldung Ihres Wechselrichters.',
  } as unknown as JetztHeldView;

  it('nimmt mit Bestätigung das Verb der Ausführung und den gemessenen Ladestand - ohne Gerätezeile', () => {
    expect(jetztZeile(t, 56, true, bestaetigt, 'eigenverbrauch', 63.6)).toEqual({
      kopf: 'Jetzt · 14:10',
      role: 'guenstig_laden',
      titel: 'Speicher lädt Solarstrom',
      geplant: false,
      unterzeile: `64${NBSP}% · voll · ab 14:30 Sonne speichern`,
      zustand: null,
    });
  });

  it('nennt ohne Bestätigung den Plan, sagt es - und steht dann mit kurzer Gerätezeile da', () => {
    const z = jetztZeile(t, 56, true, unbestaetigt, 'eigenverbrauch', null)!;
    expect(z.titel).toBe('Speicher lädt günstig aus dem Netz');
    expect(z.geplant).toBe(true);
    expect(z.unterzeile).toBe(`54${NBSP}% geplant · voll · ab 14:30 Sonne speichern`);
    expect(z.zustand).toEqual({
      ton: 'off',
      kurz: 'Wechselrichter bestätigt noch nicht',
      lang: 'Die Steuerung wird vorbereitet. Noch keine aktuelle Rückmeldung Ihres Wechselrichters.',
    });
  });

  it('beschreibt eine gewählte Viertelstunde als Plan, mit Leistung und dem Ende der Phase', () => {
    expect(jetztZeile(t, 80, false, bestaetigt, 'eigenverbrauch')).toMatchObject({
      kopf: '20:00–20:15 Uhr · geplant',
      titel: 'Speicher deckt den Verbrauch',
      geplant: true,
      unterzeile: `60${NBSP}% · 1,5${NBSP}kW · bis Mitternacht`,
      zustand: null,
    });
  });

  it('sagt beim Warten „wartet", nie „ruht"', () => {
    expect(jetztZeile(t, 2, false, null, 'eigenverbrauch')?.titel).toBe('Speicher wartet');
  });

  it('N9: nennt beim Warten keine kW-Zahl, auch mit Restleistung über der Ruhe-Schwelle', () => {
    const w = modell((i) => ({ batteryKw: i === 2 ? 0.1 : 0, socPct: 40 }));
    const z = jetztZeile(w, 2, false, null, 'eigenverbrauch')!;
    expect(z.titel).toBe('Speicher wartet');
    expect(z.unterzeile).not.toContain('kW');
  });
});

describe('Tagesschalter (E2 = A: Gestern · Heute · Morgen)', () => {
  it('zählt Kalendertage, auch über Monats- und Jahresgrenzen', () => {
    expect(tagDatum(new Date(2026, 8, 24, 14, 10), 'gestern')).toEqual(new Date(2026, 8, 23));
    expect(tagDatum(new Date(2026, 8, 30, 23, 50), 'morgen')).toEqual(new Date(2026, 9, 1));
    expect(tagDatum(new Date(2027, 0, 1, 0, 5), 'gestern')).toEqual(new Date(2026, 11, 31));
    // Zeitumstellung (25.10.2026): der Vortag bleibt ein Kalendertag.
    expect(tagDatum(new Date(2026, 9, 26, 1, 0), 'gestern')).toEqual(new Date(2026, 9, 25));
    expect(kurzDatum(new Date(2026, 8, 23))).toBe('Mi 23.09.');
  });

  it('trägt Wort und Datum wie der Prototyp - ohne Plan für morgen den Grund', () => {
    const mittag = new Date(2026, 8, 24, 12, 0);
    expect(tagesSchalter(mittag, true)).toEqual({
      optionen: [
        { id: 'gestern', label: 'Gestern', datum: 'Mi 23.09.' },
        { id: 'heute', label: 'Heute', datum: 'Do 24.09.' },
        { id: 'morgen', label: 'Morgen', datum: 'Fr 25.09.' },
      ],
      chip: null,
    });
    expect(tagesSchalter(mittag, false).optionen[2].datum).toBe('ab ca. 13 Uhr');
    // Nach 14 Uhr wäre „ab ca. 13 Uhr" eine falsche Zusage.
    expect(tagesSchalter(new Date(2026, 8, 24, 16, 0), false).optionen[2].datum).toBe('noch kein Plan');
  });

  it('sagt an Stelle eines fehlenden Bildes den Grund - nie eine leere Fläche', () => {
    const mittag = new Date(2026, 8, 24, 12, 0);
    expect(tagOhneBild('heute', null, mittag)).toBeNull();
    expect(tagOhneBild('morgen', null, mittag)).toMatchObject({
      titel: 'Für morgen gibt es noch keinen Plan',
      text: 'Die Börsenpreise für morgen kommen gegen 13 Uhr. Dann plant VoltPilot den ganzen Tag.',
      laedt: false,
    });
    expect(tagOhneBild('morgen', null, new Date(2026, 8, 24, 18, 0))?.text).toMatch(/^Sobald die Börsenpreise/);
    expect(tagOhneBild('gestern', null, mittag)).toMatchObject({ laedt: true, erneut: false });
    expect(tagOhneBild('gestern', { laedt: false, fehler: true }, mittag)).toMatchObject({ erneut: true, mitMesswerte: false });
    expect(tagOhneBild('gestern', { laedt: false, fehler: false }, mittag)).toMatchObject({
      titel: 'Für gestern ist kein vollständiger Plan gespeichert',
      mitMesswerte: true,
    });
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

  it('sind dieselben Phasen wie Uhr und Tagesband', () => {
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

describe('stationen · mit der Ist-Spur', () => {
  const t = modell((i) => ({ socPct: 40 + i / 4 }));
  // Gemessen: bis 10:00 wie geplant, dann lud der Speicher, obwohl der Plan wartete.
  const ist = t.slots.map((_, i) => (i <= 39 ? 30 + i / 8 : i <= 56 ? 35 + (i - 39) * 1.8 : null));

  it('zeigt vergangene und laufende Phasen gemessen - Kommendes bleibt Plan', () => {
    const st = stationen(t, 'eigenverbrauch', ist);
    expect(st[1]).toMatchObject({ gemessen: true, ladestand: `33${NBSP}% → 35${NBSP}%`, abweichung: null });
    expect(st.find((s) => s.laeuft)).toMatchObject({ gemessen: true });
    expect(st[st.length - 1]).toMatchObject({ gemessen: false });
  });

  it('sagt „tatsächlich geladen", wenn der Plan wartete und der Speicher gemessen lud', () => {
    const st = stationen(t, 'eigenverbrauch', ist);
    expect(st[2]).toMatchObject({ label: 'Warten', gemessen: true, abweichung: 'tatsächlich geladen' });
  });

  it('bleibt ohne Messung zeichengleich beim Plan', () => {
    expect(stationen(t, 'eigenverbrauch', t.slots.map(() => null))).toEqual(stationen(t, 'eigenverbrauch'));
  });
});
