/**
 * Pure, framework-free logic for the Betreiber PORTFOLIO shell (U5, design
 * vp-ems-ui-overhaul §6 Face 4 + §5.3): the aggregate KPI row + the operator
 * table (Anlage · Profil-Chip · Entitäten · SoC · jetzt · heute € · Status).
 * Portfolio is not an AE7 profile - it is the Betreiber SHELL whose rows drill
 * into each Standort's own derived cockpit (§2.3). Everything here is derived
 * from the ONE additive /overview rollup (roleCounts + usageProfile per site)
 * plus the existing /earnings totals - no new engine, the AE4 "lens, not
 * engine" rule. The components only render what these return.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { Earnings, EarningsSite, Overview, OverviewSite, RoleCounts } from './api';
import { berlinDay, savedOnDay, siteLiveFresh } from './fleet';
import { sanitizeSoc } from './plausible';

// ---- Entitäten badge (Σ per role) --------------------------------------------

export type TopologyRole = 'pv' | 'storage' | 'consumer' | 'grid';

/** One role's Σ for the "Entitäten" column: an Icon (never an emoji glyph - the
 *  portal renders icons through the design-system Icon component) + a count. */
export interface RoleBadge {
  role: TopologyRole;
  icon: IconName;
  /** German role name for the tooltip/aria label ("2 Speicher"). */
  label: string;
  count: number;
}

const ROLE_META: Record<TopologyRole, { icon: IconName; label: string }> = {
  pv: { icon: 'sun', label: 'Erzeuger' },
  storage: { icon: 'battery', label: 'Speicher' },
  consumer: { icon: 'zap', label: 'Verbraucher' },
  grid: { icon: 'activity', label: 'Netz' },
};

/** Fixed render order (pv, storage, consumer, grid); only non-zero roles shown. */
const ROLE_ORDER: TopologyRole[] = ['pv', 'storage', 'consumer', 'grid'];

/**
 * The Σ-per-role badges of a site's entity registry, in canonical order, with
 * the zero roles dropped. An absent roleCounts (older backend) or an all-zero
 * count (v1/registry-less site) yields an empty list - the column then reads
 * "—", never a fake zero badge.
 */
export function roleBadges(counts: RoleCounts | undefined): RoleBadge[] {
  if (!counts) return [];
  const badges: RoleBadge[] = [];
  for (const role of ROLE_ORDER) {
    const count = counts[role] ?? 0;
    if (count > 0) {
      badges.push({ role, icon: ROLE_META[role].icon, label: ROLE_META[role].label, count });
    }
  }
  return badges;
}

/** Whether a site declares ANY v2 entity (drives the "—" empty state). */
export function hasEntities(counts: RoleCounts | undefined): boolean {
  return roleBadges(counts).length > 0;
}

// ---- Profil-Chip (the per-site AE7 profile) ----------------------------------

export type ProfileKind = 'arbitrage' | 'peak' | 'private' | 'unknown';

export interface ProfileChip {
  kind: ProfileKind;
  /** Short German label for the chip. */
  label: string;
}

/**
 * The portfolio Profil-Chip for a site's effective AE7 usage profile. Faces
 * (design §6): Arbitrage/Direktvermarktung, Lastspitze (peak), Privat
 * (Eigenverbrauch). An absent/unknown value (older backend) reads "Standard"
 * as a calm neutral chip, never a wrong face.
 */
export function profileChip(usageProfile: string | undefined): ProfileChip {
  switch (usageProfile) {
    case 'arbitrage':
      return { kind: 'arbitrage', label: 'Arbitrage' };
    case 'peak':
      return { kind: 'peak', label: 'Lastspitze' };
    case 'private':
      return { kind: 'private', label: 'Privat' };
    default:
      return { kind: 'unknown', label: 'Standard' };
  }
}

// ---- Per-row derivations -----------------------------------------------------

export interface RowStatus {
  label: string;
  tone: 'ok' | 'warn' | 'off';
}

/**
 * The compact status badge for a portfolio table row - the fleet liveness rules
 * (fleet.ts) reduced to a one-word verdict: a silent device is amber, a device
 * still waiting for first data is amber, an online site is green (even while its
 * newest values are still in transit - it IS online), no device is neutral.
 */
