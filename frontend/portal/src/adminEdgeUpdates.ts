/**
 * Die REINE Schicht der Plattform-Seite „Edge-Updates": aus dem einen
 * Server-Aggregat werden hier Wörter, Töne und Sortierungen - und sonst
 * nirgends.
 *
 * **Die Ehrlichkeitsregeln stehen SERVER-seitig** (`RolloutStates` in
 * `services/api`): welcher Zustand gilt und warum. Diese Datei erfindet keinen
 * davon nach - sie ÜBERSETZT. Dieselbe Trennung wie beim Flotten-Puls: eine
 * Frage darf nicht zwei Antworten haben.
 *
 * Seit dem Ein-Schritt-Umbau („Release wählen, Geräte wählen, fertig") gibt es
 * hier KEINE Wellen, keine Bake-Zeile, keinen Freigabe-Knopf und keinen
 * Not-Aus mehr: das Portal ENTSCHEIDET, das Gerät WENDET SELBST AN, und diese
 * Seite BEOBACHTET.
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

/**
 * Die VIER Zustandsklassen der Beobachtungs-Grammatik (UX-Konzept
 * `vp-admin-geraete-ux-k2` §5).
 *
 * - `busy` läuft von SELBST (einziger animierter Zustand - die Animation ist
 *   das Versprechen „hier bewegt sich etwas ohne Sie"). Seit dem
 *   Ein-Schritt-Umbau ist das der Normalfall einer Zuweisung: das Gerät wendet
 *   von allein an, niemand wartet auf einen Menschen.
 * - `blocked` ist eine Sperre oder ein Politik-Halt: kein Vorfall, hält NICHTS
 *   an - sieht aber nie wieder wie Fortschritt aus.
 * - `incident` ist laut und trägt seinen Grund. Er ist INFORMATION, keine
 *   Sperre: eine erneute Zuweisung versucht es einfach wieder.
 * - `calm` bleibt ruhig; „offline" ist ausdrücklich KEIN Alarm (NAT-Normalfall).
 */
export type StateClass = 'busy' | 'blocked' | 'incident' | 'calm';

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

export interface RolloutDevice {
  deviceId: string;
  /** Der Name zum ZUWEISUNGS-Zeitpunkt bzw. von heute - nie eine UUID. */
  label: string | null;
  siteName: string | null;
  tenantName: string | null;
  state: string;
  reason: string | null;
  since: string | null;
  /** Dieses Gerät hat die Plattform verlassen (Unclaim), der Eintrag bleibt. */
  removed?: boolean;
}

/**
 * EINE laufende oder abgeschlossene Aktualisierung.
 *
 * Seit dem Ein-Schritt-Umbau gibt es keine Wellen, keine Freigabe-Stufe und
 * keinen Not-Aus mehr: ein Klick weist ALLEN gewählten Geräten das Release zu,
 * und die Geräte wenden es selbst an. Mehrere Aktualisierungen dürfen
 * nebeneinander laufen - die Zuweisung je Gerät ist die Wahrheit.
 */
export interface Rollout {
  id: string;
  releaseVersion: string;
  releaseSeq: number;
  state: string;
  createdBy: string | null;
  createdAt: string;
  total: number;
  confirmed: number;
  failed: number;
  devices: RolloutDevice[];
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
  /** Anzeige-Name: Gerätename, sonst die Referenz. */
  label: string;
  /** Die Referenz selbst - auf einem benannten Gerät NICHT dasselbe. */
  externalRef: string;
  siteId: string;
  siteName: string;
  tenantId: string;
  tenantName: string;
  ist: string | null;
  soll: string | null;
  sollSeq: number | null;
  state: string;
  reason: string | null;
  /**
   * Der maschinenlesbare Name einer stehenden Sperre (`otaapply.Blocker*`).
   * `null` heißt „kein Name gemeldet" - der Zustand `blockiert` kann trotzdem
   * gelten (ein älterer Edge-Stand meldet nur den deutschen Satz).
   */
  blocker?: string | null;
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
  rollouts: Rollout[];
  fleet: FleetRow[];
  journal: JournalEntry[];
  kpi: EdgeUpdatesKpi;
}

