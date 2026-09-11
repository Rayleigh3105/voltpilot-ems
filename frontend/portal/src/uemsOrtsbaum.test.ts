import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHIV_GRUENDE,
  EINTRAG_GRUENDE,
  ERLAUBTE_ELTERN,
  FLAECHE_QUELLEN,
  LISTEN_GRUENDE,
  LOESCH_GRUENDE,
  NICHT_GEZEIGT_GRUENDE,
  OBJEKT_ZUSTAENDE,
  ORT_ARTEN,
  RUECKWIRKUNG_ARTEN,
  UNTERNEHMEN,
  VERORTUNG_GRUENDE,
  VORGABE_ZEITZONE,
  WIEDERHERSTELL_GRUENDE,
  ZUORDNUNG_ZUSTAENDE,
  archivieren,
  eintrag,
  flaecheAm,
  flaecheZeitraum,
  loeschen,
  nameBelegt,
  nameBelegtSatz,
  pruefeIntervalle,
  rueckwirkung,
  standAm,
  teile,
  verortung,
  verschiebenFolgen,
  wiederherstellen,
  type Anlage,
  type EintragAntrag,
  type Intervall,
  type Messstelle,
  type Ort,
  type Ortsbaum,
} from './uemsOrtsbaum';

/**
 * Der ORTSBAUM (UEMS AP-02 IP-1) gegen die EINE geteilte Vektor-Datei —
 * dieselbe, die der Java-Zwilling `services/api .../uems/OrtsbaumAbleitungVectorsTest`
 * fährt. Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 *
 * Die Ergebnisse tragen camelCase; die Datei snake_case. `schlange()` übersetzt
 * die Schlüssel — die Werte vergleicht `toEqual` unverändert. vitest läuft mit
 * cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const VECTORS = resolve(process.cwd(), '../../docs/contracts/v2/ortsbaum-vectors.json');

/** Die Eingänge sind so vielgestaltig wie die Familien; der Läufer liest sie je Familie. */
type Eingang = Record<string, any>;

interface Fall {
  name: string;
  familie: string;
  ableitung: string;
  why: string;
  input: Eingang;
  expected: unknown;
}

interface Szenario {
  beschreibung: string;
  orte: Ort[];
  anlagen: Anlage[];
  messstellen: Messstelle[];
}

interface VectorFile {
  schema_version: string;
  zeitzone: string;
  regeln: Record<string, unknown>;
  arten_ort: string[];
  erlaubte_eltern: Record<string, string[]>;
  zustaende_zuordnung: string[];
  gruende_liste: string[];
  gruende_eintrag: string[];
  arten_rueckwirkung: string[];
  gruende_nicht_gezeigt: string[];
  gruende_verortung: string[];
  gruende_archivieren: string[];
  gruende_wiederherstellen: string[];
  gruende_loeschen: string[];
  flaeche_quellen: string[];
  objekt_zustaende: string[];
  szenarien: Record<string, Szenario>;
  cases: Fall[];
}

const vectors: VectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'));

/** Jedes Objekt der Überlagerung ERSETZT das mit demselben Kennzeichen oder kommt neu dazu. */
function ueberlagere<T extends { kennzeichen: string }>(basis: T[], neu: T[] | undefined): T[] {
  const out = basis.map((x) => neu?.find((n) => n.kennzeichen === x.kennzeichen) ?? x);
  for (const n of neu ?? []) {
    if (!basis.some((x) => x.kennzeichen === n.kennzeichen)) out.push(n);
  }
  return out;
}

function baumFuer(input: Eingang): Ortsbaum {
  const s = vectors.szenarien[input.szenario as string];
  expect(s, `Szenario ${input.szenario}`).toBeDefined();
  const u = (input.ueberlagerung ?? {}) as Partial<Szenario>;
  return {
    zeitzone: vectors.zeitzone,
    orte: ueberlagere(s.orte, u.orte),
    anlagen: ueberlagere(s.anlagen, u.anlagen),
    messstellen: ueberlagere(s.messstellen, u.messstellen),
  };
}

/** camelCase-Schlüssel → snake_case, rekursiv; `undefined` fällt weg wie in JSON. */
function schlange(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(schlange);
  if (x === null || typeof x !== 'object') return x;
  return Object.fromEntries(
    Object.entries(x as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), schlange(v)]),
  );
}

function antrag(i: Eingang): EintragAntrag {
  return { objekt: i.objekt, vorgang: i.vorgang, ab: i.ab, eltern: i.eltern, heute: i.heute };
}

/** Je Familie/Ableitung der Aufruf — derselbe Schnitt wie im Java-Test. */
const LAEUFER: Record<string, (i: Eingang) => unknown> = {
  'stand_am/baum': (i) => standAm(baumFuer(i), i.stichtag),
  'ueberlappung/liste': (i) => pruefeIntervalle(i.intervalle as Intervall[]),
  'ueberlappung/eintrag': (i) => eintrag(baumFuer(i), antrag(i)),
  'rueckwirkend/kennzeichen': (i) =>
    rueckwirkung({
      eingetragenUm: i.eingetragen_um,
      giltAb: i.gilt_ab,
      giltBis: i.gilt_bis,
      zeitzone: i.zeitzone,
      zeitraum: i.zeitraum ?? null,
    }),
  'messstelle_standort/am_tag': (i) => verortung(baumFuer(i), i.messstelle, i.tag),
  'verschieben/folgen': (i) => verschiebenFolgen(baumFuer(i), antrag(i)),
  'archiv/archivieren': (i) => archivieren(baumFuer(i), i.objekt, i.tag),
  'archiv/wiederherstellen': (i) => wiederherstellen(baumFuer(i), i.objekt, i.tag, i.neuer_name ?? null),
  'archiv/loeschen': (i) => loeschen(baumFuer(i), i.objekt),
  'zeitraum_teilung/teile': (i) => ({ teile: teile(baumFuer(i), i.objekt, i.von, i.bis) }),
  'flaeche/am_tag': (i) => flaecheAm(baumFuer(i), i.objekt, i.tag),
  'flaeche/zeitraum': (i) => ({ teile: flaecheZeitraum(baumFuer(i), i.objekt, i.von, i.bis) }),
};

