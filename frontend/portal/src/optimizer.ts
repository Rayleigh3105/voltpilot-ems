/**
 * Pure logic for the Portal-Admin optimizer diagnostics page (unit-tested;
 * OptimizerPage only renders it). Everything money-shaped keeps the backend's
 * hard null discipline: a value that is honestly not computable stays `null`
 * and the UI shows "—"/"n/a" - never a fabricated 0.
 *
 * The persisted `costEur`/`baselineCostEur` are the ASYMMETRIC real cashflows
 * the solver optimised against since the P1-P5 redesign (spot on import,
 * remuneration/Marktprämie on export - see the optimization AGENTS.md), so
 * their difference IS the real planned saving. `wearCostEur` is persisted
 * SEPARATELY (not folded into cost), so honest net = baseline - cost - wear.
 */
import type { DecisionLabel, OptimizerDiagnostics, OptimizerSlot } from './optimizerApi';

const DEADBAND_KW = 0.05;

/** German label for a decision label (falls back to the raw string). */
export function decisionLabelText(label: DecisionLabel | string): string {
  switch (label) {
    case 'solarladen':
      return 'Lädt Solarstrom';
    case 'netzladen':
      return 'Lädt aus dem Netz';
    case 'entladen':
      return 'Entlädt';
    case 'ruhe':
      return 'Hält';
    default:
      return label;
  }
}

/** Short verb used in badges/tabs. */
export function decisionShort(label: DecisionLabel | string): string {
  switch (label) {
    case 'solarladen':
      return 'Solarladen';
    case 'netzladen':
      return 'Netzladen';
    case 'entladen':
      return 'Entladen';
    case 'ruhe':
      return 'Ruhe';
    default:
      return label;
  }
}

/** de-DE ct/kWh, or "—" for null. Signed with a real minus sign. */
export function fmtCt(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Math.abs(v).toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${v < 0 ? '−' : ''}${n} ct/kWh`;
}

/** de-DE euro amount, or "—" for null. Signed with a real minus sign. */
export function fmtEur(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Math.abs(v).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? '−' : ''}${n} €`;
}

/** The aggregate objective breakdown of one run (all EUR; null = not computable). */
export interface ObjectiveTotals {
  /**
   * Real planned saving vs. a no-battery baseline = Σ(baselineCostEur −
   * costEur) over slots carrying both (asymmetric real cashflows). null when
   * no slot is priced.
   */
  grossSavingsEur: number | null;
  /** Σ wearCostEur; null when no slot persisted a wear cost (pre-P2 run). */
  wearEur: number | null;
  /** gross − wear; null when gross is null. Equals gross when wear is unknown. */
  netSavingsEur: number | null;
  /** True once at least one slot carried a persisted wear cost. */
  wearKnown: boolean;
  /**
   * The same plan valued at bare SPOT (context only): the plan's grid cashflow
   * minus the no-battery baseline's, both at solverPriceCtKwh. Shows how the
   * headline would read "zu Spot bewertet". null without spot+grid coverage.
   */
  spotSavingsEur: number | null;
  /** Slots with a computable real saving. */
  pricedSlotCount: number;
  /** Total plan slots. */
  slotCount: number;
}

/** Hours per slot (default 15 min). */
function slotHours(minutes: number): number {
  return (minutes > 0 ? minutes : 15) / 60;
}

export function objectiveTotals(diag: OptimizerDiagnostics): ObjectiveTotals {
  const h = slotHours(diag.slotMinutes);
  let gross = 0;
  let priced = 0;
  let wear = 0;
  let wearKnown = false;
  let spot = 0;
  let spotOk = false;

  for (const s of diag.slots) {
    if (s.costEur != null && s.baselineCostEur != null) {
      gross += Number(s.baselineCostEur) - Number(s.costEur);
      priced += 1;
    }
    if (s.wearCostEur != null) {
      wear += Number(s.wearCostEur);
      wearKnown = true;
    }
    // Spot context: plan grid cashflow vs. the no-battery baseline grid
    // (load − pv), both priced at the bare spot the solver saw.
    if (s.solverPriceCtKwh != null && s.gridKw != null && s.loadKw != null && s.pvKw != null) {
      const spotEurKwh = Number(s.solverPriceCtKwh) / 100;
      const planGridKwh = Number(s.gridKw) * h;
      const baseGridKwh = (Number(s.loadKw) - Number(s.pvKw)) * h;
      spot += (baseGridKwh - planGridKwh) * spotEurKwh;
      spotOk = true;
    }
  }

  const grossSavingsEur = priced > 0 ? gross : null;
  const wearEur = wearKnown ? wear : null;
  const netSavingsEur =
    grossSavingsEur == null ? null : grossSavingsEur - (wearEur ?? 0);

  return {
    grossSavingsEur,
    wearEur,
    netSavingsEur,
    wearKnown,
    spotSavingsEur: spotOk ? spot : null,
    pricedSlotCount: priced,
    slotCount: diag.slots.length,
  };
}

