import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type Device, type MastrPreview, type Site } from '../api';

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
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
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

function pvPreview(overrides: Partial<MastrPreview> = {}): MastrPreview {
  return {
    mastrNummer: 'SEE900000012345',
    kind: 'pv',
    name: null,
    status: 'In Betrieb',
    plantType: null,
    powerKw: 9.8,
    inverterPowerKw: null,
    moduleCount: 24,
    azimuthLabel: 'Süd',
    azimuthDeg: 180,
    tiltLabel: '30°',
    tiltDeg: 30,
    commissionedOn: '2023',
    storageCapacityKwh: null,
    chargePowerKw: null,
    batteryTechnology: null,
    plz: '89551',
    ort: 'Königsbronn',
    linkedUnitNumber: 'SEE900000067890',
    warnings: [],
    ...overrides,
  };
}

function storagePreview(overrides: Partial<MastrPreview> = {}): MastrPreview {
  return {
    mastrNummer: 'SEE900000067890',
    kind: 'storage',
    name: null,
    status: 'In Betrieb',
    plantType: null,
    powerKw: 5,
    inverterPowerKw: null,
    moduleCount: null,
    azimuthLabel: null,
    azimuthDeg: null,
    tiltLabel: null,
    tiltDeg: null,
    commissionedOn: '2023',
    storageCapacityKwh: 10,
    chargePowerKw: 5,
    batteryTechnology: 'Lithium',
    plz: null,
    ort: null,
    linkedUnitNumber: 'SEE900000012345',
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AnlageFlow - the register-first "Anlage anlegen" flow (captain 2026-07-09)', () => {
  it('walks Anlage -> Register (PV + linked Speicher) -> Gerät and finishes on the summary', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const mastrLookup = vi
      .spyOn(api, 'mastrLookup')
      .mockImplementation(async (_siteId: string, nummer: string) =>
        nummer === 'SEE900000012345' ? pvPreview() : storagePreview(),
      );
    const mastrApply = vi.spyOn(api, 'mastrApply').mockResolvedValue([]);
    const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(device);
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);

    // Step 1: Anlage - name only (the register brings the specs).
    expect(screen.getByText('Wie heißt Ihre Anlage?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());

    // Step 2: Register - enter ONLY the PV number; the storage is auto-adopted
    // from the record's linkedUnitNumber.
    expect(await screen.findByText('PV & Speicher aus dem Register')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('MaStR-Nummer der PV-Anlage'), {
      target: { value: 'SEE900000012345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    // Both units are looked up (PV, then the linked storage).
    await waitFor(() => expect(mastrLookup).toHaveBeenCalledTimes(2));
    expect(mastrLookup).toHaveBeenCalledWith('s-1', 'SEE900000012345');
    expect(mastrLookup).toHaveBeenCalledWith('s-1', 'SEE900000067890');

    // Preview: PV + linked storage + plausibility line.
    expect(await screen.findByText('Im Register gefunden')).toBeInTheDocument();
    expect(screen.getByText('PV-Anlage')).toBeInTheDocument();
    expect(screen.getByText('Batteriespeicher')).toBeInTheDocument();
    expect(screen.getByText('verknüpft')).toBeInTheDocument();
    expect(screen.getByText(/89551 Königsbronn - stimmt das\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen & weiter' }));
    await waitFor(() => expect(mastrApply).toHaveBeenCalled());
    const applied = mastrApply.mock.calls[0][1];
    expect(applied.pv?.mastrNummer).toBe('SEE900000012345');
    expect(applied.storage?.mastrNummer).toBe('SEE900000067890');

    // Step 3: Gerät.
    expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    await waitFor(() => expect(claimDevice).toHaveBeenCalledWith('s-1', 'VP-DEMO-0001'));

    // Fertig: the summary names PV, Speicher, Gerät and the source.
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(screen.getByText('Marktstammdaten')).toBeInTheDocument();
    expect(screen.getByText('VP-DEMO-0001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Anlage' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('keeps the manual fallback fully functional (Balkonkraftwerk / no number)', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const mastrLookup = vi.spyOn(api, 'mastrLookup');
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Drop into the manual hand-entry path from the register step.
    fireEvent.click(await screen.findByRole('button', { name: 'Keine Nummer? Daten manuell eingeben' }));
    expect(await screen.findByText('Daten manuell eingeben')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Kapazität (kWh)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Max. Ladeleistung (kW)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Max. Entladeleistung (kW)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speicher speichern' }));
    await waitFor(() => expect(saveBattery).toHaveBeenCalled());
    expect(saveBattery.mock.calls[0]).toEqual([
      's-1',
      { capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5 },
    ]);
    // The register was never queried on the manual path.
    expect(mastrLookup).not.toHaveBeenCalled();

    // Skip the device step - honest summary of what exists.
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(screen.getByText('manuell hinterlegt')).toBeInTheDocument();
    expect(screen.getByText('später verbinden')).toBeInTheDocument();
  });

  it('keeps every step past the first skippable and dead-end-free', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const claimDevice = vi.spyOn(api, 'claimDevice');
    const mastrApply = vi.spyOn(api, 'mastrApply');
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Skip the Register step, then the Gerät step.
    fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später nachtragen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));

    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(claimDevice).not.toHaveBeenCalled();
    expect(mastrApply).not.toHaveBeenCalled();
    // Nothing was applied, so the source line is absent.
    expect(screen.queryByText('Marktstammdaten')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Anlage' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('resumes a customer who already has an Anlage at the Register step (wizard restart)', () => {
    render(<AnlageFlow sites={[site]} waitForFirstData onDone={() => {}} />);
    expect(screen.getByText('PV & Speicher aus dem Register')).toBeInTheDocument();
  });

  it('maps the 422 claim refusal to the shared unknown-ID message', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'claimDevice').mockRejectedValue(new ApiError(422, 'unknown'));
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später nachtragen' }));
    fireEvent.change(await screen.findByLabelText('Geräte-ID'), {
      target: { value: 'edge-tippfehla' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(await screen.findByText(/Diese Geräte-ID kennen wir nicht/)).toBeInTheDocument();
  });

  it('surfaces the backend German MaStR error on a failed lookup', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'mastrLookup').mockRejectedValue(
      new ApiError(404, 'Diese Nummer ist im Register nicht auffindbar.'),
    );
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.change(await screen.findByLabelText('MaStR-Nummer der PV-Anlage'), {
      target: { value: 'SEE900000012345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    expect(await screen.findByText(/nicht auffindbar/)).toBeInTheDocument();
  });

  it('offers a "gleicher Standort wie …" reuse chip for an existing placed Anlage', () => {
    const placed: Site = { ...site, id: 's-9', name: 'Ferienhaus', latitude: 52.5, longitude: 13.4 };
    render(
      <AnlageFlow sites={[]} existingSites={[placed]} waitForFirstData={false} onDone={() => {}} />,
    );
    expect(screen.getByText('Gleicher Standort wie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ferienhaus/ })).toBeInTheDocument();
  });

  it('speaks "Anlage", never "Standort", as the entity name (wording decision 3)', () => {
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    expect(screen.getByLabelText('Name der Anlage')).toBeInTheDocument();
    expect(screen.queryByText(/Name des Standorts/)).not.toBeInTheDocument();
  });
});
