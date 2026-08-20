// AE7 Nutzungsprofil (usage profile) - the SECOND adaptation axis
// (adaptive-ems-ui-v1-spec.md §2/§3, contract docs/contracts/v2/usage-profile.md).
//
// The usage profile (arbitrage | peak | laden | private) steers the portal/edge EMPHASIS
// (money-/peak-/flow-centric). It is DERIVED from the site's strategy nodes +
// entity mix + money master data, explicitly overridable - ONE truth, not a
// competing concept.
//
// Byte-identical twin of services/api .../profile/UsageProfileDeriver.java; both
// are pinned by docs/contracts/v2/usage-profile-vectors.json. Change the rules on
// both sides + the vectors together.

export type UsageProfile = 'arbitrage' | 'peak' | 'laden' | 'private';
export type EmphasisLevel = 'prominent' | 'secondary' | 'minimal' | 'hidden';

export const NODE_MARKET = 'vp.strategy.market';
export const NODE_PEAKSHAVING = 'vp.strategy.peakshaving';
export const NODE_ATYPICAL_GRID = 'vp.strategy.atypical-grid';

export interface ProfileSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer: boolean;
  /**
   * Die Anlage hat mindestens einen Ladepunkt (Lastmanagement Stufe 3).
   * Absent = false, damit ein älterer Aufrufer zeichengleich weiterrechnet.
   */
  hasChargePoint?: boolean;
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

/**
 * Whether `value` is a SETTABLE usage-profile override. `private` and `laden`
 * are deliberately NOT settable (they are DERIVED: the household default and
 * the charging park); only `arbitrage` and `peak` may be chosen, so a stored/
 * legacy value of either falls through to the derivation.
 */
export function isUsageProfile(
  value: string | null | undefined,
): value is Exclude<UsageProfile, 'private'> {
  return value === 'arbitrage' || value === 'peak';
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
  // Der LADEPARK: Ladepunkte, aber kein Speicher und keine PV. Seine Frage ist
  // eindimensional (Bezug gegen Anschlussgrenze), und er verdient kein Geld -
  // ein Energiefluss-Held und eine Geld-Zone wären beide gelogen. Die Regel ist
  // strikt ADDITIV: sie greift nur dort, wo bisher `private` herauskam.
  if ((s.hasChargePoint ?? false) && !s.hasStorage && !s.hasPv) return 'laden';
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
    // ⚠ `laden` ist das EINZIGE Profil mit money: 'hidden' - und genau deshalb
    // ist es ein eigenes: ein Ladepark erzeugt nichts und rechnet nichts ab
    // (Scope-Zaun E4, Mockups §2 Entscheidung 2: kein einziger Euro auf der
    // ganzen Fläche, „Erlöse" fehlt auch in der Navigation). Der Held ist das
    // Budget-Band, also `peak: 'prominent'`; der Energiefluss hätte auf einer
    // Anlage ohne Erzeugung nichts zu zeigen.
    case 'laden':
      return { money: 'hidden', peak: 'prominent', flow: 'minimal', devices: 'prominent' };
    case 'private':
    default:
      return { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' };
  }
}

/**
 * The strategy node type a profile's auto-start starter flow places on the
 * battery, or `null` when the profile has no starter (the `private` household
 * default + any unknown profile - self-consumption is base behaviour, not a
 * strategy node). Twin of Java `FlowTemplates.strategyNodeType`.
 */
export function strategyNodeType(profile: string | null | undefined): string | null {
  switch (profile) {
    case 'arbitrage':
      return NODE_MARKET;
    case 'peak':
      return NODE_PEAKSHAVING;
    default:
      return null;
  }
}
