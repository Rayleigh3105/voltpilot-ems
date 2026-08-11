import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SteuerungSection } from './SteuerungSection';
import { api, type Site } from '../api';
import { optimizerApi } from '../optimizerApi';
import * as flowsApi from '../flows/flowsApi';
import type { SiteProfile } from '../profiles';
import type { Consumer, ConsumerOptions } from '../consumers/types';
import { buildGuidedFlow } from '../flows/guidedBuilder';

// The read-only canvas preview needs real layout; the derivation it renders is
// covered by the flow-editor tests.
vi.mock('../components/flows/FlowCanvas', () => ({
  FlowCanvas: () => <div data-testid="canvas" />,
}));

// --- Die Verbraucher-Seite der Regeln-Kapsel (Einheitsmodell Stufe 5a) ------
const cOptions = vi.fn();
const cList = vi.fn();
const cStatus = vi.fn();
const cOverrides = vi.fn();
const cFulfillment = vi.fn();
const cGetPolicy = vi.fn();
const cPause = vi.fn();
const cResume = vi.fn();
const cActivatePolicy = vi.fn();
const cDeactivatePolicy = vi.fn();
const cStartOverride = vi.fn();
const cClearOverride = vi.fn();

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    options: (...a: unknown[]) => cOptions(...a),
    list: (...a: unknown[]) => cList(...a),
    status: (...a: unknown[]) => cStatus(...a),
    overrides: (...a: unknown[]) => cOverrides(...a),
    fulfillment: (...a: unknown[]) => cFulfillment(...a),
    getPolicy: (...a: unknown[]) => cGetPolicy(...a),
    pause: (...a: unknown[]) => cPause(...a),
    resume: (...a: unknown[]) => cResume(...a),
    activatePolicy: (...a: unknown[]) => cActivatePolicy(...a),
    deactivatePolicy: (...a: unknown[]) => cDeactivatePolicy(...a),
    startOverride: (...a: unknown[]) => cStartOverride(...a),
    clearOverride: (...a: unknown[]) => cClearOverride(...a),
    create: vi.fn(),
    savePolicy: vi.fn(),
  },
}));

const site: Site = {
  id: 's-1',
  name: 'Halle Nord',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  // Direktvermarktung (market) + Leistungspreis (peak) = TWO battery modes, so
  // the co-optimization stack renders. Eigenverbrauch is no longer a mode
  // (report vp-nacht-bezug-e7 §3.3); netzladen stays false so the EEG line shows.
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: null,
  tarifArt: 'fest',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  leistungspreisEurKw: 120,
  peakReserveSocPct: 30,
};

const CONSUMER: Consumer = {
  id: 'e-wb', type: 'wallbox', typeLabel: 'Wallbox', name: 'Wallbox Garage',
  controlKind: 'on_off', ratedPowerKw: 11, minPowerKw: null, levelsKw: null,
  resolutionKw: null, powerRangesKw: null, storageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'allow', allowStorageDischarge: false, failsafe: 'off',
  enabled: true, version: 1, connection: 'connected', edgeSourceId: 'src-1',
  controlActivation: 'active', hasDraftPolicy: true, draftPolicyVersion: 1,
};

const C_OPTIONS: ConsumerOptions = {
  types: [{ type: 'wallbox', label: 'Wallbox', controlKinds: ['on_off'], defaultFailsafe: 'release', releaseAllowed: true, intents: [] }],
  signals: [],
  intents: [],
  hasStorage: true,
  reportedSources: [],
  defaultStorageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'allow',
};

/** Ein gespeichertes Regel-Dokument des Verbrauchers (liefert den Klartext-Satz). */
const POLICY = {
  entityId: 'e-wb',
  version: 1,
  lifecycle: 'active' as const,
  contentHash: 'sha256:x',
  createdBy: null,
  document: {
    schema_version: '1.0' as const,
    entity_id: 'e-wb',
    requirements: [{
      id: 'r-1', kind: 'fixed_window' as const, enforcement: 'must_run' as const,
      target: { kind: 'on_off' as const, value: true },
      recurrence: { days: 'daily' as const, from: '11:00', to: '15:00' },
    }],
  },
};

