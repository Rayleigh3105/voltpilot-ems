// Die Ladepunkt-Fläche (Lastmanagement Stufe 3) - die EINE reine Schicht, aus
// der jede Zahl und jeder Satz über Ladesäulen kommt.
//
// Grundlage sind die ABGENOMMENEN Mockups (`data/vp-ocpp-mockups-r5`): die
// Erklärtexte in §2b stehen hier WÖRTLICH, weil sie die Bau-Vorlage sind.
//
// ⚠ DREI Ehrlichkeitsregeln tragen dieses Modul:
//  1. Der deutsche Satz der BOX wird durchgereicht, nie neu formuliert. Budget,
//     Ausfall-Profil und die Warte-Gründe entstehen EINMAL im Lastmanagement
//     der Box; nur sie kennt die Zahlen dahinter. Wo dieses Modul selbst
//     formuliert, tut es das für Dinge, die die Box gar nicht kennt (die
//     Bedienung der Fläche).
//  2. Was nicht gemessen ist, wird nicht behauptet: ein fehlender Messwert ist
//     `null` und führt zu einem Satz ÜBER die Lücke, nie zu einer 0.
//  3. Warten ist kein Fehler. Grau = wartet/ruhig, immer MIT Grund; Bernstein =
//     die Säule selbst hat ein Problem. Es gibt keinen Alarm-Ton und kein
//     Pulsieren - die einzige Bewegung dieses Hauses ist `busy` im Admin-Puls.

/** Der Katalog-Typ einer Ladesäule (seit Stufe 0 im Typkatalog). */
export const EV_CHARGER = 'ev-charger';

/**
 * Das Live-Fenster, in dem ein Messwert als AKTUELL gilt (Cockpit Phase 1 / E2).
 *
 * ⚠ Es ist ein bewusster ZWILLING von `api.ts` `ONLINE_WINDOW_MS`: dieses Modul
 * ist import-frei (jede Zahl und jeder Satz über Ladesäulen kommt aus GENAU
 * hier), und `api.ts` hereinzuziehen hinge die reine Schicht an den ganzen
 * HTTP-Baum. Beide Zahlen zusammen ändern - `messwertAlterFensterStimmtMitApiUeberein`
 * in `ladepunkte.test.ts` liest sie beidseitig und fällt sonst um.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Die Form, in der die api liefert (`GET /sites/{id}/chargers`)
// ---------------------------------------------------------------------------

export interface ChargeConnector {
  connectorId: number;
  status?: string | null;
  charging: boolean;
  allocatedKw?: number | null;
  reason?: string | null;
  reasonText?: string | null;
  nextTurn?: string | null;
  powerKw?: number | null;
  energyKwh?: number | null;
  socPct?: number | null;
  commandStatus?: string | null;
  readback?: string | null;
  readbackNote?: string | null;
  sessionSince?: string | null;
  /**
   * Die Bilanz DIESES Ladevorgangs (Cockpit Phase 1 / E2). `energyKwh` daneben
   * ist ein KUMULATIVES Register - was in der laufenden Sitzung geflossen ist,
   * weiss nur die Box. null = kein Ladevorgang / kein Register.
   */
  sessionKwh?: number | null;
  /**
   * Wann die Säule zuletzt MeterValues gemeldet hat - das ALTER von
   * `powerKw`/`energyKwh`/`socPct` (Cockpit Phase 1 / E2).
   *
   * ⚠ `null` heisst „nicht gemeldet" (ein älterer Box-Stand), NIE „gerade
   * eben": ohne den Stempel bleibt jede Fläche bei ihrem Vor-Phase-1-Verhalten,
   * statt eine Frische zu behaupten, die niemand gemessen hat.
   */
  meteredAt?: string | null;
  /** An diesem Stecker läuft „Jetzt voll laden" (Stufe 4). */
  boost?: boolean;
}

export interface ChargePoint {
  deviceId: string;
  chargePointId: string;
  label?: string | null;
  priority: boolean;
  connected: boolean;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  ready: boolean;
  note?: string | null;
  lastSeen?: string | null;
  /**
   * WO die Säule laut BOX hängt (Cockpit Phase 1 / C1) - das IST.
   *
   * ⚠ `null` heisst „eine ältere Box meldet es nicht" - weder `haus` noch
   * `eigen`: erst eine Meldung belegt, dass die Unterscheidung dort angekommen
   * ist. Was der KUNDE gewählt hat, steht in der Allowlist - Soll und Ist sind
   * zwei Aussagen.
   */
  connection?: ChargerConnection | null;
  entityId?: string | null;
  reportedAt?: string | null;
  connectors?: ChargeConnector[] | null;
}

/** Die drei QUELLEN-Prioritäten des Kunden (Stufe 4, Mockups §2b). */
export type SurplusPolicy = 'nur_sonne' | 'sonne_zuerst' | 'schnell';

/** Wer den Sonnenüberschuss zuerst bekommt. */
export type StoragePriority = 'speicher_vor_auto' | 'auto_vor_speicher';

export interface ChargingBudget {
  deviceId: string;
  enabled: boolean;
  controlEnabled: boolean;
  controlNote?: string | null;
  gridLimitKw?: number | null;
  marginPct?: number | null;
  minPowerKw?: number | null;
  budgetKw?: number | null;
  allocatedKw?: number | null;
  reservedKw?: number | null;
  measuredKw?: number | null;
  siteLoadKw?: number | null;
  siteGridKw?: number | null;
  budgetMode?: string | null;
  budgetNote?: string | null;
  budgetBlind?: boolean;
  effLimitKw?: number | null;
  safeDefaultKw?: number | null;
  safeDefaultNote?: string | null;
  safeDefaultHolds?: boolean | null;
  safeWorstCaseKw?: number | null;
  maxHouseLoadKw?: number | null;
  connectorCount: number;
  // --- Stufe 4: die QUELLEN-Bahn, so wie die BOX sie fährt ---
  surplusPolicy?: string | null;
  storagePriority?: string | null;
  surplusActive?: boolean;
  surplusKw?: number | null;
  surplusMode?: string | null;
  surplusNote?: string | null;
  surplusBlind?: boolean;
  surplusTotalKw?: number | null;
  surplusBatteryKw?: number | null;
  sourceAllocatedKw?: number | null;
  /**
   * Port und Pfad, unter denen der OCPP-Server der Box lauscht - zusammen mit
   * ihrer LAN-Adresse der Endpunkt, den eine Säule anwählt.
   *
   * ⚠ DREIWERTIG: `null`/abwesend heißt „eine ältere Box meldet es nicht" ODER
   * „der Server lauscht gerade nicht" - nie Port 0. Eine Fläche, die einen
   * Port nennt, auf dem niemand antwortet, ist schlechter als eine, die
   * ehrlich nichts nennt.
   */
  ocppPort?: number | null;
  ocppUrlPath?: string | null;
  reportedAt?: string | null;
}

export interface SiteCharging {
  budget: ChargingBudget | null;
  chargers: ChargePoint[];
}

