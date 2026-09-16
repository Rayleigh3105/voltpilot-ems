import type { Versorgung } from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/** AP-10 F15 auf der E2E-Bühne: dieselben Gebäude, Systeme und Kennzeichen wie das Referenzunternehmen. */
export function versorgungAhrenberg(): Versorgung {
  const { st1, an1, an2 } = FIXTURE_IDS;
  const system1 = { id: an1, name: 'Werk Ahrenberg – Halle 1', netzanschlussKennzeichen: 'NA-1' };
  const system2 = { id: an2, name: 'Werk Ahrenberg – Halle 2', netzanschlussKennzeichen: 'NA-2' };
  return {
    stichtag: '2026-10-20',
    standort: { id: st1, kennzeichen: 'ST-1', name: 'Werk Ahrenberg' },
    gebaeude: [
      { gebaeude: { id: 'g-1', kennzeichen: 'G-1', name: 'Halle 1' }, messbar: true,
        systeme: [{ anlage: system1, messstellen: [{ kennzeichen: 'MS-03', name: 'PV Dach' }] }] },
      { gebaeude: { id: 'g-3', kennzeichen: 'G-3', name: 'Verwaltung' }, messbar: true,
        systeme: [{ anlage: system1, messstellen: [{ kennzeichen: 'MS-05', name: 'Verwaltung' }] }] },
      { gebaeude: { id: 'g-2', kennzeichen: 'G-2', name: 'Halle 2' }, messbar: true,
        systeme: [{ anlage: system2, messstellen: [{ kennzeichen: 'MS-10', name: 'Hauptverteilung' }] }] },
    ],
    ausserhalbGebaeude: [{ messstelle: { kennzeichen: 'MS-14', name: 'Ladepunkt Parkplatz' }, anlage: system2 }],
  };
}

export function versorgungLindach(): Versorgung {
  return {
    stichtag: '2026-10-20',
    standort: { id: FIXTURE_IDS.st2, kennzeichen: 'ST-2', name: 'Werk Lindach' },
    gebaeude: [{ gebaeude: { id: 'g-6', kennzeichen: 'G-6', name: 'Lager' }, messbar: false, systeme: [] }],
    ausserhalbGebaeude: [],
  };
}
