/**
 * Die REINE Schicht der Plattform-Seite „Edge-Updates" (OTA Stufe 2,
 * Scout `vp-ota-rollout-h4` §7): aus dem einen Server-Aggregat werden hier
 * Wörter, Töne und Sortierungen - und sonst nirgends.
 *
 * **Die Ehrlichkeitsregeln stehen SERVER-seitig** (`RolloutStates`/`BakeGate`
 * in `services/api`): welcher Zustand gilt, ob eine Welle frei ist, warum sie
 * es nicht ist. Diese Datei erfindet keinen davon nach - sie ÜBERSETZT. Das
 * ist dieselbe Trennung wie beim Flotten-Puls seit Stufe 2 des Admin-Umbaus:
 * eine Frage darf nicht zwei Antworten haben.
 *
 * Was hier trotzdem gilt und getestet wird:
 * - Ein Zustand, den dieser Stand NICHT kennt, wird als „unbekannt" gezeigt -
 *   nie als „aktuell" und nie als Fehler. Ein neuer Server-Zustand darf keine
 *   falsche Behauptung erzeugen, bevor das Portal ihn gelernt hat.
 * - Prozentzahlen laufen über die ERREICHBARE Menge; ein Gerät ohne Meldung
 *   steht weder im Zähler noch im Nenner.
 * - Jede rote Zeile trägt ihren Grund; fehlt er, wird KEINE Ursache erfunden.
 */

export type UpdateTone = 'ok' | 'warn' | 'off' | 'busy';

export interface EdgeUpdatesRelease {
  releaseSeq: number;
  version: string;
  targetCommit: string | null;
  notes: string | null;
  signed: boolean;
  signingKeyId: string | null;
  createdAt: string;
  runningOnDevices: number;
}

export interface WaveDevice {
  deviceId: string;
  label: string;
  siteName: string | null;
  tenantName: string | null;
  state: string;
  reason: string | null;
  since: string | null;
  bakeRemainingMinutes: number | null;
  bakeCycle: string | null;
  bakeReason: string | null;
}

export interface Wave {
  index: number;
  name: string;
  released: boolean;
  confirmed: boolean;
  devices: WaveDevice[];
}

export interface ActiveRollout {
  id: string;
  releaseVersion: string;
  releaseSeq: number;
  channel: string;
  state: string;
  currentWave: number;
  waveCount: number;
  haltedReason: string | null;
  createdBy: string | null;
  createdAt: string;
  canPromote: boolean;
  promoteBlockedReason: string | null;
  waves: Wave[];
}

export interface FleetRow {
  deviceId: string;
  label: string;
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  ist: string | null;
  soll: string | null;
  sollSeq: number | null;
  channel: string | null;
  pinned: boolean;
  state: string;
  reason: string | null;
  since: string | null;
  reportedAt: string | null;
  rolloutId: string | null;
}

export interface JournalEntry {
  id: number;
  at: string;
  actor: string;
  event: string;
  rolloutId: string | null;
  deviceId: string | null;
  detail: string | null;
}

export interface EdgeUpdatesKpi {
  known: number;
  upToDate: number;
  unknown: number;
  inRollout: number;
  failed: number;
  newestRelease: string | null;
}

export interface EdgeUpdates {
  releases: EdgeUpdatesRelease[];
  activeRollout: ActiveRollout | null;
  fleet: FleetRow[];
  journal: JournalEntry[];
  kpi: EdgeUpdatesKpi;
}

/** Beschriftung + Ton eines Geräte-Zustands (§7.2, plus `zurueckgestellt`). */
const STATE_LABELS: Record<string, { label: string; tone: UpdateTone }> = {
  aktuell: { label: 'aktuell', tone: 'ok' },
  bestaetigt: { label: 'bestätigt ✓', tone: 'ok' },
  ausstehend: { label: 'ausstehend', tone: 'busy' },
  laedt: { label: 'lädt', tone: 'busy' },
  wendet_an: { label: 'wendet an', tone: 'busy' },
  selbsttest: { label: 'Selbsttest', tone: 'busy' },
  offline_holt_nach: { label: 'offline – holt nach', tone: 'off' },
  zurueckgestellt: { label: 'zurückgestellt', tone: 'off' },
  unbekannt: { label: 'unbekannt', tone: 'off' },
  im_update_verstummt: { label: 'im Update verstummt ⚠', tone: 'warn' },
  zurueckgerollt: { label: 'zurückgerollt ⚠', tone: 'warn' },
  fehlgeschlagen: { label: 'fehlgeschlagen ⚠', tone: 'warn' },
};

