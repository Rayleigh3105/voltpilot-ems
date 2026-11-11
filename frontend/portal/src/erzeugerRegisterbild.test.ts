import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

/**
 * VoltPilot-Registerbild Erzeuger v1 (EZ-1): `docs/contracts/v2/erzeuger-registerbild.md`, sein Schema und die
 * Vektor-Datei. Es gibt noch keinen Zwilling (Box-Leser EZ-5, Simulator EZ-2, Bild-Baustein EZ-3) — darum liest
 * hier ein kleiner, unabhängiger Leser jeden Fall aus den rohen Wörtern nach. Die Vektor-Datei wurde per Skript
 * aus den Absichten kodiert; stimmen beide überein, gehen die Rechnungen auf.
 *
 * Außerdem: der Aufbau ist lückenlos, Vertrag und Datei nennen dieselben Adressen, Typen, Bits und Codes, und die
 * Rechenbeispiele im Vertrag rechnen richtig.
 */
const ROOT = resolve(process.cwd(), '../..');
const V2 = resolve(ROOT, 'docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const schema: Json = lies(resolve(V2, 'erzeuger-registerbild.schema.json'));
const vektoren: Json = lies(resolve(V2, 'erzeuger-registerbild-vectors.json'));
const vertrag = readFileSync(resolve(V2, 'erzeuger-registerbild.md'), 'utf8');

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
  if (typeof o.art === 'string' && 'fundstelle' in o) return [[pfad, o]];
  return Object.entries(o).flatMap(([k, v]) => (k === 'faelle' ? [] : angaben(v, `${pfad}.${k}`)));
};

// ---- der unabhängige Leser: Konstanten aus der Datei, Rechnung von Hand ----
const FELD: Record<string, Json> = Object.fromEntries(vektoren.felder.map((f: Json) => [f.feld, f]));
const imAbschnitt = (...kurz: string[]): Json[] => vektoren.felder.filter((f: Json) => kurz.includes(f.abschnitt));
const KOPF_LAENGE = vektoren.abschnitte.find((a: Json) => a.kurz === 'K').woerter;
const TE_BASIS = vektoren.einheit.basis;
const TE_LAENGE = vektoren.einheit.laenge;
const MAX_EINHEITEN = vektoren.einheit.max_einheiten;
const SIGNATUR: number[] = FELD.signatur.soll_woerter;
const PRUEFWERT: number[] = FELD.wortfolge.soll_woerter;
const HAUPTVERSION = FELD.version.soll.hauptversion;
const MAX_WOERTER = vektoren.lesen.max_woerter_je_anfrage.wert;
const STEHT_AB = vektoren.lesen.herzschlag.steht_ab_lesung.wert;
const SCHRITTGRENZE = Number(/\d+/.exec(vektoren.lesen.herzschlag.schrittgrenze.wert)![0]);
const MODUL = vektoren.lesen.zaehler_modul.wert;
const NAMEN = vektoren.namen;
const TEXT_WOERTER = NAMEN.woerter_je_text;
const versatz = (feld: string): number => NAMEN.texte.find((t: Json) => t.feld === feld).versatz;

/** Ein Feld an einer absoluten Adresse, roh und vorzeichenlos; Wortfolge ist fest: höherwertig zuerst. */
const rohwert = (w: number[], adresse: number, f: Json): number => (f.woerter === 1 ? w[adresse] : w[adresse] * 65536 + w[adresse + 1]);

const mitVorzeichen = (u: number, typ: string): number => {
  if (typ === 'S16') return u >= 0x8000 ? u - 0x10000 : u;
  if (typ === 'S32') return u >= 2 ** 31 ? u - 2 ** 32 : u;
  return u;
};

/** Flaggen eines Bitfelds; eine von einem 0-Bit gedeckte Flagge ist unbekannt. Bitfeld 0xFFFF → unbekannt. */
const flaggen = (f: Json, u: number): Record<string, boolean | null> | null => {
  if (u === f.ungueltig) return null;
  const out: Record<string, boolean | null> = {};
  const gedeckt = new Set<string>();
  for (const b of f.bits) {
    if (gedeckt.has(b.name)) {
      out[b.name] = null;
      continue;
    }
    out[b.name] = ((u >> b.bit) & 1) === 1;
    if (!out[b.name]) for (const d of b.deckt_bits ?? []) gedeckt.add(d);
  }
  return out;
};

