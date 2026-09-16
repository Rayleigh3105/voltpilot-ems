import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleGroesse, MessstelleWerteRaster } from './api';
import { EBENEN_SEITEN, type EbenenLesemodell, type EbenenSeiten } from './ebenenNav';
import { parseRoute } from './nav';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import { GRUENDE, raster } from './uemsErgebnis';
import {
  ABLEHNUNG_GRUENDE,
  HOECHSTENS_SCHRITTE,
  HOECHSTENS_STUNDEN,
  MESSSTELLE_GIBT_ES_NICHT,
  OHNE_HAUPTZAEHLER,
  VERGLEICH_HOECHSTENS,
  VERSION_UNLESBAR,
  WERT_NICHT_MEHR_GESPEICHERT,
  ZEITRAEUME,
  ZEITRAUM_UNLESBAR_OHNE_GRUND,
  COCKPIT_WEG_TITEL,
  auskunft,
  cockpitWeg,
  herkunftsZeile,
  kennzeichenImText,
  kennzeichenSprung,
  periodeSchluessel,
  vergleichOhnePassende,
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
  /** Das Bild VOR AP-13 IP-2: am Standort hatten nur Übersicht und Messstellen eine Seite (O17 „heute“ im Konzept). */
  const VOR_IP2: EbenenSeiten = (ort) =>
    ort.art === 'standort'
      ? { uebersicht: EBENEN_SEITEN(ort).uebersicht, messstellen: EBENEN_SEITEN(ort).messstellen }
      : EBENEN_SEITEN(ort);

  it('Unternehmen: fünf Bereiche, fünf Kacheln, Leiste', () => {
    const g = fall('O17').gegeben;
    const u = kacheln(UNTERNEHMEN, MESSKUNDE);
    expect(u).toEqual({ bereiche: g.bereiche_u, kacheln: g.kacheln_u, leiste: g.leiste_u });
    expect(u.kacheln).toHaveLength(fall('O17').erwartet.kacheln_u);
  });

  it('Werk Ahrenberg vor IP-2: vier Bereiche, zwei Kacheln (Reiter), keine Leiste', () => {
    const g = fall('O17').gegeben;
    expect(kacheln(WERK, MESSKUNDE, VOR_IP2)).toEqual({ bereiche: g.bereiche_st1, kacheln: g.kacheln_st1_heute, leiste: g.leiste_st1_heute });
  });

  it('seit IP-2 (die Seiten von heute): Werk Ahrenberg vier Kacheln, Werk Lindach drei — beide mit Leiste', () => {
    const g = fall('O17').gegeben;
    const werk = kacheln(WERK, MESSKUNDE);
    expect(werk).toEqual({ bereiche: g.bereiche_st1, kacheln: g.kacheln_st1_nach_ip2, leiste: g.leiste_st1_nach_ip2 });
    expect(werk.kacheln).toHaveLength(fall('O17').erwartet.kacheln_st1);
    const lindach = kacheln(LINDACH, MESSKUNDE);
    expect([lindach.kacheln, lindach.leiste]).toEqual([g.kacheln_st2_nach_ip2, g.leiste_st2_nach_ip2]);
  });

  it('O18: ein reiner Betriebskunde ohne Gebäude hat auf keiner Ebene eine Leiste', () => {
    const g = fall('O18').gegeben;
    const betrieb: EbenenLesemodell = {
      standorte: [werkAhrenberg({ gebaeudeZahl: 0 })],
      funktionen: ahrenbergFunktionen({ messen: 'bestand' }),
      kennzahlen: [],
    };
    expect(kacheln(UNTERNEHMEN, betrieb).bereiche).toEqual(g.betriebskunde_bereiche_u);
    expect(kacheln(WERK, betrieb).bereiche).toEqual(g.betriebskunde_bereiche_st);
    for (const ort of [UNTERNEHMEN, WERK]) expect(kacheln(ort, betrieb).leiste).toBe(g.betriebskunde_leiste);
    // Zwei Standorte ohne Messen: am Unternehmen Übersicht · Standorte — ebenfalls keine Leiste.
    expect(kacheln(UNTERNEHMEN, BETRIEBSKUNDE).leiste).toBe(false);
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

  it('seit IP-9 hat die Kostenstelle ihre Karte: Reiter „Kostenstellen“ der Welt Messstellen, mit Zeitraum', () => {
    const ohneZeit = sprungziel({ art: 'kostenstelle', kennzeichen: '4200' });
    expect(ohneZeit?.hash).toBe('#/portfolio/messstellen?reiter=kostenstellen&kostenstelle=4200');
    expect(ohneZeit && parseRoute(ohneZeit.hash)).toEqual(ohneZeit?.route);
    expect(sprungziel({ art: 'kostenstelle', kennzeichen: '4300', periode: 'monat', am: '2026-10-01' })?.hash).toBe(
      '#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01&kostenstelle=4300',
    );
  });

  it('ohne Seite bleibt die Zeile Text: Bezugsgröße BZ-6, Ereignis, Box — und bis IP-11 das Gebäude', () => {
    expect(fall('O10').erwartet.bz6_ist_sprung).toBe(false);
    expect(sprungziel({ art: 'bezugsgroesse', kennzeichen: 'BZ-6' })).toBeNull();
    const ohne = faelle.vokabulare['ohne_sprung_bis (Befunde)'] as string[];
    for (const art of ['bezugsgroesse', 'ereignis', 'box'] as const) {
      expect(ohne.some((z) => z.startsWith(`${art} `)), art).toBe(true);
      expect(sprungziel({ art, kennzeichen: 'X-1' }), art).toBeNull();
    }
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

describe('UEMS AP-13 IP-6 · Auskunft statt Fehlermeldung (Z2, Z3, §5.8) und die Leerzustände Vergleich und Energiebilanz (Z4)', () => {
  const abgelehnt = (grund: string, feld: string | null, raster: MessstelleWerteRaster = 'tag') =>
    auskunft(400, { code: 'anfrage_ungueltig', message: 'Satz des Servers', feld, grund }, raster);
  const JAVA = readFileSync(resolve(process.cwd(), '../../services/api/src/main/java/com/voltpilot/api/uems/MessstelleWerteRegeln.java'), 'utf8');

  it('die Gründe sind die der Route: `MessstelleWerteRegeln.Grund` ohne die zwei der Versions-Historie, in derselben Reihenfolge, und dieselben Grenzen', () => {
    const beginn = JAVA.indexOf('public enum Grund');
    const block = JAVA.slice(beginn, JAVA.indexOf('private final String wort', beginn));
    const woerter = [...block.matchAll(/[A-Z_]+\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(woerter.filter((w) => w !== 'raster_ohne_versionen' && w !== 'nicht_genau_eine_periode')).toEqual([...ABLEHNUNG_GRUENDE]);
    expect(JAVA).toContain(`return r == Raster.STUNDE ? ${HOECHSTENS_STUNDEN} : ${HOECHSTENS_SCHRITTE};`);
  });

  it('jede der acht 400-Ablehnungen hat ihren Satz — mit dem Feld der Antwort und der Grenze der Anfrage, nie „konnte nicht geladen werden“', () => {
    const faelle: Array<[string, string, MessstelleWerteRaster, string]> = [
      ['fehlt', 'von', 'tag', 'Der Zeitraum konnte nicht gelesen werden (Beginn fehlt). Wählen Sie einen anderen Zeitraum.'],
      ['raster_unbekannt', 'raster', 'tag', 'Der Zeitraum konnte nicht gelesen werden (diese Einteilung gibt es nicht). Wählen Sie einen anderen Zeitraum.'],
      ['form', 'bis', 'tag', 'Der Zeitraum konnte nicht gelesen werden (Ende ist kein gültiges Datum). Wählen Sie einen anderen Zeitraum.'],
      ['nicht_im_raster', 'von', 'tag', 'Der Zeitraum konnte nicht gelesen werden (Beginn liegt nicht auf einer Tagesgrenze). Wählen Sie einen anderen Zeitraum.'],
      ['von_nicht_vor_bis', 'bis', 'tag', 'Der Zeitraum konnte nicht gelesen werden (Beginn liegt nicht vor dem Ende). Wählen Sie einen anderen Zeitraum.'],
      ['ausserhalb', 'von', 'tag', 'Der Zeitraum konnte nicht gelesen werden (Beginn liegt vor 2000 oder nach 2100). Wählen Sie einen anderen Zeitraum.'],
      ['zu_viele_schritte', 'bis', 'viertelstunde', 'Dieser Zeitraum hat zu viele Schritte (höchstens 2.200, in Stunden 550). Wählen Sie einen kürzeren Zeitraum.'],
      ['version_ungueltig', 'version', 'tag', VERSION_UNLESBAR],
    ];
    expect(faelle.map((f) => f[0])).toEqual([...ABLEHNUNG_GRUENDE]);
    for (const [grund, feld, raster, satz] of faelle) {
      expect(abgelehnt(grund, feld, raster), grund).toEqual({ art: 'abgelehnt', satz, neueste: grund === 'version_ungueltig' });
    }
    // §5.8 nennt das Beispiel wörtlich; die Grenze folgt der Einteilung der Anfrage.
    expect(abgelehnt('nicht_im_raster', 'bis', 'monat')).toMatchObject({ satz: expect.stringContaining('(Ende liegt nicht auf einer Monatsgrenze)') });
  });

  it('ein fremder Grund, ein fehlendes Feld oder ein anderer Code: der Satz ohne Klammer — keine geratene Ursache', () => {
    expect(abgelehnt('fehlt', null)).toEqual({ art: 'abgelehnt', satz: ZEITRAUM_UNLESBAR_OHNE_GRUND, neueste: false });
    expect(abgelehnt('ganz_neu', 'von')).toEqual({ art: 'abgelehnt', satz: ZEITRAUM_UNLESBAR_OHNE_GRUND, neueste: false });
    expect(auskunft(400, { code: 'anderes', grund: 'version_ungueltig' }, 'tag')).toEqual({ art: 'abgelehnt', satz: ZEITRAUM_UNLESBAR_OHNE_GRUND, neueste: false });
    expect(auskunft(400, undefined, 'tag')).toEqual({ art: 'abgelehnt', satz: ZEITRAUM_UNLESBAR_OHNE_GRUND, neueste: false });
  });

  it('Z3 · 404 ohne Code — die Route kennt die Messstelle nicht oder sie gehört einem anderen: „gibt es nicht“', () => {
    expect(auskunft(404, { status: 404, error: 'Not Found', message: 'Messstelle nicht gefunden.' }, 'tag')).toEqual({
      art: 'gibt_es_nicht',
      satz: MESSSTELLE_GIBT_ES_NICHT,
    });
    expect(auskunft(404, undefined, 'monat')).toEqual({ art: 'gibt_es_nicht', satz: MESSSTELLE_GIBT_ES_NICHT });
  });

  it('O19 · 404 `wert_nicht_mehr_gespeichert`: der Fristen-Satz der Route — der Sprung zum Berichtsstand ist `null`, bis AP-12 IP-16 gebaut ist', () => {
    // AP-12 §5.8 / O19: am 02.11.2036 hält Berichtsstand Nr. 1 vom 10.11.2026 den Oktober 2026 von MS-12.
    const satz = 'Der Wert vom Oktober 2026 wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. 1 vom 10.11.2026 hält ihn fest.';
    expect(fall('O19').titel ?? JSON.stringify(fall('O19'))).toContain('wert_nicht_mehr_gespeichert');
    expect(auskunft(404, { code: 'wert_nicht_mehr_gespeichert', message: satz }, 'monat')).toEqual({ art: 'nicht_mehr_gespeichert', satz, sprung: null });
    // Ohne Satz der Route der Satz ohne Berichtsstand — nie „gibt es nicht“, die Messstelle gibt es ja.
    expect(auskunft(404, { code: 'wert_nicht_mehr_gespeichert' }, 'monat')).toEqual({
      art: 'nicht_mehr_gespeichert',
      satz: WERT_NICHT_MEHR_GESPEICHERT,
      sprung: null,
    });
    // ⚠ Heute sendet die Werte-Route diesen Code NICHT (AP-12 IP-16 ist offen): jede 404 der Route ist heute „gibt es nicht“.
  });

  it('Z5 · Server nicht erreichbar, 5xx oder ein anderer Status: eine Störung — nur sie bekommt „Erneut versuchen“', () => {
    for (const status of [null, 500, 502, 503]) expect(auskunft(status, undefined, 'tag')).toEqual({ art: 'nicht_abrufbar' });
  });

  it('Z4 · Vergleich ohne passende Messstelle: der Satz von §5.8, ohne Knopf — sobald eine passt, kein Leerzustand', () => {
    const basis: MessstelleGroesse = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' };
    const gas: MessstelleGroesse = { groesse: 'Volumen', richtung: 'Bezug', einheit: 'm³', wertart: 'Zählerstand' };
    const speicher: MessstelleGroesse = { ...basis, richtung: 'Laden / Entladen' };
    expect(vergleichOhnePassende(basis, [gas, speicher])).toEqual({
      titel: 'Keine passende Messstelle',
      satz: 'Keine weitere Messstelle misst Wirkenergie Bezug in kWh.',
      schritt: null,
    });
    expect(vergleichOhnePassende(basis, [])).not.toBeNull();
    expect(vergleichOhnePassende(basis, [gas, { ...basis }])).toBeNull();
  });

  it('Z4 · Energiebilanz ohne Hauptzähler: Satz und Schritt ergeben zusammen den Satz von §5.8', () => {
    expect(`${OHNE_HAUPTZAEHLER.satz.slice(0, -1)} — ${OHNE_HAUPTZAEHLER.schritt}.`).toBe(
      'Diese Anlage hat keinen Hauptzähler in der elektrischen Stellung — Stellung eintragen.',
    );
    expect(OHNE_HAUPTZAEHLER.titel).toBe('Kein Hauptzähler');
  });
});

/**
 * UEMS AP-13 IP-11 — die Sprünge der Kette (E2, E10, D1–D4). Der Befund, mit dem AP-13 anfing, lautete:
 * „Die Kette bricht am Text ab.“ Herkunft, Nachweis und Quelle waren Zeichenketten. Hier wird gemessen,
 * dass sie Kanten bekommen haben — und dass jede Kante ihre PERIODE und ihre VERSION mitnimmt: ein Sprung,
 * der beides verliert, führt zu einer anderen Zahl als der angeklickten, und das ist schlimmer als kein Sprung.
 */
describe('IP-11 · Herkunfts-Zeilen als Sprünge (O10, O18)', () => {
  const O10 = fall('O10');

  it('O10: die Herkunfts-Zeile springt zu MS-12 › Werte › Oktober mit Version 2 — genau der Hash des Falls', () => {
    const satz = `Menge 6.040 kWh (MS-12, korrigiert (Version 2)) je 41.000 Stück (BZ-6, Fassung 1)`;
    const stuecke = herkunftsZeile(satz, (k) => kennzeichenSprung(k, { periode: '2026-10', version: k === 'MS-12' ? 2 : null }));
    const sprung = stuecke.find((s) => s.text === 'MS-12');
    expect(sprung?.sprung?.hash).toBe(O10.gegeben.sprungziel);
    expect(O10.erwartet.herkunft_sprung).toBe(`MS-12 → ${sprung?.sprung?.hash}`);
    // Zusammengefügt ist die Zeile Zeichen für Zeichen der Satz von vorher — kein zweiter Wortlaut (D1).
    expect(stuecke.map((s) => s.text).join('')).toBe(satz);
  });

  it('O10: „41 000 Stück (BZ-6)“ bleibt Text — AP-09 hat keine Kundenfläche, und keine wird erfunden (D3)', () => {
    expect(O10.erwartet.bz6_ist_sprung).toBe(false);
    expect(kennzeichenSprung('BZ-6', { periode: '2026-10' })).toBeNull();
    const stuecke = herkunftsZeile('je 41.000 Stück (BZ-6, Fassung 1)', (k) => kennzeichenSprung(k, {}));
    expect(stuecke).toEqual([{ text: 'je 41.000 Stück (BZ-6, Fassung 1)', sprung: null }]);
    // Ereignis und Box ebenso — ihr Paket hat (noch) keine Seite.
    expect(kennzeichenImText('Box VP-DEMO-0001 · Ereignis EV-7 · BZ-6')).toEqual([]);
  });

  it('D2 · jeder Sprung trägt Periode UND Version — ohne Periode landet der Kunde bei einer anderen Zahl', () => {
    expect(kennzeichenSprung('MS-12', { periode: '2026-10', version: 2 })?.hash).toBe(
      '#/portfolio/messstellen/MS-12?periode=2026-10&version=2',
    );
    // Die Version fragt nur die Karte; ohne sie zeigt die Seite die neueste (IP-3) — aber die Periode fehlt nie.
    expect(kennzeichenSprung('MS-12', { periode: '2026-10' })?.hash).toBe('#/portfolio/messstellen/MS-12?periode=2026-10');
    expect(kennzeichenSprung('MS-12', { periode: '2026-W44', version: 1 })?.hash).toBe(
      '#/portfolio/messstellen/MS-12?periode=2026-W44&version=1',
    );
    // Im Standort-Bereich öffnet dieselbe Messstelle ihre Seite dort, mit denselben Angaben.
    expect(kennzeichenSprung('MS-12', { periode: '2026', standortId: FIXTURE_IDS.st1 })?.hash).toBe(
      `#/standort/${FIXTURE_IDS.st1}/messstellen/MS-12?periode=2026`,
    );
    // Eine Kennzahl hat keine Version im Hash — ihre Seite wählt die Periode selbst (AP-11 IP-13).
    expect(kennzeichenSprung('KZ-0001', { periode: '2026-10', version: 2 })?.hash).toBe('#/portfolio/kennzahlen/KZ-0001');
  });

  it('D1 · ein Kennzeichen wird nur als GANZES Wort erkannt — „MS-1“ ist nicht „MS-12“', () => {
    expect(kennzeichenImText('MS-12 und MS-1 und MS-12-alt')).toEqual(['MS-12', 'MS-1']);
    // Der Treffer endet vor dem Bindestrich: „MS-12-alt“ ist kein MS-12, sondern gar kein Kennzeichen.
    const stuecke = herkunftsZeile('MS-12-alt', (k) => kennzeichenSprung(k, {}));
    expect(stuecke).toEqual([{ text: 'MS-12-alt', sprung: null }]);
    // Ein Text ohne Treffer bleibt EIN Stück; ein leerer Text keines.
    expect(herkunftsZeile('ohne Kennzeichen', (k) => kennzeichenSprung(k, {}))).toHaveLength(1);
    expect(herkunftsZeile('', (k) => kennzeichenSprung(k, {}))).toEqual([]);
  });

  it('D1 · jedes Sprungziel führt auf die Seite seines Objekts — und jeder Hash liest sich zurück', () => {
    const ziele = [
      sprungziel({ art: 'messstelle', id: 'MS-12', periode: '2026-10', version: 2 }),
      sprungziel({ art: 'kennzahl', id: 'KZ-0001' }),
      sprungziel({ art: 'bericht', kennung: 'BR-2026-0001' }),
      sprungziel({ art: 'kostenstelle', kennzeichen: '4200', periode: 'monat', am: '2026-10-01' }),
      sprungziel({ art: 'geraet', siteId: FIXTURE_IDS.an1, ref: 'edge-k7m2xqp', geraetId: 'inverter' }),
    ];
    for (const z of ziele) expect(z && parseRoute(z.hash)).toEqual(z?.route);
    expect(ziele.map((z) => z?.hash)).toEqual([
      '#/portfolio/messstellen/MS-12?periode=2026-10&version=2',
      '#/portfolio/kennzahlen/KZ-0001',
      '#/portfolio/berichte/BR-2026-0001',
      '#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01&kostenstelle=4200',
      `#/anlage/${FIXTURE_IDS.an1}/geraet/edge-k7m2xqp/inverter`,
    ]);
    // D3: Bezugsgröße, Ereignis, Box und Gebäude haben keine Seite je Objekt — sie bleiben Text.
    for (const art of ['bezugsgroesse', 'ereignis', 'box', 'gebaeude'] as const) {
      expect(sprungziel({ art, kennzeichen: 'X-1' })).toBeNull();
    }
  });

  it('D2 · der Periodenschlüssel schneidet den Tag der Fläche — Tag, Monat, Jahr', () => {
    expect(periodeSchluessel('tag', '2026-11-03')).toBe('2026-11-03');
    expect(periodeSchluessel('monat', '2026-10-01')).toBe('2026-10');
    expect(periodeSchluessel('jahr', '2026-01-01')).toBe('2026');
  });

  it('O18 · E2 = A: das Cockpit bekommt EINEN Weg mit der Zählung des Registers — und tauscht keine Zahl', () => {
    const O18 = fall('O18');
    const weg = cockpitWeg(FIXTURE_IDS.an1, O18.gegeben.register_an1);
    expect(weg?.titel).toBe(COCKPIT_WEG_TITEL);
    // Die Zählung steht WÖRTLICH so da, wie das Register sie spricht — im Portal wird nichts gezählt.
    expect(weg?.text).toBe(O18.gegeben.register_an1.text);
    expect(weg?.sprung.hash).toBe(`#/portfolio/messstellen?anlage=${FIXTURE_IDS.an1}`);
    expect(weg && parseRoute(weg.sprung.hash)).toEqual(weg?.sprung.route);
    // Der erwartete Satz des Falls nennt Titel und Zählung zusammen — beides kommt aus derselben Antwort.
    expect(O18.erwartet.neuer_weg.startsWith(`${COCKPIT_WEG_TITEL} · 9 von 9`)).toBe(true);
    expect(O18.erwartet.cockpit_zahl_getauscht).toBe(false);
    expect(O18.erwartet.abgleich_warnung).toBe(false);
  });

  it('O18 · eine Anlage ohne Messstelle bekommt keinen Weg — der Betriebskunde sieht nichts Neues', () => {
    expect(cockpitWeg(FIXTURE_IDS.an1, { gesamt: 0, text: 'Noch keine Messstellen' })).toBeNull();
    expect(cockpitWeg(FIXTURE_IDS.an1, null)).toBeNull();
    expect(fall('O18').erwartet.betriebskunde_neu).toBe('nichts');
  });
});
