import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortfolioCockpit } from './PortfolioCockpit';
import { api, type Earnings, type Overview, type OverviewSite, type Site } from '../api';
import type { Route } from '../nav';

/**
 * Anwendungs-Programm Stufe 4 (Captain-Entscheid E5): EINE Portfolio-Fläche
 * für jeden Mehr-Anlagen-Kunden, komponiert aus den Anwendungen seiner
 * Anlagen. Die Betriebsart steuert nur noch DICHTE und TONALITÄT.
 *
 * Der Leitfall ist §4.3 C („Gewerbe, reines Monitoring, 3 Filialen"): bis
 * Stufe 3 standen dort drei von vier Kacheln auf „—", weil die KPI-Zeile fest
 * Geld und Speicher zuerst zeigte.
 */

const JETZT = new Date();

function site(over: Partial<Site> & { id: string; name: string }): Site {
  return {
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    netzladenErlaubt: false,
    maxFeedInKw: null,
    ...over,
  } as Site;
}

function overviewSite(over: Partial<OverviewSite> & { id: string; name: string }): OverviewSite {
  return {
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: JETZT.toISOString(),
    live: null,
    plannedSavingsTodayEur: null,
    ...over,
  } as OverviewSite;
}

/** §4.3 C: drei Filialen, je PV + Netz-Zähler, KEIN Speicher, fester Tarif. */
const FILIALEN: Site[] = [
  site({ id: 'f1', name: 'Filiale Nord' }),
  site({ id: 'f2', name: 'Filiale Süd' }),
  site({ id: 'f3', name: 'Filiale West' }),
];

const MONITORING_OVERVIEW: Overview = {
  sites: [
    overviewSite({
      id: 'f1',
      name: 'Filiale Nord',
      anwendungen: ['monitoring'],
      live: { ts: JETZT.toISOString(), pvKw: 13.7, loadKw: 20, gridKw: 6.3, socPct: null },
      energyToday: { pvKwh: 104, loadKwh: 180, gridImportKwh: 120, gridExportKwh: 8 },
      roleCounts: { pv: 1, storage: 0, consumer: 0, grid: 1 },
    }),
    overviewSite({
      id: 'f2',
      name: 'Filiale Süd',
      anwendungen: ['monitoring'],
      live: { ts: JETZT.toISOString(), pvKw: 13.7, loadKw: 20, gridKw: 6.3, socPct: null },
      energyToday: { pvKwh: 104, loadKwh: 180, gridImportKwh: 120, gridExportKwh: 8 },
      roleCounts: { pv: 1, storage: 0, consumer: 0, grid: 1 },
    }),
    overviewSite({
      id: 'f3',
      name: 'Filiale West',
      anwendungen: ['monitoring'],
      live: { ts: JETZT.toISOString(), pvKw: 13.8, loadKw: 20, gridKw: 6.2, socPct: null },
      energyToday: { pvKwh: 104, loadKwh: 180, gridImportKwh: 120, gridExportKwh: 8 },
      roleCounts: { pv: 1, storage: 0, consumer: 0, grid: 1 },
    }),
  ],
  totals: {
    sites: 3,
    devices: 3,
    online: 3,
    plannedSavingsTodayEur: null,
    liveSitesCovered: 3,
    storageCapacityKwh: null,
    storagePowerKw: null,
  },
  dailySavings: [],
} as unknown as Overview;

const LEERE_ERLOESE = {
  range: 'month',
  from: '',
  to: '',
  sites: [],
  totals: { savedEur: null },
} as unknown as Earnings;

const KOPF = { titel: 'Portfolio', satz: 'Alle Ihre Anlagen auf einen Blick.' };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'overview').mockResolvedValue(MONITORING_OVERVIEW);
  vi.spyOn(api, 'earnings').mockResolvedValue(LEERE_ERLOESE);
  vi.spyOn(api, 'tenantCockpitLayout').mockResolvedValue({
    vorgabe: null,
    eigen: null,
  } as never);
});

function renderCockpit(
  props: Partial<Parameters<typeof PortfolioCockpit>[0]> = {},
  onNavigate: (r: Route) => void = () => {},
) {
  return render(
    <PortfolioCockpit
      sites={FILIALEN}
      onNavigate={onNavigate}
      onReload={() => {}}
      betriebsart="endkunde"
      kopf={KOPF}
      {...props}
    />,
  );
}

