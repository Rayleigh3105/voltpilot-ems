/**
 * Portal v3 · **M2 — das Live-Cockpit** (`docs/portal-v3/M2-cockpit.md`,
 * Konzept-Tab „3 · Live-Cockpit").
 *
 * Die Anlagen-Startseite führt mit dem **bestehenden Energiefluss-Diagramm**
 * (groß, als Hero — `components/EnergyFlow.tsx` bzw. `AdaptiveEnergyFlow.tsx`;
 * ein neues „Energie-Rad" ist ausdrücklich abgelehnt, BUILD.md §2) und darunter
 * mit einem **Widget-Raster**: Speicher · Erzeugung · Haus · Netz, dazu
 * profil-abhängig Handel, Lastspitze, Erlöse und Geräte-Automatik. Ein Tipp auf
 * eine Kachel öffnet ein **Modal** mit den Segmenten `Jetzt | Verlauf`.
 *
 * Dieses Modul ist die **reine Ableitung** (der `cockpit.ts`/`live.ts`-
 * Präzedenzfall): kein React, kein Netzwerk, kein neuer Rechenkern. Es
 * KONSUMIERT das M0-Read-Model (`surface.ts`) und die bereits vorhandenen
 * Ableitungen (`cockpit.ts` Handel/Eigenverbrauch, `erloesKomposition.ts`,
 * `peakBand.ts`) — es rechnet nichts nach.
 *
 * Drei Regeln sind hier Gesetz:
 *
 * 1. **Die Projektion entscheidet, WELCHE Kacheln es gibt** (BUILD.md §4.1):
 *    eine Kachel existiert nur, wenn ihr Block/Modus existiert UND eine Quelle
 *    da ist. Ohne Markt-Modus keine Handel-Kachel, ohne Lastspitzen-Modul keine
 *    Lastspitze-Kachel, ohne Speicher-Kanal keine Speicher-Kachel.
 * 2. **Die „—"-Disziplin** (BUILD.md §4.2): ein nicht berechenbarer Wert
 *    rendert `—`, **nie eine erfundene 0**; eine Kachel ganz ohne Quelle
 *    entfällt, statt leer dazustehen.
 * 3. **Die Reihenfolge ist kanonisch** — sie kommt aus der Blockordnung von M0
 *    (`CockpitBlock.order`, report §1.3). Die Führungsregel (`leadSlot.ts`
 *    `leadBlock`) markiert nur, was FÜHRT; sie sortiert nichts um.
 *
 * Beide Modal-Gesichter lesen **dieselbe** Zahl wie die Kachel — es gibt keine
 * zweite Ableitung (M2-Akzeptanz 3).
 */

import type { EarningsRange, EarningsSite, HistoryTotals } from './api';
import { energyLabel, periodLabel } from './anlage';
import {
  eigenverbrauchBlock,
  handelBlock,
  type CockpitSlot,
  type EigenverbrauchBlockView,
  type HandelBlockView,
} from './cockpit';
import { DASH, erloesKomposition, steeringAttributionNote } from './erloesKomposition';
import { eurAmount, fmtNum } from './format';
import type { LiveSnapshot } from './live';
import type { AnlagenSub } from './nav';
import type { PeakBandView } from './peakBand';
import { planSentence, SLOT_DEADBAND_KW, type PlanWordingKind } from './schedule';
import { speicherschonungLabel } from './speicherschonung';
import type { ActiveMode, CockpitBlock, CockpitBlockId, MoneyStream } from './surface';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die Kacheln des Cockpits — deterministisch, nie erfunden. */
export type WidgetId =
  | 'lastspitze'
  | 'erloes'
  | 'erzeugung'
  | 'speicher'
  | 'haus'
  | 'netz'
  | 'handel'
  | 'eigenverbrauch'
  | 'automatik'
  | 'wetter';

/** Der Farbkanal einer Kachel — die `--vp-flow-*`-Token bzw. der Geld-Ton. */
export type WidgetAccent = 'pv' | 'batt' | 'grid' | 'load' | 'money';

/** Eine Zeile eines Modal-Gesichts. */
export interface WidgetRow {
  label: string;
  /** Der Wert; `—`, wenn nicht berechenbar (nie eine erfundene 0). */
  value: string;
  sub?: string | null;
}

