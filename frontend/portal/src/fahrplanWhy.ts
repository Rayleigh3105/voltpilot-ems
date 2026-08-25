/**
 * Pure "Warum" logic for the battery Fahrplan (design report
 * data/vp-fahrplan-why-design: phases-first day story + per-slot why).
 *
 * The optimizer computes and PERSISTS the facts per slot (role, binding
 * flags, the exact value of stored energy) - this module only turns those
 * facts into presentation: consecutive same-role slots become PHASES (the
 * honest narrative unit - within a phase the exact slot ordering is partly
 * economically equivalent, so it is never justified), each phase gets its
 * planned €-contribution from the persisted cost fields, and each slot gets
 * ONE plain-German why-sentence built from its real numbers.
 *
 * Null-degradation is law: a plan whose slots carry no roles (old rows,
 * pre-feature optimizer, an unknown future role id) yields NO phases and the
 * Fahrplan renders byte-identically to today - explanations are never
 * fabricated. Customer copy never says Dual/Schattenpreis/MILP; the λ number
 * is called "Wert gespeicherter Energie" (the established admin German).
 */

import {
  CURTAIL_PLAN,
  curtailChipLabel,
  curtailRoleLabel,
  type CurtailTruth,
} from './curtailment';
import { FEED_IN_FULL_MARGIN_KW } from './flowConflict';
import { eurAmount, fmtNum } from './format';
import {
  leitgrund,
  type GrenzenGrund,
  type GrenzenKontext,
  type GrenzenSlot,
} from './grenzenWarum';
import type { PlanWordingKind } from './schedule';

// ---- The slot-role vocabulary (report §6) ---------------------------------

export const KNOWN_ROLES = [
  'abregeln',
  'reserve_halten',
  'warten',
  'pv_speichern',
  'guenstig_laden',
  'spitze_kappen',
  'verkaufen',
  'eigenverbrauch',
] as const;

export type SlotRole = (typeof KNOWN_ROLES)[number];

const ROLE_SET = new Set<string>(KNOWN_ROLES);

/** What the why-layer needs per slot - a structural subset of api ScheduleSlot. */
export interface WhySlot {
  start: string;
  batteryKw: number | null;
  socPct?: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
  curtailKw?: number | null;
  pvKw?: number | null;
  /**
   * Net grid power of the slot (kW, signed +import/−export). A negative value
   * means the slot feeds surplus into the grid - the trigger for the "Überschuss
   * geht ins Netz statt in die Batterie" reasons (Teil 4b, `surplusWhy`). Absent
   * on older runs: the surplus reasons then simply do not fire.
   */
  gridKw?: number | null;
  /** Slot role id (report §6); null/unknown = no why-layer for the plan. */
  slotRole?: string | null;
  /** Binding-constraint codes (report §5.1); null = none recorded. */
  slotFlags?: string[] | null;
  /** λ - the value of a stored kWh (ct/kWh, rounded 0.1 ct). */
  storedValueCtKwh?: number | null;
  /** π - effective energy value at the grid connection (admin-only display). */
  gridValueCtKwh?: number | null;
  /** μ - the slot's share of the Leistungspreis pressure (EUR/kW). */
  peakPressureEurKw?: number | null;
  /**
   * P0 "Textwahrheit" (report vp-netzbezug-nacht-s3 §6): what one imported
   * kWh REALLY costs this site in the slot (ct/kWh) - the price the optimizer
   * decided with. `priceEurMwh` is bare spot; comparing THAT against the
   * stored-energy value produced the systematically self-contradictory
   * sentence ("Börsenpreis 21,2 wäre teurer als 21,5" while grid power cost
   * 32,5). Null on older runs - the sentence degrades to a number-free form.
   */
  importPriceCtKwh?: number | null;
  /** What one exported kWh really earns in the slot (ct/kWh). */
  exportValueCtKwh?: number | null;
  /**
   * Which rule priced the import: fest | preisblatt | sammelaufschlag |
   * default-flag | spot. Decides whether the sentence may break the price
   * down into "Börsenpreis X + Netzentgelte/Abgaben Y".
   */
  importPriceSource?: string | null;
  /**
   * Persisted P2 wear the slot spends (EUR). Not part of the §5.1 customer
   * contract yet - when absent the phase-€ falls back to baseline − cost,
   * which matches the page's existing "Heute geplant gespart" framing.
   */
  wearCostEur?: number | null;
  /**
   * Duty-Vorschau (PR 4): true = das Gerät führt in diesem Slot den GEMESSENEN
   * Hausverbrauch nach, der Watt-Wert ist also eine Vorhersage. Dreiwertig -
   * siehe `schedule.ts slotDuty` (nur ein ausdrückliches true markiert).
   */
  coverLoadFromBattery?: boolean | null;
  /** Der Ladeseiten-Spiegel: nur den gemessenen Solar-Überschuss laden. */
  chargeFromSurplusOnly?: boolean | null;
  /**
   * Erklärbarkeit Stufe 1 (§4.2 C): die beste Handlung, die dieser RUHENDE
   * Slot verworfen hat. Vokabular {@link KNOWN_NEXT_BEST}; ein unbekanntes
   * Wort wird IGNORIERT, nie geraten.
   */
  whyNextBest?: string | null;
  /** Ihr Nachteil in ct/kWh (<= 0). Ohne sie gilt der Name als abwesend. */
  whyNextBestMarginCt?: number | null;
}

// ---- Erklärbarkeit Stufe 1: die exportierten Entscheidungs-Treiber ---------
//
// Konzept `data/vp-warum-erklaerbar-e2` §4.2/§4.4. Stufe 0 hat die unechten
// Ursachen entfernt - wo kein Fakt einen Treiber trug, wurde die Fläche
// beobachtend. Diese Stufe liefert die Fakten, also dürfen die ECHTEN Ursachen
// wieder gesagt werden: WORAN der Wert gespeicherter Energie ankert (der
// 17.08.-Trüb-Fall), wie viel der Horizont gratis nachfüllt, und wie KNAPP die
// Ruhe-Entscheidung war (Gleichstand vs. klare Sache).

/** Das Anker-Vokabular des Solvers (§4.2 A) - additiv, unbekannt ⇒ ignoriert. */
export const KNOWN_ANCHORS = [
  'einspeisewert',
  'bezugspreis',
  'marktpreis',
  'vorgabe',
] as const;

export type TerminalAnchor = (typeof KNOWN_ANCHORS)[number];

/**
 * Die Anker, über die sich überhaupt etwas AUSSAGEN lässt. `vorgabe` fehlt
 * bewusst: eine env-gepinnte Zahl hat keinen Anker, sie IST einer - über sie
 * kann die Fläche nichts erklären, also gibt {@link terminalAnchor} dort null
 * zurück und der Zweig ist typ-seitig unerreichbar.
 */
export type DerivedAnchor = Exclude<TerminalAnchor, 'vorgabe'>;

const ANCHOR_SET = new Set<string>(KNOWN_ANCHORS);

/** Das Vokabular der verworfenen Handlungen (§4.2 C). */
export const KNOWN_NEXT_BEST = [
  'decken',
  'verkaufen',
  'solar_speichern',
  'netzladen',
] as const;

export type NextBestKind = (typeof KNOWN_NEXT_BEST)[number];

const NEXT_BEST_SET = new Set<string>(KNOWN_NEXT_BEST);

/**
 * Unterhalb dieses Betrags ist die Marge ein GLEICHSTAND, keine Entscheidung
 * (ct/kWh) - die Anzeige-Genauigkeit des Speicherwerts, damit ein
 * „gleichwertig" auf der gezeigten Genauigkeit wörtlich stimmt. Zwilling von
 * `explain.NEXT_BEST_TIE_CT` (Optimizer) und `SlotEconomics.NEXT_BEST_TIE_CT`
 * (api) - **alle drei zusammen ändern**.
 */
export const NEXT_BEST_TIE_CT = 0.05;

/**
 * Ab dieser Grenze füllt der Horizont den Speicher so wenig von selbst nach,
 * dass „aufheben" die richtige Beschreibung ist - und ab der oberen so viel,
 * dass „füllt sich ohnehin wieder" gilt. ANZEIGE-Schwellen über einer
 * exportierten Zahl, die im Satz IMMER daneben steht (der Kunde kann sie also
 * nachprüfen); dazwischen wird schlicht nichts über die Auffüllung behauptet.
 */
export const REFILL_LOW_PCT = 20;
export const REFILL_HIGH_PCT = 60;

/** Die Lauf-Fakten, die der Plan trägt (§4.2 A/B) - alle optional. */
export interface PlanWhyFacts {
  whyTerminalAnchor?: string | null;
  whyRefillFreePct?: number | null;
}

/**
 * Der Anker des Speicherwerts, sofern dieser Portal-Stand ihn KENNT. Ein neues
 * Solver-Wort degradiert zur beobachtenden Ansicht (das
 * `ROLE_SET`/`RolloutStates`-Konsumenten-Muster), nie zu einem geratenen Satz.
 * `vorgabe` liefert bewusst `null`: eine env-gepinnte Zahl hat keinen Anker,
 * über den sich etwas aussagen ließe.
 */
export function terminalAnchor(plan?: PlanWhyFacts | null): DerivedAnchor | null {
  const raw = plan?.whyTerminalAnchor ?? null;
  if (raw == null || !ANCHOR_SET.has(raw) || raw === 'vorgabe') return null;
  return raw as DerivedAnchor;
}

