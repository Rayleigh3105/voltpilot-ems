import { describe, expect, it } from 'vitest';
import type { Bericht, BewertungUmfang, Energieeinsatz, EnergiemanagementVerzeichnis, Kennzahl } from './api';
import type { BezugsbasisUebersicht } from './bezugsbasisUebersicht';
import { fahrplan, fahrplanSchritte, fahrplanSteht, NICHT_ABRUFBAR, WIRD_GELADEN, type FahrplanEingang, type Lage } from './fahrplan';
import { energiemanagementRoute, pageRoute } from './nav';
import type { VerbesserungUebersicht } from './verbesserungUebersicht';

/**
 * K2 (Konzept „Energiemanagement ohne Fachsprache“, D4): der Fahrplan beschreibt, was festgehalten ist — nie „0“, nie
 * „erledigt“ ohne Daten, keine Zahl über das Ganze (G4), genau eine Handlung je Schritt.
 */
const da = <T,>(wert: T): Lage<T> => ({ art: 'da', wert });
const ALLE_RECHTE = {
  standorte: [],
  unternehmen_rechte: ['energieeinsatz.ansehen', 'verbesserung.ansehen', 'energiemanagement.ansehen', 'energiemanagement.verwalten'],
};
const umfang = (fassung: number | null) => ({ fassung }) as BewertungUmfang;
const einsatz = { id: 'ee-1' } as Energieeinsatz;
const kennzahl = (archiviert_am: string | null = null) => ({ id: 'kz', archiviert_am }) as Kennzahl;
const bezugsbasen = (laufend: number) => ({ laufend }) as BezugsbasisUebersicht;
const verbesserung = (energieziele_laufend: number, massnahmen_geplant = 0) =>
  ({ zaehler: { energieziele_laufend, massnahmen_geplant } }) as VerbesserungUebersicht;
const gruppe = (g: string, wort: string, zeilen: number) => ({ gruppe: g, gruppe_wort: wort, zuschnitt: [], satz: null, zeilen: Array(zeilen).fill({}) });
const verzeichnis = (...gruppen: ReturnType<typeof gruppe>[]) => ({ gruppen }) as unknown as EnergiemanagementVerzeichnis;
const mb = (zeitraum: string, neueste_nr: number | null) =>
  ({ kennung: `BR-${zeitraum}`, vorlage: 'managementbewertung', zeitraum, archiviert_am: null, neueste_nr }) as Bericht;
const bewertungsstand = {
  kennung: 'BR-2026-0003',
  vorlage: 'energetische_bewertung',
  archiviert_am: null,
  neueste_nr: 2,
  ueberpruefung: {
    stand_nr: 2,
    stand_vom: '2026-11-17',
    faellig_am: '2027-11-17',
    ueberpruefung_faellig: false,
    faellig_seit_tagen: null,
    abgeloest_durch: null,
    verantwortliche: [],
    ohne_verantwortliche: [],
    wesentliche_einsaetze: 6,
    offene_bedarfe: 1,
  },
} as unknown as Bericht;

const leer: FahrplanEingang = {
  messendeStandorte: ['Werk Ahrenberg', 'Werk Lindach'],
  rechte: ALLE_RECHTE,
  umfang: da(umfang(null)),
  einsaetze: da([]),
  berichte: da([]),
  kennzahlen: da([]),
  bezugsbasen: da(bezugsbasen(0)),
  verbesserung: da(verbesserung(0)),
  verzeichnis: da(verzeichnis(gruppe('grundlagen', 'Grundlagen', 0), gruppe('audits_feststellungen', 'Audits und Feststellungen', 0))),
};

