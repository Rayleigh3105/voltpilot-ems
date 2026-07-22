/**
 * M0 — das Modus-Mengen-Read-Model ("Projektion", OpenProject #528, Epic #527).
 *
 * Die Anlagen-Seite ist eine PROJEKTION der Anlage:
 *
 *     surface(anlage) = base(entities) ∪ ⋃ { module(m) | m ∈ activeModes(anlage) }
 *
 * Das ersetzt das AE7-Einzelprofil: `usageProfile.ts` sammelt heute exakt
 * dieselben Signale und reduziert sie dann per argmax auf EINEN Gewinner
 * (`deriveDefault`, peak > arbitrage > private), den ein fester Emphasis-Raster
 * (`emphasisFor`) zu EINEM Gesicht macht. Eine Gewerbe-Anlage, die
 * Lastspitzenkappung UND Eigenverbrauch fährt, bekommt dadurch nur das
 * Peak-Gesicht. **Die Signale bleiben, der argmax fällt weg** — hier wird die
 * MENGE der aktiven Modi abgeleitet, und jeder Modus bringt sein eigenes
 * Surface-Manifest mit (Cockpit-Block, Geld-Strom, Steuerungs-Karte, Deep-Views).
 *
 * Reines Daten-/Logikmodul (der `adaptiveLive.ts`/`moneyEmphasis.ts`-Präzedenzfall):
 * keine React-Imports, kein Netzwerk, kein Backend — komponiert ausschließlich aus
 * bereits ausgelieferten Endpunkten (AE7-Signale `GET /sites/{id}/profile`, die
 * Flow-Liste, `SiteDto`-Stammdaten inkl. Optimizer-Echo, die v2-Entitäten).
 * Deterministisch: kanonische Reihenfolge, kein tägliches Neu-Sortieren.
 *
 * Spec: `data/vp-anlagen-face-k9/report.md` §1.1 (Projektionsregel), §1.2
 * (Aktivierungstabelle), §1.3 (Blockreihenfolge), §3 (die fünf Ausprägungen),
 * §7 (M0) + `feedback.md` (die zwei Captain-Präzisierungen, siehe unten).
 *
 * Zwei Captain-Präzisierungen sind hier Gesetz (feedback.md, 2026-07-21):
 *  1. **Telemetrie-Historie ist `base(entities)`**, kein Modus-Manifest — jede
 *     Anlage erzeugt Telemetrie, also ist die Historie der ANGELEGTEN
 *     Telemetriekanäle (inkl. frei gemappter Modbus-Kanäle aus MB-M1) in JEDEM
 *     Modus verfügbar. Die **Erlös-Historie** bleibt am Geld-Modus.
 *  2. **Marktpreise & Prognosequalität gehören zu `module(marktvermarktung)`**,
 *     nicht in eine globale Sidebar-Gruppe — sie erscheinen nur, wenn der
 *     Markt-Modus aktiv ist.
 *
 * NICHTS rendert bisher hieraus — M1–M4 konsumieren dieses Read-Model.
 */

import type { PlantKind, TarifArt } from './api';
import { catalogType, type FlowDocument } from './flows/model';
import { hasStrategyNode } from './flows/steuerung';
import {
  EINRICHTUNG_DURCH_VOLTPILOT,
  isLeistungspreisActive,
  marktoptimierungLine,
} from './moduleSurface';
import {
  NODE_ATYPICAL_GRID,
  NODE_MARKET,
  NODE_PEAKSHAVING,
  NODE_SELFCONSUMPTION,
} from './usageProfile';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die Modus-Arten der Projektion (report §1.2). */
export type ModeKind =
  | 'eigenverbrauch'
  | 'marktvermarktung'
  | 'lastspitzenkappung'
  | 'atypische-netznutzung'
  | 'automation';

/**
 * Woher ein Modus kommt — die Ehrlichkeitsregel (report §1.2): ein nur über
 * STAMMDATEN aktiver Modus (Leistungspreis gesetzt, kein Flow) darf keine
 * "Flow öffnen"-Affordanz zeigen, sondern sagt "Von VoltPilot eingerichtet".
 */
export type ModeOrigin = 'masterdata' | 'flow';

/** Welches konkrete Signal den Modus aktiviert hat (nachvollziehbar + testbar). */
export type ModeSignal =
  | 'storage-and-pv'
  | 'plant-kind-direktvermarktung'
  | 'netzladen-and-dynamic-tariff'
  | 'leistungspreis'
  | 'strategy-node'
  | 'active-flow';

