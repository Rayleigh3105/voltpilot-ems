/**
 * Flussabgleich — die reine Ableitung „der Sollwert ist register-bestätigt,
 * aber die Physik fließt nicht" (Scout `vp-verkauf-praemisse-s8` §3, Vorfall
 * Pilsting 10.08.2026).
 *
 * Der belegte Fall: der Fahrplan-Hero sagte „verkauft gerade 30,0 kW — vom
 * Wechselrichter bestätigt", der Cockpit-Speicherknoten „lädt 3,3 kW ✓" — in
 * derselben Sekunde, gemessener Batteriefluss +3,3 (LADEN), commanded −30
 * (ENTLADEN). Der bestehende `allMatch` prüft ausschließlich den REGISTER-
 * Rückabgleich; ein Abgleich gegen den gemessenen FLUSS existierte nirgends.
 * Das ist die PR-#280-Klasse eine Ebene höher: „ein bestätigtes Register ist
 * kein aktiver Befehl" → hier muss die Antwort der PHYSIK geprüft werden.
 *
 * **Eine Wahrheit, zwei Flächen** (das Haus-Muster von `curtailConflictLine`):
 * der Fahrplan-Hero (`fahrplanJetzt.ts`) und der Cockpit-Speicherknoten-Haken
 * (`adaptiveFlow.ts` via `controlStrip`-healthy) lesen dieselbe Ableitung — sie
 * können sich nicht widersprechen.
 *
 * Ehrlichkeit ist hart verdrahtet:
 *   - **Bernstein, NIE rot** — das ist kein Gerätefehler, sondern „bitte im
 *     Blick behalten" (ein Regler AN der Anlage, ein Deye-Limiter oder eine
 *     Loxone, kann die Order übersteuern; die Cloud kann das nicht entscheiden).
 *   - **Nichts erfunden:** fehlt ein Kanal (pv/load/power unbekannt), wird NICHT
 *     verglichen — unbekannt ≠ 0. Eine ältere Edge/ein älterer Zustand bleibt
 *     zeichengleich zur heutigen Anzeige.
 *   - **Ursache nur, wenn belegbar:** „Ihr Netzanschluss ist voll" wird nur MIT
 *     gepflegter Einspeisegrenze UND gemessener Einspeisung an der Grenze
 *     behauptet; sonst bleibt der Satz ursachenfrei (dieselbe Beide-Möglich-
 *     keiten-Disziplin wie `curtailConflictLine`).
 *   - **Entprellt:** ein einzelner Messversatz zwischen drei Geräten (Speicher,
 *     Haus, Netz kommen über verschiedene Zähler) darf keinen Alarm gebären —
 *     erst {@link FLOW_CONFLICT_MIN_STREAK} aufeinanderfolgende Beobachtungen
 *     lösen ihn aus (die `applyControlConfirm`-Lektion).
 *   - **Eine gemeldete Nachführung ist die REGEL, kein Widerspruch:** in den
 *     Ausführungs-Modi follow/trim/absorb folgt das Gerät bewusst dem
 *     gemessenen Wert — dort wird nichts behauptet.
 *
 * **Der PAUSEN-Fall** (Live-Vorfall Pilsting/Herzogau 24.08.2026): commanded
 * ≈ 0 (Ruhe/Pause), aber die Physik lädt/entlädt deutlich. Der Deye schiebt den
 * Überschuss JENSEITS der vollen Einspeisegrenze selbst in den Speicher, während
 * die Steuerzeile „Der Speicher pausiert gerade — vom Wechselrichter bestätigt"
 * sagt und das Flussbild „lädt 10,0 kW ✓" zeigt. Deshalb kennt dieses Modul
 * seit 24.08. eine SCHWERE (`FlowConflictView.severity`):
 *   - **`info`** (grün, kein Alarm): MIT gepflegter Grenze, gemessener
 *     Einspeisung an der Grenze UND Fluss = LADEN — die gutartige Physik der
 *     vollen Einspeisegrenze; die Aussage ist freundlich, der Haken bleibt.
 *   - **`warn`** (bernstein): jeder ORDER-Widerspruch (bisher) UND der Pausen-
 *     Fall OHNE erklärende Grenze bzw. mit Fluss = ENTLADEN. Bestätigung/Haken
 *     entfallen wie gehabt.
 */

