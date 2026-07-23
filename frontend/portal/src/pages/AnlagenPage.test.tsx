import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { AnlageSeite } from './AnlagenPage';
import { api, type Site } from '../api';
import * as adaptive from '../useAdaptiveLive';
import * as surfaceHook from '../useAnlageSurface';
import { anlageSurface, type AnlageSurfaceInput, type SurfaceEntity } from '../surface';
import { periodLabel } from '../anlage';

/**
 * M3 (#531) — der Cockpit-Beweis.
 *
 * Zwei Dinge werden hier festgenagelt:
 *
 * 1. **Das v1-Invariant (report §6.2, nicht verhandelbar):** eine nie migrierte
 *    Anlage (keine Entitäten, keine Modi, geschlossene `useAdaptiveLive`-Weiche)
 *    rendert das heutige Standard-Cockpit — und M3 steuert dazu **kein einziges
 *    Element** bei. Der Beweis ist stärker als eine Marker-Prüfung: dieselbe
 *    Anlage wird einmal mit einer NULL-Surface (älteres Backend / Ladefehler)
 *    und einmal mit der leeren Projektion gerendert; beide DOMs müssen
 *    **zeichengleich** sein und dürfen keinen M3-Knoten enthalten.
 * 2. **Das Live-Cockpit (Portal v3 M2)** erscheint für eine migrierte Anlage:
 *    der WIEDERVERWENDETE Energiefluss als Hero (kein neues „Energie-Rad"),
 *    Autarkie/Eigenverbrauch als Ringe, das Widget-Raster in kanonischer
 *    Reihenfolge, das Widget-Modal am `document.body` und die ruhige
 *    Toolbox-Zeile.
 */

// jsdom kennt weder ResizeObserver (useContainerWidth/EnergyFlow) noch das
// Canvas-Backend, das ECharts braucht - beides ist für diesen Beweis egal.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

const site: Site = {
  id: 's-1',
  name: 'Hof Lindenberg',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: true,
  maxFeedInKw: null,
};

function entity(id: string, entityType: string, channels: string[]): SurfaceEntity {
  return {
    id,
    entityType,
    label: null,
    capabilities: { measure: channels.map((channel) => ({ channel })) },
  };
}

/** Eine migrierte Multi-Modus-Anlage (Peak + Markt + EV + Automation). */
const MULTI: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: true,
  },
  config: {
    plantKind: 'eigenverbrauch',
    tarifArt: 'dynamisch',
    netzladenErlaubt: true,
    leistungspreisEurKw: 95,
  },
  flows: [
    {
      flowId: 'f-wb',
      name: 'Wallbox nur bei PV-Überschuss',
      activeVersion: 1,
      latestLifecycle: 'active',
      latestDocument: {
        schema_version: '1.0',
        name: 'Wallbox nur bei PV-Überschuss',
        runtime: 'edge',
        nodes: [
          { id: 'n1', type: 'vp.entity.read', type_version: '1.0.0' },
          { id: 'n2', type: 'vp.entity.control', type_version: '1.0.0' },
        ],
        edges: [],
        triggers: [],
      },
    },
  ],
  entities: [
    entity('e-batt', 'battery-hybrid', ['soc_pct']),
    entity('e-pv', 'producer', ['pv_power_kw']),
    entity('e-grid', 'grid-meter', ['power_kw']),
    entity('e-wb', 'wallbox', ['power_kw']),
  ],
};