/** Cockpit-Blöcke in deterministischer Reihenfolge (report §1.3). */
export type CockpitBlockId =
  | 'status'
  | 'peak-band'
  | 'erloes-komposition'
  | 'energiefluss'
  | 'handel'
  | 'eigenverbrauch'
  | 'geraete-automatik'
  | 'toolbox-pointer';

/** Tiefen-Ansichten, die base bzw. ein Modus beisteuert. */
export type DeepViewId =
  | 'live'
  | 'geraete'
  | 'telemetrie-historie'
  | 'wetter'
  | 'erloes-historie'
  | 'fahrplan'
  | 'marktpreise'
  | 'prognosequalitaet'
  | 'lastspitzen'
  | 'flow-editor';

/** Ein Geld-Strom der Erlös-Komposition (report §1.4 — kein neuer Rechenkern). */
export type MoneyStreamId =
  | 'eigenverbrauchswert'
  | 'einspeisung'
  | 'handel'
  | 'lastspitzen'
  | 'automation';

/**
 * Der Zeitraum eines Geld-Stroms. Load-bearing (report §1.4): vermiedene
 * Leistungskosten sind ein Abrechnungsperioden-Standwert, EV/Markt sind
 * Tages-/Monatswerte — die Zeile MUSS ihre Periode nennen, quer summiert wird
 * nie stillschweigend.
 */
export type StreamPeriod = 'range' | 'billing-period';

// ---------------------------------------------------------------------------
// Eingabe — komponiert aus bestehenden Endpunkten
// ---------------------------------------------------------------------------

/**
 * Die AE7-Signale, wie sie `GET /api/v1/sites/{id}/profile` liefert
 * (`SiteUsageProfile.signals`) — strukturell kompatibel, damit die Antwort
 * direkt durchgereicht werden kann.
 */
export interface SurfaceSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer?: boolean;
  /** Strategie-Knotentypen der AKTIVEN Flows (Server-Wahrheit). */
  activeStrategyNodeTypes: string[];
  plantKind?: string | null;
  hasLeistungspreis?: boolean;
}

/** Die Geld-/Vertrags-Stammdaten der Anlage (`SiteDto`-Echo). */
export interface SurfaceSiteConfig {
  plantKind?: PlantKind | string | null;
  tarifArt?: TarifArt | string | null;
  netzladenErlaubt?: boolean | null;
  /** Optimizer-Echo; absent/null/0 = keine Lastspitzenkappung. */
  leistungspreisEurKw?: number | null;
}

/**
 * Eine Flow-Zeile der Flow-Liste — strukturell von `FlowSummary` erfüllt
 * (`flows/flowsApi.ts`), damit `api.flows(siteId)` direkt hineinreicht.
 */
export interface SurfaceFlow {
  flowId: string;
  name: string;
  /** Nicht-null = dieser Flow hat eine aktive Version. */
  activeVersion: number | null;
  latestLifecycle: string;
  latestDocument: FlowDocument;
}

/**
 * Eine v2-Entität — strukturell von `SiteEntity` erfüllt (`api.ts`). Nur die
 * Felder, die die Projektion braucht.
 */
export interface SurfaceEntity {
  id: string;
  entityType: string;
  label?: string | null;
  capabilities?: {
    measure?: { channel: string }[];
    actuate?: { command: string }[];
  } | null;
}

/** Alles, woraus die Projektion einer Anlage abgeleitet wird. */
export interface AnlageSurfaceInput {
  /** AE7-Signale; null = noch nicht geladen / älteres Backend (fail-soft). */
  signals?: SurfaceSignals | null;
  /** Stammdaten der Anlage; null = noch nicht geladen. */
  config?: SurfaceSiteConfig | null;
  /** Die Flows der Anlage (nur aktive zählen); leer = keine. */
  flows?: SurfaceFlow[] | null;
  /** Die v2-Entitäten der Anlage; leer = "Neu / leer". */
  entities?: SurfaceEntity[] | null;
}

// ---------------------------------------------------------------------------
// Manifest-Typen
// ---------------------------------------------------------------------------

export interface CockpitBlock {
  id: CockpitBlockId;
  title: string;
  /** Deterministischer Rang (report §1.3) — kein tägliches Neu-Sortieren. */
  order: number;
  /** Der Modus, der den Block beisteuert ("von"-Tag); null = base. */
  from: string | null;
}

