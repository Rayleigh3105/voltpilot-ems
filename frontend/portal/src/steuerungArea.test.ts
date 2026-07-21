import { describe, expect, it } from 'vitest';
import type { EarningsSite } from './api';
import type { EditorEntity, FlowDocument } from './flows/model';
import { NBSP } from './format';
import {
  AKTIVE_MODI_INTRO,
  batteryModes,
  coOptimization,
  contributionRows,
  entityChips,
  modeActions,
  peakContributionNote,
  requirementHint,
  socReservationStack,
  storageEntities,
  toolbox,
} from './steuerungArea';
import { activeModes, type AnlageSurfaceInput, type SurfaceFlow } from './surface';
import {
  NODE_ATYPICAL_GRID,
  NODE_MARKET,
  NODE_PEAKSHAVING,
  NODE_SELFCONSUMPTION,
} from './usageProfile';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function doc(nodes: Array<{ id: string; type: string }>): FlowDocument {
  return {
    schema_version: '1.0',
    name: 'flow',
    runtime: 'edge',
    nodes: nodes.map((n) => ({ ...n, type_version: '1.0.0' })),
    edges: [],
    triggers: [],
  };
}

function flow(flowId: string, name: string, types: string[]): SurfaceFlow {
  return {
    flowId,
    name,
    activeVersion: 1,
    latestLifecycle: 'active',
    latestDocument: doc(types.map((type, i) => ({ id: `n${i}`, type }))),
  };
}

function ent(
  id: string,
  entityType: string,
  label: string,
  measure: string[] = [],
  actuate: string[] = [],
): EditorEntity {
  return { id, entityType, label, measure, actuate };
}

const BATTERY = ent('e-batt', 'battery-hybrid', 'Speicher', ['soc_pct'], ['setpoint_kw']);
const PV = ent('e-pv', 'producer', 'PV-Dach', ['pv_power_kw']);
const GRID = ent('e-grid', 'grid-meter', 'Netz-Zähler', ['power_kw']);
const WALLBOX = ent('e-wb', 'wallbox', 'Wallbox', ['power_kw'], ['on_off']);

/** Gewerbe: Peak (master data) + Eigenverbrauch (storage ∧ PV) — the union. */
const GEWERBE: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', leistungspreisEurKw: 120 },
  flows: [],
  entities: [],
};

/** Multi-Modus: peak + market (flow) + EV + one automation. */
const MULTI: AnlageSurfaceInput = {
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch', leistungspreisEurKw: 90 },
  flows: [
    flow('f-market', 'Marktoptimierung', [NODE_MARKET]),
    flow('f-wb', 'Wallbox nur bei PV-Überschuss', ['vp.entity.control']),
  ],
  entities: [],
};

const EARNINGS: EarningsSite = {
  id: 's1',
  name: 'Halle Nord',
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  realizedExportCtKwh: null,
  marketValueSolarCtKwh: null,
  marketValueProvisional: null,
  baselineEur: null,
  actualEur: null,
  savedEur: 42.5,
  arbitrageEur: null,
  pvShiftEur: null,
  coveredSlots: 96,
  firstCoveredDate: null,
  reason: null,
  dailySaved: [],
  tarifArt: 'fest',
  tarifParamCtKwh: null,
  einspeiseErloesEur: 11,
  eigenverbrauchsWertEur: 88.25,
  gesamtertragEur: 99.25,
  selbstverbrauchKwh: null,
  eingespeistKwh: null,
  batterieBewegtKwh: null,
  expectedMarketValueSolarCtKwh: null,
  expectedMarketValueFrom: null,
  expectedMarketValueTo: null,
  expectedMarketValueSlots: null,
  series: [],
  monthlyStrip: [],
  peakShaving: {
    leistungspreisEurKw: 120,
    abrechnung: 'jahr',
    periodStart: '2026-01-01',
    peakKw: 180,
    baselinePeakKw: 210,
    avoidedKw: 30,
    avoidedEur: 3600,
    history: [],
  },
} as unknown as EarningsSite;

// ---------------------------------------------------------------------------
// 1 · Beitrag
// ---------------------------------------------------------------------------

