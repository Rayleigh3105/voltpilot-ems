import { describe, expect, it } from 'vitest';
import {
  initialVerlaufOpen,
  LIVE_WINDOWS,
  liveChip,
  windowStart,
  withDayTotals,
} from './liveDetail';
import type { LivePulsRow } from './livePuls';
import { NBSP } from './format';

/**
 * Cockpit + Live-Daten merge (Option A) — the pure logic of the merged home's
 * "Komponenten im Detail" stratum: the live window (R3: „Seit 0 Uhr", never
 * „Heute"), the ONE freshness chip (R4, three states incl. site-only), the
 * Q2 disclosure default and the R2 kWh sub-lines.
 */

const NOW = new Date('2026-07-22T12:00:00+02:00');

describe('LIVE_WINDOWS — R3: two time controls never share a word', () => {
  it('labels the third window „Seit 0 Uhr", never „Heute"', () => {
    expect(LIVE_WINDOWS.map((w) => w.label)).toEqual(['1 Std', '3 Std', 'Seit 0 Uhr']);
    // The Bilanz period seg owns „Heute" — the live window must not reuse it.
    expect(LIVE_WINDOWS.some((w) => w.label === 'Heute')).toBe(false);
  });

  it('windowStart derives 1h/3h/local midnight', () => {
    expect(windowStart('1h', NOW).getTime()).toBe(NOW.getTime() - 3600_000);
    expect(windowStart('3h', NOW).getTime()).toBe(NOW.getTime() - 3 * 3600_000);
    const midnight = windowStart('today', NOW);
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getDate()).toBe(NOW.getDate());
  });
});

describe('liveChip — R4: ONE freshness truth, three honest states', () => {
  const ts = new Date(NOW.getTime() - 20_000).toISOString();

  it('live: the honest "Stand vor X"', () => {
    const chip = liveChip('live', ts, NOW)!;
    expect(chip.tone).toBe('ok');
    expect(chip.label).toContain('Stand');
  });

  it('site-only: says the per-device breakdown is missing — no greying', () => {
    const chip = liveChip('site-only', ts, NOW)!;
    expect(chip.tone).toBe('ok');
    expect(chip.label).toContain('einzelne Geräte melden noch nichts');
    // Without a known sample the wording stands alone.
    expect(liveChip('site-only', null, NOW)!.label).toBe(
      'Einzelne Geräte melden noch nichts',
    );
  });

  it('stale: "keine aktuellen Daten"; with no sample at all NO chip', () => {
    const chip = liveChip('stale', ts, NOW)!;
    expect(chip.tone).toBe('off');
    expect(chip.label).toBe('keine aktuellen Daten');
    // A site that never reported: the status sentence carries the story
    // ("wartet auf erste Daten") — a chip would be noise, never rendered.
    expect(liveChip('stale', null, NOW)).toBeNull();
  });
});

describe('initialVerlaufOpen — Q2: collapsed by default, remembered per session', () => {
  it('opens only on an explicit stored "1"', () => {
    expect(initialVerlaufOpen(null)).toBe(false);
    expect(initialVerlaufOpen('0')).toBe(false);
    expect(initialVerlaufOpen('')).toBe(false);
    expect(initialVerlaufOpen('1')).toBe(true);
  });
});

describe('withDayTotals — R2: the retired flow tiles’ kWh lines move to the board', () => {
  function row(over: Partial<LivePulsRow>): LivePulsRow {
    return {
      key: 'k',
      role: 'pv',
      icon: 'sun',
      title: 'Solar',
      value: '5,4 kW',
      stateLabel: 'erzeugt',
      stateTone: 'accent',
      health: 'ok',
      target: null,
      channels: [],
      ...over,
    };
  }
  const totals = { pvGenerationKwh: 32.1, consumptionKwh: 18.4 } as never;

  it('adds the PV kWh line and the house kWh line', () => {
    const rows = withDayTotals(
      [row({ key: 'v1-pv', role: 'pv' }), row({ key: 'v1-haus', role: 'consumer', title: 'Haus' })],
      totals,
    );
    expect(rows[0].subLine).toBe(`32,1${NBSP}kWh heute`);
    expect(rows[1].subLine).toBe(`18,4${NBSP}kWh heute`);
  });

  it('never overwrites an existing sub-line ("2 Erzeuger")', () => {
    const rows = withDayTotals([row({ role: 'pv', subLine: '2 Erzeuger' })], totals);
    expect(rows[0].subLine).toBe('2 Erzeuger');
  });

  it('never gives a Wallbox the house total, and absent totals add nothing', () => {
    const wb = row({ key: 'c-wb', role: 'consumer', title: 'Wallbox' });
    expect(withDayTotals([wb], totals)[0].subLine).toBeUndefined();
    expect(withDayTotals([row({ role: 'pv' })], null)[0].subLine).toBeUndefined();
    expect(
      withDayTotals([row({ role: 'pv' })], { pvGenerationKwh: null } as never)[0].subLine,
    ).toBeUndefined();
    // The v2 house row is identified by its generalised title.
    const haus = row({ key: 'consumer-e1-0', role: 'consumer', title: 'Hausverbrauch' });
    expect(withDayTotals([haus], totals)[0].subLine).toBe(`18,4${NBSP}kWh heute`);
  });
});