/** Die im Portal gepflegte Konfiguration (`GET/PUT /sites/{id}/charging-config`). */
export interface ChargingConfig {
  gridLimitKw: number | null;
  priorityChargePointIds: string[];
  /**
   * Die QUELLEN-Wahl (Stufe 4). null = der Kunde hat nichts gewählt und die Box
   * behält ihre eigene Einstellung - das ist NICHT dasselbe wie `schnell`.
   */
  surplusPolicy?: SurplusPolicy | null;
  storagePriority?: StoragePriority | null;
  /**
   * Die ALLOWLIST: die Kennungen, unter denen die Box eine Säule überhaupt
   * annimmt.
   *
   * ⚠ Sie FÜGT NUR HINZU. Eine leere Liste heißt hier „das Portal hat noch
   * keine eingetragen" - anders als beim Vorrang ist sie KEINE Aussage „keine
   * Säule". Eine Kennung hier WEGZULASSEN ist kein Löschen; das sagt
   * `removedChargePointIds` ausdrücklich.
   */
  chargePoints?: AllowedChargePoint[];
  /**
   * Die ZURÜCKGENOMMENEN Kennungen - die GRABSTEIN-Liste des Servers.
   *
   * ⚠ Sie reist in JEDEM folgenden Dokument an die Box mit, nicht einmal: das
   * retained Dokument wird als Ganzes ersetzt, also hätte eine nur einmal
   * genannte Löschung eine gerade offline gewesene Box nie erreicht. Eine
   * Kennung steht nie zugleich in `chargePoints` - ein erneutes Eintragen
   * belebt sie wieder. Ein ÄLTERES Backend sendet das Feld nicht.
   */
  removedChargePointIds?: string[];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/**
 * Eine im Portal eingetragene Ladesäule. Alles außer der Kennung ist das, was
 * der Betreiber zufällig schon weiß - `null` heißt „unbekannt", nie 0.
 */
/**
 * WO eine Ladesäule hängt (Cockpit Phase 1 / C1, Captain-Entscheid E5).
 *
 * `haus` = hinter dem Hausanschluss - der Normalfall: ihre Leistung steckt in
 * der Netzmessung der Anlage, das Budget-Gesetz der Box gilt für sie.
 * `eigen` = ein EIGENER Netzanschluss/Zähler: ihre Leistung steckt NICHT in
 * dieser Messung, sie darf dort also nicht zurückaddiert werden.
 */
export type ChargerConnection = 'haus' | 'eigen';

/**
 * Der SOLL-Anschluss einer eingetragenen Säule: `null` heisst „der Kunde hat
 * nichts gesagt" und die Box behält, was sie hat - NIE `eigen`.
 */
export interface AllowedChargePoint {
  chargePointId: string;
  label?: string | null;
  ratedKw?: number | null;
  connectors?: number | null;
  connection?: ChargerConnection | null;
  addedAt?: string | null;
  addedBy?: string | null;
}

/** Die Antwort auf „Jetzt voll laden". */
export interface ChargingBoostResult {
  chargePointId: string;
  connectorId: number;
  active: boolean;
  requestedAt?: string | null;
  note: string;
}

// ---------------------------------------------------------------------------
// Die Bühne: das Budget-Band
// ---------------------------------------------------------------------------

/** Ein Abschnitt des Bandes. `hatched` = der Sicherheitsabstand. */
export interface BandSegment {
  id: 'gebaeude' | 'laden' | 'abstand' | 'frei';
  label: string;
  kw: number;
  hatched?: boolean;
}

export interface BudgetBand {
  /** Die Anschlussgrenze - das Ende des Bandes. null = nicht gepflegt. */
  limitKw: number | null;
  segments: BandSegment[];
  /** „246 kW von 277" - null, solange die Grenze fehlt. */
  headline: string | null;
  /** EIN Satz, der die Lage benennt (K1). */
  line: string;
  /** Der Satz der BOX über die Herkunft des Budgets, unverändert. */
  sourceLine: string | null;
  /** true = das Budget entstand NICHT aus einer frischen Messung. */
  blind: boolean;
}

const KW = (v: number): string =>
  `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v)} kW`;

/**
 * Das Band der Bühne. Es zeigt AUSSCHLIESSLICH, was gemessen bzw. gepflegt ist:
 * ohne Anschlussgrenze gibt es kein Band, und ohne gemessenen Netzbezug keinen
 * Gebäude-Abschnitt - dort steht dann ein Satz statt eines erfundenen Balkens.
 */
export function budgetBand(budget: ChargingBudget | null): BudgetBand | null {
  if (!budget) return null;
  const limit = num(budget.effLimitKw) ?? num(budget.gridLimitKw);
  const laden = num(budget.measuredKw) ?? num(budget.allocatedKw) ?? 0;
  const house = num(budget.siteLoadKw);
  const margin = limit != null && budget.marginPct ? (limit * budget.marginPct) / 100 : 0;
  const segments: BandSegment[] = [];
  if (house != null) segments.push({ id: 'gebaeude', label: 'Gebäude', kw: Math.max(house, 0) });
  segments.push({ id: 'laden', label: 'Laden', kw: Math.max(laden, 0) });
  if (margin > 0) {
    segments.push({ id: 'abstand', label: 'Sicherheitsabstand', kw: margin, hatched: true });
  }
  if (limit != null) {
    const used = (house ?? 0) + Math.max(laden, 0) + margin;
    if (limit - used > 0.05) {
      segments.push({ id: 'frei', label: 'Frei', kw: limit - used });
    }
  }
  const shown = (house ?? 0) + Math.max(laden, 0);
  return {
    limitKw: limit,
    segments,
    headline: limit == null ? null : `${KW(shown)} von ${KW(limit)}`,
    line: bandLine(budget, house, laden),
    // ⚠ DURCHGEREICHT, nie neu formuliert: der Satz wird EINMAL auf der Box
    // geschrieben, und nur sie kennt die Zahlen dahinter.
    sourceLine: text(budget.budgetNote),
    blind: budget.budgetBlind === true,
  };
}

function bandLine(budget: ChargingBudget, house: number | null, laden: number): string {
  if (num(budget.gridLimitKw) == null && num(budget.effLimitKw) == null) {
    return 'Ihre Anschlussgrenze ist noch nicht hinterlegt - bis dahin gibt VoltPilot keine Ladeleistung frei.';
  }
  if (house == null) {
    return `Ihre Ladepunkte beziehen gerade ${KW(laden)}. Was das Gebäude zieht, misst diese Anlage noch nicht - das Ladebudget rechnet deshalb mit den hinterlegten Zahlen.`;
  }
  return `Ihr Anschluss ist geschützt: ${KW(house)} Gebäude und ${KW(laden)} Laden bleiben unter Ihrer Grenze.`;
}

// ---------------------------------------------------------------------------
// Die Ladevorgangs-Zeilen
// ---------------------------------------------------------------------------

/** Grün = lädt · Grau = wartet/ruhig · Bernstein = die Säule hat ein Problem. */
export type LadeTone = 'laedt' | 'ruhig' | 'stoerung';

/**
 * Das MASCHINEN-Wort eines Ladepunkt-Zustands - die geschlossene Menge aus dem
 * abgenommenen Konzept (`vp-verbraucher-cockpit-k1` §4.2).
 *
 * Es steht NEBEN dem deutschen Wort, damit keine Fläche einen deutschen Satz
 * nach Stichworten durchsuchen muss (die Haus-Regel des `target_verdict`).
 */
export type LadeZustandKind =
  | 'getrennt'
  | 'frei'
  | 'startet'
  | 'laedt'
  | 'laedt_ohne_messung'
  | 'nimmt_nichts'
  | 'wartet'
  | 'saeule_pausiert'
  | 'auto_pausiert'
  | 'beendet'
  | 'stoerung'
  | 'nicht_verfuegbar'
  | 'reserviert';

export interface LadeZustand {
  /** Das MASCHINEN-Wort des Zustands - worauf eine Fläche schlüsseln darf. */
  kind: LadeZustandKind;
  /** Das ZUSTANDS-WORT - nie nur eine Farbe (K5/K10). */
  word: string;
  /**
   * Dasselbe Wort OHNE die Übersteuerung („Lädt" statt „Lädt voll auf Ihren
   * Wunsch"). Für Flächen, die den Handeingriff daneben als eigene Angabe
   * nennen - sonst stünde er zweimal in einer Zeile.
   */
  basisWort: string;
  tone: LadeTone;
  /** Der Grund, wo es einen gibt - der Satz der BOX, unverändert. */
  reason: string | null;
  /** Das Maschinen-Wort desselben Grundes (`kein_ueberschuss`, `budget`, …). */
  reasonCode: string | null;
  /**
   * Unser EIGENER Zusatz zum Zustand, wo der Zustand allein zu wenig sagt
   * („zuletzt 09:12", „voll oder Auto-Timer") - getrennt vom Satz der Box
   * gehalten, damit die zwei Herkünfte nie zu einer verschmelzen.
   */
  detail: string | null;
}

const ZUSTAND_WORT: Record<LadeZustandKind, string> = {
  getrennt: 'Säule getrennt',
  frei: 'Kein Auto eingesteckt',
  startet: 'Auto eingesteckt · startet',
  laedt: 'Lädt',
  laedt_ohne_messung: 'Lädt — Leistung nicht messbar',
  nimmt_nichts: 'Eingesteckt · nimmt gerade keinen Strom',
  wartet: 'Eingesteckt · wartet',
  saeule_pausiert: 'Eingesteckt · Säule pausiert',
  auto_pausiert: 'Auto pausiert',
  beendet: 'Ladung beendet · Auto noch eingesteckt',
  stoerung: 'Störung an der Säule',
  nicht_verfuegbar: 'Nicht verfügbar',
  reserviert: 'Reserviert',
};

/**
 * Grün = lädt, Bernstein = die Säule selbst hat ein Problem, sonst grau.
 *
 * ⚠ `beendet` ist GRAU, obwohl das Konzept „grün-grau ✓" notiert: dieses Haus
 * kennt drei Töne, und Grün heißt in jeder anderen Zeile „es fließt gerade".
 * Ein beendeter Ladevorgang fließt nicht mehr - ihn grün zu färben wäre genau
 * die Verwechslung, gegen die dieser Fix gebaut ist.
 */
const ZUSTAND_TON: Record<LadeZustandKind, LadeTone> = {
  getrennt: 'stoerung',
  frei: 'ruhig',
  startet: 'ruhig',
  laedt: 'laedt',
  laedt_ohne_messung: 'laedt',
  nimmt_nichts: 'ruhig',
  wartet: 'ruhig',
  saeule_pausiert: 'ruhig',
  auto_pausiert: 'ruhig',
  beendet: 'ruhig',
  stoerung: 'stoerung',
  nicht_verfuegbar: 'ruhig',
  reserviert: 'ruhig',
};

/** Unsere eigenen Zusätze - nur dort, wo der Zustand allein zu wenig sagt. */
const ZUSTAND_DETAIL: Partial<Record<LadeZustandKind, string>> = {
  // Beides ist möglich, und die Säule sagt nicht, welches - also wird nichts
  // geraten, sondern die Unschärfe benannt.
  auto_pausiert: 'voll oder Auto-Timer',
};

/**
 * DER ZUSTAND EINES LADEPUNKTS - die EINE Stelle, an der aus einem Herzschlag
 * ein Wort wird. Ladevorgänge-Seite und Cockpit lesen sie beide.
 *
 * ⚠ DIE TRAGENDE REGEL (Konzept `vp-verbraucher-cockpit-k1` §1.5/§4.2): DER
 * OCPP-STATUS ENTSCHEIDET DAS WORT, das `charging`-Flag der Box entscheidet
 * NUR den Budget-Anspruch. Die Box hält `charging` ausdrücklich auch für
 * `SuspendedEVSE` (unser eigenes Lastmanagement hält die Säule auf 0 kW) und
 * `SuspendedEV` (das Auto nimmt nichts) auf TRUE, weil die Sitzung lebt und
 * ihre Zuteilung nicht hin- und herwandern darf (`csms/model.go`
 * `ChargingStatus`). Wer das Flag als Wort liest, sagt „lädt" über ein Auto,
 * das GERADE VON UNS ausgebremst wird - und schreibt den Widerspruch
 * „lädt · wartet - Budget vergeben" in eine einzige Zeile.
 *
 * ⚠ OHNE gemeldeten Status gibt es kein OCPP-Wort. Dann - und NUR dann - fällt
 * diese Funktion auf das Flag zurück: einen Zustand zu behaupten, den niemand
 * gemeldet hat, wäre schlimmer. Der gefährliche Fall oben trägt seinen Status
 * per Konstruktion, das Loch geht dadurch also nicht wieder auf. Ein Wort
 * ausserhalb des OCPP-Vokabulars kann hier ohnehin nicht ankommen - der Ingest
 * verwirft es, statt es zu speichern (`ChargerStatusListener`).
 */
export function ladeZustand(
  con: ChargeConnector,
  point?: Pick<ChargePoint, 'connected' | 'lastSeen'> | null,
  nowMs?: number,
): LadeZustand {
  const kind = zustandKind(con, point, nowMs);
  const boost = con.boost === true && (kind === 'laedt' || kind === 'laedt_ohne_messung');
  // ⚠ Eine übersteuerte Ladung SAGT es: eine volle Ladung, die niemand
  // angefordert hat, wäre ein stiller Bruch der eigenen Priorität des Kunden.
  // Sie sagt es aber NUR, wo wirklich geladen wird - „Lädt voll auf Ihren
  // Wunsch" über einem wartenden Stecker wäre dieselbe Lüge in Grün.
  const word = boost ? 'Lädt voll auf Ihren Wunsch' : ZUSTAND_WORT[kind];
  let detail = ZUSTAND_DETAIL[kind] ?? null;
  if (kind === 'getrennt') {
    const seen = point?.lastSeen ? clock(point.lastSeen) : '';
    detail = seen === '' ? null : `zuletzt ${seen}`;
  } else if (messwertAlter(con, nowMs) === 'veraltet') {
    // ⚠ Die Lücke wird BENANNT, nicht verschwiegen: ohne diesen Satz sähe eine
    // Säule, die zu messen aufgehört hat, aus wie eine ohne Messung ab Werk.
    const seen = con.meteredAt ? clock(con.meteredAt) : '';
    detail = seen === '' ? 'Leistung veraltet' : `Leistung veraltet · zuletzt ${seen}`;
  }
  return {
    kind,
    word,
    // ⚠ Das Wort OHNE die Übersteuerung. Eine Fläche, die den Urheber schon
    // NEBEN dem Zustand nennt (die Jetzt-Zeile: „lädt 22,0 kW · Jetzt voll
    // laden"), sagte ihn sonst zweimal - dieselbe Regel, aus der `reason`
    // gegen das Basis-Wort verglichen wird.
    basisWort: ZUSTAND_WORT[kind],
    tone: ZUSTAND_TON[kind],
    // ⚠ Der Grund wird nur genannt, wenn er MEHR sagt als das Wort: der
    // Verteiler nennt einen ladenden Stecker selbst „lädt", und die Zeile
    // zweimal dasselbe sagen zu lassen ist Rauschen, kein Beleg. Verglichen
    // wird auch gegen das BASIS-Wort - eine übersteuerte Ladung trägt sonst
    // „lädt" unter „Lädt voll auf Ihren Wunsch".
    reason:
      sameWord(con.reasonText, word) || sameWord(con.reasonText, ZUSTAND_WORT[kind])
        ? null
        : text(con.reasonText),
    reasonCode: text(con.reason),
    detail,
  };
}

/**
 * Darf `powerKw` als AKTUELL gelesen werden? (Cockpit Phase 1 / E2)
 *
 * Die Box misst je Stecker über MeterValues; hört eine Säule damit auf (Funk
 * weg, Firmware hängt, das Auto ist abgesteckt und sie schweigt), bleibt die
 * zuletzt gemeldete Zahl im Herzschlag stehen. Bis Phase 1 konnte das keine
 * Fläche sehen - „lädt mit 11 kW" war dann eine Aussage über eine halbe Stunde
 * alte Zahl.
 *
 * Drei Antworten, und die dritte ist die tragende:
 * - `frisch` - innerhalb des Fensters, das dieses Haus überall „online" nennt.
 * - `veraltet` - älter, also KEIN aktueller Messwert mehr.
 * - `unbekannt` - die Box meldet den Stempel gar nicht (ein älterer Stand).
 *   Dann bleibt alles byte-identisch zum Vor-Phase-1-Verhalten: eine Frische zu
 *   BEHAUPTEN, die niemand gemessen hat, wäre die gefährlichere der beiden
 *   Auskünfte.
 */
export function messwertAlter(
  con: Pick<ChargeConnector, 'meteredAt'>,
  nowMs?: number,
): 'frisch' | 'veraltet' | 'unbekannt' {
  const stamp = text(con.meteredAt);
  if (stamp == null) return 'unbekannt';
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return 'unbekannt';
  const now = nowMs ?? Date.now();
  return now - t <= ONLINE_WINDOW_MS ? 'frisch' : 'veraltet';
}

/**
 * Die Leistung, die eine Fläche als AKTUELL ausgeben darf - `null`, sobald der
 * Messwert nachweislich veraltet ist. Ohne Stempel unverändert der gemeldete
 * Wert (siehe `messwertAlter`).
 */
export function aktuelleLeistung(con: ChargeConnector, nowMs?: number): number | null {
  return messwertAlter(con, nowMs) === 'veraltet' ? null : num(con.powerKw);
}

function zustandKind(
  con: ChargeConnector,
  point?: Pick<ChargePoint, 'connected' | 'lastSeen'> | null,
  nowMs?: number,
): LadeZustandKind {
  // Was eine getrennte Säule tut, wissen wir gerade nicht - jedes Wort über
  // ihren Stecker wäre eine Behauptung.
  if (point && point.connected === false) return 'getrennt';
  // ⚠ Ein VERALTETER Messwert zählt wie gar keiner: sonst hiesse ein
  // stehengebliebenes Kilowatt weiterhin „lädt mit 11 kW". Die Zeile fällt
  // damit auf den Zustand zurück, den es dafür längst gibt
  // (`laedt_ohne_messung`) - kein neues Wort, keine neue Farbe.
  const power = aktuelleLeistung(con, nowMs);
  switch (text(con.status)) {
    case 'Faulted':
      return 'stoerung';
    case 'Unavailable':
      return 'nicht_verfuegbar';
    case 'Reserved':
      return 'reserviert';
    case 'Available':
      return 'frei';
    case 'Preparing':
      return 'startet';
    case 'Finishing':
      return 'beendet';
    case 'SuspendedEV':
      return 'auto_pausiert';
    case 'SuspendedEVSE':
      // Die Zuteilung trennt die zwei Ursachen: bei 0 kW halten WIR die Säule
      // an (mit einem Grund, den die Box mitliefert), sonst hält sie selbst.
      return (num(con.allocatedKw) ?? 0) > 0.05 ? 'saeule_pausiert' : 'wartet';
    case 'Charging':
      if (power == null) return 'laedt_ohne_messung';
      return power > 0.05 ? 'laedt' : 'nimmt_nichts';
    default:
      // Kein gemeldeter Status - siehe die Rückfall-Regel im Kopf.
      if (con.charging) return power == null ? 'laedt_ohne_messung' : power > 0.05 ? 'laedt' : 'nimmt_nichts';
      return con.sessionSince ? 'wartet' : 'frei';
  }
}

export interface LadevorgangRow {
  key: string;
  /** „Säule Hof Nord · Stecker A" */
  title: string;
  /** Das MASCHINEN-Wort des Zustands - worauf eine Fläche schlüsseln darf. */
  kind: LadeZustandKind;
  /** Das ZUSTANDS-WORT - nie nur eine Farbe (K5/K10). */
  word: string;
  /** Dasselbe Wort ohne die Übersteuerung (siehe `LadeZustand.basisWort`). */
  basisWort: string;
  tone: LadeTone;
  /** Der Grund, wo es einen gibt - der Satz der Box, unverändert. */
  reason: string | null;
  /**
   * Das MASCHINEN-Wort desselben Grundes (`kein_ueberschuss`, `budget`, …).
   * Es steht NEBEN dem deutschen Satz, damit keine Fläche einen deutschen Satz
   * nach Stichworten durchsuchen muss - die Haus-Regel des `target_verdict`.
   * Ein Wort, das dieser Portal-Stand nicht kennt, reist als Datum mit und
   * begründet nichts.
   */
  reasonCode: string | null;
  /** Gemessene Leistung; null = die Säule meldet keine (nie eine 0). */
  powerKw: number | null;
  /** Zugeteilt; null = dieser Stecker ist nicht Teil der Entscheidung. */
  allocatedKw: number | null;
  socPct: number | null;
  /** „seit 10:41" - null ohne laufende Sitzung. */
  since: string | null;
  /** „dran in ca. 2 Min." - null, wenn kein Termin berechenbar ist. */
  nextTurn: string | null;
  priority: boolean;
  /** Der Stecker, an dem dieser Ladevorgang hängt - für „Jetzt voll laden". */
  chargePointId: string;
  connectorId: number;
  /** Diese Ladung läuft auf Wunsch des Kunden, ohne die Quellen-Bahn. */
  boost: boolean;
}

/** Der Name einer Säule: der vergebene, sonst ihre Kennung (nie erfunden). */
export function chargerName(c: ChargePoint): string {
  const label = text(c.label);
  return label ?? c.chargePointId;
}

/** Stecker A/B/C statt „Connector 1" - der Kunde steht davor. */
export function connectorName(id: number): string {
  return id >= 1 && id <= 26 ? `Stecker ${String.fromCharCode(64 + id)}` : `Stecker ${id}`;
}

/**
 * Die Zeilen aller Ladevorgänge. Eine getrennte Säule liefert KEINE Zeilen -
 * was sie tut, wissen wir gerade nicht, und eine Zeile ohne Wissen wäre eine
 * Behauptung; ihr Zustand steht auf ihrer Komponenten-Karte.
 */
export function ladevorgangRows(chargers: ChargePoint[], nowMs?: number): LadevorgangRow[] {
  const rows: LadevorgangRow[] = [];
  for (const c of chargers) {
    if (!c.connected) continue;
    for (const con of c.connectors ?? []) {
      rows.push(rowFor(c, con, nowMs));
    }
  }
  return rows;
}

function rowFor(c: ChargePoint, con: ChargeConnector, nowMs?: number): LadevorgangRow {
  // ⚠ EINE Wortquelle: Wort, Ton und Grund kommen aus `ladeZustand`, damit
  // Ladevorgänge-Seite und Cockpit über dieselbe Sekunde nie Verschiedenes
  // behaupten können.
  const z = ladeZustand(con, c);
  return {
    key: `${c.chargePointId}#${con.connectorId}`,
    title: `${chargerName(c)} · ${connectorName(con.connectorId)}`,
    kind: z.kind,
    word: z.word,
    basisWort: z.basisWort,
    tone: z.tone,
    reason: z.reason,
    reasonCode: z.reasonCode,
    powerKw: num(con.powerKw),
    allocatedKw: num(con.allocatedKw),
    socPct: num(con.socPct),
    since: con.sessionSince ? `seit ${clock(con.sessionSince)}` : null,
    nextTurn: turnIn(con.nextTurn, nowMs),
    priority: c.priority === true,
    chargePointId: c.chargePointId,
    connectorId: con.connectorId,
    boost: con.boost === true,
  };
}

/** Sagt der Grund dasselbe wie das Zustands-Wort? Dann bleibt er weg. */
function sameWord(reason: string | null | undefined, word: string): boolean {
  return (reason ?? '').trim().toLowerCase() === word.trim().toLowerCase();
}

/** „dran in ca. 2 Min." - null, wenn kein Termin gemeldet wurde. */
export function turnIn(iso: string | null | undefined, nowMs?: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const minutes = Math.round((t - (nowMs ?? Date.now())) / 60000);
  if (minutes <= 0) return 'dran in Kürze';
  return `dran in ca. ${minutes} Min.`;
}

/** Der ehrliche Leerlauf: keine erfundenen Nullzeilen (Mockups Fläche 1). */
export function idleLine(charging: SiteCharging): string | null {
  if (ladevorgangRows(charging.chargers).some((r) => r.tone !== 'ruhig' || r.since)) return null;
  const plugs = charging.budget?.connectorCount ?? 0;
  if (plugs <= 0) return 'Gerade lädt niemand.';
  return `Gerade lädt niemand - alle ${plugs} Stecker sind frei.`;
}

// ---------------------------------------------------------------------------
// Die Säule selbst
// ---------------------------------------------------------------------------

export type ChargerState = 'angemeldet' | 'getrennt' | 'nie_gesehen';

export interface ChargerView {
  state: ChargerState;
  word: string;
  tone: LadeTone;
  /** Die FOLGE, nicht nur die Tatsache (Mockups Fläche 3). */
  detail: string;
}

export function chargerView(c: ChargePoint): ChargerView {
  if (c.connected) {
    return {
      state: 'angemeldet',
      word: 'angemeldet',
      tone: 'laedt',
      detail: c.ready
        ? 'Die Säule ist verbunden und hat ihr Sicherheitsprofil bestätigt.'
        : text(c.note) ??
          'Die Säule ist verbunden; ihr Sicherheitsprofil wird gerade hinterlegt.',
    };
  }
  if (!c.lastSeen) {
    return {
      state: 'nie_gesehen',
      word: 'noch nie gesehen',
      tone: 'ruhig',
      detail:
        'Diese Säule hat sich noch nicht gemeldet. Während der Einrichtung ist das normal - die Säule wählt VoltPilot selbst an.',
    };
  }
  return {
    state: 'getrennt',
    word: 'getrennt',
    tone: 'stoerung',
    detail:
      'Die Verbindung zu dieser Säule steht gerade nicht. Sie lädt weiter, begrenzt sich dabei aber selbst auf ihr hinterlegtes Sicherheitsprofil.',
  };
}

// ---------------------------------------------------------------------------
// Regeln & Ausfall-Schutz (Mockups Fläche 4, Texte §2b WÖRTLICH)
// ---------------------------------------------------------------------------

export const LADEPARK_LINE =
  'Verteilt die verfügbare Leistung Ihres Netzanschlusses dynamisch und fair auf alle ladenden Fahrzeuge. Was Gebäude und Anlage gerade ziehen, wird laufend abgezogen - Ihr Anschluss bleibt immer geschützt.';

export const LADEPARK_SUBLINE = 'Anschlussgrenze und Vorrang stellen Sie unter „Regeln".';

export const PV_UEBERSCHUSS_LINE =
  'Ihre Fahrzeuge laden bevorzugt mit Sonnenstrom, der sonst ins Netz fließen würde. Reicht der Überschuss nicht, entscheidet Ihre Priorität, ob Netzstrom dazukommt.';

/** Ohne PV wird die Karte SICHTBAR ausgegraut - mit Grund, nie versteckt. */
export const PV_UEBERSCHUSS_OHNE_PV = 'Auf dieser Anlage nicht verfügbar - sie hat keine PV.';

export const VERTEILUNG_TEXT =
  'Dynamisch fair: Alle ladenden Fahrzeuge teilen sich die verfügbare Leistung gleichmäßig - laufend neu berechnet, wenn Gebäude oder Fahrzeuge sich ändern. Reicht sie nicht für alle, wechseln sich Fahrzeuge alle 15 Minuten ab.';

export const VORRANG_TEXT =
  'Vorrang-Säulen bekommen zuerst ihre volle Leistung - z. B. für Einsatz- oder Dienstfahrzeuge. Alle anderen teilen sich fair den Rest.';

export const VORRANG_OHNE_AUSWAHL =
  'Zurzeit hat keine Säule Vorrang - alle fair. Mit Vorrang lädt die gewählte Säule zuerst voll; die Wartezeit der anderen steigt, und genau das sagen wir dort dann ehrlich an.';

// ---------------------------------------------------------------------------
// PV-Überschussladen (Stufe 4) - Mockups §2a/§2b, Texte WÖRTLICH
// ---------------------------------------------------------------------------

/** Die Kunden-Wörter der drei Prioritäten. Sie leben HIER und nirgends sonst. */
export const POLICY_LABEL: Record<SurplusPolicy, string> = {
  nur_sonne: 'Nur Sonnenstrom',
  sonne_zuerst: 'Sonne zuerst, Netz wenn günstig',
  schnell: 'Schnell laden',
};

export const POLICY_HELP: Record<SurplusPolicy, string> = {
  nur_sonne:
    'Geladen wird ausschließlich Ihr Überschuss. Zieht eine Wolke auf, pausiert das Laden, statt Netzstrom zu kaufen.',
  sonne_zuerst:
    'Der Überschuss wird immer zuerst genutzt. Netzstrom kommt nur dazu, wenn ein Fahrzeug sonst stehen bliebe - so werden Fahrzeuge planbar voll.',
  schnell: 'Volle verfügbare Leistung, Quelle egal. Die Anschlussgrenze gilt natürlich weiter.',
};

/** Die Vorgabe INNERHALB der Karte - nicht die einer Anlage, die nie gefragt wurde. */
export const POLICY_DEFAULT: SurplusPolicy = 'sonne_zuerst';

export const POLICY_FOOTER =
  'Gilt für alle Säulen. Einen einzelnen Ladevorgang übersteuern Sie an seiner Zeile mit „Jetzt voll laden".';

export const STORAGE_LABEL: Record<StoragePriority, string> = {
  speicher_vor_auto: 'Speicher vor Auto',
  auto_vor_speicher: 'Auto vor Speicher',
};

export const STORAGE_HELP: Record<StoragePriority, string> = {
  speicher_vor_auto:
    'Der Speicher nimmt den Überschuss zuerst; die Fahrzeuge bekommen, was übrig bleibt.',
  auto_vor_speicher:
    'Die Fahrzeuge bekommen den Überschuss zuerst; der Speicher wird währenddessen auf den Rest begrenzt.',
};

/** Ein Wort, das wir nicht kennen, wird NICHT zu einer Auswahl. */
export function asPolicy(v: string | null | undefined): SurplusPolicy | null {
  return v === 'nur_sonne' || v === 'sonne_zuerst' || v === 'schnell' ? v : null;
}

export function asStorage(v: string | null | undefined): StoragePriority | null {
  return v === 'speicher_vor_auto' || v === 'auto_vor_speicher' ? v : null;
}

/**
 * Der SATZ der Box über die Quellen-Bahn, unverändert durchgereicht.
 *
 * ⚠ Er entsteht EINMAL im Lastmanagement der Box; nur sie kennt die Zahlen
 * dahinter, und zwei Renderings desselben Urteils könnten es sonst verschieden
 * sagen (die Regel des Einspeise-Wächters, hier ein weiteres Mal).
 */
export function surplusLine(budget: ChargingBudget | null): string | null {
  return text(budget?.surplusNote);
}

/**
 * Der KOMBINATIONS-STREIFEN (Mockups §2b, wörtlich): wie die zwei Bahnen
 * ineinandergreifen, mit den ECHTEN Zahlen dieser Anlage.
 *
 * Ohne aktive Quellen-Bahn gibt es nichts zu kombinieren - dann ist es EINE
 * Grenze, und ein Streifen über zwei wäre erfunden.
 */
export function kombinationsStreifen(budget: ChargingBudget | null): string | null {
  if (!budget || budget.surplusActive !== true) return null;
  const quelle = num(budget.surplusKw);
  const physisch = num(budget.budgetKw);
  if (quelle == null || physisch == null) return null;
  return (
    'So greifen sie ineinander: Das Lastmanagement begrenzt, WIE VIEL insgesamt fließen darf ' +
    `(jetzt ${KW(physisch)} physisch möglich). Das Überschussladen bestimmt, WOHER der Strom ` +
    `kommt (jetzt ${KW(quelle)} aus Ihrer Sonne). Es gilt immer die niedrigere Grenze - und ` +
    'keine von beiden kann die Anschlussgrenze oder den Ausfall-Schutz aufweichen.'
  );
}

/**
 * Wie viel der aktuellen Ladeleistung die Sonne deckt.
 *
 * ⚠ Es ist eine STANDORT-Aussage, nie eine Solarquote je Fahrzeug: Strom ist am
 * Hub nicht etikettiert (Mockups §1a). null, solange nichts gedeckt wird.
 */
export function sonnenDeckung(budget: ChargingBudget | null): string | null {
  const kw = num(budget?.sourceAllocatedKw);
  if (kw == null || kw <= 0.05) return null;
  return `${KW(kw)} davon deckt gerade Ihre Sonne`;
}

/** Ohne PV ist die Karte SICHTBAR ausgegraut - mit Grund, nie versteckt. */
export function ueberschussVerfuegbar(hasPv: boolean, charging: SiteCharging): boolean {
  return hasPv && charging.chargers.length > 0;
}

// --- „Jetzt voll laden" ----------------------------------------------------

/**
 * Der Knopf wird NUR angeboten, wo er etwas ändern kann: ein laufender
 * Ladevorgang, den die Quellen-Bahn wirklich zurückhält. Ein Knopf, der
 * strukturell nichts bewirkt, ist Lärm.
 */
export function boostbar(budget: ChargingBudget | null, row: LadevorgangRow): boolean {
  if (!budget || budget.surplusActive !== true) return false;
  if (row.boost) return false;
  // ⚠ Geprüft wird das MASCHINEN-Wort, nie der deutsche Satz: der trägt bei
  // „kein Überschuss" zusätzlich die Priorität und passte auf keinen Vergleich.
  return row.tone === 'laedt' || row.reasonCode === 'kein_ueberschuss' || row.kind === 'wartet';
}

/**
 * Die Folgenliste des Haus-Dialogs (Mockups §2b, WÖRTLICH) - inklusive der zwei
 * Punkte, die sagen, was GLEICH bleibt.
 */
export function boostFolgen(): string[] {
  return [
    'Dieser Ladevorgang lädt ab sofort mit voller verfügbarer Leistung - auch mit Netzstrom.',
    'Ihre Überschuss-Priorität bleibt für alle anderen Ladevorgänge unverändert.',
    'Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter - daran ändert dieser Knopf nichts.',
    'Gilt, bis das Fahrzeug voll ist, längstens 4 Stunden - danach gilt wieder Ihre Priorität.',
  ];
}

export const BOOST_INTRO = 'Sie übersteuern Ihre Überschuss-Priorität für diesen einen Ladevorgang.';

// --- Der HANDEINGRIFF je Ladepunkt (Verbrauchsmanagement v1, P3a) ----------
//
// Der Boost bekommt hier seine ZWEITE Fläche: bis Paket P3a lag er allein auf
// *Fahrplan › Ladevorgänge* (vier Klicks, andere Seite - Befund S6 des
// Konzepts `vp-verbrauchsmgmt-konzept-v1`), jetzt steht er zusätzlich im
// Menü „Eingreifen ▾" der Jetzt-Zeile.
//
// ⚠ Es entsteht KEIN zweiter Mechanismus und KEINE zweite Wortquelle: beide
// Flächen lesen diese Funktionen, und beide rufen denselben
// `POST /charging-boost`. Was ein Ladepunkt-Eingriff heisst, was er tut und wie
// er endet, steht damit genau einmal im Haus.

/**
 * Was das Zeilen-Menü eines Ladepunkts anbieten kann.
 *
 * ⚠ `laden_pausieren` (der Session-Deckel 0, Konzept §4.6 / Entscheid E5) ist
 * das dritte Wort dieses Vokabulars und braucht ein Edge-Release - es ist
 * Paket **P3b** und wird deshalb hier noch NICHT angeboten. Der Platz ist
 * bewusst frei gelassen: P3b ergänzt eine Zeile in `LADEPUNKT_LABEL`, eine in
 * `LADEPUNKT_HINWEIS` und einen Zweig in `ladepunktAktionen` - nirgends sonst.
 */
export type LadepunktAktion = 'voll_laden' | 'resume';

/** Die Beschriftungen des Menüs (Mockups §4, Frame „Eingreifen-Bottom-Sheet"). */
export const LADEPUNKT_LABEL: Record<LadepunktAktion, string> = {
  voll_laden: 'Jetzt voll laden (nur diese Ladung)',
  resume: 'Automatik fortsetzen',
};

/** Die zweite Zeile je Menü-Eintrag - sie sagt die FOLGE, nicht die Tatsache. */
export const LADEPUNKT_HINWEIS: Record<LadepunktAktion, string> = {
  voll_laden: 'Netzstrom erlaubt. Endet spätestens beim Abstecken.',
  resume: 'Für diese Ladung gilt danach wieder Ihre Priorität.',
};

/**
 * Die angebotenen Dauern (Konzept §4.6, Mockup-Chips WÖRTLICH).
 *
 * ⚠ `minutes: null` heisst „bis Abstecken" und wird als FEHLENDE Dauer
 * gesendet: der Vertrags-Deckel der Box (4 h) gilt dann, und die Bindung an die
 * Transaktion beendet den Eingriff ohnehin beim Abstecken. Eine ausgerechnete
 * Minutenzahl wäre an dieser Stelle eine erfundene Zusage über ein Fahrzeug,
 * dessen Abfahrt niemand kennt.
 */
export interface LadepunktDauer {
  key: string;
  label: string;
  minutes: number | null;
}

export const LADEPUNKT_DAUERN: LadepunktDauer[] = [
  { key: '30m', label: '30 min', minutes: 30 },
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '2h', label: '2 h', minutes: 120 },
  { key: '4h', label: '4 h', minutes: 240 },
  { key: 'abstecken', label: 'bis Abstecken', minutes: null },
];

