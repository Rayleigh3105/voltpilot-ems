import { describe, expect, it } from 'vitest';

import type { ScheduleSlot } from './api';
import {
  KEINE_PREISE,
  KEINE_SLOTS,
  nachteilBisher,
  nachteilZeile,
  vorrangMitZahl,
  vorschauSatz,
  zeitraumWort,
  type VorschauErgebnis,
} from './vorschau';

const NOW = new Date('2026-08-25T12:00:00Z');
const SEIT = new Date('2026-08-25T10:00:00Z');

function slot(idx: number, patch: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    start: new Date(SEIT.getTime() + idx * 900_000).toISOString(),
    batteryKw: 0, gridKw: null, socPct: null, priceEurMwh: null, costEur: null,
    baselineCostEur: null, curtailKw: null, pvKw: null, loadKw: null,
    slotRole: null, slotFlags: null, storedValueCtKwh: null, gridValueCtKwh: null,
    peakPressureEurKw: null, importPriceCtKwh: null, exportValueCtKwh: null,
    importPriceSource: null,
    ...patch,
  } as ScheduleSlot;
}

function ergebnis(p: Partial<VorschauErgebnis> = {}): VorschauErgebnis {
  return {
    deltaEur: -0.9, basisEur: 4.2, varianteEur: 3.3, horizonSlots: 96,
    naeherung: true, grund: null, ...p,
  };
}

describe('Vorschau-Satz (Block 2 der Folgen-Karte)', () => {
  it('nennt Betrag, Richtung, Zeitraum UND dass es eine Näherung ist', () => {
    const s = vorschauSatz(ergebnis()) as string;
    expect(s).toContain('0,90');
    expect(s).toContain('kostet');
    expect(s).toContain('24 Stunden');
    expect(s).toContain('Näherung');
  });

  it('dreht die Richtung, wenn die Entscheidung etwas BRINGT', () => {
    const s = vorschauSatz(ergebnis({ deltaEur: 1.4 })) as string;
    expect(s).toContain('bringt');
    expect(s).not.toContain('kostet');
    expect(s).toContain('1,40');
  });

  it('ohne Zahl steht der GRUND da, nie eine 0', () => {
    const s = vorschauSatz(ergebnis({ deltaEur: null, grund: 'Kein Fahrplan.' }));
    expect(s).toBe('Kein Fahrplan.');
    expect(vorschauSatz(null)).toBeNull();
  });

  it('ohne bekannten Horizont wird keine Stundenzahl erfunden', () => {
    expect(zeitraumWort(null)).toBe('Fahrplan-Zeitraum');
    expect(zeitraumWort(0)).toBe('Fahrplan-Zeitraum');
    expect(zeitraumWort(96)).toContain('24 Stunden');
    expect(vorschauSatz(ergebnis({ horizonSlots: null })) as string)
      .toContain('Fahrplan-Zeitraum');
  });
});

describe('Vorrang-Hinweis Variante 2 (§3.6, S2)', () => {
  const v1 = 'Ihre Regel geht vor. Wenn sie greift, weicht der Fahrplan.';

  it('ist Variante 1 MIT der Zahl', () => {
    const s = vorrangMitZahl(v1, ergebnis()) as string;
    expect(s).toContain('Ihre Regel geht vor');
    expect(s).toContain('0,90');
    expect(s).toContain('Näherung');
  });

  it('OHNE Zahl gibt es sie gar nicht — der Aufrufer bleibt bei Variante 1', () => {
    expect(vorrangMitZahl(v1, ergebnis({ deltaEur: null }))).toBeNull();
    expect(vorrangMitZahl(v1, null)).toBeNull();
  });
});