/** Die freie Auffüll-Quote in Prozent, oder null (nie eine erfundene 0). */
export function refillFreePct(plan?: PlanWhyFacts | null): number | null {
  const v = plan?.whyRefillFreePct;
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** Name UND Marge sind EINE Aussage: fehlt eine Hälfte, gilt beides als leer. */
export function nextBestOf(
  slot: WhySlot,
): { kind: NextBestKind; marginCt: number; tie: boolean } | null {
  const kind = slot.whyNextBest ?? null;
  const margin = slot.whyNextBestMarginCt;
  if (kind == null || !NEXT_BEST_SET.has(kind)) return null;
  if (margin == null || !Number.isFinite(Number(margin))) return null;
  const marginCt = Number(margin);
  return {
    kind: kind as NextBestKind,
    marginCt,
    tie: Math.abs(marginCt) <= NEXT_BEST_TIE_CT,
  };
}

/** Die verworfene Handlung als Verbalphrase (Satz-Anfang, groß). */
function nextBestPhrase(kind: NextBestKind, plantKind: PlanWordingKind): string {
  switch (kind) {
    case 'decken':
      return 'Den Verbrauch jetzt aus dem Speicher zu decken';
    case 'verkaufen':
      return plantKind === 'direktvermarktung' ? 'Jetzt zu verkaufen' : 'Jetzt einzuspeisen';
    case 'solar_speichern':
      return 'Den Solar-Überschuss jetzt zu speichern';
    case 'netzladen':
      return 'Jetzt aus dem Netz zu laden';
  }
}

/** Dieselbe Handlung als kurzes Substantiv (Lesehöhe b/c). */
export function nextBestLabel(kind: NextBestKind, plantKind: PlanWordingKind): string {
  switch (kind) {
    case 'decken':
      return 'Verbrauch aus dem Speicher decken';
    case 'verkaufen':
      return plantKind === 'direktvermarktung' ? 'Verkaufen' : 'Einspeisen';
    case 'solar_speichern':
      return 'Solar-Überschuss speichern';
    case 'netzladen':
      return 'Aus dem Netz laden';
  }
}

/**
 * Der KNAPPHEITS-Halbsatz einer Ruhe-Entscheidung (F2 + F6). Ein Gleichstand
 * wird als Gleichstand ausgesprochen - eine Erklärung darf nie Sicherheit
 * vortäuschen, wo eine Abwägung war -, und der Zusatz benennt unsere
 * dokumentierte Tie-Break-POLITIK als Politik, nicht als Ökonomie: bei
 * Gleichstand bevorzugt der Solver ausdrücklich das Ruhen (Speicherschonung),
 * das ist eine Entscheidung von uns und keine Rechnung.
 */
export function margeSatz(slot: WhySlot, plantKind: PlanWordingKind): string | null {
  const nb = nextBestOf(slot);
  if (nb == null) return null;
  const phrase = nextBestPhrase(nb.kind, plantKind);
  if (nb.tie) {
    return `${phrase} wäre gerade praktisch gleichwertig (±0,0 ct/kWh) – VoltPilot wählt dann die schonendere Option und lässt den Speicher ruhen.`;
  }
  // Die Verbalphrase trägt ihr „jetzt" schon - ein zweites wäre Stottern
  // („Jetzt zu verkaufen wäre jetzt 3,1 ct/kWh schlechter", im Browser gesehen).
  return `${phrase} wäre ${ctFmt(Math.abs(nb.marginCt))} schlechter.`;
}

/**
 * Der ANKER-Satz: woher der Wert gespeicherter Energie kommt (§4.2 A/B) - der
 * Kern, der am 17.08. gefehlt hat. Er hängt an ZWEI Fakten (Anker + λ); ohne
 * einen von beiden ist er unerreichbar, und die Auffüll-Aussage kommt nur
 * dazu, wenn die exportierte Quote sie trägt.
 */
export function ankerSatz(slot: WhySlot, plan?: PlanWhyFacts | null): string | null {
  const anchor = terminalAnchor(plan);
  const lam = slot.storedValueCtKwh == null ? null : round1(Number(slot.storedValueCtKwh));
  if (anchor == null || lam == null) return null;
  const refill = refillFreePct(plan);
  const nachfuellen =
    refill == null
      ? ''
      : refill <= REFILL_LOW_PCT
        ? ` Aus eigenem Überschuss füllt er sich im Fahrplan-Zeitraum kaum nach (≈ ${pctFmt(refill)} der nutzbaren Kapazität).`
        : refill >= REFILL_HIGH_PCT
          ? ` Ihr eigener Überschuss füllt ihn im Fahrplan-Zeitraum ohnehin wieder auf (≈ ${pctFmt(refill)} der nutzbaren Kapazität).`
          : '';
  switch (anchor) {
    case 'bezugspreis':
      return `Der Speicher hebt seine Ladung für die kommenden Stunden auf: Sie ersetzt später Netzbezug und ist damit ≈ ${ctFmt(lam)} wert.${nachfuellen}`;
    case 'einspeisewert':
      return `Der Wert gespeicherter Energie (≈ ${ctFmt(lam)}) bemisst sich an der Einspeisung, die sie ersetzt.${nachfuellen}`;
    case 'marktpreis':
      return `Der Wert gespeicherter Energie (≈ ${ctFmt(lam)}) bemisst sich am günstigsten Nachkauf im Fahrplan-Zeitraum.${nachfuellen}`;
  }
}

/**
 * DIE GATE-TABELLE (§4.4 Punkt 1): jeder kausale Zweig nennt die Fakten, an
 * denen er hängt. Sie ist Dokumentation UND Prüfgegenstand - der Warum-Wächter
 * (`begruendung.test.ts`) fährt je Eintrag einen Negativ-Test „Gates absent ⇒
 * Zweig unerreichbar", und wer einen Zweig hinzufügt, ohne ihn hier
 * einzutragen, hat keinen.
 */
export interface Begruendung {
  id: string;
  /** Die Fakten, ohne die der Zweig nicht entstehen darf. */
  gates: string[];
  /** Was der Zweig behauptet (eine Zeile, für Menschen). */
  aussage: string;
}

export const BEGRUENDUNGEN: Begruendung[] = [
  {
    id: 'anker_bezugspreis',
    gates: ['plan.whyTerminalAnchor=bezugspreis', 'slot.storedValueCtKwh'],
    aussage: 'Der Speicher hebt die Ladung auf, weil sie später Netzbezug ersetzt.',
  },
  {
    id: 'anker_einspeisewert',
    gates: ['plan.whyTerminalAnchor=einspeisewert', 'slot.storedValueCtKwh'],
    aussage: 'Der Wert bemisst sich an der Einspeisung, die die Energie ersetzt.',
  },
  {
    id: 'anker_marktpreis',
    gates: ['plan.whyTerminalAnchor=marktpreis', 'slot.storedValueCtKwh'],
    aussage: 'Der Wert bemisst sich am günstigsten Nachkauf im Zeitraum.',
  },
  {
    id: 'auffuellung_gering',
    gates: ['plan.whyRefillFreePct<=REFILL_LOW_PCT'],
    aussage: 'Der Horizont füllt den Speicher kaum von selbst nach.',
  },
  {
    id: 'auffuellung_hoch',
    gates: ['plan.whyRefillFreePct>=REFILL_HIGH_PCT'],
    aussage: 'Der eigene Überschuss füllt den Speicher ohnehin wieder auf.',
  },
  {
    id: 'gleichstand',
    gates: ['slot.whyNextBest', 'slot.whyNextBestMarginCt', '|Marge|<=NEXT_BEST_TIE_CT'],
    aussage: 'Beides wäre gleichwertig - die Ruhe-Präferenz (Politik) entscheidet.',
  },
  {
    id: 'marge_klar',
    gates: ['slot.whyNextBest', 'slot.whyNextBestMarginCt', '|Marge|>NEXT_BEST_TIE_CT'],
    aussage: 'Die verworfene Handlung wäre um die genannte Marge schlechter.',
  },
  {
    // Erklärbarkeit Stufe 2: die zwei kausalen Halbsätze der „Lage"-Zeile
    // (`fahrplanLage.speicherHalbsatz`). Sie sagen dieselbe Sache wie
    // {@link ankerSatz}, nur kürzer und auf morgen bezogen - und hängen
    // deshalb an DENSELBEN Fakten. Eine zweite Wahrheit über denselben Fakt
    // wäre genau das, was das Haus vermeidet.
    id: 'lage_aufheben',
    gates: ['plan.whyTerminalAnchor=bezugspreis', 'plan.whyRefillFreePct<=REFILL_LOW_PCT'],
    aussage: 'Der Speicher hebt seine Ladung für die kommenden Abende auf.',
  },
  {
    id: 'lage_auffuellung',
    gates: ['plan.whyRefillFreePct>=REFILL_HIGH_PCT'],
    aussage: 'Der eigene Überschuss füllt den Speicher ohnehin wieder auf.',
  },
  {
    id: 'lambda_ueber_fenster',
    gates: ['slot.storedValueCtKwh', 'bester Börsenpreis im Plan-Fenster'],
    aussage: 'Verkaufen läge unter dem Wert gespeicherter Energie (W6).',
  },
  {
    id: 'netzladen_differenz',
    gates: ['slot.importPriceCtKwh', 'slot.storedValueCtKwh', 'imp < λ'],
    aussage: 'Der Bezugspreis liegt unter dem Wert gespeicherter Energie (W5).',
  },
  {
    id: 'eigenverbrauch_differenz',
    gates: ['slot.importPriceCtKwh', 'slot.storedValueCtKwh', 'imp > λ'],
    aussage: 'Der Bezugspreis liegt über dem Wert gespeicherter Energie.',
  },
  // Erklärbarkeit Stufe 3 „Grenzen als Gründe" (§5.4): die Abregel-Ursachen.
  // Die Rolle `abregeln` behauptete bis dahin IMMER den negativen Börsenpreis -
  // eine Ein-Ursachen-Aussage über eine Mehr-Ursachen-Entscheidung. Jeder Zweig
  // hängt jetzt an seinem exportierten Fakt; trägt keiner, sagt die Fläche die
  // BEOBACHTUNG („der Plan sieht vor, die Einspeisung zu drosseln").
  {
    id: 'grenze_14a',
    gates: ['slot.slotFlags enthält grid_limit_14a'],
    aussage: 'Der Netzbetreiber begrenzt gerade den Netzanschluss (§ 14a).',
  },
  {
    id: 'grenze_einspeisung',
    gates: ['slot.slotFlags enthält feed_in_cap'],
    aussage: 'Die Einspeisegrenze der Anlage begrenzt die PV.',
  },
  {
    id: 'grenze_negativpreis',
    gates: ['slot.priceEurMwh < 0'],
    aussage: 'Einspeisen würde beim negativen Börsenpreis Geld kosten.',
  },
  {
    // Die FREMDE Wahrheit im Gerät. Sie hängt an beiden Hälften des s0-Blocks
    // UND daran, dass die niedrigere Grenze NICHT unsere eigene Kappe sein
    // kann - die Regel wohnt in `curtailment.deviceLimitLine` und wird hier
    // durchgereicht, nie neu formuliert.
    id: 'grenze_geraet',
    gates: [
      'curtailment.exportGuard.limitKw',
      'curtailment.deviceExportLimit.limitKw',
      'Gerät < hinterlegt',
      'nicht unsere eigene capKw',
    ],
    aussage: 'Der Wechselrichter begrenzt die Einspeisung selbst enger.',
  },
  // Steuerung Stufe 6 „Vorschläge V1" (Konzept `vp-steuerung-konzept-b3` §3.3).
  // Eine Vorschlags-Karte behauptet eine URSACHE („da ist Überschuss", „das
  // sind die günstigsten Stunden") und trägt deshalb ihre Gates wie jeder
  // andere kausale Zweig. Ohne sie entsteht die Karte GAR NICHT - es gibt
  // keinen zahlfreien Rückfall, weil ein Vorschlag ohne Zahl kein Vorschlag
  // ist, sondern eine Vermutung.
  {
    id: 'vorschlag_ueberschuss',
    gates: [
      'slot.pvKw',
      'slot.loadKw',
      'pv - load >= Mindestleistung der Komponente',
      'Fenster >= MIN_UEBERSCHUSS_SLOTS',
    ],
    aussage: 'Der Fahrplan erwartet in diesem Fenster mehr Solarstrom, als das Haus braucht.',
  },
  {
    id: 'vorschlag_guenstig',
    gates: [
      'slot.importPriceCtKwh',
      'Preis-Spanne im Horizont >= MIN_SPANNE_CT',
      'Fenster >= GUENSTIG_SLOTS',
    ],
    aussage: 'Das sind die günstigsten Stunden des Fahrplan-Zeitraums.',
  },
  // Steuerung Stufe 7 „Vorschau mit Zahlen" (§3.5/§3.6/§3.8). Beide Zweige
  // behaupten eine WIRKUNG in Euro und hängen deshalb an ihren Zahlen; ohne
  // sie gibt es KEINEN zahlfreien Ersatz-Satz, sondern den Grund.
  {
    id: 'vorschau_delta',
    gates: ['server.deltaEur (zwei Solver-Läufe über EINE Eingabe)'],
    aussage: 'Diese Entscheidung kostet bzw. bringt im Fahrplan-Zeitraum den genannten Betrag.',
  },
  {
    id: 'vorschau_nachteil',
    gates: [
      'slot.loadKw',
      'slot.importPriceCtKwh',
      'slot.storedValueCtKwh',
      'Entladeleistung des Speichers',
      'Startzeit des Anspruchs',
    ],
    aussage: 'Der Regel-Vorrang hat dem Fahrplan bisher den genannten Betrag gekostet.',
  },
];

export type PhaseKind = 'charge' | 'discharge' | 'idle' | 'curtail';

/** Which goal a phase serves (report §7 - one driver per phase, no % split). */
export type ModeDriver = 'eigenverbrauch' | 'markt' | 'lastspitze' | 'notstrom' | null;

export interface PlanPhase {
  role: SlotRole;
  /** Inclusive slot-index range into the plan's slot array. */
  startIdx: number;
  endIdx: number;
  slotCount: number;
  /** ISO start of the first slot. */
  from: string;
  /** ISO end of the last slot (start + slotMinutes). */
  to: string;
  /**
   * Planned €-contribution of the phase: Σ (baseline − cost − wear) over its
   * priced slots. Null when no slot carries cost data - never a fabricated 0.
   */
  eur: number | null;
  kind: PhaseKind;
  driver: ModeDriver;
  /**
   * Erklärbarkeit Stufe 3: die Grenzen-Fakten der Phase, aggregiert aus ihren
   * Slots ({@link phases} setzt sie IMMER). Optional, damit ältere Aufrufer und
   * Test-Attrappen eine Phase weiterhin ohne sie bauen können - ohne sie bleibt
   * {@link phaseWhy} beobachtend, also zeichengleich zur Stufe davor.
   */
  limits?: PhaseLimits;
}

/**
 * Die Grenzen einer PHASE. Eine Phase hat keine eigenen Bindungs-Flags - sie
 * erbt die VEREINIGUNG der Flags ihrer Slots, und als Preis den TIEFSTEN
 * Börsenpreis (der Negativpreis-Fakt ist „irgendwo in dieser Phase lag der
 * Preis unter null"; ein Mittelwert würde ihn verschlucken).
 */
export interface PhaseLimits {
  /** Nur die Grenz-Flags am Netzanschluss - `grid_limit_14a`/`feed_in_cap`. */
  flags: string[];
  /** Der tiefste Börsenpreis der Phase in EUR/MWh; null ohne Preise. */
  minPriceEurMwh: number | null;
}

/** Die Bindungs-Flags, die eine Grenze AM NETZANSCHLUSS belegen (Stufe 3). */
const LIMIT_FLAGS = new Set<string>(['grid_limit_14a', 'feed_in_cap']);

/**
 * Die Phase als {@link GrenzenSlot} - dieselbe Verzweigung wie ein Slot, damit
 * Phasen-Karte und Slot-Panel über dieselbe Grenze nichts Verschiedenes sagen
 * können. Exportiert, weil die Phasen-Karte den Grenzen-Block daraus baut.
 */
export function phaseGrenzen(phase: PlanPhase): GrenzenSlot {
  return {
    slotFlags: phase.limits?.flags ?? null,
    priceEurMwh: phase.limits?.minPriceEurMwh ?? null,
  };
}

const ROLE_KIND: Record<SlotRole, PhaseKind> = {
  abregeln: 'curtail',
  reserve_halten: 'idle',
  warten: 'idle',
  pv_speichern: 'charge',
  guenstig_laden: 'charge',
  spitze_kappen: 'discharge',
  verkaufen: 'discharge',
  eigenverbrauch: 'discharge',
};

/** Below this a phase-€ is rounding noise, not a real contribution. */
export const PHASE_EUR_DEADBAND = 0.005;

/** Micro-phases shorter than this between same-role neighbors are smoothed. */
export const MICRO_PHASE_SLOTS = 3;

/** Every slot carries a KNOWN role - the gate for the whole why-layer. */
export function hasWhyLayer(slots: WhySlot[]): boolean {
  return (
    slots.length > 0 && slots.every((s) => s.slotRole != null && ROLE_SET.has(s.slotRole))
  );
}

/**
 * Group the plan's slots into phases: consecutive same-role runs, with
 * micro-runs (< 3 slots) BETWEEN same-role neighbors absorbed (report §3 -
 * a presentation rule; a short run between DIFFERENT roles is kept, it is a
 * real transition). Returns [] when any slot lacks a known role - the
 * null-degradation gate for the entire feature.
 */
export function phases(slots: WhySlot[], slotMinutes = 15): PlanPhase[] {
  if (!hasWhyLayer(slots)) return [];
  const roles = slots.map((s) => s.slotRole as SlotRole);

  // Consecutive same-role runs (inclusive index ranges).
  let runs: { role: SlotRole; start: number; end: number }[] = [];
  for (let i = 0; i < roles.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.role === roles[i]) last.end = i;
    else runs.push({ role: roles[i], start: i, end: i });
  }

  // Smooth micro-runs between same-role neighbors until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < runs.length - 1; i++) {
      const len = runs[i].end - runs[i].start + 1;
      if (len < MICRO_PHASE_SLOTS && runs[i - 1].role === runs[i + 1].role) {
        runs.splice(i - 1, 3, {
          role: runs[i - 1].role,
          start: runs[i - 1].start,
          end: runs[i + 1].end,
        });
        changed = true;
        break;
      }
    }
  }

  return runs.map((r) => {
    let eur: number | null = null;
    let anyPeakPressure = false;
    let reservePeak = false;
    let reserveBackup = false;
    // Erklärbarkeit Stufe 3: die Grenzen-Fakten der Phase (Vereinigung der
    // Flags, tiefster Preis) - siehe {@link PhaseLimits}.
    const limitFlags: string[] = [];
    let minPrice: number | null = null;
    for (let i = r.start; i <= r.end; i++) {
      const s = slots[i];
      if (s.costEur != null && s.baselineCostEur != null) {
        const wear = s.wearCostEur == null ? 0 : Number(s.wearCostEur);
        eur = (eur ?? 0) + (Number(s.baselineCostEur) - Number(s.costEur) - wear);
      }
      if (s.peakPressureEurKw != null && Number(s.peakPressureEurKw) > 0) anyPeakPressure = true;
      for (const f of s.slotFlags ?? []) {
        if (f === 'reserve_peak') reservePeak = true;
        if (f === 'reserve_backup') reserveBackup = true;
        if (LIMIT_FLAGS.has(f) && !limitFlags.includes(f)) limitFlags.push(f);
      }
      if (s.priceEurMwh != null && Number.isFinite(Number(s.priceEurMwh))) {
        const p = Number(s.priceEurMwh);
        if (minPrice == null || p < minPrice) minPrice = p;
      }
    }
    const lastStart = new Date(slots[r.end].start).getTime();
    return {
      role: r.role,
      startIdx: r.start,
      endIdx: r.end,
      slotCount: r.end - r.start + 1,
      from: slots[r.start].start,
      to: new Date(lastStart + slotMinutes * 60_000).toISOString(),
      eur,
      kind: ROLE_KIND[r.role],
      driver: phaseDriver(r.role, anyPeakPressure, reservePeak, reserveBackup),
      limits: { flags: limitFlags, minPriceEurMwh: minPrice },
    };
  });
}

