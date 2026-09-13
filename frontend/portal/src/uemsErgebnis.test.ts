import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import {
  ANZEIGE_EINHEITEN,
  DEZIMAL,
  EBENEN,
  FRUEHERE_FASSUNGEN,
  KENNZEICHEN,
  KENNZEICHEN_EBENE,
  MINUS,
  OHNE_ZAHL,
  PLATZHALTER,
  SCHRITTE,
  STELLEN,
  TAGESDAUER,
  TAUSENDER,
  TRENNER,
  VERSTOESSE,
  VOR_EINHEIT,
  VORGESEHEN,
  ZUSTAENDE,
  anfang,
  erkenne,
  menge,
  pruefe,
  pruefeMenge,
  pruefeZahl,
  raster,
  rundungsdifferenz,
  satz,
  sprich,
  tagesdauer,
  uhr,
  vorgesehen,
  zahl,
  type Ergebnis,
} from './uemsErgebnis';
import { stundenDesTages } from './bezugsPeriode';

/**
 * Der Ergebnis-Zustand (UEMS AP-08 IP-8) gegen die geteilte Vektor-Datei
 * `docs/contracts/v2/ergebnis-zustand-vectors.json` — per Pfad, dieselbe
 * Datei, die der Java-Zwilling `ErgebnisZustandVectorsTest` fährt.
 *
 * Neben den Fällen: das Vokabular im Modul IST das der Datei, und jeder
 * Kennzeichen-Satz der Verbrauchsregel (`verbrauch-vectors.json`) steht in der
 * geschlossenen Liste und in Vertragsreihenfolge.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const vektoren = lies('ergebnis-zustand-vectors.json');
const faelle = vektoren.cases as Json[];

describe('uemsErgebnis — Vertrag und Vokabular', () => {
  it('die Vektor-Datei erfüllt ihr Schema', () => {
    expect(schemaVerstoesse(vektoren, lies('ergebnis-zustand.schema.json'))).toEqual([]);
  });

  it('das Vokabular im Modul ist das der Datei', () => {
    expect(ZUSTAENDE).toEqual(
      vektoren.zustaende.map((z: Json) => ({ wort: z.wort, zahl: z.zahl, kennzeichen: z.kennzeichen })),
    );
    expect(PLATZHALTER).toEqual(vektoren.platzhalter);
    expect(KENNZEICHEN).toEqual(
      vektoren.kennzeichen.map((k: Json) => ({
        schluessel: k.schluessel,
        muster: k.muster,
        platzhalter: k.platzhalter,
        wort: k.wort,
        rang: k.rang,
        fehlbestand: k.fehlbestand,
        einmalig: k.einmalig,
        folgtAuf: k.folgt_auf,
        verlangtDanach: k.verlangt_danach,
      })),
    );
    expect(FRUEHERE_FASSUNGEN).toEqual(
      vektoren.fruehere_fassungen.map((f: Json) => ({
        schluessel: f.schluessel,
        muster: f.muster,
        platzhalter: f.platzhalter,
        bisFassung: f.bis_fassung,
      })),
    );
    expect(VORGESEHEN).toEqual(
      vektoren.kennzeichen_vorgesehen.map((w: Json) => ({ wort: w.wort, anfang: w.anfang, wortlautMit: w.wortlaut_mit })),
    );
    expect([...VERSTOESSE]).toEqual(vektoren.verstoesse);
    expect(TRENNER).toBe(vektoren.satz.trenner);
    expect(OHNE_ZAHL).toBe(vektoren.satz.ohne_zahl);
    expect(TAUSENDER).toBe(vektoren.rundung.tausender);
    expect(DEZIMAL).toBe(vektoren.rundung.dezimal);
    expect(VOR_EINHEIT).toBe(vektoren.rundung.vor_einheit);
    expect(MINUS).toBe(vektoren.rundung.minus);
    expect(EBENEN).toEqual(vektoren.rundung.ebenen);
    expect(STELLEN).toEqual(vektoren.rundung.stellen);
    expect(ANZEIGE_EINHEITEN).toEqual(vektoren.rundung.anzeige_einheiten);
    expect(KENNZEICHEN_EBENE).toBe(vektoren.rundung.kennzeichen_ebene);
    expect(Object.fromEntries(Object.entries(TAGESDAUER))).toEqual(vektoren.sommerzeit.tagesdauer);
    expect(SCHRITTE).toEqual(vektoren.sommerzeit.schritte);
  });

  it('jedes Muster erkennt sein Beispiel und spricht es zurück', () => {
    for (const k of vektoren.kennzeichen as Json[]) {
      const e = erkenne(k.beispiel);
      expect(e?.muster.schluessel, k.beispiel).toBe(k.schluessel);
      expect(sprich(k.schluessel, e!.werte)).toBe(k.beispiel);
    }
    for (const f of vektoren.fruehere_fassungen as Json[]) {
      const e = erkenne(f.beispiel);
      expect(e?.muster.schluessel, f.beispiel).toBe(f.schluessel);
      expect(e?.fruehereFassung).toBe(true);
      // Erkannt, aber nie mehr gesprochen: dieselben Werte ergeben den heutigen Wortlaut — oder, wo nur
      // der Platzhalter sich änderte (1.3: „337.600“ ist keine Menge), nimmt das heutige Muster den
      // alten Wert nicht mehr an (sonst hätte erkenne auf zwei Muster gepasst).
      if (sprich(f.schluessel, e!.werte) === f.beispiel) {
        expect(e!.muster.platzhalter, f.beispiel).not.toEqual(f.platzhalter);
      }
    }
    expect(anfang('ruecksetzung')).toBe('Rücksetzung ');
    expect(() => sprich('neustart', { uhr: '10:22' })).toThrow();
  });

  it('jede Familie, jedes Zustandswort und jeder Verstoß ist abgedeckt', () => {
    expect(new Set(faelle.map((f) => f.familie))).toEqual(
      new Set(['zahl', 'menge', 'ergebnis', 'erkennen', 'tagesdauer', 'raster', 'uhr', 'rundungsdifferenz']),
    );
    const gesprochen = faelle.filter((f) => f.familie === 'ergebnis' && f.erwartet.satz !== null).map((f) => f.eingang.zustand);
    for (const z of ZUSTAENDE) expect(gesprochen).toContain(z.wort);
    const gemeldet = new Set(faelle.flatMap((f) => (f.erwartet.verstoesse ?? []) as string[]));
    for (const v of VERSTOESSE) expect(gemeldet.has(v), v).toBe(true);
  });
});

/**
 * Die INVENTUR als Test: jede Erwartung der Verbrauchsregel mit Kennzeichen
 * ist ein gültiges Ergebnis dieses Vertrags.
 */
