import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import {
  api,
  ApiError,
  type Device,
  type MastrPreview,
  type Site,
  type SiteAsset,
  type SiteEntities,
} from '../api';
import type { SiteProfile } from '../profiles';
import { anwendungLabel } from '../anwendungen';

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

/**
 * Eine Regal-Karte, wie der Server sie liefert (Anwendungs-Programm Stufe 2).
 * `requirements` entscheidet, ob die Preset-Vorauswahl sie wirklich anhakt.
 */
function karte(id: string, over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    id,
    // Der Server schickt das Label aus DERSELBEN Katalog-Datei - eine
    // erfundene Beschriftung würde etwas prüfen, das es nie gibt.
    label: anwendungLabel(id),
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

/** Die Abrufe, die der Anwendungen-Schritt beim Mounten macht (Kundenpfad). */
function mockAdaptiveReads(profiles: SiteProfile[] = []) {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(emptyEntities);
  vi.spyOn(api, 'siteProfiles').mockResolvedValue({ profiles });
}

/** Pass the adaptive Anwendungen step without changing anything. */
async function skipNutzung() {
  fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später festlegen' }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AnlageFlow - the register-first "Anlage anlegen" flow (captain 2026-07-09)', () => {
  it('walks Anlage -> Register (PV + linked Speicher) -> Gerät -> Anwendungen and finishes on the summary', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const mastrLookup = vi
      .spyOn(api, 'mastrLookup')
      .mockImplementation(async (_siteId: string, nummer: string) =>
        nummer === 'SEE900000012345' ? pvPreview() : storagePreview(),
      );
    const mastrApply = vi.spyOn(api, 'mastrApply').mockResolvedValue([]);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    const claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(device);
    mockAdaptiveReads();
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
    await waitFor(() => expect(mastrLookup).toHaveBeenCalledTimes(2));

    expect(await screen.findByText('Im Register gefunden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen & weiter' }));
    await waitFor(() => expect(mastrApply).toHaveBeenCalled());
    const applied = mastrApply.mock.calls[0][1];
    expect(applied.pv?.mastrNummer).toBe('SEE900000012345');
    expect(applied.storage?.mastrNummer).toBe('SEE900000067890');

    // Step 3: Gerät (AE5: the device now comes BEFORE the adaptive step).
    expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    await waitFor(() => expect(claimDevice).toHaveBeenCalledWith('s-1', 'VP-DEMO-0001'));

    // Schritt 4: Anwendungen - Geräte + Profil-Preset + Regal + Speicher.
    expect(await screen.findByText('Wofür ist diese Anlage?')).toBeInTheDocument();
    // Stufe 2: die Preset-Karten stehen statt des früheren AE7-Vorwahl-Blocks.
    expect(screen.getByRole('heading', { name: 'Profil' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Privat/ })).toBeInTheDocument();
    await skipNutzung();

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
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    mockAdaptiveReads();
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
    expect(mastrLookup).not.toHaveBeenCalled();

    // Step 3 (Gerät) then step 4 (Nutzung) - skip both, honest summary.
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    await skipNutzung();
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(screen.getByText('manuell hinterlegt')).toBeInTheDocument();
    expect(screen.getByText('später verbinden')).toBeInTheDocument();
  });

  it('keeps every step past the first skippable and dead-end-free', async () => {
    vi.spyOn(api, 'createSite').mockResolvedValue(site);
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    mockAdaptiveReads();
    const claimDevice = vi.spyOn(api, 'claimDevice');
    const mastrApply = vi.spyOn(api, 'mastrApply');
    const onDone = vi.fn();

    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Skip the Register step, the Gerät step, then the Nutzung step.
    fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später nachtragen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    await skipNutzung();

    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(claimDevice).not.toHaveBeenCalled();
    expect(mastrApply).not.toHaveBeenCalled();
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
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'claimDevice').mockRejectedValue(new ApiError(422, 'unknown'));
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    // Register skipped -> the Gerät step is now next (before Nutzung).
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

  // E2/D3: das Preisblatt wird erst zur Wahrheit, wenn der Betreiber „Genau"
  // WÄHLT - die Vorschlagswerte bleiben sonst ein Prefill (frühere Fassung:
  // ein stilles „berührt"-Flag).
  it('legt ohne die Wahl „Genau" kein Preisblatt an', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const updateSupply = vi.spyOn(api, 'updateSupplyPrice').mockResolvedValue(null as never);
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByText(/Feineinstellungen/));
    // Der Tarif steht auf „Ohne Angabe", die Wahl auf „Schnell" - beides unberührt.
    expect(screen.getByRole('radio', { name: /Schnell/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(updateSupply).not.toHaveBeenCalled();
    createSite.mockRestore();
    updateSupply.mockRestore();
  });

  it('legt das Preisblatt an, sobald „Genau" gewählt ist', async () => {
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(site);
    const updateSupply = vi.spyOn(api, 'updateSupplyPrice').mockResolvedValue(null as never);
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
    fireEvent.click(screen.getByText(/Feineinstellungen/));
    fireEvent.click(screen.getByRole('radio', { name: /Genau/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(updateSupply).toHaveBeenCalled());
    expect(updateSupply).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ netzentgeltArbeitspreisCt: 7.6, vertriebsaufschlagCt: 1.5 }),
    );
    createSite.mockRestore();
    updateSupply.mockRestore();
  });

  it('speaks "Anlage", never "Standort", as the entity name (wording decision 3)', () => {
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    expect(screen.getByLabelText('Name der Anlage')).toBeInTheDocument();
    expect(screen.queryByText(/Name des Standorts/)).not.toBeInTheDocument();
  });
});

