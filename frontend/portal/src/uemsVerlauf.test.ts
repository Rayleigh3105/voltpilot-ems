import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleWerte } from './api';
import { UEMS_WOCHE_OHNE_ZAHL } from './glossar';
import {
  ANFANG_NICHT_GEMESSEN,
  LUECKE_03_11,
  MS_10,
  NUR_EIN_STAND,
  antwort,
  f13Tag,
  f13Viertelstunden,
  f16Monat,
  f8Tag,
  f8Viertelstunden,
  grundlastWoche,
  jahr2026,
  schritt,
  viertelstundenDes,
  voll,
} from './test/werteKarteFixtures';
import { EREIGNIS_TEXTE } from './uemsEreignis';
import {
  BILD,
  MARKER_IM_BILD,
  bild,
  blaettere,
  erhaltenText,
  gleicheAnfrage,
  heuteOderSpaeter,
  kernaussage,
  luecken,
  marker,
  markerSatz,
  schrittKarte,
  schritte,
  skalaOben,
  tooltipSatz,
  wertAm,
  zeitraumAnfragen,
} from './uemsVerlauf';

/**
 * Der Verlauf einer Messstelle (UEMS AP-13 IP-4 = AP-08 IP-10) gegen die Verträge: die Schritte der Bühne sind die
 * Erwartungen von `verbrauch-vectors.json` (F8, F13), der Marker-Satz ist der Standard-Satz des Ereignis-Vokabulars
 * (`events-vocabulary-vectors.json`) — keine selbst gedachte Zahl, kein selbst formulierter Satz.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const verbrauch = lies('verbrauch-vectors.json');
const vokabular = lies('events-vocabulary-vectors.json');

/** Testing-Vergleiche ohne das geschützte Leerzeichen der Zahlen („22,4 kWh“). */
const glatt = (t: string | null | undefined): string | null | undefined => t?.replace(/ /g, ' ');

const erwartung = (fall: string, name: string): Json => {
  const f = (verbrauch.cases as Json[]).find((c) => c.name.startsWith(`${fall}-`));
  const e = (f?.expected as Json[] | undefined)?.find((x) => x.name === name);
  if (!e) throw new Error(`keine Erwartung ${fall} · ${name}`);
  return e;
};

/** Der Schritt der Bühne mit der Beschriftung des Vektors („Viertelstunde 14:00–14:15“ → „14:00–14:15“). */
const schrittDes = (a: MessstelleWerte, name: string) => {
  const w = a.werte.find((x) => `Viertelstunde ${x.beschriftung}` === name);
  if (!w) throw new Error(`kein Schritt ${name}`);
  return w;
};

const gleichDemVektor = (a: MessstelleWerte, fall: string, name: string) => {
  const e = erwartung(fall, name);
  const w = schrittDes(a, name);
  expect(Date.parse(w.von), name).toBe(Date.parse(e.von));
  expect(Date.parse(w.bis), name).toBe(Date.parse(e.bis));
  expect(w.menge, name).toBe(e.menge);
  expect(w.zustand, name).toBe(e.zustand);
  expect(w.erhalten, name).toBe(e.erhalten);
  expect(w.erwartet, name).toBe(e.erwartet);
  expect(w.abdeckung_prozent, name).toBe(e.abdeckung_prozent);
  expect(w.kennzeichen, name).toEqual(e.kennzeichen);
};

