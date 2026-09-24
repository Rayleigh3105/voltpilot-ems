import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortfolioCockpit } from './PortfolioCockpit';
import { api, type Earnings, type Overview, type OverviewSite, type Site } from '../api';
import type { Route } from '../nav';

/**
 * Das Portfolio-Cockpit — Stufe 4 (E5) in der **Revision 2** vom 25.08.2026.
 *
 * Der Leitfall bleibt §4.3 C („Gewerbe, reines Monitoring, 3 Filialen"): bis
 * Stufe 3 standen dort drei von vier Kacheln auf „—". Revision 2 legt darüber
 * die Grammatik des Cockpits — Kopf mit EINER Flotten-Aussage,
 * Kennzahlen-LEISTE statt Icon-Kacheln, EINE Anlagen-Tabelle in zwei Dichten.
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
      // Leiste und Tabelle sind seit „Meine Anlagen neu" die Fläche des
      // BETREIBERS; der Endkunde bekommt die Übersicht (eigener Block unten).
      betriebsart="betreiber"
      titel="Portfolio"
      {...props}
    />,
  );
}

describe('§4.3 C: der Nur-Monitoring-Kunde sieht ECHTE Zahlen statt „—, —, —"', () => {
  it('zeigt PV jetzt, Erzeugung, Verbrauch und Netz - summiert über die Filialen', async () => {
    renderCockpit();
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    // Σ 13,7 + 13,7 + 13,8 = 41,2 kW - und die Einheit steht als EIGENES,
    // leises Feld neben der Zahl, nie in ihr.
    expect(within(leiste).getByText('PV jetzt')).toBeTruthy();
    expect(within(leiste).getByText('41,2')).toBeTruthy();
    // Σ Energie des Tages - Energie darf man summieren.
    expect(within(leiste).getByText('Erzeugung heute')).toBeTruthy();
    expect(within(leiste).getByText('312')).toBeTruthy();
    expect(within(leiste).getByText('Verbrauch heute')).toBeTruthy();
    expect(within(leiste).getByText('540')).toBeTruthy();
    // Bezug und Einspeisung stehen in EINER Zelle und werden nie saldiert.
    const netz = within(leiste).getByText('Netz heute').closest('div')!;
    expect(netz.textContent).toContain('360');
    expect(netz.textContent).toContain('24');
    expect(within(netz).getByText('Bezug · Einspeisung')).toBeTruthy();
  });

  it('lässt die Speicher- und Lastspitzen-Zellen WEG statt sie auf „—" zu stellen', async () => {
    renderCockpit();
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    // Genau das war der Befund: eine feste KPI-Zeile mit drei Gedankenstrichen.
    expect(within(leiste).queryByText('Vermiedene Spitze')).toBeNull();
    expect(within(leiste).queryByText('Ladepunkte')).toBeNull();
    // Und der kumulierte Ladestand gibt es seit Revision 2 gar nicht mehr.
    expect(within(leiste).queryByText(/Ladestand/)).toBeNull();
  });

  it('nennt jede Filiale und springt in genau ihre Anlage', async () => {
    const onNavigate = vi.fn();
    renderCockpit({}, onNavigate);
    // Der Name ist wie die ganze Zeile der direkte Absprung in die Anlage.
    fireEvent.click(await screen.findByRole('button', { name: 'Anlage Filiale Süd öffnen' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(JSON.stringify(onNavigate.mock.calls[0][0])).toContain('f2');
  });

  it('klappt die Vorschau der Zeile auf - und sagt beim Laden, dass sie lädt', async () => {
    renderCockpit();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Details zu Filiale Nord anzeigen' }),
    );
    // Laden und „nichts da" sind zwei verschiedene Auskünfte.
    expect(screen.getByText('Wird geladen …')).toBeTruthy();
    expect(await screen.findByText('Heute geplant')).toBeTruthy();
    expect(screen.getByText('Für heute liegt noch kein Fahrplan vor.')).toBeTruthy();
  });
});

describe('die Betriebsart steuert NUR die Dichte (E5, Revision 2)', () => {
  it('der Betreiber bekommt die kompakte Tabelle, der Endkunde die Übersicht', async () => {
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
    const endkunde = renderCockpit({ betriebsart: 'endkunde' });
    expect(await screen.findByRole('region', { name: 'Ihre Anlagen' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    endkunde.unmount();

    renderCockpit({ betriebsart: 'betreiber' });
    const tabelle = await screen.findByRole('table');
    expect(tabelle.getAttribute('data-dichte')).toBe('kompakt');
    expect(within(tabelle).getByText('Filiale Nord')).toBeTruthy();
    expect(within(tabelle).getByText('Filiale West')).toBeTruthy();
  });

  it('die KENNZAHLEN sind in beiden Dichten dieselben', async () => {
    renderCockpit({ betriebsart: 'betreiber' });
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    expect(within(leiste).getByText('41,2')).toBeTruthy();
    expect(within(leiste).getByText('312')).toBeTruthy();
  });

  it('die Tabelle lässt eine Spalte WEG, die keine Anlage füllen kann', async () => {
    // Der §4.3-C-Befund eine Ebene tiefer: eine „Speicher"-Spalte aus lauter
    // „—" ist genau das Bild, gegen das diese Stufe gebaut ist.
    renderCockpit({ betriebsart: 'betreiber' });
    const tabelle = await screen.findByRole('table');
    expect(within(tabelle).queryByRole('columnheader', { name: /Speicher/ })).toBeNull();
    // Die Pflicht-Spalten stehen weiter.
    expect(within(tabelle).getByRole('columnheader', { name: /PV jetzt/ })).toBeTruthy();
    expect(within(tabelle).getByRole('columnheader', { name: 'Zustand' })).toBeTruthy();
  });

  it('ein UNBEKANNTER Rahmen rendert die komfortable Dichte (Bestandsneutralität)', async () => {
    renderCockpit({ betriebsart: null });
    const tabelle = await screen.findByRole('table');
    expect(tabelle.getAttribute('data-dichte')).toBe('komfortabel');
  });
});

describe('der KOPF: EINE Zeile statt einer Karte', () => {
  it('sagt die Flotten-Aussage als Unterzeile unter dem Titel', async () => {
    renderCockpit();
    expect(await screen.findByText('Alle 3 Anlagen online')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeTruthy();
  });

  it('NENNT die stumme Anlage - und tönt nur dann', async () => {
    const alt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    vi.spyOn(api, 'overview').mockResolvedValue({
      ...MONITORING_OVERVIEW,
      sites: [
        MONITORING_OVERVIEW.sites[0],
        overviewSite({
          id: 'f2',
          name: 'Hof Lindenberg',
          anwendungen: ['monitoring'],
          onlineCount: 0,
          worstStatus: 'stale',
          lastSeenAt: alt.toISOString(),
        }),
      ],
    } as unknown as Overview);
    renderCockpit({ sites: FILIALEN.slice(0, 2) });
    const satz = await screen.findByText(/Hof Lindenberg meldet sich/);
    expect(satz.className).toContain('is-warn');
  });

  it('trägt keine Begrüßung mehr - der Titel kommt von der Route', async () => {
    renderCockpit({ titel: 'Meine Anlagen' });
    expect(await screen.findByRole('heading', { name: 'Meine Anlagen', level: 1 })).toBeTruthy();
    expect(screen.queryByText(/Guten Tag/)).toBeNull();
  });

  it('legt die zwei Anlege-Aktionen ins „···"-Menü', async () => {
    renderCockpit();
    await screen.findByRole('table');
    // Sie sind erreichbar, aber sie führen den Kopf nicht mehr an.
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getByText('Anlage anlegen')).toBeTruthy();
    expect(screen.getByText('Gerät hinzufügen')).toBeTruthy();
  });
});

describe('eine Anwendung mehr bringt ihren Baustein mit', () => {
  it('mit laufendem Speicher-Fahrplan erscheint der Ladestand - JE ANLAGE, nie kumuliert', async () => {
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
    const tabelle = await screen.findByRole('table');
    expect(within(tabelle).getByRole('columnheader', { name: /Speicher/ })).toBeTruthy();
    // Der Ladestand steht bei SEINER Anlage - 100 % beim Haus, 20 % beim
    // Betrieb. Es gibt keinen Flotten-Wert mehr, weder das ungewichtete
    // Mittel 60 % noch das gewichtete 26 % (Captain 25.08.2026).
    const zeilen = within(tabelle).getAllByRole('row');
    const haus = zeilen.find((r) => r.textContent?.includes('Haus'))!;
    const betrieb = zeilen.find((r) => r.textContent?.includes('Betrieb'))!;
    expect(haus.textContent).toContain('100');
    expect(betrieb.textContent).toContain('20');
    const leiste = screen.getByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    expect(within(leiste).queryByText(/Ladestand|Speicher/)).toBeNull();
    expect(screen.queryByText('nach Speichergröße gewichtet')).toBeNull();
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
    expect(screen.queryByRole('group', { name: 'Kennzahlen Ihrer Anlagen' })).toBeNull();
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
    await screen.findByRole('table');
    expect(laden).toHaveBeenCalledWith('portfolio');
  });

  it('bietet „Anpassen" an, sobald die Fläche steht', async () => {
    renderCockpit();
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Anpassen' })).toBeTruthy();
  });

  it('verspricht KEINEN Stern - das Portfolio hat keine Bühne', async () => {
    // Eine Anleitung, die einen Knopf nennt, den es hier nicht gibt, schickt
    // den Kunden auf die Suche; der Server lehnt auf dieser Fläche jeden
    // `lead` ohnehin ab.
    renderCockpit();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    const leiste = await screen.findByRole('region', { name: 'Cockpit anpassen' });
    expect(within(leiste).getByText(/Ordnen Sie die Bausteine/).textContent).not.toContain('Stern');
  });

  it('ordnet ZELLEN und SPALTEN, nie Kachel-Hüllen', async () => {
    // Revision 2: die Bausteine sind Zellen einer Leiste und Spalten einer
    // Tabelle - eine Hülle um eine Tabellenspalte gibt es nicht.
    renderCockpit();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await screen.findByRole('region', { name: 'Cockpit anpassen' });
    expect(document.querySelector('.vp-anpassen-liste')).toBeTruthy();
    expect(document.querySelector('.vp-anpassen-huelle')).toBeNull();
  });

  it('sagt an einem UNBEWEGLICHEN Baustein, WO er steht', async () => {
    // Ein „fest" ohne Begründung ist eine Sperre ohne Grund.
    renderCockpit();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await screen.findByRole('region', { name: 'Cockpit anpassen' });
    expect(screen.getByText('Die Anlagen-Tabelle steht immer zuletzt.')).toBeTruthy();
  });

  it('der Reset SAGT sein Ziel - ohne mit dem Verlust zu drohen', async () => {
    renderCockpit();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    const leiste = await screen.findByRole('region', { name: 'Cockpit anpassen' });
    expect(leiste.textContent).toContain('Danach gilt wieder der VoltPilot-Standard');
    expect(leiste.textContent).not.toContain('wird verworfen');
  });
});

describe('Der Kopf und die Reiter der Ebene (#503)', () => {
  it('zeigt die Überschrift, solange die Ebene sie nirgends sonst nennt', async () => {
    // Der Endkunden-Wirt trägt keine Reiter — dort ist die Überschrift die
    // einzige Stelle, die die Fläche benennt.
    renderCockpit();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Portfolio' });
    expect(h1.className).not.toContain('vp-sr-only');
  });

  it('macht sie zum reinen Sprungziel, wenn die Reiter sie schon nennen', async () => {
    // Seit #503 steht über der Betreiber-Ebene die Krume „Portfolio" UND ein
    // Reiter „Übersicht" — eine sichtbare dritte Nennung wäre die Dopplung,
    // die dieses Haus nicht macht. Die Überschrift BLEIBT (Sprungziel), die
    // Flotten-Aussage führt sichtbar.
    renderCockpit({ titelBereitsGenannt: true });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Portfolio' });
    expect(h1.className).toContain('vp-sr-only');
    expect(document.querySelector('.vp-portfolio-satz')).not.toBeNull();
  });
});

describe('Meine Anlagen · die Übersicht des Endkunden (Ü1–Ü5 = A)', () => {
  const ERLOESE_HEUTE = {
    range: 'day',
    from: '',
    to: '',
    sites: [
      { id: 'f1', name: 'Filiale Nord', einspeiseErloesEur: 2, eigenverbrauchsWertEur: 4, actualEur: -1.5, savedEur: 0.9, savedSteuerungEur: 0.4, reason: null, series: [], dailySaved: [], coveredSlots: 48 },
      { id: 'f2', name: 'Filiale Süd', einspeiseErloesEur: 1, eigenverbrauchsWertEur: 2, actualEur: -0.5, savedEur: 0.3, savedSteuerungEur: 0.1, reason: null, series: [], dailySaved: [], coveredSlots: 48 },
      { id: 'f3', name: 'Filiale West', einspeiseErloesEur: null, eigenverbrauchsWertEur: null, actualEur: null, reason: 'no_prices', series: [], dailySaved: [], coveredSlots: 0 },
    ],
    totals: { savedEur: null },
  } as unknown as Earnings;
  const nb = (t: string | null | undefined) => (t ?? '').replace(/\u00a0/g, ' ');

  beforeEach(() => {
    vi.spyOn(api, 'earnings').mockResolvedValue(ERLOESE_HEUTE);
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
  });

  it('führt mit Statuszeile, Ergebnis heute und der Kachel VoltPilot-Steuerung', async () => {
    renderCockpit({ betriebsart: 'endkunde', titel: 'Meine Anlagen' });
    expect(await screen.findByText('Alles in Ordnung · 3 Anlagen')).toBeTruthy();
    const heute = screen.getByRole('region', { name: 'Heute' });
    // (2 + 4 − 0,5) + (1 + 2 − 0,5) = 8,00 € — die Anlage ohne Preise fehlt, zählt nie als 0.
    expect(nb(heute.textContent)).toMatch(/\+ 8,00 €/);
    expect(nb(heute.textContent)).toMatch(/VoltPilot-Steuerung/);
    expect(nb(heute.textContent)).toMatch(/\+ 0,50 €/);
    // Nie die Admin-Zahl gegen „ohne Speicher".
    expect(nb(heute.textContent)).not.toMatch(/1,20/);
  });

  it('sagt „Jetzt" in Worten - summiert nur über frische Messwerte', async () => {
    renderCockpit({ betriebsart: 'endkunde' });
    const jetzt = await screen.findByRole('region', { name: 'Jetzt' });
    expect(nb(jetzt.textContent)).toMatch(/Sonne\s*41,2 kW\s*alle 3 Anlagen/);
    expect(nb(jetzt.textContent)).toMatch(/Netz\s*18,8 kW\s*Bezug/);
    // Kein Speicher in der Flotte → kein Speicher-Wert, nie „—".
    expect(jetzt.textContent).not.toMatch(/Speicher/);
  });

  it('zeigt jede Anlage als Karte mit Satz und Zahlen und verlinkt sie', async () => {
    renderCockpit({ betriebsart: 'endkunde' });
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    const nord = within(anlagen).getByText('Filiale Nord').closest('a') as HTMLAnchorElement;
    expect(nord.getAttribute('href')).toBe('#/anlage/f1');
    expect(nb(nord.textContent)).toMatch(/Bezieht Strom aus dem Netz/);
    expect(nb(nord.textContent)).toMatch(/Sonne\s*13,7 kW/);
    const west = within(anlagen).getByText('Filiale West').closest('a') as HTMLElement;
    expect(nb(west.textContent)).toMatch(/Heute\s*—/);
  });

  it('nennt eine stumme Anlage in der Statuszeile - mit Weg dorthin', async () => {
    const alt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    vi.spyOn(api, 'overview').mockResolvedValue({
      ...MONITORING_OVERVIEW,
      sites: [
        MONITORING_OVERVIEW.sites[0],
        overviewSite({ id: 'f2', name: 'Hof Lindenberg', onlineCount: 0, worstStatus: 'stale', lastSeenAt: alt.toISOString() }),
      ],
    } as unknown as Overview);
    renderCockpit({ betriebsart: 'endkunde', sites: FILIALEN.slice(0, 2) });
    const zeile = (await screen.findByText(/Hof Lindenberg meldet sich/)).closest('p') as HTMLElement;
    expect(zeile.className).toContain('is-warn');
    expect(within(zeile).getByRole('link', { name: 'Zur Anlage ›' }).getAttribute('href')).toBe('#/anlage/f2');
  });

  it('legt Anpassen, Anlage anlegen und Gerät hinzufügen ins „···"-Menü - keine großen Knöpfe', async () => {
    renderCockpit({ betriebsart: 'endkunde' });
    await screen.findByRole('region', { name: 'Ihre Anlagen' });
    expect(screen.queryByRole('button', { name: 'Anpassen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getByText('Anpassen')).toBeTruthy();
    expect(screen.getByText('Anlage anlegen')).toBeTruthy();
    expect(screen.getByText('Gerät hinzufügen')).toBeTruthy();
  });
});
