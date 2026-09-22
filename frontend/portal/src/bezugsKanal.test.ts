import { describe, expect, it } from 'vitest';
import { periodeGebunden, kanalRegelText, wertKennzeichen } from './bezugsKanal';
import { bindungsRegel } from './components/BezugsKanalbindung';
import type { BezugsKanalbindung } from './api';
const b: BezugsKanalbindung = { id: 'b', entity_id: 'e', kanal: 'Temperatur', wertart: 'gauge', von: '2026-10-31T23:00:00Z', bis: null, raumtemperatur: 20, heizgrenze: 15 };
describe('K6/K7 · Zeitraum und Regel', () => {
  it('sperrt halboffen in der Ortszone und schließt den letzten Periodentag ein', () => {
    expect(periodeGebunden('2026-10', 'monat', 'Europe/Berlin', [b])).toBe(false);
    expect(periodeGebunden('2026-11', 'monat', 'Europe/Berlin', [b])).toBe(true);
    expect(periodeGebunden('2026-11-01', 'tag', 'Europe/Berlin', [{ ...b, bis: '2026-11-02T23:00:00Z' }])).toBe(true);
    expect(periodeGebunden('2026-11-03', 'tag', 'Europe/Berlin', [{ ...b, bis: '2026-11-02T23:00:00Z' }])).toBe(false);
    expect(periodeGebunden('2026-10', 'monat', 'Europe/Berlin', [{ ...b, von: '2026-10-31T22:59:00Z' }])).toBe(true);
  });
  it('nennt die gespeicherten Parameter und den gewählten Zustand', () => {
    expect(bindungsRegel(b)).toBe('Gradtage G20/15');
    expect(wertKennzeichen(['aus Messkanal Charging (Zustand = Charging)'])).toEqual([]);
    expect(wertKennzeichen(['aus Leistung über 5 kW (Annahme)', 'aus Messkanal power (Regel)'])).toEqual(['aus Leistung über 5 kW (Annahme)']);
    expect(bindungsRegel({ ...b, regel: 'aus Leistung über 2,5 kW (Annahme)' })).toBe('aus Leistung über 2,5 kW (Annahme)');
    expect(kanalRegelText('Gradtage G20.5/15.5')).toBe('Gradtage G20,5/15,5');
    expect(kanalRegelText('Zustand = Stufe 1.2')).toBe('Zustand = Stufe 1.2');
    expect(bindungsRegel({ ...b, wertart: 'state', zustand: 'Charging' })).toBe('Zeit im Zustand „Charging“');
    expect(bindungsRegel({ ...b, wertart: 'counter' })).toBe('Zähler-Differenz');
  });
});
