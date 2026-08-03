import { describe, expect, it } from 'vitest';
import {
  buildWhatIfRequest,
  EMPTY_WHAT_IF_FORM,
  overrideChips,
  presetForWear,
  SPEICHERSCHONUNG_PRESETS,
  whatIfDeltaRows,
  whatIfFallbackNote,
  whatIfFormFromEffective,
  whatIfVerdict,
  type WhatIfFormState,
} from './optimizer';
import type { WhatIfPlan, WhatIfResult } from './optimizerApi';

/**
 * The what-if panel's pure half (design §4.3). Two things carry the honesty of
 * the whole surface and are pinned hardest here: an UNTOUCHED knob must never
 * reach the request (or the "solve it as configured" baseline stops being that
 * and the delta becomes meaningless), and a figure the solver could not price
 * must render "—" rather than a 0 that reads like a measured result.
 */

function plan(over: Partial<WhatIfPlan> = {}): WhatIfPlan {
  return {
    slotMinutes: 15,
    costEur: -1,
    baselineCostEur: 2,
    savingsEur: 3,
    wearCostEur: 1,
    netSavingsEur: 2,
    terminalValueEurPerKwh: 0.2,
    bankedValueEur: 0.5,
    chargedKwh: 10,
    dischargedKwh: 9,
    gridImportKwh: 20,
    gridExportKwh: 5,
    curtailedKwh: 0,
    cycles: 1,
    socStartPct: 20,
    socEndPct: 40,
    peakTargetKw: null,
    fallback14a: false,
    knobs: {
      wearCostCtPerKwh: 4,
      backupReserveSocPct: null,
      socMinPct: 5,
      socMaxPct: 95,
      netzladenErlaubt: true,
    },
    slots: [],
    ...over,
  };
}

function result(over: Partial<WhatIfResult> = {}): WhatIfResult {
  return {
    siteId: 's-1',
    computedAt: '2026-08-03T10:00:00Z',
    horizonSlots: 96,
    slotMinutes: 15,
    appliedOverrides: { wearCostCtPerKwh: 8 },
    baseline: plan(),
    variant: plan({ netSavingsEur: 3.5, savingsEur: 4, wearCostEur: 0.5, cycles: 0.4 }),
    delta: { netSavingsEur: 1.5, savingsEur: 1, wearCostEur: -0.5, cycles: -0.6 },
    ...over,
  };
}

describe('buildWhatIfRequest', () => {
  it('sends NOTHING for an untouched form - the empty request IS "as configured"', () => {
    const r = buildWhatIfRequest(EMPTY_WHAT_IF_FORM);
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({});
    expect(r.changed).toBe(0);
  });

  it('sends only the knobs that were actually moved', () => {
    const form: WhatIfFormState = { ...EMPTY_WHAT_IF_FORM, wearCostCtPerKwh: '8', netzladen: 'nein' };
    const r = buildWhatIfRequest(form);
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ wearCostCtPerKwh: 8, netzladenErlaubt: false });
    expect(r.changed).toBe(2);
  });

  it('keeps a deliberate 0 (a 0 % reserve IS a change, not an empty field)', () => {
    const r = buildWhatIfRequest({ ...EMPTY_WHAT_IF_FORM, backupReserveSocPct: '0' });
    expect(r.body).toEqual({ backupReserveSocPct: 0 });
  });

  it('accepts a German decimal comma', () => {
    expect(buildWhatIfRequest({ ...EMPTY_WHAT_IF_FORM, wearCostCtPerKwh: '4,5' }).body)
      .toEqual({ wearCostCtPerKwh: 4.5 });
  });

  it.each([
    ['wearCostCtPerKwh', 'abc', 'Verschleißkosten'],
    ['wearCostCtPerKwh', '-1', 'Verschleißkosten'],
    ['backupReserveSocPct', '140', 'Backup-Reserve'],
    ['socMinPct', '-5', 'SoC-Untergrenze'],
  ])('refuses %s = %s with a German message', (key, value, label) => {
    const r = buildWhatIfRequest({ ...EMPTY_WHAT_IF_FORM, [key]: value } as WhatIfFormState);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(label);
  });

  it('refuses an inverted SoC band before the round trip (mirrors the server 400)', () => {
    const r = buildWhatIfRequest({ ...EMPTY_WHAT_IF_FORM, socMinPct: '80', socMaxPct: '20' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('SoC-Band');
  });

  it('does not judge a one-sided band - only the server knows the other side', () => {
    expect(buildWhatIfRequest({ ...EMPTY_WHAT_IF_FORM, socMinPct: '99' }).ok).toBe(true);
  });
});

describe('Speicherschonung presets', () => {
  it('carries the same ct ladder the customer preset writes (1 / 4 / 8)', () => {
    expect(SPEICHERSCHONUNG_PRESETS.map((p) => p.wearCt)).toEqual([1, 4, 8]);
  });

  it('recognises the active preset and stays null on a free value', () => {
    expect(presetForWear('8')).toBe('schonend');
    expect(presetForWear('4')).toBe('ausgewogen');
    expect(presetForWear('6')).toBeNull();
    expect(presetForWear('')).toBeNull();
    expect(presetForWear('abc')).toBeNull();
  });
});