/** Keine Entitäten, keine Modi — die nie migrierte v1-Anlage. */
const LEER: AnlageSurfaceInput = {
  signals: {
    hasStorage: false,
    hasPv: false,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' },
  entities: [],
};

function stubApi(overviewSite: Record<string, unknown> = {}) {
  vi.spyOn(api, 'siteEntities').mockResolvedValue({
    registry: null,
    entities: [],
    localSetup: [],
    staleOnDevice: [],
  } as never);
  vi.spyOn(api, 'overview').mockResolvedValue({
    sites: [
      {
        id: 's-1',
        name: 'Hof Lindenberg',
        plantKind: 'eigenverbrauch',
        netzladenErlaubt: true,
        deviceCount: 1,
        onlineCount: 1,
        waitingCount: 0,
        worstStatus: 'online',
        lastSeenAt: new Date().toISOString(),
        batteryWithoutDevice: false,
        live: null,
        plannedSavingsTodayEur: null,
        ...overviewSite,
      },
    ],
    totals: {} as never,
    dailySavings: [],
  } as never);
  vi.spyOn(api, 'earnings').mockResolvedValue({
    range: 'month',
    from: '',
    to: '',
    sites: [],
    totals: {} as never,
  } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'weather').mockResolvedValue({ points: [] } as never);
  vi.spyOn(api, 'schedule').mockResolvedValue({
    planId: null,
    deviceId: null,
    generatedAt: null,
    slotMinutes: 15,
    savingsEur: null,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    slots: [],
  } as never);
  vi.spyOn(api, 'forecastQuality').mockResolvedValue({ planAccuracy: [] } as never);
  vi.spyOn(api, 'telemetry').mockResolvedValue([] as never);
  vi.spyOn(api, 'history').mockResolvedValue({
    totals: { autarkiePct: 82, eigenverbrauchPct: 64, gridImportKwh: 1.8 },
    buckets: [],
    protocol: [],
    plan: [],
  } as never);
}

function mockAdaptive(adaptiveOn: boolean) {
  vi.spyOn(adaptive, 'useAdaptiveLive').mockReturnValue({
    topology: null,
    profile: null,
    adaptive: adaptiveOn,
    loading: false,
  } as never);
}

function mockSurface(input: AnlageSurfaceInput | null) {
  vi.spyOn(surfaceHook, 'useAnlageSurface').mockReturnValue({
    surface: input ? anlageSurface(input) : null,
    loading: false,
  });
}

function renderSeite() {
  return render(
    <AnlageSeite
      sites={[site]}
      devices={[]}
      route={{ page: 'anlagen', siteId: 's-1', sub: null }}
      onNavigate={() => {}}
      onReload={() => {}}
      site={site}
      onOpenSub={() => {}}
      onBackToList={null}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  stubApi();
});

describe('v1-Invariant: eine nie migrierte Anlage rendert das heutige Cockpit', () => {
  it('rendert das v4-Zonen-Dashboard und KEINEN M3-Knoten', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-dash')).toBeTruthy());
    // Die heutigen Bausteine sind da ...
    expect(container.querySelector('.vp-zone-money')).toBeTruthy();
    expect(container.querySelector('.vp-dash-fahrplan')).toBeTruthy();
    expect(container.querySelector('.vp-detail-grid')).toBeTruthy();
    // ... und M3 steuert nichts bei.
    expect(container.querySelector('.vp-stack')).toBeNull();
    expect(container.querySelector('.vp-block')).toBeNull();
    expect(container.querySelector('.vp-toolbox-line')).toBeNull();
    expect(container.querySelector('.vp-block-from')).toBeNull();
  });

  it('ist zeichengleich, egal ob das Read-Model geladen wurde oder nicht', async () => {
    // (a) älteres Backend / Ladefehler: gar keine Surface.
    mockAdaptive(false);
    mockSurface(null);
    const a = renderSeite();
    await waitFor(() => expect(a.container.querySelector('.vp-anlage-dash')).toBeTruthy());
    const withoutSurface = a.container.innerHTML;
    a.unmount();

    // (b) Surface geladen, aber leer (keine Entitäten, keine Modi).
    vi.restoreAllMocks();
    stubApi();
    mockAdaptive(false);
    mockSurface(LEER);
    const b = renderSeite();
    await waitFor(() => expect(b.container.querySelector('.vp-anlage-dash')).toBeTruthy());
    expect(b.container.innerHTML).toBe(withoutSurface);
  });

  it('bleibt v1, solange die Topologie-Weiche zu ist - auch MIT Entitäten', async () => {
    mockAdaptive(false);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-dash')).toBeTruthy());
    expect(container.querySelector('.vp-stack')).toBeNull();
  });
});

