import type { OrtsbaumAmStichtag, StandortAmStichtag, StandorteAmStichtag } from '../api';
import { bestandSatz } from '../uemsOrtsbaum';
import { halle1, halle2, ortsbaumAhrenberg, ortsbaumLindach, verwaltung } from './ortsbaumFixtures';
import { FIXTURE_IDS, werkAhrenberg, werkLindach } from './standorteFixtures';

/**
 * Antworten von `GET /api/v1/standorte?stichtag=` und `GET …/standorte/{id}/orte?stichtag=`
 * für „Stand am …“ (UEMS AP-02 IP-13, Abnahme A12) — die Zeitachse des Szenarios
 * `ahrenberg` aus `docs/contracts/v2/ortsbaum-vectors.json` (Neukunden-Weg A4:
 * Werk Ahrenberg ab 01.10.2026, Werk Lindach ab 15.10.2026, Halle 2 3 400 m² ab
 * 01.01.2027, Werk Ahrenberg Nord angelegt 20.02.2027, Umzug Halle 2 und AN-2 ab
 * 01.03.2027). Werk Ahrenberg Nord steht nicht im Referenzunternehmen (dort
 * bewusst ausgelassen); Adresse aus dem Beispiel-Protokoll §4.4 („Gewerbering 9“).
 *
 * `A12_HEUTE` ist der 10.04.2027 (nach A1). Messstellen je Knoten GENAU dort,
 * gezählt aus den Zuordnungen des Szenarios; MS-08 zieht am 01.03.2027 von
 * Halle 1 Süd nach Halle 2 Montage. `StandortePageStandAm.test.tsx` prüft Eltern und
 * „gab es noch nicht“ gegen die Vektoren `stand_am`.
 *
 * Nur für Tests und E2E-Bühnen, nie ins Produktionsbündel.
 */

export const A12_HEUTE = '2027-04-10';
export const A12_STICHTAGE = ['2027-02-15', '2027-03-15', '2026-09-15'] as const;
export type A12Stichtag = (typeof A12_STICHTAGE)[number] | typeof A12_HEUTE;

export const ST3_ID = '5a1d0000-0000-4000-8000-000000000003';

