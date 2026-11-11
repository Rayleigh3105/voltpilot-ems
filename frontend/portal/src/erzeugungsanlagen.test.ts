import { describe, expect, it } from 'vitest';
import type { Einspeiseverguetung, Erzeugungsanlage, Erzeugungsanlagen } from './api';
import { verguetungZeile } from './einspeiseverguetung';
import * as E from './erzeugungsanlagen';

/** Hof Brandl ist erfunden: Altanlage 2009 in Volleinspeisung, Neuanlage 2025 im Überschuss. */
function ea(teil: Partial<Erzeugungsanlage> = {}): Erzeugungsanlage {
  return {
    id: 'ea-1',
    nummer: 1,
    name: null,
    bezeichnung: 'EA 1',
    art: 'pv',
    inbetriebnahme: '2025-05-12',
    inbetriebnahmeAbSolarspitzengesetz: null,
    registryUnitId: null,
    registryFetchedAt: null,
    folgtAnlage: true,
    fassung: {
      id: 'f-1',
      gueltigAb: null,
      leistungKwp: 20,
      einspeiseart: null,
      satzAngegebenCtKwh: null,
      herkunft: 'bestand',
    },
    fassungen: [],
    komponenten: [],
    verguetung: {
      zustand: 'eeg',
      wirksamCtKwh: 7.374,
      angegebenCtKwh: null,
      hergeleitetCtKwh: 7.374,
      naeherung: [],
      foerderendeAm: '2045-12-31',
      ohneVerguetungBeiNegativpreis: true,
    },
    ...teil,
  };
}

const altanlage = ea({
  id: 'ea-2',
  nummer: 2,
  name: 'PV Scheune',
  bezeichnung: 'EA 2 · PV Scheune',
  inbetriebnahme: '2009-04-14',
  folgtAnlage: false,
  fassung: { id: 'f-2', gueltigAb: null, leistungKwp: 30, einspeiseart: 'voll', satzAngegebenCtKwh: null, herkunft: 'angegeben' },
  verguetung: {
    zustand: 'eeg',
    wirksamCtKwh: 23.633,
    angegebenCtKwh: null,
    hergeleitetCtKwh: 23.633,
    naeherung: ['vor_erstem_band', 'volleinspeisung'],
    foerderendeAm: '2029-12-31',
    ohneVerguetungBeiNegativpreis: false,
  },
});

function liste(eas: Erzeugungsanlage[]): Erzeugungsanlagen {
  return { stichtag: '2026-11-11', netzanschluss: null, erzeugungsanlagen: eas, vorschlaege: [] };
}

describe('Erzeugungsanlagen - Einfach bleibt einfach', () => {
  it('zeigt die Liste je EA erst ab der zweiten', () => {
    expect(E.mehrere(null)).toBe(false);
    expect(E.mehrere(liste([]))).toBe(false);
    expect(E.mehrere(liste([ea()]))).toBe(false);
    expect(E.mehrere(liste([ea({ folgtAnlage: false }), altanlage]))).toBe(true);
  });

  it('spricht den Satz einer EA mit denselben Wörtern wie die Karte', () => {
    const karte: Einspeiseverguetung = {
      zustand: 'eeg',
      wirksamCtKwh: 7.374,
      angegebenCtKwh: null,
      inbetriebnahmeAbSolarspitzengesetz: null,
      hergeleitetCtKwh: 7.374,
      hergeleitetGenaehert: false,
      inbetriebnahme: '2025-05-12',
      leistungKwp: 20,
      eegEndeAm: '2045-12-31',
      ohneVerguetungBeiNegativpreis: true,
      anzulegenderWertCtKwh: null,
    };
    expect(E.satzZeile(ea())).toEqual(verguetungZeile(karte));
    expect(E.satzZeile(ea()).sub).toBe('hergeleitet aus EEG, Inbetriebnahme 12.05.2025');
  });

  it('nennt nie eine erfundene Zahl: ohne Grundlage steht „Ohne Angabe“ da', () => {
    const ohne = ea({
      inbetriebnahme: null,
      verguetung: { ...ea().verguetung, zustand: 'ohne_angabe', wirksamCtKwh: null, hergeleitetCtKwh: null, foerderendeAm: null },
    });
    expect(E.satzZeile(ohne)).toEqual({ wert: 'Ohne Angabe', sub: 'Vergütung nicht hinterlegt', warn: true });
    expect(E.eckdaten(ohne)).toContain('Inbetriebnahme nicht erhoben');
  });
});