export interface MoneyStream {
  id: MoneyStreamId;
  label: string;
  /**
   * Die `EarningsSite`-Felder, aus denen die Zeile liest — die Ströme
   * RE-PLATZIEREN bestehende Zahlen, sie rechnen nichts neu.
   */
  sources: string[];
  period: StreamPeriod;
  /**
   * true = für diesen Strom existiert KEINE Zuordnung (Automationen, E15 nicht
   * gebaut) — die Zeile zeigt "—", niemals eine erfundene Zahl.
   */
  unattributed: boolean;
  note: string | null;
  /**
   * `'steering'` = unter dieser Zeile steht die **Zurechnung** dessen, was
   * VoltPilots Steuerung beigetragen hat ("davon +X € durch VoltPilots
   * Steuerung"). Load-bearing (MIG §5): `savedEur` ist ein **Delta gegenüber
   * einer ungeregelten Anlage** und steckt bereits IM Einspeise-Erlös — als
   * eigene Summanden-Zeile wäre es doppelt gezählt. Deshalb: Attribution
   * UNTER dem Erlös, nie daneben.
   */
  attribution?: 'steering' | null;
}

export interface SteuerungCard {
  title: string;
  /** EINE deutsche Ergebnis-Zeile. */
  line: string;
  subLine: string | null;
  /** true = von VoltPilot eingerichtet (Stammdaten-Modus, kein Flow dahinter). */
  managed: boolean;
  /** 'open-flow' nur, wenn ein Flow WIRKLICH existiert (report §1.2). */
  action: 'open-flow' | 'none';
  /** true = Ökonomie noch nicht gebaut → Karte only, "in Vorbereitung". */
  preview: boolean;
}

/** Was ein Modus zur Oberfläche beiträgt (report §1.1). */
export interface ModeManifest {
  /** null = kein Cockpit-Block (reiner Karten-Modus, z. B. atypische Netznutzung). */
  cockpitBlock: CockpitBlock | null;
  /** Mehrzahl: Eigenverbrauch trägt EV-Wert UND Einspeisung bei (report §1.4). */
  moneyStreams: MoneyStream[];
  steuerungCard: SteuerungCard;
  deepViews: DeepViewId[];
}

export interface ActiveMode {
  /** Stabiler Schlüssel: `automation:{flowId}` bzw. die Modus-Art. */
  key: string;
  kind: ModeKind;
  label: string;
  origin: ModeOrigin;
  /** Der Flow dahinter (origin 'flow' und auflösbar), sonst null. */
  flowRef: { flowId: string; name: string } | null;
  /** Die auslösenden Signale — kanonisch sortiert. */
  signals: ModeSignal[];
  /** Ökonomie nicht gebaut (E5b) → nur Karte, "in Vorbereitung". */
  preview: boolean;
  manifest: ModeManifest;
}

/** Was `base(entities)` beisteuert — unabhängig von jedem Modus. */
export interface BaseSurface {
  /** false = "Neu / leer": keine Objekte, KEINE Platzhalter-Karten. */
  hasEntities: boolean;
  blocks: CockpitBlock[];
  deepViews: DeepViewId[];
  /** Alle angelegten Telemetriekanäle (inkl. frei gemappter Modbus-Kanäle). */
  telemetryChannels: string[];
}

