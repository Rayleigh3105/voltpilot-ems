import { KENNZEICHEN, erbe, erkenne } from './uemsKennzahl';
import { betriebszeit } from './betriebszeit';
import { gradtage } from './gradtage';
import { HERKUNFT_BEZOGEN, TEMPERATUR_BEZOGEN, VARIABLE_FEHLT, WORT_TAGE, ZONE as WETTER_ZONE, kennzeichenBezogen, wetterArchivMonat } from './wetterArchiv';
import { UEMS_TEMPERATUR_BEZOGEN } from './glossar';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import {
  ABDECKUNG_NACHKOMMASTELLEN,
  ANTEIL_NACHKOMMASTELLEN,
  ANZEIGE_ZEITZONE,
  BEGRUENDUNG_MAX_ZEICHEN,
  BEGRUENDUNG_MIN_ZEICHEN,
  HINWEIS_BEFUNDE,
  VERGLEICH_NACHKOMMASTELLEN,
  VIER_AUGEN_VORGABE,
  ZAHLFORMAT_VORGABE,
  ZUORDNUNG_HOECHSTENS_MONATE,
  dez,
  dezText,
  dezVergleich,
  einheit,
  importErgebnis,
  iso,
  periode,
  plausibilitaet,
  satz,
  stundenDesTages,
  urteil,
  zahl,
  zeitpunkt,
  zuordnung,
  type Dez,
  type Umrechnung,
} from './bezugsdaten';
import { ABLEHNUNGEN, EINGABE_SAETZE, GANZE_ZAHLEN, LESARTEN } from './bezugsgroesse';

/**
 * Die Regeln der BEZUGSDATEN (UEMS AP-09 IP-1) gegen die EINE geteilte
 * Vektor-Datei — dieselbe, die der Java-Zwilling
 * `services/api .../uems/BezugsdatenVectorsTest` fährt.
 *
 * `zwillinge` in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE
 * Regel, die dort „ts" nennt, und prüft, dass jede Regel OHNE TS-Zwilling ihren
 * Grund nennt — so bleibt keine Regel stillschweigend ungeprüft.
 *
 * Wer eine Regel ändert, ändert beide Seiten UND die Vektor-Datei.
 * vitest läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'bezugsdaten-vectors.json'));
const schema: Json = lies(resolve(V2, 'bezugsdaten.schema.json'));

const ZONE = vectors.zeitzone as string;

const prueftTs = (regel: string): boolean => (vectors.zwillinge[regel] ?? []).includes('ts');

/** Beträge werden NUMERISCH verglichen: „312400" und „312400.0" sind derselbe Betrag. */
const betragGleich = (ist: Dez | null, soll: unknown): void => {
  if (soll === null || soll === undefined) {
    expect(ist).toBeNull();
    return;
  }
  expect(ist).not.toBeNull();
  // NUMERISCH verglichen, die Meldung nennt beide Beträge im Klartext:
  // „erwartet 0, war 1" allein hilft niemandem.
  expect(
    dezVergleich(ist as Dez, dez(String(soll))),
    `Betrag ${dezText(ist as Dez)} soll ${soll} sein`,
  ).toBe(0);
};

const einheiten = (): Record<string, string[]> => vectors.einheiten as Record<string, string[]>;
const umrechnungen = (): Umrechnung[] => vectors.umrechnung as Umrechnung[];

