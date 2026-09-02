/**
 * Pure, framework-free logic for the money-centric "Meine Anlage" v2 view
 * (captain 2026-07-07, modelled on the Deye Copilot app). The page's period
 * tabs govern the whole page; this module derives every label, the tappable
 * 12-month strip, the Ertrag-chart axis labels and the "bester Tag" line - the
 * components only render it, and anlage.test.ts pins the numbers.
 *
 * All calendar reasoning is Europe/Berlin (the v1 platform timezone), matching
 * the backend's earnings buckets.
 */
import type {
  CreateSiteInput,
  EarningsMonth,
  EarningsRange,
  EarningsSeriesPoint,
  EarningsSite,
  Site,
} from './api';
import { eurAmount, NBSP } from './format';

const ZONE = 'Europe/Berlin';

/**
 * Builds a FULL site update payload from the current site, applying only the
 * fields a focused form edits. The backend UpdateSiteRequest is a
 * full-representation record (name is @NotBlank, plantKind/tarifArt/biddingZone
 * default when omitted), so a partial body would BLANK every untouched field.
 *
 * This is the load-bearing regression guard of the v3.1-M3 settings move: the
 * money/tariff fields (netzladenErlaubt, anzulegenderWertCtKwh, tarifArt,
 * tarifParamCtKwh) now live in the mode containers while name/zone/coords/type
 * and maxFeedInKw stay in the general Technik page - both edit surfaces MUST
 * carry the other's fields through unchanged, so both go through here. A
 * container save of a tariff field can never blank a Technik field, and a
 * Technik save can never blank a moved field.
 */
export function buildSitePayload(site: Site, overrides: Partial<CreateSiteInput>): CreateSiteInput {
  return {
    name: site.name,
    biddingZone: site.biddingZone,
    latitude: site.latitude,
    longitude: site.longitude,
    plantKind: site.plantKind,
    anzulegenderWertCtKwh: site.anzulegenderWertCtKwh,
    tarifArt: site.tarifArt,
    tarifParamCtKwh: site.tarifParamCtKwh,
    netzladenErlaubt: site.netzladenErlaubt,
    maxFeedInKw: site.maxFeedInKw,
    ...overrides,
  };
}

/** A moment as its Europe/Berlin ISO day ("2026-07-07"). */
function berlinDay(at: Date): string {
  return at.toLocaleDateString('sv-SE', { timeZone: ZONE });
}

/** Parse an ISO day ("2026-07-01") into a Date at local noon (no tz surprises). */
function isoNoon(isoDay: string): Date {
  return new Date(`${isoDay.slice(0, 10)}T12:00:00`);
}

/**
 * German energy label: kWh below a megawatt-hour, MWh above (the Deye-style
 * calm big-number unit). Null/undefined -> "–", never a fake zero.
 */
export function energyLabel(kwh: number | null | undefined): string {
  if (kwh == null) return '–';
  const abs = Math.abs(kwh);
  if (abs >= 1000) {
    return `${(kwh / 1000).toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}${NBSP}MWh`;
  }
  const digits = abs >= 100 ? 0 : 1;
  return `${kwh.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${NBSP}kWh`;
}

/** Short German month name of an ISO month/day string ("2026-07-01" -> "Jul"). */
export function monthShort(monthIso: string): string {
  return isoNoon(monthIso).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
}

/** Full German month name ("2026-07-01" -> "Juli"). */
export function monthLong(monthIso: string): string {
  return isoNoon(monthIso).toLocaleDateString('de-DE', { month: 'long' });
}

/**
 * **Der Standard-Zeitraum ist „Heute"** (Captain 2026-07-30: „immer auf heute
 * standardmäßig stellen statt Monat").
 *
 * Es gibt genau EINE Voreinstellung für den Zeitraum-Umschalter, und sie steht
 * hier: das Cockpit (Bilanz-Leiste + die von ihr regierten Kennzahlen) und die
 * Flotten-Übersicht lesen dieselbe Konstante. Eine vom Kunden getroffene Wahl
 * gewinnt weiterhin — sie lebt wie bisher im Seiten-Zustand (es gibt heute
 * keine Persistenz, und es wird hier auch keine erfunden). Die Historie kennt
 * ihren eigenen `HistoryRange` und steht schon auf „Tag"; das Portfolio hat
 * gar keinen Umschalter.
 */
