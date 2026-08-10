/**
 * Activation-state wording for the steuerbare-Verbraucher surface (Inkrement 4,
 * docs/verbrauchssteuerung.md §16). PURE + unit-tested: the row badge, the
 * review-page conflict line and the button labels derive here, so the list and
 * the rule builder can never disagree about what "aktiv" means.
 *
 * Honesty rules baked in: an older backend without `policyActivationEnabled`
 * reads as NOT enabled (the surface stays byte-identical to Increment 1), and
 * the V-5 conflict is named BEFORE the activate click - the server would refuse
 * with the same truth, but a refusal must never be a surprise.
 */
import type { EntityStrategy } from '../api';
import type { Consumer } from './types';

export const NOT_ACTIVATED_TEXT = 'Steuerung noch nicht aktiviert';

export interface ActivationBadge {
  text: string;
  tone: 'ok' | 'warn' | 'off';
}

/** The one row badge: what the CONTROL of this consumer currently is. */
export function activationBadge(
  c: Pick<Consumer, 'controlActivation'>,
): ActivationBadge {
  switch (c.controlActivation) {
    case 'active':
      return { text: 'Steuerung aktiv', tone: 'ok' };
    case 'paused':
      return { text: 'Pausiert – das Gerät folgt seinem Failsafe', tone: 'warn' };
    default:
      return { text: NOT_ACTIVATED_TEXT, tone: 'off' };
  }
}

/**
 * The honest V-5 conflict line for the review page: an ACTIVE flow already
 * claims this consumer while the consumer's own rule is NOT the active one.
 * (The server guarantees at most one active claim per entity, and while THIS
 * consumer's policy is active that claim is its own generated rule - so a
 * claim on a non-active consumer is always a foreign automation.)
 */
export function conflictNote(
  claims: EntityStrategy[] | undefined,
  controlActivation: Consumer['controlActivation'],
): string | null {
  if (controlActivation === 'active') return null;
  const claim = (claims ?? [])[0];
  if (!claim) return null;
  return `Dieser Verbraucher wird bereits durch die Automation „${claim.flowName}“ gesteuert. `
    + 'Solange sie aktiv ist, kann diese Regel nicht aktiviert werden.';
}

/** The primary review button per environment (flag OFF = Increment-1 wording). */
export function saveButtonLabel(policyActivationEnabled: boolean | undefined): string {
  return policyActivationEnabled === true ? 'Speichern & aktivieren' : 'Als Entwurf speichern';
}
