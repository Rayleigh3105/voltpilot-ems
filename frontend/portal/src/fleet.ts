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
import type { EarningsDaily, EarningsRange, EarningsReason, EarningsSite, OverviewLive, OverviewSite, PlantKind, TarifArt } from './api';
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
      return `${phrase} herausgeholt, alle Anlagen zusammen`;
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
 * Der K8-Vergleichsanker als EIN Satz: das exakte `proofLine`-PAAR, beide
 * Seiten beschriftet.
 *
 * ⚠ Ein Anker vergleicht IMMER dieselbe Größe. Eine einseitige Formulierung
 * („Ohne Speicher wären es 1,90 €.") bezieht ihr „es" stillschweigend auf die
 * Zahl darüber - steht dort eine ERSPARNIS, vergleicht der Satz Ersparnis
 * gegen Kosten und liest sich, als mache der Speicher es schlechter (echter
 * Kundenbefund auf der Fahrplan-Seite, 11.08.2026). Deshalb gibt es hier nur
 * das Paar; wer einen Anker braucht, nimmt diese Funktion.
 */
export function proofAnchor(
  kind: FleetKind,
  baselineEur: number,
  actualEur: number,
): string {
  const p = proofLine(kind, baselineEur, actualEur);
  return `${p.mitLabel} ${eurAmount(p.mitEur)} · ${p.ohneLabel} ${eurAmount(p.ohneEur)}.`;
}

/**
 * Hero fine print for the measured number - plain German, says what the number
 * is (measured values x exchange prices vs. the unregulated plant), handles
 * the Marktprämie for fleets with Direktvermarktung, and dates a "Gesamt" view
 * honestly.
 *
 * Marktprämie wording (dynamic model, 2026-07-07): when an anzulegender Wert
 * is CONFIGURED (`premiumIncluded`), the numbers include the dynamic monthly
 * premium, so the fine print says so - with the two numbers behind it when the
 * hero is site-scoped (`detail`): "Inkl. Marktprämie: anzulegender Wert X ct -
 * Monatsmarktwert Solar Y ct (vorläufig)". Without a configured value the
 * generic "zzgl. Marktprämie" stays (the amount is then deliberately NOT in
 * the numbers).
 */
export function realizedFinePrint(
  kind: FleetKind,
  range: EarningsRange,
  firstCoveredDate: string | null,
  premiumIncluded = false,
  arbitrageShown = false,
  detail: PremiumDetail | null = null,
): string {
  let text =
    'Berechnet aus Ihren gemessenen Werten und den Börsenstrompreisen - im Vergleich ' +
    'zur ungeregelten Anlage: gleiche Sonne, gleicher Verbrauch, Speicher ungenutzt.';
  if (kind !== 'eigenverbrauch') {
    if (premiumIncluded && detail) {
      text +=
        ` Inkl. Marktprämie: anzulegender Wert ${ctAmount(detail.anzulegenderWertCtKwh)} ct` +
        ` − Monatsmarktwert Solar ${ctAmount(detail.marketValueSolarCtKwh)} ct` +
        `${detail.provisional ? ' (vorläufig)' : ''}, entfällt bei negativen Preisen.`;
    } else if (premiumIncluded) {
      text += ' Inkl. Marktprämie, entfällt bei negativen Preisen.';
    } else {
      text += ' Bei Direktvermarktung zzgl. Marktprämie.';
    }
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
 * when any Direktvermarktung site has an anzulegender Wert configured (the
 * backend then credits the dynamic monthly premium in the money values it
 * returns).
 */
export function premiumIncluded(
  sites: Pick<EarningsSite, 'plantKind' | 'anzulegenderWertCtKwh'>[],
): boolean {
  return sites.some(
    (s) => s.plantKind === 'direktvermarktung' && s.anzulegenderWertCtKwh != null,
  );
}

/** The two numbers behind the site-scoped premium fine print. */
export interface PremiumDetail {
  anzulegenderWertCtKwh: number;
  marketValueSolarCtKwh: number;
  /** True while any contributing month's market value is still provisional. */
  provisional: boolean;
}

/**
 * The premium fine-print detail for the rendered sites: only when EXACTLY ONE
 * Direktvermarktung site with an anzulegender Wert is shown (the site-scoped
 * hero, or a fleet with a single DV plant) AND its window has a market-value
 * benchmark - a multi-DV fleet mixes reference rates, so it keeps the generic
 * wording rather than an averaged pseudo-number.
 */
export function premiumDetail(
  sites: Pick<
    EarningsSite,
    'plantKind' | 'anzulegenderWertCtKwh' | 'marketValueSolarCtKwh' | 'marketValueProvisional'
  >[],
): PremiumDetail | null {
  const dv = sites.filter(
    (s) => s.plantKind === 'direktvermarktung' && s.anzulegenderWertCtKwh != null,
  );
  if (dv.length !== 1 || dv[0].marketValueSolarCtKwh == null) return null;
  return {
    anzulegenderWertCtKwh: dv[0].anzulegenderWertCtKwh as number,
    marketValueSolarCtKwh: dv[0].marketValueSolarCtKwh,
    provisional: dv[0].marketValueProvisional === true,
  };
}

/**
 * The benchmark KPI line of a Direktvermarktung site (the DV selling point):
 * the export-weighted price the plant's feed-in actually fetched vs the
 * Monatsmarktwert Solar over the same window. Beating the market average is
 * exactly what shifting feed-in out of cheap solar hours delivers. Null for
 * Eigenverbrauch sites and windows without exported energy or market-value
 * coverage - never a made-up comparison.
 */
export function marktwertBenchmark(
  site: Pick<
    EarningsSite,
    'plantKind' | 'realizedExportCtKwh' | 'marketValueSolarCtKwh' | 'marketValueProvisional'
  >,
): string | null {
  if (site.plantKind !== 'direktvermarktung') return null;
  if (site.realizedExportCtKwh == null || site.marketValueSolarCtKwh == null) return null;
  const provisional = site.marketValueProvisional === true ? ' (vorläufig)' : '';
  return (
    `Sie haben ${ctAmount(site.realizedExportCtKwh)} ct/kWh für Ihren eingespeisten Strom erzielt` +
    ` − Monatsdurchschnitt Solar: ${ctAmount(site.marketValueSolarCtKwh)} ct${provisional}.`
  );
}

/** ct/kWh for user copy: German comma, one decimal ("8,1"). */
function ctAmount(value: number): string {
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Parse the anzulegender-Wert form input into ct/kWh: German comma or dot
 * decimals ("8,11" / "8.11"), empty = null (not configured), anything invalid
 * or negative = undefined (the form shows a German error and blocks the
 * submit - a reference rate can never be negative).
 */
export function parsePremiumInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The stored anzulegender Wert as form text (German comma), '' when unset. */
export function premiumInputText(anzulegenderWertCtKwh: number | null): string {
  return anzulegenderWertCtKwh == null ? '' : String(anzulegenderWertCtKwh).replace('.', ',');
}

/**
 * Parse the "Maximale Einspeiseleistung am Netzanschlusspunkt" form input into
 * kW: German comma or dot decimals ("75" / "75,5"), empty = null (no cap set /
 * keep the stored value on update), anything invalid or not strictly positive
 * = undefined (the form shows a German error and blocks the submit - a
 * connection-point limit must be a positive power).
 */
export function parseFeedInCapInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The read-only Stromtarif label for the Technik view: names the art and, when
 * set, its ct/kWh parameter in plain German ("Dynamisch (Börsenpreis + 18
 * ct/kWh Aufschlag)", "Fest: 32,5 ct/kWh", "Ohne Angabe").
 */
export function tarifArtLabel(tarifArt: TarifArt, tarifParamCtKwh: number | null): string {
  if (tarifArt === 'ohne') return 'Ohne Angabe';
  if (tarifArt === 'fest') {
    return tarifParamCtKwh != null ? `Fest: ${ctAmount(tarifParamCtKwh)} ct/kWh` : 'Fest';
  }
  return tarifParamCtKwh != null && tarifParamCtKwh > 0
    ? `Dynamisch (Börsenpreis + ${ctAmount(tarifParamCtKwh)} ct/kWh Aufschlag)`
    : 'Dynamisch (nur Börsenpreis)';
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

/* ---------------------------------------------------------------------------
 * K1/K8 · Der Satz zum 14-Tage-Spark
 *
 * Ein 18-px-Balken kann seine Zahl nicht zeigen — genau dort steckt aber die
 * Zahl, die zählt. Die Antwort ist nicht ein Tooltip, sondern ein SATZ mit
 * Vergleichsanker (K8: „9,84 €" allein sagt nichts, „gestern waren es 3,40 €"
 * sagt alles) plus die BENENNUNG des Ausreissers (K6) — der Verlusttag wurde
 * vorher nur rot gefärbt, und davor sogar auf 0 geklemmt.
 *
 * Wie `composeFleetSentence` ist das eine reine Ableitung: kein Satz ohne
 * belegte Zahl, und ohne Satz der ehrliche Grund.
 * ------------------------------------------------------------------------- */

export interface SparkAussage {
  /** Der abgeleitete Satz — `null`, wenn es keine belegbare Aussage gibt. */
  satz: string | null;
  /** Dann der ehrliche Grund. */
  grund: string | null;
  /** Der schlechteste Verlusttag im Fenster — die eine benannte Marke (K6). */
  verlustTag: { day: string; eur: number; label: string } | null;
  /** Wie viele Verlusttage das Fenster trägt (für die Bildunterschrift). */
  verlustTage: number;
}

/** Ab dieser Abweichung heisst es nicht mehr „etwa so viel wie gestern". */
const GESTERN_TOLERANZ = 0.15;

/** Beträge darunter runden auf 0 — „−0,00 €" darf nirgends erscheinen. */
const EUR_DEADBAND = 0.005;

/**
 * Der Satz über dem 14-Tage-Spark: heutiger Wert, Vergleich mit gestern und —
 * falls es einen gibt — der benannte Verlusttag.
 */
export function sparkAussage(
  spark: { day: string; savedEur: number | null }[],
  now: Date,
): SparkAussage {
  const verluste = spark.filter(
    (d) => typeof d.savedEur === 'number' && d.savedEur < -EUR_DEADBAND,
  ) as { day: string; savedEur: number }[];
  const schlechtester = verluste.reduce<{ day: string; savedEur: number } | null>(
    (worst, d) => (worst == null || d.savedEur < worst.savedEur ? d : worst),
    null,
  );
  const verlustTag = schlechtester
    ? {
        day: schlechtester.day,
        eur: schlechtester.savedEur,
        label: `Verlusttag ${signedEur(schlechtester.savedEur)}`,
      }
    : null;

  const heute = spark.find((d) => d.day === berlinDay(now));
  if (!heute || heute.savedEur == null) {
    return {
      satz: null,
      grund: 'Für heute liegt noch kein Tageswert vor.',
      verlustTag,
      verlustTage: verluste.length,
    };
  }

  const gestern = spark.find(
    (d) => d.day === berlinDay(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  );
  const teile = [`Heute ${signedEur(heute.savedEur)}`];
  if (gestern && gestern.savedEur != null) {
    teile.push(` — ${vergleich(heute.savedEur, gestern.savedEur)}`);
  }
  let satz = `${teile.join('')}.`;
  if (verlustTag) {
    satz +=
      verluste.length === 1
        ? ` Ein Verlusttag ${signedEur(verlustTag.eur)}.`
        : ` ${verluste.length} Verlusttage, schlechtester ${signedEur(verlustTag.eur)}.`;
  }
  return { satz, grund: null, verlustTag, verlustTage: verluste.length };
}

/**
 * Der Vergleichsanker. „Etwa so viel" braucht BEIDE Schranken: rein relativ
 * wäre ein Sprung von 0,02 auf 0,05 € ein „mehr als doppelt so viel", rein
 * absolut wäre bei grossen Flotten jede Bewegung „etwa gleich".
 */
function vergleich(heute: number, gestern: number): string {
  const delta = heute - gestern;
  const schranke = Math.max(Math.abs(gestern) * GESTERN_TOLERANZ, 0.2);
  if (Math.abs(delta) <= schranke) return `etwa so viel wie gestern (${signedEur(gestern)})`;
  return delta > 0
    ? `mehr als gestern (${signedEur(gestern)})`
    : `weniger als gestern (${signedEur(gestern)})`;
}

function signedEur(eur: number): string {
  const value = Math.abs(eur) < EUR_DEADBAND ? 0 : eur;
  return `${value >= 0 ? '+' : ''}${eurAmount(value)}`;
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

/**
 * Plain-German warning shown when a site has a battery with no controlling
 * device: the optimizer plans it, but the plan can never reach the edge, so the
 * battery is not actually steered. Points the owner at the fix. Customer-facing
 * copy, so it names no internals (broker/optimizer/topics).
 */
export const BATTERY_NO_DEVICE_WARNING =
  'Ihr Speicher ist keinem Gerät zugeordnet - der Fahrplan kann nicht ausgeführt werden. ' +
  'Ordnen Sie den Speicher im Bereich „Technik“ Ihrer Anlage dem steuernden Wechselrichter zu.';

/** Short badge variant of the same warning (fleet site card). */
export const BATTERY_NO_DEVICE_SHORT = 'Speicher ohne Gerät';

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
