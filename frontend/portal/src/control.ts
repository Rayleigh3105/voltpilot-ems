// Pure derivation for the Anlagen-Seite "Steuerung" strip (captain decision 4):
// "Ihr Gerät regelt gerade auf X -> Wechselrichter bestätigt Y", healthy | mismatch |
// stale, plus "geprüft vor X". No React, no side effects - unit-tested in
// control.test.ts, rendered by components/MoneyView.tsx ControlStrip.
//
// Deliberately free of internal vocabulary (no register/Modbus/kill-switch
// jargon) - that detail lives on the technician's :8484 card.
import type { ControlStatus, ExecutionDirection, ExecutionMode } from './api';
import { CURTAIL_PLAN, curtailExecutionNote, type CurtailTruth } from './curtailment';
import { fmtNum, fmtRelative } from './format';

/**
 * The strip's state:
 *   healthy  - the inverter confirmed the commanded setpoint.
 *   mismatch - the inverter reported a different value than commanded.
 *   stale    - the last confirmation is older than the freshness window.
 *   off      - control is switched off for this device (Not-Aus).
 *   pending  - the model is not yet released for control (read-only).
 *   preparing - a controllable plant that has not reported a readback yet, so
 *               the loop is honestly shown as being set up (report N4).
 */
export type ControlState = 'healthy' | 'mismatch' | 'stale' | 'off' | 'pending' | 'preparing';

/**
 * Der Flussabgleich-Befund (aus `flowConflict.ts`), den die Steuerzeile im
 * bestätigten Zustand konsumiert: der Batterie-Sollwert ist register-bestätigt,
 * aber die Physik fließt anders. `info` = die gutartige Physik der vollen
 * Einspeisegrenze (grün, Haken bleibt), `warn` = bernstein „bitte im Blick
 * behalten" (Haken entfällt). Bewusst nur `{severity, text}` statt der ganzen
 * `FlowConflictView` — so bleibt `control.ts` frei von einem Import aus
 * `flowConflict.ts`, und die Steuerzeile bleibt die EINE Stelle, die Ton und
 * Satz konsistent zusammensetzt.
 */
export interface FlowConflictNote {
  severity: 'info' | 'warn';
  text: string;
}

