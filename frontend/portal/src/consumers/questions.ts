/**
 * The context-dependent question tree of the consumer rule builder
 * (docs/verbrauchssteuerung.md §14.4). PURE + unit-tested: given the plant
 * context and the current draft it returns exactly the relevant next questions,
 * in order; the React components render only the result and never spread the
 * visibility rules across forms. "Schritt X von Y" reads Y off this list.
 *
 * The rules encode §14.4 verbatim, incl. the review decisions: D6 (Energie-
 * präferenz is a REQUIRED question at storage sites) and D3 (a kWh goal is
 * offered ONLY with an energy/power measurement channel; without it the honest
 * "Ohne Messung kann VoltPilot die Erfüllung nicht nachweisen." note appears).
 * Every capability stays reachable via a standard question OR "Weitere
 * Einstellungen" (section: 'more') - the Reachability guard test pins that.
 */
import type { ControlKind, Enforcement, GridEnergyPolicy, Operator, RecurrenceDays } from './types';
import { findSignal } from './signals';

export type Intent = 'react' | 'schedule' | 'deadline' | 'cheap';

export interface ConsumerContext {
  controlKind: ControlKind;
  hasStorage: boolean;
  /** An energy/power measurement channel exists (D3 - enables kWh goals). */
  hasMeasurementChannel: boolean;
}

export interface ConditionDraft {
  signal: string;
  operator: Operator;
  value: number | boolean;
  resetValue?: number;
  maxAgeS?: number;
}

export interface ConsumerDraft {
  intent: Intent | null;
  conditions: ConditionDraft[];
  combinator: 'and' | 'or';
  recurrence: { days: RecurrenceDays; from: string; to: string };
  demandMode: 'runtime' | 'energy';
  runtimeMinutes: number | null;
  energyKwh: number | null;
  contiguous: boolean;
  target: { kind: 'on_off' | 'percent' | 'kw' | 'mode'; value: boolean | number | string };
  /** Verbindlichkeit the user chose for reactive/fixed_window/opportunistic. */
  enforcement: Extract<Enforcement, 'must_run' | 'opportunistic'>;
  gridEnergyPolicy: GridEnergyPolicy;
  storageRelation: 'consumer_first' | 'storage_first';
  allowStorageDischarge: boolean;
}

export type QuestionKind =
  | 'conditions'
  | 'combinator'
  | 'price-basis'
  | 'target'
  | 'recurrence'
  | 'runtime'
  | 'contiguous'
  | 'energy'
  | 'enforcement'
  | 'grid-policy'
  | 'grid-allowed-note'
  | 'no-measurement-note'
  | 'storage-relation'
  | 'storage-discharge'
  | 'hysteresis';

export interface Question {
  id: string;
  kind: QuestionKind;
  label: string;
  /** Honest fact/hint copy for note-kind questions. */
  note?: string;
  section: 'standard' | 'more';
}

/** The effective enforcement for an intent (deadline/cheap are fixed). */
export function effectiveEnforcement(draft: ConsumerDraft): Enforcement {
  switch (draft.intent) {
    case 'deadline': return 'required_by_deadline';
    case 'cheap': return 'opportunistic';
    default: return draft.enforcement;
  }
}

function anyLocalSignal(conditions: ConditionDraft[]): boolean {
  return conditions.some((c) => findSignal(c.signal)?.signalClass === 'local');
}

function anyPriceSignal(conditions: ConditionDraft[]): boolean {
  return conditions.some((c) => c.signal.startsWith('market.'));
}

/**
 * The relevant questions for the current context + draft, in order. The intent
 * itself is chosen via the Absichtskarten (before this) - `draft.intent` gates
 * everything here; a null intent yields no questions yet.
 */