describe('Nachteil-Beleg (laufend, §3.8 G8)', () => {
  /** Acht Viertelstunden seit 10:00, Haus 4 kW, keine PV, 32 ct Bezug, λ 18 ct. */
  function stunden(patch: Partial<ScheduleSlot> = {}): ScheduleSlot[] {
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      slot(i, { loadKw: 4, pvKw: 0, importPriceCtKwh: 32, storedValueCtKwh: 18, ...patch }));
  }

  it('rechnet die entgangene Ersparnis über die gewerteten Slots', () => {
    const n = nachteilBisher(stunden(), SEIT, NOW, 5);
    // Defizit 4 kW < Entladeleistung 5 kW -> 1 kWh je Slot, 8 kWh gesamt.
    expect(n.kwh).toBeCloseTo(8, 6);
    // Marge 14 ct -> 8 kWh * 0,14 € = 1,12 €.
    expect(n.eur).toBeCloseTo(1.12, 6);
    expect(n.slots).toBe(8);
    expect(n.grund).toBeNull();
  });

  it('kappt auf die Entladeleistung des Speichers', () => {
    const n = nachteilBisher(stunden({ loadKw: 20 }), SEIT, NOW, 5);
    expect(n.kwh).toBeCloseTo(8 * 1.25, 6); // 5 kW * 0,25 h je Slot
  });

  it('eine NEGATIVE Marge zählt als 0, nie als Gewinn', () => {
    // λ 40 ct über dem Bezugspreis 32: das Halten war richtig.
    const n = nachteilBisher(stunden({ storedValueCtKwh: 40 }), SEIT, NOW, 5);
    expect(n.eur).toBe(0);
    expect(n.kwh).toBeGreaterThan(0);
  });

  it('PV deckt das Defizit — dann gibt es nichts zu holen', () => {
    const n = nachteilBisher(stunden({ pvKw: 9 }), SEIT, NOW, 5);
    expect(n.eur).toBe(0);
    expect(n.kwh).toBe(0);
  });

  it('EIN Slot ohne Preis ODER ohne λ macht die GANZE Zahl unbestimmbar', () => {
    const ohnePreis = stunden(); ohnePreis[3] = slot(3, { loadKw: 4, pvKw: 0, storedValueCtKwh: 18 });
    expect(nachteilBisher(ohnePreis, SEIT, NOW, 5).grund).toBe(KEINE_PREISE);
    const ohneLambda = stunden(); ohneLambda[5] = slot(5, { loadKw: 4, pvKw: 0, importPriceCtKwh: 32 });
    expect(nachteilBisher(ohneLambda, SEIT, NOW, 5).grund).toBe(KEINE_PREISE);
    const ohneLast = stunden(); ohneLast[1] = slot(1, { importPriceCtKwh: 32, storedValueCtKwh: 18 });
    expect(nachteilBisher(ohneLast, SEIT, NOW, 5).grund).toBe(KEINE_PREISE);
  });

  it('ohne Entladeleistung, ohne Startzeit oder ohne Fahrplan gibt es keine Zahl', () => {
    expect(nachteilBisher(stunden(), SEIT, NOW, null).eur).toBeNull();
    expect(nachteilBisher(stunden(), SEIT, NOW, 0).eur).toBeNull();
    expect(nachteilBisher(stunden(), null, NOW, 5).grund).toBe(KEINE_SLOTS);
    expect(nachteilBisher(null, SEIT, NOW, 5).grund).toBe(KEINE_SLOTS);
    expect(nachteilBisher([], SEIT, NOW, 5).grund).toBe(KEINE_SLOTS);
  });

  it('wertet NUR die Slots zwischen Start und jetzt', () => {
    // Der Fahrplan reicht weit in die Zukunft - sie zählt nicht mit.
    const lang = [...Array(96).keys()].map((i) =>
      slot(i, { loadKw: 4, pvKw: 0, importPriceCtKwh: 32, storedValueCtKwh: 18 }));
    expect(nachteilBisher(lang, SEIT, NOW, 5).slots).toBe(8);
    // Und ein Start NACH dem letzten Slot ergibt gar nichts.
    expect(nachteilBisher(lang, new Date('2026-08-26T23:00:00Z'), NOW, 5).grund)
      .toBe(KEINE_SLOTS);
  });

  it('die Zeile schweigt unter der Sichtbarkeitsschwelle und ohne Zahl', () => {
    expect(nachteilZeile({ eur: null, kwh: null, slots: 0, grund: 'x' }, SEIT)).toBeNull();
    expect(nachteilZeile({ eur: 0, kwh: 3, slots: 8, grund: null }, SEIT)).toBeNull();
    expect(nachteilZeile({ eur: 0.01, kwh: 3, slots: 8, grund: null }, SEIT)).toBeNull();
    const z = nachteilZeile({ eur: 1.12, kwh: 8, slots: 8, grund: null }, SEIT,
      'Europe/Berlin') as string;
    expect(z).toContain('1,12');
    expect(z).toContain('Näherung');
    expect(z).toMatch(/seit \d{2}:\d{2}/);
  });

  it('ohne Startzeit nennt die Zeile keine Uhrzeit', () => {
    const z = nachteilZeile({ eur: 1.12, kwh: 8, slots: 8, grund: null }, null) as string;
    expect(z).toContain('1,12');
    expect(z).not.toMatch(/seit \d/);
  });
});
