/**
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`): der Satz des Box-Bands (Konzept
 * vp-qr-einstieg, M3 bis M5). Die Anmeldekarte liegt im Einstieg und braucht nur ihn - der übrige
 * Wortlaut der Seiten nach dem Scan bleibt in `koppelTexte.ts` (das ihn weiterreicht) und lädt nach.
 * Den Satz der Anmeldeseite spricht auch das Keycloak-Theme (`js/box-band.js`) - gemeinsam ändern.
 */

/** M3/M4/M5 · das Band über Registrierung, Anmeldung und Assistent. */
export function bandText(ort: 'registrierung' | 'anmeldung' | 'assistent', gedruckt: string): string {
  switch (ort) {
    case 'registrierung':
      return `Box ${gedruckt} ist vorgemerkt. Nach dem Konto fragen wir die Adresse Ihrer Anlage, dann verbinden Sie die Box.`;
    case 'anmeldung':
      return `Ihre Box ${gedruckt} wartet. Nach der Anmeldung verbinden Sie sie mit Ihrer Anlage.`;
    case 'assistent':
      return `Box ${gedruckt} aus dem QR-Code ist vorgemerkt. Sie verbinden sie im nächsten Schritt.`;
  }
}

/** M6: der Haken am Kennungsfeld, wenn die Kennung aus dem QR-Code kommt (`KennungFeld`, im Einstieg). */
export const FELD_AUS_QR = 'Kennung stimmt · aus dem QR-Code';
