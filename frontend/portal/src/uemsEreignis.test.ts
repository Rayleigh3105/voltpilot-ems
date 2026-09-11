import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANZAHL_WORT,
  EREIGNIS_ARTEN,
  EREIGNIS_TEXTE,
  FELDTYP,
  GRUND_TEXT,
  dauerText,
  ereignisName,
  ereignisSatz,
  type Ereignis,
} from './uemsEreignis';

/**
 * Der KUNDENSATZ des Ereignis-Vokabulars (UEMS AP-07 IP-3) gegen die EINE geteilte
 * Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/EreignisVokabularVectorsTest` fährt (dort das Urteil, hier der Satz).
 * Die Namen der Boxen, Komponenten und Messstellen kommen aus dem Referenzunternehmen.
 *
 * Wer eine Art, ein Feld oder einen Satz ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

interface ArtVektor {
  art: string;
  name: string;
  zeit: { form: 'zeitpunkt' | 'zeitraum'; offen_erlaubt: boolean };
  bezug_pflicht: string[];
  bezug_erlaubt: string[];
  pflicht: string[];
  felder: string[];
  variante_nach: string | null;
  saetze: Record<string, string>;
  zusaetze: Record<string, string>;
}

interface Fall {
  name: string;
  pruefung: 'ereignis' | 'umschlag' | 'fortschreibung';
  why: string;
  input: {
    ereignis?: Ereignis;
    neu?: Ereignis;
    umschlag?: { device_id: string; events: Ereignis[] };
  };
  expected: { urteil: string; saetze: string[] };
}

interface Vektoren {
  zeitzone: string;
  kennungen: { boxen: Record<string, string> };
  vokabular: {
    grund: { code: string; text: string }[];
    anlass_geraetegrenze: string[];
    anlass_uebergabe: string[];
    felder: Record<string, { typ: string }>;
    arten: ArtVektor[];
  };
  cases: Fall[];
}

interface Referenz {
  boxen: { kennzeichen: string; name: string }[];
  komponenten: { kennzeichen: string; name: string }[];
  messstellen: { kennzeichen: string; name: string }[];
}

const V = JSON.parse(readFileSync(resolve(V2, 'events-vocabulary-vectors.json'), 'utf8')) as Vektoren;
const REF = JSON.parse(readFileSync(resolve(V2, 'uems-referenzunternehmen.json'), 'utf8')) as Referenz;

const NAMEN: Record<string, string> = Object.fromEntries(
  [...REF.boxen, ...REF.komponenten, ...REF.messstellen].map((x) => [x.kennzeichen, x.name]),
);
const BOX_VON_UUID: Record<string, string> = Object.fromEntries(
  Object.entries(V.kennungen.boxen).map(([k, uuid]) => [uuid, k]),
);

describe('Ereignis-Vokabular: der TS-Zwilling spricht dieselben Sätze wie die Vektor-Datei', () => {
  it('kennt dieselben Arten in derselben Reihenfolge', () => {
    expect([...EREIGNIS_ARTEN]).toEqual(V.vokabular.arten.map((a) => a.art));
  });

  it('hat je Art dieselbe Überschrift, dieselben Sätze und Zusätze', () => {
    for (const a of V.vokabular.arten) {
      const t = EREIGNIS_TEXTE[a.art as keyof typeof EREIGNIS_TEXTE];
      expect(t.name, a.art).toBe(a.name);
      expect(ereignisName(a.art as keyof typeof EREIGNIS_TEXTE)).toBe(a.name);
      expect(t.zeitraum, a.art).toBe(a.zeit.form === 'zeitraum');
      expect(t.varianteNach, a.art).toBe(a.variante_nach);
      expect(t.saetze, a.art).toEqual(a.saetze);
      expect(Object.entries(t.zusaetze), a.art).toEqual(Object.entries(a.zusaetze));
    }
  });

  it('hat dieselben Ablehnungsgründe mit demselben Kundentext', () => {
    expect(Object.entries(GRUND_TEXT)).toEqual(V.vokabular.grund.map((g) => [g.code, g.text]));
  });

  it('kennt jedes Feld mit demselben Typ', () => {
    expect(FELDTYP).toEqual(Object.fromEntries(Object.entries(V.vokabular.felder).map(([k, f]) => [k, f.typ])));
  });

  it('hat je Anlass bzw. offenem Zeitraum genau einen Satz, und jeder Platzhalter ist ein Feld der Art', () => {
    for (const a of V.vokabular.arten) {
      const varianten =
        a.variante_nach === null
          ? ['standard']
          : a.art === 'device_boundary'
            ? V.vokabular.anlass_geraetegrenze
            : V.vokabular.anlass_uebergabe;
      const erwartet = varianten.flatMap((v) => (a.zeit.offen_erlaubt ? [v, `${v}_offen`] : [v]));
      expect(Object.keys(a.saetze).sort(), a.art).toEqual([...erwartet].sort());
      const felder = new Set([
        'ereignis_id',
        ...(a.zeit.form === 'zeitpunkt' ? ['zeitpunkt'] : ['von', 'bis']),
        ...a.bezug_pflicht,
        ...a.bezug_erlaubt,
        ...a.pflicht,
        ...a.felder,
      ]);
      for (const vorlage of [...Object.values(a.saetze), ...Object.values(a.zusaetze)]) {
        for (const [, feld] of vorlage.matchAll(/\{(\w+)\}/g)) {
          const anzahl = /^anzahl_(\w+)$/.exec(feld);
          if (anzahl !== null) {
            expect(felder.has('anzahl'), `${a.art}: ${feld}`).toBe(true);
            expect(ANZAHL_WORT[anzahl[1]], `${a.art}: ${feld}`).toBeDefined();
          } else {
            expect(felder.has(feld), `${a.art}: {${feld}}`).toBe(true);
          }
        }
      }
      for (const feld of Object.keys(a.zusaetze)) expect(felder.has(feld), `${a.art}: Zusatz ${feld}`).toBe(true);
    }
  });

  describe('jeder angenommene Fall spricht genau seine Sätze', () => {
    for (const c of V.cases.filter((x) => x.expected.saetze.length > 0)) {
      it(c.name, () => {
        const ereignisse: Ereignis[] =
          c.pruefung === 'ereignis'
            ? [c.input.ereignis!]
            : c.pruefung === 'fortschreibung'
              ? [c.input.neu!]
              : c.input.umschlag!.events.map((e) => ({ ...e, box: BOX_VON_UUID[c.input.umschlag!.device_id] }));
        expect(
          ereignisse.map((e) => ereignisSatz(e, NAMEN, V.zeitzone)),
          c.why,
        ).toEqual(c.expected.saetze);
      });
    }
  });

  it('rät keine unbekannte Art', () => {
    expect(() => ereignisSatz({ art: 'power_failure' })).toThrow(/unbekannte Ereignisart/);
  });

  it('spricht Dauern mit den zwei größten Einheiten', () => {
    expect(dauerText(0)).toBe('0 s');
    expect(dauerText(390)).toBe('6 min 30 s');
    expect(dauerText(-390)).toBe('6 min 30 s');
    expect(dauerText(840)).toBe('14 min');
    expect(dauerText(3600)).toBe('1 h');
    expect(dauerText(86400)).toBe('1 Tag');
    expect(dauerText(7866000)).toBe('91 Tage 1 h');
    expect(dauerText(90061)).toBe('1 Tag 1 h');
  });
});
