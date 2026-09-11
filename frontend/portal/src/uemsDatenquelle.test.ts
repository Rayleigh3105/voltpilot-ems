import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEHLERKLASSEN,
  FUEHRUNGS_GRUENDE,
  GRUENDE,
  PROTOKOLLE,
  PRUEFREIHENFOLGE_ANTRAG,
  PRUEFREIHENFOLGE_TAUSCH,
  PRUEFREIHENFOLGE_ZEITRAUM,
  TEXTE,
  URTEILE,
  boxTausch,
  faehigkeiten,
  fehlerklasse,
  fuehrendeBox,
  pruefeAntrag,
  pruefeZeitraum,
  vorschlagsliste,
  zustaendigeBox,
  type Herkunft,
  type TabellenEintrag,
  type Zeitraum,
} from './uemsDatenquelle';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { VORGABE_ZEITZONE } from './uemsZustand';

/**
 * Der Vertrag „Datenquelle und Zuständigkeit" (UEMS AP-06 IP-1) gegen die EINE geteilte
 * Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/DatenquelleRegelnVectorsTest` fährt (dort auch der Abgleich jedes Falls
 * mit dem Referenzunternehmen; die Datei ist für beide Zwillinge dieselbe).
 *
 * Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Familie =
  | 'antrag'
  | 'zeitraeume'
  | 'zustaendig'
  | 'box_tausch'
  | 'fuehrende_box'
  | 'faehigkeiten'
  | 'fehlerklasse'
  | 'bestand';

interface Fall {
  name: string;
  familie: Familie;
  abnahme?: string;
  annahme?: string;
  why: string;
  // Die Eingänge sind snake_case wie die Datei; jede Familie liest ihre eigenen Felder.
  input: any;
  expected: any;
}

const lies = (name: string): any => JSON.parse(readFileSync(resolve(V2, name), 'utf8'));
const datei = lies('data-source-vectors.json');
const tabellenDatei = lies('edge-capabilities.json');
const tabelle: TabellenEintrag[] = tabellenDatei.faehigkeiten;
const faelle: Fall[] = datei.cases;
const vonFamilie = (f: Familie): Fall[] => faelle.filter((c) => c.familie === f);

const boxNamen = (boxen: { kennzeichen: string; name: string }[]): Record<string, string> =>
  Object.fromEntries(boxen.map((b) => [b.kennzeichen, b.name]));

/** Zeiträume nach Zeitpunkt statt Schreibweise vergleichen. */
const norm = (zs: Zeitraum[] | null): unknown =>
  zs === null
    ? null
    : zs.map((z) => ({
        box: z.box,
        von: Date.parse(z.effective_from),
        bis: z.effective_to === null ? null : Date.parse(z.effective_to),
      }));

describe('Datenquelle und Zuständigkeit — Antrag', () => {
  it.each(vonFamilie('antrag').map((c) => [c.name, c] as const))('%s', (_, c) => {
    const ist = pruefeAntrag(c.input.antrag, c.input.quellen, boxNamen(c.input.boxen), c.input.jetzt, c.input.zeitzone);
    const exp = c.expected;
    expect({ ...ist, zeitraeume: norm(ist.zeitraeume) }).toEqual({ ...exp, zeitraeume: norm(exp.zeitraeume) });
  });
});

describe('Datenquelle und Zuständigkeit — Zeiträume', () => {
  it.each(vonFamilie('zeitraeume').map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(pruefeZeitraum(c.input.bestehend, c.input.neu, boxNamen(c.input.boxen))).toEqual(c.expected);
  });
});

describe('Datenquelle und Zuständigkeit — zuständige Box', () => {
  it.each(vonFamilie('zustaendig').map((c) => [c.name, c] as const))('%s', (_, c) => {
    const ist = c.input.zeitpunkte.map((t: string) => zustaendigeBox(c.input.zeitraeume, t));
    expect(ist).toEqual(c.expected.boxen);
  });
});

describe('Datenquelle und Zuständigkeit — Box-Tausch', () => {
  it.each(vonFamilie('box_tausch').map((c) => [c.name, c] as const))('%s', (_, c) => {
    const t = c.input.tausch;
    const ist = boxTausch(c.input.quellen, t.alt, t.neu, t.zeitpunkt, c.input.jetzt, boxNamen(c.input.boxen), c.input.zeitzone);
    const ohneZeit = (qs: { kennzeichen: string; zeitraeume: Zeitraum[] }[] | null) =>
      qs === null ? null : qs.map((q) => ({ kennzeichen: q.kennzeichen, zeitraeume: norm(q.zeitraeume) }));
    expect({ ...ist, quellen: ohneZeit(ist.quellen) }).toEqual({ ...c.expected, quellen: ohneZeit(c.expected.quellen) });
  });
});

