import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

/**
 * VoltPilot-Registerbild WAGO v1 (UEMS AP-05 IP-2): `docs/contracts/v2/wago-registerbild.md`, sein Schema
 * und die Vektor-Datei. Es gibt noch keinen Zwilling (Edge IP-6, Kopf-Prüfung IP-7) — darum liest hier ein
 * kleiner, unabhängiger Leser jeden Fall aus den rohen Wörtern nach. Die Vektor-Datei wurde per Skript aus den
 * Absichten kodiert; stimmen beide überein, gehen die Rechnungen auf.
 *
 * Außerdem: jede Zahl hat eine Herkunft (Festlegung, Handbuch mit Seite, Repo mit Zeile oder „zu erheben“),
 * Vertrag und Hardwareblatt-Vorlage nennen dieselben Offsets, Messwert-IDs und Datentypen, und die
 * Rechenbeispiele im Vertrag rechnen richtig.
 */
const ROOT = resolve(process.cwd(), '../..');
const V2 = resolve(ROOT, 'docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const schema: Json = lies(resolve(V2, 'wago-registerbild.schema.json'));
const vektoren: Json = lies(resolve(V2, 'wago-registerbild-vectors.json'));
const vertrag = readFileSync(resolve(V2, 'wago-registerbild.md'), 'utf8');
const hardwareblatt = readFileSync(resolve(ROOT, 'docs/wago/hardwareblatt-vorlage.md'), 'utf8');

const LAEUFER_SCHLUESSEL = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'anyOf',
  'enum', 'const', 'pattern', 'minItems', 'minLength', 'maxLength', 'minimum', 'maximum',
]);

const fremdeSchluessel = (s: Json, pfad: string): string[] => {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return [];
  return Object.entries(s).flatMap(([k, v]: [string, Json]) => {
    const hier = LAEUFER_SCHLUESSEL.has(k) ? [] : [`${pfad}.${k}`];
    if (k === 'properties' || k === '$defs') {
      return [...hier, ...Object.entries(v).flatMap(([n, t]) => fremdeSchluessel(t, `${pfad}.${k}.${n}`))];
    }
    if (k === 'items' || k === 'additionalProperties') return [...hier, ...fremdeSchluessel(v, `${pfad}.${k}`)];
    if (k === 'anyOf') return [...hier, ...(v as Json[]).flatMap((t, i) => fremdeSchluessel(t, `${pfad}.anyOf[${i}]`))];
    return hier;
  });
};

/** Alle Angaben (Objekte mit `art`) außerhalb der Fälle, je mit Pfad. */
const angaben = (o: Json, pfad = '$'): [string, Json][] => {
  if (o === null || typeof o !== 'object') return [];
  if (Array.isArray(o)) return o.flatMap((v, i) => angaben(v, `${pfad}[${i}]`));
  if (typeof o.art === 'string') return [[pfad, o]];
  return Object.entries(o).flatMap(([k, v]) => (k === 'faelle' ? [] : angaben(v, `${pfad}.${k}`)));
};

/** Welche Artikel ein Handbuch überhaupt belegen kann. */
const ABDECKUNG: Record<string, string[]> = {
  'WAGO-750-495': ['750-495'],
  'WAGO-750-494': ['750-494'],
  'WAGO-750-362': ['750-362', '750-494', '750-495'],
};

// ---- der unabhängige Leser: Konstanten aus der Datei, Rechnung von Hand ----
const feld = (block: Json, schluessel: string): Json => block.felder.find((f: Json) => f.schluessel === schluessel);
const regel = (f: Json, name: string): Json => f.regeln.find((r: Json) => r.name === name).angabe.wert;
const K = Object.fromEntries(vektoren.kopf.felder.map((f: Json) => [f.schluessel, f.offset]));
const B = Object.fromEntries(vektoren.karte.felder.map((f: Json) => [f.schluessel, f.offset]));
const BIT = Object.fromEntries(vektoren.gueltigkeit.bits.map((b: Json) => [b.schluessel, b.angabe.wert]));
const SIGNATUR = [feld(vektoren.kopf, 'signatur_1').wert.wert, feld(vektoren.kopf, 'signatur_2').wert.wert];
const HAUPTVERSION = feld(vektoren.kopf, 'hauptversion').wert.wert;
const KOPF_MIN = feld(vektoren.kopf, 'kopflaenge').wert.wert;
const BLOCK_MIN = feld(vektoren.kopf, 'kartenblocklaenge').wert.wert;
const PRUEFWERT = feld(vektoren.kopf, 'wortfolge_pruefwert').wert.wert;
const KARTENTYPEN: number[] = regel(feld(vektoren.karte, 'kartentyp'), 'vokabular');
const INVALID_U32 = regel(feld(vektoren.karte, 'messwerte'), 'invalid_uint32');
const INVALID_I32 = regel(feld(vektoren.karte, 'messwerte'), 'invalid_int32');
const MAX_WOERTER = vektoren.lesen.max_woerter_je_anfrage.wert;
const TYPEN: (string | null)[] = vektoren.messwerte.map((m: Json) => (m.datentyp.art === 'zu erheben' ? null : m.datentyp.wert));

