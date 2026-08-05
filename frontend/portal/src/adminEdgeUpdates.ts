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

/**
 * Die VIER Zustandsklassen der Beobachtungs-Grammatik (UX-Konzept
 * `vp-admin-geraete-ux-k2` §5) - der Kern des Umbaus.
 *
 * Bis hierher trugen drei grundverschiedene Situationen dasselbe Kleid: die
 * Zuweisung ist unterwegs, der ADMIN ist der fehlende Akteur, und die Autonomie
 * ist blockiert - alle drei als busy-blaues „ausstehend". Ein stehender Blocker
 * sah damit aus wie Fortschritt, der gleich weitergeht, und der eine Zustand,
 * in dem sich OHNE eine Handlung nie wieder etwas bewegt, war von „läuft" nicht
 * zu unterscheiden.
 *
 * - `busy` läuft von SELBST (einziger animierter Zustand - die Animation ist
 *   das Versprechen „hier bewegt sich etwas ohne Sie").
 * - `action` heißt SIE sind dran: statisch, denn es bewegt sich nichts, bis
 *   jemand handelt. Trägt immer einen Weg.
 * - `blocked` ist eine Sperre oder ein Politik-Halt: kein Vorfall, hält keinen
 *   Rollout an - sieht aber nie wieder wie Fortschritt aus.
 * - `incident` ist laut und trägt seinen Grund.
 * - `calm` bleibt ruhig; „offline" ist ausdrücklich KEIN Alarm (NAT-Normalfall).
 */
export type StateClass = 'busy' | 'action' | 'blocked' | 'incident' | 'calm';

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
  /** Der Name zum ZUWEISUNGS-Zeitpunkt bzw. von heute - nie eine UUID. */
  label: string | null;
  siteName: string | null;
  tenantName: string | null;
  state: string;
  reason: string | null;
  since: string | null;
  bakeRemainingMinutes: number | null;
  bakeCycle: string | null;
  bakeReason: string | null;
  /** Dieses Gerät hat die Plattform verlassen (Unclaim), die Welle bleibt. */
  removed?: boolean;
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

/**
 * Was mit dem ANWENDEN dieses Geräts gerade ist (Portal-Apply, §6/E3).
 *
 * Er steht NEBEN `state`, nicht darin: `state` beantwortet „was ist mit dem
 * GERÄT", dieser Block „was ist mit der FREIGABE".
 */
export interface DeviceApply {
  /**
   * Die vom GERÄT gemeldete Fähigkeit, eine Freigabe aufzugreifen -
   * DREIWERTIG: `null` = ein älterer Edge-Stand meldet sie nicht, also
   * unbekannt (NIE „geht nicht"); `false` = die Box sagt selbst, dass dort
   * gerade nichts angewandt werden kann; `true` = sie würde aufgreifen.
   */
  canApply: boolean | null;
  /** `erteilt` · `abgeholt` · `verfallen` - `null`, solange es keine gibt. */
  state: string | null;
  reason: string | null;
  release: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
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
  channel: string | null;
  pinned: boolean;
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
  apply?: DeviceApply | null;
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
  /** Geräte im Zustand „wartet auf Anwendung" plus eine freigebbare Welle. */
  waitingForAdmin?: number;
  newestRelease: string | null;
}

export interface EdgeUpdates {
  releases: EdgeUpdatesRelease[];
  activeRollout: ActiveRollout | null;
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
  wartet_auf_anwendung: { label: 'wartet auf Sie', tone: 'busy', cls: 'action' },
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
  // „Sie sind dran" gehört auf die Landing-Seite, sonst bleibt der eine
  // Zustand, in dem sich ohne den Betreiber nie wieder etwas bewegt,
  // unsichtbar, bis jemand die Update-Seite öffnet. Ein ÄLTERES Backend ohne
  // das Feld schweigt hier - es wird nichts gezählt, was niemand gemeldet hat.
  const waiting = kpi.waitingForAdmin ?? 0;
  if (waiting > 0) {
    parts.push(waiting === 1 ? '1 Aktion wartet auf Sie'
      : `${waiting} Aktionen warten auf Sie`);
  }
  return parts.join(' · ');
}

