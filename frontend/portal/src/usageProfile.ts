// AE7 Nutzungsprofil (usage profile) - the SECOND adaptation axis
// (adaptive-ems-ui-v1-spec.md §2/§3, contract docs/contracts/v2/usage-profile.md).
//
// The usage profile (arbitrage | peak | private) steers the portal/edge EMPHASIS
// (money-/peak-/flow-centric). It is DERIVED from the site's strategy nodes +
// entity mix + money master data, explicitly overridable - ONE truth, not a
// competing concept.
//
// Byte-identical twin of services/api .../profile/UsageProfileDeriver.java; both
// are pinned by docs/contracts/v2/usage-profile-vectors.json. Change the rules on
// both sides + the vectors together.

export type UsageProfile = 'arbitrage' | 'peak' | 'private';
export type EmphasisLevel = 'prominent' | 'secondary' | 'minimal' | 'hidden';

export const NODE_MARKET = 'vp.strategy.market';
export const NODE_PEAKSHAVING = 'vp.strategy.peakshaving';
export const NODE_ATYPICAL_GRID = 'vp.strategy.atypical-grid';
export const NODE_SELFCONSUMPTION = 'vp.strategy.selfconsumption';

export interface ProfileSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer: boolean;
  activeStrategyNodeTypes: string[];
  plantKind: string | null;
  hasLeistungspreis: boolean;
  override?: string | null;
}

/** Which surfaces a profile makes prominent | secondary | minimal | hidden. */
export interface Emphasis {
  money: EmphasisLevel;
  peak: EmphasisLevel;
  flow: EmphasisLevel;
  devices: EmphasisLevel;
}

export function isUsageProfile(value: string | null | undefined): value is UsageProfile {
  return value === 'arbitrage' || value === 'peak' || value === 'private';
}

/** The derived default profile, ignoring any override. */
export function deriveDefault(s: ProfileSignals): UsageProfile {
  const types = s.activeStrategyNodeTypes ?? [];
  const peak =
    s.hasLeistungspreis ||
    types.includes(NODE_PEAKSHAVING) ||
    types.includes(NODE_ATYPICAL_GRID);
  if (peak) return 'peak';
  const arbitrage = types.includes(NODE_MARKET) || s.plantKind === 'direktvermarktung';
  if (arbitrage) return 'arbitrage';
  return 'private';
}

/** The effective profile: a valid override wins, else the derived default. */
export function effectiveProfile(s: ProfileSignals): UsageProfile {
  return isUsageProfile(s.override) ? s.override : deriveDefault(s);
}

/** The emphasis map for a profile (the ONE contract AE2/AE3/AE4/AE6 consult). */
export function emphasisFor(profile: string | null | undefined): Emphasis {
  switch (profile) {
    case 'arbitrage':
      return { money: 'prominent', peak: 'hidden', flow: 'secondary', devices: 'secondary' };
    case 'peak':
      return { money: 'secondary', peak: 'prominent', flow: 'secondary', devices: 'secondary' };
    case 'private':
    default:
      return { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' };
  }
}

/** The strategy node type a profile's auto-start starter flow places on the battery. */
export function strategyNodeType(profile: string | null | undefined): string {
  switch (profile) {
    case 'arbitrage':
      return NODE_MARKET;
    case 'peak':
      return NODE_PEAKSHAVING;
    case 'private':
    default:
      return NODE_SELFCONSUMPTION;
  }
}