export function consumerQuestions(ctx: ConsumerContext, draft: ConsumerDraft): Question[] {
  const q: Question[] = [];
  if (!draft.intent) {
    return q;
  }
  const conditionIntent = draft.intent === 'react' || draft.intent === 'cheap';

  if (conditionIntent) {
    q.push({ id: 'conditions', kind: 'conditions', section: 'standard',
      label: 'Wann soll der Verbraucher reagieren?' });
    // The UND/ODER choice appears ONLY from the second condition (§14.4).
    if (draft.conditions.length >= 2) {
      q.push({ id: 'combinator', kind: 'combinator', section: 'standard',
        label: 'Wie sollen die Bedingungen zusammenwirken?' });
    }
    if (anyPriceSignal(draft.conditions)) {
      q.push({ id: 'price-basis', kind: 'price-basis', section: 'standard',
        label: 'Welchen Preis meinen Sie?' });
    }
    if (anyLocalSignal(draft.conditions)) {
      q.push({ id: 'hysteresis', kind: 'hysteresis', section: 'more',
        label: 'Ab-/Rückschaltabstand (Hysterese)' });
    }
  }

  if (draft.intent === 'schedule') {
    q.push({ id: 'recurrence', kind: 'recurrence', section: 'standard',
      label: 'Zu welchen Zeiten soll er laufen?' });
  }

  if (draft.intent === 'deadline') {
    q.push({ id: 'recurrence', kind: 'recurrence', section: 'standard',
      label: 'Bis wann muss die Aufgabe erledigt sein?' });
    if (draft.demandMode === 'runtime') {
      q.push({ id: 'runtime', kind: 'runtime', section: 'standard',
        label: 'Wie lange muss er laufen?' });
      q.push({ id: 'contiguous', kind: 'contiguous', section: 'standard',
        label: 'Am Stück oder aufteilbar?' });
    } else if (ctx.hasMeasurementChannel) {
      q.push({ id: 'energy', kind: 'energy', section: 'standard',
        label: 'Welche Energiemenge wird benötigt?' });
    } else {
      // D3: no measurement channel -> no kWh goal, the honest note instead.
      q.push({ id: 'no-measurement-note', kind: 'no-measurement-note', section: 'standard',
        label: 'Energiemenge',
        note: 'Ohne Messung kann VoltPilot die Erfüllung nicht nachweisen.' });
    }
  }

  // The target ("Ziel") - shape depends on the control kind (§14.4).
  q.push({ id: 'target', kind: 'target', section: 'standard', label: targetLabel(ctx.controlKind) });

  // Verbindlichkeit - only where the user actually chooses it.
  if (draft.intent === 'react' || draft.intent === 'schedule') {
    q.push({ id: 'enforcement', kind: 'enforcement', section: 'standard',
      label: 'Wie verbindlich ist das?' });
  }

  // The energy question follows the Verbindlichkeit (§5).
  const enforcement = effectiveEnforcement(draft);
  if (enforcement === 'must_run') {
    q.push({ id: 'grid-allowed-note', kind: 'grid-allowed-note', section: 'standard',
      label: 'Netzstrom',
      note: 'Netzstrom ist für diesen Pflichtlauf erlaubt.' });
  } else {
    q.push({ id: 'grid-policy', kind: 'grid-policy', section: 'standard',
      label: 'Darf Netzstrom verwendet werden?' });
  }

  // Storage questions ONLY at a site with a storage (D6: required there).
  if (ctx.hasStorage) {
    q.push({ id: 'storage-relation', kind: 'storage-relation', section: 'standard',
      label: 'Was hat bei knapper Leistung Vorrang?' });
    q.push({ id: 'storage-discharge', kind: 'storage-discharge', section: 'standard',
      label: 'Darf der Speicher diesen Verbraucher versorgen?' });
  }

  return q;
}

function targetLabel(controlKind: ControlKind): string {
  switch (controlKind) {
    case 'stepped': return 'Auf welche Stufe?';
    case 'continuous': return 'Mit welcher Leistung?';
    default: return 'Ein oder aus?';
  }
}

/** "Schritt X von Y": the number of standard questions (the visible sequence). */
export function standardStepCount(ctx: ConsumerContext, draft: ConsumerDraft): number {
  return consumerQuestions(ctx, draft).filter((x) => x.section === 'standard').length;
}

/** The teaser for the collapsed "Weitere Einstellungen (N)" area (§14.6). */
export function moreSettings(ctx: ConsumerContext, draft: ConsumerDraft): Question[] {
  return consumerQuestions(ctx, draft).filter((x) => x.section === 'more');
}
