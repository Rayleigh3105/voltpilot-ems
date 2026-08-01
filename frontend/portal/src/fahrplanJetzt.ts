/**
 * Der JETZT-Held der Fahrplan-Seite (Konzept `vp-fahrplan-kunde-konzept`
 * §6.1, Captain-Entscheid D1 „volle Fassung").
 *
 * Der Auftrag war wörtlich: die Seite soll „genau das darstellen, was wirklich
 * gerade gemacht wird". Präzise heißt das: **drei Wahrheiten getrennt benennen
 * und im Jetzt verbinden** —
 *
 *   PLAN        was der Optimierer für die laufende Viertelstunde vorhatte
 *               (`schedule.batteryKw` des laufenden Slots)
 *   AUSFÜHRUNG  worauf das Gerät wirklich regelt (`ControlStatus.commandedKw`,
 *               seit den Nachführungs-Pflichten NICHT mehr der Plan-Wert)
 *   MESSUNG     was Haus/PV/Netz real sind (der Live-Schnappschuss)
 *
 * — und eine bewusste Abweichung der Ausführung vom Plan als das zu zeigen,
 * was sie ist: **die Regel, nicht der Fehler** (§7 Regel 2). Ein echter Bruch
 * (`allMatch = false`) wird dagegen nie beschönigt (§7 Regel 3).
 *
 * Rein, ohne React/Netz — die Fläche rendert nur. **Es gibt hier KEINE zweite
 * Steuerungs-Ableitung:** der Held schickt den Rücklese-Zustand durch dasselbe
 * `control.ts controlStrip`, das die Cockpit-Karte rendert, und den Warum-Satz
 * durch dasselbe `fahrplanWhy.slotWhy` (P0-Preiswahrheit) — beide Flächen
 * können sich damit nie widersprechen.
 *
 * Ehrlichkeit (§7 Regel 4): ohne Rücklesen gibt es KEINEN Ausführungs-Wert
 * („—" mit Grund, nie eine erfundene Zahl), ohne aufgezeichneten Grund keinen
 * Warum-Satz, und ohne die Ausführungs-Daten aus dem Heartbeat (PR 3) wird die
 * Nachführung nur GENERISCH benannt — ohne Richtung, ohne Modus-Behauptung.
 */

import type { ControlStatus } from './api';
import { controlStrip } from './control';
import { roleLabel, slotWhy, type SlotRole, type WhySlot } from './fahrplanWhy';
import { fmtNum, fmtRelative } from './format';
import { PROVENIENZ } from './historieWelten';
import type { LiveSnapshot } from './live';
import { DEADBAND_KW } from './live';
import type { PlanWordingKind } from './schedule';

/**
 * Ab dieser Differenz gilt der ausgeführte Wert als bewusst ANGEPASST und
 * nicht mehr als derselbe Wert. Bewusst größer als das 0,05-kW-Rauschband der
 * Anzeige: darunter sind Rundung und Rücklese-Auflösung nicht zu unterscheiden
 * von einer echten Nachführung, und eine behauptete Anpassung wäre eine
 * Aussage über etwas, das nicht stattfand.
 */
export const ADJUST_DEADBAND_KW = 0.1;

/**
 * Der Zustand des Helden. Jeder ist genau EINE Aussage; die Reihenfolge der
 * Auflösung ist die Rangfolge der Ehrlichkeit (ein toter Plan schlägt jede
 * „läuft wie geplant"-Aussage, ein echter Bruch schlägt jede Nachführung).
 */
export type JetztState =
  /** Plan wird 1:1 ausgeführt und ist bestätigt. */
  | 'planmaessig'
  /** Die Box weicht bewusst vom Plan-Watt ab (Nachführung) — grün, kein Fehler. */
  | 'angepasst'
  /** Geplante Ruhe. */
  | 'ruhe'
  /** Echter Bruch: der Wechselrichter meldet etwas anderes. */
  | 'abweichung'
  /** Die letzte Bestätigung ist älter als das Frischefenster. */
  | 'unbestaetigt'
  /** Der Fahrplan selbst ist älter als 2 h. */
  | 'veraltet'
  /** Steuerung ausgeschaltet (Not-Aus). */
  | 'aus'
  /** Modell noch nicht für die Steuerung freigegeben. */
  | 'nicht_freigegeben'
  /** Steuerbare Anlage, aber noch kein Rücklesen. */
  | 'wird_vorbereitet'
  /** Kein Steuerungs-Zustand vorhanden — es gibt nur den Plan. */
  | 'nur_plan';

