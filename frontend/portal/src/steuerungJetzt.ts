/**
 * Zone ① **„Jetzt"** der Steuerung (Konzept `vp-steuerung-konzept-b3` §3.2,
 * Stufe 1) — die Antwort auf die häufigste Frage des Kunden: *Was tut meine
 * Anlage gerade automatisch, warum, und kann ich eingreifen?*
 *
 * Je steuerbarer Sache EINE Zeile: **Komponente · Zustand jetzt · Grund ·
 * Quelle · seit/bis · Handeingriff**. Alles kommt aus BESTEHENDEN Endpunkten
 * (`schedule`, `control-status`, `consumer-status`, `consumer-overrides`,
 * `chargers`, `curtailment-status`); es gibt hier keine neue Route und keinen
 * neuen Speicher.
 *
 * **Es entsteht KEINE zweite Steuerungs-Ableitung** (dieselbe Regel, unter der
 * schon `fahrplanJetzt.ts` steht): der Speicher geht durch dasselbe
 * `control.controlStrip`, das die Cockpit-Karte rendert, der Warum-Satz durch
 * dasselbe `fahrplanWhy.slotWhy`, ein Gerät durch dasselbe
 * `consumers/status.consumerStatusLine` und ein laufender Handeingriff durch
 * dasselbe `consumers/fulfillment.overrideLine`. Cockpit, Fahrplan-Seite und
 * Steuerung können sich damit über dieselbe Sekunde nicht widersprechen.
 *
 * Die fünf Ehrlichkeitsregeln, die nicht wegoptimiert werden dürfen:
 *
 *  1. **Ohne Beleg keine Zeile.** Eine Anlage ohne Speicher, ohne Gerät und
 *     ohne Ladepunkt bekommt KEINE Zeilen, sondern den Leer-Satz mit dem Weg
 *     (§3.9) — nie eine Zeile, die „—" behauptet.
 *  2. **Kein erfundener Wert.** Fehlt ein Messwert, sagt die Zeile ihren
 *     Zustand ohne Zahl; eine 0 wäre eine Aussage, die niemand gemessen hat.
 *  3. **Die QUELLE wird nur genannt, wenn sie belegt ist** — und in dieser
 *     Rangfolge: laufender Handeingriff (die Cloud hat ihn erteilt und kennt
 *     sein Ende) → aktive Regel auf DIESER Komponente (die Aktivierung ist ein
 *     Server-Fakt) → Fahrplan (es läuft ein Slot). Ohne all das bleibt sie
 *     `unbekannt`, und die Zeile behauptet keinen Urheber.
 *  4. **Ein Knopf, der nichts bewirken kann, wird nicht angeboten.** Der
 *     Speicher-Handeingriff existiert cloud-seitig noch nicht (Konzept §3.7
 *     B2–B4, Stufe 4) — seine Zeile trägt deshalb KEINE Aktion und nennt den
 *     Grund, statt eine Taste anzubieten, die in nichts läuft.
 *  5. **Ein Ende wird gesagt, nie geschätzt.** Der Countdown rechnet aus dem
 *     server-gesetzten `endsAt`; ein unlesbarer Stempel ergibt keinen
 *     Countdown, nicht einen erfundenen.
 *
 * REIN + unit-getestet (`steuerungJetzt.test.ts`); die Fläche rendert nur.
 */
import type {
  ControlStatus,
  CurtailmentStatus,
  Intervention,
  ScheduleSlot,
  SchedulePlan,
  SiteInterventions,
} from './api';
import { CONTROL_DEADBAND_KW, batteryDirection, controlReasonSlot, controlStrip } from './control';
import { curtailTruth, curtailTruthForSlot, type CurtailTruth } from './curtailment';
import { slotWhy, type PlanWhyFacts, type WhySlot } from './fahrplanWhy';
import { overrideLine, sofortAktionen, type ManualOverride, type SofortAktion } from './consumers/fulfillment';
import { consumerStatusLine, STATUS_UNKNOWN_TEXT, type ConsumerRuntimeStatus } from './consumers/status';
import {
  pauseBanner,
  speicherAktionen,
  speicherKeinEingriff,
  type HandeingriffAktion,
} from './handeingriff';
import type { Consumer } from './consumers/types';
import {
  aktuelleLeistung,
  ladepunktBanner,
  chargerName,
  connectorName,
  ladepunktAktionen,
  ladepunktKeinEingriff,
  ladevorgangRows,
  type ChargePoint,
  type LadeZustandKind,
  type LadepunktAktion,
  type LadepunktEingriff,
  type LadevorgangRow,
  type SiteCharging,
} from './ladepunkte';
import { fmtNum } from './format';
import type { PlanWordingKind } from './schedule';

