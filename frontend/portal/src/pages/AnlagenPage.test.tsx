import { bestandSnapshot, bestandsZeit } from '../test/bestandsschutzSnapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageSeite, AnlagenPage } from './AnlagenPage';
import { api, type Site } from '../api';
import * as adaptive from '../useAdaptiveLive';
import * as surfaceHook from '../useAnlageSurface';
import { anlageSurface, type AnlageSurfaceInput, type SurfaceEntity } from '../surface';
import { GELD_UNTERSEITEN, ohneGeld } from '../anlageGeld';
import { periodLabel } from '../anlage';
import { readFace, rememberFace } from '../anlageFace';
// Die zwei Stücke, die das Cockpit nachlädt (Bühne in `CockpitHero`, Kacheln über
// `KachelStueck`), schon beim Sammeln übersetzen: sonst bezahlt der Bestandsschutz-
// Fall ihre erste Übersetzung innerhalb seiner `waitFor`-Fristen. `lazy()` zeigt
// trotzdem erst den Platzhalter - das Modul ist nur schon da.
import '../components/EnergieBuehne';
import '../components/kacheln/CockpitKacheln';

/**
 * M3 (#531) — der Cockpit-Beweis, erweitert um die Captain-Nachtrag-Invarianten
 * vom 06.08.2026 (`fm/vp-erst-alt-layout-r5`): der v1-Zonen-Dashboard-Renderpfad
 * ist ERSATZLOS entfallen.
 *
 * Drei Dinge werden hier festgenagelt (über die GEMOCKTEN Hooks - der Weg
 * dorthin über echte Fetch-Zyklen inkl. Lade-/Fehlerzustand steht in
 * `AnlagenPage.v1.test.tsx`):
 *
 * 1. **Der Nicht-zugeordnet-Endzustand (report §6.2 + Nachtrag §3):** eine
 *    Anlage ohne Entitäten (bzw. mit geschlossener `useAdaptiveLive`-Weiche)
 *    rendert die ruhige „nicht zugeordnet"-Zeile + den Hebel — und M3 steuert
 *    dazu **kein einziges Element** bei. Der Beweis ist stärker als eine
 *    Marker-Prüfung: dieselbe Anlage wird einmal mit einer NULL-Surface
 *    (älteres Backend / Ladefehler) und einmal mit der leeren Projektion
 *    gerendert; beide DOMs müssen **zeichengleich** sein und dürfen keinen
 *    M3-Knoten enthalten.
 * 2. **Das Live-Cockpit (Portal v3 M2)** erscheint für eine migrierte Anlage:
 *    der WIEDERVERWENDETE Energiefluss als Hero (kein neues „Energie-Rad"),
 *    Autarkie/Eigenverbrauch als Ringe, das Widget-Raster in kanonischer
 *    Reihenfolge und die ruhige Toolbox-Zeile. Seit V2 ist eine Kachel ein
 *    ABSPRUNG (kein Modal mehr): Fluss-Kacheln springen in den Verlauf-Explorer,
 *    Modus-Kacheln auf ihre Seite.
 * 3. **Der M5-Einrichtungspfad bleibt unangetastet** - er gewinnt gegenüber
 *    dem Nicht-zugeordnet-Zustand genau dann, wenn die Anlage noch NIE
 *    Messdaten geliefert hat.
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
/** Eine Privat-Anlage ohne Leistungspreis und ohne Marktvermarktung: Betriebsmodell Eigenverbrauch. */
const PRIVAT: AnlageSurfaceInput = {
  ...MULTI,
  signals: { ...MULTI.signals!, hasLeistungspreis: false },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false },
};

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
  // Cockpit+Live merge: the merged home also loads the PV-breakdown sources
  // and (lazy) the per-entity sparkline histories — both fail-soft.
  vi.spyOn(api, 'siteSources').mockResolvedValue(null as never);
  // Markt & Tag (PR 1): der Börsenpreis-Streifen holt die Zonen-Serie —
  // leer gemockt zeigt er den ehrlichen Leerzustand (bzw. nichts auf v1).
  vi.spyOn(api, 'prices').mockResolvedValue({
    biddingZone: 'DE-LU',
    resolution: 'PT15M',
    currency: 'EUR',
    points: [],
  } as never);
  vi.spyOn(api, 'entityHistory').mockResolvedValue({
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    channels: {},
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
        // Eine ONLINE-Anlage liefert auch eine Live-Zeile - ohne sie klappt der
        // Hero seit V14 (Audit) das leere Diagramm bewusst ein.
        live: { ts: new Date().toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -2.1, socPct: 60 },
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
  // B2: the cockpit money hero reads the site-scoped endpoint now.
  vi.spyOn(api, 'siteEarnings').mockResolvedValue(null as never);
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

function mockAdaptive(adaptiveOn: boolean, topology: unknown = null) {
  vi.spyOn(adaptive, 'useAdaptiveLive').mockReturnValue({
    topology,
    profile: null,
    adaptive: adaptiveOn,
    loading: false,
    failed: false,
  } as never);
}

/** Ein Topologie-Read-Model mit Rollen-Knoten — es speist das Komponenten-
 *  Board (Speicher → e-batt, Netz → e-grid). */
const TOPO = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'e-batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Speicher',
      label: null,
      category: 'storage',
      health: 'ok',
      capabilities: [{ channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 60 }],
    },
    {
      id: 'e-grid',
      entityType: 'grid-meter',
      typeLabel: 'Netzanschluss',
      label: null,
      category: 'meter',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -2.1 }],
    },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      {
        role: 'storage',
        value_kw: 1.2,
        soc_pct: 60,
        flow_active: true,
        direction: 'out',
        members: [{ entity_id: 'e-batt', label: 'Speicher', primary: true, value_kw: 1.2 }],
      },
      {
        role: 'grid',
        value_kw: 2.1,
        flow_active: true,
        direction: 'out',
        members: [{ entity_id: 'e-grid', label: 'Netz', primary: true, value_kw: -2.1 }],
      },
    ],
  },
};

function mockSurface(
  input: AnlageSurfaceInput | null,
  /** Das REGAL - nur daraus ist ablesbar, ob „Eigene Auswertung" an ist. */
  profiles: { profiles: { id: string; active: boolean }[] } | null = null,
) {
  vi.spyOn(surfaceHook, 'useAnlageSurface').mockReturnValue({
    surface: input ? anlageSurface(input) : null,
    profiles: profiles as never,
    entities: null,
    loading: false,
    failed: false,
  });
}

/** Die Entscheidungs-Eingaben laufen noch — `decision === 'pending'`. */
function mockSurfaceLoading() {
  vi.spyOn(surfaceHook, 'useAnlageSurface').mockReturnValue({
    surface: null,
    profiles: null,
    entities: null,
    loading: true,
    failed: false,
  });
}

function renderSeite(
  onOpenSub: (sub: string) => void = () => {},
  onHealthFacts?: (siteId: string, facts: unknown) => void,
) {
  return render(
    <AnlageSeite
      sites={[site]}
      devices={[]}
      route={{ page: 'anlagen', siteId: 's-1', sub: null }}
      onNavigate={() => {}}
      onReload={() => {}}
      site={site}
      onOpenSub={onOpenSub as never}
      onBackToList={null}
      onHealthFacts={onHealthFacts as never}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Die Verlauf-Disclosure merkt sich ihren Zustand pro Session (Q2) — Tests
  // starten immer mit dem Default (eingeklappt).
  sessionStorage.clear();
  stubApi();
});

/**
 * Geraeteseiten Stufe 0 (Konzept `vp-geraeteseite-rahmen-r2` Paragraph 2.1,
 * Captain-Entscheid D1a): ueber einer GERAETE- oder BOX-Seite standen drei
 * Elemente uebereinander, die alle "zurueck" bedeuten - der Knopf
 * "Anlage {Name}", die Reiter-Leiste ihres Bereichs (in der die Seite gar nicht
 * vorkommt, also war kein Reiter aktiv) und der Link "Zurueck zu den
 * Komponenten". Uebrig bleibt GENAU EINER: die Brotkrume im Seitenkopf.
 */