export interface ControlStripView {
  state: ControlState;
  /**
   * The plain-German sentence, e.g. "Der Speicher entlädt gerade mit 4,0 kW –
   * vom Wechselrichter bestätigt".
   *
   * Variante B (Wortlaut-Überarbeitung vp-steuerung-ruhe-w2): the battery's
   * direction is a WORD in every state (pausiert / lädt / entlädt), never a
   * sign, never an arrow, so a resting battery ("Der Speicher pausiert gerade")
   * can no longer read as an external §14a/Netzbetreiber curtailment. Numbers
   * are `fmtNum(Math.abs(...))`; the confirmation becomes a half-sentence.
   *
   * It deliberately does NOT say "Fahrplan-Sollwert": since the in-slot
   * following duties the box may knowingly deviate from the plan's watt value,
   * so `commandedKw` is what the DEVICE regulates - not what the Fahrplan
   * planned. Both numbers under one word ("Fahrplan") on one screen was the
   * reported contradiction (Konzept vp-fahrplan-kunde-konzept K2): the plan bar
   * read −4,3 kW while this line read −6,1 kW. The plan value keeps its own
   * home - the Fahrplan page's Jetzt-Held names Plan and execution side by
   * side (`fahrplanJetzt.ts`).
   */
  sentence: string;
  /** The freshness note, e.g. "geprüft vor 3 s" (empty for off/pending). */
  agoNote: string;
  /** Maps to the Badge status tone (dot colour). */
  tone: 'ok' | 'warn' | 'off';
  /**
   * WHY the setpoint is what it is - the plan's OWN reason for the slot being
   * executed, in plain German (e.g. "Lädt günstig aus dem Netz: Börsenpreis
   * 3,3 ct/kWh liegt unter dem Wert gespeicherter Energie (≈ 28,0 ct/kWh).").
   *
   * The owner's question at Anlage Pilsting (2026-07-30) was exactly this: the
   * strip stated a command and its confirmation and read like a stubborn order.
   * The reason is NOT computed here - it comes from the optimizer's per-slot
   * why-layer (`slotWhy` over the active plan slot), so there is no second
   * explanation logic. Null when the plan recorded no reason (a pre-why run, an
   * unknown role) or when nothing is being executed - the strip then reads
   * exactly as before, never with an invented cause.
   */
  reason: string | null;
  /**
   * WAS das Gerät gerade selbst am Sollwert geändert hat, in einem Satz -
   * `executionNote()` über die Ausführungs-Felder des Heartbeats (PR 3).
   *
   * Der Unterschied zu `reason`: `reason` ist die Begründung des OPTIMIERERS
   * für den Slot, `execution` die des GERÄTS für die Abweichung vom
   * Plan-Watt-Wert. Null, solange die Edge-Version die Felder nicht sendet
   * oder gar nichts korrigiert wurde - dann wird keine Richtung behauptet.
   */
  execution: string | null;
  /**
   * Die Abregel-Wahrheit, falls in der laufenden Viertelstunde überhaupt
   * gedrosselt werden soll (PR 3 von 4, Scout `vp-pilsting-abregeln`): „Ihre
   * Anlage setzt das noch nicht um (0 von 2 Wechselrichtern freigegeben)." bzw.
   * „Die Einspeisung ist auf 12,5 kW begrenzt — vom Wechselrichter bestätigt."
   *
   * Der Unterschied zu `execution`: dort geht es um den BATTERIE-Sollwert, hier
   * um die EINSPEISE-Begrenzung — zwei verschiedene Steuerpfade, die die
   * Steuerzeile bis PR 3 unter einer Bestätigung vermischte („bestätigt 0,0 kW"
   * deckte nur die Batterie). Null ohne Beleg oder ohne Abregel-Slot: dann sagt
   * die Karte über die Abregelung nichts, statt etwas zu behaupten.
   */
  curtailment: string | null;
  /**
   * Die Ausblick-Zeile aus dem Fahrplan (vp-steuerung-ruhe-w2, Teil 3): der
   * nächste geplante Einsatz, z. B. "→ Weiter laut Fahrplan: Laden ab ca.
   * 11:15 Uhr." Sie verwandelt "nichts passiert" in "gleich geht's weiter" -
   * und erscheint deshalb NUR im Ruhefall (der Speicher pausiert). Null, wenn
   * der Plan im Horizont keinen Einsatz mehr vorsieht, keine Slots geladen sind,
   * die Batterie gerade lädt/entlädt, oder ein Überschuss-Satz die Lage schon
   * vollständig (samt Ladezeit) erklärt. Der Aufrufer liefert den Text über
   * {@link planOutlook}; die Karte rendert ihn in Action-Blau (`.vp-outlook`).
   */
  outlook: string | null;
}

// A confirmation older than this reads as "stale" - kept in sync with the
// device liveness window used elsewhere in the portal (5 min).
export const CONTROL_STALE_MS = 5 * 60 * 1000;

/**
 * Below this a commanded/read-back setpoint reads as "pausiert" - mirrors the
 * 0,05-kW deadband used across the portal (`live.ts` DEADBAND_KW, `schedule.ts`
 * SLOT_DEADBAND_KW) so the strip agrees with the energy flow + the plan chart.
 */
export const CONTROL_DEADBAND_KW = 0.05;

/** „6,1 kW" ohne Vorzeichen — die Richtung ist ein Wort, nie ein Minus. */
function absKw(v: number): string {
  return fmtNum(Math.abs(v), 'kW', 1);
}

/** Die drei Richtungen des Batterie-Sollwerts als Vokabular. */
export type BatteryDir = 'laden' | 'entladen' | 'pausieren';

/**
 * Die Richtung eines Batterie-Werts als WORT, nie als Vorzeichen. Die
 * Konvention ist im Code empirisch belegt: `+ = laden`, `− = entladen`
 * (`live.ts` `batteryState`, der Edge-Steueradapter „VoltPilot + = charge", der
 * mqtt-schedule-Contract). `commandedKw` ist der Wert, den das GERÄT regelt.
 */
