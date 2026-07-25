import { describe, expect, it } from 'vitest';
import type { TopologyEntity } from './api';
import { layoutFlow, wrapLabel } from './adaptiveFlow';
import type { FlowNode, Topology } from './topology';

const NBSP = ' ';

function entity(id: string, entityType: string, label: string): TopologyEntity {
  return { id, entityType, typeLabel: label, label, category: '', health: 'ok', capabilities: [] };
}

const PILOT_NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 72.6,
    flow_active: true,
    direction: 'in',
    members: [
      { entity_id: 'fronius', label: 'Fronius Symo', primary: true, value_kw: 60 },
      { entity_id: 'deye', label: 'Deye', primary: false, value_kw: 12.6 },
    ],
  },
  {
    role: 'storage',
    value_kw: 4,
    soc_pct: 45,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'deye', label: 'Deye 65 kWh', primary: true, value_kw: 4 }],
  },
  {
    role: 'consumer',
    value_kw: 11,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'goe', label: 'go-e', primary: true, value_kw: 11 }],
  },
  {
    role: 'grid',
    value_kw: 54.2,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'deye', label: 'Netz', primary: true, value_kw: -54.2 }],
  },
];

const TOPO: Topology = { schema_version: '1.0', nodes: PILOT_NODES };
const ENTITIES: TopologyEntity[] = [
  entity('fronius', 'producer', 'Fronius Symo'),
  entity('deye', 'battery-hybrid', 'Deye 65 kWh'),
  entity('goe', 'wallbox', 'go-e Charger'),
];

/** A plant with `n` PV members, everything else as the pilot. */
function withProducers(n: number): Topology {
  const members = Array.from({ length: n }, (_, i) => ({
    entity_id: `wr${i}`,
    label: `Wechselrichter ${i + 1}`,
    primary: i === 0,
    value_kw: 10,
  }));
  return {
    schema_version: '1.0',
    nodes: [
      { role: 'pv', value_kw: 10 * n, flow_active: true, direction: 'in', members },
      ...PILOT_NODES.slice(1),
    ],
  };
}

describe('layoutFlow · ONE circle per role (A1)', () => {
  it('draws four circles - one per role - however many devices there are', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices).toHaveLength(4);
    expect(l.vertices.map((v) => v.role)).toEqual(['pv', 'storage', 'consumer', 'grid']);
    expect(l.vertices.map((v) => v.label)).toEqual([
      'PV-Erzeugung',
      'Batteriespeicher',
      'Hausverbrauch',
      'Netz',
    ]);
    // one circle per side
    const pv = l.vertices.find((v) => v.role === 'pv')!;
    const storage = l.vertices.find((v) => v.role === 'storage')!;
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    const grid = l.vertices.find((v) => v.role === 'grid')!;
    expect(pv.x).toBeCloseTo(l.hubX);
    expect(pv.y).toBeLessThan(l.hubY);
    expect(storage.x).toBeLessThan(l.hubX);
    expect(consumer.x).toBeGreaterThan(l.hubX);
    expect(grid.y).toBeGreaterThan(l.hubY);
  });

  it('kills the doubled hybrid: one device is never two circles of one role set', () => {
    // The captain's plant: the Deye hybrid contributes to pv, storage AND grid.
    // Before A1 it drew a "Batteriespeicher · PV" circle next to the storage one.
    const l = layoutFlow(TOPO, ENTITIES);
    const labels = l.vertices.map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
    // No device name is printed in the diagram at all any more.
    for (const v of l.vertices) {
      expect(v.labelLines.join(' ')).not.toMatch(/Deye|Fronius|go-e/);
    }
    // The devices behind a role stay reachable on the tooltip.
    expect(l.vertices.find((v) => v.role === 'pv')!.title).toBe(
      'PV-Erzeugung · Fronius Symo, Deye',
    );
  });

  it('kills the empty "–" circles: a producer without an own value gets no circle', () => {
    const noSeries: Topology = {
      schema_version: '1.0',
      nodes: [
        {
          role: 'pv',
          value_kw: 69.8,
          flow_active: true,
          direction: 'in',
          members: [
            { entity_id: 'deye', label: 'Deye', primary: true, value_kw: 69.8 },
            { entity_id: 'f1', label: 'Fronius WR 1', primary: false },
            { entity_id: 'f2', label: 'Fronius WR 2', primary: false },
          ],
        },
      ],
    };
    const l = layoutFlow(noSeries, ENTITIES);
    expect(l.vertices).toHaveLength(1);
    expect(l.vertices[0].value).toBe(`69,8${NBSP}kW`);
    expect(l.vertices.some((v) => v.value === '–')).toBe(false);
  });

  it('shows the COMPOSITION total in the PV circle, so circle and rows agree', () => {
    const l = layoutFlow(TOPO, ENTITIES, { pvTotalKw: 69.8, pvDeviceCount: 3 });
    expect(l.vertices.find((v) => v.role === 'pv')!.value).toBe(`69,8${NBSP}kW`);
    // Without a composition it falls back to the node's own aggregate.
    expect(layoutFlow(TOPO, ENTITIES).vertices[0].value).toBe(`72,6${NBSP}kW`);
  });

  it('encodes the topology flow direction (in = node->hub, out = hub->node)', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices.find((v) => v.role === 'pv')!.reverse).toBe(false); // 'in'
    expect(l.vertices.find((v) => v.role === 'consumer')!.reverse).toBe(true); // 'out'
    expect(l.vertices.find((v) => v.role === 'pv')!.spokeActive).toBe(true);
  });

  it('shows SoC in the storage circle and |kW| elsewhere', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices.find((v) => v.role === 'storage')!.value).toBe(`45${NBSP}%`);
    expect(l.vertices.find((v) => v.role === 'grid')!.value).toBe(`54,2${NBSP}kW`); // abs of -54.2
  });

  it('returns no vertices for an empty topology', () => {
    expect(layoutFlow({ schema_version: '1.0', nodes: [] }, []).vertices).toHaveLength(0);
  });
});

