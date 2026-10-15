import { describe, expect, it } from 'vitest';
import { katalogEintrag } from './werteKatalog';
import { ueberwachungSatz, vorgabenFuerBedingung } from './ueberwachungSatz';

const netz = katalogEintrag('anlage.netz.leistung')!;
const speicher = katalogEintrag('anlage.speicher.leistung')!;
const box = katalogEintrag('box.erreichbar')!;
const datenquelle = katalogEintrag('datenquelle.liefert_daten')!;

describe('ueberwachungSatz', () => {
  it('ueber: Netzbezug länger als 15 Minuten über 120 kW', () => {
    const satz = ueberwachungSatz(netz, { art: 'ueber', schwelle: 120, dauer_s: 900 }, 'warnung', 'kW');
    expect(satz).toContain('Sag mir Bescheid, wenn der Netzbezug länger als 15 Minuten über 120,0 kW liegt.');
    expect(satz).toContain('Warnung');
  });

  it('unter: Speicher-Leistung länger als 5 Minuten unter einer Schwelle', () => {
    const satz = ueberwachungSatz(speicher, { art: 'unter', schwelle: 2, dauer_s: 300 }, 'hinweis', 'kW');
    expect(satz).toBe('Sag mir Bescheid, wenn die Speicher-Leistung länger als 5 Minuten unter 2,0 kW liegt. · Hinweis');
  });

  it('ausserhalb: Speicher-Leistung außerhalb einer Spanne', () => {
    const satz = ueberwachungSatz(
      speicher,
      { art: 'ausserhalb', schwelleUnten: -5, schwelleOben: 5, dauer_s: 300 },
      'warnung',
      'kW',
    );
    expect(satz).toBe(
      'Sag mir Bescheid, wenn die Speicher-Leistung länger als 5 Minuten außerhalb -5,0 kW bis 5,0 kW liegt. · Warnung',
    );
  });

  it('zustand: Box meldet sich seit einer Dauer nicht', () => {
    const satz = ueberwachungSatz(box, { art: 'zustand', ziel: ['nicht_erreichbar'], dauer_s: 900 }, 'warnung');
    expect(satz).toBe('Sag mir Bescheid, wenn die Box länger als 15 Minuten nicht erreichbar ist. · Warnung');
  });

  it('zustand mit mehreren Zielzuständen verbindet sie mit "oder"', () => {
    const satz = ueberwachungSatz(
      datenquelle,
      { art: 'zustand', ziel: ['stale', 'never'], dauer_s: 3600 },
      'warnung',
    );
    expect(satz).toBe('Sag mir Bescheid, wenn die Datenquelle länger als 1 Stunde veraltet oder noch nie geliefert ist. · Warnung');
  });

  it('keine_daten: seit einer Dauer ohne neuen Wert', () => {
    const satz = ueberwachungSatz(netz, { art: 'keine_daten', dauer_s: 900 }, 'hinweis');
    expect(satz).toBe('Sag mir Bescheid, wenn der Netzbezug seit 15 Minuten ohne neuen Wert ist. · Hinweis');
  });
});

describe('vorgabenFuerBedingung', () => {
  it('Dauer und Erholdauer sind immer 5 Minuten (§9)', () => {
    expect(vorgabenFuerBedingung('ueber', 120)).toMatchObject({ dauer_s: 300, erholen_s: 300 });
    expect(vorgabenFuerBedingung('keine_daten')).toMatchObject({ dauer_s: 300, erholen_s: 300 });
  });

  it('ueber: die Rückkehrschwelle liegt NIEDRIGER als die Schwelle (zurück darunter)', () => {
    const v = vorgabenFuerBedingung('ueber', 120);
    expect(v.rueckkehr).toBeLessThan(120);
    expect(v.rueckkehr).toBeCloseTo(114, 5); // 120 - 5 % = 114
  });

  it('unter: die Rückkehrschwelle liegt HÖHER als die Schwelle (zurück darüber)', () => {
    const v = vorgabenFuerBedingung('unter', 10);
    expect(v.rueckkehr).toBeGreaterThan(10);
    expect(v.rueckkehr).toBeCloseTo(10.5, 5); // 10 + 5 % = 10,5
  });

  it('ausserhalb: beide Rückkehrschwellen rücken Richtung Mitte', () => {
    const v = vorgabenFuerBedingung('ausserhalb', -10, 10);
    expect(v.rueckkehrUnten).toBeGreaterThan(-10);
    expect(v.rueckkehrOben).toBeLessThan(10);
  });

  it('die Rückkehrschwelle unterschreitet nie die Auflösung der Größe', () => {
    // 1 % von 1 kW wäre 0,01 - die Auflösung 0,1 gewinnt.
    const v = vorgabenFuerBedingung('ueber', 1, undefined, 0.1);
    expect(v.rueckkehr).toBeCloseTo(0.9, 5);
  });
});
