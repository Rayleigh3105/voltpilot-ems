/**
 * The three rollout-honesty fixes of the 2026-07-24 control audit, on the ONE
 * editor both surfaces share:
 *
 * - **E-1** a plain-German REVIEW step between the guided builder and the
 *   canvas (the builder promised "… Gerät wählen, fertig" and then dropped the
 *   customer onto a 12-block technical palette),
 * - **E-7** the dry-run's own precise German cause instead of the generic
 *   "bitte versuchen Sie es erneut" - an instruction one can follow forever,
 * - **E-6** the failing STEP is the one that actually ran (the catch-all
 *   hardcoded `ausrollen`, so a simulate throw rendered "Prüfen ✓ ·
 *   Simulieren ✓ · Ausrollen ✗" next to a simulation-service message).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FlowEditorPage } from './FlowEditorPage';
import { ApiError, api, type Site } from '../../api';
import type { BoundFlowApi, FlowVersion } from '../../flows/flowsApi';
import type { EditorEntity, FlowDocument } from '../../flows/model';

const SITE: Site = {
  id: 's-1',
  name: 'Halle Nord',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'fest',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  leistungspreisEurKw: null,
  peakReserveSocPct: null,
};

const ENTITIES: EditorEntity[] = [
  { id: 'wb', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off'] },
];

/** Zeitfenster → Wallbox ein: exactly what the guided builder emits. */
const DOC: FlowDocument = {
  schema_version: '1.0',
  name: 'Wallbox mittags',
  runtime: 'edge',
  nodes: [
    { id: 'zeit1', type: 'vp.schedule.window', type_version: '1.0.0', parameters: { from: '11:00', to: '15:00', days: 'alle' } },
    {
      id: 'steuern1',
      type: 'vp.entity.control',
      type_version: '1.0.0',
      parameters: { entity_id: 'wb', command: 'on_off', ttl_s: 300 },
      claims: [{ entity_id: 'wb', commands: ['on_off'] }],
    },
  ],
  edges: [
    { id: 'e1', from: { node: 'zeit1', port: 'active' }, to: { node: 'steuern1', port: 'value' } },
  ],
  triggers: [{ id: 't1', kind: 'slot-boundary' }],
};

function version(over: Partial<FlowVersion> = {}): FlowVersion {
  return {
    flowId: 'f-1',
    flowVersion: 1,
    siteId: 's-1',
    name: 'Wallbox mittags',
    runtime: 'edge',
    lifecycle: 'draft',
    document: DOC,
    simulation: null,
    createdAt: '2026-07-24T09:00:00Z',
    updatedAt: '2026-07-24T09:00:00Z',
    simulatedAt: null,
    activatedAt: null,
    ...over,
  };
}

function fakeApi(over: Partial<BoundFlowApi> = {}): BoundFlowApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    get: vi.fn().mockResolvedValue(version()),
    save: vi.fn().mockResolvedValue(version()),
    remove: vi.fn(),
    validate: vi.fn().mockResolvedValue({ valid: true, findings: [] }),
    simulate: vi.fn().mockResolvedValue({ simulationId: 'sim-1', flowScenario: null }),
    simulationStatus: vi.fn().mockResolvedValue({ status: 'done', progress: 1 }),
    activate: vi.fn().mockResolvedValue({
      activated: true, published: true, message: 'Flow aktiviert (Version 1).', lifecycle: 'active',
    }),
    deactivate: vi.fn(),
    entities: vi.fn().mockResolvedValue(ENTITIES),
    governance: vi.fn().mockResolvedValue({ gatedNodes: [] }),
    layout: vi.fn().mockResolvedValue({ positions: {} }),
    saveLayout: vi.fn().mockResolvedValue(undefined),
    liveStatus: vi.fn().mockResolvedValue({ acks: [], nodes: [] }),
    socBands: vi.fn().mockResolvedValue(null),
    ...over,
  } as BoundFlowApi;
}

beforeEach(() => {
  vi.spyOn(api, 'topology').mockResolvedValue({ entities: [], topology: { nodes: [], flows: [] } } as never);
});