function profile(over: Partial<SiteProfile> & { id: string; label: string }): SiteProfile {
  return {
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

const BOUND = {
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
  simulate: vi.fn(),
  simulationResult: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  remove: vi.fn(),
  versions: vi.fn(),
  entities: vi.fn(),
  governance: vi.fn(),
  socBands: vi.fn(),
  liveStatus: vi.fn(),
};

function setup(overrides: Partial<typeof BOUND> = {}) {
  const bound = { ...BOUND, ...overrides };
  vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue(
    bound as unknown as flowsApi.BoundFlowApi,
  );
  return bound;
}

/** Eine Flow-Regel, die der Rück-Parser lesen kann (Baukasten-Ausschnitt). */
function pvFlow(over: Record<string, unknown> = {}) {
  const doc = buildGuidedFlow(
    {
      conditions: [{ kind: 'entity', entityId: 'e-grid', channel: 'power_kw', direction: 'below', threshold: -3.5 }],
      combinator: 'and',
      action: { kind: 'onoff', entityId: 'e-wb', ttlS: 300 },
    },
    'Wallbox nur bei PV-Überschuss',
    's-1',
  );
  return {
    flowId: 'f-wb',
    name: 'Wallbox nur bei PV-Überschuss',
    activeVersion: 2,
    latestVersion: 2,
    latestLifecycle: 'active',
    latestDocument: doc,
    versions: [1, 2],
    simulation: null,
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  BOUND.list.mockResolvedValue([]);
  BOUND.entities.mockResolvedValue([
    { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
    { id: 'e-pv', entityType: 'producer', label: 'PV-Dach', measure: ['pv_power_kw'], actuate: [] },
    { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox Garage', measure: ['power_kw'], actuate: ['on_off'] },
  ]);
  BOUND.governance.mockResolvedValue({ gatedNodes: [] });
  BOUND.liveStatus.mockResolvedValue({ acks: [], nodes: [] });
  BOUND.deactivate.mockResolvedValue({ deactivated: true, message: 'Stillgelegt.' });
  BOUND.activate.mockResolvedValue({ activated: true, message: 'Aktiviert.', published: true, lifecycle: 'active' });
  BOUND.remove.mockResolvedValue(undefined);
  cOptions.mockResolvedValue(C_OPTIONS);
  cList.mockResolvedValue([]);
  cStatus.mockResolvedValue([]);
  cOverrides.mockResolvedValue([]);
  cFulfillment.mockResolvedValue({ tasks: [] });
  cGetPolicy.mockResolvedValue(POLICY);
  cPause.mockResolvedValue({ published: true, message: 'Pausiert.' });
  cResume.mockResolvedValue({ activated: true, reason: null, message: 'Fortgesetzt.', published: true, policyVersion: 1 });
  cActivatePolicy.mockResolvedValue({ activated: true, reason: null, message: 'Aktiviert.', published: true, policyVersion: 1 });
  cDeactivatePolicy.mockResolvedValue({ published: true, message: 'Abgeschaltet.' });
  cClearOverride.mockResolvedValue({ applied: true, pushed: true, kind: 'clear', endsAt: null, effectivePowerKw: null, gridImportPossible: false, ttlCapped: false, message: '' });
  vi.spyOn(api, 'usageProfile').mockResolvedValue({
    signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  } as never);
  vi.spyOn(api, 'earnings').mockResolvedValue({
    sites: [
      {
        id: 's-1',
        eigenverbrauchsWertEur: 88.25,
        einspeiseErloesEur: 11,
        savedEur: 42.5,
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
      },
    ],
  } as never);
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  // Das Regel-Protokoll (Stufe 5b) - die Vorgabe ist der Tag der Auslieferung:
  // aufgezeichnet wird, aber noch kein Wechsel liegt vor.
  vi.spyOn(api, 'siteRuleEvents').mockResolvedValue({
    recordingSince: '2026-08-11T06:00:00Z',
    accuracySeconds: 15,
    countsToday: true,
    rules: [],
    events: [],
  });
  vi.spyOn(api, 'siteProfiles').mockResolvedValue({
    profiles: [
      profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true }),
      profile({
        id: 'marktvermarktung',
        label: 'Marktvermarktung',
        active: true,
        blockedReason: 'Läuft noch nicht: Ihrer Anlage fehlt ein dynamischer Tarif.',
      }),
      profile({ id: 'atypische-netznutzung', label: 'Atypische Netznutzung', active: false }),
    ],
  });
  vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
  vi.spyOn(optimizerApi, 'configViaSwitcher').mockResolvedValue({
    effective: { socMinPct: 5, socMaxPct: 95, backupReserveSocPct: 20, wearCostCtPerKwh: 4 },
  } as never);
});

afterEach(() => {
  window.location.hash = '';
});

describe('SteuerungSection (Portal v3 M4 + Einheitsmodell Stufe 5a)', () => {
  it('renders exactly two capsules plus the protection line — die zweite heißt „Regeln"', async () => {
    setup();
    const { container } = render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    // Naming Set A: die Kapsel heißt „Regeln", nicht mehr „Automationen".
    expect(screen.getByRole('heading', { name: 'Regeln' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Automationen' })).toBeNull();
    expect(container.querySelectorAll('section.vp-capsule')).toHaveLength(2);

    // The retired four-part surface is gone - no toolbox, no active/offer mix.
    expect(screen.queryByRole('heading', { name: 'Aktive Modi' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '＋ Modus hinzufügen' })).toBeNull();

    // The narrow always-on protection line.
    expect(screen.getByText(/Läuft immer mit/)).toBeInTheDocument();
    expect(screen.getByText('§ 14a-Schutz')).toBeInTheDocument();
    expect(screen.getByText('Negativpreis-Abregelung')).toBeInTheDocument();
    expect(screen.getByText('EEG: nur Solarladen')).toBeInTheDocument();
  });

  it('profile rows carry a real number, a real switch and the honest blocked reason', async () => {
    setup();
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Lastspitzenkappung/ })).toBeInTheDocument());
    expect(screen.getByText(/3\.600/)).toBeInTheDocument();
    expect(screen.getByText(/dynamischer Tarif/)).toBeInTheDocument();
    expect(screen.queryByText(/Angefragt/)).toBeNull();
    const off = screen.getByRole('switch', { name: /Atypische Netznutzung einschalten/ });
    expect(off).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(off);
    await waitFor(() =>
      expect(api.setSiteProfile).toHaveBeenCalledWith('s-1', 'atypische-netznutzung', 'an'));
  });

  it('renders the co-optimization reserve stack in the profile capsule', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByText('2 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.'))
        .toBeInTheDocument());
    expect(screen.getByText(/Notstrom-Reserve/)).toBeInTheDocument();
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();
  });

  it('tapping a profile row opens its Modus-Container (v3.1-M2)', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lastspitzenkappung öffnen/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Profile verwalten/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Lastspitzenkappung öffnen/ }));

    expect(await screen.findByRole('button', { name: /Zur Steuerung/ })).toBeInTheDocument();
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Regeln' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Zur Steuerung/ }));
    expect(await screen.findByRole('heading', { name: 'Regeln' })).toBeInTheDocument();
  });

  it('stays honest when the optional endpoints are unavailable (older backend / 403)', async () => {
    setup();
    vi.spyOn(api, 'earnings').mockRejectedValue(new Error('nope'));
    vi.spyOn(optimizerApi, 'configViaSwitcher').mockRejectedValue(new Error('403'));
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();
    expect(screen.queryByText(/Notstrom-Reserve/)).toBeNull();
  });

  it('renders a calm empty profile capsule when the backend has no profiles', async () => {
    setup();
    vi.spyOn(api, 'siteProfiles').mockRejectedValue(new Error('older backend'));
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    expect(screen.getByText(/noch keine Profile hinterlegt/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Die Kapsel „Regeln" (Einheitsmodell Stufe 5a)
// ---------------------------------------------------------------------------

describe('Die Regeln-Kapsel: Karten statt Zeilen', () => {
  it('hat GENAU EINEN „＋ Neue Regel"-Einstieg, dessen Dialog drei Türen bietet', async () => {
    setup();
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Regeln' })).toBeInTheDocument());
    const plus = screen.getAllByRole('button', { name: /Neue Regel/ });
    expect(plus).toHaveLength(1);
    // Das alte Wort taucht nirgends mehr auf.
    expect(screen.queryByRole('button', { name: /Neue Automation/ })).toBeNull();

    fireEvent.click(plus[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Was soll Ihre Anlage für Sie erledigen?');
    expect(dialog).toHaveTextContent('Eigene Wenn/Dann-Regel');
    expect(dialog).toHaveTextContent('Freier Editor');
    // A-1: der Name der Laufzeit ist keine Kundencopy.
    expect(dialog.textContent ?? '').not.toContain('Node-RED');
  });

  it('die Galerie zeigt die Rezepte, blendet Unpassendes gezählt aus und vertagt EHRLICH', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Neue Regel/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Neue Regel/ }));

    const dialog = await screen.findByRole('dialog');
    // Die vier Verbraucher-Absichten sind Rezepte.
    expect(dialog).toHaveTextContent('PV-Überschuss nutzen');
    expect(dialog).toHaveTextContent('Feste Zeiten');
    expect(dialog).toHaveTextContent('Günstige Stunden nutzen');
    expect(dialog).toHaveTextContent('Bis zu einer Frist erledigen');
    expect(dialog).toHaveTextContent('Speicher schützen');
    // Captain-Entscheid: die Benachrichtigung wird GEZEIGT, ehrlich vertagt.
    expect(dialog).toHaveTextContent('Sag mir Bescheid');
    expect(dialog).toHaveTextContent('bald verfügbar');
    expect(dialog).toHaveTextContent(/Zustellweg/);
  });

  it('ohne schaltbares Gerät ist die Galerie keine Sackgasse', async () => {
    const bound = setup();
    bound.entities.mockResolvedValue([
      { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
    ]);
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Regeln' })).toBeInTheDocument());

    // Der leere Zustand zeigt die Galerie INLINE - keine leere Liste.
    expect(await screen.findByText('Was soll Ihre Anlage für Sie erledigen?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Komponente anlegen' })).toBeInTheDocument();
    expect(screen.getByText(/passen nicht zu Ihrer Anlage/)).toBeInTheDocument();
  });

  it('eine Flow-Regel wird eine Karte mit Klartext-Satz — und OHNE erfundenen Zähler', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    render(<SteuerungSection site={site} />);

    expect(await screen.findByText('Wallbox nur bei PV-Überschuss')).toBeInTheDocument();
    expect(screen.getByText(/schaltet VoltPilot Wallbox Garage ein/)).toBeInTheDocument();
    // Der Verlaufsspeicher ist Stufe 5b - hier wird nichts behauptet.
    expect(screen.queryByText(/× geschaltet/)).toBeNull();
    // Der Gerätestand sagt ehrlich, dass die Bestätigung fehlt.
    expect(screen.getByText(/Ausgerollt · v2/)).toBeInTheDocument();
  });

  it('eine generierte Verbraucherregel erscheint GENAU EINMAL — als Rezept-Karte', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([
      pvFlow({
        flowId: 'f-cons',
        name: 'Verbraucherregel Wallbox',
        latestDocument: {
          ...pvFlow().latestDocument,
          origin: { kind: 'consumer-policy', policy_id: 'p-1', policy_version: 1, entity_id: 'e-wb' },
        },
      }),
    ]);
    cList.mockResolvedValue([CONSUMER]);
    render(<SteuerungSection site={site} />);

    // Die Rezept-Karte trägt den Namen des VERBRAUCHERS ...
    await waitFor(() =>
      expect(document.querySelectorAll('.vp-regel-name')).toHaveLength(1));
    expect(document.querySelector('.vp-regel-name')?.textContent).toBe('Wallbox Garage');
    // ... und die generierte Automation steht NICHT zusätzlich in der Liste.
    expect(screen.queryByText('Verbraucherregel Wallbox')).toBeNull();
    // Der Satz kommt aus dem gespeicherten Regel-Dokument.
    expect(screen.getByText(/Täglich von 11:00 bis 15:00 Uhr/)).toBeInTheDocument();
  });

  it('der Schnellschalter pausiert eine aktive Verbraucher-Regel', async () => {
    setup();
    cList.mockResolvedValue([CONSUMER]);
    render(<SteuerungSection site={site} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Wallbox Garage pausieren/ }));
    await waitFor(() => expect(cPause).toHaveBeenCalledWith('s-1', 'e-wb'));
  });

  it('und setzt eine pausierte fort (AUS geht immer, AN prüft der Server)', async () => {
    setup();
    cList.mockResolvedValue([{ ...CONSUMER, controlActivation: 'paused' }]);
    render(<SteuerungSection site={site} />);
    fireEvent.click(await screen.findByRole('switch', { name: /Wallbox Garage einschalten/ }));
    await waitFor(() => expect(cResume).toHaveBeenCalledWith('s-1', 'e-wb'));
  });

  it('eine Ablehnung beim Einschalten bleibt AUS und nennt den Server-Grund', async () => {
    setup();
    cList.mockResolvedValue([{ ...CONSUMER, controlActivation: 'not_activated' }]);
    cActivatePolicy.mockResolvedValue({
      activated: false, reason: 'gated_node_not_enabled',
      message: 'Dafür muss VoltPilot zuerst das passende Modus-Profil freischalten.',
      published: false, policyVersion: null,
    });
    render(<SteuerungSection site={site} />);

    fireEvent.click(await screen.findByRole('switch', { name: /Wallbox Garage einschalten/ }));
    await waitFor(() => expect(cActivatePolicy).toHaveBeenCalled());
    expect(await screen.findByText(/Modus-Profil freischalten/)).toBeInTheDocument();
  });

  it('meldet ein Gerät seinen Zustand, trägt die Karte ihn — sonst behauptet sie nichts', async () => {
    setup();
    cList.mockResolvedValue([CONSUMER]);
    cStatus.mockResolvedValue([
      { entityId: 'e-wb', state: 'waiting', reasonCode: 'guard_min_off', reportedAt: '2026-08-10T12:00:00Z' },
    ]);
    render(<SteuerungSection site={site} />);
    expect(await screen.findByText(/Wartet auf passenden Zeitpunkt/)).toBeInTheDocument();
    expect(screen.getByText(/Mindestpause des Geräts/)).toBeInTheDocument();
  });

  it('ein laufender Eingriff steht als Banner über der Liste und lässt sich beenden', async () => {
    setup();
    cList.mockResolvedValue([CONSUMER]);
    cOverrides.mockResolvedValue([{
      entityId: 'e-wb', kind: 'start', targetCommand: 'on_off',
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }]);
    render(<SteuerungSection site={site} />);

    expect(await screen.findByText(/Sofortaktion aktiv/)).toBeInTheDocument();
    expect(screen.getByText(/wartet — Sofortaktion hat Vorrang/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt beenden' }));
    // Der Haus-Dialog fragt vorher; erst die Bestätigung greift ein.
    fireEvent.click(await screen.findByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(cClearOverride).toHaveBeenCalledWith('s-1', 'e-wb'));
  });

  // --- Stufe 5b: das Regel-Protokoll ------------------------------------

  /** Ein Protokoll mit einem Start und einem Stopp derselben Flow-Regel. */
  function protokollMitWechseln() {
    const heute = (h: number, m: number) => new Date(2026, 7, 11, h, m).toISOString();
    return {
      recordingSince: '2026-08-09T06:00:00Z',
      accuracySeconds: 15,
      countsToday: true,
      rules: [{
        ruleKind: 'flow' as const, ruleRef: 'f-wb',
        switchedToday: 3, lastSwitchedAt: heute(14, 2),
      }],
      events: [
        {
          id: 2, ruleKind: 'flow' as const, ruleRef: 'f-wb', entityId: 'e-wb',
          kind: 'gestoppt', state: 'fulfilled', previousState: 'running_optimized',
          reasonCode: null, actualKw: null, detail: null, occurredAt: heute(14, 2),
        },
        {
          id: 1, ruleKind: 'flow' as const, ruleRef: 'f-wb', entityId: 'e-wb',
          kind: 'gestartet', state: 'running_optimized', previousState: 'waiting',
          reasonCode: 'price_below_threshold', actualKw: 7.4, detail: null,
          occurredAt: heute(12, 30),
        },
      ],
    };
  }

  it('die Karte traegt „heute 3x geschaltet - zuletzt 14:02"', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    vi.spyOn(api, 'siteRuleEvents').mockResolvedValue(protokollMitWechseln());
    render(<SteuerungSection site={site} />);

    expect(await screen.findByText(/heute 3× geschaltet · zuletzt 14:02/))
      .toBeInTheDocument();
  });

  it('der Einschub zeigt den Verlauf DIESER Regel samt Genauigkeit', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    vi.spyOn(api, 'siteRuleEvents').mockResolvedValue(protokollMitWechseln());
    render(<SteuerungSection site={site} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Öffnen' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/12:30 · gestartet · 7,4/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Günstiger Strompreis/)).toBeInTheDocument();
    expect(within(drawer).getByText(/14:02 · gestoppt/)).toBeInTheDocument();
    // Die Genauigkeit steht AN der Flaeche, nicht im Kleingedruckten.
    expect(within(drawer).getByText(/15-Sekunden-Takt/)).toBeInTheDocument();
  });

  it('das kompakte Gesamt-Protokoll steht als Aufklapper unter der Liste', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    vi.spyOn(api, 'siteRuleEvents').mockResolvedValue(protokollMitWechseln());
    render(<SteuerungSection site={site} />);

    const aufklapper = await screen.findByText('Verlauf');
    fireEvent.click(aufklapper);
    // Er nennt je Zeile die REGEL, damit man die Ereignisse zuordnen kann.
    expect(screen.getAllByText('Wallbox nur bei PV-Überschuss').length)
      .toBeGreaterThan(1);
  });

  it('ohne Protokoll (aelteres Backend) ist die Flaeche zeichengleich zu Stufe 5a', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    vi.spyOn(api, 'siteRuleEvents').mockRejectedValue(new Error('404'));
    render(<SteuerungSection site={site} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Öffnen' }));
    const drawer = await screen.findByRole('dialog');
    // Der 5a-Satz kehrt zurueck - und es gibt weder Zaehler noch Aufklapper.
    expect(within(drawer).getByText(/wird noch nicht aufgezeichnet/)).toBeInTheDocument();
    expect(screen.queryByText(/geschaltet/)).toBeNull();
    expect(screen.queryByText('Verlauf')).toBeNull();
  });

  it('„Öffnen" zeigt den Detail-Einschub — mit EHRLICH leerem Verlauf', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([pvFlow()]);
    render(<SteuerungSection site={site} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Öffnen' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Ihre Regel')).toBeInTheDocument();
    expect(within(drawer).getByText(/Geräteschutz, Netzvorgaben/)).toBeInTheDocument();
    expect(within(drawer).getByText('Verlauf dieser Regel')).toBeInTheDocument();
    // Stufe 5b: der Speicher zeichnet auf, für DIESE Regel liegt aber noch kein
    // Wechsel vor - der Einschub sagt beides, statt leer wie ein Ausfall
    // auszusehen.
    expect(within(drawer).getByText(/kein Wechsel aufgezeichnet/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Aufgezeichnet wird seit/)).toBeInTheDocument();
    // Ohne Probelauf wird KEINE Zahl behauptet.
    expect(within(drawer).getByText(/noch nicht durchgerechnet/)).toBeInTheDocument();
    expect(within(drawer).getByText('v2 aktiv · v1')).toBeInTheDocument();
  });

  it('ein Rezept öffnet den Regelbaukasten, statt einen Flow zu erzeugen (D7)', async () => {
    const bound = setup();
    cList.mockResolvedValue([{ ...CONSUMER, hasDraftPolicy: false, controlActivation: 'not_activated' }]);
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Neue Regel/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Neue Regel/ }));

    const dialog = await screen.findByRole('dialog');
    const karte = within(dialog).getByText('Feste Zeiten').closest('li') as HTMLElement;
    fireEvent.click(within(karte).getByRole('button', { name: 'Wählen' }));

    expect(await screen.findByText(/Regel für Wallbox Garage/)).toBeInTheDocument();
    // Auf diesem Weg entsteht KEIN Flow.
    expect(bound.create).not.toHaveBeenCalled();
  });

  it('ein ?verbraucher=-Lesezeichen öffnet den Regelbaukasten und räumt die Adresse auf', async () => {
    setup();
    window.location.hash = '#/anlage/s-1/steuerung?verbraucher=e-wb';
    cList.mockResolvedValue([CONSUMER]);
    render(<SteuerungSection site={site} />);

    expect(await screen.findByText(/Regel für Wallbox Garage/)).toBeInTheDocument();
    expect(window.location.hash).not.toContain('verbraucher=');
  });
});

