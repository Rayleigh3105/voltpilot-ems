import { describe, expect, it } from 'vitest';
import { anlageEnergie, anlageKurve, anlageTyp } from './anlageEnergie';
import type { AnlagenZeile } from './portfolioCockpit';
import type { History, HistoryBucket } from './api';

function bucket(start: string, pvKwh: number | null, loadKwh: number | null): HistoryBucket {
  return {
    start,
    pvKwh,
    loadKwh,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
  };
}

function hist(buckets: HistoryBucket[]): History {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    buckets,
    totals: {} as History['totals'],
    protocol: [],
    plan: [],
  };
}

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
  it('benennt den Typ aus den vorhandenen Flüssen', () => {
    expect(anlageTyp(false, false)).toBe('reine Messung');
    expect(anlageTyp(true, false)).toBe('PV');
    expect(anlageTyp(false, true)).toBe('Speicher');
    expect(anlageTyp(true, true)).toBe('PV + Speicher');
  });
});

describe('anlageEnergie', () => {
  it('reine Messung: nur Verbrauch heute und Netz jetzt', () => {
    const m = anlageEnergie(zeile({ verbrauchKwh: 54800, netz: { richtung: 'bezug', kw: 4.5 } }), {
      pv: 0,
      storage: 0,
    });
    expect(m.typ).toBe('reine Messung');
    expect(m.stats.map((s) => s.label)).toEqual(['Verbrauch', 'Netz']);
    expect(m.stats[0]).toMatchObject({ rolle: 'load', wert: '54.800', einheit: 'kWh', zeit: 'heute' });
    expect(m.stats[1]).toMatchObject({ rolle: 'grid', label: 'Netz', wert: 'Bezug 4,5', einheit: 'kW', zeit: 'jetzt' });
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

  it('zeigt gemessene PV und Speicher auch ohne modellierte Rolle', () => {
    // Die Demo-Hallen sind „Monitoring" (roleCounts pv/storage = 0), messen aber
    // Erzeugung und Ladestand — das gehört auf die Karte, nicht nach roleCounts.
    const m = anlageEnergie(
      zeile({ verbrauchKwh: 4280, erzeugungKwh: 33994, ladestandPct: 98, netz: { richtung: 'einspeisung', kw: 5.3 } }),
      { pv: 0, storage: 0 },
    );
    expect(m.typ).toBe('PV + Speicher');
    expect(m.stats.map((s) => s.label)).toEqual(['Verbrauch', 'Erzeugung', 'Netz', 'Speicher']);
    expect(m.stats[1]).toMatchObject({ rolle: 'pv', wert: '33.994', einheit: 'kWh' });
    expect(m.stats[3]).toMatchObject({ rolle: 'batt', wert: '98', einheit: '%' });
  });

  it('PV allein aus der Live-Leistung (noch kein Tageswert) → Erzeugung „–"', () => {
    const m = anlageEnergie(zeile({ pvJetztKw: 6.1 }), { pv: 0, storage: 0 });
    expect(m.typ).toBe('PV');
    expect(m.stats.find((s) => s.label === 'Erzeugung')).toMatchObject({ rolle: 'pv', wert: '–', leer: true });
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

  it('Netz: einheitliches Label „Netz", Richtung im Wert; Einspeisung und ausgeglichen', () => {
    expect(
      anlageEnergie(zeile({ netz: { richtung: 'einspeisung', kw: 2.1 } }), { pv: 1, storage: 0 }).stats.find(
        (s) => s.rolle === 'grid',
      ),
    ).toMatchObject({ label: 'Netz', wert: 'Einspeisung 2,1', einheit: 'kW' });
    expect(
      anlageEnergie(zeile({ netz: { richtung: 'ausgeglichen', kw: 0 } }), { pv: 0, storage: 0 }).stats.find(
        (s) => s.rolle === 'grid',
      ),
    ).toMatchObject({ label: 'Netz', wert: 'ausgeglichen', einheit: '' });
  });

  it('reicht den „noch nicht zugeordnet"-Zustand durch', () => {
    expect(anlageEnergie(zeile(), { pv: 0, storage: 0 }, true).nichtZugeordnet).toBe(true);
    expect(anlageEnergie(zeile(), { pv: 0, storage: 0 }).nichtZugeordnet).toBe(false);
  });

  it('reicht die Kurve durch (null als Vorgabe)', () => {
    expect(anlageEnergie(zeile(), { pv: 0, storage: 0 }).kurve).toBeNull();
    const k = anlageKurve(hist([bucket('2026-10-05T09:00:00+02:00', 1, 0.5)]), new Date('2026-10-05T09:30:00+02:00'));
    expect(anlageEnergie(zeile(), { pv: 1, storage: 0 }, false, k).kurve).toBe(k);
  });
});

describe('anlageKurve', () => {
  const now = new Date('2026-10-05T09:30:00+02:00');
  it('baut PV und Verbrauch je Viertelstunde (kWh × 4 = kW)', () => {
    const k = anlageKurve(hist([bucket('2026-10-05T09:00:00+02:00', 1, 0.5)]), now);
    expect(k).not.toBeNull();
    // 1 kWh je Viertelstunde × 4 = 4 kW; 0,5 × 4 = 2 kW — an irgendeiner Viertelstunde (TZ-unabhängig geprüft).
    expect(k!.pv.some((v) => v === 4)).toBe(true);
    expect(k!.load.some((v) => v === 2)).toBe(true);
  });
  it('fehlende Werte bleiben Lücken (null), keine 0', () => {
    const k = anlageKurve(hist([bucket('2026-10-05T09:00:00+02:00', null, 0.25)]), now);
    expect(k).not.toBeNull();
    expect(k!.pv.every((v) => v == null)).toBe(true);
    expect(k!.load.some((v) => v === 1)).toBe(true);
  });
  it('null ohne Historie oder Buckets', () => {
    expect(anlageKurve(null, now)).toBeNull();
    expect(anlageKurve(hist([]), now)).toBeNull();
  });
});
