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
 *    Reihenfolge und die ruhige Toolbox-Zeile. Seit V2 ist eine Kachel ein
 *    ABSPRUNG (kein Modal mehr): Fluss-Kacheln springen in den Verlauf-Explorer,
 *    Modus-Kacheln auf ihre Seite.
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

function mockSurface(input: AnlageSurfaceInput | null) {
  vi.spyOn(surfaceHook, 'useAnlageSurface').mockReturnValue({
    surface: input ? anlageSurface(input) : null,
    loading: false,
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
    // Cockpit+Live-Merge: das absolute v1-DOM ändert sich BEWUSST — die
    // Komponenten-Sektion gehört jetzt auch zur v1-Startseite (das Invariant
    // bleibt die Zeichengleichheit null-Surface === leere Projektion unten).
    expect(container.querySelector('.vp-dash-komponenten')).toBeTruthy();
    // ... und M3 steuert nichts bei.
    expect(container.querySelector('.vp-stack')).toBeNull();
    expect(container.querySelector('.vp-block')).toBeNull();
    expect(container.querySelector('.vp-toolbox-line')).toBeNull();
    expect(container.querySelector('.vp-block-from')).toBeNull();
  });

  it('ist zeichengleich, egal ob das Read-Model geladen wurde oder nicht', async () => {
    // Beide Renderpfade müssen erst AUSSCHWINGEN (die lazy Komponenten-Sektion
    // lädt asynchron), sonst verglichen wir einen Lade- mit einem Endzustand.
    const settle = async (container: HTMLElement) => {
      await waitFor(() => expect(container.querySelector('.vp-anlage-dash')).toBeTruthy());
      await waitFor(() =>
        expect(container.textContent).toContain('Es liegen noch keine Messwerte vor'),
      );
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
    // Default-Tab „Heute" (Captain 2026-07-30): die Ringe tragen die Periode
    // des gewählten Zeitraums.
    const now = new Date();
    const period = periodLabel('day', now, now);
    expect(period).toBe('Heute');
    expect(labels).toEqual([`Autarkie · ${period}`, `Eigenverbrauch · ${period}`]);
    // Nie das zeitraum-blinde kleingeschriebene „heute".
    expect(labels.join(' ')).not.toContain('· heute');
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
    // V13: KEIN Ring (nie „0 %") - aber der Platz bleibt reserviert und sagt,
    // warum er leer ist, damit die Seitenhöhe beim Tab-Wechsel nicht springt.
    expect(container.querySelector('.vp-hero-ring')).toBeNull();
    expect(container.querySelector('.vp-hero-rings-empty')).toBeTruthy();
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

  it('Merge: das Komponenten-Board rendert im Cockpit — die Fluss-Kacheln sind weg', async () => {
    // Option A (R2): das Board ist die EINE Live-Wert-Fläche des Cockpits;
    // die vier früheren Fluss-Kacheln existieren im Widget-Raster nicht mehr.
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-puls')).toBeTruthy());
    // Board rows für die Topologie-Rollen (Speicher, Netz).
    const rowNames = [...container.querySelectorAll('.vp-puls-name')].map((n) => n.textContent);
    expect(rowNames).toContain('Netz');
    // Keine Fluss-Kacheln im Raster.
    const widgetLabels = [...container.querySelectorAll('.vp-widget-label')].map(
      (n) => n.textContent,
    );
    for (const gone of ['Erzeugung', 'Speicher', 'Haus', 'Netz']) {
      expect(widgetLabels).not.toContain(gone);
    }
    // Der Verlauf ist eingeklappt (Q2): Toggle zu, kein Chart-Fenster-Seg.
    const toggle = container.querySelector('.vp-verlauf-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('Merge: ein Board-Zeilen-Sprung navigiert in den Verlauf mit Zeitraum-Übernahme', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-puls')).toBeTruthy());
    window.location.hash = '';
    // Die Netz-Zeile antippen — die ganze Zeile IST der Absprung (PR 2).
    const netzRow = [...container.querySelectorAll('.vp-puls-row')].find(
      (b) => b.querySelector('.vp-puls-name')?.textContent === 'Netz',
    ) as HTMLButtonElement;
    fireEvent.click(netzRow);
    // Der Hash trägt den Verlauf-Deeplink (Messwert + übernommener Zeitraum).
    expect(window.location.hash).toContain('/anlage/s-1/messwerte');
    expect(window.location.hash).toContain('m=e-grid:power_kw');
    expect(window.location.hash).toContain('z=tag'); // Default „Heute" → Tag
    // NIE ein Modal — weder am body noch im Container.
    expect(document.body.querySelector('.vp-wmodal')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('V2: eine Modus-Kachel öffnet ihre Seite über onOpenSub', async () => {
    const opened: string[] = [];
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite((sub) => opened.push(sub));
    await waitFor(() => expect(container.querySelector('.vp-widgets')).toBeTruthy());
    const automatik = [...container.querySelectorAll('.vp-widget')].find(
      (w) => w.querySelector('.vp-widget-label')?.textContent === 'Geräte-Automatik',
    ) as HTMLButtonElement;
    fireEvent.click(automatik);
    expect(opened).toContain('steuerung');
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
    // Eigenverbrauch is base behaviour (report §3.3): no mode card, no EV widget -
    // its value shows in the hero rings / MoneyView instead.
    expect(labels).not.toContain('Eigenverbrauch');
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

  // Markt & Tag (vp-cockpit-unten-ux-n3, PR 1): der Börsenpreis-Streifen führt
  // die untere Hälfte an — gated auf die Marktpreise-Regel (Markt-Modus ∨
  // dynamischer Tarif; die Fixture-Anlage trägt `tarifArt: 'dynamisch'`).
  it('trägt den Börsenpreis-Streifen mit Wert, Urteil und Absprung', async () => {
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
    mockAdaptive(true);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-strompreis')).toBeTruthy());
    const strip = container.querySelector('.vp-strompreis') as HTMLElement;
    expect(strip.textContent).toContain('Börsenpreis');
    expect(strip.textContent).toContain('ct/kWh');
    expect(strip.textContent).toContain('Marktpreise');
    // Der Streifen sitzt VOR der Komponenten-Sektion (Kopf der unteren Hälfte).
    const komponenten = container.querySelector('.vp-komponenten');
    expect(komponenten).toBeTruthy();
    expect(
      strip.compareDocumentPosition(komponenten as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // PR 4 (Konzept §4b): die kurze Speicher-Fahrplan-Karte sitzt DIREKT unter
  // dem Börsenpreis-Streifen — ① Markt (warum) → ①b Speicher-Fahrplan (was
  // der Plan draus macht) → ② Komponenten. Gated wie die Fahrplan-Ansicht
  // (Speicher vorhanden); der volle Chart lebt nur auf der Fahrplan-Seite.
  it('trägt die kurze Speicher-Fahrplan-Karte zwischen Preis-Streifen und Komponenten', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-fp-band')).toBeTruthy());
    const band = container.querySelector('.vp-fp-band') as HTMLElement;
    expect(band.textContent).toContain('Speicher-Fahrplan');
    // Ohne Plan (Standard-Stub): die ruhige Leere, kein voller Chart.
    expect(band.textContent).toContain('Für heute liegt noch kein Fahrplan vor.');
    expect(band.querySelector('.vp-chart')).toBeNull();
    // Reihenfolge: Streifen → Karte → Komponenten.
    const strip = container.querySelector('.vp-strompreis');
    const komponenten = container.querySelector('.vp-komponenten');
    expect(strip).toBeTruthy();
    expect(komponenten).toBeTruthy();
    expect(
      (strip as Node).compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      band.compareDocumentPosition(komponenten as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('v1 kennt keinen Börsenpreis-Streifen — und ruft die Preise gar nicht ab', async () => {
    mockAdaptive(false);
    mockSurface(LEER);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-anlage-dash')).toBeTruthy());
    expect(container.querySelector('.vp-strompreis')).toBeNull();
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

    // Default „Heute" (Captain 2026-07-30): der Tageswert unter dem Tagesetikett.
    await waitFor(() => expect(ringValues(container)[0]).toContain('40'));
    expect(ringLabels(container)[0]).toBe('Autarkie · Heute');

    // „Jahr": der Wert UND das Etikett folgen dem Tab.
    fireEvent.click(tab(container, 'Jahr'));
    await waitFor(() => expect(ringValues(container)[0]).toContain('71'));
    expect(ringLabels(container)).toEqual([
      `Autarkie · ${periodLabel('year', now, now)}`,
      `Eigenverbrauch · ${periodLabel('year', now, now)}`,
    ]);

    // „Monat": das Monatsetikett, der Monatswert.
    fireEvent.click(tab(container, 'Monat'));
    await waitFor(() => expect(ringValues(container)[0]).toContain('64'));
    expect(ringLabels(container)).toEqual([
      `Autarkie · ${periodLabel('month', now, now)}`,
      `Eigenverbrauch · ${periodLabel('month', now, now)}`,
    ]);

    // „Gesamt": kein All-Zeit-Historie-Endpunkt → keine Ringe (nie ein falscher
    // Wert), aber der Energiefluss bleibt live sichtbar.
    fireEvent.click(tab(container, 'Gesamt'));
    await waitFor(() => expect(container.querySelector('.vp-hero-ring')).toBeNull());
    // V13: statt eines Höhensprungs steht dort der ehrliche Satz.
    expect(container.querySelector('.vp-hero-rings-empty')?.textContent).toContain(
      'Monat oder Jahr',
    );
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
    for (const label of ['Monat', 'Jahr', 'Gesamt', 'Heute']) {
      fireEvent.click(tab(container, label));
      await waitFor(() =>
        expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')).toBeTruthy(),
      );
    }
    expect(container.querySelector('.vp-hero-flow .vp-flow-wrap')?.innerHTML).toBe(flowBefore);
  });
});

describe('Die Bühne (Konzept vp-cockpit-konzept-f4, Richtung A)', () => {
  it('stellt den Zeitraum IN die Bilanz-Leiste - keine vollbreite Zeile für vier Knöpfe mehr', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-cockpit-hero')).toBeTruthy());
    // Das Segment steht in der Leiste, unter dem Etikett „Bilanz" ...
    const seg = container.querySelector('.vp-hero-side .vp-seg.vp-seg-compact');
    expect(seg).toBeTruthy();
    expect(container.querySelector('.vp-hero-seg')?.textContent).toContain('Bilanz');
    // ... und die alte Seitenzeile gibt es auf der Bühne nicht mehr (P2).
    expect(container.querySelector('.vp-period-tabs')).toBeNull();
  });

  it('steht standardmäßig auf HEUTE, nicht auf Monat (Captain 2026-07-30)', async () => {
    mockAdaptive(true, TOPO);
    mockSurface(MULTI);
    const { container } = renderSeite();
    await waitFor(() => expect(container.querySelector('.vp-hero-side .vp-seg')).toBeTruthy());
    const active = container.querySelector('.vp-hero-side .vp-seg button.active');
    expect(active?.textContent).toBe('Heute');
    expect([...container.querySelectorAll('[role="tab"][aria-selected="true"]')]).toHaveLength(1);
    // Die Kennzahlen, die der Umschalter regiert, tragen dieselbe Periode.
    expect(container.querySelector('.vp-hero-ring-label')?.textContent).toBe('Autarkie · Heute');
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

  it('trägt die Steuerung als Bühnenfuß und den Bestätigungs-Haken am Speicher', async () => {
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
    await waitFor(() => expect(container.querySelector('.vp-stage-foot')).toBeTruthy());
    const foot = container.querySelector('.vp-stage-foot')!;
    // Sollwert → Bestätigung, über die volle Breite und ohne Karte-in-Karte.
    expect(foot.querySelector('.vp-control-foot')).toBeTruthy();
    expect(foot.textContent).toContain('regelt gerade auf');
    expect(container.querySelector('.vp-hero-flow .vp-stage-foot')).toBeNull();
    // Verzahnung: die Bestätigung ist AM Diagramm ablesbar.
    await waitFor(() => expect(container.querySelector('.vp-flow-confirm')).toBeTruthy());
    const storageTitle = [...container.querySelectorAll('.vp-hero-flow title')].map(
      (t) => t.textContent,
    );
    expect(storageTitle.some((t) => t?.includes('Sollwert bestätigt'))).toBe(true);
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
    expect(card?.textContent).toContain('Anlagen-Modell');
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
    // … und die Modus-Zeile wohnt als Fuß IN der Fläche — kein Baumler mehr.
    expect(card?.querySelector('.vp-zustand-foot .vp-toolbox-line')).not.toBeNull();
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
      expect(container.querySelector('.vp-anlage-dash')).not.toBeNull();
    });
    // Kein onHealthFacts übergeben: die Seite rendert unverändert weiter.
    expect(container.querySelector('.vp-cockpit-health')).toBeNull();
  });
});