export const DEFAULT_EARNINGS_RANGE: EarningsRange = 'day';

/**
 * The period headline of the money hero, from the SELECTED instance: "Heute"
 * for the day range, the month name ("Juli", "Juli 2025" across years) for
 * month, the year for year, "Gesamt" for all. `at` is the effective date the
 * range is anchored on (the strip's tapped month or today).
 */
export function periodLabel(range: EarningsRange, at: Date, now: Date = new Date()): string {
  const thisYear = berlinDay(now).slice(0, 4);
  const atYear = at.toLocaleDateString('en-CA', { timeZone: ZONE, year: 'numeric' });
  switch (range) {
    case 'day':
      return berlinDay(at) === berlinDay(now)
        ? 'Heute'
        : at.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: ZONE });
    case 'month': {
      const name = at.toLocaleDateString('de-DE', { month: 'long', timeZone: ZONE });
      return atYear === thisYear ? name : `${name} ${atYear}`;
    }
    case 'year':
      return atYear;
    default:
      return 'Gesamt';
  }
}

/**
 * V4 (Audit) — „Gesamt" beim Namen nennen. Die Summenzeile las
 * „**Gesamt gesamt**" (`${periodLabel} gesamt`, und `periodLabel('all')` ist
 * „Gesamt"), und niemand konnte sehen, WARUM Monat = Jahr = Gesamt dieselbe
 * Zahl zeigen (V13). Beides löst der abgedeckte Zeitraum: „seit 3. Juli 2026".
 * Ohne bekanntes Startdatum bleibt es beim schlichten „Gesamt" — nie ein
 * erfundenes Datum.
 */
