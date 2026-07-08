/**
 * Whether the shell shows its always-visible "＋ Anlage hinzufügen" header
 * action.
 *
 * The button is scoped to the ONE case where a customer would otherwise have
 * no obvious way to add a second Anlage: a customer whose account holds exactly
 * one Anlage. They have neither the "Übersicht" nor the Anlagen-Liste (both
 * appear only from the second Anlage on), so "Meine Anlage" is their whole home
 * and the only pre-existing entry point was a quiet text line at the very
 * bottom of the page. The header button makes it obvious and reachable from
 * every page without scrolling.
 *
 * Deliberately NOT shown for:
 * - Portal-Admins (they provision Anlagen through the Plattform surface, never
 *   this customer affordance).
 * - Fleets (>= 2 Anlagen), which already carry an "Anlage anlegen" button on
 *   the Übersicht and the Anlagen-Liste - scoping to a single Anlage avoids two
 *   competing buttons on the same screen.
 * - The empty account (0 Anlagen) and the first-run onboarding, which have
 *   their own prominent "Anlage anlegen" call to action.
 * - Before the tenant-scoped data has loaded (an admin without a picked tenant,
 *   or the initial load).
 */
export function showAddAnlageButton(p: {
  isAdmin: boolean;
  loaded: boolean;
  tenantReady: boolean;
  onboarding: boolean;
  siteCount: number;
}): boolean {
  return (
    !p.isAdmin && p.loaded && p.tenantReady && !p.onboarding && p.siteCount === 1
  );
}
