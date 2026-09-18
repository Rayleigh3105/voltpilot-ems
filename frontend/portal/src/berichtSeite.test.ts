import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  abschnitte,
  abzugAus,
  AUSGABE_EINGEHAENGT,
  ausgabeKnoepfe,
  darfNachLesen,
  heuteAnfrage,
  heutigerWert,
  KEIN_STAND,
  KEINE_KENNZAHLEN,
  KEIN_TAGESVERLAUF,
  LADEFEHLER,
  listenFehler,
  listenKarte,
  seitenKopf,
  standWahl,
  verlaufDerStaende,
  type Abschnitt,
  type Ansicht,
  type QuellenZahl,
} from './berichtSeite';
import {
  ABZUG_NR1,
  ABZUG_NR2,
  berichtAm,
  detailAm,
  entwurfAm,
  heutigeWerteAm,
  nameHeuteAm,
  PRUEFSUMME,
  standAm,
  UMBENENNUNG,
  ZEIT,
} from './test/berichtFixtures';
import abzuegeKopie from './test/berichtAbzuege.json';
import * as B from './uemsBericht';

/**
 * Die Welt „Berichte“ (UEMS AP-12 IP-13) gegen die EINE Vektor-Datei `docs/contracts/v2/bericht-vectors.json`:
 * B1 Nr. 1 und Nr. 2 (die Plan-Abnahme), B10 („heute: …“) und B16 (nach den Fristen) — jede Zahl, jeder Kopf und
 * jeder Vermerk ist der erwartete Wert einer Prüfung dort, nicht eine hier gedachte Zahl.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
type Json = any;
const vektoren: Json = JSON.parse(readFileSync(resolve(V2, 'bericht-vectors.json'), 'utf8'));
const fall = (id: string): Json => vektoren.cases.find((c: Json) => c.id === id);
const pruefung = (id: string, regel: string, pred: (p: Json) => boolean = () => true): Json => {
  const p = fall(id).pruefungen.find((x: Json) => x.regel === regel && pred(x));
  if (!p) throw new Error(`${id}: keine Prüfung ${regel}`);
  return p;
};

/** Geschütztes Leerzeichen (U+00A0) — so steht die Einheit hinter der Zahl (`uemsErgebnis`). */
const NB = String.fromCharCode(160);
const nb = (text: string): string => text.replace(/ (kWh|Stück|m²|%)/g, `${NB}$1`);
const RW = '<schema_version zur Bildung>';

const AM_13_11 = Date.parse('2026-11-13T09:00:00+01:00');
const AM_20_11 = Date.parse('2026-11-20T09:00:00+01:00');
const AM_03_12 = Date.parse('2026-12-03T09:00:00+01:00');
const AM_2036 = Date.parse('2036-11-02T10:00:00+01:00');

const stand = (nr: number, jetzt: number): Ansicht => ({ art: 'stand', stand: standAm(nr, jetzt) });
const teil = <A extends Abschnitt['art']>(liste: Abschnitt[], art: A): Extract<Abschnitt, { art: A }> => {
  const a = liste.find((x) => x.art === art);
  if (!a) throw new Error(`kein Abschnitt ${art}`);
  return a as Extract<Abschnitt, { art: A }>;
};
const zeile = (zeilen: QuellenZahl[], schluessel: string): QuellenZahl => {
  const z = zeilen.find((x) => x.schluessel === schluessel);
  if (!z) throw new Error(`keine Zeile ${schluessel}`);
  return z;
};

