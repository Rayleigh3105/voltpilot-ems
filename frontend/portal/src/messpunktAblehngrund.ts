/**
 * Deutsche Sätze für die geschlossene Ablehn-Wortliste einer Box-Quittung
 * (`mqtt-measurement-config-status`, `rejected[].reason`; Vertrag
 * `docs/contracts/v2/mqtt-measurement-config-status.schema.json`, serverseitig
 * geprüft in `MeasurementConfigStatusListener.REASONS`). Der Server
 * (`MeasurementSelectionService.state()`) reichte diesen rohen englischen Code
 * bisher unverändert als `applyReason`/`statusReason` weiter - der Kunde sah ihn
 * roh (Befund PR 1886). `messpunktAblehngrund.test.ts` prüft diese Liste gegen
 * den Vertrag, damit ein neuer Server-Grund ohne Übersetzung hier auffällt.
 *
 * Ein Grund außerhalb dieser Liste - heute unmöglich, da der Server nur Codes
 * dieser geschlossenen Liste annimmt, aber ein künftiger Server-Stand kann eine
 * neue Box-Freigabe schon vor der passenden Portal-Version annehmen - fällt auf
 * den allgemeinen Satz zurück, nie roh.
 */

const SAETZE: Record<string, string> = {
  unknown_point: 'Dieser Punkt ist der VoltPilot-Box unbekannt.',
  unsupported_catalog: 'Der Katalogstand der Box passt nicht zum aktuellen Plan; '
    + 'VoltPilot liefert ihn automatisch im passenden Stand neu aus.',
  edge_too_old: 'Die Software Ihrer VoltPilot-Box unterstützt diesen Punkt noch nicht - '
    + 'bitte ein Update der Box einspielen.',
  invalid_cadence: 'Die gewählte Kadenz wird von dieser Box nicht unterstützt - '
    + 'bitte eine andere Kadenz wählen.',
  budget_samples: 'Das Werte-Budget der Box ist für diesen Punkt ausgeschöpft - '
    + 'bitte andere Punkte abwählen oder eine langsamere Kadenz wählen.',
  budget_requests: 'Das Abfrage-Budget der Box ist für diesen Punkt ausgeschöpft - '
    + 'bitte andere Punkte abwählen oder eine langsamere Kadenz wählen.',
  budget_duty_cycle: 'Die Bus-Auslastung der Box ist für diesen Punkt ausgeschöpft - '
    + 'bitte andere Punkte abwählen oder eine langsamere Kadenz wählen.',
  driver_unavailable: 'Die Box hat aktuell keinen Treiber für dieses Gerät - '
    + 'bitte die Geräteverbindung prüfen.',
  ocpp_configuration_incompatible: 'Die OCPP-Konfiguration dieser Ladesäule unterstützt diesen Messwert nicht.',
  binding_unavailable: 'Die Box kann diesen Punkt noch keiner Komponente zuordnen - '
    + 'das behebt sich von selbst, sobald die Zuordnung bekannt ist.',
};

/** Die geschlossene Wortliste, die der Server heute annimmt (für den Vertragsabgleich im Test). */
export const BEKANNTE_GRUENDE = Object.keys(SAETZE);

export const ALLGEMEINER_GRUND = 'Die VoltPilot-Box hat die Auswahl abgelehnt.';

/**
 * Übersetzt EINEN Ablehn-Code der Box in einen verständlichen deutschen Satz.
 * Nie den rohen Code zeigen: ein unbekannter oder fehlender Grund fällt auf
 * {@link ALLGEMEINER_GRUND} zurück.
 */
export function ablehngrundText(code: string | null | undefined): string {
  if (!code) return ALLGEMEINER_GRUND;
  return SAETZE[code] ?? ALLGEMEINER_GRUND;
}
