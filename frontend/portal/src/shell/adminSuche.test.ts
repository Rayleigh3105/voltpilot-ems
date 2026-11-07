import { describe, expect, it } from 'vitest';
import { ADMIN_SUCHE_PLATZHALTER, ADMIN_SUCHE_SUCHTEXT, adminSucheOptionen, adminSucheWert, adminSucheZiel } from './adminSuche';

const KUNDEN = [
  { id: 'a1', name: 'Werner Schramm' },
  { id: 'a2', name: 'VfL Treuchtlingen' },
];
const SEITEN = [{ id: 'werkstatt', label: 'Werkstatt' }];

describe('adminSuche: die Suche oben beim Plattform-Administrator', () => {
  it('führt Kunden und Plattform-Seiten, jede Zeile mit ihrer Art', () => {
    expect(adminSucheOptionen(KUNDEN, SEITEN)).toEqual([
      { value: 'kunde:a1', label: 'Werner Schramm', sub: 'Kunde' },
      { value: 'kunde:a2', label: 'VfL Treuchtlingen', sub: 'Kunde' },
      { value: 'seite:werkstatt', label: 'Werkstatt', sub: 'Plattform' },
    ]);
  });

  it('der gewählte Wert ist der offene Kunde — und eine Zeile der Liste', () => {
    const wert = adminSucheWert('a1');
    expect(wert).toBe('kunde:a1');
    expect(adminSucheOptionen(KUNDEN, SEITEN).find((o) => o.value === wert)?.label).toBe('Werner Schramm');
  });

  it('ohne offene Kundensicht bleibt das Feld leer (Platzhalter statt „Bitte wählen …“)', () => {
    expect(adminSucheWert(null)).toBe('');
    expect(adminSucheWert('')).toBe('');
    expect(ADMIN_SUCHE_PLATZHALTER).not.toMatch(/Bitte wählen/);
    expect(ADMIN_SUCHE_SUCHTEXT).not.toMatch(/Bitte wählen/);
  });

  it('eine Wahl nennt ihr Ziel: Kunde oder Seite', () => {
    expect(adminSucheZiel('kunde:a2')).toEqual({ art: 'kunde', id: 'a2' });
    expect(adminSucheZiel('seite:werkstatt')).toEqual({ art: 'seite', id: 'werkstatt' });
  });

  it('Rundreise: jede Option führt zu genau ihrem Kunden bzw. ihrer Seite', () => {
    for (const o of adminSucheOptionen(KUNDEN, SEITEN)) {
      const ziel = adminSucheZiel(o.value);
      expect(ziel).not.toBeNull();
      expect(`${ziel!.art}:${ziel!.id}`).toBe(o.value);
    }
  });

  it('ein unbekannter oder leerer Wert führt nirgendwohin', () => {
    expect(adminSucheZiel('')).toBeNull();
    expect(adminSucheZiel('kunde:')).toBeNull();
    expect(adminSucheZiel('anlage:x')).toBeNull();
  });
});
