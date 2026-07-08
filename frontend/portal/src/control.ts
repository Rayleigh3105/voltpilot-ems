// Pure derivation for the Anlagen-Seite "Steuerung" strip (captain decision 4):
// "Fahrplan-Sollwert X -> Wechselrichter bestätigt Y", healthy | mismatch |
// stale, plus "geprüft vor X". No React, no side effects - unit-tested in
// control.test.ts, rendered by components/MoneyView.tsx ControlStrip.
//
// Deliberately free of internal vocabulary (no register/Modbus/kill-switch
// jargon) - that detail lives on the technician's :8484 card.
import type { ControlStatus } from './api';
import { fmtNum, fmtRelative } from './format';

/**
 * The strip's state:
 *   healthy  - the inverter confirmed the commanded setpoint.
 *   mismatch - the inverter reported a different value than commanded.
 *   stale    - the last confirmation is older than the freshness window.
 *   off      - control is switched off for this device (Not-Aus).
 *   pending  - the model is not yet released for control (read-only).
 *   preparing - a controllable plant that has not reported a readback yet, so
 *               the loop is honestly shown as being set up (report N4).
 */
export type ControlState = 'healthy' | 'mismatch' | 'stale' | 'off' | 'pending' | 'preparing';

export interface ControlStripView {
  state: ControlState;
  /** The plain-German sentence, e.g. "Fahrplan-Sollwert −4,0 kW → Wechselrichter bestätigt −4,0 kW". */
  sentence: string;
  /** The freshness note, e.g. "geprüft vor 3 s" (empty for off/pending). */
  agoNote: string;
  /** Maps to the Badge status tone (dot colour). */
  tone: 'ok' | 'warn' | 'off';
}

// A confirmation older than this reads as "stale" - kept in sync with the
// device liveness window used elsewhere in the portal (5 min).
export const CONTROL_STALE_MS = 5 * 60 * 1000;

function kw(v: number | null): string {
  return v == null ? '–' : fmtNum(v, 'kW', 1);
}

/**
 * controlStrip - derive the calm "Steuerung" strip from the latest control
 * confirmation.
 *
 * `status` is null when no readback has arrived yet. By default the strip is
 * then not rendered (returns null). For a controllable plant (a battery with a
 * controlling device, `expectControl = true`) the strip stays honest instead
 * (report N4): "Die Steuerung wird vorbereitet ..." so the "is the plan being
 * executed" loop is always visibly closed rather than silently missing.
 */
export function controlStrip(
  status: ControlStatus | null,
  now: Date = new Date(),
  expectControl = false,
): ControlStripView | null {
  if (!status) {
    if (!expectControl) return null;
    return {
      state: 'preparing',
      tone: 'off',
      sentence:
        'Die Steuerung wird vorbereitet - sobald Ihr Wechselrichter den ersten Sollwert bestätigt, sehen Sie es hier.',
      agoNote: '',
    };
  }

  // Not yet released for control: the inverter is only monitored.
  if (!status.certified) {
    return {
      state: 'pending',
      tone: 'off',
      sentence: 'Die Steuerung ist für dieses Modell noch nicht freigegeben - die Anlage wird nur ausgelesen.',
      agoNote: '',
    };
  }

  const commanded = kw(status.commandedKw);
  const confirmed = kw(status.confirmedKw);
  const ago = fmtRelative(status.checkedAt, now);
  const ageMs = now.getTime() - new Date(status.checkedAt).getTime();
  const stale = !isNaN(ageMs) && ageMs > CONTROL_STALE_MS;

  // Control switched off (Not-Aus): honest, calm, not an error.
  if (!status.controlEnabled) {
    return {
      state: 'off',
      tone: 'off',
      sentence: 'Die Wechselrichter-Steuerung ist ausgeschaltet. VoltPilot liest die Anlage aus, steuert sie aber nicht.',
      agoNote: '',
    };
  }

  if (stale) {
    return {
      state: 'stale',
      tone: 'off',
      sentence: `Fahrplan-Sollwert ${commanded} - zuletzt bestätigt ${confirmed}`,
      agoNote: `zuletzt geprüft ${ago}`,
    };
  }

  if (!status.allMatch) {
    return {
      state: 'mismatch',
      tone: 'warn',
      sentence: `Fahrplan-Sollwert ${commanded} → Wechselrichter meldet ${confirmed}`,
      agoNote: `Abweichung · geprüft ${ago}`,
    };
  }

  return {
    state: 'healthy',
    tone: 'ok',
    sentence: `Fahrplan-Sollwert ${commanded} → Wechselrichter bestätigt ${confirmed}`,
    agoNote: `geprüft ${ago}`,
  };
}