/** Der Absprung eines Gesichts in seine Tiefen-Sicht. */
export interface WidgetDrillIn {
  sub: AnlagenSub;
  label: string;
  hint?: string;
}

/** Ein Gesicht des Modals (`Jetzt` bzw. `Verlauf`). */
export interface WidgetFace {
  rows: WidgetRow[];
  note: string | null;
  drillIn: WidgetDrillIn | null;
}

/** Eine render-fertige Kachel. */
export interface WidgetDef {
  id: WidgetId;
  label: string;
  /** Die große Zahl der Kachel; `—`, wenn (noch) nicht berechenbar. */
  value: string;
  /** Die ruhige Zeile darunter; null = keine. */
  sub: string | null;
  accent: WidgetAccent;
  /** true = diese Kachel gehört zum führenden Block (`leadBlock`). */
  lead: boolean;
  modal: { jetzt: WidgetFace; verlauf: WidgetFace };
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Der Telemetriekanal, der eine Fluss-Kachel überhaupt erst entstehen lässt. */
const FLOW_CHANNELS: Record<'erzeugung' | 'speicher' | 'haus' | 'netz', string[]> = {
  erzeugung: ['pv_power_kw'],
  speicher: ['soc_pct', 'battery_power_kw'],
  haus: ['load_kw'],
  netz: ['power_kw'],
};

/** Der Verlauf-Absprung der Live-Kacheln (Telemetrie, NICHT Erlös). */
export const VERLAUF_LIVE: WidgetDrillIn = {
  sub: 'live',
  label: 'Verlauf öffnen',
  hint: 'Telemetrie-Verlauf aller angelegten Kanäle – getrennt von der Erlös-Historie.',
};

/** Der Verlauf-Absprung der Tages-/Geld-Kacheln. */
export const VERLAUF_HISTORIE: WidgetDrillIn = {
  sub: 'historie',
  label: 'Historie öffnen',
  hint: 'Erlös- und Energie-Rückblick – getrennt vom Telemetrie-Verlauf.',
};

export const VERLAUF_FAHRPLAN: WidgetDrillIn = { sub: 'fahrplan', label: 'Ganzer Fahrplan' };
export const VERLAUF_LASTSPITZEN: WidgetDrillIn = { sub: 'lastspitzen', label: 'Lastspitzen im Detail' };
export const VERLAUF_STEUERUNG: WidgetDrillIn = { sub: 'steuerung', label: 'Steuerung öffnen' };
export const VERLAUF_WETTER: WidgetDrillIn = { sub: 'wetter', label: 'Wetter am Standort' };

/** Die eine Verlauf-Notiz der Live-Kacheln. */
const LIVE_VERLAUF_NOTE =
  'Den Messwert-Verlauf dieser Anlage zeigen die Live-Daten – mit Fenster-Umschalter.';

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

export interface CockpitWidgetsInput {
  /** Die Blöcke der Projektion (M0) — sie entscheiden, was es gibt. */
  blocks: CockpitBlock[] | null | undefined;
  /** Die aktiven Modi (für die Automatik-Kachel). */
  modes: ActiveMode[] | null | undefined;
  /** Der führende Block (`leadBlock`); markiert nur, sortiert nichts um. */
  lead?: CockpitBlockId | null;
  /** Alle angelegten Telemetriekanäle (`surface.base.telemetryChannels`). */
  channels?: string[] | null;
  /** Der jüngste Live-Schnappschuss; null = noch keiner. */
  snapshot?: LiveSnapshot | null;
  /** Die Historie-Totals des heutigen Tages (serverseitig gerechnet). */
  dayTotals?: HistoryTotals | null;
  /** Die Earnings-Zeile dieser Anlage. */
  money?: EarningsSite | null;
  /** Die Geld-Ströme der aktiven Modi (M0 `moneyStreams`). */
  streams?: MoneyStream[] | null;
  range: EarningsRange;
  at?: Date;
  now: Date;
  /** Die Slots des persistierten Fahrplans. */
  slots?: CockpitSlot[] | null;
  slotMinutes?: number;
  plantKind?: PlanWordingKind;
  /** Die fertige Peak-Band-Sicht; null = kein Peak-Modul / keine Daten. */
  peak?: PeakBandView | null;
  /** Der eingestellte Umgang mit dem Speicher (roh, wird gelabelt). */
  speicherschonung?: string | null;
  /** Wetter am Standort; null = nichts geladen. */
  weather?: { nextHourTempC: number | null; why: string | null } | null;
}

// ---------------------------------------------------------------------------
// Die Kacheln
// ---------------------------------------------------------------------------

/**
 * Das Widget-Raster einer Anlage: eine Kachel je Cockpit-Block bzw. Modus, der
 * WIRKLICH etwas beisteuert, in der kanonischen Blockordnung. Eine Kachel ohne
 * Quelle entfällt; eine Kachel ohne aktuellen Wert zeigt `—`.
 */
export function cockpitWidgets(input: CockpitWidgetsInput): WidgetDef[] {
  const blocks = [...(input.blocks ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const out: WidgetDef[] = [];
  const lead = input.lead ?? null;

  for (const b of blocks) {
    switch (b.id) {
      case 'peak-band':
        push(out, lastspitzeWidget(input), b.id === lead);
        break;
      case 'erloes-komposition':
        push(out, erloesWidget(input), b.id === lead);
        break;
      case 'energiefluss':
        for (const w of flowWidgets(input)) push(out, w, b.id === lead);
        break;
      case 'handel':
        push(out, handelWidget(input), b.id === lead);
        break;
      case 'eigenverbrauch':
        push(out, eigenverbrauchWidget(input), b.id === lead);
        break;
      case 'geraete-automatik':
        push(out, automatikWidget(input), b.id === lead);
        break;
      default:
        break;
    }
  }

  // Das Wetter hat keinen eigenen Modus und keinen Nav-Eintrag mehr — es ist
  // die ruhige Schluss-Kachel und ein Weg auf die Wetter-Seite (M2-6). Ohne
  // Projektion (nie migrierte Anlage) gibt es aber ÜBERHAUPT keine Kachel:
  // das Cockpit erscheint dann gar nicht (`projectionActive`), und diese
  // Funktion darf das nicht unterlaufen.
  if (blocks.length > 0) push(out, wetterWidget(input), false);
  return out;
}

function push(out: WidgetDef[], w: Omit<WidgetDef, 'lead'> | null, lead: boolean): void {
  if (w) out.push({ ...w, lead });
}

// --- Fluss-Kacheln (base) ---------------------------------------------------

function flowWidgets(input: CockpitWidgetsInput): (Omit<WidgetDef, 'lead'> | null)[] {
  return [erzeugungWidget(input), speicherWidget(input), hausWidget(input), netzWidget(input)];
}

function hasSource(
  input: CockpitWidgetsInput,
  key: keyof typeof FLOW_CHANNELS,
  values: (number | null | undefined)[],
): boolean {
  const declared = new Set(input.channels ?? []);
  if (FLOW_CHANNELS[key].some((c) => declared.has(c))) return true;
  return values.some((v) => num(v) != null);
}

function erzeugungWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const pv = num(input.snapshot?.pvKw);
  if (!hasSource(input, 'erzeugung', [pv])) return null;
  const generated = num(input.dayTotals?.pvGenerationKwh);
  return {
    id: 'erzeugung',
    label: 'Erzeugung',
    value: pv == null ? DASH : fmtNum(pv, 'kW'),
    sub: generated == null ? null : `${energyLabel(generated)} heute`,
    accent: 'pv',
    modal: {
      jetzt: face(
        [
          { label: 'Erzeugung jetzt', value: pv == null ? DASH : fmtNum(pv, 'kW') },
          { label: 'Heute erzeugt', value: generated == null ? DASH : energyLabel(generated) },
        ],
        null,
        null,
      ),
      verlauf: face([], LIVE_VERLAUF_NOTE, VERLAUF_LIVE),
    },
  };
}

/** Der Zustandssatz des Speichers — Vorzeichen erreichen den Kunden nie. */
export function speicherStateLine(battKw: number | null | undefined): string | null {
  const v = num(battKw);
  if (v == null) return null;
  if (Math.abs(v) < SLOT_DEADBAND_KW) return 'ruht gerade';
  return v > 0 ? `lädt mit ${fmtNum(v, 'kW')}` : `entlädt mit ${fmtNum(Math.abs(v), 'kW')}`;
}

function speicherWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const soc = num(input.snapshot?.socPct);
  const batt = num(input.snapshot?.battKw);
  if (!hasSource(input, 'speicher', [soc, batt])) return null;
  const state = speicherStateLine(batt);
  const rows: WidgetRow[] = [
    { label: 'Ladestand', value: soc == null ? DASH : fmtNum(soc, '%', 0) },
    { label: 'Leistung', value: batt == null ? DASH : fmtNum(Math.abs(batt), 'kW'), sub: state },
  ];
  if (input.speicherschonung != null) {
    rows.push({
      label: 'Umgang mit dem Speicher',
      value: speicherschonungLabel(input.speicherschonung),
      sub: 'Änderbar unter Technik & Einstellungen.',
    });
  }
  return {
    id: 'speicher',
    label: 'Speicher',
    value: soc == null ? DASH : fmtNum(soc, '%', 0),
    sub: state,
    accent: 'batt',
    modal: {
      jetzt: face(rows, null, { sub: 'technik', label: 'Technik & Einstellungen' }),
      verlauf: face([], LIVE_VERLAUF_NOTE, VERLAUF_LIVE),
    },
  };
}

function hausWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const load = num(input.snapshot?.loadKw);
  if (!hasSource(input, 'haus', [load])) return null;
  const consumed = num(input.dayTotals?.consumptionKwh);
  const autarkie = num(input.dayTotals?.autarkiePct);
  return {
    id: 'haus',
    label: 'Haus',
    value: load == null ? DASH : fmtNum(load, 'kW'),
    sub: consumed == null ? null : `${energyLabel(consumed)} heute`,
    accent: 'load',
    modal: {
      jetzt: face(
        [
          { label: 'Verbrauch jetzt', value: load == null ? DASH : fmtNum(load, 'kW') },
          { label: 'Heute verbraucht', value: consumed == null ? DASH : energyLabel(consumed) },
          { label: 'Autarkie heute', value: autarkie == null ? DASH : fmtNum(autarkie, '%', 0) },
        ],
        null,
        null,
      ),
      verlauf: face([], null, VERLAUF_HISTORIE),
    },
  };
}

