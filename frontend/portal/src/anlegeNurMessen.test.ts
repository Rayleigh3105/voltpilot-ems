import { describe, expect, it } from 'vitest';
import type { FunktionStandort, FunktionZustand, Funktionen } from './api';
import { FLOW_STEPS, STARTKLAR_SATZ, startklarSatz } from './anlageFlow';
import {
  anlegeArt,
  anlageLeertext,
  anlegeSchritte,
  anlegeStandort,
  ERSTE_DATEN_NUR_MESSEN,
  messstellenZiel,
  nurMessenWeiterSatz,
  steuerGeldWoerter,
  STEUER_GELD_WOERTER,
  ZU_DEN_MESSSTELLEN,
} from './anlegeNurMessen';
import { VERAEUSSERUNGSFORM_FRAGE } from './glossar';
import { pageRoute, standortMessstellenRoute } from './nav';
import { SETUP_NEXT_HINT } from './setupPath';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from './test/funktionenFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Die Steuern-Regel im Anlege-Fluss als reine Entscheidung (Captain 15.09.2026):
 * derselbe Fakt wie auf der Übersicht (`steuernSpricht`), an dem Standort, an dem die
 * Anlage entsteht — und die Wortliste, gegen die jede Fläche des Modus geprüft wird.
 */

/** Alle Teilnahmen eines Standorts auf einen Zustand gestellt — neue Objekte, die Fixture bleibt unberührt. */
function teilnahmen(fs: FunktionStandort, zustand: FunktionZustand): FunktionStandort {
  return {
    ...fs,
    steuern: {
      ...fs.steuern,
      anlagen: fs.steuern.anlagen.map((a) => ({ ...a, teilnahme: { ...a.teilnahme, zustand } })),
    },
  };
}

const nurLindach = (): Funktionen => ahrenbergFunktionen({ standorte: [funktionWerkLindach()] });
/** Ein Unternehmen, das nur misst: auch Werk Ahrenberg ohne Teilnahme. */
const messkunde = (): Funktionen =>
  ahrenbergFunktionen({ standorte: [teilnahmen(funktionWerkAhrenberg(), 'kein_objekt'), funktionWerkLindach()] });

describe('anlegeArt — derselbe Fakt wie auf der Übersicht, am Standort der neuen Anlage', () => {
  it('noch nicht entschieden: funktionen === null zeigt weder die eine noch die andere Fassung', () => {
    expect(anlegeArt(null)).toBeNull();
    expect(anlegeArt(null, { standortId: FIXTURE_IDS.st2 })).toBeNull();
  });

  it('kein Standort und keine Anlage: zuerst den Standort', () => {
    expect(anlegeArt(ahrenbergFunktionen({ standorte: [] }))).toBe('standort_zuerst');
  });

  it('kein Standort und eine Bestandsanlage: wie heute', () => {
    expect(anlegeArt(ahrenbergFunktionen({ standorte: [] }), { hatAnlage: true })).toBe('wie_heute');
    expect(anlegeArt(ahrenbergFunktionen({ standorte: [] }), { anlageId: 'bestand-ohne-standort' })).toBe('wie_heute');
  });

  it('ein Bestands-Kundenbereich, der nie eine Anlage angelegt hat: zuerst den Standort', () => {
    const bestandOhneAnlage = ahrenbergFunktionen({ standorte: [] });
    expect(anlegeArt(bestandOhneAnlage, { hatAnlage: false })).toBe('standort_zuerst');
  });

  it('Werk Ahrenberg spricht (Halle 1 steuert): wie heute — Werk Lindach schweigt: nur messen', () => {
    expect(anlegeArt(ahrenbergFunktionen(), { standortId: FIXTURE_IDS.st1 })).toBe('wie_heute');
    expect(anlegeArt(ahrenbergFunktionen(), { standortId: FIXTURE_IDS.st2 })).toBe('nur_messen');
  });

  it('„teilnimmt“ ist breiter als „steuert“: angehalten spricht, archiviert schweigt (Falle 2 der Steuern-Regel)', () => {
    const lindach = (z: FunktionZustand) =>
      ahrenbergFunktionen({ standorte: [teilnahmen(funktionWerkLindach(), z)] });
    expect(anlegeArt(lindach('angehalten'), { standortId: FIXTURE_IDS.st2 })).toBe('wie_heute');
    expect(anlegeArt(lindach('archiviert'), { standortId: FIXTURE_IDS.st2 })).toBe('nur_messen');
  });

  it('noch keine Wahl: das Unternehmen spricht, sobald irgendein Standort spricht', () => {
    expect(anlegeArt(ahrenbergFunktionen())).toBe('wie_heute');
    expect(anlegeArt(messkunde())).toBe('nur_messen');
    expect(anlegeArt(nurLindach())).toBe('nur_messen');
  });

  it('ein Standort, den die Funktionen nicht nennen, und eine Anlage ohne Standort bleiben wie heute', () => {
    expect(anlegeArt(messkunde(), { standortId: 'st-unbekannt' })).toBe('wie_heute');
    expect(anlegeArt(messkunde(), { anlageId: 'an-ohne-standort' })).toBe('wie_heute');
  });

  it('Wiedereinstieg: die bestehende Anlage entscheidet über IHREN Standort, nicht über ihre Teilnahme', () => {
    expect(anlegeArt(ahrenbergFunktionen(), { anlageId: FIXTURE_IDS.an3 })).toBe('nur_messen');
    // Halle 2 misst nur — steht aber an Werk Ahrenberg, das von Steuern spricht.
    expect(anlegeArt(ahrenbergFunktionen(), { anlageId: FIXTURE_IDS.an2 })).toBe('wie_heute');
  });
});

