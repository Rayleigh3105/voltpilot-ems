import { describe, expect, it } from 'vitest';
import type { TopologyEntity } from './api';
import { layoutFlow, wrapLabel } from './adaptiveFlow';
import type { FlowNode, Topology } from './topology';

const NBSP = '\u00A0';

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

describe('layoutFlow', () => {
  it('places a circle per member grouped by role side', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    // 2 PV + 1 storage + 1 consumer + 1 grid = 5 vertices.
    expect(l.vertices).toHaveLength(5);
    const pv = l.vertices.filter((v) => v.role === 'pv');
    expect(pv).toHaveLength(2);
    // producers sit on the top row, symmetric around the hub x.
    expect(pv.every((v) => v.y === 48)).toBe(true);
    expect(pv[0].x + pv[1].x).toBeCloseTo(2 * l.hubX);
    // storage left column, consumer right column, grid bottom row.
    const storage = l.vertices.find((v) => v.role === 'storage')!;
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    const grid = l.vertices.find((v) => v.role === 'grid')!;
    expect(storage.x).toBeLessThan(l.hubX);
    expect(consumer.x).toBeGreaterThan(l.hubX);
    expect(grid.y).toBeGreaterThan(l.hubY);
  });

  it('encodes the topology flow direction (in = node->hub, out = hub->node)', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    const pv = l.vertices.find((v) => v.role === 'pv')!;
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    expect(pv.reverse).toBe(false); // 'in'
    expect(consumer.reverse).toBe(true); // 'out'
    expect(pv.spokeActive).toBe(true);
  });

  it('shows SoC in the storage circle and |kW| elsewhere', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices.find((v) => v.role === 'storage')!.value).toBe(`45${NBSP}%`);
    expect(l.vertices.find((v) => v.role === 'grid')!.value).toBe(`54,2${NBSP}kW`); // abs of -54.2
  });

  it('grows the viewBox as a role gains members but stays >= the base', () => {
    const wide: Topology = {
      schema_version: '1.0',
      nodes: [
        {
          role: 'pv',
          value_kw: 1,
          flow_active: true,
          direction: 'in',
          members: [
            { entity_id: 'a', label: 'A', primary: true, value_kw: 1 },
            { entity_id: 'b', label: 'B', primary: false, value_kw: 1 },
            { entity_id: 'c', label: 'C', primary: false, value_kw: 1 },
          ],
        },
      ],
    };
    const base = layoutFlow(TOPO, ENTITIES);
    const grown = layoutFlow(wide, ENTITIES);
    expect(base.W).toBe(560);
    expect(grown.W).toBeGreaterThan(base.W);
  });

  it('returns no vertices for an empty topology', () => {
    expect(layoutFlow({ schema_version: '1.0', nodes: [] }, []).vertices).toHaveLength(0);
  });
});


// G2: the names were rendered INSIDE the 60px circles and clipped to
// "Freifläche…", "Übergabezä…" - and a hybrid inverter produced TWO circles
// reading "Batteriesp…", which the customer could not tell apart.
describe('node labels are legible and distinguishable (G2)', () => {
  it('renders the name below the circle, wrapped instead of clipped', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    const fronius = l.vertices.find((v) => v.label.startsWith('Fronius'))!;
    expect(fronius.labelLines.length).toBeGreaterThan(0);
    expect(fronius.labelLines.join(' ')).toContain('Fronius');
    // the untruncated name is always reachable
    expect(fronius.title).toContain('Fronius Symo');
    expect(l.lblDy).toBeGreaterThan(0);
  });

  it('appends the role when the SAME device appears on two circles', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    // "Deye 65 kWh" is the storage member label; the pv member is "Deye" and
    // the grid member "Netz" - so only genuinely repeated names get a suffix.
    const repeated = layoutFlow(
      {
        schema_version: '1.0',
        nodes: [
          {
            role: 'pv',
            value_kw: 1,
            flow_active: true,
            direction: 'in',
            members: [{ entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 1 }],
          },
          {
            role: 'storage',
            value_kw: 1,
            soc_pct: 50,
            flow_active: true,
            direction: 'out',
            members: [{ entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 1 }],
          },
        ],
      },
      ENTITIES,
    );
    const labels = repeated.vertices.map((v) => v.label);
    expect(new Set(labels).size).toBe(2); // no two circles read the same
    // The rendered name is the SHORT one, per ASPECT: the hybrid's pv side is
    // an "Erzeuger", its storage side a "Batteriespeicher" - and the role word
    // still gets its own sub-caption line.
    expect(labels).toContain('Erzeuger · PV');
    expect(labels).toContain('Batteriespeicher · Speicher');
    // the role word is its OWN line, so the wrap can never eat it
    expect(repeated.vertices.map((v) => v.roleTag).sort()).toEqual(['PV', 'Speicher']);
    expect(repeated.vertices.map((v) => v.labelLines.join(' ')).sort()).toEqual([
      'Batteriespeicher',
      'Erzeuger',
    ]);
    // the untruncated stored name stays on the tooltip
    expect(repeated.vertices.every((v) => v.title.startsWith('Batteriespeicher'))).toBe(true);
    // a name that occurs once is left alone (short word, no role suffix)
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    expect(consumer.label).toBe('Wallbox');
    expect(consumer.title).toBe('go-e · Verbraucher');
    expect(consumer.roleTag).toBeNull();
  });

  it('every circle stays inside the viewBox, labels included', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    const labelBlock = l.lblDy + 3 * l.lblLh; // 2 name lines + the role line
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