describe('uemsErgebnis — jeder Satz der Verbrauchsregel steht in der Liste', () => {
  const verbrauch = lies('verbrauch-vectors.json');
  const erwartungen = (verbrauch.cases as Json[]).flatMap((fall) =>
    (fall.expected as Json[]).filter((e) => Array.isArray(e.kennzeichen)).map((e) => ({ fall, e })),
  );

  it('es sind die Erwartungen aller Referenzfälle', () => {
    expect(erwartungen.length).toBeGreaterThan(60);
  });

  for (const { fall, e } of erwartungen) {
    it(`${fall.name} · ${e.name}`, () => {
      // Die Verbrauchsregel spricht nur den HEUTIGEN Wortlaut — nie den einer früheren Fassung.
      for (const k of e.kennzeichen as string[]) expect(erkenne(k)?.fruehereFassung, k).toBe(false);
      const wert = e.menge ?? e.mittel ?? null;
      const ergebnis: Ergebnis = {
        wert: wert === null ? null : String(wert),
        einheit: 'kWh',
        ebene: 'viertelstunde',
        zustand: e.zustand,
        abdeckungProzent: null,
        kennzeichen: e.kennzeichen,
      };
      expect(pruefe(ergebnis)).toEqual([]);
    });
  }
});

describe('uemsErgebnis — die Fälle der Vektor-Datei', () => {
  for (const fall of faelle) {
    const ein = fall.eingang;
    const erw = fall.erwartet;
    it(`${fall.familie} · ${fall.name}`, () => {
      switch (fall.familie) {
        case 'zahl': {
          expect(pruefeZahl(ein.einheit, ein.ebene)).toEqual(erw.verstoesse);
          if (erw.verstoesse.length === 0) expect(zahl(ein.wert, ein.einheit, ein.ebene)).toBe(erw.text);
          else expect(() => zahl(ein.wert, ein.einheit, ein.ebene)).toThrow();
          break;
        }
        case 'menge': {
          expect(pruefeMenge(ein.einheit, ein.ebene)).toEqual(erw.verstoesse);
          if (erw.verstoesse.length === 0) expect(menge(ein.wert, ein.einheit, ein.ebene)).toBe(erw.text);
          else expect(() => menge(ein.wert, ein.einheit, ein.ebene)).toThrow();
          break;
        }
        case 'ergebnis': {
          const e: Ergebnis = {
            wert: ein.wert,
            einheit: ein.einheit,
            ebene: ein.ebene,
            zustand: ein.zustand,
            abdeckungProzent: ein.abdeckung_prozent,
            kennzeichen: ein.kennzeichen,
          };
          expect(pruefe(e)).toEqual(erw.verstoesse);
          if (erw.verstoesse.length === 0) expect(satz(e)).toBe(erw.satz);
          else expect(() => satz(e)).toThrow();
          break;
        }
        case 'erkennen': {
          const e = erkenne(ein.satz);
          expect(e?.muster.schluessel ?? null).toBe(erw.schluessel);
          if (e) expect(e.werte).toEqual(erw.werte);
          if (e) expect(e.fruehereFassung).toBe(erw.fruehere_fassung ?? false);
          expect(vorgesehen(ein.satz)).toBe(erw.vorgesehen);
          break;
        }
        case 'tagesdauer': {
          expect(stundenDesTages(ein.tag, ein.zeitzone)).toBe(erw.stunden);
          expect(tagesdauer(ein.tag, ein.zeitzone)).toBe(erw.satz);
          break;
        }
        case 'raster': {
          const felder = raster(ein.tag, ein.zeitzone, ein.schritt);
          expect(felder).toHaveLength(erw.anzahl);
          const ab = fall.ausschnitt_ab ?? 0;
          expect(felder.slice(ab, ab + erw.felder.length)).toEqual(erw.felder);
          if (fall.ausschnitt_ab === undefined) expect(erw.felder).toHaveLength(felder.length);
          break;
        }
        case 'uhr': {
          expect(uhr(Date.parse(ein.zeit), ein.zeitzone)).toBe(erw.text);
          break;
        }
        case 'rundungsdifferenz': {
          expect(rundungsdifferenz(ein.einheit, ein.teile, ein.ebene_teile, ein.summe, ein.ebene_summe)).toEqual({
            summeDerAngezeigten: erw.summe_der_angezeigten,
            differenz: erw.differenz,
            satz: erw.satz,
          });
          break;
        }
        default:
          throw new Error(`unbekannte Familie ${fall.familie}`);
      }
    });
  }
});