/** Die vollständige Projektion einer Anlage. */
export interface AnlageSurface {
  base: BaseSurface;
  modes: ActiveMode[];
  /** base ∪ Modus-Blöcke, deterministisch sortiert (report §1.3). */
  cockpitBlocks: CockpitBlock[];
  /** Die Erlös-Komposition (alle Ströme, in Modus-Reihenfolge). */
  moneyStreams: MoneyStream[];
  /** base ∪ Modus-Deep-Views, kanonisch sortiert, dedupliziert. */
  deepViews: DeepViewId[];
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

export const MODE_LABELS: Record<Exclude<ModeKind, 'automation'>, string> = {
  lastspitzenkappung: 'Lastspitzenkappung',
  'atypische-netznutzung': 'Atypische Netznutzung',
  marktvermarktung: 'Marktvermarktung',
  eigenverbrauch: 'Eigenverbrauch',
};

/** Kanonische Modus-Reihenfolge (F2: kanonisch, nicht €-gewichtet — kein Flackern). */
const MODE_RANK: Record<ModeKind, number> = {
  lastspitzenkappung: 10,
  'atypische-netznutzung': 20,
  marktvermarktung: 30,
  eigenverbrauch: 40,
  automation: 50,
};

/** Deterministischer Rang der Cockpit-Blöcke (report §1.3). */
const BLOCK_ORDER: Record<CockpitBlockId, number> = {
  status: 0,
  'peak-band': 10,
  'erloes-komposition': 20,
  energiefluss: 30,
  handel: 40,
  eigenverbrauch: 50,
  'geraete-automatik': 60,
  'toolbox-pointer': 99,
};

const DEEP_VIEW_ORDER: DeepViewId[] = [
  'live',
  'geraete',
  'telemetrie-historie',
  'lastspitzen',
  'fahrplan',
  'erloes-historie',
  'marktpreise',
  'prognosequalitaet',
  'flow-editor',
  'wetter',
];

const SIGNAL_ORDER: ModeSignal[] = [
  'storage-and-pv',
  'plant-kind-direktvermarktung',
  'netzladen-and-dynamic-tariff',
  'leistungspreis',
  'strategy-node',
  'active-flow',
];

function block(id: CockpitBlockId, title: string, from: string | null): CockpitBlock {
  return { id, title, order: BLOCK_ORDER[id], from };
}

// ---------------------------------------------------------------------------
// base(entities)
// ---------------------------------------------------------------------------

/**
 * Die Telemetriekanäle, die eine Anlage tatsächlich angelegt hat — inklusive
 * frei gemappter Kanäle (MB-M1 `vp.modbus.read` → `modbus-generic`-Entität mit
 * selbst benannten Kanälen). Dedupliziert + sortiert (deterministisch).
 */
export function telemetryChannels(entities: SurfaceEntity[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const e of entities ?? []) {
    for (const m of e.capabilities?.measure ?? []) {
      const channel = typeof m?.channel === 'string' ? m.channel.trim() : '';
      if (channel) seen.add(channel);
    }
  }
  return [...seen].sort();
}

/**
 * `base(entities)` (report §1.1 + feedback.md Punkt 2): Status-Kopf,
 * Energiefluss-Hub, Geräte, **Telemetrie-Historie** und Live — modus-unabhängig,
 * in JEDEM Modus verfügbar. Ohne Entitäten gibt es NICHTS (kein Platzhalter):
 * das ist die Ausprägung "Neu / leer", deren Cockpit der Einrichtungspfad ist.
 */
export function baseSurface(entities: SurfaceEntity[] | null | undefined): BaseSurface {
  const list = entities ?? [];
  const channels = telemetryChannels(list);
  if (list.length === 0) {
    return { hasEntities: false, blocks: [], deepViews: [], telemetryChannels: channels };
  }
  const deepViews: DeepViewId[] = ['live', 'geraete', 'wetter'];
  // Die Historie der ANGELEGTEN Kanäle - nur wenn es Kanäle gibt, sonst wäre
  // sie eine leere Versprechung.
  if (channels.length > 0) deepViews.push('telemetrie-historie');
  return {
    hasEntities: true,
    blocks: [
      block('status', 'Status', null),
      block('energiefluss', 'Energiefluss', null),
      block('toolbox-pointer', 'Modus hinzufügen', null),
    ],
    deepViews: sortDeepViews(deepViews),
    telemetryChannels: channels,
  };
}

// ---------------------------------------------------------------------------
// activeModes(site)
// ---------------------------------------------------------------------------

interface StrategyIndex {
  /** Alle Strategie-Knotentypen aktiver Flows (Signale ∪ Flow-Dokumente). */
  types: Set<string>;
  /** Erster aktiver Flow je Strategie-Typ (für die "Flow öffnen"-Affordanz). */
  flowByType: Map<string, { flowId: string; name: string }>;
  /** Aktive Flows OHNE Strategie-Knoten = Automationen (report §1.2). */
  automations: SurfaceFlow[];
}

/** Ein Flow zählt, sobald er eine aktive Version hat. */
function isActiveFlow(flow: SurfaceFlow): boolean {
  if (flow.activeVersion !== null && flow.activeVersion !== undefined) return true;
  return flow.latestLifecycle === 'active';
}

function strategyTypesOf(doc: FlowDocument): string[] {
  return (doc?.nodes ?? [])
    .filter((n) => catalogType(n.type)?.group === 'strategie')
    .map((n) => n.type);
}

function indexFlows(input: AnlageSurfaceInput): StrategyIndex {
  const types = new Set<string>(input.signals?.activeStrategyNodeTypes ?? []);
  const flowByType = new Map<string, { flowId: string; name: string }>();
  const automations: SurfaceFlow[] = [];
  for (const flow of input.flows ?? []) {
    if (!isActiveFlow(flow)) continue;
    const doc = flow.latestDocument;
    if (doc && hasStrategyNode(doc)) {
      for (const type of strategyTypesOf(doc)) {
        types.add(type);
        if (!flowByType.has(type)) flowByType.set(type, { flowId: flow.flowId, name: flow.name });
      }
    } else {
      automations.push(flow);
    }
  }
  automations.sort((a, b) => a.name.localeCompare(b.name, 'de') || a.flowId.localeCompare(b.flowId));
  return { types, flowByType, automations };
}

function dynamicTariff(config: SurfaceSiteConfig | null | undefined): boolean {
  return config?.tarifArt === 'dynamisch';
}

/**
 * Ist überhaupt ein Stromtarif hinterlegt? Ohne ihn KANN der Eigenverbrauch
 * nicht in Euro bewertet werden (`eigenverbrauchsWertEur` bleibt null), also
 * gibt es die Zeile gar nicht erst — statt einer ewigen "—" (MIG §5).
 */
function hasTariff(tarifArt: TarifArt | undefined): boolean {
  return tarifArt === 'dynamisch' || tarifArt === 'fest';
}

/** Der hinterlegte Tarif der Anlage (normalisiert; unbekannt/leer = 'ohne'). */
function tarifArtOf(config: SurfaceSiteConfig | null | undefined): TarifArt {
  const raw = config?.tarifArt;
  return raw === 'dynamisch' || raw === 'fest' ? raw : 'ohne';
}

function isDirektvermarktung(input: AnlageSurfaceInput): boolean {
  return (
    input.config?.plantKind === 'direktvermarktung' ||
    input.signals?.plantKind === 'direktvermarktung'
  );
}

function hasLeistungspreis(input: AnlageSurfaceInput): boolean {
  return (
    isLeistungspreisActive(input.config?.leistungspreisEurKw) ||
    input.signals?.hasLeistungspreis === true
  );
}

/**
 * Die MENGE der aktiven Modi (report §1.2) — dieselben Signale wie
 * `UsageProfileDeriver`, nur OHNE die argmax-Reduktion.
 *
 * Aktivierungsregeln:
 *  - **Eigenverbrauch**: Speicher ∧ PV vorhanden ∨ `vp.strategy.selfconsumption` aktiv.
 *    Die Stammdaten-Verzweigung ist bei einer reinen **Direktvermarktungs**-Anlage
 *    unterdrückt (report §3: der Solarpark hat Speicher UND PV, zeigt aber nachweislich
 *    KEIN Eigenverbrauchs-Cockpit und keine "Haus"-Sprache — die Kategoriefehler-Regel
 *    aus §3 macht das strukturell unmöglich). Ein EXPLIZITER Eigenverbrauchs-Flow
 *    aktiviert den Modus trotzdem, auch auf einer DV-Anlage.
 *  - **Marktvermarktung**: `plant_kind = direktvermarktung` ∨ `vp.strategy.market` aktiv
 *    ∨ (`netzladen_erlaubt` ∧ dynamischer Tarif) — F4 ist entschieden: ja, Netzladen
 *    auf dynamischem Tarif IST de facto Arbitrage.
 *  - **Lastspitzenkappung**: `leistungspreis_eur_kw` konfiguriert ∨ `vp.strategy.peakshaving` aktiv.
 *  - **Atypische Netznutzung**: `vp.strategy.atypical-grid` aktiv (E5b-Ökonomie nicht
 *    gebaut → nur Karte, "in Vorbereitung").
 *  - **Automation (je Regel)**: jeder aktive Flow ohne Strategie-Knoten.
 */
export function activeModes(site: AnlageSurfaceInput): ActiveMode[] {
  const input = site ?? {};
  const index = indexFlows(input);
  const modes: ActiveMode[] = [];

  // --- Lastspitzenkappung -------------------------------------------------
  {
    const signals: ModeSignal[] = [];
    if (hasLeistungspreis(input)) signals.push('leistungspreis');
    if (index.types.has(NODE_PEAKSHAVING)) signals.push('strategy-node');
    if (signals.length > 0) {
      const flowRef = index.flowByType.get(NODE_PEAKSHAVING) ?? null;
      modes.push(
        makeMode({
          kind: 'lastspitzenkappung',
          key: 'lastspitzenkappung',
          label: MODE_LABELS.lastspitzenkappung,
          signals,
          flowRef,
          leistungspreisEurKw: input.config?.leistungspreisEurKw ?? null,
        }),
      );
    }
  }

  // --- Atypische Netznutzung (Karten-Modus, Ökonomie nicht gebaut) --------
  if (index.types.has(NODE_ATYPICAL_GRID)) {
    modes.push(
      makeMode({
        kind: 'atypische-netznutzung',
        key: 'atypische-netznutzung',
        label: MODE_LABELS['atypische-netznutzung'],
        signals: ['strategy-node'],
        flowRef: index.flowByType.get(NODE_ATYPICAL_GRID) ?? null,
      }),
    );
  }

  // --- Marktvermarktung ---------------------------------------------------
  {
    const signals: ModeSignal[] = [];
    if (isDirektvermarktung(input)) signals.push('plant-kind-direktvermarktung');
    if (input.config?.netzladenErlaubt === true && dynamicTariff(input.config)) {
      signals.push('netzladen-and-dynamic-tariff');
    }
    if (index.types.has(NODE_MARKET)) signals.push('strategy-node');
    if (signals.length > 0) {
      modes.push(
        makeMode({
          kind: 'marktvermarktung',
          key: 'marktvermarktung',
          label: MODE_LABELS.marktvermarktung,
          signals,
          flowRef: index.flowByType.get(NODE_MARKET) ?? null,
          plantKind: isDirektvermarktung(input) ? 'direktvermarktung' : 'eigenverbrauch',
          // Der ECHTE Tarif (nicht nur dynamisch/ohne): der Geld-Stapel hängt
          // daran, ob überhaupt ein Tarif hinterlegt ist (MIG §5).
          tarifArt: tarifArtOf(input.config),
        }),
      );
    }
  }

  // --- Eigenverbrauch -----------------------------------------------------
  {
    const signals: ModeSignal[] = [];
    const storageAndPv = input.signals?.hasStorage === true && input.signals?.hasPv === true;
    if (storageAndPv && !isDirektvermarktung(input)) signals.push('storage-and-pv');
    if (index.types.has(NODE_SELFCONSUMPTION)) signals.push('strategy-node');
    if (signals.length > 0) {
      modes.push(
        makeMode({
          kind: 'eigenverbrauch',
          key: 'eigenverbrauch',
          label: MODE_LABELS.eigenverbrauch,
          signals,
          flowRef: index.flowByType.get(NODE_SELFCONSUMPTION) ?? null,
        }),
      );
    }
  }

  // --- Automationen (je aktivem Flow ohne Strategie-Knoten) ---------------
  for (const flow of index.automations) {
    modes.push(
      makeMode({
        kind: 'automation',
        key: `automation:${flow.flowId}`,
        label: flow.name,
        signals: ['active-flow'],
        flowRef: { flowId: flow.flowId, name: flow.name },
      }),
    );
  }

  return modes.sort(
    (a, b) => MODE_RANK[a.kind] - MODE_RANK[b.kind] || a.key.localeCompare(b.key),
  );
}

// ---------------------------------------------------------------------------
// Manifeste
// ---------------------------------------------------------------------------

interface ModeSeed {
  kind: ModeKind;
  key: string;
  label: string;
  signals: ModeSignal[];
  flowRef: { flowId: string; name: string } | null;
  plantKind?: PlantKind;
  tarifArt?: TarifArt;
  leistungspreisEurKw?: number | null;
}

function makeMode(seed: ModeSeed): ActiveMode {
  const signals = SIGNAL_ORDER.filter((s) => seed.signals.includes(s));
  // Flow-getragen, sobald ein Strategie-Knoten/Flow im Spiel ist; die
  // "Flow öffnen"-Affordanz hängt aber zusätzlich an einem AUFLÖSBAREN Flow -
  // nie einen editierbaren Flow versprechen, den es nicht gibt.
  const origin: ModeOrigin =
    signals.includes('strategy-node') || signals.includes('active-flow') ? 'flow' : 'masterdata';
  const preview = seed.kind === 'atypische-netznutzung';
  const mode: ActiveMode = {
    key: seed.key,
    kind: seed.kind,
    label: seed.label,
    origin,
    flowRef: seed.flowRef,
    signals,
    preview,
    manifest: manifestFor(seed, origin, preview),
  };
  return mode;
}

function manifestFor(seed: ModeSeed, origin: ModeOrigin, preview: boolean): ModeManifest {
  const managed = origin === 'masterdata';
  const action: SteuerungCard['action'] = seed.flowRef && !preview ? 'open-flow' : 'none';
  switch (seed.kind) {
    case 'lastspitzenkappung':
      return {
        cockpitBlock: block('peak-band', 'Lastspitze', seed.label),
        moneyStreams: [
          {
            id: 'lastspitzen',
            label: 'Vermiedene Leistungskosten',
            sources: ['peakShaving.avoidedEur'],
            period: 'billing-period',
            unattributed: false,
            note: 'Stand der laufenden Abrechnungsperiode.',
          },
        ],
        steuerungCard: {
          title: seed.label,
          line: 'Ihre Batterie kappt die Bezugsspitze Ihres Netzanschlusses und senkt damit Ihren Leistungspreis.',
          subLine: managed ? VOLTPILOT_MANAGED : null,
          managed,
          action,
          preview,
        },
        deepViews: ['lastspitzen', 'erloes-historie'],
      };
    case 'atypische-netznutzung':
      return {
        // Karten-Modus: kein Cockpit-Block, kein Geld-Strom - die Ökonomie
        // (E5b) ist nicht gebaut, also wird auch nichts behauptet.
        cockpitBlock: null,
        moneyStreams: [],
        steuerungCard: {
          title: seed.label,
          line: 'Verlagert Verbrauch und Speicher aus den Hochlastzeitfenstern - für ein reduziertes Netzentgelt.',
          subLine: 'In Vorbereitung.',
          managed,
          action: 'none',
          preview,
        },
        deepViews: [],
      };
    case 'marktvermarktung':
      return {
        cockpitBlock: block('handel', 'Handel', seed.label),
        // MIG §5 (Captain entschieden): eine Direktvermarktungs-Anlage weist
        // aus, was sie WIRKLICH verdient hat — Einspeise-Erlös (+ Wert des
        // Eigenverbrauchs, sobald ein Tarif hinterlegt ist). Der Steuerungs-
        // Beitrag (`savedEur`) ist die ZURECHNUNG darunter, kein Geschwister-
        // Summand: gemessen zeigte die alte Ein-Strom-Komposition auf einer
        // realen Anlage 13,62 € statt 301,46 €, weil sie nur das Delta
        // gutschrieb. Reihenfolge = die Reihenfolge des Geld-Stapels.
        moneyStreams: [
          {
            id: 'einspeisung',
            label: 'Einspeise-Erlös',
            sources: ['einspeiseErloesEur'],
            period: 'range',
            unattributed: false,
            note: null,
            attribution: 'steering',
          },
          ...(hasTariff(seed.tarifArt)
            ? [
                {
                  id: 'eigenverbrauchswert' as const,
                  label: 'Wert des Eigenverbrauchs',
                  sources: ['eigenverbrauchsWertEur'],
                  period: 'range' as const,
                  unattributed: false,
                  note: null,
                },
              ]
            : []),
        ],
        steuerungCard: {
          title: seed.label,
          line: marktoptimierungLine(seed.plantKind ?? 'eigenverbrauch', seed.tarifArt ?? 'ohne'),
          subLine: managed ? VOLTPILOT_MANAGED : null,
          managed,
          action,
          preview,
        },
        // feedback.md Punkt 1: Marktpreise + Prognosequalität sind KEINE
        // globalen Seiten - sie hängen am Markt-Modus.
        deepViews: ['fahrplan', 'marktpreise', 'prognosequalitaet', 'erloes-historie'],
      };
    case 'eigenverbrauch':
      return {
        cockpitBlock: block('eigenverbrauch', 'Eigenverbrauch', seed.label),
        moneyStreams: [
          {
            id: 'eigenverbrauchswert',
            label: 'Wert des Eigenverbrauchs',
            sources: ['eigenverbrauchsWertEur'],
            period: 'range',
            unattributed: false,
            note: null,
          },
          {
            id: 'einspeisung',
            label: 'Einspeise-Erlös',
            sources: ['einspeiseErloesEur'],
            period: 'range',
            unattributed: false,
            note: null,
          },
        ],
        steuerungCard: {
          title: seed.label,
          line: 'Ihr Speicher verschiebt Ihren Solarstrom dorthin, wo er am meisten wert ist: tagsüber laden, abends nutzen.',
          subLine: managed ? VOLTPILOT_MANAGED : null,
          managed,
          action,
          preview,
        },
        deepViews: ['erloes-historie'],
      };
    case 'automation':
    default:
      return {
        cockpitBlock: block('geraete-automatik', 'Geräte-Automatik', seed.label),
        moneyStreams: [
          {
            id: 'automation',
            label: seed.label,
            sources: [],
            period: 'range',
            // Keine Zuordnung je Regel (E15 nicht gebaut) - die Zeile zeigt "—".
            unattributed: true,
            note: null,
          },
        ],
        steuerungCard: {
          title: seed.label,
          line: 'Ihre eigene Wenn/Dann-Regel läuft auf dem Gerät.',
          subLine: null,
          managed: false,
          action: seed.flowRef ? 'open-flow' : 'none',
          preview: false,
        },
        deepViews: ['flow-editor'],
      };
  }
}

/**
 * Die Ehrlichkeits-Zeile eines reinen Stammdaten-Modus (report §1.2) - REUSE der
 * bestehenden Formulierung aus `moduleSurface.ts`, damit die Oberfläche EINE
 * Sprache spricht.
 */
export const VOLTPILOT_MANAGED = 'Von VoltPilot eingerichtet.';

/** Der Kontakt-Hinweis für einen noch nicht eingerichteten Modus (REUSE). */
export const VOLTPILOT_SETUP_HINT = EINRICHTUNG_DURCH_VOLTPILOT;

// ---------------------------------------------------------------------------
// Komposition
// ---------------------------------------------------------------------------

function sortDeepViews(views: DeepViewId[]): DeepViewId[] {
  const seen = new Set(views);
  return DEEP_VIEW_ORDER.filter((v) => seen.has(v));
}

/**
 * Alle Geld-Ströme der aktiven Modi, in Modus-Reihenfolge (report §1.4) —
 * **dedupliziert je Strom-Id**, erste Nennung gewinnt. Seit MIG §5 nennen
 * Marktvermarktung UND Eigenverbrauch dieselben Erlös-Ströme; eine Anlage, auf
 * der beide Modi aktiv sind (DV-Anlage mit explizitem Eigenverbrauchs-Flow),
 * würde denselben Euro sonst zweimal zeigen UND zweimal summieren.
 */
export function moneyStreams(modes: ActiveMode[]): MoneyStream[] {
  const seen = new Set<MoneyStreamId>();
  const streams: MoneyStream[] = [];
  for (const stream of modes.flatMap((m) => m.manifest.moneyStreams)) {
    // Unzugeordnete Ströme (je Automation einer) tragen ALLE die Id
    // 'automation' und sind KEINE Dubletten - sie zeigen ohnehin "—".
    if (!stream.unattributed) {
      if (seen.has(stream.id)) continue;
      seen.add(stream.id);
    }
    streams.push(stream);
  }
  return streams;
}

/**
 * Die Cockpit-Blöcke: base ∪ Modus-Blöcke, deterministisch nach §1.3 sortiert.
 * Die **Erlös-Komposition** kommt hinzu, sobald mindestens EIN Geld-Strom
 * existiert (sie ist die Komposition, kein Modus-Block).
 */
export function cockpitBlocks(base: BaseSurface, modes: ActiveMode[]): CockpitBlock[] {
  if (!base.hasEntities) return [];
  const blocks = new Map<CockpitBlockId, CockpitBlock>();
  for (const b of base.blocks) blocks.set(b.id, b);
  for (const mode of modes) {
    const b = mode.manifest.cockpitBlock;
    if (!b) continue;
    const existing = blocks.get(b.id);
    // Mehrere Modi auf EINEM Block (z. B. mehrere Automationen unter
    // "Geräte-Automatik"): der Block erscheint einmal und trägt dann keinen
    // einzelnen "von"-Tag mehr.
    blocks.set(b.id, existing ? { ...existing, from: null } : b);
  }
  const streams = moneyStreams(modes).filter((s) => !s.unattributed);
  if (streams.length > 0) {
    const erloes = block('erloes-komposition', 'Erlös-Komposition', null);
    blocks.set(erloes.id, erloes);
  }
  return [...blocks.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** base ∪ Modus-Deep-Views, kanonisch sortiert und dedupliziert. */
export function deepViews(base: BaseSurface, modes: ActiveMode[]): DeepViewId[] {
  return sortDeepViews([...base.deepViews, ...modes.flatMap((m) => m.manifest.deepViews)]);
}

/** Die vollständige Projektion — `surface = base(entities) ∪ ⋃ module(m)`. */
export function anlageSurface(site: AnlageSurfaceInput): AnlageSurface {
  const base = baseSurface(site?.entities);
  const modes = activeModes(site);
  return {
    base,
    modes,
    cockpitBlocks: cockpitBlocks(base, modes),
    moneyStreams: moneyStreams(modes),
    deepViews: deepViews(base, modes),
  };
}

/** Ist dieser Modus aktiv? (Bequemlichkeit für die späteren Renderer.) */
export function hasMode(modes: ActiveMode[], kind: ModeKind): boolean {
  return modes.some((m) => m.kind === kind);
}