describe('FlowEditorPage · the review step (audit E-1)', () => {
  it('opens on the rule in plain German, not on the canvas', async () => {
    render(
      <FlowEditorPage
        api={fakeApi()}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        initialView="review"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('Ihre Regel')).toBeInTheDocument();
    // The rule reads as sentences...
    expect(screen.getByTestId('flow-steplist').textContent)
      .toMatch(/Wenn es zwischen 11:00 und 15:00 Uhr ist/);
    expect(screen.getByTestId('flow-steplist').textContent).toMatch(/Wallbox/);
    // ...the technical palette and canvas are NOT in the way.
    expect(screen.queryByLabelText('Baustein-Katalog')).toBeNull();
    expect(screen.queryByTestId('flow-canvas')).toBeNull();
    // ...and the guard promise is still stated.
    expect(document.body.textContent).toMatch(/Nicht editierbar/);
    // ...and NOT the phone footer of the reused step list - on a desktop
    // review step "an einem größeren Bildschirm" would be plainly untrue.
    expect(document.body.textContent).not.toMatch(/größeren Bildschirm/);
  });

  it('offers the editor as an option, never as the destination', async () => {
    render(
      <FlowEditorPage
        api={fakeApi()}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        initialView="review"
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Im Editor öffnen' }));
    expect(await screen.findByLabelText('Baustein-Katalog')).toBeInTheDocument();
  });

  it('still opens the canvas directly for an existing flow (default)', async () => {
    render(
      <FlowEditorPage
        api={fakeApi()}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByLabelText('Baustein-Katalog')).toBeInTheDocument();
    expect(screen.queryByText('Ihre Regel')).toBeNull();
  });

  it('rolls out from the review step and says so in customer German (E-9)', async () => {
    const flowApi = fakeApi();
    render(
      <FlowEditorPage
        api={flowApi}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        initialView="review"
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ausrollen' }));

    await waitFor(() => expect(flowApi.activate).toHaveBeenCalled());
    const strip = await screen.findByTestId('rollout-strip');
    await waitFor(() => expect(strip.textContent)
      .toMatch(/Ihre Automation läuft jetzt auf dem Gerät/));
    // The raw server string never reaches the customer, and never twice.
    expect(document.body.textContent).not.toMatch(/Flow aktiviert/);
  });
});

describe('FlowEditorPage · honest rollout failures (audit E-7/E-6)', () => {
  it('E-7: shows the dry-run’s own precise cause, not "bitte erneut versuchen"', async () => {
    const flowApi = fakeApi({
      simulationStatus: vi.fn().mockResolvedValue({
        status: 'failed',
        progress: 0,
        error: 'Für das Jahr 2025 liegen nur 0 % der Börsenpreise vor.',
      }),
    });
    render(
      <FlowEditorPage
        api={flowApi}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        initialView="review"
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ausrollen' }));

    const strip = await screen.findByTestId('rollout-strip');
    await waitFor(() => expect(strip.textContent).toMatch(/nur 0 % der Börsenpreise/));
    expect(strip.textContent).not.toMatch(/Bitte versuchen Sie es erneut/);
    expect(flowApi.activate).not.toHaveBeenCalled();
  });

  it('E-6: blames the step that actually ran when a call throws', async () => {
    const flowApi = fakeApi({
      simulate: vi.fn().mockRejectedValue(
        new ApiError(502, 'Der Simulationsdienst ist gerade nicht erreichbar.'),
      ),
    });
    render(
      <FlowEditorPage
        api={flowApi}
        site={SITE}
        flowId="f-1"
        initialVersion={1}
        initialView="review"
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ausrollen' }));

    const strip = await screen.findByTestId('rollout-strip');
    await waitFor(() => expect(strip.textContent).toMatch(/Simulationsdienst/));
    const steps = Array.from(strip.querySelectorAll('.vp-rollout-step'))
      .map((el) => `${el.textContent}:${el.className.replace('vp-rollout-step ', '')}`);
    expect(steps).toEqual([
      'Prüfen:fertig',
      'Simulieren:fehler',
      'Ausrollen:uebersprungen',
    ]);
  });
});
