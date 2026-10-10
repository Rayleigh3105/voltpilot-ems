import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BatteryControlSection, StammdatenEditForm, TechnikSection } from './AnlageTechnik';
import { api, type Device, type Site, type SiteAsset, type SupplyPrice } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';

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
  it('warns when the battery has no controlling device - and names the gap', () => {
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: null })}
        devices={[device()]}
        onSaved={() => {}}
      />,
    );
    // The no-device warning is a real failure - shown first.
    expect(screen.getByText(/keinem Gerät zugeordnet/)).toBeInTheDocument();
    // Seit E5 steht der Speicher in einem Blatt: alle Werte auf einen Blick.
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
    expect(screen.getByText('Wechselrichter Garage')).toBeInTheDocument();
    expect(screen.getByText('Lade-/Entladeleistung')).toBeInTheDocument();
  });

  it('offers to add a battery when none exists yet', () => {
    render(<BatteryControlSection siteId="s-1" battery={null} devices={[]} onSaved={() => {}} />);
    expect(screen.getByRole('button', { name: /Speicher hinzufügen/ })).toBeInTheDocument();
  });

  it('beginnt auf Wunsch direkt im Formular („Speicher hinzufügen", „Gerät zuordnen")', () => {
    render(
      <BatteryControlSection siteId="s-1" battery={null} devices={[]} onSaved={() => {}} startEditing />,
    );
    expect(screen.getByLabelText('Kapazität (kWh) *')).toBeInTheDocument();
  });

  it('saves parsed params + the chosen controlling device, NEVER the Speicherschonung', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Speicher bearbeiten/ }));
    // Der Umgang mit dem Speicher hat seine eigene Zeile - nicht hier.
    expect(screen.queryByRole('radio', { name: /Ausgewogen/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Kapazität (kWh) *'), { target: { value: '12,5' } });
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

  it('no longer shows the Speicherschonung in the battery read view', () => {
    render(
      <BatteryControlSection
        siteId="s-1"
        battery={battery({ deviceId: 'd-1', speicherschonung: 'ausgewogen' })}
        devices={[device({ id: 'd-1' })]}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByText('Umgang mit dem Speicher')).toBeNull();
    expect(screen.getByText('Kapazität')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Die Seite (E5 = A): eine kurze, sortierte Liste - Werte an der Zeile,
// Bearbeiten im Blatt, einfache Schalter direkt mit „Rückgängig".
// ---------------------------------------------------------------------------

/**
 * Ein Fahrplan-Lauf, der die laufende Viertelstunde abdeckt — die Quelle der
 * Bezugspreis-Vorschau. `null` = die Anlage hat (noch) keinen Plan.
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
  batteryOver: Partial<SiteAsset> | null = {},
  supplySheet: SupplyPrice | null = null,
  plan: unknown = null,
  devices: Device[] = [device({ id: 'd-1' })],
) {
  const s: Site = { ...eegSite, ...over };
  const assets = vi
    .spyOn(api, 'siteAssets')
    .mockResolvedValue(batteryOver == null ? [] : [battery({ deviceId: 'd-1', ...batteryOver })]);
  const preview = vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a'));
  const supply = vi.spyOn(api, 'supplyPrice').mockResolvedValue(supplySheet as never);
  const schedule =
    plan == null
      ? vi.spyOn(api, 'schedule').mockRejectedValue(new Error('kein Plan'))
      : vi.spyOn(api, 'schedule').mockResolvedValue(plan as never);
  const onSiteSaved = vi.fn();
  const view = render(
    <TechnikSection
      site={s}
      devices={devices}
      sites={[s]}
      onReload={() => {}}
      onSiteSaved={onSiteSaved}
      onSiteDeleted={() => {}}
    />,
  );
  // Auf den Asset-Abruf warten, sonst steht die Speicher-Gruppe noch im Skeleton.
  await screen.findByText(batteryOver == null ? 'Speicher hinzufügen' : 'Kapazität');
  return {
    onSiteSaved,
    rerender: (next: Site) =>
      view.rerender(
        <TechnikSection
          site={next}
          devices={devices}
          sites={[next]}
          onReload={() => {}}
          onSiteSaved={onSiteSaved}
          onSiteDeleted={() => {}}
        />,
      ),
    restore: () => [assets, preview, supply, schedule].forEach((m) => m.mockRestore()),
  };
}

/** Die Zeile mit diesem Namen - sie ist der Knopf, der ihr Blatt öffnet. */
function zeile(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

async function blatt(name: string): Promise<HTMLElement> {
  fireEvent.click(zeile(name));
  return screen.findByRole('dialog');
}

describe('Einstellungen · die kurze Liste (E5)', () => {
  it('ordnet alles in vier Gruppen - jede Zeile trägt ihren Wert', async () => {
    const { restore } = await renderEinstellungen({ maxFeedInKw: 30, tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    for (const [id, titel] of [
      ['technik-anlage', 'Anlage'],
      ['technik-geld', 'Strom & Geld'],
      ['technik-speicher', 'Speicher'],
      ['technik-weiteres', 'Weiteres'],
    ]) {
      const grp = document.getElementById(id) as HTMLElement;
      expect(within(grp).getByRole('heading', { name: titel })).toBeInTheDocument();
    }
    expect(zeile('Name')).toHaveTextContent('Hof Sonnenfeld');
    expect(zeile('Einspeisegrenze')).toHaveTextContent('30,0');
    expect(zeile('Stromtarif')).toHaveTextContent('Fest: 32,5 ct/kWh');
    expect(zeile('Kapazität')).toHaveTextContent('10,0');
    // Ohne Koordinaten sagt die Zeile, was fehlt - und warum es zählt. Das
    // Feld heißt weiter „Standort" (Glossar, E9: B).
    expect(zeile('Standort')).toHaveTextContent('Ohne Standort auf der Karte gibt es keine Wettervorhersage.');
    restore();
  });

  it('hat keine Suche, keine Legende ①②③ und keine Abschnitts-Navigation mehr', async () => {
    const { restore } = await renderEinstellungen();
    expect(screen.queryByLabelText('Einstellung suchen')).toBeNull();
    expect(document.querySelector('.vp-set-legend')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Abschnitte' })).toBeNull();
    // Die Box und die App-Einrichtung sind umgezogen.
    expect(document.getElementById('technik-geraet')).toBeNull();
    expect(document.getElementById('technik-app')).toBeNull();
    expect(screen.getByRole('link', { name: 'Aufbau' })).toHaveAttribute('href', '#/anlage/s-1/modell');
    restore();
  });

  it('DER Befund bleibt geschlossen: eine Eigenverbrauchs-Anlage erreicht alle Werte', async () => {
    const { restore } = await renderEinstellungen();
    expect(zeile('Stromtarif')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Netzladen' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Umgang mit dem Speicher' })).toBeInTheDocument();
    // Die Sichtbarkeitsregel bleibt: der anzulegende Wert ist ein DV-Fakt.
    expect(screen.queryByText('Anzulegender Wert')).toBeNull();
    restore();
  });

  it('zeigt den anzulegenden Wert auf einer Direktvermarktungs-Anlage', async () => {
    const { restore } = await renderEinstellungen({
      plantKind: 'direktvermarktung',
      anzulegenderWertCtKwh: 8.11,
    });
    expect(zeile('Anzulegender Wert')).toHaveTextContent('8,11');
    restore();
  });

  it('D6: die Zeile heißt Veräußerungsform - die Frage dazu steht im Blatt', async () => {
    const { restore } = await renderEinstellungen();
    const anlage = document.getElementById('technik-anlage') as HTMLElement;
    expect(within(anlage).getByText('Veräußerungsform')).toBeInTheDocument();
    expect(within(anlage).queryByText('Anlagentyp')).toBeNull();
    const b = await blatt('Veräußerungsform');
    expect(b).toHaveAccessibleName('Anlage bearbeiten');
    expect(within(b).getByText(/Wie wird Ihr Strom vergütet/)).toBeInTheDocument();
    restore();
  });

  it('der Direktlink aus dem Modus-Container landet auf der Gruppe (kein toter Link)', async () => {
    window.location.hash = '#/anlage/s-1/technik?abschnitt=geld';
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    const { restore } = await renderEinstellungen();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.getElementById('technik-geld')).not.toBeNull();
    window.location.hash = '';
    restore();
  });

  it('führt den alten Direktlink auf „Mein Gerät" in den Aufbau', async () => {
    window.location.hash = '#/anlage/s-1/technik?abschnitt=geraet';
    const { restore } = await renderEinstellungen();
    await waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1/modell'));
    window.location.hash = '';
    restore();
  });
});

describe('Einstellungen · Stromtarif im Blatt', () => {
  it('nennt im Blatt, worauf der Tarif wirkt, und den LEBENDEN Bezugspreis', async () => {
    const { restore } = await renderEinstellungen(
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      {},
      null,
      planWithPrice(),
    );
    const b = await blatt('Stromtarif');
    expect(within(b).getByText('Wirkt auf: Fahrplan')).toBeInTheDocument();
    expect(within(b).getByText('Wirkt auf: Erlöse')).toBeInTheDocument();
    expect(within(b).getByText('Bewertet')).toBeInTheDocument();
    const vorschau = await waitFor(() => {
      const el = b.querySelector('.vp-setting-preview');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(vorschau.textContent).toContain('Ihr Bezugspreis gerade');
    expect(vorschau.textContent).toContain('32,5 ct/kWh');
    expect(vorschau.textContent).toContain('Börsenpreis 12,4');
    expect(vorschau.textContent).toContain('Netzentgelte/Abgaben 20,1');
    restore();
  });

  it('ohne Fahrplan wird KEINE Zahl erfunden - das Blatt sagt, was fehlt', async () => {
    const { restore } = await renderEinstellungen({ tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const b = await blatt('Stromtarif');
    const vorschau = await waitFor(() => {
      const el = b.querySelector('.vp-setting-preview');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(vorschau.textContent).toContain('sobald der nächste Fahrplan gerechnet ist');
    expect(vorschau.textContent).not.toMatch(/\d,\d ct/);
    restore();
  });

  it('speichert den Stromtarif als VOLL-Repräsentation (blankt kein Nachbarfeld)', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    const { onSiteSaved, restore } = await renderEinstellungen({ maxFeedInKw: 75 });

    const b = await blatt('Stromtarif');
    fireEvent.click(within(b).getByRole('combobox', { name: 'Stromtarif' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fest (ct/kWh)' }));
    fireEvent.change(within(b).getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)'), { target: { value: '32,5' } });
    fireEvent.click(within(b).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
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
    // Gespeichert schließt das Blatt.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    updateSite.mockRestore();
    restore();
  });

  it('E2: der Tarifart-Wechsel deutet die Zahl nie um - und speichert die richtige', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'fest', tarifParamCtKwh: 32.5 });
    const { onSiteSaved, restore } = await renderEinstellungen({ tarifArt: 'dynamisch', tarifParamCtKwh: 18 });

    const b = await blatt('Stromtarif');
    expect(within(b).getByLabelText('Aufschlag auf den Börsenpreis (gesamt, ct/kWh)')).toHaveValue('18');
    fireEvent.click(within(b).getByRole('combobox', { name: 'Stromtarif' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fest (ct/kWh)' }));
    expect(within(b).getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)')).toHaveValue('');
    expect(within(b).getByRole('status').textContent).toContain('Andere Bedeutung');

    fireEvent.change(within(b).getByLabelText('Arbeitspreis (all-in, brutto) (ct/kWh)'), {
      target: { value: '32,5' },
    });
    fireEvent.click(within(b).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ tarifArt: 'fest', tarifParamCtKwh: 32.5 }),
    );
    updateSite.mockRestore();
    restore();
  });

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

  it('E2/D3: „Schnell" statt „Genau" ENTFERNT das Preisblatt - angekündigt, dann getan', async () => {
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

    const b = await blatt('Stromtarif');
    await within(b).findByText('Bezugspreis-Komponenten');
    expect(within(b).queryByLabelText('Aufschlag auf den Börsenpreis (gesamt, ct/kWh)')).toBeNull();
    fireEvent.click(within(b).getByRole('radio', { name: /Schnell/ }));
    expect(within(b).getByText(/Bezugspreis-Komponenten entfernt/)).toBeInTheDocument();
    fireEvent.click(within(b).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
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
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, tarifArt: 'dynamisch', tarifParamCtKwh: 18 });
    const updateSupply = vi.spyOn(api, 'updateSupplyPrice').mockResolvedValue(maintained as never);
    const { onSiteSaved, restore } = await renderEinstellungen(
      { tarifArt: 'dynamisch', tarifParamCtKwh: 18 },
      {},
      maintained,
    );

    const b = await blatt('Stromtarif');
    await within(b).findByText('Bezugspreis-Komponenten');
    fireEvent.click(within(b).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSupply).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ netzentgeltArbeitspreisCt: 7.6, vertriebsaufschlagCt: 1.5 }),
    );
    updateSite.mockRestore();
    updateSupply.mockRestore();
    restore();
  });
});

describe('Einstellungen · Schalter wirken direkt - mit Folge und „Rückgängig"', () => {
  it('Netzladen: die Bedingung steht VOR dem Umlegen an der Zeile', async () => {
    const { restore } = await renderEinstellungen();
    const schalter = screen.getByRole('switch', { name: 'Netzladen' });
    expect(schalter).toHaveAttribute('aria-checked', 'false');
    expect(schalter.closest('li')).toHaveTextContent('nur ohne EEG-Vergütung');
    restore();
  });

  it('Netzladen: speichert als Voll-Repräsentation, nennt die Folge und nimmt sie zurück', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockImplementation(async (_id, body) => ({ ...eegSite, ...(body as object) }) as Site);
    const { onSiteSaved, rerender, restore } = await renderEinstellungen({ maxFeedInKw: 75 });

    fireEvent.click(screen.getByRole('switch', { name: 'Netzladen' }));
    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenLastCalledWith('s-1', {
      name: 'Hof Sonnenfeld',
      biddingZone: 'DE-LU',
      latitude: null,
      longitude: null,
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      netzladenErlaubt: true,
      maxFeedInKw: 75,
    });
    expect(await screen.findByText('Ab dem nächsten Fahrplan darf der Speicher aus dem Netz laden.')).toBeInTheDocument();

    // Die Schale reicht den gespeicherten Stand herein - „Rückgängig" baut
    // auf IHM auf, nicht auf dem Stand vor dem Klick.
    rerender({ ...eegSite, maxFeedInKw: 80, netzladenErlaubt: true });
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() =>
      expect(updateSite).toHaveBeenLastCalledWith(
        's-1',
        expect.objectContaining({ netzladenErlaubt: false, maxFeedInKw: 80 }),
      ),
    );
    expect(await screen.findByText('Ab dem nächsten Fahrplan lädt der Speicher nur aus Sonnenstrom.')).toBeInTheDocument();
    // Ein Rückgängig wird nicht selbst wieder rückgängig gemacht.
    expect(screen.queryByRole('button', { name: 'Rückgängig' })).toBeNull();
    updateSite.mockRestore();
    restore();
  });

  it('Netzladen: eine Ablehnung steht als Satz an der Zeile, nie als Stille', async () => {
    const updateSite = vi.spyOn(api, 'updateSite').mockRejectedValue(new Error('down'));
    const { onSiteSaved, restore } = await renderEinstellungen();
    fireEvent.click(screen.getByRole('switch', { name: 'Netzladen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nicht gespeichert');
    expect(onSiteSaved).not.toHaveBeenCalled();
    updateSite.mockRestore();
    restore();
  });

  it('Umgang mit dem Speicher: wirkt direkt über die volle Speicher-Repräsentation', async () => {
    const saveBattery = vi
      .spyOn(api, 'saveBattery')
      .mockResolvedValueOnce([battery({ deviceId: 'd-1', speicherschonung: 'schonend' })])
      .mockResolvedValueOnce([battery({ deviceId: 'd-1', speicherschonung: 'ausgewogen' })]);
    const { restore } = await renderEinstellungen();

    const gruppe = screen.getByRole('radiogroup', { name: 'Umgang mit dem Speicher' });
    expect(within(gruppe).getByRole('radio', { name: 'Ausgewogen' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(gruppe).getByRole('radio', { name: 'Schonend' }));

    await waitFor(() =>
      expect(saveBattery).toHaveBeenCalledWith('s-1', {
        capacityKwh: 10,
        maxChargeKw: 5,
        maxDischargeKw: 5,
        roundtripEfficiencyPct: null,
        deviceId: 'd-1',
        speicherschonung: 'schonend',
      }),
    );
    // Die Folge ist der Satz der Stufe - und der Weg zurück.
    expect(await screen.findByText(/längste Lebensdauer/)).toBeInTheDocument();
    expect(within(gruppe).getByRole('radio', { name: 'Schonend' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() =>
      expect(saveBattery).toHaveBeenLastCalledWith('s-1', expect.objectContaining({ speicherschonung: 'ausgewogen' })),
    );
    saveBattery.mockRestore();
    restore();
  });

  it('Umgang: eine von VoltPilot eingerichtete Stufe wird nicht still ersetzt - erst das Blatt', async () => {
    const saveBattery = vi.spyOn(api, 'saveBattery');
    const { restore } = await renderEinstellungen({}, { speicherschonung: 'individuell' });
    expect(screen.queryByRole('radiogroup', { name: 'Umgang mit dem Speicher' })).toBeNull();
    const b = await blatt('Umgang mit dem Speicher');
    expect(within(b).getByText(/Die Auswahl einer Option ersetzt diese Einstellung/)).toBeInTheDocument();
    expect(saveBattery).not.toHaveBeenCalled();
    saveBattery.mockRestore();
    restore();
  });
});

describe('Einstellungen · Profil ändern (Anwendungs-Programm Stufe 2)', () => {
  it('sagt ehrlich, wenn noch keins gewählt ist', async () => {
    const { restore } = await renderEinstellungen();
    expect(zeile('Profil')).toHaveTextContent('noch nicht festgelegt');
    restore();
  });

  it('schreibt das Profil über die SCHMALE Route - und nennt vorher die Folgen', async () => {
    const preset = vi.spyOn(api, 'setAnwendungsPreset').mockResolvedValue({ ...eegSite, profil: 'gewerbe' });
    const updateSite = vi.spyOn(api, 'updateSite');
    const { onSiteSaved, restore } = await renderEinstellungen({ profil: 'privat' });

    expect(zeile('Profil')).toHaveTextContent('Privat');
    fireEvent.click(zeile('Profil'));
    expect(screen.getByText(/Ihre eingeschalteten Betriebsmodelle bleiben unverändert/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: 'Profil' }));
    fireEvent.click(await screen.findByRole('option', { name: /Gewerbe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Profil speichern' }));

    await waitFor(() => expect(preset).toHaveBeenCalledWith('s-1', 'gewerbe'));
    await waitFor(() => expect(onSiteSaved).toHaveBeenCalled());
    expect(updateSite).not.toHaveBeenCalled();
    preset.mockRestore();
    updateSite.mockRestore();
    restore();
  });

  it('Abbrechen ändert nichts', async () => {
    const preset = vi.spyOn(api, 'setAnwendungsPreset');
    const { restore } = await renderEinstellungen({ profil: 'privat' });
    fireEvent.click(zeile('Profil'));
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(preset).not.toHaveBeenCalled();
    preset.mockRestore();
    restore();
  });
});

/** Eine Anlage MIT eingerichteter Lastspitzenkappung (die Stufe-②-Werte). */
const peakSite: Partial<Site> = {
  leistungspreisEurKw: 128.5,
  abrechnungLeistung: 'jahr',
  peakReserveSocPct: 25,
};

describe('Einstellungen · von VoltPilot eingerichtet (Schloss)', () => {
  it('D4: die Vertragswerte sind für den KUNDEN sichtbar - mit Schloss, ohne Formular', async () => {
    const { restore } = await renderEinstellungen(peakSite);
    const lp = zeile('Leistungspreis');
    expect(lp).toHaveTextContent('128,50');
    expect(lp).toHaveTextContent('Von VoltPilot eingerichtet');
    expect(zeile('Abrechnungsperiode')).toBeInTheDocument();
    const reserve = zeile('Lastspitzen-Reserve');
    expect(document.getElementById('technik-speicher')?.contains(reserve)).toBe(true);

    const b = await blatt('Leistungspreis');
    expect(within(b).getByText(/Sprechen Sie uns an/)).toBeInTheDocument();
    expect(within(b).queryByRole('button', { name: 'Speichern' })).toBeNull();
    restore();
  });

  it('erfindet auf einer Hausanlage ohne Lastspitzenkappung keine Schloss-Zeile', async () => {
    const { restore } = await renderEinstellungen();
    expect(screen.queryByText('Leistungspreis')).toBeNull();
    expect(screen.queryByText('Lastspitzen-Reserve')).toBeNull();
    expect(screen.queryByText('Von VoltPilot eingerichtet')).toBeNull();
    restore();
  });

  it('③ bleibt als Schutz-Streifen - und behauptet „nur Solarladen" nur, wenn es gilt', async () => {
    const { restore } = await renderEinstellungen();
    const streifen = document.querySelector('.vp-set-schutz') as HTMLElement;
    expect(within(streifen).getByText('§ 14a-Schutz')).toBeInTheDocument();
    expect(within(streifen).getByText('Negativpreis-Abregelung')).toBeInTheDocument();
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
});

describe('Einstellungen · Speicher, Registrierung, Löschen', () => {
  it('warnt an der Gruppe, wenn der Speicher kein steuerndes Gerät hat - und führt direkt zur Lösung', async () => {
    const { restore } = await renderEinstellungen({}, { deviceId: null });
    const gruppe = document.getElementById('technik-speicher') as HTMLElement;
    expect(within(gruppe).getByText(/keinem Gerät zugeordnet/)).toBeInTheDocument();
    fireEvent.click(within(gruppe).getByRole('button', { name: 'Gerät zuordnen' }));
    const b = await screen.findByRole('dialog', { name: 'Speicher' });
    expect(within(b).getByRole('combobox', { name: 'Steuerndes Gerät' })).toBeInTheDocument();
    restore();
  });

  it('bietet ohne Speicher „Speicher hinzufügen" - das Blatt beginnt im Formular', async () => {
    const { restore } = await renderEinstellungen({}, null);
    const b = await blatt('Speicher hinzufügen');
    expect(b).toHaveAccessibleName('Speicher hinzufügen');
    expect(within(b).getByLabelText('Kapazität (kWh) *')).toBeInTheDocument();
    restore();
  });

  it('öffnet ohne Verknüpfung direkt die Verknüpfung mit dem Marktstammdatenregister', async () => {
    const { restore } = await renderEinstellungen();
    expect(zeile('Registrierung')).toHaveTextContent('Nicht verknüpft');
    fireEvent.click(zeile('Registrierung'));
    expect(await screen.findByRole('dialog', { name: 'Anlage verknüpfen' })).toBeInTheDocument();
    restore();
  });

  it('nennt den Weg, solange der Anlage noch eine Box zugeordnet ist', async () => {
    const { restore } = await renderEinstellungen();
    const b = await blatt('Anlage löschen');
    expect(within(b).getByText(/Entfernen Sie die Box zuerst im Aufbau/)).toBeInTheDocument();
    expect(within(b).queryByRole('button', { name: 'Anlage löschen' })).toBeNull();
    restore();
  });

  it('löscht erst nach der Folgenliste', async () => {
    const del = vi.spyOn(api, 'deleteSite').mockResolvedValue(undefined as never);
    const { restore } = await renderEinstellungen({}, {}, null, null, []);
    const b = await blatt('Anlage löschen');
    fireEvent.click(within(b).getByRole('button', { name: 'Anlage löschen' }));
    expect(within(b).getByText(/Die Anlage „Hof Sonnenfeld" mit allen Daten/)).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(b).getByRole('button', { name: 'Anlage endgültig löschen' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('s-1'));
    del.mockRestore();
    restore();
  });
});

describe('AP-15 IP-23 · Karte „Gemeinsame Steuerung“ auf der Einstellungs-Seite', () => {
  /** Rendert die Einstellungen einer steuernden Anlage mit `boxen` Boxen. */
  async function renderMitBoxen(boxen: number, teilnahme: 'aktiv' | 'kein_objekt') {
    const spies = [
      vi.spyOn(api, 'siteAssets').mockResolvedValue([battery({ deviceId: 'd-1' })]),
      vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a')),
      vi.spyOn(api, 'supplyPrice').mockResolvedValue(null as never),
      vi.spyOn(api, 'schedule').mockRejectedValue(new Error('kein Plan')),
      vi.spyOn(api, 'funktionen').mockResolvedValue({
        standorte: [{ id: 'st-1', steuern: { anlagen: [{ id: 's-1', teilnahme: { zustand: teilnahme } }] } }],
      } as never),
      vi.spyOn(api, 'gemeinsameSteuerung').mockResolvedValue({ eingerichtet: false, zustand: 'nicht_eingerichtet', mitglieder: [], fehlt: [] }),
    ];
    const devices = Array.from({ length: boxen }, (_, i) => device({ id: `d-${i + 1}`, kind: 'edge', name: `Box ${i + 1}` }));
    render(
      <TechnikSection site={eegSite} devices={devices} sites={[eegSite]} onReload={() => {}} onSiteSaved={() => {}} onSiteDeleted={() => {}} />,
    );
    await screen.findByText('Kapazität');
    await waitFor(() => expect(api.gemeinsameSteuerung).toHaveBeenCalled());
    return () => spies.forEach((m) => m.mockRestore());
  }

  // Seit „Anlage – neu gedacht“ (E5) gibt es keine Abschnitts-Navigation mehr: die Karte ist
  // eine eigene Gruppe mit Überschrift unter den übrigen, `?abschnitt=gemeinsam` springt sie an.
  it('steuernd mit zwei Boxen: die Gruppe mit Karte erscheint', async () => {
    const restore = await renderMitBoxen(2, 'aktiv');
    const karte = await screen.findByTestId('gemeinsame-steuerung');
    const gruppe = karte.closest('#technik-gemeinsam') as HTMLElement | null;
    expect(gruppe).not.toBeNull();
    expect(within(gruppe!).getByRole('heading', { name: 'Gemeinsame Steuerung' })).toBeInTheDocument();
    restore();
  });

  it('eine Box oder nur messend: keine Gruppe', async () => {
    for (const [boxen, teilnahme] of [[1, 'aktiv'], [2, 'kein_objekt']] as const) {
      const restore = await renderMitBoxen(boxen, teilnahme);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(document.getElementById('technik-gemeinsam')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Gemeinsame Steuerung' })).toBeNull();
      restore();
      cleanup();
    }
  });
});

describe('AP-03 IP-12 · Rechte an der kurzen Liste', () => {
  it('ohne „anlage.verwalten“: Werte bleiben lesbar, die Zeilen öffnen nichts, der Grund steht da', async () => {
    const me = rechteSeed('JW').me;
    const ohne = (rechte: readonly string[]) => rechte.filter((r) => r !== 'anlage.verwalten');
    setSelbstauskunft({
      ...me,
      unternehmen_rechte: ohne(me.unternehmen_rechte),
      standorte: me.standorte.map((s) => ({ ...s, rechte: ohne(s.rechte) })),
    });
    const spies = [
      vi.spyOn(api, 'siteAssets').mockResolvedValue([]),
      vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a')),
      vi.spyOn(api, 'supplyPrice').mockResolvedValue(null as never),
      vi.spyOn(api, 'schedule').mockRejectedValue(new Error('kein Plan')),
    ];
    render(
      <TechnikSection site={eegSite} devices={[]} sites={[eegSite]} onReload={() => {}} onSiteSaved={() => {}} onSiteDeleted={() => {}} />,
    );
    const gruppe = document.getElementById('technik-anlage')!;
    expect(within(gruppe).getByText(eegSite.name)).toBeInTheDocument();
    expect(within(gruppe).queryByRole('button', { name: /Name/ })).toBeNull();
    expect(within(gruppe).getAllByRole('note').length).toBeGreaterThan(0);
    // Das Profil ist die Betriebsweise - ein eigenes Recht, das diese Person behält.
    expect(within(gruppe).getByRole('button', { name: /Profil/ })).toBeInTheDocument();
    spies.forEach((m) => m.mockRestore());
  });
});