describe('uemsVerlauf · F8 · die Lücke vom 03.11.2026 (Plan-Abnahme 2)', () => {
  const a = f8Viertelstunden();
  const s = schritte(a);
  const l = luecken(s);
  const m = marker(a, s, l);

  it('die Viertelstunden der Bühne sind die des Vertrags', () => {
    for (const name of ['Viertelstunde 14:00–14:15', 'Viertelstunde 14:15–14:30', 'Viertelstunde 17:30–17:45']) gleichDemVektor(a, 'f8', name);
    expect(erwartung('f8', 'Viertelstunde 14:00–14:15').kennzeichen).toEqual([NUR_EIN_STAND]);
    expect(erwartung('f8', 'Viertelstunde 17:30–17:45').kennzeichen).toEqual([ANFANG_NICHT_GEMESSEN]);
  });

  it('96 Viertelstunden; wo keine Zahl ist, steht kein Balken — nie eine Null', () => {
    expect(s).toHaveLength(96);
    expect(s[56]).toMatchObject({ titel: '14:00–14:15', art: 'unvollstaendig', hoehe: null });
    for (const x of s.slice(57, 70)) expect(x).toMatchObject({ art: 'keine_werte', hoehe: null });
    expect(s[70]).toMatchObject({ titel: '17:30–17:45', art: 'unvollstaendig', hoehe: 22.4 });
    expect(s.filter((x) => x.hoehe !== null)).toHaveLength(82);
    expect(s.filter((x) => x.hoehe === 0)).toHaveLength(0);
  });

  it('die Folge „keine Werte“ 14:15–17:30 ist EINE Fläche, und sie ist verwiesen', () => {
    expect(l).toEqual([{ erster: 57, letzter: 69, verwiesen: true }]);
  });

  it('der Marker spricht den Standard-Satz des Vokabulars — über jede berührte Viertelstunde, einmal', () => {
    const vorlage = (vokabular.vokabular.arten as Json[]).find((x) => x.art === 'data_gap').saetze.standard;
    expect(vorlage).toBe('Lücke von {von} bis {bis} — nie als 0 gerechnet');
    expect(m).toEqual([
      {
        schluessel: LUECKE_03_11.id,
        satz: vorlage.replace('{von}', '03.11.2026 14:00').replace('{bis}', '17:31'),
        erster: 56,
        letzter: 70,
        nummer: 1,
      },
    ]);
  });

  it('die Schritt-Karte: „— · keine Werte · 0 von 15“ und „22,4 kWh · unvollständig · 14 von 15“', () => {
    const leer = schrittKarte(a, s[57]);
    expect(leer).toMatchObject({ titel: '14:15–14:30', zahl: '—', zustand: 'keine Werte', luecken: '1 Lücke', grund: null });
    expect(glatt(leer.abdeckung)).toBe('Verlauf 0 % · 0 von 15 Werten');

    const teil = schrittKarte(a, s[70]);
    expect(glatt(teil.zahl)).toBe('22,4 kWh');
    expect(teil.zustand).toBe('unvollständig (Menge aus Zählerständen)');
    expect(glatt(teil.abdeckung)).toBe('Verlauf 93 % · 14 von 15 Werten');
    expect(teil.kennzeichen).toEqual(erwartung('f8', 'Viertelstunde 17:30–17:45').kennzeichen);
    expect(teil.fassung).toBe('vorläufig');
  });

  it('der Tooltip ist ein Satz (K7)', () => {
    expect(glatt(tooltipSatz(s[70]))).toBe('17:30–17:45: 22,4 kWh, unvollständig, 14 von 15 Werten.');
    expect(tooltipSatz(s[60])).toBe('15:00–15:15: —, keine Werte, 0 von 15 Werten.');
  });

  it('der Kernaussage-Satz ist aus der Karte des Tages abgeleitet (V6) — 2 304 kWh wie der Vektor', () => {
    expect(erwartung('f8', 'Tag 03.11.2026').menge).toBe(2304.0);
    const k = kernaussage('tag', f8Tag());
    expect(k?.grund).toBeNull();
    expect(glatt(k?.satz)).toBe('Di 03.11.2026: 2.304 kWh · vollständig · vorläufig');
    expect(k?.ton).toBe('ok');
  });

  it('das Bild: 82 Balken, eine Fläche an der Stelle der Folge, eine Marke, die Achse in Viertelstunden', () => {
    const b = bild(a, s, l, m, 343);
    const breite = (343 - 2 * BILD.rand) / 96;
    expect(b.balken).toHaveLength(82);
    expect(b.luecken).toHaveLength(1);
    expect(b.luecken[0].x).toBeCloseTo(BILD.rand + 57 * breite, 6);
    expect(b.luecken[0].w).toBeCloseTo(13 * breite, 6);
    expect(b.marken).toEqual([{ nummer: 1, x1: BILD.rand + 56 * breite, x2: BILD.rand + 71 * breite, y: BILD.markenZeile / 2 }]);
    expect(b.flaeche.y).toBe(BILD.oben + BILD.markenZeile);
    expect(b.ticks.map((t) => t.text)).toEqual(['00:00', '06:00', '12:00', '18:00']);
    expect(bild(a, s, l, m, 1180).ticks).toHaveLength(8);
    expect(glatt(b.skala.text)).toBe('25,0 kWh');
    // Die Nulllinie ist der Boden: kein Balken ragt darunter.
    for (const x of b.balken) expect(x.y + x.h).toBeCloseTo(b.skala.nullY, 6);
  });
});