/** Liest die Felder eines Abschnitts oder Blocks; `basis` verschiebt die Adressen (Einheit n). */
function liesFelder(w: number[], felder: Json[], basis: number) {
  const werte: Record<string, number | null> = {};
  const bits: Record<string, Record<string, boolean | null> | null> = {};
  const leer: Record<string, string> = {};
  const adr = (f: Json) => basis + f.adresse;
  for (const f of felder) {
    const u = rohwert(w, adr(f), f);
    if (f.art === 'bitfeld') {
      bits[f.feld] = flaggen(f, u);
      werte[f.feld] = u === f.ungueltig ? null : u;
      if (u === f.ungueltig) leer[f.feld] = 'ungueltig';
      continue;
    }
    if (f.gedeckt_von) {
      const bf = FELD[f.gedeckt_von.feld];
      const fl = flaggen(bf, rohwert(w, basis + bf.adresse, bf));
      if (fl === null || !fl[f.gedeckt_von.bit]) {
        werte[f.feld] = null;
        leer[f.feld] = 'gueltigkeit';
        continue;
      }
    }
    if (f.ungueltig !== null && u === f.ungueltig) {
      werte[f.feld] = null;
      leer[f.feld] = 'ungueltig';
      continue;
    }
    const wert = mitVorzeichen(u, f.typ);
    if (f.vokabular && !f.vokabular.some((v: Json) => v.code === wert)) {
      werte[f.feld] = null;
      leer[f.feld] = 'fremd';
      continue;
    }
    werte[f.feld] = wert;
  }
  return { werte, bits, leer };
}

const anfragen = (kopf: number, block: number, n: number): number => {
  let zahl = 1;
  let frei = MAX_WOERTER - kopf;
  for (let i = 0; i < n; i++) {
    if (block > frei) [zahl, frei] = [zahl + 1, MAX_WOERTER];
    frei -= block;
  }
  return zahl;
};

function liesKopf(w: number[]) {
  const { werte, leer } = liesFelder(w, imAbschnitt('K').filter((f: Json) => ['wert', 'aufzaehlung', 'adresse'].includes(f.art)), 0);
  const kopf = {
    version_haupt: w[FELD.version.adresse] >> 8,
    version_neben: w[FELD.version.adresse] & 0xff,
    te_anzahl: w[FELD.te_anzahl.adresse],
    herzschlag: w[FELD.herzschlag.adresse],
    programmstand: werte.programmstand,
    steuerung_id: werte.steuerung_id,
    anlagenart: werte.anlagenart,
    beschreibung_ab: werte.beschreibung_ab,
  };
  return { kopf, leer };
}

function liesLesung(w: number[]): Json {
  const nicht = (grund: string, kopf: Json = null) => ({
    ergebnis: 'nicht_lesbar', grund, kopf, anfragen: null, herzschlag_urteil: null, veraltet: null,
    zaehler_differenz: null, werte: null, bits: null, einheiten: [], leer: null,
  });
  if (w.length < KOPF_LAENGE) return nicht('zu_wenig_woerter');
  if (w[0] !== SIGNATUR[0] || w[1] !== SIGNATUR[1]) return nicht('signatur_fremd');
  if (w[FELD.version.adresse] >> 8 !== HAUPTVERSION) return nicht('version_fremd');
  if (w[2] !== PRUEFWERT[0] || w[3] !== PRUEFWERT[1]) return nicht('wortfolge_falsch');
  const { kopf, leer: kopfLeer } = liesKopf(w);
  const n = kopf.te_anzahl;
  if (n < 1 || n > MAX_EINHEITEN) return nicht('te_anzahl_ungueltig', kopf);
  if (w.length < TE_BASIS + TE_LAENGE * n) return nicht('zu_wenig_woerter', kopf);
  const anlage = liesFelder(w, imAbschnitt('A', 'N', 'D', 'S'), 0);
  const einheiten = Array.from({ length: n }, (_, i) => {
    const basis = i * TE_LAENGE;
    const e = liesFelder(w, imAbschnitt('T'), basis);
    return { n: i + 1, adresse: TE_BASIS + basis, ...e };
  });
  return {
    ergebnis: 'lesbar', grund: null, kopf, anfragen: anfragen(TE_BASIS, TE_LAENGE, n),
    herzschlag_urteil: null, veraltet: false, zaehler_differenz: null,
    werte: anlage.werte, bits: anlage.bits, einheiten, leer: { ...kopfLeer, ...anlage.leer },
  };
}

