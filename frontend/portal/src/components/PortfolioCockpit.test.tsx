import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PortfolioCockpit } from './PortfolioCockpit';
import { api, type Earnings, type Overview, type OverviewSite, type Site } from '../api';

/**
 * Die Übersicht der Flotten-Ebene — Stufe 4 (E5), seit „Meine Anlagen neu"
 * (Ü1–Ü5 = A) vier Blöcke: Statuszeile, Heute, Jetzt, Ihre Anlagen. Seit dem
 * Entscheid vom 25.09.2026 gilt das für JEDE Betriebsart; Kennzahlen-Leiste
 * und Anlagen-Tabelle sind aus dieser Fläche entfallen.
 *
 * Der Leitfall bleibt §4.3 C („Gewerbe, reines Monitoring, 3 Filialen"): bis
 * Stufe 3 standen dort drei von vier Kacheln auf „—".
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

/** Textinhalt mit normalen statt geschützten Leerzeichen. */
const nb = (t: string | null | undefined) => (t ?? '').replace(/ /g, ' ');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'overview').mockResolvedValue(MONITORING_OVERVIEW);
  vi.spyOn(api, 'earnings').mockResolvedValue(LEERE_ERLOESE);
  vi.spyOn(api, 'tenantCockpitLayout').mockResolvedValue({
    vorgabe: null,
    eigen: null,
  } as never);
  // Die Tageskurven lesen die Tages-Historie; ohne sie entfallen die Kurven,
  // die Fläche bleibt.
  vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
});

function renderCockpit(props: Partial<Parameters<typeof PortfolioCockpit>[0]> = {}) {
  return render(
    <PortfolioCockpit sites={FILIALEN} onReload={() => {}} titel="Portfolio" {...props} />,
  );
}

/** Öffnet „Anpassen" über das ⋯-Menü und liefert die Anpassen-Leiste. */
async function anpassenOeffnen(): Promise<HTMLElement> {
  await screen.findByRole('region', { name: 'Ihre Anlagen' });
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Anpassen/ }));
  return screen.findByRole('region', { name: 'Cockpit anpassen' });
}

describe('EINE Übersicht für jede Betriebsart (Entscheid 25.09.2026)', () => {
  it('zeigt die vier Blöcke - keine Kennzahlen-Leiste, keine Anlagen-Tabelle', async () => {
    renderCockpit();
    expect(await screen.findByRole('region', { name: 'Ihre Anlagen' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Jetzt' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Kennzahlen Ihrer Anlagen' })).toBeNull();
  });
});

describe('§4.3 C: der Nur-Monitoring-Kunde sieht ECHTE Zahlen statt „—, —, —"', () => {
  it('sagt „Jetzt" in Worten - summiert nur über frische Messwerte', async () => {
    renderCockpit();
    const jetzt = await screen.findByRole('region', { name: 'Jetzt' });
    // Σ 13,7 + 13,7 + 13,8 = 41,2 kW.
    expect(nb(jetzt.textContent)).toMatch(/Sonne\s*41,2 kW\s*alle 3 Anlagen/);
    expect(nb(jetzt.textContent)).toMatch(/Netz\s*18,8 kW\s*Bezug/);
    // Kein Speicher in der Flotte → kein Speicher-Wert, nie „—".
    expect(jetzt.textContent).not.toMatch(/Speicher/);
  });

  it('summiert Erzeugung und Verbrauch des Tages im Block „Heute"', async () => {
    renderCockpit();
    const heute = await screen.findByRole('region', { name: 'Heute' });
    // Σ Energie des Tages - Energie darf man summieren.
    expect(nb(heute.textContent)).toMatch(/Erzeugt 312,0 kWh/);
    expect(nb(heute.textContent)).toMatch(/Verbraucht 540,0 kWh/);
  });

  it('zeigt jede Filiale als Karte mit Satz und Zahlen und verlinkt genau ihre Anlage', async () => {
    renderCockpit();
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    const nord = within(anlagen).getByText('Filiale Nord').closest('a') as HTMLAnchorElement;
    expect(nord.getAttribute('href')).toBe('#/anlage/f1');
    expect(nb(nord.textContent)).toMatch(/Bezieht Strom aus dem Netz/);
    expect(nb(nord.textContent)).toMatch(/Sonne\s*13,7 kW/);
    const sued = within(anlagen).getByText('Filiale Süd').closest('a') as HTMLAnchorElement;
    expect(sued.getAttribute('href')).toBe('#/anlage/f2');
  });
});

