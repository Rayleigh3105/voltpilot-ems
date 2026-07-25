import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VerlaufExplorer } from './VerlaufExplorer';
import {
  api,
  type EntityHistory,
  type Site,
  type SiteEntities,
  type SiteEntity,
  type SiteTopology,
} from '../api';

// The chart uses useEChart (canvas); jsdom has neither, so stub it.
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

const site: Site = {
  id: 's-1',
  name: 'Pilsting',
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

function entity(over: Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>): SiteEntity {
  return {
    typeLabel: 'Komponente',
    role: over.entityType,
    label: null,
    control: false,
    deviceId: 'gw',
    capabilities: { measure: [] },
    guards: null,
    syncStatus: 'in_sync',
    observed: null,
    edgeSourceId: null,
    ...over,
  } as SiteEntity;
}

// A migrated plant whose FIRST measurement is a producer (empty by construction).
const producerOnly: SiteEntities = {
  registry: null,
  entities: [
    entity({
      id: 'pv2',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      label: 'Fronius',
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
      edgeSourceId: 'fro-2',
    }),
  ],
  localSetup: [
    { id: 'fro-2', kind: 'source', role: 'pv-generation', brand: 'Fronius', label: 'Anlage', reportedAt: '', adoptedEntityId: 'pv2' },
  ],
  staleOnDevice: [],
};

const producerTopology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'pv2', entityType: 'producer', typeLabel: 'Erzeuger', label: 'Fronius', category: 'producer', health: 'never', capabilities: [] },
  ],
  topology: { schema_version: '1.0', nodes: [] },
};

/** The producer has no telemetry_v2 → its channel history is empty. */
const emptyHistory: EntityHistory = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  channels: { pv_power_kw: [] },
};

// --- A plant with a hybrid (3 channels), a grid meter and a silent producer ---

const fullPlant: SiteEntities = {
  registry: null,
  entities: [
    entity({
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher (Hybrid)',
      // The stored label carries its type in brackets - the rail strips it.
      label: 'Batteriespeicher (Hybrid)',
      control: true,
      capabilities: {
        measure: [
          { channel: 'soc_pct', unit: '%' },
          { channel: 'pv_power_kw', unit: 'kW' },
          { channel: 'battery_power_kw', unit: 'kW' },
        ],
      },
    }),
    entity({
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netzanschluss (Messung)',
      label: 'Netzanschluss (Messung)',
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    }),
    entity({
      id: 'pv2',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      label: 'Fronius WR 1',
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
      edgeSourceId: 'fro-2',
    }),
  ],
  // The technical dump the design flagged: four near-duplicate device names for
  // one component ("deye · sun-30k-sg01hp3 · Deye · SUN-30K-SG01HP3-EU").
  localSetup: [
    { id: 'inv', kind: 'inverter', role: null, brand: 'deye', label: 'SUN-30K-SG01HP3-EU', reportedAt: '', adoptedEntityId: null },
    { id: 'fro-2', kind: 'source', role: 'pv-generation', brand: 'Fronius', label: 'WR 1', reportedAt: '', adoptedEntityId: 'pv2' },
  ],
  staleOnDevice: [],
};

const fullTopology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', typeLabel: 'Speicher', label: 'Batteriespeicher (Hybrid)', category: 'storage', health: 'ok', capabilities: [] },
    { id: 'grid', entityType: 'grid-meter', typeLabel: 'Netz', label: 'Netzanschluss (Messung)', category: 'meter', health: 'ok', capabilities: [] },
    { id: 'pv2', entityType: 'producer', typeLabel: 'Erzeuger', label: 'Fronius WR 1', category: 'producer', health: 'never', capabilities: [] },
  ],
  topology: { schema_version: '1.0', nodes: [] },
};

function hist(channels: Record<string, number>): EntityHistory {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    channels: Object.fromEntries(
      Object.entries(channels).map(([ch, v]) => [
        ch,
        [{ start: '2026-07-24T10:00:00Z', avg: v, min: v, max: v, last: v, n: 1 }],
      ]),
    ),
  };
}

const anchor = new Date('2026-07-24T10:00:00Z');

describe('VerlaufExplorer — F2a producer empty state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('explains a producer is measured through the inverter instead of "Keine Werte"', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(producerOnly);
    vi.spyOn(api, 'topology').mockResolvedValue(producerTopology);
    vi.spyOn(api, 'entityHistory').mockResolvedValue(emptyHistory);

    render(<VerlaufExplorer site={site} range="day" anchor={anchor} initialTargets={[]} />);

    await waitFor(() =>
      expect(screen.getByText('Wird über den Wechselrichter gemessen')).toBeInTheDocument(),
    );
    // The generic "Keine Werte" empty state must NOT be what a producer shows.
    expect(screen.queryByText('Keine Werte in diesem Zeitraum')).toBeNull();
  });
});

