/**
 * Die Weiche des Einrichtungspfads (M5, `setupPath.ts`), ohne den Pfad selbst.
 *
 * Eigenes Modul (Performance Welle 3): das Anlagen-Cockpit im Einstiegs-Bündel braucht nur diese Entscheidung und die
 * Statuszeile. Über `setupPath.ts` lag der ganze Einrichtungspfad (drei Schritte, Übernahme-Plan, Wortlaute) im ersten
 * Bild, weil Rollup ein Modul nur als Ganzes in ein Stück legt. Bedeutung und Regel stehen weiter in `setupPath.ts`,
 * das beides unverändert weiterreicht.
 */

export interface SetupPathGateInput {
  /** M0 `surface.base.hasEntities`; undefined/null = Read-Model nicht geladen. */
  hasEntities?: boolean | null;
  /** Anzahl aktiver Modi (M0). */
  modeCount?: number | null;
  /** true, sobald die Status-Zeile der Anlage (Overview) aufgelöst ist. */
  statusLoaded?: boolean;
  /** Zeitpunkt der letzten Messung (Overview); null = noch nie. */
  lastSeenAt?: string | null;
  /** Neuester Telemetrie-Datensatz vorhanden? */
  hasLiveSample?: boolean;
}

/**
 * Ist diese Anlage die Ausprägung „Neu / leer"? Nur dann ersetzt der
 * Einrichtungspfad das Cockpit.
 *
 * Alle vier Bedingungen müssen gelten:
 *  1. das Read-Model ist geladen (älteres Backend/Ladefehler ⇒ v1, fail-soft),
 *  2. es gibt keine Entitäten,
 *  3. es läuft kein Modus,
 *  4. die Anlage hat noch **nie** Messdaten geliefert (siehe Kopfkommentar).
 */
export function setupPathActive(input: SetupPathGateInput | null | undefined): boolean {
  const i = input ?? {};
  if (i.hasEntities !== false) return false;
  if ((i.modeCount ?? 0) > 0) return false;
  if (i.statusLoaded !== true) return false;
  if (i.lastSeenAt != null) return false;
  if (i.hasLiveSample === true) return false;
  return true;
}

export const SETUP_STATUS_LINE =
  'Ihre Anlage ist angelegt - jetzt stellen wir Ihr Energie-System zusammen. '
  + 'Drei Schritte, alles Weitere passiert automatisch.';