/** „Bezug" / „Einspeisung" / „ausgeglichen" — nie ein Vorzeichen im UI. */
export function netzDirectionLabel(gridKw: number | null | undefined): string | null {
  const v = num(gridKw);
  if (v == null) return null;
  if (Math.abs(v) < SLOT_DEADBAND_KW) return 'ausgeglichen';
  return v > 0 ? 'Netzbezug' : 'Einspeisung';
}

function netzWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const grid = num(input.snapshot?.gridKw);
  if (!hasSource(input, 'netz', [grid])) return null;
  const imported = num(input.dayTotals?.gridImportKwh);
  const exported = num(input.dayTotals?.gridExportKwh);
  const cost = num(input.dayTotals?.gridCostEur);
  return {
    id: 'netz',
    label: 'Netz',
    value: grid == null ? DASH : fmtNum(Math.abs(grid), 'kW'),
    sub: netzDirectionLabel(grid),
    accent: 'grid',
    modal: {
      jetzt: face(
        [
          {
            label: 'Netz jetzt',
            value: grid == null ? DASH : fmtNum(Math.abs(grid), 'kW'),
            sub: netzDirectionLabel(grid),
          },
          { label: 'Heute bezogen', value: imported == null ? DASH : energyLabel(imported) },
          { label: 'Heute eingespeist', value: exported == null ? DASH : energyLabel(exported) },
          { label: 'Netzkosten heute', value: cost == null ? DASH : eurAmount(cost) },
        ],
        null,
        null,
      ),
      verlauf: face([], null, VERLAUF_HISTORIE),
    },
  };
}

