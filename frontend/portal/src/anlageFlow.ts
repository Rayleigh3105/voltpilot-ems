import type { SaveBatteryInput } from './api';

/**
 * Pure logic of the ONE "Anlage anlegen" flow (captain decision 5,
 * 2026-07-07): Anlage benennen + Adresse + Anlagentyp -> Geräte-ID
 * verbinden -> Speicher (optional). Both hosts - the first-run onboarding
 * wizard and the "Anlage anlegen" drawer - render the same
 * `components/AnlageFlow.tsx`, which derives everything word- and
 * step-related from this module so it stays unit-testable without a DOM.
 */

/** The step rail of the flow, in order. */
export const FLOW_STEPS = ['Anlage', 'Gerät', 'Speicher'] as const;

export type FlowStep = 1 | 2 | 3;

/**
 * Where the flow starts: a customer who already created an Anlage (but has
 * no device yet - wizard restart, "Später einrichten") resumes at the
 * Gerät step instead of being asked to create a second Anlage.
 */
export function initialFlowStep(hasSite: boolean): FlowStep {
  return hasSite ? 2 : 1;
}

/** Bidding zone from the address' country; everything else defaults to DE-LU. */
export function zoneForCountry(countryCode: string | null | undefined): string {
  switch ((countryCode ?? '').toUpperCase()) {
    case 'AT':
      return 'AT';
    case 'CH':
      return 'CH';
    default:
      return 'DE-LU';
  }
}

/**
 * Geräte-IDs come in two shapes and typing case must not matter, so the field
 * mirrors the canonical form as you type (the api canonicalizes the same way on
 * claim): sticker IDs are printed uppercase (VP-1234-ABCD), self-generated edge
 * references lowercase (edge-k7m2xqp). Other refs are left alone.
 */
export function normalizeDeviceIdInput(value: string): string {
  if (/^\s*vp-/i.test(value)) return value.toUpperCase();
  if (/^\s*edge-/i.test(value)) return value.toLowerCase();
  return value;
}

/**
 * Shared claim-field copy so the flow and the Geräte drawer speak with ONE
 * voice about where the Geräte-ID comes from - the device shows it in its
 * own app, and some devices also carry a sticker.
 */
export const DEVICE_ID_FIELD = {
  label: 'Geräte-ID',
  placeholder: 'z. B. edge-k7m2xqp',
  help: 'Die Geräte-ID zeigt Ihnen Ihr VoltPilot-Gerät direkt an - in der Geräte-App unter „Gerät verbinden". Manche Geräte tragen sie zusätzlich auf einem Aufkleber.',
} as const;

/** One 422 message for both gates (unknown sticker OR mistyped edge reference). */
export const DEVICE_ID_UNKNOWN_MSG =
  'Diese Geräte-ID kennen wir nicht. Bitte vergleichen Sie Ihre Eingabe Zeichen für Zeichen mit der ID, die Ihr Gerät anzeigt - schon ein Tippfehler verhindert die Verbindung.';

/** Parse a German-or-plain decimal; null when empty or not a finite number. */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export type BatteryFormResult =
  | { ok: true; value: SaveBatteryInput }
  | { ok: false; error: string };

/**
 * Validate the Speicher step's three fields (German comma decimals accepted).
 * The controlling device is deliberately NOT part of the result: omitting
 * `deviceId` lets the backend auto-link the Anlage's single device - the
 * claimed inverter controls the battery without any extra wiring.
 */
export function parseBatteryForm(input: {
  capacity: string;
  maxCharge: string;
  maxDischarge: string;
}): BatteryFormResult {
  const cap = parseDecimal(input.capacity);
  const chg = parseDecimal(input.maxCharge);
  const dis = parseDecimal(input.maxDischarge);
  if (cap == null || cap <= 0 || chg == null || chg <= 0 || dis == null || dis <= 0) {
    return {
      ok: false,
      error: 'Bitte geben Sie Kapazität, Lade- und Entladeleistung als positive Zahlen an.',
    };
  }
  return {
    ok: true,
    value: { capacityKwh: cap, maxChargeKw: chg, maxDischargeKw: dis },
  };
}
