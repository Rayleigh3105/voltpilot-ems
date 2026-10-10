/** Gemeinsame Zahleneingabe. Bestehende Dezimalfelder behalten ihre bisherige Deutung. */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Deutscher Zahlentext, ohne Gleitkomma-Rundung für die Schreibschnittstelle. */
export function zahlText(text: string): string | null {
  const s = text.trim().replace(/[ \u00a0\u202f]/g, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(s)) return null;
  const [ganz, bruch] = s.replace(/\./g, '').split(',');
  const gruppiert = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return gruppiert + (bruch === undefined ? '' : `,${bruch}`);
}

/** Die deutsche Eingabe erlaubt Tausenderpunkte; ungültig bleibt unbekannt. */
export function zahl(text: string): number | null {
  const s = zahlText(text);
  return s === null ? null : parseDecimal(s.replace(/\./g, ''));
}

/** Bestand des Zählerwechsels: gruppierte deutsche Zahlen UND einfache Dezimalpunkte. */
export function ablesestandWert(text: string): number | null {
  const wert = text.trim();
  return /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(wert) ? zahl(wert) : parseDecimal(wert);
}
