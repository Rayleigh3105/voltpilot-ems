import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteSource } from '../api';
import { PvBreakdownLine } from './PvBreakdown';

function src(over: Partial<SiteSource>): SiteSource {
  return {
    deviceId: 'd1',
    sourceId: 's1',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '2026-07-21T10:00:00Z',
    ...over,
  };
}

describe('PvBreakdownLine', () => {
  it('names each inverter with its share and a freshness dot', () => {
    const { container } = render(
      <PvBreakdownLine
        sources={[
          src({ sourceId: 'inverter', kind: 'primary', role: null, label: 'Deye', pvKw: 8.3 }),
          src({ sourceId: 'a', label: 'Fronius Anlage', pvKw: 21.3 }),
          src({ sourceId: 'b', label: 'Fronius WR 2', pvKw: 9.3, health: 'stale' }),
        ]}
      />,
    );
    expect(screen.getByText('Deye')).toBeInTheDocument();
    expect(screen.getByText('Fronius WR 2')).toBeInTheDocument();
    expect(container.querySelectorAll('.vp-pvsplit-part')).toHaveLength(3);
    expect(container.querySelectorAll('.vp-pvsplit-dot.stale')).toHaveLength(1);
  });

  it('renders nothing for a single-inverter site', () => {
    const { container } = render(
      <PvBreakdownLine
        sources={[src({ sourceId: 'inverter', kind: 'primary', role: null, pvKw: 8.3 })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the points are unknown', () => {
    const { container } = render(<PvBreakdownLine sources={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
