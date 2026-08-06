import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { AnlageSeite } from './AnlagenPage';
import { api, type Site } from '../api';
import * as flowsApi from '../flows/flowsApi';

/**
 * Captain-Nachtrag 06.08.2026 (`fm/vp-erst-alt-layout-r5`) — der v1-Beweis
 * über die ECHTEN Weichen, umgeschrieben für die neue Dreiwertigkeit.
 *
 * Der frühere v1-Zonen-Dashboard-Rückfall ist ERSATZLOS entfallen. `useAdaptiveLive`
 * + `useAnlageSurface` laufen unverändert (die ECHTEN Hooks, nur `api.*` gemockt -
 * `AnlagenPage.test.tsx` (M3) nagelt die reine Ableitung über gemockte Hooks fest,
 * hier geht es um den WEG dorthin über echte Fetch-Zyklen).
 *
 * Vier Dinge werden hier bewiesen:
 *  1. Der eigentliche Fix: solange `/entities`/`/topology`/die Übersichts-Zeile
 *     noch laufen, wird KEIN Layout gewählt - nur der ruhige Zwischenzustand -
 *     und nach dem Auflösen gibt es GENAU EINEN Wechsel (keine Zwischen-
 *     Fassungen, kein Flackern).
 *  2. Der ehrliche "nicht zugeordnet"-Endzustand: eine Anlage, die bereits
 *     misst, aber keine v2-Komponenten hat (die Lücke aus dem Nachtrag §3 -
 *     der automatische Backfill überspringt Mehr-Geräte-Anlagen ohne
 *     eindeutiges Gateway).
 *  3. Ein fehlgeschlagener entscheidungskritischer Abruf ist wie "fertig" zu
 *     behandeln - der ehrliche Fehlerzustand mit Wiederholen, NIE ein
 *     stillschweigend behauptetes Layout.
 *  4. Der M5-Einrichtungspfad bleibt unangetastet (eine Anlage, die noch NIE
 *     Messdaten geliefert hat).
 *
 * Das Cockpit (der Modul-Stapel) selbst wird NICHT angefasst - hier wird nur
 * die Weiche davor bewiesen.
 */

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

const site: Site = {
  id: 's-alt',
  name: 'Bestandsanlage',
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

/** Die Übersichts-Zeile dieser Anlage - `overrides` steuert Setup vs. Daten. */
function overviewSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-alt',
    name: 'Bestandsanlage',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 0,
    onlineCount: 0,
    waitingCount: 0,
    worstStatus: 'waiting',
    lastSeenAt: null,
    live: null,
    plannedSavingsTodayEur: null,
    ...overrides,
  };
}

/** Alles, was die Anlagen-Seite sonst noch lädt — leer, aber wohlgeformt. */
function stubCommonApi(overviewOverrides: Record<string, unknown> = {}) {
  vi.spyOn(api, 'overview').mockResolvedValue({
    sites: [overviewSite(overviewOverrides)],
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
  vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null as never);
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
  vi.spyOn(api, 'telemetry').mockResolvedValue([] as never);
  vi.spyOn(api, 'history').mockResolvedValue({
    totals: {},
    buckets: [],
    protocol: [],
    plan: [],
  } as never);
  // Cockpit+Live merge: the merged home loads the PV-breakdown sources and
  // (lazy) per-entity sparkline histories — both fail-soft, here empty.
  vi.spyOn(api, 'siteSources').mockResolvedValue(null as never);
  vi.spyOn(api, 'entityHistory').mockResolvedValue({
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    channels: {},
  } as never);
  vi.spyOn(api, 'siteProfiles').mockResolvedValue(null as never);
}

/** Eine Bestandsanlage: die v2-Routen antworten, aber es gibt nichts. */
function stubNeverMigrated() {
  vi.spyOn(api, 'topology').mockResolvedValue({
    schemaVersion: '1.0',
    entities: [],
    topology: { nodes: [], flows: [] },
  } as never);
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [], localSetup: [] } as never);
  vi.spyOn(api, 'usageProfile').mockResolvedValue({
    usageProfile: 'private',
    derivedProfile: 'private',
    override: null,
    emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' },
    signals: {
      hasStorage: false,
      hasPv: false,
      hasControllableConsumer: false,
      activeStrategyNodeTypes: [],
      plantKind: 'eigenverbrauch',
      hasLeistungspreis: false,
    },
  } as never);
  vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue({
    list: () => Promise.resolve([]),
  } as never);
}

/** Ein Backend, dessen entscheidungskritische Abrufe WIRKLICH fehlschlagen. */
function stubBrokenBackend() {
  const boom = () => Promise.reject(new Error('network down'));
  vi.spyOn(api, 'topology').mockImplementation(boom as never);
  vi.spyOn(api, 'siteEntities').mockImplementation(boom as never);
  vi.spyOn(api, 'usageProfile').mockImplementation(boom as never);
  vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue({ list: boom } as never);
}

