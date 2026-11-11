import { describe, expect, it } from 'vitest';
import type { TagModell, TagViertel } from './fahrplanTag';
import type { TagSlot } from './fahrplanTag';
import { autarkieHeute, sonnenstromModell, WALLBOX_HINWEIS_AB_KWH } from './fahrplanSonnenstrom';

const START = new Date(2026, 9, 27).getTime();

/** Vier Viertelstunden: Sonne deckt Haus + lädt den Speicher, dann Haus aus dem Netz. */
function slot(i: number, over: Partial<TagSlot> = {}): TagSlot {
  return {
    start: new Date(START + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 300,
    costEur: 0,
    baselineCostEur: 0,
    pvKw: 0,
    loadKw: 1,
    ...over,
  };
}

function viertel(i: number, jetztIndex: number): TagViertel {
  return { i, von: i * 15, bis: (i + 1) * 15, vorbei: i < jetztIndex, laeuft: i === jetztIndex };
}

function tagModell(slots: TagSlot[], jetztIndex: number): TagModell {
  return {
    datum: new Date(START),
    slots,
    phasenRoh: [],
    viertel: slots.map((_, i) => viertel(i, jetztIndex)),
    phasen: [],
    jetzt: jetztIndex * 15,
    jetztIndex,
    preis: null,
    hatWarum: false,
  };
}

describe('sonnenstromModell', () => {
  it('summiert Sonne- und Haus-Balken aus energieFluss, gerundet auf ganze kWh', () => {
    // Slot 0 (vorbei, gemessen): Sonne 4 kW deckt Haus 1 kW, lädt Speicher mit Rest.
    // Slot 1 (läuft): Sonne weg, Haus 1 kW ganz aus dem Netz.
    const slots = [
      slot(0, { pvKw: 4, loadKw: 1, batteryKw: 3, measuredPvKw: 4, measuredLoadKw: 1 }),
      slot(1, { pvKw: 0, loadKw: 4, batteryKw: 0 }),
    ];
    const tag = tagModell(slots, 1);
    const m = sonnenstromModell(tag, false);
    expect(m.sonne.auto).toBeNull();
    // Die Teile runden EINZELN (AP-08) - ihre Summe darf wie im Report-Beispiel
    // (Haus 4 · Speicher 9 · Netz 22 = 35, Gesamt 34 kWh) von der GESAMT-Rundung
    // abweichen; beide bleiben aber höchstens 1 kWh auseinander.
    expect(Math.abs(m.sonne.gesamtKwh - (m.sonne.haus + m.sonne.speicher + m.sonne.netz))).toBeLessThanOrEqual(1);
    expect(Math.abs(m.haus.gesamtKwh - (m.haus.sonne + m.haus.speicher + m.haus.netz))).toBeLessThanOrEqual(1);
    // Sonne lädt Speicher (Slot 0) und deckt das Haus (Slot 0); Slot 1 bezieht
    // das Haus komplett aus dem Netz - die Netz-Zeile des Hauses ist > 0.
    expect(m.sonne.speicher).toBeGreaterThan(0);
    expect(m.haus.netz).toBeGreaterThan(0);
  });

  it('zeigt den Wallbox-Hinweis nur mit Wallbox UND viel Netz-Export', () => {
    // Ein Tag mit großem Überschuss: Sonne 20 kW, Haus 1 kW, über 40 Viertelstunden (10 h) gleich.
    const slots = Array.from({ length: 40 }, (_, i) => slot(i, { pvKw: 20, loadKw: 1, batteryKw: 0 }));
    const tag = tagModell(slots, 39);
    const ohneWallbox = sonnenstromModell(tag, false);
    expect(ohneWallbox.wallboxHinweis).toBeNull();
    const mitWallbox = sonnenstromModell(tag, true);
    expect(mitWallbox.sonne.netz).toBeGreaterThanOrEqual(WALLBOX_HINWEIS_AB_KWH);
    expect(mitWallbox.wallboxHinweis).toMatch(/Wallbox/);
    expect(mitWallbox.wallboxHinweis).toContain(`${mitWallbox.sonne.netz}`);
  });

  it('bleibt bei wenig Netz-Export ohne Hinweis, auch mit Wallbox', () => {
    const slots = [slot(0, { pvKw: 1, loadKw: 1, batteryKw: 0 })];
    const tag = tagModell(slots, 0);
    expect(sonnenstromModell(tag, true).wallboxHinweis).toBeNull();
  });
});

describe('autarkieHeute', () => {
  it('mischt die gemessene Autarkie bis jetzt mit dem geplanten Rest des Tages', () => {
    // Gemessen: 10 kWh Verbrauch, 2 kWh davon aus dem Netz (80 % autark).
    // Geplant (4 Viertelstunden à 1 kW Last, Sonne deckt sie voll): 1 kWh Verbrauch, 0 kWh Netz.
    const slots = [slot(0), slot(1), slot(2), slot(3)].map((s) => ({ ...s, pvKw: 2, loadKw: 1, batteryKw: 0 }));
    const tag = tagModell(slots, -1); // jetztIndex -1: alle vier Slots zählen als "ab jetzt".
    const a = autarkieHeute(tag, { consumptionKwh: 10, gridImportKwh: 2 });
    expect(a?.quelle).toBe('gemischt');
    // (10-2 + 1) / (10 + 1) * 100 = 81,8 % → gerundet 82 %.
    expect(a?.pct).toBe(82);
  });

  it('fällt ohne Messung auf den rein geplanten Rest zurück - nie eine erfundene Zahl', () => {
    const slots = [slot(0, { pvKw: 2, loadKw: 1, batteryKw: 0 })];
    const tag = tagModell(slots, -1);
    const a = autarkieHeute(tag, null);
    expect(a?.quelle).toBe('geplant');
    expect(a?.pct).toBe(100);
  });

  it('gibt null zurück, trägt weder Messung noch Plan einen Verbrauch', () => {
    const tag = tagModell([], -1);
    expect(autarkieHeute(tag, null)).toBeNull();
    expect(autarkieHeute(tag, { consumptionKwh: 0, gridImportKwh: 0 })).toBeNull();
  });
});
