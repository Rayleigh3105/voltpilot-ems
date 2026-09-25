import { describe, expect, it } from 'vitest';
import type { Bericht } from './api';
import * as M from './managementbewertung';
import { dokumentRoute, hashForRoute, kennzahlRoute, managementbewertungRoute, massnahmeRoute, pageRoute } from './nav';
import { r13Abzug } from './test/managementbewertungFixtures';
import { VOKABULARE } from './energiemanagement';
import { ART_WORT, wiedervorlageSprung } from './wiedervorlage';

/** UEMS AP-19 IP-24: das reine Bild der Managementbewertung und die Sprünge der Wiedervorlage (§5.5, §5.8, MG1–MG7, WV3). */
describe('Managementbewertung: Kopf, Stand und Eingaben (§5.8, MG2, MG7)', () => {
  const Z = 'Europe/Berlin';
  it('Kopf wörtlich aus §5.8 — mit Sitzung und Stand; ohne Sitzung nichts erfunden', () => {
    const stand = { nr: 1, freigegeben_am: '2029-02-12T13:10:00Z' };
    expect(M.kopfSatz('2028', { tag: '2029-02-12', leitung: 'Robert Falk' }, stand, Z)).toBe(
      'Managementbewertung 2028 · Sitzung am 12.02.2029 · Leitung Robert Falk · Stand Nr. 1 vom 12.02.2029, 14:10, mit Prüfsumme.',
    );
    expect(M.kopfSatz('2028', null, null, Z)).toBe('Managementbewertung 2028 · Entwurf.');
    expect(M.kopfSatz('2028', null, stand, Z)).toBe('Managementbewertung 2028 · Stand Nr. 1 vom 12.02.2029, 14:10, mit Prüfsumme.');
  });

  it('„Stand seines Tages“ wörtlich aus §5.8, in der Zone des Berichts', () => {
    expect(M.standSeinesTages('2029-02-12T13:00:00Z', Z)).toBe(
      'Dieser Stand zeigt die Eingaben vom 12.02.2029, 14:00. Was sich danach geändert hat, zeigt die nächste Managementbewertung.',
    );
    expect(M.zeitpunkt('2029-07-01T10:05:00Z', Z)).toBe('01.07.2029, 12:05');
  });

  it('Zahlen wie festgehalten, mit Richtung; Prüfsumme gekürzt', () => {
    expect(M.prozent(-2.7)).toBe('2,7 % weniger');
    expect(M.prozent(12.9)).toBe('12,9 % mehr');
    expect(M.prozent(null)).toBe('—');
    expect(M.pruefsummeKurz('sha256:3d55664a697dd1059f2f9e75065cd6df60cf5b47f7bb4b102890a48fb665f86e')).toBe('3d55…f86e');
  });

  it('R13: die Eingaben lesen, was der Abzug festhält — kein neu gerechnetes Urteil', () => {
    const a = M.abzug(r13Abzug('2029-02-12T14:00:00+01:00'));
    expect(M.energiezielErgebnis(a.energieziele![0])).toBe('verfehlt · 2,7 % weniger in 11 von 12 Monaten · festgehalten am 15.01.2029 von Ines Kaltenbach');
    expect(M.massnahmeStand(a.massnahmen![0])).toBe('Stand Nr. 1 · belegt · 2,4 % weniger · am 15.11.2028');
    expect(M.massnahmeStand(a.massnahmen![1])).toBe('Stand Nr. 1 · nicht messbar · am 20.11.2028');
    expect(M.massnahmeStand(a.massnahmen![2])).toBe('Termin 28.02.2029');
    expect(M.herkunftWort('nichtkonformitaet', 'F-2029-0001')).toBe('aus der Feststellung F-2029-0001');
    expect(M.leistungsvergleichZeile(a.energieleistung!.leistungsvergleiche[0])).toBe('12,9 % mehr als erwartet · Urteil wie festgehalten: schlechter');
    expect(M.aufgabenSatz(a)).toBe('Aufgaben im Energiemanagement: 10 laufende Zuordnungen; keine Person festgelegt für Bezugsbasen pflegen und freigeben.');
    expect(M.grundlage(a, 'risiken_chancen')).toEqual({ dokumente: [], satz: 'Hier ist noch nichts festgehalten.' });
    expect(M.dokumentZeile(M.grundlage(a, 'energiepolitik').dokumente[0])).toBe('D-0001 · Fassung 1 · entschieden von Robert Falk am 15.12.2026');
    expect(M.fristZeile(M.grundlage(a, 'energiepolitik').dokumente[0].ueberpruefung)).toBe('Überprüfung seit 64 Tagen fällig (10.12.2028)');
    expect(M.offenSatz(0, 'Abweichung', 'Abweichungen')).toBe('keine offene Abweichung');
    expect(M.offenSatz(1, 'Feststellung', 'Feststellungen')).toBe('1 offene Feststellung');
    expect(M.ABSCHNITTE.map((x) => x.key)).toEqual(Object.keys(a).filter((k) => k !== 'kopf'));
  });

  it('MG1: je Jahr, das jüngste zuerst; nur die Vorlage `managementbewertung`, archivierte fallen weg', () => {
    const b = (kennung: string, zeitraum: string, teil: Partial<Bericht> = {}) => ({ kennung, zeitraum, vorlage: 'managementbewertung', archiviert_am: null, ...teil }) as Bericht;
    const liste = M.managementbewertungen([
      b('BR-2028-0003', '2027'), b('BR-2029-0001', '2028'), b('BR-2029-0002', '2028', { vorlage: 'jahresbericht_unternehmen' }),
      b('BR-2027-0009', '2026', { archiviert_am: '2028-01-01T00:00:00Z' }),
    ]);
    expect(liste.map((x) => x.kennung)).toEqual(['BR-2029-0001', 'BR-2028-0003']);
    expect(M.listenZustand({ neueste_nr: null })).toBe('Entwurf');
    expect(M.listenZustand({ neueste_nr: 2 })).toBe('Stand Nr. 2');
    expect(M.jahreZurWahl('2029-02-05').map((j) => j.label)).toEqual(['2028', '2029 (läuft)', '2027', '2026', '2025']);
  });
});

