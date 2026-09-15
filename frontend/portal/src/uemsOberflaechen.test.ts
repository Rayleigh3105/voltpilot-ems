import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleGroesse } from './api';
import { EBENEN_SEITEN, type EbenenLesemodell, type EbenenSeiten } from './ebenenNav';
import { parseRoute, standortRoute } from './nav';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import { GRUENDE, raster } from './uemsErgebnis';
import {
  VERGLEICH_HOECHSTENS,
  ZEITRAEUME,
  kacheln,
  passend,
  passendSatz,
  sprungziel,
  verlaufRaster,
  weitereWaehlbar,
  zoneSatz,
} from './uemsOberflaechen';

/**
 * Das reine Modul der Oberflächen (UEMS AP-13 IP-1) gegen die Referenzfälle O1…O19 — die Portal-Kopie
 * `test/oberflaechenFaelle.json` ist Byte für Byte `referenzfaelle.json` des Konzepts. Die Kopie und der Ergebnis-Vertrag
 * dürfen nie auseinanderlaufen: der Gleichheitstest liest beide.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const KOPIE = resolve(process.cwd(), 'src/test/oberflaechenFaelle.json');
const faelle: Json = JSON.parse(readFileSync(KOPIE, 'utf8'));
const vektoren: Json = JSON.parse(readFileSync(resolve(V2, 'ergebnis-zustand-vectors.json'), 'utf8'));
const referenz: Json = JSON.parse(readFileSync(resolve(V2, 'uems-referenzunternehmen.json'), 'utf8'));
const fall = (id: string): Json => {
  const f = faelle.faelle.find((x: Json) => x.id === id);
  if (!f) throw new Error(`kein Fall ${id}`);
  return f;
};

/**
 * sha256 von `data/vp-uems-ap13-oberflaechen/referenzfaelle.json` am 15.09.2026. Ändert das Konzept seine Fälle, wird die
 * Datei neu KOPIERT und dieser Wert mit ihr — nie die Kopie von Hand bearbeitet.
 */
const REFERENZFAELLE_SHA256 = '48bc8ef1a469cb877cdd0640ac2901e055cde78d8f56bc67b8ce7688ead62d42';

/**
 * Die drei `grund`-Sätze, deren Wortlaut der Vertrag bewusst NICHT aus O15 übernimmt (firstmate 001 vom 15.09.2026 = A;
 * `data/vp-uems-ap13-oberflaechen/befunde-ip1.md`) — je mit der Stelle im Block `befunde`, die den O15-Wortlaut zitiert.
 * Eine vierte Abweichung oder eine stillschweigend zurückgenommene macht den Gleichheitstest rot.
 */
const ABWEICHUNGEN: Record<string, string> = {
  berechnet: 'grund.berechnet',
  noch_nicht_gebildet: 'grund.noch_nicht_gebildet',
  ohne_menge_gespeichert: 'grund.ohne_menge_gespeichert',
};

describe('Gleichheit: die Portal-Kopie der Referenzfälle und der Ergebnis-Vertrag', () => {
  it('die Kopie ist Byte für Byte referenzfaelle.json (19 Fälle, Stand 15.09.2026)', () => {
    expect(createHash('sha256').update(readFileSync(KOPIE)).digest('hex')).toBe(REFERENZFAELLE_SHA256);
    expect(faelle.faelle.map((f: Json) => f.id)).toEqual(Array.from({ length: 19 }, (_, i) => `O${i + 1}`));
  });

  it('O15 und der Block `grund` nennen dieselben acht Codes in derselben Reihenfolge', () => {
    const o15 = fall('O15');
    const codes = vektoren.grund.saetze.map((s: Json) => s.code);
    expect(o15.gegeben.codes).toEqual(codes);
    expect(faelle.vokabulare['grund (ergebnis-zustand, additiv — E11)']).toEqual(codes);
    expect(Object.keys(o15.gegeben.saetze)).toEqual(codes);
    expect(Object.keys(o15.gegeben.beispiele)).toEqual(codes);
    expect(o15.erwartet.saetze_anzahl).toBe(GRUENDE.length);
  });

  it('O15 (die acht Sätze): Wortlaut und Beispiel sind gleich — bis auf GENAU die drei benannten Abweichungen', () => {
    const o15 = fall('O15').gegeben;
    const anders = (vektoren.grund.saetze as Json[])
      .filter((s) => o15.saetze[s.code] !== s.muster || o15.beispiele[s.code].satz !== s.beispiel)
      .map((s) => s.code);
    expect(anders).toEqual(Object.keys(ABWEICHUNGEN));
    for (const [code, stelle] of Object.entries(ABWEICHUNGEN)) {
      const befund = (vektoren.befunde as Json[]).find((b) => b.stelle === stelle);
      expect(befund, stelle).toBeDefined();
      // Der Befund zitiert den Vorschlag, den er nicht übernimmt — so bleibt er beim nächsten Paket auffindbar.
      expect(befund.befund, stelle).toContain((o15.saetze[code] as string).replace(/\.$/, ''));
    }
  });
});