export type JetztTone = 'ok' | 'warn' | 'off';

/** Ein Messwert-Chip des Helden (die Mess-Wahrheit, die alles begründet). */
export interface JetztChip {
  label: string;
  value: string;
}

export interface JetztHeldView {
  state: JetztState;
  tone: JetztTone;
  /**
   * Das Ehrlichkeits-Abzeichen der Karte (Historie-Vokabular §7 Regel 1):
   * „Gemessen", sobald eine gemessene Wahrheit (Rücklesen oder Telemetrie)
   * die Karte trägt, sonst „Geplant".
   */
  badge: string;
  /** Die Abzeichen-ART (fürs Rendern über den geteilten `ProvBadge`). */
  badgeArt: 'gemessen' | 'geplant';
  /** Frische des Abzeichens („vor 8 Sek."); null wenn nichts Gemessenes da ist. */
  badgeNote: string | null;
  /** Die Zustandszeile (F5 — „nichts zu tun" steht wörtlich da). */
  status: string;
  /** Die EINE Aussage: „Ihre Batterie deckt gerade den Verbrauch". */
  lead: string;
  /** Die Zahl der AUSFÜHRUNG; null = kein Rücklesen (dann `valueMissing`). */
  value: string | null;
  /** Richtung als WORT („aus dem Speicher"), nie ein Vorzeichen. */
  valueNote: string | null;
  /** Warum keine Zahl dasteht — „—" bekommt immer einen Grund. */
  valueMissing: string | null;
  /**
   * Die Nachführungs-Zeile, NIE als Fehler formuliert: sie nennt den
   * Plan-Wert (nichts wird versteckt) und sagt generisch, dass das Gerät
   * innerhalb der Viertelstunde angepasst hat. Ohne die Ausführungs-Daten aus
   * dem Heartbeat wird KEINE Richtung und KEIN Modus behauptet.
   */
  adjust: string | null;
  /** „vom Wechselrichter bestätigt · geprüft vor 8 Sek."; null = nichts bestätigt. */
  confirm: string | null;
  /** Der Warum-Satz des laufenden Slots; null = kein Grund aufgezeichnet. */
  why: string | null;
  /** Die Mess-Wahrheit als Chips; leer, wenn nichts Frisches gemessen wurde. */
  chips: JetztChip[];
  /** Blick nach vorn bei geplanter Ruhe: „Nächster Einsatz: 17:45 Verbrauch decken". */
  next: string | null;
}

/** Was der Held braucht — alles optional außer der Uhrzeit und der Wortwahl. */
export interface JetztInput {
  /** Der Slot, der JETZT läuft (`control.controlReasonSlot`); null = außerhalb. */
  slot: WhySlot | null;
  /** Der jüngste Rücklese-Zustand des Geräts; null = noch keiner. */
  control: ControlStatus | null;
  /** true, sobald die Anlage überhaupt gesteuert wird (Plan mit Gerät). */
  expectControl: boolean;
  /** Die Live-Messwerte; null = keine geladen. */
  snapshot: LiveSnapshot | null;
  /** true, wenn der Schnappschuss im Frischefenster liegt. */
  snapshotFresh: boolean;
  /** Der Fahrplan ist älter als 2 h (`planStaleNote` ist gesetzt). */
  planStale: boolean;
  /** Die nächste geplante Phase (aus dem Film) für den Ruhe-Ausblick. */
  nextPhase?: { label: string; at: string } | null;
  plantKind: PlanWordingKind;
  now: Date;
}

/**
 * Die Zustände, in denen das Gerät JETZT einen Sollwert ausführt — nur dort
 * darf die große Zahl die Ausführung zeigen.
 */
const SHOWS_VALUE: ReadonlySet<JetztState> = new Set<JetztState>([
  'planmaessig',
  'angepasst',
  'ruhe',
  'abweichung',
]);

