import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteTopology } from '../api';
import { ROLE_META } from '../adaptive';
import { layoutFlow } from '../adaptiveFlow';
import type { EnergyFlowSize } from './EnergyFlow';

/**
 * AE2 adaptive energy-flow diagram: the real VoltPilot EnergyFlow (lightning
 * hub + soft-filled circle nodes + grey base spoke + animated coloured dashed
 * flow spoke) generalised from the fixed 4 nodes to the N role-grouped nodes of
 * the AE1 topology read-model. Producers sit top, storage left, consumers
 * right, grid bottom; each entity contributing to a role is its own circle, and
 * the animated spoke direction encodes the topology flow sign. A dependency-free
 * SVG that scales to its container (zero horizontal overflow). All geometry is
 * the pure `layoutFlow`; this only renders it.
 */
export function AdaptiveEnergyFlow({
  topology,
  stale = false,
  size = 'compact',
}: {
  topology: SiteTopology;
  stale?: boolean;
  /**
   * Portal v3 · M2: the ONLY addition. `'compact'` (default) keeps today's
   * `maxWidth: L.W` cap byte-for-byte; `'hero'` lifts it so the cockpit hero
   * can host the SAME diagram larger. No geometry / `adaptiveFlow.ts` change.
   */
  size?: EnergyFlowSize;
}) {
  const L = layoutFlow(topology.topology, topology.entities);
  const maxWidth = size === 'hero' ? `${Math.round(L.W * 1.6)}px` : `${L.W}px`;

  return (
    <div
      className="vp-flow-wrap vp-flow-adaptive"
      style={{ opacity: stale ? 0.55 : 1, filter: stale ? 'grayscale(0.35)' : undefined }}
      role="img"
      aria-label="Energiefluss der Anlage, nach Rollen gruppiert"
    >
      <svg
        viewBox={`0 0 ${L.W} ${L.H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', width: '100%', maxWidth, height: 'auto', margin: '0 auto' }}
      >
        {/* Base spokes (grey) + animated coloured overlay per active vertex. */}
        {L.vertices.map((v) => (
          <g key={`spoke-${v.key}`}>
            <line
              x1={v.x}
              y1={v.y}
              x2={L.hubX}
              y2={L.hubY}
              stroke="var(--vp-flow-base)"
              strokeWidth={6}
              strokeLinecap="round"
            />
            {v.spokeActive && (
              <line
                className={`vp-flow-line ${v.reverse ? 'vp-flow-rev' : 'vp-flow-on'}`}
                x1={v.x}
                y1={v.y}
                x2={L.hubX}
                y2={L.hubY}
                stroke={ROLE_META[v.role].color}
                strokeWidth={v.strokeWidth.toFixed(1)}
              />
            )}
          </g>
        ))}

        {/* Hub (lightning). */}
        <circle
          cx={L.hubX}
          cy={L.hubY}
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
          transform={`translate(${L.hubX - 12},${L.hubY - 12})`}
        />

        {/* Nodes (circle + icon + label + value). */}
        {L.vertices.map((v) => {
          const meta = ROLE_META[v.role];
          return (
            <g key={`node-${v.key}`}>
              {/* The full name always stays reachable, whatever the wrap did. */}
              <title>{v.title}</title>
              <circle
                cx={v.x}
                cy={v.y}
                r={L.nodeR}
                fill={meta.soft}
                stroke={meta.color}
                strokeWidth={2}
              />
              <Icon
                name={v.icon}
                size={16}
                x={v.x - 8}
                y={v.y - L.nodeR * 0.62}
                style={{ color: meta.color }}
              />
              {/* Only the VALUE stays inside the circle - it always fits. The
                  name sits below, wrapped, so it is never clipped (G2). */}
              <text
                x={v.x}
                y={v.y + L.nodeR * 0.4}
                textAnchor="middle"
                fontWeight={700}
                fontSize={L.valF}
                fill={meta.color}
                fontFamily="Inter, sans-serif"
              >
                {v.value}
              </text>
              {v.labelLines.map((line, li) => (
                <text
                  key={li}
                  x={v.x}
                  y={v.y + L.nodeR + L.lblDy + li * L.lblLh}
                  textAnchor="middle"
                  fontWeight={li === 0 ? 700 : 600}
                  fontSize={L.lblF}
                  fill="var(--vp-flow-ink)"
                  fontFamily="Inter, sans-serif"
                >
                  {line}
                </text>
              ))}
              {/* The role word gets its OWN line in the role colour - appended
                  to the name it would be eaten by the wrap, and two circles of
                  the same device would read alike again (G2). */}
              {v.roleTag && (
                <text
                  x={v.x}
                  y={v.y + L.nodeR + L.lblDy + v.labelLines.length * L.lblLh}
                  textAnchor="middle"
                  fontWeight={700}
                  fontSize={L.lblF - 1}
                  fill={meta.color}
                  fontFamily="Inter, sans-serif"
                >
                  {v.roleTag}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
