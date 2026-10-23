import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import {
  api,
  ApiError,
  type Device,
  type MastrPreview,
  type Site,
  type SiteAsset,
  type EntityLocalSetup,
  type SiteEntities,
} from '../api';
import { entitiesApi } from '../entitiesApi';
import { anlageRoute } from '../nav';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';

// The adaptive Nutzung step reads isPlatformAdmin() (admin: bootstrap +
// auto-start + entity add). The flow tests exercise the CUSTOMER path - keycloak
// stays out of jsdom, and the admin-only ops are never called.
vi.mock('../auth', () => ({ isPlatformAdmin: () => false }));

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

/** A complete battery asset row (what the Register/manual step leaves behind). */
function batteryAsset(overrides: Partial<SiteAsset> = {}): SiteAsset {
  return {
    id: 'a-1',
    type: 'battery',
    deviceId: null,
    capacityKwh: 10,
    maxChargeKw: 5,
    maxDischargeKw: 5,
    roundtripEfficiencyPct: 92,
    speicherschonung: 'ausgewogen',
    pvCapacityKwp: null,
    moduleCount: null,
    azimuthDeg: null,
    tiltDeg: null,
    commissionedOn: null,
    registry: null,
    registryUnitId: null,
    registryFetchedAt: null,
    ...overrides,
  };
}

const emptyEntities: SiteEntities = {
  registry: null,
  entities: [],
  localSetup: [],
  staleOnDevice: [],
};

/** Was eine Box meldet (`/entities` → `localSetup`). */
function gemeldet(over: Partial<EntityLocalSetup>): EntityLocalSetup {
  return {
    id: 'src-1',
    kind: 'source',
    role: 'pv-generation',
    brand: 'Fronius',
    model: 'Symo 10.0',
    label: null,
    reportedAt: '2026-10-23T10:00:00Z',
    adoptedEntityId: null,
    ...over,
  };
}

function mitFund(localSetup: EntityLocalSetup[]): SiteEntities {
  return { ...emptyEntities, localSetup };
}

/** Schritt 1 (Bestand ohne Standort-Objekt) und Schritt 2 durchlaufen - mit Box oder ohne. */
async function bisSchritt3(box: 'verbinden' | 'spaeter') {
  fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Zuhause' } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  expect(await screen.findByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeInTheDocument();
  if (box === 'spaeter') {
    fireEvent.click(screen.getByRole('button', { name: 'Box ist noch nicht da - später verbinden' }));
    return;
  }
  fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'edge-k7m2xq3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
});

