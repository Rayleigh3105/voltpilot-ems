import { describe, expect, it } from 'vitest';
import { bearbeiterStandorte } from './einstieg';

const person = (rollen: string[], standorte: { id: string; rollen: string[] }[] = []) => ({
  rollen,
  standorte: standorte.map((s) => ({ ...s, kennzeichen: s.id, name: s.id, umfang: null, ocpp_stufe: 'keine' as const, rechte: [] })),
});

describe('einstieg', () => {
  it('die Standorte des Bearbeiters: je Standort aus der Selbstauskunft', () => {
    expect(bearbeiterStandorte(person(['bearbeiter'], [{ id: 'st1', rollen: ['bearbeiter'] }, { id: 'st2', rollen: ['leser'] }]))).toEqual(['st1']);
    expect(bearbeiterStandorte(null)).toEqual([]);
  });
});
