import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { darf, matrixAus, type Benutzer, type Kundenbereich } from './rechte';
import * as B from './uemsBericht';

/**
 * Die Regeln des BERICHTS (UEMS AP-12 IP-1/IP-3) gegen die EINE geteilte Vektor-Datei — dieselbe,
 * die der Java-Zwilling `services/api .../uems/BerichtVectorsTest` fährt. Die kanonische Form eines
 * Abzugs ist byte-gleich: Prüfsumme (hier mit `node:crypto` gehasht) und Länge in Bytes je Abzug.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const vektoren: Json = lies('bericht-vectors.json');
const schema: Json = lies('bericht.schema.json');
const ZONE: string = vektoren.zeitzone;
const prueftTs = (regel: string): boolean => (vektoren.zwillinge[regel] ?? []).includes('ts');

const fassung = (text: string): number => {
  const [a, b] = text.split('.').map(Number);
  return a * 1000 + b;
};

/** Quellen stehen in der Datei als Gruppen je Bericht, Stand, Bezug und Tagen — hier eine Zeile je Objekt. */
const quellenZeilen = (gruppen: Json[] | undefined): B.Quelle[] =>
  (gruppen ?? []).flatMap((g) => (g.objekte as string[]).map((objekt) => {
    const { objekte: _weg, ...rest } = g;
    return { ...rest, objekt } as B.Quelle;
  }));

const pruefeRechte = (e: Json): Json => {
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
  const ergebnisse = (e.anfragen as Json[]).map((a) => {
    const kennung = B.kennung(a.handlung, a.geltung_art);
    const d = darf(m, personen.get(a.person) as Benutzer, kb, kennung, { standort: a.standort, anlage: null, stichtag: null }, e.jetzt);
    return { person: a.person, kennung, standort: a.standort, ergebnis: d.darf ? 'ja' : String(d.http) };
  });
  const teilansicht: Record<string, string | null> = {};
  for (const [kennung, b] of personen) {
    const t = B.teilansicht(m, b, kb, e.jetzt);
    teilansicht[kennung] = t === null ? null : t.join(', ');
  }
  return { ergebnisse, teilansicht };
};

const kennzeichen = (e: Json): string | null => {
  switch (e.schluessel) {
    case 'berichtsstand': return B.berichtsstand(e.nr);
    case 'ersetzt_durch': return B.ersetztDurch(e.nr, e.am, ZONE);
    case 'revision_noetig': return B.revisionNoetig(e.anlass);
    case 'entwurf': return B.entwurf(e.datenstand, ZONE);
    case 'zeitraum_laeuft': return B.ZEITRAUM_LAEUFT;
    case 'vorlaeufig': return B.vorlaeufig(e.endgueltig_ab, ZONE);
    case 'heute': return B.heute(e.name_zum_datenstand, e.name_heute);
    case 'teilansicht': return B.teilansichtKennzeichen(e.standorte);
    case 'vor_beginn': return B.vorBeginn(e.seit);
    case 'anstoss_verworfen': return B.anstossVerworfen(e.begruendung);
    default: throw new Error(`unbekanntes Kennzeichen ${e.schluessel}`);
  }
};

const satz = (code: string, w: Json): string => {
  switch (code) {
    case 'keine_quellen': return B.keineQuellen(w.geltung, w.zeitraum, w.besteht_seit);
    case 'bericht_gibt_es_schon': return B.berichtGibtEsSchon(w.kennung, w.geltung, w.zeitraum);
    case 'stand_gibt_es_nicht': return B.standGibtEsNicht(w.nr, w.neueste, ZONE);
    case 'wert_nicht_mehr_gespeichert': return B.wertNichtMehrGespeichert(w.zeitraum, w.stand, ZONE);
    case 'berichts_belege': return B.berichtsBelege(w.staende);
    case 'abzug_beschaedigt': return B.abzugBeschaedigt(w.nr);
    case 'vorlage_unbekannt':
    case 'geltung_unbekannt': return B.SAETZE[code];
    default: throw new Error(`unbekannter Satz ${code}`);
  }
};