describe('anlegeStandort, Schritte und Ziel', () => {
  it('der gewählte, der der bestehenden Anlage, sonst der einzige — unter mehreren ohne Wahl keiner', () => {
    expect(anlegeStandort(ahrenbergFunktionen(), { standortId: FIXTURE_IDS.st2 })?.name).toBe('Werk Lindach');
    expect(anlegeStandort(ahrenbergFunktionen(), { anlageId: FIXTURE_IDS.an2 })?.name).toBe('Werk Ahrenberg');
    expect(anlegeStandort(nurLindach(), {})?.name).toBe('Werk Lindach');
    expect(anlegeStandort(ahrenbergFunktionen(), {})).toBeNull();
  });

  it('„Betrieb“ steht nur wie heute — nicht im Modus „nur messen“ und nicht, solange die Art offen ist', () => {
    expect(anlegeSchritte('wie_heute')).toEqual([...FLOW_STEPS]);
    expect(anlegeSchritte('nur_messen')).toEqual(['Anlage', 'Register', 'Gerät']);
    expect(anlegeSchritte('standort_zuerst')).toEqual(['Standort', 'Anlage', 'Register', 'Gerät']);
    expect(anlegeSchritte(null)).toEqual(['Anlage', 'Register', 'Gerät']);
  });

  it('Leerzustand: nur der Mess-Standort verliert Fahrplan und Erlöse; offen zeigt keinen Satz', () => {
    const heute = 'Live-Daten, Fahrplan und Erlöse';
    const messen = 'Messwerte und technischer Zustand';
    expect(anlageLeertext('nur_messen', heute, messen)).toBe(messen);
    expect(anlageLeertext('wie_heute', heute, messen)).toBe(heute);
    expect(anlageLeertext('standort_zuerst', heute, messen)).toBe(heute);
    expect(anlageLeertext(null, heute, messen)).toBeNull();
  });

  it('der Satz des Einrichtungs-Assistenten zählt die Schritte, die der Fluss zeigt', () => {
    expect(startklarSatz(anlegeSchritte('nur_messen').length)).toBe('In drei Schritten ist Ihre Anlage startklar.');
    expect(startklarSatz(anlegeSchritte('wie_heute').length)).toBe(STARTKLAR_SATZ);
  });

  it('„Zu den Messstellen“ führt zu „Standort › Messstellen“, ohne Standort zu „Unternehmen › Messstellen“', () => {
    expect(messstellenZiel(funktionWerkLindach())).toEqual(standortMessstellenRoute(FIXTURE_IDS.st2));
    expect(messstellenZiel(null)).toEqual(pageRoute('portfolio-messstellen'));
    expect(nurMessenWeiterSatz(funktionWerkLindach())).toBe(
      'So geht es weiter: Unter „Messstellen“ von Werk Lindach legen Sie fest, was gemessen wird.',
    );
  });
});

describe('die Wortliste', () => {
  it('die Sätze des Modus schweigen über Steuern und Geld', () => {
    for (const satz of [
      nurMessenWeiterSatz(funktionWerkLindach()),
      nurMessenWeiterSatz(null),
      ERSTE_DATEN_NUR_MESSEN,
      ZU_DEN_MESSSTELLEN,
    ]) {
      expect(steuerGeldWoerter(satz), satz).toEqual([]);
    }
  });

  it('beißt an den Sätzen, die der Modus ersetzt oder weglässt', () => {
    expect(steuerGeldWoerter(SETUP_NEXT_HINT)).toEqual(['steuer']);
    expect(steuerGeldWoerter('den optimierten Speicher-Fahrplan Ihrer Anlage')).toEqual(['optimier', 'fahrplan']);
    expect(steuerGeldWoerter(VERAEUSSERUNGSFORM_FRAGE)).toEqual(['vergüt']);
    expect(steuerGeldWoerter('Stromtarif, Vergütung, Netzladen und Einspeisegrenze')).toEqual([
      'netzladen',
      'einspeisegrenze',
      'tarif',
      'vergüt',
    ]);
    expect(steuerGeldWoerter('„gespart" beim Eigenverbrauch, „mehr verdient" bei der Direktvermarktung')).toEqual([
      'verdien',
      'gespart',
      'direktvermarkt',
    ]);
    expect(steuerGeldWoerter('Heute 12,40 €')).toEqual(['€']);
    expect(steuerGeldWoerter('Ohne Betriebsmodell fährt Ihr Speicher …')).toEqual(['betriebsmodell']);
  });

  it('lässt die Messwörter und Registernamen stehen, die keine Steuer- oder Geldwörter sind', () => {
    for (const satz of [
      'Quelle: Marktstammdaten',
      'In Betrieb seit 2023',
      'Das dauert in der Regel weniger als eine Minute.',
      'Einspeisung und Bezug am Netzanschluss',
      'Wechselrichter, Erzeuger und Verbraucher richten Sie direkt am Gerät ein',
    ]) {
      expect(steuerGeldWoerter(satz), satz).toEqual([]);
    }
  });

  it('ist klein geschrieben und doppelt nichts', () => {
    expect(STEUER_GELD_WOERTER.every((w) => w === w.toLocaleLowerCase('de-DE'))).toBe(true);
    expect(new Set(STEUER_GELD_WOERTER).size).toBe(STEUER_GELD_WOERTER.length);
  });
});
