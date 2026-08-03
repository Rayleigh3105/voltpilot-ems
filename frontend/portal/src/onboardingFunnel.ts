import type { PendingEnrollment, ProvisionedDevice } from './admin/adminApi';

/**
 * Der Onboarding-Funnel der Geräte-Registry (Admin-Umbau Stufe 1, Baustein B3).
 *
 * Ein Gerät nimmt drei Stufen: **registriert** (die Aufkleber-ID steht in der
 * Manufacturing-Registry) → **wartet auf Zuordnung** (das Gerät hat sich
 * gemeldet und einen CSR hochgeladen, aber kein Claim passt dazu) →
 * **verbunden** (ein Kundenkonto hat es beansprucht).
 *
 * Die Registry-Seite zeigte bisher nur die erste und dritte Stufe. Die mittlere
 * ist das TIPPFEHLER-FENSTER: das Gerät hat seinen Teil getan, der Kunde hat
 * eine andere Referenz getippt — sichtbar war das auf keiner der beiden Seiten,
 * obwohl der Endpunkt seit dem Enrollment-Bau existiert.
 *
 * Reine Ableitung: hier wird nur gezählt und formuliert, nie geraten. Was der
 * Server nicht liefert, behauptet dieses Modul auch nicht.
 */

/**
 * Ab dieser Wartezeit ist ein meldendes Gerät ohne Claim kein normaler
 * Einrichtungs-Zwischenstand mehr, sondern ein Hinweis auf einen Tippfehler.
 * Bewusst großzügig: eine Einrichtung, bei der Kunde und Techniker nicht am
 * selben Tag arbeiten, ist normal — erst danach lohnt der Anruf.
 */
export const TYPO_SUSPECT_AFTER_MS = 24 * 60 * 60 * 1000;

export type FunnelStageId = 'registriert' | 'wartet' | 'verbunden';

/** Eine Stufe des Funnels: Zahl + Wort, sonst nichts. */
export interface FunnelStage {
  id: FunnelStageId;
  label: string;
  count: number;
  /** Ein Satz, der die Zahl einordnet — nie eine Handlungsaufforderung ohne Grund. */
  note: string;
  /** True, sobald die Stufe Aufmerksamkeit verdient (nur „wartet" kann das). */
  attention: boolean;
}

/**
 * Die drei Stufen aus dem, was die Seite ohnehin lädt. `pending` ist
 * mandantenlos (ein Enrollment kennt keinen Mandanten), `devices` ist die
 * Registry.
 */
export function funnelStages(
  devices: ProvisionedDevice[],
  pending: PendingEnrollment[],
): FunnelStage[] {
  const connected = devices.filter((d) => d.claimed).length;
  const registered = devices.length;
  const waiting = pending.length;
  return [
    {
      id: 'registriert',
      label: 'Registriert',
      count: registered,
      note:
        registered === 0
          ? 'Noch keine Geräte-ID registriert.'
          : 'Geräte-IDs, die Kunden verbinden können.',
      attention: false,
    },
    {
      id: 'wartet',
      label: 'Wartet auf Zuordnung',
      count: waiting,
      note:
        waiting === 0
          ? 'Kein Gerät wartet gerade auf einen Claim.'
          : 'Diese Geräte melden sich, treffen aber auf kein Kundenkonto.',
      attention: waiting > 0,
    },
    {
      id: 'verbunden',
      label: 'Verbunden',
      count: connected,
      note:
        connected === 0
          ? 'Noch kein Gerät mit einem Kundenkonto verbunden.'
          : 'Mit einem Kundenkonto verbunden.',
      attention: false,
    },
  ];
}

/** Eine Zeile der Sektion „Wartet auf Zuordnung". */
export interface PendingRow {
  externalRef: string;
  /** Was das Gerät über sich sagt; null wenn es nichts gesagt hat. */
  deviceInfo: string | null;
  csrUpdatedAt: string;
  /** Der eine einordnende Satz — die einzige Wertung dieser Fläche. */
  hint: string;
  /** True für den Tippfehler-Verdacht (die Zeile wird bernstein markiert). */
  suspect: boolean;
}

/**
 * Die wartenden Geräte, das LÄNGSTE Warten zuerst — genau das ist der Fall, der
 * jemanden braucht. Der Hinweis unterscheidet nur die drei Zustände, die die
 * Daten wirklich hergeben:
 *
 * - länger als {@link TYPO_SUSPECT_AFTER_MS} → vermutlich Tippfehler beim Kunden
 * - frisch → normal während der Einrichtung
 * - `everIssued` → das Gerät WAR verbunden und wurde getrennt; das ist etwas
 *   anderes als „nie angekommen" und darf nie als Tippfehler gelesen werden.
 */
export function pendingRows(
  pending: PendingEnrollment[],
  now: Date = new Date(),
): PendingRow[] {
  return [...pending]
    .sort((a, b) => Date.parse(a.csrUpdatedAt) - Date.parse(b.csrUpdatedAt))
    .map((p) => {
      const waitedMs = Math.max(0, now.getTime() - Date.parse(p.csrUpdatedAt));
      const suspect = !p.everIssued && waitedMs >= TYPO_SUSPECT_AFTER_MS;
      return {
        externalRef: p.externalRef,
        deviceInfo: p.deviceInfo && p.deviceInfo.trim() ? p.deviceInfo.trim() : null,
        csrUpdatedAt: p.csrUpdatedAt,
        hint: p.everIssued
          ? 'War schon einmal verbunden und wurde getrennt'
          : suspect
            ? 'Vermutlich Tippfehler beim Kunden'
            : 'Frisch — normal während der Einrichtung',
        suspect,
      };
    });
}