it('AP-13 Bestandsschutz · Cockpit ohne Messfunktion', async () => {
  bestandsZeit();
  stubApi();
  mockAdaptive(true, TOPO);
  mockSurface(MULTI);
  const view = renderSeite();
  await waitFor(() => expect(view.container.querySelector('.vp-cockpit-hero')).toBeTruthy());
  // Die Energie-Bühne lädt als eigenes Stück nach (main ad5210427): erst ihr Bild, nie der Platzhalter.
  await waitFor(() => expect(view.container.querySelector('.vp-eb-warten')).toBeNull());
  // Die Kacheln sind ein ZWEITES Stück (`KachelStueck`, main 1fec2bc1c): auch auf ihr
  // Bild warten - der Platzhalter `vp-k-platz` mit aria-hidden ist ihr Suspense-Ersatz;
  // unter Last kam der Schnappschuss sonst vor ihnen und hielt leere Plätze fest.
  await waitFor(() => expect(view.container.querySelector('.vp-k-platz[aria-hidden="true"]')).toBeNull());
  await bestandSnapshot('cockpit', view);
});

describe('Stufe 0 · eine Geraeteseite traegt weder Bereichs-Reiter noch den Anlagen-Knopf', () => {
  function renderSub(sub: string, geraet: unknown = null) {
    return render(
      <AnlagenPage
        sites={[site]}
        devices={[]}
        devicesFetchedAt={null}
        route={{ page: 'anlagen', siteId: 's-1', sub: sub as never, geraet: geraet as never }}
        onNavigate={() => {}}
        onReload={() => {}}
        surface={anlageSurface({ entities: [], config: { plantKind: 'eigenverbrauch' } })}
      />,
    );
  }

  it('rendert Leiste und Knopf auf dem WIRT der beiden Seiten', () => {
    // Der Kontrast-Beweis, und zwar im SELBEN Bereich: die Komponenten-Seite
    // traegt die volle Leiste - der Test darunter ist damit kein Vakuum.
    const { container } = renderSub('modell');
    expect(container.querySelectorAll('.vp-bereich-tab')).toHaveLength(2);
    expect(container.querySelector('.vp-fleet-back')).not.toBeNull();
  });

  it('laesst beides auf der BOX-Seite weg', () => {
    const { container } = renderSub('box', { ref: 'edge-1', geraetId: null });
    expect(container.querySelector('.vp-bereich-tabs')).toBeNull();
    expect(container.querySelector('.vp-fleet-back')).toBeNull();
  });

  it('laesst beides auch auf der GERAETE-Seite weg', () => {
    const { container } = renderSub('geraet', { ref: 'edge-1', geraetId: 'inverter' });
    expect(container.querySelector('.vp-bereich-tabs')).toBeNull();
    expect(container.querySelector('.vp-fleet-back')).toBeNull();
  });
});

/**
 * E6 = A („Anlage – neu gedacht"): die Prognosen-Seite ist ein Werkzeug für
 * VoltPilot. Ein Kunde mit altem Lesezeichen landet dort, wo die
 * Treffsicherheit jetzt steht - im Fahrplan -, und nie auf einer leeren Seite.
 */
describe('E6 = A · die Prognosen-Seite ist ein Werkzeug für VoltPilot', () => {
  const MIT_SPEICHER = anlageSurface({
    entities: [
      { id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
    ] as never,
    config: { plantKind: 'eigenverbrauch' },
  });

  function renderPrognose(surface: ReturnType<typeof anlageSurface> | null) {
    return render(
      <AnlagenPage
        sites={[site]}
        devices={[]}
        devicesFetchedAt={null}
        route={{ page: 'anlagen', siteId: 's-1', sub: 'prognose' as never, geraet: null as never }}
        onNavigate={() => {}}
        onReload={() => {}}
        surface={surface}
      />,
    );
  }

  afterEach(() => {
    window.location.hash = '';
  });

  it('führt einen Kunden mit altem Lesezeichen in den Fahrplan', async () => {
    expect(MIT_SPEICHER.deepViews).toContain('fahrplan');
    window.location.hash = '#/anlage/s-1/prognose';
    renderPrognose(MIT_SPEICHER);
    await waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1/fahrplan'));
  });

  it('wartet, solange die Anlage lädt - und nennt bis dahin den Weg', () => {
    window.location.hash = '#/anlage/s-1/prognose';
    renderPrognose(null);
    expect(window.location.hash).toBe('#/anlage/s-1/prognose');
    expect(screen.getByRole('link', { name: 'Fahrplan' })).toHaveAttribute('href', '#/anlage/s-1/fahrplan');
  });
});

describe('Endzustand „nicht zugeordnet": Anlage MIT Daten, ohne v2-Komponenten (Captain-Nachtrag 06.08.2026)', () => {
  it('rendert die ruhige Zeile + den Hebel, und KEINEN M3-Knoten', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.textContent).toContain('noch nicht zugeordnet');
    expect(container.querySelector('.vp-anlage-unassigned button')).toBeTruthy();
    // Der frühere v1-Zonen-Dashboard-Rückfall ist ERSATZLOS entfallen ...
    expect(container.querySelector('.vp-anlage-dash')).toBeNull();
    expect(container.querySelector('.vp-zone-money')).toBeNull();
    expect(container.querySelector('.vp-detail-grid')).toBeNull();
    // ... und M3 steuert auch hier nichts bei.
    expect(container.querySelector('.vp-stack')).toBeNull();
    expect(container.querySelector('.vp-block')).toBeNull();
    expect(container.querySelector('.vp-toolbox-line')).toBeNull();
    expect(container.querySelector('.vp-block-from')).toBeNull();
  });

  it('ist zeichengleich, egal ob das Read-Model geladen wurde oder nicht', async () => {
    // Beide Renderpfade müssen erst AUSSCHWINGEN, sonst verglichen wir einen
    // Lade- mit einem Endzustand.
    const settle = async (container: HTMLElement) => {
      await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    };

    // (a) älteres Backend / Ladefehler: gar keine Surface.
    mockAdaptive(false);
    mockSurface(null);
    const a = renderSeite();
    await settle(a.container);
    const withoutSurface = a.container.innerHTML;
    a.unmount();

    // (b) Surface geladen, aber leer (keine Entitäten, keine Modi).
    vi.restoreAllMocks();
    sessionStorage.clear();
    stubApi();
    mockAdaptive(false);
    mockSurface(LEER);
    const b = renderSeite();
    await settle(b.container);
    expect(b.container.innerHTML).toBe(withoutSurface);
  });

  it('bleibt „nicht zugeordnet", solange die Topologie-Weiche zu ist - auch MIT Entitäten', async () => {
    mockAdaptive(false);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-stack')).toBeNull();
    expect(container.querySelector('.vp-cockpit-hero')).toBeNull();
  });
});