describe('§4.3 C: der Nur-Monitoring-Kunde sieht ECHTE Zahlen statt „—, —, —"', () => {
  it('zeigt PV jetzt, Erzeugung, Verbrauch und Netz - summiert über die Filialen', async () => {
    renderCockpit();
    // Σ 13,7 + 13,7 + 13,8 = 41,2 kW
    expect(await screen.findByText('PV jetzt')).toBeTruthy();
    expect(screen.getByText('41,2 kW')).toBeTruthy();
    // Σ Energie des Tages - Energie darf man summieren.
    expect(screen.getByText('Erzeugung heute')).toBeTruthy();
    expect(screen.getByText('312 kWh')).toBeTruthy();
    expect(screen.getByText('Verbrauch heute')).toBeTruthy();
    expect(screen.getByText('540 kWh')).toBeTruthy();
    // Bezug und Einspeisung GETRENNT, nie saldiert.
    expect(screen.getByText('Netzbezug heute')).toBeTruthy();
    expect(screen.getByText('360 kWh')).toBeTruthy();
    expect(screen.getByText('Einspeisung heute')).toBeTruthy();
    expect(screen.getByText('24 kWh')).toBeTruthy();
  });

  it('lässt die Speicher- und Lastspitzen-Kacheln WEG statt sie auf „—" zu stellen', async () => {
    renderCockpit();
    await screen.findByText('PV jetzt');
    // Genau das war der Befund: eine feste KPI-Zeile mit drei Gedankenstrichen.
    expect(screen.queryByText('Speicher gesamt')).toBeNull();
    expect(screen.queryByText('Ladestand')).toBeNull();
    expect(screen.queryByText('Vermiedene Spitze')).toBeNull();
    expect(screen.queryByText('Ladepunkte')).toBeNull();
  });

  it('nennt jede Filiale und springt in genau ihre Anlage', async () => {
    const onNavigate = vi.fn();
    renderCockpit({}, onNavigate);
    const karte = await screen.findByText('Filiale Süd');
    fireEvent.click(karte);
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(JSON.stringify(onNavigate.mock.calls[0][0])).toContain('f2');
  });
});

