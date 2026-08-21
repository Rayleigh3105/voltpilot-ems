import { describe, expect, it } from 'vitest';
import { anlagenOptionen, ALLE_ANLAGEN, nebenzeile, punktFuer } from './anlagenWahl';
import type { Site } from './api';
import type { Device } from './api';

const JETZT = new Date('2026-08-21T10:00:00Z').getTime();

const site = (id: string, name: string, zone = 'DE-LU', lat: number | null = 48.879): Site => ({
  id,
  name,
  biddingZone: zone,
  latitude: lat,
  longitude: lat == null ? null : 10.771,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
});

const device = (id: string, siteId: string, lastSeenAt: string | null): Device => ({
  id,
  siteId,
  externalRef: `edge-${id}`,
  kind: 'inverter',
  name: null,
  lastSeenAt,
});

const SITES = [site('a', 'Auernheim'), site('b', 'Hof Lindenberg'), site('c', 'Solarpark Dachau')];

/** Ein Gerät, das gerade gemeldet hat, und eines, das seit Stunden schweigt. */
const DEVICES = {
  devices: [
    device('d1', 'a', '2026-08-21T09:59:00Z'),
    device('d2', 'b', '2026-08-21T04:00:00Z'),
  ],
  fetchedAt: JETZT,
};

describe('der Gesundheits-Punkt kommt aus DERSELBEN Ableitung wie die Kopfzeile', () => {
  it('markiert eine gesunde Anlage grün und eine stille bernstein', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.find((x) => x.value === 'a')?.dot).toBe('ok');
    expect(o.find((x) => x.value === 'b')?.dot).toBe('warn');
  });

  it('trägt den Gesundheits-SATZ als Nebenzeile', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.find((x) => x.value === 'a')?.sub).toContain('Alles in Ordnung');
    expect(o.find((x) => x.value === 'b')?.sub).toBeTruthy();
  });

  it('behauptet OHNE geladene Geräteliste GAR NICHTS', () => {
    // Kein Bezugspunkt = keine Lebendigkeit; ein grüner Punkt wäre erfunden.
    const o = anlagenOptionen({
      sites: SITES,
      devices: { devices: [], fetchedAt: null },
      mitFlotte: false,
      now: JETZT,
    });
    expect(o.every((x) => x.dot == null)).toBe(true);
    expect(o.every((x) => x.sub == null)).toBe(true);
  });
});

describe('der ORT steht nur da, wo er UNTERSCHEIDET', () => {
  it('bleibt in einer Ein-Land-Flotte weg - sonst stünde auf jeder Zeile dasselbe Wort', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.find((x) => x.value === 'a')?.sub).not.toContain('Deutschland');
  });

  it('erscheint, sobald die Flotte mehrere Länder umfasst', () => {
    const gemischt = [SITES[0], site('ch', 'Werk Zürich', 'CH')];
    const o = anlagenOptionen({ sites: gemischt, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.find((x) => x.value === 'a')?.sub).toContain('Deutschland');
    expect(o.find((x) => x.value === 'ch')?.sub).toContain('Schweiz');
  });

  it('rendert NIE Koordinaten - sie sind keine Ortsangabe für einen Kunden', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.map((x) => x.sub ?? '').join(' ')).not.toContain('48,8');
  });

  it('macht sie aber DURCHSUCHBAR - wer danach sucht, findet', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.find((x) => x.value === 'a')?.keywords).toContain('48.879');
    expect(o.find((x) => x.value === 'a')?.keywords).toContain('Deutschland');
  });
});

describe('„Alle Anlagen"', () => {
  it('steht ganz oben und trägt KEINEN Punkt - es ist ein Ortswechsel, kein Zustand', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: true, now: JETZT });
    expect(o[0].value).toBe(ALLE_ANLAGEN);
    expect(o[0].dot).toBeUndefined();
    expect(o[0].sub).toBe('Zurück zur Übersicht');
  });

  it('fehlt ohne Flotten-Ebene', () => {
    const o = anlagenOptionen({ sites: SITES, devices: DEVICES, mitFlotte: false, now: JETZT });
    expect(o.some((x) => x.value === ALLE_ANLAGEN)).toBe(false);
  });
});

describe('die Bausteine', () => {
  it('bildet die drei Zustände auf Punkte ab und behauptet ohne Urteil nichts', () => {
    expect(punktFuer('ok')).toBe('ok');
    expect(punktFuer('warnung')).toBe('warn');
    expect(punktFuer('hinweis')).toBe('off');
    expect(punktFuer(null)).toBeNull();
  });

  it('fügt nur zusammen, was da ist', () => {
    expect(nebenzeile('Alles in Ordnung', 'Deutschland')).toBe('Alles in Ordnung · Deutschland');
    expect(nebenzeile('Alles in Ordnung', null)).toBe('Alles in Ordnung');
    expect(nebenzeile(null, 'Deutschland')).toBe('Deutschland');
    expect(nebenzeile(null, null)).toBeNull();
  });
});