describe('Bezugsdaten-Vertrag: Form der Vektor-Datei', () => {
  it('die Datei hält ihr Schema', () => {
    expect(schemaVerstoesse(vectors, schema)).toEqual([]);
  });

  it('die Beispielwelt ist das Referenzunternehmen', () => {
    expect(vectors.referenzunternehmen).toBe('./uems-referenzunternehmen.json');
    expect(existsSync(resolve(V2, 'uems-referenzunternehmen.json'))).toBe(true);
  });

  it('Prosa und Java-Zwilling liegen, wo die Datei sie nennt', () => {
    expect(existsSync(resolve(V2, 'bezugsdaten.md'))).toBe(true);
    expect(
      existsSync(
        resolve(
          process.cwd(),
          '../../services/api/src/main/java/com/voltpilot/api/uems/BezugsdatenRegeln.java',
        ),
      ),
    ).toBe(true);
  });

  it('14 Fälle B1–B14 mit eindeutigen Namen und je einem Zweck', () => {
    const namen = vectors.cases.map((c: Json) => c.name);
    const kennungen = vectors.cases.map((c: Json) => c.id);
    expect(namen).toHaveLength(14);
    expect(new Set(namen).size).toBe(14);
    expect(new Set(kennungen).size).toBe(14);
    expect(kennungen).toContain('B1');
    expect(kennungen).toContain('B14');
    for (const fall of vectors.cases) {
      expect(fall.why, `${fall.id} · why`).toBeTruthy();
      expect(fall.titel, `${fall.id} · titel`).toBeTruthy();
      expect(fall.schritte.length, `${fall.id} · Handrechnung`).toBeGreaterThan(0);
    }
  });

  it('beide Plan-Abnahmen haben ihren Fall', () => {
    const mit = vectors.cases.filter((c: Json) => c.abnahme !== null).map((c: Json) => `${c.id}=${c.abnahme}`);
    expect(mit.sort()).toEqual(['B2=plan-1', 'B6=plan-2']);
  });

  it('die Schwellen stehen in der Datei, nicht nur im Modul', () => {
    const r = vectors.regeln;
    expect(r.begruendung_min_zeichen).toBe(BEGRUENDUNG_MIN_ZEICHEN);
    expect(r.begruendung_max_zeichen).toBe(BEGRUENDUNG_MAX_ZEICHEN);
    expect(r.zuordnung_hoechstens_monate).toBe(ZUORDNUNG_HOECHSTENS_MONATE);
    expect(r.anteil_nachkommastellen).toBe(ANTEIL_NACHKOMMASTELLEN);
    expect(r.abdeckung_nachkommastellen).toBe(ABDECKUNG_NACHKOMMASTELLEN);
    expect(r.vergleich_nachkommastellen).toBe(VERGLEICH_NACHKOMMASTELLEN);
    expect(r.zahlformat_vorgabe).toBe(ZAHLFORMAT_VORGABE);
    expect(r.vier_augen_vorgabe).toBe(VIER_AUGEN_VORGABE);
    expect(vectors.zeitzone).toBe(ANZEIGE_ZEITZONE);
    expect(vectors.hinweis_befunde).toEqual(HINWEIS_BEFUNDE);
  });

  it('jeder Befund hat seinen Kundensatz und umgekehrt', () => {
    const befunde: string[] = vectors.vokabulare.befunde;
    expect(Object.keys(vectors.befund_saetze).sort()).toEqual([...befunde].sort());
    for (const b of befunde) expect(satz(b, vectors.befund_saetze)).toBeTruthy();
  });

  it('der geschlossene Satz der Ablehnungen des Verwaltens ist der der Datei (AP-09 IP-5)', () => {
    const datei = vectors.verwalten.ablehnungen.map(
      (a: Json) => `${a.code} · ${a.status} · ${a.satz}`,
    );
    const portal = Object.entries(ABLEHNUNGEN).map(([code, a]) => `${code} · ${a.status} · ${a.satz}`);
    expect(portal).toEqual(datei);
    expect(ABLEHNUNGEN.einheit_unbekannt.satz).toBe(vectors.befund_saetze.einheit_unbekannt);
    expect([...LESARTEN]).toEqual(vectors.verwalten.lesarten);
    // AP-09 IP-7: die Sätze nach einem Wert und der Zusatz für ganze Zahlen.
    expect(EINGABE_SAETZE).toEqual(vectors.verwalten.eingabe.urteile);
    expect(GANZE_ZAHLEN).toBe(vectors.verwalten.eingabe.ganze_zahlen);
  });

  it('jede Regel ist deklariert, und jede Lücke im Portal ist begründet', () => {
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

describe('Bezugsdaten-Vertrag: Wetter-Archiv (AP-17 E9 = C)', () => {
  it('Herkunft, Grund und Kennzeichen sprechen die Wörter der Datei, des Kennzeichen-Vokabulars und des Glossars', () => {
    const w = vectors.wetter_archiv;
    expect(HERKUNFT_BEZOGEN).toBe(w.herkunft_art);
    expect(VARIABLE_FEHLT).toBe(w.grund_ohne_zahl);
    expect(WORT_TAGE).toBe(w.wort_tage);
    expect(WETTER_ZONE).toBe(vectors.zeitzone);
    const k = KENNZEICHEN.find((x) => x.schluessel === w.kennzeichen_schluessel);
    expect(k?.muster).toBe(w.kennzeichen_muster);
    expect(k?.muster.startsWith(`${TEMPERATUR_BEZOGEN} (`)).toBe(true);
    expect(UEMS_TEMPERATUR_BEZOGEN.startsWith(`${TEMPERATUR_BEZOGEN} (`)).toBe(true);
    expect(erkenne(kennzeichenBezogen(w.quelle_zuerst, '2027-11-01T06:10:00+01:00'))?.schluessel).toBe(w.kennzeichen_schluessel);
  });
});

describe('Bezugsdaten-Vertrag: die Vektoren', () => {
  const faelle: Array<[string, Json, Json]> = [];
  for (const fall of vectors.cases) {
    for (const p of fall.pruefungen) {
      if (!prueftTs(p.regel)) continue;
      faelle.push([`${fall.id} · ${p.regel} :: ${p.name}`, fall, p]);
    }
  }

  it('der Läufer ist verdrahtet (genug Prüfungen für das Portal)', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(40);
  });

  it.each(faelle)('%s', (_name, _fall, p: Json) => {
    const ein = p.eingang;
    const soll = p.ergebnis;

    switch (p.regel) {
      case 'betriebszeit_aus_leistung': {
        const ist = betriebszeit(ein.von, ein.bis, ein.kadenz_s, ein.leistungen, ein.schwellen, ein.luecken);
        betragGleich(ist.betrag, soll.betrag);
        expect(ist.zustand).toBe(soll.zustand);
        expect(ist.abdeckung_prozent).toBe(soll.abdeckung_prozent);
        expect(ist.kennzeichen).toEqual(soll.kennzeichen);
        expect(erbe('bezugsgroesse', null, ist.kennzeichen)).toEqual(soll.kennzeichen);
        expect(erbe('kennzahl', null, ist.kennzeichen)).toEqual(soll.kennzeichen);
        break;
      }
      case 'gradtage': {
        const ist = gradtage(ein.tage, ein.raumtemperatur, ein.heizgrenze);
        betragGleich(ist.betrag, soll.betrag);
        expect(ist.zustand).toBe(soll.zustand);
        expect(ist.kennzeichen).toEqual(soll.kennzeichen);
        break;
      }
      case 'wetter_archiv': {
        const ist = wetterArchivMonat(ein.standort, ein.koordinaten, ein.monat, ein.archivtage, ein.raumtemperatur, ein.heizgrenze);
        expect(ist.abruf).toBe(soll.abruf);
        expect(ist.grund).toBe(soll.grund);
        expect(ist.satz).toBe(soll.satz);
        expect(ist.nie_geschrieben).toEqual(soll.nie_geschrieben);
        expect(ist.tage.map((t) => t.datum)).toEqual(soll.tage.map((t: Json) => t.datum));
        ist.tage.forEach((t, i) => {
          betragGleich(t.betrag, soll.tage[i].betrag);
          expect(t.zustand).toBe(soll.tage[i].zustand);
          expect(t.kennzeichen).toEqual(soll.tage[i].kennzeichen);
        });
        betragGleich(ist.monat.betrag, soll.monat.betrag);
        expect(ist.monat.zustand).toBe(soll.monat.zustand);
        expect(ist.monat.grund).toBe(soll.monat.grund);
        expect(ist.monat.kennzeichen).toEqual(soll.monat.kennzeichen);
        // R3: die Kennzahl erbt das Kennzeichen — aus der Bezugsgröße und über weitere Kennzahlen.
        expect(erbe('bezugsgroesse', null, ist.monat.kennzeichen)).toEqual(soll.monat.erbt);
        expect(erbe('kennzahl', null, soll.monat.erbt)).toEqual(soll.monat.erbt);
        break;
      }
      case 'zahl': {
        const ist = zahl(ein.text, ein.format, ein.ganzzahlig);
        betragGleich(ist.betrag, soll.betrag);
        expect(ist.befund).toBe(soll.befund);
        break;
      }
      case 'einheit': {
        const ist = einheit(
          ein.betrag === null || ein.betrag === undefined ? null : dez(ein.betrag),
          ein.geliefert ?? null,
          ein.ziel,
          einheiten(),
          umrechnungen(),
        );
        betragGleich(ist.betrag, soll.betrag);
        expect(ist.einheit).toBe(soll.einheit);
        expect(ist.befunde).toEqual(soll.befunde);
        break;
      }
      case 'periode': {
        const ist = periode(
          {
            text: ein.text ?? null,
            vonText: ein.von_text ?? null,
            bisText: ein.bis_text ?? null,
            deutung: ein.deutung,
            periodeArt: ein.periode_art,
            jetzt: ein.jetzt ? Date.parse(ein.jetzt) : null,
          },
          ZONE,
        );
        expect(ist.schluessel).toBe(soll.schluessel);
        expect(ist.von === null ? null : iso(ist.von, ZONE)).toBe(soll.von);
        expect(ist.bis === null ? null : iso(ist.bis, ZONE)).toBe(soll.bis);
        expect(ist.stunden).toBe(soll.stunden);
        expect(ist.befund).toBe(soll.befund);
        break;
      }
      case 'zeit': {
        const ist = zeitpunkt(ein.text, ein.zeitzone, ein.offset_in_datei ?? null);
        expect(ist.zeitpunkt === null ? null : iso(ist.zeitpunkt, ZONE)).toBe(soll.zeitpunkt);
        expect(ist.befund).toBe(soll.befund);
        expect(ist.varianten).toEqual(soll.varianten);
        break;
      }
      case 'stunden':
        expect(stundenDesTages(ein.tag, ZONE)).toBe(soll.stunden);
        break;
      case 'plausibilitaet':
        expect(
          plausibilitaet(
            ein.betrag === null ? null : dez(ein.betrag),
            ein.einheit,
            ein.stunden_des_tages ?? null,
            ein.einheiten_gebunden ?? 1,
          ),
        ).toBe(soll.befund);
        break;
      case 'zuordnung': {
        const ist = zuordnung(Date.parse(ein.von), Date.parse(ein.bis), ein.zeitzone);
        expect(ist.dauerMinuten).toBe(soll.dauer_minuten);
        expect(ist.dauerText).toBe(soll.dauer_text);
        expect(ist.monateBeruehrt).toBe(soll.monate_beruehrt);
        expect(ist.anteile).toHaveLength(soll.anteile.length);
        ist.anteile.forEach((a, i) => {
          expect(a.monat).toBe(soll.anteile[i].monat);
          expect(a.minuten).toBe(soll.anteile[i].minuten);
          betragGleich(a.prozent, soll.anteile[i].prozent);
        });
        expect(ist.vorgabe).toBe(soll.vorgabe);
        break;
      }
      case 'urteil': {
        const ist = urteil({
          betrag: ein.betrag === null || ein.betrag === undefined ? null : dez(ein.betrag),
          bestand:
            ein.bestand == null
              ? null
              : {
                  betrag: ein.bestand.betrag === null ? null : dez(ein.bestand.betrag),
                  fassung: ein.bestand.fassung,
                  importKennung: ein.bestand.import_kennung ?? null,
                },
          dateiFingerabdruckBekannt: ein.datei_fingerabdruck_bekannt,
          fruehererImportStatus: ein.frueherer_import_status ?? null,
          entscheidung: ein.entscheidung ?? null,
          befundeVorher: ein.befunde_vorher ?? [],
        });
        expect(ist.urteil).toBe(soll.urteil);
        expect(ist.befunde).toEqual(soll.befunde);
        break;
      }
      case 'import': {
        const ist = importErgebnis(
          ein.datenzeilen,
          ein.fingerabdruck_bekannt,
          ein.frueherer_import_status ?? null,
          (ein.zeilen ?? []).map((z: Json) => ({ urteil: z.urteil, befunde: z.befunde ?? [] })),
        );
        expect(ist.status).toBe(soll.status);
        expect(ist.zaehler).toEqual({
          zeilen: soll.zaehler.zeilen,
          neu: soll.zaehler.neu,
          wiederholung: soll.zaehler.wiederholung,
          konflikt: soll.zaehler.konflikt,
          berichtigung: soll.zaehler.berichtigung,
          uebersprungen: soll.zaehler.uebersprungen,
          abgelehnt: soll.zaehler.abgelehnt,
          mitHinweis: soll.zaehler.mit_hinweis,
        });
        expect(ist.uebernahmeMoeglich).toBe(soll.uebernahme_moeglich);
        expect(ist.importDatensatz).toBe(soll.import_datensatz);
        expect(ist.bestaetigung).toBe(soll.bestaetigung);
        expect(ist.aenderungen).toBe(soll.aenderungen);
        expect(ist.befunde).toEqual(soll.befunde);
        break;
      }
      default:
        throw new Error(`unbekannte Regel ${p.regel}`);
    }
  });
});

describe('Bezugsdaten-Vertrag: die exakte Dezimalzahl', () => {
  it('rechnet ohne Binärbruch-Fehler (der Grund für `Dez`)', () => {
    // 0,1 + 0,2 ist in Gleitkomma 0,30000000000000004 — hier nicht.
    expect(dezText(dez('0.1'))).toBe('0.1');
    expect(dezVergleich(dez('312400'), dez('312400.0'))).toBe(0);
    expect(dezVergleich(dez('312400'), dez('312400.1'))).toBe(-1);
  });

  it('312,4 t sind GENAU 312 400 kg, nicht 312 399,999…', () => {
    const ist = einheit(dez('312.4'), 't', 'kg', einheiten(), umrechnungen());
    expect(dezText(ist.betrag!)).toBe('312400');
  });
});