describe('VerlaufExplorer — B1-c multi-select (up to 3)', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockFull() {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(fullPlant);
    vi.spyOn(api, 'topology').mockResolvedValue(fullTopology);
    return vi.spyOn(api, 'entityHistory').mockImplementation(async (_s, entityId) => {
      if (entityId === 'batt') return hist({ soc_pct: 80, pv_power_kw: 3.2, battery_power_kw: 1.1 });
      if (entityId === 'grid') return hist({ power_kw: -1.4 });
      return emptyHistory;
    });
  }

  it('cleans the rail: plain component names and ONE device name with its state', async () => {
    mockFull();
    render(<VerlaufExplorer site={site} range="day" anchor={anchor} initialTargets={[]} />);

    // The parenthetical type suffix is gone (it used to be truncated mid-word).
    await screen.findByText('Batteriespeicher');
    expect(screen.getByText('Netzanschluss')).toBeInTheDocument();
    expect(screen.queryByText(/\(Hybrid\)/)).toBeNull();
    expect(screen.queryByText(/\(Messung\)/)).toBeNull();

    // ONE device name plus its state - no id chain, no repeated model.
    const deviceLines = screen.getAllByText(/verbunden/);
    expect(deviceLines.length).toBeGreaterThan(0);
    for (const el of deviceLines) {
      expect(el.textContent).toBe('Deye SUN-30K-SG01HP3-EU · verbunden');
    }
  });

  it('lands on a measuring component, never on the silent producer', async () => {
    const eh = mockFull();
    render(<VerlaufExplorer site={site} range="day" anchor={anchor} initialTargets={[]} />);
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'batt', 'day', expect.any(String)));
    expect(eh).not.toHaveBeenCalledWith('s-1', 'pv2', 'day', expect.any(String));
  });

  it('puts up to 3 measurements on one chart and refuses the 4th', async () => {
    mockFull();
    render(<VerlaufExplorer site={site} range="day" anchor={anchor} initialTargets={[]} />);
    await screen.findByText('1 von 3 ausgewählt · max. 3');

    // Add two more (a second channel of the same component + another component).
    fireEvent.click(screen.getAllByRole('option', { name: /Batterieleistung/ })[0]);
    await screen.findByText('2 von 3 ausgewählt · max. 3');
    fireEvent.click(screen.getAllByRole('option', { name: /^Leistung/ })[0]);
    await screen.findByText('3 von 3 ausgewählt · max. 3');
    // (the head and the phone picker both name it)
    expect(screen.getAllByText('3 Messwerte im Vergleich').length).toBeGreaterThan(0);

    // The 4th is refused, and the row says so instead of silently doing nothing.
    const fourth = screen.getAllByRole('option', { name: /PV-Leistung/ })[0];
    expect(fourth).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(fourth);
    expect(screen.getByText('3 von 3 ausgewählt · max. 3')).toBeInTheDocument();

    // Deselecting works; the last remaining one can NOT be deselected away.
    fireEvent.click(screen.getAllByRole('option', { name: /Batterieleistung/ })[0]);
    await screen.findByText('2 von 3 ausgewählt · max. 3');
  });

  it('prefixes measurements with their component when several are compared', async () => {
    mockFull();
    render(<VerlaufExplorer site={site} range="day" anchor={anchor} initialTargets={[]} />);
    await screen.findByText('1 von 3 ausgewählt · max. 3');
    fireEvent.click(screen.getAllByRole('option', { name: /^Leistung/ })[0]);
    // Two components -> the legend disambiguates ("Netzanschluss · Leistung").
    await waitFor(() =>
      expect(screen.getAllByText('Netzanschluss · Leistung').length).toBeGreaterThan(0),
    );
  });

  it('opens pre-selected from a multi-measurement deep link', async () => {
    const eh = mockFull();
    render(
      <VerlaufExplorer
        site={site}
        range="day"
        anchor={anchor}
        initialTargets={[
          { entityId: 'batt', channel: 'soc_pct' },
          { entityId: 'grid', channel: 'power_kw' },
        ]}
      />,
    );
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'batt', 'day', expect.any(String)));
    expect(eh).toHaveBeenCalledWith('s-1', 'grid', 'day', expect.any(String));
    await screen.findByText('2 von 3 ausgewählt · max. 3');
  });

  it('NAMES a comparison partner that has no values instead of dropping its curve', async () => {
    mockFull();
    render(
      <VerlaufExplorer
        site={site}
        range="day"
        anchor={anchor}
        initialTargets={[
          { entityId: 'batt', channel: 'soc_pct' },
          { entityId: 'pv2', channel: 'pv_power_kw' },
        ]}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Fronius WR 1 · PV-Leistung: keine Werte in diesem Zeitraum\./),
      ).toBeInTheDocument(),
    );
    // The one that HAS values is still charted with its stats.
    expect(screen.getByLabelText(/Kennzahlen im Zeitraum: Batteriespeicher · Ladestand/)).toBeInTheDocument();
  });
});
