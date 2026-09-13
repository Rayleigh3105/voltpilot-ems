import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { stellungenDesReferenzunternehmens } from './test/uemsReferenzStellungen';
import { dez, dezVergleich, type Dez } from './bezugsdaten';
import { STELLUNGEN } from './uemsMessstelle';
import {
  KENNZEICHEN_ERBEND,
  MENGE_NACHKOMMASTELLEN,
  MINUS,
  SALDIERT,
  SATZ_REST_KEINE_WERTE,
  SATZ_REST_NEGATIV,
  SATZ_REST_ZUGEORDNET,
  TAUSENDER_TRENNZEICHEN,
  VERBOTENE_WOERTER,
  ZUSTAND_RANG,
  ebene,
  gebaeude,
  herkunft,
  live,
  richtung,
  rest,
  restAusStellung,
  rolle,
  saldo,
  summe,
  versorgung,
  type Eingang,
  type HerkunftEingang,
  type Summand,
} from './uemsBilanz';

/**
 * Die Regeln der ENERGIEBILANZ (UEMS AP-10 IP-1) gegen die EINE geteilte Vektor-Datei —
 * dieselbe, die der Java-Zwilling `services/api .../uems/BilanzVectorsTest` fährt.
 *
 * `zwillinge` in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE Regel, die dort
 * „ts" nennt, und prüft, dass jede Regel OHNE TS-Zwilling ihren Grund nennt — so bleibt keine
 * Regel stillschweigend ungeprüft.
 *
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'bilanz-vectors.json'));
const schema: Json = lies(resolve(V2, 'bilanz.schema.json'));
const herkunftSchema: Json = lies(resolve(V2, 'bilanzwert-herkunft.schema.json'));

const prueftTs = (regel: string): boolean => (vectors.zwillinge[regel] ?? []).includes('ts');

const betrag = (v: unknown): Dez | null => (v === null || v === undefined ? null : dez(String(v)));

/** Beträge werden NUMERISCH verglichen: „10" und „10.000000" sind derselbe Betrag. */
const betragGleich = (ist: Dez | null, soll: unknown, was: string): void => {
  if (soll === null || soll === undefined) {
    expect(ist, was).toBeNull();
    return;
  }
  expect(ist, was).not.toBeNull();
  expect(dezVergleich(ist as Dez, dez(String(soll))), `${was}: soll ${soll} sein`).toBe(0);
};

const eingaenge = (n: Json[]): Eingang[] =>
  n.map((e) => ({
    messstelle: e.messstelle,
    rolle: e.rolle,
    anteil: e.anteil,
    menge: betrag(e.menge),
    zustand: e.zustand,
    abdeckung_prozent: e.abdeckung_prozent,
    version: e.version,
    kennzeichen: e.kennzeichen,
  }));

const summanden = (n: Json[]): Summand[] =>
  n.map((e) => ({
    messstelle: e.messstelle,
    menge: betrag(e.menge),
    zustand: e.zustand,
    abdeckung_prozent: e.abdeckung_prozent,
    version: e.version,
    kennzeichen: e.kennzeichen,
    vorzeichen: e.vorzeichen,
    faktor: dez(String(e.faktor)),
  }));

const herkunftEingang = (ein: Json): HerkunftEingang => ({
  art: ein.art ?? null,
  messstelle: ein.messstelle ?? null,
  periode: { art: ein.periode?.art ?? null, schluessel: ein.periode?.schluessel ?? null },
  formel_typ: ein.formel_typ ?? null,
  formel_fassung: ein.formel_fassung ?? null,
  periode_ende: ein.periode_ende ?? null,
  berechnet_am: ein.berechnet_am ?? null,
  version: ein.version,
  ausloeser: ein.ausloeser ?? null,
  verteilung: ein.verteilung ?? null,
  eingaenge: (ein.eingaenge ?? []).map((w: Json) => ({
    messstelle: w.messstelle,
    bilanz_rolle: w.bilanz_rolle ?? null,
    anteil: w.anteil ?? null,
    menge: w.menge ?? null,
    zustand: w.zustand,
    abdeckung_prozent: w.abdeckung_prozent ?? null,
    version: w.version,
    kennzeichen: w.kennzeichen ?? [],
  })),
  ergebnis: ein.ergebnis
    ? {
        menge: ein.ergebnis.menge ?? null,
        zustand: ein.ergebnis.zustand ?? null,
        abdeckung_prozent: ein.ergebnis.abdeckung_prozent ?? null,
        kennzeichen: ein.ergebnis.kennzeichen ?? null,
      }
    : null,
});