describe('M5 · Der Leer-Zustand IST der Einrichtungspfad (#533)', () => {
  /** Eine brandneue Anlage: Gerät verbunden, aber noch nie Messdaten. */
  function stubFreshSite() {
    vi.restoreAllMocks();
    // Noch NIE Messdaten: keine Live-Zeile (das ist genau das M5-Tor).
    stubApi({
      lastSeenAt: null,
      worstStatus: 'waiting',
      onlineCount: 0,
      waitingCount: 1,
      live: null,
    });
  }

  it('rendert die drei Schritte statt eines leeren Cockpits', async () => {
    stubFreshSite();
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-setup-steps')).toBeTruthy());
    expect(container.querySelectorAll('.vp-setup-step')).toHaveLength(3);
    // Kein Platzhalter-Cockpit, kein Modul-Stapel, kein "nicht zugeordnet".
    expect(container.querySelector('.vp-stack')).toBeNull();
    expect(container.querySelector('.vp-anlage-unassigned')).toBeNull();
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

  it('erscheint NICHT auf einer bereits messenden Anlage ohne Entitäten - die bleibt „nicht zugeordnet"', async () => {
    // Das Invariant von der anderen Seite: dieselbe leere Projektion, aber die
    // Anlage misst bereits - der Einrichtungspfad greift dann NICHT.
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-setup-steps')).toBeNull();
  });
});

describe('Portal v3 M2 · Das Live-Cockpit einer migrierten Anlage', () => {
  it('führt mit dem BESTEHENDEN Energiefluss als Hero, nicht mit einem Kartenstapel', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());

    // Der M3-Kartenstapel (die frühere Zwischenform) ist abgelöst.
    expect(container.querySelector('.vp-stack')).toBeNull();
    // Das Diagramm ist der Leitungsplan der Bühne (Konzept „Cockpit als
    // Tagesfilm“, abgenommen 29.09.2026) - erkennbar an seinem Wrapper. Die
    // Bühne ist ein nachgeladenes Stück, deshalb wird auf sie gewartet.
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp')).toBeTruthy());
  });

  it('Eigenverbrauch: Autarkie und Eigenverbrauch sind eigene Kacheln für heute', async () => {
    // Konzept „Cockpit als Tagesfilm“: keine Ringe mehr in der Geldkarte -
    // die Tageskennzahlen stehen als eigene Kacheln im Raster (eine Kennzahl,
    // ein Ort). Der Energiefluss selbst bleibt „jetzt gerade“.
    mockAdaptive(true);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="autarkie"]')).toBeTruthy());
    const autarkie = container.querySelector('[data-kachel="autarkie"]') as HTMLElement;
    expect(autarkie.textContent).toContain('82');
    expect(autarkie.textContent).toContain('heute selbst gedeckt');
    expect(container.querySelector('[data-kachel="eigenverbrauch"]')?.textContent).toContain('heute selbst genutzt');
    expect(container.querySelector('.vp-c-ck-ring')).toBeNull();
  });

  it('ohne Tageswert gibt es keine Autarkie-Kachel (nie „0 %")', async () => {
    vi.restoreAllMocks();
    stubApi();
    vi.spyOn(api, 'history').mockResolvedValue({
      totals: { autarkiePct: null, eigenverbrauchPct: null, gridImportKwh: null },
      buckets: [],
      protocol: [],
      plan: [],
    } as never);
    mockAdaptive(true);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="automatik"]')).toBeTruthy());
    expect(container.querySelector('[data-kachel="autarkie"]')).toBeNull();
    expect(container.querySelector('[data-kachel="eigenverbrauch"]')).toBeNull();
    expect(container.textContent).not.toContain('0 %');
  });

  it('Lastspitzenkappung: die Lastspitze führt als Leitkachel neben dem Fluss', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-side [data-kachel="lastspitze"]')).toBeTruthy());
    const leit = container.querySelector('.vp-hero-side [data-kachel="lastspitze"]') as HTMLElement;
    expect(leit.querySelector('.vp-k-stern')).toBeTruthy();
    // Die Leitkachel steht nur EINMAL: nicht noch einmal im Raster.
    expect(container.querySelector('.vp-kraster [data-kachel="lastspitze"]')).toBeNull();
    await waitFor(() => expect(container.querySelector('.vp-kraster [data-kachel="automatik"]')).toBeTruthy());
  });

  it('keine zweite Live-Wert-Fläche: kein Komponenten-Board, keine Fluss-Kacheln', async () => {
    // Die Knoten der Bühne sind die EINE Live-Wert-Fläche; ihre Details öffnen
    // sich im Blatt des Knotens (Konzept „Cockpit als Tagesfilm“).
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-kraster [data-kachel]')).toBeTruthy());
    expect(container.querySelector('.vp-puls')).toBeNull();
    expect(container.querySelector('.vp-komponenten')).toBeNull();
    for (const gone of ['erzeugung', 'haus', 'verbrauch']) {
      expect(container.querySelector(`[data-kachel="${gone}"]`)).toBeNull();
    }
  });

  it('das Blatt eines Knotens führt in den Verlauf - ohne zweite Fläche im Cockpit', async () => {
    const opened: string[] = [];
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite((sub) => opened.push(sub));
    await waitFor(() => expect(container.querySelector('.vp-lp-k-grid')).toBeTruthy());
    fireEvent.click(container.querySelector('.vp-lp-k-grid') as Element);
    const weiter = await waitFor(() => {
      const b = [...document.body.querySelectorAll('button')].find((x) => x.textContent?.includes('Verlauf ansehen'));
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(weiter);
    expect(opened).toContain('messwerte');
  });

  it('V2: der Kopf einer Kachel öffnet ihre Seite über onOpenSub', async () => {
    const opened: string[] = [];
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite((sub) => opened.push(sub));
    await waitFor(() => expect(container.querySelector('[data-kachel="automatik"] .vp-k-kopf')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-kachel="automatik"] .vp-k-kopf') as Element);
    expect(opened).toContain('steuerung');
  });

  it('eine Privat-Anlage hat weder Lastspitze- noch Handel-Kachel', async () => {
    mockAdaptive(true);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="autarkie"]')).toBeTruthy());
    expect(container.querySelector('[data-kachel="lastspitze"]')).toBeNull();
    expect(container.querySelector('[data-kachel="handel"]')).toBeNull();
  });

  it('schließt wie im Prototyp mit EINER ruhigen Zustandszeile - ohne Werbezeile', async () => {
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-health .vp-zustand')).toBeTruthy());
    expect(container.querySelector('.vp-toolbox-line')).toBeNull();
  });

  // Markt & Tag (vp-cockpit-unten-ux-n3, PR 1): der Börsenpreis-Streifen führt
  // die untere Hälfte an — gated auf die Marktpreise-Regel (Markt-Modus ∨
  // dynamischer Tarif; die Fixture-Anlage trägt `tarifArt: 'dynamisch'`).
  it('trägt die Börsenpreis-Kachel mit Wert, Urteil und Absprung', async () => {
    const base = new Date(Date.now() - 60 * 60 * 1000);
    const points = Array.from({ length: 8 }, (_, i) => {
      const ts = new Date(base.getTime() + i * 15 * 60_000);
      return {
        ts: ts.toISOString(),
        end: new Date(ts.getTime() + 15 * 60_000).toISOString(),
        priceEurMwh: i % 2 === 0 ? 5 : 140,
      };
    });
    vi.spyOn(api, 'prices').mockResolvedValue({
      biddingZone: 'DE-LU',
      resolution: 'PT15M',
      currency: 'EUR',
      points,
    } as never);
    const opened: string[] = [];
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite((sub) => opened.push(sub));
    await waitFor(() => expect(container.querySelector('[data-kachel="strompreis"]')?.textContent).toContain('ct/kWh'));
    const kachel = container.querySelector('[data-kachel="strompreis"]') as HTMLElement;
    expect(kachel.textContent).toContain('Börsenpreis');
    // Die Plan-Kopplung („Ihr Fahrplan: …“) steht hier nicht - den Plan trägt
    // die Fahrplan-Kachel.
    expect(kachel.textContent).not.toContain('Ihr Fahrplan');
    fireEvent.click(kachel.querySelector('.vp-k-kopf') as Element);
    expect(opened).toContain('marktpreise');
  });

  // PR 4 (Konzept §4b): die kurze Speicher-Fahrplan-Karte sitzt DIREKT unter
  // dem Börsenpreis-Streifen — ① Markt (warum) → ①b Speicher-Fahrplan (was
  // der Plan draus macht) → ② Komponenten. Gated wie die Fahrplan-Ansicht
  // (Speicher vorhanden); der volle Chart lebt nur auf der Fahrplan-Seite.
  it('der Fahrplan ist eine Kachel (Tagesuhr); ohne Plan sagt sie es ruhig', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="fahrplan"]')).toBeTruthy());
    const kachel = container.querySelector('[data-kachel="fahrplan"]') as HTMLElement;
    expect(kachel.textContent).toContain('Fahrplan');
    expect(kachel.textContent).toContain('Für heute liegt noch kein Plan vor.');
    expect(container.querySelector('.vp-fp-band')).toBeNull();
  });

  /*
    Anlagen-Zentrale Stufe 3 (PR 3c): der Weg vom Cockpit auf die
    Komponenten-Karte. Bewusst EINE Zeile unter dem Board und kein zweites Ziel
    je Zeile - die Zeile hat schon eine Bedeutung („Verlauf").
  */
  it('führt aus dem Blatt eines Knotens zu „Ihre Geräte“ - genau EINMAL', async () => {
    const opened: string[] = [];
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite((sub) => opened.push(sub));
    await waitFor(() => expect(container.querySelector('.vp-lp-k-load')).toBeTruthy());
    fireEvent.click(container.querySelector('.vp-lp-k-load') as Element);
    const knoepfe = await waitFor(() => {
      const b = [...document.body.querySelectorAll('button')].filter((x) => x.textContent?.includes('Ihre Geräte'));
      expect(b).toHaveLength(1);
      return b;
    });
    fireEvent.click(knoepfe[0]);
    expect(opened).toContain('modell');
  });

  it('der Nicht-zugeordnet-Zustand kennt keinen Börsenpreis-Streifen — und ruft die Preise gar nicht ab', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('[data-kachel="strompreis"]')).toBeNull();
    expect(api.prices).not.toHaveBeenCalled();
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
    // Seit der Bühne steht der Umschalter als kompaktes Segment IN der
    // Bilanz-Leiste (`.vp-seg`), nicht mehr als vollbreite Seitenzeile.
    const btn = [...container.querySelectorAll('[role="tab"]')].find(
      (b) => b.textContent === label,
    );
    return btn as HTMLButtonElement;
  }

  function ringLabels(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll('.vp-c-ck-ring-label')].map((n) => n.textContent);
  }

  function ringValues(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll('.vp-c-ck-ring svg text')].map((n) => n.textContent);
  }

  it('die Tageskacheln bleiben beim Zeitraum-Wechsel der Geldzahl „heute“', async () => {
    rangeAwareHistory();
    mockAdaptive(true);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="autarkie"]')?.textContent).toContain('40'));
    // Der Zeitraum regiert nur die Geldzahl; die Kachel trägt den Tageswert,
    // nie den des Monats oder Jahres.
    expect(container.querySelector('[data-kachel="autarkie"]')?.textContent).not.toMatch(/64|71/);
    expect(container.querySelector('.vp-hero-flow .vp-lp')).toBeTruthy();
  });

  it('lässt das Energiefluss-Diagramm über alle Tabs unverändert live', async () => {
    // Der Fluss ist „jetzt gerade" und darf sich beim Tab-Wechsel NICHT ändern.
    rangeAwareHistory();
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp')).toBeTruthy());
    const flowBefore = container.querySelector('.vp-hero-flow .vp-lp')?.innerHTML;
    for (const label of ['Monat', 'Jahr', 'Gesamt', 'Heute']) {
      fireEvent.click(tab(container, label));
      await waitFor(() =>
        expect(container.querySelector('.vp-hero-flow .vp-lp')).toBeTruthy(),
      );
    }
    expect(container.querySelector('.vp-hero-flow .vp-lp')?.innerHTML).toBe(flowBefore);
  });
});

