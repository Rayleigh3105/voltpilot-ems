import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteTopology, SiteUsageProfile, TopologyEntity } from '../api';
import type { FlowNode } from '../topology';
import { NODE_MARKET } from '../usageProfile';
import { AdaptiveLiveView } from './AdaptiveLiveView';

function entity(id: string, type: string, label: string): TopologyEntity {
  return { id, entityType: type, typeLabel: label, label, category: '', health: 'ok', capabilities: [] };
}

const NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 72.6,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 72.6 }],
  },
  {
    role: 'storage',
    value_kw: 4,
    soc_pct: 45,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'batt', label: 'Deye', primary: true, value_kw: 4 }],
  },
  {
    role: 'consumer',
    value_kw: 11,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'wb', label: 'Wallbox', primary: true, value_kw: 11 }],
  },
  {
    role: 'grid',
    value_kw: 54.2,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: -54.2 }],
  },
];

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    entity('pv', 'producer', 'Fronius'),
    entity('batt', 'battery-hybrid', 'Deye'),
    entity('wb', 'wallbox', 'Wallbox'),
    entity('grid', 'grid-meter', 'Netz'),
  ],
  topology: { schema_version: '1.0', nodes: NODES },
};

const ARB_PROFILE: SiteUsageProfile = {
  usageProfile: 'arbitrage',
  derivedProfile: 'arbitrage',
  override: null,
  emphasis: { money: 'prominent', peak: 'hidden', flow: 'secondary', devices: 'secondary' },
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: [NODE_MARKET],
    plantKind: 'direktvermarktung',
    hasLeistungspreis: false,
  },
};

describe('AdaptiveLiveView', () => {
  it('renders the status sentence, the N-node flow, tiles and the module strip', () => {
    const { container } = render(<AdaptiveLiveView topology={TOPO} profile={ARB_PROFILE} />);
    // status sentence + profile chip
    expect(screen.getByText(/erzeugt gerade/)).toBeInTheDocument();
    expect(screen.getByText('Arbitrage / DV')).toBeInTheDocument();
    // the energy-flow svg carries the hub + one node circle per member.
    const svg = container.querySelector('.vp-flow-adaptive svg')!;
    // direct-child node/hub circles (excludes circles inside nested Icon svgs).
    const nodeCircles = svg.querySelectorAll(':scope > circle, :scope > g > circle');
    expect(nodeCircles.length).toBe(5);
    // tiles + flow name the entities by their SHORT generalised word, and the
    // full stored name stays reachable on the tile header's tooltip.
    expect(screen.getAllByText('Erzeuger').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Batteriespeicher').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Wallbox').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('.vp-verdict.pv .vp-verdict-head')).toHaveAttribute(
      'title',
      'Fronius',
    );
    // module strip reflects the active market node.
    expect(screen.getByText('Was läuft')).toBeInTheDocument();
    expect(screen.getByText('Marktoptimierung')).toBeInTheDocument();
  });

  it('shows read-only device switches on a controllable consumer tile', () => {
    render(<AdaptiveLiveView topology={TOPO} profile={ARB_PROFILE} />);
    const nurPv = screen.getByRole('button', { name: 'Nur PV' });
    expect(nurPv).toBeDisabled();
  });

  it('renders without a profile (emphasis best-effort)', () => {
    render(<AdaptiveLiveView topology={TOPO} profile={null} />);
    expect(screen.getByText(/erzeugt gerade/)).toBeInTheDocument();
  });
});
