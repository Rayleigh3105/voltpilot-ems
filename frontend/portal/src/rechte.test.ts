import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UEMS_ROLLEN_STANDORT, UEMS_ROLLEN_UNTERNEHMEN, UEMS_ROLLE_UNTERSTUETZER } from './glossar';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import {
  AENDERUNGEN,
  ARTEN,
  darf,
  ERINNERUNG_TAGE,
  geltungsbereich,
  gewaehren,
  GRUENDE,
  handeingriff,
  HOECHSTENS_MONATE,
  KONTEN,
  KONTO_ZUSTAENDE,
  matrixAus,
  NOTFALL_STUNDEN,
  OCPP_STUFEN,
  ocppStufe,
  ROLLE_KUNDENWORT,
  ROLLE_NOETIG_REIHENFOLGE,
  ROLLEN,
  sichtbareStandorte,
  summe,
  teilansicht,
  TEXTE,
  UMFAENGE,
  UMFANG_KUNDENWORT,
  unterstuetzung,
  UNTERSTUETZUNG_ZUSTAENDE,
  VORGABE_TAGE,
  vorgabeUmfang,
  zuweisungAendern,
  type Aktion,
  type Art,
  type Benutzer,
  type Kundenbereich,
  type Rolle,
  type Umfang,
  type Ziel,
  type Zuweisung,
} from './rechte';

/**
 * Der RECHTE-VERTRAG (UEMS AP-03 IP-1) gegen die EINE geteilte Vektor-Datei —
 * dieselbe, die der Java-Zwilling `services/api .../uems/RechteAbleitungVectorsTest`
 * fährt; die Matrix ist `rechte-matrix.json`. Die Prüfung gegen das
 * Referenzunternehmen und die Build-Prüfung der erzeugten Tabelle
 * (`rechte-matrix.md`) laufen im Java-Test.
 *
 * Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string) => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));

type Ableitung =
  | 'darf'
  | 'sichtbare_standorte'
  | 'teilansicht'
  | 'summe'
  | 'geltungsbereich'
  | 'ocpp_stufe'
  | 'unterstuetzung'
  | 'gewaehren'
  | 'handeingriff'
  | 'zuweisung_aendern';

interface Fall {
  name: string;
  familie: string;
  ableitung: Ableitung;
  abnahme: string | null;
  why: string;
  annahme: string | null;
  // Die Eingänge sind snake_case wie die Datei; jede Ableitung liest ihre eigenen Felder.
  input: any;
  expected: any;
}

const vectors: {
  zeitzone: string;
  familien: string[];
  abnahmefaelle: string[];
  vokabular: Record<string, string[]>;
  gruende: { code: string; http: number }[];
  regeln: Record<string, any>;
  texte: Record<string, string>;
  widersprueche: { kennung: string; faelle: string[] }[];
  cases: Fall[];
} = lies('rechte-vectors.json');
interface Handlung {
  handlung: string;
  kennungen: string[];
  zuordnung: 'neu' | 'zugeordnet';
}
const matrixDatei: {
  rollen: { kennung: string; kundenwort: string }[];
  umfaenge: { kennung: string; kundenwort: string }[];
  konzept_tabelle: { aktionen: number };
  aktionen: (Aktion & { herkunft: string; nachtrag?: string; wie?: string })[];
  nachtraege: { abschnitt: string; handlungen: Handlung[] }[];
} = lies('rechte-matrix.json');
const matrix = matrixAus(matrixDatei);
const ZONE = vectors.zeitzone;

// ─────────────────────────────────────────────────────── Eingänge lesen

function zuweisung(z: any): Zuweisung {
  return {
    rolle: z.rolle,
    standorte: z.standorte,
    umfang: z.umfang,
    art: z.art,
    gueltigAb: z.gueltig_ab,
    gueltigBis: z.gueltig_bis,
    beendetAm: z.beendet_am,
  };
}

function benutzer(b: any): Benutzer {
  return { kennung: b.kennung, name: b.name, konto: b.konto, zustand: b.zustand, zuweisungen: b.zuweisungen.map(zuweisung) };
}

const kundenbereich = (k: any): Kundenbereich => k;

function ziel(z: any): Ziel {
  return {
    standort: z.standort,
    anlage:
      z.anlage === null
        ? null
        : {
            kennzeichen: z.anlage.kennzeichen,
            zuordnungen: z.anlage.zuordnungen.map((x: any) => ({
              standort: x.standort,
              gueltigAb: x.gueltig_ab,
              gueltigBis: x.gueltig_bis,
            })),
          },
    stichtag: z.stichtag,
  };
}

// ─────────────────────────────────── Ergebnisse in die Form der Datei bringen

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function alsDatei(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(alsDatei);
  if (x !== null && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [snake(k), alsDatei(v)]));
  }
  return x;
}

function rechne(c: Fall): unknown {
  const i = c.input;
  switch (c.ableitung) {
    case 'darf':
      return darf(matrix, benutzer(i.benutzer), kundenbereich(i.kundenbereich), i.aktion, ziel(i.ziel), i.jetzt);
    case 'sichtbare_standorte':
      return sichtbareStandorte(benutzer(i.benutzer), kundenbereich(i.kundenbereich), i.jetzt, ZONE);
    case 'teilansicht':
      return { teilansicht: teilansicht(i.namen, i.gesamt, i.unternehmensweit) };
    case 'summe':
      return summe(i.werte, i.sichtbar, i.gesamt);
    case 'geltungsbereich':
      return geltungsbereich(i.objekt.geltungsbereich, i.sichtbar, i.unternehmensweit);
    case 'ocpp_stufe':
      return ocppStufe(benutzer(i.benutzer), kundenbereich(i.kundenbereich), i.standort, i.jetzt);
    case 'unterstuetzung': {
      const u = i.unterstuetzung;
      return unterstuetzung(
        {
          art: u.art,
          umfang: u.umfang,
          standorte: u.standorte,
          gewaehrtAm: u.gewaehrt_am,
          gueltigAb: u.gueltig_ab,
          gueltigBis: u.gueltig_bis,
          beendetAm: u.beendet_am,
          beendetVon: u.beendet_von,
          unterstuetzer: u.unterstuetzer,
          grund: u.grund,
        },
        kundenbereich(i.kundenbereich),
        i.jetzt,
        ZONE,
      );
    }
    case 'gewaehren': {
      const a = i.antrag;
      return gewaehren(
        { art: a.art, umfang: a.umfang, standorte: a.standorte, gueltigAb: a.gueltig_ab, gueltigBis: a.gueltig_bis, grund: a.grund },
        ZONE,
      );
    }
    case 'handeingriff': {
      const h = i.handeingriff;
      return handeingriff(
        matrix,
        { standort: h.standort, bis: h.bis, gesetztVon: h.gesetzt_von, setzer: benutzer(h.setzer) },
        kundenbereich(i.kundenbereich),
        i.jetzt,
        ZONE,
      );
    }
    case 'zuweisung_aendern':
      return zuweisungAendern(
        matrix,
        benutzer(i.handelnder),
        i.betroffener,
        i.aenderung,
        kundenbereich(i.kundenbereich),
        i.jetzt,
      );
  }
}

const ZEIT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Zeitpunkte werden als Instant verglichen („+01:00" und „Z" meinen dasselbe). */
function gleicheZeiten(ist: unknown, soll: unknown): unknown {
  if (Array.isArray(soll) && Array.isArray(ist)) return ist.map((x, n) => gleicheZeiten(x, soll[n]));
  if (soll !== null && typeof soll === 'object' && ist !== null && typeof ist === 'object') {
    return Object.fromEntries(
      Object.entries(ist as Record<string, unknown>).map(([k, v]) => [k, gleicheZeiten(v, (soll as any)[k])]),
    );
  }
  if (typeof ist === 'string' && typeof soll === 'string' && ZEIT.test(ist) && ZEIT.test(soll)) {
    return Date.parse(ist) === Date.parse(soll) ? soll : ist;
  }
  return ist;
}

