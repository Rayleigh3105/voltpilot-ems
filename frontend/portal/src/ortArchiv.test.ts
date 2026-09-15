import { describe, expect, it } from 'vitest';
import type { OrtAktionen } from './api';
import {
  archiviertAmText,
  archivierenFolgen,
  archivTag,
  KNOPF_ARCHIVIEREN,
  KNOPF_ARCHIVIEREN_GESPERRT,
  KNOPF_LOESCHEN,
  KNOPF_WIEDERHERSTELLEN,
  loeschenFolgen,
  menueEintraege,
  sperreKurz,
  wege,
  wiederherstellenFolgen,
} from './ortArchiv';

/**
 * Das Menü und die Folgenlisten aus den `aktionen` des Servers (UEMS AP-02 IP-15). Sätze und
 * Namen aus dem Referenzunternehmen und den Vektor-Fällen der Familie `archiv`
 * (`docs/contracts/v2/ortsbaum-vectors.json`).
 */

const A7_SATZ =
  'Montagehalle Lindach kann nicht archiviert werden: 1 Messstelle ist hier aktiv (MS-18 Montagehalle Lindach gesamt). Ziehen Sie die Messstelle zuerst um oder legen Sie sie still (Messstellen).';
const HALLE1_LOESCHEN =
  'Löschen geht nicht: Halle 1 hat Historie (Messstellen, Fläche und Bereiche). Gelöscht wird nur, was nie etwas getragen hat — alles andere wird archiviert.';

const gesperrtA7: OrtAktionen = {
  archivieren: {
    erlaubt: false,
    text: A7_SATZ,
    gruende: [
      {
        art: 'messstelle_aktiv',
        objekt: 'messstelle',
        id: null,
        kennzeichen: 'MS-18',
        name: 'Montagehalle Lindach gesamt',
        weg: 'messstelle_umziehen',
      },
    ],
    letzterTag: null,
    mitarchiviert: [],
  },
  wiederherstellen: null,
  loeschen: { erlaubt: false, gruende: ['hat_messstellen', 'hat_flaeche', 'hat_kinder'], text: HALLE1_LOESCHEN },
};

describe('menueEintraege — was das Menü je Knoten anbietet', () => {
  it('A7: gesperrtes Archivieren bleibt ein Eintrag mit Grund; Löschen mit Historie ist nur ein Hinweis', () => {
    expect(menueEintraege(gesperrtA7)).toEqual([
      { art: 'archivieren_gesperrt', knopf: true, text: KNOPF_ARCHIVIEREN_GESPERRT, grund: '1 Messstelle ist hier aktiv' },
      { art: 'loeschen_gesperrt', knopf: false, text: HALLE1_LOESCHEN },
    ]);
  });

  it('A9: „Löschen …“ ist nur dann ein Knopf, wenn der Server sagt, dass nie etwas hing', () => {
    const irrtum: OrtAktionen = {
      archivieren: { erlaubt: true, text: null, gruende: [], letzterTag: '2026-10-01', mitarchiviert: [] },
      wiederherstellen: null,
      loeschen: { erlaubt: true, gruende: [], text: null },
    };
    expect(menueEintraege(irrtum).map((e) => [e.text, e.knopf])).toEqual([
      [KNOPF_ARCHIVIEREN, true],
      [KNOPF_LOESCHEN, true],
    ]);
    const knoepfe = menueEintraege(gesperrtA7).filter((e) => e.knopf).map((e) => e.text);
    expect(knoepfe).not.toContain(KNOPF_LOESCHEN);
  });

  it('Z3: am archivierten Knoten Wiederherstellen — auch bei belegtem Namen (umbenannt wird im Dialog); Elternknoten archiviert = Hinweis', () => {
    const stein = (grund: 'name_belegt' | 'eltern_archiviert' | null, erlaubt: boolean): OrtAktionen => ({
      archivieren: null,
      wiederherstellen: { erlaubt, grund, text: grund ? 'Satz des Servers.' : null, ab: '2028-02-01' },
      loeschen: { erlaubt: false, gruende: ['hat_messstellen'], text: 'Löschen geht nicht: …' },
    });
    expect(menueEintraege(stein(null, true))[0]).toEqual({ art: 'wiederherstellen', knopf: true, text: KNOPF_WIEDERHERSTELLEN });
    expect(menueEintraege(stein('name_belegt', false))[0].art).toBe('wiederherstellen');
    expect(menueEintraege(stein('eltern_archiviert', false))[0]).toEqual({
      art: 'wiederherstellen_gesperrt',
      knopf: false,
      text: 'Satz des Servers.',
    });
  });

  it('mit Stichtag („Stand am …“) gibt es kein Menü', () => {
    expect(menueEintraege(null)).toEqual([]);
    expect(menueEintraege(undefined)).toEqual([]);
  });
});

