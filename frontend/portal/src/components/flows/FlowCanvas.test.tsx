/**
 * Canvas render smoke: the pure layout carries the exhaustive coverage
 * (src/flows/layout.test.ts); here we assert the SVG renders the pilot
 * chain, selection/interaction callbacks fire, and connect-mode highlights
 * compatible inputs (jsdom renders SVG natively - no canvas needed).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorEntity } from '../../flows/model';
import { pilotTemplate } from '../../flows/templates';
import { FlowCanvas } from './FlowCanvas';

const ENTITIES: EditorEntity[] = [
  {
    id: 'batt-main',
    entityType: 'battery-hybrid',
    label: 'Speicher',
    measure: ['soc_pct'],
    actuate: ['setpoint_kw'],
  },
];

function renderCanvas(overrides: Partial<Parameters<typeof FlowCanvas>[0]> = {}) {
  const doc = pilotTemplate('Pilot', 'batt-main', 'site-1');
  const props = {
    doc,
    entities: ENTITIES,
    selection: null,
    connectFrom: null,
    errorNodeIds: new Set<string>(),
    errorEdgeIds: new Set<string>(),
    onSelectNode: vi.fn(),
    onSelectEdge: vi.fn(),
    onPortClick: vi.fn(),
    onBackground: vi.fn(),
    ...overrides,
  };
  render(<FlowCanvas {...props} />);
  return props;
}

describe('FlowCanvas', () => {
  it('renders every pilot node and edge', () => {
    renderCanvas();
    for (const id of ['price1', 'pv1', 'soc1', 'strat1', 'ctl1']) {
      expect(screen.getByTestId(`node-${id}`)).toBeInTheDocument();
    }
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      expect(screen.getByTestId(`edge-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByText('Marktoptimierung')).toBeInTheDocument();
  });

  it('selects nodes and edges via click', () => {
    const props = renderCanvas();
    fireEvent.click(screen.getByTestId('node-strat1'));
    expect(props.onSelectNode).toHaveBeenCalledWith('strat1');
    fireEvent.click(screen.getByTestId('edge-e1'));
    expect(props.onSelectEdge).toHaveBeenCalledWith('e1');
  });

  it('starts a connection on an output port click', () => {
    const props = renderCanvas();
    fireEvent.click(screen.getByTestId('port-out-price1-prices'));
    expect(props.onPortClick).toHaveBeenCalledWith(
      { node: 'price1', port: 'prices' }, 'out', 'price',
    );
  });

  it('connect mode highlights compatible inputs only', () => {
    // Price source: price_in (price) and the widened timeseries input light
    // up; the plan input does not.
    renderCanvas({
      connectFrom: { ref: { node: 'price1', port: 'prices' }, type: 'price' },
    });
    expect(screen.getByTestId('port-in-strat1-price_in').getAttribute('class'))
      .toContain('accepts');
    expect(screen.getByTestId('port-in-strat1-pv_forecast').getAttribute('class'))
      .toContain('accepts');
    expect(screen.getByTestId('port-in-ctl1-plan').getAttribute('class'))
      .not.toContain('accepts');
  });

  it('marks error nodes', () => {
    renderCanvas({ errorNodeIds: new Set(['strat1']) });
    expect(screen.getByTestId('node-strat1').getAttribute('class')).toContain('error');
  });
});

// --- Portal v3 M5: drag, live chips, node states, read-only preview --------

describe('FlowCanvas (M5 interactive)', () => {
  function dragNode(testId: string, dx: number, dy: number) {
    const node = screen.getByTestId(testId);
    fireEvent.pointerDown(node, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { clientX: 100 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(node, { clientX: 100 + dx, clientY: 100 + dy });
  }

  it('reports a dragged position, snapped and never negative', () => {
    const onPositionChange = vi.fn();
    renderCanvas({ onPositionChange, positions: { strat1: { x: 200, y: 120 } } });
    dragNode('node-strat1', 41, -33);
    expect(onPositionChange).toHaveBeenCalledTimes(1);
    const [id, pos] = onPositionChange.mock.calls[0];
    expect(id).toBe('strat1');
    expect(pos.x % 8).toBe(0);
    expect(pos.y % 8).toBe(0);
    expect(pos.x).toBeGreaterThan(200);
  });

  it('a drag is not a selection (a plain click still selects)', () => {
    const onPositionChange = vi.fn();
    const props = renderCanvas({ onPositionChange });
    dragNode('node-strat1', 60, 60);
    fireEvent.click(screen.getByTestId('node-strat1'));
    expect(props.onSelectNode).not.toHaveBeenCalled();
  });

  it('stays non-interactive without onPositionChange (the read-only preview)', () => {
    const props = renderCanvas(); // no onPositionChange -> preview mode
    dragNode('node-strat1', 60, 60);
    expect(screen.getByTestId('node-strat1').getAttribute('class')).not.toContain('draggable');
    // ...and a click still selects, so the preview keeps working as before.
    fireEvent.click(screen.getByTestId('node-strat1'));
    expect(props.onSelectNode).toHaveBeenCalledWith('strat1');
  });

  it('renders live chips on wires and only the reported node states', () => {
    renderCanvas({
      live: {
        chips: { e1: '2,9 kW' },
        nodeStates: { strat1: { label: 'erfüllt', tone: 'ok' } },
        hasNodeStates: true,
      },
    });
    expect(screen.getByTestId('chip-e1')).toHaveTextContent('2,9 kW');
    expect(screen.getByTestId('state-strat1')).toHaveTextContent('erfüllt');
    expect(screen.queryByTestId('state-ctl1')).toBeNull();
  });

  it('shows no node state at all without the device block', () => {
    renderCanvas({ live: { chips: {}, nodeStates: {}, hasNodeStates: false } });
    for (const id of ['price1', 'pv1', 'soc1', 'strat1', 'ctl1']) {
      expect(screen.queryByTestId(`state-${id}`)).toBeNull();
    }
  });
});
