/**
 * Pure "Warum" logic for the battery Fahrplan (design report
 * data/vp-fahrplan-why-design: phases-first day story + per-slot why).
 *
 * The optimizer computes and PERSISTS the facts per slot (role, binding
 * flags, the exact value of stored energy) - this module only turns those
 * facts into presentation: consecutive same-role slots become PHASES (the
 * honest narrative unit - within a phase the exact slot ordering is partly
 * economically equivalent, so it is never justified), each phase gets its
 * planned €-contribution from the persisted cost fields, and each slot gets
 * ONE plain-German why-sentence built from its real numbers.
 *
 * Null-degradation is law: a plan whose slots carry no roles (old rows,
 * pre-feature optimizer, an unknown future role id) yields NO phases and the
 * Fahrplan renders byte-identically to today - explanations are never
 * fabricated. Customer copy never says Dual/Schattenpreis/MILP; the λ number
 * is called "Wert gespeicherter Energie" (the established admin German).
 */

import { eurAmount } from './format';
import type { PlanWordingKind } from './schedule';

// ---- The slot-role vocabulary (report §6) ---------------------------------

export const KNOWN_ROLES = [
  'abregeln',
  'reserve_halten',
  'warten',
  'pv_speichern',
  'guenstig_laden',
  'spitze_kappen',
  'verkaufen',
  'eigenverbrauch',
] as const;

export type SlotRole = (typeof KNOWN_ROLES)[number];

const ROLE_SET = new Set<string>(KNOWN_ROLES);

/** What the why-layer needs per slot - a structural subset of api ScheduleSlot. */
export interface WhySlot {
  start: string;
  batteryKw: number | null;
  socPct?: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
  curtailKw?: number | null;
  pvKw?: number | null;
  /** Slot role id (report §6); null/unknown = no why-layer for the plan. */
  slotRole?: string | null;
  /** Binding-constraint codes (report §5.1); null = none recorded. */
  slotFlags?: string[] | null;
  /** λ - the value of a stored kWh (ct/kWh, rounded 0.1 ct). */
  storedValueCtKwh?: number | null;
  /** π - effective energy value at the grid connection (admin-only display). */
  gridValueCtKwh?: number | null;
  /** μ - the slot's share of the Leistungspreis pressure (EUR/kW). */
  peakPressureEurKw?: number | null;
  /**
   * P0 "Textwahrheit" (report vp-netzbezug-nacht-s3 §6): what one imported
   * kWh REALLY costs this site in the slot (ct/kWh) - the price the optimizer
   * decided with. `priceEurMwh` is bare spot; comparing THAT against the
   * stored-energy value produced the systematically self-contradictory
   * sentence ("Börsenpreis 21,2 wäre teurer als 21,5" while grid power cost
   * 32,5). Null on older runs - the sentence degrades to a number-free form.
   */
  importPriceCtKwh?: number | null;
  /** What one exported kWh really earns in the slot (ct/kWh). */
  exportValueCtKwh?: number | null;
  /**
   * Which rule priced the import: fest | preisblatt | sammelaufschlag |
   * default-flag | spot. Decides whether the sentence may break the price
   * down into "Börsenpreis X + Netzentgelte/Abgaben Y".
   */
  importPriceSource?: string | null;
  /**
   * Persisted P2 wear the slot spends (EUR). Not part of the §5.1 customer
   * contract yet - when absent the phase-€ falls back to baseline − cost,
   * which matches the page's existing "Heute geplant gespart" framing.
   */
  wearCostEur?: number | null;
}

export type PhaseKind = 'charge' | 'discharge' | 'idle' | 'curtail';

/** Which goal a phase serves (report §7 - one driver per phase, no % split). */
export type ModeDriver = 'eigenverbrauch' | 'markt' | 'lastspitze' | 'notstrom' | null;