describe('whatIfFormFromEffective', () => {
  it('prefills from the site and leaves an unset override empty', () => {
    const form = whatIfFormFromEffective(
      { wearCostCtPerKwh: 4, socMinPct: 5, socMaxPct: 95, backupReserveSocPct: null },
      false,
    );
    expect(form).toEqual({
      wearCostCtPerKwh: '4',
      backupReserveSocPct: '',
      socMinPct: '5',
      socMaxPct: '95',
      netzladen: 'nein',
    });
  });
});

describe('whatIfDeltaRows', () => {
  it('tones a money row by direction and leaves throughput neutral', () => {
    const rows = whatIfDeltaRows(result());
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by('netSavingsEur').tone).toBe('better'); // more savings
    expect(by('wearCostEur').tone).toBe('better'); // LESS wear is better
    expect(by('cycles').tone).toBe('flat'); // fewer cycles is not a verdict
  });

  it('marks a worse variant as worse', () => {
    const rows = whatIfDeltaRows(result({ delta: { netSavingsEur: -2 } }));
    expect(rows.find((r) => r.key === 'netSavingsEur')!.tone).toBe('worse');
  });

  it('renders an unpriceable figure as "—" and never as a zero difference', () => {
    const rows = whatIfDeltaRows(
      result({
        baseline: plan({ netSavingsEur: null }),
        variant: plan({ netSavingsEur: null }),
        delta: { netSavingsEur: null },
      }),
    );
    const row = rows.find((r) => r.key === 'netSavingsEur')!;
    expect(row.baseline).toBe('—');
    expect(row.variant).toBe('—');
    expect(row.delta).toBe('—');
    expect(row.tone).toBe('unknown');
  });

  it('shows a sign on every non-null delta', () => {
    const rows = whatIfDeltaRows(result());
    expect(rows.find((r) => r.key === 'netSavingsEur')!.delta).toMatch(/^\+/);
    // de-DE renders the MINUS SIGN (U+2212), not a hyphen - fmtEur already
    // carries it, so the builder must not prepend a second one.
    expect(rows.find((r) => r.key === 'wearCostEur')!.delta).toMatch(/^−/);
  });
});

describe('whatIfVerdict', () => {
  it('says nothing was changed when nothing was', () => {
    expect(whatIfVerdict(result({ appliedOverrides: {}, delta: { netSavingsEur: 0 } })))
      .toContain('Kein Regler verändert');
  });

  it('names the NET difference (savings minus the wear spent on them)', () => {
    const text = whatIfVerdict(result());
    expect(text).toContain('mehr Ersparnis');
    expect(text).toContain('netto');
  });

  it('is sign-honest about a worse variant', () => {
    expect(whatIfVerdict(result({ delta: { netSavingsEur: -1.5 } })))
      .toContain('weniger Ersparnis');
  });

  it('calls a sub-cent difference what it is instead of dramatising it', () => {
    expect(whatIfVerdict(result({ delta: { netSavingsEur: 0.001 } }))).toContain('kein Geld');
  });

  it('claims NO recommendation when the difference cannot be priced', () => {
    const text = whatIfVerdict(result({ delta: { netSavingsEur: null } }));
    expect(text).toContain('nicht in Euro beziffern');
    expect(text).not.toMatch(/mehr|weniger/);
  });
});

describe('overrideChips', () => {
  it('names each knob in German, with 0 % reserve spelled out', () => {
    expect(overrideChips({ wearCostCtPerKwh: 8 })[0]).toContain('Verschleiß');
    expect(overrideChips({ backupReserveSocPct: 0 })[0]).toBe('Backup-Reserve: keine');
    expect(overrideChips({ backupReserveSocPct: 30 })[0]).toContain('30');
    expect(overrideChips({ netzladenErlaubt: false })[0]).toContain('EEG');
    expect(overrideChips({ netzladenErlaubt: true })[0]).toBe('Netzladen erlaubt');
  });

  it('is empty when nothing was overridden', () => {
    expect(overrideChips({})).toEqual([]);
  });
});

describe('whatIfFallbackNote', () => {
  it('stays silent when both runs kept the §14a limit', () => {
    expect(whatIfFallbackNote(result())).toBeNull();
  });

  it('warns that the numbers are not comparable when only ONE run dropped it', () => {
    const note = whatIfFallbackNote(
      result({ variant: plan({ fallback14a: true }) }),
    );
    expect(note).toContain('nicht direkt vergleichbar');
  });

  it('says both plans are advisory when both dropped it', () => {
    const note = whatIfFallbackNote(
      result({ baseline: plan({ fallback14a: true }), variant: plan({ fallback14a: true }) }),
    );
    expect(note).toContain('beratend');
  });
});
