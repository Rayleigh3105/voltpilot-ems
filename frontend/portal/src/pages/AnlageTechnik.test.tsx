import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BatteryControlSection, StammdatenEditForm, TechnikSection } from './AnlageTechnik';
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

// ---------------------------------------------------------------------------
// E1 · „Gruppe B bekommt ihren Ort" — die Geld-/Verhaltens-Einstellungen sind
// auf JEDER Anlage erreichbar, unabhängig von Anlagentyp und aktivem Modus.
// ---------------------------------------------------------------------------

/** Rendert die ganze Einstellungs-Seite einer gewöhnlichen PV+Speicher-Anlage. */
async function renderEinstellungen(over: Partial<Site> = {}, batteryOver: Partial<SiteAsset> = {}) {
  const s: Site = { ...eegSite, ...over };
  const assets = vi
    .spyOn(api, 'siteAssets')
    .mockResolvedValue([battery({ deviceId: 'd-1', ...batteryOver })]);
  const preview = vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a'));
  const supply = vi.spyOn(api, 'supplyPrice').mockResolvedValue(null as never);
  const onSiteSaved = vi.fn();
  render(
    <TechnikSection
      site={s}
      devices={[device({ id: 'd-1' })]}
      sites={[s]}
      onReload={() => {}}
      onSiteSaved={onSiteSaved}
      onSiteDeleted={() => {}}
    />,
  );
  // Auf den Asset-Abruf warten, sonst steht die Speicher-Karte noch im Skeleton.
  await screen.findByText('Kapazität');
  return { onSiteSaved, restore: () => [assets, preview, supply].forEach((m) => m.mockRestore()) };
}

describe('Einstellungen · Strompreis & Vergütung (E1)', () => {
  it('DER Befund, geschlossen: eine Eigenverbrauchs-Anlage ohne aktiven Modus erreicht alle Werte', async () => {
    // Genau die Anlage aus dem Konzept §3: `plantKind: eigenverbrauch`, kein
    // Modus aktiv. Vor E1 war hier KEINER dieser Werte erreichbar.
    const { restore } = await renderEinstellungen();

    // Die Gruppe steht als eigener Abschnitt (Sprungmarke + Sprung-Navigation).
    const geld = document.getElementById('technik-geld');
    expect(geld).not.toBeNull();
    expect(within(geld as HTMLElement).getByText('Strompreis & Vergütung')).toBeInTheDocument();
    for (const label of ['Stromtarif', 'Netzladen des Speichers', 'Umgang mit dem Speicher']) {
      const row = screen.getByText(label).closest('li') as HTMLElement;
      expect(within(row).getByRole('button', { name: /Bearbeiten/ })).toBeInTheDocument();
    }
    // Die Sichtbarkeitsregel bleibt: der anzulegende Wert ist ein DV-Fakt.
    expect(screen.queryByText('Anzulegender Wert')).toBeNull();
    restore();
  });

  it('zeigt den anzulegenden Wert auf einer Direktvermarktungs-Anlage', async () => {
    const { restore } = await renderEinstellungen({
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
    });
    const row = screen.getByText('Anzulegender Wert').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: /Bearbeiten/ })).toBeInTheDocument();
    restore();
  });

  it('speichert den Stromtarif als VOLL-Repräsentation (blankt kein Nachbarfeld)', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    const { onSiteSaved, restore } = await renderEinstellungen({ maxFeedInKw: 75 });

    const row = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    fireEvent.change(screen.getByLabelText('Stromtarif'), { target: { value: 'fest' } });
    fireEvent.change(screen.getByLabelText('Ihr Strompreis (ct/kWh)'), { target: { value: '32,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    // Die Regressionsfalle, die mit den Formularen umgezogen ist: Name, Zone,
    // Koordinaten und die maximale Einspeiseleistung reisen unverändert mit.
    expect(updateSite).toHaveBeenCalledWith('s-1', {
      name: 'Hof Sonnenfeld',
      biddingZone: 'DE-LU',
      latitude: null,
      longitude: null,
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'fest',
      tarifParamCtKwh: 32.5,
      netzladenErlaubt: false,
      maxFeedInKw: 75,
    });
    updateSite.mockRestore();
    restore();
  });

  it('speichert den Umgang mit dem Speicher über die volle Speicher-Repräsentation', async () => {
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    const { restore } = await renderEinstellungen();

    const row = screen.getByText('Umgang mit dem Speicher').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Schonend/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(saveBattery).toHaveBeenCalled());
    expect(saveBattery).toHaveBeenCalledWith('s-1', {
      capacityKwh: 10,
      maxChargeKw: 5,
      maxDischargeKw: 5,
      roundtripEfficiencyPct: null,
      deviceId: 'd-1',
      speicherschonung: 'schonend',
    });
    saveBattery.mockRestore();
    restore();
  });

  it('der Deep-Link aus dem Modus-Container landet auf der Gruppe (kein toter Link)', async () => {
    window.location.hash = '#/anlage/s-1/technik?abschnitt=geld';
    const scrollIntoView = vi.fn();
    // jsdom kennt scrollIntoView nicht - der Aufruf IST hier die Zusicherung.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    const { restore } = await renderEinstellungen();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // Die angesprungene Gruppe existiert wirklich unter dieser Adresse.
    expect(document.getElementById('technik-geld')).not.toBeNull();
    window.location.hash = '';
    restore();
  });
});
