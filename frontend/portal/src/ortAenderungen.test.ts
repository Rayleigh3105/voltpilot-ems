import { describe, expect, it } from 'vitest';
import type { ProtokollEintrag } from './api';
import {
  KNOPF_AENDERUNGEN,
  KNOPF_ARCHIVIEREN,
  KNOPF_VERSCHIEBEN,
  mitAenderungen,
  type MenueEintrag,
} from './ortArchiv';
import {
  bereichNurAngelegt,
  h2Angelegt,
  h2Flaeche3400,
  h2Flaeche3600,
  h2Verschoben,
  halle2Protokoll,
  werkAhrenbergProtokoll,
} from './test/ortAenderungenFixtures';
import { werkAhrenberg } from './test/standorteFixtures';
import { ortRueckwirkendMarke, protokollListe, zeile, type ProtokollListenEintrag } from './uemsProtokoll';

/**
 * Das Änderungsprotokoll der Ortsstruktur (UEMS AP-02 IP-14, Mockup H2) — der Vitest-Beleg des
 * Wortlauts „rückwirkend (n Tage)“. Die Dauer rechnet der Zwilling des Ortsbaum-Vertrags
 * (`uemsOrtsbaum.rueckwirkung`), das Urteil ist das gespeicherte des Schreibwegs.
 */

/** 20.05.2027, 18:00 Uhr in Berlin — die Bezugszeit „heute“. */
const JETZT = Date.parse('2027-05-20T18:00:00+02:00');

const zeilen = (eintraege: ProtokollListenEintrag[]) =>
  eintraege.flatMap((e) => (e.art === 'zeile' ? [e.zeile] : []));

describe('eine Zeile der Ortsstruktur (H2)', () => {
  it('A2: der nachgetragene Umzug trägt „rückwirkend (37 Tage)“ und gilt ab einem TAG', () => {
    const z = zeile(h2Verschoben(), 'eintrag', false);
    expect(z.marke).toBe('rückwirkend (37 Tage)');
    expect(z.giltAb).toBe('gilt ab 01.02.2027');
    expect(z.eingetragen).toBe('eingetragen am 10.03.2027, 09:30 Uhr');
    expect(z.zeit).toBe('09:30');
    expect(z.satz).toBe('Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)');
    expect(z.urheber).toBe('Ines Kaltenbach');
    expect(z.grund).toBe('Umzug der Spritzgussfertigung nachgetragen');
  });

  it('A3: Fläche ab 01.01.2027, eingetragen am 15.01.2027 — „rückwirkend (14 Tage)“, wie der Vertrag zählt', () => {
    const z = zeile(h2Flaeche3400(), 'eintrag', false);
    expect(z.marke).toBe('rückwirkend (14 Tage)');
    expect(z.satz).toBe('Bezugsfläche geändert: 3.100 m² → 3.400 m²');
    expect(z.giltAb).toBe('gilt ab 01.01.2027');
  });

  it('ein Tag in der Einzahl; angekündigt und sofort behalten ihre Marke', () => {
    expect(ortRueckwirkendMarke({ ...h2Verschoben(), gilt_ab: '2027-03-09T00:00:00+01:00' })).toBe(
      'rückwirkend (1 Tag)',
    );
    expect(zeile(h2Flaeche3600(), 'eintrag', false).marke).toBe('angekündigt');
    expect(zeile(h2Angelegt(), 'eintrag', false).marke).toBeNull();
  });

  it('das gespeicherte Urteil gewinnt: findet der Vertrag keine Dauer, bleibt „rückwirkend“ ohne Zahl', () => {
    const selberTag = { ...h2Verschoben(), gilt_ab: '2027-03-10T00:00:00+01:00' };
    expect(ortRueckwirkendMarke(selberTag)).toBe('rückwirkend');
  });

  it('eine Messstelle bleibt, wie AP-04 IP-21 sie zeigt: „rückwirkend“ ohne Dauer, „gilt ab“ mit Uhrzeit', () => {
    const wechsel: ProtokollEintrag = {
      ...h2Verschoben(),
      id: 'messstelle:42',
      quelle: 'messstelle',
      art: 'zaehler_gewechselt',
      text: 'Zähler gewechselt: Z-5a → Z-5b',
      gilt_ab: '2026-11-18T10:40:00+01:00',
      eingetragen_am: '2026-11-18T11:05:00+01:00',
    };
    const z = zeile(wechsel, 'wirkung', false);
    expect(z.marke).toBe('rückwirkend');
    expect(z.giltAb).toBe('gilt ab 18.11.2026, 10:40 Uhr');
  });
});