const u32 = (w: number[], i: number, wortfolge: string): number => {
  const [hoch, tief] = wortfolge === 'big' ? [w[i], w[i + 1]] : [w[i + 1], w[i]];
  return hoch * 65536 + tief;
};

const typisiert = (roh: number, typ: string | null): number | null => {
  if (typ === null) return null;
  if (typ === 'UInt32') return roh === INVALID_U32 ? null : roh;
  if (roh === INVALID_I32) return null;
  return roh >= 2 ** 31 ? roh - 2 ** 32 : roh;
};

const anfragen = (kopflaenge: number, blocklaenge: number, karten: number): number => {
  let n = 1;
  let frei = MAX_WOERTER - kopflaenge;
  for (let i = 0; i < karten; i++) {
    if (blocklaenge > frei) [n, frei] = [n + 1, MAX_WOERTER];
    frei -= blocklaenge;
  }
  return n;
};

function liesRegisterbild({ parameter, soll, woerter: w }: Json): Json {
  const nichtLesbar = (grund: string, kopf: Json = null) => ({ ergebnis: 'nicht_lesbar', grund, kopf, karten: [], anfragen_mindestens: null });
  if (w[K.signatur_1] !== SIGNATUR[0] || w[K.signatur_2] !== SIGNATUR[1]) return nichtLesbar('signatur_fremd');
  if (w[K.hauptversion] !== HAUPTVERSION) return nichtLesbar('hauptversion_fremd');
  const [kl, st, k] = [w[K.kopflaenge], w[K.kartenblocklaenge], w[K.kartenzahl]];
  if (kl < KOPF_MIN || st < BLOCK_MIN || w.length < kl + k * st || parameter.basisadresse + kl + k * st > 65536) {
    return nichtLesbar('laenge_ungueltig');
  }
  if (u32(w, K.wortfolge_pruefwert, parameter.wortfolge) !== PRUEFWERT) return nichtLesbar('wortfolge_abweichend');
  const kopf = {
    hauptversion: w[K.hauptversion], nebenversion: w[K.nebenversion], kopflaenge: kl, kartenblocklaenge: st,
    kartenzahl: k, herzschlag: w[K.herzschlag], controller_kennung: u32(w, K.controller_kennung, parameter.wortfolge),
  };
  if (k !== soll.kartenzahl) return nichtLesbar('kartenzahl_abweichend', kopf);
  if (kopf.controller_kennung !== soll.controller_kennung) return nichtLesbar('controller_kennung_abweichend', kopf);
  const karten = soll.karten.map((s: Json, n: number) => {
    const b = kl + n * st;
    const kennung = { steckplatz: w[b + B.steckplatz], kartentyp: w[b + B.kartentyp], variante: w[b + B.variante] };
    const g = w[b + B.gueltigkeit];
    const leer = { kartenregister_32: null, kartenregister_35: null, statuswoerter: null, messwerte_roh: null, messwerte: null };
    if (!KARTENTYPEN.includes(kennung.kartentyp)) return { ...kennung, ergebnis: 'kartentyp_fremd', ...leer };
    if (kennung.steckplatz !== s.steckplatz || kennung.kartentyp !== s.kartentyp || kennung.variante !== s.variante) {
      return { ...kennung, ergebnis: 'aufbau_abweichend', ...leer };
    }
    if (!(g & BIT.karte_gelesen)) return { ...kennung, ergebnis: 'nicht_gelesen', ...leer };
    const roh = TYPEN.map((_, i) => u32(w, b + B.messwerte + 2 * i, parameter.wortfolge));
    return {
      ...kennung,
      ergebnis: 'gelesen',
      kartenregister_32: g & BIT.kartenregister_32_gelesen ? w[b + B.kartenregister_32] : null,
      kartenregister_35: g & BIT.kartenregister_35_gelesen ? w[b + B.kartenregister_35] : null,
      statuswoerter: g & BIT.statuswoerter_gelesen ? w.slice(b + B.statuswoerter, b + B.messwerte) : null,
      messwerte_roh: roh,
      messwerte: roh.map((r, i) => typisiert(r, TYPEN[i])),
    };
  });
  return { ergebnis: 'erkannt', grund: null, kopf, karten, anfragen_mindestens: anfragen(kl, st, k) };
}