/** Report §7 precedence: μ-pressure → reserve flags → role's home mode. */
function phaseDriver(
  role: SlotRole,
  anyPeakPressure: boolean,
  reservePeak: boolean,
  reserveBackup: boolean,
): ModeDriver {
  if (role === 'spitze_kappen' || anyPeakPressure) return 'lastspitze';
  if (role === 'reserve_halten') {
    if (reservePeak) return 'lastspitze';
    if (reserveBackup) return 'notstrom';
    return null;
  }
  if (role === 'guenstig_laden' || role === 'verkaufen') return 'markt';
  if (role === 'pv_speichern' || role === 'eigenverbrauch') return 'eigenverbrauch';
  return null;
}

/** Customer-facing name of a phase driver (the mode tag on the phase card). */
export function driverLabel(driver: ModeDriver): string | null {
  switch (driver) {
    case 'eigenverbrauch':
      return 'Eigenverbrauch';
    case 'markt':
      return 'Marktvermarktung';
    case 'lastspitze':
      return 'Lastspitzenkappung';
    case 'notstrom':
      return 'Notstrom';
    default:
      return null;
  }
}

// ---- Labels + copy per role (report §6, D3 vocabulary) --------------------

/**
 * Der Klammer-Zusatz des Abregel-Titels aus den BELEGTEN Grenz-Flags. Ohne
 * eines bleibt es beim etablierten Rollennamen (siehe {@link roleLabel}).
 */