describe('die Betriebsart steuert NUR die Dichte (E5)', () => {
  it('ein Endkunde bekommt die ruhigen Karten', async () => {
    renderCockpit({ betriebsart: 'endkunde' });
    expect(await screen.findByRole('region', { name: 'Meine Anlagen' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('ein Betreiber bekommt die Tabelle - über DIESELBE Flotte', async () => {
    renderCockpit({ betriebsart: 'betreiber' });
    const tabelle = await screen.findByRole('table');
    expect(within(tabelle).getByText('Anwendungen')).toBeTruthy();
    expect(within(tabelle).getByText('Filiale Nord')).toBeTruthy();
    expect(within(tabelle).getByText('Filiale West')).toBeTruthy();
    // Die KENNZAHLEN sind dieselben - nur die Anlagen-Liste ist dichter.
    expect(screen.getByText('41,2 kW')).toBeTruthy();
    expect(screen.getByText('312 kWh')).toBeTruthy();
  });

  it('die Tabelle lässt eine Spalte WEG, die keine Anlage füllen kann', async () => {
    // Der §4.3-C-Befund eine Ebene tiefer: eine „Ladestand"-Spalte aus lauter
    // „—" ist genau das Bild, gegen das diese Stufe gebaut ist.
    renderCockpit({ betriebsart: 'betreiber' });
    const tabelle = await screen.findByRole('table');
    expect(within(tabelle).queryByText('Ladestand')).toBeNull();
    // Die Pflicht-Spalten stehen weiter.
    expect(within(tabelle).getByText('PV jetzt')).toBeTruthy();
    expect(within(tabelle).getByText('Status')).toBeTruthy();
  });

  it('ein UNBEKANNTER Rahmen rendert die Karten (Bestandsneutralität)', async () => {
    renderCockpit({ betriebsart: null });
    expect(await screen.findByRole('region', { name: 'Meine Anlagen' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('eine Anwendung mehr bringt ihren Baustein mit', () => {
  it('mit laufendem Speicher-Fahrplan erscheint der Speicher - GEWICHTET beschriftet', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue({
      ...MONITORING_OVERVIEW,
      sites: [
        overviewSite({
          id: 'f1',
          name: 'Haus',
          anwendungen: ['monitoring', 'speicher-fahrplan'],
          storageCapacityKwh: 10,
          live: { ts: JETZT.toISOString(), pvKw: 4, loadKw: 2, gridKw: -2, socPct: 100 },
        }),
        overviewSite({
          id: 'f2',
          name: 'Betrieb',
          anwendungen: ['monitoring', 'speicher-fahrplan'],
          storageCapacityKwh: 120,
          live: { ts: JETZT.toISOString(), pvKw: 40, loadKw: 30, gridKw: -10, socPct: 20 },
        }),
      ],
      totals: {
        ...MONITORING_OVERVIEW.totals,
        sites: 2,
        storageCapacityKwh: 130,
        storagePowerKw: 60,
      },
    } as unknown as Overview);
    renderCockpit({ sites: FILIALEN.slice(0, 2) });
    expect(await screen.findByText('Speicher gesamt')).toBeTruthy();
    expect(screen.getByText('130 kWh')).toBeTruthy();
    // (100×10 + 20×120)/130 = 26,15 % - NICHT das ungewichtete Mittel 60 %.
    expect(screen.getByText('26 %')).toBeTruthy();
    expect(screen.queryByText('60 %')).toBeNull();
    // Und die Fläche SAGT, worüber gemittelt wurde.
    expect(screen.getByText('nach Speichergröße gewichtet')).toBeTruthy();
  });
});

describe('die Ehrlichkeit der leeren Flotte', () => {
  it('sagt EINEN ruhigen Satz, statt Kacheln mit „—" aufzureihen', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue({
      ...MONITORING_OVERVIEW,
      sites: [
        overviewSite({ id: 'neu1', name: 'Neu 1', anwendungen: ['monitoring'] }),
        overviewSite({ id: 'neu2', name: 'Neu 2', anwendungen: ['monitoring'] }),
      ],
      totals: { ...MONITORING_OVERVIEW.totals, sites: 2 },
    } as unknown as Overview);
    renderCockpit({ sites: FILIALEN.slice(0, 2) });
    expect(
      await screen.findByText(/Sobald Ihre Anlagen Messwerte liefern/),
    ).toBeTruthy();
    expect(screen.queryByText('PV jetzt')).toBeNull();
    // Die Anlagen selbst stehen trotzdem da - sie sind Pflicht-Baustein.
    expect(screen.getByText('Neu 1')).toBeTruthy();
  });

  it('ein Kunde ohne Anlage bekommt den Einstieg, nie eine leere Tabelle', async () => {
    renderCockpit({ sites: [] });
    expect(await screen.findByText('Noch keine Anlage')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Anpassen im Scope KUNDE (Stufe 3, wiederverwendet)', () => {
  it('lädt und speichert das Layout der KUNDEN-Fläche, nie das einer Anlage', async () => {
    const laden = vi.spyOn(api, 'tenantCockpitLayout');
    renderCockpit();
    await screen.findByText('PV jetzt');
    expect(laden).toHaveBeenCalledWith('portfolio');
  });

  it('bietet „Anpassen" an, sobald die Fläche steht', async () => {
    renderCockpit();
    await screen.findByText('PV jetzt');
    expect(screen.getByRole('button', { name: 'Anpassen' })).toBeTruthy();
  });

  it('verspricht KEINEN Stern - das Portfolio hat keine Bühne', async () => {
    // Eine Anleitung, die einen Knopf nennt, den es hier nicht gibt, schickt
    // den Kunden auf die Suche; der Server lehnt auf dieser Fläche jeden
    // `lead` ohnehin ab.
    renderCockpit();
    await screen.findByText('PV jetzt');
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    const leiste = await screen.findByRole('region', { name: 'Cockpit anpassen' });
    expect(within(leiste).getByText(/Ordnen Sie die Bausteine/).textContent).not.toContain('Stern');
  });
});
