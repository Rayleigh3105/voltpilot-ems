import { describe, expect, it } from 'vitest';
import { anlagenBoxenZeilen, kundenZahlenText } from './kundenakte';
import type { Site } from '../api';
import type { AdminFleetSite } from './fleetApi';

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

describe('anlagenBoxenZeilen (B4 = A: je Box, nicht nur eine Summe)', () => {
  it('nennt jede Box „online“ oder „nie gemeldet“, aus Herzschlag und Messwert', () => {
    const sites = [{ id: 's1', name: 'Zuhause' } as Site];
    const fleetSites = [{
      siteId: 's1', siteName: 'Zuhause', deviceCount: 2, worstStatus: 'online',
      boxes: [
        { deviceId: 'd1', externalRef: 'edge-px6jphw', name: null, herzschlagAm: '2026-11-10T22:40:00Z', messwertAm: '2026-11-10T22:40:00Z' },
        { deviceId: 'd2', externalRef: 'edge-cyhchfr', name: null, herzschlagAm: null, messwertAm: null },
      ],
    } as unknown as AdminFleetSite];
    const [zeile] = anlagenBoxenZeilen(sites, fleetSites);
    expect(zeile.boxen).toHaveLength(2);
    expect(zeile.boxen[0]).toMatchObject({ externalRef: 'edge-px6jphw', text: 'online', nieGemeldet: false });
    expect(zeile.boxen[1]).toMatchObject({ externalRef: 'edge-cyhchfr', text: 'nie gemeldet', nieGemeldet: true });
  });

  it('eine Anlage ohne Fleet-Zeile bleibt „Stand unbekannt“, nicht „keine Box“', () => {
    const sites = [{ id: 's1', name: 'Zuhause' } as Site];
    const [zeile] = anlagenBoxenZeilen(sites, []);
    expect(zeile.unterzeile).toBe('Stand unbekannt');
    expect(zeile.boxen).toEqual([]);
  });
});
