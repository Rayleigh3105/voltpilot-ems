import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AnlageSeite } from './AnlagenPage';
import { api, type Site } from '../api';
import * as flowsApi from '../flows/flowsApi';

/**
 * M6 (#534) — der v1-Beweis über die ECHTEN Weichen (report §6.2).
 *
 * `AnlagenPage.test.tsx` (M3) nagelt die Invariante über die GEMOCKTEN Hooks
 * fest: gleiche Anlage, zwei Surfaces, zeichengleiche DOMs. Was dort naturgemäß
 * offen bleibt, ist der Weg dorthin — ob eine nie migrierte Anlage die Weichen
 * aus den ECHTEN Endpunkt-Antworten überhaupt zu bekommt. Genau das prüft diese
 * Datei: `useAdaptiveLive` + `useAnlageSurface` laufen unverändert, gefüttert
 * mit dem, was eine Bestandsanlage heute wirklich liefert (leere Topologie,
 * keine v2-Entitäten, keine Flows — und einmal: ein Backend, das die
 * v2-Routen gar nicht kennt und 404t).
 *
 * Das Cockpit selbst wird NICHT angefasst — hier wird nur bewiesen.
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

/** Alles, was die Anlagen-Seite sonst noch lädt — leer, aber wohlgeformt. */
function stubCommonApi() {
  vi.spyOn(api, 'overview').mockResolvedValue({
    sites: [],
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

/** Ein älteres Backend: die v2-Routen gibt es nicht (jede Antwort ein Fehler). */
function stubOlderBackend() {
  const boom = () => Promise.reject(new Error('404'));
  vi.spyOn(api, 'topology').mockImplementation(boom as never);
  vi.spyOn(api, 'siteEntities').mockImplementation(boom as never);
  vi.spyOn(api, 'usageProfile').mockImplementation(boom as never);
  vi.spyOn(api, 'siteSources').mockImplementation(boom as never);
  vi.spyOn(api, 'entityHistory').mockImplementation(boom as never);
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

async function renderAndSettle() {
  const view = renderSeite();
  await waitFor(() => expect(view.container.querySelector('.vp-anlage-dash')).toBeTruthy());
  // Die fail-soften Hooks setzen ihren State asynchron - kurz ausschwingen
  // lassen, damit ein verspäteter Stapel nicht durchrutschen könnte. Die lazy
  // Komponenten-Sektion (Cockpit+Live-Merge) muss ihren Endzustand erreicht
  // haben, sonst verglichen wir einen Lade- mit einem Endzustand.
  await waitFor(() => expect(view.container.querySelector('.vp-stack')).toBeNull());
  await waitFor(() =>
    expect(view.container.textContent).toContain('Es liegen noch keine Messwerte vor'),
  );
  return view;
}

beforeEach(() => {
  vi.restoreAllMocks();
  stubCommonApi();
});

describe('v1-Invariante über die echten Weichen (M6)', () => {
  it('eine nie migrierte Anlage rendert das heutige Cockpit, ohne M3-Knoten', async () => {
    stubNeverMigrated();
    const { container } = await renderAndSettle();
    expect(container.querySelector('.vp-zone-money')).toBeTruthy();
    expect(container.querySelector('.vp-dash-fahrplan')).toBeTruthy();
    expect(container.querySelector('.vp-block')).toBeNull();
    expect(container.querySelector('.vp-toolbox-line')).toBeNull();
    expect(container.querySelector('.vp-streams-block')).toBeNull();
  });

  it('bleibt zeichengleich, wenn das Backend die v2-Routen gar nicht kennt', async () => {
    stubNeverMigrated();
    const a = await renderAndSettle();
    const migrationslos = a.container.innerHTML;
    a.unmount();

    vi.restoreAllMocks();
    stubCommonApi();
    stubOlderBackend();
    const b = await renderAndSettle();
    expect(b.container.innerHTML).toBe(migrationslos);
  });
});