export interface PlanPhase {
  role: SlotRole;
  /** Inclusive slot-index range into the plan's slot array. */
  startIdx: number;
  endIdx: number;
  slotCount: number;
  /** ISO start of the first slot. */
  from: string;
  /** ISO end of the last slot (start + slotMinutes). */
  to: string;
  /**
   * Planned €-contribution of the phase: Σ (baseline − cost − wear) over its
   * priced slots. Null when no slot carries cost data - never a fabricated 0.
   */
  eur: number | null;
  kind: PhaseKind;
  driver: ModeDriver;
}

const ROLE_KIND: Record<SlotRole, PhaseKind> = {
  abregeln: 'curtail',
  reserve_halten: 'idle',
  warten: 'idle',
  pv_speichern: 'charge',
  guenstig_laden: 'charge',
  spitze_kappen: 'discharge',
  verkaufen: 'discharge',
  eigenverbrauch: 'discharge',
};

/** Below this a phase-€ is rounding noise, not a real contribution. */
export const PHASE_EUR_DEADBAND = 0.005;

/** Micro-phases shorter than this between same-role neighbors are smoothed. */
export const MICRO_PHASE_SLOTS = 3;

/** Every slot carries a KNOWN role - the gate for the whole why-layer. */
export function hasWhyLayer(slots: WhySlot[]): boolean {
  return (
    slots.length > 0 && slots.every((s) => s.slotRole != null && ROLE_SET.has(s.slotRole))
  );
}

/**
 * Group the plan's slots into phases: consecutive same-role runs, with
 * micro-runs (< 3 slots) BETWEEN same-role neighbors absorbed (report §3 -
 * a presentation rule; a short run between DIFFERENT roles is kept, it is a
 * real transition). Returns [] when any slot lacks a known role - the
 * null-degradation gate for the entire feature.
 */
export function phases(slots: WhySlot[], slotMinutes = 15): PlanPhase[] {
  if (!hasWhyLayer(slots)) return [];
  const roles = slots.map((s) => s.slotRole as SlotRole);

  // Consecutive same-role runs (inclusive index ranges).
  let runs: { role: SlotRole; start: number; end: number }[] = [];
  for (let i = 0; i < roles.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.role === roles[i]) last.end = i;
    else runs.push({ role: roles[i], start: i, end: i });
  }

  // Smooth micro-runs between same-role neighbors until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < runs.length - 1; i++) {
      const len = runs[i].end - runs[i].start + 1;
      if (len < MICRO_PHASE_SLOTS && runs[i - 1].role === runs[i + 1].role) {
        runs.splice(i - 1, 3, {
          role: runs[i - 1].role,
          start: runs[i - 1].start,
          end: runs[i + 1].end,
        });
        changed = true;
        break;
      }
    }
  }

  return runs.map((r) => {
    let eur: number | null = null;
    let anyPeakPressure = false;
    let reservePeak = false;
    let reserveBackup = false;
    for (let i = r.start; i <= r.end; i++) {
      const s = slots[i];
      if (s.costEur != null && s.baselineCostEur != null) {
        const wear = s.wearCostEur == null ? 0 : Number(s.wearCostEur);
        eur = (eur ?? 0) + (Number(s.baselineCostEur) - Number(s.costEur) - wear);
      }
      if (s.peakPressureEurKw != null && Number(s.peakPressureEurKw) > 0) anyPeakPressure = true;
      for (const f of s.slotFlags ?? []) {
        if (f === 'reserve_peak') reservePeak = true;
        if (f === 'reserve_backup') reserveBackup = true;
      }
    }
    const lastStart = new Date(slots[r.end].start).getTime();
    return {
      role: r.role,
      startIdx: r.start,
      endIdx: r.end,
      slotCount: r.end - r.start + 1,
      from: slots[r.start].start,
      to: new Date(lastStart + slotMinutes * 60_000).toISOString(),
      eur,
      kind: ROLE_KIND[r.role],
      driver: phaseDriver(r.role, anyPeakPressure, reservePeak, reserveBackup),
    };
  });
}

