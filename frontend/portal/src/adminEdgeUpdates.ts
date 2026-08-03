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
  /** OTA Stufe 4: läuft dieser Rollout mit automatischem Wellen-Vorschub? */
  autoAdvance?: boolean;
  /** Der Server-Satz, WARUM die nächste Welle gerade (nicht) kommt. */
  advanceNote?: string | null;
  waves: Wave[];
}

/**
 * Die vom Gerät GEPRÜFT gemeldete Vertrauens-Identität (OTA Stufe 4).
 *
 * `undefined`/`null` = ein älterer Edge-Stand meldet sie nicht → „unbekannt".
 * Ein Block MIT leerem `rootKeyIds` ist dagegen ein belegter Befund: das Image
 * trägt keine Wurzel, der TOFU-Crossover steht also aus.
 */
export interface DeviceTrust {
  rootKeyIds: string[];
  trustSetKeyIds: string[];
  trustSetGeneratedAt: string | null;
  trustSetError: string | null;
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
  trust?: DeviceTrust | null;
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

// ── OTA Stufe 4: Wellen-Automatik + TOFU-Abschluss ─────────────────────────

/**
 * In welchem Modus läuft dieser Rollout - und was passiert als Nächstes.
 *
 * Ohne diese Zeile wäre die Automatik ein UNSICHTBARER Zustand, und ein
 * Betreiber müsste raten, ob gerade auf ihn oder auf das Bake-Fenster gewartet
 * wird. Der SATZ kommt vom Server (`advanceNote`, dieselbe Quelle wie die
 * Bake-Begründung); erfunden wird hier nichts - ein älterer Server ohne das
 * Feld bekommt nur das Etikett und keine Behauptung darüber, was folgt.
 */
export function advanceMode(rollout: ActiveRollout | null): {
  label: string;
  tone: UpdateTone;
  note: string | null;
} | null {
  if (!rollout) return null;
  const auto = rollout.autoAdvance === true;
  return {
    label: auto ? 'Automatischer Wellen-Vorschub' : 'Wellen von Hand',
    // Bewusst kein Warn-Ton: die Automatik ist eine gewählte Betriebsart,
    // kein Befund. `busy` sagt „hier bewegt sich etwas von selbst".
    tone: auto ? 'busy' : 'off',
    note: rollout.advanceNote ?? null,
  };
}

/** Der TOFU-Stand EINES Geräts. */
export type CrossoverState = 'gekreuzt' | 'offen' | 'unbekannt' | 'fehler';

/**
 * Trägt dieses Gerät schon ein schlüsseltragendes Image?
 *
 * **Abwesenheit ist NIE ein Befund.** Ein älterer Edge-Stand meldet die
 * Vertrauens-Identität gar nicht - das ist „unbekannt" und wird ruhig
 * dargestellt, nie als Fehler und nie als „nicht gekreuzt". Ein Gerät MIT
 * Block und LEERER Wurzel-Liste ist dagegen ein belegter, dokumentierter
 * Zustand: der Crossover steht aus (`docs/ota-signing.md` §6) - auch das ist
 * kein Fehler, sondern eine offene Aufgabe.
 *
 * Rot wird es nur bei `fehler`: ein Gerät, das eine Wurzel trägt, aber ein
 * Vertrauens-Set abgelehnt hat - das ist ein Vorfall, keine offene Aufgabe.
 */
export function crossoverState(trust: DeviceTrust | null | undefined): {
  state: CrossoverState;
  label: string;
  tone: UpdateTone;
  detail: string | null;
} {
  if (!trust || !Array.isArray(trust.rootKeyIds)) {
    return {
      state: 'unbekannt',
      label: 'unbekannt',
      tone: 'off',
      detail: 'Dieser Stand meldet seinen Vertrauensanker noch nicht.',
    };
  }
  if (trust.rootKeyIds.length === 0) {
    return {
      state: 'offen',
      label: 'Crossover offen',
      tone: 'off',
      detail: 'Dieses Gerät fährt ein Image ohne eingebackenen Vertrauensanker. '
        + 'Der beaufsichtigte Crossover je Box steht noch aus.',
    };
  }
  if (trust.trustSetKeyIds.length === 0) {
    return {
      state: 'fehler',
      label: 'ohne Vertrauens-Set',
      tone: 'warn',
      detail: trust.trustSetError
        ?? 'Auf diesem Gerät liegt kein gültiges, root-signiertes Vertrauens-Set.',
    };
  }
  const stand = trust.trustSetGeneratedAt
    ? ` · Vertrauens-Set vom ${formatTrustStamp(trust.trustSetGeneratedAt)}`
    : '';
  return {
    state: 'gekreuzt',
    label: 'gekreuzt ✓',
    tone: 'ok',
    detail: `Wurzel: ${trust.rootKeyIds.join(', ')}${stand}`,
  };
}

/**
 * Die eine ruhige Zeile über der Flotte: „Crossover offen: n Geräte".
 *
 * Sie zählt NUR die belegt offenen (Block vorhanden, Wurzel leer) - ein Gerät,
 * das nichts meldet, ist unbekannt und wird getrennt genannt, weil man daraus
 * keine Aufgabe ableiten kann.
 */
export function crossoverHint(fleet: FleetRow[]): string | null {
  let offen = 0;
  let unbekannt = 0;
  let fehler = 0;
  for (const row of fleet) {
    const s = crossoverState(row.trust).state;
    if (s === 'offen') offen += 1;
    else if (s === 'unbekannt') unbekannt += 1;
    else if (s === 'fehler') fehler += 1;
  }
  const parts: string[] = [];
  if (offen > 0) {
    parts.push(offen === 1
      ? 'Crossover offen: 1 Gerät fährt noch ein Image ohne Vertrauensanker'
      : `Crossover offen: ${offen} Geräte fahren noch ein Image ohne Vertrauensanker`);
  }
  if (fehler > 0) {
    parts.push(fehler === 1
      ? '1 Gerät hat kein gültiges Vertrauens-Set'
      : `${fehler} Geräte haben kein gültiges Vertrauens-Set`);
  }
  if (unbekannt > 0) {
    parts.push(unbekannt === 1
      ? '1 Gerät meldet seinen Vertrauensanker nicht (unbekannt)'
      : `${unbekannt} Geräte melden ihren Vertrauensanker nicht (unbekannt)`);
  }
  return parts.length > 0 ? `${parts.join(' · ')}.` : null;
}

/**
 * Welche Vertrauens-Sets fährt die Flotte gerade - der Blick, den ein
 * Rotations-Drill braucht („haben alle Boxen das neue Set gesehen?").
 *
 * Gezählt werden nur Geräte mit einem GEPRÜFTEN Set; „unbekannt"/„offen"
 * erscheinen hier nicht, weil sie kein Set haben, über das sich reden ließe -
 * die trägt `crossoverHint`.
 */
export function trustSetSpread(fleet: FleetRow[]): { stamp: string; devices: number }[] {
  const counts = new Map<string, number>();
  for (const row of fleet) {
    const t = row.trust;
    if (!t || t.trustSetKeyIds.length === 0) continue;
    const key = t.trustSetGeneratedAt ?? 'ohne Stempel';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stamp, devices]) => ({ stamp, devices }))
    // Neueste zuerst; „ohne Stempel" ans Ende, weil es sich nicht einordnen lässt.
    .sort((a, b) => (a.stamp === 'ohne Stempel' ? 1 : b.stamp === 'ohne Stempel' ? -1
      : b.stamp.localeCompare(a.stamp)));
}

/** Ein RFC-3339-Stempel als deutsches Datum - unlesbar bleibt unverändert. */
export function formatTrustStamp(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
  wave_auto_released: 'Welle automatisch freigegeben',
  auto_advance_on: 'Wellen-Automatik eingeschaltet',
  auto_advance_off: 'Wellen-Automatik ausgeschaltet',
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