// --- Modus-Kacheln ----------------------------------------------------------

function lastspitzeWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const peak = input.peak;
  if (!peak) return null;
  const rows: WidgetRow[] = [
    { label: 'Aktuelles ¼-h-Mittel', value: peak.currentLabel },
    { label: 'Ziel Netzbezug', value: peak.targetLabel ?? DASH },
    ...peak.metrics.map((m) => ({ label: m.label, value: m.value })),
  ];
  return {
    id: 'lastspitze',
    label: 'Lastspitze',
    value: peak.currentLabel,
    sub: peak.targetLabel ? `Ziel ${peak.targetLabel}` : peak.note,
    accent: 'pv',
    modal: {
      jetzt: face(rows, peak.note, VERLAUF_LASTSPITZEN),
      verlauf: face([], null, VERLAUF_LASTSPITZEN),
    },
  };
}

function erloesWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const view = erloesKomposition({
    streams: input.streams ?? [],
    money: input.money ?? null,
    range: input.range,
    at: input.at,
    now: input.now,
  });
  if (view.isEmpty) return null;
  const total = view.totals[0] ?? null;
  return {
    id: 'erloes',
    label: 'Erlöse',
    value: total?.valueText ?? DASH,
    sub: total?.label ?? null,
    accent: 'money',
    modal: {
      jetzt: face(
        view.rows.map((r) => ({ label: r.label, value: r.valueText, sub: r.periodLabel })),
        view.periodNote ?? view.footnote,
        null,
      ),
      verlauf: face([], null, VERLAUF_HISTORIE),
    },
  };
}

function handelWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const view: HandelBlockView = handelBlock({
    money: input.money ?? null,
    slots: input.slots ?? [],
    now: input.now,
    slotMinutes: input.slotMinutes ?? 15,
    periodLabel: periodLabel(input.range, input.at ?? input.now, input.now),
  });
  if (view.isEmpty) return null;
  const first = view.tiles[0];
  return {
    id: 'handel',
    label: 'Handel',
    value: first.value,
    sub: first.label,
    accent: 'grid',
    modal: {
      jetzt: face(
        view.tiles.map((t) => ({ label: t.label, value: t.value, sub: t.sub })),
        view.praemieNote,
        VERLAUF_FAHRPLAN,
      ),
      verlauf: face([], null, VERLAUF_FAHRPLAN),
    },
  };
}

function eigenverbrauchWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const view: EigenverbrauchBlockView = eigenverbrauchBlock({
    autarkiePct: input.dayTotals?.autarkiePct,
    eigenverbrauchPct: input.dayTotals?.eigenverbrauchPct,
    gridImportKwh: input.dayTotals?.gridImportKwh,
    slots: input.slots ?? [],
    now: input.now,
    slotMinutes: input.slotMinutes ?? 15,
  });
  if (view.isEmpty) return null;
  const first = view.tiles[0];
  return {
    id: 'eigenverbrauch',
    label: 'Eigenverbrauch',
    value: first.value,
    sub: first.label,
    accent: 'batt',
    modal: {
      jetzt: face(
        view.tiles.map((t) => ({ label: t.label, value: t.value, sub: t.sub })),
        null,
        VERLAUF_FAHRPLAN,
      ),
      verlauf: face([], null, VERLAUF_HISTORIE),
    },
  };
}

function automatikWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const rows = (input.modes ?? []).filter((m) => m.kind === 'automation');
  if (rows.length === 0) return null;
  return {
    id: 'automatik',
    label: 'Geräte-Automatik',
    value: String(rows.length),
    sub: rows.length === 1 ? 'aktive Regel' : 'aktive Regeln',
    accent: 'load',
    modal: {
      jetzt: face(
        rows.map((m) => ({ label: m.label, value: 'aktiv', sub: 'Läuft auf Ihrem Gerät.' })),
        null,
        VERLAUF_STEUERUNG,
      ),
      verlauf: face([], null, VERLAUF_STEUERUNG),
    },
  };
}

