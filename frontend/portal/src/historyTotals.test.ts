import { describe, expect, it } from 'vitest';
import type { HistoryTotals } from './api';

/**
 * Hygiene guard for the portal ↔ backend type drift the UI design flagged
 * (`HistoryTotalsDto`, audit V2/X1/H3/X2):
 *
 *  - the four energy sums are server-side NULLABLE, so the TS interface must
 *    accept null (it declared `number`, which is why consumers believed a sum
 *    is always present);
 *  - the planned battery saving is `batterySavingsPlannedEur` - the deprecated
 *    `batterySavingsEur` alias must NOT be part of the portal type, so no new
 *    reader can appear;
 *  - `tarifArt`/`tarifPriced` travel with `gridCostEur` (valued at the site's
 *    real supply price since the structured Bezugspreis, bare spot only
 *    without any price data), so a surface can label that number truthfully.
 *
 * These are compile-time facts; the assertions exist so the intent is visible in
 * the suite and a regression fails the type-check with a named test.
 */
describe('HistoryTotals mirrors HistoryTotalsDto', () => {
  it('accepts null for every one of the four energy sums', () => {
    const nothingMeasured: HistoryTotals = {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: null,
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    };
    expect(nothingMeasured.pvGenerationKwh).toBeNull();
  });

  it('names the planned saving "geplant" and carries the tariff context', () => {
    const totals: HistoryTotals = {
      consumptionKwh: 18.4,
      pvGenerationKwh: 32.1,
      gridImportKwh: 3.2,
      gridExportKwh: 9.6,
      gridCostEur: 0.94,
      tarifArt: 'dynamisch',
      tarifPriced: true,
      batterySavingsPlannedEur: 1.2,
      autarkiePct: 82,
      eigenverbrauchPct: 64,
    };
    expect(totals.batterySavingsPlannedEur).toBe(1.2);
    expect(totals.tarifArt).toBe('dynamisch');
    expect(totals.tarifPriced).toBe(true);
    // The deprecated alias is not part of the portal type.
    expect('batterySavingsEur' in totals).toBe(false);
  });
});