/** Herzschlag-Urteil, veraltet und Vorgaben seit der letzten Lesung — über die Lesungen einer Steuerung. */
function liesFolge(lesungen: number[][]): Json[] {
  let vorher: Json = null;
  let steht = 0;
  return lesungen.map((w) => {
    const l = liesLesung(w);
    if (l.ergebnis !== 'lesbar') return l;
    if (vorher) {
      const [hv, h] = [vorher.kopf.herzschlag, l.kopf.herzschlag];
      l.herzschlag_urteil = h === hv ? 'steht' : h > hv ? 'laeuft' : h + 65536 - hv <= SCHRITTGRENZE ? 'ueberlauf' : 'rueckwaerts';
      const differenz = (z: string) => {
        const [alt, neu] = [vorher.werte[z], l.werte[z]];
        return l.herzschlag_urteil === 'rueckwaerts' || alt === null || neu === null ? null : (((neu - alt) % MODUL) + MODUL) % MODUL;
      };
      l.zaehler_differenz = { n_zaehler: differenz('n_zaehler'), d_zaehler: differenz('d_zaehler') };
    }
    steht = l.herzschlag_urteil === 'steht' ? steht + 1 : 0;
    l.veraltet = steht >= STEHT_AB - 1;
    vorher = l;
    return l;
  });
}

const text = (woerter: number[]): string | null => {
  const bytes = woerter.flatMap((x) => [x >> 8, x & 0xff]);
  const ende = bytes.indexOf(0);
  const s = String.fromCharCode(...(ende < 0 ? bytes : bytes.slice(0, ende)));
  return s === '' ? null : s;
};

function liesNamen(kopf: Json, eingabe: Json): Json {
  const ohne = (ergebnis: string) => ({ ergebnis, anfragen: null, netzbetreiber_name: null, direktvermarkter_name: null, t_typ_name: [] });
  const [ab, n] = [kopf.beschreibung_ab, kopf.te_anzahl];
  if (ab === null || NAMEN.keine_namen.includes(ab)) return ohne('keine_namen');
  const laenge = versatz('t_typ_name') + n * TEXT_WOERTER;
  if (ab < TE_BASIS + TE_LAENGE * n || ab + laenge > 65536) return ohne('bereich_ungueltig');
  expect(eingabe?.ab).toBe(ab);
  if (eingabe.woerter.length < laenge) return ohne('zu_wenig_woerter');
  const bei = (v: number) => text(eingabe.woerter.slice(v, v + TEXT_WOERTER));
  return {
    ergebnis: 'gelesen',
    anfragen: anfragen(0, TEXT_WOERTER, laenge / TEXT_WOERTER),
    netzbetreiber_name: bei(versatz('netzbetreiber_name')),
    direktvermarkter_name: bei(versatz('direktvermarkter_name')),
    t_typ_name: Array.from({ length: n }, (_, i) => bei(versatz('t_typ_name') + i * TEXT_WOERTER)),
  };
}

function liesFall(input: Json): Json {
  const lesungen = liesFolge(input.lesungen.map((l: Json) => l.woerter));
  const letzte = [...lesungen].reverse().find((l) => l.ergebnis === 'lesbar');
  return { lesungen, namen: letzte ? liesNamen(letzte.kopf, input.namen) : null };
}