/** Report §7 precedence: μ-pressure → reserve flags → role's home mode. */
function phaseDriver(
  role: SlotRole,
  anyPeakPressure: boolean,
  reservePeak: boolean,
  reserveBackup: boolean,
): ModeDriver {
  if (role === 'spitze_kappen' || anyPeakPressure) return 'lastspitze';
  if (role === 'reserve_halten') {
    if (reservePeak) return 'lastspitze';
    if (reserveBackup) return 'notstrom';
    return null;
  }
  if (role === 'guenstig_laden' || role === 'verkaufen') return 'markt';
  if (role === 'pv_speichern' || role === 'eigenverbrauch') return 'eigenverbrauch';
  return null;
}

/** Customer-facing name of a phase driver (the mode tag on the phase card). */
export function driverLabel(driver: ModeDriver): string | null {
  switch (driver) {
    case 'eigenverbrauch':
      return 'Eigenverbrauch';
    case 'markt':
      return 'Marktvermarktung';
    case 'lastspitze':
      return 'Lastspitzenkappung';
    case 'notstrom':
      return 'Notstrom';
    default:
      return null;
  }
}

// ---- Labels + copy per role (report §6, D3 vocabulary) --------------------

/** Full customer label of a role (the panel headline). */
export function roleLabel(role: SlotRole, kind: PlanWordingKind, flags?: string[] | null): string {
  switch (role) {
    case 'abregeln':
      return 'Einspeisung pausiert (Negativpreis)';
    case 'reserve_halten': {
      const f = flags ?? [];
      if (f.includes('reserve_backup')) return 'Reserve halten (Notstrom)';
      if (f.includes('reserve_peak')) return 'Reserve halten (Lastspitze)';
      return 'Reserve halten';
    }
    case 'warten':
      return 'Warten';
    case 'pv_speichern':
      return 'PV-Überschuss speichern';
    case 'guenstig_laden':
      return 'Günstig aus dem Netz laden';
    case 'spitze_kappen':
      return 'Lastspitze kappen';
    case 'verkaufen':
      return kind === 'direktvermarktung' ? 'Zum Spitzenpreis verkaufen' : 'Einspeisen';
    case 'eigenverbrauch':
      return 'Verbrauch aus dem Speicher decken';
  }
}

/** ONE plain-German sentence summarizing a phase (the phase card body). */
export function phaseWhy(phase: PlanPhase, kind: PlanWordingKind): string {
  switch (phase.role) {
    case 'pv_speichern':
      return 'Überschüssiger Solarstrom wandert in den Speicher statt in die Einspeisung – für die teuren Stunden.';
    case 'guenstig_laden':
      return phase.driver === 'lastspitze'
        ? 'Der Speicher kauft günstigen Strom ein – bewusst flach verteilt, damit keine neue Lastspitze entsteht.'
        : 'Der Speicher kauft günstigen Strom ein – für die teuren Stunden danach.';
    case 'eigenverbrauch':
      return 'Der Speicher deckt den Verbrauch und vermeidet teuren Netzbezug.';
    case 'verkaufen':
      return kind === 'direktvermarktung'
        ? 'Der Speicher verkauft zum Spitzenpreis.'
        : 'Der Speicher speist zum hohen Preis ein.';
    case 'spitze_kappen':
      return 'Der Speicher hält den Netzbezug unter dem Spitzen-Ziel – jede Viertelstunde darüber würde die Leistungsspitze anheben.';
    case 'reserve_halten':
      if (phase.driver === 'notstrom')
        return 'Der Speicher hält Ladung als Notstrom-Reserve zurück.';
      if (phase.driver === 'lastspitze')
        return 'Der Speicher hält Ladung als Reserve für die Lastspitzenkappung zurück.';
      return 'Der Speicher hält Ladung als Reserve zurück.';
    case 'warten':
      return 'Der Speicher wartet – kein Einsatz, der sich nach Verlusten und Verschleiß lohnt.';
    case 'abregeln':
      return 'Einspeisen würde bei negativen Preisen Geld kosten – die PV wird gedrosselt, statt draufzuzahlen.';
  }
}

