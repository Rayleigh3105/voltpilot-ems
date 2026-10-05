import { describe, expect, it } from 'vitest';
import type { FunktionTeilnahme, Funktionen } from '../api';
import { RUHE_VERBINDUNG_HINWEIS } from '../ruheHinweis';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { OHNE_FUNKTION, funktionsLage } from './funktion';

/** Halle 1 (Werk Ahrenberg) in einem anderen Zustand. */
function halle1(t: Partial<FunktionTeilnahme>): Funktionen {
  const f = structuredClone(ahrenbergFunktionen());
  Object.assign(f.standorte[0].steuern.anlagen[0].teilnahme, t);
  return f;
}

describe('funktionsLage', () => {
  it('ohne Antwort behauptet die Seite nichts (unbekannt ist kein Zustand)', () => {
    expect(funktionsLage(null, FIXTURE_IDS.an1)).toEqual(OHNE_FUNKTION);
    expect(funktionsLage(ahrenbergFunktionen(), 'fremde-anlage')).toEqual(OHNE_FUNKTION);
  });

  it('aktiv: keine Ruhe, keine Sperre, kein Band', () => {
    const l = funktionsLage(ahrenbergFunktionen(), FIXTURE_IDS.an1);
    expect(l).toMatchObject({ zustand: 'aktiv', standortId: FIXTURE_IDS.st1, ruht: false, ohneTeilnahme: false, einstieg: false });
    expect([l.plakette, l.satz, l.sperre]).toEqual([null, null, null]);
  });

  it('angehalten: Plakette mit Tag, Band im Wortlaut der Variante A (SZ-2), Regeln wirken nicht, Eingriffe gesperrt', () => {
    const l = funktionsLage(halle1({ zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00', aktionen: ['fortsetzen', 'beenden'] }), FIXTURE_IDS.an1);
    expect(l.ruht).toBe(true);
    expect(l.angehalten).toBe(true);
    expect(l.plakette).toBe('Angehalten seit 03.11.');
    expect(l.satz).toBe('Steuerung angehalten seit 03.11.2026 14:10');
    expect(l.folge).toBe('VoltPilot sendet keine Sollwerte. Regeln und das Betriebsmodell des Speichers wirken nicht, bis Sie fortsetzen. Schutzgrenzen gelten weiter.');
    expect(l.wirktNicht).toBe('wirkt nicht — angehalten seit 03.11.2026 14:10');
    expect(l.sperre).toBe('Eingriffe und Pause gibt es wieder, sobald die Steuerung fortgesetzt ist.');
    expect(l.ohneTeilnahme).toBe(false);
    expect([l.fortsetzenMoeglich, l.anhaltenMoeglich]).toEqual([true, false]);
  });

  it('SZ-2 A: ob „Bis ich fortsetze“ bzw. „Fortsetzen“ angeboten wird, sagt der Server (aktionen)', () => {
    const aktiv = funktionsLage(halle1({ aktionen: ['anhalten', 'beenden'], ruhe_hinweis: { jetzt: false, beim_anhalten: true } }), FIXTURE_IDS.an1);
    expect(aktiv).toMatchObject({ anhaltenMoeglich: true, fortsetzenMoeglich: false, ruheHinweisBeimAnhalten: true, angehalten: false, wirktNicht: null });
    const ohne = funktionsLage(halle1({ aktionen: [] }), FIXTURE_IDS.an1);
    expect([ohne.anhaltenMoeglich, ohne.fortsetzenMoeglich]).toEqual([false, false]);
    // Eingerichtet und beendet sind Ruhe, aber nicht „angehalten“: nichts wird abgedimmt.
    expect(funktionsLage(halle1({ zustand: 'eingerichtet', seit: null }), FIXTURE_IDS.an1).angehalten).toBe(false);
    expect(funktionsLage(halle1({ zustand: 'archiviert', seit: null }), FIXTURE_IDS.an1).angehalten).toBe(false);
  });

  it('eingerichtet und entwurf: „Noch nicht gestartet“ statt „Automatik an“', () => {
    const e = funktionsLage(halle1({ zustand: 'eingerichtet', seit: '2026-10-01T09:00:00+02:00' }), FIXTURE_IDS.an1);
    expect(e).toMatchObject({ ruht: true, plakette: 'Noch nicht gestartet', satz: 'Eingerichtet am 01.10.2026 — Steuerung noch nicht gestartet' });
    expect(e.sperre).toBe('Eingriffe und Pause gibt es, sobald die Steuerung gestartet ist.');
    const w = funktionsLage(halle1({ zustand: 'entwurf', seit: null }), FIXTURE_IDS.an1);
    expect(w).toMatchObject({ ruht: true, plakette: 'Noch nicht gestartet', satz: 'Noch nicht eingerichtet — Steuerung noch nicht gestartet' });
    expect(w.sperre).not.toBeNull();
  });

  it('beendet: ruht weiter (beenden schreibt die Ruhe) und nimmt nicht mehr teil - ohne Einstieg', () => {
    const l = funktionsLage(halle1({ zustand: 'archiviert', seit: '2026-11-04T08:00:00+01:00', text: 'Steuerung beendet am 04.11.2026' }), FIXTURE_IDS.an1);
    expect(l).toMatchObject({ ruht: true, ohneTeilnahme: true, einstieg: false, plakette: 'Steuerung beendet', satz: 'Steuerung beendet am 04.11.2026' });
    expect(l.sperre).not.toBeNull();
  });

  it('kein Objekt: Einstieg, keine Ruhe, keine Sperre (Steuern-Regel #779 / #965)', () => {
    const l = funktionsLage(ahrenbergFunktionen(), FIXTURE_IDS.an3);
    expect(l).toMatchObject({ zustand: 'kein_objekt', ohneTeilnahme: true, einstieg: true, ruht: false, sperre: null, plakette: null, satz: null });
    expect(l.standortId).toBe(FIXTURE_IDS.st2);
  });

  it('der Ruhe-Satz der älteren Box nur in Ruhe und nur, wenn der Server ihn jetzt verlangt (#986)', () => {
    const ruhe = { zustand: 'angehalten' as const, seit: '2026-11-03T14:10:00+01:00' };
    expect(funktionsLage(halle1({ ...ruhe, ruhe_hinweis: { jetzt: true, beim_anhalten: false } }), FIXTURE_IDS.an1).ruheHinweis).toBe(true);
    expect(funktionsLage(halle1({ ...ruhe, ruhe_hinweis: { jetzt: false, beim_anhalten: false } }), FIXTURE_IDS.an1).ruheHinweis).toBe(false);
    expect(funktionsLage(halle1({ ...ruhe, ruhe_hinweis: undefined }), FIXTURE_IDS.an1).ruheHinweis).toBe(false);
    expect(funktionsLage(halle1({ ruhe_hinweis: { jetzt: true, beim_anhalten: true } }), FIXTURE_IDS.an1).ruheHinweis).toBe(false);
    expect(RUHE_VERBINDUNG_HINWEIS).toBe('Diese Box hält die Ruhe nur, solange sie mit VoltPilot verbunden ist.');
  });
});
