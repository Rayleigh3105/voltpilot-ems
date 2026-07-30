import { useEffect, useRef, useState } from 'react';
import { fmtNum } from '../format';
import { flowState, type LiveSnapshot, type Spoke } from '../live';

/**
 * Energy-flow diagram: four spokes (PV top, Batterie left, Haus right, Netz
 * bottom) around a central hub, with animated dashed flows whose DIRECTION
 * encodes charge/discharge and import/export. A dependency-free React port of
 * the edge device's hand-rolled SVG (`dashboard.js` renderFlow / buildFlow), so
 * the customer sees the same picture at home and in the portal. The 4-hue
 * palette comes from the `--vp-flow-*` tokens (index.css), lifted from the edge
 * dashboard. Read-only; no new dependencies.
 */

type NodeKey = 'pv' | 'load' | 'grid' | 'batt';

interface Layout {
  W: number;
  H: number;
  hubR: number;
  nodeR: number;
  lblF: number;
  valF: number;
  hub: { x: number; y: number };
  pos: Record<NodeKey, { x: number; y: number }>;
}

// Two layouts sharing the same node->hub topology (identical animation logic,
// only coordinates differ). WIDE is the landscape diamond (tablet/desktop);
// NARROW is a taller portrait cross that fills a phone's width so the labels
// stay full-size instead of shrinking into an unreadable diamond.
const WIDE: Layout = {
  W: 400,
  H: 250,
  hubR: 22,
  nodeR: 26,
  lblF: 10.5,
  valF: 10,
  hub: { x: 200, y: 128 },
  pos: {
    pv: { x: 200, y: 40 },
    load: { x: 336, y: 128 },
    grid: { x: 200, y: 216 },
    batt: { x: 64, y: 128 },
  },
};
const NARROW: Layout = {
  W: 280,
  H: 344,
  hubR: 26,
  nodeR: 32,
  lblF: 13,
  valF: 12,
  hub: { x: 140, y: 172 },
  pos: {
    pv: { x: 140, y: 52 },
    load: { x: 214, y: 172 },
    grid: { x: 140, y: 292 },
    batt: { x: 66, y: 172 },
  },
};

const META: Record<NodeKey, { label: string; color: string; soft: string }> = {
  pv: { label: 'PV', color: 'var(--vp-flow-pv)', soft: 'var(--vp-flow-pv-soft)' },
  load: { label: 'Haus', color: 'var(--vp-flow-load)', soft: 'var(--vp-flow-load-soft)' },
  grid: { label: 'Netz', color: 'var(--vp-flow-grid)', soft: 'var(--vp-flow-grid-soft)' },
  batt: { label: 'Batterie', color: 'var(--vp-flow-batt)', soft: 'var(--vp-flow-batt-soft)' },
};
const KEYS: NodeKey[] = ['pv', 'load', 'grid', 'batt'];

function strokeWidth(magnitude: number): number {
  return Math.max(2.5, Math.min(7, 2.5 + Math.abs(magnitude) * 0.7));
}

function nodeValue(key: NodeKey, snap: LiveSnapshot): string {
  if (key === 'batt') return snap.socPct == null ? '–' : `${fmtNum(snap.socPct, '', 0)}%`;
  const v = key === 'pv' ? snap.pvKw : key === 'load' ? snap.loadKw : snap.gridKw;
  if (v == null) return '–';
  return `${fmtNum(Math.abs(v), '', 1)} kW`;
}

/**
 * Portal v3 · M2: the ONLY change to this component is an optional SIZE.
 * `'compact'` (the default) is byte-for-byte today's behaviour — the fleet card
 * and the Live view stay identical. `'hero'` merely raises the WIDE layout's
 * height cap so the cockpit hero can host the very same diagram larger; no
 * geometry, no animation, no "—" behaviour changes.
 */
export type EnergyFlowSize = 'compact' | 'hero';