describe('M5 · Der Leer-Zustand IST der Einrichtungspfad (#533)', () => {
  /** Eine brandneue Anlage: Gerät verbunden, aber noch nie Messdaten. */
  function stubFreshSite() {
    vi.restoreAllMocks();
    stubApi({ lastSeenAt: null, worstStatus: 'waiting', onlineCount: 0, waitingCount: 1 });
  }

  it('rendert die drei Schritte statt eines leeren Cockpits', async () => {
    stubFreshSite();
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-setup-steps')).toBeTruthy());
    expect(container.querySelectorAll('.vp-setup-step')).toHaveLength(3);
    // Kein Platzhalter-Cockpit, kein Modul-Stapel.
    expect(container.querySelector('.vp-anlage-dash')).toBeNull();
    expect(container.querySelector('.vp-stack')).toBeNull();
    // Der Kopf spricht vom Weg, nicht von "offline".
    expect(container.querySelector('.vp-anlage-sentence')?.textContent).toContain(
      'Energie-System zusammen',
    );
  });

  it('tritt zurück, sobald Entitäten da sind (das Cockpit übernimmt)', async () => {
    stubFreshSite();
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    expect(container.querySelector('.vp-setup-steps')).toBeNull();
  });

  it('erscheint NICHT auf einer laufenden v1-Anlage ohne Entitäten', async () => {
    // Das v1-Invariant von der anderen Seite: dieselbe leere Projektion, aber
    // die Anlage misst bereits - ihr Cockpit bleibt unangetastet.
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-dash')).toBeTruthy());
    expect(container.querySelector('.vp-setup-steps')).toBeNull();
  });
});

describe('Portal v3 M2 · Das Live-Cockpit einer migrierten Anlage', () => {
  it('führt mit dem BESTEHENDEN Energiefluss als Hero, nicht mit einem Kartenstapel', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());

    // Das feste v4-Zonen-Raster UND der M3-Kartenstapel sind abgelöst.
    expect(container.querySelector('.vp-anlage-dash')).toBeNull();
    expect(container.querySelector('.vp-stack')).toBeNull();
    // Das Diagramm ist das WIEDERVERWENDETE `EnergyFlow`/`AdaptiveEnergyFlow`
    // (kein neues "Energie-Rad") - erkennbar an seinem Wrapper.
    expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).toBeTruthy();
  });

  it('zeigt Autarkie und Eigenverbrauch als Ringe, die dem Zeitraum folgen', async () => {
    // v3.2 M1: die Ring-Kennzahlen tragen die Periode wie die Geld-Zeile (nicht
    // mehr das feste „heute"). Der Energiefluss selbst bleibt „jetzt gerade".
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-rings')).toBeTruthy());
    const labels = [...container.querySelectorAll('.vp-hero-ring-label')].map((n) => n.textContent);
    // Default-Tab „Monat": die Ringe tragen die Periode des gewählten Zeitraums.
    const now = new Date();
    const period = periodLabel('month', now, now);
    expect(labels).toEqual([`Autarkie · ${period}`, `Eigenverbrauch · ${period}`]);
    // Nie mehr das zeitraum-blinde „heute".
    expect(labels.join(' ')).not.toContain('heute');
  });

  it('lässt die Ringe WEG, wenn der Tageswert fehlt (nie „0 %")', async () => {
    vi.restoreAllMocks();
    stubApi();
    vi.spyOn(api, 'history').mockResolvedValue({
      totals: { autarkiePct: null, eigenverbrauchPct: null, gridImportKwh: null },
      buckets: [],
      protocol: [],
      plan: [],
    } as never);
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    expect(container.querySelector('.vp-hero-rings')).toBeNull();
    expect(container.textContent).not.toContain('0 %');
  });

  it('rendert das Widget-Raster in kanonischer Reihenfolge', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-widgets')).toBeTruthy());
    const labels = [...container.querySelectorAll('.vp-widget-label')].map((n) => n.textContent);
    // Peak führt (leadBlock), dann die Fluss-Kacheln, dann die Modus-Kacheln.
    expect(labels[0]).toBe('Lastspitze');
    expect(labels).toContain('Geräte-Automatik');
    expect(container.querySelectorAll('.vp-widget.is-lead')).toHaveLength(1);
  });

  it('öffnet je Kachel ein Modal mit „Jetzt | Verlauf"', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-widgets')).toBeTruthy());
    const tile = container.querySelector('.vp-widget') as HTMLButtonElement;
    fireEvent.click(tile);
    const modal = document.body.querySelector('.vp-wmodal');
    expect(modal).toBeTruthy();
    const segs = [...document.body.querySelectorAll('.vp-wmodal-segbtn')].map((n) => n.textContent);
    expect(segs).toEqual(['Jetzt', 'Verlauf']);
    // Das Modal hängt am body (Karten haben `overflow: hidden`).
    expect(container.querySelector('.vp-wmodal')).toBeNull();
    fireEvent.click(document.body.querySelector('.vp-wmodal-close') as HTMLButtonElement);
    expect(document.body.querySelector('.vp-wmodal')).toBeNull();
  });

  it('eine Privat-Anlage hat weder Lastspitze- noch Handel-Kachel', async () => {
    mockAdaptive(true);
    mockSurface({
      ...MULTI,
      signals: { ...MULTI.signals!, hasLeistungspreis: false },
      config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false },
    });
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-widgets')).toBeTruthy());
    const labels = [...container.querySelectorAll('.vp-widget-label')].map((n) => n.textContent);
    expect(labels).not.toContain('Lastspitze');
    expect(labels).not.toContain('Handel');
    expect(labels).toContain('Eigenverbrauch');
  });

  it('schließt mit der ruhigen Toolbox-Zeile, ohne einen Modus zu bewerben', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-toolbox-line')).toBeTruthy());
    const line = container.querySelector('.vp-toolbox-line')?.textContent ?? '';
    expect(line).toContain('Ihre Anlage kann mehr');
    expect(line).toContain('Modus hinzufügen');
    expect(line).not.toMatch(/Lastspitzen|Marktvermarktung|Eigenverbrauch/);
  });
});