/** Die Vorauswahl - der `on`-Chip des abgenommenen Mockups. */
export const LADEPUNKT_DAUER_VORGABE = '2h';

/**
 * WELCHE Handeingriffe eine Ladepunkt-Zeile wirklich anbietet.
 *
 * ⚠ Die Reihenfolge ist eine AUSSAGE (dieselbe wie bei `speicherAktionen`):
 * läuft ein Eingriff, steht ZUERST sein Rückweg - wer eingegriffen hat, muss
 * ihn zurücknehmen können. Ohne laufenden Eingriff entscheidet `boostbar`,
 * also genau die Regel, die die Ladevorgänge-Seite seit je fährt: ein Knopf,
 * der strukturell nichts bewirken kann, wird nicht angeboten.
 */
export function ladepunktAktionen(
  budget: ChargingBudget | null,
  row: LadevorgangRow,
): LadepunktAktion[] {
  if (row.boost) return ['resume'];
  return boostbar(budget, row) ? ['voll_laden'] : [];
}

/** Warum an diesem Ladepunkt gerade nichts zu greifen ist (nur ohne Aktion). */
export function ladepunktKeinEingriff(
  budget: ChargingBudget | null,
  row: LadevorgangRow,
): string | null {
  if (ladepunktAktionen(budget, row).length > 0) return null;
  // ⚠ Der Grund wird nur genannt, wenn er MEHR sagt als das Zustands-Wort -
  // dieselbe Regel, unter der schon `ladeZustand.reason` steht. Über einem
  // Stecker, der „Kein Auto eingesteckt" ALS ZUSTAND trägt, wäre derselbe Satz
  // ein zweites Mal Rauschen, kein Beleg (im Browser-Beweis aufgefallen).
  if (row.kind === 'frei' || row.kind === 'beendet') {
    return row.word.trim().toLowerCase().startsWith('kein auto')
      ? null
      : 'Kein Auto eingesteckt.';
  }
  if (row.kind === 'getrennt' || row.kind === 'stoerung' || row.kind === 'nicht_verfuegbar') {
    return 'Dieser Ladepunkt meldet sich gerade nicht - ein Eingriff käme nicht an.';
  }
  if (!budget || budget.surplusActive !== true) {
    return 'Diese Ladung folgt keiner Überschuss-Priorität - es gibt nichts zu übersteuern.';
  }
  return null;
}