describe('Die Bühne (Konzept vp-cockpit-konzept-f4, Richtung A)', () => {
  it('der Zeitraum steht in der Kachel „Unterm Strich“, direkt unter der Zahl', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="geld"] .vp-k-zeitraum .vp-seg.vp-seg-compact')).toBeTruthy());
    expect(container.querySelector('.vp-period-tabs')).toBeNull();
  });

  it('steht standardmäßig auf HEUTE, nicht auf Monat (Captain 2026-07-30)', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="geld"] .vp-seg')).toBeTruthy());
    const active = container.querySelector('[data-kachel="geld"] .vp-seg button.active');
    expect(active?.textContent).toBe('Heute');
    expect([...container.querySelectorAll('[role="tab"][aria-selected="true"]')]).toHaveLength(1);
  });

  it('der Kopfsatz schweigt im Normalfall - der Fluss IST der Satz', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    // Keine Prosa-Doppelung der drei Zahlen an den Fluss-Knoten (Befund P1) ...
    expect(container.querySelector('.vp-anlage-sentence')).toBeNull();
    // ... aber Name, Statuspunkt und Chips stehen weiterhin da.
    expect(container.querySelector('.vp-anlage-head h1')?.textContent).toContain('Hof Lindenberg');
    expect(container.querySelector('.vp-fleet-dot')).toBeTruthy();
  });

  it('der Kopfsatz kehrt zurück, sobald er etwas anderes sagt als das Diagramm', async () => {
    // Ein stilles Gerät: die Ursache zeigt kein Kreis.
    stubApi({ onlineCount: 0, waitingCount: 0, worstStatus: 'stale' });
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-sentence')).toBeTruthy());
    const p = container.querySelector('.vp-anlage-sentence')!;
    expect(p.className).toContain('tone-warn');
    expect(p.textContent).toContain('meldet sich nicht');
  });

  it('trägt die Steuerung als Bühnenfuß: Auftrag, Gerät und Wirkung getrennt', async () => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    stubApi();
    vi.spyOn(api, 'controlStatus').mockResolvedValue({
      deviceId: 'd-1',
      commandedKw: 2.1,
      confirmedKw: 2.1,
      allMatch: true,
      controlEnabled: true,
      certified: true,
      mismatchRoles: null,
      slotStart: null,
      checkedAt: new Date().toISOString(),
    } as never);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-stage-foot .vp-control-spalten')).toBeTruthy());
    const foot = container.querySelector('.vp-stage-foot') as HTMLElement;
    const text = (foot.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain('Auftrag');
    expect(text).toContain('Speicher laden 2,1 kW');
    expect(text).toContain('bestätigt');
    expect(text).toContain('Wirkung');
    expect(container.querySelector('.vp-hero-flow .vp-stage-foot')).toBeNull();
    // Die Bestätigung steht EINMAL - in der Steuerzeile, nicht noch am Speicher-Knoten.
    await waitFor(() => expect(container.querySelector('.vp-hero-flow .vp-lp-batt')).toBeTruthy());
    expect(container.querySelector('.vp-flow-confirm')).toBeNull();
    expect(container.querySelector('.vp-hero-flow .vp-lp-batt')?.getAttribute('title')).not.toContain('Sollwert bestätigt');
  });

  it('setzt KEINEN Haken, solange der Wechselrichter nichts bestätigt hat', async () => {
    // `controlStatus` bleibt null (der Default des Stubs) - nie eine behauptete
    // Bestätigung.
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    expect(container.querySelector('.vp-flow-confirm')).toBeNull();
    expect(container.querySelector('.vp-stage-foot')).toBeNull();
  });
});

