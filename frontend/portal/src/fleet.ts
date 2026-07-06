/**
 * Fleet-mode logic for the adaptive Übersicht (multi-site customers). Pure,
 * framework-free, fully unit-tested - the components only render it.
 *
 * Wording rule (captain decision, 2026-07-06): the fleet is a MIX of
 * Direktvermarktungs-Anlagen and Eigenverbrauchs-Haushalte. A fleet of only
 * DV sites speaks revenue ("Mehrerlös / mehr verdient" - at spot marketing the
 * money is literal income), only-EV speaks avoided cost ("Vorteil / gespart"),
 * a mixed fleet gets the neutral "Ihr VoltPilot-Vorteil" headline while each
 * site card keeps its own wording. Same formula, two stories.
 *
 * The fleet status sentence lifts the composeStatusSentence pattern from
 * live.ts to fleet level: green when everything is fine; ONE silent device
 * turns it amber and names it ("1 Gerät ... meldet sich nicht") - calm and
 * concrete, never alarm-red.
 */
import type { OverviewSite, PlantKind } from './api';
import { ONLINE_WINDOW_MS } from './api';
import { eurAmount, fmtNum } from './format';
import { DEADBAND_KW } from './live';

/** The fleet's overall plant-kind composition. */
export type FleetKind = PlantKind | 'gemischt';

export function fleetKind(kinds: PlantKind[]): FleetKind {
  const hasDv = kinds.includes('direktvermarktung');
  const hasEv = kinds.includes('eigenverbrauch');
  if (hasDv && !hasEv) return 'direktvermarktung';
  if (hasEv && !hasDv) return 'eigenverbrauch';
  return 'gemischt';
}

/** Hero headline per fleet composition. */
export function fleetHeadline(kind: FleetKind): string {
  return kind === 'direktvermarktung' ? 'Ihr VoltPilot-Mehrerlös' : 'Ihr VoltPilot-Vorteil';
}

/**
 * Hero subline under the big number - honestly labelled "geplant" (Phase 1
 * shows the plan's claim; measured numbers come with the earnings engine).
 */
export function fleetSubline(kind: FleetKind): string {
  switch (kind) {
    case 'direktvermarktung':
      return 'heute laut Fahrplan mehr verdient';
    case 'eigenverbrauch':
      return 'heute laut Fahrplan gespart';
    default:
      return 'heute laut Fahrplan, alle Standorte zusammen';
  }
}

/** Hero fine print - plain German, says what the number is and is not. */
export function fleetFinePrint(kind: FleetKind): string {
  // "mehr herausholen" also covers the mixed fleet - it reads right for both
  // avoided cost and market revenue; only-EV keeps the familiar "sparen".
  const verb = kind === 'eigenverbrauch' ? 'sparen' : 'mehr herausholen';
  return (
    `Geplanter Wert: So viel will VoltPilot heute mit Ihren Speichern ${verb} - ` +
    'berechnet aus Fahrplan und Börsenstrompreisen, im Vergleich zu einem Betrieb ' +
    'ohne Speicher. Gemessene Zahlen folgen in Kürze.'
  );
}

/**
 * The per-site money teaser on a fleet card, in the SITE's own wording.
 * Null when the site has no plan today - the card then stays silent about
 * money instead of showing a fake zero.
 */
export function siteEarnText(kind: PlantKind, savingsEur: number | null): string | null {
  if (savingsEur == null) return null;
  const signed = `${savingsEur >= 0 ? '+' : ''}${eurAmount(savingsEur)}`;
  const verb = kind === 'direktvermarktung' ? 'mehr verdient' : 'gespart';
  return `Heute ${signed} ${verb} (geplant)`;
}

// ---- Fleet status sentence ---------------------------------------------------

export interface FleetSentence {
  text: string;
  /** ok = green (all fine), warn = amber (needs attention), off = no devices. */
  tone: 'ok' | 'warn' | 'off';
}

/**
 * Sum of the fleet's CURRENT PV generation, over sites with a fresh live
 * snapshot only (never stale numbers). Null when no site is fresh or no fresh
 * site reports PV.
 */
export function fleetPvKw(sites: OverviewSite[], now: Date = new Date()): number | null {
  let sum: number | null = null;
  for (const s of sites) {
    if (!s.live || s.live.pvKw == null) continue;
    if (now.getTime() - new Date(s.live.ts).getTime() > ONLINE_WINDOW_MS) continue;
    sum = (sum ?? 0) + s.live.pvKw;
  }
  return sum;
}

/**
 * The one plain-German fleet answer above the site cards. Green when all
 * devices report; a silent (stale) device turns it amber and NAMES it; devices
 * still waiting for first data are named too (calm onboarding note).
 */
export function composeFleetSentence(
  sites: OverviewSite[],
  now: Date = new Date(),
): FleetSentence {
  const devices = sites.reduce((n, s) => n + s.deviceCount, 0);
  if (devices === 0) {
    return { tone: 'off', text: 'Noch keine Geräte verbunden.' };
  }
  const online = sites.reduce((n, s) => n + s.onlineCount, 0);
  const waiting = sites.reduce((n, s) => n + s.waitingCount, 0);
  const stale = devices - online - waiting;

  const staleSites = sites
    .filter((s) => s.deviceCount - s.onlineCount - s.waitingCount > 0)
    .map((s) => s.name);
  const waitingSites = sites.filter((s) => s.waitingCount > 0).map((s) => s.name);

  const parts: string[] = [];
  if (stale > 0) {
    parts.push(
      stale === 1
        ? `1 Gerät in ${listNames(staleSites)} meldet sich nicht.`
        : `${stale} Geräte melden sich nicht (${listNames(staleSites)}).`,
    );
    parts.push(`${online} von ${devices} Geräten online.`);
    return { tone: 'warn', text: parts.join(' ') };
  }
  if (waiting > 0) {
    parts.push(
      waiting === 1
        ? `1 Gerät in ${listNames(waitingSites)} wartet auf erste Daten.`
        : `${waiting} Geräte warten auf erste Daten (${listNames(waitingSites)}).`,
    );
    if (online > 0) parts.push(`${online} von ${devices} Geräten online.`);
    return { tone: 'warn', text: parts.join(' ') };
  }

  const pv = fleetPvKw(sites, now);
  const generating = pv != null && pv > DEADBAND_KW;
  return {
    tone: 'ok',
    text: generating
      ? `Alles läuft. ${online} von ${devices} Geräten online, Ihre Anlagen erzeugen gerade ${fmtNum(pv, 'kW')} Solarstrom.`
      : `Alles läuft. ${online} von ${devices} Geräten online.`,
  };
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

// ---- Site card derivations ----------------------------------------------------

/**
 * Whether a site card may show its live numbers as live: at least one device
 * is ONLINE (arrival-based) AND the snapshot observation itself is fresh - a
 * reconnected store-and-forward edge replaying hours-old samples is online but
 * its values are not current, and stale numbers must never render as live.
 */
export function siteLiveFresh(site: OverviewSite, now: Date = new Date()): boolean {
  if (site.onlineCount === 0 || !site.live) return false;
  return now.getTime() - new Date(site.live.ts).getTime() <= ONLINE_WINDOW_MS;
}