// ────────────────────────────────────────────────────────────── die Fälle

describe('rechte · jeder Fall der geteilten Vektoren', () => {
  it('hat Fälle in jeder Familie', () => {
    expect(vectors.cases.length).toBeGreaterThan(100);
  });

  for (const c of vectors.cases) {
    it(`${c.familie} · ${c.name}`, () => {
      const ist = gleicheZeiten(alsDatei(rechne(c)), c.expected);
      expect(ist, c.why).toEqual(c.expected);
    });
  }
});

// ─────────────────────────────────────────────────────── die Datei als Ganzes

describe('rechte · Vokabular, Sätze und Matrix sind dieselben', () => {
  it('beide Dateien halten ihr Schema (Wurzel = Vektoren, $defs/matrix = Matrix)', () => {
    const schema = lies('rechte.schema.json');
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
    expect(schemaVerstoesse(matrixDatei, schema, schema.$defs.matrix)).toEqual([]);
  });

  it('das Vokabular ist dasselbe — und in derselben Reihenfolge', () => {
    const v = vectors.vokabular;
    expect(v.konto).toEqual([...KONTEN]);
    expect(v.konto_zustand).toEqual([...KONTO_ZUSTAENDE]);
    expect(v.art).toEqual([...ARTEN]);
    expect(v.umfang).toEqual([...UMFAENGE]);
    expect(v.ocpp_stufe).toEqual([...OCPP_STUFEN]);
    expect(v.unterstuetzung_zustand).toEqual([...UNTERSTUETZUNG_ZUSTAENDE]);
    expect(v.aenderung).toEqual([...AENDERUNGEN]);
    expect(v.rolle_noetig_reihenfolge).toEqual([...ROLLE_NOETIG_REIHENFOLGE]);
  });

  it('die Gründe tragen denselben Status', () => {
    expect(Object.fromEntries(vectors.gruende.map((g) => [g.code, g.http]))).toEqual(GRUENDE);
  });

  it('die Kundensätze sind dieselben', () => {
    expect(vectors.texte).toEqual(TEXTE);
  });

  it('die Regel-Zahlen sind dieselben', () => {
    const r = vectors.regeln;
    expect(r.unterstuetzung_hoechstens_monate).toBe(HOECHSTENS_MONATE);
    expect(r.unterstuetzung_vorgabe_tage).toBe(VORGABE_TAGE);
    expect(r.erinnerung_tage).toBe(ERINNERUNG_TAGE);
    expect(r.notfall_stunden).toBe(NOTFALL_STUNDEN);
    for (const [art, umfang] of Object.entries(r.vorgabe_umfang)) {
      expect(vorgabeUmfang(art as Art), art).toBe(umfang as Umfang);
    }
  });

  it('die Rollen der Matrix sind die sieben Spalten — mit den Wörtern aus glossar.ts', () => {
    expect(matrixDatei.rollen.map((r) => r.kennung)).toEqual([...ROLLEN]);
    for (const r of matrixDatei.rollen) expect(ROLLE_KUNDENWORT[r.kennung as Rolle]).toBe(r.kundenwort);
    const woerter = matrixDatei.rollen.map((r) => r.kundenwort);
    expect(woerter).toEqual(
      expect.arrayContaining([...UEMS_ROLLEN_UNTERNEHMEN, ...UEMS_ROLLEN_STANDORT, UEMS_ROLLE_UNTERSTUETZER]),
    );
    expect(matrixDatei.umfaenge.map((u) => [u.kennung, u.kundenwort])).toEqual(Object.entries(UMFANG_KUNDENWORT));
  });

  it('die Matrix hat die 48 Konzept-Zeilen plus die Nachträge, jede Kennung eindeutig, und jede Aktion eines Falls steht darin', () => {
    const konzept = matrixDatei.aktionen.filter((a) => a.nachtrag === undefined);
    expect(konzept).toHaveLength(48);
    expect(konzept).toHaveLength(matrixDatei.konzept_tabelle.aktionen);
    expect(matrixDatei.aktionen.length).toBeGreaterThan(48);
    expect(matrix.size).toBe(matrixDatei.aktionen.length);
    expect(new Set(matrixDatei.aktionen.map((a) => a.kennung)).size).toBe(matrixDatei.aktionen.length);
    for (const c of vectors.cases) {
      if (c.input.aktion !== undefined) expect(matrix.has(c.input.aktion), c.name).toBe(true);
    }
  });

  it('jede Nachtrags-Zeile steht gegen ihre Herkunft, und jede Handlung der Rechte-Abschnitte trägt eine Kennung der Matrix', () => {
    const zeilen = new Map(matrixDatei.aktionen.map((a) => [a.kennung, a]));
    const neuAngelegt = new Set<string>();
    for (const n of matrixDatei.nachtraege) {
      for (const h of n.handlungen) {
        for (const k of h.kennungen) {
          const zeile = zeilen.get(k);
          expect(zeile, `${n.abschnitt} · ${h.handlung}: ${k}`).toBeDefined();
          if (h.zuordnung === 'neu') {
            expect(zeile?.nachtrag, `${n.abschnitt} legt ${k} an`).toBe(n.abschnitt);
            neuAngelegt.add(k);
          } else {
            expect(zeile?.nachtrag, `${n.abschnitt} ordnet ${k} nur zu`).not.toBe(n.abschnitt);
          }
        }
      }
    }
    const abschnitte = new Set(matrixDatei.nachtraege.map((n) => n.abschnitt));
    const gepinnt = new Set(vectors.cases.filter((c) => c.familie === 'darf').map((c) => c.input.aktion));
    for (const a of matrixDatei.aktionen.filter((x) => x.nachtrag !== undefined)) {
      expect(abschnitte.has(a.nachtrag!), a.kennung).toBe(true);
      expect(a.herkunft.startsWith(a.nachtrag!), `Herkunft von ${a.kennung}`).toBe(true);
      expect(neuAngelegt.has(a.kennung), `keine Handlung legt ${a.kennung} an`).toBe(true);
      expect(gepinnt.has(a.kennung), `kein darf-Fall für ${a.kennung}`).toBe(true);
      if (a.wie !== undefined) expect(a.zellen, `${a.kennung} wie ${a.wie}`).toEqual(zeilen.get(a.wie)?.zellen);
    }
  });

  it('jede Familie hat Fälle, jeder Abnahmefall A1–A16 ist gepinnt, jeder Widerspruch hat seine Fälle', () => {
    expect(new Set(vectors.cases.map((c) => c.familie))).toEqual(new Set(vectors.familien));
    const abnahmen = new Set(vectors.cases.flatMap((c) => (c.abnahme === null ? [] : [c.abnahme])));
    expect(vectors.abnahmefaelle).toHaveLength(16);
    for (const a of vectors.abnahmefaelle) expect(abnahmen, a).toContain(a);
    const namen = new Set(vectors.cases.map((c) => c.name));
    for (const w of vectors.widersprueche) for (const f of w.faelle) expect(namen, w.kennung).toContain(f);
  });

  it('jeder Fall sagt, warum er da ist — und heißt eindeutig', () => {
    for (const c of vectors.cases) expect(c.why, c.name).toBeTruthy();
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.cases.length);
  });
});
