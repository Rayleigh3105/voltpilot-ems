import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BezugsdatenVorschau } from './api';
import { vorschauAbleitung } from './bezugsdatenVorschau';

const vertrag = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/bezugsdaten-vectors.json'), 'utf8'));

function vorschau(urteile: Array<{ urteil: string; befunde: string[] }>): BezugsdatenVorschau {
  const importFall = vertrag.cases.flatMap((f: any) => f.pruefungen)
    .find((p: any) => p.regel === 'import' && JSON.stringify(p.eingang.zeilen) === JSON.stringify(urteile));
  const z = importFall.ergebnis.zaehler;
  return {
    vorschau: { kennung: 'VS1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'vorschau', ausgestellt_am: '', gueltig_bis: '', ergebnis_fingerabdruck: '' },
    vorlage: null,
    datei: { name: 'werte.csv', bytes: 10, sha256: '', befund: null, zusatz: null, zusatz_satz: null, zeile: null, kodierung: 'utf-8', bom: false, trennzeichen: ';', kopfzeile: true, kopf: [], spalten: 4, datenzeilen: z.zeilen },
    frueherer_import: null,
    zeilen: urteile.map((x, i) => ({ nr: i + 2, felder: [], bezugsgroesse: null, bezugsgroesse_id: null, schluessel: null, periode_von: null, periode_bis: null, zeitpunkt: null, betrag: null, einheit: null, geliefert: null, urteil: x.urteil, befunde: x.befunde.map((b) => ({ befund: b, satz: vertrag.befund_saetze[b], hinweis: vertrag.hinweis_befunde.includes(b) })), fingerabdruck: null, bestand: null })),
    import: { status: importFall.ergebnis.status, zaehler: { ...z, mit_hinweis: z.mit_hinweis }, uebernahme_moeglich: importFall.ergebnis.uebernahme_moeglich, import_datensatz: importFall.ergebnis.import_datensatz, bestaetigung: importFall.ergebnis.bestaetigung, aenderungen: importFall.ergebnis.aenderungen, befunde: importFall.ergebnis.befunde.map((b: string) => ({ befund: b, satz: vertrag.befund_saetze[b], hinweis: vertrag.hinweis_befunde.includes(b) })) },
  };
}

describe('Vorschau-Ableitung des Import-Assistenten', () => {
  it('nennt im Normalfall die Zahl der zu übernehmenden Zeilen', () => {
    expect(vorschauAbleitung(vorschau([{ urteil: 'neu', befunde: [] }]))).toMatchObject({
      zeilen: 1, uebernehmen: 1, nichtUebernehmen: 0, teiluebernahme: false, knopf: '1 Zeile übernehmen',
    });
  });

  it('übernimmt Zähler und Kundensätze wortgleich aus dem Vertrag', () => {
    const modell = vorschauAbleitung(vorschau([{ urteil: 'wiederholung', befunde: ['datei_bekannt'] }]));
    expect(modell).toMatchObject({ zeilen: 1, uebernehmen: 0, nichtUebernehmen: 1 });
    expect(modell.befunde).toEqual([{ befund: 'datei_bekannt', satz: vertrag.befund_saetze.datei_bekannt, hinweis: true }]);
  });
});