/**
 * Der Ton der Puls-Karte: rot vor „Sie sind dran" vor gelb vor ruhig.
 *
 * Eine wartende Handlung schlägt den Fortschritts-Ton bewusst: „läuft" ist
 * dort die eine Aussage, die nicht stimmt.
 */
export function kpiTone(kpi: EdgeUpdatesKpi): UpdateTone {
  if (kpi.failed > 0) return 'warn';
  if ((kpi.waitingForAdmin ?? 0) > 0) return 'busy';
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
  // „Sie sind dran" steht direkt hinter den Vorfällen: es ist das Einzige, was
  // ohne den Betreiber nie von selbst weitergeht.
  wartet_auf_anwendung: 1,
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
 * Der Name einer Wellen-Zeile - **nie eine UUID**.
 *
 * Die Wellen-Definition wird beim Start eingefroren; verschwindet ein Gerät
 * danach von der Plattform (Unclaim + Re-Claim prägt eine NEUE Geräte-Id), fiel
 * die Zeile bis hierher auf `id.toString()` zurück und stand als nackte
 * `cdba2ee8-91f3-4c…` mitten zwischen Klarnamen (Reibung R2 vom 04.08.2026).
 *
 * Der Server liefert seit dem Umbau einen NAMENS-Schnappschuss vom
 * Zuweisungs-Zeitpunkt; fehlt auch der (ein Rollout von vor der Migration),
 * wird das ausdrücklich GESAGT statt eine Kennung zu rendern, die die Frage der
 * Zeile („welche Anlage?") gar nicht beantwortet. Die Kurzform der Id steht nur
 * als Wiedererkennungs-Hilfe dahinter, nie allein.
 */
export function waveDeviceName(device: WaveDevice): { name: string; removed: boolean } {
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

/** Eine Sache, die auf den Betreiber wartet. */
export interface HandelnItem {
  kind: 'wave' | 'apply';
  key: string;
  title: string;
  /** Was der Beleg ist bzw. was das Gerät gemeldet hat. */
  detail: string;
  /** Der WEG - ohne ihn ist „Sie sind dran" nur ein Vorwurf. */
  how: string | null;
  deviceId: string | null;
  /**
   * Der Apply-Knopf dieser Zeile (nur bei `kind: 'apply'`). Seit dem
   * Portal-Apply ist der WEG in den meisten Fällen ein Knopf statt einer
   * Anleitung - `how` bleibt für die Box, der er nachweislich nicht hilft.
   */
  apply?: ApplyView;
}

/**
 * Der Weg AM GERÄT - seit dem Portal-Apply nur noch der Rückfall.
 *
 * Er steht dort, wo das Portal nachweislich nicht helfen kann (die Box meldet
 * selbst, dass sie nichts anwenden kann). Ihn immer zu zeigen, hieße einen
 * Umweg zu empfehlen, den es nicht mehr braucht; ihn nie zu zeigen, ließe
 * genau die Box im Regen stehen, die den Knopf nicht bedienen kann.
 */
export const APPLY_HOW =
  'Hier hilft nur der Weg am Gerät: Geräteseite der Box (Port 8484) → „Jetzt '
  + 'anwenden" - mit Selbsttest und automatischer Rücknahme.';

/** Die Aussagen einer erteilten Freigabe (Portal-Apply). */
const APPROVAL_LABELS: Record<string, { label: string; tone: UpdateTone }> = {
  erteilt: { label: 'Freigabe erteilt', tone: 'busy' },
  abgeholt: { label: 'Freigabe abgeholt', tone: 'ok' },
  verfallen: { label: 'Freigabe nicht abgeholt', tone: 'warn' },
};

/** Was der „Auf Gerät anwenden"-Knopf dieser Zeile darf und sagen muss. */
export interface ApplyView {
  /** Darf der Knopf gedrückt werden? */
  canClick: boolean;
  /** Die Beschriftung - sie sagt IMMER, was gerade Sache ist. */
  label: string;
  /**
   * Was VOR dem Klick gesagt werden muss, weil es die Anwendung verhindern
   * WIRD (eine stehende Sperre, z. B. die Neutral-Zeit einer steuernden
   * Anlage). Der Knopf bleibt trotzdem bedienbar - die Entscheidung gehört dem
   * Betreiber, nicht dieser Funktion.
   */
  warn: string | null;
  /** Der ehrliche Hinweis, wenn das Portal nicht helfen kann. */
  hint: string | null;
  /** Der Zustand einer schon ERTEILTEN Freigabe - `null`, wenn es keine gibt. */
  approval: { state: string; label: string; tone: UpdateTone; reason: string | null } | null;
}

/**
 * Die EINE Ableitung des Apply-Knopfes - rein, damit jede Fläche (Handeln-
 * Karte, Geräte-Drawer) dasselbe sagt.
 *
 * Vier Regeln, jede gegen einen konkreten Fehlgriff:
 *
 * 1. **Ein Knopf, der strukturell nichts bewirken kann, wird nicht angeboten.**
 *    Meldet die Box `canApply: false`, steht dort der Weg am Gerät - nicht ein
 *    Knopf, der in eine stille Verweigerung läuft.
 * 2. **Unbekannt ist nicht „nein".** Ein älterer Edge-Stand meldet die
 *    Fähigkeit gar nicht; ihm den Knopf zu verweigern hieße, eine Box zu
 *    sperren, die ihn sehr wohl bedienen kann. Der Knopf bleibt - mit einem
 *    ehrlichen Hinweis.
 * 3. **Was die Anwendung verhindern WIRD, wird VORHER gesagt.** Eine stehende
 *    Sperre (Neutral-Zeit einer steuernden Anlage, Platte, Interlock …) nennt
 *    ihren Hebel, bevor jemand klickt - sonst ist die Verweigerung danach ein
 *    Rätsel.
 * 4. **Eine offene Freigabe wird nicht doppelt erteilt.** Der Server lehnt das
 *    ohnehin ab (409); der Knopf sagt es vorher.
 */
export function applyView(row: {
  state?: string | null;
  blocker?: string | null;
  reason?: string | null;
  apply?: DeviceApply | null;
  soll?: string | null;
}): ApplyView {
  const apply = row.apply ?? null;
  const approvalState = apply?.state ?? null;
  const approval = approvalState
    ? {
        state: approvalState,
        label: APPROVAL_LABELS[approvalState]?.label ?? approvalState,
        tone: APPROVAL_LABELS[approvalState]?.tone ?? ('off' as UpdateTone),
        reason: apply?.reason ?? null,
      }
    : null;

  const base: ApplyView = {
    canClick: false,
    label: 'Auf Gerät anwenden',
    warn: null,
    hint: null,
    approval,
  };

  // Ohne Zuweisung gibt es nichts anzuwenden.
  if (!row.soll) {
    return { ...base, label: 'Kein Release zugewiesen' };
  }
  // Eine gebrochene Kette ist ein Sicherheits-Ereignis, kein „probier es halt".
  if (row.state === 'fehlgeschlagen' || row.state === 'zurueckgerollt') {
    return {
      ...base,
      label: 'Anwenden nicht möglich',
      hint: row.reason
        ?? 'Dieses Gerät meldet einen Fehlschlag - erst den Grund klären.',
    };
  }
  if (approvalState === 'erteilt') {
    return {
      ...base,
      label: 'Freigabe läuft',
      hint: apply?.reason ?? null,
    };
  }
  if (apply?.canApply === false) {
    return { ...base, label: 'Gerät kann gerade nicht anwenden', hint: APPLY_HOW };
  }

  const warn = row.blocker
    ? (blockerLever(row.blocker)
      ?? row.reason
      ?? 'Dieses Gerät meldet eine stehende Sperre.')
    : null;
  return {
    ...base,
    canClick: true,
    warn,
    hint: apply?.canApply === undefined || apply?.canApply === null
      ? 'Diese Box meldet (noch) nicht, ob sie eine Freigabe aufgreifen kann - '
        + 'ein älterer Stand. Die Freigabe geht trotzdem hinaus.'
      : null,
  };
}

/**
 * Die „Sie sind dran"-Karte: alles, was gerade auf den Betreiber wartet, an
 * EINEM Ort - mit Ort und Weg.
 *
 * Bis hierher hatte dieser Job kein Zuhause (§2 J6): Welle-freigeben versteckte
 * sich in einem Knopf unter dem Board, Anwenden-am-Gerät in einem Geräte-Satz
 * in einer Zeile. Beides sind Handlungen, ohne die sich nie wieder etwas
 * bewegt - und genau das sagte keine Fläche.
 *
 * **Leer heißt: die Karte verschwindet.** Sie ist nie ein Dauer-Banner.
 */
export function handelnItems(data: EdgeUpdates | null): HandelnItem[] {
  if (!data) return [];
  const items: HandelnItem[] = [];
  const rollout = data.activeRollout;
  if (rollout && rollout.canPromote) {
    const next = rollout.waves.find((w) => w.index === rollout.currentWave + 1);
    const current = rollout.waves.find((w) => w.index === rollout.currentWave);
    items.push({
      kind: 'wave',
      key: `wave-${rollout.id}-${rollout.currentWave + 1}`,
      title: next
        ? `Welle ${next.index} „${next.name}" freigeben`
        : 'Nächste Welle freigeben',
      detail: bakeProof(current),
      how: null,
      deviceId: null,
    });
  }
  for (const row of data.fleet) {
    if (row.state !== 'wartet_auf_anwendung') continue;
    const view = applyView(row);
    // Eine LAUFENDE Freigabe wartet auf das Gerät, nicht auf den Betreiber -
    // sie gehört damit nicht in eine Karte namens „Sie sind dran".
    if (view.approval?.state === 'erteilt') continue;
    const verfallen = view.approval?.state === 'verfallen';
    items.push({
      kind: 'apply',
      key: `apply-${row.deviceId}`,
      title: `${row.siteName}${row.tenantName ? ` · ${row.tenantName}` : ''}: `
        + (verfallen ? 'Freigabe erneut erteilen' : 'Release anwenden'),
      detail: verfallen
        ? (view.approval?.reason
          ?? 'Die letzte Freigabe ist abgelaufen, ohne dass das Gerät sie abgeholt hat.')
        : (row.soll
          ? `${row.soll} ist auf diesem Gerät verifiziert.`
          : 'Das zugewiesene Release ist auf diesem Gerät verifiziert.'),
      how: view.hint,
      deviceId: row.deviceId,
      apply: view,
    });
  }
  return items;
}

/** Wie viele Geräte-Belege die Karte nennt, bevor sie zusammenfasst. */
const MAX_PROOF_DEVICES = 2;

/**
 * Der BELEG unter „Welle freigeben": warum ist das Bake-Kriterium erfüllt?
 *
 * Zwei Regeln, beide gegen einen konkreten Fehlgriff:
 *
 * 1. **Belegt wird nur an BESTÄTIGTEN Geräten.** Eine Welle kann Geräte
 *    enthalten, deren Zyklus noch offen ist (übersprungene Pins, offline);
 *    ihre Zeilen als Beleg zu nennen, während der Satz „das Bake-Kriterium ist
 *    erfüllt" darüber steht, wäre ein sichtbarer Selbstwiderspruch.
 * 2. **Zwei Belege, dann eine Zahl.** Eine Welle mit zehn Geräten erzeugte
 *    sonst eine Kette aus zehn gleichlautenden Halbsätzen - der Beleg ginge im
 *    Rauschen unter, das er widerlegen soll.
 *
 * Die ENTSCHEIDUNG selbst kommt weiterhin ausschließlich vom Server
 * (`canPromote`); dies ist nur ihre Begründung in Worten.
 */
function bakeProof(wave: Wave | undefined): string {
  const plain = 'Das Bake-Kriterium der laufenden Welle ist erfüllt.';
  if (!wave) return plain;
  const confirmed = wave.devices.filter((d) => d.state === 'bestaetigt');
  const lines: string[] = [];
  for (const d of confirmed) {
    const line = bakeLine(d);
    if (!line) continue;
    const name = waveDeviceName(d).name;
    const entry = `${name}: ${line}`;
    if (!lines.includes(entry)) lines.push(entry);
  }
  if (lines.length === 0) return plain;
  const shown = lines.slice(0, MAX_PROOF_DEVICES);
  const more = lines.length - shown.length;
  const rest = more > 0 ? ` (und ${more} weitere)` : '';
  return `${shown.join(' · ')}${rest} - das Bake-Kriterium ist erfüllt.`;
}

/** Ein Abschnitt des Fortschritts-Rückgrats. */
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
  { cls: 'action', label: 'wartet auf Sie' },
  { cls: 'blocked', label: 'blockiert' },
  { cls: 'incident', label: 'Vorfall' },
];

/**
 * Das Fortschritts-Rückgrat EINES Rollouts: wo steht die Verteilung?
 *
 * Gezählt wird der LIVE-Zustand (aus der Flotte), nicht der historische der
 * Wellen-Zeile - eine Fläche, eine Wahrheit. **Offline und unbekannt stehen
 * NEBEN der Quote, nie in ihrem Nenner** (die bestehende Quoten-Regel: ein
 * Gerät hinter NAT ist der Normalfall einer Verteilung, kein Rückstand).
 */
export function progressBackbone(data: EdgeUpdates | null): ProgressView | null {
  const rollout = data?.activeRollout;
  if (!data || !rollout) return null;
  const live = new Map(data.fleet.map((r) => [r.deviceId, r.state]));
  const counts = new Map<StateClass, number>();
  let offline = 0;
  let unknown = 0;
  let total = 0;
  for (const wave of rollout.waves) {
    for (const d of wave.devices) {
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
 * Die Rahmung eines eingefrorenen/abgeschlossenen Rollouts als ABSCHLUSSBILD.
 *
 * Die Zwei-Wahrheiten-Reibung (§1 Nr. 3) entstand nicht aus falschen Daten,
 * sondern aus GLEICHRANGIGKEIT: das Wellen-Board zeigt den persistierten
 * Zustand vom Zeitpunkt des Einfrierens, die Flotte daneben den heutigen. Als
 * Nachbarn liest sich das als Widerspruch. Ab hier führt überall die
 * LIVE-Wahrheit, und die Geschichte steht als gedämpfte Fußnote darunter.
 */
export function frozenFraming(rollout: ActiveRollout | null): {
  frozen: boolean;
  headline: string;
  note: string;
} | null {
  if (!rollout) return null;
  if (rollout.state !== 'halted' && rollout.state !== 'done') return null;
  return {
    frozen: rollout.state === 'halted',
    headline: rollout.state === 'halted' ? 'Abschlussbild - eingefroren'
      : 'Abschlussbild - abgeschlossen',
    note: 'Die Zeilen zeigen den HEUTIGEN Stand jedes Geräts; der Ausgang beim Abschluss '
      + 'steht darunter. Weitermachen ist ein neuer, bewusst gestarteter Rollout.',
  };
}

/**
 * Eine Wellen-Zeile: LIVE führt, die Geschichte ist Fußnote.
 *
 * `historyNote` entsteht nur, wenn der persistierte Ausgang vom heutigen
 * Zustand ABWEICHT - eine Fußnote, die dasselbe wiederholt, ist Rauschen.
 */
export function waveRowView(device: WaveDevice, fleet: FleetRow[], frozen: boolean): {
  state: string;
  reason: string | null;
  historyNote: string | null;
} {
  const liveRow = fleet.find((r) => r.deviceId === device.deviceId);
  const state = liveRow?.state ?? device.state;
  const reason = liveRow?.reason ?? device.reason;
  const differs = liveRow != null && liveRow.state !== device.state;
  return {
    state,
    reason,
    historyNote: frozen && differs
      ? `beim Abschluss: ${stateLabel(device.state).label}`
      : null,
  };
}

/**
 * Die eine ruhige Zeile, wenn kein Rollout läuft.
 *
 * Statt leerer Karten („Kein Rollout", „Noch nichts passiert") sagt die Seite
 * in einem Satz, wie die Flotte steht - und nennt Unbekanntes getrennt, statt
 * es als Rückstand zu zählen.
 */
export function restingLine(data: EdgeUpdates | null): string | null {
  if (!data || data.activeRollout) return null;
  const kpi = data.kpi;
  if (kpi.known === 0 && kpi.unknown === 0) {
    return 'Es ist kein Gerät verbunden. Kein Rollout aktiv.';
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
  return `${parts.join(' · ')}. Kein Rollout aktiv.`;
}

const NBSP = ' ';

/**
 * „Stand: vor X" - die Bezugszeit der gezeigten Daten.
 *
 * Sie gehört sichtbar auf ein BEOBACHTUNGS-Werkzeug: ohne sie ist nicht zu
 * unterscheiden, ob sich nichts bewegt oder ob nur niemand nachgesehen hat -
 * genau das „dauert das wirklich so lang?"-Gefühl vom 04.08.2026. Gerechnet
 * wird gegen die ANTWORTZEIT, nie gegen eine Uhr über einem stehenden
 * Schnappschuss (die Lebendigkeits-Lehre aus `liveness.ts`).
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
  /** Der bewährte Canary (D4): war er in Welle 1 des letzten Rollouts? */
  proven: boolean;
}

/**
 * Die Kandidaten für Welle 1 - **mit ihrem Zustand**, statt als nackte
 * Checkbox-Liste.
 *
 * Der behobene Befund (UX-Konzept §3 G): der Start-Drawer zeigte weder
 * Gerätezustand (offline? blockiert? Vertrauen offen?) noch einen Vorschlag.
 * Ein offline gewähltes Canary lässt Welle 1 still stehen - und niemand sieht,
 * warum.
 *
 * **Der Vorschlag ist eine BEOBACHTUNG, keine Empfehlung aus dem Nichts:**
 * „bewährt" heißt hier nachweislich „stand in Welle 1 des letzten Rollouts"
 * (D4: der eingespielte Canary). Ohne einen vorherigen Rollout wird nichts
 * vorgeschlagen - die AUSWAHL bleibt in jedem Fall Handarbeit.
 */
export function candidates(
  fleet: FleetRow[],
  rollout: ActiveRollout | null,
): CandidateView[] {
  const provenIds = new Set(
    (rollout?.waves.find((w) => w.index === 1)?.devices ?? []).map((d) => d.deviceId),
  );
  return sortFleet(fleet).map((row) => {
    const st = stateLabel(row.state);
    const cross = crossoverState(row.trust);
    let caveat: string | null = null;
    if (row.pinned) {
      caveat = 'festgenagelt - ein Rollout überspringt dieses Gerät sichtbar';
    } else if (row.state === 'offline_holt_nach') {
      caveat = 'meldet sich gerade nicht - eine Welle 1 aus diesem Gerät stünde still';
    } else if (row.state === 'blockiert' || row.state === 'zurueckgestellt') {
      caveat = 'kann gerade nicht anwenden';
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
      proven: provenIds.has(row.deviceId),
    };
  });
}

/**
 * Die Zusammenfassung VOR dem Start - was dieser Klick konkret auslöst.
 *
 * Sie nennt ausdrücklich auch, was NICHT passiert (ein festgenageltes Gerät
 * wird übersprungen, ein offline gegangenes holt nach): beides sieht später
 * wie ein Fehler aus, wenn es hier nicht angekündigt wurde.
 */
export function startSummary(
  canaryIds: string[],
  fleet: FleetRow[],
): string[] {
  const byId = new Map(fleet.map((r) => [r.deviceId, r]));
  const canaryNames = canaryIds
    .map((id) => byId.get(id)?.siteName)
    .filter((n): n is string => !!n);
  const rest = fleet.filter((r) => !canaryIds.includes(r.deviceId));
  const lines: string[] = [];
  if (canaryNames.length > 0) {
    lines.push(`Welle 1 „Canary": ${canaryNames.join(', ')} - wird SOFORT zugewiesen.`);
  }
  if (rest.length > 0) {
    lines.push(`Welle 2 „Flotte": ${rest.length} Gerät${rest.length === 1 ? '' : 'e'} - `
      + 'erst nach Ihrer Freigabe.');
  }
  const pinned = fleet.filter((r) => r.pinned).length;
  if (pinned > 0) {
    lines.push(`${pinned} festgenagelt${pinned === 1 ? 'es Gerät wird' : 'e Geräte werden'} `
      + 'übersprungen, nicht überschrieben.');
  }
  const offline = fleet.filter((r) => r.state === 'offline_holt_nach').length;
  if (offline > 0) {
    lines.push(`${offline} Gerät${offline === 1 ? '' : 'e'} meldet sich gerade nicht - die `
      + 'Zuweisung liegt beim Broker bereit und wird nachgeholt.');
  }
  return lines;
}
