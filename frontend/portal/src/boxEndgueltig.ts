import type { BoxEndgueltigBefund } from './admin/adminApi';
import { fmtRelative } from './format';

/**
 * „Endgültig löschen" einer AUSGEBAUTEN Box (vierter Löschweg, vp-box-endgueltig-loeschen): die
 * Sätze der Geräteakte als reines Modul - die Karte erklärt mit ihnen ruhig, WARUM eine Box bleibt
 * (nie ein toter Knopf), und der Dialog spricht die Folgen. Das Urteil selbst kommt IMMER vom
 * Server (`BoxEndgueltigBefund`); hier wird nichts entschieden, nur formuliert.
 */

/** Die Datenarten der 409-/Befund-Liste, in Kundenworten (Reihenfolge gibt der Server vor). */
export const DATENART_LABEL: Record<string, string> = {
  herzschlag: 'Herzschläge',
  messwerte: 'Messwerte',
  messauswahl: 'eine Auswahl aufzuzeichnender Werte',
  meldungen: 'Software-Meldungen',
  befehle: 'einen Befehlsverlauf',
  ocpp: 'Ladevorgänge (OCPP)',
  rueckmeldungen: 'Rückmeldungen',
  freigaben: 'Steuerungs-Freigaben',
  komponenten: 'gemeldete Komponenten',
  messstellen_belege: 'Belege an Messstellen',
  berichtsstaende: 'Zitate in freigegebenen Berichtsständen',
  weitere_aufzeichnungen: 'weitere Aufzeichnungen',
};

export function datenListe(daten: string[]): string {
  return daten.map((d) => DATENART_LABEL[d] ?? d).join(' · ');
}

/** Die Kopfzeile der Karte „Ausgebaut": Kunde › Anlage · Ausgebaut vor … */
export function ausgebautZeile(befund: BoxEndgueltigBefund, jetzt: Date): string {
  const f = befund.fakten;
  return `${f.tenantName} › ${f.siteName} · Ausgebaut ${fmtRelative(f.ausgebautAm, jetzt)}`;
}

/** Löschbar: der EINE Satz der Spezifikation - er steht in Karte und Dialog wörtlich gleich. */
export const NIE_DATEN_SATZ = 'Die Box hat nie Daten geliefert; Werkstatt- und Fernwartungs-Protokolle bleiben.';

/** Nicht löschbar: die ruhige Erklärung, warum die Box als Historie bleibt - mit dem Was. */
export function bleibtSatz(daten: string[]): string {
  return `Diese Box bleibt als Historie: sie trägt ${datenListe(daten)}.`;
}

/** Die Folgenliste des Bestätigungs-Dialogs (ConfirmDialog nennt auch, was GLEICH bleibt). */
export function loeschenFolgen(boxRef: string): string[] {
  return [
    `„${boxRef}" verschwindet endgültig aus der Geräteliste.`,
    'Werkstatt-, Fernwartungs- und Zertifikats-Protokolle der Kennung bleiben erhalten.',
    'Die Kennung bleibt wieder anmeldbar - wie nach dem Ausbau.',
  ];
}
