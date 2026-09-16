import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { dez, dezGleich, dezText, type Dez } from './dez';
import { darf, matrixAus, type Benutzer, type Kundenbereich, type Ziel } from './rechte';
import * as K from './uemsKennzahl';

/**
 * Die Regeln der KENNZAHL (UEMS AP-11 IP-1/IP-3) gegen die EINE geteilte Vektor-Datei — dieselbe,
 * die der Java-Zwilling `services/api .../uems/KennzahlVectorsTest` fährt.
 *
 * `zwillinge` in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE Regel, die dort
 * „ts" nennt, und prüft, dass jede Regel OHNE TS-Zwilling ihren Grund nennt.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const vektoren: Json = lies('kennzahl-vectors.json');
const prueftTs = (regel: string): boolean => (vektoren.zwillinge[regel] ?? []).includes('ts');
const betrag = (v: unknown): Dez | null => (v === null || v === undefined ? null : dez(String(v)));

/** Beträge auf den Vergleichs-Stellen des Vertrags: gerechnet wird ungerundet, verglichen auf 4 Stellen. */
const gleich = (ist: Dez | null, soll: unknown, was: string): void => {
  if (soll === null || soll === undefined) {
    expect(ist, was).toBeNull();
    return;
  }
  expect(ist, was).not.toBeNull();
  expect(dezGleich(ist as Dez, dez(String(soll)), K.VERGLEICH_NACHKOMMASTELLEN), `${was}: ${dezText(ist as Dez)} soll ${soll} sein`).toBe(true);
};

const eingang = (n: Json): K.Eingang | null =>
  n === null || n === undefined
    ? null
    : {
      art: n.art, objekt: n.objekt, name: n.name ?? null, geltung: n.geltung ?? null, wertart: n.wertart ?? null,
      status: n.status ?? null, wert: betrag(n.wert), einheit: n.einheit, zustand: n.zustand ?? null,
      abdeckung_prozent: betrag(n.abdeckung_prozent), endgueltig: n.endgueltig ?? true, ursache: n.ursache ?? null,
      kennzeichen: n.kennzeichen ?? [],
    };

const antrag = (e: Json): K.Antrag => ({
  rechenform: e.rechenform,
  periode: e.periode,
  einheit: e.einheit,
  zaehler: eingang(e.zaehler),
  nenner: eingang(e.nenner),
  komplement: e.komplement ?? false,
  mengen_nicht_negativ: e.mengen_nicht_negativ ?? false,
  teile: e.teile === null || e.teile === undefined
    ? null
    : e.teile.map((t: Json) => ({
      objekt: t.objekt, geltung: t.geltung ?? null, zaehler: betrag(t.zaehler), nenner: betrag(t.nenner), zustand: t.zustand,
      richtung: t.richtung ?? null, abdeckung_prozent: betrag(t.abdeckung_prozent), endgueltig: t.endgueltig ?? true,
      kennzeichen: t.kennzeichen ?? [],
    })),
  teile_art: e.teile_art ?? null,
  teile_wort: e.teile_wort ?? null,
  teile_periode_art: e.teile_periode_art ?? null,
  teile_rechenform: e.teile_rechenform ?? null,
  bestehen_ab: e.bestehen_ab ?? null,
  hinweise: e.hinweise ?? [],
  bisher: e.bisher ?? null,
  anlass: e.anlass ?? null,
});

const pruefeWert = (e: Json, erw: Json): void => {
  const r = K.wert(antrag(e));
  gleich(r.wert, erw.wert, 'wert');
  gleich(r.zaehler, erw.zaehler, 'zaehler');
  gleich(r.nenner, erw.nenner, 'nenner');
  gleich(r.abdeckung_prozent, erw.abdeckung_prozent, 'abdeckung_prozent');
  expect({
    zustand: r.zustand, richtung: r.richtung, grund: r.grund, fassung: r.fassung, version: r.version,
    kennzeichen: r.kennzeichen, anzeige: r.anzeige, kundensatz: r.kundensatz,
  }).toEqual({
    zustand: erw.zustand, richtung: erw.richtung, grund: erw.grund, fassung: erw.fassung, version: erw.version,
    kennzeichen: erw.kennzeichen, anzeige: erw.anzeige, kundensatz: erw.kundensatz,
  });
  expect(K.kennzeichenPruefen(r.kennzeichen), 'die Liste ist eine Kennzahl-Liste').toEqual([]);
  if (erw.nie !== undefined) {
    expect(dezGleich(r.wert as Dez, dez(erw.nie), 4), 'die Zahl, die nicht entstehen darf').toBe(false);
  }
};