describe('Eine Warnung nennt ihre Ursache und ist in einem Klick erreichbar', () => {
  it('die MIGRIERTE Anlage hat eine „Zustand"-Karte — laut, mit Ursache und Hebel', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    // Ein stilles Gerät: genau der Fall, der oben „Warnung" auslöst.
    stubApi({ onlineCount: 0, waitingCount: 0, worstStatus: 'stale' });
    const { container } = renderSeite();
    await waitFor(() => {
      expect(container.querySelector('.vp-cockpit-health')).not.toBeNull();
    });
    // PR 3: der Befund-Fall ist die LAUTE Karte (Titel wortgleich mit dem
    // Abzeichen-Popover), die Ursache steht in Kundendeutsch, der Hebel führt
    // zur Unterseite.
    const card = container.querySelector('.vp-cockpit-health');
    expect(card?.querySelector('.vp-zustand.befund')).not.toBeNull();
    expect(card?.textContent).toContain('Zustand der Anlage');
    expect(card?.textContent).toContain('Gerät: meldet sich nicht');
    expect(card?.textContent).toContain('Aufbau');
  });

  it('alles grün: EINE ruhige Zeile mit dem Modus-Fuß in der Fläche (D5/D6)', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    // Grün braucht einen HEUTIGEN Plan (der Standard-Stub hat keinen —
    // „Fahrplan: noch keiner erstellt" wäre ein ehrlicher off-Befund).
    vi.spyOn(api, 'schedule').mockResolvedValue({
      planId: 'p1',
      deviceId: null,
      generatedAt: new Date().toISOString(),
      slotMinutes: 15,
      savingsEur: null,
      bankedValueEur: null,
      socStartPct: null,
      socEndPct: null,
      peakTargetKw: null,
      slots: [
        {
          start: new Date().toISOString(),
          batteryKw: 0,
          gridKw: null,
          socPct: null,
          priceEurMwh: null,
          costEur: null,
          baselineCostEur: null,
          curtailKw: null,
          pvKw: null,
          loadKw: null,
          slotRole: null,
          slotFlags: null,
          storedValueCtKwh: null,
          gridValueCtKwh: null,
          peakPressureEurKw: null,
          importPriceCtKwh: null,
          exportValueCtKwh: null,
          importPriceSource: null,
          coverLoadFromBattery: null,
          chargeFromSurplusOnly: null,
        },
      ],
    } as never);
    const { container } = renderSeite();
    await waitFor(() => {
      expect(container.querySelector('.vp-cockpit-health .vp-zustand')).not.toBeNull();
    });
    const card = container.querySelector('.vp-cockpit-health');
    // Leise: die eine Zeile statt vier Häkchen-Zeilen …
    expect(card?.textContent).toContain('Alles in Ordnung');
    expect(card?.querySelector('.vp-zustand.befund')).toBeNull();
    expect(card?.querySelector('.vp-health-list')).toBeNull();
    // … schmal wie im Prototyp (Konzept „Cockpit als Tagesfilm“), ohne Modus-Fuß.
    expect(card?.querySelector('.vp-zustand.is-kompakt')).not.toBeNull();
    expect(card?.querySelector('.vp-toolbox-line')).toBeNull();
    expect(container.querySelector('.vp-stack-foot')).toBeNull();
  });

  it('meldet die selbst gemessenen Fakten (Fahrplan/Steuerung/Speicher) nach oben', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubApi({ batteryWithoutDevice: true });
    const reported: { siteId: string; facts: Record<string, unknown> }[] = [];
    renderSeite(
      () => {},
      (siteId, facts) => reported.push({ siteId, facts: facts as Record<string, unknown> }),
    );
    await waitFor(() => {
      expect(reported.some((r) => r.facts.battery != null)).toBe(true);
    });
    const last = reported[reported.length - 1];
    expect(last.siteId).toBe('s-1');
    // Der Speicher-Fakt ist GEMESSEN (die Übersicht ist da) ...
    expect(last.facts.battery).toEqual({ withoutDevice: true, linked: false });
    // ... der Fahrplan-Fakt ebenfalls (der Abruf ist beantwortet, wenn auch leer).
    expect(last.facts.plan).toEqual({ hasPlanToday: false, hasAnyPlan: false });
    // Ohne Rückmeldung bleibt die Steuerung UNBEKANNT - nie ein erfundenes "ok".
    expect(last.facts.controlState ?? null).toBeNull();
  });

  it('kommt ohne die optionale Rückmeldung aus (nur Gerätedaten, kein Absturz)', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => {
      expect(container.querySelector('.vp-anlage-unassigned')).not.toBeNull();
    });
    // Kein onHealthFacts übergeben: die Seite rendert unverändert weiter.
    expect(container.querySelector('.vp-cockpit-health')).toBeNull();
  });
});

/**
 * Mobil-Umbau Stufe 2 — die Telefon-KOMPOSITION des Cockpits (abgenommenes
 * Konzept `data/vp-mobile-views-x1`, Sektion „Cockpit"; Captain-Go 09.08.2026).
 *
 * Der Beweis ist bewusst BEIDSEITIG: dieselbe Anlage wird einmal am Telefon und
 * einmal am Rechner gerendert. Am Telefon muss die Geld-Aussage GENAU EINMAL
 * stehen; am Rechner darf sich **nichts** geändert haben (die Bühne ist
 * unangetastet — das ist die eigentliche Zusage dieser Stufe).
 *
 * `useIsPhone` liest `matchMedia`; jsdom hat es nicht, deshalb ist die
 * Desktop-Fassung überall sonst in dieser Datei automatisch die gerenderte.
 */
describe('Mobil-Umbau Stufe 2 · die Telefon-Fassung', () => {
  function stubPhone(isPhone: boolean) {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: isPhone && query.includes('720px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('am Telefon: keine Leiste, die Leitkachel steht als erste Kachel unter der Bühne', async () => {
    stubPhone(true);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-kraster [data-kachel="lastspitze"]')).toBeTruthy());
    expect(container.querySelector('.vp-hero-side')).toBeNull();
    const erste = container.querySelector('.vp-kraster [data-kachel]') as HTMLElement;
    expect(erste.getAttribute('data-kachel')).toBe('lastspitze');
    // Die Geldzahl steht in EINER Kachel; der Sticky-Kopf bleibt verborgen,
    // solange er nicht ausgelöst wurde.
    expect(container.querySelectorAll('[data-kachel="geld"]')).toHaveLength(1);
    const sticky = container.querySelector('.vp-mob-sticky');
    expect(sticky == null || sticky.getAttribute('aria-hidden') === 'true').toBe(true);
    expect(container.querySelector('.vp-c-ck-ring')).toBeNull();
  });

  /**
   * **Bewegung · P7 — der Frische-Chip springt nicht mehr.**
   *
   * Gemessener Befund (`e2e/motion-p7/proof.mjs` (c), Produktions-Build,
   * 375 px · CPU 4× · Fast 3G, 5 von 5 Läufen gleich): der Chip traf erst mit
   * den Übersichts-Daten ein, belegte am Telefon eine EIGENE Zeile und schob
   * damit `.vp-anlage-pending` um 30 px nach unten — der größte Einzelsprung
   * des ganzen App-Starts (CLS 0,308 von 0,333 gesamt). Seither steht die
   * Zeile von Anfang an da; ein unsichtbarer Zwilling hält ihre Höhe frei.
   *
   * ⚠ Der Beweis ist BEIDSEITIG: am Telefon muss die Zeile schon VOR den
   *   Daten stehen, am Rechner darf es sie GAR NICHT geben (dort bestimmt die
   *   Überschrift die Kopfhöhe, der Chip schiebt nichts — und eine Zeile, die
   *   niemand braucht, wäre dort eine zweite Wahrheit über dieselbe Kopfzeile).
   */
  it('hält die Chip-Zeile am Telefon von Anfang an frei — auch ohne Daten', async () => {
    stubPhone(true);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();

    // SOFORT, im allerersten Bild: die Zeile steht, und sie trägt bereits
    // einen Körper (den unsichtbaren Zwilling) — sonst wäre sie 0 px hoch und
    // reservierte nichts.
    const zeileVorher = container.querySelector('.vp-anlage-chipzeile');
    expect(zeileVorher).toBeTruthy();
    const platz = zeileVorher?.firstElementChild as HTMLElement | null;
    expect(platz).toBeTruthy();
    expect(platz?.style.visibility).toBe('hidden');
    expect(platz?.getAttribute('aria-hidden')).toBe('true');

    // … und nachdem die Daten da sind, ist es DIESELBE Zeile — kein zweiter
    // Behälter, der daneben aufginge.
    await waitFor(() => expect(container.querySelector('[data-kachel="geld"]')).toBeTruthy());
    expect(container.querySelectorAll('.vp-anlage-chipzeile').length).toBe(1);
  });

  it('kennt die Chip-Zeile am Rechner NICHT (der breite Kopf ist unangetastet)', async () => {
    stubPhone(false);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-head')).toBeTruthy());
    expect(container.querySelector('.vp-anlage-chipzeile')).toBeNull();
  });

  it('am Telefon sind Fahrplan und Börsenpreis Kacheln wie am Rechner', async () => {
    stubPhone(true);
    mockAdaptive(true, TOPO);
    mockSurface(PRIVAT);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="fahrplan"]')).toBeTruthy());
    expect(container.querySelectorAll('.vp-mob-row')).toHaveLength(0);
    expect(container.querySelector('.vp-fp-band')).toBeNull();
  });

  it('lässt den Seitenkopf weg — die Topbar trägt die Identität (Stufe 1)', async () => {
    stubPhone(true);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('[data-kachel="geld"]')).toBeTruthy());
    const head = container.querySelector('.vp-anlage-head') as HTMLElement;
    expect(head.className).toContain('is-phone');
    // Die Überschrift bleibt für Screenreader stehen (0 px hoch), die
    // Stammdaten-Abzeichen entfallen: sie ändern sich nie und beantworten
    // keine Tagesfrage.
    expect(head.querySelector('h1.vp-sr-only')?.textContent).toBe(site.name);
    expect(head.textContent).not.toContain('Direktvermarktung');
    expect(head.textContent).not.toContain('Netzladen');
  });

  it('am Rechner: die Leitkachel steht in der Bühne, kein Telefon-Knoten', async () => {
    stubPhone(false);
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-side [data-kachel]')).toBeTruthy());
    expect(container.querySelectorAll('[class*="vp-mob-"]').length).toBe(0);
    const head = container.querySelector('.vp-anlage-head') as HTMLElement;
    expect(head.className).not.toContain('is-phone');
    expect(head.querySelector('h1.vp-sr-only')).toBeNull();
  });
});