// ---- Tabellen aus Markdown ----
const zellen = (zeile: string): string[] => zeile.split('|').slice(1, -1).map((z) => z.trim());
const ohneMarkup = (z: string): string => z.replace(/`/g, '').replace(/[¹²³]/g, '').trim();
const anzeige = (a: Json): string => (a.art === 'zu erheben' ? 'zu erheben' : String(a.wert));
const zahl = (z: string): number => Number(z.replace('−', '-').replace(/[^\d,-]/g, '').replace(',', '.'));

describe('VoltPilot-Registerbild WAGO v1: Schema, Aufbau und Herkunft jeder Zahl', () => {
  it('das Schema bleibt in der Teilmenge des Schema-Läufers', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(fremdeSchluessel(schema, '$')).toEqual([]);
  });

  it('die Vektor-Datei hält das Schema', () => {
    expect(schemaVerstoesse(vektoren, schema)).toEqual([]);
  });

  it('Gegenprobe: ein Vertrags-Fall kann nicht belegt sein, ein Pilot-Fall nur mit Nachweis', () => {
    const daten = structuredClone(vektoren);
    daten.faelle[0].belegt = true;
    const verstoesse = schemaVerstoesse(daten, schema);
    expect(verstoesse).toHaveLength(1);
    expect(verstoesse[0]).toMatch(/^\$\.faelle\[0\]: .* passt zu keinem Zweig von anyOf$/);
    daten.faelle[0].herkunft = 'pilot';
    expect(schemaVerstoesse(daten, schema)).toHaveLength(1);
    daten.faelle[0].nachweis = { datum: '2027-01-14', ort: 'Halle 2, C-1', pruefer: 'Pilot', vergleich: 'Netzzähler' };
    expect(schemaVerstoesse(daten, schema)).toEqual([]);
  });

  it('Kopf und Karten-Block sind lückenlos und so lang, wie der Kopf es festlegt (12 und 42 Wörter)', () => {
    for (const [block, laenge] of [[vektoren.kopf, KOPF_MIN], [vektoren.karte, BLOCK_MIN]] as [Json, number][]) {
      let offset = 0;
      for (const f of block.felder) {
        expect(f.offset, f.schluessel).toBe(offset);
        offset += f.woerter;
      }
      expect(offset).toBe(block.laenge);
      expect(block.laenge).toBe(laenge);
    }
    expect([KOPF_MIN, BLOCK_MIN]).toEqual([12, 42]);
  });

  it('zwölf 32-bit-Messwerte in Hardwareblatt-Reihenfolge, je vier in einer Gruppe, plus zwölf Statuswörter (E9: 13 Werte)', () => {
    const mw = feld(vektoren.karte, 'messwerte');
    const sw = feld(vektoren.karte, 'statuswoerter');
    expect(vektoren.messwerte.map((m: Json) => m.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const m of vektoren.messwerte) {
      expect(m.offset, m.schluessel).toBe(mw.offset + 2 * (m.nr - 1));
      expect(m.gruppe, m.schluessel).toBe(Math.ceil(m.nr / 4));
      expect(m.hardwareblatt_zeile).toBe(m.nr);
    }
    expect(mw.woerter).toBe(2 * vektoren.messwerte.length);
    expect(sw.woerter).toBe(vektoren.statuswoerter.gruppen.wert * vektoren.statuswoerter.woerter_je_gruppe.wert);
    expect(vektoren.statuswoerter.woerter).toHaveLength(vektoren.statuswoerter.woerter_je_gruppe.wert);
    expect(Object.values(BIT)).toEqual([1, 2, 4, 8]);
  });

  it('jede Zahl hat eine Herkunft: Handbuch mit Quelle und abgedecktem Artikel, Repo mit Datei und Zeile', () => {
    const alle = angaben(vektoren);
    expect(alle.length).toBeGreaterThan(40);
    for (const [pfad, a] of alle) {
      if (a.art === 'handbuch') {
        const quelle = a.fundstelle.split(' ')[0];
        expect(vektoren.quellen, pfad).toHaveProperty(quelle);
        for (const artikel of a.gilt_fuer) expect(ABDECKUNG[quelle], `${pfad}: ${quelle} belegt ${artikel} nicht`).toContain(artikel);
      }
      if (a.art === 'repo') {
        const [datei, zeile] = a.fundstelle.split(':');
        expect(existsSync(resolve(ROOT, datei)), pfad).toBe(true);
        const text = readFileSync(resolve(ROOT, datei), 'utf8').split('\n')[Number(zeile) - 1];
        const werte = Array.isArray(a.wert) ? a.wert : [a.wert];
        for (const wert of werte) expect(text, pfad).toContain(String(wert));
      }
    }
  });

  it('der Vertrag nennt jedes Feld mit demselben Offset und derselben Länge, jeden Messwert mit Messwert-ID und Datentyp', () => {
    const zeilen = vertrag.split('\n').filter((z) => /^\| \d+ \| \d+ \| `[a-z0-9_]+` \|/.test(z) || /^\| \d+ \| \d+ \| 2 \| `[a-z0-9_]+` \|/.test(z));
    const felder = new Map<string, string[]>();
    for (const z of zeilen) {
      const c = zellen(z);
      if (c[2] === '2' && c[3].startsWith('`')) felder.set(ohneMarkup(c[3]), c);
      else felder.set(ohneMarkup(c[2]), c);
    }
    for (const f of [...vektoren.kopf.felder, ...vektoren.karte.felder]) {
      expect(felder.get(f.schluessel)?.slice(0, 2), f.schluessel).toEqual([String(f.offset), String(f.woerter)]);
    }
    for (const m of vektoren.messwerte) {
      const c = felder.get(m.schluessel);
      expect(c, m.schluessel).toBeDefined();
      expect([c![0], c![1], c![5], ohneMarkup(c![6]), ohneMarkup(c![7])], m.schluessel)
        .toEqual([String(m.nr), String(m.offset), String(m.gruppe), anzeige(m.met_id), anzeige(m.datentyp)]);
    }
  });

  it('die Hardwareblatt-Vorlage nennt dieselben Messwert-IDs und Datentypen (Zeilen 1–12)', () => {
    const abschnitt = hardwareblatt.split('## 4 Zeilen')[1].split('\n## ')[0];
    const zeilen = new Map<number, [string, string]>();
    for (const z of abschnitt.split('\n').filter((l) => /^\| \d+(–\d+)? \|/.test(l))) {
      const c = zellen(z);
      const [von, bis] = c[0].split('–').map(Number);
      const teile = c[3].split(' · ').map(ohneMarkup);
      if (teile.length !== 3) continue;
      const ids = teile[1].split(' / ');
      for (let nr = von; nr <= (bis ?? von); nr++) zeilen.set(nr, [ids[ids.length === 1 ? 0 : nr - von], teile[2]]);
    }
    for (const m of vektoren.messwerte) {
      expect(zeilen.get(m.hardwareblatt_zeile), m.schluessel).toEqual([anzeige(m.met_id), anzeige(m.datentyp)]);
    }
  });

  it('die Rechenbeispiele im Vertrag rechnen richtig', () => {
    const woerter = vertrag.split('\n').filter((z) => /^\| `0x[0-9A-F]{4} 0x[0-9A-F]{4}` \| (big|little) \|/.test(z));
    expect(woerter.length).toBeGreaterThanOrEqual(5);
    for (const z of woerter) {
      const [hex, wortfolge, typ, ergebnis] = zellen(z);
      const w = ohneMarkup(hex).split(' ').map((h) => parseInt(h, 16));
      const wert = typisiert(u32(w, 0, wortfolge), typ);
      expect(wert === null ? 'kein Wert' : wert, z).toBe(ergebnis === 'kein Wert' ? ergebnis : zahl(ergebnis));
    }
    const faktoren = vertrag.split('\n').filter((z) => /^\| −?[\d ]+ \| [\d,]+ (kWh|W) \| −?[\d ,]+ (kWh|W) \|/.test(z));
    expect(faktoren.length).toBeGreaterThanOrEqual(2);
    for (const z of faktoren) {
      const [roh, faktor, ergebnis] = zellen(z);
      const stellen = (ergebnis.split(',')[1] ?? '').replace(/\D/g, '').length;
      expect((zahl(roh) * zahl(faktor)).toFixed(stellen), z).toBe(zahl(ergebnis).toFixed(stellen));
    }
  });

  it('Größe: 12 + 42 · K Wörter, nie mehr als 120 je Anfrage, kein Karten-Block geteilt', () => {
    expect(MAX_WOERTER).toBe(120);
    expect([1, 2, 3, 4, 5].map((k) => anfragen(KOPF_MIN, BLOCK_MIN, k))).toEqual([1, 1, 2, 2, 3]);
  });
});

describe('VoltPilot-Registerbild WAGO v1: Lese-Fälle', () => {
  it('alle Fälle sind Vertrags-Fälle ohne Beleg und haben eindeutige Namen', () => {
    expect(vektoren.faelle.every((f: Json) => f.herkunft === 'vertrag' && f.belegt === false)).toBe(true);
    const namen = vektoren.faelle.map((f: Json) => f.name.split(' ')[0]);
    expect(new Set(namen).size).toBe(namen.length);
  });

  it.each(vektoren.faelle.map((f: Json) => [f.name, f]))('%s: der unabhängige Leser kommt zum erwarteten Ergebnis', (_, f: Json) => {
    expect(liesRegisterbild(f.input)).toEqual(f.expected);
  });
});
