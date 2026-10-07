import { describe, expect, it } from 'vitest';
import type { EnergiemanagementVerzeichnis } from './api';
import { letzterTag, namensTeile } from './components/nachweisen/EinsichtBlatt';
import { VOKABULARE, WOERTER } from './energiemanagement';
import { ebenenAktiv, istDetailseite } from './ebenenNav';
import * as P from './mappeBild';
import { hashForRoute, mappeRoute, parseRoute } from './nav';

const zeile = (gruppe: string, tag: string | null) =>
  ({ gruppe, art: 'x', kennzeichen: 'K', titel: 't', nr: null, entschieden_von: null, eingetragen_von: null, tag, pruefsumme: null,
    ort: 'in_voltpilot', gruppe_wort: gruppe, ort_satz: '' }) as EnergiemanagementVerzeichnis['gruppen'][number]['zeilen'][number];
const gruppe = (g: string, tage: (string | null)[]) => ({ gruppe: g, gruppe_wort: g, zuschnitt: [], satz: null, zeilen: tage.map((t) => zeile(g, t)) });

describe('Unterlagen zusammenstellen (Konzept Nachweisen n1, Entscheid 7)', () => {
  it('„Wofür?“ in der Folge des Vertrags (1.6), mit dem Wort des Vertrags und dem Vorlauf', () => {
    expect(P.anlassOptionen().map((o) => o.wert)).toEqual(VOKABULARE.mappe_anlass);
    expect(P.anlassOptionen().map((o) => o.titel)).toEqual(VOKABULARE.mappe_anlass.map((a) => WOERTER.mappe_anlass[a]));
    expect(P.anlassOptionen().map((o) => o.zusatz)).toEqual(['meist 6 Wochen vorher', 'oft 4 Wochen Frist', null]);
  });

  it('der Zeitraum zählt ab dem Tag der Route: 12 Monate bis 30.04.2029 beginnen am 01.05.2028, auch über den Schalttag', () => {
    expect(P.vonFuer('zwoelf_monate', '2029-04-30', null)).toBe('2028-05-01');
    expect(P.vonFuer('drei_jahre', '2029-04-30', null)).toBe('2026-05-01');
    // Schalttag: die zwölf Monate bis zum 29.02.2028 beginnen am 01.03.2027, die drei Jahre am 01.03.2025.
    expect(P.vonFuer('zwoelf_monate', '2028-02-29', null)).toBe('2027-03-01');
    expect(P.vonFuer('drei_jahre', '2028-02-29', null)).toBe('2025-03-01');
    expect(P.vonFuer('zwoelf_monate', '2029-02-28', null)).toBe('2028-02-29');
    expect(P.vonFuer('zwoelf_monate', '2029-12-31', null)).toBe('2029-01-01');
    expect(P.vonFuer('alles', '2029-04-30', null)).toBeNull();
    expect(P.vonFuer('ab_tag', '2029-04-30', '2029-01-15')).toBe('2029-01-15');
    expect(P.zeitraumKurz('2028-05-01')).toBe('seit 01.05.2028');
    expect(P.zeitraumKurz(null)).toBe('alles');
  });

  it('die vier Bündel decken jede Gruppe des Verzeichnisses genau einmal ab', () => {
    const alle = P.BUENDEL.flatMap((b) => b.gruppen);
    expect([...alle].sort()).toEqual([...VOKABULARE.verzeichnis_gruppe].sort());
    expect(new Set(alle).size).toBe(alle.length);
    expect(P.gruppenAus(['berichte', 'grundlagen'])).toEqual(['grundlagen', 'verantwortung', 'risiken_chancen',
      'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung', 'berichte']);
    // Sprach-Wächter SP3: „Bewertung“ steht nie allein.
    expect(P.BUENDEL.map((b) => b.titel).join(' ')).not.toMatch(/(?<!Energetische )Bewertung/u);
  });

  it('zählt die Einträge eines Bündels im Zeitraum, beide Ränder eingeschlossen, ohne Tag nie', () => {
    const v = { gruppen: [gruppe('grundlagen', ['2028-04-30', '2028-05-01', '2029-04-30', '2029-05-01', null]), gruppe('berichte', ['2029-01-01'])] };
    const grundlagen = P.BUENDEL[0];
    expect(P.eintraegeIm(v, grundlagen, '2028-05-01', '2029-04-30')).toBe(2);
    expect(P.eintraegeIm(v, grundlagen, null, '2029-04-30')).toBe(3);
    expect(P.eintraegeIm(v, P.BUENDEL[3], null, '2029-04-30')).toBe(1);
    expect(P.teileOffenWort(1)).toBe('1 Teil offen');
    expect(P.teileOffenWort(4)).toBe('4 Teile offen');
  });

  it('die Seite einer Mappe: Zeit, Datei, offen, Zeitraum', () => {
    expect(P.zeitText('2029-04-30T10:20:00+02:00')).toBe('30.04.2029, 10:20');
    expect(P.dateiZeile({ abrufbar: true, abrufbar_tage: 30 })).toBe('PDF · CSV · noch 30 Tage');
    expect(P.dateiZeile({ abrufbar: true, abrufbar_tage: 1 })).toBe('PDF · CSV · noch 1 Tag');
    expect(P.dateiZeile({ abrufbar: false, abrufbar_tage: 0 })).toBe('nicht mehr abrufbar');
    expect(P.offenZeile({ offen: ['kontext', 'beschaffung'] })).toBe('2 Teile als offen aufgeführt');
    expect(P.offenZeile({ offen: [] })).toBeNull();
    expect(P.zeitraumText({ von: '2028-05-01', bis: '2029-04-30' })).toBe('01.05.2028 bis 30.04.2029');
    expect(P.zeitraumText({ von: null, bis: '2029-04-30' })).toBe('alles bis 30.04.2029');
  });
});

describe('die Route einer Mappe', () => {
  it('liegt unter dem Überblick von Nachweisen, ist eine Detailseite und kommt aus dem Hash zurück', () => {
    const id = '091577ca-1eab-4fce-bb25-d373beca2e67';
    expect(hashForRoute(mappeRoute(id))).toBe(`#/portfolio/energiemanagement/mappen/${id}`);
    expect(parseRoute(`#/portfolio/energiemanagement/mappen/${id}`)).toEqual(mappeRoute(id));
    expect(istDetailseite(mappeRoute(id))).toBe(true);
    expect(ebenenAktiv(mappeRoute(id).page, undefined, mappeRoute(id).energiemanagementReiter)).toBe(
      ebenenAktiv('portfolio-energiemanagement', undefined, undefined),
    );
  });
});

describe('Einsicht geben (Entscheid 8)', () => {
  it('„2 Wochen“ endet am 14. Tag nach dem Tag der Route, über Monats- und Jahresgrenzen', () => {
    expect(letzterTag('2029-04-30', 14)).toBe('2029-05-14');
    expect(letzterTag('2029-12-25', 14)).toBe('2030-01-08');
    expect(letzterTag('2028-02-20', 28)).toBe('2028-03-19');
  });

  it('der Name: das letzte Wort ist der Nachname', () => {
    expect(namensTeile('  Petra  Prüfer ')).toEqual({ vorname: 'Petra', nachname: 'Prüfer' });
    expect(namensTeile('Anna Maria von Stein')).toEqual({ vorname: 'Anna Maria von', nachname: 'Stein' });
    expect(namensTeile('Prüfer')).toEqual({ vorname: '', nachname: 'Prüfer' });
  });
});