describe('uemsOberflaechen · passend (E6) — O12', () => {
  const haupt = (kennzeichen: string): MessstelleGroesse => {
    const h = referenz.messstellen.find((m: Json) => m.kennzeichen === kennzeichen).hauptgroesse;
    return { groesse: h.groesse, richtung: h.richtung, einheit: h.einheit, wertart: h.wertart };
  };
  const basis = haupt('MS-06');

  it('Spritzguss MS-06 und MS-11 sind passend; Speicher, Gas und PV nicht', () => {
    const o12 = fall('O12').gegeben;
    const urteil = Object.fromEntries(Object.keys(o12.passend).map((kz) => [kz, passend(basis, haupt(kz)).passend]));
    expect(urteil).toEqual(o12.passend);
    expect(passendSatz(passend(basis, haupt('MS-11')))).toBeNull();
  });

  it('der Picker nennt den Grund in den Wörtern des Messstellen-Vertrags', () => {
    const picker = fall('O12').schritte[0] as string;
    expect(passendSatz(passend(basis, haupt('MS-21')))).toBe('nicht passend: Volumen in m³');
    expect(picker).toContain('nicht passend: Volumen in m³');
    expect(passendSatz(passend(basis, haupt('MS-03')))).toBe('nicht passend: Erzeugung');
    expect(picker).toContain('nicht passend: Erzeugung');
    // Nebenbefund (befunde-ip1.md): O12 schreibt „Laden/Entladen“, das Vokabular „Laden / Entladen“.
    expect(passendSatz(passend(basis, haupt('MS-04')))).toBe('nicht passend: Laden / Entladen');
    expect(picker).toContain('nicht passend: Laden/Entladen');
  });

  it('der erste Unterschied nennt den Grund: Größe vor Richtung vor Einheit vor Wertart', () => {
    expect(passend(basis, haupt('MS-21'))).toEqual({ passend: false, teil: 'groesse', grund: 'Volumen in m³' });
    // MS-03 unterscheidet sich in Richtung UND Wertart — genannt wird die Richtung.
    expect(passend(basis, haupt('MS-03'))).toEqual({ passend: false, teil: 'richtung', grund: 'Erzeugung' });
    expect(passend(basis, { ...basis, einheit: 'MWh' })).toEqual({ passend: false, teil: 'einheit', grund: 'in MWh' });
    expect(passend(basis, { ...basis, wertart: 'Intervallmenge' })).toEqual({ passend: false, teil: 'wertart', grund: 'Intervallmenge' });
  });

  it('höchstens drei Reihen in einem Bild', () => {
    expect(VERGLEICH_HOECHSTENS).toBe(fall('O12').gegeben.hoechstens_reihen);
    expect(weitereWaehlbar(1)).toBe(true);
    expect(weitereWaehlbar(2)).toBe(true);
    expect(weitereWaehlbar(3)).toBe(false);
  });
});

