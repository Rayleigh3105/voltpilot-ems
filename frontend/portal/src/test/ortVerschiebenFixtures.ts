import type {
  ArchivSperrgrund,
  OrtAktionen,
  OrtsbaumAmStichtag,
  OrtsbaumBereich,
  OrtVerschiebenZiel,
  OrtVerschiebung,
  OrtVerschiebungKnoten,
  OrtVerschiebungMessstelle,
} from '../api';
import { halle1, halle2, ORT_IDS, ortsbaumAhrenberg, verwaltung } from './ortsbaumFixtures';
import { werkAhrenberg, werkLindach } from './standorteFixtures';

/**
 * Antworten für „Gebäude/Bereich verschieben“ (UEMS AP-02 IP-12, V1–V4) — Namen, Kurzzeichen, Tage und
 * Messstellen nur aus dem Referenzunternehmen (Fassung 1.1), A1/A13 und den Vektor-Fällen der Familie
 * `verschieben` (`a13-folgen-karte`, `bereich-innerhalb-des-standorts`) sowie dem Gegenfall zu A2
 * (am 10.03.2027 eingetragen, gültig ab 20.02.2027):
 *
 * - `ahrenbergV1` — 20.02.2027: der Ortsbaum von Werk Ahrenberg mit `aktionen` samt `verschieben`.
 * - `halle2NachNord` — die Vorschau „Halle 2 → Werk Ahrenberg Nord ab 01.03.2027“ (A13).
 * - `halle2Verschoben` — der Eintrag dazu, mit Protokolleintrag (V4).
 * - `halle2Rueckwirkend` — derselbe Umzug rückwirkend ab 20.02.2027, eingetragen am 10.03.2027.
 * - `lagerNachHalle1` — Halle 2 Lager zieht zu Halle 1: keine Folgen.
 * - `ahrenbergV4` — 20.02.2027 nach dem Eintrag: Halle 2 steht bis 28.02.2027 bei Werk Ahrenberg, mit Abzeichen.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const NORD_ID = '5a1d0000-0000-4000-8000-000000000003';
export const AN2_ID = 'a2000000-0000-4000-8000-000000000002';
export const NA2_ID = '4a000000-0000-4000-8000-000000000002';

export const ST1: OrtVerschiebungKnoten = { id: werkAhrenberg().id, art: 'standort', kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' };
export const ST2: OrtVerschiebungKnoten = { id: werkLindach().id, art: 'standort', kurzzeichen: 'ST-2', name: 'Werk Lindach' };
export const ST3: OrtVerschiebungKnoten = { id: NORD_ID, art: 'standort', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg Nord' };
const G1: OrtVerschiebungKnoten = { id: ORT_IDS.g1, art: 'gebaeude', kurzzeichen: 'G-1', name: 'Halle 1' };
const G2: OrtVerschiebungKnoten = { id: ORT_IDS.g2, art: 'gebaeude', kurzzeichen: 'G-2', name: 'Halle 2' };

export const HALLE2_LOESCHEN =
  'Löschen geht nicht: Halle 2 hat Historie (Messstellen, Fläche und Bereiche). Gelöscht wird nur, was nie etwas getragen hat — alles andere wird archiviert.';

const HALLE2_ARCHIV =
  'Halle 2 kann nicht archiviert werden: 5 Messstellen sind hier aktiv (MS-10 Netzbezug Halle 2, MS-11 Spritzguss SG07–SG10, MS-12 Montage Linie M1, MS-13 Lager Halle 2 (Allgemein) und MS-15 Halle 2 nicht zugeordnet). Ziehen Sie die Messstellen zuerst um oder legen Sie sie still (Messstellen).';

const MESSSTELLEN: [string, string, OrtVerschiebungKnoten][] = [
  ['MS-10', 'Netzbezug Halle 2', G2],
  ['MS-11', 'Spritzguss SG07–SG10', { id: ORT_IDS.b4, art: 'bereich', kurzzeichen: 'B-4', name: 'Halle 2 Spritzguss' }],
  ['MS-12', 'Montage Linie M1', { id: ORT_IDS.b3, art: 'bereich', kurzzeichen: 'B-3', name: 'Halle 2 Montage' }],
  ['MS-13', 'Lager Halle 2 (Allgemein)', { id: ORT_IDS.b5, art: 'bereich', kurzzeichen: 'B-5', name: 'Halle 2 Lager' }],
  ['MS-15', 'Halle 2 nicht zugeordnet', G2],
];

function messstelle(kennzeichen: string, name: string, ort: OrtVerschiebungKnoten): OrtVerschiebungMessstelle {
  return { id: `3e000000-0000-4000-8000-0000000000${kennzeichen.slice(3)}`, kennzeichen, name, ort };
}

function sperre(kennzeichen: string, name: string): ArchivSperrgrund {
  return { art: 'messstelle_aktiv', objekt: 'messstelle', id: null, kennzeichen, name, weg: 'messstelle_umziehen' };
}

/** Die Ziele eines Gebäudes von Werk Ahrenberg: jeder andere Standort. */
export function zieleGebaeude(): OrtVerschiebenZiel[] {
  return [ST2, ST3].map((s) => ({ id: s.id!, art: 'standort', kurzzeichen: s.kurzzeichen!, name: s.name!, standortName: null }));
}

