/**
 * Das Lebenszeichen einer Box aus ihrer eigenen Zertifikats-Anfrage/-Abfrage
 * (`device_enrollment`, siehe {@link Device.anmeldung} in `api.ts`) - der
 * einzige Beweis für "online", den eine Box geben kann, bevor sie ihren
 * ersten Status-Herzschlag schickt. Neutral (keine Admin-Worte, kein
 * Kunden-Vokabular), damit Kunden- UND Admin-Schichten dieselben Fenster und
 * dieselbe Rechnung verwenden - einmal pro Zahl.
 */

/**
 * Online-Fenster einer Box, die schon einmal ein Zertifikat bekommen hat
 * (`device_enrollment.issued_at` gesetzt). Ihr Lebenszeichen ist keine
 * Herzschlag-Meldung, sondern ihre Zertifikats-Abfrage im Abgleich-Takt alle
 * 5 min (Edge-Core `reconcileLoop`), und die API notiert höchstens eine
 * Abfrage je Minute. Zwei Abgleich-Takte plus diese Minute: eine verpasste
 * Abfrage kippt die Box noch nicht auf "offline".
 */
export const WARTET_ONLINE_WINDOW_MS = 11 * 60 * 1000;

/**
 * Online-Fenster einer Box, die NIE ein Zertifikat bekommen hat: sie fragt
 * laut Edge-Core-Enrollment alle ≤ 60 s, nicht alle 5 min. Zwei ausgebliebene
 * Abfragen plus die eine Minute, die die API höchstens einmal je Minute
 * notiert: 2 × 60 s + 60 s = 3 Min.
 */
export const WARTET_NIE_ZUGEORDNET_ONLINE_WINDOW_MS = 3 * 60 * 1000;

/** Die eigenen Anmelde-Momente einer Box; siehe `Device.anmeldung` in `api.ts`. */
export interface BoxAnmeldung {
  zuletztAngefragtAm: string | null;
  schluesselAbgeholtAm: string | null;
  zuletztAbgefragtAm?: string | null;
}

/**
 * Ist eine Box aus ihrer eigenen Zertifikats-Anfrage/-Abfrage gerade online?
 * Die spätere von `zuletztAngefragtAm` (CSR) und `zuletztAbgefragtAm`
 * (Zertifikats-Poll) - eine Box mit Zertifikat schickt nie wieder eine CSR,
 * ohne die Abfrage stünde sie nach einer Trennung für immer auf "offline",
 * auch wenn sie im Takt fragt. Das Fenster folgt, ob je ein Zertifikat
 * ausgestellt wurde (`schluesselAbgeholtAm`): eine nie zugeordnete Box fragt
 * sehr viel öfter, darum ein viel engeres Fenster.
 */
export function boxSchonAngemeldetOnline(
  anmeldung: BoxAnmeldung | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!anmeldung) return false;
  const zeiten = [anmeldung.zuletztAngefragtAm, anmeldung.zuletztAbgefragtAm ?? null]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (zeiten.length === 0) return false;
  const age = now.getTime() - Math.max(...zeiten);
  const window = anmeldung.schluesselAbgeholtAm != null ? WARTET_ONLINE_WINDOW_MS : WARTET_NIE_ZUGEORDNET_ONLINE_WINDOW_MS;
  return age <= window;
}