/**
 * The phase's planned €-line, sign-honest (report §8): discharge/sell phases
 * read "+X €"; a charge phase's negative € is honestly an Einkauf that pays
 * off in the discharge phases. Null when nothing is computable or the value
 * is rounding noise.
 */
export function phaseEurLine(phase: PlanPhase): string | null {
  const amount = phaseEurAmount(phase);
  if (amount == null) return null;
  if (phase.kind === 'charge' && (phase.eur ?? 0) < 0)
    return `Einkauf ${amount} – zahlt sich in den Entladephasen aus`;
  return amount;
}

/** Just the signed amount ("+3,96 €" / "−0,54 €"); null when noise/absent. */
export function phaseEurAmount(phase: PlanPhase): string | null {
  if (phase.eur == null || !Number.isFinite(phase.eur)) return null;
  const v = phase.eur;
  if (Math.abs(v) < PHASE_EUR_DEADBAND) return null;
  return v > 0 ? `+${eurAmount(v)}` : `−${eurAmount(-v)}`;
}

/** The calm explanation next to a charge phase's negative € (else null). */
export function phaseEurNote(phase: PlanPhase): string | null {
  if (phase.kind === 'charge' && phase.eur != null && phase.eur < -PHASE_EUR_DEADBAND)
    return 'Einkauf, der sich in den Entladephasen auszahlt';
  return null;
}