const pruefeHerkunft = (e: Json, erw: Json): void => {
  const h = K.herkunft({
    kennzahl: e.kennzahl ?? null,
    rechenform: e.rechenform,
    definition_fassung: e.definition_fassung ?? null,
    periode: e.periode,
    berechnet_am: e.berechnet_am ?? null,
    version: e.version ?? null,
    anlass: e.anlass ?? null,
    eingaenge: (e.eingaenge ?? []).map((x: Json) => ({
      ...x, wert: betrag(x.wert), zaehler: betrag(x.zaehler), nenner: betrag(x.nenner), abdeckung_prozent: betrag(x.abdeckung_prozent),
    })),
    ergebnis: { ...e.ergebnis, wert: betrag(e.ergebnis.wert), abdeckung_prozent: betrag(e.ergebnis.abdeckung_prozent) },
  });
  expect(h).toEqual(erw);
  expect(schemaVerstoesse(h, lies('kennzahlwert-herkunft.schema.json'))).toEqual([]);
};

/** Die Fallquelle ist das Referenzunternehmen 1.3 — dieselben Zahlen, und die Regel rechnet denselben Wert. */
const pruefeReferenz = (e: Json, erw: Json): void => {
  const kennzahlen = new Map<string, Json>((lies('uems-referenzunternehmen.json').kennzahlen as Json[]).map((k) => [k.kennzeichen, k]));
  const kz = kennzahlen.get(e.kennzahl);
  expect(kz, 'Kennzahl im Referenzunternehmen').toBeDefined();
  expect([kz.rechenform, kz.einheit]).toEqual([erw.rechenform, erw.einheit]);
  gleich(betrag(kz.oktober_2026_zaehler), erw.zaehler, 'Zähler');
  gleich(betrag(kz.oktober_2026_nenner), erw.nenner, 'Nenner');
  gleich(betrag(kz.oktober_2026_wert), erw.wert, 'Wert');
  const periode = { art: 'monat', schluessel: '2026-10' };
  const leer = {
    komplement: false, mengen_nicht_negativ: false, teile: null, teile_art: null, teile_wort: null, teile_periode_art: null,
    teile_rechenform: null, bestehen_ab: null, hinweise: [], bisher: null, anlass: null, zaehler: null, nenner: null,
  };
  const r = kz.rechenform === K.ZUSAMMENFASSUNG
    ? K.wert({
      ...leer, rechenform: kz.rechenform, periode, einheit: kz.einheit, teile_art: 'ebene', teile_wort: 'Gebäuden',
      teile_rechenform: K.QUOTIENT,
      teile: (kz.paare as string[]).map((p) => ({
        objekt: p, geltung: kennzahlen.get(p).geltung, zaehler: betrag(kennzahlen.get(p).oktober_2026_zaehler),
        nenner: betrag(kennzahlen.get(p).oktober_2026_nenner), zustand: 'vollständig', richtung: null, abdeckung_prozent: null,
        endgueltig: true, kennzeichen: [],
      })),
    })
    : K.wert({
      ...leer, rechenform: kz.rechenform, periode, einheit: kz.einheit,
      zaehler: eingang({ art: K.MESSSTELLE, objekt: kz.zaehler, wert: kz.oktober_2026_zaehler, einheit: 'kWh', zustand: 'vollständig' }),
      nenner: eingang({
        art: K.BEZUGSGROESSE, objekt: kz.nenner, wert: kz.oktober_2026_nenner, einheit: 'Stück',
        wertart: kz.nenner_ort === null ? K.PERIODENWERT : K.STAMMDATUM, status: kz.nenner_ort === null ? K.WIRKSAM : null,
      }),
    });
  gleich(r.wert, erw.wert, 'die Regel rechnet den Wert des Referenzunternehmens');
};

