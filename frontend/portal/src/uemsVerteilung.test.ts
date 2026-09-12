import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { dez, dezVergleich, type Dez } from './bezugsdaten';
import { MENGE_NACHKOMMASTELLEN } from './uemsBilanz';
import {
  ANTEIL_NACHKOMMASTELLEN,
  NICHT_VERTEILT,
  SUMME_PROZENT,
  VERTEILT,
  amTag,
  erbe,
  fassung,
  mengen,
  satz,
  term,
  type Abschnitt,
  type Bestandszeile,
  type Zeile,
  type Ziel,
} from './uemsVerteilung';

/**
 * Die Regeln der FESTEN VERTEILUNG (UEMS AP-10 IP-1) gegen die EINE geteilte Vektor-Datei —
 * dieselbe, die der Java-Zwilling `services/api .../uems/VerteilungVectorsTest` fährt.
 *
 * `zwillinge` in der Datei sagt je Regel, wer sie prüft; `zwillinge_grund` nennt je Lücke den
 * Grund. Die Regel `herkunft` ist serverseitig — sie wird im Bilanz-Vertrag in BEIDEN Sprachen
 * geprüft und hier deshalb nur als Lücke mit Grund geführt.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'verteilung-vectors.json'));
const schema: Json = lies(resolve(V2, 'verteilung.schema.json'));

const prueftTs = (regel: string): boolean => (vectors.zwillinge[regel] ?? []).includes('ts');

const betrag = (v: unknown): Dez | null => (v === null || v === undefined ? null : dez(String(v)));

const betragGleich = (ist: Dez | null, soll: unknown, was: string): void => {
  if (soll === null || soll === undefined) {
    expect(ist, was).toBeNull();
    return;
  }
  expect(ist, was).not.toBeNull();
  expect(dezVergleich(ist as Dez, dez(String(soll))), `${was}: soll ${soll} sein`).toBe(0);
};

const zeilen = (n: Json[]): Zeile[] =>
  n.map((z) => ({ kostenstelle: z.kostenstelle, anteil_prozent: dez(String(z.anteil_prozent)) }));

const ziele = (n: Json[]): Ziel[] =>
  n.map((z) => ({
    kostenstelle: z.kostenstelle,
    gueltig_ab: z.gueltig_ab ?? null,
    gueltig_bis: z.gueltig_bis ?? null,
  }));

const bestand = (n: Json[]): Bestandszeile[] =>
  n.map((z) => ({
    kostenstelle: z.kostenstelle,
    anteil_prozent: dez(String(z.anteil_prozent)),
    gueltig_ab: z.gueltig_ab ?? null,
    gueltig_bis: z.gueltig_bis ?? null,
    aufgehoben_am: z.aufgehoben_am ?? null,
  }));

const abschnitte = (n: Json[]): Abschnitt[] =>
  n.map((a) => ({
    gueltig_ab: a.gueltig_ab ?? null,
    gueltig_bis: a.gueltig_bis ?? null,
    zeilen: zeilen(a.zeilen),
  }));

describe('Verteilungs-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
  });

  it('Prosa und Java-Zwilling liegen, wo die Datei sie nennt', () => {
    expect(existsSync(resolve(V2, 'verteilung.md'))).toBe(true);
    expect(
      existsSync(
        resolve(
          process.cwd(),
          '../../services/api/src/main/java/com/voltpilot/api/uems/VerteilungRegeln.java',
        ),
      ),
    ).toBe(true);
  });

  it('die 100 %, die Anteilsgrenzen und die Zustandswörter stehen in der Datei', () => {
    expect(dezVergleich(dez(String(vectors.regeln.summe_prozent)), SUMME_PROZENT)).toBe(0);
    expect(vectors.regeln.anteil_min_ausschliesslich).toBe(0);
    expect(vectors.regeln.anteil_nachkommastellen).toBe(ANTEIL_NACHKOMMASTELLEN);
    expect(vectors.regeln.menge_nachkommastellen).toBe(MENGE_NACHKOMMASTELLEN);
    expect(vectors.regeln.ziel_art).toBe('kostenstelle');
    expect(vectors.vokabulare.verteilung_zustand).toEqual([VERTEILT, NICHT_VERTEILT]);
  });

  it('jede Regel ist deklariert, jede Lücke im Portal begründet', () => {
    const benutzt = new Set<string>();
    for (const fall of vectors.cases) for (const p of fall.pruefungen) benutzt.add(p.regel);
    expect(Object.keys(vectors.zwillinge).sort()).toEqual([...benutzt].sort());
    for (const [regel, wer] of Object.entries<string[]>(vectors.zwillinge)) {
      expect(wer, `Zwillinge von ${regel}`).toContain('java');
      if (!wer.includes('ts')) {
        expect(vectors.zwillinge_grund[regel], `Grund, warum ${regel} keinen TS-Zwilling hat`).toBeTruthy();
      }
    }
  });

  it('jede Abweichung und jede ungeprüfte Erwartung ist benannt', () => {
    expect(vectors._abweichungen.length).toBeGreaterThan(0);
    for (const a of vectors._abweichungen) expect(a.grund).toBeTruthy();
    expect(vectors._nicht_geprueft.length).toBeGreaterThan(0);
    for (const n of vectors._nicht_geprueft) expect(n.warum).toBeTruthy();
  });
});

describe('Verteilungs-Vertrag: die Vektoren', () => {
  const faelle: Array<[string, Json, Json]> = [];
  for (const fall of vectors.cases) {
    for (const p of fall.pruefungen) {
      if (!prueftTs(p.regel)) continue;
      faelle.push([`${fall.id} · ${p.regel} :: ${p.name}`, fall, p]);
    }
  }

  it('der Läufer ist verdrahtet (genug Prüfungen für das Portal)', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(16);
  });

  it.each(faelle)('%s', (_name, fall: Json, p: Json) => {
    const why = `${fall.id} (${fall.why})`;
    const ein = p.eingang;
    const soll = p.ergebnis;

    switch (p.regel) {
      case 'satz': {
        const ist = satz(ein.tag, ein.messstelle, zeilen(ein.zeilen), ziele(ein.ziele));
        expect(ist.gueltig, `${why} · gültig`).toBe(soll.gueltig);
        betragGleich(ist.summe, soll.summe, `${why} · Summe`);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        expect(ist.fakten, `${why} · Fakten`).toEqual(soll.fakten);
        break;
      }
      case 'am_tag': {
        const ist = amTag(ein.tag, bestand(ein.zeilen), ziele(ein.ziele));
        expect(
          ist.zeilen.map((z) => z.kostenstelle),
          `${why} · Ziele`,
        ).toEqual(soll.zeilen.map((z: Json) => z.kostenstelle));
        ist.zeilen.forEach((z, i) =>
          betragGleich(z.anteil_prozent, soll.zeilen[i].anteil_prozent, `${why} · Anteil ${z.kostenstelle}`),
        );
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        break;
      }
      case 'fassung': {
        const ist = fassung(ein.heute, bestand(ein.bestehend), ein.neu.gueltig_ab, zeilen(ein.neu.zeilen));
        expect(ist.beendet, `${why} · beendet`).toEqual(soll.beendet);
        expect(
          ist.neu.map((n) => `${n.kostenstelle}@${n.gueltig_ab}`),
          `${why} · neue Zeilen`,
        ).toEqual(soll.neu.map((n: Json) => `${n.kostenstelle}@${n.gueltig_ab}`));
        ist.neu.forEach((n, i) =>
          betragGleich(n.anteil_prozent, soll.neu[i].anteil_prozent, `${why} · Anteil ${n.kostenstelle}`),
        );
        expect(ist.rueckwirkend, `${why} · rückwirkend`).toBe(soll.rueckwirkend);
        expect(ist.tage_rueckwirkend, `${why} · Tage rückwirkend`).toBe(soll.tage_rueckwirkend);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        break;
      }
      case 'mengen': {
        const tage = ein.tage === null ? null : ein.tage.map((t: Json) => ({ tag: t.tag, menge: betrag(t.menge) }));
        const ist = mengen(ein.von, ein.bis, betrag(ein.periode_menge), tage, abschnitte(ein.verteilung));
        expect(Object.keys(ist.je_ziel).sort(), `${why} · Ziele`).toEqual(Object.keys(soll.je_ziel).sort());
        for (const [ziel, wert] of Object.entries(soll.je_ziel)) {
          betragGleich(ist.je_ziel[ziel] ?? null, wert, `${why} · Ziel ${ziel}`);
        }
        betragGleich(ist.summe, soll.summe, `${why} · Summe`);
        betragGleich(ist.nicht_verteilt, soll.nicht_verteilt, `${why} · nicht verteilt`);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        break;
      }
      case 'erbe': {
        const ist = erbe(
          {
            messstelle: ein.quelle.messstelle,
            menge: betrag(ein.quelle.menge),
            zustand: ein.quelle.zustand,
            abdeckung_prozent: ein.quelle.abdeckung_prozent,
            version: ein.quelle.version,
            kennzeichen: ein.quelle.kennzeichen,
          },
          dez(String(ein.anteil_prozent)),
          ein.fassung,
          ein.ziel,
          ein.einheit,
        );
        betragGleich(ist.menge, soll.menge, `${why} · verteilte Menge`);
        expect(ist.zustand, `${why} · Zustand`).toBe(soll.zustand);
        expect(ist.abdeckung_prozent, `${why} · Abdeckung`).toBe(soll.abdeckung_prozent);
        expect(ist.version, `${why} · Version`).toBe(soll.version);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.grund, `${why} · Grund`).toBe(soll.grund);
        break;
      }
      case 'term': {
        const ist = term(
          {
            art: ein.term.art,
            verteilung_ziel: ein.term.verteilung_ziel,
            quell_messstelle: ein.term.quell_messstelle,
            anteil: ein.term.anteil,
            faktor: betrag(ein.term.faktor),
            vorzeichen: ein.term.vorzeichen,
          },
          ein.tag,
          dez(String(ein.quelle_menge)),
          abschnitte(ein.verteilung),
        );
        betragGleich(ist.menge, soll.menge, `${why} · Menge`);
        betragGleich(ist.anteil_prozent, soll.anteil_prozent, `${why} · Anteil`);
        expect(ist.kennzeichen, `${why} · Kennzeichen`).toEqual(soll.kennzeichen);
        expect(ist.fehler, `${why} · Fehler`).toBe(soll.fehler);
        break;
      }
      default:
        throw new Error(`unbekannte Regel ${p.regel}`);
    }
  });
});
