import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteSource, SiteTopology } from '../api';
import {
  layoutFlow,
  NARROW_MAX_PX,
  type ChargingNodeOpts,
  type FlowVertex,
} from '../adaptiveFlow';
import { pvComposition } from '../pvComposition';
import type { EntityPin } from '../pvReconcile';
import { PvCompositionDetails } from './PvBreakdown';
import { DirectionArrow } from './FlowArrow';
import { SwapText } from './SwapNumber';
import { useFlowTempo } from './useFlowTempo';
import type { EnergyFlowSize } from './EnergyFlow';
import { geraetKomponenteBearbeitenHash, komponenteBearbeitenHash } from '../nav';

/**
 * AE2 adaptive energy-flow diagram: the real VoltPilot EnergyFlow (lightning
 * hub + soft-filled circle nodes + grey base spoke + animated coloured dashed
 * flow spoke), driven by the AE1 topology read-model. A dependency-free SVG that
 * scales to its container (zero horizontal overflow). All geometry is the pure
 * `layoutFlow`; this only renders it.
 *
 * **ONE circle per ROLE, composition on click (owner decision A1, concept
 * `vp-ui-pv-hist-d8`).** Four nodes - PV-Erzeugung, Batteriespeicher,
 * Hausverbrauch, Netz - so the hybrid inverter no longer appears twice and the
 * producers that have no series of their own no longer draw empty "–" circles.
 * A tap on „PV-Erzeugung" opens which inverter contributes what; the rows sum to
 * the number in the circle by construction (both come from `pvComposition`).
 * The diagram keeps its character exactly: same circles, same animated spokes,
 * same colour language.
 *
 * **V9 (Audit) — the phone fix, twofold.** The container width is measured
 * (ResizeObserver, the `EnergyFlow` precedent) and below `NARROW_MAX_PX` the
 * portrait geometry is used, so at 375 px the whole cross fits with readable
 * labels. And the `<svg>` carries `minWidth: 0`: as a flex item its automatic
 * minimum size otherwise pinned it at ~440 px inside a ~290 px card, pushing
 * the Hausverbrauch node entirely off-screen.
 */