/** The one-line verdict headline of a run. */
export interface Verdict {
  /** The number to show (net saving if known, else gross). */
  eur: number | null;
  /** 'good' | 'bad' | 'neutral' drive the banner accent. */
  tone: 'good' | 'bad' | 'neutral';
  /** Plain-German headline sentence. */
  text: string;
}

/** Below this daily saving we call the plan "neutral" (flat-curve idle days). */
const VERDICT_NEUTRAL_EUR = 0.02;

export function verdict(diag: OptimizerDiagnostics, siteName: string): Verdict {
  const totals = objectiveTotals(diag);
  const eur = totals.netSavingsEur;
  if (eur == null) {
    return {
      eur: null,
      tone: 'neutral',
      text: `Für ${siteName} liegt noch kein bewertbarer Plan vor - sobald Preise und Prognosen für den Horizont vorliegen, erscheint hier die geplante Ersparnis.`,
    };
  }
  if (eur > VERDICT_NEUTRAL_EUR) {
    return {
      eur,
      tone: 'good',
      text: `${siteName} spart mit diesem Plan rund ${fmtEur(eur)}/Tag gegenüber einem Betrieb ohne Speicher${totals.wearKnown ? ' (nach Verschleiß)' : ''}.`,
    };
  }
  if (eur < -VERDICT_NEUTRAL_EUR) {
    return {
      eur,
      tone: 'bad',
      text: `Dieser Plan kostet ${siteName} rund ${fmtEur(Math.abs(eur))}/Tag mehr als ein Betrieb ohne Speicher${totals.wearKnown ? ' (nach Verschleiß)' : ''} - die Konfiguration unten prüfen.`,
    };
  }
  return {
    eur,
    tone: 'neutral',
    text: `${siteName} fährt den Speicher heute kaum - bei flachem Preisverlauf lohnt sich keine nennenswerte Verschiebung (${fmtEur(eur)}/Tag).`,
  };
}

/** One row of the explain-a-slot breakdown. */
export interface WaterfallRow {
  key: string;
  label: string;
  ctKwh: number | null;
  /** 'gain' (green, what the decision earns) | 'cost' (red) | 'ref' (neutral). */
  kind: 'gain' | 'cost' | 'ref';
  /** True for the forward-heuristic stored-energy value (label it honestly). */
  approximate?: boolean;
}

/**
 * The ct/kWh components behind one slot's decision, ordered for the waterfall.
 * Rows are the fields the backend computed; a null-valued field is KEPT (so the
 * UI shows "—" and the reader sees it was considered but not computable), except
 * the two that only make sense for a charge decision (stored-energy value) which
 * are dropped entirely when absent. `whyText` (authoritative German) is rendered
 * alongside - this only supplies the numeric backing.
 */
export function slotWaterfall(slot: OptimizerSlot): WaterfallRow[] {
  const rows: WaterfallRow[] = [
    { key: 'spot', label: 'Spot-Preis (Solver)', ctKwh: slot.solverPriceCtKwh, kind: 'ref' },
    { key: 'import', label: 'Bezugspreis (real)', ctKwh: slot.importPriceCtKwh, kind: 'cost' },
    { key: 'export', label: 'Einspeisewert (real)', ctKwh: slot.exportValueCtKwh, kind: 'gain' },
  ];
  // Value of stored energy only frames a charge/hold decision; drop when null.
  if (slot.valueOfStoredEnergyCtKwh != null) {
    rows.push({
      key: 'stored',
      label: 'Wert gespeicherter Energie',
      ctKwh: slot.valueOfStoredEnergyCtKwh,
      kind: 'gain',
      approximate: true,
    });
  }
  rows.push({ key: 'wear', label: 'Verschleiß', ctKwh: slot.wearCostCtKwh, kind: 'cost' });
  return rows;
}

