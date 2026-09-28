/**
 * K6 (Konzept „Energiemanagement ohne Fachsprache“): dieselben Seiten, eine andere erste Ansicht je Rolle — ohne neue
 * Rechte. K8: am Telefon beginnt die Übersicht des Unternehmens mit dem, was man unterwegs prüft (fällige Punkte der
 * Wiedervorlage, Abweichungen, Datenlage); alles andere bleibt erreichbar.
 *
 * | Rolle | erste Frage | oben auf der Übersicht |
 * |---|---|---|
 * | Energiemanager | Was fehlt noch, was ist fällig? | Fahrplan (K2) und „Was steht an“ |
 * | Kundenadministrator | Wer darf was an welchem Standort? | wie heute |
 * | Bearbeiter | Ist mein Standort angeschlossen? | „Ihr Standort“: Aufbau, Messstellen, Abweichungen |
 * | Leser, Einsicht | Wo finde ich die Belege? | „Belege“: Berichte, Dokumente, Managementbewertung |
 *
 * Reines Modul: kein React, kein Netz. Welche Bausteine tatsächlich Inhalt haben, entscheidet weiter die Übersicht.
 */
import type { Selbstauskunft } from './api';
import type { UebersichtBausteinId } from './uebersichtBausteine';

export type Einstieg = 'aufbauen' | 'standort' | 'belege' | 'wie_heute';

/** Die Bausteine der Übersicht und die drei Einstiege, die K2/K6 dazulegen. */
export type ObenBaustein = UebersichtBausteinId | 'fahrplan' | 'belege' | 'standort';

type Rollen = Pick<Selbstauskunft, 'rollen' | 'standorte'>;

const alleRollen = (s: Rollen) => [...s.rollen, ...s.standorte.flatMap((st) => st.rollen)];

/**
 * Die erste Ansicht nach der Rolle. Wer mehrere Rollen hat, bekommt die, die am meisten aufbaut: Energiemanager vor
 * Kundenadministrator (der behält die Übersicht von heute), dann Bearbeiter, dann die lesenden Rollen.
 */
export function einstiegFuer(s: Rollen | null | undefined): Einstieg {
  if (!s) return 'wie_heute';
  const rollen = alleRollen(s);
  if (rollen.includes('energiemanager')) return 'aufbauen';
  if (s.rollen.includes('kundenadministrator')) return 'wie_heute';
  if (rollen.includes('bearbeiter')) return 'standort';
  if (rollen.includes('leser') || rollen.includes('einsicht')) return 'belege';
  return 'wie_heute';
}

/** Der Einstieg der Rolle als Baustein — „wie heute“ legt keinen dazu. */
const EINSTIEG_BAUSTEIN: Record<Einstieg, ObenBaustein[]> = {
  aufbauen: ['fahrplan'],
  standort: ['standort'],
  belege: ['belege'],
  wie_heute: [],
};

/**
 * Was OBEN auf der Übersicht des Unternehmens steht, vor der Leiste der Kennzahlen und den Anlagen, in dieser
 * Reihenfolge. Am Rechner nur der Einstieg der Rolle (der Energiemanager dazu „Was steht an“); am Telefon zuerst „Was
 * steht an“, dann der Einstieg, dann Abweichungen und Datenlage (K8). Was hier steht, steht unten nicht noch einmal.
 */
export function obenBausteine(einstieg: Einstieg, telefon: boolean): ObenBaustein[] {
  if (telefon) return ['energiemanagement', ...EINSTIEG_BAUSTEIN[einstieg], 'ziele-massnahmen', 'messstellen'];
  return einstieg === 'aufbauen' ? ['fahrplan', 'energiemanagement'] : EINSTIEG_BAUSTEIN[einstieg];
}

/** Die Standorte, an denen die Person Bearbeiter ist — je Standort aus `/me` (dort steht die Rolle auch unternehmensweit). */
export function bearbeiterStandorte(s: Rollen | null | undefined): string[] {
  if (!s) return [];
  return s.standorte.filter((st) => st.rollen.includes('bearbeiter')).map((st) => st.id);
}
