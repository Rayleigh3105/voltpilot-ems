import { describe, expect, it } from 'vitest';
import * as F from './bezugsbasisFassungen';
import { ANPASSUNGSGRUENDE as VOKABULAR } from './bezugsbasis';
import { anstossR5, ANSTOSS_SATZ_R5, basisMit, fassung1, fassung2, faktorenR1, FRIST_SATZ_R13, fristR13 } from './test/bezugsbasisFassungenFixtures';

/** UEMS AP-17 IP-18 — die reinen Sätze der Fassungen (§5.5, §5.8) gegen R1/R5/R13; gerechnet wird nichts. */
describe('Zeitleiste: Zustand, Gültigkeit, Freigeber, Anpassungsgründe', () => {
  it('A1 hat dieselben sieben Gründe in derselben Reihenfolge wie das Vokabular', () => {
    expect(F.ANPASSUNGSGRUENDE).toEqual(VOKABULAR);
  });
  it('Fassung 1 freigegeben, nach Fassung 2 beendet mit gilt bis (F4); neueste oben', () => {
    const f1 = fassung1();
    expect(F.fassungZustand(f1)).toBe('freigegeben');
    expect(F.geltungText(f1)).toBe('gilt ab 01.11.2026');
    const f1b = fassung1({ gilt_bis: '2026-12-31' });
    expect(F.fassungZustand(f1b)).toBe('beendet');
    expect(F.ZUSTAND_WORT.beendet).toBe('beendet');
    expect(F.geltungText(f1b)).toBe('gilt vom 01.11.2026 bis 31.12.2026');
    expect(F.zeitleiste([f1b, fassung2()]).map((f) => f.fassung)).toEqual([2, 1]);
    expect(F.laufendeFassung([f1, fassung2()])?.fassung).toBe(1);
    expect(F.offeneFassung([f1, fassung2()])?.fassung).toBe(2);
  });
  it('Freigeber: freigegeben, beantragt, abgelehnt; der Entwurf hat keinen', () => {
    expect(F.freigeberText(fassung1())).toBe('freigegeben von Ines Kaltenbach am 12.11.2026');
    expect(F.freigeberText(fassung2('entwurf'))).toBeNull();
    expect(F.freigeberText(fassung2('beantragt'))).toBe('beantragt von Ines Kaltenbach am 05.01.2027');
    expect(F.freigeberText(fassung2('abgelehnt', { entscheidung: { name: 'Jonas Weber', rolle: 'kundenadministrator', am: '2027-01-06T09:00:00+01:00' } }))).toBe(
      'abgelehnt von Jonas Weber am 06.01.2027',
    );
  });
  it('Anpassungsgründe in Kundenwörtern, sonstiger mit Wortlaut; Fassung 1 hat keine', () => {
    expect(F.anpassungText(fassung1())).toBeNull();
    expect(F.anpassungText(fassung2())).toBe('Anpassungsgründe: Struktur geändert');
    expect(F.anpassungText({ anpassungsgruende: ['grundlage_korrigiert', 'sonstiger'], anpassung_wortlaut: 'Zählertausch' })).toBe(
      'Anpassungsgründe: Grundlage korrigiert, sonstiger Grund („Zählertausch“)',
    );
  });
  it('Basiswert in Kundenwort (Verhältnis) — kein eigenes Rechnen', () => {
    expect(F.wertText(fassung1(), 'kWh/kg')).toBe('Verhältnis 0,2837 kWh je kg');
  });
});