/** Beschriftung + Ton + Klasse eines Geräte-Zustands (§7.2, §5-Grammatik). */
const STATE_LABELS: Record<string, { label: string; tone: UpdateTone; cls: StateClass }> = {
  aktuell: { label: 'aktuell', tone: 'ok', cls: 'calm' },
  bestaetigt: { label: 'bestätigt ✓', tone: 'ok', cls: 'calm' },
  ausstehend: { label: 'ausstehend', tone: 'busy', cls: 'busy' },
  laedt: { label: 'lädt', tone: 'busy', cls: 'busy' },
  wendet_an: { label: 'wendet an', tone: 'busy', cls: 'busy' },
  selbsttest: { label: 'Selbsttest', tone: 'busy', cls: 'busy' },
  blockiert: { label: 'blockiert', tone: 'warn', cls: 'blocked' },
  offline_holt_nach: { label: 'offline – holt nach', tone: 'off', cls: 'calm' },
  zurueckgestellt: { label: 'zurückgestellt', tone: 'off', cls: 'blocked' },
  unbekannt: { label: 'unbekannt', tone: 'off', cls: 'calm' },
  im_update_verstummt: { label: 'im Update verstummt ⚠', tone: 'warn', cls: 'incident' },
  zurueckgerollt: { label: 'zurückgerollt ⚠', tone: 'warn', cls: 'incident' },
  fehlgeschlagen: { label: 'fehlgeschlagen ⚠', tone: 'warn', cls: 'incident' },
};

/**
 * Zustand → Beschriftung + Ton + Klasse.
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
  cls: StateClass;
} {
  if (!state) return { label: 'unbekannt', tone: 'off', cls: 'calm' };
  return STATE_LABELS[state] ?? { label: 'unbekannt', tone: 'off', cls: 'calm' };
}

/**
 * Der HEBEL zu einer Sperre - das, was den Blocker aufhebt.
 *
 * Er kommt aus dem maschinenlesbaren Namen (`update.blocker`), nie aus einer
 * Stichwortsuche im deutschen Grund. Ein Name, den dieser Portal-Stand nicht
 * kennt, bekommt KEINEN Hebel: der Grund des Geräts steht ohnehin daneben und
 * ist die Aussage - ein geratener Hebel wäre eine Anweisung ins Leere.
 */
const BLOCKER_LEVERS: Record<string, string> = {
  neutralzeit:
    'Neutral-Zeit der Wechselrichter-Familie am Prüfstand belegen und in '
    + 'VP_OTA_NEUTRAL_VERIFIED eintragen.',
  neutralzeit_zu_kurz:
    'Die belegte Neutral-Zeit lässt keine brauchbare Wachhund-Frist zu - Wert am '
    + 'Prüfstand überprüfen.',
  platte: 'Platz auf dem Datenträger der Box schaffen.',
  interlock:
    'Die Anlage führt gerade einen Sollwert aus. Sie wird von selbst wieder frei - '
    + 'oder das Release wird als eilig markiert.',
  kern_still: 'Der Kern meldet seinen Zustand nicht - Zustand der Box am Gerät prüfen.',
  kette: 'Signaturkette prüfen: Vertrauens-Set und Release-Signatur auf der Box.',
  politik:
    'Das Release gilt für diese Box nicht (Anti-Rollback-Boden oder Rückschritt) - '
    + 'ein passendes Release zuweisen.',
  zurueckgenommen:
    'Dieses Release wurde auf dieser Box schon einmal zurückgenommen und läuft nie '
    + 'von selbst wieder an - ein ANDERES Release zuweisen.',
  backend: 'Das Release ist nicht für das Apply-Backend dieser Box bestimmt.',
  state_schema: 'Das Release kennt den Datenstand dieser Box nicht.',
  freigabe_release: 'Die erteilte Freigabe galt einem anderen Release.',
  laden: 'Die Images konnten nicht geladen werden - Registry-Zugang der Box prüfen.',
  rueckfallziel: 'Das Rückfallziel konnte nicht gesichert werden.',
  sicherung: 'Die Sicherung des Datenstands ist nicht gelungen.',
  unlesbar: 'Eine Protokoll-Datei der Box ist unlesbar.',
};

export function blockerLever(blocker: string | null | undefined): string | null {
  if (!blocker) return null;
  return BLOCKER_LEVERS[blocker] ?? null;
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

/**
 * Der Ton der Puls-Karte: rot vor gelb vor ruhig.
 *
 * Ein Fehlschlag ist INFORMATION, keine Sperre - er hält seit dem
 * Ein-Schritt-Umbau nichts an, verdient aber den lauten Ton.
 */
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

/** Der Zustand einer Aktualisierung in Worten. */
export function rolloutStateLabel(state: string): { label: string; tone: UpdateTone } {
  switch (state) {
    case 'active':
      return { label: 'läuft', tone: 'busy' };
    case 'done':
      return { label: 'abgeschlossen ✓', tone: 'ok' };
    default:
      return { label: 'unbekannt', tone: 'off' };
  }
}
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
  apply_requested: 'Anwendung freigegeben',
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
  blockiert: 2,
  wendet_an: 3,
  laedt: 3,
  selbsttest: 3,
  ausstehend: 4,
  zurueckgestellt: 5,
  offline_holt_nach: 6,
  unbekannt: 7,
  bestaetigt: 8,
  aktuell: 8,
};