describe('die Fixtures SIND die Vektoren', () => {
  it('die Abzüge Nr. 1 und Nr. 2 sind byte-gleich zu `abzuege` — und haben die Prüfsummen der Prüfung `kanonisch`', () => {
    for (const [schluessel, nr] of [['BR-2026-0001/1', 1], ['BR-2026-0001/2', 2]] as const) {
      const text = B.kanonisch((abzuegeKopie as Json)[schluessel]);
      expect(text).toBe(B.kanonisch(vektoren.abzuege[schluessel]));
      const erwartet = pruefung('B1', 'kanonisch', (p) => p.eingang.abzug === schluessel).ergebnis;
      expect(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`).toBe(erwartet.pruefsumme);
      expect(PRUEFSUMME[nr]).toBe(erwartet.pruefsumme);
    }
    expect(B.kanonisch(ABZUG_NR1)).toBe(B.kanonisch(vektoren.abzuege['BR-2026-0001/1']));
    expect(B.kanonisch(ABZUG_NR2)).toBe(B.kanonisch(vektoren.abzuege['BR-2026-0001/2']));
  });

  it('die Zeitpunkte sind die der Referenzdatei 1.4 (berichte[], korrekturen[])', () => {
    const ref: Json = JSON.parse(readFileSync(resolve(V2, 'uems-referenzunternehmen.json'), 'utf8'));
    const br = ref.berichte.find((b: Json) => b.kennung === 'BR-2026-0001');
    const [nr1, nr2] = br.staende;
    expect(Date.parse(ZEIT.angelegt)).toBe(Date.parse(nr1.datenstand));
    expect(Date.parse(ZEIT.nr1)).toBe(Date.parse(nr1.freigegeben_am));
    expect(Date.parse(ZEIT.korrektur)).toBe(Date.parse(nr2.datenstand));
    expect(Date.parse(ZEIT.nr2)).toBe(Date.parse(nr2.freigegeben_am));
    expect(Date.parse(ZEIT.korrektur)).toBe(Date.parse(ref.korrekturen.find((k: Json) => k.kennung === 'K-2026-0007').freigegeben_am));
  });
});

describe('B1 Nr. 1 — der Berichtsstand vom 10.11.2026, gelesen am 20.11.2026', () => {
  const detail = detailAm(AM_20_11);
  const ansicht = stand(1, AM_20_11);
  const { abschnitte: liste, ohneInhalt } = abschnitte(abzugAus(ansicht.art === 'stand' ? ansicht.stand.abzug : {}));

  it('Kopf (D5): Datenstand und Freigabe erzählen zwei Dinge — wörtlich die Prüfung `kopf`; Nr. 1 ist ersetzt', () => {
    const k = seitenKopf(detail, ansicht, AM_20_11);
    expect(k.zeile).toBe(pruefung('B1', 'kopf', (p) => p.eingang.stand.nr === 1).ergebnis.text);
    expect(k.titel).toBe('Monatsbericht Werk Ahrenberg Oktober 2026');
    expect(k.vorlage).toBe('Monatsbericht Standort · Fassung 1');
    expect(k.pruefsumme).toBe(PRUEFSUMME[1]);
    expect(k.abzeichen.map((a) => a.text)).toEqual([pruefung('B1', 'kennzeichen', (p) => p.eingang.schluessel === 'ersetzt_durch').ergebnis.text]);
  });

  it('die Abschnitte folgen der Vorlage; der Tagesverlauf 1.2 erscheint, seine leeren Listen bleiben sichtbare Lücken', () => {
    expect(liste.map((a) => a.titel)).toEqual(['Kopf', 'Zusammenfassung', 'Verbrauch je Messstelle', 'Tagesverlauf je Messstelle', 'Kennzahlen', 'Qualität', 'Quellenverzeichnis']);
    expect(ohneInhalt).toEqual([]);
    const tagesverlauf = teil(liste, 'tagesverlauf');
    expect(tagesverlauf.zeilen).toHaveLength(16);
    expect(tagesverlauf.zeilen.every((z) => z.tage.length === 0 && z.leer === KEIN_TAGESVERLAUF)).toBe(true);
    expect(teil(liste, 'kopf').anzahl).toBe('8 Angaben');
    expect(teil(liste, 'kopf').zeilen.map((z) => z.name)).toEqual([
      'Unternehmen', 'Standort', 'Zeitraum', 'Vormonat September 2026', 'Vorjahresmonat Oktober 2025', 'Datenstand', 'Darstellung', 'Regelwerk',
    ]);
  });

  it('MS-12 Oktober: 6.100 kWh (DA1, Prüfung `anzeige`), vollständig, Version 1, kein Kennzeichen — Nachweis in der Form der Karte', () => {
    const ms = teil(liste, 'messstellen');
    const ms12 = zeile(ms.zeilen, 'MS-12');
    const anzeige = pruefung('B1', 'anzeige', (p) => p.eingang.art === 'menge' && p.eingang.wert === '6100').ergebnis.text;
    expect(ms12.zahl).toBe(anzeige);
    expect([ms12.name, ms12.zustand, ms12.version, ms12.kennzeichenSaetze]).toEqual(['Montage Linie M1', 'vollständig', 'Version 1', []]);
    expect(ms12.nachweis.karte).toMatchObject({ titel: 'Oktober 2026', fassung: 'endgültig', zahl: anzeige, zustand: 'vollständig', abdeckung: nb('Verlauf 100 %') });
    expect(ms12.nachweis.herkunft).toEqual([
      'Ort zum Datenstand B-3',
      'Version 1 · endgültig ab 08.11.2026 · gerechnet 01.11.2026 00:20',
      `Regelwerk verbrauch ${RW}`,
    ]);
    expect(ms12.heute).toBeNull();
  });

  it('MS-15 trägt Formel und Formel-Fassung; MS-04 steht als ein Richtungspaar „Laden / Entladen“ beieinander', () => {
    const ms = teil(liste, 'messstellen');
    const ms15 = zeile(ms.zeilen, 'MS-15');
    expect([ms15.zahl, ms15.kennzeichenSaetze]).toEqual([nb('3.800 kWh'), ['berechnet']]);
    expect(ms15.nachweis.herkunft.slice(-2)).toEqual(['Berechnung MS-10 − MS-11 − MS-12 − MS-13 − MS-14 · Fassung 1', `Regelwerk bilanz ${RW}`]);
    expect([zeile(ms.zeilen, 'MS-04/laden').zahl, zeile(ms.zeilen, 'MS-04/entladen').zahl]).toEqual([nb('7.900 kWh'), nb('7.100 kWh')]);
    const paar = ms.gruppen.find((g) => g.kennzeichen === 'MS-04')!;
    expect([paar.name, paar.richtungspaar, paar.fehlt, paar.zeilen.map((z) => z.name)]).toEqual([
      'Speicher Halle 1', true, null, ['Laden', 'Entladen'],
    ]);
    expect(zeile(ms.zeilen, 'MS-04/laden').messstelle).toBeNull();
    expect(ms.zeilen).toHaveLength(16);
    expect(ms.vergleiche).toEqual([
      'Vormonat September 2026: keine Werte — vor Beginn (Energiemanagement seit 01.10.2026)',
      'Vorjahresmonat Oktober 2025: keine Werte — vor Beginn',
    ]);
  });

  it('KZ-0001 0,15 kWh je Stück und KZ-0005 11,90 kWh je m² (Prüfung `anzeige`) mit Eingängen und Fassung der Berechnung', () => {
    const kz = teil(liste, 'kennzahlen');
    expect(kz.leer).toBeNull();
    const kz1 = zeile(kz.zeilen, 'KZ-0001');
    expect(kz1.zahl).toBe(pruefung('B1', 'anzeige', (p) => p.eingang.wert === '0.1488').ergebnis.text);
    expect(zeile(kz.zeilen, 'KZ-0005').zahl).toBe(pruefung('B1', 'anzeige', (p) => p.eingang.wert === '11.9032').ergebnis.text);
    expect(kz1.nachweis.herkunft).toEqual([
      'Ort zum Datenstand G-2',
      nb('MS-12 6.100 kWh (Version 1)'),
      nb('BZ-6 41.000 Stück (Fassung 1)'),
      'Berechnung Fassung 1 · endgültig ab 08.11.2026 · gerechnet 01.11.2026 00:20',
      `Regelwerk kennzahl ${RW}`,
    ]);
    expect(zeile(kz.zeilen, 'KZ-0005').nachweis.herkunft[2]).toBe(nb('BZ-4 (G-2) 3.100 m² (Stichtag 31.10.2026)'));
  });

  it('Zusammenfassung, Qualität und Quellenverzeichnis sprechen den Abzug', () => {
    const z = teil(liste, 'zusammenfassung');
    expect(z.kacheln.map((k) => `${k.name} ${k.wert}`)).toEqual(
      ['Netzbezug 165.300 kWh', 'Einspeisung 3.120 kWh', 'PV-Erzeugung 14.900 kWh', 'Speicher laden 7.900 kWh', 'Speicher entladen 7.100 kWh'].map(nb),
    );
    expect(z.zaehlung).toBe('16 Werte · davon 16 endgültig · 16 vollständig');
    const q = teil(liste, 'qualitaet');
    expect(q.zeilen.map((x) => x.wert)).toEqual([nb('100 %'), '0', '0', '0', '0']);
    expect(q.korrekturen).toEqual([]);
    const quellen = teil(liste, 'quellen');
    expect(quellen.anzahl).toBe('19 Quellen');
    expect(quellen.zeilen.map((x) => x.kennzeichen)).toEqual(vektoren.abzuege['BR-2026-0001/1'].kopf.quellenverzeichnis);
    expect(quellen.zeilen.find((x) => x.kennzeichen === 'BZ-6')?.stand).toBe('Fassung 1');
    expect(quellen.zeilen.find((x) => x.kennzeichen === 'MS-12')).toEqual({
      kennzeichen: 'MS-12',
      name: 'Montage Linie M1',
      heute: null,
      stand: 'Version 1',
      // AP-13 IP-11: der Weg zu dieser Quelle trägt den Zeitraum des Berichts und ihre Version.
      sprung: { route: expect.anything(), hash: '#/portfolio/messstellen/MS-12?periode=2026-10&version=1' },
    });
  });

  it('Verlauf der Stände: Nr. 2 mit Anlass K-2026-0007, Nr. 1 ersetzt durch Nr. 2 (16.11.2026)', () => {
    expect(verlaufDerStaende(detail)).toEqual([
      {
        nr: 2,
        titel: 'Berichtsstand Nr. 2',
        zeile: 'Datenstand 12.11.2026 10:05 · freigegeben 16.11.2026 14:20 von Ines Kaltenbach',
        anlass: `Anlass ${pruefung('B1', 'anlass').ergebnis.text}`,
        ersetzt: null,
        anstoesse: [],
      },
      {
        nr: 1,
        titel: pruefung('B1', 'kennzeichen', (p) => p.eingang.schluessel === 'berichtsstand').ergebnis.text,
        zeile: 'Datenstand 10.11.2026 08:55 · freigegeben 10.11.2026 09:02 von Ines Kaltenbach',
        anlass: null,
        ersetzt: 'ersetzt durch Nr. 2 (16.11.2026)',
        anstoesse: [],
      },
    ]);
  });
});

describe('Vertrag 1.2 — Tagesverlauf, Richtungspaar und Kennzahl-Nachweis', () => {
  it('zeigt gespeicherte Tage mit Menge und Zustand; ein nicht gespeicherter Tag wird nicht als 0 ergänzt', () => {
    const roh = structuredClone(vektoren.abzuege['BR-2026-0001/1']);
    const reihe = roh.tagesverlauf.find((r: Json) => r.quelle === 'MS-12');
    reihe.tage = [
      { tag: '2026-10-01', menge: 201.5, zustand: 'vollständig' },
      { tag: '2026-10-03', menge: null, zustand: 'keine Werte' },
    ];
    const tagesverlauf = teil(abschnitte(abzugAus(roh)).abschnitte, 'tagesverlauf');
    const ms12 = tagesverlauf.zeilen.find((z) => z.schluessel === 'MS-12')!;
    expect(ms12.tage.map((t) => [t.label, t.mengeText, t.zustand, t.ton])).toEqual([
      ['01.10.2026', nb('202 kWh'), 'vollständig', 'vollstaendig'],
      ['03.10.2026', '—', 'keine Werte', 'keine-werte'],
    ]);
    expect(ms12.tage.some((t) => t.tag === '2026-10-02')).toBe(false);
    expect(ms12.leer).toBeNull();
  });

  it('unterscheidet eine leere Tagesliste von einem alten Abzug, der das Feld noch nicht kannte', () => {
    const leer = structuredClone(vektoren.abzuege['BR-2026-0001/1']);
    const leerErgebnis = abschnitte(abzugAus(leer));
    expect(teil(leerErgebnis.abschnitte, 'tagesverlauf').zeilen[0].leer).toBe(KEIN_TAGESVERLAUF);
    const alt = structuredClone(leer);
    delete alt.tagesverlauf;
    const altErgebnis = abschnitte(abzugAus(alt));
    expect(altErgebnis.abschnitte.some((a) => a.art === 'tagesverlauf')).toBe(false);
    expect(altErgebnis.ohneInhalt).toContain('tagesverlauf');
  });

  it('nennt ein unvollständig gespeichertes Richtungspaar mit Grund und zeigt keine erfundene Null', () => {
    const roh = structuredClone(vektoren.abzuege['BR-2026-0001/1']);
    for (const w of roh.werte.filter((x: Json) => x.quelle === 'MS-04')) w.menge = null;
    const ms = teil(abschnitte(abzugAus(roh)).abschnitte, 'messstellen');
    const paar = ms.gruppen.find((g) => g.kennzeichen === 'MS-04')!;
    expect(paar.fehlt).toContain('nicht vollständig getrennt gespeichert');
    expect(paar.zeilen.map((z) => z.zahl)).toEqual(['—', '—']);
    expect(paar.zeilen.map((z) => z.zahl).join(' ')).not.toContain('0');
  });

  it('zeigt Ort und „endgültig ab“ nur, wenn die optionale Kennzahl sie im Abzug trägt', () => {
    const neu = teil(abschnitte(abzugAus(structuredClone(vektoren.abzuege['BR-2026-0001/1']))).abschnitte, 'kennzahlen').zeilen[0];
    expect(neu.nachweis.herkunft).toContain('Ort zum Datenstand G-2');
    expect(neu.nachweis.herkunft.some((h) => h.includes('endgültig ab 08.11.2026'))).toBe(true);
    const alt = structuredClone(vektoren.abzuege['BR-2026-0001/1']);
    for (const k of alt.kennzahlen) {
      delete k.ort_zum_datenstand;
      delete k.endgueltig_ab;
    }
    const vorher = teil(abschnitte(abzugAus(alt)).abschnitte, 'kennzahlen').zeilen[0];
    expect(vorher.nachweis.herkunft.some((h) => h.includes('Ort zum Datenstand') || h.includes('endgültig ab'))).toBe(false);
  });
});

describe('B1 Nr. 2 — die Revision vom 16.11.2026', () => {
  const detail = detailAm(AM_20_11);
  const ansicht = stand(2, AM_20_11);
  const { abschnitte: liste } = abschnitte(abzugAus(standAm(2, AM_20_11).abzug));

  it('Kopf wörtlich `kopf` Nr. 2; der gültige Stand trägt seinen Vermerk „Berichtsstand Nr. 2“; vorgewählt ist er', () => {
    const k = seitenKopf(detail, ansicht, AM_20_11);
    expect(k.zeile).toBe(pruefung('B1', 'kopf', (p) => p.eingang.stand.nr === 2).ergebnis.text);
    expect(k.pruefsumme).toBe(PRUEFSUMME[2]);
    expect(k.abzeichen.map((a) => a.text)).toEqual(['Berichtsstand Nr. 2']);
    expect(standWahl(detail)).toEqual({
      optionen: [{ id: 'nr-1', label: 'Nr. 1' }, { id: 'nr-2', label: 'Nr. 2' }, { id: 'entwurf', label: 'Entwurf' }],
      vorgabe: 'nr-2',
    });
  });

  it('MS-12 6.040 kWh „korrigiert (Version 2)“, MS-15 3.860 kWh, KZ-0001 Version 2 aus MS-12 Version 2; Qualität nennt K-2026-0007', () => {
    const ms = teil(liste, 'messstellen');
    const nachweis = fall('B1').nachweis;
    const ms12 = zeile(ms.zeilen, 'MS-12');
    expect([ms12.zahl, ms12.version, ms12.kennzeichenSaetze]).toEqual([nb('6.040 kWh'), 'Version 2', ['korrigiert (Version 2)']]);
    expect(ms12.nachweis.herkunft[1]).toBe('Version 2 · endgültig ab 08.11.2026 · gerechnet 12.11.2026 10:05');
    expect([zeile(ms.zeilen, 'MS-15').zahl, zeile(ms.zeilen, 'MS-15').kennzeichenSaetze]).toEqual([nb('3.860 kWh'), ['berechnet', 'korrigiert (Version 2)']]);
    const kz1 = zeile(teil(liste, 'kennzahlen').zeilen, 'KZ-0001');
    expect([kz1.version, kz1.nachweis.herkunft[1]]).toEqual(['Version 2', nb('MS-12 6.040 kWh (Version 2)')]);
    expect(teil(liste, 'qualitaet').korrekturen).toEqual([
      'Korrektur K-2026-0007 an MS-12 · freigegeben 12.11.2026 10:05 von Ines Kaltenbach (Energiemanager) · Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)',
    ]);
    // Der Nachweis der Plan-Abnahme nennt denselben Stand.
    expect(nachweis.stand.pruefsumme).toBe(PRUEFSUMME[1]);
    expect(nachweis.anstoss).toMatchObject({ kennung: 'K-2026-0007', stand: 1, zustand: 'erledigt', erledigt_durch: 2 });
  });
});

describe('Liste und Entwurf entlang der Zeitachse (R5)', () => {
  it('am 13.11.2026 steht „Revision nötig — Korrektur K-2026-0007“ (Prüfung `kennzeichen`), am 20.11. „Berichtsstand Nr. 2“', () => {
    const revision = pruefung('B1', 'kennzeichen', (p) => p.eingang.schluessel === 'revision_noetig').ergebnis.text;
    expect(listenKarte(berichtAm(AM_13_11))).toEqual({
      kennung: 'BR-2026-0001',
      titel: 'Monatsbericht Werk Ahrenberg Oktober 2026',
      unter: 'Monatsbericht Standort · Fassung 1',
      stand: revision,
      standTon: 'warn',
      archiviert: null,
    });
    expect(listenKarte(berichtAm(AM_20_11)).stand).toBe('Berichtsstand Nr. 2');
    // Der offene Anstoß steht am 13.11. am gültigen Stand Nr. 1 und im Verlauf.
    const detail = detailAm(AM_13_11);
    expect(seitenKopf(detail, stand(1, AM_13_11), AM_13_11).abzeichen).toEqual([{ text: revision, ton: 'warn' }]);
    expect(verlaufDerStaende(detail)[0].anstoesse).toEqual([revision]);
  });

  it('der Entwurf spricht „Entwurf · Datenstand …“; vor dem ersten Stand „noch kein Berichtsstand“, im Oktober „Zeitraum läuft“', () => {
    const vorFreigabe = Date.parse('2026-11-10T09:00:00+01:00');
    const k = seitenKopf(detailAm(vorFreigabe), { art: 'entwurf', entwurf: entwurfAm(vorFreigabe) }, vorFreigabe);
    expect(k.zeile).toBe('Entwurf · Datenstand 10.11.2026 08:55 (MEZ)');
    expect(k.abzeichen.map((a) => a.text)).toEqual([KEIN_STAND]);
    expect(k.pruefsumme).toBeNull();
    const imOktober = Date.parse('2026-10-20T10:00:00+02:00');
    expect(seitenKopf(detailAm(vorFreigabe), { art: 'entwurf', entwurf: entwurfAm(vorFreigabe) }, imOktober).abzeichen.map((a) => a.text)).toEqual([
      KEIN_STAND,
      B.ZEITRAUM_LAEUFT,
    ]);
    expect(standWahl(detailAm(vorFreigabe)).vorgabe).toBe('entwurf');
  });

  it('eine 403 der Liste spricht den Satz der Route, ohne „Erneut versuchen“; sonst der Ladefehler', () => {
    const satz = 'Berichte und Exporte stehen der Unterstützung nicht zur Verfügung.';
    expect(listenFehler(new ApiError(403, satz, { code: 'recht_fehlt', message: satz }))).toEqual({ satz, erneut: false });
    expect(listenFehler(new Error('weg'))).toEqual({ satz: LADEFEHLER, erneut: true });
  });

  it('ein Abzug ohne Kennzahlen sagt „Keine Kennzahlen definiert“; ohne Speicher-Schlüssel keine Speicher-Kachel (unbekannt ist keine Null)', () => {
    const roh = structuredClone(vektoren.abzuege['BR-2026-0001/1']);
    roh.kennzahlen = [];
    delete roh.zusammenfassung.speicher_laden_kwh;
    delete roh.zusammenfassung.speicher_entladen_kwh;
    const liste = abschnitte(abzugAus(roh)).abschnitte;
    expect(teil(liste, 'kennzahlen')).toMatchObject({ leer: KEINE_KENNZAHLEN, zeilen: [] });
    expect(teil(liste, 'zusammenfassung').kacheln.map((k) => k.name)).toEqual(['Netzbezug', 'Einspeisung', 'PV-Erzeugung']);
  });
});

describe('B10 — „heute: …“ (A5) und B16 — nach den Fristen', () => {
  it('am 03.12.2026 heißt MS-12 heute anders: Nr. 2 nennt den Namen zum Datenstand und den Hinweis wörtlich aus B10', () => {
    const erwartet = pruefung('B10', 'kennzeichen', (p) => p.eingang.name_heute === UMBENENNUNG.heute).ergebnis.text;
    const gleich = pruefung('B10', 'kennzeichen', (p) => p.eingang.name_heute === p.eingang.name_zum_datenstand).ergebnis.text;
    const heuteName = (k: string) => nameHeuteAm(AM_03_12, k, k === 'MS-12' ? UMBENENNUNG.vorher : null);
    const liste = abschnitte(abzugAus(standAm(2, AM_03_12).abzug), heuteName).abschnitte;
    const ms12 = zeile(teil(liste, 'messstellen').zeilen, 'MS-12');
    expect([ms12.name, ms12.heute]).toEqual([UMBENENNUNG.vorher, erwartet]);
    expect(teil(liste, 'quellen').zeilen.find((x) => x.kennzeichen === 'MS-12')?.heute).toBe(erwartet);
    // Vor der Umbenennung (und bei gleichem Namen) kein Hinweis.
    const vorher = abschnitte(abzugAus(standAm(2, AM_20_11).abzug), (k) => nameHeuteAm(AM_20_11, k, k === 'MS-12' ? UMBENENNUNG.vorher : null));
    expect(zeile(teil(vorher.abschnitte, 'messstellen').zeilen, 'MS-12').heute).toBe(gleich);
  });

  it('„heutigen Wert zeigen“ am 20.11.2026: MS-12 heute 6.040 kWh in Version 2 — Nr. 1 bleibt, wie er ist', () => {
    const b = berichtAm(AM_20_11);
    expect(heuteAnfrage(b)).toEqual({ raster: 'monat', von: '2026-10-01', bis: '2026-10-31' });
    expect(heutigerWert({ antwort: heutigeWerteAm('MS-12', AM_20_11) }, b, standAm(1, AM_20_11))).toEqual({
      art: 'wert',
      text: nb('heute: 6.040 kWh · vollständig · Version 2 · korrigiert (Version 2)'),
    });
  });

  it('am 02.11.2036 (B16): die Route antwortet 404 `wert_nicht_mehr_gespeichert` — der Satz verweist auf Nr. 1, wörtlich die Prüfung `satz`', () => {
    const b = berichtAm(AM_2036);
    const nr1 = standAm(1, AM_2036);
    let fehler: unknown = null;
    try {
      heutigeWerteAm('MS-12', AM_2036);
    } catch (e) {
      fehler = e;
    }
    const erwartet = pruefung('B16', 'satz', (p) => p.eingang.code === 'wert_nicht_mehr_gespeichert' && p.eingang.werte.stand !== null);
    expect(erwartet.eingang.werte.stand).toEqual({ nr: 1, freigegeben_am: '2026-11-10T09:02:00+01:00' });
    expect(Date.parse(nr1.freigegeben_am)).toBe(Date.parse(erwartet.eingang.werte.stand.freigegeben_am));
    expect(heutigerWert({ fehler }, b, nr1)).toEqual({ art: 'nicht_gespeichert', text: erwartet.ergebnis.kundensatz });
    // Nr. 1 erklärt trotzdem alles: derselbe Abzug, dieselbe Prüfsumme wie am 10.11.2026.
    expect(pruefung('B16', 'kanonisch').ergebnis.pruefsumme).toBe(nr1.pruefsumme);
    expect(zeile(teil(abschnitte(abzugAus(nr1.abzug)).abschnitte, 'messstellen').zeilen, 'MS-12').zahl).toBe(nb('6.100 kWh'));
    // Eine andere Ablehnung ist kein „nicht mehr gespeichert“.
    expect(heutigerWert({ fehler: new ApiError(500, 'weg') }, b, nr1).art).toBe('fehler');
  });
});

/**
 * UEMS AP-13 IP-11 (K4, O10 Schritt 6): „Vom Bericht aus derselbe Weg“ — der Nachweis führt auf die Seite
 * seines Objekts, im ZEITRAUM DES BERICHTS. Ein Sprung ohne Periode zeigte die heutige Zahl statt der, die
 * im Stand steht.
 */
describe('AP-13 IP-11 — vom Nachweis zur Zahl (K4, O10)', () => {
  const liste = abschnitte(abzugAus(stand(1, AM_20_11).stand.abzug)).abschnitte;

  it('MS-12 im Bericht springt auf die Messstellen-Seite mit der Periode des Berichts (Oktober 2026)', () => {
    const ms12 = zeile(teil(liste, 'messstellen').zeilen, 'MS-12');
    expect(ms12.sprung?.hash).toBe('#/portfolio/messstellen/MS-12?periode=2026-10');
    expect(ms12.sprungWort).toBe('Zur Messstelle');
    // Der Weg steht NEBEN „heutigen Wert zeigen“, nicht statt dessen — die Messstelle bleibt gefragt.
    expect(ms12.messstelle).toBe('MS-12');
  });

  it('eine Kennzahl des Berichts springt auf ihre Kennzahl-Seite; ihre Eingänge auf ihre Messstellen', () => {
    const kz = teil(liste, 'kennzahlen').zeilen[0];
    expect(kz.sprung?.hash).toBe(`#/portfolio/kennzahlen/${kz.kennzeichen}`);
    expect(kz.sprungWort).toBe('Zur Kennzahl');
    const mitSprung = kz.nachweis.herkunftStuecke.flat().filter((t) => t.sprung !== null);
    expect(mitSprung.length).toBeGreaterThan(0);
    for (const t of mitSprung) expect(t.sprung?.hash).toContain('periode=2026-10');
    // Jede Zeile bleibt zeichengleich der Satz, den sie war (D1).
    expect(kz.nachweis.herkunftStuecke.map((z) => z.map((t) => t.text).join(''))).toEqual(kz.nachweis.herkunft);
  });

  it('eine Bezugsgröße im Nachweis bleibt Text — AP-09 hat keine Kundenfläche (D3)', () => {
    const kz = teil(liste, 'kennzahlen').zeilen[0];
    expect(kz.nachweis.herkunftStuecke.flat().some((t) => t.text.startsWith('BZ-') && t.sprung !== null)).toBe(false);
  });

  it('auch das Quellenverzeichnis führt zu seinen Objekten — mit dem Zeitraum des Berichts, BZ-6 nicht', () => {
    const quellen = teil(liste, 'quellen').zeilen;
    const ms = quellen.filter((q) => q.kennzeichen.startsWith('MS-'));
    expect(ms.length).toBeGreaterThan(0);
    for (const q of ms) expect(q.sprung?.hash).toMatch(/^#\/portfolio\/messstellen\/MS-\d+\?periode=2026-10(&version=\d+)?$/);
    for (const q of quellen.filter((x) => x.kennzeichen.startsWith('BZ-'))) expect(q.sprung).toBeNull();
  });

  it('eine Speicher-Mengenart hat keinen Weg — den heutigen Leseweg trennt der Bericht nicht (Folgepaket)', () => {
    const speicher = teil(liste, 'messstellen').zeilen.filter((z) => z.schluessel.includes('/'));
    for (const z of speicher) {
      expect(z.sprung).toBeNull();
      expect(z.sprungWort).toBeNull();
    }
  });
});

describe('PDF und CSV — abgeleitet, sichtbar erst mit ihrem Ziel (IP-10, IP-11)', () => {
  const b = berichtAm(AM_20_11);
  const alle = { pdf: true, csv: true } as const;

  it('heute hat keine Ausgabe ein Ziel: kein Knopf, auch nicht mit jedem Recht', () => {
    expect(AUSGABE_EINGEHAENGT).toEqual({ pdf: false, csv: false });
    expect(ausgabeKnoepfe(b, stand(1, AM_20_11), () => true)).toEqual([]);
  });

  it('eingehängt: ein Stand bekommt PDF und CSV mit den Kennungen aus G1 und den Dateinamen aus §5.4; ein Entwurf nie (EW4)', () => {
    const kennung = (h: string) => vektoren.regeln.kennung[`standort/${h}`];
    expect(ausgabeKnoepfe(b, stand(1, AM_20_11), () => true, alle)).toEqual([
      { handlung: 'pdf', text: 'PDF', recht: kennung('pdf'), datei: 'bericht-BR-2026-0001-nr1.pdf' },
      { handlung: 'csv', text: 'CSV', recht: kennung('csv'), datei: 'bericht-BR-2026-0001-nr1.csv' },
    ]);
    expect(ausgabeKnoepfe(b, { art: 'entwurf', entwurf: entwurfAm(AM_20_11) }, () => true, alle)).toEqual([]);
    expect(ausgabeKnoepfe(b, null, () => true, alle)).toEqual([]);
  });

  it('das Recht: nach dem Lesen ist `abrufen` (= PDF) sicher, `export.standort` (CSV) unbekannt — ein unbekanntes Recht zeigt keinen Knopf', () => {
    const darf = darfNachLesen(b);
    expect(darf('bericht.standort_abrufen')).toBe(true);
    expect(darf('export.standort')).toBeNull();
    expect(ausgabeKnoepfe(b, stand(2, AM_20_11), darf, alle).map((k) => k.text)).toEqual(['PDF']);
    expect(ausgabeKnoepfe(b, stand(2, AM_20_11), () => false, alle)).toEqual([]);
  });
});