import type { ExecutionMode } from './api';
import { batteryDirection, type BatteryDir } from './control';
import { fmtNum } from './format';
import { deriveBatteryKw, type LiveSnapshot } from './live';

/** Erst ab diesem angewiesenen Betrag lohnt ein Abgleich (winzige Sollwerte sind Rauschen). */
export const FLOW_CONFLICT_MIN_COMMAND_KW = 1;

/**
 * Für einen RICHTUNGS-Widerspruch muss auch die gemessene Bewegung deutlich
 * sein — beide Beträge > diesem Wert. Bewusst zehnmal über dem 0,05-kW-Anzeige-
 * Totband: ein paar Zehntel Gegenrichtung sind Messversatz, kein Widerspruch.
 */
export const FLOW_CONFLICT_MIN_FLOW_KW = 0.5;

/**
 * Im PAUSEN-Fall (commanded ≈ 0) zählt erst ein deutlich fließender Speicher
 * als Widerspruch. Höher als {@link FLOW_CONFLICT_MIN_FLOW_KW}, weil ein
 * pausierender Speicher im normalen Eigenverbrauchs-Ausgleich ohnehin ein paar
 * Zehntel bis über ein kW wandert (Zähler-Versatz + Mikro-Regelung) — erst ab
 * hier ist es ein echtes, erklärungsbedürftiges Fließen.
 */
export const FLOW_CONFLICT_MIN_PAUSE_FLOW_KW = 2;

/** Ein FEHLBETRAG zählt ab dem GRÖSSEREN aus absolutem Boden und Anteil. */
export const FLOW_CONFLICT_ABS_SHORTFALL_KW = 2;
export const FLOW_CONFLICT_REL_SHORTFALL = 0.5;

/**
 * So viele aufeinanderfolgende konfliktbehaftete Beobachtungen (≈ Polls) müssen
 * vorliegen, bevor der Konflikt behauptet wird. Drei ist bewusst der obere Rand
 * der „2-3"-Empfehlung: ein etwas später erscheinender Hinweis ist auf einer
 * Kundenfläche weit besser als ein falscher aus einem einzelnen Messversatz.
 */
export const FLOW_CONFLICT_MIN_STREAK = 3;

/**
 * Ab dieser Nähe zur gepflegten Einspeisegrenze gilt der Netzanschluss als voll
 * (gemessene Einspeisung ≥ Grenze − 1 kW). Erst dann DARF „Netzanschluss voll"
 * als Ursache behauptet werden.
 */
export const FEED_IN_FULL_MARGIN_KW = 1;

/** Die Ausführungs-Modi, in denen das Gerät bewusst dem MESSWERT folgt. */
const FOLLOWING_MODES: ReadonlySet<string> = new Set(['follow', 'trim', 'absorb']);

/** Der Trailing-Satz jeder Konflikt-Aussage: ein Hinweis, kein Alarm. */
export const FLOW_CONFLICT_WATCH_SENTENCE = 'Bitte im Blick behalten.';

/**
 * Was den Konflikt ausmacht (für die Wortwahl der Zeile):
 *   - `direction`/`shortfall` — ein ORDER-Widerspruch (|commanded| ≥ 1);
 *   - `pause` — commanded ≈ 0, aber die Physik fließt deutlich.
 */
export type FlowConflictKind = 'direction' | 'shortfall' | 'pause';

/**
 * Wie ernst der Befund ist:
 *   - `info` — gutartige Physik (voller Netzanschluss nimmt Überschuss auf),
 *     grün, der Haken bleibt;
 *   - `warn` — bernstein, „bitte im Blick behalten", Haken/Bestätigung entfallen.
 */
export type FlowConflictSeverity = 'info' | 'warn';

/** Der ROHE Befund einer einzelnen Beobachtung, vor der Entprellung. */
export interface FlowConflictCandidate {
  /** Der angewiesene Sollwert (+ laden / − entladen / ≈ 0 pausieren). */
  commandedKw: number;
  /** Der gemessene, abgeleitete Batteriefluss (dieselbe Vorzeichen-Konvention). */
  measuredKw: number;
  /** Richtung des Sollwerts als Wort. */
  commandedDir: BatteryDir;
  /** Richtung des gemessenen Flusses. */
  measuredDir: BatteryDir;
  kind: FlowConflictKind;
}