describe('uemsVerlauf · F13 · der 25-Stunden-Tag (O14)', () => {
  const a = f13Viertelstunden();
  const s = schritte(a);

  it('100 Viertelstunden, die doppelte mit MESZ und MEZ — wie der Vertrag', () => {
    gleichDemVektor(a, 'f13', 'Viertelstunde 02:15–02:30 MEZ');
    expect(s).toHaveLength(100);
    expect(s.map((x) => x.titel)).toContain('02:15–02:30 MESZ');
    expect(s.map((x) => x.titel)).toContain('02:15–02:30 MEZ');
    expect(s.every((x) => x.art === 'vollstaendig' && x.hoehe === 7.2)).toBe(true);
    expect(luecken(s)).toEqual([]);
    expect(marker(a, s, [])).toEqual([]);
  });

  it('die Achse nennt jede Wanduhr einmal, und der Kernaussage-Satz ist der der Karte', () => {
    expect(bild(a, s, [], [], 343).ticks.map((t) => t.text)).toEqual(['00:00', '06:00', '12:00', '18:00']);
    expect(glatt(kernaussage('tag', f13Tag())?.satz)).toBe('So 25.10.2026: 720 kWh · vollständig · endgültig');
  });
});

describe('uemsVerlauf · Marker (V5, K6)', () => {
  const zone = 'Europe/Berlin';

  it('höchstens drei im Bild, jeder in der Liste — nach Beginn geordnet', () => {
    const tag = '2026-11-03';
    const gaps = [2, 10, 20, 30, 40].map((i, n) => ({ i, e: { id: `e${n}`, art: 'data_gap', von: '', bis: null as string | null } }));
    const werte = viertelstundenDes(tag, (_b, i) => {
      const g = gaps.find((x) => x.i === i);
      return g ? { zustand: 'keine Werte', erhalten: 0, erwartet: 15, abdeckung_prozent: 0 } : voll(24.0, 15);
    }).map((w, i) => {
      const g = gaps.find((x) => x.i === i);
      return g ? { ...w, ereignisse: [{ ...g.e, von: w.von, bis: w.bis }] } : w;
    });
    const a = antwort(MS_10, 'viertelstunde', werte[0].von, werte[95].bis, werte);
    const s = schritte(a);
    const l = luecken(s);
    const m = marker(a, s, l);
    expect(m.map((x) => x.nummer)).toEqual([1, 2, 3, null, null]);
    expect(MARKER_IM_BILD).toBe(3);
    expect(bild(a, s, l, m, 343).marken).toHaveLength(3);
  });

  it('eine Lücke ohne verwiesenes Ereignis sagt „keine Werte von … bis …“ — ohne Ursache', () => {
    const a: MessstelleWerte = { ...f8Viertelstunden(), werte: f8Viertelstunden().werte.map((w) => ({ ...w, ereignisse: [] })) };
    const s = schritte(a);
    expect(marker(a, s, luecken(s)).map((x) => x.satz)).toEqual(['keine Werte von 03.11.2026 14:15 bis 17:30']);
  });

  it('braucht der Satz Felder, die die Route nicht liefert, steht der Name mit der Zeit — nie ein geratenes Feld', () => {
    // Der Box-Tausch der Zeitachse Ahrenberg: 04.11.2026 09:38–09:40.
    const tausch = markerSatz({ art: 'handover', von: '2026-11-04T09:38:00+01:00', bis: '2026-11-04T09:40:00+01:00' }, zone);
    expect(tausch).toBe(`${EREIGNIS_TEXTE.handover.name} von 04.11.2026 09:38 bis 09:40`);
    const wechsel = markerSatz({ art: 'device_boundary', von: '2026-11-18T10:40:00+01:00', bis: null }, zone);
    expect(wechsel).toBe(`${EREIGNIS_TEXTE.device_boundary.name} am 18.11.2026 10:40`);
    expect(markerSatz({ art: 'data_gap', von: '2026-11-03T14:00:00+01:00', bis: null }, zone)).toBe('Lücke seit 03.11.2026 14:00 — nie als 0 gerechnet');
    for (const satz of [tausch, wechsel]) expect(satz).not.toMatch(/undefined|\{/);
    expect(markerSatz({ art: 'gibt_es_nicht', von: '2026-11-04T09:38:00+01:00', bis: null }, zone)).toBeNull();
  });
});

describe('uemsVerlauf · Zeiträume (V1, V2)', () => {
  it('Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in Monaten — die Woche ohne Karte', () => {
    expect(zeitraumAnfragen('tag', '2026-10-25')).toEqual({
      karte: { raster: 'tag', von: '2026-10-25', bis: '2026-10-25' },
      liste: { raster: 'stunde', von: '2026-10-25', bis: '2026-10-25' },
      verlauf: { raster: 'viertelstunde', von: '2026-10-25', bis: '2026-10-25' },
    });
    expect(zeitraumAnfragen('woche', '2026-W43')).toEqual({
      karte: null,
      liste: { raster: 'tag', von: '2026-10-19', bis: '2026-10-25' },
      verlauf: { raster: 'stunde', von: '2026-10-19', bis: '2026-10-25' },
    });
    expect(zeitraumAnfragen('monat', '2026-10')).toEqual({
      karte: { raster: 'monat', von: '2026-10-01', bis: '2026-10-31' },
      liste: { raster: 'tag', von: '2026-10-01', bis: '2026-10-31' },
      verlauf: { raster: 'tag', von: '2026-10-01', bis: '2026-10-31' },
    });
    expect(zeitraumAnfragen('jahr', '2026')).toEqual({
      karte: { raster: 'jahr', von: '2026-01-01', bis: '2026-12-31' },
      liste: { raster: 'monat', von: '2026-01-01', bis: '2026-12-31' },
      verlauf: { raster: 'monat', von: '2026-01-01', bis: '2026-12-31' },
    });
    // Im Monat und im Jahr ist der Verlauf die Liste — EINE Anfrage.
    for (const z of ['monat', 'jahr'] as const) {
      const a = zeitraumAnfragen(z, z === 'monat' ? '2026-10' : '2026');
      expect(gleicheAnfrage(a.liste, a.verlauf), z).toBe(true);
    }
    for (const z of ['tag', 'woche'] as const) {
      const a = zeitraumAnfragen(z, z === 'tag' ? '2026-10-25' : '2026-W43');
      expect(gleicheAnfrage(a.liste, a.verlauf), z).toBe(false);
    }
    expect(zeitraumAnfragen('woche', '2026-W53').liste).toEqual({ raster: 'tag', von: '2026-12-28', bis: '2027-01-03' });
    expect(zeitraumAnfragen('monat', '2028-02').liste.bis).toBe('2028-02-29');
  });

  it('blättern und der Zeitraum eines Tages — über Monats- und Jahresgrenzen', () => {
    expect(wertAm('woche', '2026-10-25')).toBe('2026-W43');
    expect(wertAm('woche', '2027-01-01')).toBe('2026-W53');
    expect(wertAm('monat', '2026-10-25')).toBe('2026-10');
    expect(wertAm('jahr', '2026-10-25')).toBe('2026');
    expect(blaettere('tag', '2026-10-31', 1)).toBe('2026-11-01');
    expect(blaettere('woche', '2026-W53', 1)).toBe('2027-W01');
    expect(blaettere('woche', '2026-W01', -1)).toBe('2025-W52');
    expect(blaettere('monat', '2026-12', 1)).toBe('2027-01');
    expect(blaettere('monat', '2026-01', -1)).toBe('2025-12');
    expect(blaettere('jahr', '2026', -1)).toBe('2025');
    expect(heuteOderSpaeter('woche', '2026-W44', '2026-10-26')).toBe(true);
    expect(heuteOderSpaeter('woche', '2026-W43', '2026-10-26')).toBe(false);
    expect(heuteOderSpaeter('jahr', '2026', '2026-10-26')).toBe(true);
  });

  it('die Woche: 169 Stunden am Ende der Sommerzeit, der Titel nennt den Tag; keine Zahl für die Woche, und warum', () => {
    const w = grundlastWoche('2026-10-19', '2026-10-26');
    const s = schritte(w.stunden);
    expect(s).toHaveLength(169);
    expect(s.map((x) => x.titel)).toContain('So 25.10. 02:00–03:00 MEZ');
    expect(bild(w.stunden, s, [], [], 343).ticks.map((t) => t.text)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    expect(kernaussage('woche', null)).toEqual({ wert: null, satz: null, grund: UEMS_WOCHE_OHNE_ZAHL, ton: 'calm' });
  });

  it('das Jahr: bis September „keine Werte“ als EINE Fläche mit Satz, Oktober mit Zahl, der Rest noch nicht gerechnet', () => {
    const j = jahr2026('2026-11-10');
    const s = schritte(j.monate);
    const l = luecken(s);
    expect(s.map((x) => x.art)).toEqual([...Array(9).fill('keine_werte'), 'vollstaendig', 'ohne', 'ohne']);
    expect(l).toEqual([{ erster: 0, letzter: 8, verwiesen: false }]);
    expect(marker(j.monate, s, l).map((x) => x.satz)).toEqual(['keine Werte von Januar 2026 bis September 2026']);
    expect(tooltipSatz(s[10])).toBe('November 2026: —, noch nicht gerechnet.');
    expect(kernaussage('jahr', j.karte)).toMatchObject({ satz: null, grund: '2026: — · noch nicht gerechnet' });
    expect(glatt(kernaussage('monat', f16Monat())?.satz)).toBe('Oktober 2026: 55.100 kWh · vollständig · vorläufig');
    expect(bild(j.monate, s, l, [], 343).ticks.map((t) => t.text)).toEqual(['Jan', 'Apr', 'Jul', 'Okt']);
  });
});

describe('uemsVerlauf · kleine Regeln', () => {
  it('„erhalten von erwartet“ mit Tausenderpunkt und Einzahl', () => {
    expect(erhaltenText({ erhalten: 1230, erwartet: 1440 })).toBe('1.230 von 1.440 Werten');
    expect(erhaltenText({ erhalten: 1, erwartet: 1 })).toBe('1 von 1 Wert');
    expect(erhaltenText({ erhalten: null, erwartet: 15 })).toBeNull();
  });

  it('ein nicht gesprochener Schritt hat keinen Balken und keine Zählung', () => {
    const a = antwort(MS_10, 'viertelstunde', '2026-11-05T00:00:00+01:00', '2026-11-05T00:15:00+01:00', [
      schritt({ von: '2026-11-05T00:00:00+01:00', bis: '2026-11-05T00:15:00+01:00', beschriftung: '00:00–00:15', grund: 'noch_nicht_gebildet', erhalten: 3, erwartet: 15 }),
    ]);
    expect(schritte(a)[0]).toMatchObject({ art: 'ohne', hoehe: null, erhalten: null });
  });

  it('die Skala rundet nur fürs Bild', () => {
    expect([24, 28.8, 7.2, 691.2, 55100, 0].map(skalaOben)).toEqual([25, 30, 8, 800, 60000, 0]);
  });
});
