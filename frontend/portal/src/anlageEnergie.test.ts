import { describe, expect, it } from 'vitest';
import { anlageEnergie, anlageTyp } from './anlageEnergie';
import type { AnlagenZeile } from './portfolioCockpit';

function zeile(over: Partial<AnlagenZeile> = {}): AnlagenZeile {
  return {
    id: 'a1',
    name: 'Halle 1',
    unterzeile: null,
    speicherOhneGeraet: false,
    pvJetztKw: null,
    erzeugungKwh: null,
    verbrauchKwh: null,
    ladestandPct: null,
    ladestandWort: null,
    ladestandStand: null,
    netz: null,
    heuteEur: null,
    heuteGrund: null,
    zustand: { wort: 'Online', alter: null, ton: 'ok' },
    ...over,
  };
}

describe('anlageTyp', () => {
  it('benennt den Typ aus den Rollen', () => {
    expect(anlageTyp({ pv: 0, storage: 0 })).toBe('reine Messung');
    expect(anlageTyp({ pv: 2, storage: 0 })).toBe('PV');
    expect(anlageTyp({ pv: 0, storage: 1 })).toBe('Speicher');
    expect(anlageTyp({ pv: 1, storage: 1 })).toBe('PV + Speicher');
  });
});

describe('anlageEnergie', () => {
  it('reine Messung: nur Verbrauch heute und Netz jetzt', () => {
    const m = anlageEnergie(zeile({ verbrauchKwh: 54800, netz: { richtung: 'bezug', kw: 4.5 } }), {
      pv: 0,
      storage: 0,
    });
    expect(m.typ).toBe('reine Messung');
    expect(m.stats.map((s) => s.label)).toEqual(['Verbrauch', 'Netzbezug']);
    expect(m.stats[0]).toMatchObject({ rolle: 'load', wert: '54.800', einheit: 'kWh', zeit: 'heute' });
    expect(m.stats[1]).toMatchObject({ rolle: 'grid', wert: '4,5', einheit: 'kW', zeit: 'jetzt' });
  });

  it('PV + Speicher: vier Angaben in Rollen-Farben', () => {
    const m = anlageEnergie(
      zeile({
        verbrauchKwh: 142300,
        erzeugungKwh: 31500,
        netz: { richtung: 'bezug', kw: 4.3 },
        ladestandPct: 64,
        ladestandWort: 'lädt',
      }),
      { pv: 1, storage: 1 },
    );
    expect(m.typ).toBe('PV + Speicher');
    expect(m.stats.map((s) => s.rolle)).toEqual(['load', 'pv', 'grid', 'batt']);
    expect(m.stats[1]).toMatchObject({ label: 'Erzeugung', wert: '31.500', einheit: 'kWh' });
    expect(m.stats[3]).toMatchObject({ label: 'Speicher', wert: '64', einheit: '%', zeit: 'lädt' });
  });

  it('fehlender Wert steht als „–", nie als 0', () => {
    const m = anlageEnergie(zeile({ verbrauchKwh: null, netz: null }), { pv: 0, storage: 0 });
    expect(m.stats[0]).toMatchObject({ wert: '–', leer: true });
    expect(m.stats[1]).toMatchObject({ wert: '–', leer: true });
  });

  it('gemessene 0 bleibt 0 (nicht „–")', () => {
    const m = anlageEnergie(zeile({ erzeugungKwh: 0 }), { pv: 1, storage: 0 });
    const erz = m.stats.find((s) => s.label === 'Erzeugung');
    expect(erz?.wert).toBe('0');
    expect(erz?.leer).toBeUndefined();
  });

  it('veralteter Ladestand ist datiert und gedämpft, nicht „jetzt"', () => {
    const m = anlageEnergie(zeile({ ladestandPct: 6, ladestandStand: 'am 12.08.' }), { pv: 0, storage: 1 });
    const sp = m.stats.find((s) => s.label === 'Speicher');
    expect(sp).toMatchObject({ wert: '6', einheit: '%', zeit: 'am 12.08.', dim: true });
  });

  it('Netz: Einspeisung und ausgeglichen', () => {
    expect(
      anlageEnergie(zeile({ netz: { richtung: 'einspeisung', kw: 2.1 } }), { pv: 1, storage: 0 }).stats.find(
        (s) => s.rolle === 'grid',
      ),
    ).toMatchObject({ label: 'Einspeisung', wert: '2,1' });
    expect(
      anlageEnergie(zeile({ netz: { richtung: 'ausgeglichen', kw: 0 } }), { pv: 0, storage: 0 }).stats.find(
        (s) => s.rolle === 'grid',
      ),
    ).toMatchObject({ wert: 'ausgeglichen', einheit: '' });
  });

  it('reicht den „noch nicht zugeordnet"-Zustand durch', () => {
    expect(anlageEnergie(zeile(), { pv: 0, storage: 0 }, true).nichtZugeordnet).toBe(true);
    expect(anlageEnergie(zeile(), { pv: 0, storage: 0 }).nichtZugeordnet).toBe(false);
  });
});