export function siteStatus(site: OverviewSite): RowStatus {
  if (site.deviceCount === 0) {
    return { label: 'Kein Gerät', tone: 'off' };
  }
  const stale = site.deviceCount - site.onlineCount - site.waitingCount;
  if (stale > 0) {
    return { label: 'Meldet sich nicht', tone: 'warn' };
  }
  if (site.onlineCount === 0 && site.waitingCount > 0) {
    return { label: 'Wartet auf Daten', tone: 'warn' };
  }
  return { label: 'Online', tone: 'ok' };
}

/** The site's plausible live SoC (%), only when a live snapshot exists; else null. */
export function siteSoc(site: OverviewSite): number | null {
  return site.live ? sanitizeSoc(site.live.socPct) : null;
}

/**
 * The site's "jetzt" power (kW): the current PV generation when a FRESH live
 * snapshot is present (a reconnected store-and-forward edge replaying old
 * samples is online but its values are not current, so stale numbers never
 * render as live). Null when no fresh PV reading exists.
 */
export function siteNowKw(site: OverviewSite, now: Date = new Date()): number | null {
  if (!siteLiveFresh(site, now) || !site.live) return null;
  return site.live.pvKw;
}

/** The site's realized savings for today (Berlin day), from its 14-day series. */
export function siteSavedToday(
  earningsSite: Pick<EarningsSite, 'dailySaved'> | null,
  now: Date = new Date(),
): number | null {
  if (!earningsSite) return null;
  return savedOnDay(earningsSite.dailySaved, berlinDay(now));
}

// ---- Aggregate KPI row -------------------------------------------------------

export interface PortfolioKpis {
  /** Σ battery capacity (kWh) over the fleet; null when no battery. */
  storageKwh: number | null;
  /** Σ battery discharge power (kW) over the fleet; null when no battery. */
  storageKw: number | null;
  /** Ø live SoC (%) over sites with a plausible reading; null when none. */
  portfolioSoc: number | null;
  /** Realized Erlös today (Berlin day), summed over sites; null when none. */
  erloesHeute: number | null;
  /** Realized Erlös over the earnings range (month by default); null when none. */
  erloesRange: number | null;
  /** Σ vermiedene Spitze (EUR) over module-active sites; null when none. */
  avoidedPeakEur: number | null;
  /** Σ vermiedene Spitze (kW) over module-active sites; null when none. */
  avoidedPeakKw: number | null;
}

/**
 * The portfolio KPI row from the ONE /overview + ONE /earnings response:
 *
 * - Σ Speicher kWh/kW: the fleet storage totals (overview.totals, from the v1
 *   asset rows).
 * - Portfolio-SoC: the simple average of the sites' plausible live SoC (an
 *   absent reading is skipped, never counted as 0).
 * - Erlös heute/Monat: today's summed realized savings + the range total, both
 *   from /earnings (null = nothing computable, never a fake 0).
 * - Σ vermiedene Spitze: sums the per-site peakShaving blocks (PS-4) - cheap,
 *   present only for module-active sites (§6 Face 4).
 */
export function portfolioKpis(
  overview: Overview | null,
  earnings: Earnings | null,
  now: Date = new Date(),
): PortfolioKpis {
  const storageKwh = overview?.totals.storageCapacityKwh ?? null;
  const storageKw = overview?.totals.storagePowerKw ?? null;

  let socSum = 0;
  let socN = 0;
  for (const s of overview?.sites ?? []) {
    const soc = siteSoc(s);
    if (soc != null) {
      socSum += soc;
      socN += 1;
    }
  }
  const portfolioSoc = socN > 0 ? socSum / socN : null;

  const erloesRange = earnings?.totals.savedEur ?? null;

  const today = berlinDay(now);
  let heuteSum = 0;
  let heuteN = 0;
  for (const s of earnings?.sites ?? []) {
    const saved = savedOnDay(s.dailySaved, today);
    if (saved != null) {
      heuteSum += saved;
      heuteN += 1;
    }
  }
  const erloesHeute = heuteN > 0 ? heuteSum : null;

  let peakEurSum = 0;
  let peakKwSum = 0;
  let peakN = 0;
  for (const s of earnings?.sites ?? []) {
    const ps = s.peakShaving;
    if (ps && ps.avoidedEur != null) {
      peakEurSum += ps.avoidedEur;
      peakKwSum += ps.avoidedKw ?? 0;
      peakN += 1;
    }
  }
  const avoidedPeakEur = peakN > 0 ? peakEurSum : null;
  const avoidedPeakKw = peakN > 0 ? peakKwSum : null;

  return {
    storageKwh,
    storageKw,
    portfolioSoc,
    erloesHeute,
    erloesRange,
    avoidedPeakEur,
    avoidedPeakKw,
  };
}
