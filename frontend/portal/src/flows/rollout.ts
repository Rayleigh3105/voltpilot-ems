/**
 * Portal v3 M5 · Part B - the guided "Ausrollen" step machine (pure,
 * unit-tested). ONE button orchestrates the THREE EXISTING calls
 * (…/validate, …/simulate + poll, …/activate); this module owns the German
 * labels, the per-step states and - load-bearing since the v3 release turns
 * flow activation ON in production - the customer-grade German for every
 * refusal a customer can now actually hit.
 *
 * It performs nothing: the page runs the calls and feeds the outcome back in.
 */

export type RolloutPhase = 'idle' | 'pruefen' | 'simulieren' | 'ausrollen' | 'fertig' | 'fehler';
export type StepState = 'wartet' | 'laeuft' | 'fertig' | 'fehler' | 'uebersprungen';

export interface RolloutStep {
  key: 'pruefen' | 'simulieren' | 'ausrollen';
  label: string;
  state: StepState;
}

export interface RolloutState {
  phase: RolloutPhase;
  /** The failing step, when the run stopped. */
  failedAt?: 'pruefen' | 'simulieren' | 'ausrollen';
  /** The machine-readable backend reason, when one came back. */
  reason?: string | null;
  /** A German message the server already produced (it wins over ours). */
  message?: string | null;
}

const LABELS: Record<RolloutStep['key'], string> = {
  pruefen: 'Prüfen',
  simulieren: 'Simulieren',
  ausrollen: 'Ausrollen',
};

const ORDER: Array<RolloutStep['key']> = ['pruefen', 'simulieren', 'ausrollen'];

/**
 * Customer-grade German for every activation refusal. Until the v3 release
 * these strings were operator-only (no production site could activate a flow);
 * from the release on a customer reads them, so none may name an internal
 * component (compiler / sidecar / gate / flag).
 */
export const ROLLOUT_REASONS: Record<string, string> = {
  compiler_unavailable:
    'Der Rollout ist gerade nicht möglich - bitte versuchen Sie es in einigen Minuten erneut. '
    + 'Ihre Regel bleibt unverändert gespeichert.',
  compiler_rejected:
    'Diese Regel lässt sich so nicht auf Ihr Gerät übertragen. '
    + 'Bitte prüfen Sie die markierten Bausteine und versuchen Sie es erneut.',
  gated_node_not_enabled:
    'Für diese Regel muss VoltPilot zuerst das passende Modus-Profil für Ihre Anlage '
    + 'freischalten. Schalten Sie das Profil unter „Modus-Profile" ein oder sprechen Sie uns an.',
  peakshaving_not_configured:
    'Für die Lastspitzenkappung fehlen noch Ihre Vertragsdaten (Leistungspreis). '
    + 'VoltPilot hinterlegt sie für Sie - sprechen Sie uns kurz an.',
  activation_disabled:
    'Regeln können auf dieser Anlage derzeit nicht scharf geschaltet werden. '
    + 'Ihre Regel bleibt gespeichert - VoltPilot meldet sich dazu bei Ihnen.',
  already_active: 'Diese Regel läuft bereits auf Ihrem Gerät.',
};

/** The customer sentence for the happy path - see {@link rolloutMessage}. */
export const ROLLOUT_DONE_MESSAGE = 'Ihre Regel läuft jetzt auf dem Gerät.';

/**
 * The honest German sentence for one outcome. A server message wins for every
 * FAILURE (it is the precise cause, and the caller has already mapped it), but
 * NOT for the happy path: there the server says "Flow aktiviert (Version 1)."
 * - internal vocabulary and a version number the customer did not ask for
 * (audit E-9), so the customer string wins.
 */
