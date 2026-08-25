import { describe, expect, it } from 'vitest';
import type { EarningsSite } from './api';
import { anwendung } from './anwendungen';
import type { EditorEntity, FlowDocument } from './flows/model';
import { NBSP } from './format';
import {
  PROFILE_CAPSULE_INTRO,
  automationRows,
  contributionRows,
  entityChips,
  modeActions,
  peakContributionNote,
  profileRows,
  protectionItems,
  storageEntities,
} from './steuerungArea';
import type { SiteProfile } from './profiles';
import { activeModes, type AnlageSurfaceInput, type SurfaceFlow } from './surface';
import { NODE_ATYPICAL_GRID, NODE_MARKET } from './usageProfile';

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
  it('reads the real number of each mode stream (peak = billing period, market = range)', () => {
    const peak = activeModes(GEWERBE).find((m) => m.kind === 'lastspitzenkappung')!;
    const peakRows = contributionRows(peak, EARNINGS);
    expect(peakRows).toHaveLength(1);
    expect(peakRows[0].label).toBe('Vermiedene Leistungskosten');
    expect(peakRows[0].value).toContain('3.600');
    expect(peakRows[0].period).toBe('billing-period');
    expect(peakRows[0].note).toBe('laufende Abrechnungsperiode');

    // Der Eigenverbrauchswert reist im Markt-Manifest (kein EV-Modus mehr).
    const markt = activeModes(MULTI).find((m) => m.kind === 'marktvermarktung')!;
    const marktRows = contributionRows(markt, EARNINGS);
    expect(marktRows.map((r) => r.label)).toEqual([
      'Einspeise-Erlös',
      'Wert des Eigenverbrauchs',
    ]);
    expect(marktRows.every((r) => r.period === 'range')).toBe(true);
  });

  it('shows "—" (null value) instead of a fabricated zero when nothing is attributable', () => {
    const auto = activeModes(MULTI).find((m) => m.kind === 'automation')!;
    const rows = contributionRows(auto, EARNINGS);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
    expect(rows[0].note).toBe('Pro Regel noch nicht zugeordnet.');
  });

  it('yields null values (never 0) when the earnings response is missing', () => {
    const markt = activeModes(MULTI).find((m) => m.kind === 'marktvermarktung')!;
    expect(contributionRows(markt, null).every((r) => r.value === null)).toBe(true);
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
// M4 · Kapsel 1 — Profil-Zeilen
// ---------------------------------------------------------------------------

function profile(over: Partial<SiteProfile> & { id: string }): SiteProfile {
  return {
    label: over.id,
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

describe('profileRows (M4 Kapsel 1)', () => {
  it('states the contribution of an active profile with a real number and its period', () => {
    const modes = activeModes(GEWERBE);
    const rows = profileRows(
      [profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })],
      modes,
      EARNINGS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].on).toBe(true);
    expect(rows[0].tone).toBe('on');
    expect(rows[0].contribution).toContain('3.600');
    expect(rows[0].contribution).toContain('laufende Abrechnungsperiode');
  });

  it('never fabricates a 0 - without earnings the row shows NO contribution', () => {
    const rows = profileRows(
      [profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true })],
      activeModes(GEWERBE),
      null,
    );
    // Stufe 0: statt eines „—" steht dort GAR NICHTS - die Zeile beantwortet
    // „Was bringt mir das?" über ihren Nutzen-Satz, nicht über einen
    // Gedankenstrich.
    expect(rows[0].contribution).toBeNull();
    expect(rows[0].benefit).toBe(anwendung('lastspitzenkappung')?.nutzen);
  });

  it('Stufe 0: die Zeile trägt Nutzen-Satz und Voraussetzungs-Chips', () => {
    const rows = profileRows(
      [profile({
        id: 'marktvermarktung',
        label: 'Marktoptimierung',
        active: false,
        requirements: [
          { label: 'Speicher', met: true },
          { label: 'Dynamischer Tarif oder Direktvermarktung', met: false },
        ],
      })],
      [],
      null,
    );
    expect(rows[0].benefit).toContain('Börsenpreisen');
    expect(rows[0].requirements).toEqual([
      { label: 'Speicher', met: true, text: 'Speicher' },
      {
        label: 'Dynamischer Tarif oder Direktvermarktung',
        met: false,
        text: 'Dynamischer Tarif oder Direktvermarktung fehlt',
      },
    ]);
  });

  it('Stufe 0: der ZWEITE Filter - nur Betriebsmodelle stehen im Regal', () => {
    // Ein ÄLTERER Server schickt weiterhin alle neun Zeilen; die Kapsel bleibt
    // trotzdem aufgeräumt. Eine dem Katalog UNBEKANNTE Id wird ausgelassen
    // statt ohne Nutzen-Satz gerendert.
    const rows = profileRows(
      [
        profile({ id: 'monitoring', label: 'Anlage beobachten', active: true }),
        profile({ id: 'ueberschuss', label: 'Überschuss nutzen', active: false }),
        profile({ id: 'eigene-auswertung', label: 'Eigene Auswertung', active: true }),
        profile({ id: 'marktvermarktung', label: 'Marktoptimierung', active: false }),
        profile({ id: 'brandneu', label: 'Brandneu', active: true }),
      ],
      [],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(['marktvermarktung']);
  });

  it('eine AUTOMATION erreicht das Regal nie - sie ist eine Regel, kein Modell', () => {
    // Sie war nie eine Anwendung; seit Stufe 0 hält der Katalog-Filter das
    // strukturell fest, statt sie mit einem „—" als Modell zu rendern.
    const modes = activeModes({
      ...GEWERBE,
      flows: [flow('f-rule', 'Wallbox', [])],
    } as AnlageSurfaceInput);
    const automation = modes.find((m) => m.kind === 'automation')!;
    const rows = profileRows(
      [profile({ id: String(automation.kind), label: 'Automation', active: true })],
      modes,
      EARNINGS,
    );
    expect(rows).toEqual([]);
  });

  it('a switched-off profile keeps its switch and shows no contribution', () => {
    const rows = profileRows(
      [profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: false })],
      [],
      EARNINGS,
    );
    expect(rows[0].on).toBe(false);
    expect(rows[0].tone).toBe('off');
    expect(rows[0].contribution).toBeNull();
    expect(rows[0].blockedReason).toBeNull();
  });

  it('an ON profile that cannot fully run shows M3s honest reason, never a request prompt', () => {
    const rows = profileRows(
      [profile({
        id: 'marktvermarktung',
        label: 'Marktvermarktung',
        active: true,
        blockedReason: 'Läuft noch nicht: Ihrer Anlage fehlt ein dynamischer Tarif.',
      })],
      [],
      EARNINGS,
    );
    expect(rows[0].tone).toBe('blocked');
    expect(rows[0].blockedReason).toContain('Läuft noch nicht');
    expect(rows[0].blockedReason).not.toContain('Angefragt');
    expect(rows[0].blockedReason).not.toContain('anfragen');
  });

  it('is empty without profiles (older backend) - never an invented row', () => {
    expect(profileRows(null, activeModes(GEWERBE), EARNINGS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M4 · Kapsel 2 — Automations-Zeilen
// ---------------------------------------------------------------------------

const FLOW_ROW = {
  flowId: 'f-1',
  name: 'Wallbox nur bei PV-Überschuss',
  activeVersion: 2 as number | null,
  latestVersion: 2,
  latestLifecycle: 'active',
};

describe('automationRows (M4 Kapsel 2)', () => {
  it('without node status says only "Läuft" - never an invented switch count', () => {
    const rows = automationRows([FLOW_ROW]);
    expect(rows[0].state).toBe('Läuft');
    expect(rows[0].tone).toBe('on');
    expect(rows[0].version).toBe(2);
  });

  it('renders the live line once a device reported it', () => {
    const at = new Date();
    at.setHours(14, 2, 0, 0);
    const rows = automationRows([FLOW_ROW], [
      { flowId: 'f-1', switchedToday: 3, lastSwitchedAt: at.toISOString() },
    ]);
    expect(rows[0].state).toBe('Läuft · heute 3× geschaltet · zuletzt 14:02');
  });

  it('reports a partial status honestly (count only / last only)', () => {
    expect(automationRows([FLOW_ROW], [{ flowId: 'f-1', switchedToday: 0 }])[0].state)
      .toBe('Läuft · heute 0× geschaltet');
    expect(automationRows([FLOW_ROW], [{ flowId: 'f-1', lastSwitchedAt: 'kaputt' }])[0].state)
      .toBe('Läuft');
  });

  it('a not-yet-active rule shows its lifecycle and never a run state', () => {
    const rows = automationRows(
      [{ ...FLOW_ROW, activeVersion: null, latestLifecycle: 'simulated' }],
      [{ flowId: 'f-1', switchedToday: 9 }],
    );
    expect(rows[0].state).toBe('Simuliert');
    expect(rows[0].tone).toBe('off');
    expect(rows[0].active).toBe(false);
  });

  it('marks the generated consumer rule via its server-stamped origin (D7)', () => {
    const rows = automationRows([
      {
        ...FLOW_ROW,
        latestDocument: {
          origin: { kind: 'consumer-policy', entity_id: 'e-wallbox' },
        },
      },
    ]);
    expect(rows[0].fromConsumerRule).toEqual({ entityId: 'e-wallbox' });
  });

  it('never invents an origin: plain flows and foreign kinds stay null', () => {
    expect(automationRows([FLOW_ROW])[0].fromConsumerRule).toBeNull();
    expect(
      automationRows([
        { ...FLOW_ROW, latestDocument: { origin: { kind: 'something-else', entity_id: 'x' } } },
      ])[0].fromConsumerRule,
    ).toBeNull();
    expect(
      automationRows([
        { ...FLOW_ROW, latestDocument: { origin: { kind: 'consumer-policy' } } },
      ])[0].fromConsumerRule,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M4 · Die schmale Schutz-Zeile
// ---------------------------------------------------------------------------

describe('protectionItems', () => {
  it('always carries §14a and the negative-price curtailment', () => {
    const labels = protectionItems({ netzladenErlaubt: true }).map((p) => p.label);
    expect(labels).toEqual(['§ 14a-Schutz', 'Negativpreis-Abregelung']);
  });

  it('names the EEG solar-only clamp ONLY while grid charging is barred', () => {
    expect(protectionItems({ netzladenErlaubt: false }).map((p) => p.label))
      .toContain('EEG: nur Solarladen');
    expect(protectionItems({ netzladenErlaubt: null }).map((p) => p.label))
      .not.toContain('EEG: nur Solarladen');
  });

  it('never speaks optimizer-internal vocabulary', () => {
    const text = [
      PROFILE_CAPSULE_INTRO,
      ...protectionItems({ netzladenErlaubt: false }).map((p) => `${p.label} ${p.tip}`),
    ].join(' ');
    for (const word of ['MILP', 'Modul', 'Solver', 'SoC-Band', 'flow_definition']) {
      expect(text).not.toContain(word);
    }
  });
});
