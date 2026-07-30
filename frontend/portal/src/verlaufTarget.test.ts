import { describe, expect, it } from 'vitest';
import { verlaufRangeForCockpit, widgetTarget } from './verlaufTarget';

/**
 * V2 — „Eine Kachel ist ein Absprung" (`data/vp-portal-livedata-design/report.md`
 * §1 + §4), verschlankt durch den Cockpit+Live-Merge (Option A,
 * `data/vp-cockpit-live-merge-design/report.md` §6 M2): die vier Fluss-Kacheln
 * sind aus dem Raster genommen — das Komponenten-Board ist die EINE
 * Live-Wert-Fläche, seine Zeilen springen selbst (mit Zeitraum-Übernahme).
 * Übrig: die Geld-/Modus-Kacheln per Tabelle, und die Zeitraum-Übernahme.
 */

describe('widgetTarget — Geld-/Modus-Kacheln bilden auf ihre Seite ab', () => {
  it('folgt der Abbildungstabelle (report §1)', () => {
    expect(widgetTarget('eigenverbrauch')).toEqual({ kind: 'sub', sub: 'messwerte' });
    expect(widgetTarget('erloes')).toEqual({ kind: 'sub', sub: 'erloese' });
    expect(widgetTarget('handel')).toEqual({ kind: 'sub', sub: 'fahrplan' });
    expect(widgetTarget('lastspitze')).toEqual({ kind: 'sub', sub: 'lastspitzen' });
    expect(widgetTarget('automatik')).toEqual({ kind: 'sub', sub: 'steuerung' });
    expect(widgetTarget('wetter')).toEqual({ kind: 'sub', sub: 'wetter' });
  });
});

describe('verlaufRangeForCockpit — Zeitraum-Übernahme (Board-Zeilen-Sprünge)', () => {
  it('Heute→Tag, Monat→Monat, Jahr→Jahr, Gesamt→Jahr', () => {
    expect(verlaufRangeForCockpit('day')).toBe('day');
    expect(verlaufRangeForCockpit('month')).toBe('month');
    expect(verlaufRangeForCockpit('year')).toBe('year');
    // Der Explorer hat keinen All-Zeit-Bereich → Gesamt landet auf Jahr.
    expect(verlaufRangeForCockpit('all')).toBe('year');
  });
});
