/** Shared German formatting helpers for the portal. */

/** Non-breaking space: keeps a number and its unit on one line. */
export const NBSP = ' ';

export function eur(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "1,57 €" with a non-breaking space before the sign. */
export function eurAmount(v: number): string {
  return `${eur(v)}${NBSP}€`;
}

/** "vor 4 Sek." / "vor 12 Min." / "vor 3 Std." / date - or "noch nie". */
export function fmtRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'noch nie';
  const diffS = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (diffS < 60) return `vor ${Math.round(diffS)}${NBSP}Sek.`;
  if (diffS < 3600) return `vor ${Math.round(diffS / 60)}${NBSP}Min.`;
  if (diffS < 86400) return `vor ${Math.round(diffS / 3600)}${NBSP}Std.`;
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** German label for a device kind (backend enum values stay English). */
export function deviceKindLabel(kind: string): string {
  const map: Record<string, string> = {
    inverter: 'Wechselrichter',
    battery: 'Batteriespeicher',
    meter: 'Zähler',
    'ev-charger': 'Ladepunkt',
    'heat-pump': 'Wärmepumpe',
  };
  return map[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** "52,5200° N · 13,4050° O" - or null when the site has no coordinates. */
export function fmtCoords(lat: number | null | undefined, lon: number | null | undefined): string | null {
  if (lat == null || lon == null) return null;
  const f = (v: number) =>
    Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return `${f(lat)}°${NBSP}${lat < 0 ? 'S' : 'N'} · ${f(lon)}°${NBSP}${lon < 0 ? 'W' : 'O'}`;
}

/**
 * Wholesale EUR/MWh -> the customer-relatable "12,34 ct/kWh" (÷10). Customer
 * surfaces speak ct/kWh (the unit on an electricity bill), never MWh. A regular
 * space before the unit lets it wrap under the number in a narrow KPI card.
 */
export function ctPerKwh(eurMwh: number | null | undefined, digits = 2): string {
  if (eurMwh == null) return '-';
  const n = (Number(eurMwh) / 10).toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n} ct/kWh`;
}

/**
 * Friendly German label for a bidding-zone code on customer surfaces. Onboarding
 * deliberately hides the raw "DE-LU"/"AT"/"CH" jargon; the dashboard shouldn't
 * re-expose it. Unknown codes pass through unchanged.
 */
export function zoneLabel(zone: string | null | undefined): string {
  if (!zone) return '';
  const map: Record<string, string> = {
    'DE-LU': 'Deutschland',
    DE: 'Deutschland',
    AT: 'Österreich',
    CH: 'Schweiz',
  };
  return map[zone] ?? zone;
}

/** German label for a site's Anlagentyp (backend enum values stay lowercase). */
export function plantKindLabel(kind: string | null | undefined): string {
  if (kind === 'direktvermarktung') return 'Direktvermarktung';
  if (kind === 'eigenverbrauch') return 'Eigenverbrauch';
  return kind ?? '';
}

/** German decimal number + unit, joined with a non-breaking space. */
export function fmtNum(v: number | null | undefined, unit: string, digits = 1): string {
  if (v == null) return '-';
  const n = Number(v).toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return unit ? `${n}${NBSP}${unit}` : n;
}
