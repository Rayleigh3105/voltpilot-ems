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
import type { ControlStatus, CurtailmentStatus, ScheduleSlot, SchedulePlan } from './api';
import { CONTROL_DEADBAND_KW, batteryDirection, controlReasonSlot, controlStrip } from './control';
import { curtailTruth, curtailTruthForSlot, type CurtailTruth } from './curtailment';
import { slotWhy, type PlanWhyFacts, type WhySlot } from './fahrplanWhy';
import { overrideLine, sofortAktionen, type ManualOverride, type SofortAktion } from './consumers/fulfillment';
import { consumerStatusLine, STATUS_UNKNOWN_TEXT, type ConsumerRuntimeStatus } from './consumers/status';
import type { Consumer } from './consumers/types';
import { budgetBand, chargerName, type SiteCharging } from './ladepunkte';
import { fmtNum } from './format';
import type { PlanWordingKind } from './schedule';

/** Was in einer Zeile steht — die drei steuerbaren Arten dieser Stufe. */
export type JetztArt = 'speicher' | 'geraet' | 'ladepark';

/** Woher der Befehl kommt, der gerade wirkt. */
export type JetztQuelle = 'handeingriff' | 'regel' | 'fahrplan' | 'unbekannt';

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
  /** Die Handeingriffe, die diese Zeile WIRKLICH anbietet (leer = keine). */
  aktionen: SofortAktion[];
  /** Warum es keinen Handeingriff gibt — nur gesetzt, wenn `aktionen` leer ist. */
  keinEingriff: string | null;
}

export interface JetztBanner {
  /** „Handeingriff läuft: Heizstab an bis 14:30 Uhr (noch 1 Std. 12 Min.)". */
  text: string;
  /** Der Weg zurück, wörtlich der Knopf-Titel. */
  aktion: string;
  entityId: string;
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
}

export const JETZT_TITEL = 'Jetzt';

export const JETZT_INTRO =
  'Was Ihre Anlage gerade von selbst tut — und woher der Befehl kommt.';

/** Der Leer-Zustand: EIN Satz mit dem Weg, nicht drei (§3.9 / B7). */
export const JETZT_LEER =
  'Für diese Anlage steuert VoltPilot noch nichts. Sobald ein Speicher oder ein '
  + 'schaltbares Gerät eingerichtet ist, steht hier, was es gerade tut.';

/**
 * Warum der Speicher (noch) keinen Handeingriff hat. Der Weg dorthin ist
 * gebaut, der Knopf nicht — und ein Knopf, der nichts bewirkt, ist schlimmer
 * als keiner.
 */
export const SPEICHER_KEIN_EINGRIFF =
  'Ein Eingriff von Hand am Speicher ist noch nicht möglich — Ihr Fahrplan und '
  + 'Ihre Regeln steuern ihn.';

/** Warum ein nicht verbundenes Gerät keinen Handeingriff hat. */
export const GERAET_NICHT_VERBUNDEN =
  'Dieses Gerät meldet sich gerade nicht — ein Eingriff käme nicht an.';

/** Warum ein Gerät ohne freigegebene Steuerung keinen Handeingriff hat. */
export const GERAET_NICHT_FREIGEGEBEN =
  'Für dieses Gerät ist das Schalten noch nicht freigegeben.';

/** Der Ladepark wird hier nur GEZEIGT — geregelt wird er von der Anlage selbst. */
export const LADEPARK_KEIN_EINGRIFF =
  'Die Ladeleistung verteilt Ihre Anlage selbst — sie hält dabei Ihre '
  + 'Anschlussgrenze ein.';

export const BANNER_AKTION = 'Automatik fortsetzen';

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

  return {
    key: 'speicher',
    art: 'speicher',
    entityId: null,
    name: input.name?.trim() ? input.name.trim() : 'Speicher',
    zustand,
    grund: traegt ? why : (strip.reason ?? why),
    quelle,
    quelleText,
    bis: null,
    ton: strip.tone,
    aktionen: [],
    keinEingriff: SPEICHER_KEIN_EINGRIFF,
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
// Ladepark-Zeile
// ---------------------------------------------------------------------------

/**
 * Die Ladepark-Zeile — rein lesend (§3.2: „2 Fahrzeuge laden · Budget 22 kW von
 * 30 kW"). Ohne gemeldetes Budget wird KEINE Zahl behauptet.
 */
export function ladeparkZeile(charging: SiteCharging | null | undefined): JetztZeile | null {
  const chargers = charging?.chargers ?? [];
  if (chargers.length === 0) return null;
  const band = budgetBand(charging?.budget ?? null);
  // Gezählt werden die ladenden STECKER, nicht die Säulen: an einer Säule
  // hängen zwei Fahrzeuge, und der Kunde fragt nach den Fahrzeugen.
  const ladend = chargers.reduce(
    (n, c) => n + (c.connectors ?? []).filter((k) => k.charging).length, 0);
  const zustand = ladend === 0
    ? 'keine Fahrzeuge laden'
    : `${ladend} ${ladend === 1 ? 'Fahrzeug lädt' : 'Fahrzeuge laden'}`;
  // Die Budget-Zahl wird DURCHGEREICHT (`budgetBand.headline` — „22,0 kW von
  // 30,0 kW"), nie hier neu gerechnet: ohne hinterlegte Grenze ist sie null,
  // und dann steht keine Zahl da statt einer erfundenen.
  const grund = band?.headline ? `Budget ${band.headline}` : null;
  return {
    key: 'ladepark',
    art: 'ladepark',
    entityId: null,
    name: chargers.length === 1 ? chargerName(chargers[0]) : 'Ladepunkte',
    zustand,
    grund,
    quelle: 'unbekannt',
    quelleText: null,
    bis: null,
    ton: ladend > 0 ? 'ok' : 'off',
    aktionen: [],
    keinEingriff: LADEPARK_KEIN_EINGRIFF,
  };
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
): JetztBanner | null {
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
  return null;
}

// ---------------------------------------------------------------------------
// Die Zone
// ---------------------------------------------------------------------------

export interface JetztInput {
  speicher?: SpeicherInput | null;
  geraete?: GeraetInput[];
  charging?: SiteCharging | null;
  overrides?: ManualOverride[] | null;
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
  for (const g of input.geraete ?? []) zeilen.push(geraetZeile(g, input.now));
  const lp = ladeparkZeile(input.charging);
  if (lp) zeilen.push(lp);

  const namen: Record<string, string> = {};
  for (const g of input.geraete ?? []) namen[g.consumer.id] = g.consumer.name;

  return {
    zeilen,
    banner: jetztBanner(input.overrides, namen, input.now),
    leer: zeilen.length === 0 ? JETZT_LEER : null,
  };
}
