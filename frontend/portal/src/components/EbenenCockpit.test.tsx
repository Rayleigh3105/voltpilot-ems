import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EbenenCockpit } from './EbenenCockpit';
import { api, type Earnings, type Overview, type OverviewSite, type Site } from '../api';
import type { Route } from '../nav';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';

/**
 * Die UEMS-Übersicht einer Ebene (`EbenenCockpit`) — bis zum Nachzug von main
 * (d1d67b97e) der Ebenen-Zweig des Portfolio-Cockpits. Die Fälle stammen aus
 * `PortfolioCockpit.test.tsx` (uems) und laufen unverändert gegen die Ebene;
 * die Flotte ohne Ebene prüft `PortfolioCockpit.test.tsx`.
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'overview').mockResolvedValue(MONITORING_OVERVIEW);
  vi.spyOn(api, 'earnings').mockResolvedValue(LEERE_ERLOESE);
  vi.spyOn(api, 'tenantCockpitLayout').mockResolvedValue({
    vorgabe: null,
    eigen: null,
  } as never);
  // Die Vorschau der aufgeklappten Zeile lädt LAZY; ohne diese zwei Attrappen
  // liefe sie in einen echten Abruf.
  vi.spyOn(api, 'schedule').mockResolvedValue({ slots: [], deviceId: null } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'standortZuordnungVorschlag').mockResolvedValue({ gruppen: [], anlagenZahl: 0 });
});

const UNTERNEHMEN = { art: 'unternehmen' as const, name: 'Kunststoffwerk Ahrenberg GmbH', standorte: [] };

function renderCockpit(
  props: Partial<Parameters<typeof EbenenCockpit>[0]> = {},
  onNavigate: (r: Route) => void = () => {},
) {
  return render(
    <EbenenCockpit
      sites={FILIALEN}
      ebene={UNTERNEHMEN}
      onNavigate={onNavigate}
      onReload={() => {}}
      betriebsart="endkunde"
      titel="Portfolio"
      {...props}
    />,
  );
}

it('AP-02 A6/A15 · Vorschläge ergänzen Karte und Chips, Bestätigen räumt beides ab', async () => {
  vi.spyOn(api, 'funktionen').mockResolvedValue({
    unternehmen: {
      messen: { laeuft_an: 0, standorte: 0, text: null },
      steuern: { laeuft_an: 0, standorte: 0, text: null },
    },
    standorte: [],
  } as never);
  vi.spyOn(api, 'standortZuordnungVorschlag').mockResolvedValueOnce({
    anlagenZahl: 2,
    gruppen: [
      { name: 'Werk Ahrenberg – Halle 1', zeitzone: 'Europe/Berlin', adresse: null,
        anlagen: [{ vorschlagId: 'v1', anlageId: 'f1', anlageName: 'Filiale Nord', gueltigAb: '2025-01-03' }] },
      { name: 'Werk Ahrenberg – Halle 2', zeitzone: 'Europe/Berlin', adresse: null,
        anlagen: [{ vorschlagId: 'v2', anlageId: 'f2', anlageName: 'Filiale Süd', gueltigAb: '2025-06-04' }] },
    ],
  }).mockResolvedValue({ gruppen: [], anlagenZahl: 0 });
  const bestaetigen = vi.spyOn(api, 'standortZuordnungBestaetigen').mockResolvedValue({ standortIds: ['st1'], zuordnungen: 2 });
  const reload = vi.fn();
  renderCockpit({
    onReload: reload,
    ebene: UNTERNEHMEN,
  });

  expect(await screen.findByText('Noch nicht zugeordnet')).toBeTruthy();
  expect(screen.getAllByText('noch nicht zugeordnet')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Standorte einrichten' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Alle Anlagen zusammenlegen' }));
  const felder = screen.getAllByRole('textbox');
  fireEvent.change(felder[0], { target: { value: 'Werk Ahrenberg' } });
  fireEvent.change(felder[1], { target: { value: 'Gewerbering 7' } });
  fireEvent.change(felder[2], { target: { value: '84123' } });
  fireEvent.change(felder[3], { target: { value: 'Ahrenberg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zuordnung bestätigen' }));

  await waitFor(() => expect(bestaetigen).toHaveBeenCalledWith({ gruppen: [{
    name: 'Werk Ahrenberg', zeitzone: 'Europe/Berlin',
    adresse: { strasse: 'Gewerbering 7', plz: '84123', ort: 'Ahrenberg', land: 'DE' },
    vorschlagIds: ['v1', 'v2'],
  }] }));
  await waitFor(() => expect(screen.queryByText('Noch nicht zugeordnet')).toBeNull());
  expect(reload).toHaveBeenCalled();
}, 20_000);

it('AP-02 O18 · ein reiner Betriebskunde lädt und sieht die Vorschlagsfläche nicht', async () => {
  setSelbstauskunft(rechteSeed('CB').me);
  const holen = vi.mocked(api.standortZuordnungVorschlag);
  renderCockpit();

  await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
  expect(holen).not.toHaveBeenCalled();
  expect(screen.queryByText('Noch nicht zugeordnet')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Standorte einrichten' })).toBeNull();
});