/**
 * Der Banner-Satz eines laufenden „Jetzt voll laden" (Mockup 1440, Marker 19).
 *
 * ⚠ Er trägt KEINEN Countdown, und das ist Absicht: der Herzschlag meldet je
 * Stecker nur `boost: true|false`, kein Ende. Eine Restzeit wäre hier erfunden
 * - der Eingriff endet beim Abstecken, und genau das steht stattdessen da.
 */
export function boostBanner(name: string): string {
  return `Handeingriff läuft: ${name} lädt voll (nur diese Ladung) · endet spätestens beim Abstecken`;
}

// --- Die Folgen-Karte ------------------------------------------------------

/**
 * Ein Block der Folgen-Karte. Die Schlüssel sind bewusst die des Haus-Musters
 * (`handeingriff.ts` `FolgenBlock`), damit der BESTEHENDE Dialog sie rendert -
 * es gibt in der Jetzt-Zone genau eine Folgen-Karte, nicht zwei.
 */
export interface LadepunktFolgenBlock {
  key: 'passiert' | 'risiko' | 'gleich' | 'ende';
  titel: string;
  zeilen: string[];
}

export interface LadepunktFolgen {
  titel: string;
  intro: string;
  bloecke: LadepunktFolgenBlock[];
  bestaetigen: string;
}