export function batteryDirection(kw: number | null | undefined): BatteryDir {
  const n = num(kw);
  if (n == null || Math.abs(n) <= CONTROL_DEADBAND_KW) return 'pausieren';
  return n > 0 ? 'laden' : 'entladen';
}

/**
 * Variante B, gesunder Fall: „Der Speicher lädt/entlädt gerade mit X kW – vom
 * Wechselrichter bestätigt" bzw. „Der Speicher pausiert gerade – vom
 * Wechselrichter bestätigt". Nie ein Vorzeichen, nie „regelt auf X".
 */
function directionSentence(cmd: number | null): string {
  const n = num(cmd);
  const dir = batteryDirection(n);
  if (dir === 'pausieren') return 'Der Speicher pausiert gerade – vom Wechselrichter bestätigt';
  const verb = dir === 'laden' ? 'lädt' : 'entlädt';
  return `Der Speicher ${verb} gerade mit ${absKw(n as number)} – vom Wechselrichter bestätigt`;
}

/**
 * Variante B, Abweichung: „Der Speicher soll mit 4,0 kW laden – der
 * Wechselrichter meldet 2,1 kW". Die Richtung ist auf beiden Seiten ein Wort,
 * nie ein Vorzeichen: die „soll"-Seite trägt das Verb (laden/entladen/
 * pausieren); die „meldet"-Seite bleibt bei gleicher Richtung schlicht
 * („meldet 2,1 kW"), nennt aber bei ABWEICHENDER Richtung (oder „soll
 * pausieren, meldet X") das gemeldete Verhalten ausdrücklich ("meldet 4,0 kW
 * Ladung" / „meldet Stillstand"), damit das Gegenteil nie verborgen bleibt.
 */
function mismatchSentence(cmd: number | null, conf: number | null): string {
  const c = num(cmd);
  const f = num(conf);
  const cmdDir = batteryDirection(c);
  const sollPhrase = cmdDir === 'pausieren' ? 'pausieren' : `mit ${absKw(c as number)} ${cmdDir}`;
  const confDir = batteryDirection(f);
  let meldet: string;
  if (confDir === 'pausieren') meldet = 'meldet Stillstand';
  else if (confDir === cmdDir) meldet = `meldet ${absKw(f as number)}`;
  else meldet = `meldet ${absKw(f as number)} ${confDir === 'laden' ? 'Ladung' : 'Entladung'}`;
  return `Der Speicher soll ${sollPhrase} – der Wechselrichter ${meldet}`;
}

/**
 * Variante B, veralteter Stand: „Zuletzt: Speicher lud/entlud mit X kW –
 * bestätigt" bzw. „Zuletzt: Speicher pausierte – bestätigt" (Vergangenheit,
 * richtungs-wortbasiert wie der gesunde Fall).
 */
function staleSentence(cmd: number | null): string {
  const n = num(cmd);
  const dir = batteryDirection(n);
  if (dir === 'pausieren') return 'Zuletzt: Speicher pausierte – bestätigt';
  const verb = dir === 'laden' ? 'lud' : 'entlud';
  return `Zuletzt: Speicher ${verb} mit ${absKw(n as number)} – bestätigt`;
}

/**
 * Der Klarstellungs-Halbsatz (Teil 2), NUR im Ruhefall an die Begründung
 * angehängt: er räumt das Missverständnis „meine PV wird gedrosselt" direkt
 * aus - nur der Speicher ruht, die Erzeugung nicht.
 */
export const PV_CLARIFICATION = 'Ihre Solaranlage erzeugt und speist normal weiter.';

/**
 * Die Richtung einer Nachführung als WORT. Beide sind bewusste Korrekturen -
 * eine unbenannte Korrektur liest sich als Defekt (genau der gemeldete
 * Eindruck, als die Steuerungs-Karte nur zwei verschiedene Zahlen zeigte).
 */
