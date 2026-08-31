import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.getAllByText('Lädt').length).toBeGreaterThan(0);
    // Warten ist kein Fehler - aber es nennt seinen Grund.
    expect(screen.getByText(/wartet - Budget vergeben/)).toBeTruthy();

    // Der Ausfall-Schutz zeigt die nachrechenbare Zeile.
    expect(
      screen.getByText(/6 Stecker × 15 kW \+ höchste Gebäudelast 180 kW = 270 kW < Grenze 277 kW/),
    ).toBeTruthy();

    // Die getrennte Säule nennt die FOLGE, nicht nur die Tatsache.
    expect(screen.getByText(/begrenzt sich dabei aber selbst/)).toBeTruthy();
  });

  /*
    Der Nebenbefund aus `vp-verbraucher-cockpit-k1` §1.5: die Box hält
    `charging` auch für eine Säule auf TRUE, die UNSER Lastmanagement gerade
    auf 0 kW hält. Vor diesem Fix stand in EINER Zeile „lädt · wartet - Budget
    vergeben" - Zustandswort und Grund widersprachen sich.
  */
  it('sagt über eine ausgebremste Säule NICHT „lädt" - Wort und Grund passen zusammen', async () => {
    vi.spyOn(api, 'siteChargers').mockResolvedValue({
      budget: charging.budget,
      chargers: [
        {
          ...charging.chargers[0],
          connectors: [
            {
              connectorId: 1,
              status: 'SuspendedEVSE',
              charging: true, // die Box: die Sitzung lebt, die Zuteilung bleibt
              allocatedKw: 0,
              powerKw: null, // diese Säule meldet keine MeterValues
              reason: 'budget',
              reasonText: 'wartet - Budget vergeben',
              sessionSince: '2026-08-20T08:41:00Z',
            },
          ],
        },
      ],
    });
    render(<LadevorgaengeSection site={site} />);

    expect(await screen.findByText('Eingesteckt · wartet')).toBeTruthy();
    expect(screen.getByText(/wartet - Budget vergeben/)).toBeTruthy();
    // Das eigentliche Versprechen: nirgends auf dieser Seite steht „lädt".
    expect(screen.queryByText('Lädt')).toBeNull();
    expect(screen.queryByText('lädt')).toBeNull();
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

  /*
    P7 (Konzept §4.5): der Weg vom Ladevorgang zum Fahrzeug-Profil. Er ist der
    Ort, an dem ein Kunde eine Karte BENENNT - „dieser Ladevorgang war …".
  */
  describe('Fahrzeug benennen (P7)', () => {
    const CARD = 'tagref_1f2e3d4c5b6a798877665544';
    const mitKarte = {
      budget: charging.budget,
      chargers: [
        {
          ...charging.chargers[0],
          connectors: [{ ...charging.chargers[0].connectors[0], tagRef: CARD }],
        },
      ],
    };

    it('nennt die unbenannte Karte bei ihrer Kurzform und bietet das Benennen an', async () => {
      vi.spyOn(api, 'siteChargers').mockResolvedValue(mitKarte);
      vi.spyOn(api, 'siteFahrzeuge').mockResolvedValue({ fahrzeuge: [{ tagRef: CARD }] });
      render(<LadevorgaengeSection site={site} />);
      expect(await screen.findByText(/Karte 1f2e… · Lädt wie der Ladepunkt/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Fahrzeug benennen' })).toBeTruthy();
    });

    it('nennt die benannte Karte samt Steuerart und bietet das Ändern an', async () => {
      vi.spyOn(api, 'siteChargers').mockResolvedValue(mitKarte);
      vi.spyOn(api, 'siteFahrzeuge').mockResolvedValue({
        fahrzeuge: [{ tagRef: CARD, name: 'Dienstwagen', steuerart: { quelle: 'sofort' } }],
      });
      render(<LadevorgaengeSection site={site} />);
      expect(await screen.findByText('Dienstwagen · Sofort laden')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Fahrzeug' })).toBeTruthy();
    });

    // ⚠ Der Klartext der Karte steht NIRGENDS - das Portal bekommt ihn nie.
    it('öffnet den Dialog und zeigt nie mehr als die Kurzform des Pseudonyms', async () => {
      vi.spyOn(api, 'siteChargers').mockResolvedValue(mitKarte);
      vi.spyOn(api, 'siteFahrzeuge').mockResolvedValue({ fahrzeuge: [{ tagRef: CARD }] });
      render(<LadevorgaengeSection site={site} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Fahrzeug benennen' }));
      expect(await screen.findByRole('button', { name: 'Speichern' })).toBeTruthy();
      expect(document.body.textContent).not.toContain(CARD);
      expect(document.body.textContent).not.toContain('3d4c5b6a');
    });

    // ⚠ Ohne gemeldetes Pseudonym gibt es keinen Knopf - eine Säule, die keine
    // Karte nennt, sagt nichts über ein Auto.
    it('bietet ohne gemeldete Karte GAR KEINEN Fahrzeug-Weg an', async () => {
      vi.spyOn(api, 'siteChargers').mockResolvedValue(charging);
      vi.spyOn(api, 'siteFahrzeuge').mockResolvedValue({ fahrzeuge: [] });
      render(<LadevorgaengeSection site={site} />);
      await screen.findByText('Hof Nord · Stecker A');
      expect(screen.queryByRole('button', { name: /Fahrzeug/ })).toBeNull();
    });

    // ⚠ Fail-soft: ein älteres Backend kennt die Route nicht - dann rendert die
    // Seite zeichengleich wie vor P7.
    it('rendert unverändert, wenn die Fahrzeug-Route fehlt', async () => {
      vi.spyOn(api, 'siteChargers').mockResolvedValue(mitKarte);
      vi.spyOn(api, 'siteFahrzeuge').mockRejectedValue(new Error('404'));
      render(<LadevorgaengeSection site={site} />);
      await screen.findByText('Hof Nord · Stecker A');
      // Die Karte lädt nachweislich - der Weg bleibt trotzdem offen (die
      // Sichtung hat derselbe Herzschlag serverseitig geschrieben).
      expect(screen.getByRole('button', { name: 'Fahrzeug benennen' })).toBeTruthy();
    });
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
