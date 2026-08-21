import type { AdminDeviceRow, PendingEnrollment, ProvisionedDevice } from './admin/adminApi';
import { crossoverState } from './adminEdgeUpdates';

/**
 * Die reine Schicht der Plattform-Seite **„Geräte"**: der Onboarding-Funnel
 * (Admin-Umbau Stufe 1, B3) und - seit der Konsolidierung P2 - das INVENTAR
 * über den ganzen Lebenszyklus.
 *
 * Ein Gerät nimmt VIER Stufen: **registriert** (die Aufkleber-ID steht in der
 * Manufacturing-Registry) → **wartet auf Zuordnung** (das Gerät hat sich
 * gemeldet und einen CSR hochgeladen, aber kein Claim passt dazu) →
 * **verbunden** (ein Kundenkonto hat es beansprucht) → **Vertrauen gekreuzt**
 * (erst der TOFU-Crossover macht die Box update-fähig).
 *
 * Die Seite zeigte bisher nur die erste und dritte Stufe. Die zweite ist das
 * TIPPFEHLER-FENSTER: das Gerät hat seinen Teil getan, der Kunde hat eine
 * andere Referenz getippt — sichtbar war das auf keiner der beiden Seiten,
 * obwohl der Endpunkt seit dem Enrollment-Bau existiert. Die vierte wohnte als
 * SPALTE in der Flotten-Matrix der ANDEREN Seite, der Funnel hörte also eine
 * Stufe zu früh auf.
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

export type FunnelStageId = 'registriert' | 'wartet' | 'verbunden' | 'vertrauen';

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
 * Die VIER Stufen aus dem, was die Seite ohnehin lädt. `pending` ist
 * mandantenlos (ein Enrollment kennt keinen Mandanten), `registry` ist die
 * Aufkleber-Registry, `fleet` das Geräte-Inventar.
 *
 * **Die vierte Stufe „Vertrauen gekreuzt" schließt den Funnel** (UX-Konzept §3
 * Befund C): „verbunden" ist nicht das Onboarding-ENDE - erst der TOFU-
 * Crossover macht eine Box update-fähig. Diese Information existierte schon,
 * wohnte aber als SPALTE in der Flotten-Matrix der ANDEREN Seite; der Funnel
 * hörte damit eine Stufe zu früh auf.
 *
 * **Gezählt wird nur, was belegt ist:** ein Gerät, das seinen Vertrauensanker
 * gar nicht meldet, ist „unbekannt" und geht weder in den Zähler noch in die
 * offene Zahl ein - `crossoverState` ist dieselbe Ableitung, die auch die
 * Geräte-Zeile rendert.
 *
 * `verbunden` zählt seit dem Umbau die ECHTE Flotte, nicht mehr nur die
 * beanspruchten Aufkleber-IDs: die Bestandsboxen verbinden sich über selbst
 * generierte `edge-`Referenzen und kamen in dieser Zahl gar nicht vor.
 */