function curtailAnlass(flags?: string[] | null): string {
  const f = flags ?? [];
  if (f.includes('grid_limit_14a')) return 'Netzgrenze §14a';
  if (f.includes('feed_in_cap')) return 'Einspeisegrenze';
  return 'Negativpreis';
}

/**
 * Full customer label of a role (the panel headline).
 *
 * `framed` = der umgebende Satz sagt bereits „Geplant ist gerade: …", dann
 * entfällt der „— geplant"-Zusatz (sonst stünde es zweimal in einer Zeile).
 *
 * `curtail` ist die Beleg-Lage der Abregelung (PR 3). Sie ändert NUR die Rolle
 * `abregeln` und nur, wenn der Aufrufer sie durch `curtailTruthForSlot`
 * geschickt hat — ohne Beleg (Standard) ist die Ausgabe zeichengleich zu
 * Fix 1, also zum PLAN-Wortlaut.
 */
export function roleLabel(
  role: SlotRole,
  kind: PlanWordingKind,
  flags?: string[] | null,
  framed = false,
  curtail: CurtailTruth = CURTAIL_PLAN,
): string {
  switch (role) {
    case 'abregeln':
      // Gegenwart NUR mit Beleg - sonst der Plan-Wortlaut aus Fix 1.
      // Der Klammer-Zusatz folgt seit Erklärbarkeit Stufe 3 dem BELEGTEN
      // Grenz-Flag (§5.4): eine vom Netzbetreiber angeordnete Drosselung als
      // „(Negativpreis)" zu betiteln, wäre genau der Widerspruch zwischen
      // Überschrift und Satz, den die Stufe beseitigt. Ohne Flag bleibt der
      // etablierte §6-Rollenname stehen - die URSACHE trägt der Satz darunter,
      // und der ist seit Stufe 3 fakten-gebunden.
      return curtailRoleLabel(curtail, framed, curtailAnlass(flags));
    case 'reserve_halten': {
      const f = flags ?? [];
      if (f.includes('reserve_backup')) return 'Reserve halten (Notstrom)';
      if (f.includes('reserve_peak')) return 'Reserve halten (Lastspitze)';
      return 'Reserve halten';
    }
    case 'warten':
      return 'Warten';
    case 'pv_speichern':
      return 'PV-Überschuss speichern';
    case 'guenstig_laden':
      return 'Günstig aus dem Netz laden';
    case 'spitze_kappen':
      return 'Lastspitze kappen';
    case 'verkaufen':
      return kind === 'direktvermarktung' ? 'Zum Spitzenpreis verkaufen' : 'Einspeisen';
    case 'eigenverbrauch':
      return 'Verbrauch aus dem Speicher decken';
  }
}

/**
 * ONE plain-German sentence summarizing a phase (the phase card body).
 *
 * `curtail` wie bei {@link roleLabel}: ohne Beleg (Standard) exakt der
 * Plan-Wortlaut aus Fix 1.
 */
export function phaseWhy(
  phase: PlanPhase,
  kind: PlanWordingKind,
  curtail: CurtailTruth = CURTAIL_PLAN,
  grenzen?: GrenzenKontext | null,
): string {
  switch (phase.role) {
    case 'pv_speichern':
      return 'Überschüssiger Solarstrom wandert in den Speicher statt in die Einspeisung – für die teuren Stunden.';
    case 'guenstig_laden':
      return phase.driver === 'lastspitze'
        ? 'Der Speicher kauft günstigen Strom ein – bewusst flach verteilt, damit keine neue Lastspitze entsteht.'
        : 'Der Speicher kauft günstigen Strom ein – für die teuren Stunden danach.';
    case 'eigenverbrauch':
      return 'Der Speicher deckt den Verbrauch und vermeidet teuren Netzbezug.';
    case 'verkaufen':
      return kind === 'direktvermarktung'
        ? 'Der Speicher verkauft zum Spitzenpreis.'
        : 'Der Speicher speist zum hohen Preis ein.';
    case 'spitze_kappen':
      return 'Der Speicher hält den Netzbezug unter dem Spitzen-Ziel – jede Viertelstunde darüber würde die Leistungsspitze anheben.';
    case 'reserve_halten':
      if (phase.driver === 'notstrom')
        return 'Der Speicher hält Ladung als Notstrom-Reserve zurück.';
      if (phase.driver === 'lastspitze')
        return 'Der Speicher hält Ladung als Reserve für die Lastspitzenkappung zurück.';
      return 'Der Speicher hält Ladung als Reserve zurück.';
    case 'warten':
      // BEOBACHTEND, nicht kausal (Erklärbarkeit Stufe 0, Konzept
      // vp-warum-erklaerbar-e2 §4.1): die Rolle `warten` beschreibt das
      // ERGEBNIS, nie den TREIBER - für sie gibt es strukturell mehrere
      // (Spanne zu klein · λ über jedem Nutzwert · exakter Gleichstand · voll ·
      // Reserve), und nur zwei davon sind heute als Fakt exportiert. Der frühere
      // Satz behauptete die Spannen-Ursache und lag am 17.08. arithmetisch
      // richtig und kausal falsch. Ohne Fakt wird die Beobachtung gesagt.
      return 'Der Speicher wartet – in dieser Phase ist weder Laden noch Entladen eingeplant.';
    case 'abregeln':
      // Erklärbarkeit Stufe 3 (§5.4): die Ursache kommt aus dem BELEGTEN
      // Leitgrund der Phase, nie mehr pauschal aus dem Negativpreis - der
      // Solver regelt auch an der Einspeisegrenze und an §14a ab. Ohne Beleg
      // die BEOBACHTUNG.
      return abregelSatz(leitgrund(phaseGrenzen(phase), grenzen), curtail, 'phase');
  }
}

