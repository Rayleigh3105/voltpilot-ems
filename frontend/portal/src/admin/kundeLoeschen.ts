import type { KundeLoeschbarkeit } from './adminApi';

/**
 * „Kunde endgültig löschen" (vp-kunde-sofort-loeschen-mit-daten): die Sätze der Kundenakte und der
 * Kundenliste als reines Modul. Jeder Kunde ist sofort löschbar, mit oder ohne Daten - der Dialog
 * sagt nur ehrlich, WAS dabei verloren geht, und spricht die Folgen. Die Datenarten kommen IMMER
 * vom Server (`KundeLoeschbarkeit` aus `KundeDatenBestand`); hier wird nichts entschieden, nur
 * formuliert.
 */

/** Die Datenarten der Befund-/409-Liste eines Kunden, in Kundenworten (Reihenfolge gibt der Server vor). */
export const KUNDE_DATENART_LABEL: Record<string, string> = {
  herzschlag: 'Box-Herzschläge',
  messwerte: 'Messwerte',
  messreihen: 'Messreihen',
  messauswahl: 'eine Auswahl aufzuzeichnender Werte',
  meldungen: 'Software-Meldungen',
  befehle: 'einen Befehlsverlauf',
  ocpp: 'Ladevorgänge (OCPP)',
  rueckmeldungen: 'Rückmeldungen',
  komponenten: 'gemeldete Komponenten',
  auswertungen: 'Auswertungen',
  erloese: 'Erlösdaten',
  alarme: 'Alarme und Benachrichtigungen',
  messstellen: 'Messstellen',
  bezugsdaten: 'Bezugsgrößen und Importe',
  kennzahlen: 'Kennzahlen',
  berichte: 'Berichte',
  nachweise: 'Nachweise des Energiemanagements',
  uems_struktur: 'aufgebaute Energiemanagement-Struktur',
};

export function kundeDatenListe(daten: string[]): string {
  return daten.map((d) => KUNDE_DATENART_LABEL[d] ?? d).join(' · ');
}

/** Keine Daten: der EINE Satz - er steht in Dialog und Gefahrenzone wörtlich gleich. */
export const KUNDE_KEINE_DATEN_SATZ = 'Dieser Kunde hat keinen Datenbestand.';

/** Hat Daten: der EINE Satz, was dabei verloren geht - kein Grund mehr, der das Löschen aufhält. */
export function kundeHatDatenSatz(befund: KundeLoeschbarkeit): string {
  return `Dieser Kunde hat Daten: ${kundeDatenListe(befund.daten)}. Sie gehen beim Löschen unwiderruflich `
    + 'verloren; vorher kann der Kundenadministrator den Gesamtabzug laden.';
}

/** Die Folgenliste des Bestätigungs-Dialogs - aus den Server-Fakten, nie aus Portal-Annahmen. */
export function kundeLoeschenFolgen(name: string, befund: KundeLoeschbarkeit): string[] {
  const folgen = befund.folgen;
  const anlass = befund.daten.length === 0 ? 'sofort, keine Daten' : 'sofort, mit Daten';
  const liste = [
    `Der Kunde „${name}" mit allen Anlagen (${folgen ? folgen.anlagen : '…'}) und seinem Vertrag - endgültig.`,
    `Alle Personen (${folgen ? folgen.personen : '…'}) samt Konten und offenen Einladungen. Ein Konto, das auch `
      + 'einem anderen Kunden dient (Partner), wird nur aus diesem Kunden gelöst.',
  ];
  if (folgen && folgen.boxen.length > 0) {
    liste.push(`Nie gemeldete Boxen werden vom Kunden gelöst und sind sofort wieder anmeldbar: `
      + `${folgen.boxen.join(', ')}.`);
  }
  liste.push('Werkstatt-, Fernwartungs- und Plattform-Protokolle bleiben; die Löschung selbst wird mit Name, '
    + `Anlass („${anlass}") und Löschnachweis protokolliert.`);
  return liste;
}
