import { describe, expect, it } from 'vitest';
import { bearbeiterStandorte, einstiegFuer, obenBausteine } from './einstieg';

/** K6/K8 (Konzept „Energiemanagement ohne Fachsprache“): die erste Ansicht je Rolle — ohne neue Rechte. */
const person = (rollen: string[], standorte: { id: string; rollen: string[] }[] = []) => ({
  rollen,
  standorte: standorte.map((s) => ({ ...s, kennzeichen: s.id, name: s.id, umfang: null, ocpp_stufe: 'keine' as const, rechte: [] })),
});

describe('K6 · Einstieg je Rolle', () => {
  it('Energiemanager → Fahrplan und „Was steht an“; Kundenadministrator → wie heute; Bearbeiter → Standort; Leser/Einsicht → Belege', () => {
    expect(einstiegFuer(person(['energiemanager']))).toBe('aufbauen');
    expect(einstiegFuer(person([], [{ id: 'st1', rollen: ['energiemanager'] }]))).toBe('aufbauen');
    expect(einstiegFuer(person(['kundenadministrator']))).toBe('wie_heute');
    expect(einstiegFuer(person([], [{ id: 'st1', rollen: ['bearbeiter'] }]))).toBe('standort');
    expect(einstiegFuer(person(['leser']))).toBe('belege');
    expect(einstiegFuer(person(['einsicht']))).toBe('belege');
    expect(einstiegFuer(person(['bedienberechtigt']))).toBe('wie_heute');
    expect(einstiegFuer(null)).toBe('wie_heute');
  });

  it('wer mehrere Rollen hat, bekommt die, die am meisten aufbaut', () => {
    expect(einstiegFuer(person(['kundenadministrator', 'energiemanager']))).toBe('aufbauen');
    expect(einstiegFuer(person(['kundenadministrator'], [{ id: 'st1', rollen: ['bearbeiter'] }]))).toBe('wie_heute');
    expect(einstiegFuer(person(['einsicht'], [{ id: 'st1', rollen: ['bearbeiter'] }]))).toBe('standort');
  });

  it('K8: am Telefon zuerst „Was steht an“, dann der Einstieg, dann Abweichungen und Datenlage; am Rechner nur der Einstieg', () => {
    expect(obenBausteine('aufbauen', false)).toEqual(['fahrplan', 'energiemanagement']);
    expect(obenBausteine('aufbauen', true)).toEqual(['energiemanagement', 'fahrplan', 'ziele-massnahmen', 'messstellen']);
    expect(obenBausteine('wie_heute', false)).toEqual([]);
    expect(obenBausteine('wie_heute', true)).toEqual(['energiemanagement', 'ziele-massnahmen', 'messstellen']);
    expect(obenBausteine('belege', false)).toEqual(['belege']);
    expect(obenBausteine('standort', true)).toEqual(['energiemanagement', 'standort', 'ziele-massnahmen', 'messstellen']);
  });

  it('die Standorte des Bearbeiters: je Standort aus der Selbstauskunft', () => {
    expect(bearbeiterStandorte(person(['bearbeiter'], [{ id: 'st1', rollen: ['bearbeiter'] }, { id: 'st2', rollen: ['leser'] }]))).toEqual(['st1']);
    expect(bearbeiterStandorte(null)).toEqual([]);
  });
});