/** Das entprellte Ergebnis, das die Flächen rendern. */
export interface FlowConflictView {
  /** Grün-Info (gutartige Physik) vs. bernstein Warnung — steuert Ton + Haken. */
  severity: FlowConflictSeverity;
  /** Der Beobachtungs-Satz („Entladung angewiesen (30,0 kW) - …"). */
  observation: string;
  /** Der Ursachen-Satz, nur wenn belegbar; sonst null. */
  cause: string | null;
  /** Beobachtung + (Ursache) + „Bitte im Blick behalten." als EIN Text. */
  text: string;
}

/** Was die Ableitung braucht — alles optional außer der Wortwahl. */
export interface FlowConflictInput {
  /** Worauf das GERÄT regelt (`ControlStatus.commandedKw`). */
  commandedKw: number | null | undefined;
  /** Die Live-Messwerte; null = keine geladen. */
  snapshot: LiveSnapshot | null;
  /** true, wenn der Schnappschuss im Frischefenster liegt. */
  snapshotFresh: boolean;
  /** Der gemeldete Ausführungs-Modus; follow/trim/absorb = kein Widerspruch. */
  executionMode: ExecutionMode | null | undefined;
  /** Die gepflegte Einspeisegrenze am Netzanschluss (kW); null = keine. */
  maxFeedInKw: number | null | undefined;
}

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** „6,1 kW" ohne Vorzeichen — die Richtung ist ein Wort, nie ein Minus. */
function kw(v: number): string {
  return fmtNum(Math.abs(v), 'kW', 1);
}

/**
 * Der rohe Konflikt-Befund einer einzelnen Beobachtung — vor jeder Entprellung.
 * null, sobald irgendeine Ehrlichkeitsbedingung nicht hält (kein Sollwert,
 * unfrisch, ein unbekannter Kanal, ein zu kleiner Sollwert, ein Nachführungs-
 * Modus, oder schlicht kein Widerspruch).
 */
export function flowConflictCandidate(input: FlowConflictInput): FlowConflictCandidate | null {
  const commanded = num(input.commandedKw);
  if (commanded == null) return null;
  // (v) Eine gemeldete Nachführung ist die Regel, kein Fehler.
  if (input.executionMode != null && FOLLOWING_MODES.has(input.executionMode)) return null;
  // Ohne frische Messung wird nichts behauptet.
  if (!input.snapshotFresh || input.snapshot == null) return null;

  // Der abgeleitete Batteriefluss aus den GEZEIGTEN Kanälen — fehlt einer,
  // wird NICHT verglichen (unbekannt ≠ 0). Vorzeichen wie `commandedKw`.
  const measured = deriveBatteryKw(
    input.snapshot.pvKw,
    input.snapshot.loadKw,
    input.snapshot.gridKw,
  );
  if (measured == null) return null;

  const measuredDir = batteryDirection(measured);
  const commandedDir = batteryDirection(commanded);

  // PAUSEN-Fall: kein Sollwert angewiesen, aber die Physik fließt deutlich.
  // Erst ab {@link FLOW_CONFLICT_MIN_PAUSE_FLOW_KW} — ein pausierender Speicher
  // wandert im normalen Ausgleich ohnehin ein paar Zehntel.
  if (commandedDir === 'pausieren') {
    if (Math.abs(measured) < FLOW_CONFLICT_MIN_PAUSE_FLOW_KW) return null;
    return { commandedKw: commanded, measuredKw: measured, commandedDir, measuredDir, kind: 'pause' };
  }

  // ORDER-Fall: (ii) winzige Sollwerte sind Rauschen.
  if (Math.abs(commanded) < FLOW_CONFLICT_MIN_COMMAND_KW) return null;

  // (iii) Richtungswiderspruch: entgegengesetzte Vorzeichen, beide Beträge
  // deutlich. |commanded| ≥ 1 erfüllt seinen Boden bereits.
  const oppositeSign = Math.sign(commanded) !== Math.sign(measured);
  const directionConflict =
    oppositeSign &&
    Math.abs(commanded) > FLOW_CONFLICT_MIN_FLOW_KW &&
    Math.abs(measured) > FLOW_CONFLICT_MIN_FLOW_KW;

  // ODER ein Fehlbetrag über dem größeren aus Boden und Anteil.
  const shortfall = Math.abs(commanded) - Math.abs(measured);
  const shortfallConflict =
    shortfall >
    Math.max(FLOW_CONFLICT_ABS_SHORTFALL_KW, FLOW_CONFLICT_REL_SHORTFALL * Math.abs(commanded));

  if (!directionConflict && !shortfallConflict) return null;
  return {
    commandedKw: commanded,
    measuredKw: measured,
    commandedDir,
    measuredDir,
    kind: directionConflict ? 'direction' : 'shortfall',
  };
}

