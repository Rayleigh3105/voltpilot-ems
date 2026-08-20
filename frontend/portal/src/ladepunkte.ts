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
  updatedAt?: string | null;
  updatedBy?: string | null;
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

export interface LadevorgangRow {
  key: string;
  /** „Säule Hof Nord · Stecker A" */
  title: string;
  /** Das ZUSTANDS-WORT - nie nur eine Farbe (K5/K10). */
  word: string;
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
  const power = num(con.powerKw);
  const allocated = num(con.allocatedKw);
  const charging = con.charging && (power == null || power > 0.05);
  const faulted = con.status === 'Faulted' || con.status === 'Unavailable';
  let word = 'frei';
  // Das Wort OHNE den Übersteuerungs-Zusatz: der Verteiler kennt „Jetzt voll
  // laden" nicht und meldet für dieselbe Sekunde weiter „lädt".
  let baseWord = 'frei';
  let tone: LadeTone = 'ruhig';
  if (faulted) {
    word = 'Störung an der Säule';
    tone = 'stoerung';
  } else if (charging) {
    // ⚠ Eine übersteuerte Ladung SAGT es: eine volle Ladung, die niemand
    // angefordert hat, wäre ein stiller Bruch der eigenen Priorität des Kunden.
    word = con.boost ? 'lädt voll auf Ihren Wunsch' : 'lädt';
    baseWord = 'lädt';
    tone = 'laedt';
  } else if (con.sessionSince) {
    word = 'wartet';
  }
  return {
    key: `${c.chargePointId}#${con.connectorId}`,
    title: `${chargerName(c)} · ${connectorName(con.connectorId)}`,
    word,
    tone,
    // ⚠ Der Grund wird nur genannt, wenn er MEHR sagt als das Wort: der
    // Verteiler nennt einen ladenden Stecker selbst „lädt", und die Zeile
    // zweimal dasselbe sagen zu lassen ist Rauschen, kein Beleg. Verglichen
    // wird auch gegen das BASIS-Wort - eine übersteuerte Ladung trägt sonst
    // „lädt" unter „lädt voll auf Ihren Wunsch".
    reason:
      sameWord(con.reasonText, word) || sameWord(con.reasonText, baseWord)
        ? null
        : text(con.reasonText),
    reasonCode: text(con.reason),
    powerKw: power,
    allocatedKw: allocated,
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
  return row.tone === 'laedt' || row.reasonCode === 'kein_ueberschuss' || row.word === 'wartet';
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
 * Der Assistent DREHT die gewohnte Richtung um, und der erste Satz sagt es.
 *
 * ⚠ Die Adresse zeigt das GERÄT, nicht das Portal: die Box weiß nicht, unter
 * welchem Namen ihr LAN sie erreicht, und eine erfundene Adresse auf einem
 * Kopier-Feld ist schlimmer als keine. Deshalb nennt diese Fläche den WEG statt
 * eine Adresse zu behaupten.
 */
export const ANBINDEN_SCHRITTE = [
  'Ladesäulen verbinden sich selbst: Sie tragen in der Säule die Adresse Ihres VoltPilot-Geräts und eine Kennung ein - danach meldet sich die Säule von allein.',
  'Adresse und Kennung zeigt Ihnen die Geräteseite von VoltPilot in Ihrem Netzwerk (Bereich „Ladepunkte").',
  'Sobald sich die Säule gemeldet hat, erscheint sie hier automatisch - mit Modell und Steckern, die sie selbst mitbringt.',
];

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
