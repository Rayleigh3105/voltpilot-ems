import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { dez, type Dez } from './bezugsdaten';
import {
  KENNZEICHEN_MAX_ZEICHEN,
  KENNZEICHEN_MIN_ZEICHEN,
  KENNZEICHEN_MUSTER,
} from './uemsMessstelle';
import {
  KENNZEICHEN_PRAEFIX,
  KENNZEICHEN_STELLEN,
  KOPFZEILE_TRENNER,
  MALO_MUSTER,
  MESSUNGEN,
  bindung,
  felder,
  kennzeichen,
  kopfzeile,
  malo,
  type Bindung,
} from './uemsNetzanschluss';

/**
 * Die Regeln des NETZANSCHLUSSES (UEMS AP-10 IP-1) gegen die EINE geteilte Vektor-Datei —
 * dieselbe, die der Java-Zwilling `services/api .../uems/NetzanschlussVectorsTest` fährt.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'netzanschluss-vectors.json'));
const schema: Json = lies(resolve(V2, 'netzanschluss.schema.json'));

const prueftTs = (regel: string): boolean => (vectors.zwillinge[regel] ?? []).includes('ts');

const betrag = (v: unknown): Dez | null => (v === null || v === undefined ? null : dez(String(v)));

const bind = (b: Json): Bindung => ({
  anlage: b.anlage,
  netzanschluss: b.netzanschluss,
  gueltig_ab: b.gueltig_ab,
  gueltig_bis: b.gueltig_bis ?? null,
});

describe('Netzanschluss-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
  });

  it('Prosa und Java-Zwilling liegen, wo die Datei sie nennt', () => {
    expect(existsSync(resolve(V2, 'netzanschluss.md'))).toBe(true);
    expect(
      existsSync(
        resolve(
          process.cwd(),
          '../../services/api/src/main/java/com/voltpilot/api/uems/NetzanschlussRegeln.java',
        ),
      ),
    ).toBe(true);
  });

  it('die Kennzeichen-Form ist die des Messstellen-Vertrags — nur das Präfix ist eigen', () => {
    const k = vectors.kennzeichen_regel;
    expect(k.praefix).toBe(KENNZEICHEN_PRAEFIX);
    expect(k.stellen).toBe(KENNZEICHEN_STELLEN);
    expect(k.muster).toBe(KENNZEICHEN_MUSTER);
    expect(k.min_zeichen).toBe(KENNZEICHEN_MIN_ZEICHEN);
    expect(k.max_zeichen).toBe(KENNZEICHEN_MAX_ZEICHEN);
    expect(vectors.regeln.malo_muster).toBe(MALO_MUSTER);
    expect(vectors.vokabulare.messung).toEqual(MESSUNGEN);
    expect(vectors.regeln.kopfzeile_trenner).toBe(KOPFZEILE_TRENNER);
  });

  it('jede Regel ist in beiden Sprachen deklariert, jede Abweichung benannt', () => {
    const benutzt = new Set<string>();
    for (const fall of vectors.cases) for (const p of fall.pruefungen) benutzt.add(p.regel);
    expect(Object.keys(vectors.zwillinge).sort()).toEqual([...benutzt].sort());
    for (const [regel, wer] of Object.entries<string[]>(vectors.zwillinge)) {
      expect(wer, `Zwillinge von ${regel}`).toEqual(expect.arrayContaining(['java', 'ts']));
    }
    expect(vectors._abweichungen.length).toBeGreaterThan(0);
    for (const a of vectors._abweichungen) expect(a.grund).toBeTruthy();
    expect(vectors._nicht_geprueft.length).toBeGreaterThan(0);
    for (const n of vectors._nicht_geprueft) expect(n.warum).toBeTruthy();
  });
});

describe('Netzanschluss-Vertrag: die Vektoren', () => {
  const faelle: Array<[string, Json, Json]> = [];
  for (const fall of vectors.cases) {
    for (const p of fall.pruefungen) {
      if (!prueftTs(p.regel)) continue;
      faelle.push([`${fall.id} · ${p.regel} :: ${p.name}`, fall, p]);
    }
  }

  it('der Läufer ist verdrahtet', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(20);
  });

  it.each(faelle)('%s', (_name, fall: Json, p: Json) => {
    const why = `${fall.id} (${fall.why})`;
    const ein = p.eingang;
    const soll = p.ergebnis;

    switch (p.regel) {
      case 'kennzeichen': {
        const ist = kennzeichen(ein.kandidat, ein.belegt, ein.zaehler);
        expect(ist.gueltig, `${why} · gültig`).toBe(soll.gueltig);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.vorschlag, `${why} · Vorschlag`).toEqual(soll.vorschlag);
        break;
      }
      case 'malo': {
        const ist = malo(ein.text);
        expect(ist.malo, `${why} · Marktlokation`).toBe(soll.malo);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        break;
      }
      case 'felder': {
        const ist = felder({
          name: ein.name,
          standort: ein.standort,
          malo: ein.malo,
          netzbetreiber: ein.netzbetreiber,
          anschluss_kva: betrag(ein.anschluss_kva),
          vereinbart_kw: betrag(ein.vereinbart_kw),
          messung: ein.messung,
        });
        expect(ist.gueltig, `${why} · gültig`).toBe(soll.gueltig);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.feld, `${why} · Feld`).toBe(soll.feld);
        expect(ist.hinweise, `${why} · Hinweise`).toEqual(soll.hinweise);
        break;
      }
      case 'bindung': {
        const ist = bindung(ein.bestehend.map(bind), bind(ein.neu), ein.heute);
        expect(ist.beendet, `${why} · beendet`).toEqual(soll.beendet);
        expect(ist.eintrag, `${why} · Eintrag`).toEqual(soll.eintrag);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.rueckwirkend, `${why} · rückwirkend`).toBe(soll.rueckwirkend);
        break;
      }
      case 'kopfzeile': {
        const ist = kopfzeile(
          ein.netzanschluss,
          betrag(ein.vereinbart_kw),
          betrag(ein.anschluss_kva),
          betrag(ein.momentan_kw),
          ein.nachweis ?? null,
        );
        expect(ist.text, `${why} · Kopfzeile`).toBe(soll.text);
        expect(ist.grenze_geprueft, `${why} · geprüft nur mit Grenz-Nachweis`).toBe(
          soll.grenze_geprueft,
        );
        break;
      }
      default:
        throw new Error(`unbekannte Regel ${p.regel}`);
    }
  });
});
