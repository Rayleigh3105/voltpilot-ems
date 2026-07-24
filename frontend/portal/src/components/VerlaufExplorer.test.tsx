import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VerlaufExplorer } from './VerlaufExplorer';
import { api, type EntityHistory, type Site, type SiteEntities, type SiteTopology } from '../api';

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

// A migrated plant whose FIRST measurement is a producer (empty by construction).
const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'pv2',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      role: 'producer',
      label: 'Fronius',
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: 'fro-2',
    },
  ],
  localSetup: [
    { id: 'fro-2', kind: 'source', role: 'pv-generation', brand: 'Fronius', label: 'Anlage', reportedAt: '', adoptedEntityId: 'pv2' },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
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

describe('VerlaufExplorer — F2a producer empty state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('explains a producer is measured through the inverter instead of "Keine Werte"', async () => {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    vi.spyOn(api, 'entityHistory').mockResolvedValue(emptyHistory);

    render(<VerlaufExplorer site={site} range="day" anchor={new Date('2026-07-24T10:00:00Z')} initialTarget={null} />);

    await waitFor(() =>
      expect(screen.getByText('Wird über den Wechselrichter gemessen')).toBeInTheDocument(),
    );
    // The generic "Keine Werte" empty state must NOT be what a producer shows.
    expect(screen.queryByText('Keine Werte in diesem Zeitraum')).toBeNull();
  });
});
