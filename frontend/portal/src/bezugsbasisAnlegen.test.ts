import { describe, expect, it } from 'vitest';
import * as B from './bezugsbasisAnlegen';
import { bb1, bb1Fassung, kz4, variablenVorschlag } from './test/bezugsbasisFixtures';

/** UEMS AP-17 IP-9 — die reinen Ableitungen des Reiters „Bezugsbasis“ gegen die Sätze aus §5.8 und R1. */
describe('Basis-Zeile und Register (§5.8, R1, B3)', () => {
  it('spricht die Basis-Zeile von R1 wörtlich', () => {
    expect(B.basisZeile(bb1(), bb1Fassung('freigegeben'), 'kWh/kg')).toBe(
      'Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12 Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.',
    );
  });
  it('nennt bei Vier-Augen die zweite Person, die freigab (`entscheidung`)', () => {
    const f = bb1Fassung('freigegeben', {
      vieraugen: true,
      freigabe: { name: 'Ines Kaltenbach', rolle: 'energiemanager', am: '2026-11-11T16:00:00+01:00' },
      entscheidung: { name: 'Jonas Wendlinger', rolle: 'kundenadministrator', am: '2026-11-12T10:00:00+01:00' },
    });
    expect(B.basisZeile(bb1(), f, 'kWh/kg')).toMatch(/· freigegeben von Jonas Wendlinger am 12\.11\.2026\.$/);
    expect(B.tagIn('2026-11-30T23:30:00Z')).toBe('01.12.2026');
  });
  it('zeigt Entwurf und Antrag als Zustand, nie als freigegeben', () => {
    expect(B.basisZeile(bb1(), bb1Fassung('entwurf'), 'kWh/kg')).toMatch(/· Entwurf\.$/);
    expect(B.basisZeile(bb1(), bb1Fassung('beantragt'), 'kWh/kg')).toMatch(/· zur Freigabe beantragt\.$/);
    expect(B.basisZeile(bb1(), bb1Fassung('freigegeben', { monate: 12, referenzperiode: '2026-11/2027-10' }), 'kWh/kg')).toBe(
      'Bezugsbasis BB-0001 · November 2026 bis Oktober 2027 · Verhältnis 0,2837 kWh je kg · freigegeben von Ines Kaltenbach am 12.11.2026.',
    );
  });
  it('trägt das Register-Kennzeichen nur bei freigegebener Basis — ohne Feld keine Vermutung (R10)', () => {
    expect(B.energieleistung(kz4())).toBeNull();
    expect(B.energieleistung(kz4({ bezugsbasis: null }))).toBeNull();
    for (const s of ['entwurf', 'beantragt', 'abgelehnt'] as const) {
      expect(B.energieleistung(kz4({ bezugsbasis: { kennzeichen: 'BB-0001', fassung: 1, freigabe_status: s, vorlaeufig: true } }))).toBeNull();
    }
    expect(B.energieleistung(kz4({ bezugsbasis: { kennzeichen: 'BB-0001', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: false } }))).toBe(
      'Energieleistungskennzahl — Bezugsbasis BB-0001.',
    );
    expect(B.energieleistung(kz4({ bezugsbasis: { kennzeichen: 'BB-0001', fassung: 1, freigabe_status: 'freigegeben', vorlaeufig: true } }))).toBe(
      'Energieleistungskennzahl — Bezugsbasis BB-0001 · vorläufig.',
    );
  });
  it('der Reiter gehört nur zu Quotient und Zusammenfassung (B2)', () => {
    expect(B.kannBezugsbasis({ rechenform: 'quotient' })).toBe(true);
    expect(B.kannBezugsbasis({ rechenform: 'zusammenfassung' })).toBe(true);
    expect(B.kannBezugsbasis({ rechenform: 'anteil' })).toBe(false);
  });
  it('nennt die jüngste freigegebene Fassung, sonst die jüngste', () => {
    const b = bb1('freigegeben');
    b.fassungen.push({ ...b.fassungen[0], fassung: 2, freigabe_status: 'entwurf' });
    expect(B.zeilenFassung(b)?.fassung).toBe(1);
    expect(B.zeilenFassung(bb1('entwurf'))?.fassung).toBe(1);
    expect(B.zeilenFassung(bb1(null))).toBeNull();
    expect(B.laufende([{ ...bb1(), beendet_zum: '2026-12-31' }])).toBeNull();
  });
});

