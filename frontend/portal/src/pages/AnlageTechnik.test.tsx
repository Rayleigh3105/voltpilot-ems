import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BatteryControlSection, StammdatenEditForm } from './AnlageTechnik';
import { api, type Device, type Site, type SiteAsset } from '../api';

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

const eegSite: Site = {
  id: 's-1',
  name: 'Hof Sonnenfeld',
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

describe('StammdatenEditForm (Meine Anlage - Stammdaten + Netzanschluss)', () => {
  it('sends the maximale Einspeiseleistung (FK1, moved up in v3.1-M3) and rejects garbage', async () => {
    const updateSite = vi.spyOn(api, 'updateSite').mockResolvedValue({ ...eegSite, maxFeedInKw: 75.5 });
    const onSaved = vi.fn();
    render(<StammdatenEditForm site={eegSite} onCancel={() => {}} onSaved={onSaved} />);
    const field = screen.getByLabelText('Maximale Einspeiseleistung am Netzanschlusspunkt (kW)');

    // Garbage blocks the submit with a German error, nothing is sent.
    fireEvent.change(field, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText(/maximale Einspeiseleistung als Zahl in kW/)).toBeInTheDocument();
    expect(updateSite).not.toHaveBeenCalled();

    // A German-comma value is parsed and sent.
    fireEvent.change(field, { target: { value: '75,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenCalledWith('s-1', expect.objectContaining({ maxFeedInKw: 75.5 }));
    updateSite.mockRestore();
  });

  it('a focused Technik save never blanks the fields the mode containers own', async () => {
    // A DV plant whose tariff/netzladen/anzulegender-Wert live in the mode
    // containers now: editing the name here must carry ALL of them through.
    const dvSite: Site = {
      ...eegSite,
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      netzladenErlaubt: true,
    };
    const updateSite = vi.spyOn(api, 'updateSite').mockResolvedValue(dvSite);
    const onSaved = vi.fn();
    render(<StammdatenEditForm site={dvSite} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Neuer Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // The moved fields ride along unchanged - the full-representation guard.
    expect(updateSite).toHaveBeenCalledWith('s-1', {
      name: 'Neuer Name',
      biddingZone: 'DE-LU',
      latitude: null,
      longitude: null,
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      netzladenErlaubt: true,
      maxFeedInKw: null,
    });
    updateSite.mockRestore();
  });
});

function battery(over: Partial<SiteAsset> = {}): SiteAsset {
  return {
    id: 'a-batt',
    type: 'battery',
    deviceId: null,
    capacityKwh: 10,
    maxChargeKw: 5,
    maxDischargeKw: 5,
    roundtripEfficiencyPct: null,
    speicherschonung: 'ausgewogen',
    pvCapacityKwp: null,
    moduleCount: null,
    azimuthDeg: null,
    tiltDeg: null,
    commissionedOn: null,
    registry: null,
    registryUnitId: null,
    registryFetchedAt: null,
    ...over,
  };
}

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'd-1',
    siteId: 's-1',
    externalRef: 'edge-abcdefj',
    kind: 'inverter',
    name: null,
    status: 'claimed',
    lastSeenAt: null,
    createdAt: null,
    ...over,
  };
}

describe('BatteryControlSection (battery <-> device control path)', () => {
  it('warns when the battery has no controlling device (warning stays always visible)', () => {
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: null })}
        devices={[device()]}
        onSaved={() => {}}
      />,
    );
    // The no-device warning is a real failure - shown before any disclosure.
    expect(screen.getByText(/keinem Gerät zugeordnet/)).toBeInTheDocument();
    // The controlling-device row moved behind "Technische Details".
    fireEvent.click(screen.getByRole('button', { name: /Technische Details/ }));
    expect(screen.getByText(/nicht zugeordnet/)).toBeInTheDocument();
  });

  it('shows the controlling device and no warning when linked', () => {
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: 'd-1' })}
        devices={[device({ id: 'd-1', name: 'Wechselrichter Garage' })]}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByText(/keinem Gerät zugeordnet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Technische Details/ }));
    expect(screen.getByText('Wechselrichter Garage')).toBeInTheDocument();
  });

  it('offers to add a battery when none exists yet', () => {
    render(<BatteryControlSection siteId="s-1" battery={null} devices={[]} onSaved={() => {}} />);
    expect(screen.getByRole('button', { name: /Speicher hinzufügen/ })).toBeInTheDocument();
  });

  it('saves parsed params + the chosen controlling device, NEVER the moved Speicherschonung', async () => {
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const onSaved = vi.fn();
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: null })}
        devices={[device({ id: 'd-1', name: 'WR Nord' }), device({ id: 'd-2', name: 'WR Süd' })]}
        onSaved={onSaved}
      />,
    );
    // The editor lives behind "Technische Details" in the read-first layout.
    fireEvent.click(screen.getByRole('button', { name: /Technische Details/ }));
    fireEvent.click(screen.getByRole('button', { name: /Speicher bearbeiten/ }));
    // The Speicherschonung radio group is GONE from here (moved to the mode
    // containers in v3.1-M3).
    expect(screen.queryByRole('radio', { name: /Ausgewogen/ })).toBeNull();
    // German comma decimal is accepted.
    fireEvent.change(screen.getByLabelText('Kapazität (kWh) *'), { target: { value: '12,5' } });
    fireEvent.change(screen.getByLabelText('Steuerndes Gerät'), { target: { value: 'd-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speicher speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // No speicherschonung sent - a param edit keeps the customer's stored preset.
    expect(saveBattery).toHaveBeenCalledWith('s-1', {
      capacityKwh: 12.5,
      maxChargeKw: 5,
      maxDischargeKw: 5,
      roundtripEfficiencyPct: null,
      deviceId: 'd-2',
    });
    saveBattery.mockRestore();
  });

  it('no longer shows the Speicherschonung row in the read view (moved to the mode containers)', () => {
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: 'd-1', speicherschonung: 'ausgewogen' })}
        devices={[device({ id: 'd-1' })]}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByText('Umgang mit dem Speicher')).toBeNull();
    // Kapazität stays as the read-first battery figure.
    expect(screen.getByText('Kapazität')).toBeInTheDocument();
  });
});
