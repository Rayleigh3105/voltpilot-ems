import { describe, expect, it } from 'vitest';
import type { GeraetBild, JetztWerte, SpeicherBild } from './bild';
import { messBild } from './messen';
import { raster } from './zeit';

const R = raster(new Date('2026-10-04T13:10:00+02:00'));

function geraet(id: string, name: string, x: Partial<GeraetBild> = {}): GeraetBild {
  return {
    id, name, kurz: name, symbol: 'plug', typ: 'generic-load', typLabel: 'Steuerbare Last', form: 'schalten', ladepunkt: null,
    gemessen: true, nennKw: null, stufenKw: null, steuerart: null, ohneAuftrag: true, sonnig: false, schreibbar: true,
    nichtSchreibbarGrund: null, eintrag: { ladepunkt: false } as GeraetBild['eintrag'], consumer: null, status: null,
    kw: [], herkunft: [], jetztKw: null, an: null, pill: ['off', 'aus'], warum: '', warumLang: '', eingriff: null,
    regelJetzt: null, auftrag: '', regeln: 0, ...x,
  };
}

const LIVE: JetztWerte = { pv: 18.4, last: 64.6, netz: 46.2, soc: 64, bat: 0, ts: '2026-10-04T11:09:00Z' };

describe('messBild (SZ-1 A)', () => {
  it('sagt nur, was gemessen wird: Netz, PV, größte Verbraucher, Ladepunkt; die Leiste teilt den gemessenen Verbrauch', () => {
    const m = messBild({
      raster: R,
      jetzt: LIVE,
      geraete: [
        geraet('k', 'Kältemaschine', { jetztKw: 21 }),
        geraet('d', 'Druckluft', { jetztKw: 14.5 }),
        geraet('l', 'Lüftung', { jetztKw: 9 }),
        geraet('w', 'Ladepunkt Parkplatz', {
          eintrag: { ladepunkt: true } as GeraetBild['eintrag'], typLabel: 'Ladepunkt',
          ladepunkt: { chargePointId: 'CP', connectorId: 1, angesteckt: false, sitzungSeit: null, sitzungKwh: null, karte: null, laedt: false },
          jetztKw: 0,
        }),
      ],
      speicher: null,
    });
    expect(m.eye).toBe('Jetzt · 13:10 · gemessen');
    expect(m.satz).toBe('Die Anlage bezieht 46,2 kW aus dem Netz, die PV liefert 18,4 kW.');
    expect(m.zusatz).toEqual(['Größte Verbraucher gerade: Kältemaschine 21,0 kW · Druckluft 14,5 kW.', 'Ladepunkt Parkplatz: kein Auto angesteckt.']);
    expect(m.teile.map((t) => [t.label, Math.round(t.kw * 10) / 10])).toEqual([['Kältemaschine', 21], ['Druckluft', 14.5], ['Lüftung', 9], ['Rest', 20.1]]);
    expect(m.zeilen.map((z) => z.satz)).toEqual([
      'gemessen · Steuerbare Last', 'gemessen · Steuerbare Last', 'gemessen · Steuerbare Last', 'gemessen · kein Auto angesteckt',
    ]);
  });

  it('unbekannt ist keine Null: ohne frische Telemetrie kein Satz mit Zahl und keine Leiste; ein angenommener Wert zählt nicht', () => {
    const m = messBild({
      raster: R,
      jetzt: null,
      geraete: [geraet('h', 'Heizstab', { gemessen: false, jetztKw: 3, an: true })],
      speicher: { name: 'Speicher', pill: ['off', 'ruht'], warum: '', kwh: 10, kw: 5, soc: 50, jetztKw: 2, reservePct: null } as SpeicherBild,
    });
    expect(m.satz).toBe('Für jetzt liegt noch kein Messwert vor.');
    expect(m.zusatz).toEqual([]);
    expect(m.teile).toEqual([]);
    expect(m.zeilen.map((z) => [z.name, z.satz, z.kw, z.gemessen])).toEqual([
      ['Speicher', 'ohne Messwert', null, false],
      ['Heizstab', 'ohne eigene Messung · Steuerbare Last', null, false],
    ]);
  });

  it('Einspeisung und Speicher aus der Messung', () => {
    const m = messBild({
      raster: R,
      jetzt: { pv: 8, last: 5, netz: -0.4, soc: 100, bat: 2.6, ts: '' },
      geraete: [],
      speicher: { name: 'Speicher Scheune' } as SpeicherBild,
    });
    expect(m.satz).toBe('Die Anlage speist 0,4 kW ins Netz ein, die PV liefert 8,0 kW.');
    expect(m.zeilen[0]).toMatchObject({ name: 'Speicher Scheune', satz: 'gemessen · lädt · Ladestand 100 %', kw: 2.6 });
  });
});
