import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LadevorgaengeSection } from './LadevorgaengeSection';
import { api, type Device, type Site } from '../api';
import type { SiteCharging } from '../ladepunkte';

const site: Site = {
  id: 's-lade',
  name: 'Ladepark Hof',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  leistungspreisEurKw: null,
  peakReserveSocPct: null,
};

/** Das Beispiel-Szenario der abgenommenen Mockups, 13:24 Uhr. */
const charging: SiteCharging = {
  budget: {
    deviceId: 'd-1',
    enabled: true,
    controlEnabled: true,
    gridLimitKw: 277,
    effLimitKw: 277,
    marginPct: 10,
    minPowerKw: 30,
    budgetKw: 82.3,
    allocatedKw: 82,
    measuredKw: 79,
    siteLoadKw: 167,
    siteGridKw: 246,
    budgetMode: 'gemessen',
    budgetNote: 'Das Budget folgt der Messung am Netzanschluss.',
    budgetBlind: false,
    safeDefaultKw: 15,
    safeDefaultHolds: true,
    safeWorstCaseKw: 270,
    maxHouseLoadKw: 180,
    connectorCount: 6,
  },
  chargers: [
    {
      deviceId: 'd-1',
      chargePointId: 'saeule-1',
      label: 'Hof Nord',
      priority: false,
      connected: true,
      ready: true,
      vendor: 'Midapower',
      model: 'DC-240',
      connectors: [
        {
          connectorId: 1,
          status: 'Charging',
          charging: true,
          allocatedKw: 41,
          powerKw: 40,
          socPct: 62,
          reasonText: 'lädt',
          sessionSince: '2026-08-20T08:41:00Z',
        },
        {
          connectorId: 2,
          status: 'Preparing',
          charging: false,
          allocatedKw: 0,
          reasonText: 'wartet - Budget vergeben',
        },
      ],
    },
    {
      deviceId: 'd-1',
      chargePointId: 'saeule-2',
      label: 'Hof Süd',
      priority: false,
      connected: false,
      ready: true,
      lastSeen: '2026-08-20T09:00:00Z',
      connectors: [],
    },
  ],
};

describe('LadevorgaengeSection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('zeigt Bühne, Ladevorgänge und die RECHNUNG des Ausfall-Schutzes', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue(charging);
    render(<LadevorgaengeSection site={site} />);

    // Die Bühne mit dem Satz der Box, unverändert.
    expect(await screen.findByText('246 kW von 277 kW')).toBeTruthy();
    expect(screen.getByText('Das Budget folgt der Messung am Netzanschluss.')).toBeTruthy();

    // Der Ladevorgang trägt sein WORT, nicht nur eine Farbe.
    expect(screen.getByText('Hof Nord · Stecker A')).toBeTruthy();
    expect(screen.getAllByText('lädt').length).toBeGreaterThan(0);
    // Warten ist kein Fehler - aber es nennt seinen Grund.
    expect(screen.getByText(/wartet - Budget vergeben/)).toBeTruthy();

    // Der Ausfall-Schutz zeigt die nachrechenbare Zeile.
    expect(
      screen.getByText(/6 Stecker × 15 kW \+ höchste Gebäudelast 180 kW = 270 kW < Grenze 277 kW/),
    ).toBeTruthy();

    // Die getrennte Säule nennt die FOLGE, nicht nur die Tatsache.
    expect(screen.getByText(/begrenzt sich dabei aber selbst/)).toBeTruthy();
  });

  it('sagt den Leerlauf ehrlich statt Nullzeilen zu erfinden', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue({
      budget: charging.budget,
      chargers: [
        {
          ...charging.chargers[0],
          connectors: [{ connectorId: 1, status: 'Available', charging: false }],
        },
      ],
    });
    render(<LadevorgaengeSection site={site} />);
    expect(await screen.findByText('Gerade lädt niemand - alle 6 Stecker sind frei.')).toBeTruthy();
  });

  /*
    Anlagen-Zentrale Stufe 3 (PR 3c, §13.4): der Aufklapper „Technische
    Angaben" ist die GERÄTESEITE der Säule geworden - ein Ladepunkt hat damit
    denselben EINEN Ort wie jedes andere Gerät.
  */
  it('führt von der Säule auf ihre Geräteseite - Kennung bleibt sichtbar', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue(charging);
    const box: Device = {
      id: 'd-1', siteId: 's-lade', externalRef: 'edge-abc123', kind: 'inverter',
      name: null, status: 'active', lastSeenAt: null, createdAt: null,
    };
    render(<LadevorgaengeSection site={site} devices={[box]} />);

    const links = await screen.findAllByRole('link', { name: /Geräteseite/ });
    expect(links.map((l) => l.getAttribute('href'))).toContain(
      '#/anlage/s-lade/geraet/edge-abc123/cp-saeule-1',
    );
    // Ohne Klick bleibt sichtbar, was man ohne Klick braucht…
    expect(screen.getByText('saeule-1')).toBeTruthy();
    // …und der Aufklapper ist weg (ein Ort, nicht zwei).
    expect(screen.queryByText('Technische Angaben')).toBeNull();
  });

  it('bietet ohne eindeutige Box KEINEN Weg an - und behält den Aufklapper', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue(charging);
    render(<LadevorgaengeSection site={site} />);
    await screen.findByText('Hof Nord · Stecker A');
    expect(screen.queryByRole('link', { name: /Geräteseite/ })).toBeNull();
    expect(screen.getAllByText('Technische Angaben').length).toBeGreaterThan(0);
  });

  it('verweist vom Anbinden-Kasten in die Zentrale (dort wohnt der Weg)', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue(charging);
    render(<LadevorgaengeSection site={site} />);
    const link = await screen.findByRole('link', { name: /Alle Geräte dieser Anlage/ });
    expect(link.getAttribute('href')).toBe('#/anlage/s-lade/modell');
  });

  it('nennt ohne Ladesäule den WEG, nie eine erfundene Adresse', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
    render(<LadevorgaengeSection site={site} />);
    expect(await screen.findByText('Noch keine Ladesäule verbunden')).toBeTruthy();
    // Der Satz steht zweimal: als leere-Liste-Hinweis und im Anbinden-Kasten.
    expect(screen.getAllByText(/verbinden sich selbst/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/ws:\/\//);
  });
});
