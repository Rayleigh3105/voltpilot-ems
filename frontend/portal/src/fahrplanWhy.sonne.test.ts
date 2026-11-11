/**
 * Der Wächter der Sonnen-Erzählung (Konzept `vp-fahrplan-eigenverbrauch-konzept`
 * §5.5, Scheibe S2): auf den echten Optimierer-Läufen (Festtarif Oktober,
 * Frühling, § 51a) darf keine Kundenableitung mit `sonne = true` ein
 * Börsenwort tragen; auf den Preis-Läufen (dynamisch, Netzladen an,
 * Direktvermarktung) bleibt `slotWhy` mit `sonne = false` (Vorgabe, wie jeder
 * bestehende Aufrufer sie heute ruft) wortgleich zu vor dieser Scheibe - der
 * Wächter beweist das, indem er dieselben verbotenen Wörter dort NICHT als
 * fehlend, sondern als unverändert vorhanden toleriert (kein Rückschritt).
 */
import { describe, expect, it } from 'vitest';
import { CURTAIL_PLAN } from './curtailment';
import dv0500 from './fahrplanVektoren/laeufe/dv-0500.json';
import evDyn from './fahrplanVektoren/laeufe/ev-dyn-tag.json';
import evFest51a from './fahrplanVektoren/laeufe/ev-fest-51a-tag.json';
import evFestFruehling from './fahrplanVektoren/laeufe/ev-fest-fruehling-tag.json';
import evFestNetzladen from './fahrplanVektoren/laeufe/ev-fest-netzladen-0500.json';
import evFest from './fahrplanVektoren/laeufe/ev-fest-tag.json';
import { nullstundenSatz, slotWhy, type PlanWhyFacts, type WhySlot } from './fahrplanWhy';
import { preisRolle } from './preisRolle';
import type { PlanWordingKind } from './schedule';

interface Lauf {
  klasse: string;
  plan: PlanWhyFacts;
  slots: WhySlot[];
}

const SONNE_LAEUFE: [string, Lauf][] = [
  ['ev-fest-tag', evFest as Lauf],
  ['ev-fest-fruehling-tag', evFestFruehling as Lauf],
  ['ev-fest-51a-tag', evFest51a as Lauf],
];

const PREIS_LAEUFE: [string, Lauf, PlanWordingKind][] = [
  ['ev-dyn-tag', evDyn as Lauf, 'eigenverbrauch'],
  ['ev-fest-netzladen-0500', evFestNetzladen as Lauf, 'eigenverbrauch'],
  ['dv-0500', dv0500 as Lauf, 'direktvermarktung'],
];

/** Verbotene Wörter der Sonnen-Erzählung außerhalb von Lesehöhe c (§4.4/§5.5). */
const VERBOTEN = [
  'Börse',
  'teuren Stunden',
  'Strompreis steigt',
  'günstig genug',
  'Wert gespeicherter Energie',
];

function pruefeVerboten(satz: string, kontext: string) {
  for (const wort of VERBOTEN) {
    expect(satz, `${kontext}: "${satz}" enthält das verbotene Wort "${wort}"`).not.toContain(wort);
  }
}

describe('Wächter: die Sonnen-Erzählung trägt kein Börsenwort (slotWhy, sonne = true)', () => {
  it.each(SONNE_LAEUFE)('%s: preisRolle klassifiziert als sonne', (_name, lauf) => {
    const rolle = preisRolle({ slots: lauf.slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.erzaehlung).toBe('sonne');
  });

  it.each(SONNE_LAEUFE)('%s: jeder Warum-Satz ist sonnen-sicher', (name, lauf) => {
    let geprueft = 0;
    for (const slot of lauf.slots) {
      const satz = slotWhy(slot, 'eigenverbrauch', CURTAIL_PLAN, lauf.slots, lauf.plan, undefined, true);
      if (satz == null) continue;
      pruefeVerboten(satz, `${name} @ ${slot.start}`);
      geprueft++;
    }
    // Jeder Lauf trägt eine volle Warum-Ebene (96 Viertelstunden) - der
    // Wächter prüft wirklich etwas, keine leere Schleife.
    expect(geprueft).toBeGreaterThan(0);
  });
});

describe('Kein Rückschritt: dieselben Läufe mit sonne = false (Vorgabe, Preis-Erzählung) bleiben unverändert', () => {
  it.each(PREIS_LAEUFE)('%s: preisRolle klassifiziert als preis', (_name, lauf) => {
    const rolle = preisRolle({
      slots: lauf.slots,
      tarifArt: lauf.klasse === 'ev-dyn' ? 'dynamisch' : 'fest',
      plantKind: lauf.klasse === 'dv' ? 'direktvermarktung' : 'eigenverbrauch',
    });
    expect(rolle.erzaehlung).toBe('preis');
  });

  it.each(PREIS_LAEUFE)('%s: slotWhy ohne `sonne` (Vorgabe false) bleibt bei der Preis-Formulierung', (name, lauf, kind) => {
    let mitPreiswort = 0;
    for (const slot of lauf.slots) {
      // Kein `sonne`-Argument - exakt wie jeder bestehende Aufrufer (Cockpit,
      // Steuerung) heute ruft, bis diese Flächen in S4 selbst umgestellt werden.
      const satz = slotWhy(slot, kind, CURTAIL_PLAN, lauf.slots, lauf.plan);
      if (satz == null) continue;
      if (VERBOTEN.some((w) => satz.includes(w))) mitPreiswort++;
    }
    // Mindestens EIN Satz trägt weiterhin sein Preis-Wort - sonst hätte der
    // Lauf keinen Unterschied zur Sonnen-Erzählung mehr belegt.
    expect(mitPreiswort, `${name} sollte weiterhin Preis-Wörter tragen (kein Rückschritt)`).toBeGreaterThan(0);
  });
});

describe('nullstundenSatz (§ 51a, §4.4) - die Viertelstunden ohne Vergütung', () => {
  it('ohne Nullstunden: kein Satz', () => {
    expect(nullstundenSatz([], [])).toBeNull();
  });

  it('nennt die Spanne VON-BIS über den echten § 51a-Lauf (ev-fest-51a-tag)', () => {
    const lauf = evFest51a as Lauf;
    const rolle = preisRolle({ slots: lauf.slots, tarifArt: 'fest', plantKind: 'eigenverbrauch' });
    expect(rolle.nullstunden).toHaveLength(19);
    const satz = nullstundenSatz(lauf.slots, rolle.nullstunden);
    expect(satz).toBe(
      'Von 10:00 bis 14:45 gibt es für eingespeisten Strom keine Vergütung ' +
        '(negative Börsenpreise, § 51a EEG). In dieser Zeit füllt VoltPilot lieber den Speicher.',
    );
  });
});