describe('Datenquelle und Zuständigkeit — führende Box', () => {
  it.each(vonFamilie('fuehrende_box').map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(fuehrendeBox(c.input.boxen, c.input.speicher_box, c.input.gespeichert)).toEqual(c.expected);
  });
});

describe('Datenquelle und Zuständigkeit — Fähigkeiten', () => {
  it.each(vonFamilie('faehigkeiten').map((c) => [c.name, c] as const))('%s', (_, c) => {
    // Ohne eigene Tabelle liest der Fall die ECHTE Datei (A7).
    expect(faehigkeiten(c.input.stand, c.input.tabelle ?? tabelle, c.input.register)).toEqual(c.expected);
  });
});

describe('Datenquelle und Zuständigkeit — Fehlerklassen', () => {
  it.each(vonFamilie('fehlerklasse').map((c) => [c.name, c] as const))('%s', (_, c) => {
    const k = fehlerklasse(c.input.code, c.input.von as Herkunft);
    expect({ klasse: k?.code ?? null, name: k?.name ?? null }).toEqual(c.expected);
  });
});

describe('Datenquelle und Zuständigkeit — Bestand', () => {
  it.each(vonFamilie('bestand').map((c) => [c.name, c] as const))('%s', (_, c) => {
    const ist = vorschlagsliste(c.input.komponenten, c.input.naechste_nummer);
    const zeitNorm = (vs: any[]) => vs.map((v) => ({ ...v, zeitraeume: norm(v.zeitraeume) }));
    expect(zeitNorm(ist)).toEqual(zeitNorm(c.expected.vorschlaege));
  });
});

describe('Datenquelle und Zuständigkeit — die Datei als Ganzes', () => {
  it('hält ihr Schema — und die Fähigkeiten-Tabelle ihres', () => {
    expect(schemaVerstoesse(datei, lies('data-source-assignment.schema.json'))).toEqual([]);
    expect(schemaVerstoesse(tabellenDatei, lies('edge-capabilities.schema.json'))).toEqual([]);
  });

  it('hat dasselbe geschlossene Vokabular — die Reihenfolgen SIND die Regel', () => {
    expect(PROTOKOLLE).toEqual(datei.protokolle);
    expect([...URTEILE]).toEqual(datei.urteile);
    expect(GRUENDE).toEqual(datei.gruende);
    expect(PRUEFREIHENFOLGE_ANTRAG).toEqual(datei.pruefreihenfolge_antrag);
    expect(PRUEFREIHENFOLGE_ZEITRAUM).toEqual(datei.pruefreihenfolge_zeitraum);
    expect(PRUEFREIHENFOLGE_TAUSCH).toEqual(datei.pruefreihenfolge_tausch);
    expect(FEHLERKLASSEN).toEqual(datei.fehlerklassen);
    expect([...FUEHRUNGS_GRUENDE]).toEqual(datei.gruende_fuehrende_box);
    expect(TEXTE).toEqual(datei.texte);
    expect(datei.zeitzone).toBe(VORGABE_ZEITZONE);
  });

  it('deckt jede Familie und jeden genannten Abnahmefall ab — mit mindestens zwölf Fällen', () => {
    expect(new Set(faelle.map((c) => c.familie))).toEqual(new Set(datei.familien));
    expect(new Set(faelle.flatMap((c) => (c.abnahme ? [c.abnahme] : [])))).toEqual(new Set(datei.abnahmefaelle));
    expect(faelle.length).toBeGreaterThanOrEqual(12);
  });

  it('jeder Fall sagt, warum er da ist, und hat einen eigenen Namen', () => {
    for (const c of faelle) expect(c.why.trim(), c.name).not.toBe('');
    expect(new Set(faelle.map((c) => c.name)).size).toBe(faelle.length);
  });

  it('die echte Fähigkeiten-Tabelle trägt heute noch kein Release', () => {
    expect(tabelle.map((e) => e.code)).toEqual(['data_sources', 'assignment_effective_at']);
    expect(tabelle.every((e) => e.ab_release === null)).toBe(true);
  });
});