/**
 * Die Folgen-Karte VOR dem Klick - vier feste Blöcke (das b3-Haus-Muster) mit
 * den Sätzen des abgenommenen Mockups.
 *
 * ⚠ DIE EINZIGE ZAHL IST DIE GEMESSENE: die Anschlussgrenze wird nur genannt,
 * wenn die Box sie meldet (`gridLimitKw`); ohne sie steht der Satz ohne Zahl da
 * statt mit einer geratenen. Wie viel Leistung dieser Ladung dadurch wirklich
 * zufällt, weiss niemand vorher - deshalb behauptet die Karte es auch nicht.
 */
export function boostFolgenKarte(
  budget: ChargingBudget | null,
  dauer: LadepunktDauer,
): LadepunktFolgen {
  const limit = num(budget?.gridLimitKw);
  const netz = limit == null
    ? 'Ihr Netzanschluss bleibt geschützt.'
    : `Ihr Netzanschluss (${KW(limit)}) bleibt geschützt.`;
  return {
    titel: 'Jetzt voll laden',
    intro: BOOST_INTRO,
    bloecke: [
      {
        key: 'passiert',
        titel: 'Das passiert',
        zeilen: ['Diese Ladung bekommt volle Leistung - auch aus dem Netz, auch ohne Sonne.'],
      },
      {
        key: 'risiko',
        titel: 'Risiko',
        zeilen: [
          'Die anderen Ladepunkte teilen sich den Rest und können dadurch langsamer laden.',
        ],
      },
      {
        key: 'gleich',
        titel: 'Das bleibt gleich',
        zeilen: [
          netz,
          'Ihre Überschuss-Priorität bleibt für alle anderen Ladevorgänge unverändert.',
          'Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter - daran ändert dieser Knopf nichts.',
        ],
      },
      {
        key: 'ende',
        titel: 'Ende / Rücknahme',
        zeilen: [
          // ⚠ „bis Abstecken" bekommt KEINE Minutenzahl in den Satz - dort
          // gilt allein der Vertrags-Deckel der Box (4 Stunden), und eine
          // Zahl daneben wäre eine zweite, erfundene Frist.
          dauer.minutes == null
            ? 'Endet beim Abstecken, längstens nach 4 Stunden - danach gilt wieder Ihre Priorität.'
            : `Endet beim Abstecken, längstens nach ${dauer.label} - danach gilt wieder Ihre Priorität.`,
          'Sie können jederzeit früher „Automatik fortsetzen" wählen.',
        ],
      },
    ],
    bestaetigen: `Jetzt voll laden - ${dauer.label}`,
  };
}

