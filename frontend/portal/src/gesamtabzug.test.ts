import { expect, it } from 'vitest';
import type { Selbstauskunft } from './api';
import { gesamtabzugLaden } from './rollen';

const person = (teil: Partial<Selbstauskunft>): Selbstauskunft => ({
  kennung: 'jw', name: 'JW', konto: 'benutzer', zustand: 'aktiv', kundenbereich: { id: 'k', name: 'Ahrenberg' },
  zugang: 'konto', rollen: ['kundenadministrator'], unternehmensweit: true, standorte: [], unternehmen_rechte: [],
  kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] } as unknown as Selbstauskunft['unterstuetzungen'],
  kundenadministratoren: [], ...teil,
});

it('AP-20 IP-17: den Gesamtabzug bietet das Portal nur dem Kundenadministrator mit eigenem Konto an', () => {
  expect(gesamtabzugLaden(person({}))).toBe(true);
  expect(gesamtabzugLaden(person({ rollen: ['energiemanager'] }))).toBe(false);
  expect(gesamtabzugLaden(person({ rollen: ['einsicht'] }))).toBe(false);
  expect(gesamtabzugLaden(person({ konto: 'partner', zugang: 'unterstuetzung', rollen: ['unterstuetzer'] }))).toBe(false);
  expect(gesamtabzugLaden(person({ konto: 'plattform', zugang: 'umschalter' }))).toBe(false);
  expect(gesamtabzugLaden(person({ zustand: 'gesperrt' }))).toBe(false);
  expect(gesamtabzugLaden(null)).toBe(false);
});
