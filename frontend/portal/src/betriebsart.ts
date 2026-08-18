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
 * - `betreiber` -> the PORTFOLIO shell (U5, #516): the sidebar leads with a
 *   `Portfolio` item (aggregate KPIs + operator table) instead of `Übersicht`,
 *   even with a single Standort (the operator signed up for portfolio
 *   affordances; the chrome must not jump when site 2 arrives). Opening a
 *   Standort renders the SAME cockpit as the Endkunde shell (one cockpit, two
 *   shells).
 * - `null` (no explicit override stored, context not loaded, older backend) ->
 *   the v1 site-count fallback, byte-identical to the pre-U0 behavior. This is
 *   the DEFAULT for every existing tenant: the api derives the frame ONLY from
 *   an explicit `tenant.betriebsart`, never from `tenant.segment` (which
 *   defaults to `CI` and would otherwise have flipped every admin-provisioned
 *   customer into the Portfolio shell on deploy - pre-deploy audit HIGH-1).
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

/**
 * The Betreiber PORTFOLIO shell (U5): the tenant's EFFECTIVE frame is
 * `betreiber`. This is the ONLY thing that swaps the `Übersicht` sidebar item +
 * card landing for the `Portfolio` page + operator table; an `endkunde` (even
 * with 2-3 Anlagen) keeps the calm card Übersicht, and a null/unknown frame
 * falls back to the endkunde behavior. Distinct from {@link isFleetShell} (the
 * "is there a fleet LEVEL at all" question, which an endkunde with 2+ Anlagen
 * also answers yes to).
 */
export function isBetreiberShell(betriebsart: Betriebsart | null): boolean {
  return betriebsart === 'betreiber';
}

/**
 * Whether the sidebar shows the `Portfolio` item (and the landing is the
 * Portfolio page). Betreiber tenants only, once the load + tenant context are
 * settled. Admins reach it by selecting a betreiber tenant in the switcher
 * (their tenant-context then reports `betreiber`), so no special admin case is
 * needed here.
 */
export function showPortfolioNav(i: ShellInput): boolean {
  if (!i.loaded || !i.tenantReady) return false;
  return isBetreiberShell(i.betriebsart);
}

/**
 * Whether the "Übersicht" nav item renders in the sidebar. A Betreiber gets
 * `Portfolio` INSTEAD (see {@link showPortfolioNav}), so Übersicht is hidden
 * for them; admins otherwise keep today's always-Übersicht behavior; an
 * endkunde shows it only from the fleet level (2+ Anlagen).
 */
export function showOverviewNav(i: ShellInput): boolean {
  if (showPortfolioNav(i)) return false;
  if (i.isAdmin) return true;
  if (!i.loaded || !i.tenantReady) return false;
  return isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Whether a customer landing on #/uebersicht (default boot hash, old
 * bookmark) is forwarded to the Anlagen entry - i.e. the tenant has no fleet
 * level. A Betreiber is never forwarded here: their landing is the Portfolio
 * page (see {@link redirectToPortfolio}), and an endkunde fleet keeps the
 * Übersicht.
 */
export function redirectOverviewToAnlage(i: ShellInput): boolean {
  if (i.isAdmin || !i.loaded) return false;
  if (isBetreiberShell(i.betriebsart)) return false;
  return !isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Whether the current landing should be swapped to the Portfolio page: a
 * betreiber tenant landing on `#/uebersicht` (the default boot hash / an old
 * bookmark) is sent to `#/portfolio`. Admins are included - selecting a
 * betreiber tenant surfaces the Portfolio "via the switcher" (design §2.3).
 */
export function redirectToPortfolio(i: ShellInput): boolean {
  return showPortfolioNav(i);
}

/**
 * Landet dieser Aufruf auf der PLATTFORM-ÜBERSICHT statt auf der
 * Kunden-Übersicht? (Admin-Umbau Stufe 1, Captain-Entscheid F1.)
 *
 * Ein Admin-Boot rendert bis hierher die KUNDEN-Übersicht - ohne gewählten
 * Mandanten praktisch leer -, während die Plattform-Übersicht, die als
 * „täglicher erster Blick" gebaut wurde (Captain-Entscheid Q1), einen Klick
 * entfernt lag. Der Admin soll auf seiner Landung aufwachen.
 *
 * ⚠ Die Bedingung ist der LEERE Boot-Hash, nicht „die Übersicht ist offen":
 * ein Admin hat den Nav-Punkt „Übersicht" weiterhin und muss ihn anklicken
 * können, ohne sofort weitergeleitet zu werden. Deshalb entscheidet
 * ausschließlich, ob der Aufruf überhaupt ein Ziel genannt hat - ein
 * Deep-Link (auch `#/uebersicht`) bleibt unangetastet, und die Weiterleitung
 * läuft genau EINMAL je Sitzung (der Aufrufer merkt sich das).
 */
export function redirectAdminToPlattform(i: { isAdmin: boolean; bootHash: boolean }): boolean {
  return i.isAdmin && i.bootHash;
}