const pruefe = (regel: string, e: Json): Json => {
  switch (regel) {
    case 'vorlage': {
      const v = B.vorlage(e.vorlage);
      return v === null
        ? { geltung_art: null, zeitraum_art: null, vergleiche: null, abschnitte: null, fehler: 'vorlage_unbekannt', status: B.FEHLER_STATUS.vorlage_unbekannt, kundensatz: B.SAETZE.vorlage_unbekannt }
        : { geltung_art: v.geltung_art, zeitraum_art: v.zeitraum_art, vergleiche: v.vergleiche, abschnitte: v.abschnitte, fehler: null, status: null, kundensatz: null };
    }
    case 'zeitraum': return B.zeitraum(e.art, e.schluessel, e.zone);
    case 'vergleich_grund': return { grund: B.vergleichGrund(e) };
    case 'vergleich': return B.vergleich(e);
    case 'freigabe': return B.freigabe(e);
    case 'datenstand': {
      const d2 = B.d2(e.datenstand, e.berechnet_am, e.endgueltig_ab, e.freigabe !== null);
      const d3 = e.freigabe === null ? [] : B.d3(e.datenstand, e.freigabe, e.aenderungen);
      const d4 = B.d4(e.datenstand, e.aenderungen);
      return { d2: d2.length === 0, d2_verstoesse: d2, d3: e.freigabe === null ? null : d3.length === 0, d3_verstoesse: d3, d4_aktuell: d4.length === 0, d4_neuere: d4 };
    }
    case 'betroffenheit': {
      const quellen = quellenZeilen(e.quellen);
      if (e.betroffen !== undefined) {
        const bindung = new Map<string, string[]>((e.quellenbindung as Json[]).map((x) => [`${x.entity}/${x.kanal}`, x.messstellen]));
        const betroffene = B.betroffene(quellen, e.betroffen, (r) => bindung.get(`${r.entity}/${r.kanal}`) ?? []);
        return { betroffene: betroffene.map((b) => [b.kennung, b.stand]), anstoss_art: B.anstossArt(e.betroffen) };
      }
      return { betroffene: B.betroffeneStruktur(quellen, e.struktur.objekte, e.struktur.gilt_ab).map((b) => [b.kennung, b.stand]), anstoss_art: null };
    }
    case 'struktur': return B.struktur(e.protokoll, e.objekt_art, e.art, e.rueckwirkend, e.korrektur);
    case 'abweichungen': return { abweichungen: B.abweichungen(vektoren.abzuege[e.alt], vektoren.abzuege[e.neu]) };
    case 'rechte': return pruefeRechte(e);
    case 'kanonisch': {
      const text = B.kanonisch(vektoren.abzuege[e.abzug]);
      const pruefsumme = B.PRUEFSUMME_PRAEFIX + createHash('sha256').update(text, 'utf8').digest('hex');
      const bytes = Buffer.byteLength(text, 'utf8');
      return e.abzug === 'randfall' ? { text, pruefsumme, bytes } : { pruefsumme, bytes };
    }
    case 'csv_kopf': return { zeilen: B.csvKopf(e) };
    case 'csv_zeile': return { zeile: B.csvZeile(e, ZONE) };
    case 'kopf': return { text: B.kopf(e.datenstand, e.zone, e.stand) };
    case 'kennzeichen': return { text: kennzeichen(e) };
    case 'anlass': return { text: B.anlass(e.kennung) };
    case 'satz': return { status: B.FEHLER_STATUS[e.code], kundensatz: satz(e.code, e.werte) };
    case 'anzeige': return { text: B.anzeige(e.art, e.wert, e.einheit, e.ebene) };
    default: throw new Error(`unbekannte Regel ${regel}`);
  }
};

