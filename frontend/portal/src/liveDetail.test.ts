import { describe, expect, it } from 'vitest';
import {
  flowHasValues,
  headSentenceVisible,
  initialVerlaufOpen,
  LIVE_WINDOWS,
  liveChip,
  windowStart,
  withDayTotals,
} from './liveDetail';
import type { LiveSnapshot } from './live';
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

  // --- V2 (Audit): no fabricated zero next to an honest "no data" ----------

  it('V2: a row that says „noch keine Daten" gets NO day total appended', () => {
    // The board read „noch keine Daten · 0,0 kWh heute" — the two halves of one
    // line contradicted each other.
    const rows = withDayTotals(
      [row({ key: 'v1-pv', role: 'pv', stateLabel: 'noch keine Daten', value: '—' })],
      totals,
    );
    expect(rows[0].subLine).toBeUndefined();
  });

  it('V2: a 0-bucket total is „not reported", never printed as 0,0 kWh', () => {
    // The history endpoint returns pvGenerationKwh: 0.0 on a day with ZERO
    // buckets (while correctly nulling the cost fields).
    const zeroDay = { pvGenerationKwh: 0, consumptionKwh: 0 } as never;
    const rows = withDayTotals(
      [row({ key: 'v1-pv', role: 'pv' }), row({ key: 'v1-haus', role: 'consumer', title: 'Haus' })],
      zeroDay,
    );
    expect(rows[0].subLine).toBeUndefined();
    expect(rows[1].subLine).toBeUndefined();
    // A real, non-zero total still shows.
    expect(withDayTotals([row({ role: 'pv' })], totals)[0].subLine).toBe(`32,1${NBSP}kWh heute`);
  });
});

describe('flowHasValues — V14: collapse a diagram that would be four dashes', () => {
  const snap = (over: Partial<LiveSnapshot>): LiveSnapshot =>
    ({ pvKw: null, loadKw: null, gridKw: null, socPct: null, battKw: null, ts: null, ...over }) as
      LiveSnapshot;

  it('false when neither source carries a single value', () => {
    expect(flowHasValues(null, snap({}))).toBe(false);
    expect(flowHasValues(null, null)).toBe(false);
  });

  it('true from the v1 snapshot as soon as ONE channel has a value', () => {
    expect(flowHasValues(null, snap({ pvKw: 0 }))).toBe(true);
    expect(flowHasValues(null, snap({ socPct: 87 }))).toBe(true);
  });

  it('reads the migrated topology: node value, SoC or a member value', () => {
    const topo = (nodes: unknown[]) =>
      ({ schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes } }) as never;
    const silent = topo([
      { role: 'pv', flow_active: false, members: [{ entity_id: 'e', label: 'x', primary: true }] },
    ]);
    expect(flowHasValues(silent, snap({}))).toBe(false);
    expect(
      flowHasValues(
        topo([{ role: 'pv', value_kw: 5.9, flow_active: true, members: [] }]),
        snap({}),
      ),
    ).toBe(true);
    expect(
      flowHasValues(topo([{ role: 'storage', soc_pct: 87, flow_active: false, members: [] }]), snap({})),
    ).toBe(true);
    expect(
      flowHasValues(
        topo([
          {
            role: 'pv',
            flow_active: false,
            members: [{ entity_id: 'e', label: 'x', primary: true, value_kw: 1.2 }],
          },
        ]),
        snap({}),
      ),
    ).toBe(true);
  });
});

describe('Die Kopfsatz-Regel der Bühne (§6.2)', () => {
  /** Der Normalfall der Bühne: alles läuft, das Diagramm zeigt es. */
  const ok = { projected: true, tone: 'ok' as const, hasFlow: true };

  it('schweigt im Normalfall - der Fluss IST der Satz', () => {
    expect(headSentenceVisible(ok)).toBe(false);
  });

  it('spricht, sobald er etwas anderes sagt als das Diagramm', () => {
    // Eine Warnung nennt eine Ursache, die kein Kreis zeigt.
    expect(headSentenceVisible({ ...ok, tone: 'warn' })).toBe(true);
    expect(headSentenceVisible({ ...ok, tone: 'off' })).toBe(true);
    // Kein zeichenbarer Fluss: dann ist der Satz die einzige Aussage.
    expect(headSentenceVisible({ ...ok, hasFlow: false })).toBe(true);
    // Noch kein Zustand geladen - nie stillschweigend nichts sagen.
    expect(headSentenceVisible({ ...ok, tone: null })).toBe(true);
    expect(headSentenceVisible({ projected: true, hasFlow: true })).toBe(true);
  });

  it('lässt das v1-Zonen-Dashboard und den Einrichtungspfad unangetastet', () => {
    // Die Regel gilt NUR auf der Bühne; alles andere rendert wie bisher.
    expect(headSentenceVisible({ ...ok, projected: false })).toBe(true);
    expect(headSentenceVisible({ projected: false, tone: 'ok', hasFlow: false })).toBe(true);
  });
});
