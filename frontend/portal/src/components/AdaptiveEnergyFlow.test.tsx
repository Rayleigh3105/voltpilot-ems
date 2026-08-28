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
      // Post-Label-Hygiene a composed row carries no label of its own.
      label: null,
      primary: true,
      value_kw: 69.8,
    },
    { entity_id: 'f1', label: null, primary: false },
    { entity_id: 'f2', label: null, primary: false },
  ],
  [
    entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: null }),
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

  // Alias concept §5: the pencil belongs HERE too - this is the list the wish
  // was born looking at - but only where a component exists to name.
  it('offers a rename pencil per component row only when the host allows it', () => {
    const { container, rerender } = render(
      <AdaptiveEnergyFlow topology={MULTI} sources={MULTI_SOURCES} pins={MULTI_PINS} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /PV-Erzeugung/ }));
    expect(container.querySelectorAll('.vp-pvcomp-pencil')).toHaveLength(0);

    rerender(
      <AdaptiveEnergyFlow
        topology={MULTI}
        sources={MULTI_SOURCES}
        pins={MULTI_PINS}
        rename={{ siteId: 's1', boxRef: 'VP-BOX-1', onRenamed: () => {} }}
      />,
    );
    expect(container.querySelectorAll('.vp-pvcomp-pencil')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /„Deye SUN-30K“ umbenennen/ })).toHaveAttribute(
      'href',
      '#/anlage/s1/geraet/VP-BOX-1/inv?bearbeiten=1&komponente=deye',
    );
    expect(screen.getByRole('link', { name: /„Fronius Anlage“ umbenennen/ })).toHaveAttribute(
      'href',
      '#/anlage/s1/geraet/VP-BOX-1/a?bearbeiten=1&komponente=f1',
    );
    expect(screen.queryByRole('dialog', { name: 'Komponente umbenennen' })).toBeNull();
  });

  it('keeps pinned component pencils on the device page without live source readings', () => {
    render(
      <AdaptiveEnergyFlow
        topology={MULTI}
        sources={null}
        pins={MULTI_PINS}
        rename={{ siteId: 's1', boxRef: 'VP-BOX-1', onRenamed: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /PV-Erzeugung/ }));

    expect(screen.getAllByRole('link', { name: /umbenennen/ }).map((link) =>
      link.getAttribute('href'))).toEqual([
      '#/anlage/s1/modell?bearbeiten=1&komponente=deye',
      '#/anlage/s1/geraet/VP-BOX-1/a?bearbeiten=1&komponente=f1',
      '#/anlage/s1/geraet/VP-BOX-1/b?bearbeiten=1&komponente=f2',
    ]);
    expect(screen.queryByRole('button', { name: /umbenennen/ })).toBeNull();
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

describe('AdaptiveEnergyFlow · der Knoten „Laden" (Konzept vp-verbraucher-cockpit-k1 §6, E3)', () => {
  const LADEND = { kw: 11, wort: 'lädt', aktiv: true, count: 1 };
  /** ⚠ MIT Haus-Knoten - ohne ihn gäbe es gar keinen Abzweig, und die Tests
      darunter wären allesamt vakuum. */
  const MIT_HAUS: SiteTopology = {
    ...MULTI,
    entities: [...MULTI.entities, entity({ id: 'haus' })],
    topology: {
      ...MULTI.topology,
      nodes: [
        ...MULTI.topology.nodes,
        {
          role: 'consumer',
          value_kw: 14.1,
          flow_active: true,
          direction: 'out',
          members: [{ entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 14.1 }],
        },
      ],
    },
  };

  it('⚠ ohne Ladepunkt rendert das Diagramm ZEICHENGLEICH zu vorher', () => {
    const ohne = render(<AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    const vorher = ohne.container.querySelector('svg')!.outerHTML;
    ohne.unmount();
    // Der Wächter beweist sich selbst: MIT Knoten ist es NICHT zeichengleich.
    const mitKnoten = render(
      <AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} charging={LADEND} />,
    );
    expect(mitKnoten.container.querySelector('svg')!.outerHTML).not.toBe(vorher);
    mitKnoten.unmount();
    for (const charging of [undefined, null]) {
      const mit = render(
        <AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} charging={charging} />,
      );
      expect(mit.container.querySelector('svg')!.outerHTML).toBe(vorher);
      mit.unmount();
    }
  });

  it('zeichnet den fünften Kreis samt Wort und Leistung', () => {
    const { container } = render(
      <AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} charging={LADEND} />,
    );
    const texte = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    expect(texte).toContain('Laden');
    expect(texte).toContain('lädt');
    expect(texte.join(' ')).toContain('11,0');
    // Ein Kreis mehr als ohne den Knoten - die vier Rollen bleiben.
    const ohne = render(<AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    expect(container.querySelectorAll('svg circle').length).toBe(
      ohne.container.querySelectorAll('svg circle').length + 1,
    );
  });

  it('⚠ seine Speiche endet am HAUS, nicht im Hub - ein Abzweig (E3)', () => {
    // ⚠ Nur die GRUNDspeichen zählen: die Icons zeichnen ihrerseits `<line>`.
    const speichen = (el: Element) =>
      Array.from(el.querySelectorAll('line')).filter(
        (l) => l.getAttribute('stroke') === 'var(--vp-flow-base)',
      );
    const { container } = render(
      <AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} charging={LADEND} />,
    );
    const svg = container.querySelector('svg')!;
    const hub = svg.querySelector('circle')!; // der Hub ist der erste Kreis
    const hubY = hub.getAttribute('cy');
    const abseits = speichen(svg).filter((l) => l.getAttribute('y2') !== hubY);
    expect(abseits).toHaveLength(1);
    // Sie läuft vom Laden-Kreis NACH OBEN und endet UNTERHALB des Hubs -
    // also am Haus, nicht in der Mitte.
    const y1 = Number(abseits[0].getAttribute('y1'));
    const y2 = Number(abseits[0].getAttribute('y2'));
    expect(y2).toBeLessThan(y1);
    expect(y2).toBeGreaterThan(Number(hubY));
    // und senkrecht: sie bleibt auf der Spalte des Hauses.
    expect(abseits[0].getAttribute('x1')).toBe(abseits[0].getAttribute('x2'));

    // Ohne den Knoten zielt JEDE Speiche auf den Hub - der Wächter ist nicht vakuum.
    const ohneR = render(<AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} />);
    const ohneSvg = ohneR.container.querySelector('svg')!;
    const ohneHubY = ohneSvg.querySelector('circle')!.getAttribute('cy');
    expect(speichen(ohneSvg).filter((l) => l.getAttribute('y2') !== ohneHubY)).toHaveLength(0);
  });

  it('bietet KEINEN Klick am Laden-Knoten an', () => {
    render(
      <AdaptiveEnergyFlow topology={MIT_HAUS} sources={MULTI_SOURCES} pins={MULTI_PINS} charging={LADEND} />,
    );
    expect(screen.queryByRole('button', { name: /Laden/ })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cockpit Phase 1 / C2 · der Kreis „Laden (eigener Anschluss)"
  // -------------------------------------------------------------------------

  const EIGEN = { kw: 4, wort: 'lädt', aktiv: true, count: 1 };
  const flow = (extra: Record<string, unknown>) =>
    render(
      <AdaptiveEnergyFlow
        topology={MIT_HAUS}
        sources={MULTI_SOURCES}
        pins={MULTI_PINS}
        {...extra}
      />,
    ).container.querySelector('svg')!.outerHTML;

  // ⚠ Der Wächter über den Bestand: das GANZE svg, Zeichen für Zeichen.
  it('⚠ ohne eigenen Anschluss ist das svg ZEICHENGLEICH zu vorher', () => {
    const ohne = flow({ charging: LADEND });
    expect(flow({ charging: LADEND, chargingOwn: null })).toBe(ohne);
    expect(flow({ charging: LADEND, chargingOwn: undefined })).toBe(ohne);
    // ... und der Vergleich ist nicht vakuum: MIT Knoten schlägt er an.
    expect(flow({ charging: LADEND, chargingOwn: EIGEN })).not.toBe(ohne);
  });

  it('zeichnet ihn als eigenen Kreis mit seinem Namen', () => {
    render(
      <AdaptiveEnergyFlow
        topology={MIT_HAUS}
        sources={MULTI_SOURCES}
        pins={MULTI_PINS}
        charging={LADEND}
        chargingOwn={EIGEN}
      />,
    );
    expect(screen.getByText('Laden (eigener')).toBeInTheDocument();
    expect(screen.getByText(/4,0/)).toBeInTheDocument();
  });

  // ⚠ Der Abzweig endet am HAUS, der eigene Anschluss am HUB - genau daran
  // hängt die Aussage „die Haus-Summe enthält ihn nicht".
  it('hängt am Hub, während der Abzweig am Haus endet', () => {
    const { container } = render(
      <AdaptiveEnergyFlow
        topology={MIT_HAUS}
        sources={MULTI_SOURCES}
        pins={MULTI_PINS}
        charging={LADEND}
        chargingOwn={EIGEN}
      />,
    );
    const svg = container.querySelector('svg')!;
    const hubY = svg.querySelector('circle')!.getAttribute('cy');
    // ⚠ Nur die GRUNDspeichen zählen: die Icons zeichnen ihrerseits `<line>`.
    const grund = Array.from(svg.querySelectorAll('line')).filter(
      (l) => l.getAttribute('stroke') === 'var(--vp-flow-base)',
    );
    // Genau EINE Speiche endet abseits des Hubs: die des Abzweigs.
    expect(grund.filter((l) => l.getAttribute('y2') !== hubY)).toHaveLength(1);
  });
});