for (const schluessel of Object.keys(LAEUFER)) {
  const [familie, ableitung] = schluessel.split('/');
  const cases = vectors.cases.filter((c) => c.familie === familie && c.ableitung === ableitung);

  describe(`uemsOrtsbaum · ${familie} · ${ableitung} (geteilte Vektoren)`, () => {
    it('hat Fälle', () => {
      expect(cases.length).toBeGreaterThan(0);
    });
    for (const c of cases) {
      it(c.name, () => {
        expect(schlange(LAEUFER[schluessel](c.input))).toEqual(c.expected);
      });
    }
  });
}

describe('uemsOrtsbaum · der Vertrag selbst', () => {
  it('jeder Fall hat einen Läufer — keine Familie fällt still heraus', () => {
    const ohne = vectors.cases
      .filter((c) => LAEUFER[`${c.familie}/${c.ableitung}`] === undefined)
      .map((c) => c.name);
    expect(ohne).toEqual([]);
  });

  it('jeder Fall sagt, warum er da ist', () => {
    for (const c of vectors.cases) expect(c.why.trim(), c.name).not.toBe('');
  });

  it('Fallnamen sind eindeutig', () => {
    const namen = vectors.cases.map((c) => c.name);
    expect(new Set(namen).size).toBe(namen.length);
  });

  it('die Regel-Konstanten sind dieselben', () => {
    expect(vectors.zeitzone).toBe(VORGABE_ZEITZONE);
    expect(vectors.regeln.unternehmen_kennzeichen).toBe(UNTERNEHMEN);
    expect(vectors.regeln.bis_ist_letzter_tag).toBe(true);
    expect(vectors.erlaubte_eltern).toEqual(ERLAUBTE_ELTERN);
  });

  it('das Vokabular ist dasselbe — die Reihenfolge IST die Regel', () => {
    expect(vectors.arten_ort).toEqual([...ORT_ARTEN]);
    expect(vectors.zustaende_zuordnung).toEqual([...ZUORDNUNG_ZUSTAENDE]);
    expect(vectors.gruende_liste).toEqual([...LISTEN_GRUENDE]);
    expect(vectors.gruende_eintrag).toEqual([...EINTRAG_GRUENDE]);
    expect(vectors.arten_rueckwirkung).toEqual([...RUECKWIRKUNG_ARTEN]);
    expect(vectors.gruende_nicht_gezeigt).toEqual([...NICHT_GEZEIGT_GRUENDE]);
    expect(vectors.gruende_verortung).toEqual([...VERORTUNG_GRUENDE]);
    expect(vectors.gruende_archivieren).toEqual([...ARCHIV_GRUENDE]);
    expect(vectors.gruende_wiederherstellen).toEqual([...WIEDERHERSTELL_GRUENDE]);
    expect(vectors.gruende_loeschen).toEqual([...LOESCH_GRUENDE]);
    expect(vectors.flaeche_quellen).toEqual([...FLAECHE_QUELLEN]);
    expect(vectors.objekt_zustaende).toEqual([...OBJEKT_ZUSTAENDE]);
  });

  // A10 über `nameBelegt` — dieselbe Prüfung wie im Java-Zwilling (a10DieNamensregelBeimAnlegenUndUmbenennen).
  it('A10: die Namensregel beim Anlegen und Umbenennen', () => {
    const b = baumFuer({ szenario: 'ahrenberg-vor-dem-umzug' });
    const tag = '2026-10-20';
    const g1 = nameBelegt(b, 'gebaeude', 'ST-1', '  halle 1 ', tag, null);
    expect(g1?.kennzeichen).toBe('G-1');
    expect(nameBelegtSatz(g1 as Ort)).toBe(
      'Diesen Namen gibt es hier schon: Halle 1 (G-1). Wählen Sie einen anderen Namen — oder öffnen Sie Halle 1.',
    );
    expect(nameBelegt(b, 'gebaeude', 'ST-2', 'Halle 1', tag, null)).toBeUndefined();
    expect(nameBelegt(b, 'gebaeude', 'ST-1', 'Halle 1', tag, 'G-1')).toBeUndefined();
    expect(nameBelegt(b, 'standort', null, 'WERK LINDACH', tag, null)?.kennzeichen).toBe('ST-2');
    // Werk Ahrenberg Nord gibt es erst ab 20.02.2027 — vorher belegt es seinen Namen nicht.
    expect(nameBelegt(b, 'standort', null, 'Werk Ahrenberg Nord', tag, null)).toBeUndefined();
  });

  it('jedes Szenario ist in sich überlappungsfrei — die Beispieldaten halten die eigene Regel', () => {
    for (const [name, s] of Object.entries(vectors.szenarien)) {
      const listen: [string, Intervall[]][] = [
        ...s.orte.map((o): [string, Intervall[]] => [o.kennzeichen, o.intervalle]),
        ...s.anlagen.map((a): [string, Intervall[]] => [a.kennzeichen, a.zuordnungen]),
        ...s.messstellen.map((m): [string, Intervall[]] => [m.kennzeichen, m.zuordnungen]),
      ];
      for (const [kz, liste] of listen) {
        expect(pruefeIntervalle(liste).gueltig, `${name} · ${kz}`).toBe(true);
      }
    }
  });
});