export function directionLabel(direction: ExecutionDirection | null | undefined): string | null {
  if (direction === 'deepen') return 'angehoben';
  if (direction === 'reduce') return 'begrenzt';
  return null;
}

/** Die deutschen Namen der additiven Ausführungs-Modi (Anzeige, nie Fachjargon). */
export const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  plan: 'Fahrplan',
  follow: 'Nachführung',
  trim: 'Solar-Überschuss',
  absorb: 'Überschuss-Aufnahme',
  fallback: 'Eingebaute Sicherung',
  idle_follow: 'Live-Lastnachführung',
  deficit_cover: 'Live-Lastdeckung',
  // Der abgelöste enge Vollakku-Fall (bis edge-2026.08.29). Nur noch eine
  // ältere Box meldet ihn; das Wort bleibt, damit ihre Meldung lesbar ist.
  high_soc_follow: 'Vollakku-Entlastung',
  high_soc_charge: 'PV-Puffer-Nachladung',
  autonomous_discharge: 'Wechselrichter-Automatik',
};

/**
 * executionNote - der EINE deutsche Satz, der die bewusste Abweichung des
 * Geräts vom Plan-Watt-Wert benennt.
 *
 * Das ist die Lücke, die PR 3 schließt: `commandedKw` trägt seit den
 * In-Slot-Pflichten den KORRIGIERTEN Wert, aber nichts sagte, warum - also
 * standen zwei verschiedene Zahlen (Plan-Balken vs. geregelter Wert) ohne
 * Erklärung nebeneinander. Der Satz nennt die Richtung, den Plan-Wert und den
 * gemessenen Wert, dem gefolgt wird.
 *
 * **Nie eine Behauptung ohne Daten** (§7 Regel 4): ohne Ausführungs-Felder
 * (ältere Edge-Version) und bei `plan` gibt es KEINEN Satz - der Aufrufer
 * bleibt dann bei seiner generischen Formulierung. Ein fehlender Messwert
 * lässt seinen Halbsatz weg statt eine 0 zu erfinden.
 */