/**
 * Was in einer Zeile steht.
 *
 * **⚠ `ladepark` ist ENTFALLEN** (Verbrauchsmanagement v1 §6.1: „Der Ladepark
 * ist keine Sammelzeile mehr"): die Kopfzahl „22 kW von 32 kW verteilt" steht
 * im Ladepark-Rahmen der Verbraucher-Zone, und JEDER Ladepunkt bekommt hier
 * seine eigene Zeile — sonst gäbe es keinen Ort, an dem man in EINEN
 * Ladevorgang eingreifen kann.
 */
export type JetztArt = 'speicher' | 'geraet' | 'ladepunkt';

/** Woher der Befehl kommt, der gerade wirkt. */
export type JetztQuelle =
  | 'handeingriff'
  | 'regel'
  | 'fahrplan'
  /** Das Grundverhalten der Komponente (Verbrauchsmanagement v1). */
  | 'steuerart'
  | 'unbekannt';

export type JetztTon = 'ok' | 'warn' | 'off';

export interface JetztZeile {
  key: string;
  art: JetztArt;
  /**
   * Die Komponenten-Id — der Schlüssel, unter dem das Zeilen-Menü seinen
   * Handeingriff schickt. `null` heißt: diese Zeile adressiert keine einzelne
   * Komponente (der Ladepark ist die Anlage, nicht ein Gerät).
   */
  entityId: string | null;
  name: string;
  /** Der Zustand JETZT, als Satz („lädt 3,2 kW"). */
  zustand: string;
  /** Der Grund — null, wenn keiner aufgezeichnet ist. */
  grund: string | null;
  quelle: JetztQuelle;
  /** Die Quelle als Wort („Fahrplan", „Regel", „Handeingriff bis 14:30 Uhr"). */
  quelleText: string | null;
  /** Der Countdown eines laufenden Handeingriffs („noch 1 Std. 12 Min."). */
  bis: string | null;
  ton: JetztTon;
  /**
   * Die Handeingriffe, die diese Zeile WIRKLICH anbietet (leer = keine).
   * Verbraucher sprechen das `SofortAktion`-Vokabular, der Speicher das der
   * Stufe 4 (`speicher_laden`/`speicher_halten`) — `resume` teilen sich beide.
   */
  aktionen: (SofortAktion | HandeingriffAktion | LadepunktAktion)[];
  /** Warum es keinen Handeingriff gibt — nur gesetzt, wenn `aktionen` leer ist. */
  keinEingriff: string | null;
  /**
   * Die Adresse eines Ladepunkt-Eingriffs (P3a). Ein Ladevorgang hängt an
   * einem STECKER, nicht an einer Komponente — `entityId` kann ihn deshalb
   * nicht tragen. `null` bei jeder anderen Zeilenart.
   */
  ladepunkt?: LadepunktAdresse | null;
  /**
   * Der NAME des Fahrzeugs, das hier gerade lädt (P7) - „Dienstwagen".
   *
   * ⚠ Nur ein BENANNTES Profil steht hier: eine unbenannte Karte („Karte
   * 1f2e…") sagt dem Kunden in der Jetzt-Zone nichts, was er nicht schon
   * sieht, und ein Pseudonym in einer Zustandszeile wäre Lärm. Ohne Karte oder
   * ohne Namen bleibt es `null` - nie eine erfundene Zuordnung.
   */
  fahrzeug?: string | null;
}

/** Wohin ein Ladepunkt-Handeingriff geht (`POST /charging-boost`). */
export interface LadepunktAdresse {
  chargePointId: string;
  connectorId: number;
  /** Der Name, wie die Zeile ihn zeigt — für Banner und Folgen-Karte. */
  name: string;
  /**
   * WELCHE der zwei Richtungen an dieser Zeile gerade läuft (P3b), `null` =
   * keine. Sie steht hier und nicht am Zustands-Wort, weil Banner UND
   * Rücknahme-Karte sie brauchen — und weil „ein Eingriff läuft" allein sie
   * beide falsch formulieren liesse.
   */
  eingriff?: LadepunktEingriff | null;
}

export interface JetztBanner {
  /** „Handeingriff läuft: Heizstab an bis 14:30 Uhr (noch 1 Std. 12 Min.)". */
  text: string;
  /** Der Weg zurück, wörtlich der Knopf-Titel. */
  aktion: string;
  entityId: string;
  /** Gesetzt, wenn der laufende Eingriff einem LADEPUNKT gilt (P3a). */
  ladepunkt?: LadepunktAdresse | null;
}