describe('Anstoß und Frist (§5.8, R5, R13)', () => {
  it('der Satz des Servers steht wörtlich; ohne ihn Art und Tag', () => {
    expect(F.anstossSatz({ kennzeichen: 'BB-0001' }, anstossR5())).toBe(ANSTOSS_SATZ_R5);
    expect(F.anstossSatz({ kennzeichen: 'BB-0001' }, anstossR5({ anlass_satz: '' }))).toBe('Bezugsbasis BB-0001: Struktur geändert (05.01.2027) — Fassung 1 prüfen.');
    expect(F.anstossOhneAnlass({ kennzeichen: 'BB-0001' }, 1)).toBe('Bezugsbasis BB-0001: Anstoß liegt vor — Fassung 1 prüfen.');
  });
  it('nur offene Anstöße der laufenden Fassung stehen im Kasten (A4)', () => {
    const beantwortet = anstossR5({ offen: false, antwort: { art: 'bleibt', person: 'Ines Kaltenbach', am: '2027-01-06T10:00:00+01:00', begruendung: 'bleibt' } });
    expect(F.offeneAnstoesse([anstossR5(), beantwortet, anstossR5({ fassung: 2 })], 1)).toEqual([anstossR5()]);
    expect(F.offeneAnstoesse(undefined, 1)).toEqual([]);
  });
  it('Frist aus dem Feld der Route (R13 fällig seit 1 Tag); nicht fällig → keine Zeile; Rückfall Übersicht', () => {
    const f1 = fassung1();
    expect(F.fristZeile(basisMit([f1], { frist: fristR13(true) }), f1, null)).toBe(FRIST_SATZ_R13);
    expect(F.fristZeile(basisMit([f1], { frist: fristR13(false) }), f1, null)).toBeNull();
    const rueckfall = { bezugsbasis_id: 'x', kennzeichen: 'BB-0001', kennzahl_id: 'k', kennzahl_kennzeichen: null, kennzahl_name: null, fassung: 1, freigegeben_am: '2026-11-12', datenlage: null, zustand: 'ueberpruefung_faellig' as const, faellig_am: '2027-11-12', faellig_seit_tagen: 3, anstoss_liegt_vor: false, beendet_zum: null, beendet_grund: null };
    expect(F.fristZeile(basisMit([f1]), f1, rueckfall)).toBe('Bezugsbasis BB-0001, Fassung 1 vom 12.11.2026 · Überprüfung fällig seit 3 Tagen — bestätigen oder neu fassen.');
  });
  it('nach „beenden“: der Satz für Vergleiche danach (§5.8 „Beendet“)', () => {
    expect(F.nachBeendenSatz({ beendet_zum: '2026-12-31', beendet_grund: 'struktur_geaendert' })).toBe(
      'Vergleiche danach: Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Struktur geändert).',
    );
  });
});

describe('Faktoren (§17)', () => {
  it('der Satz des Servers — Fläche mit Wert und Stand, Wortlaut ohne Anstoß', () => {
    expect(faktorenR1.map(F.faktorSatz)).toEqual([
      'Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)',
      'Statischer Faktor: Zweischichtbetrieb, Halle 2 (Wortlaut, ohne Anstoß)',
    ]);
  });
  it('ohne Satz aus Art, Kennung, Wert und Stichtag zusammengesetzt', () => {
    expect(F.faktorSatz({ ...faktorenR1[0], satz: '' })).toBe('Statischer Faktor: Fläche G-2 Halle 2 3 100 m² (Stand 12.11.2026)');
    expect(F.faktorSatz({ ...faktorenR1[1], satz: '' })).toBe('Statischer Faktor: Zweischichtbetrieb, Halle 2 (Wortlaut, ohne Anstoß)');
  });
});

