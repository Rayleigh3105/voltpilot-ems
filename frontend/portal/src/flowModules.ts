/**
 * AE3 / spec §4 "Modul-Karten spiegeln den Flow": the read-only module strip of
 * the adaptive live view is a reflection of the site's ACTIVE strategy nodes
 * (from the AE7 profile signals) plus the AE7 node governance (gated nodes show
 * the lock "VoltPilot richtet ein"). ONE truth - the flow; the cards follow, no
 * separate drifting surface. Pure + framework-free (flowModules.test.ts).
 *
 * German OUTCOME language only - "Modul"/"MILP"/optimizer-internal vocabulary
 * never appears (pinned by the test, the moduleSurface.ts discipline).
 */

import {
  NODE_ATYPICAL_GRID,
  NODE_MARKET,
  NODE_PEAKSHAVING,
  type UsageProfile,
} from './usageProfile';

export interface FlowModuleCard {
  /** The strategy node type this card reflects. */
  id: string;
  title: string;
  /** ONE outcome sentence. */
  line: string;
  /** active = runs on the flow ("läuft"); gated = the locked offer. */
  state: 'active' | 'gated';
}

interface NodeMeta {
  title: string;
  activeLine: string;
  gatedLine: string;
  gated: boolean;
}

/**
 * The known strategy nodes. `gated` mirrors the AE7 governance / the flow
 * catalog `gated:true` (market-/grid-near = VoltPilot-set). Change in lockstep
 * with usageProfile.ts + the flow catalog. (Self-consumption is base behaviour,
 * not a strategy node - report vp-nacht-bezug-e7 §3.3.)
 */
const NODE_META: Record<string, NodeMeta> = {
  [NODE_MARKET]: {
    title: 'Marktoptimierung',
    activeLine: 'Ihr Speicher lädt günstig und verkauft teuer – der Ertrag am Strommarkt.',
    gatedLine: 'Ihr Speicher könnte am Strommarkt Geld verdienen – auf Wunsch schaltet VoltPilot das frei.',
    gated: true,
  },
  [NODE_PEAKSHAVING]: {
    title: 'Lastspitzenkappung',
    activeLine: 'Der Speicher deckelt Ihre Netz-Spitze und senkt so Ihren Leistungspreis.',
    gatedLine: 'Bezugsspitzen kappen und den Leistungspreis senken – Einrichtung durch VoltPilot.',
    gated: true,
  },
  [NODE_ATYPICAL_GRID]: {
    title: 'Atypische Netznutzung',
    activeLine: 'Verbrauch in Randzeiten senkt Ihr Netzentgelt.',
    gatedLine: 'Verbrauch in Randzeiten für ein reduziertes Netzentgelt – Beratung durch VoltPilot.',
    gated: true,
  },
};

/** Fixed display order (headline value modules first). */
const ORDER = [NODE_MARKET, NODE_PEAKSHAVING, NODE_ATYPICAL_GRID];

/**
 * Which gated-but-not-active nodes to surface as the honest offer:
 * Marktoptimierung is always relevant (arbitrage upsell); Peak-Shaving and
 * atypische Netznutzung only make sense for a Gewerbe/Peak profile, so they are
 * offered there (matching the AE0 mockups' per-profile module strips).
 */
function offeredWhenInactive(nodeType: string, profile: UsageProfile): boolean {
  if (nodeType === NODE_MARKET) return true;
  if (nodeType === NODE_PEAKSHAVING || nodeType === NODE_ATYPICAL_GRID) return profile === 'peak';
  return false;
}

/**
 * Build the module strip: every ACTIVE known strategy node as a "läuft" card,
 * plus the relevant gated-but-inactive nodes as locked offers. Reflects the
 * flow (active nodes) + governance (locks); a site with no active flow shows
 * just the offers.
 */
export function flowModuleCards(
  profile: UsageProfile,
  activeStrategyNodeTypes: string[],
): FlowModuleCard[] {
  const active = new Set(activeStrategyNodeTypes);
  const cards: FlowModuleCard[] = [];
  for (const type of ORDER) {
    const meta = NODE_META[type];
    if (!meta) continue;
    if (active.has(type)) {
      cards.push({ id: type, title: meta.title, line: meta.activeLine, state: 'active' });
    } else if (meta.gated && offeredWhenInactive(type, profile)) {
      cards.push({ id: type, title: meta.title, line: meta.gatedLine, state: 'gated' });
    }
  }
  return cards;
}