export interface JetztView {
  zeilen: JetztZeile[];
  /** Der Banner über der Zone, solange ein Handeingriff läuft. */
  banner: JetztBanner | null;
  /**
   * Der Leer-Satz mit dem Weg — nur gesetzt, wenn es NICHTS Steuerbares gibt
   * (§3.9). Gibt es Zeilen, ist er null.
   */
  leer: string | null;
  /**
   * „9 weitere Ladepunkte ohne Auto" — die Zeilen, die ab einem grossen
   * Ladepark bewusst NICHT einzeln stehen (§6.4: die Jetzt-Zone zeigt nur
   * Ladepunkte mit Auto). Sie werden GEZÄHLT, nie verschwiegen.
   */
  weitereLadepunkte: string | null;
}

export const JETZT_TITEL = 'Jetzt';

export const JETZT_INTRO =
  'Was Ihre Anlage gerade von selbst tut — und woher der Befehl kommt.';

/** Der Leer-Zustand: EIN Satz mit dem Weg, nicht drei (§3.9 / B7). */
export const JETZT_LEER =
  'Für diese Anlage steuert VoltPilot noch nichts. Sobald ein Speicher oder ein '
  + 'schaltbares Gerät eingerichtet ist, steht hier, was es gerade tut.';

/** Warum ein nicht verbundenes Gerät keinen Handeingriff hat. */
export const GERAET_NICHT_VERBUNDEN =
  'Dieses Gerät meldet sich gerade nicht — ein Eingriff käme nicht an.';

/** Warum ein Gerät ohne freigegebene Steuerung keinen Handeingriff hat. */
export const GERAET_NICHT_FREIGEGEBEN =
  'Für dieses Gerät ist das Schalten noch nicht freigegeben.';

export const BANNER_AKTION = 'Automatik fortsetzen';

/**
 * Die `entityId` des PAUSE-Banners. Die Pause gilt der ANLAGE und hat deshalb
 * keine Komponente - ein Sentinel ist ehrlicher als eine geliehene Id, weil
 * die Fläche daran erkennt, welchen Rückweg sie aufrufen muss.
 */
export const PAUSE_BANNER_ID = '__anlage__';

// ---------------------------------------------------------------------------
// Zeit
// ---------------------------------------------------------------------------