/**
 * Die Zustände, in denen es überhaupt etwas zu erklären gibt: entweder wird
 * ausgeführt, oder es gibt einen aktuellen Plan. Einen Sollwert zu begründen,
 * der gar nicht ausgeführt wird (Steuerung aus, nicht freigegeben) wäre eine
 * Behauptung über etwas, das nicht passiert — und ein VERALTETER Plan sagt
 * über das Jetzt ohnehin nichts mehr.
 */
const SHOWS_WHY: ReadonlySet<JetztState> = new Set<JetztState>([
  'planmaessig',
  'angepasst',
  'ruhe',
  'abweichung',
  'unbestaetigt',
  'wird_vorbereitet',
  'nur_plan',
]);

/** Die Zustände, deren Ton grün ist (eine bewusste Nachführung gehört dazu). */
const GREEN: ReadonlySet<JetztState> = new Set<JetztState>([
  'planmaessig',
  'angepasst',
  'ruhe',
]);

/** Die Zustände, die als echtes Problem gelesen werden dürfen. */
const AMBER: ReadonlySet<JetztState> = new Set<JetztState>(['abweichung', 'veraltet']);

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** „6,1 kW" ohne Vorzeichen — die Richtung ist ein Wort, nie ein Minus. */
function kw(v: number): string {
  return fmtNum(Math.abs(v), 'kW', 1);
}

/** „17:45" der Uhrzeit eines ISO-Zeitpunkts. */
function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Was die Batterie tut, als Verbalphrase. Die Rolle des Plans ist die
 * genauere Aussage; **widerspricht sie der wirklich ausgeführten Richtung,
 * gewinnt die Ausführung** — sie ist es, was passiert.
 */
export function actionPhrase(
  role: SlotRole | null,
  executedKw: number | null,
  kind: PlanWordingKind,
): string {
  const dir = executedKw == null ? null : direction(executedKw);
  const roleDir = role == null ? null : roleDirection(role);
  const agree = dir == null || roleDir == null || dir === roleDir;
  if (role != null && agree) {
    switch (role) {
      case 'eigenverbrauch':
        return 'deckt gerade den Verbrauch';
      case 'spitze_kappen':
        return 'kappt gerade die Lastspitze';
      case 'verkaufen':
        return kind === 'direktvermarktung'
          ? 'verkauft gerade zum Spitzenpreis'
          : 'speist gerade ein';
      case 'pv_speichern':
        return 'speichert gerade Solarstrom';
      case 'guenstig_laden':
        return 'lädt gerade günstig aus dem Netz';
      case 'abregeln':
        return 'pausiert gerade die Einspeisung';
      case 'reserve_halten':
        return 'hält gerade Ladung als Reserve';
      case 'warten':
        return 'ruht gerade';
    }
  }
  if (dir === 'laden') return 'lädt gerade';
  if (dir === 'entladen') return 'entlädt gerade';
  return 'ruht gerade';
}

type Direction = 'laden' | 'entladen' | 'ruhe';

function direction(v: number): Direction {
  if (v > DEADBAND_KW) return 'laden';
  if (v < -DEADBAND_KW) return 'entladen';
  return 'ruhe';
}

function roleDirection(role: SlotRole): Direction {
  switch (role) {
    case 'pv_speichern':
    case 'guenstig_laden':
      return 'laden';
    case 'eigenverbrauch':
    case 'verkaufen':
    case 'spitze_kappen':
      return 'entladen';
    default:
      return 'ruhe';
  }
}

/**
 * Der JETZT-Held aus den drei Wahrheiten. Nie eine erfundene Zahl, nie ein
 * erfundener Grund, nie „läuft wie vorgesehen" über einem toten Plan.
 */
