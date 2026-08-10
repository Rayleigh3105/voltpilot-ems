/**
 * The pure fulfilment-ledger + manual-override derivations for the consumer
 * surfaces (docs/verbrauchssteuerung.md §9.4/§14.13/§17, Inkrement 5). THE house
 * rule: no surface greps German - the machine-readable state/reason/confirmation
 * words map through THESE tested tables, and a word we do not know produces NO
 * claimed text. Every value is honest: energy the edge only assumed reads
 * "angenommen", never "gemessen"; a period past its deadline reads "Nicht
 * erreicht"; "Frist gefährdet" is the §17 warn.
 */

export interface FulfilmentTask {
  requirementId: string;
  periodStart: string;
  deadline: string;
  requiredRuntimeSeconds?: number | null;
  actualRuntimeSeconds?: number | null;
  requiredEnergyKwh?: number | null;
  actualEnergyKwh?: number | null;
  energyConfirmation?: string | null;
  state: string;
  atRisk: boolean;
  reasonCode?: string | null;
}

export interface ConsumerFulfilment {
  tasks: FulfilmentTask[];
}

export interface ManualOverride {
  entityId: string;
  kind: string; // start | stop
  targetCommand: string;
  targetValue?: number | null;
  endsAt: string;
}

/** The §9.4 ledger states → customer wording. */
export const TASK_STATE_TEXT: Record<string, string> = {
  pending: 'Geplant',
  running: 'Läuft',
  fulfilled: 'Erfüllt',
  missed: 'Nicht erreicht',
  blocked: 'Blockiert',
};

/** D3 confirmation level → the honesty label of the energy figure. */
export const ENERGY_CONFIRMATION_TEXT: Record<string, string> = {
  measured: 'gemessen',
  integrated: 'aus der Leistung berechnet',
  assumed: 'angenommen (Nennleistung × Zeit)',
};

export const AT_RISK_TEXT = 'Frist gefährdet';

export interface TaskLine {
  /** State sentence, '' when the word is unknown (claims nothing). */
  text: string;
  /** "45 / 60 min" or "3,2 / 8,0 kWh" or '' when no goal. */
  progress: string;
  /** The energy honesty label, '' when no energy tracked. */
  confirmation: string;
  /** True exactly when the §17 warn applies. */
  atRisk: boolean;
  tone: 'ok' | 'warn' | 'off';
}

function fmtMinutes(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  return `${Math.round(seconds / 60)}`;
}