describe('uemsErgebnis — was nur der TS-Zwilling braucht', () => {
  it('eine Zahl rundet wie ihr Dezimaltext, nie wie ihr Binärbruch', () => {
    // 0.15 ist als Binärbruch 0.1499999…; BigDecimal("0.15") rundet kaufmännisch auf 0,2.
    expect(zahl(0.15, 'kW', null)).toBe(`0,2${VOR_EINHEIT}kW`);
    expect(zahl(0.35, 'm³', null)).toBe(`0,4${VOR_EINHEIT}m³`);
    for (const f of faelle.filter((x) => x.familie === 'zahl' && x.erwartet.text !== null && x.eingang.wert !== null)) {
      expect(zahl(Number(f.eingang.wert), f.eingang.einheit, f.eingang.ebene), f.name).toBe(f.erwartet.text);
    }
  });

  it('eine sehr kleine Zahl in Exponentschreibweise wird nicht falsch gelesen', () => {
    expect(zahl(1e-7, 'kWh', 'tag')).toBe(`0${VOR_EINHEIT}kWh`);
  });
});

/** Die drei Befunde aus PR 721, gegen die ALTEN Wortlaute — damit sie nicht zurückkommen. */
describe('uemsErgebnis — die alten Kundensätze kommen nicht zurück', () => {
  it('Dativ: „mit Ablesestände“ wird nie mehr gesprochen', () => {
    expect(sprich('geraetegrenze_mit', { uhr: '10:40' })).toBe('Gerätegrenze 10:40 mit Ableseständen');
    expect(erkenne('Gerätegrenze 10:40 mit Ablesestände')?.fruehereFassung).toBe(true);
  });

  it('Zuwachs: „337.600“ ohne Einheit wird nie mehr gesprochen, bleibt aber lesbar', () => {
    const alt = erkenne('Lücke 14:00–17:31: Zuwachs 337.600 gemessen, nicht auf Viertelstunden verteilbar');
    expect(alt?.muster.schluessel).toBe('luecke_zuwachs');
    expect(alt?.fruehereFassung).toBe(true);
    const neu = `Lücke 14:00–17:31: Zuwachs ${menge('337600', 'Wh', KENNZEICHEN_EBENE)} gemessen, nicht auf Viertelstunden verteilbar`;
    expect(neu).toBe(`Lücke 14:00–17:31: Zuwachs 337,6${VOR_EINHEIT}kWh gemessen, nicht auf Viertelstunden verteilbar`);
    expect(erkenne(neu)?.fruehereFassung).toBe(false);
  });

  it('Sommerzeit: 02:30 am 25.10.2026 ist nie mehr ohne Zusatz', () => {
    const erste = uhr(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Berlin');
    const zweite = uhr(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Berlin');
    expect(erste).not.toBe('02:30');
    expect(zweite).not.toBe('02:30');
    expect(erste).not.toBe(zweite);
  });
});