describe('the caption under a circle', () => {
  it('offers the composition from two devices on, and stays quiet with one', () => {
    const one = layoutFlow(withProducers(1), ENTITIES, { pvDeviceCount: 1 });
    const pvOne = one.vertices.find((v) => v.role === 'pv')!;
    expect(pvOne.expandable).toBe(false);
    expect(pvOne.subLabel).toBeNull();

    const three = layoutFlow(withProducers(3), ENTITIES, { pvDeviceCount: 3 });
    const pvThree = three.vertices.find((v) => v.role === 'pv')!;
    expect(pvThree.expandable).toBe(true);
    expect(pvThree.subLabel).toBe('3 Geräte');
    expect(pvThree.memberCount).toBe(3);
  });

  it('never offers a composition on a role other than PV', () => {
    const l = layoutFlow(withProducers(6), ENTITIES, { pvDeviceCount: 6 });
    expect(l.vertices.filter((v) => v.expandable).map((v) => v.role)).toEqual(['pv']);
  });

  it('says the state in words for the other roles', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices.find((v) => v.role === 'storage')!.subLabel).toBe(`lädt 4,0${NBSP}kW`);
    expect(l.vertices.find((v) => v.role === 'grid')!.subLabel).toBe('Einspeisung');
    const importing = layoutFlow(
      {
        schema_version: '1.0',
        nodes: [
          {
            role: 'storage',
            value_kw: 3.4,
            soc_pct: 20,
            flow_active: true,
            direction: 'in',
            members: [{ entity_id: 'deye', label: 'Deye', primary: true, value_kw: 3.4 }],
          },
          {
            role: 'grid',
            value_kw: 2,
            flow_active: true,
            direction: 'in',
            members: [{ entity_id: 'deye', label: 'Netz', primary: true, value_kw: 2 }],
          },
        ],
      },
      ENTITIES,
    );
    expect(importing.vertices.find((v) => v.role === 'storage')!.subLabel).toBe(
      `entlädt 3,4${NBSP}kW`,
    );
    expect(importing.vertices.find((v) => v.role === 'grid')!.subLabel).toBe('Bezug');
  });

  it('says nothing where nothing is flowing', () => {
    const idle = layoutFlow(
      {
        schema_version: '1.0',
        nodes: [
          {
            role: 'grid',
            value_kw: 0,
            flow_active: false,
            members: [{ entity_id: 'deye', label: 'Netz', primary: true, value_kw: 0 }],
          },
        ],
      },
      ENTITIES,
    );
    expect(idle.vertices[0].subLabel).toBeNull();
  });
});

