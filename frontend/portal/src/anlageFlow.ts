import type { MastrApplyInput, MastrPreview } from './api';
import { FLOW_STEPS } from './anlageFlowSchritte';

/**
 * Die reine Logik des Anlege-Flusses (Anlage-Flow a1): Schrittleiste und Satz darüber, Kennung der Box,
 * Gebotszone, MaStR-Hilfen für „Aus dem Register holen“ (Schritt 3, `components/RegisterHolen.tsx`). Beide
 * Einstiege - der Einrichtungs-Assistent und „Anlage anlegen“ - rendern `components/AnlageFlow.tsx`, das
 * alles Wort- und Schrittbezogene von hier bezieht, damit es ohne DOM prüfbar bleibt.
 */

/** Die Schrittleiste wohnt in `anlageFlowSchritte.ts` (Einstiegs-Bündel). */
export { FLOW_STEPS };

/** Zahlwörter für die Schrittzahl - so weit, wie ein Assistent je reichen kann. */
const ZAHLWORT = ['null', 'einem', 'zwei', 'drei', 'vier', 'fünf', 'sechs'] as const;

/** „In drei Schritten ist Ihre Anlage startklar." — ABGELEITET aus {@link FLOW_STEPS}, nicht getippt. */
export const STARTKLAR_SATZ = startklarSatz(FLOW_STEPS.length);

/** Derselbe Satz für die Schritte, die der Fluss wirklich zeigt (mit Standort-Schritt vier). */
export function startklarSatz(anzahl: number): string {
  return `In ${ZAHLWORT[anzahl] ?? anzahl} Schritten ist Ihre Anlage startklar.`;
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
 * references lowercase (edge-k7m2xq3). Other refs are left alone.
 */
export function normalizeDeviceIdInput(value: string): string {
  if (/^\s*vp-/i.test(value)) return value.toUpperCase();
  if (/^\s*edge-/i.test(value)) return value.toLowerCase();
  return value;
}

/**
 * Shared claim-field copy so the flow and the Box dialog speak with ONE voice
 * about where the Kennung comes from - the box shows it in its own app; there
 * is no sticker (Captain, Anlage-Flow a1 Runde 1: „Wir haben keinen Aufkleber,
 * sag einfach das man die Kennung eintragen soll“). The path and labels are the
 * box web app's (edge-app/core/internal/web/static/einrichten.html, card
 * #portal); the box withholds the reference until data arrives
 * (commissioning.js, claim_unlocked). The check itself lives in `edgeRef.ts`.
 */
export const DEVICE_ID_FIELD = {
  label: 'Kennung',
  placeholder: 'z. B. edge-k7m2xq3',
  // Die Einrichtungsseite der Box nennt sie „Referenz-ID dieses Geräts“ (edge-app `web/static/einrichten.html`,
  // Karte #portal); einen Menüpunkt „Gerät verbinden“ gibt es dort nicht.
  help: 'Die Kennung zeigt Ihre Box in ihrer App unter „Einrichten" → „Kopplung mit dem VoltPilot-Portal" als „Referenz-ID dieses Geräts". Sie erscheint dort, sobald ein Wechselrichter oder eine Ladesäule Daten liefert.',
} as const;

/** One 422 message for both gates (unknown register ID OR a ref that is no box Kennung). */
export const DEVICE_ID_UNKNOWN_MSG =
  'Diese Kennung kennen wir nicht. Bitte vergleichen Sie sie Zeichen für Zeichen mit der App Ihrer Box - schon ein Tippfehler verhindert die Verbindung.';

/** 409: die Kennung gehört schon einem anderen Konto. */
export const DEVICE_ID_TAKEN_MSG =
  'Diese Box ist bereits mit einem anderen Konto verbunden. Bitte prüfen Sie die Kennung - oder kontaktieren Sie unseren Support.';

export { parseDecimal } from './zahl';

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

/** The register plausibility line, e.g. "89551 Königsbronn". Null when absent. */
export function mastrLocationLabel(p: MastrPreview): string | null {
  const label = `${p.plz ?? ''} ${p.ort ?? ''}`.trim();
  return label || null;
}