/** Die Ziele eines Bereichs: die Gebäude außer seinem und jeder Standort. */
export function zieleBereich(eltern: string | null): OrtVerschiebenZiel[] {
  const g = verwaltung();
  const gebaeude: OrtVerschiebenZiel[] = [
    { id: ORT_IDS.g1, art: 'gebaeude', kurzzeichen: 'G-1', name: 'Halle 1', standortName: 'Werk Ahrenberg' },
    { id: ORT_IDS.g2, art: 'gebaeude', kurzzeichen: 'G-2', name: 'Halle 2', standortName: 'Werk Ahrenberg' },
    { id: g.id, art: 'gebaeude', kurzzeichen: g.kurzzeichen, name: g.name, standortName: 'Werk Ahrenberg' },
  ];
  const standorte = [ST1, ST2, ST3].map(
    (s): OrtVerschiebenZiel => ({ id: s.id!, art: 'standort', kurzzeichen: s.kurzzeichen!, name: s.name!, standortName: null }),
  );
  return [...standorte, ...gebaeude].filter((z) => z.id !== eltern);
}

function aktionenGebaeude(name: string): OrtAktionen {
  return {
    archivieren: { erlaubt: true, text: null, gruende: [], letzterTag: '2027-02-19', mitarchiviert: [] },
    wiederherstellen: null,
    loeschen: { erlaubt: false, gruende: ['hat_messstellen'], text: `Löschen geht nicht: ${name} hat Historie (Messstellen). Gelöscht wird nur, was nie etwas getragen hat — alles andere wird archiviert.` },
    verschieben: { erlaubt: true, text: null, ziele: zieleGebaeude() },
  };
}

function mitVerschieben(baum: OrtsbaumAmStichtag): OrtsbaumAmStichtag {
  const bereich = (b: OrtsbaumBereich, eltern: string): OrtsbaumBereich => ({
    ...b,
    aktionen: { ...aktionenGebaeude(b.name), verschieben: { erlaubt: true, text: null, ziele: zieleBereich(eltern) } },
  });
  return {
    ...baum,
    gebaeude: baum.gebaeude.map((g) => ({
      ...g,
      aktionen:
        g.kurzzeichen === 'G-2'
          ? {
              archivieren: {
                erlaubt: false,
                text: HALLE2_ARCHIV,
                gruende: MESSSTELLEN.map(([kz, name]) => sperre(kz, name)),
                letzterTag: null,
                mitarchiviert: [],
              },
              wiederherstellen: null,
              loeschen: { erlaubt: false, gruende: ['hat_messstellen', 'hat_flaeche', 'hat_kinder'], text: HALLE2_LOESCHEN },
              verschieben: { erlaubt: true, text: null, ziele: zieleGebaeude() },
            }
          : aktionenGebaeude(g.name),
      bereiche: g.bereiche.map((b) => bereich(b, g.id)),
    })),
  };
}

export function ahrenbergV1(): OrtsbaumAmStichtag {
  return mitVerschieben(ortsbaumAhrenberg({ stichtag: '2027-02-20', gebaeude: [halle1(), halle2(), verwaltung()] }));
}

/** V4: nach dem Eintrag steht Halle 2 bis 28.02.2027 bei Werk Ahrenberg — mit „ab 01.03.2027 → Werk Ahrenberg Nord“. */
export function ahrenbergV4(): OrtsbaumAmStichtag {
  const baum = ahrenbergV1();
  return {
    ...baum,
    gebaeude: baum.gebaeude.map((g) =>
      g.kurzzeichen === 'G-2'
        ? {
            ...g,
            gueltigBis: '2027-02-28',
            danach: {
              ab: '2027-03-01',
              elternId: NORD_ID,
              elternArt: 'standort',
              elternName: 'Werk Ahrenberg Nord',
              standortId: NORD_ID,
              standortName: 'Werk Ahrenberg Nord',
            },
          }
        : g,
    ),
  };
}