describe('Erzeugungsanlagen - Zeile und Hinweise', () => {
  it('fasst Inbetriebnahme, Leistung, Einspeiseart und Förderende zusammen', () => {
    expect(E.eckdaten(altanlage)).toBe('Inbetriebnahme 14.04.2009 · 30,0 kWp · Volleinspeisung · Förderende 31.12.2029');
  });

  it('sagt, warum ein hergeleiteter Satz genähert ist, und die Lage bei negativen Preisen', () => {
    expect(E.hinweise(altanlage)).toEqual([E.NAEHERUNG.vor_erstem_band, E.NAEHERUNG.volleinspeisung]);
    expect(E.hinweise(ea())).toEqual(['Bei negativem Börsenpreis keine Vergütung (§ 51a EEG).']);
  });

  it('zeigt mit mehreren EA je EA ihren Satz in der Zeile', () => {
    const z = E.mehrereZeile(liste([ea({ folgtAnlage: false }), altanlage]));
    expect(z.wert).toBe('2 Erzeugungsanlagen');
    expect(z.sub).toBe('EA 1: 7,37 ct/kWh · EA 2: 23,63 ct/kWh');
  });

  it('sagt ehrlich, womit Fahrplan und Erlöse heute rechnen', () => {
    expect(E.nurAnzeigeHinweis(null)).toContain('nur angezeigt');
    const anlage: Einspeiseverguetung = {
      zustand: 'angegeben',
      wirksamCtKwh: 12.5,
      angegebenCtKwh: 12.5,
      inbetriebnahmeAbSolarspitzengesetz: null,
      hergeleitetCtKwh: null,
      hergeleitetGenaehert: false,
      inbetriebnahme: null,
      leistungKwp: null,
      eegEndeAm: null,
      ohneVerguetungBeiNegativpreis: false,
      anzulegenderWertCtKwh: null,
    };
    expect(E.nurAnzeigeHinweis(anlage)).toBe(
      'Fahrplan und Erlöse rechnen bis auf Weiteres mit einem Satz für die ganze Anlage: 12,50 ct/kWh (von Ihnen angegeben). Die Sätze je Erzeugungsanlage sind hier nur angezeigt.',
    );
  });

  it('nennt einen Vorschlag mit Namen und Leistung', () => {
    expect(E.vorschlagText({ komponenteId: 'k', name: 'WR Garage', leistungKwp: 5, registryUnitId: null })).toBe(
      '„WR Garage“ (5,0 kWp) speist noch keine Erzeugungsanlage.',
    );
  });

  it('beschreibt Fassungen und Verweise', () => {
    expect(
      E.fassungText({ id: 'x', gueltigAb: '2030-01-01', leistungKwp: 30, einspeiseart: 'voll', satzAngegebenCtKwh: 0, herkunft: 'angegeben' }),
    ).toBe('ab 01.01.2030 · 30,0 kWp · Volleinspeisung · eigener Satz 0,00 ct/kWh');
    expect(
      E.komponenteText({ id: 'v', komponenteId: 'k', name: 'WR Hybrid', eingang: 2, gueltigAb: '2025-05-12', gueltigBis: null }),
    ).toBe('WR Hybrid, Eingang 2 · seit 12.05.2025');
  });
});

describe('Erzeugungsanlagen - Eingabe', () => {
  it('liest deutsche Zahlen; leer ist nicht erhoben, ungültig ist kein Wert', () => {
    expect(E.leistungAus('')).toBeNull();
    expect(E.leistungAus('9,8')).toBe(9.8);
    expect(E.leistungAus('1.200')).toBe(1200);
    expect(E.leistungAus('0')).toBeUndefined();
    expect(E.leistungAus('abc')).toBeUndefined();
    expect(E.satzAus('0')).toBe(0);
    expect(E.satzAus('100,5')).toBeUndefined();
    expect(E.seeAus(' see 9123 4567 8901 ')).toBe('SEE912345678901');
  });

  it('prüft den Entwurf wie der Server und nennt das erste falsche Feld', () => {
    expect(E.pruefe({ ...E.LEER }, '2026-11-11')).toBeNull();
    expect(E.pruefe({ ...E.LEER, inbetriebnahme: '2027-01-01' }, '2026-11-11')?.feld).toBe('inbetriebnahme');
    expect(E.pruefe({ ...E.LEER, leistung: '-1' }, '2026-11-11')?.feld).toBe('leistung');
    expect(E.pruefe({ ...E.LEER, satz: '200' }, '2026-11-11')?.feld).toBe('satz');
    expect(E.pruefe({ ...E.LEER, see: 'SEE1' }, '2026-11-11')?.feld).toBe('see');
  });

  it('übernimmt eine EA in den Entwurf mit deutschem Komma', () => {
    expect(E.entwurfAus(altanlage)).toEqual({
      name: 'PV Scheune',
      art: 'pv',
      inbetriebnahme: '2009-04-14',
      leistung: '30',
      einspeiseart: 'voll',
      satz: '',
      see: '',
    });
  });
});
