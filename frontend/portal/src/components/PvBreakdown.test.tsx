import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteSource } from '../api';
import type { PvComposition } from '../pvComposition';
import { PvBreakdownLine, PvCompositionDetails } from './PvBreakdown';

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

const COMPOSITION: PvComposition = {
  totalKw: 69.8,
  parts: [
    { key: 'deye:0', label: 'Deye SUN-30K', kw: 23, health: 'ok', note: null, title: 'Deye' },
    { key: 'f1:1', label: 'Fronius Anlage', kw: 21.3, health: 'ok', note: null, title: 'Fronius' },
    {
      key: 'f2:2',
      label: 'Fronius Anlage WR 2',
      kw: 25.5,
      health: 'stale',
      note: null,
      title: 'Fronius 2',
    },
  ],
  unmeasured: [],
  deviceCount: 3,
  origin: 'sources',
};

describe('PvCompositionDetails (the panel behind the click on „PV-Erzeugung")', () => {
  it('names every inverter with its share, and the shares add up to the total', () => {
    const { container } = render(<PvCompositionDetails composition={COMPOSITION} />);
    expect(screen.getByText('Deye SUN-30K')).toBeInTheDocument();
    expect(screen.getByText('Fronius Anlage')).toBeInTheDocument();
    expect(screen.getByText('Fronius Anlage WR 2')).toBeInTheDocument();
    expect(container.querySelectorAll('.vp-pvcomp-row')).toHaveLength(3);
    expect(container.querySelectorAll('.vp-pvcomp-seg')).toHaveLength(3);
    expect(screen.getByText('3 Geräte')).toBeInTheDocument();
    // the rendered values are the composition's parts, which sum to its total
    const sum = COMPOSITION.parts.reduce((s, p) => s + (p.kw as number), 0);
    expect(sum).toBeCloseTo(COMPOSITION.totalKw as number, 9);
  });

  it('flags a stale device instead of quietly showing it as live', () => {
    const { container } = render(<PvCompositionDetails composition={COMPOSITION} />);
    expect(container.querySelectorAll('.vp-pvsplit-dot.stale')).toHaveLength(1);
  });

  it('names a device without an own value with its reason - never a bare "–"', () => {
    const { container } = render(
      <PvCompositionDetails
        composition={{
          ...COMPOSITION,
          parts: COMPOSITION.parts.slice(0, 2),
          totalKw: 44.3,
          unmeasured: [
            {
              key: 'f2:2',
              label: 'Fronius Anlage WR 2',
              kw: null,
              health: 'never',
              note: 'über den Wechselrichter mitgemessen',
              title: 'Fronius 2',
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('Fronius Anlage WR 2')).toBeInTheDocument();
    expect(screen.getByText('über den Wechselrichter mitgemessen')).toBeInTheDocument();
    expect(container.textContent).not.toContain('–');
    expect(container.querySelectorAll('.vp-pvcomp-row.quiet')).toHaveLength(1);
  });
});

describe('PvCompositionDetails · Serien trennt die FUGE, nicht die Deckkraft', () => {
  /** Eine Zusammensetzung aus n gleich grossen Geraeten. */
  function mitGeraeten(n: number, kws?: number[]): PvComposition {
    const parts = Array.from({ length: n }, (_, i) => ({
      key: `wr${i}`,
      label: `WR ${i + 1}`,
      kw: kws?.[i] ?? 5,
      health: 'ok' as const,
      note: null,
      title: `WR ${i + 1}`,
    }));
    return {
      totalKw: parts.reduce((sum, p) => sum + p.kw, 0),
      parts,
      unmeasured: [],
      deviceCount: n,
      origin: 'sources',
    };
  }

  it('bleibt auch bei sechs Geraeten sichtbar (die alte Rampe war ab dem 5. bei 0,04)', () => {
    const { container } = render(<PvCompositionDetails composition={mitGeraeten(6)} />);
    const segs = [...container.querySelectorAll<HTMLElement>('.vp-pvcomp-seg')];
    expect(segs).toHaveLength(6);
    // KEIN Segment traegt noch eine eigene Deckkraft - sie war der Defekt.
    for (const seg of segs) expect(seg.style.opacity).toBe('');
  });

  it('behaelt die EINE PV-Farbe (F10) statt erfundener Serientoene', () => {
    const { container } = render(<PvCompositionDetails composition={mitGeraeten(3)} />);
    // Keine Inline-Farbe: alle tragen dieselbe Token-Farbe aus dem CSS.
    for (const seg of container.querySelectorAll<HTMLElement>('.vp-pvcomp-seg')) {
      expect(seg.style.background).toBe('');
    }
  });

  it('gewichtet die Segmente weiterhin nach ihrem Anteil', () => {
    const { container } = render(<PvCompositionDetails composition={mitGeraeten(2, [3, 9])} />);
    const grows = [...container.querySelectorAll<HTMLElement>('.vp-pvcomp-seg')].map((s) =>
      Number(s.style.flexGrow),
    );
    expect(grows[1] / grows[0]).toBeCloseTo(3, 3);
  });
});