const ANLAGE = {
  an1: { id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' },
  an2: { id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' },
  an3: { id: FIXTURE_IDS.an3, name: 'Werk Lindach' },
};

function werkAhrenbergNord(over: Partial<StandortAmStichtag> = {}): StandortAmStichtag {
  return {
    id: ST3_ID,
    kurzzeichen: 'ST-3',
    name: 'Werk Ahrenberg Nord',
    adresse: { strasse: 'Gewerbering 9', plz: null, ort: 'Ahrenberg', land: 'DE' },
    zeitzone: 'Europe/Berlin',
    zustand: 'aktiv',
    esFehlt: [],
    bestand: 'vorhanden',
    bestandText: null,
    anlagen: [{ ...ANLAGE.an2, gueltigAb: '2027-03-01', gueltigBis: null }],
    anlagenZahl: 1,
    gebaeudeZahl: 1,
    bereichZahl: 3,
    flaecheM2: 3400,
    flaecheQuelle: 'aus_gebaeuden_summiert',
    nutzung: ['produktion', 'montage', 'lager'],
    notiz: null,
    lage: null,
    archiviertAm: null,
    ...over,
  };
}

/** Am Stichtag noch nicht da: Zahlen und Fläche `null`, keine Anlage, der Satz des Servers. */
function gabEsNochNicht(s: StandortAmStichtag, stichtag: string): StandortAmStichtag {
  return {
    ...s,
    bestand: 'gab_es_noch_nicht',
    bestandText: bestandSatz('gab_es_noch_nicht', s.name, stichtag),
    anlagen: [],
    anlagenZahl: null,
    gebaeudeZahl: null,
    bereichZahl: null,
    flaecheM2: null,
    flaecheQuelle: null,
  };
}

const lindach = () => werkLindach({ anlagen: [{ ...ANLAGE.an3, gueltigAb: '2026-10-15', gueltigBis: null }] });

/** Nach dem Umzug (ab 01.03.2027): Werk Ahrenberg nur noch mit Halle 1 und Verwaltung. */
const ahrenbergNachUmzug = () =>
  werkAhrenberg({
    anlagen: [{ ...ANLAGE.an1, gueltigAb: '2026-10-01', gueltigBis: null }],
    anlagenZahl: 1,
    gebaeudeZahl: 2,
    bereichZahl: 2,
  });

export function a12Liste(stichtag: A12Stichtag): StandorteAmStichtag {
  switch (stichtag) {
    case '2027-02-15':
      return {
        stichtag,
        standorte: [
          werkAhrenberg({
            anlagen: [
              { ...ANLAGE.an1, gueltigAb: '2026-10-01', gueltigBis: null },
              { ...ANLAGE.an2, gueltigAb: '2026-10-01', gueltigBis: '2027-02-28' },
            ],
          }),
          lindach(),
        ],
        nichtGezeigt: [gabEsNochNicht(werkAhrenbergNord(), stichtag)],
        nochNichtZugeordnet: null,
      };
    case '2027-03-15':
    case A12_HEUTE:
      return {
        stichtag,
        standorte: [ahrenbergNachUmzug(), lindach(), werkAhrenbergNord()],
        nichtGezeigt: [],
        nochNichtZugeordnet: null,
      };
    case '2026-09-15':
      return {
        stichtag,
        standorte: [],
        nichtGezeigt: [werkAhrenberg(), werkLindach(), werkAhrenbergNord()].map((s) => gabEsNochNicht(s, stichtag)),
        // Das Lesemodell nennt hier jede Anlage, die es HEUTE gibt — die Sicht zeigt die Gruppe darum nicht.
        nochNichtZugeordnet: { anlagenZahl: 3, anlagen: [ANLAGE.an1, ANLAGE.an2, ANLAGE.an3] },
      };
  }
}

/** Halle 1 Süd ohne MS-08 (Kühlung zieht am 01.03.2027 nach Halle 2 Montage). */
function halle1NachUmzug() {
  const h = halle1();
  return { ...h, bereiche: h.bereiche.map((b) => (b.kurzzeichen === 'B-2' ? { ...b, messstellenZahl: 2 } : b)) };
}

function halle2NachUmzug() {
  const h = halle2({ flaecheM2: 3400 });
  return { ...h, bereiche: h.bereiche.map((b) => (b.kurzzeichen === 'B-3' ? { ...b, messstellenZahl: 2 } : b)) };
}

/** Der Ortsbaum eines Standorts am Stichtag — `null`, wenn es ihn da nicht gab (die Liste fragt dann nicht). */
export function a12Orte(standortId: string, stichtag: A12Stichtag): OrtsbaumAmStichtag | null {
  const standort = a12Liste(stichtag).standorte.find((s) => s.id === standortId);
  if (!standort) return null;
  if (standortId === FIXTURE_IDS.st2) return ortsbaumLindach({ stichtag, standort });
  if (standortId === ST3_ID) {
    return {
      stichtag,
      standort,
      summeGebaeudeM2: 3400,
      gebaeudeOhneFlaeche: [],
      gebaeude: [halle2NachUmzug()],
      direktAmStandort: { bereiche: [], messstellenZahl: 0 },
    };
  }
  return stichtag === '2027-02-15'
    ? ortsbaumAhrenberg({
        stichtag,
        standort,
        summeGebaeudeM2: 8750,
        gebaeude: [halle1(), halle2({ flaecheM2: 3400 }), verwaltung()],
      })
    : ortsbaumAhrenberg({ stichtag, standort, summeGebaeudeM2: 5350, gebaeude: [halle1NachUmzug(), verwaltung()] });
}
