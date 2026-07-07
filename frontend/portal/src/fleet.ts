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
import type { EarningsDaily, EarningsRange, EarningsReason, EarningsSite, OverviewLive, OverviewSite, PlantKind } from './api';
import { ONLINE_WINDOW_MS } from './api';
import { eurAmount, fmtNum } from './format';
import { composeStatusSentence, DEADBAND_KW, deriveBatteryKw, type LiveSnapshot } from './live';
import { sanitizeSoc } from './plausible';

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

// ---- Realized earnings wording (Phase 2: the hero shows MEASURED money) ------

/** The date of a moment as a Europe/Berlin ISO day string. */
export function berlinDay(at: Date): string {
  return at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/** German period phrase: "heute" / "im Juli" / "im Jahr 2026" / "seit ...". */
export function rangePhrase(
  range: EarningsRange,
  now: Date,
  firstCoveredDate: string | null,
): string {
  switch (range) {
    case 'day':
      return 'heute';
    case 'month':
      return `im ${now.toLocaleDateString('de-DE', { month: 'long', timeZone: 'Europe/Berlin' })}`;
    case 'year':
      return `im Jahr ${berlinDay(now).slice(0, 4)}`;
    default:
      return firstCoveredDate ? `seit dem ${fmtDayLong(firstCoveredDate)}` : 'insgesamt';
  }
}

/** "20. Juni 2026" from an ISO day string (no timezone surprises). */
function fmtDayLong(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00`).toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Hero subline under the measured number: the period phrase plus the fleet's
 * verb - only-DV "mehr verdient", only-EV "gespart", mixed the neutral
 * "herausgeholt" with the alle-Standorte hint.
 */
export function realizedSubline(
  kind: FleetKind,
  range: EarningsRange,
  now: Date,
  firstCoveredDate: string | null,
): string {
  const phrase = rangePhrase(range, now, firstCoveredDate);
  switch (kind) {
    case 'direktvermarktung':
      return `${phrase} mehr verdient`;
    case 'eigenverbrauch':
      return `${phrase} gespart`;
    default:
      return `${phrase} herausgeholt, alle Standorte zusammen`;
  }
}

/**
 * The hero's two-number proof line, sign-honest and free of minus signs. The
 * backend values are signed COSTS (negative = revenue):
 *
 * - both revenue (net export): "Erlös mit VoltPilot X / Ungeregelt wären es Y"
 * - both costs: "Stromkosten mit VoltPilot X / Ohne Speicher wären es Y"
 *   (Direktvermarktung/mixed say "Ungeregelt" - their counterfactual is the
 *   unregulated plant, not a missing battery)
 * - MIXED signs (earned with VoltPilot, would have paid without - or the
 *   reverse): neither single framing works without a confusing negative
 *   number, so each row says its own verb ("Mit VoltPilot verdient 12,89 € /
 *   Ohne Speicher hätten Sie gezahlt 12,89 €").
 *
 * Amounts are always absolute; the labels carry the direction.
 */
export interface ProofLine {
  mitLabel: string;
  ohneLabel: string;
  mitEur: number;
  ohneEur: number;
}

export function proofLine(kind: FleetKind, baselineEur: number, actualEur: number): ProofLine {
  // "Ohne Speicher" is the honest counterfactual name for a household;
  // marketed/mixed fleets compare against the unregulated plant.
  const counter = kind === 'eigenverbrauch' ? 'Ohne Speicher' : 'Ungeregelt';
  const mitRevenue = actualEur <= 0;
  const ohneRevenue = baselineEur <= 0;
  if (mitRevenue && ohneRevenue) {
    return {
      mitLabel: 'Erlös mit VoltPilot',
      ohneLabel: 'Ungeregelt wären es',
      mitEur: -actualEur,
      ohneEur: -baselineEur,
    };
  }
  if (!mitRevenue && !ohneRevenue) {
    return {
      mitLabel: 'Stromkosten mit VoltPilot',
      ohneLabel: `${counter} wären es`,
      mitEur: actualEur,
      ohneEur: baselineEur,
    };
  }
  return {
    mitLabel: mitRevenue ? 'Mit VoltPilot verdient' : 'Mit VoltPilot gezahlt',
    ohneLabel: ohneRevenue
      ? `${counter} hätten Sie verdient`
      : `${counter} hätten Sie gezahlt`,
    mitEur: Math.abs(actualEur),
    ohneEur: Math.abs(baselineEur),
  };
}

/**
 * Hero fine print for the measured number - plain German, says what the number
 * is (measured values x exchange prices vs. the unregulated plant), handles
 * the Marktprämie for fleets with Direktvermarktung, and dates a "Gesamt" view
 * honestly.
 *
 * Marktprämie wording (Phase 3): when a premium is CONFIGURED
 * (`premiumIncluded`), the numbers include it, so the fine print says so -
 * "inkl. Marktprämie, entfällt bei negativen Preisen" (the simplified §51-EEG
 * rule the backend applies). Without a configured premium the generic
 * "zzgl. Marktprämie" stays (the amount is then deliberately NOT in the
 * numbers).
 */
export function realizedFinePrint(
  kind: FleetKind,
  range: EarningsRange,
  firstCoveredDate: string | null,
  premiumIncluded = false,
  arbitrageShown = false,
): string {
  let text =
    'Berechnet aus Ihren gemessenen Werten und den Börsenstrompreisen - im Vergleich ' +
    'zur ungeregelten Anlage: gleiche Sonne, gleicher Verbrauch, Speicher ungenutzt.';
  if (kind !== 'eigenverbrauch') {
    text += premiumIncluded
      ? ' Inkl. Marktprämie, entfällt bei negativen Preisen.'
      : ' Bei Direktvermarktung zzgl. Marktprämie.';
  }
  if (arbitrageShown) {
    // The one-sentence attribution promise behind the "davon durch Netzladen"
    // line: what the number is and what it already accounts for.
    text +=
      ' Der Netzladen-Anteil ist der Verkaufserlös der aus dem Netz geladenen ' +
      'Energie abzüglich ihrer Einkaufskosten.';
  }
  if (range === 'all' && firstCoveredDate) {
    text += ` Messwerte liegen seit dem ${fmtDayLong(firstCoveredDate)} vor.`;
  }
  return text;
}

/**
 * The hero's calm "davon durch Netzladen verdient" extra line (captain pick
 * 2026-07-07): only for fleets/sites where an arbitrage attribution exists
 * (null = no line - EEG sites and ranges without grid charging stay silent).
 * Sign-honest: a period where grid charging LOST money (round-trip losses, a
 * price bet that did not come in) says so plainly instead of pretending a
 * "Verdienst"; a value rounding to zero renders "+0,00 €", never "-0,00 €".
 */
export function arbitrageLine(arbitrageEur: number | null): string | null {
  if (arbitrageEur == null) return null;
  const value = Math.abs(arbitrageEur) < 0.005 ? 0 : arbitrageEur;
  if (value < 0) {
    return `Netzladen hat in diesem Zeitraum ${eurAmount(-value)} gekostet`;
  }
  return `davon durch Netzladen verdient: +${eurAmount(value)}`;
}

/**
 * Whether the earnings numbers of these sites include a Marktprämie: true
 * when any Direktvermarktung site has one configured (the backend then
 * credits it in the money values it returns).
 */
export function premiumIncluded(sites: Pick<EarningsSite, 'plantKind' | 'marktpraemieCtKwh'>[]): boolean {
  return sites.some(
    (s) => s.plantKind === 'direktvermarktung' && s.marktpraemieCtKwh != null,
  );
}

/**
 * Parse the Marktprämie form input into ct/kWh: German comma or dot decimals
 * ("0,6" / "0.6"), empty = null (not configured), anything invalid or
 * negative = undefined (the form shows a German error and blocks the submit -
 * a premium can never be negative).
 */
export function parsePremiumInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The stored premium as form text (German comma), '' when not configured. */
export function premiumInputText(marktpraemieCtKwh: number | null): string {
  return marktpraemieCtKwh == null ? '' : String(marktpraemieCtKwh).replace('.', ',');
}

/**
 * The per-site money teaser on a fleet card, in the SITE's own wording - now
 * the MEASURED value for today. Null when nothing is computable today (e.g.
 * the rollups still trail live data) - the card then stays silent about money
 * instead of showing a fake zero.
 */
export function siteEarnText(kind: PlantKind, savedTodayEur: number | null): string | null {
  if (savedTodayEur == null) return null;
  // A value that ROUNDS to zero must render "+0,00 €", never "-0,00 €".
  const value = Math.abs(savedTodayEur) < 0.005 ? 0 : savedTodayEur;
  const signed = `${value >= 0 ? '+' : ''}${eurAmount(value)}`;
  const verb = kind === 'direktvermarktung' ? 'mehr verdient' : 'gespart';
  return `Heute ${signed} ${verb}`;
}

/** The realized savings of one Berlin day, from a site's 14-day series. */
export function savedOnDay(dailySaved: EarningsDaily[], day: string): number | null {
  const entry = dailySaved.find((d) => d.day === day);
  return entry ? entry.savedEur : null;
}

/**
 * The hero spark's fixed 14-day axis (oldest first, ending today Berlin): every
 * day gets a slot so two days of history render as two day-wide bars, not two
 * half-width blocks; days without a computable value carry null (empty slot,
 * never a fake zero bar).
 */
export function sparkDays(
  dailySaved: EarningsDaily[],
  now: Date,
  days = 14,
): { day: string; savedEur: number | null }[] {
  const byDay = new Map(dailySaved.map((d) => [d.day, d.savedEur]));
  const result: { day: string; savedEur: number | null }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = berlinDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    result.push({ day, savedEur: byDay.get(day) ?? null });
  }
  return result;
}

/** Merge the sites' per-day series into one fleet-wide series (sorted by day). */
export function fleetDailySaved(sites: EarningsSite[]): EarningsDaily[] {
  const byDay = new Map<string, number>();
  for (const s of sites) {
    for (const d of s.dailySaved) {
      byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.savedEur);
    }
  }
  return [...byDay.entries()]
    .map(([day, savedEur]) => ({ day, savedEur }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Card copy for a site whose earnings are not computable, plus the why. */
export function notComputableHint(reason: EarningsReason): string {
  switch (reason) {
    case 'missing_channels':
      return 'Das Gerät liefert nicht alle benötigten Messwerte (z. B. reine Erzeugungsmessung).';
    case 'no_prices':
      return 'Für den Zeitraum liegen noch keine Börsenpreise vor.';
    default:
      return 'Für den Zeitraum liegen noch keine Messwerte vor.';
  }
}

// ---- Grid-charging mode badge (netzladen_erlaubt) -----------------------------

/**
 * The plain-German mode badge of the per-site grid-charging switch: an EEG
 * site (netzladenErlaubt = false, the default) charges its battery only from
 * its own solar surplus - "Nur Solarladen (EEG)", green; a merchant site may
 * also charge from the grid - "Netzladen aktiv", cyan. The kind maps onto the
 * NetzladenBadge component's colorway.
 */
export interface NetzladenBadge {
  label: string;
  kind: 'eeg' | 'netzladen';
}

export function netzladenBadge(netzladenErlaubt: boolean): NetzladenBadge {
  return netzladenErlaubt
    ? { label: 'Netzladen aktiv', kind: 'netzladen' }
    : { label: 'Nur Solarladen (EEG)', kind: 'eeg' };
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

// ---- Single-site status (the simplified single-site Übersicht) ----------------

/**
 * A site's overview snapshot as the live.ts LiveSnapshot the EnergyFlow
 * diagram renders: battery derived from the power balance, SoC sanitized -
 * exactly the fleet-card conventions. No live row = all-absent (the diagram
 * then shows a calm grey picture, never fake zeros).
 */
export function siteSnapshot(live: OverviewLive | null): LiveSnapshot {
  if (!live) {
    return { pvKw: null, loadKw: null, gridKw: null, battKw: null, socPct: null, socAt: null };
  }
  const socPct = sanitizeSoc(live.socPct);
  return {
    pvKw: live.pvKw,
    loadKw: live.loadKw,
    gridKw: live.gridKw,
    battKw: deriveBatteryKw(live.pvKw, live.loadKw, live.gridKw),
    socPct,
    socAt: socPct == null ? null : live.ts,
  };
}

/**
 * The ONE plain-German sentence of the single-site Übersicht (single-site
 * customers and the fleet drill-down) - the fleet sentence's singular sibling.
 * Device health leads: a silent device turns the sentence amber and says what
 * to check; a device still waiting for first data gets the calm onboarding
 * note. When everything reports, "Alles läuft." plus the live energy sentence
 * from live.ts; an online device whose newest OBSERVATION is old (a
 * store-and-forward edge replaying its buffer) stays green but says the values
 * are still in transit - stale numbers never read as live.
 */
export function composeSiteSentence(site: OverviewSite, now: Date = new Date()): FleetSentence {
  const devices = site.deviceCount;
  if (devices === 0) {
    return { tone: 'off', text: 'Hier ist noch kein Gerät verbunden.' };
  }
  const online = site.onlineCount;
  const waiting = site.waitingCount;
  const stale = devices - online - waiting;
  if (stale > 0) {
    const lead =
      devices === 1
        ? 'Ihr Gerät meldet sich nicht.'
        : stale === 1
          ? `1 von ${devices} Geräten meldet sich nicht.`
          : `${stale} von ${devices} Geräten melden sich nicht.`;
    return {
      tone: 'warn',
      text: `${lead} Bitte prüfen Sie, ob das Gerät mit Strom und Internet verbunden ist.`,
    };
  }
  if (waiting > 0) {
    return {
      tone: 'warn',
      text:
        devices === 1
          ? 'Ihr Gerät ist verbunden und wartet auf die ersten Daten.'
          : waiting === 1
            ? `1 von ${devices} Geräten wartet auf die ersten Daten.`
            : `${waiting} von ${devices} Geräten warten auf die ersten Daten.`,
    };
  }
  if (!siteLiveFresh(site, now)) {
    const onlinePart =
      devices === 1 ? 'Ihr Gerät ist online' : `${online} von ${devices} Geräten online`;
    return {
      tone: 'ok',
      text: `Alles läuft. ${onlinePart} - die neuesten Messwerte werden gerade übertragen.`,
    };
  }
  return {
    tone: 'ok',
    text: `Alles läuft. ${composeStatusSentence(siteSnapshot(site.live), true).text}`,
  };
}
