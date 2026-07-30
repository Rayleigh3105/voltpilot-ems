import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHistoryCache,
  historyCacheKey,
  historyCacheSize,
  HISTORY_CACHE_MAX,
  HISTORY_TTL_MS,
  readHistoryCache,
  writeHistoryCache,
} from './historyCache';
import type { History } from './api';

function h(marker: string): History {
  return {
    range: 'day',
    from: marker,
    to: '',
    bucketMinutes: 15,
    buckets: [],
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
  };
}

beforeEach(() => clearHistoryCache());

describe('historyCacheKey', () => {
  it('unterscheidet Anlage, Zeitraum und Anker', () => {
    expect(historyCacheKey('s1', 'day', '2026-07-30')).toBe('s1|day|2026-07-30');
    expect(historyCacheKey('s1', 'month', '2026-07-30')).not.toBe(
      historyCacheKey('s1', 'day', '2026-07-30'),
    );
    expect(historyCacheKey('s2', 'day', '2026-07-30')).not.toBe(
      historyCacheKey('s1', 'day', '2026-07-30'),
    );
  });
});

describe('der Cache macht den Welt-Wechsel zu 0 Abrufen (P2)', () => {
  it('gibt dieselbe Periode ohne Abruf zurück', () => {
    const key = historyCacheKey('s1', 'month', '2026-07-01');
    expect(readHistoryCache(key)).toBeNull();
    writeHistoryCache(key, h('juli'));
    expect(readHistoryCache(key)?.from).toBe('juli');
  });

  it('gibt einen ABGELAUFENEN Eintrag nie zurück (die laufende Periode wächst)', () => {
    const key = historyCacheKey('s1', 'day', '2026-07-30');
    writeHistoryCache(key, h('heute'), 1_000);
    expect(readHistoryCache(key, 1_000 + HISTORY_TTL_MS - 1)?.from).toBe('heute');
    expect(readHistoryCache(key, 1_000 + HISTORY_TTL_MS + 1)).toBeNull();
    // Und der abgelaufene Eintrag ist damit auch weg, nicht nur unsichtbar.
    expect(historyCacheSize()).toBe(0);
  });
});

describe('der Cache wächst nicht unbegrenzt', () => {
  it('verdrängt den ältesten Eintrag an der Obergrenze', () => {
    for (let i = 0; i < HISTORY_CACHE_MAX + 3; i++) {
      writeHistoryCache(historyCacheKey('s1', 'day', `2026-01-${i}`), h(`d${i}`));
    }
    expect(historyCacheSize()).toBe(HISTORY_CACHE_MAX);
    // Die drei ältesten sind raus, der neueste ist da.
    expect(readHistoryCache(historyCacheKey('s1', 'day', '2026-01-0'))).toBeNull();
    expect(
      readHistoryCache(historyCacheKey('s1', 'day', `2026-01-${HISTORY_CACHE_MAX + 2}`))?.from,
    ).toBe(`d${HISTORY_CACHE_MAX + 2}`);
  });

  it('frischt einen erneut geschriebenen Eintrag auf, statt ihn zu doppeln', () => {
    const key = historyCacheKey('s1', 'day', '2026-07-30');
    writeHistoryCache(key, h('alt'), 1_000);
    writeHistoryCache(key, h('neu'), 2_000);
    expect(historyCacheSize()).toBe(1);
    expect(readHistoryCache(key, 2_000)?.from).toBe('neu');
  });
});
