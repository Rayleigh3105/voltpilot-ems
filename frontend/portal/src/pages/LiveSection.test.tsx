import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { LiveSection } from './LiveSection';
import {
  api,
  type EntityHistory,
  type Site,
  type SiteTopology,
  type SiteUsageProfile,
  type TelemetryPoint,
} from '../api';
import type { FlowNode } from '../topology';

// jsdom has no canvas, so the ECharts Verlauf chart is stubbed — V3's board is
// what this render test asserts (the chart's toggle is covered elsewhere).
vi.mock('../TelemetryChart', () => ({
  TelemetryChart: () => <div data-testid="telemetry-chart" />,
}));

const site: Site = {
  id: 's-1',
  name: 'Testanlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const NOW = '2026-07-06T10:00:00Z';
const freshPoint = (over: Partial<TelemetryPoint> = {}): TelemetryPoint => ({
  ts: NOW,
  powerKw: -2.4,
  socPct: 76,
  pvPowerKw: 4.7,
  loadKw: 1.1,
  gridLimitKw: null,
  ...over,
});

const NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 6.4,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 6.4 }],
  },
  {
    role: 'grid',
    value_kw: 1.2,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: 1.2 }],
  },
];

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'pv',
      entityType: 'producer',
      typeLabel: 'PV',
      label: 'Fronius',
      category: 'producer',
      health: 'ok',
      capabilities: [{ channel: 'pv_power_kw', unit: null, role: 'pv', primary: false, value: 6.4 }],
    },
    {
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netz',
      label: 'Netz',
      category: 'meter',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: null, role: 'grid', primary: true, value: 1.2 }],
    },
  ],
  topology: { schema_version: '1.0', nodes: NODES },
};

const EMPTY_TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [],
  topology: { schema_version: '1.0', nodes: [] },
};

const PROFILE: SiteUsageProfile = {
  usageProfile: 'private',
  derivedProfile: 'private',
  override: null,
  emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'secondary' },
  signals: {
    hasStorage: false,
    hasPv: true,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: null,
    hasLeistungspreis: false,
  },
};

const history: EntityHistory = {
  range: 'day',
  from: NOW,
  to: NOW,
  bucketMinutes: 15,
  channels: { pv_power_kw: [{ start: NOW, avg: 6.4, min: 6.4, max: 6.4, last: 6.4, n: 1 }] },
};

beforeEach(() => {
  vi.spyOn(api, 'siteSources').mockResolvedValue(null);
  vi.spyOn(api, 'entityHistory').mockResolvedValue(history);
  vi.spyOn(api, 'usageProfile').mockResolvedValue(PROFILE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiveSection (V3 Komponenten-Board)', () => {
  it('renders the adaptive board for a migrated site (one row per component)', async () => {
    vi.spyOn(api, 'topology').mockResolvedValue(TOPO);
    vi.spyOn(api, 'telemetry').mockResolvedValue([freshPoint()]);

    render(<LiveSection site={site} />);

    const board = await screen.findByLabelText('Komponenten im Detail');
    // PV component (short generalised word) + Netz component.
    expect(within(board).getByText('Erzeuger')).toBeInTheDocument();
    expect(within(board).getByText('Netz')).toBeInTheDocument();
    // The compact Verlauf chart is present below the split.
    expect(screen.getByTestId('telemetry-chart')).toBeInTheDocument();
  });

  it('falls back to the v1 board for an un-migrated site', async () => {
    vi.spyOn(api, 'topology').mockResolvedValue(EMPTY_TOPO);
    vi.spyOn(api, 'telemetry').mockResolvedValue([freshPoint()]);

    render(<LiveSection site={site} />);

    const board = await screen.findByLabelText('Komponenten im Detail');
    // The four site-level rows.
    for (const title of ['Solar', 'Batterie', 'Haus', 'Netz']) {
      expect(within(board).getByText(title)).toBeInTheDocument();
    }
  });

  it('shows an honest empty state when the site has no measurements yet', async () => {
    vi.spyOn(api, 'topology').mockResolvedValue(EMPTY_TOPO);
    vi.spyOn(api, 'telemetry').mockResolvedValue([]);

    render(<LiveSection site={site} />);

    await waitFor(() =>
      expect(screen.getByText(/liegen noch keine Messwerte vor/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Komponenten im Detail')).not.toBeInTheDocument();
  });

  it('shows the stale chip + dims the board when the newest sample is old', async () => {
    vi.spyOn(api, 'topology').mockResolvedValue(EMPTY_TOPO);
    // A sample from long ago → outside the liveness window.
    vi.spyOn(api, 'telemetry').mockResolvedValue([
      freshPoint({ ts: '2020-01-01T00:00:00Z' }),
    ]);

    const { container } = render(<LiveSection site={site} />);

    await waitFor(() => expect(screen.getByText('keine aktuellen Daten')).toBeInTheDocument());
    expect(container.querySelector('.vp-status-line')).toHaveClass('stale');
    expect(container.querySelectorAll('.vp-stale').length).toBeGreaterThan(0);
  });
});