/**
 * Zustand → Beschriftung + Ton.
 *
 * Ein Zustand, den dieser Portal-Stand NICHT kennt, wird zu „unbekannt" mit
 * neutralem Ton: er könnte alles bedeuten, und „aktuell" wäre die eine
 * Behauptung, die er sicher nicht rechtfertigt. (Der Server verwirft schon
 * beim Ingest, was er nicht versteht - dies ist die zweite Hälfte derselben
 * Disziplin, für den Fall, dass der Server neuer ist als das Portal.)
 */
export function stateLabel(state: string | null | undefined): {
  label: string;
  tone: UpdateTone;
} {
  if (!state) return { label: 'unbekannt', tone: 'off' };
  return STATE_LABELS[state] ?? { label: 'unbekannt', tone: 'off' };
}

/** Zustände, die einen LAUTEN Hinweis verdienen (Warn-first, wie im Puls). */
export const LOUD_STATES = ['fehlgeschlagen', 'zurueckgerollt', 'im_update_verstummt'];

export function isLoud(state: string): boolean {
  return LOUD_STATES.includes(state);
}

/**
 * Der Banner über der Flotte: NUR wenn wirklich etwas laut ist, und er NENNT
 * die betroffenen Geräte. Ein Alarm ohne Adresse ist Lärm.
 */
export function loudBanner(fleet: FleetRow[]): string | null {
  const loud = fleet.filter((r) => isLoud(r.state));
  if (loud.length === 0) return null;
  const names = loud.slice(0, 3).map((r) => `${r.siteName} (${stateLabel(r.state).label})`);
  const more = loud.length > names.length ? ` und ${loud.length - names.length} weitere` : '';
  return `${loud.length === 1 ? 'Ein Gerät braucht' : `${loud.length} Geräte brauchen`} `
    + `Aufmerksamkeit: ${names.join(', ')}${more}.`;
}

/**
 * Die Puls-Kennzahl „Edge-Updates": `n/m aktuell · k Rollout aktiv ·
 * j fehlgeschlagen`.
 *
 * `m` ist die ERREICHBARE Menge (`known`), nicht die Flotte: über ein Gerät,
 * das nie gemeldet hat, ist nichts bekannt, und es in den Nenner zu nehmen
 * machte aus einer Wissenslücke eine schlechte Quote.
 */
export function kpiText(kpi: EdgeUpdatesKpi): string {
  const parts = [`${kpi.upToDate}/${kpi.known} aktuell`];
  if (kpi.inRollout > 0) parts.push(`${kpi.inRollout} im Rollout`);
  if (kpi.failed > 0) parts.push(`${kpi.failed} fehlgeschlagen`);
  return parts.join(' · ');
}

/** Der Ton der Puls-Karte: rot vor gelb vor ruhig. */
export function kpiTone(kpi: EdgeUpdatesKpi): UpdateTone {
  if (kpi.failed > 0) return 'warn';
  if (kpi.inRollout > 0) return 'busy';
  return 'ok';
}

/** Die Zusatzzeile der Puls-Karte, wenn Geräte gar nichts gemeldet haben. */
export function kpiUnknownNote(kpi: EdgeUpdatesKpi): string | null {
  if (kpi.unknown <= 0) return null;
  return kpi.unknown === 1
    ? '1 Gerät meldet keinen Stand (unbekannt, nicht veraltet).'
    : `${kpi.unknown} Geräte melden keinen Stand (unbekannt, nicht veraltet).`;
}

/** Der Zustand eines Rollouts in Worten. */
export function rolloutStateLabel(state: string): { label: string; tone: UpdateTone } {
  switch (state) {
    case 'active':
      return { label: 'läuft', tone: 'busy' };
    case 'paused':
      return { label: 'pausiert', tone: 'off' };
    case 'halted':
      return { label: 'eingefroren ⚠', tone: 'warn' };
    case 'done':
      return { label: 'abgeschlossen ✓', tone: 'ok' };
    default:
      return { label: 'unbekannt', tone: 'off' };
  }
}

/**
 * Warum „Nächste Welle" gesperrt ist - der Satz, der neben dem deaktivierten
 * Knopf steht. Der Server liefert ihn; fehlt er, wird KEINE Ursache erfunden.
 */
export function promoteHint(rollout: ActiveRollout | null): string | null {
  if (!rollout) return null;
  if (rollout.canPromote) return null;
  return rollout.promoteBlockedReason ?? 'Die nächste Welle ist gerade nicht freigegeben.';
}