describe('Bilanz-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
  });

  it('die Beispielwelt ist das Referenzunternehmen', () => {
    expect(vectors.referenzunternehmen).toBe('./uems-referenzunternehmen.json');
    expect(existsSync(resolve(V2, 'uems-referenzunternehmen.json'))).toBe(true);
  });

  it('Prosa und Java-Zwilling liegen, wo die Datei sie nennt', () => {
    expect(existsSync(resolve(V2, 'bilanz.md'))).toBe(true);
    expect(existsSync(resolve(V2, 'bilanzwert-herkunft.md'))).toBe(true);
    expect(
      existsSync(
        resolve(
          process.cwd(),
          '../../services/api/src/main/java/com/voltpilot/api/uems/BilanzAbleitung.java',
        ),
      ),
    ).toBe(true);
  });

  it('jeder Fall hat Zweck, Titel und Handrechnung; die Kennungen sind eindeutig', () => {
    const kennungen = vectors.cases.map((c: Json) => c.id);
    expect(new Set(kennungen).size).toBe(kennungen.length);
    expect(kennungen).toContain('F1');
    expect(kennungen).toContain('F19');
    for (const fall of vectors.cases) {
      expect(fall.why, `${fall.id} · why`).toBeTruthy();
      expect(fall.titel, `${fall.id} · titel`).toBeTruthy();
      expect(fall.schritte.length, `${fall.id} · Handrechnung`).toBeGreaterThan(0);
    }
  });

  it('die Plan-Abnahme des Captains hat ihren Fall — 100 · 60 · 30 · 10', () => {
    const plan: string = vectors.plan_abnahmen.plan;
    for (const zahl of ['100', '60', '30', '10']) expect(plan).toContain(zahl);
    const mit = vectors.cases
      .filter((c: Json) => c.abnahme !== null)
      .map((c: Json) => `${c.id}=${c.abnahme}`);
    expect(mit).toEqual(['F1=plan']);
  });

  it('die Schwellen, Zeichen und Erbregeln stehen in der Datei, nicht nur im Modul', () => {
    expect(vectors.regeln.menge_nachkommastellen).toBe(MENGE_NACHKOMMASTELLEN);
    expect(vectors.regeln.tausender_trennzeichen).toBe(TAUSENDER_TRENNZEICHEN);
    expect(vectors.regeln.minuszeichen).toBe(MINUS);
    expect(vectors.zustand_rang).toEqual(ZUSTAND_RANG);
    expect([...vectors.vokabulare.zustand].sort()).toEqual([...ZUSTAND_RANG].sort());
    expect(vectors.verbotene_woerter).toEqual(VERBOTENE_WOERTER);
    expect(vectors.kennzeichen_erbend.map((e: Json) => ({ muster: e.muster, als: e.als }))).toEqual(
      KENNZEICHEN_ERBEND,
    );
    for (const e of vectors.kennzeichen_erbend) expect(e.warum).toBeTruthy();
  });

  it('die Stellungen sind die des Messstellen-Vertrags — kein zweites Vokabular', () => {
    expect(vectors.vokabulare.stellung).toEqual([...STELLUNGEN]);
  });

  it('der Kundensatz des Rests kommt aus dem Vertrag (saetze) — nie „Verlust"', () => {
    expect(SATZ_REST_ZUGEORDNET).toBe(vectors.saetze.rest_zugeordnet);
    expect(SATZ_REST_NEGATIV).toBe(vectors.saetze.rest_negativ);
    expect(SATZ_REST_KEINE_WERTE).toBe(vectors.saetze.rest_keine_werte);
  });

  it('E3: jede Fassung aus der Stellung ist genau die Eingangsmenge einer Rest-Prüfung desselben Falls', () => {
    const schluessel = (ts: Json[]): string[] =>
      ts.map((t) => `${t.messstelle}:${t.rolle}:${t.anteil}`).sort();
    let gedeckt = 0;
    for (const fall of vectors.cases) {
      for (const p of fall.pruefungen) {
        if (p.regel !== 'rest_aus_stellung' || p.ergebnis.fehler !== null) continue;
        const ausStellung = schluessel(p.ergebnis.terme);
        const restEingaenge = fall.pruefungen
          .filter((r: Json) => r.regel === 'rest' && r.eingang.hauptzaehler === p.eingang.hauptzaehler)
          .map((r: Json) => schluessel(r.eingang.eingaenge));
        expect(restEingaenge, `${fall.id} · ${p.name}`).toContainEqual(ausStellung);
        gedeckt += 1;
      }
    }
    expect(gedeckt).toBeGreaterThanOrEqual(9);
  });

  it('die Richtung je Typ ist eine Regel in der Datei', () => {
    expect(vectors.richtung_je_typ.rest.fest).toBe(true);
    expect(vectors.richtung_je_typ.rest.richtung).toBe('Bezug');
    expect(vectors.richtung_je_typ.saldo.richtung).toBe(SALDIERT);
    expect(vectors.richtung_je_typ.saldo.nur_art).toBe('berechnet');
    expect(vectors.richtung_je_typ.gewichtete_summe.fest).toBe(false);
    expect(vectors.vokabulare.richtung_berechnet_additiv).toEqual([SALDIERT]);
  });

  it('kein Satz und kein Kennzeichen behauptet eine Ursache', () => {
    const saetze: string[] = [
      ...Object.values<string>(vectors.saetze),
      ...vectors.vokabulare.kennzeichen_neu,
    ];
    for (const fall of vectors.cases) {
      for (const p of fall.pruefungen) {
        if (typeof p.ergebnis?.kundensatz === 'string') saetze.push(p.ergebnis.kundensatz);
      }
    }
    for (const satz of saetze) {
      for (const wort of VERBOTENE_WOERTER) expect(satz).not.toContain(wort);
    }
  });

  it('jede Regel ist deklariert, jede Lücke begründet, jeder Fall ohne Prüfung benannt', () => {
    const benutzt = new Set<string>();
    const ohnePruefung: string[] = [];
    for (const fall of vectors.cases) {
      if (fall.pruefungen.length === 0) ohnePruefung.push(fall.id);
      for (const p of fall.pruefungen) benutzt.add(p.regel);
    }
    expect(Object.keys(vectors.zwillinge).sort()).toEqual([...benutzt].sort());
    for (const [regel, wer] of Object.entries<string[]>(vectors.zwillinge)) {
      expect(wer, `Zwillinge von ${regel}`).toContain('java');
      if (!wer.includes('ts')) {
        expect(vectors.zwillinge_grund[regel], `Grund, warum ${regel} keinen TS-Zwilling hat`).toBeTruthy();
      }
    }
    const begruendet: string[] = vectors._nicht_geprueft.map((o: Json) => o.fall);
    for (const id of ohnePruefung) {
      expect(begruendet.some((b) => b.includes(id)), `${id} muss in _nicht_geprueft stehen`).toBe(true);
    }
  });

  it('jede Abweichung von der Vorlage und jede ungeprüfte Erwartung ist benannt', () => {
    expect(Array.isArray(vectors._abweichungen)).toBe(true);
    for (const a of vectors._abweichungen) {
      expect(a.fall).toBeTruthy();
      expect(a.feld).toBeTruthy();
      expect(a.grund).toBeTruthy();
    }
    expect(vectors._nicht_geprueft.length).toBeGreaterThan(0);
    for (const n of vectors._nicht_geprueft) {
      expect(n.fall).toBeTruthy();
      expect(n.feld).toBeTruthy();
      expect(n.warum).toBeTruthy();
    }
  });
});

