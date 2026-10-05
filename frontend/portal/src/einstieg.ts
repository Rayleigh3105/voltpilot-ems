/**
 * Die Bausteinmenge der Übersicht und die Standorte, an denen eine Person Bearbeiter ist.
 *
 * Reines Modul: kein React, kein Netz.
 *
 * Hinweis (Review R2 §C8): die früher hier wohnende rollenabhängige „erste Ansicht" des
 * Unternehmens (`einstiegFuer`/`obenBausteine`, K6/K8) ist mit der FESTEN Unternehmensstruktur
 * (Konzept `data/vp-portfolio-konzept2-p2` §5.1) entfallen und wurde entfernt - die
 * Unternehmens-Übersicht ordnet nicht mehr nach Rolle. `ObenBaustein` (die Bausteinmenge) und
 * `bearbeiterStandorte` (Einstieg „Ihr Standort") sind weiter in Gebrauch.
 */
import type { Selbstauskunft } from './api';
import type { UebersichtBausteinId } from './uebersichtBausteine';

/** Die Bausteine der Übersicht plus die Einstiege, die die Übersicht oben dazulegen kann. */
export type ObenBaustein = UebersichtBausteinId | 'fahrplan' | 'belege' | 'standort';

type Rollen = Pick<Selbstauskunft, 'rollen' | 'standorte'>;

/** Die Standorte, an denen die Person Bearbeiter ist — je Standort aus `/me` (dort steht die Rolle auch unternehmensweit). */
export function bearbeiterStandorte(s: Rollen | null | undefined): string[] {
  if (!s) return [];
  return s.standorte.filter((st) => st.rollen.includes('bearbeiter')).map((st) => st.id);
}