describe('die Liste eines Ortes', () => {
  it('nach dem Eintrag: der Umzug vom 10.03. steht über der Notiz vom 20.02., obwohl er früher gilt', () => {
    const view = protokollListe([halle2Protokoll()], JETZT, { anlegeSatz: true, ohneBezug: 'x' });
    expect(zeilen(view.eintraege).map((z) => z.satz)).toEqual([
      'Bezugsfläche geändert: 3.400 m² → 3.600 m²',
      'Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)',
      'Gebäude bearbeitet: Notiz geändert',
      'Bezugsfläche geändert: 3.100 m² → 3.400 m²',
      'Gebäude angelegt: Halle 2',
    ]);
    expect(view.achseSatz).toBe('Sortiert danach, wann die Änderung eingetragen wurde.');
    expect(view.hinweis).toBeNull();
    expect(zeilen(view.eintraege).every((z) => z.bezug === null)).toBe(true);
  });

  it('„Seit dem Anlegen am 01.10.2026 keine Änderung.“ — nur mit genau dem Anlege-Eintrag und nur, wenn der Wirt es will', () => {
    expect(protokollListe([bereichNurAngelegt()], JETZT, { anlegeSatz: true }).hinweis).toBe(
      'Seit dem Anlegen am 01.10.2026 keine Änderung.',
    );
    expect(protokollListe([bereichNurAngelegt()], JETZT).hinweis).toBeNull();
    expect(
      protokollListe([{ ...bereichNurAngelegt(), weiter: '1:ort:7' }], JETZT, { anlegeSatz: true }).hinweis,
    ).toBeNull();
    expect(protokollListe([halle2Protokoll()], JETZT, { anlegeSatz: true }).hinweis).toBeNull();
  });

  it('am Standort nennt jede Zeile ihr Objekt — Gebäude, Bereich, Anlage —, der Standort selbst nicht', () => {
    const view = protokollListe([werkAhrenbergProtokoll()], JETZT, {
      mitBezug: true,
      ohneBezug: werkAhrenberg().id,
    });
    expect(zeilen(view.eintraege).map((z) => z.bezug)).toEqual([
      'G-2 · Halle 2',
      'G-2 · Halle 2',
      null,
      'G-2 · Halle 2',
      'B-3 · Halle 2 Montage',
      'G-2 · Halle 2',
      'G-1 · Halle 1',
      'Werk Ahrenberg – Halle 2',
      null,
    ]);
  });
});

describe('das Menü mit dem Änderungsprotokoll (V1)', () => {
  const verschieben: MenueEintrag = { art: 'verschieben', knopf: true, text: KNOPF_VERSCHIEBEN };
  const archivieren: MenueEintrag = { art: 'archivieren', knopf: true, text: KNOPF_ARCHIVIEREN };

  it('steht direkt hinter „Verschieben …“ und vor „Archivieren …“', () => {
    expect(mitAenderungen([verschieben, archivieren]).map((e) => e.text)).toEqual([
      KNOPF_VERSCHIEBEN,
      KNOPF_AENDERUNGEN,
      KNOPF_ARCHIVIEREN,
    ]);
  });

  it('ohne „Verschieben“ ganz vorn — und ohne Menü gibt es auch keinen Eintrag', () => {
    expect(mitAenderungen([archivieren]).map((e) => e.art)).toEqual(['aenderungen', 'archivieren']);
    expect(mitAenderungen([])).toEqual([]);
  });
});
