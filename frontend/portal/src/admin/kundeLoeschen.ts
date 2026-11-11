import type { KundeLoeschbarkeit } from './adminApi';
import { datumDe } from './kundenakte';

/**
 * „Kunde endgültig löschen" (vp-kunde-sofort-loeschen): die Sätze der Kundenakte und der Kundenliste
 * als reines Modul - der Dialog erklärt mit ihnen ruhig, WARUM ein Kunde (noch) nicht löschbar ist
 * (nie ein toter Knopf), und spricht die Folgen. Das Urteil selbst kommt IMMER vom Server
 * (`KundeLoeschbarkeit` aus `KundeDatenBestand`); hier wird nichts entschieden, nur formuliert.
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

/** Sofort löschbar: der EINE Satz - er steht in Dialog und Gefahrenzone wörtlich gleich. */
export const KUNDE_KEINE_DATEN_SATZ =
  'Dieser Kunde hat keinen Datenbestand - er kann sofort endgültig gelöscht werden, ohne Frist.';

/** Nicht sofort löschbar: die ruhige Erklärung mit dem Was, dem Ab-wann und dem Weg zum Gesamtabzug. */
export function kundeBleibtSatz(befund: KundeLoeschbarkeit): string {
  const was = `Dieser Kunde hat Daten: ${kundeDatenListe(befund.daten)}.`;
  if (befund.loeschungFruehestens) {
    return `${was} Gelöscht wird frühestens am ${datumDe(befund.loeschungFruehestens)}; bis dahin kann der `
      + 'Kundenadministrator den Gesamtabzug laden.';
  }
  return `${was} Gelöscht wird erst, nachdem der Vertrag beendet wurde und die Frist abgelaufen ist; `
    + 'bis dahin kann der Kundenadministrator den Gesamtabzug laden.';
}

/** Die Folgenliste des Bestätigungs-Dialogs - aus den Server-Fakten, nie aus Portal-Annahmen. */
export function kundeLoeschenFolgen(name: string, befund: KundeLoeschbarkeit): string[] {
  const folgen = befund.folgen;
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
    + 'Anlass („sofort, keine Daten") und Löschnachweis protokolliert.');
  return liste;
}