/** K18: Sichtbarkeit (R-A1 ∧ R-A6, R-A7) und Anlegen — die Wahrheitswerte kommen aus `rechte.darf`. */
const pruefeRechte = (e: Json, erw: Json): void => {
  const m = matrixAus(lies('rechte-matrix.json'));
  const kb: Kundenbereich = e.kundenbereich;
  const personen = new Map<string, Benutzer>(
    (e.personen as Json[]).map((p) => [p.kennung, {
      kennung: p.kennung, name: p.name, konto: p.konto, zustand: p.zustand,
      zuweisungen: p.zuweisungen.map((z: Json) => ({
        rolle: z.rolle, standorte: z.standorte, umfang: z.umfang, art: z.art, gueltigAb: z.gueltig_ab,
        gueltigBis: z.gueltig_bis, beendetAm: z.beendet_am,
      })),
    }]),
  );
  const ziel = (g: K.GeltungUrteil): Ziel => ({ standort: g.rechte_geltung === K.STANDORT ? g.standort : null, anlage: null, stichtag: null });
  const kennzahlen = new Map<string, Json>((e.kennzahlen as Json[]).map((k) => [k.kennzeichen, k]));
  const sichtbarkeit: Record<string, Record<string, string>> = {};
  for (const [kennung, b] of personen) {
    sichtbarkeit[kennung] = {};
    for (const k of kennzahlen.values()) {
      const g = K.geltung(k.geltung_art, k.standort);
      const rA1 = darf(m, b, kb, K.ANSEHEN, ziel(g), e.jetzt).darf;
      const rA6 = (k.eingangs_standorte as string[]).map((s) => darf(m, b, kb, K.ANSEHEN, { standort: s, anlage: null, stichtag: null }, e.jetzt).darf);
      sichtbarkeit[kennung][k.kennzeichen] = K.sichtbarkeit(rA1, rA6, b.konto !== 'benutzer');
    }
  }
  const anlegen = (e.anlegen as Json[]).map((a) => {
    const k = kennzahlen.get(a.kennzahl);
    const g = K.geltung(k.geltung_art, k.standort);
    const d = darf(m, personen.get(a.person) as Benutzer, kb, g.kennung, ziel(g), e.jetzt);
    return { person: a.person, kennzahl: a.kennzahl, http: d.darf ? 201 : d.http, rolle_noetig: d.rolleNoetig };
  });
  expect({ sichtbarkeit, anlegen }).toEqual(erw);
};

const pruefe = (regel: string, e: Json, erw: Json): void => {
  switch (regel) {
    case 'wert': return pruefeWert(e, erw);
    case 'einheit': expect(K.einheit(e.rechenform, e.zaehler, e.nenner, e.paare)).toEqual(erw); return;
    case 'periode': expect(K.periode(e.gewuenscht, e.eingaenge)).toEqual(erw); return;
    case 'bestehen': expect(K.bestehen(e.periode, e.seit)).toEqual(erw); return;
    case 'laufend': expect(K.laufend(e.periode, e.jetzt, e.zeitzone, e.nenner.art, e.nenner.wertart)).toEqual(erw); return;
    case 'zyklus': expect(K.zyklus(e.kennzeichen, e.verweise, e.bestehende)).toEqual(erw); return;
    case 'geltung': expect(K.geltung(e.geltung_art, e.standort)).toEqual(erw); return;
    case 'eingang_geltung': expect(K.eingangGeltung(e.kennzahl, e.eingang)).toEqual(erw); return;
    case 'rechte': return pruefeRechte(e, erw);
    case 'vorlage': expect(K.vorlage(e.vorlage.rechenform, e.vorlage.name_vorschlag, e.vorlage.zweck_vorschlag, e.geltung_name)).toEqual(erw); return;
    case 'kopie': expect(K.kopie(e.quelle, e.neue_geltung_name)).toEqual(erw); return;
    case 'herkunft': return pruefeHerkunft(e, erw);
    case 'referenz': return pruefeReferenz(e, erw);
    case 'kennzeichen': expect(K.kennzeichenPruefen(e.liste)).toEqual(erw.verstoesse); return;
    case 'rechenform': expect(K.rechenform(e.rechenform)).toEqual(erw); return;
    case 'satz': expect(K.satz(e.code, e.werte)).toBe(erw.kundensatz); return;
    default: throw new Error(`Regel ohne TS-Prüfung: ${regel}`);
  }
};

