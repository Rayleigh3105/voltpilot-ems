import { describe, expect, it } from 'vitest';
import { ANDERES, MESSWERT_ARTEN, definitionAusArt, einheitFehler, messwertArt } from './eigenerMesswert';

describe('eigenerMesswert · was die Antwort bedeutet', () => {
  it('bietet genau die tragenden Kombinationen und „Etwas anderes"', () => {
    expect(MESSWERT_ARTEN.map((a) => a.label)).toEqual([
      'Energie-Zählerstand – Bezug', 'Energie-Zählerstand – Abgabe', 'Energie-Zählerstand – Erzeugung',
      'Energie-Zählerstand – Laden', 'Energie-Zählerstand – Entladen',
      'Leistung – Bezug', 'Leistung – Abgabe', 'Leistung – Erzeugung', 'Leistung – Laden', 'Leistung – Entladen',
      'Etwas anderes (ohne Messstelle)',
    ]);
    // Zählerstand ist immer counter + energy_counter, Leistung immer gauge + eine Momentanwert-Klasse.
    for (const a of MESSWERT_ARTEN) {
      if (!a.measures) continue;
      expect(a.measures.aggregationKind).toBe(a.measures.quantity === 'active_energy' ? 'counter' : 'gauge');
      expect(a.retentionClass).toBe(a.measures.quantity === 'active_energy' ? 'energy_counter' : 'live_power');
    }
  });

  it('schickt ohne Messstelle keine Angabe und nie die unbekannte Klasse gauge', () => {
    expect(definitionAusArt(messwertArt(ANDERES)!)).toEqual({ retentionClass: 'live_power' });
    expect(MESSWERT_ARTEN.map((a) => a.retentionClass)).not.toContain('gauge');
  });

  it('prüft die Einheit wie die API', () => {
    expect(einheitFehler(messwertArt('energie.import'), 'kWh')).toBeNull();
    expect(einheitFehler(messwertArt('energie.import'), 'kW')).toBe('Ein Energie-Zählerstand braucht die Einheit Wh, kWh oder MWh.');
    expect(einheitFehler(messwertArt('leistung.generation'), 'kWh')).toBe('Eine Leistung braucht die Einheit W, kW oder MW.');
    expect(einheitFehler(messwertArt(ANDERES), '°C')).toBeNull();
    expect(einheitFehler(null, 'x')).toBeNull();
  });
});
