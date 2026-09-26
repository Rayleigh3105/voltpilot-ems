/**
 * Passwort-Vorgabe aus AP-20 E12: mindestens 12 Zeichen und nicht der
 * Benutzername. Bei der Selbstregistrierung ist die E-Mail-Adresse der
 * Benutzername; der Name bzw. Firmenname zählt ebenfalls als erratbar.
 *
 * Die API prüft dasselbe (`RegistrationRequest`, `ResetPasswordRequest`),
 * der gehärtete Realm zusätzlich. Das Portal prüft vorab, damit niemand erst
 * an einem 400 der API oder an Keycloak scheitert.
 */
export const PASSWORT_MIN_ZEICHEN = 12;

/** Vergleich wie beim Anmelden: ohne Rand-Leerzeichen, ohne Groß/klein. */
function gleich(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  return x.length > 0 && x === b.trim().toLowerCase();
}

/** true, wenn das Passwort einem der Namen (Benutzername, E-Mail, Name) gleicht. */
export function passwortGleichtName(passwort: string, ...namen: string[]): boolean {
  return namen.some((n) => gleich(passwort, n));
}

/** Deutsche Meldung, warum das Passwort nicht genügt - null, wenn es genügt. */
export function passwortFehler(passwort: string, ...namen: string[]): string | null {
  if (passwort.length === 0) {
    return `Bitte wählen Sie ein Passwort mit mindestens ${PASSWORT_MIN_ZEICHEN} Zeichen.`;
  }
  if (passwort.length < PASSWORT_MIN_ZEICHEN) {
    return `Noch ${PASSWORT_MIN_ZEICHEN - passwort.length} Zeichen – mindestens ${PASSWORT_MIN_ZEICHEN} sind nötig.`;
  }
  if (passwortGleichtName(passwort, ...namen)) {
    return 'Das Passwort darf nicht Ihr Name oder Ihre E-Mail-Adresse sein.';
  }
  return null;
}
