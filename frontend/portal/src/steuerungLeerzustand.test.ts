import { describe, expect, it } from 'vitest';
import { NUR_MESSEN_TITEL, OHNE_STEUERBARE_KOMPONENTE, nurMessenLeerzustand } from './steuerungArea';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Der Leerzustand „Diese Anlage misst nur" der Steuerung (UEMS AP-01 IP-8,
 * Konzept §5.5, A8) — gegen das Referenzunternehmen Ahrenberg am 20.10.2026:
 * am Standort Werk Ahrenberg läuft „Steuern & Optimieren" mit Halle 1, Halle 2
 * misst nur (Ladepunkt „Parkplatz Halle 2"); Werk Lindach hat die Funktion
 * nicht und keine steuerbare Komponente.
 */

const { an1, an2, an3 } = FIXTURE_IDS;

describe('Fassung „Standort mit Funktion" — Halle 2 in Werk Ahrenberg', () => {
  it('nennt, was am Standort läuft, und den Schritt „aufnehmen" — als Hinweis, nicht als Knopf', () => {
    expect(
      nurMessenLeerzustand({ siteId: an2, funktionen: ahrenbergFunktionen(), steuerbar: ['Ladepunkt Parkplatz Halle 2'] }),
    ).toEqual({
      fassung: 'standort-mit-funktion',
      titel: 'Diese Anlage misst nur.',
      satz:
        'Am Standort Werk Ahrenberg läuft Steuern & Optimieren bereits (Werk Ahrenberg – Halle 1). '
        + 'Wenn VoltPilot „Ladepunkt Parkplatz Halle 2“ steuern soll, nehmen Sie diese Anlage auf — nichts schaltet, bevor Sie starten.',
      schritt: 'Werk Ahrenberg – Halle 2 aufnehmen',
      weg: null,
    });
  });

  it('eine angehaltene Funktion läuft nicht „bereits" — der Satz nennt ihren Zustand', () => {
    const f = ahrenbergFunktionen();
    const st = f.standorte[0];
    st.steuern.zustand = 'angehalten';
    st.steuern.text = 'Angehalten seit 03.11.2026 14:10';
    st.steuern.anlagen[0].teilnahme.zustand = 'angehalten';
    const leer = nurMessenLeerzustand({ siteId: an2, funktionen: f, steuerbar: ['Ladepunkt Parkplatz Halle 2'] });
    expect(leer?.satz).toMatch(/^Am Standort Werk Ahrenberg gibt es Steuern & Optimieren bereits \(Angehalten seit 03\.11\.2026 14:10\)\. /);
    expect(leer?.schritt).toBe('Werk Ahrenberg – Halle 2 aufnehmen');
  });
});

describe('Fassung „Standort ohne Funktion" — Werk Lindach', () => {
  it('A8: ohne steuerbare Komponente ist der Schritt „Gerät anbinden" — der einzige Weg mit heutigem Ziel', () => {
    expect(nurMessenLeerzustand({ siteId: an3, funktionen: ahrenbergFunktionen(), steuerbar: [] })).toEqual({
      fassung: 'standort-ohne-funktion',
      titel: NUR_MESSEN_TITEL,
      satz: OHNE_STEUERBARE_KOMPONENTE,
      schritt: 'Gerät anbinden',
      weg: 'geraet-anbinden',
    });
  });

  it('mit steuerbarer Komponente ist der Schritt „einrichten" — und nennt nie „keine", solange es unbekannt ist', () => {
    const leer = nurMessenLeerzustand({ siteId: an3, funktionen: ahrenbergFunktionen(), steuerbar: null });
    expect(leer).toEqual({
      fassung: 'standort-ohne-funktion',
      titel: NUR_MESSEN_TITEL,
      satz: 'Wenn VoltPilot hier steuern soll, richten Sie Steuern & Optimieren für Werk Lindach ein — nichts schaltet, bevor Sie starten.',
      schritt: 'Steuern & Optimieren für Werk Lindach einrichten',
      weg: null,
    });
    expect(leer?.satz).not.toContain('keine angebunden');
  });

  it('mehr als zwei Komponenten stehen nicht im Satz — dann heißt es „hier"', () => {
    const leer = nurMessenLeerzustand({ siteId: an3, funktionen: ahrenbergFunktionen(), steuerbar: ['A', 'B', 'C'] });
    expect(leer?.satz).toMatch(/^Wenn VoltPilot hier steuern soll/);
    expect(nurMessenLeerzustand({ siteId: an3, funktionen: ahrenbergFunktionen(), steuerbar: ['A', 'B'] })?.satz).toMatch(
      /^Wenn VoltPilot „A“ und „B“ steuern soll/,
    );
  });
});

describe('kein Leerzustand, wo die Anlage teilnimmt oder keinem Standort gehört', () => {
  it('Halle 1 steuert — ihre Steuerungsseite bleibt, wie sie ist', () => {
    expect(nurMessenLeerzustand({ siteId: an1, funktionen: ahrenbergFunktionen(), steuerbar: ['Speicher'] })).toBeNull();
  });

  it('jede Teilnahme zählt, auch eine angehaltene oder eine im Entwurf', () => {
    for (const zustand of ['entwurf', 'eingerichtet', 'angehalten', 'archiviert'] as const) {
      const f = ahrenbergFunktionen();
      f.standorte[0].steuern.anlagen[1].teilnahme.zustand = zustand;
      expect(nurMessenLeerzustand({ siteId: an2, funktionen: f, steuerbar: ['Ladepunkt Parkplatz Halle 2'] }), zustand).toBeNull();
    }
  });

  it('ohne Funktionen oder ohne Standort bleibt die Seite wie vorher', () => {
    expect(nurMessenLeerzustand({ siteId: an3, funktionen: null, steuerbar: [] })).toBeNull();
    expect(nurMessenLeerzustand({ siteId: 'fremd', funktionen: ahrenbergFunktionen(), steuerbar: [] })).toBeNull();
  });
});
