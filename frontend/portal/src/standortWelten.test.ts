import { describe, expect, it } from 'vitest';
import { amStandort as berichteAmStandort, LEER as LEER_BERICHTE, LEER_STANDORT as LEER_BERICHTE_STANDORT } from './berichtSeite';
import { STANDORT_BERICHTE, STANDORT_KENNZAHLEN } from './ebenenNav';
import { amStandort as kennzahlenAmStandort, LEER as LEER_KENNZAHLEN, LEER_STANDORT as LEER_KENNZAHLEN_STANDORT } from './kennzahlKarte';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/**
 * UEMS AP-13 IP-2 (Ü8, K3): „Kennzahlen dieses Standorts“ und „Berichte dieses Standorts“ — dieselben Listen wie am
 * Unternehmen, gefiltert auf Geltung ⊆ Standort. Eine Kennzahl oder ein Bericht des Unternehmens erscheint dort nie (R-A1).
 */
describe('AP-13 IP-2 · Kennzahlen und Berichte am Standort', () => {
  it('Kennzahlen: Standort, Gebäude oder Prozess mit Ort im Standort — nie die des Unternehmens', () => {
    const alle = ahrenbergKennzahlen();
    const werk = kennzahlenAmStandort(alle, FIXTURE_IDS.st1);
    const lindach = kennzahlenAmStandort(alle, FIXTURE_IDS.st2);
    expect(werk.length).toBeGreaterThan(0);
    expect(lindach.length).toBeGreaterThan(0);
    expect(werk.every((k) => k.standort_id === FIXTURE_IDS.st1)).toBe(true);
    expect(lindach.every((k) => k.standort_id === FIXTURE_IDS.st2)).toBe(true);
    const unternehmen = alle.filter((k) => k.standort_id === null);
    expect(unternehmen.length).toBeGreaterThan(0);
    for (const k of unternehmen) {
      expect(werk).not.toContain(k);
      expect(lindach).not.toContain(k);
    }
    // Die Reihenfolge der Route bleibt.
    expect(werk).toEqual(alle.filter((k) => k.standort_id === FIXTURE_IDS.st1));
  });

  it('Berichte: nur `geltung_art = standort` für genau diesen Standort', () => {
    const liste = [
      { kennung: 'BR-1', geltung_art: 'standort' as const, geltung_id: FIXTURE_IDS.st1 },
      { kennung: 'BR-2', geltung_art: 'unternehmen' as const, geltung_id: FIXTURE_IDS.st1 },
      { kennung: 'BR-3', geltung_art: 'standort' as const, geltung_id: FIXTURE_IDS.st2 },
    ];
    expect(berichteAmStandort(liste, FIXTURE_IDS.st1).map((b) => b.kennung)).toEqual(['BR-1']);
    expect(berichteAmStandort(liste, FIXTURE_IDS.st2).map((b) => b.kennung)).toEqual(['BR-3']);
  });

  it('die Wörter: Überschrift = Einstieg, und der Leersatz sagt „für diesen Standort“ statt „es gibt keine“', () => {
    expect(STANDORT_KENNZAHLEN).toBe('Kennzahlen dieses Standorts');
    expect(STANDORT_BERICHTE).toBe('Berichte dieses Standorts');
    expect(LEER_KENNZAHLEN_STANDORT).toMatch(/^Für diesen Standort /);
    expect(LEER_BERICHTE_STANDORT).toMatch(/^Für diesen Standort /);
    expect(LEER_KENNZAHLEN_STANDORT).not.toBe(LEER_KENNZAHLEN);
    expect(LEER_BERICHTE_STANDORT).not.toBe(LEER_BERICHTE);
  });
});
