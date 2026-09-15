import type { MastrApplyInput, MastrPreview, SaveBatteryInput } from './api';
import { fmtNum } from './format';

/**
 * Pure logic of the REGISTER-FIRST "Anlage anlegen" flow (captain
 * 2026-07-09): instead of typing PV and battery specs by hand, the customer
 * enters their MaStR number(s) and VoltPilot pulls the data from the
 * Marktstammdatenregister. Steps: 1 · Anlage (Name + Standort) ->
 * 2 · Register (PV + Speicher aus dem Register, Vorschau, Übernehmen; manual
 * entry is the always-reachable fallback) -> 3 · Anwendungen ("Wie soll Ihr
 * Speicher arbeiten?" - Speicherschonung + Optimierungs-Nutzungen, captain
 * design update 2026-07-16; changeable later on the Optimierung subpage) ->
 * 4 · Gerät (Geräte-ID verbinden) -> Fertig. Both hosts - the first-run
 * onboarding wizard and the "Anlage anlegen" drawer - render the same
 * `components/AnlageFlow.tsx`, which derives everything word- and step-related
 * from this module so it stays unit-testable without a DOM.
 */

/**
 * The step rail of the flow, in order (register-first). AE5 (spec §3) moved the
 * device claim ("Gerät") ahead of the adaptive last step: the entity bootstrap +
 * usage-profile + auto-start seeding need the Anlage's master data AND its
 * gateway device in place, so it is the last, adaptive step.
 *
 * Its LABEL is **„Betrieb"** since Steuerung Stufe 0 „Entwirrung"
 * (Captain 25.08.2026: „Anwendung" ist kein Kundenwort mehr; der Schritt fragt
 * nach dem BETRIEB der Anlage — Profil, EIN Betriebsmodell, Speicherschonung).
 * Es war davor „Anwendungen" und davor „Nutzung"; die Komponenten-Id und jede
 * Route bleiben.
 */
export const FLOW_STEPS = ['Anlage', 'Register', 'Gerät', 'Betrieb'] as const;

export type FlowStep = 1 | 2 | 3 | 4;

/** Zahlwörter für die Schrittzahl - so weit, wie ein Assistent je reichen kann. */
const ZAHLWORT = ['null', 'einem', 'zwei', 'drei', 'vier', 'fünf', 'sechs'] as const;

/**
 * „In vier Schritten ist Ihre Anlage startklar." — ABGELEITET aus
 * {@link FLOW_STEPS}, nicht getippt.
 *
 * Die Copy sagte „In drei Schritten" über VIER Schritt-Punkten: seit AE5 den
 * Gerät-Schritt vorzog und den vierten Schritt ergänzte, war sie falsch, und niemand
 * bemerkte es, weil Satz und Schrittleiste keine gemeinsame Quelle hatten.
 * Jetzt haben sie eine — ein fünfter Schritt korrigiert den Satz von selbst.
 */
export const STARTKLAR_SATZ = startklarSatz(FLOW_STEPS.length);

/**
 * Derselbe Satz für die Schritte, die der Fluss wirklich zeigt — der Modus „nur messen“
 * hat ohne „Betrieb“ drei (`anlegeNurMessen.ts`).
 */
export function startklarSatz(anzahl: number): string {
  return `In ${ZAHLWORT[anzahl] ?? anzahl} Schritten ist Ihre Anlage startklar.`;
}

