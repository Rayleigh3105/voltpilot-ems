import type { VpOption } from '../picker/optionen';

/**
 * Die Suche oben in der Kopfzeile des Plattform-Administrators (Scheibe S1, E3 = A): sie ersetzt den
 * Mandanten-Umschalter und findet Kunden und die Plattform-Seiten. Reine Ableitung — die Schale rendert nur.
 *
 * ⚠ Eine Wahl muss SICHTBAR etwas tun. Bis 07.11.2026 setzte „Kunde“ nur den Mandanten: die Seite blieb stehen
 * (z. B. auf „Benutzer“ oder auf der Anlage des vorigen Kunden), das Feld zeigte weiter „Bitte wählen …“, und am
 * Telefon sah es aus, als passiere nichts. Jetzt öffnet die Wahl die Kundensicht genau wie „Wie der Kunde es sieht“
 * in der Kundenakte, und das Feld nennt den geöffneten Kunden.
 */

/** Im geschlossenen Feld: kurz, damit es am Telefon (390 px, neben Glocke und Konto) nicht abgeschnitten wird. */
export const ADMIN_SUCHE_PLATZHALTER = 'Kunde suchen …';
/** In der offenen Liste: dort ist Platz, und die Liste führt auch die Plattform-Seiten. */
export const ADMIN_SUCHE_SUCHTEXT = 'Kunde oder Seite suchen …';

const KUNDE = 'kunde:';
const SEITE = 'seite:';

export type AdminSucheZiel = { art: 'kunde'; id: string } | { art: 'seite'; id: string };

export function adminSucheOptionen(
  kunden: ReadonlyArray<{ id: string; name: string }>,
  seiten: ReadonlyArray<{ id: string; label: string }>,
): VpOption[] {
  return [
    ...kunden.map((k) => ({ value: `${KUNDE}${k.id}`, label: k.name, sub: 'Kunde' })),
    ...seiten.map((s) => ({ value: `${SEITE}${s.id}`, label: s.label, sub: 'Plattform' })),
  ];
}

/**
 * Was das Feld als gewählt zeigt: den Kunden, dessen Sicht offen ist. Ohne offene Kundensicht bleibt es leer
 * (Platzhalter) — eine Plattform-Seite steht schon in der Leiste, und ein Suchfeld, das „Benutzer“ trägt, läse
 * sich wie ein Filter.
 */
export function adminSucheWert(kundeOffen: string | null): string {
  return kundeOffen ? `${KUNDE}${kundeOffen}` : '';
}

/** Wohin eine Wahl führt; `null` für einen Wert, den die Suche nicht kennt. */
export function adminSucheZiel(wert: string): AdminSucheZiel | null {
  if (wert.startsWith(KUNDE) && wert.length > KUNDE.length) return { art: 'kunde', id: wert.slice(KUNDE.length) };
  if (wert.startsWith(SEITE) && wert.length > SEITE.length) return { art: 'seite', id: wert.slice(SEITE.length) };
  return null;
}
