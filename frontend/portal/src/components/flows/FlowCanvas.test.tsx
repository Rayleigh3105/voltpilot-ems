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
