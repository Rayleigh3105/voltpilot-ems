import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { initInstallApp, resetInstallApp, type InstallEnv } from '../installApp';
import { BatteryControlSection, StammdatenEditForm, TechnikSection } from './AnlageTechnik';
import { api, type Device, type Site, type SiteAsset, type SupplyPrice } from '../api';

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
    // Seit dem Picker-System ist die Geräte-Wahl der Haus-Picker.
    fireEvent.click(screen.getByRole('combobox', { name: 'Steuerndes Gerät' }));
    fireEvent.click(screen.getByRole('option', { name: 'WR Süd' }));
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

/**
 * Ein Fahrplan-Lauf, der die laufende Viertelstunde abdeckt — die Quelle der
 * E5-Bezugspreis-Vorschau. `null` = die Anlage hat (noch) keinen Plan.
 */
function planWithPrice(over: Partial<Record<string, unknown>> = {}) {
  const start = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  return {
    planId: 'p-1',
    deviceId: 'd-1',
    generatedAt: start,
    slotMinutes: 15,
    savingsEur: null,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    slots: [
      {
        start,
        batteryKw: null,
        gridKw: null,
        socPct: null,
        priceEurMwh: 124,
        costEur: null,
        baselineCostEur: null,
        curtailKw: null,
        pvKw: null,
        loadKw: null,
        slotRole: null,
        slotFlags: null,
        importPriceCtKwh: 32.5,
        importPriceSource: 'preisblatt',
        ...over,
      },
    ],
  } as never;
}

