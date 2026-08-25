/**
 * Die REGELN-Fläche: Zustands-Vokabular + Karten-Ableitung + Sortierung
 * (Einheitsmodell Stufe 5a, Konzept `vp-komponenten-einheit-h2` Teil 5b.1/5b.2).
 *
 * Eine Regel hat DREI unabhängige Wahrheiten, und die Karte spricht sie in EINEM
 * Satzmuster aus — „Aktiv · greift gerade — lädt 7,4 kW":
 *
 *  1. **Lebenszyklus** — Entwurf · Aktiv · Pausiert · Stillgelegt.
 *  2. **Gerätestand** — „Läuft auf dem Gerät · v3" … (die fünf Zustände
 *     existieren WÖRTLICH in `flows/rollout.ts` `deployedBadge`; sie werden hier
 *     WIEDERVERWENDET, nicht nachgebaut).
 *  3. **Betrieb** — „greift gerade — lädt 7,4 kW" / „wartet — {Grund}"
 *     (der Herzschlag-Verbraucherblock über `consumers/status.ts`).
 *
 * Ehrlichkeitsregeln, die nicht wegoptimiert werden dürfen:
 *  - **Ohne Beleg keine Betriebs-Aussage.** Meldet KEIN Gerät Zustände, zeigt
 *    die Karte nur Lebenszyklus + Gerätestand — nie ein geratener Betrieb.
 *  - **Kein erfundener Zähler.** „heute N× geschaltet" ist Stufe 5b; hier
 *    bleibt das Feld leer und die Fläche sagt das (`VERLAUF_NOCH_NICHT`).
 *  - **Schweigen ist bernstein, nie rot** — eine Lücke ist kein bewiesener
 *    Defekt; rot ist nur, was wirklich kaputt ist (Komponente entfernt,
 *    Aktivierung abgelehnt).
 *  - **Jede rote Zeile trägt ihren Grund.**
 *
 * PURE + unit-getestet (`zustand.test.ts`).
 */
import type { Consumer } from '../consumers/types';
import {
  consumerStatusLine,
  STATUS_UNKNOWN_TEXT,
  type ConsumerRuntimeStatus,
} from '../consumers/status';
import {
  fulfilmentSummary,
  overrideLine,
  type ConsumerFulfilment,
  type ManualOverride,
} from '../consumers/fulfillment';
import { deployedBadge, type DeployedBadge } from '../flows/rollout';
import type { FlowDeviceAck } from '../flows/flowsApi';
import type { EditorEntity, FlowDocument } from '../flows/model';
import { deriveClaims } from '../flows/model';
import type { RuleEvents } from '../api';
import { aktivitaetZeile, karteSchluessel } from './verlauf';
import { flowSatz, VORRANG_ZEILE } from './satz';

/** Der Wohnort des Verlaufs — Stufe 5b, hier ehrlich leer. */
export const VERLAUF_NOCH_NICHT =
  'Der Verlauf dieser Regel wird noch nicht aufgezeichnet.';

export type RegelTon = 'ok' | 'warn' | 'error' | 'off';
export type RegelArt = 'rezept' | 'baukasten' | 'editor';

/**
 * Aufmerksamkeit zuerst (5b.2): Fehler → wartet/übersteuert/Störung → greift
 * gerade → ruhig aktiv → Entwurf → pausiert. Dieselbe Rangfolge, mit der schon
 * der Flotten-Puls sortiert.
 */
export const RANK_FEHLER = 0;
export const RANK_WARTET = 1;
export const RANK_GREIFT = 2;
export const RANK_AKTIV = 3;
export const RANK_ENTWURF = 4;
export const RANK_PAUSIERT = 5;

export interface RegelZustandView {
  /** Das Lebenszyklus-Wort (immer vorhanden). */
  lebenszyklus: string;
  /** Der Gerätestand, oder null wenn nichts ausgerollt ist. */
  geraet: DeployedBadge | null;
  /** Der Betriebs-Halbsatz, oder null OHNE Beleg. */
  betrieb: string | null;
  /** Eine Störung/ein Fehler mit seinem Grund, oder null. */
  problem: string | null;
  /** Die EINE Zustands-Zeile der Karte. */
  zeile: string;
  ton: RegelTon;
  rang: number;
}

export interface RegelChip {
  key: string;
  label: string;
  /** Ein Nachweis-Chip (Pflicht-Rezept) wird ruhig getönt. */
  ton: 'plain' | 'ok' | 'warn';
}