function fmtKwh(kwh: number | null | undefined): string {
  if (kwh == null) return '—';
  // de-DE decimal comma, one place
  return kwh.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Derive the display line of ONE requirement instance. */
export function taskLine(task: FulfilmentTask): TaskLine {
  const text = TASK_STATE_TEXT[task.state] ?? '';
  let progress = '';
  if (task.requiredRuntimeSeconds != null) {
    progress = `${fmtMinutes(task.actualRuntimeSeconds ?? 0)} / ${fmtMinutes(
      task.requiredRuntimeSeconds,
    )} min`;
  } else if (task.requiredEnergyKwh != null) {
    progress = `${fmtKwh(task.actualEnergyKwh)} / ${fmtKwh(task.requiredEnergyKwh)} kWh`;
  }
  const confirmation = task.energyConfirmation
    ? (ENERGY_CONFIRMATION_TEXT[task.energyConfirmation] ?? '')
    : '';
  let tone: TaskLine['tone'] = 'off';
  if (task.state === 'fulfilled' || task.state === 'running') tone = 'ok';
  if (task.state === 'missed' || task.state === 'blocked' || task.atRisk) tone = 'warn';
  return { text, progress, confirmation, atRisk: task.atRisk, tone };
}

export interface FulfilmentSummary {
  total: number;
  fulfilled: number;
  missed: number;
  running: number;
  atRisk: number;
  /** The one calm today-line, '' when there are no recurring tasks. */
  headline: string;
}

/** The "Heute: erfüllte/offene Aufgaben" summary (§14.13). */
export function fulfilmentSummary(f: ConsumerFulfilment | null | undefined): FulfilmentSummary {
  const tasks = f?.tasks ?? [];
  const fulfilled = tasks.filter((t) => t.state === 'fulfilled').length;
  const missed = tasks.filter((t) => t.state === 'missed').length;
  const running = tasks.filter((t) => t.state === 'running').length;
  const atRisk = tasks.filter((t) => t.atRisk).length;
  let headline = '';
  if (tasks.length > 0) {
    if (missed > 0) headline = `${missed} Aufgabe${missed === 1 ? '' : 'n'} nicht erreicht`;
    else if (atRisk > 0) headline = `${atRisk} Frist gefährdet`;
    else if (fulfilled === tasks.length) headline = 'Alle Aufgaben erfüllt';
    else headline = `${fulfilled} von ${tasks.length} Aufgaben erfüllt`;
  }
  return { total: tasks.length, fulfilled, missed, running, atRisk, headline };
}

// --- manual override (§11 + §14.13 Sofortaktionen) ------------------------

/** The active-override banner line, or null when no unexpired override. */
export function overrideLine(
  override: ManualOverride | null | undefined,
  now: Date = new Date(),
): { text: string; tone: 'warn' } | null {
  if (!override) return null;
  const ends = new Date(override.endsAt);
  if (Number.isNaN(ends.getTime()) || ends.getTime() <= now.getTime()) return null;
  const until = ends.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const what = override.kind === 'stop' ? 'gestoppt' : 'gestartet';
  return { text: `Manueller Eingriff: ${what} bis ${until} Uhr`, tone: 'warn' };
}

export type SofortAktion = 'start' | 'stop' | 'resume';

/**
 * Which Sofortaktionen the status head offers for a CONNECTED, controllable
 * consumer (§14.13). A running override adds "Automatik fortsetzen" (resume);
 * otherwise start + stop. An unconnected consumer gets none (the head then
 * shows the honest connection state instead).
 */
export function sofortAktionen(
  opts: { connected: boolean; hasOverride: boolean },
): SofortAktion[] {
  if (!opts.connected) return [];
  if (opts.hasOverride) return ['resume'];
  return ['start', 'stop'];
}

export const SOFORT_LABEL: Record<SofortAktion, string> = {
  start: 'Jetzt starten',
  stop: 'Jetzt stoppen',
  resume: 'Automatik fortsetzen',
};

/**
 * The ConfirmDialog consequence list for a manual START (§14.13: it shows the
 * effective power + the grid-import hint before acting). The `effectivePowerKw`
 * is the wirksame Leistung; guards may clamp it further on the device.
 */
export function startConsequences(effectivePowerKw: number | null | undefined): string[] {
  const power = effectivePowerKw != null
    ? `Der Verbraucher läuft mit bis zu ${fmtKwh(effectivePowerKw)} kW.`
    : 'Der Verbraucher läuft mit seiner wirksamen Leistung.';
  return [
    power,
    'Dabei kann Strom aus dem Netz bezogen werden.',
    'Der Eingriff endet automatisch zur gewählten Zeit - Ihre gespeicherte Regel bleibt unverändert.',
  ];
}

export const STOP_CONSEQUENCES: string[] = [
  'Der Verbraucher wird ausgeschaltet.',
  'Der Eingriff endet automatisch zur gewählten Zeit - Ihre gespeicherte Regel bleibt unverändert.',
];

export const RESUME_CONSEQUENCES: string[] = [
  'Der manuelle Eingriff endet sofort.',
  'Die Automatik (Fahrplan und Regeln) übernimmt wieder.',
];

// --- cockpit consumer strip (§14.10) --------------------------------------

import { consumerStatusLine, type ConsumerRuntimeStatus } from './status';

export interface StripConsumer {
  id: string;
  name: string;
  ratedPowerKw: number;
  connection: string; // connected | disconnected
}

export interface StripRow {
  name: string;
  /** Measured power now, or null (never a fabricated 0). */
  actualKw: number | null;
  ratedKw: number;
  text: string;
  reason: string;
  tone: 'ok' | 'warn' | 'off';
}

export interface ConsumerStripView {
  /** Σ of the measured powers, or null when nothing is measured. */
  sumKw: number | null;
  rows: StripRow[];
  running: number;
  ready: number;
  disturbed: number;
}

const DISTURBED = new Set(['offline', 'clamped', 'missed']);

/**
 * The cockpit consumer strip (§14.10): one row per consumer with its measured
 * power vs. Nennleistung and its live state. Returns NULL when there are no
 * consumers - the cockpit is then byte-identical to before. Without a source a
 * consumer still gets a row (its state), but its measured power stays null
 * ("—"), never a fabricated 0.
 */
export function consumerStrip(
  consumers: StripConsumer[] | null | undefined,
  statuses: ConsumerRuntimeStatus[] | null | undefined,
): ConsumerStripView | null {
  if (!consumers || consumers.length === 0) return null;
  const byId = new Map((statuses ?? []).map((s) => [s.entityId, s]));
  const anyReported = (statuses ?? []).length > 0;
  const rows: StripRow[] = [];
  let sum: number | null = null;
  let running = 0;
  let ready = 0;
  let disturbed = 0;
  for (const c of consumers) {
    const st = byId.get(c.id);
    const line = anyReported ? consumerStatusLine(st) : consumerStatusLine(undefined);
    const actualKw = st?.actualKw ?? null;
    if (actualKw != null) sum = (sum ?? 0) + actualKw;
    const state = st?.state;
    if (state === 'running_forced' || state === 'running_optimized') running++;
    else if (state === 'ready') ready++;
    if (state && (DISTURBED.has(state) || st?.confirmed === false)) disturbed++;
    rows.push({
      name: c.name,
      actualKw,
      ratedKw: c.ratedPowerKw,
      text: line.text,
      reason: line.reason,
      tone: line.tone,
    });
  }
  return { sumKw: sum, rows, running, ready, disturbed };
}

/** The default duration options for a manual override (§14.13 Endzeit PFLICHT). */
export const OVERRIDE_DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 Minuten' },
  { minutes: 60, label: '1 Stunde' },
  { minutes: 120, label: '2 Stunden' },
  { minutes: 240, label: '4 Stunden' },
];
