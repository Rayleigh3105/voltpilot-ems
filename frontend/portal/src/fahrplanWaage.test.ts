import { describe, expect, it } from 'vitest';
import type { WhySlot } from './fahrplanWhy';
import { waage } from './fahrplanWaage';

function slot(over: Partial<WhySlot>): WhySlot {
  return {
    start: '2026-09-24T12:00:00Z',
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
    ...over,
  };
}

describe('waage · zwei Zahlen und ein Satz (E5)', () => {
  it('lädt aus dem Netz, weil gespeichert mehr wert ist, als es kostet', () => {
    const w = waage(slot({ slotRole: 'guenstig_laden', importPriceCtKwh: 19.3, storedValueCtKwh: 27.2 }), 'eigenverbrauch')!;
    expect(w.frage).toBe('Warum lädt er aus dem Netz?');
    expect(w.seiten!.map((s) => s.ct)).toEqual([19.3, 27.2]);
    expect(w.seiten![0].kosten).toBe(true);
    expect(w.gewaehlt).toBe(1);
    expect(w.urteil).toBe(
      'Gespeichert ist die Kilowattstunde mehr wert, als sie jetzt kostet. Speicherverluste und Verschleiß sind im Plan eingerechnet.',
    );
  });

  it('nennt nie eine Vorteils-Zahl - nur die Richtung', () => {
    const w = waage(slot({ slotRole: 'guenstig_laden', importPriceCtKwh: 19.3, storedValueCtKwh: 27.2 }), 'eigenverbrauch')!;
    expect(w.urteil).not.toMatch(/\d/);
  });

  it('speichert die Sonne und spricht je Anlagenart vom Einspeisen oder Verkaufen', () => {
    const s = slot({ slotRole: 'pv_speichern', exportValueCtKwh: 8.1, storedValueCtKwh: 27.2 });
    expect(waage(s, 'eigenverbrauch')!.seiten![0].label).toBe('Einspeisen brächte');
    expect(waage(s, 'direktvermarktung')!.seiten![0].label).toBe('Verkaufen brächte');
    expect(waage(s, 'direktvermarktung')!.urteil).toContain('mehr wert als verkauft');
  });

  it('deckt den Verbrauch, weil jetzt nutzen mehr spart, als Aufheben wert wäre', () => {
    const w = waage(slot({ slotRole: 'eigenverbrauch', importPriceCtKwh: 38.4, storedValueCtKwh: 27.2 }), 'eigenverbrauch')!;
    expect(w.gewaehlt).toBe(0);
    expect(w.seiten![1].hinweis).toBe('Wert gespeicherter Energie');
  });

  it('verkauft, wenn die Einspeisung mehr bringt, als Aufheben wert wäre', () => {
    const w = waage(slot({ slotRole: 'verkaufen', exportValueCtKwh: 31, storedValueCtKwh: 27.2 }), 'direktvermarktung')!;
    expect(w.frage).toBe('Warum verkauft er jetzt?');
    expect(w.gewaehlt).toBe(0);
  });

  it('zeigt keine Waage, deren schwerere Seite nicht gewählt wurde', () => {
    expect(waage(slot({ slotRole: 'guenstig_laden', importPriceCtKwh: 30, storedValueCtKwh: 27.2 }), 'eigenverbrauch')).toBeNull();
    expect(waage(slot({ slotRole: 'eigenverbrauch', importPriceCtKwh: 20, storedValueCtKwh: 27.2 }), 'eigenverbrauch')).toBeNull();
    expect(waage(slot({ slotRole: 'guenstig_laden', storedValueCtKwh: null }), 'eigenverbrauch')).toBeNull();
  });

  it('lässt beim Warten nur die Marge des Optimierers sprechen, inklusive Gleichstand', () => {
    const marge = waage(slot({ slotRole: 'warten', whyNextBest: 'decken', whyNextBestMarginCt: -2.4 }), 'eigenverbrauch')!;
    expect(marge.seiten).toBeNull();
    expect(marge.urteil).toBe('Den Verbrauch jetzt aus dem Speicher zu decken wäre 2,4 ct/kWh schlechter.');
    expect(marge.gleichstand).toBe(false);
    const gleich = waage(slot({ slotRole: 'reserve_halten', whyNextBest: 'verkaufen', whyNextBestMarginCt: 0.03 }), 'eigenverbrauch')!;
    expect(gleich.gleichstand).toBe(true);
    expect(gleich.urteil).toContain('praktisch gleichwertig');
    expect(waage(slot({ slotRole: 'warten' }), 'eigenverbrauch')).toBeNull();
  });

  it('überlässt Abregeln und Lastspitze dem Erklär-Panel', () => {
    expect(waage(slot({ slotRole: 'abregeln' }), 'eigenverbrauch')).toBeNull();
    expect(waage(slot({ slotRole: 'spitze_kappen' }), 'eigenverbrauch')).toBeNull();
  });
});
