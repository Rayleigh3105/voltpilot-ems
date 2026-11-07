import { describe, expect, it } from 'vitest';
import { kundenZahlenText } from './kundenakte';

describe('kundenZahlenText (Kundenliste am Telefon)', () => {
  it('nennt die drei Zahlen in einer Zeile mit Einzahl und Mehrzahl', () => {
    expect(kundenZahlenText({ anzahlPersonen: 1, anzahlAnlagen: 3, anzahlBoxen: 0 })).toBe('1 Person · 3 Anlagen · 0 Boxen');
    expect(kundenZahlenText({ anzahlPersonen: 8, anzahlAnlagen: 1, anzahlBoxen: 1 })).toBe('8 Personen · 1 Anlage · 1 Box');
  });

  it('zeigt eine noch fehlende Zahl als „…“, nie als 0', () => {
    expect(kundenZahlenText({ anzahlPersonen: undefined, anzahlAnlagen: null, anzahlBoxen: null })).toBe('… Personen · … Anlagen · … Boxen');
    expect(kundenZahlenText({ anzahlPersonen: null, anzahlAnlagen: 2, anzahlBoxen: 2 })).toBe('… Personen · 2 Anlagen · 2 Boxen');
  });
});
