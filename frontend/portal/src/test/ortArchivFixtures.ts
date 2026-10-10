import type { ArchivSperrgrund, OrtAktionen, OrtLoeschGrund, OrtsbaumAmStichtag, OrtsbaumBereich } from '../api';
import { halle1, halle2, ORT_IDS, ortsbaumAhrenberg, ortsbaumLindach, verwaltung } from './ortsbaumFixtures';

/**
 * Antworten von `GET /api/v1/standorte/{id}/orte` MIT `aktionen` und archivierten Knoten
 * (UEMS AP-02 IP-15) — Namen, Kurzzeichen, Tage und Sätze nur aus dem Referenzunternehmen
 * (Fassung 1.1), den Abnahmefällen A7/A8/A9 und den Vektor-Fällen der Familie `archiv`:
 *
 * - `lindachA7` — 20.10.2026: Montagehalle Lindach (G-5) mit aktiver MS-18 (Z1).
 * - `ahrenbergA9` — 02.10.2026 10:05: „Halle 2 Test“ irrtümlich angelegt (ohne Historie),
 *   Halle 1 mit Messstellen, Fläche und Bereichen (A9).
 * - `ahrenbergA8Archivieren` — 30.06.2027: Halle 2 Lager nach dem Umzug von MS-13 (Z2).
 * - `ahrenbergA8Archiviert` — Halle 2 Lager, archiviert am 30.06.2027 (Z3): heute, in
 *   „Stand am 15.07.2027“ oder am 01.02.2028 mit inzwischen vergebenem Namen.
 *
 * Jeder Knoten trägt `aktionen`, wie der Server sie ohne Stichtag schickt. Nur für Tests und
 * E2E-Bühnen, nie ins Produktionsbündel.
 */

export const B8_HALLE_2_TEST = 'b0e70000-0000-4000-8000-000000000008';

/** Vektor-Fall `a7-sperre-sagt-aktiv-nicht-liefert-daten`, Satz Zeichen für Zeichen. */
export const A7_SATZ =
  'Montagehalle Lindach kann nicht archiviert werden: 1 Messstelle ist hier aktiv (MS-18 Montagehalle Lindach gesamt). Ziehen Sie die Messstelle zuerst um oder legen Sie sie still (Messstellen).';

export const HALLE1_LOESCHEN = loeschenSatz('Halle 1', 'Messstellen, Fläche und Bereiche');

function loeschenSatz(name: string, historie: string): string {
  return `Löschen geht nicht: ${name} hat Historie (${historie}). Gelöscht wird nur, was nie etwas getragen hat — alles andere wird archiviert.`;
}

function messstelle(kennzeichen: string, name: string): ArchivSperrgrund {
  return { art: 'messstelle_aktiv', objekt: 'messstelle', id: null, kennzeichen, name, weg: 'messstelle_umziehen' };
}

function gesperrt(text: string, gruende: ArchivSperrgrund[]): NonNullable<OrtAktionen['archivieren']> {
  return { erlaubt: false, text, gruende, letzterTag: null, mitarchiviert: [] };
}

function erlaubt(letzterTag: string): NonNullable<OrtAktionen['archivieren']> {
  return { erlaubt: true, text: null, gruende: [], letzterTag, mitarchiviert: [] };
}

function historie(name: string, gruende: OrtLoeschGrund[], worte: string): NonNullable<OrtAktionen['loeschen']> {
  return { erlaubt: false, gruende, text: loeschenSatz(name, worte) };
}

/** Jeder Knoten im Baum mit Aktionen: Vorgabe „archivierbar, Löschen wegen Messstellen gesperrt“. */
function mitAktionen(
  baum: OrtsbaumAmStichtag,
  letzterTag: string,
  je: Record<string, OrtAktionen> = {},
): OrtsbaumAmStichtag {
  const aktionen = (b: OrtsbaumBereich): OrtAktionen =>
    je[b.kurzzeichen] ?? {
      archivieren: erlaubt(letzterTag),
      wiederherstellen: null,
      loeschen: historie(b.name, ['hat_messstellen'], 'Messstellen'),
    };
  return {
    ...baum,
    gebaeude: baum.gebaeude.map((g) => ({
      ...g,
      aktionen: aktionen(g),
      bereiche: g.bereiche.map((b) => ({ ...b, aktionen: aktionen(b) })),
    })),
  };
}

