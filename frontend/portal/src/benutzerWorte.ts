/**
 * **Die Wörter der Benutzer-Seite** — aus Unternehmens- oder Haushaltssicht
 * (Privatkunde, Nebenbefund 5).
 *
 * Rollen, Rechte und Geltungsbereiche bleiben dieselben (`rechte-matrix.json`,
 * `KUNDENROLLEN`); nur ihre Anzeige folgt dem Anwendungsprofil der Anlagen
 * (`site.profil`) wie die Geld-Sprache (`fleet.ts siteTonalitaet`) und das
 * Wort des Rests (`verbrauchKomposition.restWort`). Das Profil ist nur
 * Voreinstellung und Tonalität, keine Verzweigung im Fachmodell.
 *
 * ⚠ Haushaltswörter nur, wenn JEDE Anlage `privat` trägt: eine gemischte
 * Flotte und jede Bestandsanlage ohne Profil behalten die Unternehmenswörter
 * zeichengleich.
 *
 * Kein React, kein Netz.
 */
import { ROLLE_KUNDENWORT, type Rolle } from './rechte';

export type BenutzerTon = 'privat' | 'gewerbe';

/** Haushaltssicht genau dann, wenn es Anlagen gibt und alle das Profil `privat` tragen. */
export function benutzerTon(sites: readonly { profil?: string | null }[] | null | undefined): BenutzerTon {
  return sites && sites.length > 0 && sites.every((s) => s.profil === 'privat') ? 'privat' : 'gewerbe';
}

/** Die Rollen-Beschreibung im Rollen-Wähler — je zuweisbare Rolle ein Satz (`copy.test.ts` hält sie vollständig). */
export const ROLLE_BESCHREIBUNG: Record<string, string> = {
  kundenadministrator: 'Verwaltet Benutzer, Daten und Steuerung im ganzen Unternehmen.',
  energiemanager: 'Pflegt Daten an allen Standorten; bedient keine Steuerung und verwaltet keine Benutzer.',
  bearbeiter: 'Pflegt Daten an ausgewählten Standorten; bedient keine Steuerung.',
  bedienberechtigt: 'Bedient die Steuerung an ausgewählten Standorten; pflegt keine Messdaten und erteilt keine Freigaben.',
  leser: 'Sieht Daten an ausgewählten Standorten; ändert nichts.',
  einsicht: 'Sieht das Energiemanagement des ganzen Unternehmens und kann nichts ändern — für Leitung und Prüfende, auch befristet.',
};

/** Die Rollennamen aus Haushaltssicht; nicht genannte Rollen behalten ihr Kundenwort. */
const ROLLE_HAUSHALT: Partial<Record<Rolle, string>> = {
  kundenadministrator: 'Verwalten',
  energiemanager: 'Daten pflegen',
  bearbeiter: 'Daten pflegen an einzelnen Orten',
  bedienberechtigt: 'Bedienen',
  leser: 'Ansehen',
  einsicht: 'Alles ansehen',
};

const BESCHREIBUNG_HAUSHALT: Record<string, string> = {
  kundenadministrator: 'Verwaltet Benutzer, Daten und Steuerung im ganzen Haushalt.',
  energiemanager: 'Pflegt Daten an allen Orten des Haushalts; bedient keine Steuerung und verwaltet keine Benutzer.',
  bearbeiter: 'Pflegt Daten an ausgewählten Orten; bedient keine Steuerung.',
  bedienberechtigt: 'Bedient die Steuerung an ausgewählten Orten; pflegt keine Messdaten und erteilt keine Freigaben.',
  leser: 'Sieht Daten an ausgewählten Orten; ändert nichts.',
  einsicht: 'Sieht alles im Haushalt und kann nichts ändern, auch befristet.',
};

export interface BenutzerWorte {
  rolle: (rolle: string) => string;
  beschreibung: (rolle: string) => string | undefined;
  /** Satz, solange nur ein Konto besteht. */
  allein: string;
  /** Der Geltungsbereich ohne Standort („Unternehmen“ / „Haushalt“). */
  ganzes: string;
  /** Feldname im Wähler („Standorte“ / „Orte“). */
  orte: string;
  mindestensEiner: string;
  alleAktuellen: string;
  neueSpaeter: string;
  rolleUndOrteAendern: string;
  giltFuerAlle: string;
  alleOrteDesGanzen: string;
  ortNichtVerfuegbar: string;
  zeitzone: string;
}

const GEWERBE: BenutzerWorte = {
  rolle: (r) => ROLLE_KUNDENWORT[r as Rolle] ?? r,
  beschreibung: (r) => ROLLE_BESCHREIBUNG[r],
  allein: 'Bisher arbeiten Sie allein. Legen Sie Kolleginnen und Kollegen an und bestimmen Sie, was sie sehen und bedienen dürfen.',
  ganzes: 'Unternehmen',
  orte: 'Standorte',
  mindestensEiner: 'Wählen Sie mindestens einen Standort.',
  alleAktuellen: 'Alle aktuellen Standorte',
  neueSpaeter: 'Neue Standorte müssen später ausdrücklich zugewiesen werden.',
  rolleUndOrteAendern: 'Rolle und Standorte ändern',
  giltFuerAlle: 'Gilt für alle Standorte des Unternehmens, auch künftige.',
  alleOrteDesGanzen: 'Alle Standorte des Unternehmens',
  ortNichtVerfuegbar: 'Der zugewiesene Standort ist nicht verfügbar.',
  zeitzone: 'Zeitzone des Unternehmens',
};

const HAUSHALT: BenutzerWorte = {
  rolle: (r) => ROLLE_HAUSHALT[r as Rolle] ?? GEWERBE.rolle(r),
  beschreibung: (r) => BESCHREIBUNG_HAUSHALT[r] ?? ROLLE_BESCHREIBUNG[r],
  allein: 'Bisher nutzen nur Sie VoltPilot. Legen Sie weitere Personen Ihres Haushalts an und bestimmen Sie, was sie sehen und bedienen dürfen.',
  ganzes: 'Haushalt',
  orte: 'Orte',
  mindestensEiner: 'Wählen Sie mindestens einen Ort.',
  alleAktuellen: 'Alle aktuellen Orte',
  neueSpaeter: 'Neue Orte müssen später ausdrücklich zugewiesen werden.',
  rolleUndOrteAendern: 'Rolle und Orte ändern',
  giltFuerAlle: 'Gilt für alle Orte des Haushalts, auch künftige.',
  alleOrteDesGanzen: 'Alle Orte des Haushalts',
  ortNichtVerfuegbar: 'Der zugewiesene Ort ist nicht verfügbar.',
  zeitzone: 'Zeitzone des Haushalts',
};

export function benutzerWorte(ton: BenutzerTon): BenutzerWorte {
  return ton === 'privat' ? HAUSHALT : GEWERBE;
}
