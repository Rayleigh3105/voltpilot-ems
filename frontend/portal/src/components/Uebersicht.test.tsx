import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EbenenCockpit } from './EbenenCockpit';
import { PortfolioCockpit } from './PortfolioCockpit';
import { StandortUebersichtPage } from '../pages/StandortUebersichtPage';
import { api, type Earnings, type Funktionen, type Overview, type OverviewSite, type Site } from '../api';
import catalog from '../anwendungen/catalog.json';
import { berlinDay } from '../fleet';
import { GELD_BAUSTEINE } from '../portfolioCockpit';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import { FIXTURE_IDS, ahrenbergHeute, werkAhrenberg, werkLindach } from '../test/standorteFixtures';
import { versorgungAhrenberg, versorgungLindach } from '../test/versorgungFixtures';
import { standortRoute } from '../nav';

/**
 * Die Unternehmens- und Standort-Übersicht GERENDERT (UEMS AP-01 IP-6): das
 * Portfolio-Cockpit mit Ebene, gegen das Referenzunternehmen Ahrenberg am
 * 20.10.2026 10:15 (A7) — und der Beweis der Geld-Regel am Messkunden (A13).
 */

const JETZT = new Date();
const { an1, an2, an3, st1 } = FIXTURE_IDS;
const ALLE_ANWENDUNGEN = catalog.anwendungen.map((a) => a.id);

function site(id: string, name: string): Site {
  return {
    id,
    name,
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    netzladenErlaubt: false,
    maxFeedInKw: null,
  } as Site;
}

function zeile(over: Partial<OverviewSite> & { id: string; name: string }): OverviewSite {
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

const live = (gridKw: number, pvKw: number | null = null, socPct: number | null = null) => ({
  ts: JETZT.toISOString(),
  pvKw,
  loadKw: null,
  gridKw,
  socPct,
});

const SITES = [site(an1, 'Werk Ahrenberg – Halle 1'), site(an2, 'Werk Ahrenberg – Halle 2'), site(an3, 'Werk Lindach')];

function ahrenbergOverview(anwendungen: string[] = ['monitoring'], lindachRollen = { pv: 0, storage: 0 }): Overview {
  return {
    sites: [
      zeile({
        id: an1,
        name: 'Werk Ahrenberg – Halle 1',
        anwendungen: ['monitoring', 'speicher-fahrplan', 'lastspitzenkappung'],
        live: live(312.4, 168.2, 62),
        roleCounts: { pv: 1, storage: 1, consumer: 0, grid: 1 },
      }),
      zeile({
        id: an2,
        name: 'Werk Ahrenberg – Halle 2',
        anwendungen,
        live: live(96.5),
        roleCounts: { pv: 0, storage: 0, consumer: 1, grid: 1 },
      }),
      zeile({
        id: an3,
        name: 'Werk Lindach',
        anwendungen,
        live: live(38.7),
        energyToday: { pvKwh: null, loadKwh: 412, gridImportKwh: 412, gridExportKwh: null },
        roleCounts: { ...lindachRollen, consumer: 0, grid: 1 },
      }),
    ],
    totals: { sites: 3, devices: 3, online: 3, plannedSavingsTodayEur: null, liveSitesCovered: 3 },
    dailySavings: [],
  } as Overview;
}

/** Der Server liefert für JEDE Anlage Geld — Vorteil und vermiedene Spitze. */
function geldFuerAlle(): Earnings {
  const heute = berlinDay(JETZT);
  return {
    range: 'day',
    sites: SITES.map((s) => ({
      id: s.id,
      name: s.name,
      plantKind: 'eigenverbrauch',
      dailySaved: [{ day: heute, savedEur: 12.5, savedSteuerungEur: 12.5 }],
      peakShaving: { avoidedEur: 4800, avoidedKw: 40 },
    })),
    totals: {},
  } as unknown as Earnings;
}

function mocks(o: { overview: Overview; earnings?: Earnings; funktionen?: Funktionen }) {
  vi.spyOn(api, 'overview').mockResolvedValue(o.overview);
  vi.spyOn(api, 'earnings').mockResolvedValue(o.earnings ?? ({ range: 'day', sites: [], totals: {} } as unknown as Earnings));
  vi.spyOn(api, 'funktionen').mockResolvedValue(o.funktionen ?? ahrenbergFunktionen());
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'tenantCockpitLayout').mockResolvedValue({ vorgabe: null, eigen: null } as never);
  vi.spyOn(api, 'schedule').mockResolvedValue({ slots: [], deviceId: null } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'versorgung').mockImplementation(async (id) =>
    id === FIXTURE_IDS.st1 ? versorgungAhrenberg() : versorgungLindach(),
  );
});

