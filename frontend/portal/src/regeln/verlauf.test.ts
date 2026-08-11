import { describe, expect, it } from 'vitest';
import {
  MAX_ZEILEN_GESAMT,
  MAX_ZEILEN_JE_REGEL,
  VERLAUF_LEER,
  aktivitaetZeile,
  ereignisZeile,
  ereignisseFuer,
  genauigkeitsNote,
  karteSchluessel,
  protokoll,
  uhrzeit,
  verlaufAbschnitt,
} from './verlauf';
import type { RuleEvent, RuleEvents } from '../api';

/**
 * Das Regel-Protokoll an der Fläche (Stufe 5b). Geprüft wird vor allem, was die
 * Fläche NICHT behauptet: keine 0 ohne Beleg, kein geratenes Wort, keine
 * geratene Regel.
 */

const WALLBOX = '11111111-1111-1111-1111-111111111111';
const FLOW = '33333333-3333-3333-3333-333333333333';

function ev(over: Partial<RuleEvent> = {}): RuleEvent {
  return {
    id: 1,
    ruleKind: 'rezept',
    ruleRef: WALLBOX,
    entityId: WALLBOX,
    kind: 'gestartet',
    state: 'running_optimized',
    previousState: 'waiting',
    reasonCode: null,
    actualKw: null,
    detail: null,
    occurredAt: '2026-08-11T12:02:00Z',
    ...over,
  };
}

function daten(over: Partial<RuleEvents> = {}): RuleEvents {
  return {
    recordingSince: '2026-08-10T08:00:00Z',
    accuracySeconds: 15,
    countsToday: true,
    rules: [],
    events: [],
    ...over,
  };
}

describe('aktivitaetZeile', () => {
  it('nennt den Zähler, wenn der Server ihn belegt hat', () => {
    expect(aktivitaetZeile({ switchedToday: 3, lastSwitchedAt: null }, '2026-08-10T08:00:00Z'))
      .toBe('heute 3× geschaltet');
    expect(aktivitaetZeile({ switchedToday: 1, lastSwitchedAt: null }, null))
      .toBe('heute 1× geschaltet');
  });

  it('eine BELEGTE 0 ist eine Aussage und wird ausgesprochen', () => {
    expect(aktivitaetZeile({ switchedToday: 0, lastSwitchedAt: null }, null))
      .toBe('heute noch nicht geschaltet');
  });

  it('ohne belastbaren Zähler nennt sie den Beginn der Aufzeichnung statt einer 0', () => {
    const zeile = aktivitaetZeile(
      { switchedToday: null, lastSwitchedAt: null },
      new Date(2026, 7, 11, 14, 5).toISOString(),
    );
    expect(zeile).toBe('seit 14:05 aufgezeichnet');
    // Und ausdrücklich KEIN Zähler - weder eine 0 noch ein „×".
    expect(zeile).not.toContain('geschaltet');
    expect(zeile).not.toContain('×');
  });

  it('ohne alles behauptet sie GAR NICHTS', () => {
    expect(aktivitaetZeile({ switchedToday: null, lastSwitchedAt: null }, null)).toBeNull();
    expect(aktivitaetZeile(null, null)).toBeNull();
    expect(aktivitaetZeile(undefined, undefined)).toBeNull();
  });

  it('eine Regel OHNE Ereignis nennt die BELEGTE 0, wenn der Server den Tag zaehlt', () => {
    expect(aktivitaetZeile(null, '2026-08-10T08:00:00Z', true))
      .toBe('heute noch nicht geschaltet');
    // Ohne dieses Flag waere es eine Behauptung - dann nennt sie den Beginn.
    expect(aktivitaetZeile(null, new Date(2026, 7, 11, 10, 0).toISOString(), false))
      .toBe('seit 10:00 aufgezeichnet');
  });

  it('hängt „zuletzt HH:MM" an, wenn ein Schaltvorgang belegt ist', () => {
    const at = new Date(2026, 7, 11, 14, 2).toISOString();
    expect(aktivitaetZeile({ switchedToday: 3, lastSwitchedAt: at }, null))
      .toBe('heute 3× geschaltet · zuletzt 14:02');
  });

  it('ein unlesbarer Zeitstempel wird weggelassen, nie als „Invalid Date" gerendert', () => {
    expect(aktivitaetZeile({ switchedToday: 2, lastSwitchedAt: 'kaputt' }, null))
      .toBe('heute 2× geschaltet');
    expect(uhrzeit('kaputt')).toBeNull();
    expect(uhrzeit(null)).toBeNull();
  });
});