describe('uemsOberflaechen · Kacheln je Lesemodell über ebenenBereiche — O17', () => {
  const UNTERNEHMEN = { art: 'unternehmen' } as const;
  const WERK = { art: 'standort', standortId: FIXTURE_IDS.st1 } as const;
  const LINDACH = { art: 'standort', standortId: FIXTURE_IDS.st2 } as const;
  /** Ahrenberg am 20.10.2026: zwei Standorte, beide messen, Kennzahlen aus dem Referenzunternehmen. */
  const MESSKUNDE: EbenenLesemodell = {
    standorte: [werkAhrenberg(), werkLindach()],
    funktionen: ahrenbergFunktionen(),
    kennzahlen: ahrenbergKennzahlen(),
  };
  const BETRIEBSKUNDE: EbenenLesemodell = { ...MESSKUNDE, funktionen: ahrenbergFunktionen({ messen: 'bestand' }), kennzahlen: [] };
  /** Das Bild, sobald IP-2 Gebäude und Anlagen des Standorts einhängt — nur, um O17 „nach IP-2“ zu prüfen. */
  const NACH_IP2: EbenenSeiten = (ort) =>
    ort.art === 'standort'
      ? { ...EBENEN_SEITEN(ort), gebaeude: standortRoute(ort.standortId), anlagen: standortRoute(ort.standortId) }
      : EBENEN_SEITEN(ort);

  it('Unternehmen: fünf Bereiche, fünf Kacheln, Leiste', () => {
    const g = fall('O17').gegeben;
    const u = kacheln(UNTERNEHMEN, MESSKUNDE);
    expect(u).toEqual({ bereiche: g.bereiche_u, kacheln: g.kacheln_u, leiste: g.leiste_u });
    expect(u.kacheln).toHaveLength(fall('O17').erwartet.kacheln_u);
  });

  it('Werk Ahrenberg heute: vier Bereiche, zwei Kacheln (Reiter), keine Leiste', () => {
    const g = fall('O17').gegeben;
    expect(kacheln(WERK, MESSKUNDE)).toEqual({ bereiche: g.bereiche_st1, kacheln: g.kacheln_st1_heute, leiste: g.leiste_st1_heute });
  });

  it('nach IP-2: Werk Ahrenberg vier Kacheln, Werk Lindach drei — beide mit Leiste', () => {
    const g = fall('O17').gegeben;
    const werk = kacheln(WERK, MESSKUNDE, NACH_IP2);
    expect(werk).toEqual({ bereiche: g.bereiche_st1, kacheln: g.kacheln_st1_nach_ip2, leiste: g.leiste_st1_nach_ip2 });
    expect(werk.kacheln).toHaveLength(fall('O17').erwartet.kacheln_st1);
    const lindach = kacheln(LINDACH, MESSKUNDE, NACH_IP2);
    expect([lindach.kacheln, lindach.leiste]).toEqual([g.kacheln_st2_nach_ip2, g.leiste_st2_nach_ip2]);
  });

  it('O18: ein reiner Betriebskunde hat heute auf keiner Ebene eine Leiste', () => {
    for (const ort of [UNTERNEHMEN, WERK, LINDACH]) expect(kacheln(ort, BETRIEBSKUNDE).leiste).toBe(false);
  });
});

