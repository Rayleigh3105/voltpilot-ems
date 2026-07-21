/**
 * M2 — die Steuerung als Fläche der aktiven Modi ("Projektion", OpenProject
 * #530, Epic #527; Spec `data/vp-anlagen-face-k9/report.md` §2.3 + §1.2).
 *
 * Die Steuerung besteht aus VIER Teilen, und dieses Modul leitet sie rein ab
 * (keine React-Imports, kein Netzwerk — der `surface.ts`/`fleet.ts`-Präzedenzfall):
 *
 *  1. **Aktive Modi** — je aktivem Modus eine Karte: Zustand, Ergebnis-Satz,
 *     **sein Beitrag** (echte Zahlen) und **Geräte-Chips** (welche Geräte der
 *     Modus beansprucht) + Aktionen (Details, Pausieren).
 *  2. **Ko-Optimierungs-Streifen** — ab ZWEI speicher-beanspruchenden Modi:
 *     "N Modi, ein Speicher" + der **SoC-Reservierungs-Stack**.
 *  3. **Automationen** — die U3-Mechanik unverändert (nur Rahmung).
 *  4. **＋ Modus hinzufügen** — die Werkzeugkiste: JEDER Modus für JEDEN Kunden,
 *     mit ehrlichen Voraussetzungs-Chips und dem bestehenden Gate.
 *
 * Zwei Regeln sind hier Gesetz:
 *  - **Nur AKTIVES steht in Teil 1.** Das Vermischen von aktiv + Angebot
 *    (`flowModules.ts offeredWhenInactive`) endet — Angebote leben
 *    ausschließlich in der Werkzeugkiste (Teil 4).
 *  - **Stammdaten-Ehrlichkeit** (report §1.2): ein nur über Stammdaten aktiver
 *    Modus sagt "Von VoltPilot eingerichtet" und bekommt KEINE
 *    "Flow öffnen"-Affordanz — nie einen editierbaren Flow versprechen, den es
 *    nicht gibt. Genauso wird nie eine Zahl erfunden: fehlt die Zuordnung,
 *    steht dort "—".
 */

import type { EarningsSite, EntityStrategy } from './api';
import { eurAmount, fmtNum } from './format';
import type { EditorEntity } from './flows/model';
import { controllableConsumers, gridMeterEntity } from './flows/customerTemplates';
import {
  EINRICHTUNG_DURCH_VOLTPILOT,
  lastspitzenkappungCard,
  marktoptimierungLine,
} from './moduleSurface';
import {
  MODE_LABELS,
  VOLTPILOT_MANAGED,
  type ActiveMode,
  type ModeKind,
  type MoneyStreamId,
  type StreamPeriod,
} from './surface';
import {
  NODE_ATYPICAL_GRID,
  NODE_MARKET,
  NODE_PEAKSHAVING,
  NODE_SELFCONSUMPTION,
} from './usageProfile';

// ---------------------------------------------------------------------------
// 1 · Der Beitrag eines Modus (echte Zahlen, sonst "—")
// ---------------------------------------------------------------------------

/**
 * Aus WELCHEM Feld der Erlös-Antwort ein Geld-Strom seinen Wert liest. Labels,
 * Reihenfolge und Periode kommen aus dem M0-Manifest (`surface.ts`), damit
 * Steuerung und Erlös-Komposition (M4) dieselbe Sprache sprechen; hier steht
 * nur die Auflösung auf ein konkretes Feld. `null` = es GIBT keine Zuordnung
 * (Automationen, E15 nicht gebaut) — die Zeile zeigt "—".
 */
const STREAM_FIELD: Record<MoneyStreamId, ((e: EarningsSite) => number | null) | null> = {
  eigenverbrauchswert: (e) => e.eigenverbrauchsWertEur,
  einspeisung: (e) => e.einspeiseErloesEur,
  handel: (e) => e.savedEur,
  lastspitzen: (e) => e.peakShaving?.avoidedEur ?? null,
  automation: null,
};

export interface ContributionRow {
  id: MoneyStreamId;
  label: string;
  /** Formatierter Betrag; null = keine Zahl (zeigt "—"). */
  value: string | null;
  period: StreamPeriod;
  /** Kurzer Zusatz (Periode/Kleingedrucktes); null = keiner. */
  note: string | null;
}