describe('K2 · der Fahrplan „Ihr Energiemanagement“', () => {
  it('sechs Schritte in der Reihenfolge des Aufbaus — je ein Satz und genau eine Handlung', () => {
    const s = fahrplan(leer);
    expect(s.map((x) => x.titel)).toEqual([
      'Messen einrichten',
      'Energieeinsätze bewerten',
      'Kennzahlen mit Vergleichszeitraum',
      'Ziele und Maßnahmen',
      'Nachweise führen',
      'Jährlicher Rückblick',
    ]);
    expect(s.map((x) => x.stand)).toEqual([
      'Gemessen wird an: Werk Ahrenberg, Werk Lindach.',
      'Der Umfang ist noch nicht festgelegt.',
      'Noch keine Kennzahl.',
      'Noch kein laufendes Energieziel.',
      'Hier ist noch nichts festgehalten.',
      'Noch keine Managementbewertung angelegt.',
    ]);
    expect(s.map((x) => x.handlung.text)).toEqual([
      'Messstellen ansehen',
      'Umfang festlegen',
      'Kennzahl anlegen',
      'Energieziel setzen',
      'Energiepolitik und Anwendungsbereich festhalten',
      'Zur Managementbewertung',
    ]);
    expect(s.map((x) => x.festgehalten)).toEqual([true, false, false, false, false, false]);
    expect(fahrplanSteht(s)).toBe(false);
  });

  it('keine Zahl über das Ganze, kein Urteil: kein Satz nennt „von 6“, „erledigt“, „vollständig“ oder ein Norm-Wort', () => {
    const texte = fahrplan(leer).flatMap((x) => [x.titel, x.stand, x.handlung.text]);
    for (const t of texte) expect(t).not.toMatch(/von\s+\d|erledigt|vollständig|konform|ISO|Norm/i);
  });

  it('Regel 1: was nicht abrufbar ist, heißt „Nicht abrufbar.“ — was lädt, ist unbekannt; beides steht nie', () => {
    const s = fahrplan({ ...leer, kennzahlen: { art: 'fehler' }, verzeichnis: { art: 'laedt' } });
    const kz = s.find((x) => x.key === 'kennzahlen')!;
    expect(kz.stand).toBe(NICHT_ABRUFBAR);
    expect(kz.festgehalten).toBeNull();
    expect(kz.handlung).toEqual({ text: 'Zu den Kennzahlen', ziel: pageRoute('portfolio-kennzahlen') });
    const nw = s.find((x) => x.key === 'nachweise')!;
    expect(nw.stand).toBe(WIRD_GELADEN);
    expect(nw.festgehalten).toBeNull();
    // Ein unbekannter Schritt steht nie — auch wenn alle anderen stehen.
    expect(fahrplanSteht(s.map((x) => (x.festgehalten === null ? x : { ...x, festgehalten: true })))).toBe(false);
    expect(fahrplanSteht([])).toBe(false);
  });

  it('D4: stehen alle Schritte, steht der Fahrplan — dann bleibt nur „Was steht an“', () => {
    const voll: FahrplanEingang = {
      ...leer,
      umfang: da(umfang(1)),
      einsaetze: da([einsatz]),
      berichte: da([bewertungsstand, mb('2026', 1)]),
      kennzahlen: da([kennzahl(), kennzahl('2026-01-01')]),
      bezugsbasen: da(bezugsbasen(1)),
      verbesserung: da(verbesserung(2, 3)),
      verzeichnis: da(verzeichnis(gruppe('grundlagen', 'Grundlagen', 2), gruppe('audits_feststellungen', 'Audits und Feststellungen', 1))),
    };
    const s = fahrplan(voll);
    expect(s.map((x) => x.stand)).toEqual([
      'Gemessen wird an: Werk Ahrenberg, Werk Lindach.',
      'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig am 17.11.2027.',
      '1 Kennzahl · 1 laufende Bezugsbasis.',
      '2 laufende Energieziele · 3 Maßnahmen geplant.',
      'Festgehalten in: Grundlagen, Audits und Feststellungen.',
      'Managementbewertung 2026: Stand Nr. 1 freigegeben.',
    ]);
    expect(fahrplanSteht(s)).toBe(true);
  });

  it('Zwischenstände nennen den nächsten Schritt: Bezugsbasis, Energieeinsatz, Stand der Bewertung, Verzeichnis-Weg', () => {
    const s = fahrplan({
      ...leer,
      umfang: da(umfang(1)),
      einsaetze: da([einsatz, einsatz]),
      kennzahlen: da([kennzahl()]),
      berichte: da([mb('2026', null)]),
      verzeichnis: da(verzeichnis(gruppe('grundlagen', 'Grundlagen', 1), gruppe('audits_feststellungen', 'Audits und Feststellungen', 0))),
    });
    const bei = (k: string) => s.find((x) => x.key === k)!;
    expect(bei('bewerten').stand).toBe('2 Energieeinsätze angelegt, noch kein freigegebener Stand der energetischen Bewertung.');
    expect(bei('bewerten').handlung.text).toBe('Zur energetischen Bewertung');
    expect(bei('kennzahlen')).toMatchObject({ stand: '1 Kennzahl, noch ohne Bezugsbasis.', festgehalten: false });
    expect(bei('kennzahlen').handlung.text).toBe('Bezugsbasis festlegen');
    expect(bei('nachweise')).toMatchObject({ stand: 'Festgehalten in: Grundlagen.', festgehalten: false });
    expect(bei('nachweise').handlung).toEqual({ text: 'Zum Auditprogramm', ziel: energiemanagementRoute('audits') });
    expect(bei('rueckblick').stand).toBe('Managementbewertung 2026: noch kein Stand freigegeben.');
  });

  it('ein Schritt ohne das Recht auf seinen Bereich entfällt — keine Sackgasse', () => {
    expect(fahrplanSchritte({ standorte: [], unternehmen_rechte: [] })).toEqual(['messen', 'kennzahlen']);
    expect(fahrplanSchritte(ALLE_RECHTE)).toEqual(['messen', 'bewerten', 'kennzahlen', 'ziele', 'nachweise', 'rueckblick']);
    const nurLesen = { standorte: [], unternehmen_rechte: ['energiemanagement.ansehen'] };
    const s = fahrplan({ ...leer, rechte: nurLesen });
    expect(s.map((x) => x.key)).toEqual(['messen', 'kennzahlen', 'nachweise', 'rueckblick']);
    // Wer nur liest, bekommt keinen Schritt, der Schreiben verspricht: der Weg führt ins Verzeichnis.
    expect(s.find((x) => x.key === 'nachweise')!.handlung.text).toBe('Zum Auditprogramm');
  });
});