/**
 * Where the flow starts: a customer who already created an Anlage (but has no
 * device yet - wizard restart, "Später einrichten") resumes at the Register
 * step. Register is skippable, so nothing is forced on them, but the
 * register-first value stays offered on the way back to the Gerät step.
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
 * Validate the manual Speicher fallback's three fields (German comma decimals
 * accepted). The controlling device is deliberately NOT part of the result:
 * omitting `deviceId` lets the backend auto-link the Anlage's single device -
 * the claimed inverter controls the battery without any extra wiring.
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

// --- MaStR (Marktstammdaten) helpers: the register-first heart of the flow ---

/** Canonical SEE number: strip whitespace, uppercase (the api canonicalizes too). */
export function normalizeSeeNummer(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Client-side SEE-number check with the same friendly hints the backend
 * returns, so a wrong prefix is caught before the round-trip. Returns null for
 * an empty field (optional) or a well-formed SEE number, else a German hint.
 */
export function validateSeeNummer(raw: string): string | null {
  const cleaned = normalizeSeeNummer(raw);
  if (!cleaned) return null;
  if (/^SEE\d{12}$/.test(cleaned)) return null;
  const prefix = cleaned.slice(0, 3);
  if (prefix === 'SES') {
    return 'SES-Nummern kennzeichnen keine Einheit. Auch Batteriespeicher haben eine SEE-Nummer.';
  }
  if (prefix === 'SSE') {
    return 'Das ist die Nummer der Speicher-Anlage. Bitte die SEE-Nummer der Speicher-Einheit eingeben.';
  }
  if (prefix === 'EEG') {
    return 'Das ist die Nummer der EEG-Anlage. Bitte die SEE-Nummer der Einheit eingeben.';
  }
  if (prefix === 'ABR') {
    return 'Das ist Ihre Betreibernummer. Bitte die SEE-Nummer der Einheit eingeben.';
  }
  return 'Eine Einheitennummer beginnt mit SEE, gefolgt von 12 Ziffern (z. B. SEE966831669444).';
}

/**
 * Which storage number to look up: an explicitly typed one always wins; when
 * the field is empty and the PV record cross-links a storage unit
 * (`linkedUnitNumber`), that number is adopted automatically so the customer
 * usually never types the second number. Null = no storage to look up.
 */
export function pickStorageNumber(
  pvPreview: MastrPreview | null,
  explicitStorage: string,
): { number: string; autoFilled: boolean } | null {
  const explicit = normalizeSeeNummer(explicitStorage);
  if (explicit) return { number: explicit, autoFilled: false };
  const linked = pvPreview?.linkedUnitNumber ? normalizeSeeNummer(pvPreview.linkedUnitNumber) : '';
  if (linked) return { number: linked, autoFilled: true };
  return null;
}

/**
 * Map confirmed MaStR previews onto the apply payload (PV onto the PV asset,
 * storage onto the battery asset) - `mastr-apply` persists both atomically and
 * auto-links the battery to the site's device.
 */
export function buildMastrApply(previews: MastrPreview[]): MastrApplyInput {
  const input: MastrApplyInput = {};
  for (const p of previews) {
    if (p.kind === 'pv') {
      input.pv = {
        mastrNummer: p.mastrNummer,
        capacityKwp: p.powerKw,
        moduleCount: p.moduleCount,
        azimuthDeg: p.azimuthDeg,
        tiltDeg: p.tiltDeg,
        commissionedOn: p.commissionedOn,
      };
    } else {
      input.storage = {
        mastrNummer: p.mastrNummer,
        capacityKwh: p.storageCapacityKwh,
        maxChargeKw: p.chargePowerKw,
        maxDischargeKw: p.powerKw,
        commissionedOn: p.commissionedOn,
      };
    }
  }
  return input;
}

/** One-line PV recap for the Fertig screen, e.g. "9,8 kWp · Süd 30°". */
export function mastrPvSummary(p: MastrPreview): string {
  const parts: string[] = [];
  if (p.powerKw != null) parts.push(fmtNum(p.powerKw, 'kWp', 2));
  const orient = [p.azimuthLabel, p.tiltLabel].filter(Boolean).join(' ');
  if (orient) parts.push(orient);
  return parts.join(' · ') || 'aus dem Register';
}

/** One-line Speicher recap for the Fertig screen, e.g. "10 kWh · 5 kW". */
export function mastrStorageSummary(p: MastrPreview): string {
  const parts: string[] = [];
  if (p.storageCapacityKwh != null) parts.push(fmtNum(p.storageCapacityKwh, 'kWh', 1));
  if (p.powerKw != null) parts.push(fmtNum(p.powerKw, 'kW', 2));
  if (p.batteryTechnology) parts.push(p.batteryTechnology);
  return parts.join(' · ') || 'aus dem Register';
}

/** The register plausibility line, e.g. "89551 Königsbronn". Null when absent. */
export function mastrLocationLabel(p: MastrPreview): string | null {
  const label = `${p.plz ?? ''} ${p.ort ?? ''}`.trim();
  return label || null;
}