/** Periodenlabel — quer über Perioden wird NIE stillschweigend summiert (§1.4). */
export function periodLabel(period: StreamPeriod): string {
  return period === 'billing-period' ? 'laufende Abrechnungsperiode' : 'im gewählten Zeitraum';
}

/**
 * Der Beitrag eines Modus — eine Zeile je Geld-Strom seines M0-Manifests.
 * Fehlt die Erlös-Antwort oder das Feld, steht dort ehrlich "—", nie eine 0.
 */
export function contributionRows(
  mode: ActiveMode,
  earnings: EarningsSite | null | undefined,
): ContributionRow[] {
  return mode.manifest.moneyStreams.map((stream) => {
    const read = stream.unattributed ? null : STREAM_FIELD[stream.id];
    const raw = read && earnings ? read(earnings) : null;
    return {
      id: stream.id,
      label: stream.label,
      value: raw == null ? null : eurAmount(raw),
      period: stream.period,
      note: stream.unattributed
        ? 'Pro Regel noch nicht zugeordnet.'
        : periodLabel(stream.period),
    };
  });
}

/**
 * Der zusätzliche Nachweis-Satz eines Lastspitzen-Modus ("X kW vermieden").
 * Null, solange in der laufenden Periode nichts gemessen ist.
 */
export function peakContributionNote(earnings: EarningsSite | null | undefined): string | null {
  const peak = earnings?.peakShaving;
  if (!peak || peak.avoidedKw == null) return null;
  return `Vermiedene Spitze: ${fmtNum(peak.avoidedKw, 'kW')}`;
}

// ---------------------------------------------------------------------------
// 1 · Geräte-Chips (welche Geräte der Modus beansprucht)
// ---------------------------------------------------------------------------

export interface EntityChip {
  id: string;
  label: string;
}

/** Speicher-Entitäten der Anlage (die Einheit, die jede Batterie-Strategie steuert). */
export function storageEntities(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter((e) => e.entityType === 'battery-hybrid');
}

/**
 * Die Geräte, die dieser Modus beansprucht:
 *  - Flow-getragen → die **echten Claims** aus `api.entityStrategies` (welcher
 *    aktive Flow welche Entität anfasst) — kein Raten.
 *  - Stammdaten-getragen (kein Flow) → die Speicher-Einheit, die die
 *    VoltPilot-Ko-Optimierung fährt; ein Modus ohne Speicherbezug bekommt
 *    KEINE Chips (lieber nichts als eine Behauptung).
 */