/**
 * B1 · Welle 3 startet MIT Welle 2 (Perf-Review `vp-cockpit-perf-p7` §3).
 *
 * Gemessen wurde ein reiner WELLENABSTAND: `/history` und `/telemetry` hingen
 * an `showStack`/`isPeakLead` und damit daran, dass `/entities` + `/topology`
 * geantwortet haben — bei Prod-Latenz ~0,5 s Warten. Hier wird der Umbau von
 * beiden Seiten festgenagelt: mit Erinnerung startet der Abruf, BEVOR
 * entschieden ist; ohne Erinnerung bleibt alles wie vor B1.
 *
 * Die Ehrlichkeitsregel wird MITgeprüft: gerendert wird währenddessen weiterhin
 * `AnlagePending` — es wandert nur der Startzeitpunkt, nie eine Aussage.
 */
describe('B1 · Welle 3 faltet in Welle 2', () => {
  it('startet /history schon WÄHREND die Entscheidung läuft, wenn die Anlage zuletzt den Stapel zeigte', async () => {
    rememberFace('s-1', { stack: true, peak: false });
    mockAdaptive(true, TOPO);
    mockSurfaceLoading();
    const { container } = renderSeite();
    await waitFor(() => expect(api.history).toHaveBeenCalled());
    // ... und die Fläche behauptet trotzdem NICHTS: der Zwischenzustand steht.
    expect(container.querySelector('.vp-anlage-pending')).toBeTruthy();
    expect(container.querySelector('.vp-cockpit-stack')).toBeNull();
  });

  it('startet /telemetry mit, wenn zuletzt das Peak-Band führte', async () => {
    rememberFace('s-1', { stack: true, peak: true });
    mockAdaptive(true, TOPO);
    mockSurfaceLoading();
    renderSeite();
    await waitFor(() => expect(api.telemetry).toHaveBeenCalled());
  });

  it('spekuliert NICHT ohne Erinnerung — byte-gleich zu vor B1', async () => {
    mockAdaptive(true, TOPO);
    mockSurfaceLoading();
    renderSeite();
    // Der Zwischenzustand steht; die Welle-3-Abrufe warten wie bisher.
    await waitFor(() => expect(api.overview).toHaveBeenCalled());
    expect(api.history).not.toHaveBeenCalled();
    expect(api.telemetry).not.toHaveBeenCalled();
  });

  it('spekuliert NICHT auf /telemetry, wenn zuletzt kein Peak-Band führte', async () => {
    rememberFace('s-1', { stack: true, peak: false });
    mockAdaptive(true, TOPO);
    mockSurfaceLoading();
    renderSeite();
    await waitFor(() => expect(api.history).toHaveBeenCalled());
    expect(api.telemetry).not.toHaveBeenCalled();
  });

  it('merkt sich das Gesicht, sobald ENTSCHIEDEN ist', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-stack')).toBeTruthy());
    expect(readFace('s-1')).toEqual({ stack: true, peak: true });
  });

  it('ein FALSCHER Tipp verwirft das Ergebnis: die Fläche zeigt den Endzustand, nie Stapel-Zahlen', async () => {
    rememberFace('s-1', { stack: true, peak: true });
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(container.querySelector('.vp-cockpit-stack')).toBeNull();
    // ... und die Erinnerung ist auf den wahren Zustand nachgezogen.
    expect(readFace('s-1')).toEqual({ stack: false, peak: false });
  });
});

