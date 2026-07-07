import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type Device, type Site } from '../api';

// Leaflet (pulled in via LocationMap) needs real layout that jsdom lacks -
// mock it like LocationMap.test.tsx does; the map itself is not under test.
vi.mock('leaflet', () => {
  const map = {
    on: vi.fn(),
    setView: vi.fn(),
    removeLayer: vi.fn(),
    invalidateSize: vi.fn(),
    getZoom: () => 13,
    getBounds: () => ({ contains: () => true }),
    remove: vi.fn(),
  };
  const marker = {
    addTo: vi.fn(() => marker),
    on: vi.fn(),
    setLatLng: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })),
  };
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    marker: vi.fn(() => marker),
    divIcon: vi.fn(() => ({})),
    latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })),
  };
  return { default: L };
});

const site: Site = {
  id: 's-1',
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  marktpraemieCtKwh: null,
  netzladenErlaubt: false,
};

const device: Device = {
  id: 'd-1',
  siteId: 's-1',
  externalRef: 'VP-DEMO-0001',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AnlageFlow - the ONE "Anlage anlegen" flow (captain decision 5)', () => {
  it('walks Anlage -> Gerät -> Speicher and finishes on the summary', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(device);
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const onDone = vi.fn();
    const onSiteCreated = vi.fn();

    render(
      <AnlageFlow
        sites={[]}
        waitForFirstData={false}
        onSiteCreated={onSiteCreated}
        onDone={onDone}
      />,
    );

    // Step 1: Anlage - name, derived zone, plant kind; advanced stays collapsed.
    expect(screen.getByText('Ihre Anlage')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(createSite.mock.calls[0][0]).toMatchObject({
      name: 'Zuhause',
      biddingZone: 'DE-LU',
      plantKind: 'eigenverbrauch',
      netzladenErlaubt: false,
    });
    expect(onSiteCreated).toHaveBeenCalledWith(site);

    // Step 2: Gerät - claim by Geräte-ID against the just-created Anlage.
    expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerät verbinden' }));
    await waitFor(() => expect(claimDevice).toHaveBeenCalledWith('s-1', 'VP-DEMO-0001'));

    // Step 3: Speicher - optional battery data, saved WITHOUT a deviceId
    // (the backend auto-links the claimed inverter).
    expect(await screen.findByText('Ihr Batteriespeicher')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Kapazität (kWh)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Max. Ladeleistung (kW)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Max. Entladeleistung (kW)'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speicher speichern' }));
    await waitFor(() => expect(saveBattery).toHaveBeenCalled());
    expect(saveBattery.mock.calls[0]).toEqual([
      's-1',
      { capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5 },
    ]);

    // Summary: honest recap, "Fertig" ends the flow.
    expect(await screen.findByText(/„Zuhause“ ist angelegt/)).toBeInTheDocument();
    expect(screen.getByText(/Speicherdaten sind hinterlegt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('keeps every step past the first skippable and dead-end-free', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const claimDevice = vi.spyOn(api, 'claimDevice');
    const saveBattery = vi.spyOn(api, 'saveBattery');
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);

    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Skip the Gerät step.
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät später verbinden' }));
    // Skip the Speicher step.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Kein Speicher oder später eintragen' }),
    );

    // The summary is honest about what was skipped.
    expect(await screen.findByText(/Noch ist kein Gerät verbunden/)).toBeInTheDocument();
    expect(claimDevice).not.toHaveBeenCalled();
    expect(saveBattery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('resumes a customer who already has an Anlage at the Gerät step (wizard restart)', () => {
    render(<AnlageFlow sites={[site]} waitForFirstData onDone={() => {}} />);
    expect(screen.getByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Anlage „${site.name}“ verbunden`))).toBeInTheDocument();
  });

  it('maps the 422 claim refusal to the shared unknown-ID message', async () => {
    vi.spyOn(api, 'claimDevice').mockRejectedValue(new ApiError(422, 'unknown'));
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);

    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'edge-tippfehla' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerät verbinden' }));
    expect(
      await screen.findByText(/Diese Geräte-ID kennen wir nicht/),
    ).toBeInTheDocument();
  });

  it('waits for first data after a claimed device in wizard mode', async () => {
    vi.spyOn(api, 'claimDevice').mockResolvedValue(device);
    vi.spyOn(api, 'telemetry').mockResolvedValue([]);
    render(<AnlageFlow sites={[site]} waitForFirstData onDone={() => {}} />);

    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'VP-DEMO-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerät verbinden' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Kein Speicher oder später eintragen' }),
    );
    expect(await screen.findByText('Ihr Gerät meldet sich…')).toBeInTheDocument();
  });

  it('speaks "Anlage", never "Standort", as the entity name (wording decision 3)', () => {
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    expect(screen.getByLabelText('Name der Anlage')).toBeInTheDocument();
    expect(screen.queryByText(/Name des Standorts/)).not.toBeInTheDocument();
    // The map keeps its address-sense "Standort" copy - that one survives by
    // design ("Standort bleibt nur als Adress-Angabe innerhalb der Anlage").
  });
});
