/**
 * Die Wörter, die schon das erste Bild braucht: Navigation, Reiter, Anmeldung und Cockpit.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): `glossar.ts` ist EIN Modul und liegt deshalb
 * als Ganzes in genau einem Stück - mit jedem Wort, das irgendeine Seite braucht (13,9 kB im Einstiegs-Bündel).
 * Schale, Navigation und Cockpit brauchen davon nur diese sechzehn. Bedeutung und Regel jedes Worts stehen weiter an
 * seiner Stelle in `glossar.ts`, das jedes Wort unter seinem Namen weiterreicht; nur die Module des Einstiegs-Bündels
 * importieren von hier. Ein Wort kommt nur hierher, wenn ein Modul des Einstiegs es braucht - und zuerst ins
 * Fachmodell-Glossar (Pflegeregel: `docs/fachmodell/README.md`).
 */
export const UEMS_UNTERNEHMEN = 'Unternehmen';
export const UEMS_STANDORT = 'Standort';
export const UEMS_MESSSTELLE = 'Messstelle';
export const FAHRPLAN_TAETIGKEIT = {
  sonneSpeichern: 'Sonne speichern',
  guenstigLaden: 'Günstig aus dem Netz laden',
  verbrauchDecken: 'Verbrauch decken',
  warten: 'Warten',
  einspeisungPausieren: 'Einspeisung pausieren',
} as const;
export const UEMS_KENNZAHLEN = 'Kennzahlen';
export const UEMS_ENERGIEBILANZ = 'Energiebilanz';
export const UEMS_ZIELE_UND_MASSNAHMEN = 'Ziele und Maßnahmen';
export const UEMS_ENERGIEZIELE = 'Energieziele';
export const UEMS_MASSNAHMEN = 'Maßnahmen';
export const UEMS_ABWEICHUNGEN = 'Abweichungen';
export const UEMS_ENERGIEMANAGEMENT = 'Energiemanagement';
export const UEMS_WIEDERVORLAGE = 'Wiedervorlage';
export const UEMS_DOKUMENTE = 'Dokumente';
export const UEMS_MANAGEMENTBEWERTUNG = 'Managementbewertung';
export const LADEN_BEI_BEZUG_WOLKE =
  'Eine Wolke hat die Sonne gerade verdeckt – der Speicher regelt in den nächsten Sekunden nach.';
export const LADEN_BEI_BEZUG_FAHRPLAN = 'Der Fahrplan lädt jetzt für die teuren Stunden.';