/** German short daytime label "Do. 14:15 Uhr" for a slot's ISO time. */
export function slotTimeLabel(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('de-DE', { weekday: 'short' });
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time} Uhr`;
}

/** Full run-label "Do. 12.06., 13:00 Uhr" for the run picker. */
export function runLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Indices worth quick-picking in the explain panel: first discharge / charge / grid-import. */
export interface NotableSlots {
  firstDischarge: number | null;
  firstCharge: number | null;
  firstGridImport: number | null;
}

export function notableSlots(slots: OptimizerSlot[]): NotableSlots {
  let firstDischarge: number | null = null;
  let firstCharge: number | null = null;
  let firstGridImport: number | null = null;
  slots.forEach((s, i) => {
    const b = s.batteryKw == null ? 0 : Number(s.batteryKw);
    const g = s.gridKw == null ? 0 : Number(s.gridKw);
    if (firstDischarge == null && b < -DEADBAND_KW) firstDischarge = i;
    if (firstCharge == null && b > DEADBAND_KW) firstCharge = i;
    if (firstGridImport == null && g > DEADBAND_KW && b <= DEADBAND_KW) firstGridImport = i;
  });
  return { firstDischarge, firstCharge, firstGridImport };
}

/** The default slot to explain: first discharge, else first charge, else the mid slot. */
export function defaultSlotIndex(slots: OptimizerSlot[]): number {
  if (slots.length === 0) return -1;
  const n = notableSlots(slots);
  return n.firstDischarge ?? n.firstCharge ?? Math.floor(slots.length / 2);
}

/** Mode badge text/tone from the grid-charging switch. */
export function modeBadge(netzladenErlaubt: boolean): { text: string; tone: 'ok' | 'off' } {
  return netzladenErlaubt
    ? { text: 'Merchant (Netzladen erlaubt)', tone: 'ok' }
    : { text: 'EEG · Nur Solarladen', tone: 'off' };
}

// ---- config panel: form <-> request payload -----------------------------------

/** Editable override fields as strings (form state). "" = cleared to default. */
export interface ConfigFormState {
  wearCostCtPerKwh: string;
  socMinPct: string;
  socMaxPct: string;
  backupReserveSocPct: string;
}

/** Seed the form from the current overrides (null override -> empty field). */
export function configFormFromOverrides(
  o: { wearCostCtPerKwh: number | null; socMinPct: number | null; socMaxPct: number | null; backupReserveSocPct: number | null },
): ConfigFormState {
  const s = (v: number | null) => (v == null ? '' : String(v));
  return {
    wearCostCtPerKwh: s(o.wearCostCtPerKwh),
    socMinPct: s(o.socMinPct),
    socMaxPct: s(o.socMaxPct),
    backupReserveSocPct: s(o.backupReserveSocPct),
  };
}

/** Parse a de/en decimal field; "" -> null (clear override), invalid -> undefined. */
export function parseField(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export interface ConfigValidation {
  ok: boolean;
  /** German error, when not ok. */
  error?: string;
  /** The request body, when ok. */
  body?: {
    wearCostCtPerKwh: number | null;
    socMinPct: number | null;
    socMaxPct: number | null;
    backupReserveSocPct: number | null;
  };
}

/**
 * Validate + build the PUT body from the form. Mirrors the server rules so the
 * user gets an inline German error instead of a round-trip 400: every field
 * >= 0 (SoC/reserve <= 100), and the EFFECTIVE band (override ?? platform
 * default per side) must stay a real window.
 */
export function buildConfigRequest(
  form: ConfigFormState,
  defaults: { socMinPct: number; socMaxPct: number },
): ConfigValidation {
  const wear = parseField(form.wearCostCtPerKwh);
  const min = parseField(form.socMinPct);
  const max = parseField(form.socMaxPct);
  const reserve = parseField(form.backupReserveSocPct);

  if (wear === undefined) return { ok: false, error: 'Verschleißkosten: bitte eine Zahl eingeben.' };
  if (min === undefined) return { ok: false, error: 'SoC-Untergrenze: bitte eine Zahl eingeben.' };
  if (max === undefined) return { ok: false, error: 'SoC-Obergrenze: bitte eine Zahl eingeben.' };
  if (reserve === undefined) return { ok: false, error: 'Backup-Reserve: bitte eine Zahl eingeben.' };

  if (wear != null && wear < 0) return { ok: false, error: 'Verschleißkosten müssen ≥ 0 sein.' };
  for (const [v, name] of [
    [min, 'SoC-Untergrenze'],
    [max, 'SoC-Obergrenze'],
    [reserve, 'Backup-Reserve'],
  ] as const) {
    if (v != null && (v < 0 || v > 100)) {
      return { ok: false, error: `${name} muss zwischen 0 und 100 % liegen.` };
    }
  }

  const effMin = min ?? defaults.socMinPct;
  const effMax = max ?? defaults.socMaxPct;
  if (effMin >= effMax) {
    return {
      ok: false,
      error: `SoC-Band ungültig: die Untergrenze (${effMin} %) muss unter der Obergrenze (${effMax} %) liegen.`,
    };
  }

  return {
    ok: true,
    body: {
      wearCostCtPerKwh: wear,
      socMinPct: min,
      socMaxPct: max,
      backupReserveSocPct: reserve,
    },
  };
}