export interface RegelKarte {
  key: string;
  art: RegelArt;
  /** Flow-Id (Flow-Regel) bzw. Verbraucher-/Komponenten-Id (Rezept). */
  id: string;
  name: string;
  /** Der Klartext-Satz — null heißt: es gibt keinen ableitbaren. */
  satz: string | null;
  /** Die ehrliche Ersatz-Zeile, wenn `satz` null ist. */
  ersatz: string;
  zustand: RegelZustandView;
  chips: RegelChip[];
  /** Der statische Erklärsatz (Speicher-Vorrang), sonst null. */
  hinweis: string | null;
  /**
   * Die Zähler-Zeile des Regel-Protokolls („heute 3× geschaltet · zuletzt
   * 14:02"), Stufe 5b. NULL heißt: für diese Regel liegt (noch) nichts
   * Belastbares vor - dann steht dort NICHTS, nie eine erfundene 0.
   */
  aktivitaet: string | null;
  /**
   * Der NACHTEIL-BELEG (Steuerung Stufe 7, Leitprinzip Regel 3): „diese Regel
   * hält den Speicher seit 14:10 — dem Fahrplan sind dadurch bisher etwa
   * 0,80 € entgangen." Er steht NEBEN {@link hinweis}, nicht an seiner Stelle:
   * der Hinweis WARNT vor dem Klick, der Beleg BERICHTET danach — zwei
   * Aussagen, die zusammen erst das Leitprinzip erfüllen.
   *
   * NULL heißt: kein Anspruch auf den Speicher, keine Startzeit, kein
   * Fahrplan, oder ein Nachteil unter der Sichtbarkeitsschwelle. Nie eine 0
   * und nie eine Schätzung.
   */
  nachteil: string | null;
  /** Schnellschalter-Stellung. */
  an: boolean;
  /** Die Version, wenn eine ausgerollt/gespeichert ist. */
  version: number | null;
}

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

export interface FlowRegelInput {
  flowId: string;
  name: string;
  activeVersion: number | null;
  latestVersion: number;
  latestLifecycle: string;
  latestDocument: FlowDocument | null;
  /** Die Gerätebestätigung aus dem Herzschlag (fehlt = keine Behauptung). */
  ack?: FlowDeviceAck | null;
}

export interface RezeptRegelInput {
  consumer: Consumer;
  status?: ConsumerRuntimeStatus | null;
  fulfilment?: ConsumerFulfilment | null;
  override?: ManualOverride | null;
  /** Der Satz aus dem gespeicherten Policy-Dokument (fehlt = kein Satz). */
  satz?: string | null;
  /** Ob IRGENDEIN Gerät Zustände gemeldet hat (die Beleg-Regel). */
  anyStatusReported: boolean;
}