export function jetztHeld(input: JetztInput): JetztHeldView {
  const { now, plantKind } = input;
  const slot = input.slot;
  const role = (slot?.slotRole ?? null) as SlotRole | null;
  // Der Grund kommt aus dem BESTEHENDEN Warum-Layer - keine zweite Erklär-Logik.
  const reason = slot ? slotWhy(slot, plantKind) : null;
  // ... und der Steuerungs-Zustand aus der BESTEHENDEN Ableitung der Karte.
  const strip = controlStrip(input.control, now, input.expectControl, reason);

  const planKw = num(slot?.batteryKw);
  const status = input.control;
  const live = status != null && status.certified && status.controlEnabled;
  const executedKw = live ? num(status.commandedKw) : null;
  const confirmedKw = live ? num(status.confirmedKw) : null;

  const state = resolveState(input, strip?.state ?? null, planKw, executedKw);
  const tone: JetztTone = AMBER.has(state) ? 'warn' : GREEN.has(state) ? 'ok' : 'off';

  // Der Ausführungs-Wert erscheint nur, wo wirklich etwas ausgeführt wird -
  // eine Zahl unter „Steuerung aus" wäre eine Behauptung.
  const showValue = SHOWS_VALUE.has(state) && executedKw != null;
  const dir = showValue ? direction(executedKw as number) : null;

  const chips = input.snapshotFresh ? measurementChips(input.snapshot) : [];
  const measured = showValue || chips.length > 0;

  return {
    state,
    tone,
    badge: measured ? PROVENIENZ.gemessen.label : PROVENIENZ.geplant.label,
    badgeArt: measured ? 'gemessen' : 'geplant',
    badgeNote: measured && status ? fmtRelative(status.checkedAt, now) : null,
    status: statusLine(state, strip?.sentence ?? null, executedKw, confirmedKw),
    lead: leadLine(state, role, showValue ? executedKw : null, slot?.slotFlags ?? null, plantKind),
    value: showValue ? kw(executedKw as number) : null,
    valueNote:
      dir == null ? null : dir === 'laden' ? 'in den Speicher' : dir === 'entladen' ? 'aus dem Speicher' : 'der Speicher hält',
    valueMissing: showValue ? null : valueMissingReason(state),
    adjust:
      state === 'angepasst' && planKw != null
        ? `Der Fahrplan sah ${kw(planKw)} vor — Ihr Gerät hat den Wert innerhalb der ` +
          'Viertelstunde angepasst: es regelt auf den gemessenen Verbrauch bzw. eine ' +
          'Schutzgrenze. Das ist so vorgesehen.'
        : null,
    confirm:
      (state === 'planmaessig' || state === 'angepasst' || state === 'ruhe') && status
        ? `vom Wechselrichter bestätigt · geprüft ${fmtRelative(status.checkedAt, now)}`
        : null,
    // Ein toter Plan erklärt nichts über das Jetzt - sein Grund bleibt weg.
    why: SHOWS_WHY.has(state) ? reason : null,
    chips,
    next:
      state === 'ruhe' && input.nextPhase
        ? `Nächster Einsatz: ${hm(input.nextPhase.at)} ${input.nextPhase.label}`
        : null,
  };
}

function resolveState(
  input: JetztInput,
  stripState: string | null,
  planKw: number | null,
  executedKw: number | null,
): JetztState {
  // Ein Fahrplan, der nicht mehr aktuell ist, darf nie „läuft wie geplant"
  // tragen - er sagt über das Jetzt nichts mehr aus (§7 Regel 3).
  if (input.planStale) return 'veraltet';
  if (stripState == null) return 'nur_plan';
  if (stripState === 'off') return 'aus';
  if (stripState === 'pending') return 'nicht_freigegeben';
  if (stripState === 'preparing') return 'wird_vorbereitet';
  if (stripState === 'mismatch') return 'abweichung';
  if (stripState === 'stale') return 'unbestaetigt';
  if (executedKw == null) return 'wird_vorbereitet';
  if (planKw != null && Math.abs(executedKw - planKw) > ADJUST_DEADBAND_KW) return 'angepasst';
  if (direction(executedKw) === 'ruhe') return 'ruhe';
  return 'planmaessig';
}

/**
 * Die EINE Aussage — und zwar aus der Wahrheit, die im jeweiligen Zustand
 * wirklich gilt: die AUSFÜHRUNG, wo ausgeführt wird; der PLAN, wo es nur
 * einen Plan gibt (dann auch als Plan formuliert, nie als Tatsache); und gar
 * keine Handlungs-Behauptung, wo VoltPilot nicht steuert oder der Plan tot
 * ist. Genau hier entstand der gemeldete Widerspruch — zwei verschiedene
 * Zahlen unter demselben Wort.
 */