describe('Portal v3.2 M1 · die Ring-KPIs folgen dem Zeitraum-Tab, der Fluss bleibt live', () => {
  /** Autarkie je Zeitraum, damit ein Tab-Wechsel den Wert SICHTBAR ändert. */
  function rangeAwareHistory() {
    vi.spyOn(api, 'history').mockImplementation((_id, range) =>
      Promise.resolve({
        totals: {
          autarkiePct:
            range === 'day' ? 40 : range === 'month' ? 64 : range === 'year' ? 71 : null,
          eigenverbrauchPct:
            range === 'day' ? 30 : range === 'month' ? 55 : range === 'year' ? 60 : null,
          gridImportKwh: 1.8,
        },
        buckets: [],
        protocol: [],
        plan: [],
      } as never),
    );
  }

  function tab(container: HTMLElement, label: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('.vp-period-tabs button')].find(
      (b) => b.textContent === label,
    );
    return btn as HTMLButtonElement;
  }

  function ringLabels(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll('.vp-hero-ring-label')].map((n) => n.textContent);
  }

  function ringValues(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll('.vp-hero-ring svg text')].map((n) => n.textContent);
  }

  it('wechselt Kennzahl UND Etikett mit Heute/Monat/Jahr — Gesamt hat keinen Ring', async () => {
    rangeAwareHistory();
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-rings')).toBeTruthy());

    const now = new Date();

    // Default „Monat": 64 % unter dem Monatsetikett.
    await waitFor(() => expect(ringValues(container)[0]).toContain('64'));
    expect(ringLabels(container)).toEqual([
      `Autarkie · ${periodLabel('month', now, now)}`,
      `Eigenverbrauch · ${periodLabel('month', now, now)}`,
    ]);

    // „Jahr": der Wert UND das Etikett folgen dem Tab.
    fireEvent.click(tab(container, 'Jahr'));
    await waitFor(() => expect(ringValues(container)[0]).toContain('71'));
    expect(ringLabels(container)).toEqual([
      `Autarkie · ${periodLabel('year', now, now)}`,
      `Eigenverbrauch · ${periodLabel('year', now, now)}`,
    ]);

    // „Heute": das Tagesetikett, der Tageswert.
    fireEvent.click(tab(container, 'Heute'));
    await waitFor(() => expect(ringValues(container)[0]).toContain('40'));
    expect(ringLabels(container)[0]).toBe('Autarkie · Heute');

    // „Gesamt": kein All-Zeit-Historie-Endpunkt → keine Ringe (nie ein falscher
    // Wert), aber der Energiefluss bleibt live sichtbar.
    fireEvent.click(tab(container, 'Gesamt'));
    await waitFor(() => expect(container.querySelector('.vp-hero-rings')).toBeNull());
    expect(container.textContent).not.toContain('0 %');
    expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).toBeTruthy();
  });

  it('lässt das Energiefluss-Diagramm über alle Tabs unverändert live', async () => {
    // Der Fluss ist „jetzt gerade" und darf sich beim Tab-Wechsel NICHT ändern.
    rangeAwareHistory();
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).toBeTruthy());
    const flowBefore = container.querySelector('.vp-hero-flow .vp-flow-wrap')?.innerHTML;
    for (const label of ['Heute', 'Jahr', 'Gesamt', 'Monat']) {
      fireEvent.click(tab(container, label));
      await waitFor(() =>
        expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).toBeTruthy(),
      );
    }
    expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')?.innerHTML).toBe(flowBefore);
  });
});