describe('Bilanz-Vertrag: die Vektoren', () => {
  const faelle: Array<[string, Json, Json]> = [];
  for (const fall of vectors.cases) {
    for (const p of fall.pruefungen) {
      if (!prueftTs(p.regel)) continue;
      faelle.push([`${fall.id} · ${p.regel} :: ${p.name}`, fall, p]);
    }
  }

  it('der Läufer ist verdrahtet (genug Prüfungen für das Portal)', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(45);
  });

  it.each(faelle)('%s', (_name, fall: Json, p: Json) => {
    const why = `${fall.id} (${fall.why})`;
    const ein = p.eingang;
    const soll = p.ergebnis;

    switch (p.regel) {
      case 'rolle': {
        const ist = rolle({
          stellung: ein.stellung,
          richtung: ein.richtung,
          art: ein.art,
          medium: ein.medium,
          unterzaehler_von: ein.unterzaehler_von,
        });
        expect(ist.rollen, `${why} · Rollen`).toEqual(soll.rollen);
        expect(ist.ziel, `${why} · Ziel`).toBe(soll.ziel);
        expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
        break;
      }
      case 'rest': {
        const ist = rest(ein.hauptzaehler, ein.einheit, ein.version, ein.vermerke, eingaenge(ein.eingaenge));
        betragGleich(ist.zufluss, soll.zufluss, `${why} · Zufluss`);
        betragGleich(ist.abfluss, soll.abfluss, `${why} · Abfluss`);
        betragGleich(ist.zugeordnet, soll.zugeordnet, `${why} · zugeordnet`);
        betragGleich(ist.verbrauch_system, soll.verbrauch_system, `${why} · Verbrauch`);
        betragGleich(ist.menge, soll.menge, `${why} · Rest`);
        expect(ist.groesse, `${why} · Größe`).toBe(soll.groesse);
        expect(ist.richtung, `${why} · Richtung`).toBe(soll.richtung);
        expect(ist.einheit, `${why} · Einheit`).toBe(soll.einheit);
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
        expect(ist.fehlend, `${why} · fehlend`).toEqual(soll.fehlend);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.kundensatz, `${why} · Kundensatz`).toBe(soll.kundensatz);
        break;
      }
      case 'summe': {
        const ist = summe(ein.einheit, summanden(ein.eingaenge));
        betragGleich(ist.menge, soll.menge, `${why} · Summe`);
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
        expect(ist.vorhanden, `${why} · vorhanden`).toBe(soll.vorhanden);
        expect(ist.gesamt, `${why} · gesamt`).toBe(soll.gesamt);
        expect(ist.fehlend, `${why} · fehlend`).toEqual(soll.fehlend);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.anzeige, `${why} · Anzeige`).toBe(soll.anzeige);
        break;
      }
      case 'saldo': {
        const ist = saldo(ein.einheit, ein.art, eingaenge(ein.eingaenge));
        betragGleich(ist.menge, soll.menge, `${why} · Saldo`);
        expect(ist.groesse, `${why} · Größe`).toBe(soll.groesse);
        expect(ist.richtung, `${why} · Richtung`).toBe(soll.richtung);
        expect(ist.einheit, `${why} · Einheit`).toBe(soll.einheit);
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
        expect(ist.fehlend, `${why} · fehlend`).toEqual(soll.fehlend);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
        break;
      }
      case 'richtung': {
        const ist = richtung(ein.typ, ein.art, ein.wertart, ein.terme);
        expect(ist.groesse, `${why} · Größe`).toBe(soll.groesse);
        expect(ist.richtung, `${why} · Richtung`).toBe(soll.richtung);
        expect(ist.einheit, `${why} · Einheit`).toBe(soll.einheit);
        expect(ist.wertart, `${why} · Wertart`).toBe(soll.wertart);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
        break;
      }
      case 'ebene': {
        const ist = ebene(
          ein.einheit,
          ein.wort,
          ein.systeme.map((s: Json) => ({ ...s, menge: betrag(s.menge) })),
        );
        betragGleich(ist.menge, soll.menge, `${why} · Summe`);
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
        expect(ist.mit_werten, `${why} · mit Werten`).toBe(soll.mit_werten);
        expect(ist.gesamt, `${why} · gesamt`).toBe(soll.gesamt);
        expect(ist.fehlend, `${why} · fehlend`).toEqual(soll.fehlend);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.anzeige_kennzeichen, `${why} · Anzeige-Kennzeichen`).toEqual(soll.anzeige_kennzeichen);
        break;
      }
      case 'live': {
        const ist = live(ein.einheit, ein.terme);
        expect(ist.wert, `${why} · Live-Wert`).toBe(soll.wert);
        expect(ist.unvollstaendig, `${why} · unvollständig`).toBe(soll.unvollstaendig);
        expect(ist.fehlende, `${why} · fehlende`).toEqual(soll.fehlende);
        break;
      }
      case 'gebaeude': {
        const ist = gebaeude(
          ein.gebaeude,
          ein.anlage,
          ein.einheit,
          ein.messstellen.map((z: Json) => ({ ...z, menge: dez(String(z.menge)) })),
          betrag(ein.rest?.menge),
        );
        betragGleich(ist.gemessen_im_gebaeude, soll.gemessen_im_gebaeude, `${why} · gemessen im Gebäude`);
        betragGleich(ist.im_system_ausserhalb, soll.im_system_ausserhalb, `${why} · im System außerhalb`);
        betragGleich(ist.rest_nicht_verortet, soll.rest_nicht_verortet, `${why} · Rest nicht verortet`);
        betragGleich(ist.zufluss_im_gebaeude, soll.zufluss_im_gebaeude, `${why} · Zufluss im Gebäude`);
        expect(ist.gebaeudeverbrauch, `${why} · Gebäudeverbrauch wird NIE behauptet`).toBeNull();
        expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
        break;
      }
      case 'versorgung': {
        const ist = versorgung(ein.tag, ein.gebaeude, ein.messstellen);
        expect(ist.versorgt, `${why} · versorgt`).toEqual(soll.versorgt);
        expect(ist.ausserhalb_gebaeude, `${why} · außerhalb eines Gebäudes`).toEqual(
          soll.ausserhalb_gebaeude,
        );
        expect(ist.nicht_messbar, `${why} · nicht messbar`).toEqual(soll.nicht_messbar);
        break;
      }
      case 'herkunft': {
        const ist = herkunft(herkunftEingang(ein));
        expect(ist.fehlt, `${why} · fehlende Pflichtangaben`).toEqual(soll.fehlt);
        if (soll.satz === null) {
          expect(ist.satz, `${why} · kein halber Herkunfts-Satz`).toBeNull();
          break;
        }
        expect(ist.satz, `${why} · Herkunfts-Satz`).toEqual(soll.satz);
        expect(schemaVerstoesse(ist.satz, herkunftSchema), `${why} · Schema`).toEqual([]);
        break;
      }
      case 'rest_aus_stellung': {
        const ist = restAusStellung(ein.hauptzaehler, ein.tag, stellungenDesReferenzunternehmens());
        expect(ist.hauptzaehler, `${why} · Hauptzähler`).toBe(ein.hauptzaehler);
        expect(ist.anlage, `${why} · System`).toBe(soll.anlage);
        expect(ist.terme, `${why} · Terme aus der Stellung`).toEqual(soll.terme);
        expect(ist.ausserhalb, `${why} · außerhalb`).toEqual(soll.ausserhalb);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        break;
      }
      default:
        throw new Error(`unbekannte Regel ${p.regel}`);
    }
  });
});