describe('Kennzahl-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vektoren, lies('kennzahl.schema.json'))).toEqual([]);
  });

  it('die Beispielwelt ist das Referenzunternehmen in der Fassung, deren Kennzahlen sie liest', () => {
    expect(vektoren.referenzunternehmen).toBe('./uems-referenzunternehmen.json');
    // Seit 1.4 (AP-12 IP-2) darf die Datei weiter sein — sie ergänzt nur, der Diff-Test hält die Kennzahlen gleich.
    const fassung = (t: string): number => Number(t.split('.')[0]) * 1000 + Number(t.split('.')[1]);
    expect(fassung(lies('uems-referenzunternehmen.json').version)).toBeGreaterThanOrEqual(fassung(vektoren.referenz_stand));
  });

  it('Prosa und Java-Zwilling liegen, wo die Datei sie nennt', () => {
    expect(existsSync(resolve(V2, 'kennzahl.md'))).toBe(true);
    expect(existsSync(resolve(V2, 'kennzahlwert-herkunft.md'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), '../../services/api/src/main/java/com/voltpilot/api/uems/KennzahlRegeln.java'))).toBe(true);
  });

  it('K1 … K22 in ihrer Reihenfolge; die Plan-Abnahme hat ihre drei Fälle', () => {
    expect((vektoren.cases as Json[]).map((c) => c.id)).toEqual(Array.from({ length: 22 }, (_, i) => `K${i + 1}`));
    expect((vektoren.cases as Json[]).filter((c) => c.abnahme !== null).map((c) => `${c.id}=${c.abnahme}`))
      .toEqual(['K1=gebaeude', 'K2=gebaeude', 'K3=unternehmen']);
    expect(vektoren.plan_abnahmen.unternehmen).toContain('0,20');
  });
});

describe('Kennzahl-Vertrag: Vokabulare, Sätze und Kennzeichen sind die des Moduls', () => {
  it('Vokabulare, Perioden, Rechte und Regeln', () => {
    const v = vektoren.vokabulare;
    expect([v.rechenform, v.rechenform_vorgesehen, v.eingang_art, v.eingang_art_anfrage, v.eingang_rolle, v.periode_art,
      v.geltung_art])
      .toEqual([K.RECHENFORMEN, K.RECHENFORMEN_VORGESEHEN, K.EINGANG_ARTEN, K.EINGANG_ARTEN_ANFRAGE, K.EINGANG_ROLLEN,
        K.PERIODEN, K.GELTUNG_ARTEN]);
    expect([...v.zustand].sort()).toEqual([...K.ZUSTAND_RANG].sort());
    expect([v.richtung_unsicherheit, v.grund_ohne_zahl, v.fehler, v.sichtbarkeit, v.protokoll, v.ereignisse_reserviert, v.rechte])
      .toEqual([K.RICHTUNGEN, K.GRUENDE_OHNE_ZAHL, K.FEHLER, K.SICHTBARKEIT, K.PROTOKOLL, K.EREIGNISSE_RESERVIERT, K.RECHTE]);
    expect(vektoren.zustand_rang).toEqual(K.ZUSTAND_RANG);
    expect(vektoren.perioden).toEqual({ ordnung: K.PERIODEN, aufgehen: K.AUFGEHEN, woerter: K.PERIODEN_WOERTER, monatsnamen: K.MONATSNAMEN });
    expect(vektoren.rechte).toEqual({ geltung: K.RECHTE_GELTUNG, kennung: K.KENNUNG, ansehen: K.ANSEHEN });
    const r = vektoren.regeln;
    expect([r.wert_nachkommastellen, r.vergleich_nachkommastellen, r.anzeige_nachkommastellen, r.anteil_faktor, r.je, r.einheit_trenner, r.einzahl, r.ohne_zahl])
      .toEqual([K.WERT_NACHKOMMASTELLEN, K.VERGLEICH_NACHKOMMASTELLEN, K.ANZEIGE_NACHKOMMASTELLEN, K.ANTEIL_FAKTOR, K.JE, K.EINHEIT_TRENNER, K.EINZAHL, K.OHNE_ZAHL]);
    expect(vektoren.saetze).toEqual(K.SAETZE);
    expect(vektoren.verbotene_woerter).toEqual(K.VERBOTENE_WOERTER);
  });

  it('die Kennzeichen stehen im Ergebnis-Zustand 1.9 — Wortlaut, Rang, Erbregeln; jedes Beispiel ist sein eigenes Muster', () => {
    const block = lies('ergebnis-zustand-vectors.json').kennzahl_kennzeichen;
    expect(block.platzhalter).toEqual(K.PLATZHALTER);
    expect((block.saetze as Json[]).map(({ beispiel: _b, fall: _f, ...rest }) => rest)).toEqual(K.KENNZEICHEN);
    for (const s of block.saetze as Json[]) expect(K.erkenne(s.beispiel)?.schluessel, s.beispiel).toBe(s.schluessel);
    expect((block.erbend as Json[]).map(({ warum: _w, ...rest }) => rest)).toEqual(K.ERBEND);
  });

  it('die Kennungen stehen in der Rechte-Matrix', () => {
    const kennungen = new Set((lies('rechte-matrix.json').aktionen as Json[]).map((a) => a.kennung));
    for (const k of K.RECHTE) expect(kennungen.has(k), k).toBe(true);
  });

  it('jede Regel hat ihre Zwillinge; eine Regel ohne TS-Zwilling nennt ihren Grund', () => {
    const regeln = new Set<string>();
    for (const c of vektoren.cases as Json[]) for (const p of c.pruefungen as Json[]) regeln.add(p.regel);
    expect(Object.keys(vektoren.zwillinge).sort()).toEqual([...regeln].sort());
    const ohneTs = Object.keys(vektoren.zwillinge).filter((r) => !prueftTs(r)).sort();
    expect(Object.keys(vektoren.zwillinge_grund).sort()).toEqual(ohneTs);
  });
});