// ---- Tabellen aus Markdown ----
const zellen = (zeile: string): string[] => zeile.split('|').slice(1, -1).map((z) => z.trim());
const ohneMarkup = (z: string): string => z.replace(/`/g, '').trim();
const zahl = (z: string): number => Number(z.replace('−', '-').replace(/[^\d,-]/g, '').replace(',', '.'));
const abschnitt = (nr: number): string => vertrag.split(`\n## ${nr}. `)[1].split('\n## ')[0];
const hex = (n: number | null): string => (n === null ? '—' : `0x${n.toString(16).toUpperCase()}`);
const fall = (praefix: string): Json => vektoren.faelle.find((f: Json) => f.name.startsWith(`${praefix} `));

describe('VoltPilot-Registerbild Erzeuger v1: Schema und Aufbau', () => {
  it('das Schema bleibt in der Teilmenge des Schema-Läufers', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(fremdeSchluessel(schema, '$')).toEqual([]);
  });

  it('die Vektor-Datei hält das Schema', () => {
    expect(schemaVerstoesse(vektoren, schema)).toEqual([]);
  });

  it('Gegenprobe: belegt ist nur ein Fall von der Steuerung, und ein Feld ohne Typ fällt auf', () => {
    const daten = structuredClone(vektoren);
    daten.faelle[0].belegt = true;
    expect(schemaVerstoesse(daten, schema)).toEqual([`$.faelle[0]: ${JSON.stringify(daten.faelle[0])} passt zu keinem Zweig von anyOf`]);
    daten.faelle[0].herkunft = 'steuerung';
    expect(schemaVerstoesse(daten, schema)).toEqual([]);
    daten.faelle[0].herkunft = 'vertrag';
    delete daten.faelle[0].belegt;
    delete daten.felder[0].typ;
    expect(schemaVerstoesse(daten, schema)).toEqual(['$.felder[0]: Pflichtfeld typ fehlt', '$.faelle[0]: Pflichtfeld belegt fehlt']);
  });

  it('Kopf bis Wirkung sind lückenlos 0–37, der Block je Einheit 38–47, die Abschnitte wie in der Vorlage', () => {
    let adresse = 0;
    for (const f of vektoren.felder) {
      expect(f.adresse, f.feld).toBe(adresse);
      if (f.woerter === 2) expect(f.adresse % 2, `${f.feld}: 32 bit auf gerader Adresse`).toBe(0);
      expect(f.woerter, f.feld).toBe(vektoren.typen.find((t: Json) => t.typ === f.typ).woerter);
      adresse += f.woerter;
    }
    expect(adresse).toBe(TE_BASIS + TE_LAENGE);
    for (const a of vektoren.abschnitte) {
      const felder = vektoren.felder.filter((f: Json) => f.abschnitt === a.kurz);
      expect(felder[0].adresse, a.kurz).toBe(a.start);
      expect(felder.reduce((s: number, f: Json) => s + f.woerter, 0), a.kurz).toBe(a.woerter);
    }
    expect(vektoren.abschnitte.map((a: Json) => [a.kurz, a.start, a.woerter])).toEqual([
      ['K', 0, 12], ['A', 12, 10], ['N', 22, 6], ['D', 28, 6], ['S', 34, 4], ['T', 38, 10],
    ]);
    expect([TE_BASIS + 3 * TE_LAENGE, TE_BASIS + 2 * TE_LAENGE]).toEqual([vektoren.einheit.gore_woerter, vektoren.einheit.buettner_woerter]);
    expect([vektoren.einheit.gore_woerter, vektoren.einheit.buettner_woerter, MAX_EINHEITEN]).toEqual([68, 58, 10]);
  });

  it('ungültig ist das Typ-Maximum — außer bei den drei Zählern, die von 65535 auf 0 laufen (firstmate A2 = A)', () => {
    const maximum: Record<string, number> = Object.fromEntries(vektoren.typen.map((t: Json) => [t.typ, t.ungueltig]));
    expect(maximum).toEqual({ U16: 0xffff, S16: 0x7fff, U32: 0xffffffff, S32: 0x7fffffff });
    const zaehler = vektoren.felder.filter((f: Json) => f.art === 'zaehler').map((f: Json) => f.feld);
    expect(zaehler).toEqual(['herzschlag', 'n_zaehler', 'd_zaehler']);
    for (const f of vektoren.felder) {
      expect(f.ungueltig, f.feld).toBe(zaehler.includes(f.feld) ? null : maximum[f.typ]);
      if (zaehler.includes(f.feld)) expect(f.ungueltig_in_der_vorlage, f.feld).toBe('0xFFFF');
    }
    expect(MODUL).toBe(65536);
  });

  it('Bits sind eindeutig, liegen unter „frei ab“ und decken nur Felder desselben Abschnitts; gedeckt_von zeigt zurück', () => {
    for (const f of vektoren.felder.filter((x: Json) => x.art === 'bitfeld')) {
      const nummern = f.bits.map((b: Json) => b.bit);
      expect(nummern, f.feld).toEqual([...nummern.keys()]);
      expect(f.frei_ab_bit, f.feld).toBe(nummern.length);
      const namen = f.bits.map((b: Json) => b.name);
      for (const b of f.bits) {
        for (const d of b.deckt ?? []) {
          expect(FELD[d]?.abschnitt, `${f.feld}.${b.name} deckt ${d}`).toBe(f.abschnitt);
          expect(FELD[d].gedeckt_von, d).toEqual({ feld: f.feld, bit: b.name });
        }
        for (const d of b.deckt_bits ?? []) expect(namen, `${f.feld}.${b.name} deckt ${d}`).toContain(d);
      }
    }
    for (const f of vektoren.felder.filter((x: Json) => x.gedeckt_von)) {
      const bits = FELD[f.gedeckt_von.feld].bits.find((b: Json) => b.name === f.gedeckt_von.bit);
      expect(bits.deckt, f.feld).toContain(f.feld);
    }
  });

  it('jede Repo-Angabe steht so in ihrer Datei und Zeile', () => {
    const repo = angaben(vektoren).filter(([, a]) => a.art === 'repo');
    expect(repo.length).toBeGreaterThanOrEqual(2);
    for (const [pfad, a] of repo) {
      const [datei, zeile] = a.fundstelle.split(':');
      expect(existsSync(resolve(ROOT, datei)), pfad).toBe(true);
      expect(readFileSync(resolve(ROOT, datei), 'utf8').split('\n')[Number(zeile) - 1], pfad).toContain(String(a.wert));
    }
  });
});

