/** Shared German formatting helpers for the portal. */

/** Non-breaking space: keeps a number and its unit on one line. */
export const NBSP = ' ';

/**
 * Die Zahlformate der heißen Pfade stehen EINMAL als `Intl.NumberFormat` bereit: `toLocaleString` baut bei jedem
 * Aufruf einen neuen Formatierer, und das Anlagen-Cockpit formatiert je Neu-Rendern Dutzende Zahlen (CPU-Profil der
 * Performance-Runde vp-perf2-portal: `fmtNum` und `eur` allein ≈ 60 ms je Minute offener Seite). Die Ausgabe ist dieselbe -
 * `toLocaleString(locale, optionen)` IST `new Intl.NumberFormat(locale, optionen).format(v)`.
 */
const EUR_FORMAT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STELLEN_FORMAT = new Map<number, Intl.NumberFormat>();
function stellenFormat(digits: number): Intl.NumberFormat {
  let f = STELLEN_FORMAT.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    STELLEN_FORMAT.set(digits, f);
  }
  return f;
}

export function eur(v: number): string {
  return EUR_FORMAT.format(v);
}

/** "1,57 €" with a non-breaking space before the sign. */
export function eurAmount(v: number): string {
  return `${eur(v)}${NBSP}€`;
}

/**
 * Unter dieser Dauer heißt es „gerade eben": „Stand vor 0 Sek." las sich wie
 * ein Messfehler, und eine Sekundenzahl ist in diesem Bereich ohnehin Rauschen
 * der Abrufzeit, keine Aussage.
 */
export const GERADE_EBEN_S = 5;
export const GERADE_EBEN = 'gerade eben';

/** "gerade eben" / "vor 12 Sek." / "vor 12 Min." / "vor 3 Std." / date - or "noch nie". */
export function fmtRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'noch nie';
  const diffS = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (diffS < GERADE_EBEN_S) return GERADE_EBEN;
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

/**
 * „seit 3 Std." — die DAUER eines anhaltenden Zustands, nicht der Zeitpunkt
 * eines Ereignisses. `fmtRelative` beantwortet „wann zuletzt?" („vor 3 Std.");
 * ein Zustand, der ANHÄLT, braucht das andere Wort: „meldet sich nicht · seit
 * 3 Std." Ohne Zeitstempel wird nichts behauptet (null), nie „seit noch nie".
 */
export function seitDauer(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const rel = fmtRelative(iso, now);
  if (rel === GERADE_EBEN) return 'seit wenigen Sekunden';
  return rel.startsWith('vor ') ? `seit ${rel.slice(4)}` : `seit dem ${rel}`;
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

/**
 * The 8 exact Hauptausrichtung bearings MaStR reports (MastrCatalog.java
 * AZIMUTH_LABEL; `azimuthDeg` on the asset is always one of these when it
 * came from the register). Any other degree value is a manual entry and has
 * no compass word - showing it as degrees stays more honest than guessing
 * the nearest direction.
 */
const COMPASS_LABEL: Record<number, string> = {
  0: 'Nord',
  45: 'Nord-Ost',
  90: 'Ost',
  135: 'Süd-Ost',
  180: 'Süd',
  225: 'Süd-West',
  270: 'West',
  315: 'Nord-West',
};

/** "Süd" for an exact register bearing, else null (not one of the 8 compass points). */
export function compassLabel(deg: number): string | null {
  return COMPASS_LABEL[deg] ?? null;
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

/**
 * German decimal number + unit, joined with a non-breaking space.
 * A negative value gets the real minus sign (U+2212), not the ASCII hyphen
 * `toLocaleString` would print - the portal rule "echtes Minus verwenden"
 * (UEMS-Zahlenformat AP-08 E11; Zählerbaum-Konzept N2).
 */
export function fmtNum(v: number | null | undefined, unit: string, digits = 1): string {
  if (v == null) return '-';
  const num = Number(v);
  const vorzeichen = num < 0 ? '−' : '';
  const n = `${vorzeichen}${stellenFormat(digits).format(Math.abs(num))}`;
  return unit ? `${n}${NBSP}${unit}` : n;
}
