import { describe, expect, it } from 'vitest';
import { auslegungSaetze, boxSpalten } from './adminGemeinsameSteuerung';
import type { UemsGemeinsameSteuerungEinrichten } from './api';
import { boxNamen, boxZeilen, einspeisungUnbegrenzt, urteilSatz, zustandsZeile } from './gemeinsameSteuerungFlaeche';
import { gsBlatt } from './test/betreiberblattFixtures';
import { GS_IDS, gsBoxen, gsEingerichtet, gsZustand } from './test/gemeinsameSteuerungFixtures';

/**
 * AP-15 Folge zu PR 1149: Cloud, Box und Planer kennen „keine Einspeisegrenze“ — das Portal sagt es jetzt auch. Drei
 * Zustände je Fläche: Grenze gesetzt (Ahrenberg 100 kW), ausdrücklich keine (`einspeisung_keine`, Einspeisung
 * unbegrenzt, nur der Bezug wird aufgeteilt) und nicht eingetragen (unbekannt — weiter „nicht rechenbar“).
 */
const JETZT = new Date('2027-06-15T11:40:00Z');
const UNBEGRENZT = 'Einspeisung unbegrenzt — nur der Bezug wird aufgeteilt.';

function ohneEinspeisegrenze(keine: boolean): UemsGemeinsameSteuerungEinrichten {
  const e = gsEingerichtet();
  return {
    ...e,
    grenzen: { einspeisung_kw: null, bezug_kw: 550, einspeisung_keine: keine },
    ergebnis: { einspeisung: null, bezug: e.ergebnis!.bezug },
  };
}
const GESETZT = gsEingerichtet();
const KEINE = ohneEinspeisegrenze(true);
const UNBEKANNT = ohneEinspeisegrenze(false);

describe('Einspeisung unbegrenzt — die drei Zustände der Einspeisegrenze', () => {
  it('nur das ausdrückliche „keine“ ist unbegrenzt; ein Wert gewinnt, ein fehlender Wert bleibt unbekannt', () => {
    expect(einspeisungUnbegrenzt(GESETZT)).toBe(false);
    expect(einspeisungUnbegrenzt(KEINE)).toBe(true);
    expect(einspeisungUnbegrenzt(UNBEKANNT)).toBe(false);
    expect(einspeisungUnbegrenzt({ ...KEINE, grenzen: { ...KEINE.grenzen!, einspeisung_kw: 80 } })).toBe(false);
    expect(einspeisungUnbegrenzt(null)).toBe(false);
  });

  it('Frage 6: „Passt die Anlage zur Grenze?“ — unbegrenzt statt „noch nicht zu rechnen“', () => {
    expect(urteilSatz(GESETZT.ergebnis!.einspeisung, einspeisungUnbegrenzt(GESETZT)))
      .toBe('Ja — die Anlage passt zur Grenze am Netzanschluss.');
    expect(urteilSatz(KEINE.ergebnis!.einspeisung, einspeisungUnbegrenzt(KEINE))).toBe(UNBEGRENZT);
    expect(urteilSatz(UNBEKANNT.ergebnis!.einspeisung, einspeisungUnbegrenzt(UNBEKANNT)))
      .toBe('Noch nicht zu rechnen — dafür fehlen Angaben aus den Fragen davor.');
  });

  it('Karte: die Zustandszeile nennt die unbegrenzte Einspeisung', () => {
    const namen = boxNamen(gsBoxen(JETZT), GESETZT);
    const z = gsZustand('anteile_aktiv');
    expect(zustandsZeile(z, GESETZT, namen))
      .toBe('Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung höchstens 100 kW · Bezug höchstens 550 kW');
    expect(zustandsZeile(z, KEINE, namen))
      .toBe('Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung unbegrenzt · Bezug höchstens 550 kW');
    expect(zustandsZeile(z, UNBEKANNT, namen)).toBe('Gemeinsame Steuerung aktiv');
  });

  it('Box-Zeile der mitsteuernden Box: nur der Bezug ist ihr Anteil', () => {
    const namen = boxNamen(gsBoxen(JETZT), GESETZT);
    const nurBezug = { e1: { einspeisung_kw: null, bezug_kw: 0 }, e4: { einspeisung_kw: null, bezug_kw: 77 } };
    const aktiv = gsZustand('anteile_aktiv', null, { wirksam: nurBezug });
    expect(boxZeilen(gsZustand('anteile_aktiv'), GESETZT, namen, new Map(), 'B')[1].text)
      .toBe('Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 60 kW · Bezug 77 kW');
    expect(boxZeilen(aktiv, KEINE, namen, new Map(), 'B')[1].text)
      .toBe('Box Verwaltung steuert mit · hält ihren Anteil: Bezug 77 kW · Einspeisung unbegrenzt');
    expect(boxZeilen(gsZustand('beobachtet'), KEINE, namen, new Map(), 'B')[1].text)
      .toBe('Box Verwaltung steuert mit, sobald VoltPilot freischaltet · vorgesehener Anteil: Bezug 77 kW · Einspeisung unbegrenzt');
    expect(boxZeilen(aktiv, UNBEKANNT, namen, new Map(), 'B')[1].text).toBe('Box Verwaltung steuert mit');
  });

  it('Betreiber-Blatt: Auslegung, Wächter und wirksamer Anteil der Einspeisung', () => {
    expect(auslegungSaetze(GESETZT)[0]).toMatch(/^Einspeisung: Grenze 100 kW .* — passt\.$/);
    expect(auslegungSaetze(KEINE)[0]).toBe(UNBEGRENZT);
    expect(auslegungSaetze(KEINE)[1]).toMatch(/^Bezug: Grenze 550 kW/);
    expect(auslegungSaetze(UNBEKANNT)[0]).toBe('Einspeisung: nicht rechenbar — unbekannt ist nicht „passt“.');

    const namen = new Map([[GS_IDS.e1, 'Halle 1'], [GS_IDS.e4, 'Verwaltung']]);
    const blatt = gsBlatt('s1', JETZT);
    blatt.boxen[0] = { ...blatt.boxen[0], waechter: { einspeisung: 'aus', bezug: 'ueberwacht' },
      anteile: { ...blatt.boxen[0].anteile, wirksam_kw: { bezug: 550 } } };
    const [keine] = boxSpalten(blatt, KEINE, namen, JETZT);
    expect(keine.waechter.einspeisung).toEqual({ text: 'aus · Einspeisung unbegrenzt' });
    expect(keine.wirksam.einspeisung).toEqual({ text: 'unbegrenzt' });
    const [unbekannt] = boxSpalten(blatt, UNBEKANNT, namen, JETZT);
    expect(unbekannt.waechter.einspeisung).toMatchObject({ text: 'aus', warnung: true });
    expect(unbekannt.wirksam.einspeisung).toMatchObject({ unbekannt: true });
  });
});