/**
 * Der Abregel-Satz: BELEGTER Leitgrund + was der Plan tut. Ohne Grund bleibt
 * nur die Beobachtung übrig - der frühere Satz behauptete IMMER den negativen
 * Börsenpreis und war damit eine Ein-Ursachen-Aussage über eine
 * Mehr-Ursachen-Entscheidung (Konzept §5.4 / `begruendung.test.ts`).
 */
function abregelSatz(
  grund: GrenzenGrund | null,
  curtail: CurtailTruth,
  scope: 'slot' | 'phase',
): string {
  const done = curtail.stufe === 'ausgefuehrt';
  const wo = scope === 'slot' ? 'in dieser Viertelstunde' : 'in dieser Phase';
  if (grund == null) {
    return done
      ? `Die Einspeisung wird ${wo} gedrosselt.`
      : `Der Plan sieht vor, die Einspeisung ${wo} zu drosseln.`;
  }
  if (grund.id === 'negativpreis') {
    const tail = done
      ? 'die PV wird deshalb gedrosselt.'
      : 'der Plan sieht vor, die PV zu drosseln, statt draufzuzahlen.';
    // Der Grund-Satz endet auf einem Punkt - für den Anschluss ersetzt.
    return `${grund.text.replace(/\.$/, '')} – ${tail}`;
  }
  return grund.text;
}

/**
 * The phase's planned €-line, sign-honest (report §8): discharge/sell phases
 * read "+X €"; a charge phase's negative € is honestly an Einkauf that pays
 * off in the discharge phases. Null when nothing is computable or the value
 * is rounding noise.
 */
export function phaseEurLine(phase: PlanPhase): string | null {
  const amount = phaseEurAmount(phase);
  if (amount == null) return null;
  if (phase.kind === 'charge' && (phase.eur ?? 0) < 0)
    return `Einkauf ${amount} – zahlt sich in den Entladephasen aus`;
  return amount;
}

/** Just the signed amount ("+3,96 €" / "−0,54 €"); null when noise/absent. */
export function phaseEurAmount(phase: PlanPhase): string | null {
  if (phase.eur == null || !Number.isFinite(phase.eur)) return null;
  const v = phase.eur;
  if (Math.abs(v) < PHASE_EUR_DEADBAND) return null;
  return v > 0 ? `+${eurAmount(v)}` : `−${eurAmount(-v)}`;
}

/** The calm explanation next to a charge phase's negative € (else null). */
export function phaseEurNote(phase: PlanPhase): string | null {
  if (phase.kind === 'charge' && phase.eur != null && phase.eur < -PHASE_EUR_DEADBAND)
    return 'Einkauf, der sich in den Entladephasen auszahlt';
  return null;
}

/** "11:15–17:45 Uhr" for the phase card / band tooltip. */
export function phaseRange(phase: PlanPhase): string {
  const hm = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${hm(phase.from)}–${hm(phase.to)} Uhr`;
}

// ---- Per-slot why ---------------------------------------------------------

/** de-DE "31,5 ct/kWh". */
function ctFmt(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

/** de-DE "31,5" - a bare number for use inside a price breakdown. */
function numFmt(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** de-DE "13 %" - whole percent, the accuracy the refill share is exported at. */
function pctFmt(v: number): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`;
}

/**
 * Der bezifferte Abstand zweier im SELBEN Satz gezeigter ct-Zahlen ("4,2
 * ct/kWh ") - der Kunde kann ihn nachrechnen. Auf der ANGEZEIGTEN Genauigkeit
 * gerundet, damit er zu den genannten Zahlen passt; unter der Genauigkeit
 * entfällt er ersatzlos (leerer String), statt „0,0 ct/kWh" zu behaupten.
 */
function abstand(hoeher: number, niedriger: number): string {
  const d = round1(round1(hoeher) - round1(niedriger));
  return d >= 0.1 ? `${ctFmt(d)} ` : '';
}

/** Spot price of a slot in ct/kWh, null-safe. */
function spotCt(slot: WhySlot): number | null {
  return slot.priceEurMwh == null ? null : Number(slot.priceEurMwh) / 10;
}

/**
 * What one imported kWh really costs in this slot (ct/kWh) - the number the
 * optimizer decided with. Null on runs that predate the field; a sentence
 * needing it then degrades to its number-free form. NEVER falls back to the
 * spot price: labeling spot as "Netzstrom" is exactly the bug this closes.
 */
function importCt(slot: WhySlot): number | null {
  return slot.importPriceCtKwh == null ? null : Number(slot.importPriceCtKwh);
}

/** Below this the breakdown's Aufschlag term is noise, not information. */
const PRICE_PART_DEADBAND_CT = 0.05;

/**
 * The parenthetical that makes the grid price VERIFIABLE - only ever from
 * what the run really carries:
 *   preisblatt/sammelaufschlag/default-flag → "(Börsenpreis 21,2 +
 *     Netzentgelte/Abgaben 11,3)" - the remainder is stated, never itemized
 *     beyond what the API tells us;
 *   fest → "(Ihr Festpreis-Tarif)" - a flat retail price has no spot share;
 *   spot → "(Börsenpreis)" - import IS spot here, so no invented components;
 *   unknown/missing source → no parenthetical at all.
 */
function importPriceDetail(slot: WhySlot, imp: number): string | null {
  const source = slot.importPriceSource ?? null;
  if (source === 'fest') return '(Ihr Festpreis-Tarif)';
  if (source === 'spot') return '(Börsenpreis)';
  if (source !== 'preisblatt' && source !== 'sammelaufschlag' && source !== 'default-flag') {
    return null;
  }
  const spot = spotCt(slot);
  if (spot == null) return null;
  const parts = imp - spot;
  if (parts <= PRICE_PART_DEADBAND_CT) return null;
  return `(Börsenpreis ${numFmt(spot)} + Netzentgelte/Abgaben ${numFmt(parts)})`;
}

/** "32,5 ct/kWh (Börsenpreis 21,2 + Netzentgelte/Abgaben 11,3)". */
function importPricePhrase(slot: WhySlot, imp: number): string {
  const detail = importPriceDetail(slot, imp);
  return detail ? `${ctFmt(imp)} ${detail}` : ctFmt(imp);
}

/** Auf die ANGEZEIGTE Genauigkeit (0,1 ct) runden - siehe `bestPriceCt`. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Der höchste Börsenpreis im Plan-Fenster (ct/kWh); null ohne Preise.
 *
 * Gerundet auf die ANGEZEIGTE Genauigkeit, damit ein „liegt unter"-Satz immer
 * wörtlich stimmt - genau die Disziplin des Schwester-Zweigs
 * `schedule.idleReason` (`stored_value_above_peak`), aus dem dieser Zweig an
 * den Slot gewandert ist (W6).
 */
function bestPriceCt(slots: WhySlot[]): number | null {
  let best: number | null = null;
  for (const s of slots) {
    if (s.priceEurMwh == null) continue;
    const ct = Number(s.priceEurMwh) / 10;
    if (!Number.isFinite(ct)) continue;
    if (best == null || ct > best) best = ct;
  }
  return best == null ? null : round1(best);
}

