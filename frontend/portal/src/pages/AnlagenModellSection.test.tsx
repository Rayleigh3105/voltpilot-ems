import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlagenModellSection } from './AnlagenModellSection';
import { api, ApiError, type Site, type SiteEntities, type SiteTopology } from '../api';
import * as auth from '../auth';
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
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      role: 'storage',
      label: 'Batteriespeicher',
      control: true,
      deviceId: 'gw',
      capabilities: {
        measure: [
          { channel: 'pv_power_kw', unit: 'kW' },
          { channel: 'soc_pct', unit: '%' },
        ],
      },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: null,
    },
  ],
  localSetup: [
    { id: 'inv', kind: 'inverter', role: null, brand: 'deye', label: 'SUN-12K', reportedAt: '', adoptedEntityId: null },
    // A newly reported go-e wallbox — not adopted yet.
    { id: 'goe-1', kind: 'source', role: 'consumer', brand: 'go-e', label: 'Charger 3', reportedAt: '', adoptedEntityId: null },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      label: 'Batteriespeicher',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: 5.8 },
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
      ],
    },
  ],
  topology: { schema_version: '1.0', nodes: [] },
};

function stub() {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  // The installer panel (EntitaetenSection) also reads these — fail-soft, but
  // stub them so an admin render is quiet.
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue({ catalog_version: '1.0.0', types: [] });
}

const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/;

describe('AnlagenModellSection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the three columns and highlights a device on click', async () => {
    stub();
    render(<AnlagenModellSection site={site} />);

    // Three columns.
    expect(await screen.findByRole('group', { name: 'Anlagen-Modell' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Geräte' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Komponenten' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Ihre Anlage' })).toBeInTheDocument();

    // Tap the device -> it becomes pressed (its components highlight).
    const device = screen.getByRole('button', { name: /SUN-12K/ });
    expect(device).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(device);
    expect(device).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the newly reported device and opens the one-move assign dialog', async () => {
    stub();
    render(<AnlagenModellSection site={site} />);

    const found = await screen.findByText('Neues Gerät gefunden');
    fireEvent.click(found);
    expect(await screen.findByText('Gerät zuordnen')).toBeInTheDocument();
    expect(screen.getByText('Was misst dieses Gerät?')).toBeInTheDocument();
    // The guided type for a go-e source is a Wallbox.
    expect(screen.getByText('Wallbox')).toBeInTheDocument();
  });

  it('shows the honest fallback when the customer adopt twin is absent (403)', async () => {
    stub();
    vi.spyOn(entitiesApi, 'adopt').mockRejectedValue(new ApiError(403, 'Forbidden'));
    render(<AnlagenModellSection site={site} />);

    fireEvent.click(await screen.findByText('Neues Gerät gefunden'));
    fireEvent.click(await screen.findByRole('button', { name: 'Fertig' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/VoltPilot/),
    );
  });

  it('uses no forbidden customer vocabulary in the customer view', async () => {
    stub();
    const { container } = render(<AnlagenModellSection site={site} />);
    await screen.findByRole('group', { name: 'Anlagen-Modell' });
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
  });

  // M7 role-gate: two views, one product. A customer never sees the technical
  // installer layer; a platform-admin sees it ADDED to the same page.
  it('hides the installer layer for a customer (showTechnicalLayer false)', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} />);
    await screen.findByRole('group', { name: 'Anlagen-Modell' });
    expect(screen.queryByText(/Installateur-Ansicht/)).toBeNull();
    // …and the technical panel's own vocabulary is nowhere on the page.
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
  });

  it('shows the installer layer for a platform-admin, on the same page', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    render(<AnlagenModellSection site={site} />);
    // The customer picture is still there…
    await screen.findByRole('group', { name: 'Anlagen-Modell' });
    // …plus the installer panel added on top.
    expect(screen.getByText(/Installateur-Ansicht/)).toBeInTheDocument();
    expect(await screen.findByText('Rollen & Zuordnung')).toBeInTheDocument();
  });
});