export function sortFleet(fleet: FleetRow[]): FleetRow[] {
  return [...fleet].sort((a, b) => {
    const ra = STATE_RANK[a.state] ?? 7;
    const rb = STATE_RANK[b.state] ?? 7;
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

// ── Beobachten: Namen, Handeln, Fortschritt, Frische ───────────────────────

/**
 * Der Name eines Geräts in einer Aktualisierungs-Zeile - **nie eine UUID**.
 *
 * Der Server liefert einen NAMENS-Schnappschuss vom Zuweisungs-Zeitpunkt;
 * fehlt er, wird das ausdrücklich GESAGT statt eine Kennung zu rendern, die
 * die Frage der Zeile („welche Anlage?") gar nicht beantwortet. Die Kurzform
 * der Id steht nur als Wiedererkennungs-Hilfe dahinter, nie allein.
 */
export function rolloutDeviceName(device: RolloutDevice): { name: string; removed: boolean } {
  const shortId = device.deviceId ? device.deviceId.slice(0, 8) : '';
  const named = device.siteName ?? device.label ?? null;
  if (!named) {
    return { name: `Entferntes Gerät${shortId ? ` (${shortId}…)` : ''}`, removed: true };
  }
  if (device.removed) {
    return { name: `${named} (entfernt)`, removed: true };
  }
  return { name: named, removed: false };
}
export interface ProgressSegment {
  cls: StateClass;
  label: string;
  count: number;
}

export interface ProgressView {
  /** Der Nenner: die ERREICHBARE Menge, ohne offline/unbekannt. */
  total: number;
  segments: ProgressSegment[];
  /** Was neben der Quote steht, statt im Nenner zu verschwinden. */
  asideNote: string | null;
}

const PROGRESS_ORDER: { cls: StateClass; label: string }[] = [
  { cls: 'calm', label: 'bestätigt' },
  { cls: 'busy', label: 'im Gang' },
  { cls: 'blocked', label: 'blockiert' },
  { cls: 'incident', label: 'Vorfall' },
];

/**
 * Das Fortschritts-Rückgrat EINER Aktualisierung: wo steht die Verteilung?
 *
 * Gezählt wird der LIVE-Zustand (aus der Flotte), nicht der historische der
 * Zeile - eine Fläche, eine Wahrheit. **Offline und unbekannt stehen NEBEN der
 * Quote, nie in ihrem Nenner** (die bestehende Quoten-Regel: ein Gerät hinter
 * NAT ist der Normalfall einer Verteilung, kein Rückstand).
 */
export function progressBackbone(rollout: Rollout | null, fleet: FleetRow[]): ProgressView | null {
  if (!rollout) return null;
  const live = new Map(fleet.map((r) => [r.deviceId, r.state]));
  const counts = new Map<StateClass, number>();
  let offline = 0;
  let unknown = 0;
  let total = 0;
  for (const d of rollout.devices) {
    const state = live.get(d.deviceId) ?? d.state;
    if (state === 'offline_holt_nach') {
      offline += 1;
      continue;
    }
    if (state === 'unbekannt' || !live.has(d.deviceId)) {
      // Ein Gerät, über das nichts bekannt ist (oder das die Plattform
      // verlassen hat), zählt weder im Zähler noch im Nenner.
      unknown += 1;
      continue;
    }
    total += 1;
    const cls = stateLabel(state).cls;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  const segments = PROGRESS_ORDER
    .map((s) => ({ ...s, count: counts.get(s.cls) ?? 0 }))
    .filter((s) => s.count > 0);
  const aside: string[] = [];
  if (offline > 0) {
    aside.push(offline === 1 ? '1 offline – holt nach' : `${offline} offline – holen nach`);
  }
  if (unknown > 0) {
    aside.push(unknown === 1 ? '1 ohne Meldung' : `${unknown} ohne Meldung`);
  }
  return {
    total,
    segments,
    asideNote: aside.length > 0 ? `${aside.join(' · ')} (zählt nicht in die Quote)` : null,
  };
}
/**
 * Die eine ruhige Zeile, wenn gerade nichts läuft.
 *
 * Statt leerer Karten („Kein Rollout", „Noch nichts passiert") sagt die Seite
 * in einem Satz, wie die Flotte steht - und nennt Unbekanntes getrennt, statt
 * es als Rückstand zu zählen.
 */
export function restingLine(data: EdgeUpdates | null): string | null {
  if (!data || data.rollouts.length > 0) return null;
  const kpi = data.kpi;
  if (kpi.known === 0 && kpi.unknown === 0) {
    return 'Es ist kein Gerät verbunden. Gerade wird nichts aktualisiert.';
  }
  const parts: string[] = [];
  if (kpi.newestRelease) {
    parts.push(`${kpi.upToDate}/${kpi.known} Geräte auf ${kpi.newestRelease} ✓`);
  } else {
    parts.push('Kein Release im Register - ohne Maßstab wird kein Stand bewertet');
  }
  if (kpi.unknown > 0) {
    parts.push(kpi.unknown === 1
      ? '1 meldet keinen Stand (unbekannt, nicht veraltet)'
      : `${kpi.unknown} melden keinen Stand (unbekannt, nicht veraltet)`);
  }
  return `${parts.join(' · ')}. Gerade wird nichts aktualisiert.`;
}

const NBSP = '\u00a0';

/**
 * „Stand: vor X" - die Bezugszeit der gezeigten Daten.
 *
 * Sie gehört sichtbar auf ein BEOBACHTUNGS-Werkzeug: ohne sie ist nicht zu
 * unterscheiden, ob sich nichts bewegt oder ob nur niemand nachgesehen hat.
 * Gerechnet wird gegen die ANTWORTZEIT, nie gegen eine Uhr über einem
 * stehenden Schnappschuss (die Lebendigkeits-Lehre aus `liveness.ts`).
 */
export function freshnessLabel(fetchedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (secs < 5) return 'Stand: gerade eben';
  if (secs < 60) return `Stand: vor ${secs}${NBSP}Sek.`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Stand: vor ${mins}${NBSP}Min.`;
  return `Stand: vor ${Math.round(mins / 60)}${NBSP}Std.`;
}

// ── Rollout starten: der Kandidat und die Zusammenfassung ──────────────────

/** Wie tauglich ist dieses Gerät gerade als Canary? */
export interface CandidateView {
  deviceId: string;
  name: string;
  tenantName: string | null;
  /** Der Zustand in Worten (dieselbe Ableitung wie überall). */
  state: string;
  cls: StateClass;
  /** Was gegen dieses Gerät spricht - null heißt: nichts Bekanntes. */
  caveat: string | null;
}

/**
 * Die wählbaren Geräte - **mit ihrem Zustand**, statt als nackte Checkbox-Liste.
 *
 * Ein Einwand ist ein HINWEIS, nie eine Sperre: seit dem Ein-Schritt-Umbau gibt
 * es keine Vorbedingung mehr, die der Betreiber erst erfüllen müsste. Ein
 * offline gegangenes Gerät holt die Zuweisung beim nächsten Verbindungsaufbau
 * selbst ab (die Zuweisung liegt retained beim Broker) - es auszuschließen wäre
 * die alte Gängelung in neuer Form.
 */
export function candidates(fleet: FleetRow[]): CandidateView[] {
  return sortFleet(fleet).map((row) => {
    const st = stateLabel(row.state);
    const cross = crossoverState(row.trust);
    let caveat: string | null = null;
    if (row.state === 'offline_holt_nach') {
      caveat = 'meldet sich gerade nicht - die Zuweisung wird nachgeholt';
    } else if (row.state === 'unbekannt') {
      caveat = 'hat noch keinen Stand gemeldet';
    } else if (cross.state === 'offen' || cross.state === 'fehler') {
      caveat = 'Vertrauen noch nicht gekreuzt - dieses Gerät kann kein Release anwenden';
    }
    return {
      deviceId: row.deviceId,
      name: row.siteName,
      tenantName: row.tenantName,
      state: st.label,
      cls: st.cls,
      caveat,
    };
  });
}

/**
 * Die Zusammenfassung VOR dem Klick - was dieser eine Knopf konkret auslöst.
 *
 * Sie nennt ausdrücklich auch, was NICHT sofort passiert (ein offline
 * gegangenes Gerät holt nach): das sieht später wie ein Fehler aus, wenn es
 * hier nicht angekündigt wurde.
 */
export function startSummary(deviceIds: string[], fleet: FleetRow[]): string[] {
  const chosen = fleet.filter((r) => deviceIds.includes(r.deviceId));
  const lines: string[] = [];
  if (chosen.length === 0) return lines;
  lines.push(`${chosen.length} Gerät${chosen.length === 1 ? '' : 'e'} bekommen die Zuweisung `
    + 'SOFORT - und aktualisieren sich selbst.');
  const offline = chosen.filter((r) => r.state === 'offline_holt_nach').length;
  if (offline > 0) {
    lines.push(`${offline} Gerät${offline === 1 ? '' : 'e'} meldet sich gerade nicht - die `
      + 'Zuweisung liegt beim Broker bereit und wird nachgeholt.');
  }
  const uncrossed = chosen.filter((r) => {
    const c = crossoverState(r.trust).state;
    return c === 'offen' || c === 'fehler';
  }).length;
  if (uncrossed > 0) {
    lines.push(`${uncrossed} Gerät${uncrossed === 1 ? ' hat' : 'e haben'} das Vertrauen noch `
      + 'nicht gekreuzt und meldet dann einen Grund - es geht nichts verloren.');
  }
  lines.push('Es gibt keinen zweiten Schritt: niemand muss an ein Gerät.');
  return lines;
}