describe('contributionRows', () => {
  it('reads the real number of each mode stream (peak = billing period)', () => {
    const modes = activeModes(GEWERBE);
    const peak = modes.find((m) => m.kind === 'lastspitzenkappung')!;
    const ev = modes.find((m) => m.kind === 'eigenverbrauch')!;

    const peakRows = contributionRows(peak, EARNINGS);
    expect(peakRows).toHaveLength(1);
    expect(peakRows[0].label).toBe('Vermiedene Leistungskosten');
    expect(peakRows[0].value).toContain('3.600');
    expect(peakRows[0].period).toBe('billing-period');
    expect(peakRows[0].note).toBe('laufende Abrechnungsperiode');

    const evRows = contributionRows(ev, EARNINGS);
    expect(evRows.map((r) => r.label)).toEqual(['Wert des Eigenverbrauchs', 'Einspeise-Erlös']);
    expect(evRows[0].value).toContain('88,25');
    expect(evRows.every((r) => r.period === 'range')).toBe(true);
  });

  it('shows "—" (null value) instead of a fabricated zero when nothing is attributable', () => {
    const auto = activeModes(MULTI).find((m) => m.kind === 'automation')!;
    const rows = contributionRows(auto, EARNINGS);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].note).toBe('Pro Regel noch nicht zugeordnet.');
  });

  it('yields null values (never 0) when the earnings response is missing', () => {
    const ev = activeModes(GEWERBE).find((m) => m.kind === 'eigenverbrauch')!;
    expect(contributionRows(ev, null).every((r) => r.value === null)).toBe(true);
  });

  it('peakContributionNote is null until the running period measured something', () => {
    expect(peakContributionNote(EARNINGS)).toBe(`Vermiedene Spitze: 30,0${NBSP}kW`);
    expect(peakContributionNote(null)).toBeNull();
    expect(
      peakContributionNote({
        ...EARNINGS,
        peakShaving: { ...EARNINGS.peakShaving!, avoidedKw: null },
      } as EarningsSite),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1 · Geräte-Chips + Aktionen
// ---------------------------------------------------------------------------

describe('entityChips', () => {
  const entities = [BATTERY, PV, GRID, WALLBOX];

  it('uses the REAL flow claims for a flow-backed mode', () => {
    const market = activeModes(MULTI).find((m) => m.kind === 'marktvermarktung')!;
    const chips = entityChips(
      market,
      {
        'e-batt': [{ flowId: 'f-market', flowName: 'Marktoptimierung' }],
        'e-wb': [{ flowId: 'f-wb', flowName: 'Wallbox' }],
      },
      entities,
    );
    expect(chips.map((c) => c.label)).toEqual(['Speicher']);
  });

  it('falls back to the storage unit for a master-data battery mode', () => {
    const peak = activeModes(GEWERBE).find((m) => m.kind === 'lastspitzenkappung')!;
    expect(peak.origin).toBe('masterdata');
    expect(entityChips(peak, null, entities).map((c) => c.label)).toEqual(['Speicher']);
  });

  it('claims nothing rather than guessing when there is no claim to show', () => {
    const market = activeModes(MULTI).find((m) => m.kind === 'marktvermarktung')!;
    expect(entityChips(market, {}, entities)).toEqual([]);
    expect(storageEntities([PV, GRID])).toEqual([]);
  });
});

describe('modeActions', () => {
  it('offers Details/Pausieren only for a resolvable flow (report §1.2 honesty)', () => {
    const modes = activeModes(MULTI);
    const market = modes.find((m) => m.kind === 'marktvermarktung')!;
    expect(modeActions(market)).toEqual({ canOpen: true, canPause: true, managedNote: null });

    const peak = modes.find((m) => m.kind === 'lastspitzenkappung')!;
    const actions = modeActions(peak);
    expect(actions.canOpen).toBe(false);
    expect(actions.canPause).toBe(false);
    expect(actions.managedNote).toBe('Von VoltPilot eingerichtet.');
  });

  it('never offers to open a preview mode (economics not built)', () => {
    const atyp = activeModes({
      signals: { hasStorage: false, hasPv: false, activeStrategyNodeTypes: [NODE_ATYPICAL_GRID] },
      flows: [flow('f-atyp', 'Atyp', [NODE_ATYPICAL_GRID])],
    }).find((m) => m.kind === 'atypische-netznutzung')!;
    expect(modeActions(atyp).canOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 · Ko-Optimierung + Reservierungs-Stack
// ---------------------------------------------------------------------------

describe('coOptimization', () => {
  it('is null below two battery-claiming modes', () => {
    const single = activeModes({
      signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
      config: { plantKind: 'eigenverbrauch' },
    });
    expect(batteryModes(single)).toHaveLength(1);
    expect(coOptimization(single)).toBeNull();
  });

  it('names the count once two modes share one battery', () => {
    const co = coOptimization(activeModes(GEWERBE))!;
    expect(co.count).toBe(2);
    expect(co.sentence).toBe('2 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.');
    expect(co.modeLabels).toEqual(['Lastspitzenkappung', 'Eigenverbrauch']);
  });

  it('does not count automations or "in Vorbereitung" modes toward the battery set', () => {
    const modes = activeModes(MULTI);
    expect(modes.some((m) => m.kind === 'automation')).toBe(true);
    expect(batteryModes(modes).map((m) => m.kind)).toEqual([
      'lastspitzenkappung',
      'marktvermarktung',
      'eigenverbrauch',
    ]);
  });
});

describe('socReservationStack', () => {
  it('stacks technical floor < backup < peak < free band', () => {
    const layers = socReservationStack({
      socMinPct: 5,
      socMaxPct: 95,
      backupReserveSocPct: 20,
      peakReserveSocPct: 35,
    });
    expect(layers.map((l) => [l.key, l.fromPct, l.toPct])).toEqual([
      ['technisch', 0, 5],
      ['notstrom', 5, 20],
      ['lastspitze', 20, 35],
      ['frei', 35, 95],
    ]);
  });

  it('renders only the layers it actually knows — never a fabricated one', () => {
    const layers = socReservationStack({ peakReserveSocPct: 30 });
    expect(layers.map((l) => l.key)).toEqual(['lastspitze', 'frei']);
    expect(layers[1].toPct).toBe(100);
    expect(socReservationStack({})).toEqual([]);
    expect(socReservationStack(null)).toEqual([]);
  });

  it('treats reservations as absolute (highest binds), not additive', () => {
    // A backup reserve BELOW the technical floor adds no segment of its own.
    const layers = socReservationStack({ socMinPct: 20, backupReserveSocPct: 10, socMaxPct: 95 });
    expect(layers.map((l) => l.key)).toEqual(['technisch', 'frei']);
    expect(layers[0].toPct).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 4 · Werkzeugkiste
// ---------------------------------------------------------------------------

describe('toolbox', () => {
  it('shows every mode to every customer, with honest requirement chips', () => {
    const entries = toolbox({ modes: [], entities: [BATTERY, PV], enabledGatedTypes: [] });
    expect(entries.map((e) => e.kind)).toEqual([
      'eigenverbrauch',
      'marktvermarktung',
      'lastspitzenkappung',
      'atypische-netznutzung',
      'automation',
    ]);

    const peak = entries.find((e) => e.kind === 'lastspitzenkappung')!;
    expect(peak.requirements).toEqual([
      { key: 'speicher', label: 'Speicher', ok: true },
      { key: 'leistungsmessung', label: 'Leistungsmessung', ok: false },
    ]);
    expect(peak.ready).toBe(false);
    expect(requirementHint(peak)).toBe('Dafür fehlt noch: Leistungsmessung.');

    const ev = entries.find((e) => e.kind === 'eigenverbrauch')!;
    expect(ev.ready).toBe(true);
    expect(requirementHint(ev)).toBeNull();
  });

  it('drops already-active modes but always keeps "Eigene Regel"', () => {
    const entries = toolbox({
      modes: activeModes(GEWERBE),
      entities: [BATTERY, PV, GRID, WALLBOX],
      enabledGatedTypes: [],
    });
    expect(entries.map((e) => e.kind)).toEqual([
      'marktvermarktung',
      'atypische-netznutzung',
      'automation',
    ]);
    const rule = entries.find((e) => e.kind === 'automation')!;
    expect(rule.ready).toBe(true);
    expect(rule.action).toEqual({ kind: 'guided' });
  });

  it('keeps the governance gate intact — visible for all, locked until enabled', () => {
    const locked = toolbox({ modes: [], entities: [BATTERY], enabledGatedTypes: [] });
    const market = locked.find((e) => e.kind === 'marktvermarktung')!;
    expect(market.gate).toBe('gated-locked');
    expect(market.gateNote).toBe('Einrichtung durch VoltPilot – sprechen Sie uns an.');

    const open = toolbox({ modes: [], entities: [BATTERY], enabledGatedTypes: [NODE_MARKET] });
    expect(open.find((e) => e.kind === 'marktvermarktung')!.gate).toBe('gated-open');
    expect(open.find((e) => e.kind === 'marktvermarktung')!.gateNote).toBeNull();
    // Free modes are never gated.
    expect(open.find((e) => e.kind === 'eigenverbrauch')!.gate).toBe('free');
    expect(open.find((e) => e.kind === 'automation')!.gate).toBe('free');
  });

  it('uses the shipped catalog node ids so the gate keys can never drift', () => {
    const entries = toolbox({ modes: [], entities: [], enabledGatedTypes: [] });
    expect(entries.map((e) => e.id)).toEqual([
      NODE_SELFCONSUMPTION,
      NODE_MARKET,
      NODE_PEAKSHAVING,
      NODE_ATYPICAL_GRID,
      'automation',
    ]);
  });

  it('never speaks optimizer-internal vocabulary', () => {
    const text = [
      AKTIVE_MODI_INTRO,
      ...toolbox({ modes: [], entities: [], enabledGatedTypes: [] }).flatMap((e) => [
        e.title,
        e.line,
        e.gateNote ?? '',
      ]),
      ...socReservationStack({ socMinPct: 5, backupReserveSocPct: 20, peakReserveSocPct: 30 }).map(
        (l) => `${l.label} ${l.note}`,
      ),
    ].join(' ');
    for (const word of ['MILP', 'Modul', 'Solver', 'SoC-Band', 'flow_definition']) {
      expect(text).not.toContain(word);
    }
  });
});