export function coveredSinceLabel(firstCoveredDate: string | null | undefined): string | null {
  const iso = firstCoveredDate?.trim();
  if (!iso) return null;
  const d = isoNoon(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `seit ${d.toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;
}

/** One slot of the fixed 12-month strip (oldest first, ending this month). */
export interface StripSlot {
  /** First day of the Berlin month ("2026-07-01") - the `at` for a tap. */
  month: string;
  /** Short month name ("Jul"). */
  label: string;
  /** Gesamtertrag of the month, or null when it had no computable slot. */
  value: number | null;
  /** True for the current Berlin month. */
  isCurrent: boolean;
  /**
   * Ob der Monat überhaupt Daten trägt — `undefined` heißt **unbekannt** (die
   * Geld-Ansicht weiß es nicht und graut deshalb nie etwas aus). Die Historie
   * füllt es aus der Datenabdeckung (`historieZeit.ts`), damit ein Tipp nie in
   * eine garantiert leere Fläche führt.
   */
  hasData?: boolean;
}

/**
 * The tappable 12-month strip: a FIXED axis of the last `count` Berlin months
 * ending this month, so a partial history still renders month-wide chips (like
 * the earnings spark). Months without a computable value carry null - a glance
 * navigator, never a fake zero.
 */
export function stripSlots(strip: EarningsMonth[], now: Date, count = 12): StripSlot[] {
  const byMonth = new Map(strip.map((m) => [m.month.slice(0, 7), m.gesamtertragEur]));
  const currentKey = berlinDay(now).slice(0, 7);
  // Walk months back from the current one using UTC arithmetic on year/month.
  const [y, m] = currentKey.split('-').map(Number);
  const slots: StripSlot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthIso = `${key}-01`;
    slots.push({
      month: monthIso,
      label: monthShort(monthIso),
      value: byMonth.get(key) ?? null,
      isCurrent: key === currentKey,
    });
  }
  return slots;
}

/** Compact strip-chip value ("+104" / "-7" / "0" / "–"). */
export function stripValueLabel(value: number | null): string {
  if (value == null) return '–';
  const rounded = Math.round(value);
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  // Only a gain carries the "+"; zero stays bare, a loss keeps its own minus.
  return `${safe > 0 ? '+' : ''}${safe.toLocaleString('de-DE')}`;
}

/** Ertrag-chart section title per range ("Ertrag pro Tag" etc.). */
export function ertragTitle(range: EarningsRange): string {
  switch (range) {
    case 'day':
      return 'Ertrag pro Stunde';
    case 'month':
      return 'Ertrag pro Tag';
    default:
      return 'Ertrag pro Monat';
  }
}

/** X-axis label of one chart bucket given the range (Berlin-local). */
export function bucketAxisLabel(startIso: string, range: EarningsRange): string {
  const d = new Date(startIso);
  switch (range) {
    case 'day':
      return d
        .toLocaleTimeString('de-DE', { hour: '2-digit', hour12: false, timeZone: ZONE })
        .replace(/\D/g, '');
    case 'month':
      return `${d.toLocaleDateString('de-DE', { day: 'numeric', timeZone: ZONE })}.`;
    default:
      return d.toLocaleDateString('de-DE', { month: 'short', timeZone: ZONE }).replace('.', '');
  }
}

/** Full tooltip label of one chart bucket (Berlin-local). */
export function bucketTooltipLabel(startIso: string, range: EarningsRange): string {
  const d = new Date(startIso);
  switch (range) {
    case 'day':
      return `${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: ZONE })} Uhr`;
    case 'month':
      return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: ZONE });
    default:
      return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: ZONE });
  }
}

/** ct/kWh for provenance copy: German comma, one decimal ("7,6"). */
function ctAmount(value: number): string {
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Nachvollziehbarkeit (captain decision 3, 2026-07-08): each euro figure in the
 * money hero carries an expandable "i" whose body is ONE plain-German sentence
 * of provenance - the real quantities and prices of THIS Anlage, not a formula.
 * Each function returns null when the number is not shown (nothing to explain),
 * so the hero stays as calm as before when collapsed.
 */

/**
 * Einspeise-Erlös provenance: "Eingespeiste X MWh × Ø Y ct/kWh Börsenpreis Ihrer
 * Einspeise-Zeiten" (+ the Marktprämie note for a Direktvermarktung site with an
 * anzulegender Wert). realizedExportCtKwh is the export-weighted spot price the
 * feed-in actually fetched, so the number is real.
 *
 * ⚠ A1 (audit vp-review-eeg-r1): an EEG-vergütete Eigenverbrauchs-Anlage
 * (`exportVerguetungPriced === true`) valued its feed-in at the FESTE
 * Einspeisevergütung, not at spot - a bare "Börsenpreis" here (and the spot
 * figure `realizedExportCtKwh`) would visibly contradict the card's revenue
 * (report example: 1,5 kWh × 5,0 ct = 0,075 € vs. the card's 0,12165 €). Then
 * the effective rate is `einspeiseErloesEur / eingespeistKwh` (the blended
 * feste Vergütung, net of §51a), and the copy names it "Ihre feste
 * Einspeisevergütung". A missing flag (older/fleet backend) keeps the
 * conservative Börsenpreis wording, byte-identical.
 */
export function einspeiseProvenance(money: EarningsSite): string | null {
  if (money.einspeiseErloesEur == null) return null;
  const premium =
    money.plantKind === 'direktvermarktung' && money.anzulegenderWertCtKwh != null
      ? ' Enthält Ihre Marktprämie.'
      : '';
  if (money.exportVerguetungPriced === true) {
    // Effektiver Vergütungssatz aus den ZWEI gezeigten Zahlen (kein Spot); ohne
    // eingespeiste kWh gibt es keinen Satz, dann die zahlfreie ehrliche Fassung.
    if (money.eingespeistKwh != null && money.eingespeistKwh > 0) {
      return (
        `Eingespeiste ${energyLabel(money.eingespeistKwh)} × Ø ` +
        `${ctAmount((money.einspeiseErloesEur / money.eingespeistKwh) * 100)} ct/kWh ` +
        `Ihre feste Einspeisevergütung.`
      );
    }
    return 'Erlös aus dem ins Netz eingespeisten Solarstrom, bewertet zu Ihrer festen Einspeisevergütung.';
  }
  if (money.eingespeistKwh == null || money.realizedExportCtKwh == null) {
    return `Erlös aus dem ins Netz eingespeisten Solarstrom, bewertet zum Börsenpreis Ihrer Einspeise-Zeiten.${premium}`;
  }
  return (
    `Eingespeiste ${energyLabel(money.eingespeistKwh)} × Ø ${ctAmount(money.realizedExportCtKwh)} ct/kWh ` +
    `Börsenpreis Ihrer Einspeise-Zeiten.${premium}`
  );
}

/**
 * Wert-des-Eigenverbrauchs provenance. Seit dem Captain-Entscheid E7
 * (02.09.2026) wird die selbst genutzte kWh mit GENAU dem Preis bewertet, zu
 * dem auch der bezogene Netzstrom dieser Karte bewertet wird - der Wert IST
 * der vermiedene Bezug. Der Satz nennt deshalb keine Preis-FORMEL mehr (ob ein
 * Preisblatt, ein Aufschlag oder der Standard-Satz komponiert, weiß nur der
 * Server), sondern die Menge, den Bezugspreis und den EFFEKTIVEN Durchschnitt
 * aus den zwei gezeigten Zahlen - eine Aussage, die die Fläche selbst belegen
 * kann. {@code fest} behält seine exakte Zahl (dort IST der Tarif der
 * Bezugspreis); ohne Tarif-Bewertung ({@code tarifPriced === false}) nennt er
 * den Börsenpreis beim Namen und den Weg zum Stromtarif.
 */
export function eigenverbrauchProvenance(money: EarningsSite): string | null {
  const kwh = money.selbstverbrauchKwh;
  if (kwh == null) return null;
  const menge = `Selbst verbrauchte ${energyLabel(kwh)}`;
  if (money.eigenverbrauchsWertEur == null) {
    return `${menge} - direkt im Haus genutzter Solarstrom. Für diesen Zeitraum liegt kein Euro-Wert vor.`;
  }
  const gespart = ' So viel teuren Netzstrom haben Sie sich gespart.';
  if (money.tarifArt === 'fest' && money.tarifParamCtKwh != null) {
    return `${menge} × ${ctAmount(money.tarifParamCtKwh)} ct/kWh (Ihr fester Strompreis).${gespart}`;
  }
  const avg = kwh > 0 ? ` (im Schnitt ${ctAmount((money.eigenverbrauchsWertEur / kwh) * 100)} ct/kWh)` : '';
  if (money.tarifPriced === false) {
    return (
      `${menge} × Börsenpreis${avg} - bewertet wie Ihr Netzbezug. Für eine Bewertung zu Ihrem ` +
      `Stromtarif hinterlegen Sie ihn unter „Einstellungen".`
    );
  }
  return `${menge} × Ihr Bezugspreis${avg} - derselbe Preis, zu dem auch Ihr Netzstrom bewertet wird.${gespart}`;
}

