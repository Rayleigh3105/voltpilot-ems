/**
 * Woraus eine Zahl entstanden ist - das Abzeichen an der Karte (report §7).
 *
 * ⚠ EIGENES MODUL (UX-Review V-01, 24.09.2026): Fahrplan-Zeile, Börsenpreis-
 * Streifen und Geld-Karte des Cockpits brauchen nur diese drei Wörter;
 * `historieWelten.ts` (Welten, Reiter, Adressen der Historie) reicht sie
 * unverändert weiter.
 */
export type Provenienz = 'gemessen' | 'bewertet' | 'geplant';

/** Das Abzeichen: ein Wort plus der Satz, der seine Einschränkung ausspricht. */
export interface ProvenienzInfo {
  label: string;
  /** Der eine Satz, den die UI zum Abzeichen sagen muss (report §7). */
  satz: string;
}

export const PROVENIENZ: Record<Provenienz, ProvenienzInfo> = {
  gemessen: {
    label: 'Gemessen',
    satz:
      'Gemessene Werte Ihrer Anlage; einzelne Ausreißer sind durch den letzten gültigen Wert ersetzt.',
  },
  bewertet: {
    label: 'Bewertet',
    satz: 'Bewertet mit dem heute gepflegten Preisblatt — nicht Ihre Abrechnung.',
  },
  geplant: {
    label: 'Geplant',
    satz: 'Vorab geplant — nicht die gemessene Ersparnis.',
  },
};
