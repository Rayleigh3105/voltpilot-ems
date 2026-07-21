import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AnlageSeite } from './AnlagenPage';
import { api, type Site } from '../api';
import * as adaptive from '../useAdaptiveLive';
import * as surfaceHook from '../useAnlageSurface';
import { anlageSurface, type AnlageSurfaceInput, type SurfaceEntity } from '../surface';

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
 * 2. **Der Modul-Stapel** erscheint für eine migrierte Anlage in der
 *    kanonischen Reihenfolge, jeder Block mit „von"-Tag, plus die beiden NEUEN
 *    Blöcke und die ruhige Toolbox-Zeile.
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

function stubApi() {
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

describe('Der Modul-Stapel einer migrierten Anlage', () => {
  it('rendert die Blöcke in kanonischer Reihenfolge, jeweils mit „von"-Tag', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-stack')).toBeTruthy());

    // Das feste v4-Zonen-Raster ist abgelöst.
    expect(container.querySelector('.vp-anlage-dash')).toBeNull();

    const titles = [...container.querySelectorAll('.vp-block-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Lastspitze', 'Energiefluss', 'Handel', 'Eigenverbrauch', 'Geräte-Automatik']);

    const tags = [...container.querySelectorAll('.vp-block-from')].map((n) => n.textContent);
    expect(tags).toContain('Modus: Marktvermarktung');
    expect(tags).toContain('Modus: Eigenverbrauch');
    expect(tags).toContain('Entitäten');
  });

  it('platziert die Erlös-Komposition (M4) als Geld-Block', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-streams-block')).toBeTruthy());
    expect(container.querySelector('.vp-streams-from')?.textContent).toBe('Erlös-Komposition');
  });

  it('führt mit dem Peak-Band (N-äre Führungsregel)', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-stack')).toBeTruthy());
    const leads = [...container.querySelectorAll('.vp-block-lead')];
    expect(leads).toHaveLength(1);
    expect(leads[0].querySelector('.vp-block-title')?.textContent).toBe('Lastspitze');
  });

  it('bietet den Telemetrie-Verlauf als BASIS-Drill-in und die Erlöse getrennt', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-stack')).toBeTruthy());
    const drills = [...container.querySelectorAll('.vp-block-drill')].map((n) => n.textContent);
    // Basis-Tiefe (in JEDEM Modus) ...
    expect(drills.some((t) => t?.includes('Verlauf'))).toBe(true);
    expect(drills.some((t) => t?.includes('Live im Detail'))).toBe(true);
    // ... und die Modus-Tiefen an ihren Blöcken.
    expect(drills.some((t) => t?.includes('Lastspitzen im Detail'))).toBe(true);
    expect(drills.some((t) => t?.includes('Ganzer Fahrplan'))).toBe(true);
    expect(drills.some((t) => t?.includes('Steuerung'))).toBe(true);
    // Die Erlös-Historie gehört dem Geld-Block (M4 rendert sie selbst, sobald
    // eine zugerechnete Zahl vorliegt) - NICHT dem Basis-Block.
    const hub = container.querySelector('.vp-block-drills');
    expect(hub?.textContent).not.toContain('Erlöse im Detail');
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

  it('eine Privat-Anlage zeigt weder Peak- noch Handel-Block', async () => {
    mockAdaptive(true);
    mockSurface({
      ...MULTI,
      signals: { ...MULTI.signals!, hasLeistungspreis: false },
      config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false },
    });
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-stack')).toBeTruthy());
    const titles = [...container.querySelectorAll('.vp-block-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Energiefluss', 'Eigenverbrauch', 'Geräte-Automatik']);
  });
});