describe('Bericht-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema; die Abzüge, die Quellen und die Vorlagen-Datei halten ihre Formen', () => {
    expect(schemaVerstoesse(vektoren, schema)).toEqual([]);
    for (const s of ['BR-2026-0001/1', 'BR-2026-0001/2']) {
      expect(schemaVerstoesse(vektoren.abzuege[s], schema, schema.$defs.abzug), s).toEqual([]);
    }
    const zeilen = (vektoren.cases as Json[]).flatMap((c) => (c.pruefungen as Json[]).flatMap((p) => quellenZeilen(p.eingang.quellen)));
    expect(zeilen.length).toBeGreaterThan(300);
    expect(zeilen.flatMap((q) => schemaVerstoesse(q, schema, schema.$defs.quelle))).toEqual([]);
    expect(schemaVerstoesse(lies('bericht-vorlagen.json'), schema, schema.$defs.vorlagen_datei)).toEqual([]);
  });

  it('die Beispielwelt ist das Referenzunternehmen 1.4 oder später; Prosa und Java-Zwilling liegen', () => {
    const ref = lies('uems-referenzunternehmen.json');
    expect(fassung(ref.version)).toBeGreaterThanOrEqual(fassung(vektoren.referenz_stand));
    expect(ref.berichte[0].quellen).toEqual(vektoren.cases[0].nachweis.quellenverzeichnis);
    expect(existsSync(resolve(V2, 'bericht.md'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), '../../services/api/src/main/java/com/voltpilot/api/uems/BerichtRegeln.java'))).toBe(true);
  });

  it('B1 … B16 in ihrer Reihenfolge; die Plan-Abnahme hat B1 und B16 mit derselben Prüfsumme', () => {
    expect((vektoren.cases as Json[]).map((c) => c.id)).toEqual(Array.from({ length: 16 }, (_, i) => `B${i + 1}`));
    expect((vektoren.cases as Json[]).filter((c) => c.abnahme !== null).map((c) => [c.id, c.abnahme])).toEqual([['B1', 'captain'], ['B16', 'captain']]);
    const summe = (i: number): string => (vektoren.cases[i].pruefungen as Json[]).find((p) => p.regel === 'kanonisch').ergebnis.pruefsumme;
    expect(summe(15)).toBe(summe(0));
    expect(summe(0)).toBe(vektoren.cases[0].nachweis.stand.pruefsumme);
  });
});

describe('Bericht-Vertrag: Vokabulare, Sätze, Vorlagen und Kennzeichen sind die des Moduls', () => {
  it('Vokabulare, Fehler, Regeln und Sätze', () => {
    const v = vektoren.vokabulare;
    expect([v.bericht_stand, v.vorlage, v.geltung_art, v.zeitraum_art, v.vergleich_art, v.quelle_art, v.quelle_bezug, v.anstoss_art,
      v.anstoss_zustand, v.grund_ohne_vergleich, v.kein_anstoss, v.struktur_protokoll, v.handlung, v.fehler, v.ereignisse_reserviert, v.rechte])
      .toEqual([B.STAENDE, B.VORLAGEN.map((x) => x.schluessel), B.GELTUNG_ARTEN, B.ZEITRAUM_ARTEN, B.VERGLEICH_ARTEN, B.QUELLE_ARTEN,
        B.QUELLE_BEZUEGE, B.ANSTOSS_ARTEN, B.ANSTOSS_ZUSTAENDE, B.GRUENDE_OHNE_VERGLEICH, B.KEIN_ANSTOSS, B.STRUKTUR_PROTOKOLLE,
        B.HANDLUNGEN, B.FEHLER, B.EREIGNISSE_RESERVIERT, B.RECHTE]);
    expect(vektoren.fehler_status).toEqual(B.FEHLER_STATUS);
    const r = vektoren.regeln;
    expect([r.freigabe_frist_tage, r.prozent_nachkommastellen, r.prozent_rechen_nachkommastellen, r.quellen_im_satz, r.pruefsumme_praefix,
      r.kennzeichen_trenner, r.ohne_zahl, r.csv_trenner, r.csv_dezimal, r.csv_spalten, r.csv_kopf, r.kennung, r.teilansicht_recht])
      .toEqual([B.FREIGABE_FRIST_TAGE, B.PROZENT_NACHKOMMASTELLEN, B.PROZENT_RECHEN_NACHKOMMASTELLEN, B.QUELLEN_IM_SATZ, B.PRUEFSUMME_PRAEFIX,
        B.KENNZEICHEN_TRENNER, B.OHNE_ZAHL, B.CSV_TRENNER, B.CSV_DEZIMAL, B.CSV_SPALTEN, B.CSV_KOPF, B.KENNUNG, B.TEILANSICHT_RECHT]);
    expect(vektoren.saetze).toEqual(B.SAETZE);
    expect(vektoren.verbotene_woerter).toEqual(B.VERBOTENE_WOERTER);
  });

  it('die Vorlagen-Datei ist die der Klasse', () => {
    const datei = lies('bericht-vorlagen.json');
    expect((datei.vorlagen as Json[]).map((v) => ({
      schluessel: v.schluessel, fassung: v.fassung, geltung_art: v.geltung_art, zeitraum_art: v.zeitraum_art,
      vergleiche: v.vergleiche, abschnitte: (v.abschnitte as Json[]).map((a) => a.schluessel),
    }))).toEqual(B.VORLAGEN);
  });

  it('die Kennzeichen stehen im Ergebnis-Zustand 1.10 — Wortlaut und Stelle; jedes Beispiel ist sein eigenes Muster', () => {
    const ez = lies('ergebnis-zustand-vectors.json');
    const block = ez.bericht_kennzeichen;
    expect(block.platzhalter).toEqual(B.KENNZEICHEN_PLATZHALTER);
    expect(block.platzhalter.datum).toBe(ez.kennzahl_kennzeichen.platzhalter.datum);
    expect((block.saetze as Json[]).map((s) => ({ schluessel: s.schluessel, muster: s.muster, platzhalter: s.platzhalter, stelle: s.stelle })))
      .toEqual(B.KENNZEICHEN);
    for (const s of block.saetze as Json[]) {
      let rx = (s.muster as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const [name, typ] of Object.entries(s.platzhalter as Record<string, string>)) {
        rx = rx.split(`\\{${name}\\}`).join(`(${block.platzhalter[typ]})`);
      }
      expect(new RegExp(`^${rx}$`, 'u').test(s.beispiel), `${s.schluessel}: ${s.beispiel}`).toBe(true);
    }
  });

  it('die Kennungen stehen in der Rechte-Matrix; die Reservierungen im Ereignis-Vokabular', () => {
    const kennungen = new Set((lies('rechte-matrix.json').aktionen as Json[]).map((a) => a.kennung));
    expect([...B.RECHTE, B.TEILANSICHT_RECHT].filter((k) => !kennungen.has(k))).toEqual([]);
    const ev = lies('events-vocabulary-vectors.json');
    expect((ev.reserviert as Json[]).filter((r) => r.art.startsWith('bericht_')).map((r) => `${r.art}/${r.bezug}`)).toEqual(B.EREIGNISSE_RESERVIERT);
  });

  it('jede Regel hat ihre Zwillinge; eine Regel ohne TS-Zwilling nennt ihren Grund', () => {
    const regeln = new Set((vektoren.cases as Json[]).flatMap((c) => (c.pruefungen as Json[]).map((p) => p.regel)));
    expect(new Set(Object.keys(vektoren.zwillinge))).toEqual(regeln);
    const ohneTs = Object.keys(vektoren.zwillinge).filter((r) => !prueftTs(r));
    expect(Object.keys(vektoren.zwillinge_grund).sort()).toEqual(ohneTs.sort());
  });
});