describe('VoltPilot-Registerbild Erzeuger v1: Vertrag ⟷ Datei', () => {
  it('§3 nennt jedes Feld mit Adresse, Wörtern, Typ und Ungültig-Wert', () => {
    const zeilen = abschnitt(3).split('\n').filter((z) => /^\| \d+ \| [12] \| `[a-z0-9_]+` \|/.test(z)).map(zellen);
    expect(zeilen.map((c) => ohneMarkup(c[2]))).toEqual(vektoren.felder.map((f: Json) => f.feld));
    for (const c of zeilen) {
      const f = FELD[ohneMarkup(c[2])];
      expect([Number(c[0]), Number(c[1]), c[3], c[4]], f.feld).toEqual([f.adresse, f.woerter, f.typ, hex(f.ungueltig)]);
    }
  });

  it('§4 nennt jedes Bit mit Namen und dem, was es deckt', () => {
    const zeilen = abschnitt(4).split('\n').filter((z) => /^\| `[a-z_]+` \| \d+ \| `[a-z_]+` \|/.test(z)).map(zellen);
    const ausDatei = vektoren.felder.filter((f: Json) => f.bits).flatMap((f: Json) =>
      f.bits.map((b: Json) => [f.feld, b.bit, b.name, [...(b.deckt ?? []), ...(b.deckt_bits ?? [])]]));
    const ausVertrag = zeilen.map((c) => [ohneMarkup(c[0]), Number(c[1]), ohneMarkup(c[2]),
      c[4] === '—' ? [] : c[4].split(', ').map(ohneMarkup)]);
    expect(ausVertrag).toEqual(ausDatei);
    const frei = /Frei ab: (.*)\./.exec(abschnitt(4))![1].split(', ').map((s) => /`([a-z_]+)` Bit (\d+)/.exec(s)!.slice(1));
    expect(frei.map(([f, b]) => [f, Number(b)])).toEqual(vektoren.felder.filter((f: Json) => f.bits).map((f: Json) => [f.feld, f.frei_ab_bit]));
  });

  it('§5 nennt jedes Vokabular mit Code und Namen', () => {
    const zeilen = abschnitt(5).split('\n').filter((z) => /^\| `[a-z_]+` \| \d+ \| `[a-z_]+` \|/.test(z)).map(zellen);
    const ausVertrag = new Map<string, [number, string][]>();
    for (const c of zeilen) ausVertrag.set(ohneMarkup(c[0]), [...(ausVertrag.get(ohneMarkup(c[0])) ?? []), [Number(c[1]), ohneMarkup(c[2])]]);
    ausVertrag.set('t_zustand', ausVertrag.get('anlage_zustand')!);
    for (const f of vektoren.felder.filter((x: Json) => x.vokabular)) {
      expect(ausVertrag.get(f.feld), f.feld).toEqual(f.vokabular.map((v: Json) => [v.code, v.name]));
    }
    expect(vektoren.felder.filter((x: Json) => x.art === 'aufzaehlung').every((f: Json) => f.vokabular)).toBe(true);
  });

  it('§6 nennt die Namen-Texte mit Versatz, und bei 140 liegen sie wie in der Vorlage', () => {
    const zeilen = abschnitt(6).split('\n').filter((z) => /^\| \+\d+/.test(z)).map(zellen);
    expect(zeilen.map((c) => [zahl(c[0].split(' ')[0]), ohneMarkup(c[2])])).toEqual(NAMEN.texte.map((t: Json) => [t.versatz, t.feld]));
    expect(NAMEN.vorgabe_ab + versatz('netzbetreiber_name')).toBe(140);
    expect(NAMEN.vorgabe_ab + versatz('direktvermarkter_name')).toBe(156);
    expect([1, 2, 3].map((n) => NAMEN.vorgabe_ab + versatz('t_typ_name') + (n - 1) * TEXT_WOERTER)).toEqual([172, 188, 204]);
  });

  it('§7 nennt die Prüfreihenfolge der Datei', () => {
    const gruende = [...abschnitt(7).split('\n\nDanach')[0].matchAll(/^\d\. .* → `([a-z_]+)`$/gm)].map((m) => m[1]);
    expect(gruende).toEqual(vektoren.lesen.pruefreihenfolge.wert);
    const reihenfolge = [...abschnitt(7).split('Danach je Wert')[1].matchAll(/Grund `([a-z_]+)`/g)].map((m) => m[1]);
    expect(reihenfolge).toEqual(vektoren.lesen.leer_gruende.wert);
  });

  it('§9: Wörter und Anfragen je Einheitenzahl — eine Anfrage bis 8, zwei ab 9 (firstmate A1 = A)', () => {
    const zeilen = abschnitt(9).split('\n').filter((z) => /^\| \d+ \| \d+ \| \d \| \d+ \| \d \|$/.test(z)).map((z) => zellen(z).map(Number));
    expect(zeilen.map((c) => c[0])).toEqual(Array.from({ length: MAX_EINHEITEN }, (_, i) => i + 1));
    for (const [n, woerter, a, namenWoerter, namenAnfragen] of zeilen) {
      expect([woerter, a], `${n} Einheiten`).toEqual([TE_BASIS + TE_LAENGE * n, anfragen(TE_BASIS, TE_LAENGE, n)]);
      expect([namenWoerter, namenAnfragen], `${n} Einheiten`).toEqual([versatz('t_typ_name') + TEXT_WOERTER * n, anfragen(0, TEXT_WOERTER, 2 + n)]);
    }
    expect(Math.max(...zeilen.filter((c) => c[2] === 1).map((c) => c[0]))).toBe(vektoren.lesen.einheiten_in_einer_anfrage.wert);
    expect(Math.floor(MAX_WOERTER / TEXT_WOERTER)).toBe(vektoren.lesen.namen_texte_je_anfrage.wert);
  });

  it('§11: die Rechenbeispiele rechnen richtig', () => {
    const teil = abschnitt(11);
    const woerter = teil.split('\n').filter((z) => /^\| `0x[0-9A-F]{4}( 0x[0-9A-F]{4})?` \| [US](16|32) \|/.test(z)).map(zellen);
    expect(woerter.length).toBeGreaterThanOrEqual(10);
    for (const [w, typ, ergebnis] of woerter) {
      const ws = ohneMarkup(w).split(' ').map((h) => parseInt(h, 16));
      const f = { woerter: ws.length, typ, ungueltig: vektoren.typen.find((t: Json) => t.typ === typ).ungueltig };
      const u = rohwert(ws, 0, f);
      const wert = u === f.ungueltig ? 'kein Wert' : mitVorzeichen(u, typ);
      expect(wert, w).toBe(ergebnis === 'kein Wert' ? ergebnis : zahl(ergebnis));
    }
    const faktoren = teil.split('\n').filter((z) => /^\| −?[\d ]+ \| [\d,]+( [^|]+)? \| −?[\d ,]+( [^|]+)? \|$/.test(z)).map(zellen);
    expect(faktoren.length).toBeGreaterThanOrEqual(4);
    for (const [roh, faktor, ergebnis] of faktoren) {
      const stellen = (ergebnis.split(',')[1] ?? '').replace(/\D/g, '').length;
      expect((zahl(roh) * zahl(faktor)).toFixed(stellen), ergebnis).toBe(zahl(ergebnis).toFixed(stellen));
    }
    const zaehler = [...teil.matchAll(/^\| `(\d+) → (\d+)` \| (\d+) \|/gm)];
    expect(zaehler.length).toBeGreaterThanOrEqual(3);
    for (const [, alt, neu, diff] of zaehler) expect((((Number(neu) - Number(alt)) % MODUL) + MODUL) % MODUL).toBe(Number(diff));
    const texte = teil.split('\n').filter((z) => /^\| `0x[0-9A-F]{4}( 0x[0-9A-F]{4})*` \| Text \|/.test(z)).map(zellen);
    expect(texte.length).toBeGreaterThanOrEqual(2);
    for (const [w, , t] of texte) expect(text(ohneMarkup(w).split(' ').map((h) => parseInt(h, 16))), w).toBe(t);
  });
});

