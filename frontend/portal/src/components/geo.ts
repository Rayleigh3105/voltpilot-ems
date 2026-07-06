/**
 * Pure geo helpers for the LocationMap component. Kept free of React/Leaflet so
 * the pin<->fields sync and validation are unit-testable without a DOM or a map
 * instance (the "thin render-only component over a pure module" convention).
 */

/** DACH-level view shown when no pin is placed yet (roughly centered on Germany). */
export const DACH_CENTER: [number, number] = [51.1, 10.4];
export const DACH_ZOOM = 5;
/** Zoom used once a concrete location is known (pin placed or search result). */
export const PIN_ZOOM = 13;

export const LAT_ERROR = 'Bitte eine Zahl zwischen -90 und 90 eingeben, z. B. 52,52 - oder leer lassen.';
export const LON_ERROR = 'Bitte eine Zahl zwischen -180 und 180 eingeben, z. B. 13,405 - oder leer lassen.';

/**
 * Parse a manual coordinate field. Accepts German comma or dot decimals.
 * Returns `null` for an empty field, `NaN` for an unparseable value, otherwise
 * the finite number (callers treat NaN as "invalid").
 */
export function parseCoordInput(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Round to 5 decimals (~1 m) so a pin drag never writes absurd precision into the field. */
export function roundCoord(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/** Format a coordinate for the manual field ('' when unset); dot decimal, expert-facing. */
export function coordFieldValue(n: number | null | undefined): string {
  return n == null ? '' : String(roundCoord(n));
}

export function isValidLat(n: number): boolean {
  return Number.isFinite(n) && n >= -90 && n <= 90;
}

export function isValidLon(n: number): boolean {
  return Number.isFinite(n) && n >= -180 && n <= 180;
}

export interface CoordSync {
  /** Latitude to propagate (number, or null when the field is empty/incomplete). */
  lat: number | null;
  /** Longitude to propagate. */
  lon: number | null;
  latError: string | null;
  lonError: string | null;
  /** True when neither field is invalid (empty is allowed - coords are optional). */
  ok: boolean;
}

/**
 * Derive the (lat, lon, errors) a pair of manual field strings should produce.
 * The single source of truth for manual-edit -> pin synchronisation: a field is
 * invalid when it is non-empty and not a coordinate in range; empty stays null
 * (location is optional). Only when BOTH fields are valid-or-empty do we hand
 * back usable numbers.
 */
export function syncFromFields(latStr: string, lonStr: string): CoordSync {
  const latRaw = parseCoordInput(latStr);
  const lonRaw = parseCoordInput(lonStr);
  const latBad = Number.isNaN(latRaw) || (latRaw != null && !isValidLat(latRaw));
  const lonBad = Number.isNaN(lonRaw) || (lonRaw != null && !isValidLon(lonRaw));
  return {
    lat: latBad || latRaw == null ? null : latRaw,
    lon: lonBad || lonRaw == null ? null : lonRaw,
    latError: latBad ? LAT_ERROR : null,
    lonError: lonBad ? LON_ERROR : null,
    ok: !latBad && !lonBad,
  };
}