// ---------------------------------------------------------------------------
// Umstellung Direktvermarktung → Eigenverbrauch (Captain-Hotfix 2026-07-29)
// ---------------------------------------------------------------------------

describe('Umstellung des Anlagentyps hinterlässt keinen kaputten Zwischenzustand', () => {
  /** Netzladen + dynamischer Tarif: der Markt-Modus überlebt die Umstellung. */
  const dv: Site = {
    ...site,
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 5,
    netzladenErlaubt: true,
    anzulegenderWertCtKwh: 8.11,
  };
  const ev: Site = { ...dv, plantKind: 'eigenverbrauch' };

  async function openMarkt(target: Site) {
    render(<SteuerungSection site={target} />);
    const row = await screen.findByRole('button', { name: /Marktvermarktung öffnen/ });
    fireEvent.click(row);
    return screen.findByRole('button', { name: /Zur Steuerung/ });
  }

  it('weist keine Basis-Ansicht als Freischaltung des Markt-Modus aus', async () => {
    setup();
    await openMarkt(dv);
    expect(screen.queryByLabelText('Ansichten dieses Modus')).toBeNull();
  });

  it('zeigt den anzulegenden Wert nur solange die Anlage direkt vermarktet', async () => {
    setup();
    await openMarkt(dv);
    expect(screen.getByText('Anzulegender Wert')).toBeInTheDocument();
  });

  it('lässt nach der Umstellung keine verwaiste Einstellung und keinen Fehler zurück', async () => {
    setup();
    const { container } = render(<SteuerungSection site={ev} />);
    fireEvent.click(await screen.findByRole('button', { name: /Marktvermarktung öffnen/ }));
    await screen.findByRole('button', { name: /Zur Steuerung/ });

    expect(screen.queryByText('Anzulegender Wert')).toBeNull();
    expect(screen.getByText('Netzladen des Speichers')).toBeInTheDocument();
    expect(screen.getByText('Stromtarif')).toBeInTheDocument();
    expect(container.querySelector('.vp-flowed-notice.error')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Zur Steuerung/ }));
    expect(await screen.findByRole('heading', { name: 'Regeln' })).toBeInTheDocument();
  });
});
