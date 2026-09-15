import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archivierenFolgen, wiederherstellenFolgen } from './ortArchiv';
import * as B from './uemsBericht';

/**
 * W2 (AP-12, entschieden 14.09.2026: „Auflösung übernommen“) — der Archivieren-Dialog (AP-02 IP-15, `ortArchiv.ts`) sagt
 * zwei Sätze über Berichte, geschrieben, als es noch keine Berichte gab: „Berichte bis dahin bleiben, wie sie sind.“ und
 * „Alte Berichte und der Export finden es unverändert.“ AP-12 löst beide ein (E1 = A Kopie, B6 Beenden ist kein Anstoß,
 * A5 stabile Kennzeichen). Dieser Test pinnt jeden Satz WÖRTLICH an die Regeln, die ihn wahr machen — gelesen aus
 * `bericht-vectors.json`, gesprochen vom Zwilling `uemsBericht.ts`. Ändert sich eine dieser Regeln, wird er rot, bevor
 * der Dialog etwas verspricht, das nicht mehr gilt. Die Sätze bleiben wörtlich stehen (W2).
 */
type Json = any;
const vektoren: Json = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/bericht-vectors.json'), 'utf8'));
const alle = (regel: string): Json[] => (vektoren.cases as Json[]).flatMap((c) => c.pruefungen as Json[]).filter((p) => p.regel === regel);
const fall = (id: string): Json => (vektoren.cases as Json[]).find((c) => c.id === id);

/** Quellen stehen in der Datei als Gruppen je Bericht, Stand, Bezug und Tagen — hier eine Zeile je Objekt. */
const quellenZeilen = (gruppen: Json[]): B.Quelle[] =>
  gruppen.flatMap((g) => (g.objekte as string[]).map((objekt) => ({ ...g, objekte: undefined, objekt }) as B.Quelle));

const SATZ_ARCHIVIEREN = 'Berichte bis dahin bleiben, wie sie sind.';
const SATZ_WIEDERHERSTELLEN = 'Alte Berichte und der Export finden es unverändert.';
/** Die Art, die Archivieren an `ort_aenderung` schreibt (`OrtAenderungRepository.ARCHIVIERT`). */
const ARCHIVIERT = 'archiviert';
const ARCHIV = { erlaubt: true, text: null, gruende: [], letzterTag: '2026-12-31', mitarchiviert: [] };

describe(`W2 · „${SATZ_ARCHIVIEREN}“`, () => {
  it('steht wörtlich als erste Folge jedes Archivierens — Standort, Gebäude, Bereich', () => {
    for (const art of ['standort', 'gebaeude', 'bereich'] as const) expect(archivierenFolgen(art, ARCHIV)[0].text, art).toBe(SATZ_ARCHIVIEREN);
  });

  it('E1 = A: ein Berichtsstand ist eine Kopie — seine kanonische Form ergibt die gespeicherte Prüfsumme, ohne lebende Zeile', () => {
    const pruefungen = alle('kanonisch').filter((p) => p.eingang.abzug !== 'randfall');
    expect(pruefungen.length).toBeGreaterThanOrEqual(2);
    for (const p of pruefungen) {
      const text = B.kanonisch(vektoren.abzuege[p.eingang.abzug]);
      expect(B.PRUEFSUMME_PRAEFIX + createHash('sha256').update(text, 'utf8').digest('hex'), p.eingang.abzug).toBe(p.ergebnis.pruefsumme);
    }
  });

  it('B6: Beenden zum Tag ist kein Anstoß — Archivieren ist für den Strukturänderungs-Läufer keine Strukturänderung', () => {
    for (const objekt of ['standort', 'gebaeude', 'bereich']) {
      expect(B.struktur(B.ORT_AENDERUNG, objekt, ARCHIVIERT, false, false), objekt).toEqual({ anstoss_art: null, grund: B.KEINE_STRUKTURAENDERUNG });
    }
  });

  it('B11: was ab dem Tag nach dem Ende gilt, trifft keinen Bericht bis dahin — und einen Tag früher träfe es ihn (der Test beißt)', () => {
    const b11 = fall('B11').pruefungen.find((p: Json) => p.regel === 'betroffenheit');
    const quellen = quellenZeilen(b11.eingang.quellen);
    const { objekte, gilt_ab: giltAb } = b11.eingang.struktur;
    expect(b11.ergebnis.betroffene).toEqual([]);
    expect(B.betroffeneStruktur(quellen, objekte, giltAb)).toEqual([]);
    expect(B.betroffeneStruktur(quellen, objekte, '2026-12-31').length).toBeGreaterThan(0);
  });
});

describe(`W2 · „${SATZ_WIEDERHERSTELLEN}“`, () => {
  it('steht wörtlich unter „Kurzzeichen … bleibt“', () => {
    expect(wiederherstellenFolgen('bereich', 'B-5', '2027-06-30', '2028-02-01')[1]).toEqual({ titel: 'Kurzzeichen B-5 bleibt', text: SATZ_WIEDERHERSTELLEN });
  });

  it('A5: der Abzug trägt Kennzeichen, Namen und Orte zum Datenstand selbst — jede Zahl und das Quellenverzeichnis', () => {
    for (const schluessel of ['BR-2026-0001/1', 'BR-2026-0001/2']) {
      const abzug = vektoren.abzuege[schluessel];
      expect(abzug.werte.every((w: Json) => /^MS-\d+$/.test(w.quelle) && typeof w.name_zum_datenstand === 'string'), schluessel).toBe(true);
      expect(abzug.kopf.quellenverzeichnis.length, schluessel).toBeGreaterThan(0);
    }
  });

  it('B10: eine Umbenennung ist kein Anstoß; der Stand behält den Namen, „heute: …“ ist nur ein Hinweis daneben', () => {
    const umbenannt = alle('struktur').filter((p) => p.eingang.art === 'bearbeitet');
    expect(umbenannt.length).toBeGreaterThanOrEqual(2);
    for (const p of umbenannt) {
      const e = p.eingang;
      expect(B.struktur(e.protokoll, e.objekt_art, e.art, e.rueckwirkend, e.korrektur)).toEqual({ anstoss_art: null, grund: B.UMBENENNUNG });
    }
    const heute = alle('kennzeichen').find((p) => p.eingang.schluessel === 'heute' && p.ergebnis.text !== null);
    expect(B.heute(heute.eingang.name_zum_datenstand, heute.eingang.name_heute)).toBe(heute.ergebnis.text);
  });

  it('der Export: die CSV-Zeile eines Stands nennt die Quelle über ihr Kennzeichen aus dem Abzug (B14)', () => {
    const zeilen = alle('csv_zeile');
    expect(zeilen.length).toBeGreaterThan(0);
    for (const p of zeilen) {
      const zeile = B.csvZeile(p.eingang, vektoren.zeitzone);
      expect(zeile).toBe(p.ergebnis.zeile);
      expect(zeile.startsWith(`${p.eingang.quelle}${B.CSV_TRENNER}`)).toBe(true);
    }
  });
});
