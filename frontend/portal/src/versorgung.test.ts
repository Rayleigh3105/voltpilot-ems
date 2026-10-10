import { describe, expect, it } from 'vitest';
import type { Versorgung } from './api';
import { ausserhalbSatz, versorgungZeilen } from './versorgung';

const an1 = { id: 'AN-1', name: 'Werk Ahrenberg – Halle 1', netzanschlussKennzeichen: 'NA-1' };
const an2 = { id: 'AN-2', name: 'Werk Ahrenberg – Halle 2', netzanschlussKennzeichen: 'NA-2' };

const f15: Versorgung = {
  stichtag: '2026-10-20',
  standort: { id: 'ST-1', kennzeichen: 'ST-1', name: 'Werk Ahrenberg' },
  gebaeude: [
    { gebaeude: { id: 'G-1', kennzeichen: 'G-1', name: 'Halle 1' }, messbar: true,
      systeme: [{ anlage: an1, messstellen: [{ kennzeichen: 'MS-03', name: 'PV Dach' }] }] },
    { gebaeude: { id: 'G-3', kennzeichen: 'G-3', name: 'Verwaltung' }, messbar: true,
      systeme: [{ anlage: an1, messstellen: [{ kennzeichen: 'MS-05', name: 'Verwaltung' }] }] },
    { gebaeude: { id: 'G-2', kennzeichen: 'G-2', name: 'Halle 2' }, messbar: true,
      systeme: [{ anlage: an2, messstellen: [{ kennzeichen: 'MS-10', name: 'Hauptverteilung' }] }] },
    { gebaeude: { id: 'G-6', kennzeichen: 'G-6', name: 'Werkstatt' }, messbar: false, systeme: [] },
  ],
  ausserhalbGebaeude: [{ messstelle: { kennzeichen: 'MS-14', name: 'Ladepunkt' }, anlage: an2 }],
};

describe('AP-10 F15 · Standort › Versorgung', () => {
  it('spricht Gebäude ← System samt Netzanschluss und lässt ein ungemessenes Gebäude ehrlich offen', () => {
    expect(versorgungZeilen(f15).map((z) => z.text)).toEqual([
      'Halle 1 ← System Halle 1 (NA-1)',
      'Verwaltung ← System Halle 1 (NA-1)',
      'Halle 2 ← System Halle 2 (NA-2)',
      'Werkstatt · nicht messbar',
    ]);
  });

  it('schlägt die Messstelle am Standort keinem Gebäude zu', () => {
    expect(ausserhalbSatz(f15)).toBe('1 Messstelle außerhalb eines Gebäudes');
    expect(versorgungZeilen(f15).map((z) => z.messstellen)).not.toContain('MS-14');
  });
});