describe('Bericht-Vertrag: jede Prüfung der Vektor-Datei', () => {
  for (const fall of vektoren.cases as Json[]) {
    for (const p of fall.pruefungen as Json[]) {
      if (!prueftTs(p.regel)) continue;
      it(`${fall.id} · ${p.regel} · ${p.name}`, () => expect(pruefe(p.regel, p.eingang)).toEqual(p.ergebnis));
    }
  }
});

describe('Bericht-Vertrag: Grenzen', () => {
  it('kein Satz, kein Kundensatz und kein Kennzeichen spricht über den Bericht in einem verbotenen Wort', () => {
    const texte = [
      ...Object.values(B.SAETZE), ...B.KENNZEICHEN.map((k) => k.muster),
      ...(vektoren.cases as Json[]).flatMap((c) => (c.pruefungen as Json[])
        .filter((p) => p.regel !== 'kanonisch')
        .flatMap((p) => [p.ergebnis.kundensatz, p.ergebnis.text].filter((t): t is string => typeof t === 'string'))),
    ];
    expect(texte.length).toBeGreaterThan(80);
    expect(texte.filter((t) => B.VERBOTENE_WOERTER.some((w) => t.includes(w)))).toEqual([]);
  });

  it('aufgerufen, nicht kopiert: keine feste Zeitzone, keine eigene Sieben-Tage-Rechnung, kein eigener Zonen-Zusatz', () => {
    const ts = readFileSync(resolve(process.cwd(), 'src/uemsBericht.ts'), 'utf8');
    for (const soll of ['spanneVon', 'mitternacht', 'uhr(', 'zoneKurz(', 'zahlMitStellen', 'anzeige as kennzahlAnzeige', 'periodeText', 'datumText', 'darf(']) {
      expect(ts, soll).toContain(soll);
    }
    for (const nie of ['Europe/Berlin', "'MEZ'", '86400000 * 7', '7 * 86400000']) {
      expect(ts, nie).not.toContain(nie);
    }
  });
});