describe('Wiedervorlage: Art-Wörter und Sprünge (WV3)', () => {
  it('jede Art des Vokabulars hat ein Wort', () => {
    expect(Object.keys(ART_WORT).sort()).toEqual([...VOKABULARE.wiedervorlage_art].sort());
  });

  it('Sprung nur zu einer Seite, die es gibt, und nur mit der Kennung der Route', () => {
    const z = (art: string, kennzeichen: string, id: string | null = null, kennzahl_id: string | null = null) =>
      ({ art, kennzeichen, id, kennzahl_id }) as Parameters<typeof wiedervorlageSprung>[0];
    expect(wiedervorlageSprung(z('dokument_ueberpruefung', 'D-0001', 'd1'))).toEqual(dokumentRoute('d1'));
    expect(wiedervorlageSprung(z('dokument_ueberpruefung', 'D-0001'))).toBeNull();
    expect(wiedervorlageSprung(z('massnahme_termin', 'M-2029-0001', 'm1'))).toEqual(massnahmeRoute('m1'));
    expect(wiedervorlageSprung(z('bezugsbasis_ueberpruefung', 'BB-0002', 'b2', 'k1'))).toEqual(kennzahlRoute('k1'));
    expect(wiedervorlageSprung(z('bewertung_ueberpruefung', 'BR-2027-0001'))).toEqual(pageRoute('portfolio-bewertung'));
    expect(hashForRoute(wiedervorlageSprung(z('bericht_anstoss', 'BR-2028-0001'))!)).toBe('#/portfolio/berichte/BR-2028-0001');
    expect(wiedervorlageSprung(z('managementbewertung', 'BR-2029-0001'))).toEqual(managementbewertungRoute('BR-2029-0001'));
    expect(wiedervorlageSprung(z('messbedarf_frist', 'MB-1', 'mb1'))).toBeNull();
  });
});

describe('Nächste Managementbewertung (MG7, Folge IP-24)', () => {
  const leer = { faellig: [], vorschau: [], nicht_in_liste: [], vorschau_tage: 30 };
  const liste = [{ kennung: 'BR-2029-0001', neueste_nr: 1 }];
  const r13 = { faellig_am: '2030-02-12', kennzeichen: 'BR-2029-0001', sitzung_am: '2029-02-12', rhythmus_monate: 12 };

  it('außerhalb des Vorschau-Fensters: Tag und Herkunft aus dem Feld der Route, nichts selbst gerechnet', () => {
    expect(M.naechsteSatz({ ...leer, nicht_in_liste: ['BR-2029-0001'], naechste_managementbewertung: r13 }, liste)).toBe(
      'Nächste Managementbewertung fällig am 12.02.2030 (Sitzung von BR-2029-0001 am 12.02.2029 + 12 Monate).',
    );
  });

  it('im Fenster kommt der Satz der Zeile dazu; ein Monat heißt „Monat“', () => {
    const zeile = { art: 'managementbewertung', kennzeichen: 'BR-2029-0001', faellig_am: '2029-03-12', satz: 'fällig in 16 Tagen' };
    const monat = { ...r13, faellig_am: '2029-03-12', rhythmus_monate: 1 };
    expect(M.naechsteSatz({ ...leer, vorschau: [zeile], naechste_managementbewertung: monat }, liste)).toBe(
      'Nächste Managementbewertung fällig am 12.03.2029 — fällig in 16 Tagen (Sitzung von BR-2029-0001 am 12.02.2029 + 1 Monat).',
    );
  });

  it('ohne freigegebene Managementbewertung bleibt der heutige Satz', () => {
    expect(M.naechsteSatz({ ...leer, naechste_managementbewertung: null }, [])).toBe(
      'Ohne freigegebene Managementbewertung mit Sitzung nennt VoltPilot keine nächste.',
    );
  });
});
