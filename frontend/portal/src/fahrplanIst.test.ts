import { describe, expect, it } from 'vitest';
import { istLadestand, istVerlauf } from './fahrplanIst';
import { tagModell, type TagSlot } from './fahrplanTag';

const TAG = new Date(2026, 9, 20);

function viertel(i: number): TagSlot {
  return {
    start: new Date(TAG.getTime() + i * 15 * 60_000).toISOString(),
    batteryKw: 0,
    socPct: 50,
    priceEurMwh: 100,
    costEur: 0,
    baselineCostEur: 0,
    slotRole: 'warten',
    slotFlags: null,
    storedValueCtKwh: 28,
    importPriceCtKwh: 30,
    exportValueCtKwh: 8,
  };
}

const tag = tagModell({
  slots: Array.from({ length: 96 }, (_, i) => viertel(i)),
  slotMinutes: 15,
  now: new Date(2026, 9, 20, 1, 10),
  plantKind: 'eigenverbrauch',
});
const eimer = (i: number, soc: number | null) => ({ start: viertel(i).start, socLastPct: soc });

describe('istLadestand · der gemessene Ladestand je Viertelstunde', () => {
  it('ordnet jeden Verlaufs-Eimer seiner Viertelstunde zu - über den Beginn, nicht über den Index', () => {
    const ist = istLadestand(tag, [eimer(2, 40), eimer(0, 42), eimer(1, 41)]);
    expect(ist.slice(0, 4)).toEqual([42, 41, 40, null]);
  });

  it('misst nie in die Zukunft und erfindet keine 0', () => {
    const ist = istLadestand(tag, [eimer(4, 38), eimer(5, 37), eimer(6, null)]);
    // 01:10 läuft die Viertelstunde 4; 5 und 6 liegen in der Zukunft.
    expect(ist.slice(3, 7)).toEqual([null, 38, null, null]);
  });

  it('begrenzt Ausreißer auf 0–100 % und liefert ohne Verlauf nur Lücken', () => {
    expect(istLadestand(tag, [eimer(0, 104)])[0]).toBe(100);
    expect(istLadestand(tag, null).every((x) => x == null)).toBe(true);
  });
});

describe('istVerlauf · was der Speicher in einer Phase gemessen tat', () => {
  const ist = [50, 48, 46, null, 44];

  it('nimmt den Stand vor der Phase und an ihrem Ende', () => {
    expect(istVerlauf(ist, 1, 2)).toEqual({ von: 50, bis: 46 });
    expect(istVerlauf(ist, 0, 1)).toEqual({ von: 50, bis: 48 });
  });

  it('schweigt, wenn eine der beiden Messungen fehlt', () => {
    expect(istVerlauf(ist, 4, 4)).toBeNull();
    expect(istVerlauf(ist, 2, 3)).toBeNull();
  });
});