export function halle2NachNord(over: Partial<OrtVerschiebung> = {}): OrtVerschiebung {
  return {
    ortId: ORT_IDS.g2,
    art: 'gebaeude',
    kurzzeichen: 'G-2',
    name: 'Halle 2',
    bisher: ST1,
    bisherStandort: ST1,
    neu: ST3,
    neuStandort: ST3,
    gueltigAb: '2027-03-01',
    gueltigBis: null,
    danach: null,
    rueckwirkung: { art: 'geplant', tage: 9, abzeichen: null },
    rueckwirkendBetroffen: null,
    zuordnungen: [
      { eltern: ST1, gueltigAb: '2026-10-01', gueltigBis: '2027-02-28', zustand: 'gueltig' },
      { eltern: ST3, gueltigAb: '2027-03-01', gueltigBis: null, zustand: 'geplant' },
    ],
    folgen: {
      ziehenMit: [
        { id: ORT_IDS.b3, art: 'bereich', kurzzeichen: 'B-3', name: 'Halle 2 Montage' },
        { id: ORT_IDS.b4, art: 'bereich', kurzzeichen: 'B-4', name: 'Halle 2 Spritzguss' },
        { id: ORT_IDS.b5, art: 'bereich', kurzzeichen: 'B-5', name: 'Halle 2 Lager' },
      ],
      messstellenWechselnStandort: MESSSTELLEN.map(([kz, name, ort]) => messstelle(kz, name, ort)),
      bleibenAnlagen: [{ id: AN2_ID, name: 'Werk Ahrenberg – Halle 2', standort: ST1 }],
      bleibenNetzanschluesse: [{ id: NA2_ID, kennzeichen: 'NA-2' }],
      bleibenMessstellen: [messstelle('MS-14', 'Ladepunkt Parkplatz Halle 2', ST1)],
    },
    befehle: 0,
    begruendung: null,
    protokoll: [],
    ...over,
  };
}

export function halle2Verschoben(): OrtVerschiebung {
  return halle2NachNord({
    protokoll: [
      {
        id: 4711,
        objektArt: 'gebaeude',
        objektId: ORT_IDS.g2,
        text: 'Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)',
        giltAb: '2027-03-01',
        rueckwirkend: false,
        wer: 'Ines Kaltenbach',
        eingetragenAm: '2027-02-20T10:04:00+01:00',
      },
    ],
  });
}

export function halle2Rueckwirkend(): OrtVerschiebung {
  return halle2NachNord({
    gueltigAb: '2027-02-20',
    rueckwirkung: { art: 'rueckwirkend', tage: 18, abzeichen: 'rückwirkend (18 Tage)' },
    rueckwirkendBetroffen: { von: '2027-02-20', bis: '2027-03-09' },
    zuordnungen: [
      { eltern: ST1, gueltigAb: '2026-10-01', gueltigBis: '2027-02-19', zustand: 'beendet' },
      { eltern: ST3, gueltigAb: '2027-02-20', gueltigBis: null, zustand: 'gueltig' },
    ],
    protokoll: [
      {
        id: 4712,
        objektArt: 'gebaeude',
        objektId: ORT_IDS.g2,
        text: 'Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)',
        giltAb: '2027-02-20',
        rueckwirkend: true,
        wer: 'Ines Kaltenbach',
        eingetragenAm: '2027-03-10T09:12:00+01:00',
      },
    ],
  });
}

export function lagerNachHalle1(): OrtVerschiebung {
  return {
    ...halle2NachNord(),
    ortId: ORT_IDS.b5,
    art: 'bereich',
    kurzzeichen: 'B-5',
    name: 'Halle 2 Lager',
    bisher: G2,
    bisherStandort: ST1,
    neu: G1,
    neuStandort: ST1,
    zuordnungen: [
      { eltern: G2, gueltigAb: '2026-10-01', gueltigBis: '2027-02-28', zustand: 'gueltig' },
      { eltern: G1, gueltigAb: '2027-03-01', gueltigBis: null, zustand: 'geplant' },
    ],
    folgen: { ziehenMit: [], messstellenWechselnStandort: [], bleibenAnlagen: [], bleibenNetzanschluesse: [], bleibenMessstellen: [] },
  };
}