describe('Z1 — Grund und Weg', () => {
  it('nennt je Sperrgrund, wer im Weg steht und was zu tun ist', () => {
    expect(wege(gesperrtA7.archivieren!.gruende)).toEqual([
      { wer: 'MS-18 Montagehalle Lindach gesamt', weg: 'Messstelle umziehen oder stilllegen' },
    ]);
    expect(
      sperreKurz([
        { art: 'anlage_aktiv', objekt: 'anlage', id: 'x', kennzeichen: null, name: 'Werk Lindach', weg: 'anlage_zuordnen' },
        { art: 'messstelle_aktiv', objekt: 'messstelle', id: null, kennzeichen: 'MS-16', name: 'Netzbezug Lindach', weg: 'messstelle_umziehen' },
        { art: 'messstelle_aktiv', objekt: 'messstelle', id: null, kennzeichen: 'MS-18', name: 'Montagehalle Lindach gesamt', weg: 'messstelle_umziehen' },
      ]),
    ).toBe('Die Anlage Werk Lindach ist aktiv und 2 Messstellen sind hier aktiv');
  });
});

describe('Folgenlisten', () => {
  it('Z2/A8: Halle 2 Lager — Ende der Zuordnung, alte Berichte unverändert, sichtbar, wiederherstellbar', () => {
    const folgen = archivierenFolgen('bereich', {
      erlaubt: true,
      text: null,
      gruende: [],
      letzterTag: '2027-06-29',
      mitarchiviert: [],
    });
    expect(folgen.map((f) => f.titel)).toEqual([
      'Zuordnung endet am 29.06.2027',
      'Bleibt sichtbar',
      'Wiederherstellen jederzeit möglich',
    ]);
    expect(folgen[0].text).toBe('Berichte bis dahin bleiben, wie sie sind.');
    expect(folgen[1].text).toBe('Ausgegraut mit „Archiviert am 30.06.2027“; in „Stand am …“ vor dem 30.06.2027 wie bisher.');
  });

  it('AP-12 IP-9: gefragt wird ab dem Archivtag; „Freigegebene Berichte“ steht zuletzt, mit Punkt — die Sätze davor bleiben', () => {
    const a = { erlaubt: true, text: null, gruende: [], letzterTag: '2027-06-29', mitarchiviert: [] };
    expect(archivTag(a)).toBe('2027-06-30');
    expect(archivTag({ ...a, letzterTag: '2027-12-31' })).toBe('2028-01-01');
    expect(archivTag({ ...a, letzterTag: null })).toBeNull();

    const berichte = { titel: 'Freigegebene Berichte', text: '4 zitieren Messstellen dieses Orts — sie bleiben unverändert' };
    const folgen = archivierenFolgen('bereich', a, berichte);
    expect(folgen.at(-1)).toEqual({
      titel: 'Freigegebene Berichte',
      text: '4 zitieren Messstellen dieses Orts — sie bleiben unverändert.',
    });
    expect(folgen.slice(0, -1)).toEqual(archivierenFolgen('bereich', a));
    expect(folgen[0].text).toBe('Berichte bis dahin bleiben, wie sie sind.');
    expect(archivierenFolgen('bereich', a, null).map((f) => f.titel)).not.toContain('Freigegebene Berichte');
  });

  it('ein Gebäude nennt die leeren Bereiche, die mitgehen; der Standort sagt, dass Anlagen und Messstellen bleiben', () => {
    const a = {
      erlaubt: true,
      text: null,
      gruende: [],
      letzterTag: '2026-10-19',
      mitarchiviert: [{ id: 'b7', art: 'bereich' as const, kurzzeichen: 'B-7', name: 'Montage Lindach' }],
    };
    expect(archivierenFolgen('gebaeude', a)[2]).toEqual({
      titel: 'Wird mitarchiviert',
      text: 'Montage Lindach (B-7) — ohne aktive Messstelle.',
    });
    const standort = archivierenFolgen('standort', { ...a, mitarchiviert: [] });
    expect(standort[0].titel).toBe('Besteht bis 19.10.2026');
    expect(standort.map((f) => f.titel)).toContain('Anlagen und Messstellen bleiben, wie sie sind');
  });

  it('Z3/A8: Wiederherstellen am 01.02.2028 — neue Gültigkeit, die Lücke bleibt, das Kurzzeichen bleibt', () => {
    expect(wiederherstellenFolgen('bereich', 'B-5', '2027-06-30', '2028-02-01')).toEqual([
      { titel: 'Gilt wieder ab 01.02.2028', text: 'Die Zeit vom 30.06.2027 bis dahin bleibt sichtbar — sie wird nie aufgefüllt.' },
      { titel: 'Kurzzeichen B-5 bleibt', text: 'Alte Berichte und der Export finden es unverändert.' },
    ]);
    expect(wiederherstellenFolgen('gebaeude', 'G-2', null, '2028-02-01').at(-1)?.titel).toBe('Mitarchiviertes bleibt archiviert');
  });

  it('A9: die Rückfrage vor dem Löschen — endgültig, Kurzzeichen nicht wieder vergeben, Eintrag bei Halle 2', () => {
    expect(loeschenFolgen('bereich', 'Halle 2 Test', 'B-8', 'Halle 2').map((f) => f.titel)).toEqual([
      'Endgültig',
      'Kurzzeichen B-8 wird nicht wieder vergeben',
      'Das Protokoll behält es',
    ]);
    expect(loeschenFolgen('bereich', 'Halle 2 Test', 'B-8', 'Halle 2')[2].text).toBe(
      'Bei Halle 2 steht: „Bereich Halle 2 Test gelöscht“.',
    );
  });

  it('der Archivtag in Kundensprache', () => {
    expect(archiviertAmText('2027-06-30')).toBe('Archiviert am 30.06.2027');
  });
});