/**
 * Der Beobachtungs-Satz — bernstein, ohne Ursache, ohne „Bitte im Blick
 * behalten." (das setzt {@link flowConflictView} an). Die Wortwahl folgt den
 * RICHTUNGEN, nicht dem `kind`: eine (auch kleine) Gegenbewegung liest sich als
 * „entlädt aber nicht (Messung: lädt …)", eine schwache Mitbewegung als
 * „entlädt aber deutlich weniger", keine Bewegung als „entlädt aber nicht
 * (Messung: keine Bewegung)".
 */
export function flowConflictLine(c: FlowConflictCandidate): string {
  const cmdNoun = c.commandedDir === 'entladen' ? 'Entladung' : 'Ladung';
  const cmdVerb = c.commandedDir === 'entladen' ? 'entlädt' : 'lädt';
  const moving = c.measuredDir !== 'pausieren';
  const opposite = moving && c.measuredDir !== c.commandedDir;

  let negation: string;
  let measuredPhrase: string;
  if (!moving) {
    negation = `${cmdVerb} aber nicht`;
    measuredPhrase = 'keine Bewegung';
  } else if (opposite) {
    negation = `${cmdVerb} aber nicht`;
    measuredPhrase = `${c.measuredDir === 'laden' ? 'lädt' : 'entlädt'} ${kw(c.measuredKw)}`;
  } else {
    negation = `${cmdVerb} aber deutlich weniger`;
    measuredPhrase = kw(c.measuredKw);
  }
  return `${cmdNoun} angewiesen (${kw(c.commandedKw)}) - der Speicher ${negation} (Messung: ${measuredPhrase}).`;
}

/**
 * Die gepflegte Einspeisegrenze (kW), falls sie durch die GEMESSENE Einspeisung
 * nahezu erreicht ist — sonst null. Die eine „ist der Netzanschluss voll?"-
 * Regel; {@link feedInFullCause} und der Pausen-Info-Zweig lesen sie beide, und
 * der kappen-bewusste Fahrplan-Satz (`fahrplanWhy.fedInClause`) teilt sich ihre
 * Marge {@link FEED_IN_FULL_MARGIN_KW}.
 */
export function feedInLimitReached(
  snapshot: LiveSnapshot | null,
  maxFeedInKw: number | null | undefined,
): number | null {
  const limit = num(maxFeedInKw);
  if (limit == null || limit <= 0) return null;
  const grid = snapshot == null ? null : num(snapshot.gridKw);
  // Negativ = Einspeisung (die `live.ts`-Konvention).
  const exportKw = grid != null && grid < 0 ? -grid : null;
  if (exportKw == null) return null;
  return exportKw >= limit - FEED_IN_FULL_MARGIN_KW ? limit : null;
}

/** „N kW" mit passender Genauigkeit (ganzzahlige Grenze ohne Nachkommastelle). */
function limitKw(limit: number): string {
  return fmtNum(limit, 'kW', Number.isInteger(limit) ? 0 : 1);
}

/**
 * Der Ursachen-Satz „Ihr Netzanschluss ist voll (Einspeisegrenze N kW
 * erreicht)" — nur wenn er BELEGBAR ist: eine gepflegte Grenze UND eine
 * gemessene Einspeisung, die sie nahezu erreicht. Sonst null (die Cloud kann
 * Deye-Limiter/Loxone/Defekt nicht unterscheiden, also behauptet sie keine).
 */