describe('uemsOberflaechen · Sprungziel (E10, D1–D3) — O10', () => {
  it('die Herkunfts-Zeile „MS-12“ springt zur Messstellen-Seite mit Periode und Version', () => {
    const o10 = fall('O10');
    const s = sprungziel({ art: 'messstelle', id: 'MS-12', periode: '2026-10', version: 2 });
    expect(s?.hash).toBe(o10.gegeben.sprungziel);
    expect(o10.erwartet.herkunft_sprung).toBe(`MS-12 → ${s?.hash}`);
    // Die Parameter stören die heutige Adresse nicht: sie liest dieselbe Seite.
    expect(parseRoute(s!.hash)).toEqual(s!.route);
  });

  it('aus dem Bereich eines Standorts bleibt der Sprung im Standort; ohne Periode kein Parameter', () => {
    const s = sprungziel({ art: 'messstelle', id: 'MS-12', standortId: FIXTURE_IDS.st1 });
    expect(s?.hash).toBe(`#/standort/${FIXTURE_IDS.st1}/messstellen/MS-12`);
    expect(parseRoute(s!.hash)).toEqual(s!.route);
    expect(sprungziel({ art: 'messstelle', id: 'MS-12', periode: '2026-10' })?.hash).toBe('#/portfolio/messstellen/MS-12?periode=2026-10');
  });

  it('Kennzahl, Bericht und Gerät haben ihre Seite', () => {
    expect(sprungziel({ art: 'kennzahl', id: 'KZ-0001' })?.hash).toBe('#/portfolio/kennzahlen/KZ-0001');
    expect(sprungziel({ art: 'bericht', kennung: 'BR-2026-0001' })?.hash).toBe('#/portfolio/berichte/BR-2026-0001');
    const geraet = sprungziel({ art: 'geraet', siteId: 'site-1', ref: 'edge-k7m2xqp', geraetId: 'inverter' });
    expect(geraet && parseRoute(geraet.hash)).toEqual(geraet?.route);
  });

  it('ohne Seite bleibt die Zeile Text: Bezugsgröße BZ-6, Ereignis, Box — und bis IP-9/IP-2 Kostenstelle und Gebäude', () => {
    expect(fall('O10').erwartet.bz6_ist_sprung).toBe(false);
    expect(sprungziel({ art: 'bezugsgroesse', kennzeichen: 'BZ-6' })).toBeNull();
    const ohne = faelle.vokabulare['ohne_sprung_bis (Befunde)'] as string[];
    for (const art of ['bezugsgroesse', 'ereignis', 'box'] as const) {
      expect(ohne.some((z) => z.startsWith(`${art} `)), art).toBe(true);
      expect(sprungziel({ art, kennzeichen: 'X-1' }), art).toBeNull();
    }
    expect(sprungziel({ art: 'kostenstelle', kennzeichen: '4200' })).toBeNull();
    expect(sprungziel({ art: 'gebaeude', kennzeichen: 'G-1' })).toBeNull();
  });
});

describe('uemsOberflaechen · Zeitraum → Raster (E5) und Zone-Satz (E12) — O1, O14', () => {
  it('Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in Monaten', () => {
    expect(ZEITRAEUME.map((z) => `${z} → ${verlaufRaster(z)}`)).toEqual(faelle.vokabulare['zeitraeume_verlauf (E5)']);
  });

  it('O1: der 03.11.2026 hat 96 Viertelstunden; O14: der 25.10.2026 hat 25 Stunden mit der doppelten Stunde', () => {
    const o1 = fall('O1').gegeben;
    expect(raster(o1.tag, o1.zone, verlaufRaster('tag'))).toHaveLength(96);
    const o14 = fall('O14');
    const stunden = raster(o14.gegeben.tag, o14.gegeben.zone, 'stunde').map((f) => f.beschriftung);
    expect(stunden).toHaveLength(o14.erwartet.stunden_zeilen);
    for (const zeile of o14.erwartet.doppelte_stunde as string[]) expect(stunden).toContain(zeile.split(' · ')[0]);
    // Nebenbefund (befunde-ip1.md): O14 zeichnet „25 Balken“ — der Tag im Raster von E5 hat 100 Viertelstunden.
    expect(raster(o14.gegeben.tag, o14.gegeben.zone, verlaufRaster('tag'))).toHaveLength(100);
  });

  it('der Kopf nennt die Zone der Antwort und ihre Herkunft', () => {
    expect(fall('O1').erwartet.kopf.endsWith(` · ${zoneSatz('Europe/Berlin', 'standort', 'Werk Ahrenberg')}`)).toBe(true);
    const o14 = fall('O14');
    expect(o14.erwartet.kopf).toBe(`Sonntag, 25.10.2026 · ${zoneSatz(o14.gegeben.zone, o14.gegeben.zeitzone_herkunft, 'Werk Ahrenberg')}`);
    expect(zoneSatz('Europe/Vienna', 'unternehmen', 'Werk Ahrenberg')).toBe('Zeiten in Europe/Vienna (Zeitzone des Unternehmens)');
    expect(zoneSatz('Europe/Berlin', 'vorgabe')).toBe('Zeiten in Europe/Berlin (Vorgabe)');
    expect(o14.schritte[0]).toContain('„(Zeitzone des Unternehmens)“');
    expect(o14.schritte[0]).toContain('„(Vorgabe)“');
  });
});
