import { describe, expect, it } from 'vitest';
import type { SupplyPrice } from './api';
import {
  buildSupplyPricePatch,
  parseSupplyPriceNumber,
  showSupplyPriceFields,
  SUPPLY_PRICE_FIELDS,
  SUPPLY_PRICE_UST_SUGGESTION,
  supplyPriceComponentsSumCt,
  supplyPriceFormValues,
  type SupplyPriceFormValues,
} from './supplyPrice';

describe('supplyPrice (Stufe 2 Bezugspreis-Komponenten)', () => {
  it('carries the researched suggestion set (Stand 2026, report Teil 2)', () => {
    expect(SUPPLY_PRICE_FIELDS.map((f) => [f.key, f.suggestion])).toEqual([
      ['netzentgeltArbeitspreisCt', 7.6],
      ['stromsteuerCt', 2.05],
      ['konzessionsabgabeCt', 1.59],
      ['umlagenCt', 2.946],
      ['vertriebsaufschlagCt', 1.5],
    ]);
    expect(SUPPLY_PRICE_UST_SUGGESTION).toBe(19);
  });

  it('shows the component fields only for the structured tariffs', () => {
    expect(showSupplyPriceFields('dynamisch')).toBe(true);
    expect(showSupplyPriceFields('ohne')).toBe(true);
    expect(showSupplyPriceFields('fest')).toBe(false);
  });

  it('parses numbers: empty=clear, comma ok, invalid/negative=undefined', () => {
    expect(parseSupplyPriceNumber('')).toBeNull();
    expect(parseSupplyPriceNumber('  ')).toBeNull();
    expect(parseSupplyPriceNumber('7,6')).toBe(7.6);
    expect(parseSupplyPriceNumber('7.6')).toBe(7.6);
    expect(parseSupplyPriceNumber('-1')).toBeUndefined();
    expect(parseSupplyPriceNumber('abc')).toBeUndefined();
  });

  it('prefills the suggestions when there is no maintained sheet', () => {
    for (const sheet of [null, undefined, { present: false } as unknown as SupplyPrice]) {
      const v = supplyPriceFormValues(sheet);
      expect(v.netzentgeltArbeitspreisCt).toBe('7.6');
      expect(v.umlagenCt).toBe('2.946');
      expect(v.ustPct).toBe('19');
      expect(v.komponentenStand).toBe('');
    }
  });

  it('shows the stored values verbatim for an existing sheet (cleared stays empty)', () => {
    const sheet: SupplyPrice = {
      present: true,
      hasComponents: true,
      netzentgeltArbeitspreisCt: 8.1,
      stromsteuerCt: null, // cleared
      konzessionsabgabeCt: 1.59,
      umlagenCt: 2.946,
      vertriebsaufschlagCt: 2,
      ustPct: 0,
      komponentenStand: '2026-01-01',
      updatedAt: '2026-07-29T00:00:00Z',
    };
    const v = supplyPriceFormValues(sheet);
    expect(v.netzentgeltArbeitspreisCt).toBe('8.1');
    expect(v.stromsteuerCt).toBe(''); // not re-prefilled with the suggestion
    expect(v.ustPct).toBe('0');
    expect(v.komponentenStand).toBe('2026-01-01');
  });

  it('sums the currently entered components (ignoring blanks)', () => {
    const v = supplyPriceFormValues(null); // suggestions
    expect(supplyPriceComponentsSumCt(v)).toBeCloseTo(15.686, 6);
    expect(supplyPriceComponentsSumCt({ ...v, umlagenCt: '' })).toBeCloseTo(12.74, 6);
  });

  it('builds a patch: components always sent (empty clears), ust/date honoured', () => {
    const v: SupplyPriceFormValues = {
      netzentgeltArbeitspreisCt: '7.6',
      stromsteuerCt: '', // cleared -> null
      konzessionsabgabeCt: '1,59',
      umlagenCt: '2.946',
      vertriebsaufschlagCt: '1.5',
      ustPct: '19',
      komponentenStand: '2026-01-01',
    };
    const built = buildSupplyPricePatch(v);
    expect('patch' in built).toBe(true);
    if ('patch' in built) {
      expect(built.patch.netzentgeltArbeitspreisCt).toBe(7.6);
      expect(built.patch.stromsteuerCt).toBeNull(); // cleared, not omitted
      expect(built.patch.konzessionsabgabeCt).toBe(1.59); // comma parsed
      expect(built.patch.ustPct).toBe(19);
      expect(built.patch.komponentenStand).toBe('2026-01-01');
    }
  });

  it('clears the date to null and omits an empty ust (NOT NULL server-side)', () => {
    const v = { ...supplyPriceFormValues(null), ustPct: '', komponentenStand: '' };
    const built = buildSupplyPricePatch(v);
    expect('patch' in built).toBe(true);
    if ('patch' in built) {
      expect(built.patch.komponentenStand).toBeNull();
      expect('ustPct' in built.patch).toBe(false);
    }
  });

  it('rejects an invalid component or USt with a German error', () => {
    const bad = buildSupplyPricePatch({
      ...supplyPriceFormValues(null),
      stromsteuerCt: '-3',
    });
    expect('error' in bad).toBe(true);
    const badUst = buildSupplyPricePatch({
      ...supplyPriceFormValues(null),
      ustPct: '150',
    });
    expect('error' in badUst).toBe(true);
  });
});