export function executionNote(status: ControlStatus | null): string | null {
  const mode = status?.executionMode ?? null;
  if (!status || mode == null || mode === 'plan') return null;

  const planned = num(status.executionPlannedKw);
  const target = num(status.executionTargetKw);
  const plannedPart = planned == null ? '' : `Der Fahrplan sah ${absKw(planned)} vor — `;
  const measured = target == null ? '' : ` (${absKw(target)})`;

  if (mode === 'fallback') {
    return (
      'Auf Ihrem Gerät liegt kein aktueller Fahrplan — es regelt selbstständig auf ' +
      'Eigenverbrauch (die eingebaute Sicherung).'
    );
  }
  if (mode === 'trim') {
    const surplus = target == null ? '' : ` (${absKw(target)})`;
    return (
      `${plannedPart}geladen wird nur der gemessene Solar-Überschuss${surplus}: ` +
      'Netzstrom wäre in dieser Viertelstunde teurer als der spätere Nutzen.'
    );
  }
  if (mode === 'absorb') {
    return `${plannedPart}Ihr Gerät nimmt gerade den gemessenen Solar-Überschuss auf.`;
  }
  if (mode === 'idle_follow' || mode === 'autonomous_discharge') {
    const path = mode === 'idle_follow' ? 'der 10-Sekunden-Nachführung' : 'der Wechselrichter-Automatik';
    return `${plannedPart}Unerwarteter Verbrauch wird live mit ${path}${measured} gedeckt.`;
  }
  if (mode === 'deficit_cover') {
    return (
      `${plannedPart}Ihr Verbrauch${measured} wird gerade aus dem Speicher gedeckt, statt ` +
      'ihn einzukaufen. Der Fahrplan sieht in dieser Viertelstunde keine Ladung vor.'
    );
  }
  if (mode === 'high_soc_follow') {
    return (
      `${plannedPart}Der Speicher ist nahezu voll. VoltPilot deckt den nach Solar verbleibenden ` +
      `Verbrauch${measured} jetzt aus dem Speicher und schafft nur ein kleines oberes Pufferfenster.`
    );
  }
  if (mode === 'high_soc_charge') {
    const surplus = target == null ? '' : ` (${absKw(target)})`;
    return (
      `${plannedPart}Der gemessene Solar-Überschuss${surplus} lädt den fast vollen Speicher ` +
      'jetzt bis zur Ladegrenze nach. VoltPilot nutzt damit den oberen PV-Puffer, statt in ' +
      'diesem Verbrauchs-Slot einzuspeisen.'
    );
  }
  // follow
  if (status.executionDirection === 'reduce') {
    return (
      `${plannedPart}Ihr Haus braucht gerade weniger. Die Entladung wurde auf den ` +
      `gemessenen Verbrauch${measured} begrenzt, damit kein Strom unnötig ins Netz geht.`
    );
  }
  if (status.executionDirection === 'deepen') {
    return (
      `${plannedPart}Ihr Haus braucht gerade mehr. Die Entladung wurde auf den ` +
      `gemessenen Verbrauch${measured} angehoben, damit kein Netzstrom nötig ist.`
    );
  }
  // Nachführung ohne gemeldete Richtung: benennen, aber keine erfinden.
  return `${plannedPart}Ihr Gerät folgt gerade dem gemessenen Verbrauch${measured}.`;
}

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/**
 * WARUM die Steuerung noch nicht freigegeben ist - der Satz, den „wird
 * vorbereitet" bisher verschluckt hat (Plattform-Register, 10.08.2026).
 *
 * Drei Situationen, drei Sätze:
 *
 * - **zertifiziert, Aktivierung ausstehend**: das Modell ist am Prüfstand
 *   freigegeben, es fehlt der eine bewusste Klick. Der Kunde erfährt, dass es
 *   NICHT an seiner Anlage liegt - und dass es schnell geht.
 * - **noch nicht zertifiziert**: für dieses Modell ist wirklich ein
 *   Prüfstandslauf nötig; kein Klick ersetzt ihn.
 * - **unbekannt** (älteres Gerät, oder es hat nie ein Cloud-Dokument gesehen):
 *   dann wird GAR NICHTS behauptet, und der Satz bleibt der alte.
 *
 * ⚠ `null`/`unknown` darf nie wie `not_covered` klingen: das schickte einen
 * Kunden zu einem Prüfstand, den er nicht braucht.
 */
/**
 * Der Satz für eine Anlage, die AUSDRÜCKLICH ohne Ladestand eingerichtet wurde
 * („Trotzdem fortfahren (nur Lesen)", Live-Fall Mühlfeldweg 2, 21.08.2026).
 *
 * Er steht VOR jedem Freigabe-Satz, weil er den konkreten, behebbaren Grund
 * nennt: ohne Ladestand ist die SoC-Klemme blind, die den Speicher vor Tief-
 * und Überladung schützt - ein Prüfstandslauf ändert daran nichts. Und er nennt
 * den Weg zurück, statt eine Sackgasse zu behaupten.
 */
export const OHNE_LADESTAND_SATZ =
  'Steuerung nicht möglich - kein Ladestand vom BMS. Sobald das BMS gekoppelt ist und der '
  + 'Ladestand erscheint, lässt sie sich aktivieren.';

function pendingSentence(status: ControlStatus): string {
  const base = 'Die Steuerung ist für dieses Modell noch nicht freigegeben - die Anlage wird nur ausgelesen.';
  switch (status.platformCertVerdict) {
    case 'covered_not_activated':
      return (
        'Ihr Wechselrichter-Modell ist für die Steuerung freigegeben - VoltPilot muss sie für ' +
        'diese Anlage nur noch einschalten. Bis dahin wird die Anlage nur ausgelesen.'
      );
    case 'not_covered':
      return (
        'Die Steuerung ist für dieses Wechselrichter-Modell noch nicht freigegeben - VoltPilot ' +
        'prüft es zuerst am Prüfstand. Bis dahin wird die Anlage nur ausgelesen.'
      );
    default:
      // 'granted' kann hier gar nicht stehen (certified wäre dann true),
      // 'unknown'/null behauptet nichts.
      return base;
  }
}

