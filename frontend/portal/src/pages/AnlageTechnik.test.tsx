import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BatteryControlSection, VerguetungEditForm } from './AnlageTechnik';
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
  marktpraemieCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
};

describe('VerguetungEditForm (netzladen switch, captain revision 2026-07-07)', () => {
  it('renders the editable switch for site owners - no read-only admin note anymore', () => {
    render(<VerguetungEditForm site={eegSite} onCancel={() => {}} onSaved={() => {}} />);
    const select = screen.getByLabelText('Netzladen des Speichers') as HTMLSelectElement;
    expect(select.value).toBe('verboten');
    // The Ausschließlichkeitsprinzip warning stays, carrying the responsibility.
    expect(screen.getByText(/Ausschließlichkeitsprinzip/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nur aktivieren, wenn Ihre Anlage keine\s+EEG-Vergütung bezieht/),
    ).toBeInTheDocument();
    // The former customer read-only note is gone.
    expect(screen.queryByText(/Änderung nur durch den Betreiber/)).not.toBeInTheDocument();
  });

  it('sends the flipped netzladenErlaubt value on save, carrying the Stammdaten through', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, netzladenErlaubt: true });
    const onSaved = vi.fn();
    render(<VerguetungEditForm site={eegSite} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Netzladen des Speichers'), {
      target: { value: 'erlaubt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // A focused form still posts the full site representation (name is @NotBlank
    // server-side, plantKind/tarifArt default when omitted), so the untouched
    // Grunddaten ride along unchanged.
    expect(updateSite).toHaveBeenCalledWith(
      eegSite.id,
      expect.objectContaining({ netzladenErlaubt: true, name: eegSite.name, plantKind: 'eigenverbrauch' }),
    );
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
    render(
      <BatteryControlSection siteId="s-1" battery={null} devices={[]} onSaved={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /Speicher hinzufügen/ })).toBeInTheDocument();
  });

  it('saves parsed params + the chosen controlling device', async () => {
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
    // German comma decimal is accepted.
    fireEvent.change(screen.getByLabelText('Kapazität (kWh) *'), { target: { value: '12,5' } });
    fireEvent.change(screen.getByLabelText('Steuerndes Gerät'), { target: { value: 'd-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speicher speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveBattery).toHaveBeenCalledWith('s-1', {
      capacityKwh: 12.5,
      maxChargeKw: 5,
      maxDischargeKw: 5,
      roundtripEfficiencyPct: null,
      deviceId: 'd-2',
    });
    saveBattery.mockRestore();
  });
});