/** Die Folgen-Karte der RÜCKNAHME - sie wirkt sofort und braucht keine Dauer. */
export function boostEndeKarte(): LadepunktFolgen {
  return {
    titel: 'Automatik fortsetzen',
    intro: 'Sie beenden die volle Ladung für diesen einen Ladevorgang.',
    bloecke: [
      {
        key: 'passiert',
        titel: 'Das passiert',
        zeilen: [
          'Der Eingriff endet sofort. Für diese Ladung gilt wieder Ihre Überschuss-Priorität.',
        ],
      },
      {
        key: 'gleich',
        titel: 'Das bleibt gleich',
        zeilen: [
          'Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter - daran ändert dieser Knopf nichts.',
        ],
      },
      {
        key: 'ende',
        titel: 'Ende / Rücknahme',
        zeilen: ['Sie können jederzeit wieder eingreifen.'],
      },
    ],
    bestaetigen: 'Automatik fortsetzen',
  };
}


/**
 * Der Ausfall-Schutz in drei Schritten - und der dritte trägt die RECHNUNG,
 * nicht eine nackte Zahl. Ohne berechenbare Zahlen wird der dritte Schritt
 * weggelassen statt geraten (die Box sagt dann selbst, warum sie nicht rechnen
 * kann).
 */
export function ausfallSchutz(budget: ChargingBudget | null): string[] {
  if (!budget) return [];
  const per = num(budget.safeDefaultKw);
  const steps: string[] = [];
  steps.push(
    per == null || per <= 0
      ? text(budget.safeDefaultNote) ??
          'Jede Säule hat ein eigenes Sicherheitsprofil gespeichert. VoltPilot hinterlegt es beim Verbinden.'
      : `Jede Säule hat ein eigenes Sicherheitsprofil gespeichert: höchstens ${KW(per)} je Stecker. VoltPilot hat es beim Verbinden hinterlegt und die Säule hat es bestätigt.`,
  );
  steps.push(
    'Jedes Limit von VoltPilot läuft nach 2 Minuten von selbst ab. Bleibt die Box still, fällt die Säule automatisch auf ihr Sicherheitsprofil zurück - dafür muss nichts funktionieren, das ist in der Säule eingebaut.',
  );
  const sum = failsafeSum(budget);
  if (sum) steps.push(`Laden geht weiter, nur langsamer. Ihr Anschluss bleibt auch im schlimmsten Fall geschützt: ${sum}`);
  return steps;
}