describe('AnlageFlow - Adresse · Box · Anlage (Anlage-Flow a1, Paket 2)', () => {
  it('mit Box: verbinden, die gefundenen Geräte bestätigen, die kWp gehen EINMAL an den Erzeuger - und ab ins Cockpit', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue({ ...device, externalRef: 'edge-k7m2xq3' });
    vi.spyOn(api, 'siteEntities').mockResolvedValue(
      mitFund([
        gemeldet({ id: 'wr', kind: 'inverter', role: null, brand: 'Deye', model: 'SUN-10K' }),
        gemeldet({ id: 'pv-1' }),
        gemeldet({ id: 'zaehler', role: 'grid-meter', brand: 'Eastron', model: 'SDM630' }),
      ]),
    );
    const adopt = vi.spyOn(entitiesApi, 'adopt').mockResolvedValue({} as never);
    const savePv = vi.spyOn(api, 'savePv');
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await bisSchritt3('verbinden');
    // Das Verbinden trägt eine Anfrage-Kennung - ein Wiederholen verbindet nie doppelt (Paket 2).
    await waitFor(() =>
      expect(claimDevice).toHaveBeenCalledWith('s-1', 'edge-k7m2xq3', expect.stringMatching(/:box:edge-k7m2xq3$/)),
    );

    // Kein Warte-Bildschirm (D7): Schritt 3 zeigt, was die Box gefunden hat.
    expect(await screen.findByRole('heading', { name: 'Das hat Ihre Box gefunden' })).toBeInTheDocument();
    expect(screen.getByText('Wechselrichter')).toBeInTheDocument();
    expect(screen.getByText('PV-Erzeuger')).toBeInTheDocument();
    expect(screen.getByText('Netz-Zähler')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Leistung der Solarmodule (kWp)'), { target: { value: '9,8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stimmt so' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(anlageRoute('s-1')));
    expect(adopt).toHaveBeenCalledWith('s-1', { sourceId: 'pv-1', entityType: 'producer', capacityKwp: 9.8, registryUnitId: undefined });
    expect(adopt).toHaveBeenCalledWith('s-1', { sourceId: 'zaehler', entityType: 'grid-meter', capacityKwp: undefined, registryUnitId: undefined });
    expect(adopt).toHaveBeenCalledTimes(2);
    // Die kWp stehen genau einmal in der Summe: mit gemeldetem Erzeuger über ihn, nie zusätzlich an der Anlage.
    expect(savePv).not.toHaveBeenCalled();
    // Die Karte „Ihre Anlage ist live“ steht an (D7), der Entwurf ist weg (F9).
    expect(localStorage.getItem('vp.erste-werte.s-1')).toBe('1');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('die Box meldet sich im Hintergrund: erst „wird gesucht“, dann die Liste - ohne zu warten', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'createSite').mockResolvedValue(site);
      vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
      vi.spyOn(api, 'claimDevice').mockResolvedValue({ ...device, externalRef: 'edge-k7m2xq3' });
      const entities = vi.spyOn(api, 'siteEntities').mockResolvedValue(emptyEntities);
      render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
      await bisSchritt3('verbinden');
      expect(await screen.findByRole('heading', { name: /^Ihre Box meldet gerade ihre Geräte/ })).toBeInTheDocument();
      expect(screen.getByText('werden gesucht')).toBeInTheDocument();
      // Weiter geht es trotzdem: der Knopf steht.
      expect(screen.getByRole('button', { name: 'Stimmt so' })).toBeEnabled();

      entities.mockResolvedValue(mitFund([gemeldet({ id: 'pv-1' })]));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await screen.findByRole('heading', { name: 'Das hat Ihre Box gefunden' })).toBeInTheDocument();
      expect(screen.getByText('Fronius Symo 10.0')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F17: kennt die Anlage die kWp schon (Register), steht sie als Tatsache da - der Erzeuger kommt ohne zweite Buchung', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([
      batteryAsset({ id: 'pv', type: 'pv', pvCapacityKwp: 9.8, capacityKwh: null, registry: 'mastr', registryUnitId: 'SEE900000012345' }),
      batteryAsset(),
    ]);
    vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [device], teilansicht: null } as never);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(mitFund([gemeldet({ id: 'pv-1' })]));
    const adopt = vi.spyOn(entitiesApi, 'adopt').mockResolvedValue({} as never);
    const onDone = vi.fn();
    render(<AnlageFlow sites={[site]} wirt="assistent" onDone={onDone} />);

    expect(await screen.findByText('9,8 kWp')).toBeInTheDocument();
    expect(screen.getByText('aus dem Register')).toBeInTheDocument();
    expect(screen.getByText('10 kWh')).toBeInTheDocument();
    expect(screen.queryByLabelText('Leistung der Solarmodule (kWp)')).toBeNull();
    // Was die Anlagen-Daten wissen, fragt der Schritt nicht - der Register-Link entfällt.
    expect(screen.queryByRole('button', { name: 'Aus dem Register holen' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Stimmt so' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(adopt).toHaveBeenCalledWith('s-1', {
      sourceId: 'pv-1',
      entityType: 'producer',
      capacityKwp: undefined,
      registryUnitId: 'SEE900000012345',
    });
  });

  it('ohne Box: „Was haben Sie?“ - Solar und Speicher als Zahlen, die kWp an die Anlage (PUT /pv)', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const entities = vi.spyOn(api, 'siteEntities');
    const savePv = vi.spyOn(api, 'savePv').mockResolvedValue([]);
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const claim = vi.spyOn(api, 'claimDevice');
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await bisSchritt3('spaeter');

    expect(await screen.findByRole('heading', { name: 'Was haben Sie?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Solar' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Leistung der Solarmodule (kWp)'), { target: { value: '6,05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speicher' }));
    fireEvent.change(screen.getByLabelText('Kapazität (kWh)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Lade- und Entladeleistung (kW)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(anlageRoute('s-1')));
    expect(savePv).toHaveBeenCalledWith('s-1', 6.05);
    expect(saveBattery).toHaveBeenCalledWith('s-1', { capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5 });
    expect(claim).not.toHaveBeenCalled();
    // Ohne Box fragt der Schritt keine Geräte ab.
    expect(entities).not.toHaveBeenCalled();
  });

  it('„Später ergänzen“ lässt alles offen und erfindet nichts', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const savePv = vi.spyOn(api, 'savePv');
    const saveBattery = vi.spyOn(api, 'saveBattery');
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await bisSchritt3('spaeter');
    fireEvent.change(await screen.findByLabelText('Leistung der Solarmodule (kWp)'), { target: { value: '6,05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Später ergänzen' }));
    expect(onDone).toHaveBeenCalledWith(anlageRoute('s-1'));
    expect(savePv).not.toHaveBeenCalled();
    expect(saveBattery).not.toHaveBeenCalled();
  });

  it('Fehler am Feld: eine falsche Zahl wird nicht gesendet, eine Ablehnung des Servers steht am Feld, das sie meint', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const savePv = vi.spyOn(api, 'savePv').mockRejectedValue(
      new ApiError(400, 'Bad Request', { code: 'anfrage_ungueltig', feld: 'capacityKwp', message: 'Höchstens zwei Nachkommastellen, z. B. 9,8 kWp.' }),
    );
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await bisSchritt3('spaeter');
    const feld = await screen.findByLabelText('Leistung der Solarmodule (kWp)');
    fireEvent.change(feld, { target: { value: '9,875' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Höchstens zwei Nachkommastellen, z. B. 9,8 kWp.')).toBeInTheDocument();
    expect(savePv).not.toHaveBeenCalled();
    await waitFor(() => expect(feld).toHaveFocus());

    fireEvent.change(feld, { target: { value: '9,8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(savePv).toHaveBeenCalledWith('s-1', 9.8));
    expect(await screen.findByText('Höchstens zwei Nachkommastellen, z. B. 9,8 kWp.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    // Speicher gewählt, aber ohne Zahlen: beide Sätze am Feld, nichts gesendet.
    fireEvent.click(screen.getByRole('button', { name: 'Speicher' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/Kapazität des Speichers als Zahl/)).toBeInTheDocument();
    expect(screen.getByText(/Leistung des Speichers als Zahl/)).toBeInTheDocument();
  });

  it('R4: „Aus dem Register holen“ - der Ort aus dem Register wird gegen die Adresse geprüft, die Werte stehen danach als Tatsache', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const assets = vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'mastrLookup').mockImplementation(async (_s: string, nummer: string) =>
      nummer === 'SEE900000012345' ? pvPreview() : storagePreview(),
    );
    const mastrApply = vi.spyOn(api, 'mastrApply').mockResolvedValue([
      batteryAsset({ id: 'pv', type: 'pv', pvCapacityKwp: 9.8, capacityKwh: null, registry: 'mastr', registryUnitId: 'SEE900000012345' }),
      batteryAsset({ registry: 'mastr' }),
    ]);
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await bisSchritt3('spaeter');
    fireEvent.click(await screen.findByRole('button', { name: 'Aus dem Register holen' }));
    fireEvent.change(screen.getByLabelText('MaStR-Nummer der PV-Anlage'), { target: { value: 'SEE900000012345' } });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    expect(await screen.findByText('Im Register gefunden')).toBeInTheDocument();
    // Ohne bekannte Adresse (Bestand ohne Standort-Objekt) fragt die Zeile nur.
    expect(screen.getByText('89551 Königsbronn - stimmt das?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    await waitFor(() => expect(mastrApply).toHaveBeenCalled());
    expect(mastrApply.mock.calls[0][1].storage?.mastrNummer).toBe('SEE900000067890');
    expect(await screen.findByText('9,8 kWp')).toBeInTheDocument();
    expect(screen.getByText('aus dem Register')).toBeInTheDocument();
    expect(assets).toHaveBeenCalledTimes(1);
  });

  it('surfaces the backend German MaStR error on a failed lookup', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'mastrLookup').mockRejectedValue(new ApiError(404, 'Diese Nummer ist im Register nicht auffindbar.'));
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await bisSchritt3('spaeter');
    fireEvent.click(await screen.findByRole('button', { name: 'Aus dem Register holen' }));
    fireEvent.change(screen.getByLabelText('MaStR-Nummer der PV-Anlage'), { target: { value: 'SEE900000012345' } });
    fireEvent.click(screen.getByRole('button', { name: /Im Register suchen/ }));
    expect(await screen.findByText(/nicht auffindbar/)).toBeInTheDocument();
    // Zurück ohne Register: der Schritt steht wieder.
    fireEvent.click(screen.getByRole('button', { name: 'Ohne Register weiter' }));
    expect(await screen.findByRole('heading', { name: 'Was haben Sie?' })).toBeInTheDocument();
  });

  it('Wiedereinstieg: eine Anlage ohne Box setzt bei der Box fort, eine mit Box bei „Anlage“', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(emptyEntities);
    const devices = vi.spyOn(api, 'listDevices').mockResolvedValue({ eintraege: [], teilansicht: null } as never);
    const { unmount } = render(<AnlageFlow sites={[site]} wirt="assistent" onDone={() => {}} />);
    expect(screen.getByText('Der nächste Schritt wird vorbereitet …')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeInTheDocument();
    unmount();
    // Ein neuer Tab ohne Entwurf (F9) - sonst ginge es am Schritt des Entwurfs weiter.
    sessionStorage.clear();
    devices.mockResolvedValue({ eintraege: [device], teilansicht: null } as never);
    render(<AnlageFlow sites={[site]} wirt="assistent" onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: /^Ihre Box meldet gerade ihre Geräte/ })).toBeInTheDocument();
  });

  it('maps the 422 claim refusal to the shared unknown-ID message', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'claimDevice').mockRejectedValue(new ApiError(422, 'unknown'));
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    await bisSchritt3('verbinden');
    expect(await screen.findByText(/Diese Kennung kennen wir nicht/)).toBeInTheDocument();
    expect(screen.getByLabelText('Kennung')).toHaveFocus();
  });

  // B4 (Anlage-Flow a1): ein Tippfehler in der Kennung wird nie gesendet - früher legte der
  // Server „edge-k7m2xq1" („1" statt „l") als Gerät an, das sich nie meldete.
  it('sends no Kennung with a typo - the field says why, nothing is claimed', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(emptyEntities);
    const claim = vi.spyOn(api, 'claimDevice');
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);

    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const feld = await screen.findByLabelText('Kennung');
    fireEvent.change(feld, { target: { value: 'edge-k7m2xq1' } });
    expect(screen.getByText('Diese Kennung stimmt nicht. Eine Kennung enthält kein 0, 1, i, l oder o.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
    fireEvent.change(feld, { target: { value: 'edge-k7m2xqz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
    expect(screen.getByText(/^Diese Kennung stimmt nicht\. Bitte vergleichen/)).toBeInTheDocument();
    expect(claim).not.toHaveBeenCalled();

    // Ohne „edge-“ getippt: das Feld ergänzt ihn, gesendet wird die Kennung.
    claim.mockResolvedValue({ id: 'd1', siteId: site.id, externalRef: 'edge-k7m2xq3' } as never);
    fireEvent.change(feld, { target: { value: 'K7M2XQ3' } });
    expect(screen.getByText('Kennung stimmt: edge-k7m2xq3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
    await waitFor(() => expect(claim).toHaveBeenCalledWith(site.id, 'edge-k7m2xq3', expect.any(String)));
  });

  it('offers a "gleicher Standort wie …" reuse chip for an existing placed Anlage', async () => {
    const placed: Site = { ...site, id: 's-9', name: 'Ferienhaus', latitude: 52.5, longitude: 13.4 };
    render(<AnlageFlow sites={[]} existingSites={[placed]} wirt="dialog" onDone={() => {}} />);
    expect(await screen.findByText('Gleicher Standort wie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ferienhaus/ })).toBeInTheDocument();
  });

  // E2/D3: das Preisblatt wird erst zur Wahrheit, wenn der Betreiber „Genau"
  // WÄHLT - die Vorschlagswerte bleiben sonst ein Prefill.
  it('legt ohne die Wahl „Genau" kein Preisblatt an', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const updateSupply = vi.spyOn(api, 'updateSupplyPrice').mockResolvedValue(null as never);
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(await screen.findByText(/Feineinstellungen/));
    expect(screen.getByRole('radio', { name: /Schnell/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(updateSupply).not.toHaveBeenCalled();
  });

  it('legt das Preisblatt an, sobald „Genau" gewählt ist', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const updateSupply = vi.spyOn(api, 'updateSupplyPrice').mockResolvedValue(null as never);
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(await screen.findByText(/Feineinstellungen/));
    fireEvent.click(screen.getByRole('radio', { name: /Genau/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(updateSupply).toHaveBeenCalled());
    expect(updateSupply).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ netzentgeltArbeitspreisCt: 7.6, vertriebsaufschlagCt: 1.5 }),
    );
  });

  it('speaks "Anlage", never "Standort", as the entity name (wording decision 3)', async () => {
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    expect(await screen.findByLabelText('Name der neuen Anlage')).toBeInTheDocument();
    expect(screen.queryByText(/Name des Standorts/)).not.toBeInTheDocument();
  });
});

describe('F9: der Entwurf je Schritt (Anlage-Flow a1, Paket 3)', () => {
  it('Neuladen mitten in Schritt 1: die Eingaben stehen wieder da - mit dem Satz, dass sie wiederhergestellt sind', async () => {
    const erst = render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Garage' } });
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: 'Marktplatz 2 Pappenheim' } });
    erst.unmount();

    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    expect(await screen.findByText('Ihre Eingaben sind wiederhergestellt.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name der neuen Anlage')).toHaveValue('Garage');
    expect(screen.getByLabelText('Adresse')).toHaveValue('Marktplatz 2 Pappenheim');
  });

  it('Anmeldung in Schritt 3: zurück am selben Schritt der angelegten Anlage, mit den getippten Zahlen', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const erst = render(<AnlageFlow sites={[]} wirt="assistent" onDone={() => {}} />);
    await bisSchritt3('spaeter');
    fireEvent.change(await screen.findByLabelText('Leistung der Solarmodule (kWp)'), { target: { value: '6,05' } });
    erst.unmount();

    // Nach der Anmeldung lädt die Seite neu - die Anlage steht jetzt in der Liste.
    render(<AnlageFlow sites={[site]} wirt="assistent" onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Was haben Sie?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Leistung der Solarmodule (kWp)')).toHaveValue('6,05');
    expect(createSite).toHaveBeenCalledTimes(1);
  });

  it('kein Geisterzustand: ein anderer Wirt, eine verschwundene Anlage oder „Später einrichten“ - der Entwurf gilt nicht', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const erst = render(<AnlageFlow sites={[]} wirt="assistent" onDone={() => {}} />);
    await bisSchritt3('spaeter');
    await screen.findByRole('heading', { name: 'Was haben Sie?' });
    erst.unmount();

    // Der Dialog nimmt den Entwurf des Assistenten nicht.
    const dialog = render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    expect(await screen.findByLabelText('Name der neuen Anlage')).toBeInTheDocument();
    expect(screen.queryByText('Ihre Eingaben sind wiederhergestellt.')).toBeNull();
    dialog.unmount();

    // Die Anlage gibt es nicht mehr: der Entwurf gilt nicht, der Assistent beginnt vorn.
    vi.spyOn(api, 'standorte').mockRejectedValue(new Error('offline'));
    const weg = render(<AnlageFlow sites={[]} wirt="assistent" onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: /Wo steht/ })).toBeInTheDocument();
    expect(screen.queryByText('Ihre Eingaben sind wiederhergestellt.')).toBeNull();
    weg.unmount();

    // „Später einrichten“ räumt ab.
    const onSkip = vi.fn();
    render(<AnlageFlow sites={[site]} wirt="assistent" onDone={() => {}} onSkipAll={onSkip} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Später einrichten - direkt zum Portal' }));
    expect(onSkip).toHaveBeenCalled();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});