describe('Anwendungs-Programm Stufe 3 · das anpassbare Cockpit', () => {
  /** Wartet, bis das Cockpit wirklich ausgeschwungen ist (fail-soft-Abrufe). */
  async function ausgeschwungen(container: HTMLElement): Promise<string> {
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    let prev = '';
    for (let i = 0; i < 25; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const now = container.innerHTML;
      if (now === prev) return now;
      prev = now;
    }
    return prev;
  }

  /** Alle Schichten leer — der Zustand JEDER Bestandsanlage. */
  function stubLayout(response: Record<string, unknown> | null = null) {
    vi.spyOn(api, 'cockpitLayout').mockResolvedValue(
      (response ?? {
        surface: 'cockpit',
        profil: null,
        presetLayout: null,
        tenantVorgabe: null,
        siteVorgabe: null,
        eigen: null,
        bausteine: [],
        darfVorgabe: false,
      }) as never,
    );
  }

  it('rendert OHNE gespeicherte Zeile Zeichen für Zeichen dasselbe wie ohne die Route', async () => {
    // Der Bestands-Beweis am echten DOM: ein Backend, das die Route gar nicht
    // kennt (Abruf schlägt fehl), und eines, das leere Schichten liefert, führen
    // zum IDENTISCHEN Cockpit.
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    vi.spyOn(api, 'cockpitLayout').mockRejectedValue(new Error('gibts nicht'));
    const alt = renderSeite();
    const ohneRoute = await ausgeschwungen(alt.container);
    alt.unmount();

    vi.restoreAllMocks();
    stubApi();
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubLayout();
    const neu = renderSeite();
    expect(await ausgeschwungen(neu.container)).toBe(ohneRoute);
  });

  it('ohne Erlös-Komposition und ohne Geldzahl gibt es keine Geld-Kachel (kein leerer Rahmen)', async () => {
    // Eine reine Regel-Anlage (Wallbox + eine Automation, kein Speicher, kein
    // Geld-Modus): nichts zu rechnen, also auch keine Kachel „Unterm Strich“.
    const OHNE_GELD: AnlageSurfaceInput = {
      signals: {
        hasStorage: false,
        hasPv: false,
        hasControllableConsumer: true,
        activeStrategyNodeTypes: [],
        plantKind: 'eigenverbrauch',
        hasLeistungspreis: false,
      },
      config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' },
      flows: [
        {
          flowId: 'f-reg',
          name: 'Wallbox-Regel',
          activeVersion: 1,
          latestLifecycle: 'active',
          latestDocument: {
            schema_version: '1.0',
            name: 'Wallbox-Regel',
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
      entities: [entity('e-wb', 'wallbox', ['power_kw'])],
    };
    mockAdaptive(true, TOPO);
    mockSurface(OHNE_GELD);
    stubLayout();
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.vp-kraster [data-kachel]')).toBeTruthy());
    expect(container.querySelector('[data-kachel="geld"]')).toBeNull();
  });

  it('bietet „Cockpit anpassen" erst, wenn es einen Stapel zum Anordnen gibt', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    stubLayout();
    const leer = renderSeite();
    await waitFor(() => expect(leer.container.querySelector('.vp-anlage-unassigned')).toBeTruthy());
    expect(leer.container.querySelector('[aria-label="Cockpit anpassen"]')).toBeNull();
    leer.unmount();

    vi.restoreAllMocks();
    stubApi();
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubLayout();
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    expect(container.querySelector('[aria-label="Cockpit anpassen"]')).toBeTruthy();
  });

  it('blendet einen Baustein aus, lässt ihn erreichbar und speichert die Absicht', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(PRIVAT);
    stubLayout();
    const save = vi.spyOn(api, 'saveCockpitLayout').mockResolvedValue({
      surface: 'cockpit',
      profil: null,
      presetLayout: null,
      tenantVorgabe: null,
      siteVorgabe: null,
      eigen: null,
      bausteine: [],
      darfVorgabe: false,
    } as never);
    const { container, getByLabelText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());

    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-bar')).toBeTruthy());
    // Die Fahrplan-Kachel ist da — und wird ausgeblendet.
    await waitFor(() => expect(container.querySelector('[data-kachel="fahrplan"]')).toBeTruthy());
    fireEvent.click(getByLabelText('Speicher-Fahrplan ausblenden'));
    await waitFor(() => expect(container.querySelector('[data-kachel="fahrplan"]')).toBeNull());
    // ... bleibt aber in der Reihe „Ausgeblendet (n)" erreichbar.
    expect(container.querySelector('.vp-anpassen-versteckt')?.textContent).toContain(
      'Ausgeblendet (1)',
    );

    fireEvent.click(container.querySelector('.vp-anpassen-btn.is-primary') as Element);
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [, layer, doc] = save.mock.calls[0] as unknown as [
      string,
      string,
      { order: string[]; hidden: string[]; lead: string | null },
    ];
    // Der Kunde schreibt SEINE Schicht — nie die Vorgabe.
    expect(layer).toBe('eigen');
    expect(doc.hidden).toEqual(['fahrplan']);
    // Das Dokument nennt die volle Reihenfolge, inklusive des Ausgeblendeten.
    expect(doc.order).toContain('fahrplan');
  });

  it('ein Pflicht-Baustein bekommt gar keinen Auge-Knopf, sondern die ehrliche Zeile', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubLayout();
    const { container, getByLabelText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-bar')).toBeTruthy());
    expect(container.querySelector('[aria-label="Zustand ausblenden"]')).toBeNull();
    expect(container.textContent).toContain('immer sichtbar');
  });

  it('ordnet mit den Tastatur-Knöpfen um — ohne Maus und ohne Drag-and-Drop', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(PRIVAT);
    stubLayout();
    const { container, getByLabelText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-bar')).toBeTruthy());

    const namen = () =>
      [...container.querySelectorAll('.vp-anpassen-huelle > .vp-anpassen-ctrl > .vp-anpassen-name')]
        .map((n) => n.textContent);
    const vorher = namen();
    expect(vorher).toContain('Speicher-Fahrplan');
    fireEvent.click(getByLabelText('Speicher-Fahrplan nach oben'));
    await waitFor(() => expect(namen()).not.toEqual(vorher));
    const nachher = namen();
    expect(nachher.indexOf('Speicher-Fahrplan')).toBeLessThan(vorher.indexOf('Speicher-Fahrplan'));
    // Kopf und Bühne bleiben oben — sie sind unbeweglich, damit ein
    // Lead-Wechsel oder eine Umsortierung sie nie zerlegt.
    expect(nachher.slice(0, 2)).toEqual(['Status & Warnungen', 'Energiefluss']);
  });

  it('sagt beim Zurücksetzen, WORAUF es fällt — und nennt die Vorgabe, wenn es eine gibt', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubLayout({
      surface: 'cockpit',
      profil: null,
      presetLayout: null,
      tenantVorgabe: null,
      siteVorgabe: {
        document: { version: 1, order: [], hidden: ['strompreis'], shown: [], lead: null },
        updatedBy: 'admin',
        updatedAt: null,
      },
      eigen: null,
      bausteine: [],
      darfVorgabe: false,
    });
    const { container, getByLabelText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-bar')).toBeTruthy());
    expect(container.querySelector('.vp-anpassen-bar')?.textContent).toContain(
      'Vorgabe Ihres Betreibers',
    );
  });

  it('ein Admin bekommt den sichtbaren Schalter „als Vorgabe speichern" samt Band', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    stubLayout({
      surface: 'cockpit',
      profil: null,
      presetLayout: null,
      tenantVorgabe: null,
      siteVorgabe: null,
      eigen: null,
      bausteine: [],
      darfVorgabe: true,
    });
    const { container, getByLabelText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-toggle')).toBeTruthy());
    // Er handelt als Betreiber: der Schalter ist VORGEWÄHLT, das Band sagt es.
    expect(
      (container.querySelector('.vp-anpassen-toggle input') as HTMLInputElement).checked,
    ).toBe(true);
    expect(container.querySelector('.vp-anpassen-band')?.textContent).toContain('Vorgabe');
  });
});

describe('Anwendungs-Programm Stufe 5 · die eigene Auswertung im Cockpit', () => {
  /** Alle Schichten leer, aber MIT den zwei Vorlagen (Stufe 5). */
  function stubLayout5(eigen: Record<string, unknown> | null = null) {
    vi.spyOn(api, 'cockpitLayout').mockResolvedValue({
      surface: 'cockpit',
      profil: null,
      presetLayout: null,
      tenantVorgabe: null,
      siteVorgabe: null,
      eigen,
      bausteine: [],
      darfVorgabe: false,
      vorlagen: [],
    } as never);
  }

  const KACHEL = {
    id: 'eigen:k1',
    titel: 'Wärmepumpe jetzt',
    darstellung: 'kachel',
    entityId: 'e-wb',
    channel: 'power_kw',
    aggregat: 'jetzt',
  };

  /** Das Regal mit „Eigene Auswertung" AN bzw. AUS. */
  const regal = (active: boolean) => ({
    profiles: [{ id: 'eigene-auswertung', active }],
  });

  it('rendert eine gespeicherte Kachel mit Zahl, Einheit und Zeitbezug', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(true));
    stubLayout5({
      document: { version: 1, order: [], hidden: [], shown: [], lead: null, custom: [KACHEL] },
      updatedBy: 'u',
      updatedAt: null,
    });
    vi.spyOn(api, 'eigeneAuswertung').mockResolvedValue({
      at: '2026-08-25',
      from: '',
      to: '',
      bucketMinutes: 15,
      werte: [
        {
          ...KACHEL,
          wert: 3.25,
          kanalart: 'leistung',
          komponente: 'Wärmepumpe',
          entityType: 'wallbox',
          hinweis: null,
          verlauf: [],
        },
      ],
    } as never);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-eigen-kachel')).toBeTruthy());
    const kachel = container.querySelector('.vp-eigen-kachel') as HTMLElement;
    expect(kachel.textContent).toContain('Wärmepumpe jetzt');
    expect(kachel.textContent).toContain('3,25');
    expect(kachel.textContent).toContain('kW');
    // Der ZEITBEZUG steht an der Zahl — „3,25 kW" allein sagt zu wenig.
    expect(kachel.textContent).toContain('jetzt');
  });

  it('behauptet ohne Messwert KEINE Null, sondern sagt es', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(true));
    stubLayout5({
      document: { version: 1, order: [], hidden: [], shown: [], lead: null, custom: [KACHEL] },
      updatedBy: 'u',
      updatedAt: null,
    });
    // Der Abruf scheitert — fail-soft wie jeder Zusatz-Abruf des Cockpits.
    vi.spyOn(api, 'eigeneAuswertung').mockRejectedValue(new Error('weg'));
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-eigen-kachel')).toBeTruthy());
    const kachel = container.querySelector('.vp-eigen-kachel') as HTMLElement;
    expect(kachel.textContent).toContain('—');
    expect(kachel.textContent).toContain('keine Messwerte');
    expect(kachel.textContent).not.toMatch(/\b0,00\b/);
  });

  it('Stufe 8: eine Kachel rendert OHNE jeden Schalter — es gibt keinen mehr', async () => {
    // „Eigene Auswertung" ist seit Steuerung Stufe 8 die Katalog-Klasse
    // `cockpit`: sie hat keinen Schalter, ihre Kacheln entstehen im Cockpit
    // unter „Anpassen". Ein Regal-Zustand `active: false` (ein ÄLTERER Server,
    // der die Karte noch führt) darf sie deshalb nicht mehr verstecken.
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(false));
    stubLayout5({
      document: { version: 1, order: [], hidden: [], shown: [], lead: null, custom: [KACHEL] },
      updatedBy: 'u',
      updatedAt: null,
    });
    vi.spyOn(api, 'eigeneAuswertung').mockResolvedValue({
      at: '2026-08-25',
      from: '',
      to: '',
      bucketMinutes: 15,
      werte: [
        {
          ...KACHEL,
          wert: 3.25,
          kanalart: 'leistung',
          komponente: 'Wärmepumpe',
          einheit: 'kW',
          grund: null,
        },
      ],
    } as never);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-eigen-kachel')).toBeTruthy());
  });

  it('eine frisch angelegte Kachel sagt „noch nicht gespeichert", nie „keine Messwerte"', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(true));
    stubLayout5();
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [
        {
          id: 'e-wb',
          entityType: 'wallbox',
          typeLabel: 'Wallbox',
          role: 'consumer',
          label: 'Wallbox',
          control: false,
          deviceId: 'd1',
          capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
          guardConfig: null,
          syncStatus: 'in_sync',
          observed: null,
          edgeSourceId: null,
          orphanedPin: null,
          capacityKwp: null,
        },
      ],
      localSetup: [],
      staleOnDevice: [],
    } as never);
    const { container, getByLabelText, getByText, findByRole } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-eigen-neu')).toBeTruthy());
    fireEvent.click(getByText('+ Eigene Auswertung'));

    // Durch den geführten Dialog … (welche Komponente der Baum anbietet, ist
    // hier gleichgültig - geprüft wird die WORTWAHL der frischen Kachel).
    fireEvent.click(await findByRole('combobox', { name: /Komponente/ }));
    const komponenten = await screen.findAllByRole('option');
    fireEvent.click(komponenten[0]);
    fireEvent.click(await findByRole('combobox', { name: /Messwert/ }));
    const messwerte = await screen.findAllByRole('option');
    fireEvent.click(messwerte[0]);
    fireEvent.click(getByText('Anlegen'));

    // … erscheint die Kachel SOFORT - aber sie behauptet keine fehlenden
    // Messwerte, sondern sagt, dass sie noch nicht gespeichert ist.
    await waitFor(() => expect(container.querySelector('.vp-eigen-kachel')).toBeTruthy());
    const kachel = container.querySelector('.vp-eigen-kachel') as HTMLElement;
    expect(kachel.textContent).toContain('Fertig');
    expect(kachel.textContent).not.toContain('keine Messwerte');
  });

  it('bietet „+ Eigene Auswertung" NUR im Anpassen-Modus und NUR mit der Anwendung', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(true));
    stubLayout5();
    const { container, getByLabelText, getByText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    // Ausserhalb des Anpassen-Modus gibt es den Knopf nicht.
    expect(container.querySelector('.vp-eigen-neu')).toBeNull();

    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-eigen-neu')).toBeTruthy());
    // Ohne eine einzige Auswertung sagt die Zeile, wofür der Knopf da ist.
    expect(container.querySelector('.vp-eigen-neu')?.textContent).toContain(
      'noch keine eigene Auswertung',
    );
    // Und er öffnet den geführten Dialog.
    fireEvent.click(getByText('+ Eigene Auswertung'));
    await waitFor(() => expect(container.ownerDocument.body.textContent).toContain('Komponente'));
  });

  it('Stufe 8: der Knopf steht im Anpassen-Modus IMMER — ohne vorheriges Einschalten', async () => {
    // Der Umzug der Stufe 8: „Eigene Auswertung" verschwindet als Schalter und
    // existiert nur noch hier. Also darf der Weg zu ihr nicht mehr davon
    // abhängen, dass irgendwo vorher etwas eingeschaltet wurde.
    mockAdaptive(true, TOPO);
    mockSurface(MULTI, regal(false));
    stubLayout5();
    const { container, getByLabelText, getByText } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    fireEvent.click(getByLabelText('Cockpit anpassen'));
    await waitFor(() => expect(container.querySelector('.vp-anpassen-bar')).toBeTruthy());
    expect(getByText('+ Eigene Auswertung')).toBeTruthy();
  });
});