/**
 * Der Freigabe-Stand in EINEM Wort (Geräteseiten Stufe 4, Konzept
 * `vp-geraeteseite-rahmen-r2` §5.1: „Zweite Zeile: Freigabe-Stand in einem
 * Wort").
 *
 * ⚠ Er wohnt HIER, weil hier schon {@link pendingSentence} wohnt - der lange
 * Satz und das kurze Wort sind zwei Längen DERSELBEN Aussage, und zwei
 * Ableitungen darüber wären zwei Urteile über dieselbe Freigabe.
 *
 * ⚠ **`unknown`/null behauptet NICHTS** (`null`): ein Gerät, das sich zum
 * Register nie geäußert hat, ist nicht „nicht freigegeben" - wer die zwei
 * zusammenfallen lässt, schickt einen Kunden zu einem Prüfstand, den er nicht
 * braucht (die Haus-Regel des Plattform-Registers).
 */
export function freigabeWort(
  status: ControlStatus | null | undefined,
): { wort: string; ton: 'ok' | 'warn' | 'off' } | null {
  if (!status) return null;
  if (status.certified) return { wort: 'freigegeben', ton: 'ok' };
  switch (status.platformCertVerdict) {
    case 'covered_not_activated':
      return { wort: 'für diese Anlage einschalten', ton: 'warn' };
    case 'not_covered':
      return { wort: 'Prüfstand nötig', ton: 'off' };
    default:
      return null;
  }
}

/**
 * controlStrip - derive the calm "Steuerung" strip from the latest control
 * confirmation.
 *
 * `status` is null when no readback has arrived yet. By default the strip is
 * then not rendered (returns null). For a controllable plant (a battery with a
 * controlling device, `expectControl = true`) the strip stays honest instead
 * (report N4): "Die Steuerung wird vorbereitet ..." so the "is the plan being
 * executed" loop is always visibly closed rather than silently missing.
 *
 * `reason` is the plan's OWN why-sentence for the slot being executed (built by
 * the caller from `slotWhy(activeSlot)` - see `controlReasonSlot`). It is only
 * attached to the states that actually SHOW a commanded setpoint: explaining a
 * setpoint that is not being executed (off / not released / no readback yet)
 * would be a claim about something that is not happening.
 */