/** Ø spot price over the plan's priced slots (ct/kWh); null without prices. */
export function dayAvgPriceCt(slots: WhySlot[]): number | null {
  let sum = 0;
  let n = 0;
  for (const s of slots) {
    if (s.priceEurMwh == null) continue;
    sum += Number(s.priceEurMwh) / 10;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/**
 * ONE customer why-sentence for a slot, from its real persisted numbers
 * (the customer-grade sibling of the admin whyText). λ is always called
 * "Wert gespeicherter Energie"; missing numbers degrade the sentence to a
 * number-free form, never an invented value. Null when the slot carries no
 * known role (the why-layer is then absent anyway).
 *
 * `curtail` wie bei {@link roleLabel}: ohne Beleg (Standard) exakt der
 * Plan-Wortlaut aus Fix 1.
 *
 * `slots` ist das PLAN-FENSTER, gegen das der Wert gespeicherter Energie
 * verglichen wird (W6, Erklärbarkeit Stufe 0). Es ist OPTIONAL: ohne das
 * Fenster (oder ohne λ) entfällt der Zweig und der Satz bleibt beobachtend -
 * nie ein Vergleich gegen einen Preis, den niemand geliefert hat.
 */
export function slotWhy(
  slot: WhySlot,
  kind: PlanWordingKind,
  curtail: CurtailTruth = CURTAIL_PLAN,
  slots: WhySlot[] = [],
  plan?: PlanWhyFacts | null,
  grenzen?: GrenzenKontext | null,
): string | null {
  const role = slot.slotRole;
  if (role == null || !ROLE_SET.has(role)) return null;
  const price = spotCt(slot);
  const lam = slot.storedValueCtKwh == null ? null : Number(slot.storedValueCtKwh);
  const flags = slot.slotFlags ?? [];

  switch (role as SlotRole) {
    case 'pv_speichern':
      return lam != null
        ? `Überschüssiger Solarstrom wird gespeichert statt eingespeist – gespeicherte Energie ist später ≈ ${ctFmt(lam)} wert.`
        : 'Überschüssiger Solarstrom wird für die teuren Stunden gespeichert.';
    // The two grid-price roles name the BEZUGSPREIS, never the bare spot
    // (P0 Textwahrheit): the comparison against the stored-energy value is
    // only made when it actually holds - otherwise the number is stated
    // without a claim, so the sentence can never contradict itself.
    case 'guenstig_laden': {
      const imp = importCt(slot);
      if (imp == null || lam == null) return 'Lädt günstig aus dem Netz für die teuren Stunden.';
      const head = `Lädt günstig aus dem Netz: Netzstrom kostet Sie jetzt ${importPricePhrase(slot, imp)}`;
      // W5 (Stufe 1): der ABSTAND wird beziffert, nicht nur behauptet - und
      // zwar als Differenz der zwei Zahlen, die im selben Satz stehen, also
      // vom Kunden nachrechenbar. Unter der Anzeige-Genauigkeit entfällt er
      // („0,0 ct/kWh günstiger" wäre keine Auskunft).
      return imp < lam
        ? `${head} – ${abstand(lam, imp)}weniger als der Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${head}.`;
    }
    case 'eigenverbrauch': {
      const imp = importCt(slot);
      if (imp == null || lam == null) {
        return 'Deckt den Verbrauch aus dem Speicher und vermeidet teuren Netzbezug.';
      }
      const head = `Deckt den Verbrauch aus dem Speicher: Netzstrom kostet Sie jetzt ${importPricePhrase(slot, imp)}`;
      return imp > lam
        ? `${head} – ${abstand(imp, lam)}mehr als der Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${head}.`;
    }
    case 'verkaufen': {
      const verb = kind === 'direktvermarktung' ? 'Verkauft zum Spitzenpreis' : 'Speist ein';
      return price != null && lam != null
        ? `${verb}: Börsenpreis ${ctFmt(price)} liegt über dem Wert gespeicherter Energie (≈ ${ctFmt(lam)}).`
        : `${verb}: der Preis liegt über dem Wert gespeicherter Energie.`;
    }
    case 'spitze_kappen':
      return 'Der Speicher hält den Netzbezug unter dem Spitzen-Ziel – jede Viertelstunde darüber würde die Leistungsspitze anheben.';
    // Ruhe-Sätze geschärft (vp-steuerung-ruhe-w2 §4): jeder sagt, was ALS
    // NÄCHSTES passiert - nicht nur, was gerade nicht passiert.
    case 'reserve_halten':
      if (flags.includes('reserve_backup'))
        return 'Der Speicher hält Ladung als Notstrom-Reserve zurück – so wie in Ihren Einstellungen festgelegt.';
      if (flags.includes('reserve_peak'))
        return 'Der Speicher hält Ladung als Reserve für die Lastspitzenkappung zurück.';
      return 'Der Speicher hält Ladung als Reserve zurück.';
    case 'warten':
      if (flags.includes('soc_max'))
        return 'Der Speicher ist voll. Er entlädt wieder, sobald es sich lohnt – meist am Abend, wenn der Strompreis steigt.';
      if (flags.includes('soc_floor'))
        return 'Der Speicher hat seine Schutz-Reserve erreicht. Er lädt automatisch wieder, sobald Ihre PV mehr liefert als das Haus braucht – oder der Strompreis günstig genug ist.';
      {
        // W1 (Erklärbarkeit Stufe 1): der ECHTE Treiber der Ruhe, aus den
        // exportierten Fakten - woher der Wert gespeicherter Energie kommt
        // (Anker + Auffüll-Quote) und wie knapp die Entscheidung war. Genau
        // diese vier Zahlen fehlten am 17.08., und die Vorlage füllte die
        // Lücke mit einer Spannen-Ursache, die niemand geprüft hatte. Beide
        // Halbsätze sind EINZELN gegated: es wird nur zusammengesetzt, was
        // wirklich vorliegt.
        const anker = ankerSatz(slot, plan);
        const marge = margeSatz(slot, kind);
        if (anker && marge) return `${anker} ${marge}`;
        if (anker) return anker;
        if (marge) return `Der Speicher wartet. ${marge}`;
      }
      {
        // W6 (Erklärbarkeit Stufe 0): der λ-über-Fenster-Zweig aus
        // `schedule.idleReason` an der Viertelstunde. Er ist der EINZIGE
        // kausale Zweig dieser Rolle und hängt an ZWEI exportierten Fakten -
        // dem Wert gespeicherter Energie UND dem besten Preis des Fensters;
        // fehlt einer, ist er unerreichbar. Verglichen wird auf der ANGEZEIGTEN
        // Genauigkeit, damit das „liegt unter" wörtlich stimmt; Gleichstand ist
        // kein Grund, sondern ehrlich nur Warten.
        const best = bestPriceCt(slots);
        if (lam != null && best != null && round1(lam) > best) {
          const tail =
            kind === 'direktvermarktung'
              ? 'Verkaufen wäre jetzt ein Verlustgeschäft.'
              : 'Einspeisen brächte jetzt weniger, als die Energie später wert ist.';
          return `Der Speicher wartet: Der höchste Börsenpreis im Zeitraum (${ctFmt(best)}) liegt unter dem Wert gespeicherter Energie (≈ ${ctFmt(round1(lam))}) – ${tail}`;
        }
      }
      // Ohne belegten Treiber: BEOBACHTEND (siehe {@link phaseWhy}).
      return 'Der Speicher wartet – für diese Viertelstunde ist weder Laden noch Entladen eingeplant.';
    case 'abregeln':
      // Erklärbarkeit Stufe 3 (§5.4): §14a → Einspeisegrenze → Negativpreis →
      // BEOBACHTUNG. Gegenwart weiterhin nur mit Ausführungs-Beleg (PR 3).
      return abregelSatz(leitgrund(slot, grenzen), curtail, 'slot');
  }
  return null;
}

// ---- Überschuss geht ins Netz statt in die Batterie (Teil 4b) -------------
//
// Situationen mit genug PV-Überschuss, in denen trotzdem eingespeist statt
// gespeichert wird. Der Kunde sieht im Energiefluss "PV → Netz" bei ruhendem
// (oder am Limit ladendem) Speicher und fragt sich warum - dafür gab es keine
// Begründung. Vier Fälle, alle aus schon vorhandenen Fahrplan-Daten ableitbar.

/** Below this a slot's grid power reads as "kein Export". */
const SURPLUS_EXPORT_DEADBAND_KW = 0.05;
/** Below this the battery reads as resting (mirrors the plan/chart deadband). */
const SURPLUS_REST_DEADBAND_KW = 0.05;

/** de-DE "12:00" for the "lädt ab X Uhr" reason. */
function slotTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Ab dieser Nähe zu 100 % ist „voll wird der Speicher trotzdem" belegt. */
const FULL_SOC_PCT = 90;

/** Optionaler Kontext für die kappen-bewusste + bezifferte Begründung. */
export interface SurplusOpts {
  /** Das PLAN-FENSTER, für die Ladefenster-Ökonomie (Teil 3). */
  slots?: WhySlot[];
  /** Slot-Länge in Minuten (kWh-Rechnung); Vorgabe 15. */
  slotMinutes?: number;
  /** Die gepflegte Einspeisegrenze am Netzanschluss (kW); null = keine. */
  maxFeedInKw?: number | null;
  /** Die GEMESSENE Einspeisung (kW, positiv); der „gemessen"-Teil von Teil 2. */
  measuredExportKw?: number | null;
}

function numOr(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/**
 * Die gepflegte Einspeisegrenze (kW), wenn der Überschuss sie erreicht - GEMESSEN
 * (live) ODER PROGNOSTIZIERT (der geplante Export des Slots). Sonst null. Teilt
 * sich die Marge {@link FEED_IN_FULL_MARGIN_KW} mit dem Flussabgleich, damit
 * „voll" auf Steuerzeile und Fahrplan dieselbe Schwelle meint.
 */
function capReachedLimit(slot: WhySlot, opts?: SurplusOpts): number | null {
  const limit = numOr(opts?.maxFeedInKw);
  if (limit == null || limit <= 0) return null;
  const measured = numOr(opts?.measuredExportKw);
  const plannedExport = slot.gridKw != null && Number(slot.gridKw) < 0 ? -Number(slot.gridKw) : null;
  const exp = measured ?? plannedExport;
  if (exp == null) return null;
  return exp >= limit - FEED_IN_FULL_MARGIN_KW ? limit : null;
}

/** „N kW" mit passender Genauigkeit (ganzzahlige Grenze ohne Nachkommastelle). */
function limitKwFmt(limit: number): string {
  return fmtNum(limit, 'kW', Number.isInteger(limit) ? 0 : 1);
}

/**
 * Der „bis dahin eingespeist"-Satz des Warte-Falls (Fall c) — kappen-EHRLICH
 * (Teil 2): erreicht der Überschuss die gepflegte Grenze, wird nicht ALLES
 * eingespeist, der Teil DARÜBER lädt den ruhenden Speicher bereits jetzt (das
 * war der gemeldete Widerspruch: „eingespeist" neben einem ladenden Speicher).
 * Ohne erreichte Grenze der unveränderte Satz aus Fix 1.
 */
function fedInClause(slot: WhySlot, opts?: SurplusOpts): string {
  const limit = capReachedLimit(slot, opts);
  return limit == null
    ? 'Bis dahin wird Ihr Überschuss eingespeist und vergütet.'
    : `Ihr Überschuss wird bis zur Einspeisegrenze (${limitKwFmt(limit)}) eingespeist und vergütet; was darüber liegt, lädt den Speicher.`;
}

/** Zusammenfassung des geplanten Ladefensters ab `from` (Teil 3). */
interface ChargeWindow {
  endTime: string;
  minExpCt: number | null;
  maxExpCt: number | null;
  kWh: number;
  endSocPct: number | null;
}

/**
 * Das zusammenhängende LADE-Fenster ab dem Slot `from` (ISO): solange der Plan
 * lädt (`batteryKw` über dem Ruheband). Liefert die Einspeisewert-Spanne (die
 * entgangene Vergütung des Wartens), die geplante Lademenge und das End-SoC.
 * null, wenn `from` kein Slot des Fensters ist oder dort nicht geladen wird.
 */
function chargeWindow(
  slots: WhySlot[],
  from: string,
  slotMinutes: number,
): ChargeWindow | null {
  const startIdx = slots.findIndex((s) => s.start === from);
  if (startIdx < 0) return null;
  let end = -1;
  let kWh = 0;
  let minExp: number | null = null;
  let maxExp: number | null = null;
  for (let i = startIdx; i < slots.length; i++) {
    const b = slots[i].batteryKw == null ? null : Number(slots[i].batteryKw);
    if (b == null || b <= SURPLUS_REST_DEADBAND_KW) break;
    end = i;
    kWh += b * (slotMinutes / 60);
    const e = slots[i].exportValueCtKwh;
    if (e != null && Number.isFinite(Number(e))) {
      const ev = Number(e);
      minExp = minExp == null ? ev : Math.min(minExp, ev);
      maxExp = maxExp == null ? ev : Math.max(maxExp, ev);
    }
  }
  if (end < 0) return null;
  const last = slots[end];
  return {
    endTime: new Date(new Date(last.start).getTime() + slotMinutes * 60_000).toISOString(),
    minExpCt: minExp,
    maxExpCt: maxExp,
    kWh,
    endSocPct: last.socPct == null ? null : Number(last.socPct),
  };
}

/** Die entgangene Vergütung im Ladefenster als „rund X ct/kWh" bzw. „X–Y ct/kWh". */
function expRange(min: number | null, max: number | null): string | null {
  if (min == null || max == null) return null;
  if (Math.abs(max - min) < 0.5) return `rund ${ctFmt(round1((min + max) / 2))}`;
  return `${numFmt(round1(min))}–${numFmt(round1(max))} ct/kWh`;
}

/** Die Zusicherung, dass der Speicher gefüllt wird — belegt aus dem Plan (Teil 3). */
function fillClause(win: ChargeWindow): string | null {
  if (win.kWh < 0.5) return null;
  const menge = `rund ${Math.round(win.kWh)} kWh bis ${slotTime(win.endTime)} Uhr`;
  return win.endSocPct != null && win.endSocPct >= FULL_SOC_PCT
    ? `Voll wird der Speicher trotzdem (geplant: ${menge}).`
    : `Der Speicher wird laut Fahrplan noch geladen (geplant: ${menge}).`;
}

/**
 * Warum wird der Solar-Überschuss GERADE eingespeist statt gespeichert? Fires
 * ONLY when the slot actually EXPORTS (`gridKw` < 0) and is not curtailed at a
 * negative price (role `abregeln`). Priority a > b > c > d:
 *   a) charge_cap: the battery already charges at max power, the rest overflows;
 *   b) soc_max: the battery is full;
 *   c) a resting battery that will charge later (needs `nextChargeAt`);
 *   d) a resting battery where feeding in pays more than storing would be worth.
 *
 * Null when no case applies OR a needed datum is missing - the caller then
 * falls back to the plain `slotWhy` reason (Null-Degradation bleibt Gesetz).
 * `nextChargeAt` (ISO) = start of the next charge phase, supplied by the caller
 * (`control.ts nextChargeStart`); absent → case c is skipped for case d.
 *
 * Cases a/b (full/maxed battery) can't absorb more, so their surplus IS fed in.
 * Cases c/d (resting battery) get the cap-honest phrasing (Teil 2): with the
 * feed-in limit reached, the excess above it charges the resting battery. Case c
 * additionally quantifies the wait economics from the plan (Teil 3).
 */
export function surplusWhy(
  slot: WhySlot,
  kind: PlanWordingKind,
  nextChargeAt?: string | null,
  opts?: SurplusOpts,
): string | null {
  const grid = slot.gridKw == null ? null : Number(slot.gridKw);
  // Only when the slot really feeds surplus into the grid.
  if (grid == null || grid >= -SURPLUS_EXPORT_DEADBAND_KW) return null;
  // Negative prices are a different story (role abregeln, Fix 1/3).
  if (slot.slotRole === 'abregeln') return null;

  const flags = slot.slotFlags ?? [];
  const batt = slot.batteryKw == null ? null : Number(slot.batteryKw);

  // a) Charging at max power - what the PV delivers beyond that is fed in. The
  //    battery is already at max, so it CANNOT take the excess (no cap clause).
  if (flags.includes('charge_cap') && batt != null && batt > SURPLUS_REST_DEADBAND_KW) {
    return `Der Speicher lädt bereits mit seiner maximalen Leistung (${fmtNum(batt, 'kW', 1)}). Was Ihre PV darüber hinaus liefert, wird eingespeist und vergütet.`;
  }
  // b) Full battery + surplus - likewise cannot absorb more.
  if (flags.includes('soc_max')) {
    return 'Der Speicher ist voll – Ihr Überschuss wird eingespeist und vergütet. Er entlädt wieder, sobald es sich lohnt, meist am Abend.';
  }

  // The remaining cases are about a RESTING battery.
  const resting = batt == null || Math.abs(batt) <= SURPLUS_REST_DEADBAND_KW;
  if (!resting) return null;

  // c) Deliberately waiting to charge later, when storing is most valuable.
  if (nextChargeAt != null) {
    // Teil 3: die Warte-Ökonomie beziffern - Einspeisen JETZT gegen die
    // (niedrigere) entgangene Vergütung im geplanten Ladefenster, plus die
    // Zusicherung aus dem Plan, dass der Speicher trotzdem gefüllt wird. Der
    // Kappen-Fakt (Überschuss über der Grenze lädt bereits jetzt) trägt auf der
    // Steuerzeile der Flussabgleich-Info-Satz - hier steht nur die Ökonomie.
    const expNow = numOr(slot.exportValueCtKwh);
    const win = opts?.slots ? chargeWindow(opts.slots, nextChargeAt, opts.slotMinutes ?? 15) : null;
    const range = win ? expRange(win.minExpCt, win.maxExpCt) : null;
    // Nur enrichen, wenn die Ökonomie WIRKLICH so ist: das Ladefenster kostet
    // weniger entgangene Vergütung als das Einspeisen jetzt (sonst wäre der
    // bezifferte „darum wartet er"-Satz irreführend).
    if (expNow != null && range != null && win!.maxExpCt != null && win!.maxExpCt <= expNow) {
      const fill = fillClause(win!);
      return `Der Speicher wartet absichtlich: Einspeisen bringt jetzt ${ctFmt(expNow)}, ab ${slotTime(nextChargeAt)} Uhr kostet Laden nur ${range} entgangene Vergütung.${fill ? ` ${fill}` : ''}`;
    }
    // Fallback ohne Bezifferung: kappen-ehrlicher „eingespeist"-Satz (Teil 2).
    return `Der Speicher wartet absichtlich: Er lädt laut Fahrplan ab ${slotTime(nextChargeAt)} Uhr, wenn Speichern am wertvollsten ist. ${fedInClause(slot, opts)}`;
  }
  // d) Feeding in pays more than storing would be worth later.
  const exp = numOr(slot.exportValueCtKwh);
  const lam = numOr(slot.storedValueCtKwh);
  if (exp != null && lam != null && exp >= lam) {
    // Teil 2: bei erreichter Grenze lädt der ruhende Speicher den Teil darüber
    // trotzdem - „nur eingespeist" wäre dann eine halbe Wahrheit.
    const capLimit = capReachedLimit(slot, opts);
    const capTail =
      capLimit == null
        ? ''
        : ` Über die Einspeisegrenze (${limitKwFmt(capLimit)}) hinaus lädt der Speicher trotzdem.`;
    return kind === 'direktvermarktung'
      ? `Ihr Solar-Überschuss wird gerade verkauft statt gespeichert: Die Einspeisung bringt jetzt ${ctFmt(exp)} – mehr, als der Strom später aus dem Speicher wert wäre (≈ ${ctFmt(lam)} nach Verlusten und Verschleiß).${capTail}`
      : `Ihr Solar-Überschuss wird gerade eingespeist statt gespeichert: Die Einspeisevergütung bringt jetzt mehr, als der Strom später einsparen würde.${capTail}`;
  }
  return null;
}

/** One label/value row of the slot panel's context list. */
export interface ContextRow {
  label: string;
  value: string;
}

/**
 * The slot panel's context rows from what the customer contract carries:
 * Börsenpreis (with the plan's Ø for comparison), PV-Prognose, Ladestand,
 * Wert gespeicherter Energie. Rows whose value is absent are omitted -
 * "—"-discipline, never a fabricated number.
 */
export function slotContextRows(
  slot: WhySlot,
  slots: WhySlot[],
  plan?: PlanWhyFacts | null,
  kind: PlanWordingKind = 'eigenverbrauch',
): ContextRow[] {
  const rows: ContextRow[] = [];
  const price = spotCt(slot);
  if (price != null) {
    const avg = dayAvgPriceCt(slots);
    rows.push({
      label: 'Börsenpreis',
      value: avg != null ? `${ctFmt(price)} · Ø ${ctFmt(avg)}` : ctFmt(price),
    });
  }
  // P0-Textwahrheit: was eine bezogene kWh diesen Standort WIRKLICH kostet -
  // die Zahl, mit der der Optimierer entschieden hat.
  const imp = importCt(slot);
  if (imp != null) {
    rows.push({ label: 'Netzstrom kostet Sie jetzt', value: importPricePhrase(slot, imp) });
  }
  if (slot.pvKw != null) {
    rows.push({
      label: 'PV-Prognose',
      value: `${Number(slot.pvKw).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`,
    });
  }
  if (slot.socPct != null) {
    rows.push({
      label: 'Ladestand danach',
      value: `${Number(slot.socPct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`,
    });
  }
  if (slot.storedValueCtKwh != null) {
    // Lesehöhe (b), Stufe 1: λ stand hier schon immer - NEU ist sein WARUM.
    // Der Zusatz kommt ausschließlich aus dem exportierten Anker; ohne ihn
    // bleibt die Zeile wortgleich wie vor dieser Stufe.
    const anchor = terminalAnchor(plan);
    const woher =
      anchor === 'bezugspreis'
        ? ' · so viel, weil sie später Netzbezug ersetzt'
        : anchor === 'einspeisewert'
          ? ' · bemessen an der Einspeisung, die sie ersetzt'
          : anchor === 'marktpreis'
            ? ' · bemessen am günstigsten Nachkauf'
            : '';
    rows.push({
      label: 'Wert gespeicherter Energie',
      value: `≈ ${ctFmt(Number(slot.storedValueCtKwh))}${woher}`,
    });
  }
  const refill = refillFreePct(plan);
  if (refill != null) {
    rows.push({
      label: 'Füllt sich von selbst nach',
      value: `≈ ${pctFmt(refill)} der nutzbaren Kapazität`,
    });
  }
  const nb = nextBestOf(slot);
  if (nb != null) {
    rows.push({
      label: 'Nächstbeste Option',
      value: nb.tie
        ? `${nextBestLabel(nb.kind, kind)} – praktisch gleichwertig (±0,0 ct/kWh)`
        : `${nextBestLabel(nb.kind, kind)} – ${ctFmt(Math.abs(nb.marginCt))} schlechter`,
    });
  }
  // W7: in dieser Viertelstunde ist der Watt-Wert eine VORHERSAGE, keine
  // feste Anweisung - deshalb kann Netzbezug entstehen, obwohl der Speicher
  // lädt. Nur bei einem ausdrücklichen true (die Dreiwertigkeit der Pflicht).
  if (slot.chargeFromSurplusOnly === true) {
    rows.push({
      label: 'In dieser Viertelstunde',
      value:
        'lädt der Speicher nur den gemessenen Solar-Überschuss – Ihr Haus bezieht seine Last parallel aus dem Netz',
    });
  } else if (slot.coverLoadFromBattery === true) {
    rows.push({
      label: 'In dieser Viertelstunde',
      value: 'folgt der Speicher dem gemessenen Hausverbrauch – der Plan-Wert ist eine Vorhersage',
    });
  }
  return rows;
}

/**
 * LESEHÖHE (c), der Technik-Blick (§5.3, Captain-Entscheid F1: für ALLE Kunden
 * aufklappbar, wie der Roh-Blick der Kommando-Transparenz). Die tragenden
 * Terme EINES Slots, alle aus der Persistenz - nichts wird hier gerechnet, und
 * eine Zeile entsteht nur zu einer Zahl, die wirklich vorliegt („—"-Disziplin).
 *
 * Vokabular wie im Betreiber-Blick etabliert („Wert gespeicherter Energie" für
 * λ); NIE „Dual/Schattenpreis/MILP" - das ist Kundensicht, auch wenn sie
 * technisch ist.
 */
export function technikRows(
  slot: WhySlot,
  plan?: (PlanWhyFacts & { fallback14a?: boolean | null }) | null,
  kind: PlanWordingKind = 'eigenverbrauch',
): ContextRow[] {
  // Die ROLLE steht bewusst NICHT hier: sie ist die Überschrift der Karte
  // direkt darüber (das Mockup in §5.3 zeigt einen eigenständigen Block).
  // Dieselbe Aussage zweimal auf einer Karte ist das dokumentierte
  // Anti-Muster des Hauses.
  const rows: ContextRow[] = [];
  if (slot.storedValueCtKwh != null) {
    const anchor = terminalAnchor(plan);
    const anker = anchor == null ? '' : ` · Anker: ${ANCHOR_LABEL[anchor]}`;
    rows.push({
      label: 'λ Wert gespeicherter Energie',
      value: `${ctFmt(round1(Number(slot.storedValueCtKwh)))}${anker}`,
    });
  }
  if (slot.gridValueCtKwh != null) {
    rows.push({
      label: 'π Energiewert am Netzpunkt',
      value: ctFmt(round1(Number(slot.gridValueCtKwh))),
    });
  }
  if (slot.peakPressureEurKw != null && Number(slot.peakPressureEurKw) > 0) {
    rows.push({
      label: 'μ Leistungspreis-Anteil',
      value: `${Number(slot.peakPressureEurKw).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} €/kW`,
    });
  }
  const refill = refillFreePct(plan);
  if (refill != null) {
    rows.push({
      label: 'Freie PV-Auffüllung im Zeitraum',
      value: `${pctFmt(refill)} der nutzbaren Kapazität`,
    });
  }
  const nb = nextBestOf(slot);
  if (nb != null) {
    rows.push({
      label: 'Marge der verworfenen Option',
      value: nb.tie
        ? `${nextBestLabel(nb.kind, kind)} ±0,0 ct/kWh → Gleichstand, Ruhe-Präferenz (Schonung) entscheidet`
        : `${nextBestLabel(nb.kind, kind)} −${ctFmt(Math.abs(nb.marginCt))}`,
    });
  }
  // Die Bindungen stehen als CHIPS über dem Aufklapper - hier steht nur die
  // Aussage, die dort strukturell fehlt: dass KEINE erfasst wurde. („Keine
  // Chips" heißt sonst mehrdeutig „keine Bindung" oder „nicht aufgezeichnet".)
  if (bindingChips(slot.slotFlags).length === 0) {
    rows.push({ label: 'Bindungen', value: 'keine' });
  }
  if (plan?.fallback14a != null) {
    rows.push({ label: 'Netzgrenze §14a eingeplant', value: plan.fallback14a ? 'nein' : 'ja' });
  }
  return rows;
}

/** Der Anker als Kundenwort (Technik-Blick + Lesehöhe b). */
const ANCHOR_LABEL: Record<DerivedAnchor, string> = {
  bezugspreis: 'vermiedener Netzbezug',
  einspeisewert: 'entgangene Einspeisung',
  marktpreis: 'günstigster Nachkauf',
};

// ---- Binding chips --------------------------------------------------------

/** Known binding codes → calm customer chips (unknown codes are ignored). */
const CHIP_LABELS: Record<string, string> = {
  soc_max: 'Speicher voll',
  soc_floor: 'Speicher am Minimum',
  reserve_backup: 'Notstrom-Reserve',
  reserve_peak: 'Reserve für Lastspitze',
  charge_cap: 'Maximale Leistung',
  discharge_cap: 'Maximale Leistung',
  solar_only: 'Nur Solarladen (EEG)',
  grid_limit_14a: 'Netzgrenze §14a',
  feed_in_cap: 'Einspeisegrenze',
  peak_defining: 'Bestimmt die Lastspitze',
  // Ohne Beleg der Plan-Wortlaut wie überall bei der Abregelung; mit Beleg
  // ersetzt `bindingChips` ihn durch „Drosselung aktiv".
  curtailing: 'Drosselung geplant',
};

/**
 * The slot's binding constraints as calm German chips. Unknown codes are
 * dropped (the vocabulary is additive), duplicates collapse (charge_cap +
 * discharge_cap → one "Maximale Leistung").
 */
export function bindingChips(
  flags: string[] | null | undefined,
  curtail: CurtailTruth = CURTAIL_PLAN,
): string[] {
  if (!flags) return [];
  const out: string[] = [];
  for (const f of flags) {
    const label = f === 'curtailing' ? curtailChipLabel(curtail) : CHIP_LABELS[f];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ---- Plan-level honesty copy ---------------------------------------------

/** Forecast honesty footer (report §8) - shown only with the why-layer. */
export const FORECAST_FOOTNOTE =
  'Basiert auf Ihrer Verbrauchs- und PV-Prognose · aktualisiert alle 15 Minuten.';

/**
 * Fallback-build honesty (report §8): the plan could not fully schedule the
 * §14a grid limit - the device enforces it additionally on execution.
 */
export const FALLBACK_14A_NOTE =
  'Die Netzgrenze (§14a) konnte nicht vollständig eingeplant werden – Ihr Gerät begrenzt zusätzlich.';