function wetterWidget(input: CockpitWidgetsInput): Omit<WidgetDef, 'lead'> | null {
  const temp = num(input.weather?.nextHourTempC);
  const why = input.weather?.why ?? null;
  if (temp == null && !why) return null;
  return {
    id: 'wetter',
    label: 'Wetter',
    value: temp == null ? DASH : fmtNum(temp, '°C'),
    sub: why ?? 'Vorhersage am Standort Ihrer Anlage',
    accent: 'pv',
    modal: {
      jetzt: face(
        [{ label: 'Nächste Stunde', value: temp == null ? DASH : fmtNum(temp, '°C'), sub: why }],
        'Die Vorhersage ist die Grundlage der PV-Prognose.',
        VERLAUF_WETTER,
      ),
      verlauf: face([], null, VERLAUF_WETTER),
    },
  };
}

// ---------------------------------------------------------------------------
// Der Hero
// ---------------------------------------------------------------------------

/** Eine Ring-Kennzahl neben dem Energiefluss. */
export interface HeroRing {
  id: 'autarkie' | 'eigenverbrauch';
  label: string;
  /** 0..100 — nur vorhanden, wenn der Tageswert wirklich gemessen wurde. */
  pct: number;
  valueText: string;
  /** CSS-Farbe (Token-`var()`). */
  hue: string;
}

/** Die Geld-Zeile des Hero — Zurechnung IMMER als Unterzeile (MIG §5). */
export interface HeroMoney {
  label: string;
  value: string;
  /** „davon X € durch VoltPilots Steuerung"; null = keine Zurechnung. */
  attribution: string | null;
}

export interface CockpitHeroView {
  rings: HeroRing[];
  money: HeroMoney | null;
  /** EINE deutsche Fahrplan-Zeile; null = kein Plan für heute. */
  planSentence: string | null;
}

const RING_HUE = {
  autarkie: 'var(--vp-flow-pv)',
  eigenverbrauch: 'var(--vp-flow-batt)',
} as const;

/**
 * Der Hero neben dem Energiefluss: **Autarkie heute** und **Eigenverbrauch** als
 * Ringe, die verdiente Summe des gewählten Zeitraums mit der Steuerungs-
 * Zurechnung als Unterzeile, und die eine Fahrplan-Zeile.
 *
 * Ehrlichkeit: ein Tageswert, der nicht vorliegt, erzeugt **keinen Ring**
 * (nicht „0 %", M2-Akzeptanz 2); ohne berechenbaren Betrag entfällt die
 * Geld-Zeile. Die Steuerungs-Zurechnung ist NIE ein eigener Summand — sie
 * steckt bereits im Erlös und steht deshalb darunter.
 */
export function cockpitHero(input: {
  dayTotals?: HistoryTotals | null;
  money?: EarningsSite | null;
  range: EarningsRange;
  at?: Date;
  now: Date;
  slots?: CockpitSlot[] | null;
  slotMinutes?: number;
  plantKind?: PlanWordingKind;
}): CockpitHeroView {
  const rings: HeroRing[] = [];
  const autarkie = num(input.dayTotals?.autarkiePct);
  if (autarkie != null) {
    rings.push({
      id: 'autarkie',
      label: 'Autarkie heute',
      pct: clampPct(autarkie),
      valueText: fmtNum(autarkie, '%', 0),
      hue: RING_HUE.autarkie,
    });
  }
  const ev = num(input.dayTotals?.eigenverbrauchPct);
  if (ev != null) {
    rings.push({
      id: 'eigenverbrauch',
      label: 'Eigenverbrauch',
      pct: clampPct(ev),
      valueText: fmtNum(ev, '%', 0),
      hue: RING_HUE.eigenverbrauch,
    });
  }

  const label = periodLabel(input.range, input.at ?? input.now, input.now);
  const total = num(input.money?.gesamtertragEur) ?? num(input.money?.einspeiseErloesEur);
  const money: HeroMoney | null =
    total == null
      ? null
      : {
          label: `Verdient · ${label}`,
          value: eurAmount(total),
          attribution: steeringAttributionNote(input.money?.savedEur),
        };

  return {
    rings,
    money,
    planSentence: planSentence(
      input.slots ?? [],
      input.plantKind ?? 'eigenverbrauch',
      input.now,
      input.slotMinutes ?? 15,
    ),
  };
}

// ---------------------------------------------------------------------------

function face(rows: WidgetRow[], note: string | null, drillIn: WidgetDrillIn | null): WidgetFace {
  return { rows, note, drillIn };
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}