export function controlStrip(
  status: ControlStatus | null,
  now: Date = new Date(),
  expectControl = false,
  reason: string | null = null,
  curtail: CurtailTruth = CURTAIL_PLAN,
  outlook: string | null = null,
  surplusActive = false,
  /**
   * Diese Anlage wurde ausdrücklich OHNE Ladestand eingerichtet (der Beleg
   * `reading_override` an ihrer Wechselrichter-Komponente). Der Aufrufer liest
   * die Tatsache; hier wird sie nie geraten.
   */
  ohneLadestand = false,
  /**
   * Der entprellte Flussabgleich (aus `flowConflict.ts`), falls im bestätigten
   * Zustand die Physik anders fließt als der Sollwert lautet. Er ersetzt DANN
   * den gesunden Satz: `info` grün (voller Netzanschluss nimmt Überschuss auf,
   * Ton bleibt `ok`), `warn` bernstein („bitte im Blick behalten"). null = kein
   * (belegter, entprellter) Widerspruch → die Zeile ist zeichengleich wie zuvor.
   */
  flow: FlowConflictNote | null = null,
): ControlStripView | null {
  if (!status) {
    if (!expectControl) return null;
    return {
      state: 'preparing',
      tone: 'off',
      sentence:
        'Die Steuerung wird vorbereitet - sobald Ihr Wechselrichter den ersten Sollwert bestätigt, sehen Sie es hier.',
      agoNote: '',
      reason: null,
      execution: null,
      curtailment: null,
      outlook: null,
    };
  }

  // Not yet released for control: the inverter is only monitored - but WHY?
  // Until the platform register existed, this one sentence swallowed three
  // different situations, and the customer could not tell "a bench run is
  // needed" from "one click is missing" from "we do not know yet".
  //
  // ⚠ Der fehlende Ladestand steht VOR allen dreien: er ist der konkrete,
  // behebbare Grund, und „VoltPilot prüft es am Prüfstand" wäre daneben eine
  // Falschaussage (ein Prüfstandslauf bringt kein BMS ans Laufen). Wo die
  // Anlage TROTZDEM steuert (certified), wird nichts behauptet - dann läuft sie
  // ja, und ein „nicht möglich" wäre die nächste Falschaussage.
  if (!status.certified) {
    return {
      state: 'pending',
      tone: 'off',
      sentence: ohneLadestand ? OHNE_LADESTAND_SATZ : pendingSentence(status),
      agoNote: '',
      reason: null,
      execution: null,
      curtailment: null,
      outlook: null,
    };
  }

  // Die Selbst-Erklärung des GERÄTS (PR 3) - nur dort angehängt, wo auch ein
  // Sollwert gezeigt wird; sie erklärt eine Abweichung, die ohne Sollwert gar
  // nicht sichtbar wäre. Null ohne Ausführungs-Felder (ältere Edge-Version).
  const note = executionNote(status);
  // Die Abregel-Wahrheit steht nur dort, wo auch ein Sollwert gezeigt wird -
  // aus demselben Grund wie `note`: eine Aussage über eine Ausführung, die
  // gerade gar nicht stattfindet, wäre eine Behauptung. Der Aufrufer hat sie
  // bereits auf den laufenden Slot gefiltert (`curtailTruthForSlot`).
  const curtailNote = curtailExecutionNote(curtail);
  const ago = fmtRelative(status.checkedAt, now);
  const ageMs = now.getTime() - new Date(status.checkedAt).getTime();
  const stale = !isNaN(ageMs) && ageMs > CONTROL_STALE_MS;

  // Control switched off (Not-Aus): honest, calm, not an error.
  if (!status.controlEnabled) {
    return {
      state: 'off',
      tone: 'off',
      sentence: 'Die Wechselrichter-Steuerung ist ausgeschaltet. VoltPilot liest die Anlage aus, steuert sie aber nicht.',
      agoNote: '',
      reason: null,
      execution: null,
      curtailment: null,
      outlook: null,
    };
  }

  if (stale) {
    return {
      state: 'stale',
      tone: 'off',
      sentence: staleSentence(status.commandedKw),
      agoNote: `zuletzt geprüft ${ago}`,
      reason,
      execution: note,
      curtailment: curtailNote,
      outlook: null,
    };
  }

  if (!status.allMatch) {
    return {
      state: 'mismatch',
      tone: 'warn',
      sentence: mismatchSentence(status.commandedKw, status.confirmedKw),
      agoNote: `Abweichung · geprüft ${ago}`,
      reason,
      execution: note,
      curtailment: curtailNote,
      outlook: null,
    };
  }

  // Healthy. Only in the RUHE case (the battery pauses) do the two calm
  // additions appear: the clarification half-sentence (PV keeps running) and
  // the Fahrplan outlook. Both are suppressed when a surplus reason already
  // explains the feed-in itself (`surplusActive`) - it names the export (and,
  // in the "waits to charge later" case, the charge time), so appending the
  // clarification or a second outlook line would only repeat it.
  const isRuhe = batteryDirection(status.commandedKw) === 'pausieren';
  const ruheReason =
    isRuhe && reason && !surplusActive ? `${reason} ${PV_CLARIFICATION}` : reason;
  const ruheOutlook = isRuhe && !surplusActive ? outlook : null;

  // Der Flussabgleich versöhnt Register- und Physik-Wahrheit: der Sollwert
  // ist bestätigt, aber die Batterie fließt anders (der Deye schiebt Überschuss
  // jenseits der vollen Einspeisegrenze selbst in den Speicher). Der Befund
  // ERSETZT den gesunden Satz - „Der Speicher pausiert gerade" neben einem
  // Flussbild „lädt 10,0 kW" war der gemeldete Widerspruch.
  //   - `info`: gutartige Physik, Ton bleibt `ok`, der Grund (Warte-Ökonomie)
  //     bleibt daneben stehen.
  //   - `warn`: bernstein; der Plan-Grund tritt zurück (er würde die Warnung
  //     überlagern), die Aussage ist „bitte im Blick behalten".
  if (flow) {
    const warn = flow.severity === 'warn';
    return {
      state: 'healthy',
      tone: warn ? 'warn' : 'ok',
      sentence: flow.text,
      agoNote: `geprüft ${ago}`,
      reason: warn ? null : ruheReason,
      execution: warn ? null : note,
      curtailment: warn ? null : curtailNote,
      outlook: warn ? null : ruheOutlook,
    };
  }
  return {
    state: 'healthy',
    tone: 'ok',
    sentence: directionSentence(status.commandedKw),
    agoNote: `geprüft ${ago}`,
    reason: ruheReason,
    execution: note,
    curtailment: curtailNote,
    outlook: ruheOutlook,
  };
}