export interface RegelKartenInput {
  flows: FlowRegelInput[];
  rezepte: RezeptRegelInput[];
  entities: EditorEntity[];
  /**
   * Das Regel-Protokoll der Anlage (Stufe 5b). Fehlt es (älteres Backend, der
   * Abruf ist fail-soft), tragen die Karten KEINE Zähler-Zeile und die Fläche
   * ist zeichengleich zu Stufe 5a.
   */
  protokoll?: RuleEvents | null;
  /**
   * Der NACHTEIL-BELEG je Regel-Schlüssel (Steuerung Stufe 7). Er wird von der
   * Fläche gerechnet, weil er den Fahrplan und die Speicherdaten braucht, die
   * diese Ableitung nicht kennt — hier wird er nur EINSORTIERT. Fehlt er,
   * bleiben die Karten zeichengleich zu Stufe 6.
   */
  nachteile?: Record<string, string> | null;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Lebenszyklus
// ---------------------------------------------------------------------------

const LIFECYCLE_WORD: Record<string, string> = {
  draft: 'Entwurf',
  simulated: 'Entwurf',
  active: 'Aktiv',
  retired: 'Pausiert',
};

/** Das Lebenszyklus-Wort einer FLOW-Regel (5b.1, erste Ebene). */
export function lebenszyklusWort(lifecycle: string, active: boolean): string {
  if (active) return 'Aktiv';
  return LIFECYCLE_WORD[lifecycle] ?? 'Entwurf';
}

/** Das Lebenszyklus-Wort einer REZEPT-Regel (Verbraucher). */
export function rezeptLebenszyklus(c: Consumer): string {
  if (c.controlActivation === 'active') return 'Aktiv';
  if (c.controlActivation === 'paused') return 'Pausiert';
  return 'Entwurf';
}

/**
 * Der Zusatz, den „Pausiert" beim Verbraucher WÖRTLICH mitführt: das Gerät
 * folgt seinem Failsafe (der Wortlaut aus `consumers/activation.ts`).
 */
export const PAUSIERT_FAILSAFE = 'das Gerät folgt seinem Failsafe';

// ---------------------------------------------------------------------------
// Zustands-Zeile
// ---------------------------------------------------------------------------

function compose(parts: (string | null)[]): string {
  return parts.filter((p) => p != null && p !== '').join(' · ');
}

/** Die Zustands-Zeile einer FLOW-Regel. */
export function flowZustand(input: FlowRegelInput): RegelZustandView {
  const active = input.activeVersion != null;
  const lebenszyklus = lebenszyklusWort(input.latestLifecycle, active);
  const geraet = active
    ? deployedBadge({
      activeVersion: input.activeVersion,
      ackVersion: input.ack?.flowVersion ?? null,
      ackState: (input.ack?.state as 'active' | 'error' | 'unsupported' | undefined) ?? null,
      ackDetail: input.ack?.detail ?? null,
    })
    : null;

  let problem: string | null = null;
  let ton: RegelTon = active ? 'ok' : 'off';
  let rang = active ? RANK_AKTIV : RANK_ENTWURF;
  if (input.latestLifecycle === 'retired' && !active) {
    rang = RANK_PAUSIERT;
  }
  if (geraet && geraet.tone === 'warn') {
    // „Gerät meldet ein Problem" / „Gerät zu alt für diese Regel": bernstein,
    // nie rot - und der Grund reist mit, wenn das Gerät einen genannt hat.
    problem = compose([geraet.label, geraet.detail]);
    ton = 'warn';
    rang = RANK_WARTET;
  }

  return {
    lebenszyklus,
    geraet,
    betrieb: null,
    problem,
    zeile: compose([lebenszyklus, problem ?? (geraet ? geraet.label : null)]),
    ton,
    rang,
  };
}

/** Die Zustands-Zeile einer REZEPT-Regel (Verbraucher). */
export function rezeptZustand(
  input: RezeptRegelInput,
  now: Date = new Date(),
): RegelZustandView {
  const c = input.consumer;
  const lebenszyklus = rezeptLebenszyklus(c);
  const banner = overrideLine(input.override, now);
  const aktiv = c.controlActivation === 'active';

  // Ohne einen einzigen gemeldeten Zustand behauptet die Karte NICHTS über den
  // Betrieb (die Beleg-Regel) - sie zeigt dann nur den Lebenszyklus. Und was
  // eine NICHT aktive Regel „gerade tut", gibt es nicht: der gemeldete Zustand
  // gehört dann dem GERÄT, nicht ihr, also spricht die Karte ihn nicht als
  // Regel-Betrieb aus.
  const line = input.anyStatusReported && aktiv
    ? consumerStatusLine(input.status ?? undefined)
    : null;

  let betrieb: string | null = null;
  let problem: string | null = null;
  let ton: RegelTon = aktiv ? 'ok' : 'off';
  let rang = aktiv ? RANK_AKTIV : RANK_ENTWURF;
  if (c.controlActivation === 'paused') rang = RANK_PAUSIERT;

  if (line && line.text !== STATUS_UNKNOWN_TEXT) {
    // Ein Grund, der WÖRTLICH den Zustand wiederholt („Gerät meldet sich nicht
    // — Gerät meldet sich nicht"), sagt nichts Zweites: er entfällt. Im Browser
    // aufgefallen, nicht im Unit-Test.
    const grund = line.reason && line.reason !== line.text ? line.reason : null;
    const zusatz = compose([grund, line.unconfirmed ? 'Ausführung nicht bestätigt' : null]);
    betrieb = zusatz ? `${line.text} — ${zusatz}` : line.text;
    if (line.tone === 'ok') {
      ton = 'ok';
      rang = RANK_GREIFT;
    } else if (line.tone === 'warn') {
      ton = 'warn';
      rang = RANK_WARTET;
      problem = betrieb;
      betrieb = null;
    } else {
      // „Bereit"/„Wartet auf passenden Zeitpunkt": die Regel läuft, greift aber
      // gerade nicht - sie steht über der ruhig aktiven, unter einer Störung.
      rang = RANK_WARTET;
    }
  }

  if (banner) {
    // Eine laufende Sofortaktion hat Vorrang - und die Regel sagt das.
    problem = 'wartet — Sofortaktion hat Vorrang';
    betrieb = null;
    ton = 'warn';
    rang = RANK_WARTET;
  }

  if (c.connection !== 'connected' && c.controlActivation !== 'not_activated') {
    problem = 'Gerät ist nicht verbunden';
    ton = 'warn';
    rang = RANK_WARTET;
  }

  const pausiert = c.controlActivation === 'paused' ? PAUSIERT_FAILSAFE : null;
  return {
    lebenszyklus,
    geraet: null,
    betrieb,
    problem,
    zeile: compose([lebenszyklus, pausiert, problem ?? betrieb]),
    ton,
    rang,
  };
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** Die Komponenten-Chips einer Flow-Regel (aus den D-13-Ansprüchen). */
export function flowChips(doc: FlowDocument | null, entities: EditorEntity[]): RegelChip[] {
  if (!doc) return [];
  const seen = new Set<string>();
  const chips: RegelChip[] = [];
  for (const claim of deriveClaims(doc)) {
    if (seen.has(claim.entityId)) continue;
    seen.add(claim.entityId);
    const found = entities.find((e) => e.id === claim.entityId);
    chips.push({
      key: claim.entityId,
      // Eine gelöschte Komponente wird BENANNT, nie stillschweigend als Id
      // gerendert - die Regel verschwindet nie still mit ihrer Komponente.
      // Ein Chip benennt die Komponente. Ist sie weg, sagt der Chip das mit
      // seinem EIGENEN Wort - die Zustands-Zeile trägt bereits das Urteil, und
      // dieselbe Zeichenkette zweimal untereinander liest sich wie ein Fehler.
      label: found?.label?.trim() ? found.label : 'Entfernte Komponente',
      ton: found ? 'plain' : 'warn',
    });
  }
  return chips;
}

/** Die Chips einer Rezept-Regel: die Komponente + der Erfüllungs-Nachweis. */
export function rezeptChips(input: RezeptRegelInput): RegelChip[] {
  const chips: RegelChip[] = [
    { key: input.consumer.id, label: input.consumer.name, ton: 'plain' },
  ];
  const summary = fulfilmentSummary(input.fulfilment);
  if (summary.headline) {
    // Grün heisst ERFÜLLT. Eine laufende Aufgabe ist weder gut noch schlecht -
    // sie bekommt den ruhigen Chip, nicht den grünen.
    const alleErfuellt = summary.total > 0 && summary.fulfilled === summary.total;
    chips.push({
      key: `${input.consumer.id}:nachweis`,
      label: `Heute: ${summary.headline}`,
      ton: summary.missed > 0 || summary.atRisk > 0 ? 'warn' : (alleErfuellt ? 'ok' : 'plain'),
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// Karten
// ---------------------------------------------------------------------------

/**
 * Ob eine Regel den SPEICHER beansprucht (dann trägt sie den Vorrang-Hinweis).
 * Exportiert, seit die Jetzt-Zone (Steuerung Stufe 1) dieselbe Frage stellt:
 * „nennt diese Zeile den Fahrplan oder Ihre Regel als Quelle?" — sie darf sie
 * nicht ein zweites Mal beantworten.
 */
export function beanspruchtSpeicher(doc: FlowDocument | null, entities: EditorEntity[]): boolean {
  if (!doc) return false;
  return deriveClaims(doc).some((claim) => {
    const e = entities.find((x) => x.id === claim.entityId);
    return e?.entityType === 'battery-hybrid' || (e?.measure ?? []).includes('soc_pct');
  });
}

/** Eine Karte je Flow-Regel. */
export function flowKarte(input: FlowRegelInput, entities: EditorEntity[]): RegelKarte {
  const { satz, ersatz, rule } = flowSatz(input.latestDocument, entities);
  const active = input.activeVersion != null;
  const chips = flowChips(input.latestDocument, entities);
  const fehlend = chips.find((c) => c.ton === 'warn');
  const zustand = flowZustand(input);
  if (fehlend) {
    // Eine Regel, deren Komponente entfernt wurde, bleibt SICHTBAR und rot.
    zustand.problem = 'Komponente wurde entfernt';
    zustand.ton = 'error';
    zustand.rang = RANK_FEHLER;
    zustand.zeile = compose([zustand.lebenszyklus, zustand.problem]);
  }
  return {
    key: `flow:${input.flowId}`,
    art: rule ? 'baukasten' : 'editor',
    id: input.flowId,
    name: input.name,
    satz,
    ersatz,
    zustand,
    chips,
    // Der Vorrang-Einzeiler (§3.6 Variante 3) steht an JEDER Regel, die
    // wirklich etwas beansprucht - nach der beanspruchten Sache getrennt, weil
    // „Ihre Regel geht vor" auf dem Speicher heute nicht gilt (siehe
    // `VORRANG_ZEILE`). Eine Regel ohne Anspruch (nur Benachrichtigung) sagt
    // dazu nichts: sie kann den Fahrplan gar nicht bremsen.
    hinweis: chips.length === 0
      ? null
      : VORRANG_ZEILE[beanspruchtSpeicher(input.latestDocument, entities) ? 'speicher' : 'geraet'],
    aktivitaet: null,
    nachteil: null,
    an: active,
    version: active ? input.activeVersion : input.latestVersion,
  };
}

/** Eine Karte je Rezept-Regel (Verbraucher mit gespeicherter Regel). */
export function rezeptKarte(input: RezeptRegelInput, now: Date = new Date()): RegelKarte {
  const c = input.consumer;
  return {
    key: `rezept:${c.id}`,
    art: 'rezept',
    id: c.id,
    name: c.name,
    satz: input.satz ?? null,
    ersatz: `Regel für ${c.name}`,
    zustand: rezeptZustand(input, now),
    chips: rezeptChips(input),
    // Eine Verbraucher-Regel schaltet immer ihr Gerät - der Einzeiler gilt.
    hinweis: VORRANG_ZEILE.geraet,
    aktivitaet: null,
    // Eine Verbraucher-Regel hält den Speicher nicht - sie kann dem Fahrplan
    // dort also nichts entziehen, und ein Beleg wäre eine erfundene Aussage.
    nachteil: null,
    an: c.controlActivation === 'active',
    version: null,
  };
}

/**
 * Die Regel-Liste, Aufmerksamkeit zuerst. Innerhalb desselben Rangs entscheidet
 * seit Stufe 5b der ZULETZT geschaltete zuerst — jetzt gibt es dafür einen
 * Beleg; ohne ihn bleibt es alphabetisch (eine erfundene Reihenfolge wäre eine
 * erfundene Aussage).
 */
export function regelKarten(input: RegelKartenInput): RegelKarte[] {
  const now = input.now ?? new Date();
  const aktivitaeten = new Map(
    (input.protokoll?.rules ?? [])
      .map((r) => [karteSchluessel(r.ruleKind, r.ruleRef), r] as const)
      .filter((paar): paar is [string, typeof paar[1]] => paar[0] != null),
  );
  const zeit = (k: RegelKarte) => {
    const at = aktivitaeten.get(k.key)?.lastSwitchedAt;
    const t = at ? new Date(at).getTime() : NaN;
    return Number.isNaN(t) ? null : t;
  };
  const karten = [
    ...input.flows.map((f) => flowKarte(f, input.entities)),
    ...input.rezepte.map((r) => rezeptKarte(r, now)),
  ].map((k) => ({
    ...k,
    aktivitaet: aktivitaetZeile(
      aktivitaeten.get(k.key), input.protokoll?.recordingSince,
      input.protokoll?.countsToday ?? false,
    ),
    // Nur eine AKTIVE Regel kann dem Fahrplan gerade etwas entziehen; eine
    // pausierte trägt ihren alten Beleg nicht weiter (er wäre eine Aussage
    // über eine Gegenwart, die es nicht mehr gibt).
    nachteil: k.an ? (input.nachteile?.[k.key] ?? null) : null,
  }));
  return karten.sort((a, b) => {
    if (a.zustand.rang !== b.zustand.rang) return a.zustand.rang - b.zustand.rang;
    // Zuletzt geschaltet zuerst - aber nur zwischen zwei Karten, die BEIDE
    // einen Beleg tragen; sonst würde eine belegte Karte eine unbelegte
    // überholen, ohne dass etwas darüber bekannt wäre.
    const ta = zeit(a);
    const tb = zeit(b);
    if (ta != null && tb != null && ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name, 'de');
  });
}

/**
 * Die aus einer Verbraucherregel GENERIERTE Automation erscheint NICHT als
 * eigene Karte — sie ist die Rezept-Karte ihres Verbrauchers (5b.2). Der
 * Origin-Stempel ist server-gesetzt und damit eindeutig, nie geraten.
 */
export function istGenerierteVerbraucherregel(doc: FlowDocument | null | undefined): boolean {
  return doc?.origin?.kind === 'consumer-policy';
}

/** Die ruhige Zeile über der Liste, wenn eine Sofortaktion läuft. */
export function sofortBanner(
  overrides: ManualOverride[] | null | undefined,
  namen: Record<string, string>,
  now: Date = new Date(),
): { text: string; hinweis: string } | null {
  for (const o of overrides ?? []) {
    const line = overrideLine(o, now);
    if (!line) continue;
    const name = namen[o.entityId] ?? 'Ihr Gerät';
    return {
      text: `Sofortaktion aktiv: „${name}" — ${line.text}`,
      hinweis: 'Sie endet von selbst zur gewählten Zeit — die Regel dieses Geräts wartet solange.',
    };
  }
  return null;
}
