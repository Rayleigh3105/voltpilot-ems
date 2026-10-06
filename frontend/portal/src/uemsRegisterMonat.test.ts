import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessstelleRegisterZeile } from './api';
import { anzeige, type Rahmen } from './uemsWerteKarte';

// Messen PR5 (Konzept §10.2): `GET /api/v1/messstellen?letzterMonat=true` gibt jeder Zeile den letzten
// vollständigen Monat mit GENAU dem Schritt von `…/werte?raster=monat`. Die echte Antwort der eigenen API auf einer
// Kopie der Demo-Datenbank (rundgang, Kunststoffwerk Ahrenberg, Stichtag 05.10.2026) - die Fläche spricht den Schritt
// mit derselben `anzeige()` wie jede Werte-Karte und rechnet nichts nach.
const antwort = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/test/fixtures/register-letzter-monat-2026-09.json'), 'utf8'),
) as { register: MessstelleRegisterZeile[] };

const NB = ' ';

const zeile = (kennzeichen: string): MessstelleRegisterZeile => {
  const z = antwort.register.find((r) => r.kennzeichen === kennzeichen);
  if (!z) throw new Error(`keine Zeile ${kennzeichen}`);
  return z;
};

/** Der Rahmen eines Register-Monats: die Hauptgröße der Zeile (gespeicherte Einheit) und das Raster Monat. */
const rahmen = (z: MessstelleRegisterZeile): Rahmen => ({
  messstelle: {
    id: z.id,
    kennzeichen: z.kennzeichen,
    name: z.name,
    art: z.art,
    ...z.hauptgroesse,
  },
  raster: 'monat',
});

describe('Register: der letzte vollständige Monat (Messen PR5)', () => {
  it('trägt den Monat vor dem Stichtag und die Zone des Standorts', () => {
    for (const z of antwort.register) {
      expect(z.letzter_monat).toMatchObject({ monat: '2026-09', zeitzone: 'Europe/Berlin' });
      expect(z.letzter_monat?.ausserhalb_zugriff).toBeUndefined();
    }
  });

  it('ein Monat aus Ablesungen spricht wie die Werte-Karte: Menge, Zustand, Ablesezeitraum', () => {
    const z = zeile('MS-20');
    expect(anzeige(rahmen(z), z.letzter_monat!.wert!, false)).toMatchObject({
      zahl: `88.200${NB}kWh`,
      zustand: 'vollständig',
      kennzeichen: ['Ablesezeitraum 01.09. 00:00 – 01.10. 00:00 (Zuordnung durch den Kunden)'],
    });
    const hz = zeile('HZ-1');
    expect(anzeige(rahmen(hz), hz.letzter_monat!.wert!, false).zahl).toBe(`199.500${NB}kWh`);
  });

  it('ein Monat ohne Zahl bleibt ohne Zahl - mit dem Grund des Schritts, nie 0', () => {
    const z = zeile('MS-03');
    const w = z.letzter_monat!.wert!;
    expect(w).toMatchObject({ menge: null, zustand: 'keine Werte', grund: 'keine_quelle' });
    expect(anzeige(rahmen(z), w, false).zahl).not.toMatch(/\d/);
  });
});
