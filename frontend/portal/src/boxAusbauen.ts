/**
 * "Box ausbauen" ohne Mandantensprung (vp-admin-box-ausbauen, Captain-Auftrag 11.11.2026): die
 * Sätze von `BoxLoesenDialog.tsx` als reines Modul - der Dialog spricht die Folgen, hier wird
 * nichts entschieden. Das Urteil, OB ausbaubar, liest denselben Befund wie "Vom Kunden lösen"
 * (`BoxLoesenBefund.gruende`): keine zweite Abfrage, kein zweiter Server-Weg.
 */

/**
 * Ausbaubar = dieselbe Zuständigkeits-Prüfung wie der Server beim Ausbauen selbst
 * (`DeviceRepository#ausbauen`, 409 `box_hat_zustaendigkeiten`): die Box muss noch aktiv sein (kein
 * `verbund`-Grund - praktisch immer der Fall, der Lösen-Befund zeigt nur aktive Boxen) und darf
 * keine offene Datenquelle mehr lesen (kein `zustaendigkeit`-Grund). Jeder andere Grund
 * (Herzschlag, Messwerte, Meldungen, Anmeldung) ist genau der Fall, FÜR DEN Ausbauen gedacht ist -
 * er blockiert nie.
 */
export function ausbaubar(gruende: string[]): boolean {
  return !gruende.includes('verbund') && !gruende.includes('zustaendigkeit');
}

/** Die Folgenliste des Bestätigungs-Dialogs, wenn ausbaubar - wörtlich wahr für den Ausbau-Weg. */
export function ausbauenFolgen(boxRef: string): string[] {
  return [
    'Die Messdaten bleiben beim Kunden - nichts Aufgezeichnetes geht verloren.',
    `„${boxRef}" wird frei: die Box sendet in rund 20 Minuten nicht mehr und kann neu verbunden werden.`,
    'War es die einzige Box der Anlage, kommt der Kunde wieder in die Einrichtung.',
  ];
}

/**
 * Nicht ausbaubar UND nicht lösbar: die ruhige Erklärung mit dem Weg dorthin, statt eines toten
 * Knopfs. `zustaendigkeit` ist der einzige Grund, den der Admin selbst beheben kann (über den
 * Mandantensprung) - jeder andere Fall (z. B. ein Rennen mit dem Kunden-Weg) bekommt den
 * bisherigen Umweg-Satz.
 */
export function nichtAusbaubarFolgen(gruende: string[]): string[] {
  return gruende.includes('zustaendigkeit')
    ? ['Die Box liest noch eine Datenquelle - erst die Zuständigkeit lösen (Mandantensicht „Wie der Kunde '
        + 'es sieht" › Box › Datenquelle), dann lässt sie sich hier ausbauen.']
    : ['Der Kunde entfernt die Box selbst (Anlage › Box › ⋯ › Gerät entfernen) - die Daten bleiben.',
        'Gehören die Daten zu einer fremden Anlage, ist das ein Fall für die Unterstützung.'];
}