describe('Referenzperiode (P1–P3)', () => {
  it('schlägt die letzten zwölf vollen Monate vor und bietet nur abgeschlossene', () => {
    expect(B.vorschlagPeriode('2026-11-12')).toEqual({ von: '2025-11', bis: '2026-10' });
    expect(B.waehlbareMonate('2026-11-12', 3)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(B.waehlbareMonate('2027-01-05', 2)).toEqual(['2026-12', '2026-11']);
    expect(B.referenzperiodeText('2026-10/2026-10')).toBe('Oktober 2026');
    expect(B.monateZwischen('2026-11', '2027-10')).toBe(12);
    expect(B.periodeFehler('2026-10', '2026-09')).toBe('Der letzte Monat liegt vor dem ersten.');
    expect(B.periodeFehler('2026-10', '2026-10')).toBeNull();
  });
  it('liest je Monat vorhanden · vorläufig · fehlt aus der Vorschau-Antwort', () => {
    expect(
      B.monatsZustaende([
        { periode: '2026-09', grund: 'noch_nicht_gebildet' },
        { periode: '2026-10', kennzahl: { objekt: 'KZ-0004', wert: '0.28', version: 1, definition_fassung: 1, zustand: 'endgueltig', menge_zustand: null, kennzeichen: [] } },
        { periode: '2026-11', kennzahl: { objekt: 'KZ-0004', wert: '0.28', version: 1, definition_fassung: 1, zustand: 'vorlaeufig', menge_zustand: null, kennzeichen: [] } },
      ]).map((z) => [z.text, z.zustand]),
    ).toEqual([
      ['September 2026', 'fehlt'],
      ['Oktober 2026', 'vorhanden'],
      ['November 2026', 'vorlaeufig'],
    ]);
    expect(B.vorlaeufigText(1, 12)).toBe('vorläufig (1 von 12 Monaten)');
    expect(B.vorlaeufigText(12, 12)).toBeNull();
    expect(B.datenlageSaetze(bb1Fassung())).toEqual(['vorläufig (1 von 12 Monaten)']);
  });
});

describe('Methoden (IP-5, G1) und Einflussgrößen (IP-11a)', () => {
  it('unter zwölf Monaten trägt nur das Verhältnis (G1, §5.8); ab zwölf alle vier; `methode_noch_nicht_gebaut` graut aus', () => {
    const M = 'Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.';
    expect(B.methodenWahl(1, new Set()).map((x) => [x.methode.kundenwort, x.grund])).toEqual([
      ['Verhältnis', null],
      ['Modell mit einer Einflussgröße', M],
      ['Modell mit zwei Einflussgrößen', M],
      ['Wetterbereinigung über Gradtage', M],
    ]);
    expect(B.methodenWahl(12, new Set()).every((x) => x.grund === null)).toBe(true);
    expect(B.methodenWahl(12, new Set(['gradtage']))[3].grund).toBe('kommt');
  });
  it('spricht ein Modell wie §5.8 „Fassung 2“ und die abgelehnte zweite Variable (G4)', () => {
    const f = bb1Fassung('freigegeben', {
      fassung: 2, methode: 'regression_eine_variable', referenzperiode: '2026-11/2027-10', monate: 12,
      koeffizienten: { a: '10522.6206', b: '0.2343' }, streuung_prozent: '0.8', r2: '0.991',
    });
    expect(B.modellText(f, 'kWh/kg')).toBe('Modell mit einer Einflussgröße — 10 523 kWh Grundlast + 0,2343 kWh je kg, Streuung ± 0,8 %');
    expect(B.basisZeile(bb1(), f, 'kWh/kg')).toBe(
      'Bezugsbasis BB-0001 · Fassung 2 · November 2026 bis Oktober 2027 · Modell mit einer Einflussgröße — 10 523 kWh Grundlast + 0,2343 kWh je kg, Streuung ± 0,8 % · freigegeben von Ines Kaltenbach am 12.11.2026.',
    );
    expect(B.modellText(bb1Fassung(), 'kWh/kg')).toBeNull();
    expect(B.abgelehntSatz({ objekt: 'BZ-3', position: 2, grund: 'variablen_abhaengig', r: '0.997' })).toBe(
      'BZ-3 nicht aufgenommen: hängt an Einflussgröße 1 (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.',
    );
  });
  it('ein abhängiger Kandidat trägt den Satz der Route und ist nicht wählbar', () => {
    const [, bz3] = variablenVorschlag().kandidaten;
    expect(B.kandidatZeile(bz3)).toEqual({
      titel: 'Betriebsstunden (BZ-3, h)',
      hinweis: 'Betriebsstunden hängt an Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.',
      waehlbar: false,
    });
    expect(B.kandidatZeile({ ...bz3, satz: null, abhaengigkeit: { ...bz3.abhaengigkeit!, ergebnis: 'unabhaengig', r: -0.4219 } }).hinweis).toBe(
      'unabhängig von BZ-1 (r = −0,422)',
    );
  });
  it('Zahlen, Einheiten, Prüfsumme und Begründung', () => {
    expect(B.dezimal('0.2837')).toBe('0,2837');
    expect(B.dezimal('10523')).toBe('10 523');
    expect(B.einheitJe('kWh/kg')).toBe('kWh je kg');
    expect(B.pruefsummeKurz('sha256:4e2d9c0a7f1b')).toBe('4e2d9c0a…');
    expect(B.begruendungFehler('kurz')).not.toBeNull();
    expect(B.begruendungFehler('Oktober 2026 ist der erste volle Monat mit Produktionsmenge.')).toBeNull();
    expect(B.begruendungFehler('x'.repeat(501))).not.toBeNull();
    expect(B.nachAntragSatz(bb1Fassung('freigegeben'))).toBe('Fassung 1 ist freigegeben und gilt ab 01.11.2026.');
    expect(B.nachAntragSatz(bb1Fassung('beantragt'))).toBe('Fassung 1 ist zur Freigabe beantragt und wartet auf eine zweite Person.');
  });
});