export function AdaptiveEnergyFlow({
  topology,
  stale = false,
  size = 'compact',
  sources = null,
  pins = null,
  controlConfirmed = false,
  charging = null,
  chargingOwn = null,
  rename = null,
  kanonischePv = false,
}: {
  topology: SiteTopology;
  /** Cockpit: die Rollen-Aufschlüsselung erklärt bereits den kanonischen PV-Wert. */
  kanonischePv?: boolean;
  stale?: boolean;
  /**
   * Portal v3 · M2: `'compact'` (default) keeps today's `maxWidth: L.W` cap
   * byte-for-byte; `'hero'` lifts it so the cockpit hero can host the SAME
   * diagram larger. No geometry / `adaptiveFlow.ts` change.
   *
   * Seit der Bühne (Konzept `vp-cockpit-konzept-f4`) FÜLLT `'hero'` die
   * Bühnenspalte: der frühere Deckel `L.W * 1.6` war ein zweiter, unsichtbarer
   * Grenzwert neben der Spaltenbreite — das Diagramm soll groß sein, also
   * entscheidet die Spalte allein (bindende Captain-Vorgabe 30.07.).
   */
  size?: EnergyFlowSize;
  /**
   * The reported measurement points (`/sources`). Until the edge publishes PV
   * per entity they are what splits the composite PV back onto the separate
   * inverters in the composition panel. A no-op otherwise.
   */
  sources?: SiteSource[] | null;
  /**
   * The v2 entities' PIN facts (`edgeSourceId` / `orphanedPin`). They are the
   * ONLY link between a component and the device that measures it - without
   * them a source is never assigned to a circle (`vp-pin-werte-f8`: matching by
   * position put values on the wrong rows).
   */
  pins?: EntityPin[] | null;
  /**
   * Der Wechselrichter bestätigt gerade den Fahrplan-Sollwert
   * (`controlStrip().state === 'healthy'`) → der Speicher-Knoten trägt den
   * Bestätigungs-Haken (Konzept §6.3 „Verzahnung"). Additiv.
   */
  controlConfirmed?: boolean;
  /**
   * Der fünfte Kreis „Laden" (Konzept `vp-verbraucher-cockpit-k1` §6, E3) -
   * ein Abzweig VOM Haus, abgeleitet von `ladenKachel.ladeFlussKnoten`. Fehlt
   * er (keine Ladepunkte, älteres Backend), ist das Diagramm ZEICHENGLEICH zu
   * vorher: kein Knoten, keine grössere viewBox.
   */
  charging?: ChargingNodeOpts | null;
  /**
   * Der Kreis „Laden (eigener Anschluss)" (Phase 1 / C2) - Säulen an einem
   * EIGENEN Netzanschluss. Er hängt am HUB neben dem Haus, weil seine Kilowatt
   * nicht in der Hausmessung stecken, und braucht kein Haus, um zu erscheinen.
   */
  chargingOwn?: ChargingNodeOpts | null;
  /**
   * Enables the rename pencils on the PV-composition rows (concept
   * `vp-entity-alias-k1` §5, the „Abkürzung"): the wish is born looking at this
   * very list, so the pencil is here too. Absent = no pencils, byte-for-byte the
   * previous panel.
   */
  rename?: { siteId: string; boxRef: string | null; onRenamed: () => void } | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Bewegungs-Programm P3 (E4 a): das Punkt-Tempo kommt aus der Leistung
  // (`data-vp-kw` je Speiche). Siehe `useFlowTempo.ts`, warum eine Aenderung
  // von `animation-duration` die Punkte springen liesse.
  useFlowTempo(svgRef);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width > 0 && width < NARROW_MAX_PX;
  // The ONE derivation of what the PV role is made of - it feeds both the number
  // in the circle and the rows behind the click, so they cannot disagree.
  const composition = kanonischePv ? null : pvComposition(topology, sources, pins);
  const L = layoutFlow(topology.topology, topology.entities, {
    narrow,
    pvTotalKw: composition?.totalKw,
    pvDeviceCount: composition?.deviceCount,
    controlConfirmed,
    charging,
    chargingOwn,
  });
  const maxWidth = size === 'hero' ? '100%' : `${L.W}px`;
  const expandable = composition != null && L.vertices.some((v) => v.expandable);
  const showDetails = expandable && open;

  return (
    /* The composition panel is a SIBLING of `.vp-flow-wrap`, not a child: below
       620 px that wrap becomes a horizontally scrolling box with a 440 px min
       width for the diagram, and the panel must not be dragged into it. */
    <div
      className="vp-flow-composed"
      style={{
        opacity: stale ? 0.55 : 1,
        filter: stale ? 'grayscale(0.35)' : undefined,
      }}
    >
      <div ref={wrapRef} className="vp-flow-wrap vp-flow-adaptive">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${L.W} ${L.H}`}
          preserveAspectRatio="xMidYMid meet"
          // V12: „nach Rollen gruppiert" was internal v2 vocabulary (D3 says
          // Gerät / Komponente / Messwert) - the customer just has an Anlage.
          // `group` (not `img`) because a node may be an interactive control.
          role="group"
          aria-label="Energiefluss Ihrer Anlage"
          style={{
            display: 'block',
            width: '100%',
            maxWidth,
            minWidth: 0,
            height: 'auto',
            margin: '0 auto',
          }}
        >
          {/* Base spokes (grey) + animated coloured overlay per active vertex.
              Ziel ist normalerweise der Hub; der Laden-Knoten endet am HAUS
              (`toX`/`toY`) - ein ABZWEIG, kein zweiter Anschluss (E3). */}
          {L.vertices.map((v) => {
            const toX = v.toX ?? L.hubX;
            const toY = v.toY ?? L.hubY;
            return (
              <g key={`spoke-${v.key}`}>
                <line
                  x1={v.spokeX}
                  y1={v.spokeY}
                  x2={toX}
                  y2={toY}
                  stroke="var(--vp-flow-base)"
                  strokeWidth={v.baseWidth}
                  strokeLinecap="round"
                />
                {v.spokeActive && (
                  <>
                    <line
                      className={`vp-flow-line ${v.reverse ? 'vp-flow-rev' : 'vp-flow-on'}`}
                      data-vp-kw={v.flowKw.toFixed(3)}
                      x1={v.spokeX}
                      y1={v.spokeY}
                      x2={toX}
                      y2={toY}
                      stroke={v.color}
                      strokeWidth={v.strokeWidth.toFixed(1)}
                    />
                    <DirectionArrow
                      from={
                        v.reverse
                          ? { x: toX, y: toY }
                          : { x: v.spokeX, y: v.spokeY }
                      }
                      to={
                        v.reverse
                          ? { x: v.spokeX, y: v.spokeY }
                          : { x: toX, y: toY }
                      }
                      color={v.color}
                    />
                  </>
                )}
              </g>
            );
          })}

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

          {/* Nodes (circle + icon + value + name + caption). */}
          {L.vertices.map((v) => (
            <Node
              key={`node-${v.key}`}
              v={v}
              L={L}
              open={showDetails}
              onToggle={v.expandable && composition ? () => setOpen((o) => !o) : null}
            />
          ))}
        </svg>
      </div>

      {showDetails && composition && (
        <PvCompositionDetails
          composition={composition}
          renameHref={rename ? (row) => row.entityId
            ? row.deviceId && rename.boxRef
              ? geraetKomponenteBearbeitenHash(
                  rename.siteId, rename.boxRef, row.deviceId, row.entityId,
                )
              : komponenteBearbeitenHash(rename.siteId, row.entityId)
            : null : undefined}
        />
      )}
    </div>
  );
}

function Node({
  v,
  L,
  open,
  onToggle,
}: {
  v: FlowVertex;
  L: ReturnType<typeof layoutFlow>;
  open: boolean;
  /** non-null = this node opens the composition details. */
  onToggle: (() => void) | null;
}) {
  const subY = v.y + L.nodeR + L.lblDy + v.labelLines.length * L.lblLh;
  const interactive = onToggle != null;
  return (
    <g
      className={interactive ? 'vp-flow-node-btn' : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? open : undefined}
      aria-label={
        interactive
          ? `${v.label}: ${v.value}. ${v.memberCount} Geräte — Zusammensetzung anzeigen`
          : undefined
      }
      onClick={onToggle ?? undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      {/* The full name always stays reachable, whatever the wrap did. */}
      <title>{v.title}</title>
      {/* An invisible hit area so the whole node (circle + caption) is tappable
          at the 44px touch-target size, not just the glyph. */}
      {interactive && (
        <rect
          x={v.x - L.nodeR - 8}
          y={v.y - L.nodeR - 8}
          width={2 * (L.nodeR + 8)}
          height={2 * L.nodeR + 16 + L.lblDy + (v.labelLines.length + 1) * L.lblLh}
          fill="transparent"
        />
      )}
      <circle cx={v.x} cy={v.y} r={L.nodeR} fill={v.soft} stroke={v.color} strokeWidth={2} />
      <Icon
        name={v.icon}
        size={16}
        x={v.x - 8}
        y={v.y - L.nodeR * 0.62}
        style={{ color: v.color }}
      />
      {/* Only the VALUE stays inside the circle - it always fits. The name sits
          below, wrapped, so it is never clipped (G2). */}
      <SwapText
        value={v.value}
        x={v.x}
        y={v.y + L.nodeR * 0.4}
        textAnchor="middle"
        fontWeight={700}
        fontSize={L.valF}
        fill={v.color}
        fontFamily="Inter, sans-serif"
      />
      {v.labelLines.map((line, li) => (
        <text
          key={li}
          x={v.labelX}
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
      {/* The caption gets its OWN line in the role colour - appended to the name
          it would be eaten by the wrap. */}
      {v.subLabel && (
        <text
          x={v.labelX}
          y={subY}
          textAnchor="middle"
          fontWeight={700}
          fontSize={L.lblF - 1}
          fill={v.color}
          fontFamily="Inter, sans-serif"
        >
          {v.subLabel}
        </text>
      )}
      {/* Die Verzahnung (Konzept §6.3): der Haken am Speicher-Knoten sagt „der
          Wechselrichter hat den Fahrplan-Sollwert bestätigt". Als SVG-Pfad wie
          der Chevron nebenan — nie ein Unicode-Häkchen (die Icon-Konvention).
          Der volle Wortlaut steht im `<title>` des Knotens. */}
      {v.confirmed && v.subLabel && (
        <path
          className="vp-flow-confirm"
          d={`M${v.labelX + captionOffset(v)} ${subY - 4} l3 3.2 l5.5 -7`}
          fill="none"
          stroke={v.color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {/* The chevron says "there is more behind this circle". */}
      {interactive && (
        <path
          d={
            open
              ? `M${v.labelX + captionOffset(v)} ${subY - 1} l4 -4 l4 4`
              : `M${v.labelX + captionOffset(v)} ${subY - 5} l4 4 l4 -4`
          }
          fill="none"
          stroke={v.color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </g>
  );
}

/** Where the chevron sits relative to the centred caption. */
function captionOffset(v: FlowVertex): number {
  const chars = v.subLabel?.length ?? 0;
  return (chars * 11 * 0.55) / 2 + 4;
}
