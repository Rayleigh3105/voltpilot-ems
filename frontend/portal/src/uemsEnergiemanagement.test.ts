import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as em from './energiemanagement';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

const v2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string) => JSON.parse(readFileSync(resolve(v2, datei), 'utf8'));
const data = lies('energiemanagement-vectors.json');
const schema = lies('energiemanagement.schema.json');
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function rechnen(fall: any) {
  const e = fall.eingang;
  switch (fall.operation) {
    case 'ueberpruefung': return em.ueberpruefung(e);
    case 'wiedervorlage': return em.wiedervorlage(e);
    case 'anwendungsbereich_vergleich': return em.anwendungsbereichVergleich(e);
    case 'verzeichnis_zeile': return em.verzeichnisZeile(e);
    case 'pruefsumme': return em.pruefsumme(e, sha256Hex);
    case 'satz': return em.satz(e.schluessel, e.werte);
    default: throw new Error(`Ungeprüfte Operation: ${fall.operation}`);
  }
}
const quelle = (pfad: string) => readFileSync(resolve(process.cwd(), pfad), 'utf8');
const fall = (anfang: string) => data.cases.find((c: any) => c.name.startsWith(anfang));

describe('AP-19 NW-1 · Energiemanagement: dieselben Vektoren wie Java und Python', () => {
  for (const f of data.cases) it(f.name, () => expect(rechnen(f)).toEqual(f.erwartet));
  it('geschlossenes Schema, Startwerte, Vokabular, Wörter und Sätze', () => {
    expect(schemaVerstoesse(data, schema)).toEqual([]);
    expect(em.STARTWERTE).toEqual(data.startwerte);
    expect(em.VOKABULARE).toEqual(data.vokabulare);
    expect(em.DOKUMENT_ART_KLASSE).toEqual(data.dokument_art_klasse);
    expect(em.LEITUNGS_PFLICHT).toEqual(data.leitungs_pflicht);
    expect(em.WOERTER).toEqual(data.woerter);
    expect(em.SAETZE).toEqual(data.saetze);
    expect(new Set(data.cases.map((c: any) => c.name)).size).toBe(data.cases.length);
  });
  it('Schema lehnt ein unbekanntes Feld ab', () => {
    const falsch = structuredClone(data);
    falsch.cases.find((c: any) => c.operation === 'wiedervorlage').eingang.zusatz = 1.5;
    expect(schemaVerstoesse(falsch, schema).length).toBeGreaterThan(0);
  });
  it('Datum von außen, keine Uhr — in keinem Zwilling', () => {
    const zwillinge = {
      ts: quelle('src/energiemanagement.ts'),
      java: quelle('../../services/api/src/main/java/com/voltpilot/api/uems/EnergiemanagementRegeln.java'),
      py: quelle('../../services/optimization/voltpilot_optimization/energiemanagement.py'),
    };
    for (const [sprache, text] of Object.entries(zwillinge)) {
      expect(/Date\.now|new Date\(\)|\.now\(|date\.today|\bClock\b|currentTimeMillis/.test(text), sprache).toBe(false);
    }
    expect((em.ueberpruefung({ ...fall('R1 D-0001 seit 64 Tagen fällig').eingang, abruf: '2029-02-13' }) as em.Frist).tage).toBe(65);
  });
  it('die Pflichtfälle der §8-Zeile sind eigene Vektoren', () => {
    for (const p of ['R1 D-0001 seit 64 Tagen fällig', 'R12 BB-0002 seit 457 Tagen', 'R2 nur Strom → Gas nicht im Betrachtungsumfang']) {
      expect(fall(p), p).toBeDefined();
    }
  });
  it('die Prüfsumme der Referenzdatei gilt für −5, nicht für −5.0 (bericht.md A1)', () => {
    const roh = readFileSync(resolve(v2, 'uems-referenzunternehmen.json'), 'utf8');
    const stand = JSON.parse(roh).managementbewertungen[0].staende[0];
    expect(roh).toContain('"zielwert_prozent": -5.0');
    expect(em.pruefsumme({ kopie: stand.abzug }, sha256Hex).pruefsumme).toBe(stand.pruefsumme);
  });
});
