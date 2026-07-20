import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EntitaetenSection } from './EntitaetenSection';
import { api, type Site, type SiteEntities, type SiteTopology } from '../api';
import { entitiesApi } from '../entitiesApi';

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

const entities: SiteEntities = {
  registry: {
    revision: 'r1',
    composedAt: '2026-07-20T10:00:00Z',
    deviceId: 'd-1',
    reportedRevision: 'r1',
    reportedAt: '2026-07-20T10:00:00Z',
  },
  entities: [
    {
      id: 'wallbox',
      entityType: 'wallbox',
      typeLabel: 'Wallbox',
      role: 'wallbox',
      label: 'Wallbox Carport',
      control: true,
      deviceId: 'd-1',
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
      guards: { failsafe: { behavior: 'release' } },
      syncStatus: 'in_sync',
      observed: {
        health: 'ok',
        lastTelemetryAt: '2026-07-20T10:00:00Z',
        channels: ['power_kw'],
        appliedType: 'wallbox',
        reportedAt: '2026-07-20T10:00:00Z',
      },
      edgeSourceId: 'goe-1',
    },
  ],
  localSetup: [
    {
      id: 'inv',
      kind: 'inverter',
      role: null,
      brand: 'deye',
      label: 'SUN-12K',
      reportedAt: '2026-07-20T10:00:00Z',
      adoptedEntityId: null,
    },
    {
      id: 'grid-src',
      kind: 'source',
      role: 'grid-meter',
      brand: 'Fronius',
      label: 'Smart Meter',
      reportedAt: '2026-07-20T10:00:00Z',
      adoptedEntityId: null,
    },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'wallbox',
      entityType: 'wallbox',
      typeLabel: 'Wallbox',
      label: 'Wallbox Carport',
      category: 'consumer',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: true, value: 3.2 }],
    },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      { role: 'consumer', value_kw: 3.2, flow_active: true, direction: 'out', members: [] },
    ],
  },
};

function stub() {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue({
    catalog_version: '1.0.0',
    types: [
      { type: 'wallbox', label: 'Wallbox', category: 'consumer', controllable: true, composed: false, default_failsafe: 'release' },
      { type: 'grid-meter', label: 'Netzanschlusszähler', category: 'meter', controllable: false, composed: true, default_failsafe: 'measure-only' },
    ],
  });
}

describe('EntitaetenSection', () => {
  it('renders the three sections with role pills and the adoption CTA (admin)', async () => {
    stub();
    render(<EntitaetenSection site={site} isAdmin />);

    // Section 1: the entity card with its assigned role pill.
    expect(await screen.findByText('Ihre Geräte')).toBeInTheDocument();
    // The label appears on the entity card AND as a role-box member.
    await waitFor(() => expect(screen.getAllByText('Wallbox Carport').length).toBeGreaterThan(0));
    const pills = await screen.findAllByText('Verbraucher');
    expect(pills.length).toBeGreaterThan(0); // role pill + role box heading

    // Section 2: the Rollen & Zuordnung box.
    expect(screen.getByText('Rollen & Zuordnung')).toBeInTheDocument();
    expect(screen.getByText(/Automatisch zugeordnet/)).toBeInTheDocument();

    // Section 3: the reported grid source is adoptable by the admin.
    expect(screen.getByText('Vom Gerät gemeldet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Als Entität übernehmen' })).toBeInTheDocument();
    // The reported inverter shows as info, not adoptable.
    expect(screen.getByText(/vor Ort eingerichtet/)).toBeInTheDocument();
  });

  it('hides the adoption CTA for customers and shows the honest hint', async () => {
    stub();
    render(<EntitaetenSection site={site} isAdmin={false} />);
    await screen.findByText('Vom Gerät gemeldet');
    expect(screen.queryByRole('button', { name: 'Als Entität übernehmen' })).toBeNull();
    expect(screen.getAllByText('VoltPilot richtet ein').length).toBeGreaterThan(0);
  });
});
