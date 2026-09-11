import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import {
  ANWENDUNGEN,
  ARTEN,
  EINHEIT_MAX_ZEICHEN,
  FEHLER,
  HERKUENFTE,
  STATUS,
  TEXTE,
  WANDLER_ARTEN,
  ZAHL_GRENZE,
  ZEITZONE,
  ZUSTELLUNGEN,
  anwendungText,
  folgen,
  neueFassung,
  status,
  wertGueltig,
  wertText,
  zustellung,
  type Bestehende,
  type Eingang,
} from './uemsEinstellung';

/**
 * Die Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11) gegen die EINE
 * geteilte Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/QuelleEinstellungRegelnVectorsTest` fährt. Die
 * Familien `verbindung` und `aenderung` kennt nur der Server (Java + SQL): das
 * Portal leitet aus einer Verbindung keine Fassung ab.
 *
 * Wer eine Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'quelle-einstellung-vectors.json'));
const schema: Json = lies(resolve(V2, 'quelle-einstellung.schema.json'));

const faelle = (familie: string): Json[] => vectors.cases[familie];

const eingang = (i: Json): Eingang => ({
  beginn: i.beginn,
  ende: i.ende,
  bestehende: i.bestehende.map(
    (b: Json): Bestehende => ({
      id: b.id,
      wert: b.wert,
      anwendung: b.anwendung,
      gueltigAb: b.gueltig_ab,
      gueltigBis: b.gueltig_bis,
    }),
  ),
  neu: {
    art: i.neu.art,
    wert: i.neu.wert,
    anwendung: i.neu.anwendung,
    gueltigAb: i.neu.gueltig_ab,
    tatsaechlichAb: i.neu.tatsaechlich_ab,
  },
  jetzt: i.jetzt,
});

/** Zeitpunkte vergleicht man als Zeitpunkte: „+01:00" und „Z" sind derselbe Moment. */
const ms = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

describe('uemsEinstellung — Datei und Konstanten', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
  });

  it('die Konstanten stehen genau so in der Datei', () => {
    expect(vectors.arten).toEqual(ARTEN);
    expect(vectors.wandler_arten).toEqual(WANDLER_ARTEN);
    expect(vectors.zahl_grenze).toBe(ZAHL_GRENZE);
    expect(vectors.einheit_max_zeichen).toBe(EINHEIT_MAX_ZEICHEN);
    expect(vectors.zeitzone).toBe(ZEITZONE);
    expect(vectors.anwendungen).toEqual(ANWENDUNGEN);
    expect(vectors.herkuenfte).toEqual(HERKUENFTE);
    expect(vectors.zustellungen).toEqual(ZUSTELLUNGEN);
    expect(vectors.status).toEqual(STATUS);
    expect(vectors.fehler).toEqual(FEHLER);
    expect(vectors.texte).toEqual(TEXTE);
  });
});

describe('uemsEinstellung — Werte', () => {
  it.each(faelle('wert').map((c: Json) => [c.name, c]))('%s', (_n, c: Json) => {
    expect(wertGueltig(c.input.art, c.input.wert)).toBe(c.expected.gueltig);
    expect(wertText(c.input.art, c.input.wert)).toBe(c.expected.text);
  });
});

describe('uemsEinstellung — eine neue Fassung', () => {
  it.each(faelle('fassung').map((c: Json) => [c.name, c]))('%s', (_n, c: Json) => {
    const u = neueFassung(eingang(c.input));
    expect(u.fehler).toBe(c.expected.code);
    if (c.expected.beendet === null) {
      expect(u.beendet).toBeNull();
    } else {
      expect(u.beendet?.id).toBe(c.expected.beendet.id);
      expect(ms(u.beendet?.gueltigBis ?? null)).toBe(ms(c.expected.beendet.gueltig_bis));
    }
    expect(ms(u.gueltigAb)).toBe(ms(c.expected.gueltig_ab));
    expect(ms(u.gueltigBis)).toBe(ms(c.expected.gueltig_bis));
    expect(u.rueckwirkend).toBe(c.expected.rueckwirkend);
  });
});

describe('uemsEinstellung — die Folgen-Sätze', () => {
  it.each(faelle('folgen').map((c: Json) => [c.name, c]))('%s', (_n, c: Json) => {
    const i = c.input;
    expect(
      folgen(
        i.art,
        i.herkunft,
        {
          wert: i.neu.wert,
          anwendung: i.neu.anwendung,
          gueltigAb: i.neu.gueltig_ab,
          tatsaechlichAb: i.neu.tatsaechlich_ab,
        },
        i.vorgaenger,
      ),
    ).toEqual(c.expected);
  });
});

describe('uemsEinstellung — die Anzeige', () => {
  it.each(faelle('anzeige').map((c: Json) => [c.name, c]))('%s', (_n, c: Json) => {
    const i = c.input;
    expect(status(i.gueltig_ab, i.gueltig_bis, i.jetzt)).toBe(c.expected.status);
    expect(zustellung(i.anwendung, i.herkunft)).toBe(c.expected.zustellung);
    expect(anwendungText(i.anwendung, i.herkunft)).toBe(c.expected.anwendung_text);
  });
});