describe('ereignisZeile', () => {
  it('spricht Zeit, Handlung, Messwert und Grund', () => {
    const zeile = ereignisZeile(ev({
      occurredAt: new Date(2026, 7, 11, 12, 2).toISOString(),
      actualKw: 7.4,
      reasonCode: 'price_below_threshold',
    }));
    expect(zeile).toContain('12:02');
    expect(zeile).toContain('gestartet');
    expect(zeile).toContain('7,4');
    expect(zeile).toContain('Günstiger Strompreis');
  });

  it('ein NICHT gemessener Wert erscheint gar nicht — nie eine 0', () => {
    expect(ereignisZeile(ev({ actualKw: null }))).not.toContain('0,0');
    // Und ein Wert im Totband ebenso wenig.
    expect(ereignisZeile(ev({ actualKw: 0.01 }))).not.toContain('kW');
  });

  it('ein unbekannter GRUND wird weggelassen statt geraten', () => {
    expect(ereignisZeile(ev({ reasonCode: 'brandneues_wort' })))
      .not.toContain('brandneues_wort');
  });

  it('ein Zustandswechsel spricht das Zustands-Wort', () => {
    expect(ereignisZeile(ev({ kind: 'zustand', state: 'clamped' })))
      .toContain('Begrenzt · Schutz/Netzvorgabe');
  });

  it('eine unbekannte ART und ein unbekannter ZUSTAND erzeugen KEINE Zeile', () => {
    expect(ereignisZeile(ev({ kind: 'irgendwas_neues' }))).toBeNull();
    expect(ereignisZeile(ev({ kind: 'zustand', state: 'brandneu' }))).toBeNull();
  });

  it('das Ausrollen nennt seine Version aus dem Server-Detail', () => {
    const zeile = ereignisZeile(ev({
      kind: 'ausgerollt', ruleKind: 'flow', ruleRef: FLOW, entityId: null,
      state: 'active', detail: 'v2 → v3',
    }));
    expect(zeile).toContain('auf das Gerät ausgerollt');
    expect(zeile).toContain('v2 → v3');
  });
});

describe('karteSchluessel + ereignisseFuer', () => {
  it('bildet den Kartenschlüssel je Regel-Art', () => {
    expect(karteSchluessel('rezept', WALLBOX)).toBe(`rezept:${WALLBOX}`);
    expect(karteSchluessel('flow', FLOW)).toBe(`flow:${FLOW}`);
    expect(karteSchluessel(null, WALLBOX)).toBeNull();
    expect(karteSchluessel('rezept', null)).toBeNull();
  });

  it('filtert die Ereignisse EINER Regel und lässt fremde liegen', () => {
    const events = [
      ev({ id: 1 }),
      ev({ id: 2, ruleKind: 'flow', ruleRef: FLOW }),
      ev({ id: 3, ruleKind: null, ruleRef: null }),
    ];
    expect(ereignisseFuer(events, `rezept:${WALLBOX}`).map((e) => e.id)).toEqual([1]);
    expect(ereignisseFuer(events, `flow:${FLOW}`).map((e) => e.id)).toEqual([2]);
  });
});