/** Das Bake-Urteil eines Geräts als eine Zeile - oder null (nichts zu sagen). */
export function bakeLine(device: WaveDevice): string | null {
  if (!device.bakeCycle) return null;
  const parts: string[] = [];
  if (device.bakeRemainingMinutes != null && device.bakeRemainingMinutes > 0) {
    parts.push(`noch ${formatMinutes(device.bakeRemainingMinutes)} gesund`);
  } else if (device.state === 'bestaetigt') {
    parts.push('24 Std. gesund ✓');
  }
  switch (device.bakeCycle) {
    case 'erfuellt':
      parts.push('Steuerzyklus ✓');
      break;
    case 'nicht_pruefbar':
      // Ein Beleg, den es auf dieser Anlage strukturell nicht geben kann, wird
      // SICHTBAR ausgenommen - nie stillschweigend als erfüllt gewertet.
      parts.push('Steuerzyklus nicht prüfbar');
      break;
    case 'offen':
      parts.push('Steuerzyklus offen');
      break;
    default:
      break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} Min.`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} Std.` : `${h} Std. ${m} Min.`;
}

/** Ein Journal-Ereignis in einem deutschen Satz. */
const EVENT_LABELS: Record<string, string> = {
  rollout_created: 'Rollout gestartet',
  wave_released: 'Welle freigegeben',
  rollout_paused: 'Rollout pausiert',
  rollout_resumed: 'Rollout fortgesetzt',
  rollout_halted: 'Rollout eingefroren',
  rollout_auto_halted: 'Rollout AUTOMATISCH angehalten',
  rollout_done: 'Rollout abgeschlossen',
  rollout_last_wave: 'Letzte Welle freigegeben',
  target_assigned: 'Release zugewiesen',
  target_reverted: 'Zuweisung zurückgenommen',
  target_republished: 'Zuweisung erneut gesendet',
  target_cleared_on_unclaim: 'Zuweisung beim Entfernen des Geräts gelöscht',
  device_pinned_skipped: 'Gerät übersprungen (festgenagelt)',
  device_state: 'Zustand geändert',
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

/**
 * Wer hat gehandelt. `system` ist der Wächter - er wird als solcher benannt
 * und nie wie ein Mensch dargestellt, sonst wäre die Papier-Spur wertlos.
 */
export function actorLabel(actor: string): string {
  return actor === 'system' ? 'automatisch' : actor;
}

/**
 * Das Journal für die Anzeige: die reinen Zustands-Protokolle des Wächters
 * werden AUSGEBLENDET, sofern sie nicht laut sind.
 *
 * Begründung: `device_state` schreibt bei jedem echten Wechsel eine Zeile, und
 * eine Flotte im Rollout erzeugt davon Dutzende. Der „Verlauf" beantwortet
 * „wer hat wann welches Release wohin ausgerollt, und was ist daraus geworden"
 * (§7.1) - die ENTSCHEIDUNGEN und die ERGEBNISSE. Ein `fehlgeschlagen` oder
 * `zurueckgerollt` ist ein Ergebnis und bleibt drin.
 */
export function visibleJournal(journal: JournalEntry[]): JournalEntry[] {
  return journal.filter(
    (e) =>
      e.event !== 'device_state'
      || LOUD_STATES.some((s) => (e.detail ?? '').startsWith(s)),
  );
}

/**
 * Die Flotten-Matrix, sortiert: erst was Aufmerksamkeit braucht, dann was
 * gerade läuft, dann der Rest - innerhalb einer Gruppe nach Mandant/Anlage.
 * Dieselbe Warn-first-Ordnung wie im Flotten-Puls.
 */
const STATE_RANK: Record<string, number> = {
  fehlgeschlagen: 0,
  zurueckgerollt: 0,
  im_update_verstummt: 0,
  wendet_an: 1,
  laedt: 1,
  selbsttest: 1,
  ausstehend: 2,
  zurueckgestellt: 3,
  offline_holt_nach: 4,
  unbekannt: 5,
  bestaetigt: 6,
  aktuell: 6,
};

export function sortFleet(fleet: FleetRow[]): FleetRow[] {
  return [...fleet].sort((a, b) => {
    const ra = STATE_RANK[a.state] ?? 5;
    const rb = STATE_RANK[b.state] ?? 5;
    if (ra !== rb) return ra - rb;
    const t = a.tenantName.localeCompare(b.tenantName, 'de');
    if (t !== 0) return t;
    return a.siteName.localeCompare(b.siteName, 'de');
  });
}

/**
 * Ob ein Release ausgerollt werden DARF. Nur ein signiertes - ohne
 * Manifest-Bytes hat ein Gerät nichts, was es gegen seine eingebackene Wurzel
 * prüfen kann. Die api lehnt es ohnehin ab (409); der Knopf zeigt es vorher.
 */
export function canRollOut(release: EdgeUpdatesRelease): boolean {
  return release.signed;
}

/** Der Signatur-Status eines Registereintrags in Worten. */
export function signatureLabel(release: EdgeUpdatesRelease): {
  label: string;
  tone: UpdateTone;
} {
  return release.signed
    ? { label: `signiert (${release.signingKeyId ?? 'unbekannter Schlüssel'})`, tone: 'ok' }
    : { label: 'nicht signiert', tone: 'off' };
}