export function rolloutMessage(state: RolloutState): string | null {
  if (state.phase === 'fertig') {
    return ROLLOUT_DONE_MESSAGE;
  }
  if (state.message && state.message.trim()) return state.message.trim();
  if (state.phase !== 'fehler') return null;
  const known = state.reason ? ROLLOUT_REASONS[state.reason] : undefined;
  if (known) return known;
  if (state.failedAt === 'pruefen') {
    return 'Die Regel ist noch nicht vollständig - bitte beheben Sie die markierten Stellen.';
  }
  if (state.failedAt === 'simulieren') {
    return 'Der Probelauf konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.';
  }
  return 'Der Rollout ist fehlgeschlagen. Ihre bisher laufende Regel bleibt unverändert.';
}

/** The three steps with their current state - the progress UI reads this. */
export function rolloutSteps(state: RolloutState): RolloutStep[] {
  const phaseIndex = ORDER.indexOf(state.phase as RolloutStep['key']);
  const failedIndex = state.failedAt ? ORDER.indexOf(state.failedAt) : -1;
  return ORDER.map((key, i) => {
    let stepState: StepState = 'wartet';
    if (state.phase === 'fertig') {
      stepState = 'fertig';
    } else if (state.phase === 'fehler') {
      if (i < failedIndex) stepState = 'fertig';
      else if (i === failedIndex) stepState = 'fehler';
      else stepState = 'uebersprungen';
    } else if (phaseIndex >= 0) {
      if (i < phaseIndex) stepState = 'fertig';
      else if (i === phaseIndex) stepState = 'laeuft';
    }
    return { key, label: LABELS[key], state: stepState };
  });
}

/** True while the guided rollout is running (the button stays disabled). */
export function rolloutBusy(state: RolloutState): boolean {
  return state.phase === 'pruefen' || state.phase === 'simulieren' || state.phase === 'ausrollen';
}

/**
 * "Läuft auf dem Gerät · v4" / "noch nicht ausgerollt" - the deployed-version
 * badge. `ack` is the device's own acknowledgement from the heartbeat.
 */
export interface DeployedBadge {
  label: string;
  tone: 'ok' | 'warn' | 'off';
  detail: string | null;
}

export function deployedBadge(input: {
  activeVersion: number | null;
  ackVersion?: number | null;
  ackState?: 'active' | 'error' | 'unsupported' | null;
  ackDetail?: string | null;
}): DeployedBadge {
  if (input.activeVersion == null) {
    return { label: 'Noch nicht ausgerollt', tone: 'off', detail: null };
  }
  const version = `v${input.activeVersion}`;
  if (input.ackState === 'error') {
    return {
      label: `Gerät meldet ein Problem · ${version}`,
      tone: 'warn',
      detail: input.ackDetail ?? null,
    };
  }
  if (input.ackState === 'unsupported') {
    return {
      label: `Gerät zu alt für diese Regel · ${version}`,
      tone: 'warn',
      detail: input.ackDetail ?? null,
    };
  }
  if (input.ackState === 'active' && input.ackVersion === input.activeVersion) {
    return { label: `Läuft auf dem Gerät · ${version}`, tone: 'ok', detail: null };
  }
  // Activated, but the device has not (yet) confirmed this version - say so
  // instead of claiming a green state the device never reported.
  return {
    label: `Ausgerollt · ${version}`,
    tone: 'off',
    detail: 'Das Gerät hat den Empfang noch nicht bestätigt.',
  };
}

/**
 * The fork banner: editing the version that is running creates a NEW draft
 * server-side, so the customer must see that the device keeps running the old
 * one. Null when nothing is running.
 */
export function forkBanner(input: {
  activeVersion: number | null;
  editingVersion: number;
  dirty: boolean;
}): string | null {
  if (input.activeVersion == null) return null;
  if (input.editingVersion !== input.activeVersion && !input.dirty) {
    return `Sie bearbeiten eine Kopie - das Gerät läuft weiter mit v${input.activeVersion}.`;
  }
  if (input.dirty) {
    return `Sie bearbeiten eine Kopie - das Gerät läuft weiter mit v${input.activeVersion}.`;
  }
  return null;
}