/**
 * The WIDE layout's height cap per size (the NARROW phone cross always fills).
 *
 * `hero` = die Bühne: der Deckel wurde von 420 auf 520 px angehoben (Konzept
 * `vp-cockpit-konzept-f4`, Richtung A — der Fluss soll GRÖSSER werden, nicht
 * kleiner; die Bühnenspalte begrenzt ihn ohnehin). `compact` ist unverändert.
 */
const WIDE_HEIGHT_CAP: Record<EnergyFlowSize, number> = { compact: 264, hero: 520 };

export function EnergyFlow({
  snapshot,
  stale = false,
  size = 'compact',
}: {
  snapshot: LiveSnapshot;
  stale?: boolean;
  size?: EnergyFlowSize;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 400);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = width < 380 ? NARROW : WIDE;
  // Fill the width exactly (no letterbox) for the phone cross; cap the landscape
  // diamond's height so a wide card doesn't blow it up.
  const rawHeight = width * (L.H / L.W);
  const height = Math.round(
    L === NARROW ? rawHeight : Math.min(rawHeight, WIDE_HEIGHT_CAP[size]),
  );

  const flow = flowState(snapshot);
  const spokeClass = (s: Spoke): string =>
    !s.active ? '' : s.reverse ? 'vp-flow-line vp-flow-rev' : 'vp-flow-line vp-flow-on';

  return (
    <div
      className="vp-flow-wrap"
      ref={wrapRef}
      style={{ height, opacity: stale ? 0.55 : 1, filter: stale ? 'grayscale(0.35)' : undefined }}
      role="img"
      aria-label="Energiefluss: Solar, Batterie, Haus und Netz"
    >
      <svg viewBox={`0 0 ${L.W} ${L.H}`} preserveAspectRatio="xMidYMid meet">
        {/* Base spokes (grey) + animated flow overlays (coloured, node<->hub). */}
        {KEYS.map((k) => {
          const p = L.pos[k];
          const s = flow[k];
          return (
            <g key={`spoke-${k}`}>
              <line
                x1={p.x}
                y1={p.y}
                x2={L.hub.x}
                y2={L.hub.y}
                stroke="var(--vp-flow-base)"
                strokeWidth={6}
                strokeLinecap="round"
              />
              {s.active && (
                <line
                  className={spokeClass(s)}
                  x1={p.x}
                  y1={p.y}
                  x2={L.hub.x}
                  y2={L.hub.y}
                  stroke={META[k].color}
                  strokeWidth={strokeWidth(s.magnitude).toFixed(1)}
                />
              )}
            </g>
          );
        })}

        {/* Hub (lightning). */}
        <circle
          cx={L.hub.x}
          cy={L.hub.y}
          r={L.hubR}
          fill="#fff"
          stroke="var(--vp-flow-base)"
          strokeWidth={2}
        />
        <path
          d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"
          fill="none"
          stroke="var(--vp-navy-2)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          transform={`translate(${L.hub.x - 12},${L.hub.y - 12})`}
        />

        {/* Nodes (circle + label + value). */}
        {KEYS.map((k) => {
          const p = L.pos[k];
          return (
            <g key={`node-${k}`}>
              <circle
                cx={p.x}
                cy={p.y}
                r={L.nodeR}
                fill={META[k].soft}
                stroke={META[k].color}
                strokeWidth={2}
              />
              <text
                x={p.x}
                y={p.y - L.nodeR * 0.16}
                textAnchor="middle"
                fontWeight={700}
                fontSize={L.lblF}
                fill="var(--vp-flow-ink)"
                fontFamily="Inter, sans-serif"
              >
                {META[k].label}
              </text>
              <text
                x={p.x}
                y={p.y + L.nodeR * 0.44}
                textAnchor="middle"
                fontWeight={600}
                fontSize={L.valF}
                fill={META[k].color}
                fontFamily="Inter, sans-serif"
              >
                {nodeValue(k, snapshot)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
