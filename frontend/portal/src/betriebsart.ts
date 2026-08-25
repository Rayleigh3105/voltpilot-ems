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
 * Der BETREIBER-Rahmen: die EFFEKTIVE Betriebsart des Mandanten ist
 * `betreiber`.
 *
 * ⚠ Seit dem Anwendungs-Programm Stufe 4 (Captain-Entscheid E5) entscheidet
 * er NICHT mehr, WELCHE Fläche die Flotten-Ebene zeigt — es gibt nur noch EINE
 * ({@link showPortfolioNav}). Er steuert dort ausschliesslich DICHTE (Tabelle
 * statt Karten, `portfolioDichte`) und TONALITÄT (`fleetTonalitaet`). Sein
 * zweiter Nutzen ist unverändert: ein Betreiber hat seine Flotten-Ebene ab der
 * ERSTEN Anlage, ein Endkunde erst ab der zweiten.
 */
export function isBetreiberShell(betriebsart: Betriebsart | null): boolean {
  return betriebsart === 'betreiber';
}

/**
 * Wie die FLOTTEN-EBENE im Menü heisst (Navigations-Runde „zwei Ebenen",
 * r2 §5.1: „nur das Wort folgt der Tonalität").
 *
 * Es gibt sie GENAU EINMAL — ein Betreiber nennt sie „Portfolio", ein Endkunde
 * „Meine Anlagen". Der frühere zweite Eintrag „Meine Anlage(n)" (die Listen-
 * Seite) ist darin aufgegangen: das Portfolio IST die Liste, und zwei Einträge
 * für dieselbe Ebene waren dieselbe Frage mit zwei Antworten.
 */
export function fleetLabel(betriebsart: Betriebsart | null): string {
  return betriebsart === 'betreiber' ? 'Portfolio' : 'Meine Anlagen';
}

/**
 * Zeigt die Schale den Punkt `Portfolio` — und ist die Landung damit das
 * Portfolio-Cockpit?
 *
 * ⚠ **Anwendungs-Programm Stufe 4 (E5): die Bedingung ist die FLOTTEN-Ebene,
 * nicht mehr der Betreiber-Rahmen.** Bis dahin sah ein Endkunde mit drei
 * Anlagen die ruhigen `FleetUebersicht`-Karten und NIE eine Portfolio-Welt,
 * während ein Betreiber die feste Geld-/Speicher-Tabelle bekam — zwei
 * Implementierungen derselben Frage, und für einen Nur-Monitoring-Kunden
 * antwortete die eine mit „—, —, —". Jetzt komponiert EINE Fläche sich aus den
 * Anwendungen der Anlagen, und die Betriebsart wählt nur noch ihre Dichte.
 *
 * Sichtbare Folge (gewollt, in `concept.html` gezeigt): ein Endkunde ab zwei
 * Anlagen sieht statt „Übersicht" den Punkt „Portfolio" — dieselbe ruhige
 * Karten-Dichte, jetzt mit den Bausteinen seiner Anwendungen. Sein altes
 * Lesezeichen `#/uebersicht` gilt weiter: {@link redirectToPortfolio} leitet
 * es weiter.
 *
 * Ein Admin erreicht das Portfolio wie bisher über den Mandanten-Umschalter
 * (dessen Kontext den Rahmen und die Anlagen-Zahl liefert), deshalb braucht es
 * hier keinen Admin-Sonderfall.
 */
export function showPortfolioNav(i: ShellInput): boolean {
  if (!i.loaded || !i.tenantReady) return false;
  return isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Whether the "Übersicht" nav item renders in the sidebar. Wer eine
 * Flotten-Ebene hat, bekommt `Portfolio` STATTDESSEN (siehe
 * {@link showPortfolioNav}); Admins behalten sonst ihr heutiges
 * Immer-Übersicht-Verhalten, und ein Kunde ohne Flotten-Ebene hat gar keinen
 * Punkt (seine Welt IST die eine Anlage).
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
 * level. Wer eine Flotten-Ebene HAT, wird stattdessen auf das
 * Portfolio-Cockpit geleitet ({@link redirectToPortfolio}, das im Aufrufer
 * ZUERST greift) — hier bleibt nur der Einzel-Anlagen-Kunde übrig, und für den
 * ist alles unverändert.
 */
export function redirectOverviewToAnlage(i: ShellInput): boolean {
  if (i.isAdmin || !i.loaded) return false;
  if (isBetreiberShell(i.betriebsart)) return false;
  return !isFleetShell(i.betriebsart, i.siteCount);
}

/**
 * Wird die Landung auf das Portfolio-Cockpit umgelegt? Ein Mandant MIT
 * Flotten-Ebene, der auf `#/uebersicht` landet (Boot-Hash oder altes
 * Lesezeichen), wird auf `#/portfolio` geleitet — das ist der Weg, auf dem
 * seit Stufe 4 auch jedes Endkunden-Lesezeichen gilt. Admins sind
 * eingeschlossen: die Wahl im Umschalter bringt sie „über den Umschalter" ins
 * Portfolio des gewählten Kunden (Design §2.3).
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