describe('the geometry never grows with the device count', () => {
  it('draws 1 and 6 inverters on the identical viewBox', () => {
    const one = layoutFlow(withProducers(1), ENTITIES, { pvDeviceCount: 1 });
    const six = layoutFlow(withProducers(6), ENTITIES, { pvDeviceCount: 6 });
    expect(one.W).toBe(560);
    expect(six.W).toBe(one.W);
    expect(six.H).toBe(one.H);
    expect(six.vertices.map((v) => [v.x, v.y])).toEqual(one.vertices.map((v) => [v.x, v.y]));
    expect(six.vertices).toHaveLength(4);
  });

  it('V15: a top node\'s spoke starts BELOW its label block, not at its centre', () => {
    // The animated dots ran straight through the caption under the PV circle,
    // because the spoke began at the circle centre.
    const l = layoutFlow(TOPO, ENTITIES);
    for (const v of l.vertices) {
      if (v.y < l.hubY) {
        expect(v.spokeY).toBeGreaterThan(v.y + l.nodeR);
      } else {
        // every other side keeps the untouched geometry
        expect(v.spokeX).toBeCloseTo(v.x, 6);
        expect(v.spokeY).toBeCloseTo(v.y, 6);
      }
    }
  });

  it('V9: the narrow (phone) layout is a slimmer viewBox with the same nodes', () => {
    const wide = layoutFlow(TOPO, ENTITIES);
    const narrow = layoutFlow(TOPO, ENTITIES, { narrow: true });
    expect(narrow.W).toBeLessThan(wide.W);
    expect(narrow.vertices.map((v) => v.key)).toEqual(wide.vertices.map((v) => v.key));
    expect(narrow.lblF).toBe(wide.lblF);
    const labelBlock = narrow.lblDy + 3 * narrow.lblLh;
    for (const v of narrow.vertices) {
      expect(v.x - narrow.nodeR).toBeGreaterThanOrEqual(0);
      expect(v.x + narrow.nodeR).toBeLessThanOrEqual(narrow.W);
      expect(v.y - narrow.nodeR).toBeGreaterThanOrEqual(0);
      expect(v.y + narrow.nodeR + labelBlock).toBeLessThanOrEqual(narrow.H);
    }
  });

  it('V9: a long caption on an outer column stays inside the narrow viewBox', () => {
    // SVG <text> is neither wrapped nor clipped by CSS - a centred label on the
    // left column ran past x=0 and rendered as "3atteriespeicher".
    const narrow = layoutFlow(TOPO, ENTITIES, { narrow: true, pvDeviceCount: 3 });
    for (const v of narrow.vertices) {
      const widest = Math.max(...v.labelLines.map((l) => l.length), v.subLabel?.length ?? 0, 1);
      const half = (widest * narrow.lblF * 0.55) / 2;
      expect(v.labelX - half).toBeGreaterThanOrEqual(-0.01);
      expect(v.labelX + half).toBeLessThanOrEqual(narrow.W + 0.01);
    }
  });

  it('every circle stays inside the viewBox, labels included', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    const labelBlock = l.lblDy + 3 * l.lblLh; // 2 name lines + the caption line
    for (const v of l.vertices) {
      expect(v.y - l.nodeR).toBeGreaterThanOrEqual(0);
      expect(v.y + l.nodeR + labelBlock).toBeLessThanOrEqual(l.H);
      expect(v.x - l.nodeR).toBeGreaterThanOrEqual(0);
      expect(v.x + l.nodeR).toBeLessThanOrEqual(l.W);
    }
  });
});

describe('wrapLabel', () => {
  it('keeps a short name on one line', () => {
    expect(wrapLabel('Netz')).toEqual(['Netz']);
  });

  it('breaks on spaces into at most two lines', () => {
    const lines = wrapLabel('Batteriespeicher Hybrid Wechselrichter');
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain('Batteriespeicher');
  });

  it('cuts a single over-long word rather than overflowing', () => {
    const [line] = wrapLabel('Uebergabezaehlerbezeichnungxyz');
    expect(line.length).toBeLessThanOrEqual(21);
    expect(line.endsWith('…')).toBe(true);
  });

  it('returns nothing for an empty name', () => {
    expect(wrapLabel('   ')).toEqual([]);
  });
});
