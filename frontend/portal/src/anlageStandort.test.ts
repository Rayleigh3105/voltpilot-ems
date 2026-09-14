import { describe, expect, it } from 'vitest';
import {
  koordinatenLabel,
  standortDerAnlage,
  standortWaehlenSatz,
  standortWahl,
  standortWahlHinweis,
  standortZeile,
} from './anlageStandort';
import { ahrenbergHeute, bestandEineAnlage, bestandZweiAnlagen, FIXTURE_IDS, werkAhrenberg } from './test/standorteFixtures';

describe('Meine Anlage · die Zeile „Standort“ (AP-02 IP-8, T6a, W4)', () => {
  it('findet den Standort der Anlage mit „seit“ = Beginn ihrer Zuordnung', () => {
    const a = standortDerAnlage(ahrenbergHeute(), FIXTURE_IDS.an2)!;
    expect(a.standort.kurzzeichen).toBe('ST-1');
    expect(standortZeile(a)).toEqual({
      name: 'Werk Ahrenberg (ST-1)',
      zeile: 'Gewerbering 7, Ahrenberg · seit 01.10.2026',
      fehlt: null,
    });
    expect(koordinatenLabel(a)).toBe('Standort auf der Karte');
  });

  it('der automatisch angelegte Standort sagt, dass die Adresse fehlt', () => {
    const a = standortDerAnlage(bestandEineAnlage(), FIXTURE_IDS.an1)!;
    expect(standortZeile(a)).toEqual({
      name: 'Werk Ahrenberg – Halle 1 (ST-1)',
      zeile: 'seit 12.03.2024',
      fehlt: 'Noch nicht eingerichtet — es fehlt: Adresse',
    });
  });

  it('ohne Standort-Objekt: nichts gefunden, das Label der Koordinaten bleibt „Standort“', () => {
    expect(standortDerAnlage(bestandZweiAnlagen(), FIXTURE_IDS.an1)).toBeNull();
    expect(standortDerAnlage(null, FIXTURE_IDS.an1)).toBeNull();
    expect(standortDerAnlage(ahrenbergHeute(), 'fremde-anlage')).toBeNull();
    expect(koordinatenLabel(null)).toBe('Standort');
  });

  it('ein Standort, den es am Stichtag nicht gab, ist kein Standort der Anlage', () => {
    const antwort = { ...ahrenbergHeute(), standorte: [werkAhrenberg({ bestand: 'gab_es_noch_nicht' })] };
    expect(standortDerAnlage(antwort, FIXTURE_IDS.an2)).toBeNull();
  });
});

describe('Anlage-Assistent Schritt 1 · der Standort-Picker (AP-02 IP-8)', () => {
  it('ohne Standort kein Picker', () => {
    expect(standortWahl(null)).toBeNull();
    expect(standortWahl(bestandZweiAnlagen())).toBeNull();
    expect(standortWahl({ ...ahrenbergHeute(), standorte: [werkAhrenberg({ zustand: 'archiviert' })] })).toBeNull();
  });

  it('genau ein Standort: vorbelegt, und der Satz sagt es', () => {
    const w = standortWahl(bestandEineAnlage())!;
    expect(w.vorbelegt).toBe(FIXTURE_IDS.st1);
    expect(w.optionen).toEqual([{ value: FIXTURE_IDS.st1, label: 'Werk Ahrenberg – Halle 1 (ST-1)', sub: null }]);
    expect(standortWahlHinweis(w, w.vorbelegt)).toBe(
      'Ihr einziger Standort ist vorbelegt: die neue Anlage gehört ab heute zu Werk Ahrenberg – Halle 1 (ST-1).',
    );
  });

  it('mehrere: zur Wahl, nichts vorbelegt — der Pflicht-Satz ist der des Servers', () => {
    const w = standortWahl(ahrenbergHeute())!;
    expect(w.vorbelegt).toBeNull();
    expect(w.optionen.map((o) => [o.label, o.sub])).toEqual([
      ['Werk Ahrenberg (ST-1)', 'Gewerbering 7, Ahrenberg'],
      ['Werk Lindach (ST-2)', 'Am Bahndamm 12, Lindach'],
    ]);
    expect(standortWahlHinweis(w, null)).toBeNull();
    expect(standortWahlHinweis(w, FIXTURE_IDS.st2)).toBe('Die neue Anlage gehört ab heute zu Werk Lindach (ST-2).');
    expect(standortWaehlenSatz(2)).toBe(
      'Ihr Unternehmen hat 2 Standorte. Bitte wählen Sie, zu welchem Standort die neue Anlage gehört.',
    );
  });
});