describe('Schritt Betrieb - Preset + EIN Betriebsmodell (Steuerung Stufe 0)', () => {
  /** Bis zum vierten Schritt durchklicken (Register + Gerät überspringen). */
  async function bisZumSchritt() {
    fireEvent.click(await screen.findByRole('button', { name: 'Überspringen - später nachtragen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät habe ich noch nicht - später' }));
    expect(await screen.findByText('Wofür ist diese Anlage?')).toBeInTheDocument();
  }

  it('Privat schlägt KEIN Betriebsmodell vor - und schaltet nichts', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    // Der Befund der Stufe 0 an dieser Stelle: der Assistent wiederholte das
    // neunzeilige Regal und setzte für einen Haushalt zwei Absichts-Schalter,
    // die nichts auslösten. Jetzt fährt sein Speicher den Eigenverbrauchs-
    // Fahrplan, und das steht als Satz da - nicht als Schalter.
    mockAdaptiveReads([
      karte('monitoring', { active: true }),
      karte('ueberschuss', {
        requirements: [
          { label: 'PV-Erzeugung', met: true },
          { label: 'Steuerbares Gerät', met: true },
        ],
      }),
      karte('verbraucher', { requirements: [{ label: 'Steuerbares Gerät', met: true }] }),
      karte('marktvermarktung', { requirements: [{ label: 'Marktzugang', met: true }] }),
    ]);
    const preset = vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(site);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(await screen.findByRole('radio', { name: /Privat/ }));
    expect(await screen.findByText(/Eigenverbrauchs-Fahrplan/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Überschuss nutzen/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Verbraucher steuern/ })).toBeNull();
    // Der Satz, der den Schritt schliesst: Regeln entstehen später.
    expect(screen.getByText(/Regeln legen Sie später in der Steuerung an/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(preset).toHaveBeenCalledWith('s-1', 'privat'));
    expect(toggle).not.toHaveBeenCalled();
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
  });

  it('Gewerbe schlägt GENAU EINES vor und schaltet genau dieses ein', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    // Beide könnten laufen - vorgeschlagen wird das Startmodell des Profils.
    mockAdaptiveReads([
      karte('marktvermarktung', { requirements: [{ label: 'Marktzugang', met: true }] }),
      karte('lastspitzenkappung', {
        requirements: [{ label: 'Leistungspreis hinterlegt', met: true }],
      }),
    ]);
    const preset = vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(site);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(await screen.findByRole('radio', { name: /Gewerbe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => expect(preset).toHaveBeenCalledWith('s-1', 'gewerbe'));
    await waitFor(() =>
      expect(toggle.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        ['lastspitzenkappung', 'an'],
      ]),
    );
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(screen.getByText(/Eingeschaltet: Lastspitzenkappung\./)).toBeInTheDocument();
  });

  it('ohne Leistungspreis springt die Marktoptimierung ein - nie beide', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    mockAdaptiveReads([
      karte('marktvermarktung', { requirements: [{ label: 'Marktzugang', met: true }] }),
      karte('lastspitzenkappung', {
        requirements: [{ label: 'Leistungspreis hinterlegt', met: false }],
      }),
    ]);
    vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(site);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(await screen.findByRole('radio', { name: /Gewerbe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() =>
      expect(toggle.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        ['marktvermarktung', 'an'],
      ]),
    );
  });

  it('kann keins laufen, wird das GEMEINTE genannt und nichts geschaltet', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    mockAdaptiveReads([
      karte('marktvermarktung', { requirements: [{ label: 'Marktzugang', met: false }] }),
      karte('lastspitzenkappung', {
        requirements: [{ label: 'Leistungspreis hinterlegt', met: false }],
      }),
    ]);
    const preset = vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(site);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(await screen.findByRole('radio', { name: /Gewerbe/ }));
    expect(
      await screen.findByText(
        /Lastspitzenkappung schlagen wir noch nicht vor: Leistungspreis hinterlegt fehlt\./,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(preset).toHaveBeenCalledWith('s-1', 'gewerbe'));
    expect(toggle).not.toHaveBeenCalled();
  });

  it('schaltet eine schon LAUFENDE Anwendung nie ab und zeigt sie immer', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    // Ein Ladepark auf einer Privat-Anlage: abgeleitet aktiv, vom Privat-Preset
    // „verborgen" - er darf weder eingeklappt noch abgeschaltet werden.
    mockAdaptiveReads([
      karte('lastmanagement', { derivedActive: true, active: true }),
      karte('ueberschuss', { requirements: [{ label: 'PV-Erzeugung', met: false }] }),
    ]);
    vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue(site);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(await screen.findByRole('radio', { name: /Privat/ }));
    expect(
      screen.getByRole('switch', { name: /Ladepark-Lastmanagement ausschalten/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.getByText(/„Zuhause“ ist da/)).toBeInTheDocument());
    // Kein `aus` auf etwas, das läuft - und kein `an` auf etwas, das schon an ist.
    expect(toggle).not.toHaveBeenCalled();
  });

  it('eine BASIS-Anwendung erscheint gar nicht mehr - auch nicht als immer-an-Zeile', async () => {
    // Stufe 0: die ruhige Zeile ist mit dem Regal aus dem Assistenten
    // verschwunden. Was ohnehin läuft, braucht keine Zeile in einem Schritt,
    // der nach der BETRIEBSWEISE fragt.
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    mockAdaptiveReads([karte('monitoring', { derivedActive: true, active: true })]);
    const toggle = vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    expect(screen.queryByText('immer an')).toBeNull();
    expect(screen.getByText(/Eigenverbrauchs-Fahrplan/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Anlage beobachten/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(screen.getByText(/„Zuhause“ ist da/)).toBeInTheDocument());
    expect(toggle).not.toHaveBeenCalled();
  });

  it('saves a changed Speicherschonung preset carrying the battery master data through', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    mockAdaptiveReads();
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    // The battery exists, so the Umgang choice is offered; pick Schonend.
    fireEvent.click(await screen.findByRole('radio', { name: /Schonend/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() =>
      expect(saveBattery).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({
          capacityKwh: 10,
          maxChargeKw: 5,
          maxDischargeKw: 5,
          speicherschonung: 'schonend',
        }),
      ),
    );
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
  });

  it('writes nothing when untouched', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    mockAdaptiveReads([karte('marktvermarktung')]);
    const saveBattery = vi.spyOn(api, 'saveBattery');
    const preset = vi.spyOn(api, 'setAnwendungsPreset');
    const toggle = vi.spyOn(api, 'setSiteProfile');
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(saveBattery).not.toHaveBeenCalled();
    expect(preset).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('hides the Umgang choice when the Anlage has no battery', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    mockAdaptiveReads();
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();
    expect(screen.queryByText('Umgang mit dem Speicher')).not.toBeInTheDocument();
  });

  it('bleibt ohne Regal-Antwort bedienbar (älteres Backend / Ladefehler)', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(emptyEntities);
    vi.spyOn(api, 'siteProfiles').mockRejectedValue(new Error('down'));
    const toggle = vi.spyOn(api, 'setSiteProfile');
    render(<AnlageFlow sites={[site]} waitForFirstData={false} onDone={() => {}} />);
    await bisZumSchritt();

    // Kein Regal, aber die Profil-Wahl und der Weg nach vorn stehen.
    expect(screen.getByRole('radio', { name: /Privat/ })).toBeInTheDocument();
    expect(screen.queryByText('Ihre Anwendungen')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/„Zuhause“ ist da/)).toBeInTheDocument();
    expect(toggle).not.toHaveBeenCalled();
  });
});