describe('verlaufAbschnitt', () => {
  it('nennt ohne Ereignis den ehrlichen Satz UND seit wann aufgezeichnet wird', () => {
    const a = verlaufAbschnitt([], `rezept:${WALLBOX}`,
      daten({ recordingSince: new Date(2026, 7, 11, 8, 30).toISOString() }));
    expect(a.zeilen).toEqual([]);
    expect(a.note).toContain(VERLAUF_LEER);
    expect(a.note).toContain('seit 08:30');
  });

  it('ohne jede Aufzeichnung bleibt es beim nackten Satz', () => {
    const a = verlaufAbschnitt([], `rezept:${WALLBOX}`, daten({ recordingSince: null }));
    expect(a.note).toBe(VERLAUF_LEER);
  });

  it('nennt die Genauigkeit AN der Fläche, sobald etwas dasteht', () => {
    const a = verlaufAbschnitt([ev()], `rezept:${WALLBOX}`, daten());
    expect(a.zeilen).toHaveLength(1);
    expect(a.note).toContain('15-Sekunden-Takt');
    expect(a.note).toContain('unsichtbar');
  });

  it('deckelt die Zeilen des Einschubs', () => {
    const viele = Array.from({ length: MAX_ZEILEN_JE_REGEL + 5 }, (_, i) => ev({ id: i + 1 }));
    expect(verlaufAbschnitt(viele, `rezept:${WALLBOX}`, daten()).zeilen)
      .toHaveLength(MAX_ZEILEN_JE_REGEL);
  });

  it('eine unbekannte Ereignis-Art fällt heraus, statt eine leere Zeile zu erzeugen', () => {
    const a = verlaufAbschnitt([ev({ kind: 'nagelneu' })], `rezept:${WALLBOX}`, daten());
    expect(a.zeilen).toEqual([]);
  });
});

describe('protokoll', () => {
  it('nennt je Zeile die Regel — und ein unzuordenbares Ereignis bleibt sichtbar', () => {
    const view = protokoll(
      daten({ events: [ev({ id: 1 }), ev({ id: 2, ruleKind: null, ruleRef: null })] }),
      { [`rezept:${WALLBOX}`]: 'Wallbox Hof' },
    );
    expect(view.zeilen).toHaveLength(2);
    expect(view.zeilen[0].regel).toBe('Wallbox Hof');
    expect(view.zeilen[1].regel).toBeNull();
    expect(view.leer).toBeNull();
  });

  it('tönt nur ein Problem und den Deckel-Vermerk bernstein', () => {
    const view = protokoll(daten({
      events: [
        ev({ id: 1, kind: 'geraet_problem', ruleKind: 'flow', ruleRef: FLOW, state: 'error' }),
        ev({ id: 2, kind: 'protokoll_gedeckelt', ruleKind: null, ruleRef: null }),
        ev({ id: 3 }),
      ],
    }), {});
    expect(view.zeilen.map((z) => z.ton)).toEqual(['warn', 'warn', 'plain']);
    expect(view.zeilen[1].text).toContain('nicht weiter protokolliert');
  });

  it('sagt ohne Ereignisse ehrlich, dass (noch) nichts vorliegt', () => {
    const view = protokoll(
      daten({ recordingSince: new Date(2026, 7, 11, 9, 15).toISOString() }), {});
    expect(view.zeilen).toEqual([]);
    expect(view.leer).toContain('seit 09:15');
    expect(view.note).toBeNull();
  });

  it('ohne Daten überhaupt (älteres Backend) bleibt es beim ehrlichen Satz', () => {
    const view = protokoll(null, {});
    expect(view.zeilen).toEqual([]);
    expect(view.leer).toBe('Für diese Anlage wird noch kein Verlauf aufgezeichnet.');
  });

  it('deckelt das Gesamt-Protokoll', () => {
    const viele = Array.from({ length: MAX_ZEILEN_GESAMT + 10 }, (_, i) => ev({ id: i + 1 }));
    expect(protokoll(daten({ events: viele }), {}).zeilen).toHaveLength(MAX_ZEILEN_GESAMT);
  });
});

describe('genauigkeitsNote', () => {
  it('behauptet ohne Angabe keine Genauigkeit', () => {
    expect(genauigkeitsNote(null)).toBeNull();
    expect(genauigkeitsNote(0)).toBeNull();
    expect(genauigkeitsNote(undefined)).toBeNull();
  });
});