/** Die nachrechenbare Zeile `6 × 15 kW + 180 kW = 270 kW < Grenze 277 kW ✓`. */
export function failsafeSum(budget: ChargingBudget | null): string | null {
  if (!budget) return null;
  const per = num(budget.safeDefaultKw);
  const worst = num(budget.safeWorstCaseKw);
  const house = num(budget.maxHouseLoadKw);
  const limit = num(budget.gridLimitKw);
  const plugs = budget.connectorCount;
  if (per == null || worst == null || house == null || limit == null || plugs <= 0) return null;
  const holds = budget.safeDefaultHolds === true;
  const relation = holds ? '<' : '>';
  const mark = holds ? '✓' : '- diese Anlage prüfen wir gemeinsam';
  return `${plugs} Stecker × ${KW(per)} + höchste Gebäudelast ${KW(house)} = ${KW(worst)} ${relation} Grenze ${KW(limit)} ${mark}`;
}

// ---------------------------------------------------------------------------
// Säule anbinden (Mockups Fläche 3)
// ---------------------------------------------------------------------------

/**
 * Der EINE Satz, der die gewohnte Richtung umdreht - er steht überall dort, wo
 * eine Säule GESUCHT wird, und führt in den Assistenten.
 *
 * ⚠ Seit Geräteseiten Stufe 3 (E1) sind aus den drei erklärenden Sätzen ein
 * ASSISTENT geworden (`ladesaeuleAnbinden.ts`): er nennt die konkrete Adresse
 * zum Kopieren, weil die Box ihre eigene seit D5 MELDET - vorher konnte diese
 * Fläche nur den Weg beschreiben. Die Regel dahinter ist unverändert: eine
 * Adresse wird nie erfunden, sondern nur weitergereicht.
 */