describe('Fassung n + 1: Pflicht, Körper, Vorbelegung, Vorschau alt/neu', () => {
  it('Pflicht: mindestens ein Grund, sonstiger nur mit Wortlaut, Begründung 10–500', () => {
    expect(F.anpassungFehler({ gruende: [], wortlaut: '', begruendung: 'kurz', giltAb: '' })).toEqual({
      gruende: 'Bitte wählen Sie mindestens einen Anpassungsgrund.',
      wortlaut: null,
      begruendung: 'Bitte begründen Sie mit mindestens 10 Zeichen.',
    });
    expect(F.anpassungFehler({ gruende: ['sonstiger'], wortlaut: '  ', begruendung: 'Zählertausch in Halle 2', giltAb: '' }).wortlaut).toBe(
      'Bitte nennen Sie den sonstigen Grund.',
    );
    expect(F.anpassungFehler({ gruende: ['struktur_geaendert'], wortlaut: '', begruendung: 'Anbau Halle 2 im Januar', giltAb: '' })).toEqual({
      gruende: null, wortlaut: null, begruendung: null,
    });
  });
  it('Körper: Gründe in Vokabular-Reihenfolge, Wortlaut nur mit sonstiger, gilt_ab nur, wenn gesetzt', () => {
    expect(F.anpassungKoerper({ gruende: ['sonstiger', 'grundlage_korrigiert'], wortlaut: ' Zählertausch ', begruendung: ' Neue Messung ab Januar ', giltAb: '' })).toEqual({
      anpassungsgruende: ['grundlage_korrigiert', 'sonstiger'],
      anpassung_wortlaut: 'Zählertausch',
      begruendung: 'Neue Messung ab Januar',
    });
    expect(F.anpassungKoerper({ gruende: ['struktur_geaendert'], wortlaut: 'bleibt weg', begruendung: 'Anbau Halle 2 im Januar', giltAb: '2027-01-01' })).toEqual({
      anpassungsgruende: ['struktur_geaendert'],
      anpassung_wortlaut: null,
      begruendung: 'Anbau Halle 2 im Januar',
      gilt_ab: '2027-01-01',
    });
  });
  it('Vorbelegung aus Fassung n: Referenzperiode, Methode, Toleranz, Wiedervorlage, Faktoren', () => {
    expect(F.vorbelegung(fassung1())).toEqual({
      von: '2026-10', bis: '2026-10', methode: 'verhaeltnis', zweite: [], toleranz: '2', wiedervorlage: '12',
      faktoren: ['g2000000-0000-4000-8000-000000000002'], wortlaut: 'Zweischichtbetrieb, Halle 2',
    });
    expect(F.anpassungAus(fassung2())).toEqual({ gruende: ['struktur_geaendert'], wortlaut: '', begruendung: 'Anbau Halle 2: die Fläche wächst von 3 100 auf 3 400 m².', giltAb: '' });
  });
  it('Vorschau alt/neu: je Zeile beide Fassungen, Ungleiches markiert', () => {
    const zeilen = F.vorschauAltNeu(fassung1(), fassung2(), 'kWh/kg');
    expect(zeilen.map((z) => z.wort)).toEqual(['Referenzperiode', 'Methode', 'Datenlage', 'Gültig', 'Statische Faktoren', 'Prüfsumme']);
    expect(zeilen[1]).toEqual({ wort: 'Methode', alt: 'Verhältnis 0,2837 kWh je kg', neu: 'Verhältnis 0,2811 kWh je kg', anders: true });
    expect(zeilen[0].anders).toBe(false);
    expect(zeilen[3]).toMatchObject({ alt: 'gilt ab 01.11.2026', neu: 'gilt ab 01.01.2027', anders: true });
    expect(zeilen[4].neu).toContain('3 400 m²');
  });
});

describe('Beenden (F4)', () => {
  it('Tag, Grund aus A1 und Begründung sind Pflicht; vor heute rückwirkend', () => {
    expect(F.beendenFehler({ tag: '', grund: '', begruendung: '' })).toEqual({
      tag: 'Bitte wählen Sie den letzten Tag der Bezugsbasis.',
      grund: 'Bitte wählen Sie einen Grund.',
      begruendung: 'Bitte begründen Sie mit mindestens 10 Zeichen.',
    });
    expect(F.beendenFehler({ tag: '2026-12-31', grund: 'struktur_geaendert', begruendung: 'Anbau Halle 2 im Januar' })).toEqual({ tag: null, grund: null, begruendung: null });
    expect(F.rueckwirkend('2026-11-11', '2026-11-12')).toBe(true);
    expect(F.rueckwirkend('2026-11-12', '2026-11-12')).toBe(false);
  });
  it('jede Ablehnung der Pflege-Routen hat einen Kundensatz', () => {
    for (const c of ['begruendung_fehlt', 'grund_unbekannt', 'rueckwirkend_fehlt', 'tag_vor_fassung', 'bezugsbasis_beendet', 'keine_freigegebene_fassung']) {
      expect(F.PFLEGE_SATZ[c], c).toBeTruthy();
    }
  });
});
