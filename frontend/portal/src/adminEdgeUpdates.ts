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

/**
 * Die Bauart einer Box (`ota.BoxArt` in der API): die Docker-Box (`edge-app`)
 * oder Edge Light (`vp-edge-light`, z. B. auf dem GL.iNet Mango).
 */
export type BoxArt = 'docker' | 'light';

export interface EdgeUpdatesRelease {
  releaseSeq: number;
  version: string;
  targetCommit: string | null;
  notes: string | null;
  signed: boolean;
  signingKeyId: string | null;
  createdAt: string;
  runningOnDevices: number;
  /**
   * Für welche Box-Art das Release gebaut ist. Fehlt das Feld (älterer
   * Server), gilt es wie dort als Docker-Release.
   */
  boxArt?: BoxArt;
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
  /**
   * Die Box-Art aus der letzten Meldung, abgeleitet in der API (`ota.BoxArt`).
   * `null`/fehlend heißt „unbekannt" - nie still „Docker-Box".
   */
  boxArt?: string | null;
  // ── Geräte & Updates G1/G2 (additiv; fehlen bei einem älteren Server) ──
  /** Das letzte Lebenszeichen - die EINE Uhr für „online" (Herzschlag, Serverzeit). */
  lastSeenAt?: string | null;
  /** Die Linie, an der gemessen wird (`docker`/`light`); `null` = unbekannt. */
  linie?: BoxArt | null;
  /** Wo die Box in ihrer Linie steht (`ota.LinienStand`). */
  stand?: LinienStand;
  /** Edge Light ohne gekreuztes Vertrauen: nimmt keine Updates aus dem Portal an. */
  stufe1?: boolean;
  /** Das Register-Release, das die Box fährt; `null` = nicht registriert. */
  istRelease?: string | null;
  /** Wie viele Releases der Linie neuer sind; `null` = unbekannt. */
  releasesDahinter?: number | null;
  /** Seit wann der laufende Stand läuft (Serverzeit); `null` = unbekannt. */
  istSeit?: string | null;
  /** Angefragt · angenommen · bestätigt der aktuellen Anfrage; `null` = keine Anfrage. */
  fakten?: UpdateFakten | null;
  // ── Geräte & Updates G8 (additiv) ──
  /** Das Modell, wie die Box es meldet (`update.geraet`); `null` = nicht gemeldet. */
  geraetModell?: string | null;
  /** Die Architektur des laufenden Programms (amd64, arm64, mipsle …). */
  geraetArch?: string | null;
  /** Nur Edge Light: `update` (Loader kennt Updates, Stufe 2) oder `flash` (Stufe 1). */
  loader?: string | null;
}

/**
 * Der Linien-Stand einer Box (`ota.LinienStand`, Geräte & Updates G1). Ein
 * Wort, das dieser Portal-Stand nicht kennt, bleibt ein `string` und wird wie
 * `unbekannt` behandelt.
 */
export type LinienStand =
  | 'hand' | 'fehler' | 'offline' | 'laeuft' | 'gehalten' | 'aktuell' | 'aelter' | 'unbekannt'
  | (string & {});

