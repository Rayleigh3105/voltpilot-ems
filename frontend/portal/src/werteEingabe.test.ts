import { expect, it } from 'vitest';
import { letzteFreiePeriode, monatsZuordnung, periodenFehler, wertFehler, wirksameAblesungen } from './werteEingabe';
import type { Ablesung, BezugsgroesseWert } from './api';
it('wählt die letzte abgeschlossene Periode ohne Wert, auch über Jahresgrenzen', () => {
  expect(letzteFreiePeriode('2026-11-03', 'monat', [{ periode_von: '2026-10-01' } as BezugsgroesseWert])).toBe('2026-09');
  expect(letzteFreiePeriode('2027-01-01', 'jahr', [])).toBe('2026');
  expect(periodenFehler('2026-11', 'monat', '2026-11-03')).toContain('nicht zu Ende');
  expect(periodenFehler('2026-13', 'monat', '2027-01-03')).not.toBeNull();
});
it('verlangt ganze Stückzahlen und erhält die Null als Eingabe', () => {
  expect(wertFehler('1.234,5', 'kg')).toBeNull();
  expect(wertFehler('1.234,5', 'Stück')).toBe('Stück sind ganze Zahlen.');
  expect(wertFehler('-2', 'kg')).toBe('Mengen sind nicht negativ.');
  expect(wertFehler('0', 'kg')).toBeNull();
});
it('Z6 kommt aus dem Vertragszwilling, bei drei Monaten gibt es keine Vorgabe', () => {
  const alt = { zeitpunkt: '2026-10-01T07:15:00+02:00', fassung: 1 } as Ablesung;
  const z = monatsZuordnung([alt], '2026-11-02T07:40:00+01:00', 'Europe/Berlin')!;
  expect(z.vorgabe).toBe('2026-10'); expect(z.dauerText).toBe('32 Tage 1 h 25 min');
  expect(monatsZuordnung([alt], '2026-12-02T07:40:00+01:00', 'Europe/Berlin')!.vorgabe).toBeNull();
  expect(monatsZuordnung([], alt.zeitpunkt, 'Europe/Berlin')).toBeNull();
  expect(wirksameAblesungen([alt, { ...alt, fassung: 2 }])).toEqual([{ ...alt, fassung: 2 }]);
});
