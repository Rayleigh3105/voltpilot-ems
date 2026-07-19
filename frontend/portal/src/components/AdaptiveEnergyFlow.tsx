import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteTopology } from '../api';
import { ROLE_META } from '../adaptive';
import { layoutFlow } from '../adaptiveFlow';

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
}: {
  topology: SiteTopology;
  stale?: boolean;
}) {
  const L = layoutFlow(topology.topology, topology.entities);

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
        style={{ display: 'block', width: '100%', maxWidth: `${L.W}px`, height: 'auto', margin: '0 auto' }}
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
                size={15}
                x={v.x - 7.5}
                y={v.y - L.nodeR * 0.7}
                style={{ color: meta.color }}
              />
              <text
                x={v.x}
                y={v.y + L.nodeR * 0.06}
                textAnchor="middle"
                fontWeight={700}
                fontSize={L.lblF}
                fill="var(--vp-flow-ink)"
                fontFamily="Inter, sans-serif"
              >
                {v.label}
              </text>
              <text
                x={v.x}
                y={v.y + L.nodeR * 0.56}
                textAnchor="middle"
                fontWeight={600}
                fontSize={L.valF}
                fill={meta.color}
                fontFamily="Inter, sans-serif"
              >
                {v.value}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
