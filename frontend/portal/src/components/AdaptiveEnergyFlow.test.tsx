import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteSource, SiteTopology, TopologyEntity } from '../api';
import type { FlowMember } from '../topology';
import type { EntityPin } from '../pvReconcile';
import { AdaptiveEnergyFlow } from './AdaptiveEnergyFlow';

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

function entity(over: Partial<TopologyEntity> & { id: string }): TopologyEntity {
  return {
    entityType: 'producer',
    typeLabel: 'Erzeuger',
    label: null,
    category: 'producer',
    health: 'ok',
    capabilities: [],
    ...over,
  };
}

function siteTopology(members: FlowMember[], entities: TopologyEntity[]): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities,
    topology: {
      schema_version: '1.0',
      nodes: [
        { role: 'pv', value_kw: 69.8, flow_active: true, direction: 'in', members },
        {
          role: 'storage',
          value_kw: 8.2,
          soc_pct: 69,
          flow_active: true,
          direction: 'out',
          members: [{ entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 8.2 }],
        },
        {
          role: 'grid',
          value_kw: 33.3,
          flow_active: true,
          direction: 'out',
          members: [{ entity_id: 'deye', label: 'Netzanschluss', primary: true, value_kw: -33.3 }],
        },
      ],
    },
  };
}

/** The captain's plant: the hybrid carries the whole plant's PV, /sources splits it. */
const MULTI = siteTopology(
  [
    {
      entity_id: 'deye',
      label: 'Batteriespeicher (Hybrid-Wechselrichter)',
      primary: true,
      value_kw: 69.8,
    },
    { entity_id: 'f1', label: 'Fronius (Erzeuger)', primary: false },
    { entity_id: 'f2', label: 'Fronius 2 (Erzeuger)', primary: false },
  ],
  [
    entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: 'Batteriespeicher' }),
    entity({ id: 'f1', health: 'never' }),
    entity({ id: 'f2', health: 'never' }),
  ],
);

const MULTI_SOURCES: SiteSource[] = [
  src({ sourceId: 'inv', kind: 'primary', role: null, brand: 'deye', model: 'SUN-30K-SG01HP3-EU', pvKw: 23 }),
  src({ sourceId: 'a', label: 'Fronius Anlage', pvKw: 21.3 }),
  src({ sourceId: 'b', label: 'Fronius Anlage WR 2', pvKw: 25.5 }),
];

/** The pins: each producer names the source that measures it (never the order). */
const MULTI_PINS: EntityPin[] = [
  { id: 'deye', edgeSourceId: null },
  { id: 'f1', edgeSourceId: 'a' },
  { id: 'f2', edgeSourceId: 'b' },
];

const SINGLE = siteTopology(
  [{ entity_id: 'deye', label: 'Deye', primary: true, value_kw: 8.3 }],
  [entity({ id: 'deye' })],
);

describe('AdaptiveEnergyFlow · one node per role', () => {
  it('draws four circles, not one per device', () => {
    const { container } = render(<AdaptiveEnergyFlow topology={MULTI} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    const names = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    expect(names).toContain('PV-Erzeugung');
    expect(names).toContain('Batteriespeicher');
    expect(names).toContain('Netz');
    // No device name is printed in the diagram - the hybrid appears once, as
    // the Speicher; its PV share lives in the composition behind the click.
    expect(names.join(' ')).not.toMatch(/Deye|Fronius/);
    expect(container.querySelectorAll('svg text')).not.toHaveLength(0);
    // and no empty "–" circle survives
    expect(names).not.toContain('–');
  });
});

describe('AdaptiveEnergyFlow · click on PV-Erzeugung opens the composition', () => {
  it('offers the details, opens them on click and closes again', () => {
    const { container } = render(<AdaptiveEnergyFlow topology={MULTI} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    const node = screen.getByRole('button', { name: /PV-Erzeugung/ });
    expect(node).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.vp-pvcomp')).toBeNull();
    // the affordance is visible before the click
    expect(
      Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent),
    ).toContain('3 Geräte');

    fireEvent.click(node);
    expect(screen.getByRole('button', { name: /PV-Erzeugung/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(container.querySelector('.vp-pvcomp')).not.toBeNull();
    expect(screen.getByText('Deye SUN-30K')).toBeInTheDocument();
    expect(screen.getByText('Fronius Anlage')).toBeInTheDocument();
    expect(screen.getByText('Fronius Anlage WR 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /PV-Erzeugung/ }));
    expect(container.querySelector('.vp-pvcomp')).toBeNull();
  });

  it('opens on Enter and Space, so it is reachable without a mouse', () => {
    const { container } = render(<AdaptiveEnergyFlow topology={MULTI} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    const node = screen.getByRole('button', { name: /PV-Erzeugung/ });
    expect(node).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(container.querySelector('.vp-pvcomp')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: /PV-Erzeugung/ }), { key: ' ' });
    expect(container.querySelector('.vp-pvcomp')).toBeNull();
  });

  it('offers nothing on a single-inverter plant - there is nothing to explain', () => {
    const { container } = render(
      <AdaptiveEnergyFlow
        topology={SINGLE}
        sources={[src({ sourceId: 'inv', kind: 'primary', role: null, pvKw: 8.3 })]}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.vp-pvcomp')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent),
    ).not.toContain('1 Geräte');
  });

  it('lists all six inverters of a large plant', () => {
    const members: FlowMember[] = Array.from({ length: 6 }, (_, i) => ({
      entity_id: `wr${i}`,
      label: `Wechselrichter ${i + 1}`,
      primary: i === 0,
      value_kw: 5 + i,
    }));
    const six = siteTopology(
      members,
      members.map((m) => entity({ id: m.entity_id })),
    );
    const { container } = render(<AdaptiveEnergyFlow topology={six} sources={null} />);
    const node = screen.getByRole('button', { name: /PV-Erzeugung/ });
    fireEvent.click(node);
    expect(container.querySelectorAll('.vp-pvcomp-row')).toHaveLength(6);
    // the diagram itself stayed four circles
    const names = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    expect(names.filter((n) => n === 'PV-Erzeugung')).toHaveLength(1);
    expect(names).toContain('6 Geräte');
  });
});
