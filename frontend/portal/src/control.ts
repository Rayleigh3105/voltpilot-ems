// Pure derivation for the Anlagen-Seite "Steuerung" strip (captain decision 4):
// "Ihr Gerät regelt gerade auf X -> Wechselrichter bestätigt Y", healthy | mismatch |
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
  /**
   * The plain-German sentence, e.g. "Ihr Gerät regelt gerade auf −4,0 kW →
   * Wechselrichter bestätigt −4,0 kW".
   *
   * It deliberately does NOT say "Fahrplan-Sollwert": since the in-slot
   * following duties the box may knowingly deviate from the plan's watt value,
   * so `commandedKw` is what the DEVICE regulates - not what the Fahrplan
   * planned. Both numbers under one word ("Fahrplan") on one screen was the
   * reported contradiction (Konzept vp-fahrplan-kunde-konzept K2): the plan bar
   * read −4,3 kW while this line read −6,1 kW. The plan value keeps its own
   * home - the Fahrplan page's Jetzt-Held names Plan and execution side by
   * side (`fahrplanJetzt.ts`).
   */
  sentence: string;
  /** The freshness note, e.g. "geprüft vor 3 s" (empty for off/pending). */
  agoNote: string;
  /** Maps to the Badge status tone (dot colour). */
  tone: 'ok' | 'warn' | 'off';
  /**
   * WHY the setpoint is what it is - the plan's OWN reason for the slot being
   * executed, in plain German (e.g. "Lädt günstig aus dem Netz: Börsenpreis
   * 3,3 ct/kWh liegt unter dem Wert gespeicherter Energie (≈ 28,0 ct/kWh).").
   *
   * The owner's question at Anlage Pilsting (2026-07-30) was exactly this: the
   * strip stated a command and its confirmation and read like a stubborn order.
   * The reason is NOT computed here - it comes from the optimizer's per-slot
   * why-layer (`slotWhy` over the active plan slot), so there is no second
   * explanation logic. Null when the plan recorded no reason (a pre-why run, an
   * unknown role) or when nothing is being executed - the strip then reads
   * exactly as before, never with an invented cause.
   */
  reason: string | null;
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
 *
 * `reason` is the plan's OWN why-sentence for the slot being executed (built by
 * the caller from `slotWhy(activeSlot)` - see `controlReasonSlot`). It is only
 * attached to the states that actually SHOW a commanded setpoint: explaining a
 * setpoint that is not being executed (off / not released / no readback yet)
 * would be a claim about something that is not happening.
 */
export function controlStrip(
  status: ControlStatus | null,
  now: Date = new Date(),
  expectControl = false,
  reason: string | null = null,
): ControlStripView | null {
  if (!status) {
    if (!expectControl) return null;
    return {
      state: 'preparing',
      tone: 'off',
      sentence:
        'Die Steuerung wird vorbereitet - sobald Ihr Wechselrichter den ersten Sollwert bestätigt, sehen Sie es hier.',
      agoNote: '',
      reason: null,
    };
  }

  // Not yet released for control: the inverter is only monitored.
  if (!status.certified) {
    return {
      state: 'pending',
      tone: 'off',
      sentence: 'Die Steuerung ist für dieses Modell noch nicht freigegeben - die Anlage wird nur ausgelesen.',
      agoNote: '',
      reason: null,
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
      reason: null,
    };
  }

  if (stale) {
    return {
      state: 'stale',
      tone: 'off',
      sentence: `Zuletzt geregelt auf ${commanded} - bestätigt ${confirmed}`,
      agoNote: `zuletzt geprüft ${ago}`,
      reason,
    };
  }

  if (!status.allMatch) {
    return {
      state: 'mismatch',
      tone: 'warn',
      sentence: `Ihr Gerät regelt gerade auf ${commanded} → Wechselrichter meldet ${confirmed}`,
      agoNote: `Abweichung · geprüft ${ago}`,
      reason,
    };
  }

  return {
    state: 'healthy',
    tone: 'ok',
    sentence: `Ihr Gerät regelt gerade auf ${commanded} → Wechselrichter bestätigt ${confirmed}`,
    agoNote: `geprüft ${ago}`,
    reason,
  };
}

/**
 * The plan slot the strip explains: the one whose
 * [start, start + slotMinutes) contains `now`.
 *
 * Null outside the plan's horizon - the strip then states the command and its
 * confirmation and claims NO cause, exactly like a plan from before the
 * why-layer (idleReason's discipline: an uncomputed cause stays absent instead
 * of being invented).
 */
export function controlReasonSlot<T extends { start: string }>(
  slots: T[],
  now: Date = new Date(),
  slotMinutes = 15,
): T | null {
  const t = now.getTime();
  const width = slotMinutes * 60_000;
  for (const s of slots) {
    const start = new Date(s.start).getTime();
    if (!isNaN(start) && t >= start && t < start + width) return s;
  }
  return null;
}