/** Die drei Fakten einer Anfrage (`ota.UpdateFakten`, Geräte & Updates G2). */
export interface UpdateFakten {
  /** Angefragt (Portal): Release, Zeitpunkt, Person (JWT-Subjekt oder `system`). */
  angefragt: { release: string; releaseSeq: number; am: string | null; von: string | null };
  /** Angenommen (Box): `ja`, `offen`, `wartet`, `abgelehnt`, `zurueckgestellt`. */
  angenommen: { stand: string; am: string | null; grund: string | null };
  /**
   * Bestätigt (Box): `ja`, `offen`, `laeuft` (mit `schritt` `laedt`/`wendet_an`/
   * `selbsttest`), `fehlgeschlagen`, `zurueckgenommen`, `verstummt`.
   */
  bestaetigt: { stand: string; am: string | null; schritt: string | null; grund: string | null };
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

/**
 * Eine Software-Linie (Geräte & Updates S0, `EdgeUpdatesDto.LineDto`):
 * Docker-Box (`edge-JJJJ.MM.N`) oder Edge Light (`edge-light-JJJJ.MM.N`).
 *
 * `newestRelease` ist das neueste Release DIESER Linie (`null` = noch keines),
 * `devices` die Boxen der Linie (eine Box unbekannter Art zählt in keiner),
 * `known` davon die mit gemeldetem Stand, `upToDate` die auf dem neuesten
 * Release der Linie - dieselbe Regel wie auf der Kunden-Box-Seite.
 */
export interface EdgeUpdatesLine {
  boxArt: BoxArt;
  newestRelease: string | null;
  newestReleaseSeq: number | null;
  devices: number;
  known: number;
  upToDate: number;
  // ── Geräte & Updates G1 (additiv) ──
  /** Wie viele Releases die Linie im Register hat. */
  releases?: number;
  /** Boxen je Linien-Stand (`ota.LinienStand`, feste Reihenfolge, jede Gruppe genau einmal). */
  stand?: Record<string, number>;
  /**
   * Die Versionsleiter: je Release (oder nicht registriertem Stand,
   * `releaseSeq: null`) die Boxen, die es melden; registrierte neueste zuerst.
   */
  versions?: { version: string; releaseSeq: number | null; devices: string[] }[];
}

export interface EdgeUpdates {
  releases: EdgeUpdatesRelease[];
  rollouts: Rollout[];
  fleet: FleetRow[];
  journal: JournalEntry[];
  /**
   * ⚠ `kpi.upToDate`/`kpi.newestRelease` messen am neuesten Release über BEIDE
   * Linien (für ältere Portale unverändert). Das Urteil je Linie steht in
   * `lines` - fehlt das Feld (älterer Server), leitet `linienKarten` (`geraeteUpdates.ts`)
   * die Linie aus Register und Flotte ab.
   */
  kpi: EdgeUpdatesKpi;
  lines?: EdgeUpdatesLine[];
}

/**
 * Ein Eintrag im Verlauf einer Box (`GET /admin/devices/{id}/verlauf`, Geräte &
 * Updates G3), neueste zuerst. `quelle` `portal`: angefragt, zurueckgezogen,
 * erneut_gesendet, entfernt (`von` = Akteur). `quelle` `box`: stand (mit `vorher`;
 * `null` = erste Meldung), angenommen, abgelehnt, zurueckgestellt,
 * fehlgeschlagen, zurueckgenommen (mit dem Grund der Box). Serverzeit.
 */
export interface VerlaufEintrag {
  am: string;
  quelle: 'portal' | 'box' | (string & {});
  art: string;
  release: string | null;
  vorher: string | null;
  grund: string | null;
  von: string | null;
  rolloutId: string | null;
}
export interface BoxVerlauf {
  deviceId: string;
  eintraege: VerlaufEintrag[];
}

/**
 * Wer EIN Release bekommen kann (`GET /admin/edge-updates/eignung?releaseSeq=`,
 * Geräte & Updates G1): jede Box der Linie (und jede unbekannter Art) in GENAU
 * einer Gruppe - `bereit`, `wartet` (offline, holt die Anfrage retained ab),
 * `aktuell` oder `kann_nicht` mit dem Satz der Sperre. „Bereit" ist keine Zusage:
 * das Portal fragt an, die Box entscheidet.
 */
export interface EignungBox {
  deviceId: string;
  label: string | null;
  externalRef: string;
  siteName: string | null;
  tenantName: string | null;
  ist: string | null;
  gruppe: 'bereit' | 'wartet' | 'aktuell' | 'kann_nicht' | (string & {});
  grund: string | null;
  lastSeenAt: string | null;
}
export interface EdgeEignung {
  releaseSeq: number;
  version: string;
  boxArt: string;
  boxen: EignungBox[];
  /** Boxen der anderen Linie - sie kommen für dieses Release nie in Frage. */
  andereLinie: number;
}

/**
 * Die Release-Seite (`GET /admin/edge-updates/releases/{releaseSeq}`, Geräte &
 * Updates G4): Inhalt aus dem signierten Manifest, bei Edge Light welche
 * Programme fertig im Portal liegen, „Was ist neu" und wo es läuft.
 */
export interface EdgeReleaseSeite {
  releaseSeq: number;
  version: string;
  boxArt: string;
  signed: boolean;
  signingKeyId: string | null;
  createdAt: string;
  targetCommit: string | null;
  notes: string | null;
  /** Die Box-Änderungen seit dem letzten Tag derselben Linie; `null` = keine Angabe, `[]` = keine Änderung. */
  aenderungen: string[] | null;
  erlaubtRueckschritt: boolean;
  minFromSeq: number | null;
  /** Je Teil des Manifests: Bild (Docker) oder Programm je Plattform (Edge Light). */
  inhalt: { typ: string; name: string; arch: string | null; groesse: number | null; gzGroesse: number | null }[];
  /** Nur Edge Light: je Programm, ob es fertig geprüft im Portal liegt. */
  programme: { arch: string; groesse: number; empfangen: number; fertig: boolean }[];
  laeuftAuf: string[];
  boxenDerLinie: number;
  verteilt: {
    rolloutId: string; state: string; createdBy: string | null; createdAt: string;
    total: number; confirmed: number; failed: number;
  }[];
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
  // Nur in einer Verteilung (Geräte & Updates G2): ihre Anfrage gilt nicht mehr -
  // zurückgezogen oder durch eine neuere abgelöst. Ruhig: das war eine Entscheidung.
  zurueckgezogen: { label: 'zurückgezogen', tone: 'off', cls: 'calm' },
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
const LEGACY_LEVER =
  'Diese Sperre gibt es nicht mehr - die Box läuft noch auf einem älteren '
  + 'Image. Sie fällt weg, sobald dieses Update durchgelaufen ist.';

const BLOCKER_LEVERS: Record<string, string> = {
  // Die Sperren, die es HEUTE noch gibt.
  kette: 'Signaturkette prüfen: Vertrauens-Set und Release-Signatur auf der Box.',
  politik:
    'Das Release gilt für diese Box nicht (Anti-Rollback-Boden oder Rückschritt) - '
    + 'ein passendes Release zuweisen.',
  // Gültig signiert, aber für eine andere Box-Art (Docker-Box ↔ Edge Light)
  // oder mit Bestandteilen, die diese Box nicht anwendet. Die Box stellt
  // zurück, statt abzulehnen - kein Vorfall, und es bleibt dabei, bis ein
  // Release ihrer Box-Art zugewiesen ist (docs/contracts/ota-release-manifest-vectors.json).
  backend:
    'Das Release ist für eine andere Box-Art bestimmt (Docker-Box oder Edge Light) oder trägt '
    + 'Bestandteile, die diese Box nicht anwendet - ein Release ihrer eigenen Box-Art zuweisen.',
  state_schema: 'Das Release kennt den Datenstand dieser Box nicht.',
  platte:
    'Platz auf dem Datenträger der Box schaffen - die Box hat ihre abgelösten '
    + 'Abbilder schon selbst weggeräumt.',
  zurueckgenommen:
    'Genau diese Zuweisung wurde hier schon einmal zurückgenommen. Erneut '
    + 'aktualisieren (auch mit demselben Release) startet einen neuen Versuch.',
  // Die Tore der VORBEREITUNG - sie halten den Tausch auf, bevor etwas stoppt.
  laden: 'Die Images konnten nicht geladen werden - Registry-Zugang der Box prüfen.',
  rueckfallziel: 'Das Rückfallziel konnte nicht gesichert werden.',
  sicherung: 'Die Sicherung des Datenstands ist nicht gelungen.',
  unlesbar: 'Eine Protokoll-Datei der Box ist unlesbar.',

  // ── Nur noch zum LESEN ──────────────────────────────────────────────────
  // Diese Tore sind mit dem Ein-Schritt-Umbau ERSATZLOS entfallen. Eine Box
  // mit älterem Image meldet sie noch, also bleibt das Vokabular vollständig -
  // aber der Hebel ist bei allen derselbe: dieses Image ablösen. Ihn auf den
  // alten Handgriff zeigen zu lassen (Prüfstand, Freigabe am Gerät) wäre eine
  // Anweisung auf einen Weg, den es nicht mehr gibt.
  neutralzeit: LEGACY_LEVER,
  neutralzeit_zu_kurz: LEGACY_LEVER,
  interlock: LEGACY_LEVER,
  kern_still: LEGACY_LEVER,
  freigabe_release: LEGACY_LEVER,
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
 * Die EINE Ableitung „aktuell/bekannt" über Linien hinweg (Geräte & Updates
 * S0): „aktuell" heißt auf dem neuesten Release der EIGENEN Linie. Ohne
 * `lines` (älterer Server) bleibt es bei der alten, linienblinden Zahl aus
 * `kpi`.
 *
 * Jede Fläche, die behauptet, wie viele Boxen „aktuell" bzw. „nicht aktuell"
 * sind, liest dieses EINE Urteil - nie `kpi.known`/`kpi.upToDate` direkt,
 * sonst misst eine zweite Stelle an BEIDEN Linien statt an der eigenen und
 * widerspricht der ersten (Plattform-Übersicht G1).
 */
export interface EdgeUpdatesUrteil {
  aktuell: number;
  bekannt: number;
  /** `bekannt - aktuell`, nie negativ. */
  veraltet: number;
}

export function edgeUpdatesUrteil(
  kpi: EdgeUpdatesKpi,
  lines?: EdgeUpdatesLine[] | null,
): EdgeUpdatesUrteil {
  const aktuell = lines ? lines.reduce((n, l) => n + l.upToDate, 0) : kpi.upToDate;
  const bekannt = lines ? lines.reduce((n, l) => n + l.known, 0) : kpi.known;
  return { aktuell, bekannt, veraltet: Math.max(0, bekannt - aktuell) };
}

/**
 * Die Puls-Kennzahl „Edge-Updates": `n/m aktuell · k Rollout aktiv ·
 * j fehlgeschlagen`.
 *
 * `m` ist die ERREICHBARE Menge (`known`), nicht die Flotte: über ein Gerät,
 * das nie gemeldet hat, ist nichts bekannt, und es in den Nenner zu nehmen
 * machte aus einer Wissenslücke eine schlechte Quote.
 */
export function kpiText(kpi: EdgeUpdatesKpi, lines?: EdgeUpdatesLine[] | null): string {
  const { aktuell, bekannt } = edgeUpdatesUrteil(kpi, lines);
  const parts = [`${aktuell}/${bekannt} aktuell`];
  if (kpi.inRollout > 0) parts.push(`${kpi.inRollout} im Rollout`);
  if (kpi.failed > 0) parts.push(`${kpi.failed} fehlgeschlagen`);
  return parts.join(' · ');
}

/**
 * Zustände eines Rollout-Geräts, die KEIN „läuft noch" mehr sind (Geräte &
 * Updates: `RolloutStates.isConfirmed` plus die Fehl-Enden). Ein Gerät in
 * einem dieser Zustände ist FERTIG - gut oder schlecht - und darf nicht mehr
 * als „laufend" gezählt werden.
 */
const ROLLOUT_ABGESCHLOSSEN = new Set([
  'bestaetigt',
  'fehlgeschlagen',
  'zurueckgerollt',
  'im_update_verstummt',
]);

/**
 * Wie viele Geräte gerade WIRKLICH in einem Rollout laufen (Geräte & Updates
 * G1-Folgefund): `EdgeUpdatesKpi.inRollout` zählt jedes Gerät, das in einem
 * der letzten Rollouts VORKOMMT - auch ein längst bestätigtes. Diese
 * Ableitung zählt stattdessen je Gerät nur den JÜNGSTEN Eintrag (`rollouts`
 * kommt neueste-zuerst, wie `RolloutService.readModel`) und nur, wenn der
 * dort NICHT abgeschlossen ist.
 */
export function rolloutsLaufend(rollouts: Rollout[]): number {
  const jeGeraet = new Map<string, string>();
  for (const r of rollouts) {
    for (const d of r.devices) {
      if (d.removed) continue;
      if (!jeGeraet.has(d.deviceId)) {
        jeGeraet.set(d.deviceId, d.state);
      }
    }
  }
  let laufend = 0;
  for (const state of jeGeraet.values()) {
    if (!ROLLOUT_ABGESCHLOSSEN.has(state)) laufend++;
  }
  return laufend;
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

export type CrossoverState = 'gekreuzt' | 'offen' | 'unbekannt' | 'fehler' | 'von_hand';

/** Die ruhige Zeile für Edge Light ohne signierte Updates (Plan Edge Light, Stufe 1). */
export const VON_HAND_LABEL = 'Updates von Hand (Edge Light, Stufe 1)';
export const VON_HAND_DETAIL =
  'Diese Box prüft Updates noch nicht gegen die Signaturkette; Aktualisierung über den '
  + 'Wartungstunnel.';
/** Stufe 1 am gemeldeten Loader (Geräte & Updates G8). */
export const VON_HAND_DETAIL_LOADER =
  'Der Loader dieser Box startet immer die Fassung aus dem Flash und kennt keine Updates; '
  + 'einmal über den Wartungstunnel nachrüsten.';

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
 *
 * **Edge Light ohne gekreuztes Vertrauen ist `von_hand`, nie `fehler`.** Die
 * Box trägt die Wurzel, ein Vertrauens-Set kommt aber erst mit Stufe 2 -
 * bis dahin ist das der bekannte Betrieb, kein Vorfall. Sobald eine
 * Edge-Light-Box ein geprüftes Set meldet, gilt dieselbe Regel wie für die
 * Docker-Box („gekreuzt ✓").
 */
/**
 * Hat das Gerät sein Vertrauen GEKREUZT - Wurzel UND geprüftes Vertrauens-Set
 * gemeldet? Zwilling von `BoxArt.vertrauenGekreuzt` in der API: ohne das ist
 * eine Edge-Light-Box Stufe 1 und bekommt kein Release (`releaseSperre`).
 */
export function vertrauenGekreuzt(trust: DeviceTrust | null | undefined): boolean {
  return !!trust && Array.isArray(trust.rootKeyIds) && trust.rootKeyIds.length > 0
    && Array.isArray(trust.trustSetKeyIds) && trust.trustSetKeyIds.length > 0;
}

/** Der Loader einer Edge-Light-Box startet nur die Fassung aus dem Flash (`update.geraet.loader`). */
export const LOADER_FLASH = 'flash';

/**
 * Hat eine Edge-Light-Box Stufe 1 - nimmt sie keine Updates aus dem Portal an?
 * Ohne gekreuztes Vertrauen, oder mit einem Loader, der nur die Fassung aus dem
 * Flash startet (Geräte & Updates G8). Zwilling von `BoxArt.stufe1`; ein nicht
 * gemeldeter Loader (ältere Box) lässt allein das Vertrauen entscheiden.
 */
export function stufe1(
  boxArt: string | null | undefined,
  trust: DeviceTrust | null | undefined,
  loader?: string | null,
): boolean {
  return deviceBoxArt(boxArt) === 'light' && (!vertrauenGekreuzt(trust) || loader === LOADER_FLASH);
}

export function crossoverState(
  trust: DeviceTrust | null | undefined,
  boxArt?: string | null,
  loader?: string | null,
): {
  state: CrossoverState;
  label: string;
  tone: UpdateTone;
  detail: string | null;
} {
  if (deviceBoxArt(boxArt) === 'light' && loader === LOADER_FLASH) {
    return { state: 'von_hand', label: VON_HAND_LABEL, tone: 'off', detail: VON_HAND_DETAIL_LOADER };
  }
  if (deviceBoxArt(boxArt) === 'light' && !vertrauenGekreuzt(trust)) {
    return { state: 'von_hand', label: VON_HAND_LABEL, tone: 'off', detail: VON_HAND_DETAIL };
  }
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
  let vonHand = 0;
  for (const row of fleet) {
    const s = crossoverState(row.trust, row.boxArt, row.loader).state;
    if (s === 'offen') offen += 1;
    else if (s === 'unbekannt') unbekannt += 1;
    else if (s === 'fehler') fehler += 1;
    else if (s === 'von_hand') vonHand += 1;
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
  // Benannt statt verschwiegen (E10) - aber ruhig: das ist kein Vorfall.
  if (vonHand > 0) {
    parts.push(vonHand === 1
      ? '1 Edge-Light-Box bekommt Updates von Hand (Stufe 1)'
      : `${vonHand} Edge-Light-Boxen bekommen Updates von Hand (Stufe 1)`);
  }
  return parts.length > 0 ? `${parts.join(' · ')}.` : null;
}

// ── Box-Art: Docker-Box oder Edge Light ────────────────────────────────────

/** Die Box-Art eines Geräts; ein unbekanntes Wort bleibt unbekannt. */
/**
 * Das Gerät in einer Zeile (Geräte & Updates G8): „Raspberry Pi 4 Model B Rev 1.4 ·
 * arm64". Was die Box nicht meldet, wird nicht ergänzt: ohne Modell steht nur die
 * Architektur, ohne beides „Gerät nicht gemeldet".
 */
export function geraetZeile(row: { geraetModell?: string | null; geraetArch?: string | null }): string {
  const teile = [row.geraetModell, row.geraetArch].filter((t): t is string => !!t && t.trim() !== '');
  return teile.length > 0 ? teile.join(' · ') : 'Gerät nicht gemeldet';
}

/** Der Loader-Stand in Worten (nur Edge Light); `null`, wenn er nicht gemeldet ist. */
export function loaderLabel(loader: string | null | undefined): string | null {
  if (loader === 'update') return 'kennt Updates (Stufe 2)';
  if (loader === LOADER_FLASH) return 'startet nur die Fassung aus dem Flash (Stufe 1)';
  return null;
}

export function deviceBoxArt(boxArt: string | null | undefined): BoxArt | null {
  return boxArt === 'docker' || boxArt === 'light' ? boxArt : null;
}

/** Die Box-Art eines Releases - ohne Kennzeichnung ein Docker-Release (wie in der API). */
export function releaseBoxArt(release: Pick<EdgeUpdatesRelease, 'boxArt'>): BoxArt {
  return release.boxArt === 'light' ? 'light' : 'docker';
}

export const BOX_ART_LABELS: Record<BoxArt, string> = {
  docker: 'Docker-Box',
  light: 'Edge Light',
};
export const BOX_ART_UNBEKANNT = 'Box-Art unbekannt';

/**
 * Der Chip einer Box: „Docker-Box", „Edge Light" oder ehrlich „Box-Art
 * unbekannt". Die Ableitung macht die API; hier wird nur übersetzt.
 */
export function boxArtLabel(boxArt: string | null | undefined): {
  art: BoxArt | null;
  label: string;
  detail: string;
} {
  const art = deviceBoxArt(boxArt);
  if (art === 'light') {
    return { art, label: BOX_ART_LABELS.light,
      detail: 'Edge Light (vp-edge-light): eigene Release-Linie, kein Docker-Release.' };
  }
  if (art === 'docker') {
    return { art, label: BOX_ART_LABELS.docker,
      detail: 'Docker-Box (edge-app): bekommt Docker-Releases über das Portal.' };
  }
  return { art: null, label: BOX_ART_UNBEKANNT,
    detail: 'Die Box hat noch nichts gemeldet, woran sich ihre Bauart erkennen lässt.' };
}

/** Die Sätze der Zuweisungs-Sperre - wortgleich mit `ota.BoxArt` in der API. */
export const GRUND_DOCKER_AUF_LIGHT = 'Release für die Docker-Box – diese Box ist eine Edge Light.';
export const GRUND_LIGHT_AUF_DOCKER = 'Release für Edge Light – diese Box ist eine Docker-Box.';
export const GRUND_LIGHT_AUF_UNBEKANNT =
  'Release für Edge Light – die Box-Art dieses Geräts ist unbekannt. Ein Edge-Light-Release '
  + 'geht nur an eine Box, die sich als Edge Light gemeldet hat.';
/** Edge-Light-Release an eine Edge-Light-Box, deren Loader nur die Flash-Fassung startet (G8). */
export const GRUND_LIGHT_STUFE_1_LOADER =
  'Release für Edge Light – diese Box hat Stufe 1: ihr Loader startet immer die Fassung aus dem '
  + 'Flash und kennt keine Updates. Einmal über den Wartungstunnel nachrüsten, danach kommt jede '
  + 'Fassung über das Portal.';
/** Edge-Light-Release an eine Edge-Light-Box mit Stufe 1 (Geräte & Updates S0). */
export const GRUND_LIGHT_STUFE_1 =
  'Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem Portal an '
  + '(kein geprüftes Vertrauens-Set). Einmal über den Wartungstunnel nachrüsten, danach kommt '
  + 'jede Fassung über das Portal.';

/**
 * Warum dieses Release diesem Gerät NICHT zugewiesen werden kann - oder
 * `null`, wenn es passt.
 *
 * Der Zwilling von `BoxArt.sperrgrund` in der API, die mit 409 dasselbe
 * ablehnt. Das Portal zeigt den Grund VOR dem Klick, statt eine Zuweisung
 * anzubieten, die der Server verweigert (E10: ausgegraut mit Grund, nie still
 * weggelassen).
 *
 * `trust` ist Pflicht (auch `null`): eine Edge-Light-Box ohne gekreuztes
 * Vertrauen hat Stufe 1 und nimmt kein Release aus dem Portal an - ein
 * vergessener Wert würde sonst still jede Edge-Light-Box sperren.
 */
export function releaseSperre(
  release: Pick<EdgeUpdatesRelease, 'boxArt'>,
  boxArt: string | null | undefined,
  trust: DeviceTrust | null | undefined,
  loader?: string | null,
): string | null {
  const geraet = deviceBoxArt(boxArt);
  if (releaseBoxArt(release) === 'light') {
    if (geraet === 'light' && loader === LOADER_FLASH) return GRUND_LIGHT_STUFE_1_LOADER;
    if (geraet === 'light') return vertrauenGekreuzt(trust) ? null : GRUND_LIGHT_STUFE_1;
    return geraet == null ? GRUND_LIGHT_AUF_UNBEKANNT : GRUND_LIGHT_AUF_DOCKER;
  }
  return geraet === 'light' ? GRUND_DOCKER_AUF_LIGHT : null;
}

export interface ZuweisbareReleases {
  /** Signiert UND zur Box-Art passend - nur die werden angeboten. */
  passend: EdgeUpdatesRelease[];
  /** Alle signierten (ohne sie gibt es gar nichts zu verteilen). */
  signiert: number;
  /** Der Satz zu den signierten, aber unpassenden - `null`, wenn alle passen. */
  hinweis: string | null;
}

/**
 * Die Releases, die EINEM Gerät angeboten werden: signiert und passend. Was
 * nicht passt, wird gezählt und mit Grund GENANNT, damit die Auswahl nicht
 * kommentarlos schrumpft (E10). Für eine Edge-Light-Box mit Stufe 1 ist das der
 * Satz zum Nachrüsten (`GRUND_LIGHT_STUFE_1`), auch wenn andere Gründe dazukommen.
 */
export function zuweisbareReleases(
  releases: EdgeUpdatesRelease[],
  boxArt: string | null | undefined,
  trust: DeviceTrust | null | undefined,
  loader?: string | null,
): ZuweisbareReleases {
  const signed = releases.filter((r) => r.signed);
  const passend: EdgeUpdatesRelease[] = [];
  let gesperrt = 0;
  let grund: string | null = null;
  for (const r of signed) {
    const g = releaseSperre(r, boxArt, trust, loader);
    if (g == null) passend.push(r);
    else {
      gesperrt += 1;
      // Stufe 1 ist der Grund, der zählt: er sagt, was zu tun ist (nachrüsten).
      grund = g === GRUND_LIGHT_STUFE_1 || g === GRUND_LIGHT_STUFE_1_LOADER ? g : grund ?? g;
    }
  }
  let hinweis: string | null = null;
  if (gesperrt > 0 && passend.length === 0) {
    hinweis = `${gesperrt === 1
      ? 'Das signierte Release passt nicht zu dieser Box.'
      : `Keines der ${gesperrt} signierten Releases passt zu dieser Box.`} ${grund}`;
  } else if (gesperrt > 0) {
    hinweis = `${gesperrt === 1
      ? '1 weiteres signiertes Release ist'
      : `${gesperrt} weitere signierte Releases sind`} hier nicht zuweisbar: ${grund}`;
  }
  return { passend, signiert: signed.length, hinweis };
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

/**
 * Ein Journal-Ereignis in einem deutschen Satz.
 *
 * Die Wörter der Wellen-/Freigabe-Ära (`wave_*`, `rollout_paused`, …) stehen
 * hier weiter, obwohl der Server sie nicht mehr schreibt: das Journal ist
 * append-only, und eine Zeile von damals soll auch morgen noch lesbar sein.
 * Neu entsteht keines davon.
 */
const EVENT_LABELS: Record<string, string> = {
  rollout_created: 'Aktualisierung gestartet',
  rollout_done: 'Aktualisierung abgeschlossen',
  wave_released: 'Welle freigegeben',
  wave_auto_released: 'Welle automatisch freigegeben',
  auto_advance_on: 'Wellen-Automatik eingeschaltet',
  auto_advance_off: 'Wellen-Automatik ausgeschaltet',
  rollout_paused: 'Rollout pausiert',
  rollout_resumed: 'Rollout fortgesetzt',
  rollout_halted: 'Rollout eingefroren',
  rollout_auto_halted: 'Rollout AUTOMATISCH angehalten',
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

// ── Beobachten: Frische ────────────────────────────────────────────────────

const NBSP = '\u00a0';

/**
 * „Stand: vor X" - die Bezugszeit der gezeigten Daten.
 *
 * Sie gehört sichtbar auf ein BEOBACHTUNGS-Werkzeug: ohne sie ist nicht zu
 * unterscheiden, ob sich nichts bewegt oder ob nur niemand nachgesehen hat.
 * Gerechnet wird gegen die ANTWORTZEIT, nie gegen eine Uhr über einem
 * stehenden Schnappschuss (die Lebendigkeits-Lehre aus `liveness.ts`).
 *
 * `fehlgeschlagen` (Adminview-Konzept §5.2): schlägt die Abfrage fehl, steht
 * hier „Aktualisierung schlägt fehl · Stand HH:MM" statt eines wachsenden
 * Alters - die Werte selbst bleiben mit ihrem alten Alter stehen, nur DIESE
 * Zeile sagt, dass sie gerade nicht mehr nachgezogen werden.
 */
export function freshnessLabel(fetchedAt: number, now: number, fehlgeschlagen = false): string {
  if (fehlgeschlagen) {
    const uhrzeit = new Date(fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return `Aktualisierung schlägt fehl${NBSP}· Stand ${uhrzeit}`;
  }
  const secs = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (secs < 5) return 'Stand: gerade eben';
  if (secs < 60) return `Stand: vor ${secs}${NBSP}Sek.`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Stand: vor ${mins}${NBSP}Min.`;
  return `Stand: vor ${Math.round(mins / 60)}${NBSP}Std.`;
}

// ── Rollout starten: der Kandidat und die Zusammenfassung ──────────────────

