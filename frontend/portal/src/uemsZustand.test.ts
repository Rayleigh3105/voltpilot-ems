import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EINHEITEN,
  LUECKE_FAKTOR,
  STEUERT_GRUND_TEXT,
  TOLERANZ_FAKTOR,
  TOLERANZ_HOECHSTENS_S,
  TOLERANZ_MINDESTENS_S,
  VORGABE_ZEITZONE,
  aggregatLiefertDaten,
  aggregatSteuert,
  berechnet,
  liefertDaten,
  liefertDatenAnlage,
  steuert,
  type AnlageGrund,
  type BoxZustand,
  type EinheitCode,
  type LiefertDatenZustand,
  type Quellzustand,
  type SteuertGrund,
} from './uemsZustand';

/**
 * Das ZUSTANDSVOKABULAR „liefert Daten" und „steuert" (UEMS AP-00 IP-3) gegen
 * die EINE geteilte Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/ZustandAbleitungVectorsTest` fährt.
 *
 * Wer die Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const VECTORS = resolve(process.cwd(), '../../docs/contracts/v2/uems-zustand-vectors.json');

interface Fall {
  name: string;
  familie: 'liefert_daten' | 'steuert';
  ableitung: 'einzel' | 'anlage' | 'aggregat' | 'berechnet';
  why: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

interface VectorFile {
  schema_version: string;
  zeitzone: string;
  toleranz: {
    faktor: number;
    mindestens_s: number;
    hoechstens_s: number;
    kante_gehoert_zu_liefert: boolean;
    luecke_faktor: number;
  };
  zustaende_liefert_daten: LiefertDatenZustand[];
  gruende_anlage: AnlageGrund[];
  gruende_steuert: SteuertGrund[];
  einheiten: Record<string, { singular: string; plural: string }>;
  cases: Fall[];
}

const vectors: VectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'));

function faelle(familie: Fall['familie'], ableitung: Fall['ableitung']): Fall[] {
  return vectors.cases.filter((c) => c.familie === familie && c.ableitung === ableitung);
}

describe('uemsZustand · liefert Daten (geteilte Vektoren)', () => {
  const cases = faelle('liefert_daten', 'einzel');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input as {
        quelle_vorhanden: boolean;
        letzter_guter_wert: string | null;
        je_ein_wert: boolean;
        kadenz_s: number;
        jetzt: string;
        zeitzone?: string;
      };
      expect(
        liefertDaten({
          quelleVorhanden: i.quelle_vorhanden,
          letzterGuterWert: i.letzter_guter_wert,
          jeEinWert: i.je_ein_wert,
          kadenzS: i.kadenz_s,
          jetzt: i.jetzt,
          zeitzone: i.zeitzone,
        }),
      ).toEqual({
        zustand: c.expected.zustand,
        seit: c.expected.seit,
        toleranzS: c.expected.toleranz_s,
        lueckeOffen: c.expected.luecke_offen,
        text: c.expected.text,
      });
    });
  }
});

describe('uemsZustand · Anlage (geteilte Vektoren)', () => {
  const cases = faelle('liefert_daten', 'anlage');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input as {
        boxen: BoxZustand[];
        hauptzaehler: Quellzustand | null;
        jetzt: string;
        zeitzone?: string;
      };
      const ist = liefertDatenAnlage({
        boxen: i.boxen,
        hauptzaehler: i.hauptzaehler,
        jetzt: i.jetzt,
        zeitzone: i.zeitzone,
      });
      expect({
        zustand: ist.liefert ? 'liefert' : 'liefert_nicht',
        grund: ist.grund,
        seit: ist.seit,
        text: ist.text,
      }).toEqual(c.expected);
    });
  }
});

describe('uemsZustand · Aggregat „x von y" (geteilte Vektoren)', () => {
  const cases = [...faelle('liefert_daten', 'aggregat'), ...faelle('steuert', 'aggregat')];

  it('hat Fälle beider Familien', () => {
    expect(faelle('liefert_daten', 'aggregat').length).toBeGreaterThan(0);
    expect(faelle('steuert', 'aggregat').length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.familie} · ${c.name}`, () => {
      const i = c.input as { einheit: EinheitCode; einzel: string[] };
      if (c.familie === 'steuert') {
        const ist = aggregatSteuert(
          i.einzel.map((z) => z === 'steuert'),
          i.einheit,
        );
        expect({ steuernd: ist.erfuellt, gesamt: ist.gesamt, text: ist.text }).toEqual(c.expected);
      } else {
        const ist = aggregatLiefertDaten(i.einzel as LiefertDatenZustand[], i.einheit);
        expect({ liefernd: ist.erfuellt, gesamt: ist.gesamt, text: ist.text }).toEqual(c.expected);
      }
    });
  }
});

describe('uemsZustand · berechnete Messstelle (geteilte Vektoren)', () => {
  const cases = faelle('liefert_daten', 'berechnet');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input as {
        eingaenge: { kennzeichen: string; zustand: LiefertDatenZustand; seit: string | null }[];
        jetzt: string;
        zeitzone?: string;
      };
      const ist = berechnet(i.eingaenge, i.jetzt, i.zeitzone);
      expect({
        zustand: ist.vollstaendig ? 'vollstaendig' : 'unvollstaendig',
        fehlend: ist.fehlend,
        seit: ist.seit,
        text: ist.text,
      }).toEqual(c.expected);
    });
  }
});

describe('uemsZustand · steuert (geteilte Vektoren)', () => {
  const cases = faelle('steuert', 'einzel');

  it('hat Fälle', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const i = c.input as {
        freigabe_erteilt: boolean;
        funktion_gestartet: boolean;
        laeuft: boolean;
        laeuft_art: 'betriebsmodell' | 'regel' | null;
        laeuft_name: string | null;
        box_verbunden: boolean;
        box_bestaetigt: boolean;
        ruhe_eintrag: boolean;
      };
      const ist = steuert({
        freigabeErteilt: i.freigabe_erteilt,
        funktionGestartet: i.funktion_gestartet,
        laeuft: i.laeuft,
        laeuftArt: i.laeuft_art,
        laeuftName: i.laeuft_name,
        boxVerbunden: i.box_verbunden,
        boxBestaetigt: i.box_bestaetigt,
        ruheEintrag: i.ruhe_eintrag,
      });
      expect({
        zustand: ist.steuert ? 'steuert' : 'steuert_nicht',
        grund: ist.grund,
        text: ist.text,
      }).toEqual(c.expected);
    });
  }
});

describe('uemsZustand · die Datei als Ganzes', () => {
  /**
   * Die Konstanten der Regel stehen in der Vektor-Datei UND im Code. Sie hier
   * gegeneinander zu prüfen ist der Unterschied zwischen „dokumentiert" und
   * „bewiesen" — ein geänderter Faktor fiele sonst erst in einem einzelnen
   * Zahlenfall auf.
   */
  it('die Regel-Konstanten stimmen mit der Datei überein', () => {
    expect(vectors.toleranz.faktor).toBe(TOLERANZ_FAKTOR);
    expect(vectors.toleranz.mindestens_s).toBe(TOLERANZ_MINDESTENS_S);
    expect(vectors.toleranz.hoechstens_s).toBe(TOLERANZ_HOECHSTENS_S);
    expect(vectors.toleranz.luecke_faktor).toBe(LUECKE_FAKTOR);
    expect(vectors.toleranz.kante_gehoert_zu_liefert).toBe(true);
    expect(vectors.zeitzone).toBe(VORGABE_ZEITZONE);
  });

  /** Die Reihenfolge IST die Regel: sie entscheidet, welcher Grund gilt, wenn mehrere zutreffen. */
  it('das Vokabular ist dasselbe — und in derselben Reihenfolge', () => {
    expect(vectors.zustaende_liefert_daten).toEqual([
      'liefert',
      'liefert_nicht_seit',
      'wartet_auf_erste_daten',
      'keine_datenquelle',
    ]);
    expect(vectors.gruende_steuert).toEqual(Object.keys(STEUERT_GRUND_TEXT));
  });

  it('die Einheiten-Tabelle ist dieselbe', () => {
    expect(vectors.einheiten).toEqual(EINHEITEN);
  });

  it('jeder Fall sagt, warum er da ist', () => {
    for (const c of vectors.cases) {
      expect(c.why, c.name).toBeTruthy();
    }
  });
});