export function funnelStages(
  registry: ProvisionedDevice[],
  pending: PendingEnrollment[],
  fleet: AdminDeviceRow[] = [],
): FunnelStage[] {
  const registered = registry.length;
  const waiting = pending.length;
  const connectedRows = fleet.filter((d) => d.deviceId != null);
  // Ohne Inventar (älteres Backend) bleibt die alte Quelle gültig - dann zählt
  // die Stufe eben nur die beanspruchten Aufkleber, statt zu schweigen.
  const connected = fleet.length > 0
    ? connectedRows.length
    : registry.filter((d) => d.claimed).length;
  let crossed = 0;
  let open = 0;
  for (const d of connectedRows) {
    const s = crossoverState(d.trust).state;
    if (s === 'gekreuzt') crossed += 1;
    else if (s === 'offen' || s === 'fehler') open += 1;
  }
  const stages: FunnelStage[] = [
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
  // Die vierte Stufe erscheint nur, wenn es überhaupt eine Flotte gibt, über
  // die sie etwas sagen könnte - eine „0 von 0"-Kachel wäre kein Befund.
  if (connectedRows.length > 0) {
    stages.push({
      id: 'vertrauen',
      label: 'Vertrauen gekreuzt',
      count: crossed,
      note:
        open > 0
          ? open === 1
            ? '1 Gerät ist noch nicht update-fähig.'
            : `${open} Geräte sind noch nicht update-fähig.`
          : crossed === 0
            ? 'Noch kein Gerät meldet einen geprüften Vertrauensanker.'
            : 'Diese Geräte können Releases anwenden.',
      // Ein offener Crossover ist eine AUFGABE, kein Fehler - aber er ist der
      // Grund, warum ein Rollout auf dieser Box nichts bewirkt.
      attention: open > 0,
    });
  }
  return stages;
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

// ── Das INVENTAR: eine Tabelle über den ganzen Lebenszyklus ────────────────

/** Wo im Lebenszyklus steht diese Zeile? */
export type DeviceLifecycle = 'gedruckt' | 'verbunden';

/** Eine Zeile der EINEN Geräte-Tabelle. */
export interface DeviceRow {
  key: string;
  row: AdminDeviceRow;
  lifecycle: DeviceLifecycle;
  /** Was die Zeile in der Spalte „Gerät" trägt - nie eine UUID. */
  name: string;
  /** Anlage · Mandant, wo bekannt. */
  context: string | null;
  /** Steht diese Referenz in der Aufkleber-Registry? */
  provisioned: boolean;
}

/**
 * Das Inventar, sortiert: erst was Aufmerksamkeit braucht, dann die verbundene
 * Flotte, zuletzt die gedruckten IDs, die noch niemand verbunden hat.
 *
 * Die Reihenfolge INNERHALB der verbundenen Geräte ist die des Flotten-Pulses
 * (warn-first) - eine zweite Rangfolge für dieselbe Frage wäre eine zweite
 * Wahrheit; sie kommt deshalb aus `sortFleet`s Rang-Tabelle über `stateRank`.
 */
export function deviceRows(devices: AdminDeviceRow[]): DeviceRow[] {
  const rows: DeviceRow[] = devices.map((row) => ({
    key: row.externalRef,
    row,
    lifecycle: row.deviceId != null ? 'verbunden' : 'gedruckt',
    // Ein verbundenes Gerät heißt nach seiner Anlage bzw. seinem Namen; eine
    // gedruckte ID hat noch keinen - dann IST die Referenz der Name.
    name: row.siteName ?? row.label ?? row.externalRef,
    context: row.tenantName ?? null,
    provisioned: row.provisioned,
  }));
  return rows.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === 'verbunden' ? -1 : 1;
    const ra = stateRank(a.row.state);
    const rb = stateRank(b.row.state);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'de');
  });
}

/** Warn-first, dieselbe Ordnung wie im Flotten-Puls. */
function stateRank(state: string | null): number {
  switch (state) {
    case 'fehlgeschlagen':
    case 'zurueckgerollt':
    case 'im_update_verstummt':
      return 0;
    case 'wartet_auf_anwendung':
      return 1;
    case 'blockiert':
      return 2;
    case 'wendet_an':
    case 'laedt':
    case 'selbsttest':
      return 3;
    case 'ausstehend':
      return 4;
    case 'zurueckgestellt':
      return 5;
    case 'offline_holt_nach':
      return 6;
    case 'unbekannt':
      return 7;
    default:
      return 8;
  }
}

// ⚠ `versionDisplay`/`versionLabel` sind nach `src/edgeVersionLabel.ts`
// gezogen: seit der BOX-Seite (Geräteseiten Stufe 1) liest sie auch eine
// KUNDEN-Fläche, und der Copy-Wächter verbietet einer Kundenfläche zu Recht,
// eine reine ADMIN-Schicht zu importieren. Re-Export, damit jeder bestehende
// Aufrufer unverändert gilt.
export { versionDisplay, versionLabel } from './edgeVersionLabel';

