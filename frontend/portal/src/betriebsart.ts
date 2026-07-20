import type { Betriebsart } from './api';

/**
 * U0 shell decision (design vp-ems-ui-overhaul §2 / epic UO #509): which
 * navigation SHELL the portal renders. The former `sites.length >= 2`
 * heuristic is replaced by the tenant's EFFECTIVE Betriebsart (resolved
 * server-side, read from /tenant-context at login):
 *
 * - `endkunde` -> single-object cockpit shell. NEVER fleet/operator chrome:
 *   with one Anlage the Anlage IS the home; with 2-3 Anlagen the Übersicht
 *   shows the calm existing FleetUebersicht CARDS, never an operator table.
 * - `betreiber` -> fleet/portfolio shell, even with a single Standort (the
 *   operator signed up for portfolio affordances; the chrome must not jump
 *   when site 2 arrives). INTERIM: until the real Portfolio page ships
 *   (U5, #516) the shell lands on today's Übersicht.
 * - `null` (context not loaded / older backend) -> the v1 site-count
 *   fallback, byte-identical to the pre-U0 behavior.
 *
 * Admins keep today's behavior (tenant switcher + always-Übersicht); the
 * betriebsart in play is the currently-selected tenant's.
 */

export interface ShellInput {
  isAdmin: boolean;
  /** Sites/devices load settled (the pre-U0 gate for showing fleet nav). */
  loaded: boolean;
  /** False for an admin without a selected tenant (no context yet). */
  tenantReady: boolean;
  /** EFFECTIVE betriebsart from /tenant-context; null = unknown. */
  betriebsart: Betriebsart | null;
  siteCount: number;
}

/**
 * Does the tenant get the fleet shell (Übersicht as the fleet/portfolio
 * level)? Pure frame question - admin handling and load gates live in the
 * callers below.
 */
export function isFleetShell(betriebsart: Betriebsart | null, siteCount: number): boolean {
  if (betriebsart === 'betreiber') return true;
  if (betriebsart === 'endkunde') return siteCount >= 2;
  // Unknown frame: the v1 heuristic (fail-soft, no regression).
  return siteCount >= 2;
}

/** Whether the "Übersicht" nav item renders in the sidebar. */
export function showOverviewNav(i: ShellInput): boolean {
  if (i.isAdmin) return true;
  if (!i.loaded || !i.tenantReady) return false;
  return isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Whether a customer landing on #/uebersicht (default boot hash, old
 * bookmark) is forwarded to the Anlagen entry - i.e. the tenant has no fleet
 * level. A Betreiber is never forwarded: their landing IS the fleet shell.
 */
export function redirectOverviewToAnlage(i: ShellInput): boolean {
  if (i.isAdmin || !i.loaded) return false;
  return !isFleetShell(i.betriebsart, i.siteCount);
}