function leadLine(
  state: JetztState,
  role: SlotRole | null,
  executedKw: number | null,
  flags: string[] | null,
  kind: PlanWordingKind,
): string {
  if (SHOWS_VALUE.has(state)) {
    return `Ihre Batterie ${actionPhrase(role, executedKw, kind)}`;
  }
  if (state === 'veraltet') return 'Ihre Batterie regelt gerade eigenständig weiter';
  if (state === 'aus' || state === 'nicht_freigegeben') {
    return 'VoltPilot steuert Ihre Batterie gerade nicht';
  }
  // nur_plan / wird_vorbereitet / unbestaetigt: es gibt einen aktuellen Plan,
  // aber keine bestätigte Ausführung - also wird er als PLAN benannt.
  if (role == null) return 'Für die laufende Viertelstunde liegt kein Fahrplan vor';
  return `Geplant ist gerade: ${roleLabel(role, kind, flags)}`;
}

function statusLine(
  state: JetztState,
  stripSentence: string | null,
  executedKw: number | null,
  confirmedKw: number | null,
): string {
  switch (state) {
    case 'planmaessig':
    case 'angepasst':
      return 'Läuft wie vorgesehen — nichts zu tun';
    case 'ruhe':
      return 'Ruhe — so geplant, nichts zu tun';
    case 'abweichung':
      return executedKw != null && confirmedKw != null
        ? `Der Wechselrichter meldet ${kw(confirmedKw)} statt ${kw(executedKw)} — bitte im Blick behalten`
        : 'Der Wechselrichter meldet einen anderen Wert als angefordert — bitte im Blick behalten';
    case 'veraltet':
      return 'Dieser Fahrplan ist nicht mehr aktuell — Ihr Gerät regelt eigenständig weiter';
    case 'nur_plan':
      return 'So ist es geplant — Ihr Gerät meldet dazu keine Bestätigung';
    default:
      // aus / nicht freigegeben / wird vorbereitet / unbestätigt: die
      // bestehenden ehrlichen Sätze der Steuerungs-Ableitung, unverändert.
      return stripSentence ?? 'Zur Steuerung liegt gerade keine Rückmeldung vor';
  }
}

function valueMissingReason(state: JetztState): string | null {
  switch (state) {
    case 'aus':
      return 'Es wird gerade kein Sollwert gestellt.';
    case 'nicht_freigegeben':
      return 'Diese Anlage wird nur ausgelesen, nicht gesteuert.';
    case 'wird_vorbereitet':
    case 'unbestaetigt':
      return 'Noch keine aktuelle Rückmeldung Ihres Wechselrichters.';
    case 'veraltet':
      return 'Ohne aktuellen Fahrplan zeigt VoltPilot hier keinen Wert.';
    case 'nur_plan':
      return 'Ihr Gerät meldet keinen ausgeführten Wert zurück.';
    default:
      return null;
  }
}

/**
 * Die Mess-Wahrheit als Chips — genau die drei Werte, die eine Nachführung
 * BEGRÜNDEN. Ein fehlender Wert erzeugt keinen Chip (nie eine erfundene 0),
 * und das Vorzeichen des Netzanschlusses erreicht den Kunden als WORT.
 */
export function measurementChips(snap: LiveSnapshot | null): JetztChip[] {
  if (!snap) return [];
  const out: JetztChip[] = [];
  if (snap.socPct != null) out.push({ label: 'Speicher', value: fmtNum(snap.socPct, '%', 0) });
  if (snap.loadKw != null) out.push({ label: 'Haus', value: fmtNum(snap.loadKw, 'kW', 1) });
  if (snap.gridKw != null) {
    const g = Number(snap.gridKw);
    out.push({
      label: g > DEADBAND_KW ? 'Netzbezug' : g < -DEADBAND_KW ? 'Einspeisung' : 'Netz',
      value: fmtNum(Math.abs(g), 'kW', 1),
    });
  }
  return out;
}