export function entityChips(
  mode: ActiveMode,
  strategies: Record<string, EntityStrategy[]> | null | undefined,
  entities: EditorEntity[],
): EntityChip[] {
  const byId = new Map(entities.map((e) => [e.id, e] as const));
  const flowId = mode.flowRef?.flowId ?? null;
  if (flowId && strategies) {
    const chips: EntityChip[] = [];
    for (const [entityId, rows] of Object.entries(strategies)) {
      if (!(rows ?? []).some((r) => r.flowId === flowId)) continue;
      chips.push({ id: entityId, label: byId.get(entityId)?.label ?? entityId });
    }
    return chips.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }
  if (!flowId && isBatteryMode(mode.kind)) {
    return storageEntities(entities).map((e) => ({ id: e.id, label: e.label }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// 1 · Aktionen einer Modus-Karte
// ---------------------------------------------------------------------------

export interface ModeActions {
  /** "Details/Öffnen" — nur mit WIRKLICH auflösbarem Flow (report §1.2). */
  canOpen: boolean;
  /** "Pausieren" = den Flow stilllegen; nie bei Stammdaten-Modi. */
  canPause: boolean;
  /** Die Ehrlichkeits-Zeile eines Stammdaten-Modus; null sonst. */
  managedNote: string | null;
}

export function modeActions(mode: ActiveMode): ModeActions {
  const open = mode.manifest.steuerungCard.action === 'open-flow' && mode.flowRef != null;
  return {
    canOpen: open,
    canPause: open,
    managedNote: mode.manifest.steuerungCard.managed ? VOLTPILOT_MANAGED : null,
  };
}

// ---------------------------------------------------------------------------
// 2 · Ko-Optimierungs-Streifen
// ---------------------------------------------------------------------------

/** Welche Modi um DENSELBEN Speicher konkurrieren (und deshalb ko-optimiert werden). */
const BATTERY_MODE_KINDS: ModeKind[] = [
  'lastspitzenkappung',
  'marktvermarktung',
  'eigenverbrauch',
];

export function isBatteryMode(kind: ModeKind): boolean {
  return BATTERY_MODE_KINDS.includes(kind);
}

/**
 * Die speicher-beanspruchenden Modi. "In Vorbereitung"-Modi zählen NICHT mit —
 * was noch nicht rechnet, kann auch nicht mit-optimiert werden.
 */
export function batteryModes(modes: ActiveMode[]): ActiveMode[] {
  return modes.filter((m) => !m.preview && isBatteryMode(m.kind));
}

export interface CoOptimization {
  count: number;
  modeLabels: string[];
  /** "3 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam." */
  sentence: string;
  /** Wie die Auflösung passiert (der ehrliche Zusatz). */
  detail: string;
}

/** Null unter zwei Speicher-Modi — dann gibt es nichts zu ko-optimieren. */
export function coOptimization(modes: ActiveMode[]): CoOptimization | null {
  const battery = batteryModes(modes);
  if (battery.length < 2) return null;
  return {
    count: battery.length,
    modeLabels: battery.map((m) => m.label),
    sentence: `${battery.length} Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.`,
    detail:
      'Alle 15 Minuten wird EIN gemeinsamer Fahrplan gerechnet, der alle Ziele zugleich ' +
      'verfolgt — die Reservierungen unten legen fest, wer welchen Teil des Speichers sicher hat.',
  };
}

// ---------------------------------------------------------------------------
// 2 · Der SoC-Reservierungs-Stack
// ---------------------------------------------------------------------------

export interface ReservationInput {
  /** Technische Untergrenze (Plattform/Anlage), z. B. 5 %. */
  socMinPct?: number | null;
  /** Obergrenze des nutzbaren Bandes, z. B. 95 %. */
  socMaxPct?: number | null;
  /** Notstrom-Reserve (harte SoC-Grenze, P11). */
  backupReserveSocPct?: number | null;
  /** Lastspitzen-Reserve (PS-2, `site.peak_reserve_soc_pct`). */
  peakReserveSocPct?: number | null;
}

export interface ReservationLayer {
  key: 'technisch' | 'notstrom' | 'lastspitze' | 'frei';
  label: string;
  /** Untere/obere Kante in Prozent (0..100) — die Balkengeometrie. */
  fromPct: number;
  toPct: number;
  /** Eine erklärende Zeile. */
  note: string;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/**
 * Der Reservierungs-Stack (technische Untergrenze < Notstrom-Reserve <
 * Lastspitzen-Reserve < freies Band) als Balkensegmente. **Es wird nichts
 * erfunden:** eine nicht bekannte Schicht (Feld fehlt, Endpunkt für diesen
 * Nutzer nicht lesbar) erscheint gar nicht, und ohne jede bekannte Schicht ist
 * das Ergebnis leer — der Streifen zeigt dann nur den Ko-Optimierungs-Satz.
 *
 * Die Schichten sind ABSOLUTE Grenzen, nicht additiv: die höchste bindet
 * (dieselbe Regel wie im Solver, `max` über die Reservierungen).
 */
export function socReservationStack(input: ReservationInput | null | undefined): ReservationLayer[] {
  if (!input) return [];
  const known: { key: ReservationLayer['key']; label: string; pct: number; note: string }[] = [];
  if (input.socMinPct != null && Number.isFinite(input.socMinPct)) {
    known.push({
      key: 'technisch',
      label: 'Technische Untergrenze',
      pct: clampPct(input.socMinPct),
      note: 'Schutz der Batterie — wird nie unterschritten.',
    });
  }
  if (input.backupReserveSocPct != null && Number.isFinite(input.backupReserveSocPct)) {
    known.push({
      key: 'notstrom',
      label: 'Notstrom-Reserve',
      pct: clampPct(input.backupReserveSocPct),
      note: 'Bleibt für Ihren Notstrombedarf reserviert — kein Preis überschreibt sie.',
    });
  }
  if (input.peakReserveSocPct != null && Number.isFinite(input.peakReserveSocPct)) {
    known.push({
      key: 'lastspitze',
      label: 'Lastspitzen-Reserve',
      pct: clampPct(input.peakReserveSocPct),
      note: 'Vorgehalten, um eine Bezugsspitze auch außerhalb des Fahrplans zu kappen.',
    });
  }
  if (known.length === 0) return [];

  const top = input.socMaxPct != null && Number.isFinite(input.socMaxPct)
    ? clampPct(input.socMaxPct)
    : 100;
  const layers: ReservationLayer[] = [];
  let cursor = 0;
  for (const l of known) {
    const to = Math.min(l.pct, top);
    // Die Schichten werden in ihrer kanonischen Reihenfolge (technisch →
    // Notstrom → Lastspitze) durchlaufen; eine Reservierung, die die bisher
    // erreichte Kante nicht überragt, ist bereits abgedeckt (absolute Grenzen,
    // die höchste bindet) - sie bekommt dann kein eigenes Segment.
    if (to > cursor) {
      layers.push({ key: l.key, label: l.label, fromPct: cursor, toPct: to, note: l.note });
      cursor = to;
    }
  }
  if (top > cursor) {
    layers.push({
      key: 'frei',
      label: 'Frei für die Modi',
      fromPct: cursor,
      toPct: top,
      note: 'Dieser Teil wird von allen aktiven Modi gemeinsam genutzt.',
    });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// 4 · Die Werkzeugkiste "＋ Modus hinzufügen"
// ---------------------------------------------------------------------------

/** Eine Voraussetzung, ehrlich aus den Entitäten abgeleitet ("Speicher ✓"). */
export interface RequirementChip {
  key: string;
  label: string;
  ok: boolean;
}

export type ToolboxAction =
  /** Der geführte Wenn/Dann-Baukasten. */
  | { kind: 'guided' }
  /** Die Marktoptimierungs-Vorlage (braucht eine Speicher-Einheit). */
  | { kind: 'market-template' }
  /** Leerer Editor mit vorgefiltertem Strategie-Palettenteil. */
  | { kind: 'editor'; name: string }
  /** Nichts zu klicken — VoltPilot richtet ein (Vertrieb läuft persönlich). */
  | { kind: 'managed' };

export interface ToolboxEntry {
  id: string;
  kind: ModeKind;
  title: string;
  /** EIN deutscher Ergebnis-Satz. */
  line: string;
  requirements: RequirementChip[];
  /** Alle Voraussetzungen erfüllt? */
  ready: boolean;
  /** 'free' = jederzeit; 'gated-open' = freigeschaltet; 'gated-locked' = Gate zu. */
  gate: 'free' | 'gated-open' | 'gated-locked';
  /** Die Gate-Zeile ("Einrichtung durch VoltPilot …"); null, wenn offen. */
  gateNote: string | null;
  action: ToolboxAction;
}

export interface ToolboxInput {
  /** Die AKTIVEN Modi — sie verschwinden aus der Werkzeugkiste. */
  modes: ActiveMode[];
  entities: EditorEntity[];
  /** Die per-Site freigeschalteten gated Knotentypen (AE7-Governance). */
  enabledGatedTypes: string[];
}

function req(key: string, label: string, ok: boolean): RequirementChip {
  return { key, label, ok };
}

/**
 * JEDER Modus, für JEDEN Kunden, immer (report §2.3 Teil 4 — die Antwort auf
 * die Auffindbarkeit). Bereits aktive Modi verschwinden; Voraussetzungen werden
 * aus den Entitäten abgeleitet und ehrlich als erfüllt/fehlend gezeigt; das
 * bestehende Gate bleibt unangetastet (die Karte ist sichtbar, die Aktivierung
 * prüft der Server weiterhin selbst).
 */
export function toolbox(input: ToolboxInput): ToolboxEntry[] {
  const active = new Set(input.modes.map((m) => m.kind));
  const enabled = new Set(input.enabledGatedTypes);
  const entities = input.entities ?? [];
  const hasStorage = storageEntities(entities).length > 0;
  const hasPv = entities.some((e) => e.measure.includes('pv_power_kw'));
  const hasGrid = gridMeterEntity(entities) != null;
  const hasConsumer = controllableConsumers(entities).length > 0;

  const gateFor = (nodeType: string): Pick<ToolboxEntry, 'gate' | 'gateNote'> =>
    enabled.has(nodeType)
      ? { gate: 'gated-open', gateNote: null }
      : { gate: 'gated-locked', gateNote: EINRICHTUNG_DURCH_VOLTPILOT };

  const entries: ToolboxEntry[] = [];

  if (!active.has('eigenverbrauch')) {
    const requirements = [req('speicher', 'Speicher', hasStorage), req('pv', 'PV', hasPv)];
    entries.push({
      id: NODE_SELFCONSUMPTION,
      kind: 'eigenverbrauch',
      title: MODE_LABELS.eigenverbrauch,
      line: marktoptimierungLine('eigenverbrauch', 'ohne'),
      requirements,
      ready: requirements.every((r) => r.ok),
      gate: 'free',
      gateNote: null,
      action: { kind: 'editor', name: MODE_LABELS.eigenverbrauch },
    });
  }

  if (!active.has('marktvermarktung')) {
    const requirements = [req('speicher', 'Speicher', hasStorage)];
    entries.push({
      id: NODE_MARKET,
      kind: 'marktvermarktung',
      title: MODE_LABELS.marktvermarktung,
      line: marktoptimierungLine('direktvermarktung', 'ohne'),
      requirements,
      ready: requirements.every((r) => r.ok),
      ...gateFor(NODE_MARKET),
      action: { kind: 'market-template' },
    });
  }

  if (!active.has('lastspitzenkappung')) {
    const requirements = [
      req('speicher', 'Speicher', hasStorage),
      req('leistungsmessung', 'Leistungsmessung', hasGrid),
    ];
    entries.push({
      id: NODE_PEAKSHAVING,
      kind: 'lastspitzenkappung',
      title: MODE_LABELS.lastspitzenkappung,
      line: lastspitzenkappungCard(null).line,
      requirements,
      ready: requirements.every((r) => r.ok),
      ...gateFor(NODE_PEAKSHAVING),
      // Vertragsnahes Modul: Leistungspreis + Reserve richtet VoltPilot ein.
      action: { kind: 'managed' },
    });
  }

  if (!active.has('atypische-netznutzung')) {
    const requirements = [req('leistungsmessung', 'Leistungsmessung', hasGrid)];
    entries.push({
      id: NODE_ATYPICAL_GRID,
      kind: 'atypische-netznutzung',
      title: MODE_LABELS['atypische-netznutzung'],
      line: 'Verlagert Verbrauch und Speicher aus den Hochlastzeitfenstern — für ein reduziertes Netzentgelt.',
      requirements,
      ready: requirements.every((r) => r.ok),
      ...gateFor(NODE_ATYPICAL_GRID),
      action: { kind: 'managed' },
    });
  }

  // Eigene Regeln sind nie "schon aktiv" - man kann immer eine weitere bauen.
  const consumerReq = [req('geraet', 'Steuerbares Gerät', hasConsumer)];
  entries.push({
    id: 'automation',
    kind: 'automation',
    title: 'Eigene Regel',
    line: 'Eine Wenn/Dann-Regel für Ihre Geräte — z. B. „Wallbox nur bei PV-Überschuss“.',
    requirements: consumerReq,
    ready: consumerReq.every((r) => r.ok),
    gate: 'free',
    gateNote: null,
    action: { kind: 'guided' },
  });

  return entries;
}

/** Die Zeile, die eine unerfüllte Voraussetzung erklärt; null wenn alles da ist. */
export function requirementHint(entry: ToolboxEntry): string | null {
  const missing = entry.requirements.filter((r) => !r.ok).map((r) => r.label);
  if (missing.length === 0) return null;
  return `Dafür fehlt noch: ${missing.join(' · ')}.`;
}

// ---------------------------------------------------------------------------
// Kopfzeilen der vier Teile
// ---------------------------------------------------------------------------

export const AKTIVE_MODI_INTRO =
  'Diese Modi laufen gerade auf Ihrer Anlage — mit dem, was sie beitragen.';

export const KEINE_MODI =
  'Auf dieser Anlage läuft noch kein Modus. Unten finden Sie alles, was möglich ist.';

export const TOOLBOX_INTRO =
  'Jeder Modus ist für jede Anlage sichtbar. Was Ihre Anlage dafür braucht, steht auf der Karte.';