describe('der KOPF: EINE Zeile statt einer Karte', () => {
  it('sagt den Zustand der Flotte als Statuszeile unter dem Titel', async () => {
    renderCockpit();
    expect(await screen.findByText('Alles in Ordnung · 3 Anlagen')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeTruthy();
  });

  it('NENNT die stumme Anlage - mit Weg dorthin, und tönt nur dann', async () => {
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
    const zeile = (await screen.findByText(/Hof Lindenberg meldet sich/)).closest('p') as HTMLElement;
    expect(zeile.className).toContain('is-warn');
    expect(within(zeile).getByRole('link', { name: 'Zur Anlage ›' }).getAttribute('href')).toBe(
      '#/anlage/f2',
    );
  });

  it('trägt keine Begrüßung mehr - der Titel kommt von der Route', async () => {
    renderCockpit({ titel: 'Meine Anlagen' });
    expect(await screen.findByRole('heading', { name: 'Meine Anlagen', level: 1 })).toBeTruthy();
    expect(screen.queryByText(/Guten Tag/)).toBeNull();
  });

  it('legt Anpassen, Anlage anlegen und Gerät hinzufügen ins „···"-Menü - keine großen Knöpfe', async () => {
    renderCockpit();
    await screen.findByRole('region', { name: 'Ihre Anlagen' });
    expect(screen.queryByRole('button', { name: 'Anpassen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getByText('Anpassen')).toBeTruthy();
    expect(screen.getByText('Anlage anlegen')).toBeTruthy();
    expect(screen.getByText('Gerät hinzufügen')).toBeTruthy();
  });
});

describe('eine Anwendung mehr bringt ihren Wert mit', () => {
  it('mit laufendem Speicher-Fahrplan steht der Ladestand JE ANLAGE, nie gemittelt', async () => {
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
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    // Der Ladestand steht bei SEINER Anlage - 100 % beim Haus, 20 % beim
    // Betrieb. Es gibt keinen Flotten-Wert, weder das ungewichtete Mittel
    // 60 % noch das gewichtete 26 % (Captain 25.08.2026).
    const haus = within(anlagen).getByText('Haus').closest('a') as HTMLElement;
    const betrieb = within(anlagen).getByText('Betrieb').closest('a') as HTMLElement;
    expect(nb(haus.textContent)).toMatch(/Speicher\s*100 %/);
    expect(nb(betrieb.textContent)).toMatch(/Speicher\s*20 %/);
    const jetzt = screen.getByRole('region', { name: 'Jetzt' });
    expect(nb(jetzt.textContent)).not.toMatch(/60 %|26 %/);
    expect(screen.queryByText('nach Speichergröße gewichtet')).toBeNull();
  });
});

describe('die Ehrlichkeit der leeren Flotte', () => {
  it('stellt ohne Messwerte keinen „Jetzt"-Block mit „—" auf - die Anlagen stehen trotzdem da', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue({
      ...MONITORING_OVERVIEW,
      sites: [
        overviewSite({ id: 'neu1', name: 'Neu 1', anwendungen: ['monitoring'] }),
        overviewSite({ id: 'neu2', name: 'Neu 2', anwendungen: ['monitoring'] }),
      ],
      totals: { ...MONITORING_OVERVIEW.totals, sites: 2 },
    } as unknown as Overview);
    renderCockpit({ sites: FILIALEN.slice(0, 2) });
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    expect(within(anlagen).getByText('Neu 1')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Jetzt' })).toBeNull();
    // Fehlend ist keine Null.
    expect(nb(screen.getByRole('region', { name: 'Heute' }).textContent)).not.toMatch(/0,00 €/);
  });

  it('ein Kunde ohne Anlage bekommt den Einstieg, nie eine leere Übersicht', async () => {
    renderCockpit({ sites: [] });
    expect(await screen.findByText('Noch keine Anlage')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ihre Anlagen' })).toBeNull();
  });
});

describe('Anpassen im Scope KUNDE (Stufe 3, wiederverwendet)', () => {
  it('lädt und speichert das Layout der KUNDEN-Fläche, nie das einer Anlage', async () => {
    const laden = vi.spyOn(api, 'tenantCockpitLayout');
    renderCockpit();
    await screen.findByRole('region', { name: 'Ihre Anlagen' });
    expect(laden).toHaveBeenCalledWith('portfolio');
  });

  it('verspricht KEINEN Stern - das Portfolio hat keine Bühne', async () => {
    // Eine Anleitung, die einen Knopf nennt, den es hier nicht gibt, schickt
    // den Kunden auf die Suche; der Server lehnt auf dieser Fläche jeden
    // `lead` ohnehin ab.
    renderCockpit();
    const leiste = await anpassenOeffnen();
    expect(within(leiste).getByText(/Ordnen Sie die Bausteine/).textContent).not.toContain('Stern');
  });

  it('ordnet die Bausteine in EINER Liste, nie in Kachel-Hüllen', async () => {
    renderCockpit();
    await anpassenOeffnen();
    expect(document.querySelector('.vp-anpassen-liste')).toBeTruthy();
    expect(document.querySelector('.vp-anpassen-huelle')).toBeNull();
  });

  it('sagt an einem UNBEWEGLICHEN Baustein, WO er steht', async () => {
    // Ein „fest" ohne Begründung ist eine Sperre ohne Grund.
    renderCockpit();
    await anpassenOeffnen();
    expect(screen.getByText('Der Block „Ihre Anlagen" steht immer zuletzt.')).toBeTruthy();
    expect(screen.queryByText(/Anlagen-Tabelle/)).toBeNull();
  });

  it('der Reset SAGT sein Ziel - ohne mit dem Verlust zu drohen', async () => {
    renderCockpit();
    const leiste = await anpassenOeffnen();
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
    // Seit #503 steht über der Flotten-Ebene die Krume UND ein Reiter
    // „Übersicht" — eine sichtbare dritte Nennung wäre die Dopplung, die
    // dieses Haus nicht macht. Die Überschrift BLEIBT (Sprungziel), die
    // Statuszeile führt sichtbar.
    renderCockpit({ titelBereitsGenannt: true });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Portfolio' });
    expect(h1.className).toContain('vp-sr-only');
    expect(screen.getByText('Alles in Ordnung · 3 Anlagen')).toBeTruthy();
  });
});

describe('Heute: Ergebnis und VoltPilot-Steuerung (Ü1–Ü5 = A)', () => {
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

  it('führt mit Ergebnis heute und der Kachel VoltPilot-Steuerung', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(ERLOESE_HEUTE);
    renderCockpit({ titel: 'Meine Anlagen' });
    const heute = await screen.findByRole('region', { name: 'Heute' });
    await within(heute).findByText(/VoltPilot-Steuerung/);
    // (2 + 4 − 0,5) + (1 + 2 − 0,5) = 8,00 € — die Anlage ohne Preise fehlt, zählt nie als 0.
    expect(nb(heute.textContent)).toMatch(/\+ 8,00 €/);
    expect(nb(heute.textContent)).toMatch(/\+ 0,50 €/);
    // Nie die Admin-Zahl gegen „ohne Speicher".
    expect(nb(heute.textContent)).not.toMatch(/1,20/);
  });

  it('eine Anlage ohne Tageszahl zeigt „—" in ihrer Karte, nie 0', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(ERLOESE_HEUTE);
    renderCockpit();
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    await within(screen.getByRole('region', { name: 'Heute' })).findByText(/VoltPilot-Steuerung/);
    const west = within(anlagen).getByText('Filiale West').closest('a') as HTMLElement;
    expect(nb(west.textContent)).toMatch(/Heute\s*—/);
  });
});