/**
 * UEMS AP-01 IP-8 · die Geld-Regel JE ANLAGE (A13 — Captain 10.09.2026: „Die
 * Messdatenkunden brauchen keine Geldanzeige."). Geprüft wird der GERENDERTE
 * Text, und zwar mit JEDER Geld-Quelle, die das Cockpit kennt: Erlöse und
 * Netto vom Server, Leistungspreis, dynamischer Tarif, Markt-Knoten. Ein
 * künftiger Geld-Baustein, der an `anlageGeld` vorbeigeht, macht ihn rot.
 */
describe('UEMS AP-01 IP-8 · eine Anlage ohne Steuerung, Erzeuger und Speicher zeigt nirgends eine Geldzahl', () => {
  const GELD = /€|\bEUR\b|ct\/kWh|Unterm Strich|Marktpreis|Erlös/;

  function geldUeberall() {
    vi.spyOn(api, 'siteEarnings').mockResolvedValue({
      from: '2026-11-15T00:00:00+01:00',
      to: '2099-01-01T00:00:00+01:00',
      nettoErgebnisEur: 42.5,
      eigenverbrauchsWertEur: 88.25,
      einspeiseErloesEur: 11,
      actualEur: 45.75,
      savedEur: 12,
      peakShaving: {
        leistungspreisEurKw: 95,
        abrechnung: 'jahr',
        periodStart: '2026-01-01',
        peakKw: 180,
        baselinePeakKw: 210,
        avoidedKw: 30,
        avoidedEur: 3600,
        history: [],
      },
    } as never);
  }

  function mockGeldfrei() {
    vi.spyOn(surfaceHook, 'useAnlageSurface').mockReturnValue({
      surface: ohneGeld(anlageSurface(MULTI)),
      profiles: null,
      entities: null,
      loading: false,
      failed: false,
    } as never);
  }

  async function fertig(container: HTMLElement) {
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    await waitFor(() => expect(api.siteEarnings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  }

  it('Gegenprobe: dieselbe Anlage MIT Geld zeigt Geld — sonst bewiese der nächste Test nichts', async () => {
    geldUeberall();
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await fertig(container);
    await waitFor(() => expect(container.textContent).toMatch(GELD));
  });

  it('Cockpit: kein Geld-Held, keine Steuerungs-Karte, keine Marktpreise — kein einziges Euro-Zeichen', async () => {
    geldUeberall();
    mockAdaptive(true, TOPO);
    mockGeldfrei();
    const { container } = renderSeite();
    await fertig(container);
    expect(container.textContent).not.toMatch(GELD);
    expect(container.querySelector('.vp-sp-link')).toBeNull();
  });

  it('Verlauf: kein Reiter nennt Geld, und ein Lesezeichen auf eine Geld-Seite zeigt die Messwerte', async () => {
    geldUeberall();
    for (const sub of GELD_UNTERSEITEN) {
      const { container, unmount } = render(
        <AnlagenPage
          sites={[site]}
          devices={[]}
          devicesFetchedAt={null}
          route={{ page: 'anlagen', siteId: 's-1', sub }}
          onNavigate={() => {}}
          onReload={() => {}}
          surface={ohneGeld(anlageSurface(MULTI))}
        />,
      );
      const reiter = [...container.querySelectorAll('.vp-bereich-tab')].map((t) => t.textContent);
      // Seit dem Verlauf-Rework von main (763b87f39) heißt der Verlauf „Energie · Erlöse · Messwerte“;
      // Preise und Wetter stehen im Fahrplan (MULTI hat einen), Prognosen nur für VoltPilot (41ed67c26, E6).
      // Ohne Geld bleibt davon: kein Reiter „Erlöse“.
      expect(reiter, sub).toEqual(['Energie', 'Messwerte']);
      await new Promise((r) => setTimeout(r, 0));
      expect(container.textContent, sub).not.toMatch(GELD);
      unmount();
    }
  });
});

it('H-3 lädt alle drei Rollen und erhält Verbrauch/Netz auch bei fehlgeschlagenem PV-Leser', async () => {
  mockAdaptive(true, TOPO);
  mockSurface(MULTI);
  const lesen = vi.spyOn(api, 'rollenWert').mockImplementation(async (_siteId, role) => {
    if (role === 'pv') throw new Error('nicht erreichbar');
    return { role, wert: role === 'grid' ? -3.5 : 213.5, einheit: 'kW', stand: '2026-09-16T10:15:00+02:00',
      zuordnung_vorhanden: true, unvollstaendig: false,
      geraete: [{ entity_id: role, name: 'Rollenquelle', art: 'gesamtwert', wert: role === 'grid' ? -3.5 : 213.5, liefernd: true, grund: null }] };
  });
  const { container } = renderSeite();
  await waitFor(() => expect(lesen).toHaveBeenCalledTimes(3));
  for (const role of ['pv', 'consumer', 'grid']) expect(lesen).toHaveBeenCalledWith('s-1', role);
  // Die Aufschlüsselung je Gerät steht im Blatt des jeweiligen Knotens.
  await waitFor(() => expect(container.querySelector('.vp-lp-k-load')).toBeTruthy());
  fireEvent.click(container.querySelector('.vp-lp-k-load') as Element);
  await waitFor(() => expect(document.body.querySelector('.vp-rolle-consumer')?.textContent).toContain('Stand 10:15 Uhr'));
  expect(document.body.querySelector('.vp-rolle-pv')).toBeNull();
});