export const ANBINDEN_EINSTIEG =
  'Ladesäulen verbinden sich selbst: Sie tragen in der Säule die Adresse Ihres VoltPilot-Geräts und eine Kennung ein - danach meldet sich die Säule von allein.';

/** Nur eine eingetragene Kennung wird zugelassen - die Zusage als Satz. */
export const ANBINDEN_ALLOWLIST =
  'VoltPilot nimmt ausschließlich Ladesäulen an, deren Kennung eingetragen ist. Eine unbekannte Verbindung wird abgewiesen und protokolliert.';

// ---------------------------------------------------------------------------
// Der Aktivieren-Dialog (Anschlussgrenze)
// ---------------------------------------------------------------------------

/** Die Folgenliste des Haus-Dialogs - sie sagt auch, was GLEICH bleibt. */
export function aktivierenFolgen(gridLimitKw: number | null): string[] {
  const folgen = [
    gridLimitKw == null
      ? 'VoltPilot verteilt ab sofort die verfügbare Leistung Ihres Netzanschlusses auf die ladenden Fahrzeuge.'
      : `VoltPilot rechnet ab sofort mit einer Anschlussgrenze von ${KW(gridLimitKw)} und verteilt die verfügbare Leistung auf die ladenden Fahrzeuge.`,
    'Was Gebäude und Anlage gerade ziehen, wird laufend abgezogen - Ihr Anschluss bleibt geschützt.',
    'Der Ausfall-Schutz Ihrer Säulen gilt unverändert weiter: er ist in der Säule gespeichert und wirkt auch, wenn VoltPilot still bleibt.',
    'Sie können die Grenze jederzeit ändern; sie gilt für alle Säulen dieser Anlage.',
  ];
  return folgen;
}

/** Die Warnung, die eine fehlende Grenze verdient - sie ist kein Detail. */
export const GRENZE_FEHLT =
  'Ohne hinterlegte Anschlussgrenze gibt VoltPilot keine Ladeleistung frei. Sie steht in Ihrem Netzanschlussvertrag.';

/** Prüft die Eingabe des Dialogs, bevor irgendetwas gespeichert wird. */
export function grenzeFehler(raw: string): string | null {
  const v = Number(String(raw).replace(',', '.').trim());
  if (!Number.isFinite(v) || v <= 0) return 'Bitte eine Leistung größer 0 kW eintragen.';
  if (v > 100000) return 'Diese Leistung ist unplausibel - bitte den Wert prüfen.';
  return null;
}

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function clock(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ''
    : new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(t);
}

export const __test = { KW, clock };