export function feedInFullCause(
  snapshot: LiveSnapshot | null,
  maxFeedInKw: number | null | undefined,
): string | null {
  const limit = feedInLimitReached(snapshot, maxFeedInKw);
  if (limit == null) return null;
  return `Ihr Netzanschluss ist voll (Einspeisegrenze ${limitKw(limit)} erreicht).`;
}

/**
 * Ein Entprellungs-Schritt: die neue Serienlänge nach genau EINER Beobachtung.
 * Eine konfliktfreie Beobachtung setzt zurück; eine konfliktbehaftete zählt
 * hoch (gedeckelt, damit sie nicht unbegrenzt wächst). Rein und
 * render-idempotent, wenn der Aufrufer sie je Beobachtung genau einmal faltet.
 */
export function stepFlowConflict(prevStreak: number, hasCandidate: boolean): number {
  if (!hasCandidate) return 0;
  return Math.min(prevStreak + 1, FLOW_CONFLICT_MIN_STREAK);
}

/**
 * Der Pausen-Befund als Sicht: MIT gepflegter, erreichter Einspeisegrenze und
 * Fluss = LADEN ist es die gutartige Physik der vollen Grenze (grün, `info`,
 * der Haken bleibt); sonst — keine Grenze, Grenze nicht erreicht, oder Fluss =
 * ENTLADEN — ein bernstein Hinweis ohne behauptete Ursache.
 */
function pauseView(candidate: FlowConflictCandidate, input: FlowConflictInput): FlowConflictView {
  const flow = kw(candidate.measuredKw);
  const limit =
    candidate.measuredDir === 'laden'
      ? feedInLimitReached(input.snapshot, input.maxFeedInKw)
      : null;
  if (limit != null) {
    const observation = `Der Speicher pausiert planmäßig – nimmt aber gerade ${flow} Überschuss auf`;
    const cause = `weil Ihre Einspeisegrenze (${limitKw(limit)}) erreicht ist. Dieser Strom wäre sonst verloren.`;
    return { severity: 'info', observation, cause, text: `${observation}, ${cause}` };
  }
  const verb = candidate.measuredDir === 'laden' ? 'lädt' : 'entlädt';
  const observation = `Pause angewiesen – der Speicher ${verb} aber ${flow} (Messung).`;
  return {
    severity: 'warn',
    observation,
    cause: null,
    text: `${observation} ${FLOW_CONFLICT_WATCH_SENTENCE}`,
  };
}

/**
 * Das entprellte Ergebnis. null, solange der aktuelle Befund fehlt (eine kurze
 * saubere Messung blendet den Konflikt SOFORT aus) ODER die Serie noch nicht
 * lang genug ist. Nur wenn beides zusammenkommt, entsteht der Text — mit der
 * belegbaren Ursache, wenn es sie gibt, und der {@link FlowConflictSeverity},
 * die Ton und Haken der Flächen steuert.
 */
export function flowConflictView(
  candidate: FlowConflictCandidate | null,
  streak: number,
  input: FlowConflictInput,
): FlowConflictView | null {
  if (candidate == null || streak < FLOW_CONFLICT_MIN_STREAK) return null;
  if (candidate.kind === 'pause') return pauseView(candidate, input);
  // ORDER-Widerspruch: immer bernstein (bisheriges Verhalten).
  const observation = flowConflictLine(candidate);
  const cause = feedInFullCause(input.snapshot, input.maxFeedInKw);
  const text = [observation, cause, FLOW_CONFLICT_WATCH_SENTENCE].filter(Boolean).join(' ');
  return { severity: 'warn', observation, cause, text };
}

/**
 * Die EINE Ableitung, die beide Flächen konsumieren: baut den Befund aus dem
 * Input und wendet die Entprellungs-Serie (die der Aufrufer über
 * {@link stepFlowConflict} führt) an. null = kein (belegter, entprellter)
 * Konflikt — dann bleibt jede Fläche zeichengleich zur heutigen Anzeige.
 */
export function flowConflict(input: FlowConflictInput, streak: number): FlowConflictView | null {
  return flowConflictView(flowConflictCandidate(input), streak, input);
}
