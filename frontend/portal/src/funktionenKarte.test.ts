import { describe, expect, it } from 'vitest';
import { ahrenbergFunktionen, funktionWerkLindach } from './test/funktionenFixtures';
import { ahrenbergHeute, werkAhrenberg, werkLindach } from './test/standorteFixtures';
import { funktionenKarte, standortLeerzustand, type UebersichtEbene } from './uebersicht';

/**
 * Die Karte „Funktionen" und der Leerzustand der Standort-Übersicht, reine
 * Hälfte (UEMS AP-01 IP-8, E5 = A, E6 = C) — gegen das Referenzunternehmen
 * Ahrenberg am 20.10.2026 (A7) und nach dem Umstieg (A11).
 */

const UNTERNEHMEN: UebersichtEbene = {
  art: 'unternehmen',
  name: 'Kunststoffwerk Ahrenberg GmbH',
  standorte: ahrenbergHeute().standorte,
};

describe('Unternehmens-Übersicht: je Funktion, je Standort Zustand und nächster Schritt', () => {
  it('A7: Messen läuft an beiden Standorten — kein Schritt', () => {
    const [messen] = funktionenKarte(UNTERNEHMEN, ahrenbergFunktionen())!;
    expect(messen).toEqual({
      funktion: 'messen',
      label: 'Messen & Auswerten',
      verbreitung: 'Läuft an 2 von 2 Standorten',
      zeilen: [
        expect.objectContaining({ name: 'Werk Ahrenberg', satz: 'Eingerichtet am 01.10.2026 · 13 von 13 Messstellen liefern Daten', schritt: null }),
        expect.objectContaining({ name: 'Werk Lindach', satz: 'Eingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten', schritt: null }),
      ],
    });
  });

  it('A7: Steuern läuft in Werk Ahrenberg — Halle 2 aufnehmen; Werk Lindach einrichten', () => {
    const [, steuern] = funktionenKarte(UNTERNEHMEN, ahrenbergFunktionen())!;
    expect(steuern.verbreitung).toBe('Läuft an 1 von 2 Standorten');
    expect(steuern.zeilen.map(({ name, zustand, satz, ton, schritt }) => ({ name, zustand, satz, ton, schritt }))).toEqual([
      {
        name: 'Werk Ahrenberg',
        zustand: 'aktiv',
        satz: 'Läuft mit Werk Ahrenberg – Halle 1',
        ton: 'ok',
        schritt: 'Werk Ahrenberg – Halle 2 aufnehmen',
      },
      {
        name: 'Werk Lindach',
        zustand: 'kein_objekt',
        satz: 'Noch nicht eingerichtet',
        ton: 'off',
        schritt: 'Steuern & Optimieren für Werk Lindach einrichten',
      },
    ]);
  });

  it('A11: nach dem Umstieg hat Messen kein Objekt — der Schritt heißt „einrichten"', () => {
    const [messen] = funktionenKarte(UNTERNEHMEN, ahrenbergFunktionen({ messen: 'bestand' }))!;
    expect(messen.verbreitung).toBe('Läuft an 0 von 2 Standorten');
    expect(messen.zeilen.map((z) => z.schritt)).toEqual([
      'Messen & Auswerten für Werk Ahrenberg einrichten',
      'Messen & Auswerten für Werk Lindach einrichten',
    ]);
  });

  it('nimmt jede Anlage des Standorts teil, gibt es keinen Schritt', () => {
    const f = ahrenbergFunktionen();
    f.standorte[0].steuern.anlagen[1].teilnahme.zustand = 'aktiv';
    const [, steuern] = funktionenKarte(UNTERNEHMEN, f)!;
    expect(steuern.zeilen[0].schritt).toBeNull();
  });

  it('nicht abrufbar ist eine Aussage, keine leere Karte', () => {
    expect(funktionenKarte(UNTERNEHMEN, null)).toBeNull();
  });
});

describe('Standort-Übersicht: dieselbe Karte für EINEN Standort', () => {
  it('ohne Standort-Namen (er steht im Kopf) und ohne „läuft an x von y"', () => {
    const karte = funktionenKarte({ art: 'standort', standort: werkAhrenberg() }, ahrenbergFunktionen())!;
    expect(karte.map((a) => a.verbreitung)).toEqual([null, null]);
    expect(karte.map((a) => a.zeilen.map((z) => [z.name, z.schritt]))).toEqual([
      [[null, null]],
      [[null, 'Werk Ahrenberg – Halle 2 aufnehmen']],
    ]);
  });

  it('ein Standort ohne Anlage hat in der Karte keinen Schritt — ihn nennt der Leerzustand', () => {
    const lindachLeer = funktionWerkLindach('bestand');
    lindachLeer.steuern.anlagen = [];
    const karte = funktionenKarte(
      { art: 'standort', standort: werkLindach({ anlagen: [], anlagenZahl: 0 }) },
      ahrenbergFunktionen({ standorte: [lindachLeer], messen: 'bestand' }),
    )!;
    expect(karte.map((a) => [a.zeilen[0].satz, a.zeilen[0].schritt])).toEqual([
      ['Noch nicht eingerichtet', null],
      ['Noch nicht eingerichtet', null],
    ]);
  });
});

describe('der Leerzustand der Standort-Übersicht', () => {
  it('ein Standort ohne Anlage nennt Grund und nächsten Schritt — benannt, ohne Knopf', () => {
    expect(standortLeerzustand(werkLindach({ anlagen: [], anlagenZahl: 0 }))).toEqual({
      titel: 'Werk Lindach ist angelegt — noch ohne Anlage',
      satz: 'Messwerte kommen über eine Anlage: an ihr verbinden Sie die Box und binden die Zähler an.',
      schritt: 'Eine Anlage anlegen oder eine bestehende Anlage diesem Standort zuordnen (in der Anlage unter Einstellungen)',
    });
  });

  it('sobald eine Anlage zugeordnet ist, gibt es ihn nicht', () => {
    expect(standortLeerzustand(werkLindach())).toBeNull();
  });
});