/** Die Funktionen unter der Kopfzeile der Standort-Übersicht (nicht die Karte „Funktionen"). */
function funktionenImKopf(): HTMLElement {
  const kopf = document.querySelector<HTMLElement>('.vp-portfolio-funktionen');
  if (!kopf) throw new Error('Die Funktionen unter der Kopfzeile fehlen.');
  return kopf;
}

function renderUnternehmen(onNavigate = vi.fn()) {
  render(
    <EbenenCockpit
      sites={SITES}
      onNavigate={onNavigate}
      onReload={() => {}}
      betriebsart="endkunde"
      titel="Portfolio"
      titelBereitsGenannt
      ebene={{ art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH', standorte: ahrenbergHeute().standorte }}
    />,
  );
  return onNavigate;
}

describe('A7 · die Unternehmens-Übersicht IST das Portfolio-Cockpit', () => {
  it('Kopfzeile: Name, Standorte, Anlagen, wer steuert, Datenlage', async () => {
    mocks({ overview: ahrenbergOverview() });
    renderUnternehmen();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Kunststoffwerk Ahrenberg GmbH' });
    // Die Ebene nennt der Titel sichtbar — anders als das Portfolio unter seinen Reitern.
    expect(h1.className).not.toContain('vp-sr-only');
    expect(await screen.findByText('2 Standorte · 3 Anlagen · 1 steuert')).toBeTruthy();
    expect(screen.getByText('3 von 3 Anlagen liefern Daten')).toBeTruthy();
  });

  it('Kennzahlen-Leiste: Netzbezug jetzt 447,6 kW über alle drei Anlagen', async () => {
    mocks({ overview: ahrenbergOverview() });
    renderUnternehmen();
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    await waitFor(() => expect(within(leiste).getByText('Netzbezug jetzt')).toBeTruthy());
    expect(within(leiste).getByText('447,6')).toBeTruthy();
    expect(within(leiste).getByText('PV jetzt')).toBeTruthy();
  });

  it('die Anlagen-Tabelle ist nach Standorten gruppiert, jede Karte zeigt Messen — Steuern nur, wo eine Anlage steuert', async () => {
    mocks({ overview: ahrenbergOverview() });
    const onNavigate = renderUnternehmen();
    await waitFor(() => expect(screen.getAllByTestId('standort-gruppe')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Wird geladen …')).toBeNull());
    const [ahrenberg, lindach] = screen.getAllByTestId('standort-gruppe');

    expect(within(ahrenberg).getByText('2 Anlagen · 1 steuert · 2 von 2 Anlagen liefern Daten')).toBeTruthy();
    expect(within(ahrenberg).getByText('Eingerichtet am 01.10.2026 · 15 von 16 Messstellen liefern Daten')).toBeTruthy();
    expect(within(ahrenberg).getByText('Läuft mit Werk Ahrenberg – Halle 1')).toBeTruthy();

    expect(within(lindach).getByText('1 Anlage · reine Messung · 1 von 1 Anlage liefert Daten')).toBeTruthy();
    const zustaende = [...lindach.querySelectorAll('li')].map((li) => li.textContent);
    // Steuern-Regel: an Werk Lindach steuert keine Anlage — keine Zeile „Noch nicht eingerichtet“ (löst PR 771 ab).
    expect(zustaende).toEqual(['Messen & AuswertenEingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten']);
    expect(lindach.textContent).not.toMatch(/steuer/i);

    // Die Anlagen stehen unter IHREM Standort: jede Gruppe ist ein eigener Zeilen-Block.
    const bloecke = [...document.querySelectorAll('tbody')];
    expect(bloecke).toHaveLength(2);
    expect(within(bloecke[0]).getByRole('button', { name: 'Anlage Werk Ahrenberg – Halle 2 öffnen' })).toBeTruthy();
    expect(within(bloecke[1]).getByRole('button', { name: 'Anlage Werk Lindach öffnen' })).toBeTruthy();
    expect(within(bloecke[1]).queryByRole('button', { name: /Halle/ })).toBeNull();

    // Der Name der Karte führt zur Standort-Übersicht.
    fireEvent.click(within(ahrenberg).getByRole('button', { name: 'Standort Werk Ahrenberg öffnen' }));
    expect(onNavigate).toHaveBeenCalledWith(standortRoute(st1));
  });

  it('sind die Funktionen nicht abrufbar, sagt die Karte das — statt einer leeren Stelle', async () => {
    mocks({ overview: ahrenbergOverview() });
    vi.spyOn(api, 'funktionen').mockRejectedValue(new Error('offline'));
    renderUnternehmen();
    await waitFor(() =>
      expect(screen.getAllByText('Der Zustand der Funktionen ist gerade nicht abrufbar.')).toHaveLength(3),
    );
    // Je Standort-Karte einmal — und die Karte „Funktionen" (AP-01 IP-8) sagt es auch.
    expect(
      within(screen.getByTestId('funktionen-karte')).getByText('Der Zustand der Funktionen ist gerade nicht abrufbar.'),
    ).toBeTruthy();
    // Über Steuerung wird dann nichts behauptet.
    expect(screen.getByText('2 Standorte · 3 Anlagen')).toBeTruthy();
  });
});

describe('die Standort-Übersicht ist DIESELBE Seite mit einem Filter', () => {
  it('F15 zeigt die abgeleitete Versorgung und nennt eine Messstelle außerhalb eines Gebäudes', async () => {
    mocks({ overview: ahrenbergOverview() });
    render(
      <StandortUebersichtPage standort={werkAhrenberg()} sites={SITES} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const karte = await screen.findByTestId('versorgung');
    expect(within(karte).getByText('Halle 1 ← System Halle 1 (NA-1)')).toBeTruthy();
    expect(within(karte).getByText('Verwaltung ← System Halle 1 (NA-1)')).toBeTruthy();
    expect(within(karte).getByText('Halle 2 ← System Halle 2 (NA-2)')).toBeTruthy();
    expect(within(karte).getByText('1 Messstelle außerhalb eines Gebäudes')).toBeTruthy();
  });

  it('Werk Lindach: nur seine Anlage, nur ihre Zahlen, nur Messen unter der Kopfzeile', async () => {
    mocks({ overview: ahrenbergOverview() });
    render(
      <StandortUebersichtPage standort={werkLindach()} sites={SITES} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    await waitFor(() => expect(within(leiste).getByText('38,7')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Anlage Werk Lindach öffnen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Anlage Werk Ahrenberg/ })).toBeNull();
    expect(screen.getByText('1 von 1 Anlage liefert Daten')).toBeTruthy();
    // Unter der Kopfzeile — dieselben Sätze stehen seit IP-8 auch in der Karte „Funktionen".
    await waitFor(() =>
      expect(within(funktionenImKopf()).getByText('Eingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten')).toBeTruthy(),
    );
    // Eine Seite, ein Standort — keine Standort-Gruppen darüber.
    expect(screen.queryByTestId('standort-gruppe')).toBeNull();
  });

  it('Werk Ahrenberg unter dem Unternehmen: Netzbezug nur über Halle 1 und Halle 2', async () => {
    mocks({ overview: ahrenbergOverview() });
    render(
      <StandortUebersichtPage standort={werkAhrenberg()} sites={SITES} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    // 312,4 + 96,5 = 408,9 — Werk Lindach zählt hier nicht.
    await waitFor(() => expect(within(leiste).getByText('408,9')).toBeTruthy());
    await waitFor(() => expect(within(funktionenImKopf()).getByText('Läuft mit Werk Ahrenberg – Halle 1')).toBeTruthy());
    // Je Anlage steht der Netzbezug als Spalte „Netz jetzt".
    expect(screen.getByRole('columnheader', { name: /Netz jetzt/ })).toBeTruthy();
  });
});

describe('A13 · Geld-Regel: ein Messkunde sieht NIRGENDS eine Geldzahl', () => {
  const GELD_LABELS = catalog.bausteine.filter((b) => (GELD_BAUSTEINE as readonly string[]).includes(b.id)).map((b) => b.label);
  const GELD_TEXT = /€|\bEUR\b|Vorteil|Mehrerlös|Erlös|Spitze/;

  it('Werk Lindach (Peter Hollerbach): jede Anwendung läuft, der Server liefert Geld — die Seite zeigt keins', async () => {
    const overview = ahrenbergOverview(ALLE_ANWENDUNGEN);
    overview.sites = overview.sites.filter((s) => s.id === an3);
    mocks({
      overview,
      earnings: geldFuerAlle(),
      funktionen: ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }),
    });
    render(
      <StandortUebersichtPage
        standort={werkLindach()}
        sites={[SITES[2]]}
        onNavigate={() => {}}
        onReload={() => {}}
        betriebsart="endkunde"
      />,
    );
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    await waitFor(() => expect(within(leiste).getByText('Netzbezug jetzt')).toBeTruthy());
    await waitFor(() =>
      expect(within(funktionenImKopf()).getByText('Eingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten')).toBeTruthy(),
    );
    // Erst wenn auch das Geld des Servers angekommen ist, ist das Nicht-Zeigen ein Beweis.
    await waitFor(() => expect(api.earnings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    expect(document.body.textContent).not.toMatch(GELD_TEXT);
    for (const label of GELD_LABELS) expect(screen.queryByText(label)).toBeNull();

    // Auch im Anpassen-Modus steht kein Geld-Baustein zur Wahl.
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await waitFor(() => expect(screen.getByText('Netzbezug gesamt')).toBeTruthy());
    expect(document.body.textContent).not.toMatch(GELD_TEXT);
    for (const label of GELD_LABELS) expect(screen.queryByText(label)).toBeNull();
  });

  it('… und dieselbe Seite MIT Erzeuger zeigt das Geld — die Regel beisst nur beim Messkunden', async () => {
    const overview = ahrenbergOverview(ALLE_ANWENDUNGEN, { pv: 1, storage: 0 });
    overview.sites = overview.sites.filter((s) => s.id === an3);
    mocks({ overview, earnings: geldFuerAlle(), funktionen: ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }) });
    render(
      <StandortUebersichtPage standort={werkLindach()} sites={[SITES[2]]} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    await waitFor(() => expect(within(leiste).getByText('Vorteil heute')).toBeTruthy());
    expect(document.body.textContent).toMatch(GELD_TEXT);
  });

  it('Unternehmens-Übersicht Ahrenberg: Vorteil „nur Halle 1", die Zeilen von Halle 2 und Lindach ohne Geld', async () => {
    mocks({ overview: ahrenbergOverview(), earnings: geldFuerAlle() });
    renderUnternehmen();
    const leiste = await screen.findByRole('group', { name: 'Kennzahlen Ihrer Anlagen' });
    await waitFor(() => expect(within(leiste).getByText('Vorteil heute')).toBeTruthy());
    expect(within(leiste).getByText('gegenüber Speicher ohne Steuerung · 1 von 3 Anlagen · nur Werk Ahrenberg – Halle 1')).toBeTruthy();
    // 4.800 € vermiedene Spitze EINMAL (Halle 1), nicht dreimal.
    expect(within(leiste).getByText(/4\.800/)).toBeTruthy();
    expect(within(leiste).queryByText(/14\.400/)).toBeNull();

    await waitFor(() => expect(screen.getAllByTestId('standort-gruppe')).toHaveLength(2));
    const zeileVon = (name: string) =>
      screen.getByRole('button', { name: `Anlage ${name} öffnen` }).closest('tr') as HTMLElement;
    expect(zeileVon('Werk Ahrenberg – Halle 1').textContent).toMatch(/12,50/);
    expect(zeileVon('Werk Ahrenberg – Halle 2').textContent).not.toMatch(/12,50/);
    expect(zeileVon('Werk Lindach').textContent).not.toMatch(/12,50/);
    // Die Karte von Werk Lindach trägt kein Geld.
    const lindach = screen.getAllByTestId('standort-gruppe')[1];
    expect(lindach.textContent).not.toMatch(GELD_TEXT);
  });
});

/**
 * UEMS AP-01 IP-8 · die Karte „Funktionen" (E5 = A, E6 = C) und der Leerzustand
 * der Standort-Übersicht. Seit IP-10a ist „Halle 2 aufnehmen“ der bewusste
 * Einstieg in den Assistenten; Messen bleibt bis zu seinem eigenen Einstieg ein Hinweis.
 */
describe('AP-01 IP-8 · die Karte „Funktionen" und der Leerzustand der Standort-Übersicht', () => {
  it('Unternehmens-Übersicht: je Standort Zustand und der eine bewusste Steuern-Einstieg', async () => {
    mocks({ overview: ahrenbergOverview() });
    renderUnternehmen();
    const karte = await screen.findByTestId('funktionen-karte');
    await waitFor(() => expect(within(karte).getByText('Werk Ahrenberg – Halle 2 aufnehmen')).toBeTruthy());
    expect(within(karte).getByRole('heading', { level: 2, name: 'Funktionen' })).toBeTruthy();
    expect(within(karte).getByText('Läuft an 2 von 2 Standorten')).toBeTruthy();
    expect(within(karte).getByText('Läuft an 1 von 2 Standorten')).toBeTruthy();
    // Steuern-Regel: Werk Lindach steht nicht im Abschnitt „Steuern & Optimieren“ — kein „einrichten“.
    expect(within(karte).queryByText(/Werk Lindach einrichten/)).toBeNull();
    expect(karte.querySelector('[data-funktion="steuern"]')?.textContent).not.toContain('Werk Lindach');
    expect(within(karte).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Werk Ahrenberg – Halle 2 aufnehmen',
      'Standort anhalten',
    ]);
    expect(within(karte).queryAllByRole('link')).toHaveLength(0);
  });

  it('Standort-Übersicht: dieselbe Karte für EINEN Standort, ohne seinen Namen und ohne „läuft an"', async () => {
    const overview = ahrenbergOverview();
    overview.sites = overview.sites.filter((s) => s.id !== an3);
    mocks({ overview });
    render(
      <StandortUebersichtPage standort={werkAhrenberg()} sites={SITES.slice(0, 2)} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const karte = await screen.findByTestId('funktionen-karte');
    await waitFor(() => expect(within(karte).getByText('Werk Ahrenberg – Halle 2 aufnehmen')).toBeTruthy());
    expect(within(karte).queryByText('Werk Lindach')).toBeNull();
    expect(within(karte).queryByText(/^Läuft an \d/)).toBeNull();
    expect(within(karte).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Werk Ahrenberg – Halle 2 aufnehmen',
      'Standort anhalten',
    ]);
  });

  it('Leerzustand: ein Standort ohne Anlage nennt Grund und Schritt — kein Knopf, keine leere Tabelle', async () => {
    // Werk Lindach ist angelegt, AN-3 noch nicht — Werk Ahrenberg hat seine zwei Hallen.
    const lindach = funktionWerkLindach('bestand');
    lindach.steuern.anlagen = [];
    const overview = ahrenbergOverview();
    overview.sites = overview.sites.filter((s) => s.id !== an3);
    mocks({ overview, funktionen: ahrenbergFunktionen({ standorte: [lindach], messen: 'bestand' }) });
    const { container } = render(
      <StandortUebersichtPage
        standort={werkLindach({ anlagen: [], anlagenZahl: 0 })}
        sites={SITES.slice(0, 2)}
        onNavigate={() => {}}
        onReload={() => {}}
        betriebsart="endkunde"
      />,
    );
    const titel = await screen.findByRole('heading', { name: 'Werk Lindach ist angelegt — noch ohne Anlage' });
    const leer = titel.closest('.vp-empty') as HTMLElement;
    expect(leer.textContent).toContain('Messwerte kommen über eine Anlage: an ihr verbinden Sie die Box und binden die Zähler an.');
    expect(leer.textContent).toContain(
      'Nächster Schritt: Eine Anlage anlegen oder eine bestehende Anlage diesem Standort zuordnen (in der Anlage unter Einstellungen).',
    );
    expect(within(leer).queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('table')).toBeNull();
  });

  it('ohne Ebene (das Portfolio eines Betreibers) gibt es die Karte nicht', async () => {
    mocks({ overview: ahrenbergOverview() });
    // Seit main d1d67b97e ist die Flotte die Übersicht in vier Blöcken (ohne Leiste/Tabelle).
    render(<PortfolioCockpit sites={SITES} onReload={() => {}} titel="Portfolio" titelBereitsGenannt />);
    await screen.findByRole('region', { name: 'Ihre Anlagen' });
    expect(screen.queryByTestId('funktionen-karte')).toBeNull();
  });
});

/**
 * Steuern-Regel je Ebene (Captain über firstmate 003/004, 15.09.2026: „Von
 * steuern soll beim messen eigentlich noch nicht die rede sein."): ein Standort
 * spricht von Steuern, sobald eine seiner Anlagen teilnimmt; einer, an dem keine
 * teilnimmt, schweigt ganz. Das Wort „reine Messung" bleibt. (Die Anlage Halle 2,
 * die auf ihrer eigenen Steuerungsseite schweigt: `pages/SteuerungSection.test.tsx`.)
 */
describe('Steuern-Regel · je Ebene am Referenzunternehmen Ahrenberg', () => {
  it('Werk Lindach (keine Anlage steuert): die Standort-Übersicht zeigt NIRGENDS ein Wort über Steuern', async () => {
    mocks({ overview: ahrenbergOverview() });
    const { container } = render(
      <StandortUebersichtPage standort={werkLindach()} sites={SITES} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const karte = await screen.findByTestId('funktionen-karte');
    await waitFor(() =>
      expect(within(karte).getByText('Eingerichtet am 15.10.2026 · 3 von 3 Messstellen liefern Daten')).toBeTruthy(),
    );
    expect(karte.querySelector('[data-funktion="steuern"]')).toBeNull();
    expect(container.textContent).not.toMatch(/steuer/i);
  });

  it('Werk Ahrenberg spricht, weil Halle 1 steuert — Kopf und Karte nennen „Steuern & Optimieren“', async () => {
    const overview = ahrenbergOverview();
    overview.sites = overview.sites.filter((s) => s.id !== an3);
    mocks({ overview });
    render(
      <StandortUebersichtPage standort={werkAhrenberg()} sites={SITES.slice(0, 2)} onNavigate={() => {}} onReload={() => {}} betriebsart="endkunde" />,
    );
    const karte = await screen.findByTestId('funktionen-karte');
    await waitFor(() => expect(within(karte).getByText('Werk Ahrenberg – Halle 2 aufnehmen')).toBeTruthy());
    expect(within(karte).getByRole('heading', { level: 3, name: 'Steuern & Optimieren' })).toBeTruthy();
    expect(within(funktionenImKopf()).getByText('Steuern & Optimieren')).toBeTruthy();
    expect(within(funktionenImKopf()).getByText('Läuft mit Werk Ahrenberg – Halle 1')).toBeTruthy();
  });

  it('der reine Messkunde (nirgends steuert eine Anlage): die Unternehmens-Übersicht sagt „reine Messung“ — und sonst kein Wort über Steuern', async () => {
    // Die Fixture teilt Halle 1 zwischen den Aufrufen — nur an einer Kopie drehen.
    const f = structuredClone(ahrenbergFunktionen());
    const st = f.standorte[0].steuern;
    st.zustand = 'kein_objekt';
    st.text = 'Steuern & Optimieren — noch nicht eingerichtet';
    st.anlagen[0].teilnahme.zustand = 'kein_objekt';
    f.unternehmen.steuern = { laeuft_an: 0, standorte: 2, text: 'Steuern & Optimieren läuft an 0 von 2 Standorten' };
    mocks({ overview: ahrenbergOverview(), funktionen: f });
    renderUnternehmen();
    expect(await screen.findByText('2 Standorte · 3 Anlagen · reine Messung')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('standort-gruppe')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Wird geladen …')).toBeNull());
    expect(screen.getByTestId('funktionen-karte').querySelector('[data-funktion="steuern"]')).toBeNull();
    // Das eine Wort, das bleibt, benennt, was der Kunde ist.
    expect((document.body.textContent ?? '').replaceAll('reine Messung', '')).not.toMatch(/steuer/i);
  });
});