/** Rendert die ganze Einstellungs-Seite einer gewöhnlichen PV+Speicher-Anlage. */
async function renderEinstellungen(
  over: Partial<Site> = {},
  batteryOver: Partial<SiteAsset> = {},
  supplySheet: SupplyPrice | null = null,
  plan: unknown = null,
) {
  const s: Site = { ...eegSite, ...over };
  const assets = vi
    .spyOn(api, 'siteAssets')
    .mockResolvedValue([battery({ deviceId: 'd-1', ...batteryOver })]);
  const preview = vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a'));
  const supply = vi.spyOn(api, 'supplyPrice').mockResolvedValue(supplySheet as never);
  // Die E5-Vorschau liest den Fahrplan; ohne Lauf sagt sie das ehrlich.
  const schedule =
    plan == null
      ? vi.spyOn(api, 'schedule').mockRejectedValue(new Error('kein Plan'))
      : vi.spyOn(api, 'schedule').mockResolvedValue(plan as never);
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
  return {
    onSiteSaved,
    restore: () => [assets, preview, supply, schedule].forEach((m) => m.mockRestore()),
  };
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
    // Seit dem Picker-System ist die Tarifart der Haus-Picker, kein `select`.
    fireEvent.click(screen.getByRole('combobox', { name: 'Stromtarif' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fest (ct/kWh)' }));
    fireEvent.change(screen.getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)'), { target: { value: '32,5' } });
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

  // -------------------------------------------------------------------------
  // E2 · „Bedeutungsfalle" — auf der echten Einstellungs-Seite
  // -------------------------------------------------------------------------

  it('E2: der Tarifart-Wechsel deutet die Zahl nie um - und speichert die richtige', async () => {
    // Wunde 1 live: eine Anlage mit dynamischem Tarif und 18 ct Aufschlag.
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    const { onSiteSaved, restore } = await renderEinstellungen({
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
    });

    const row = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    expect(screen.getByLabelText('Aufschlag auf den Börsenpreis (gesamt, ct/kWh)')).toHaveValue('18');

    // Seit dem Picker-System ist die Tarifart der Haus-Picker, kein `select`.
    fireEvent.click(screen.getByRole('combobox', { name: 'Stromtarif' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fest (ct/kWh)' }));
    // Vor E2 stand hier „18" unter dem Namen des Arbeitspreises - der Bezugspreis,
    // mit dem der Optimierer PLANT, wäre damit still verstellt worden.
    expect(screen.getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)')).toHaveValue('');
    expect(screen.getByRole('status').textContent).toContain('Andere Bedeutung');

    fireEvent.change(screen.getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)'), {
      target: { value: '32,5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ tarifArt: 'fest', tarifParamCtKwh: 32.5 }),
    );
    updateSite.mockRestore();
    restore();
  });

  it('E2/D3: „Schnell" statt „Genau" ENTFERNT das Preisblatt - angekündigt, dann getan', async () => {
    // Eine Anlage MIT gepflegtem Preisblatt: der Server rechnet damit und
    // ignoriert den Aufschlag. Wer auf „Schnell" wechselt, muss es also
    // wirklich loswerden, sonst behauptet die Oberfläche etwas Falsches.
    const maintained: SupplyPrice = {
      present: true,
      hasComponents: true,
      netzentgeltArbeitspreisCt: 7.6,
      stromsteuerCt: 2.05,
      konzessionsabgabeCt: 1.59,
      umlagenCt: 2.946,
      vertriebsaufschlagCt: 1.5,
      ustPct: 19,
      komponentenStand: null,
      updatedAt: null,
    };
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const updateSupply = vi
      .spyOn(api, 'updateSupplyPrice')
      .mockResolvedValue({ ...maintained, hasComponents: false } as never);
    const { onSiteSaved, restore } = await renderEinstellungen(
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      {},
      maintained,
    );

    const row = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    // Gespeichert ist „Genau": das Preisblatt steht offen, die Schnell-Zahl nicht.
    await screen.findByText('Bezugspreis-Komponenten');
    expect(screen.queryByLabelText('Aufschlag auf den Börsenpreis (gesamt, ct/kWh)')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Schnell/ }));
    // Erst die Ansage …
    expect(screen.getByText(/Bezugspreis-Komponenten entfernt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    // … dann die Tat: jede Komponente geleert, der USt-Satz unangetastet.
    expect(updateSupply).toHaveBeenCalledWith('s-1', {
      komponentenStand: null,
      netzentgeltArbeitspreisCt: null,
      stromsteuerCt: null,
      konzessionsabgabeCt: null,
      umlagenCt: null,
      vertriebsaufschlagCt: null,
    });
    updateSite.mockRestore();
    updateSupply.mockRestore();
    restore();
  });

  it('E2/D3: ohne Wechsel bleibt „Genau" gepflegt - nichts wird still entwertet', async () => {
    const maintained: SupplyPrice = {
      present: true,
      hasComponents: true,
      netzentgeltArbeitspreisCt: 7.6,
      stromsteuerCt: 2.05,
      konzessionsabgabeCt: 1.59,
      umlagenCt: 2.946,
      vertriebsaufschlagCt: 1.5,
      ustPct: 19,
      komponentenStand: null,
      updatedAt: null,
    };
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const updateSupply = vi
      .spyOn(api, 'updateSupplyPrice')
      .mockResolvedValue(maintained as never);
    const { onSiteSaved, restore } = await renderEinstellungen(
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      {},
      maintained,
    );

    const row = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Bearbeiten/ }));
    await screen.findByText('Bezugspreis-Komponenten');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSupply).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ netzentgeltArbeitspreisCt: 7.6, vertriebsaufschlagCt: 1.5 }),
    );
    updateSite.mockRestore();
    updateSupply.mockRestore();
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

// ---------------------------------------------------------------------------
// E4-E7 · Autoritäts-Stufen · Wirkung & Vorschau · Suche & Wording · Box
// ---------------------------------------------------------------------------

/** Eine Anlage MIT eingerichteter Lastspitzenkappung (die Stufe-②-Werte). */
const peakSite: Partial<Site> = {
  leistungspreisEurKw: 128.5,
  abrechnungLeistung: 'jahr',
  peakReserveSocPct: 25,
};

describe('Einstellungen · Profil ändern (Anwendungs-Programm Stufe 2)', () => {
  it('sagt ehrlich, wenn noch keins gewählt ist', async () => {
    const { restore } = await renderEinstellungen();
    const zeile = screen.getByText('Profil').closest('.vp-kv-row') as HTMLElement;
    expect(within(zeile).getByText('noch nicht festgelegt')).toBeInTheDocument();
    restore();
  });

  it('schreibt das Profil über die SCHMALE Route - und nennt vorher die Folgen', async () => {
    const preset = vi
      .spyOn(api, 'setAnwendungsPreset')
      .mockResolvedValue({ ...eegSite, profil: 'gewerbe' });
    const updateSite = vi.spyOn(api, 'updateSite');
    const { onSiteSaved, restore } = await renderEinstellungen({ profil: 'privat' });

    const zeile = screen.getByText('Profil').closest('.vp-kv-row') as HTMLElement;
    expect(within(zeile).getByText('Privat')).toBeInTheDocument();
    fireEvent.click(within(zeile).getByRole('button', { name: 'Ändern' }));

    // Die Folgenliste steht VOR dem Klick - und sie sagt, was GLEICH bleibt.
    expect(
      screen.getByText(/Ihre eingeschalteten Betriebsmodelle bleiben unverändert/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: 'Profil' }));
    fireEvent.click(await screen.findByRole('option', { name: /Gewerbe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Profil speichern' }));

    await waitFor(() => expect(preset).toHaveBeenCalledWith('s-1', 'gewerbe'));
    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    // Ein voll-repräsentatives updateSite für EIN Feld wäre ein
    // Überschreib-Risiko für alles andere in diesem Kasten.
    expect(updateSite).not.toHaveBeenCalled();
    preset.mockRestore();
    updateSite.mockRestore();
    restore();
  });

  it('Abbrechen ändert nichts', async () => {
    const preset = vi.spyOn(api, 'setAnwendungsPreset');
    const { restore } = await renderEinstellungen({ profil: 'privat' });
    const zeile = screen.getByText('Profil').closest('.vp-kv-row') as HTMLElement;
    fireEvent.click(within(zeile).getByRole('button', { name: 'Ändern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(preset).not.toHaveBeenCalled();
    preset.mockRestore();
    restore();
  });
});

describe('Einstellungen · E4 · die drei Autoritäts-Stufen sind sichtbar', () => {
  it('jede Kunden-Zeile trägt das Abzeichen ① und ihren Bearbeiten-Knopf', async () => {
    const { restore } = await renderEinstellungen();
    for (const label of ['Stromtarif', 'Netzladen des Speichers', 'Umgang mit dem Speicher']) {
      const row = screen.getByText(label).closest('li') as HTMLElement;
      expect(row.querySelector('.vp-authority-1')).not.toBeNull();
      expect(within(row).getByRole('button', { name: /Bearbeiten/ })).toBeInTheDocument();
    }
    restore();
  });

  it('D4: die Vertragswerte der Lastspitzenkappung sind für den KUNDEN sichtbar - read-only', async () => {
    // Befund B4: bis E4 existierten diese Werte im Kunden-UI gar nicht. Jetzt
    // stehen sie mit Abzeichen ② da - mit ihrem Wert, ohne Aktionsknopf.
    const { restore } = await renderEinstellungen(peakSite);

    const lp = screen.getByText('Leistungspreis').closest('li') as HTMLElement;
    expect(within(lp).getByText(/128,50/)).toBeInTheDocument();
    expect(lp.querySelector('.vp-authority-2')).not.toBeNull();
    expect(within(lp).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
    expect(within(lp).getByText(/Sprechen Sie uns an/)).toBeInTheDocument();

    // Die Abrechnungsperiode steht daneben, die Reserve beim Speicher.
    expect(screen.getByText('Abrechnungsperiode')).toBeInTheDocument();
    const reserve = screen.getByText('Lastspitzen-Reserve').closest('li') as HTMLElement;
    expect(document.getElementById('technik-speicher')?.contains(reserve)).toBe(true);
    expect(within(reserve).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();

    // Editierbar bleiben sie ausschließlich auf der Plattform-Seite „Optimizer"
    // (Admin) - diese Fläche bietet dafür nirgends ein Formular an.
    restore();
  });

  it('erfindet auf einer Hausanlage ohne Lastspitzenkappung keine ②-Zeile', async () => {
    const { restore } = await renderEinstellungen();
    expect(screen.queryByText('Leistungspreis')).toBeNull();
    expect(screen.queryByText('Lastspitzen-Reserve')).toBeNull();
    expect(document.querySelector('.vp-authority-2')).toBeNull();
    restore();
  });

  it('③ zieht als Schutz-Streifen mit um - und behauptet „nur Solarladen" nur, wenn es gilt', async () => {
    const { restore } = await renderEinstellungen();
    const streifen = document.querySelector('.vp-set-schutz') as HTMLElement;
    expect(streifen).not.toBeNull();
    expect(within(streifen).getByText('§ 14a-Schutz')).toBeInTheDocument();
    expect(within(streifen).getByText('Negativpreis-Abregelung')).toBeInTheDocument();
    // netzladenErlaubt === false auf der Fixture-Anlage -> die Zeile gilt.
    expect(within(streifen).getByText('EEG: nur Solarladen')).toBeInTheDocument();
    restore();
  });

  it('… und lässt „nur Solarladen" weg, sobald das Netzladen erlaubt ist', async () => {
    const { restore } = await renderEinstellungen({ netzladenErlaubt: true });
    const streifen = document.querySelector('.vp-set-schutz') as HTMLElement;
    expect(within(streifen).getByText('§ 14a-Schutz')).toBeInTheDocument();
    expect(within(streifen).queryByText('EEG: nur Solarladen')).toBeNull();
    restore();
  });

  it('die Legende erklärt alle drei Stufen', async () => {
    const { restore } = await renderEinstellungen();
    const legende = document.querySelector('.vp-set-legend') as HTMLElement;
    expect(within(legende).getByText('Sie stellen ein')).toBeInTheDocument();
    expect(within(legende).getByText('Von VoltPilot eingerichtet')).toBeInTheDocument();
    expect(within(legende).getByText('Läuft automatisch')).toBeInTheDocument();
    restore();
  });
});

describe('Einstellungen · E5 · Wirkung & Vorschau', () => {
  it('jede Zeile sagt, worauf sie wirkt und welche Art Zahl sie ändert', async () => {
    const { restore } = await renderEinstellungen();
    const tarif = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    expect(within(tarif).getByText('Wirkt auf: Fahrplan')).toBeInTheDocument();
    expect(within(tarif).getByText('Wirkt auf: Erlöse')).toBeInTheDocument();
    expect(within(tarif).getByText('Bewertet')).toBeInTheDocument();

    const netzladen = screen.getByText('Netzladen des Speichers').closest('li') as HTMLElement;
    expect(within(netzladen).getByText('Wirkt auf: Ihr Speicher')).toBeInTheDocument();
    expect(within(netzladen).getByText('Geplant')).toBeInTheDocument();
    expect(within(netzladen).queryByText('Wirkt auf: Erlöse')).toBeNull();
    restore();
  });

  it('zeigt den LEBENDEN Bezugspreis aus dem Fahrplan - dieselbe eine Preis-Wahrheit', async () => {
    const { restore } = await renderEinstellungen(
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      {},
      null,
      planWithPrice(),
    );
    const tarif = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    const preview = await waitFor(() => {
      const el = tarif.querySelector('.vp-setting-preview');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(preview.textContent).toContain('Ihr Bezugspreis gerade');
    expect(preview.textContent).toContain('32,5 ct/kWh');
    // 124 EUR/MWh = 12,4 ct Börse; der Rest ist die Aufschlüsselung des Servers.
    expect(preview.textContent).toContain('Börsenpreis 12,4');
    expect(preview.textContent).toContain('Netzentgelte/Abgaben 20,1');
    restore();
  });

  it('ohne Fahrplan wird KEINE Zahl erfunden - die Zeile sagt, was fehlt', async () => {
    const { restore } = await renderEinstellungen({ tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const tarif = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    const preview = await waitFor(() => {
      const el = tarif.querySelector('.vp-setting-preview');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(preview.textContent).toContain('sobald der nächste Fahrplan gerechnet ist');
    expect(preview.textContent).not.toMatch(/\d,\d ct/);
    restore();
  });

  it('ohne Tarifangabe sagt sie, dass gar nicht in Euro gerechnet wird', async () => {
    const { restore } = await renderEinstellungen({ tarifArt: 'ohne' }, {}, null, planWithPrice());
    const tarif = screen.getByText('Stromtarif').closest('li') as HTMLElement;
    // Der Lauf trägt zwar einen Preis, die Anlage aber keinen Tarif: dann darf
    // die Vorschau ihn nicht als „Ihren" Bezugspreis ausgeben.
    await waitFor(() => expect(tarif.querySelector('.vp-setting-preview')).not.toBeNull());
    restore();
  });
});

describe('Einstellungen · E6 · Suche & Wording', () => {
  it('findet den Strompreis und springt in seine Gruppe', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    const { restore } = await renderEinstellungen();
    const feld = screen.getByLabelText('Einstellung suchen');
    fireEvent.change(feld, { target: { value: 'Strompreis' } });
    const treffer = await screen.findByRole('button', { name: /Stromtarif/ });
    scrollIntoView.mockClear();
    fireEvent.click(treffer);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // Die Adresse zeigt danach auf die Gruppe (Neuladen landet wieder dort).
    expect(window.location.hash).toContain('abschnitt=geld');
    window.location.hash = '';
    restore();
  });

  it('findet dieselbe Zeile auch unter einem Synonym und unter dem ALTEN Namen', async () => {
    const { restore } = await renderEinstellungen();
    const feld = screen.getByLabelText('Einstellung suchen');
    fireEvent.change(feld, { target: { value: 'Arbeitspreis' } });
    expect(await screen.findByRole('button', { name: /Stromtarif/ })).toBeInTheDocument();
    fireEvent.change(feld, { target: { value: 'Anlagentyp' } });
    expect(await screen.findByRole('button', { name: /Veräußerungsform/ })).toBeInTheDocument();
    restore();
  });

  it('sagt bei keinem Treffer, wo man stattdessen schaut', async () => {
    const { restore } = await renderEinstellungen();
    fireEvent.change(screen.getByLabelText('Einstellung suchen'), {
      target: { value: 'quantencomputer' },
    });
    expect(await screen.findByText(/sechs Gruppen/)).toBeInTheDocument();
    restore();
  });

  it('D6: das Feld heißt Veräußerungsform, nicht mehr Anlagentyp', async () => {
    const { restore } = await renderEinstellungen();
    const anlage = document.getElementById('technik-anlage') as HTMLElement;
    expect(within(anlage).getByText('Veräußerungsform')).toBeInTheDocument();
    expect(within(anlage).queryByText('Anlagentyp')).toBeNull();
    expect(within(anlage).getByText(/Wie wird Ihr Strom vergütet/)).toBeInTheDocument();
    restore();
  });
});

describe('Einstellungen · E7 · die Grenze zur Box (D5)', () => {
  it('spricht die Zuständigkeit beidseitig aus und nennt den Weg zur Geräteseite', async () => {
    const { restore } = await renderEinstellungen();
    const geraet = document.getElementById('technik-geraet') as HTMLElement;
    const box = geraet.querySelector('.vp-set-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('WOMIT');
    expect(box.textContent).toContain('WOFÜR');
    expect(box.textContent).toContain('8484');
    // Kein erfundener Link ins Heimnetz des Kunden.
    expect(box.querySelector('a')).toBeNull();
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/* Als App auf dem Handy (PWA-Hülle)                                          */
/* -------------------------------------------------------------------------- */

/** Ein `window`-Stellvertreter für den Einrichten-Zustand dieses Geräts. */
function installEnv(opts: { standalone?: boolean; ua?: string } = {}) {
  const handlers = new Map<string, Array<(e: Event) => void>>();
  const env: InstallEnv & { fire(type: string, e?: Partial<Event>): void } = {
    addEventListener(type, cb) {
      handlers.set(type, [...(handlers.get(type) ?? []), cb]);
    },
    removeEventListener(type, cb) {
      const list = handlers.get(type) ?? [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    matchMedia: () => ({ matches: opts.standalone === true }),
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (Linux; Android 14) Chrome/151' },
    fire(type, e) {
      for (const cb of handlers.get(type) ?? []) cb({ ...e, type } as Event);
    },
  };
  return env;
}

describe('Einstellungen · Als App auf dem Handy (PWA-Hülle)', () => {
  it('steht als eigener Abschnitt und nennt ohne Angebot den GRUND statt eines toten Knopfes', async () => {
    resetInstallApp();
    initInstallApp(installEnv());
    const { restore } = await renderEinstellungen();

    const app = document.getElementById('technik-app') as HTMLElement;
    expect(app).not.toBeNull();
    expect(within(app).getByText('Als App auf dem Handy')).toBeInTheDocument();
    expect(within(app).getByText(/bietet das Einrichten hier nicht an/)).toBeInTheDocument();
    expect(within(app).queryByRole('button', { name: 'App installieren' })).toBeNull();
    restore();
  });

  it('zeigt den Knopf, sobald der Browser sein Angebot macht - auch NACH dem Rendern', async () => {
    resetInstallApp();
    const env = installEnv();
    initInstallApp(env);
    const { restore } = await renderEinstellungen();
    const app = document.getElementById('technik-app') as HTMLElement;
    expect(within(app).queryByRole('button', { name: 'App installieren' })).toBeNull();

    const prompt = vi.fn(() => Promise.resolve());
    act(() => {
      env.fire('beforeinstallprompt', {
        preventDefault: vi.fn(),
        prompt,
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      } as never);
    });

    const btn = within(app).getByRole('button', { name: 'App installieren' });
    fireEvent.click(btn);
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    restore();
  });

  it('zeigt der installierten App KEINEN Hinweis mehr, nur einen ruhigen Satz', async () => {
    resetInstallApp();
    initInstallApp(installEnv({ standalone: true }));
    const { restore } = await renderEinstellungen();

    const app = document.getElementById('technik-app') as HTMLElement;
    expect(within(app).getByText('Sie nutzen VoltPilot bereits als App.')).toBeInTheDocument();
    expect(within(app).queryByRole('button', { name: 'App installieren' })).toBeNull();
    expect(within(app).queryByRole('list')).toBeNull();
    restore();
  });

  it('führt auf dem iPhone in zwei Schritten statt einen Dialog zu versprechen', async () => {
    resetInstallApp();
    initInstallApp(installEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari' }));
    const { restore } = await renderEinstellungen();

    const app = document.getElementById('technik-app') as HTMLElement;
    const steps = within(app).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(/Teilen/);
    expect(steps[1]).toHaveTextContent(/Home-Bildschirm/);
    expect(within(app).queryByRole('button', { name: 'App installieren' })).toBeNull();
    restore();
  });
});