export function lindachA7(): OrtsbaumAmStichtag {
  return mitAktionen(ortsbaumLindach(), '2026-10-19', {
    'G-5': {
      archivieren: gesperrt(A7_SATZ, [messstelle('MS-18', 'Montagehalle Lindach gesamt')]),
      wiederherstellen: null,
      loeschen: historie('Montagehalle Lindach', ['hat_messstellen', 'hat_flaeche', 'hat_kinder'], 'Messstellen, Fläche und Bereiche'),
    },
  });
}

export function ahrenbergA9(): OrtsbaumAmStichtag {
  const g2 = halle2();
  const test: OrtsbaumBereich = {
    id: B8_HALLE_2_TEST,
    kurzzeichen: 'B-8',
    name: 'Halle 2 Test',
    nutzung: null,
    notiz: null,
    zustand: 'aktiv',
    gueltigAb: '2026-10-02',
    gueltigBis: null,
    flaecheM2: null,
    flaecheQuelle: null,
    messstellenZahl: 0,
  };
  return mitAktionen(
    ortsbaumAhrenberg({ stichtag: '2026-10-02', gebaeude: [halle1(), { ...g2, bereiche: [...g2.bereiche, test] }, verwaltung()] }),
    '2026-10-01',
    {
      'G-1': {
        archivieren: gesperrt(
          'Halle 1 kann nicht archiviert werden: 2 Messstellen sind hier aktiv (MS-03 PV-Erzeugung Dach Halle 1 und MS-09 Halle 1 + Verwaltung nicht zugeordnet). Ziehen Sie die Messstellen zuerst um oder legen Sie sie still (Messstellen).',
          [messstelle('MS-03', 'PV-Erzeugung Dach Halle 1'), messstelle('MS-09', 'Halle 1 + Verwaltung nicht zugeordnet')],
        ),
        wiederherstellen: null,
        loeschen: { erlaubt: false, gruende: ['hat_messstellen', 'hat_flaeche', 'hat_kinder'], text: HALLE1_LOESCHEN },
      },
      'B-8': { archivieren: erlaubt('2026-10-01'), wiederherstellen: null, loeschen: { erlaubt: true, gruende: [], text: null } },
    },
  );
}

export function ahrenbergA8Archivieren(): OrtsbaumAmStichtag {
  const g2 = halle2();
  return mitAktionen(
    ortsbaumAhrenberg({
      stichtag: '2027-06-30',
      gebaeude: [
        halle1(),
        { ...g2, bereiche: g2.bereiche.map((b) => (b.kurzzeichen === 'B-5' ? { ...b, messstellenZahl: 0 } : b)) },
        verwaltung(),
      ],
    }),
    '2027-06-29',
  );
}

/**
 * Halle 2 Lager, archiviert am 30.06.2027. Ohne Stichtag „heute“ (15.07.2027, bzw. 01.02.2028 mit
 * `nameBelegt`) mit Aktionen; mit Stichtag („Stand am …“) ohne — dort ändert man nichts.
 */
export function ahrenbergA8Archiviert(opts: { stichtag?: string; nameBelegt?: boolean } = {}): OrtsbaumAmStichtag {
  const g2 = halle2();
  const heute = opts.nameBelegt ? '2028-02-01' : '2027-07-15';
  const baum = ortsbaumAhrenberg({
    stichtag: opts.stichtag ?? heute,
    gebaeude: [halle1(), { ...g2, bereiche: g2.bereiche.filter((b) => b.kurzzeichen !== 'B-5') }, verwaltung()],
    archiviert: [
      {
        id: ORT_IDS.b5,
        art: 'bereich',
        kurzzeichen: 'B-5',
        name: 'Halle 2 Lager',
        nutzung: ['lager'],
        archiviertAm: '2027-06-30',
        elternId: ORT_IDS.g2,
        elternArt: 'gebaeude',
        aktionen: opts.stichtag
          ? null
          : {
              archivieren: null,
              wiederherstellen: opts.nameBelegt
                ? { erlaubt: false, grund: 'name_belegt', text: 'Diesen Namen gibt es hier schon: Halle 2 Lager (B-8).', ab: heute }
                : { erlaubt: true, grund: null, text: null, ab: heute },
              loeschen: historie('Halle 2 Lager', ['hat_messstellen'], 'Messstellen'),
            },
      },
    ],
  });
  return opts.stichtag ? baum : mitAktionen(baum, '2027-07-14');
}