/** „14:30" eines ISO-Zeitpunkts; null, wenn er unlesbar ist. */
export function uhrzeit(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Die Restzeit bis `iso` als „noch 1 Std. 12 Min." — null, sobald sie abgelaufen
 * oder der Stempel unlesbar ist. Ein abgelaufener Handeingriff ist keiner mehr,
 * und ein unlesbares Ende ergibt keinen geschätzten Countdown.
 */
export function restZeit(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `noch ${min} Min.`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `noch ${h} Std.` : `noch ${h} Std. ${rest} Min.`;
}

// ---------------------------------------------------------------------------
// Speicher-Zeile
// ---------------------------------------------------------------------------

export interface SpeicherInput {
  /** Der Anzeigename der Speicher-Komponente; ohne einen heißt sie „Speicher". */
  name?: string | null;
  /** Der jüngste Rücklese-Zustand; null = noch keiner gemeldet. */
  control: ControlStatus | null;
  /** true, sobald die Anlage überhaupt gesteuert wird (Plan mit Gerät). */
  expectControl: boolean;
  /** Der Plan (für Slot + Warum-Satz); null = keiner geladen. */
  plan?: SchedulePlan | null;
  slots?: ScheduleSlot[] | null;
  planFacts?: PlanWhyFacts | null;
  /** Die Abregel-Beleglage — für den Warum-Satz des laufenden Slots. */
  curtail?: CurtailmentStatus | null;
  plantKind: PlanWordingKind;
  /**
   * Ob eine AKTIVE Kundenregel diesen Speicher beansprucht. Der Aufrufer weiß
   * es aus den aktiven Regeln (ein Server-Fakt); geraten wird es hier nie.
   */
  regelHaeltAn?: boolean;
  /**
   * Der laufende Handeingriff an diesem Speicher (Stufe 4); null = keiner.
   * Er kommt aus `GET /interventions` — geraten wird er nie.
   */
  eingriff?: Intervention | null;
  /** Pausiert die ganze Anlage gerade? Dann greift man nicht einzeln ein. */
  pausiert?: boolean;
  /**
   * Ob VoltPilot diesen Speicher überhaupt STEUERT. Ohne das gibt es keinen
   * Knopf, sondern den Grund — ein Knopf, der nichts bewirkt, ist schlimmer
   * als keiner.
   */
  steuerbar?: boolean;
  now: Date;
}

/** „lädt 3,2 kW" / „entlädt 4,0 kW" / „pausiert" — nie ein Vorzeichen. */
export function speicherZustand(commandedKw: number | null | undefined): string {
  const dir = batteryDirection(commandedKw);
  if (dir === 'pausieren') return 'pausiert';
  const n = Number(commandedKw);
  const verb = dir === 'laden' ? 'lädt' : 'entlädt';
  return `${verb} ${fmtNum(Math.abs(n), 'kW', 1)}`;
}

/**
 * Die Speicher-Zeile. Sie entsteht NUR, wenn es überhaupt etwas über den
 * Speicher zu sagen gibt (ein Rücklesen oder ein erwarteter Steuerpfad) —
 * sonst gibt es keine Zeile statt einer leeren.
 */
export function speicherZeile(input: SpeicherInput): JetztZeile | null {
  const slots = (input.slots ?? []) as WhySlot[];
  const slot = slots.length > 0 ? controlReasonSlot(slots, input.now) : null;
  // Die Abregel-Beleglage gilt NUR dem laufenden Abregel-Slot (dieselbe
  // Filterung wie auf der Fahrplan-Seite) — sonst erzählte ein Beleg von
  // vorhin die Geschichte des jetzigen Slots.
  const curtail: CurtailTruth = curtailTruthForSlot(
    input.curtail ? curtailTruth(input.curtail, input.now) : null,
    slot?.slotRole ?? null,
    slot != null,
  );
  const strip = controlStrip(input.control, input.now, input.expectControl);
  if (!strip) return null;

  const cmd = input.control?.commandedKw ?? null;
  // Der Zustand kommt aus dem, was das GERÄT regelt — aber nur, wenn das
  // Rücklesen wirklich trägt. Ohne bestätigten Sollwert spricht der Streifen
  // (er sagt dann ehrlich, warum es keine Zahl gibt).
  const traegt = strip.state === 'healthy' || strip.state === 'mismatch';
  const zustand = traegt && cmd != null ? speicherZustand(cmd) : strip.sentence;
  const why = slot ? slotWhy(slot, input.plantKind, curtail, slots, input.planFacts ?? null) : null;

  const quelle: JetztQuelle = input.regelHaeltAn
    ? 'regel'
    : (slot ? 'fahrplan' : 'unbekannt');
  const quelleText = quelle === 'regel'
    ? 'Ihre Regel'
    : (quelle === 'fahrplan' ? 'Fahrplan' : null);

  // Steuerung Stufe 4: der laufende Eingriff schlägt jede andere Quelle - er
  // IST der Befehl, der gerade wirkt.
  const eingriff = input.eingriff ?? null;
  const gate = {
    laufend: eingriff != null,
    steuerbar: input.steuerbar ?? (strip.state === 'healthy' || strip.state === 'mismatch'),
    pausiert: input.pausiert === true,
  };
  const aktionen = speicherAktionen(gate);
  const bis = eingriff ? uhrzeit(eingriff.endsAt) : null;
  const rest = eingriff ? restZeit(eingriff.endsAt, input.now) : null;

  return {
    key: 'speicher',
    art: 'speicher',
    entityId: eingriff?.entityId ?? null,
    name: input.name?.trim() ? input.name.trim() : 'Speicher',
    zustand,
    grund: traegt ? why : (strip.reason ?? why),
    quelle: eingriff ? 'handeingriff' : quelle,
    quelleText: eingriff
      ? `Handeingriff${bis ? ` bis ${bis} Uhr` : ''}`
      : quelleText,
    bis: rest,
    ton: strip.tone,
    aktionen,
    // ⚠ Die zwei Ableitungen sind KOMPLEMENTÄR: wo `speicherAktionen` leer
    // liefert, nennt `speicherKeinEingriff` den Grund - und umgekehrt. Deshalb
    // gibt es hier keinen Rückfall-Satz mehr (der der Stufe 1 wäre seit Stufe 4
    // sogar falsch: den Knopf gibt es).
    keinEingriff: aktionen.length === 0 ? speicherKeinEingriff(gate) : null,
  };
}

// ---------------------------------------------------------------------------
// Geräte-Zeilen
// ---------------------------------------------------------------------------

export interface GeraetInput {
  consumer: Consumer;
  status?: ConsumerRuntimeStatus | null;
  override?: ManualOverride | null;
  /** Ob IRGENDEIN Gerät Zustände gemeldet hat (die Beleg-Regel). */
  anyStatusReported: boolean;
}

/**
 * Eine Zeile je schaltbarem Gerät. Der Zustand kommt WÖRTLICH aus
 * `consumerStatusLine` (dieselbe Tabelle, die Cockpit-Streifen und Regel-Karte
 * lesen) — ein Wort, das der Ingest nicht kennt, hat sie längst verworfen.
 */
export function geraetZeile(input: GeraetInput, now: Date = new Date()): JetztZeile {
  const c = input.consumer;
  const line = input.anyStatusReported
    ? consumerStatusLine(input.status ?? undefined)
    : consumerStatusLine(undefined);
  const ov = overrideLine(input.override, now);
  const verbunden = c.connection === 'connected';
  const bis = ov ? restZeit(input.override?.endsAt, now) : null;
  const endeUhr = ov ? uhrzeit(input.override?.endsAt) : null;

  let quelle: JetztQuelle = 'unbekannt';
  let quelleText: string | null = null;
  if (ov) {
    quelle = 'handeingriff';
    quelleText = endeUhr ? `Handeingriff bis ${endeUhr} Uhr` : 'Handeingriff';
  } else if (c.controlActivation === 'active') {
    quelle = 'regel';
    quelleText = 'Ihre Regel';
  }

  // Der gemessene Wert steht nur da, wo er GEMESSEN wurde.
  const kw = input.status?.actualKw;
  const zustand = kw != null && Math.abs(Number(kw)) > CONTROL_DEADBAND_KW
    ? `${line.text} — ${fmtNum(Math.abs(Number(kw)), 'kW', 1)}`
    : line.text;

  const aktionen = sofortAktionen({
    connected: verbunden && c.controlActivation !== 'not_activated',
    hasOverride: ov != null,
  });
  let keinEingriff: string | null = null;
  if (aktionen.length === 0) {
    keinEingriff = verbunden ? GERAET_NICHT_FREIGEGEBEN : GERAET_NICHT_VERBUNDEN;
  }

  return {
    key: `geraet:${c.id}`,
    art: 'geraet',
    entityId: c.id,
    name: c.name,
    zustand,
    // Ein Grund, der den Zustand WÖRTLICH wiederholt, sagt nichts Zweites.
    grund: line.reason && line.reason !== line.text ? line.reason : null,
    quelle,
    quelleText,
    bis,
    ton: ov ? 'warn' : (line.text === STATUS_UNKNOWN_TEXT ? 'off' : line.tone),
    aktionen,
    keinEingriff,
  };
}

// ---------------------------------------------------------------------------
// Ladepunkt-Zeilen
// ---------------------------------------------------------------------------

/**
 * Ab wie vielen Ladepunkten nur noch die mit Auto einzeln stehen (§6.4).
 * Darunter steht jeder Ladepunkt — auch ein freier, denn auf einer kleinen
 * Anlage IST „Kein Auto eingesteckt" die Antwort auf „was passiert jetzt?".
 */
export const LADEPUNKTE_ALLE_BIS = 8;

/** „9 weitere Ladepunkte ohne Auto" — gezählt, nie verschwiegen. */
export function weitereLadepunkteSatz(n: number): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? 'weiterer Ladepunkt' : 'weitere Ladepunkte'} ohne Auto`;
}

/** Ein Zustand, bei dem kein Fahrzeug am Stecker hängt. */
function ohneAuto(kind: LadeZustandKind): boolean {
  return kind === 'frei' || kind === 'getrennt';
}

/**
 * Die `entityId` des LADEPUNKT-Banners. Ein Ladevorgang hat keine Komponente,
 * die man adressieren könnte — der Sentinel sagt der Fläche, dass der Rückweg
 * über `chargingBoost(cancel)` läuft und nicht über einen Geräte-Override.
 */
export const LADEPUNKT_BANNER_ID = '__ladepunkt__';

/**
 * Der Name eines Ladepunkts in der Jetzt-Zone (Konzept §6.2, Mockup 375):
 * „Wallbox Garage" bei genau einem Stecker, sonst „Säule Hof Nord · Stecker A".
 *
 * ⚠ Der Stecker wird nur genannt, wo er UNTERSCHEIDET. „Wallbox Garage ·
 * Stecker A" über der einzigen Buchse einer Wallbox ist Technik, die der Kunde
 * vor seiner Garage nicht braucht.
 */
export function ladepunktName(c: ChargePoint, connectorId: number): string {
  const count = (c.connectors ?? []).length;
  return count <= 1
    ? chargerName(c)
    : `${chargerName(c)} · ${connectorName(connectorId)}`;
}

/**
 * Eine Zeile JE LADEPUNKT (Verbrauchsmanagement v1, P1/P3a · Konzept §6.1+§6.2):
 * „Wallbox Garage · lädt 7,4 kW · Überschuss (Sonne zuerst)" — mit „Eingreifen ▸"
 * dort, wo eingegriffen wird (Befund S6: vorher vier Klicks auf einer anderen
 * Seite).
 *
 * ⚠ Es entsteht KEINE zweite Wahrheit über den Ladevorgang. Zustand, Ton und
 * Grund kommen aus `ladevorgangRows` (also aus `ladepunkte.ladeZustand`), die
 * Leistung aus `aktuelleLeistung` (ein veralteter Messwert liest NIE als
 * aktuell), die Handlung aus `ladepunktAktionen` — dieselben Ableitungen, die
 * die Ladevorgänge-Seite rendert. Diese Datei setzt sie nur zusammen.
 *
 * ⚠ Die QUELLE wird ÜBERGEBEN, nie geraten: ein laufender Boost IST der
 * Urheber, sonst die Steuerart, die der Server projiziert hat
 * (`GET /sites/{id}/verbraucher`). Ohne beides bleibt sie `unbekannt` — ein
 * vollwertiges Urteil.
 *
 * ⚠ Ein laufender Eingriff bekommt KEINEN Countdown: der Herzschlag meldet je
 * Stecker nur `boost: true|false`, kein Ende. „noch 1:12 h" wäre erfunden —
 * stattdessen steht dort, was wirklich gilt („endet beim Abstecken").
 *
 * Eine GETRENNTE Säule liefert keine Zeilen (`ladevorgangRows` überspringt
 * sie): was sie tut, wissen wir gerade nicht, und ihr Zustand steht auf ihrer
 * Komponenten-Karte.
 */
export function ladepunktZeilen(
  charging: SiteCharging | null | undefined,
  steuerart?: (entityId: string | null | undefined) => string | null,
  nowMs?: number,
  /**
   * Der NAME zu einem Karten-Pseudonym (P7). Ohne die Funktion - oder ohne
   * gepflegtes Profil - bleibt die Zeile Zeichen für Zeichen die von vorher.
   */
  fahrzeug?: (tagRef: string | null | undefined) => string | null,
): { zeilen: JetztZeile[]; weitere: string | null } {
  const chargers = charging?.chargers ?? [];
  if (chargers.length === 0) return { zeilen: [], weitere: null };
  const budget = charging?.budget ?? null;
  // ⚠ Gezählt wird, was WIRKLICH Zeilen ergibt: eine getrennte Säule steht
  // ohnehin nicht da, sie darf die Liste also auch nicht einklappen.
  const verbunden = chargers.filter((c) => c.connected);
  const alleZeigen = verbunden.length <= LADEPUNKTE_ALLE_BIS;

  const zeilen: JetztZeile[] = [];
  let ohne = 0;
  for (const c of verbunden) {
    const rows = ladevorgangRows([c], nowMs);
    if (!alleZeigen && !rows.some((r) => !ohneAuto(r.kind))) {
      ohne += 1;
      continue;
    }
    const quelleText = steuerart?.(c.entityId) ?? null;
    for (const row of rows) {
      const name = ladepunktName(c, row.connectorId);
      const aktionen = ladepunktAktionen(budget, row);
      const con = (c.connectors ?? []).find((k) => k.connectorId === row.connectorId);
      const kw = con ? aktuelleLeistung(con, nowMs) : null;
      const leer = ohneAuto(row.kind);
      zeilen.push({
        key: `ladepunkt:${row.key}`,
        art: 'ladepunkt',
        entityId: c.entityId ?? null,
        name,
        // Das Zustands-Wort der EINEN Wortquelle, klein geschrieben wie jede
        // andere Zeile dieser Zone („lädt 7,4 kW").
        zustand: ladepunktZustand(row, kw),
        grund: row.reason ?? row.nextTurn,
        // Ein laufender Boost IST der Urheber; sonst steuert die Steuerart —
        // und ohne Auto steuert gerade nichts, dann wäre jede Quelle eine
        // Aussage über einen Ladevorgang, den es nicht gibt.
        // Ein laufender Eingriff IST der Urheber - in BEIDE Richtungen (P3b).
        quelle: row.boost || row.handeingriff
          ? 'handeingriff'
          : leer || !quelleText
            ? 'unbekannt'
            : 'steuerart',
        quelleText: row.handeingriff
          ? 'Handeingriff'
          : row.boost
            ? 'Jetzt voll laden'
            : leer
              ? null
              : quelleText,
        bis: null,
        ton: row.tone === 'stoerung' ? 'warn' : row.tone === 'laedt' ? 'ok' : 'off',
        aktionen,
        keinEingriff: aktionen.length > 0 ? null : ladepunktKeinEingriff(budget, row),
        // ⚠ Nur an einer LAUFENDEN Ladung: „Dienstwagen" über einem freien
        // Stecker wäre eine Aussage über ein Auto, das nicht da ist.
        fahrzeug: leer ? null : fahrzeug?.(row.tagRef) ?? null,
        ladepunkt: {
          chargePointId: row.chargePointId,
          connectorId: row.connectorId,
          name,
          // ⚠ WELCHE Richtung läuft - der Banner und seine Rücknahme-Karte
          // sagen Gegenteiliges, und ein blosses „ein Eingriff läuft" schriebe
          // „lädt voll" über eine Ladung, die gerade gestoppt wurde.
          eingriff: row.handeingriff ? 'pausiert' : row.boost ? 'voll_laden' : null,
        },
      });
    }
  }
  return { zeilen, weitere: weitereLadepunkteSatz(ohne) };
}

/**
 * „lädt 7,4 kW" — die Zahl nur, wo die Säule sie FRISCH gemeldet hat.
 *
 * ⚠ Der Wert kommt aus `aktuelleLeistung`, nie aus `row.powerKw`: das Feld
 * trägt den ROHEN Messwert, und ein veralteter darf nie als aktuell lesen.
 *
 * ⚠ Bei laufendem Eingriff steht hier das BASIS-Wort: den Urheber nennt die
 * Zeile daneben als Quelle („Jetzt voll laden"), und zweimal wäre er Rauschen
 * (der Mockup-Wortlaut ist „Lädt 22 kW · Jetzt voll laden").
 */
function ladepunktZustand(row: LadevorgangRow, kw: number | null): string {
  // ⚠ Eine von HAND pausierte Ladung sagt genau das - nicht das OCPP-Wort der
  // Säule („eingesteckt · wartet"), das wie ein Leistungsmangel läse. Den
  // Urheber nennt die Zeile daneben als Quelle („pausiert · Handeingriff").
  if (row.handeingriff) return 'pausiert';
  const basis = row.boost ? row.basisWort : row.word;
  const wort = basis.charAt(0).toLowerCase() + basis.slice(1);
  return kw == null || row.tone !== 'laedt' ? wort : `${wort} ${fmtNum(kw, 'kW')}`;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/**
 * Der Banner über der Zone, solange ein Handeingriff läuft. Er nennt das Ende
 * als Uhrzeit UND als Countdown — beides aus demselben server-gesetzten
 * Stempel, nie geschätzt.
 */
export function jetztBanner(
  overrides: ManualOverride[] | null | undefined,
  namen: Record<string, string>,
  now: Date = new Date(),
  interventions?: SiteInterventions | null,
  charging?: SiteCharging | null,
): JetztBanner | null {
  // ⚠ Die ANLAGEN-Pause geht vor: sie beschreibt den Zustand der ganzen
  // Anlage, ein Geräte-Eingriff nur den einer Zeile. Zwei Banner gäbe es nie -
  // und das obere muss das Umfassendere sein.
  if (interventions?.automationPaused && interventions.pausedUntil) {
    const bis = uhrzeit(interventions.pausedUntil);
    return {
      text: pauseBanner(bis ? `${bis} Uhr` : 'auf Weiteres',
        restZeit(interventions.pausedUntil, now)),
      aktion: BANNER_AKTION,
      entityId: PAUSE_BANNER_ID,
    };
  }
  for (const o of interventions?.interventions ?? []) {
    if (o.entityId == null) continue;
    const bis = uhrzeit(o.endsAt);
    const rest = restZeit(o.endsAt, now);
    if (!bis) continue;
    const was = o.kind === 'speicher_laden' ? 'lädt' : 'hält seinen Ladestand';
    return {
      text: `Handeingriff läuft: Speicher ${was} bis ${bis} Uhr${rest ? ` (${rest})` : ''}`,
      aktion: BANNER_AKTION,
      entityId: o.entityId,
    };
  }
  for (const o of overrides ?? []) {
    const line = overrideLine(o, now);
    if (!line) continue;
    const name = namen[o.entityId] ?? 'Ihr Gerät';
    const was = o.kind === 'stop' ? 'aus' : 'an';
    const bis = uhrzeit(o.endsAt);
    const rest = restZeit(o.endsAt, now);
    const ende = bis ? ` bis ${bis} Uhr${rest ? ` (${rest})` : ''}` : '';
    return {
      text: `Handeingriff läuft: ${name} ${was}${ende}`,
      aktion: BANNER_AKTION,
      entityId: o.entityId,
    };
  }
  // ⚠ Der Ladepunkt-Boost steht ZULETZT: er ist der engste der Eingriffe (eine
  // einzelne Ladung), und über einer Anlagen-Pause oder einem Speicher-Eingriff
  // wäre er das kleinere über dem größeren. Ohne laufenden Boost ist dieser
  // Zweig ein No-op — die Zone bleibt dann Zeichen für Zeichen die von vorher.
  for (const z of ladepunktZeilen(charging).zeilen) {
    if (!z.ladepunkt || z.quelle !== 'handeingriff' || !z.ladepunkt.eingriff) continue;
    return {
      text: ladepunktBanner(z.name, z.ladepunkt.eingriff),
      aktion: BANNER_AKTION,
      entityId: LADEPUNKT_BANNER_ID,
      ladepunkt: z.ladepunkt,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Die Zone
// ---------------------------------------------------------------------------

export interface JetztInput {
  speicher?: SpeicherInput | null;
  geraete?: GeraetInput[];
  charging?: SiteCharging | null;
  /**
   * Die STEUERART je Ladepunkt-Komponente, als Wort — sie kommt aus dem
   * Lese-Aggregat der Verbraucher-Zone und wird hier nur eingesetzt. Fehlt
   * sie, bleibt die Quelle der Zeile ehrlich leer.
   */
  steuerart?: (entityId: string | null | undefined) => string | null;
  /**
   * Der NAME zu einem Karten-Pseudonym (P7) — die Jetzt-Zeile sagt dann, WER
   * dort lädt („Lädt 11 kW · Dienstwagen · Sofort laden"). Ohne die Funktion
   * oder ohne benanntes Fahrzeug bleibt die Zeile Zeichen für Zeichen die von
   * vorher.
   */
  fahrzeug?: (tagRef: string | null | undefined) => string | null;
  overrides?: ManualOverride[] | null;
  /** Die laufenden Handeingriffe + die Pause (Stufe 4); null = keine geladen. */
  interventions?: SiteInterventions | null;
  now: Date;
}

/**
 * Die ganze Zone ①. Ohne eine einzige steuerbare Sache gibt es KEINE Zeilen
 * und stattdessen den Leer-Satz mit dem Weg — nie eine Zeile, die „—" sagt.
 */
export function jetztZone(input: JetztInput): JetztView {
  const zeilen: JetztZeile[] = [];
  const sp = input.speicher ? speicherZeile(input.speicher) : null;
  if (sp) zeilen.push(sp);
  // P1 hat die Sammelzeile `ladeparkZeile` ERSATZLOS gestrichen (Konzept §6.1):
  // ihre Kopfzahl trägt jetzt der Ladepark-Rahmen der Verbraucher-Zone, und
  // jede Ladung steht als eigene Zeile — dort, und nur dort, greift der Kunde
  // ein (P3a).
  const lp = ladepunktZeilen(input.charging, input.steuerart, input.now.getTime(),
    input.fahrzeug);
  // ⚠ Ein Ladepunkt steht GENAU EINMAL. Traegt dieselbe Entitaet zusaetzlich ein
  // Verbraucher-Profil, saehe der Kunde sie zweimal — einmal aus dem gemeldeten
  // Verbraucher-Zustand, einmal aus dem Ladevorgang; zwei Wahrheiten ueber
  // dieselbe Saeule. Die Ladepunkt-Zeile gewinnt: sie ist die genauere (je
  // Stecker, mit dem echten OCPP-Zustand).
  const ladepunktEntitaeten = new Set(
    lp.zeilen.map((z) => z.entityId).filter((id): id is string => id != null),
  );
  for (const g of input.geraete ?? []) {
    if (ladepunktEntitaeten.has(g.consumer.id)) continue;
    zeilen.push(geraetZeile(g, input.now));
  }
  for (const z of lp.zeilen) zeilen.push(z);

  const namen: Record<string, string> = {};
  for (const g of input.geraete ?? []) namen[g.consumer.id] = g.consumer.name;

  return {
    zeilen,
    banner: jetztBanner(input.overrides, namen, input.now, input.interventions, input.charging),
    // ⚠ Die Sammel-Zeile der grossen Ladeparks zählt als Inhalt: eine Anlage,
    // die nur solche hat, ist nicht „leer".
    leer: zeilen.length === 0 && !lp.weitere ? JETZT_LEER : null,
    weitereLadepunkte: lp.weitere,
  };
}