function renderSeite() {
  return render(
    <AnlageSeite
      sites={[site]}
      devices={[]}
      route={{ page: 'anlagen', siteId: 's-alt', sub: null }}
      onNavigate={() => {}}
      onReload={() => {}}
      site={site}
      onOpenSub={() => {}}
      onBackToList={null}
    />,
  );
}

/** Ein manuell auflösbares Promise - für die Verzögerungs-/Regressionstests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Der Zwischenzustand: kein Layout, solange die Entscheidungs-Eingaben laufen', () => {
  it('rendert weder den Stapel noch den Nicht-zugeordnet-Zustand, solange /entities und /topology noch laufen - und wechselt danach GENAU EINMAL', async () => {
    // Eine Anlage, die schon Daten liefert (also kein M5-Einrichtungspfad),
    // aber deren v2-Abrufe künstlich verzögert werden.
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -2.1, socPct: 60 },
    });
    const topo = deferred<unknown>();
    const entities = deferred<unknown>();
    vi.spyOn(api, 'topology').mockReturnValue(topo.promise as never);
    vi.spyOn(api, 'siteEntities').mockReturnValue(entities.promise as never);
    vi.spyOn(api, 'usageProfile').mockResolvedValue({
      usageProfile: 'private',
      derivedProfile: 'private',
      override: null,
      emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' },
      signals: {
        hasStorage: false,
        hasPv: false,
        hasControllableConsumer: false,
        activeStrategyNodeTypes: [],
        plantKind: 'eigenverbrauch',
        hasLeistungspreis: false,
      },
    } as never);
    vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue({
      list: () => Promise.resolve([]),
    } as never);

    const { container } = renderSeite();

    // Während die Abrufe laufen: der ruhige Zwischenzustand - NIE der Stapel,
    // NIE der "nicht zugeordnet"-Endzustand, NIE der Einrichtungspfad. Das ist
    // der eigentliche Fix: die frühere Weiche hätte hier bereits entschieden
    // (hasEntities/adaptive waren während des Ladens schlicht `false`).
    await waitFor(() => expect(container.querySelector('.vp-anlage-pending')).toBeTruthy());
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
    expect(container.querySelector('.vp-anlage-unassigned')).toBeNull();
    expect(container.querySelector('.vp-setup-steps')).toBeNull();

    // Jetzt lösen die zwei entscheidungskritischen Abrufe auf.
    entities.resolve({ entities: [], localSetup: [] });
    topo.resolve({ schemaVersion: '1.0', entities: [], topology: { nodes: [], flows: [] } });

    // Genau EIN Wechsel: vom Zwischenzustand direkt zum richtigen Endzustand
    // (hier "nicht zugeordnet", weil die Anlage bereits misst).
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-anlage-pending')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
  });

  it('wählt kein Layout, solange nur die Übersichts-Zeile noch läuft (auch wenn /entities und /topology längst fertig sind)', async () => {
    // `setupPathActive` braucht die Übersichts-Zeile, um "noch nie Daten
    // geliefert" von "noch nicht geladen" zu unterscheiden - ohne sie darf die
    // Seite nicht einmal den "nicht zugeordnet"-Zustand zeigen (das wäre eine
    // verfrühte Behauptung über eine Anlage, die vielleicht der M5-Pfad ist).
    const overview = deferred<unknown>();
    vi.spyOn(api, 'overview').mockReturnValue(overview.promise as never);
    vi.spyOn(api, 'earnings').mockResolvedValue({
      range: 'month',
      from: '',
      to: '',
      sites: [],
      totals: {} as never,
    } as never);
    vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
    vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null as never);
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
    vi.spyOn(api, 'telemetry').mockResolvedValue([] as never);
    vi.spyOn(api, 'history').mockResolvedValue({ totals: {}, buckets: [], protocol: [], plan: [] } as never);
    vi.spyOn(api, 'siteSources').mockResolvedValue(null as never);
    vi.spyOn(api, 'entityHistory').mockResolvedValue({
      range: 'day',
      from: '',
      to: '',
      bucketMinutes: 15,
      channels: {},
    } as never);
    vi.spyOn(api, 'siteProfiles').mockResolvedValue(null as never);
    stubNeverMigrated();

    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-pending')).toBeTruthy());
    expect(container.querySelector('.vp-anlage-unassigned')).toBeNull();
    expect(container.querySelector('.vp-setup-steps')).toBeNull();

    overview.resolve({
      sites: [overviewSite({ lastSeenAt: null, live: null })],
      totals: {} as never,
      dailySavings: [],
    });

    // Jetzt ist alles geladen - "noch nie Daten" ⇒ der M5-Einrichtungspfad.
    await waitFor(() => expect(container.querySelector('.vp-setup-steps')).toBeTruthy());
    expect(container.querySelector('.vp-anlage-pending')).toBeNull();
  });
});

describe('Der ehrliche "nicht zugeordnet"-Endzustand (Captain-Nachtrag §3)', () => {
  it('eine Anlage MIT Daten, aber ohne v2-Komponenten, bekommt die ruhige Zeile + den Hebel - nie den v1-Rückfall', async () => {
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -2.1, socPct: 60 },
    });
    stubNeverMigrated();

    const opened: string[] = [];
    const { container } = render(
      <AnlageSeite
        sites={[site]}
        devices={[]}
        route={{ page: 'anlagen', siteId: 's-alt', sub: null }}
        onNavigate={() => {}}
        onReload={() => {}}
        site={site}
        onOpenSub={(sub) => opened.push(sub)}
        onBackToList={null}
      />,
    );

    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.textContent).toContain('noch nicht zugeordnet');
    // Der konkrete Hebel ist da und führt ins Anlagen-Modell ...
    const lever = container.querySelector('.vp-anlage-unassigned button') as HTMLButtonElement;
    expect(lever).toBeTruthy();
    fireEvent.click(lever);
    expect(opened).toContain('modell');
    // ... und es ist NICHT der frühere v1-Zonen-Dashboard-Rückfall.
    expect(container.querySelector('.vp-anlage-dash')).toBeNull();
    expect(container.querySelector('.vp-zone-money')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
    expect(container.querySelector('.vp-setup-steps')).toBeNull();
  });

  it('bleibt "nicht zugeordnet", solange die Topologie-Weiche zu ist - auch wenn /entities Entitäten liefert', async () => {
    // Beide Tore müssen offen sein (report §6.2) - eine Entitäten-Liste ohne
    // brauchbare Topologie ist strukturell derselbe Fall wie keine Entitäten.
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 },
    });
    vi.spyOn(api, 'topology').mockResolvedValue({
      schemaVersion: '1.0',
      entities: [],
      topology: { nodes: [], flows: [] },
    } as never);
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      entities: [{ id: 'e-1', entityType: 'battery-hybrid', label: null, capabilities: { measure: [] } }],
      localSetup: [],
    } as never);
    vi.spyOn(api, 'usageProfile').mockResolvedValue({
      usageProfile: 'private',
      derivedProfile: 'private',
      override: null,
      emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' },
      signals: {
        hasStorage: true,
        hasPv: false,
        hasControllableConsumer: false,
        activeStrategyNodeTypes: [],
        plantKind: 'eigenverbrauch',
        hasLeistungspreis: false,
      },
    } as never);
    vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue({
      list: () => Promise.resolve([]),
    } as never);

    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
  });
});

describe('Ein fehlgeschlagener Abruf ist wie "fertig" zu behandeln', () => {
  it('zeigt den ehrlichen Fehlerzustand mit Wiederholen - nie stillschweigend ein Layout', async () => {
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 },
    });
    stubBrokenBackend();

    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-alert-err')).toBeTruthy());
    expect(container.textContent).toContain('Erneut versuchen');
    // Kein Layout wurde stillschweigend behauptet.
    expect(container.querySelector('.vp-anlage-unassigned')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
    expect(container.querySelector('.vp-setup-steps')).toBeNull();
    expect(container.querySelector('.vp-anlage-pending')).toBeNull();
  });

  it('"Erneut versuchen" holt die entscheidungskritischen Abrufe wirklich neu', async () => {
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 },
    });
    stubBrokenBackend();
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-alert-err')).toBeTruthy());

    // Der zweite Versuch klappt.
    vi.restoreAllMocks();
    stubCommonApi({
      lastSeenAt: new Date().toISOString(),
      onlineCount: 1,
      worstStatus: 'online',
      live: { ts: new Date().toISOString(), pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 },
    });
    stubNeverMigrated();

    const retry = container.querySelector('.vp-alert-err button') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    fireEvent.click(retry);

    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-alert-err')).toBeNull();
  });
});

describe('M5 · Der Einrichtungspfad bleibt unangetastet', () => {
  it('eine Anlage, die noch NIE Messdaten geliefert hat, bekommt den Einrichtungspfad, nie den "nicht zugeordnet"-Zustand', async () => {
    stubCommonApi({ lastSeenAt: null, live: null, worstStatus: 'waiting', onlineCount: 0, waitingCount: 1 });
    stubNeverMigrated();
    const { container } = await (async () => {
      const view = renderSeite();
      await waitFor(() => expect(view.container.querySelector('.vp-setup-steps')).toBeTruthy());
      return view;
    })();
    expect(container.querySelectorAll('.vp-setup-step')).toHaveLength(3);
    expect(container.querySelector('.vp-anlage-unassigned')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
  });
});