/**
 * Gesamtertrag provenance: names the two parts that add up to it (feed-in
 * revenue + the value of self-consumption), so the big number is traceable.
 */
export function gesamtertragProvenance(money: EarningsSite): string | null {
  if (money.gesamtertragEur == null) return null;
  const einspeise = money.einspeiseErloesEur != null ? `Einspeise-Erlös ${eurAmount(money.einspeiseErloesEur)}` : null;
  const wert = money.eigenverbrauchsWertEur != null ? `Wert des Eigenverbrauchs ${eurAmount(money.eigenverbrauchsWertEur)}` : null;
  const parts = [einspeise, wert].filter(Boolean).join(' + ');
  return parts
    ? `Gesamtertrag = ${parts}.`
    : 'Ihr gesamter Ertrag in diesem Zeitraum: Einspeise-Erlös plus Wert Ihres Eigenverbrauchs.';
}

/**
 * "davon durch VoltPilots Steuerung" provenance: the measured extra vs. an
 * unregulated plant (battery off, PV fed in immediately) - what the steering
 * concretely earned/saved. Since the structured Bezugspreis (Stufe 3) the
 * avoided grid import inside this number is valued at the SITE'S TARIFF -
 * the same composition the steering optimizes against - so the sentence says
 * so when it applies (`tarifPriced`); a site without any price data stays
 * spot-valued and keeps the plain sentence, never an over-claim.
 */
export function savedProvenance(money: EarningsSite): string | null {
  if (money.savedEur == null) return null;
  const verb = money.plantKind === 'direktvermarktung' ? 'mehr verdient' : 'gespart';
  const tarif = money.tarifPriced
    ? ' Vermiedener Netzbezug ist dabei zu Ihrem Stromtarif bewertet statt zum Börsenpreis - dieselbe Rechnung, mit der die Steuerung plant.'
    : '';
  return (
    `Gemessen gegenüber einer ungeregelten Anlage (Speicher aus, Solarstrom sofort eingespeist): ` +
    `so viel hat VoltPilots Steuerung ${verb}.${tarif}`
  );
}