describe('Kennzahl-Vertrag: jede Prüfung der Vektor-Datei', () => {
  for (const fall of vektoren.cases as Json[]) {
    for (const p of fall.pruefungen as Json[]) {
      if (!prueftTs(p.regel)) continue;
      it(`${fall.id} · ${p.regel} · ${p.name}`, () => pruefe(p.regel, p.eingang, p.ergebnis));
    }
  }
});

describe('Kennzahl-Vertrag: Grenzen', () => {
  it('kein Kundensatz, keine Anzeige und kein Kennzeichen spricht ein verbotenes Wort', () => {
    const verboten = new RegExp(`(^|[^\\p{L}])(${K.VERBOTENE_WOERTER.join('|')})([^\\p{L}]|$)`, 'u');
    const saetze: string[] = [...Object.values(K.SAETZE)];
    for (const c of vektoren.cases as Json[]) {
      for (const p of c.pruefungen as Json[]) {
        for (const t of [p.ergebnis.kundensatz, p.ergebnis.anzeige, ...(p.ergebnis.kennzeichen ?? [])]) {
          if (typeof t === 'string') saetze.push(t);
        }
      }
    }
    expect(saetze.length).toBeGreaterThan(100);
    expect(saetze.filter((s) => verboten.test(s))).toEqual([]);
  });

  it('das ungewichtete Mittel entsteht nirgends — keiner der Zwillinge teilt durch die Zahl seiner Teile', () => {
    const mitNie = (vektoren.cases as Json[]).flatMap((c) => c.pruefungen as Json[]).filter((p) => p.ergebnis.nie !== undefined);
    expect(mitNie).toHaveLength(2);
    for (const p of mitNie) expect(dezGleich(K.wert(antrag(p.eingang)).wert as Dez, dez(p.ergebnis.nie), 4)).toBe(false);
    const ts = readFileSync(resolve(process.cwd(), 'src/uemsKennzahl.ts'), 'utf8');
    expect(/\baverage\b|\.mean\(|\/\s*[\w.]*\.length\b|geteilt\([^)]*\.length/i.test(ts)).toBe(false);
  });

  it('Kreis wird AUFGERUFEN, nicht kopiert', () => {
    const ts = readFileSync(resolve(process.cwd(), 'src/uemsKennzahl.ts'), 'utf8');
    expect(ts).toContain("from './uemsMessstelleFormel'");
    expect(ts).not.toContain('besucht');
  });
});