describe('VoltPilot-Registerbild Erzeuger v1: Lese-Fälle', () => {
  it('belegt sind nur Fälle von der Steuerung, alle anderen sind Vertrags-Fälle; die Nummern sind eindeutig', () => {
    expect(vektoren.faelle.filter((f: Json) => f.belegt).map((f: Json) => f.name)).toEqual(['E21 gore-erste-lesung-ersatzwert']);
    expect(vektoren.faelle.every((f: Json) => (f.belegt ? f.herkunft === 'steuerung' : f.herkunft === 'vertrag'))).toBe(true);
    const nummern = vektoren.faelle.map((f: Json) => f.name.split(' ')[0]);
    expect(nummern).toEqual(nummern.map((_: string, i: number) => `E${i + 1}`));
  });

  it.each(vektoren.faelle.map((f: Json) => [f.name, f]))('%s: der unabhängige Leser kommt zum erwarteten Ergebnis', (_, f: Json) => {
    expect(liesFall(f.input)).toEqual(f.expected);
  });

  it('Gore (E1): PV, drei Wechselrichter, 265 kW, Netzbetreiber-Kanal 3, Einspeisung negativ, Namen gefüllt', () => {
    const [l] = liesFall(fall('E1').input).lesungen;
    expect([l.kopf.anlagenart, l.kopf.te_anzahl, l.werte.p_installiert_kw, l.werte.n_kanal, l.anfragen]).toEqual([1, 3, 265, 3, 1]);
    expect(l.werte.p_nvp_w).toBe(-2140);
    expect(l.werte.n_cosphi).toBe(-950);
    expect(fall('E1').input.lesungen[0].woerter).toHaveLength(68);
    expect(fall('E1').expected.namen.netzbetreiber_name).toBe('N-ERGIE Netz GmbH');
    expect(fall('E1').expected.namen.direktvermarkter_name).toBeNull();
  });

  it('Gore, erste Lesung (E21): ohne gültige Vorgabe trägt Wort 24 den Ersatzwert, gelesen wird er nicht als Vorgabe', () => {
    const woerter = fall('E21').input.lesungen[0].woerter;
    expect([woerter[23], woerter[24], woerter[25], woerter[34]]).toEqual([0x0002, 1000, 0x7fff, 6]);
    const [l] = liesFall(fall('E21').input).lesungen;
    expect(l.bits.n_bits.vorgabe_gueltig).toBe(false);
    expect([l.werte.n_p_prozent, l.leer.n_p_prozent, l.werte.n_cosphi, l.leer.n_cosphi]).toEqual([null, 'gueltigkeit', null, 'gueltigkeit']);
    // Was wirkt, sagt S: der Ersatzwert der Steuerung, 265,5 kW = Σ Sollwert der drei Wechselrichter.
    expect([l.werte.quelle_p, l.bits.s_bits.gueltig, l.werte.p_grenze_w]).toEqual([6, true, 265_500]);
    expect(l.einheiten.reduce((s: number, e: Json) => s + e.werte.t_p_soll_w, 0)).toBe(265_500);
    expect(FELD.quelle_p.vokabular.find((c: Json) => c.code === 6).name).toBe('ersatzwert');
  });

  it('Büttner (E2): BHKW, Motoren 66 und 33 kW, Direktvermarkter-Kanal 1, Gasspeicher, Netzpunkt unbekannt (EW-16 C)', () => {
    const [l] = liesFall(fall('E2').input).lesungen;
    expect([l.kopf.anlagenart, l.werte.d_kanal, l.werte.speicher_fuellstand, l.werte.p_installiert_kw]).toEqual([2, 1, 734, 99]);
    expect(l.einheiten.map((e: Json) => [e.werte.t_art, e.werte.t_nenn_kw])).toEqual([[2, 66], [2, 33]]);
    expect([l.werte.p_nvp_w, l.leer.p_nvp_w, l.bits.a_gueltig.netzpunkt_berechnet]).toEqual([null, 'gueltigkeit', false]);
    expect(fall('E2').input.lesungen[0].woerter).toHaveLength(58);
    expect(fall('E2').expected.namen.direktvermarkter_name).toBe('WVV (Stadtwerke Würzburg)');
  });

  it('die Fehlerbilder des Auftrags sind alle da', () => {
    const gruende = vektoren.faelle.flatMap((f: Json) => f.expected.lesungen.map((l: Json) => l.grund));
    for (const g of ['signatur_fremd', 'wortfolge_falsch', 'version_fremd', 'te_anzahl_ungueltig', 'zu_wenig_woerter']) expect(gruende).toContain(g);
    const alle = vektoren.faelle.flatMap((f: Json) => f.expected.lesungen);
    expect(alle.some((l: Json) => l.veraltet === true)).toBe(true);
    const leer = alle.flatMap((l: Json) => [l.leer, ...l.einheiten.map((e: Json) => e.leer)]).flatMap((x: Json) => Object.values(x ?? {}));
    for (const g of vektoren.lesen.leer_gruende.wert) expect(leer).toContain(g);
    const tAnzahl = vektoren.faelle.flatMap((f: Json) => f.expected.lesungen.map((l: Json) => l.kopf?.te_anzahl));
    for (const n of [0, MAX_EINHEITEN, MAX_EINHEITEN + 1, 0xffff]) expect(tAnzahl).toContain(n);
    expect(vektoren.faelle.map((f: Json) => f.expected.namen?.ergebnis)).toContain('keine_namen');
  });
});