/** One energy tile of the money view: a name, the value, and a mini-explanation. */
export interface EnergyTile {
  label: string;
  value: string;
  hint: string;
}

/**
 * The three energy tiles, renamed + self-explaining (captain decision 4):
 * "Eingespeist / Selbst genutzt / Über Batterie", each with a one-line
 * everyday-language hint. Pure so anlage.test.ts pins the wording.
 */
export function energyTiles(money: EarningsSite | null): EnergyTile[] {
  return [
    { label: 'Eingespeist', value: energyLabel(money?.eingespeistKwh), hint: 'ins Netz verkauft' },
    { label: 'Selbst genutzt', value: energyLabel(money?.selbstverbrauchKwh), hint: 'direkt im Haus verbraucht' },
    { label: 'Über Batterie', value: energyLabel(money?.batterieBewegtKwh), hint: 'zwischengespeichert' },
  ];
}

/**
 * The forward "erwarteter Marktwert Solar" line for the Anlage money view
 * (captain 2026-07-09): the day-ahead price weighted with THIS Anlage's own PV
 * forecast over the coming horizon (Σ(price × pv) / Σ(pv), backend-computed),
 * the forward companion to the realized `marktwertBenchmark`. Returns the
 * formatted ct/kWh value, a plain-German horizon label ("nächste 24 h") and the
 * InfoTip text. Null when the backend has no forward figure (no PV forecast or
 * no forward price coverage) - the portal then hides the line entirely, never a
 * fake 0. Pure so anlage.test.ts pins the wording.
 */
export interface ExpectedMarketValueLine {
  /** "15,1 ct/kWh" (NBSP before the unit). */
  value: string;
  /** "nächste 24 h" - the covered forward window. */
  horizon: string;
  /** The InfoTip sentence (the plain formula, no jargon). */
  info: string;
}

export function expectedMarketValueLine(
  money: Pick<
    EarningsSite,
    | 'expectedMarketValueSolarCtKwh'
    | 'expectedMarketValueFrom'
    | 'expectedMarketValueTo'
    | 'expectedMarketValueSlots'
  >,
): ExpectedMarketValueLine | null {
  const ct = money.expectedMarketValueSolarCtKwh;
  if (ct == null) return null;
  return {
    value: `${ctAmount(ct)}${NBSP}ct/kWh`,
    horizon: expectedHorizonLabel(money.expectedMarketValueFrom, money.expectedMarketValueTo),
    info:
      'Erwarteter Marktwert Solar: die Day-Ahead-Börsenpreise der kommenden Stunden, ' +
      'gewichtet mit der PV-Prognose Ihrer Anlage - so viel ist Ihr Solarstrom im Schnitt ' +
      'wert, wenn er tatsächlich erzeugt wird.',
  };
}

/**
 * "nächste N h" from the covered forward window: the span from the first to the
 * last covered slot start, plus the last slot's 15 min, rounded to whole hours.
 * Falls back to "kommende Stunden" when the bounds are absent.
 */
function expectedHorizonLabel(from: string | null, to: string | null): string {
  if (from == null || to == null) return 'kommende Stunden';
  const spanH = (Date.parse(to) - Date.parse(from)) / 3_600_000 + 0.25;
  const hours = Math.max(1, Math.round(spanH));
  return `nächste ${hours}${NBSP}h`;
}

/** The best (highest-Gesamtertrag) bucket of a series, or null when empty. */
export function bestBucket(series: EarningsSeriesPoint[]): EarningsSeriesPoint | null {
  let best: EarningsSeriesPoint | null = null;
  for (const p of series) {
    if (best == null || p.gesamtertragEur > best.gesamtertragEur) best = p;
  }
  return best;
}

/**
 * The "bester Tag/Monat/Stunde" line under the Ertrag chart: names the best
 * bucket and its Gesamtertrag. Null when the series is empty or the best value
 * is not positive (nothing worth highlighting - honest, no "Bester Tag: 0 €").
 */
export function bestBucketText(series: EarningsSeriesPoint[], range: EarningsRange): string | null {
  const best = bestBucket(series);
  if (best == null || best.gesamtertragEur <= 0) return null;
  const lead = range === 'day' ? 'Beste Stunde' : range === 'month' ? 'Bester Tag' : 'Bester Monat';
  return `${lead}: ${bucketTooltipLabel(best.start, range)} · +${eurAmount(best.gesamtertragEur)}`;
}