/** "11:15–17:45 Uhr" for the phase card / band tooltip. */
export function phaseRange(phase: PlanPhase): string {
  const hm = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${hm(phase.from)}–${hm(phase.to)} Uhr`;
}

// ---- Per-slot why ---------------------------------------------------------

/** de-DE "31,5 ct/kWh". */
function ctFmt(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

/** de-DE "31,5" - a bare number for use inside a price breakdown. */
function numFmt(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Spot price of a slot in ct/kWh, null-safe. */
function spotCt(slot: WhySlot): number | null {
  return slot.priceEurMwh == null ? null : Number(slot.priceEurMwh) / 10;
}

/**
 * What one imported kWh really costs in this slot (ct/kWh) - the number the
 * optimizer decided with. Null on runs that predate the field; a sentence
 * needing it then degrades to its number-free form. NEVER falls back to the
 * spot price: labeling spot as "Netzstrom" is exactly the bug this closes.
 */
function importCt(slot: WhySlot): number | null {
  return slot.importPriceCtKwh == null ? null : Number(slot.importPriceCtKwh);
}

/** Below this the breakdown's Aufschlag term is noise, not information. */
const PRICE_PART_DEADBAND_CT = 0.05;

/**
 * The parenthetical that makes the grid price VERIFIABLE - only ever from
 * what the run really carries:
 *   preisblatt/sammelaufschlag/default-flag → "(Börsenpreis 21,2 +
 *     Netzentgelte/Abgaben 11,3)" - the remainder is stated, never itemized
 *     beyond what the API tells us;
 *   fest → "(Ihr Festpreis-Tarif)" - a flat retail price has no spot share;
 *   spot → "(Börsenpreis)" - import IS spot here, so no invented components;
 *   unknown/missing source → no parenthetical at all.
 */
function importPriceDetail(slot: WhySlot, imp: number): string | null {
  const source = slot.importPriceSource ?? null;
  if (source === 'fest') return '(Ihr Festpreis-Tarif)';
  if (source === 'spot') return '(Börsenpreis)';
  if (source !== 'preisblatt' && source !== 'sammelaufschlag' && source !== 'default-flag') {
    return null;
  }
  const spot = spotCt(slot);
  if (spot == null) return null;
  const parts = imp - spot;
  if (parts <= PRICE_PART_DEADBAND_CT) return null;
  return `(Börsenpreis ${numFmt(spot)} + Netzentgelte/Abgaben ${numFmt(parts)})`;
}

/** "32,5 ct/kWh (Börsenpreis 21,2 + Netzentgelte/Abgaben 11,3)". */
function importPricePhrase(slot: WhySlot, imp: number): string {
  const detail = importPriceDetail(slot, imp);
  return detail ? `${ctFmt(imp)} ${detail}` : ctFmt(imp);
}

/** Ø spot price over the plan's priced slots (ct/kWh); null without prices. */
export function dayAvgPriceCt(slots: WhySlot[]): number | null {
  let sum = 0;
  let n = 0;
  for (const s of slots) {
    if (s.priceEurMwh == null) continue;
    sum += Number(s.priceEurMwh) / 10;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/**
 * ONE customer why-sentence for a slot, from its real persisted numbers
 * (the customer-grade sibling of the admin whyText). λ is always called
 * "Wert gespeicherter Energie"; missing numbers degrade the sentence to a
 * number-free form, never an invented value. Null when the slot carries no
 * known role (the why-layer is then absent anyway).
 */
export function slotWhy(slot: WhySlot, kind: PlanWordingKind): string | null {
  const role = slot.slotRole;
  if (role == null || !ROLE_SET.has(role)) return null;
  const price = spotCt(slot);
  const lam = slot.storedValueCtKwh == null ? null : Number(slot.storedValueCtKwh);
  const flags = slot.slotFlags ?? [];

  switch (role as SlotRole) {
    case 'pv_speichern':
      return lam != null
        ? `Überschüssiger Solarstrom wird gespeichert statt eingespeist – gespeicherte Energie ist später ≈ ${ctFmt(lam)} wert.`
        : 'Überschüssiger Solarstrom wird für die teuren Stunden gespeichert.';
    // The two grid-price roles name the BEZUGSPREIS, never the bare spot
    // (P0 Textwahrheit): the comparison against the stored-energy value is
    // only made when it actually holds - otherwise the number is stated
    // without a claim, so the sentence can never contradict itself.
    case 'guenstig_laden': {
      const imp = importCt(slot);
      if (imp == null || lam == null) return 'Lädt günstig aus dem Netz für die teuren Stunden.';
      const head = `Lädt günstig aus dem Netz: Netzstrom kostet Sie jetzt ${importPricePhrase(slot, imp)}`;
      return imp < lam
        ? `${head} – weniger als der Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${head}.`;
    }
    case 'eigenverbrauch': {
      const imp = importCt(slot);
      if (imp == null || lam == null) {
        return 'Deckt den Verbrauch aus dem Speicher und vermeidet teuren Netzbezug.';
      }
      const head = `Deckt den Verbrauch aus dem Speicher: Netzstrom kostet Sie jetzt ${importPricePhrase(slot, imp)}`;
      return imp > lam
        ? `${head} – mehr als der Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${head}.`;
    }
    case 'verkaufen': {
      const verb = kind === 'direktvermarktung' ? 'Verkauft zum Spitzenpreis' : 'Speist ein';
      return price != null && lam != null
        ? `${verb}: Börsenpreis ${ctFmt(price)} liegt über dem Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${verb}: der Preis liegt über dem Wert gespeicherter Energie.`;
    }
    case 'spitze_kappen':
      return 'Der Speicher hält den Netzbezug unter dem Spitzen-Ziel – jede Viertelstunde darüber würde die Leistungsspitze anheben.';
    case 'reserve_halten':
      if (flags.includes('reserve_backup'))
        return 'Der Speicher hält Ladung als Notstrom-Reserve zurück.';
      if (flags.includes('reserve_peak'))
        return 'Der Speicher hält Ladung als Reserve für die Lastspitzenkappung zurück.';
      return 'Der Speicher hält Ladung als Reserve zurück.';
    case 'warten':
      if (flags.includes('soc_max'))
        return 'Der Speicher ist voll und wartet auf die nächste Entladephase.';
      if (flags.includes('soc_floor'))
        return 'Der Speicher ist am Minimum und wartet auf PV-Überschuss oder günstigen Strom.';
      return 'Der Speicher wartet – kein Einsatz, der sich nach Verlusten und Verschleiß lohnt.';
    case 'abregeln':
      return price != null && price < 0
        ? `Einspeisen würde beim negativen Börsenpreis (${ctFmt(price)}) Geld kosten – die PV wird gedrosselt, statt draufzuzahlen.`
        : 'Einspeisen würde bei negativen Preisen Geld kosten – die PV wird gedrosselt, statt draufzuzahlen.';
  }
  return null;
}

/** One label/value row of the slot panel's context list. */
export interface ContextRow {
  label: string;
  value: string;
}

/**
 * The slot panel's context rows from what the customer contract carries:
 * Börsenpreis (with the plan's Ø for comparison), PV-Prognose, Ladestand,
 * Wert gespeicherter Energie. Rows whose value is absent are omitted -
 * "—"-discipline, never a fabricated number.
 */
export function slotContextRows(slot: WhySlot, slots: WhySlot[]): ContextRow[] {
  const rows: ContextRow[] = [];
  const price = spotCt(slot);
  if (price != null) {
    const avg = dayAvgPriceCt(slots);
    rows.push({
      label: 'Börsenpreis',
      value: avg != null ? `${ctFmt(price)} · Ø ${ctFmt(avg)}` : ctFmt(price),
    });
  }
  if (slot.pvKw != null) {
    rows.push({
      label: 'PV-Prognose',
      value: `${Number(slot.pvKw).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`,
    });
  }
  if (slot.socPct != null) {
    rows.push({
      label: 'Ladestand danach',
      value: `${Number(slot.socPct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`,
    });
  }
  if (slot.storedValueCtKwh != null) {
    rows.push({
      label: 'Wert gespeicherter Energie',
      value: `≈ ${ctFmt(Number(slot.storedValueCtKwh))}`,
    });
  }
  return rows;
}

// ---- Binding chips --------------------------------------------------------

/** Known binding codes → calm customer chips (unknown codes are ignored). */
const CHIP_LABELS: Record<string, string> = {
  soc_max: 'Speicher voll',
  soc_floor: 'Speicher am Minimum',
  reserve_backup: 'Notstrom-Reserve',
  reserve_peak: 'Reserve für Lastspitze',
  charge_cap: 'Maximale Leistung',
  discharge_cap: 'Maximale Leistung',
  solar_only: 'Nur Solarladen (EEG)',
  grid_limit_14a: 'Netzgrenze §14a',
  feed_in_cap: 'Einspeisegrenze',
  peak_defining: 'Bestimmt die Lastspitze',
  curtailing: 'Einspeisung gedrosselt',
};

/**
 * The slot's binding constraints as calm German chips. Unknown codes are
 * dropped (the vocabulary is additive), duplicates collapse (charge_cap +
 * discharge_cap → one "Maximale Leistung").
 */
export function bindingChips(flags: string[] | null | undefined): string[] {
  if (!flags) return [];
  const out: string[] = [];
  for (const f of flags) {
    const label = CHIP_LABELS[f];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ---- Plan-level honesty copy ---------------------------------------------

/** Forecast honesty footer (report §8) - shown only with the why-layer. */
export const FORECAST_FOOTNOTE =
  'Basiert auf Ihrer Verbrauchs- und PV-Prognose · aktualisiert alle 15 Minuten.';

/**
 * Fallback-build honesty (report §8): the plan could not fully schedule the
 * §14a grid limit - the device enforces it additionally on execution.
 */
export const FALLBACK_14A_NOTE =
  'Die Netzgrenze (§14a) konnte nicht vollständig eingeplant werden – Ihr Gerät begrenzt zusätzlich.';