/**
 * The plan slot the strip explains: the one whose
 * [start, start + slotMinutes) contains `now`.
 *
 * Null outside the plan's horizon - the strip then states the command and its
 * confirmation and claims NO cause, exactly like a plan from before the
 * why-layer (idleReason's discipline: an uncomputed cause stays absent instead
 * of being invented).
 */
export function controlReasonSlot<T extends { start: string }>(
  slots: T[],
  now: Date = new Date(),
  slotMinutes = 15,
): T | null {
  const t = now.getTime();
  const width = slotMinutes * 60_000;
  for (const s of slots) {
    const start = new Date(s.start).getTime();
    if (!isNaN(start) && t >= start && t < start + width) return s;
  }
  return null;
}

// ---- The Ruhe outlook (Teil 3) -------------------------------------------

/** de-DE "11:15". */
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** The next engaged slot after `now` (the battery charges or discharges). */
export interface NextEngagement {
  kind: 'laden' | 'entladen';
  /** ISO start of that slot. */
  start: string;
}

/**
 * The first plan slot STARTING at or after `now` whose battery is engaged
 * (beyond the deadband). The current slot (started before `now`) is skipped -
 * in the Ruhe case it is the idle one, so this is the next thing the battery
 * does. Null when the plan schedules no further engagement or has no slots.
 */
export function nextEngagement<T extends { start: string; batteryKw: number | null }>(
  slots: T[],
  now: Date = new Date(),
): NextEngagement | null {
  const t = now.getTime();
  for (const s of slots) {
    const start = new Date(s.start).getTime();
    if (isNaN(start) || start < t) continue;
    const dir = batteryDirection(s.batteryKw);
    if (dir === 'pausieren') continue;
    return { kind: dir, start: s.start };
  }
  return null;
}

/**
 * The Ruhe outlook line (Teil 3): "→ Weiter laut Fahrplan: Laden ab ca. 11:15
 * Uhr." from the plan slots the page has already loaded. Null when the plan
 * shows no further engagement in the horizon - honest, never a fabricated time.
 */
export function planOutlook<T extends { start: string; batteryKw: number | null }>(
  slots: T[],
  now: Date = new Date(),
): string | null {
  const ne = nextEngagement(slots, now);
  if (!ne) return null;
  const verb = ne.kind === 'laden' ? 'Laden' : 'Entladen';
  return `→ Weiter laut Fahrplan: ${verb} ab ca. ${hhmm(ne.start)} Uhr.`;
}

/**
 * ISO start of the next CHARGE slot at or after `now` - the surplus "waits to
 * charge later" reason (fahrplanWhy `surplusWhy` case c) names that time. Null
 * when the plan schedules no further charge.
 */
export function nextChargeStart<T extends { start: string; batteryKw: number | null }>(
  slots: T[],
  now: Date = new Date(),
): string | null {
  const t = now.getTime();
  for (const s of slots) {
    const start = new Date(s.start).getTime();
    if (isNaN(start) || start < t) continue;
    if (batteryDirection(s.batteryKw) === 'laden') return s.start;
  }
  return null;
}
