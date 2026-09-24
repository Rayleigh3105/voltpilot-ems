/**
 * Portal v3 · **M2 — das Live-Cockpit** (`docs/portal.md`,
 * Konzept-Tab „3 · Live-Cockpit").
 *
 * Die Anlagen-Startseite führt mit dem **bestehenden Energiefluss-Diagramm**
 * (groß, als Hero — `components/EnergyFlow.tsx` bzw. `AdaptiveEnergyFlow.tsx`;
 * ein neues „Energie-Rad" ist ausdrücklich abgelehnt, BUILD.md §2) und darunter
 * mit einem **Widget-Raster** der Geld-/Modus-Kacheln: Handel, Lastspitze,
 * Erlöse, Eigenverbrauch, Geräte-Automatik, Wetter.
 *
 * **Die vier FLUSS-Kacheln (Erzeugung/Speicher/Haus/Netz) sind seit dem
 * Cockpit+Live-Merge (Option A, `data/vp-cockpit-live-merge-design/report.md`
 * §3 R2) ersatzlos entfernt**: das Komponenten-Board im Cockpit ist die EINE
 * Live-Wert-Fläche — strikt reicher (Zustandswort, Health, Sparkline, alle
 * Messwerte), und seine Zeilen springen selbst in den Verlauf-Explorer.
 *
 * **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2,
 * `data/vp-portal-livedata-design/report.md` §1): ein Tipp navigiert direkt zum
 * `target` der Kachel — auf ihre Seite. Das frühere Detail-Modal ist ersatzlos
 * entfernt; die Werte-Zeilen leben auf den Zielseiten (Bilanz / Lastspitzen /
 * Fahrplan).
 *
 * Dieses Modul ist die **reine Ableitung** (der `cockpit.ts`/`live.ts`-
 * Präzedenzfall): kein React, kein Netzwerk, kein neuer Rechenkern. Es
 * KONSUMIERT das M0-Read-Model (`surface.ts`) und die bereits vorhandenen
 * Ableitungen (`cockpit.ts` Handel/Eigenverbrauch, `erloesKomposition.ts`,
 * `peakBand.ts`) — es rechnet nichts nach. Das Absprung-Ziel selbst kommt aus
 * dem reinen `verlaufTarget.ts` (`widgetTarget`).
 *
 * Drei Regeln sind hier Gesetz:
 *
 * 1. **Die Projektion entscheidet, WELCHE Kacheln es gibt** (BUILD.md §4.1):
 *    eine Kachel existiert nur, wenn ihr Block/Modus existiert UND eine Quelle
 *    da ist. Ohne Markt-Modus keine Handel-Kachel, ohne Lastspitzen-Modul keine
 *    Lastspitze-Kachel.
 * 2. **Die „—"-Disziplin** (BUILD.md §4.2): ein nicht berechenbarer Wert
 *    rendert `—`, **nie eine erfundene 0**; eine Kachel ganz ohne Quelle
 *    entfällt, statt leer dazustehen.
 * 3. **Die Reihenfolge ist kanonisch** — sie kommt aus der Blockordnung von M0
 *    (`CockpitBlock.order`, report §1.3). Die Führungsregel (`leadSlot.ts`
 *    `leadBlock`) markiert nur, was FÜHRT; sie sortiert nichts um.
 */

import type {
  CockpitMoney,
  EarningsRange,
  HistoryRange,
  HistoryTotals,
} from './api';
import { periodLabel } from './anlage';
import {
  eigenverbrauchBlock,
  handelBlock,
  type CockpitSlot,
  type EigenverbrauchBlockView,
  type HandelBlockView,
} from './cockpit';
import {
  DASH,
  bestandZeile,
  signedEuro,
  type BestandZeile,
  type SteuerungFormelInput,
} from './erloesKomposition';
import { NETTO_WORT, nettoEur } from './erloesNetto';
import { fmtNum } from './format';
import type { PeakBandView } from './peakBand';
import { planSentence, type PlanWordingKind } from './schedule';
import { speicherAussage, type SpeicherAussage } from './speicherAussage';
import type { ActiveMode, CockpitBlock, CockpitBlockId, MoneyStream } from './surface';
import type { SiteCharging } from './ladepunkte';
import { widgetTarget, type WidgetTarget } from './verlaufTarget';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Die Kacheln des Cockpits — deterministisch, nie erfunden. Die vier
 *  Fluss-Kacheln sind seit dem Cockpit+Live-Merge (R2) kein Teil davon. */
export type WidgetId =
  | 'lastspitze'
  | 'erloes'
  | 'handel'
  | 'eigenverbrauch'
  | 'automatik'
  | 'wetter';

/** Der Farbkanal einer Kachel — die `--vp-flow-*`-Token bzw. der Geld-Ton. */
export type WidgetAccent = 'pv' | 'batt' | 'grid' | 'load' | 'money';

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
  /** Wohin ein Tipp springt: ein Verlauf-Messwert oder eine Seite. */
  target: WidgetTarget;
}

/** Eine Kachel vor dem Anhängen von `lead` + `target`. */
type WidgetBase = Omit<WidgetDef, 'lead' | 'target'>;

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
  /** Die Historie-Totals des heutigen Tages (serverseitig gerechnet). */
  dayTotals?: HistoryTotals | null;
  /** Die Earnings-Zeile dieser Anlage. */
  money?: CockpitMoney | null;
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
  /** Die Ladepunkt-Sicht der Anlage; null = keine Ladesäulen / nichts geladen. */
  charging?: SiteCharging | null;
  /** Wetter am Standort; null = nichts geladen. */
  weather?: { nextHourTempC: number | null; why: string | null } | null;
}

// ---------------------------------------------------------------------------
// Die Kacheln
// ---------------------------------------------------------------------------

/**
 * Das Widget-Raster einer Anlage: eine Kachel je Cockpit-Block bzw. Modus, der
 * WIRKLICH etwas beisteuert, in der kanonischen Blockordnung. Eine Kachel ohne
 * Quelle entfällt; eine Kachel ohne aktuellen Wert zeigt `—`. Jede Kachel
 * bekommt ihr Absprung-`target` (Verlauf-Messwert bzw. Seite) angehängt.
 */
export function cockpitWidgets(input: CockpitWidgetsInput): WidgetDef[] {
  const blocks = [...(input.blocks ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const out: Omit<WidgetDef, 'target'>[] = [];
  const lead = input.lead ?? null;

  for (const b of blocks) {
    switch (b.id) {
      // ⚠ `lade-budget` gehört seit der Kachel „Laden" DORT hin (Konzept §5.1):
      // ein Block hat EINEN Wohnort, sonst rendert er zweimal. Die
      // Netzanschluss-Kachel ist deshalb hier ERSATZLOS entfallen - ihre
      // Aussage steht als Fusszeile unter den Ladepunkt-Zeilen, die sie
      // erklärt.
      case 'peak-band':
        push(out, lastspitzeWidget(input), b.id === lead);
        break;
      // ⚠ `erloes-komposition` steuert seit P5 KEINE Kachel mehr bei
      // (Captain-Entscheid **E11 = (a)**, 03.09.2026, Befund B14): die Kachel
      // „Erlöse 9,95 € · Heute gesamt" trug den GESAMTERTRAG brutto und stand
      // damit als ZWEITE Geldzahl neben „Unterm Strich + 5,14 €" derselben
      // Karte — E9 („Netto überall") lässt genau eine Geldzahl je Schirm zu.
      // Der BLOCK bleibt: er trägt weiter Nav-Eintrag und Lead-Slot der
      // Erlöse-Welt (`surface.ts`), also hinterlässt eine gespeicherte
      // `cockpit_layout`-Schicht, die ihn nennt, keine Lücke.
      // 'energiefluss' steuert seit dem Merge KEINE Kacheln mehr bei: der Hero
      // (Diagramm) und das Komponenten-Board tragen die Live-Werte (R1/R2).
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

  return out.map((w) => ({ ...w, target: widgetTarget(w.id) }));
}

function push(out: Omit<WidgetDef, 'target'>[], w: WidgetBase | null, lead: boolean): void {
  if (w) out.push({ ...w, lead });
}

// --- Modus-Kacheln ----------------------------------------------------------


function lastspitzeWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const peak = input.peak;
  if (!peak) return null;
  return {
    id: 'lastspitze',
    label: 'Lastspitze',
    value: peak.currentLabel,
    sub: peak.targetLabel ? `Ziel ${peak.targetLabel}` : peak.note,
    accent: 'pv',
  };
}

function handelWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const view: HandelBlockView = handelBlock({
    money: input.money ?? null,
    slots: input.slots ?? [],
    now: input.now,
    slotMinutes: input.slotMinutes ?? 15,
    periodLabel: periodLabel(input.range, input.at ?? input.now, input.now),
  });
  if (view.isEmpty) return null;
  // `savedEur` already lives as attribution directly below the hero total.
  // Repeating the same interim amount as a large "Handel" KPI made a running
  // day's negative cash-flow look like a second, final loss. The widget keeps
  // its useful plan shortcut, but now leads with the next actual trade window.
  const first = view.tiles.find((tile) => !tile.label.startsWith('Durch Steuerung ·'));
  if (!first) return null;
  return {
    id: 'handel',
    label: 'Handel',
    value: first.value,
    sub: first.label,
    accent: 'grid',
  };
}

function eigenverbrauchWidget(input: CockpitWidgetsInput): WidgetBase | null {
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
  };
}

function automatikWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const rows = (input.modes ?? []).filter((m) => m.kind === 'automation');
  if (rows.length === 0) return null;
  return {
    id: 'automatik',
    label: 'Geräte-Automatik',
    value: String(rows.length),
    sub: rows.length === 1 ? 'aktive Regel' : 'aktive Regeln',
    accent: 'load',
  };
}

function wetterWidget(input: CockpitWidgetsInput): WidgetBase | null {
  const temp = num(input.weather?.nextHourTempC);
  const why = input.weather?.why ?? null;
  if (temp == null && !why) return null;
  return {
    id: 'wetter',
    label: 'Wetter',
    value: temp == null ? DASH : fmtNum(temp, '°C'),
    sub: why ?? 'Vorhersage am Standort Ihrer Anlage',
    accent: 'pv',
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
  /**
   * true = das Netto ist NEGATIV (mehr Stromkosten als Ertrag). Das Zeichen
   * steht ohnehin im Text — die Farbe ist die Zugabe (Erlöse-Konzept §2
   * Prinzip 4, E8 = a).
   */
  kosten: boolean;
  /**
   * Die volle Speicher-Aussage — dieselbe Ableitung, die die Erlöse-Seite in
   * der Langform zeigt (§3.5/§3.6). Seit P5 rendert die Cockpit-Erlöskarte
   * daraus DIESELBE `SpeicherKarte`; `attribution` bleibt die Kurzform für
   * Flächen, die nur eine Zeile haben (Sticky-Kopf, Portfolio).
   */
  speicher: SpeicherAussage | null;
  /**
   * Die Speicher-Aussage in Kurzform: „Speicher + 12,40 € · davon Steuerung
   * + 3,10 €" (Erlöse-Konzept §3.6). null = es gibt nichts zu sagen.
   */
  attribution: string | null;
  /** Der volle Wortlaut als Tooltip der Kurzform; null ohne Aussage. */
  attributionTitel?: string | null;
  /** true = the selected earnings window is still running. */
  attributionInterim?: boolean;
  /** Measured battery inventory, valued by the plan and NEVER added to cash. */
  bestand?: BestandZeile | null;
  /**
   * Die Eingabe fuer den Aufklapper „Wie wird das berechnet?" unter dem
   * Zurechnungs-Chip (Captain 01.09.2026). Null = es gibt keine Zurechnung,
   * also auch nichts zu erklaeren — ein Aufklapper ohne Bezugszahl waere ein
   * Versprechen ins Leere.
   */
  formel?: SteuerungFormelInput | null;
}

export interface CockpitHeroView {
  rings: HeroRing[];
  /**
   * V13 (Audit): warum gerade KEIN Ring dasteht. Auf „Heute" und „Gesamt"
   * verschwanden die Ringe kommentarlos und die Seitenhöhe sprang bei jedem
   * Tab-Wechsel. Der Satz hält den Platz und erklärt ihn — nie ein Ring mit
   * einer erfundenen 0. null = es gibt Ringe.
   */
  ringsNote: string | null;
  money: HeroMoney | null;
  /** EINE deutsche Fahrplan-Zeile; null = kein Plan für heute. */
  planSentence: string | null;
}

const RING_HUE = {
  autarkie: 'var(--vp-flow-pv)',
  eigenverbrauch: 'var(--vp-flow-batt)',
} as const;

/**
 * Der Historie-Bereich, aus dem die Hero-Ringe ihre zeitraum-bezogene
 * Autarkie/Eigenverbrauch ziehen. Die Zeitraum-Tabs sprechen `EarningsRange`
 * (Heute/Monat/Jahr/Gesamt), die Historie kennt `HistoryRange`
 * (day/week/month/year) — hier die Abbildung. **„Gesamt" (`all`) hat keinen
 * All-Zeit-Historie-Endpunkt**, also `null`: der Aufrufer holt dann keine
 * Summen und die Ringe entfallen ehrlich (nie ein falscher Jahres-Wert unter
 * „Gesamt").
 */
export function historyRangeForCockpit(range: EarningsRange): HistoryRange | null {
  switch (range) {
    case 'day':
      return 'day';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return null;
  }
}

/**
 * Der Hero neben dem Energiefluss: **Autarkie** und **Eigenverbrauch** als
 * Ringe, die verdiente Summe des gewählten Zeitraums mit der Steuerungs-
 * Zurechnung als Unterzeile, und die eine Fahrplan-Zeile.
 *
 * Die Ring-Kennzahlen **folgen dem gewählten Zeitraum** (v3.2 M1): `totals`
 * sind die zeitraum-bezogenen Historie-Summen (Tag/Monat/Jahr), und das
 * Ring-Etikett trägt die Periode wie die Geld-Zeile (`Autarkie · Juli`) — nur
 * der Energiefluss selbst bleibt „jetzt gerade". „Gesamt" hat keinen All-Zeit-
 * Historie-Endpunkt, also übergibt der Aufrufer dann `totals: null` und es
 * erscheint **kein Ring** (nie ein falscher Zeitraum-Wert).
 *
 * Ehrlichkeit: ein Zeitraum-Wert, der nicht vorliegt, erzeugt **keinen Ring**
 * (nicht „0 %", M2-Akzeptanz 2); ohne berechenbaren Betrag entfällt die
 * Geld-Zeile. Die Steuerungs-Zurechnung ist NIE ein eigener Summand — sie
 * steckt bereits im Erlös und steht deshalb darunter.
 */
export function cockpitHero(input: {
  /** Die Historie-Summen des GEWÄHLTEN Zeitraums (nicht „heute"). */
  totals?: HistoryTotals | null;
  /**
   * Die Anlagen-Antwort. Sie ist als `CockpitMoney` typisiert (die Flotten-Zeile
   * trägt nicht mehr), die Anlagen-Seite reicht aber die volle `SiteEarnings`
   * durch — deshalb sind die Tarif-Felder OPTIONAL angehängt: fehlen sie, sagt
   * die Erklärung die vorsichtigere Fassung („Börsenpreis").
   */
  money?: (CockpitMoney & Partial<SteuerungFormelInput>) | null;
  range: EarningsRange;
  at?: Date;
  now: Date;
  slots?: CockpitSlot[] | null;
  slotMinutes?: number;
  plantKind?: PlanWordingKind;
}): CockpitHeroView {
  const label = periodLabel(input.range, input.at ?? input.now, input.now);
  const rings: HeroRing[] = [];
  const autarkie = num(input.totals?.autarkiePct);
  if (autarkie != null) {
    rings.push({
      id: 'autarkie',
      label: `Autarkie · ${label}`,
      pct: clampPct(autarkie),
      valueText: fmtNum(autarkie, '%', 0),
      hue: RING_HUE.autarkie,
    });
  }
  const ev = num(input.totals?.eigenverbrauchPct);
  if (ev != null) {
    rings.push({
      id: 'eigenverbrauch',
      label: `Eigenverbrauch · ${label}`,
      pct: clampPct(ev),
      valueText: fmtNum(ev, '%', 0),
      hue: RING_HUE.eigenverbrauch,
    });
  }

  // EINE Zahl ueber die Flaechen (Erloese-Konzept E9 / P9, Befund B11): der
  // Held ist das Ergebnis UNTERM STRICH — dieselbe Zahl und dasselbe Wort, die
  // die Erloese-Welt eine Ebene tiefer zeigt. Vorher stand hier der
  // GESAMTERTRAG (ohne Stromkosten) unter dem Wort „Verdient", und ein Klick
  // vom Cockpit in die Erloese-Welt zeigte zwei Zahlen fuer denselben Tag.
  // Gelesen wird sie NICHT hier, sondern in `erloesNetto.nettoEur` — der EINEN
  // Ableitung, die auch die Erloese-Seite und das Portfolio fahren.
  const total = nettoEur(input.money);
  const periodEnd = input.money?.to ? new Date(input.money.to).getTime() : NaN;
  const running = Number.isFinite(periodEnd) && periodEnd > input.now.getTime();
  // Die SPEICHER-AUSSAGE in Kurzform (Erlöse-Konzept §3.5/§3.6, P5): dieselbe
  // Ableitung, die die Erlöse-Karte in der Langform zeigt. Vorher stand hier
  // `savedEur` unter dem Wort „Steuerung" — derselbe Wert misst aber den
  // GANZEN Speicher (§2.2), und die Erlöse-Seite nennt ihn seither so. Ohne
  // die gemeinsame Ableitung sagte das Cockpit „Steuerung −2,67 €" und die
  // Erlöse-Seite „Steuerung +1,45 €" über dieselbe Stunde.
  const speicher = speicherAussage(input.money, { now: input.now });
  const attribution = speicher?.hatAussage ? speicher.kurz : null;
  const money: HeroMoney | null =
    total == null
      ? null
      : {
          label: `${NETTO_WORT} · ${label}`,
          // Vorzeichen wie auf der Erloese-Seite: das Netto KANN negativ sein
          // (mehr Stromkosten als Ertrag), und derselbe Wert darf hier nicht
          // anders aussehen als eine Ebene tiefer.
          value: signedEuro(total),
          kosten: total < 0,
          speicher: speicher?.hatAussage ? speicher : null,
          attribution,
          attributionTitel: speicher?.kurzTitel ?? null,
          attributionInterim: running && attribution != null,
          bestand: bestandZeile(input.money, input.now),
          // Der Aufklapper haengt am CHIP: ohne Zurechnung gibt es ihn nicht.
          formel:
            attribution == null
              ? null
              : {
                  tarifArt: input.money?.tarifArt ?? null,
                  tarifParamCtKwh: input.money?.tarifParamCtKwh ?? null,
                  tarifPriced: input.money?.tarifPriced ?? null,
                  exportVerguetungPriced: input.money?.exportVerguetungPriced ?? null,
                  bezugspreisCtKwh: input.money?.bezugspreisCtKwh ?? null,
                  plantKind: input.money?.plantKind ?? null,
                  marktpraemieEur: input.money?.marktpraemieEur ?? null,
                  anzulegenderWertCtKwh: input.money?.anzulegenderWertCtKwh ?? null,
                  marketValueSolarCtKwh: input.money?.marketValueSolarCtKwh ?? null,
                  bestandSichtbar: bestandZeile(input.money, input.now) != null,
                  savedSteuerungEur: input.money?.savedSteuerungEur ?? null,
                },
        };

  return {
    rings,
    ringsNote:
      rings.length > 0
        ? null
        : input.range === 'all'
          ? 'Autarkie und Eigenverbrauch gibt es je Zeitraum – wählen Sie Monat oder Jahr.'
          : `Autarkie und Eigenverbrauch liegen für ${label} noch nicht vor.`,
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
// Mobil-Umbau Stufe 2 — die Telefon-Fassung des Cockpits (<= 720 px)
// ---------------------------------------------------------------------------
//
// Abgenommenes Konzept `data/vp-mobile-views-x1` (Sektion „Cockpit", Captain-Go
// 09.08.2026). Der gemessene Befund war Wiederholung, nicht Layout: dieselbe
// Geld-Aussage stand am Telefon VIER Mal auf 550 px (Hero-Zahl 788 px,
// Zurechnung 825 px, Kachel „Erlöse" 1226 px, Kachel „Handel" 1333 px), und der
// Fahrplan-Satz zweimal in Folge (Preis-Streifen + Speicher-Fahrplan-Karte).
//
// Alles hier ist REINE Ableitung über schon vorhandene Sichten — es wird nichts
// nachgerechnet und nichts erfunden; die Regeln stehen an EINER Stelle, damit
// Telefon- und Desktop-Fassung nie Verschiedenes behaupten können.

/** Die Kacheln, deren Aussage am Telefon ANDERSWO auf demselben Schirm steht. */
const MOBILE_DEDUPED: ReadonlySet<WidgetId> = new Set<WidgetId>([
  // Die Geld-Karte trägt die Zahl (und die Bottom-Bar seit Stufe 1 den Weg in
  // die Erlöse-Welt) — die Kachel wäre die dritte Kopie derselben Aussage.
  'erloes',
  // „Handel" IST die Steuerungs-Zurechnung, die in der Geld-Karte schon als
  // Unterzeile unter der Zahl steht (MIG §5: nie ein eigener Summand).
  'handel',
  // Das Wetter verliert die eigene Kachel; sein EINER erklärender Satz reist
  // als Notiz in der Fahrplan-Zeile — und nur dann, wenn er etwas erklärt.
  'wetter',
]);

/**
 * Das Widget-Raster der Telefon-Fassung: dieselben Kacheln, minus die, deren
 * Aussage auf demselben Bildschirm schon steht (P2 „eine Wahrheit steht einmal
 * auf dem Schirm").
 *
 * **Die Kachel-Maschine BLEIBT** — Modus-Kacheln wie Lastspitze und
 * Geräte-Automatik tragen ihre eigene Aussage und werden nie entfernt.
 *
 * `hasRings` ist die eine bedingte Regel: die Eigenverbrauchs-Kachel führt
 * „Autarkie heute", und genau das steht als Ring-Chip in der Geld-Karte —
 * **aber nur, wenn es dort wirklich einen Ring gibt** (unter „Gesamt" gibt es
 * keinen, dann ist die Kachel der einzige Träger und bleibt).
 */
export function mobileWidgets(widgets: WidgetDef[], opts: { hasRings: boolean }): WidgetDef[] {
  return widgets.filter((w) => {
    if (MOBILE_DEDUPED.has(w.id)) return false;
    if (w.id === 'eigenverbrauch' && opts.hasRings) return false;
    return true;
  });
}

/* ⚠ `HeroChip`/`heroChips` sind mit P5 ERSATZLOS entfallen (Konzept
   `vp-erloese-lesbar-konzept-u3` §3.7): die Telefon-Geld-Karte trug die zwei
   Ring-Kennzahlen als CHIPS, während die Bühne dieselbe Zahl als Ring zeigte —
   eine Kennzahl in zwei Formen (Befund B7). Seit dem C-Kleid rendern beide
   Breiten dasselbe Bauteil mit denselben Ringen und 14-px-Labels. */

/** Eine Zeile der Telefon-Fassung: EINE Aussage + ein Absprung. */
export interface MobileRow {
  /** Die Aussage (fett, erste Zeile). */
  head: string;
  /** Die ruhige zweite Zeile; null = keine. */
  sub: string | null;
  /**
   * Die bestätigte Ausführung als eigene Zeile mit Haken (V-04:
   * `control.steuerungKurz`); absent = keine.
   */
  status?: string | null;
}

/**
 * Die Fahrplan-ZEILE der Telefon-Fassung (statt Hero-Satz + Speicher-Karte, die
 * am Telefon denselben Satz zweimal in Folge zeigten).
 *
 * `sentence` ist die schon abgeleitete Erzählzeile (`speicherKurzzeile` bzw.
 * `planSentence`) — hier wird sie NICHT neu gebaut. Die Unterzeile trägt den
 * geplanten Vorteil und, NUR wenn er etwas erklärt, den Wetter-Satz
 * (`weather.weatherWhy`); ohne beides bleibt sie weg statt leer dazustehen.
 *
 * null = kein Fahrplan-Satz ⇒ der Aufrufer zeigt seinen ehrlichen Leerzustand.
 */
export function fahrplanZeile(input: {
  sentence: string | null;
  /** Der geplante Vorteil in Euro (`savingsTodayEur`); null = keine Zahl. */
  savedEur?: number | null;
  /** Der Wetter-Satz (`weatherWhy`); null = er erklärt gerade nichts. */
  weatherWhy?: string | null;
  /** Formatierer für den Betrag (der Aufrufer reicht `eurAmount` durch). */
  eur: (v: number) => string;
}): MobileRow | null {
  if (!input.sentence) return null;
  const parts: string[] = [];
  const saved = num(input.savedEur);
  // Dieselbe Schwelle wie die Speicher-Fahrplan-Karte: unter einem halben Cent
  // ist „Vorteil" keine Aussage, sondern Rauschen.
  if (saved != null && saved > 0.005) parts.push(`Heute geplant: +${input.eur(saved)}`);
  if (input.weatherWhy) parts.push(input.weatherWhy);
  return { head: input.sentence, sub: parts.length > 0 ? parts.join(' · ') : null };
}

/**
 * Die Börsenpreis-ZEILE der Telefon-Fassung (statt des vollen Streifens mit
 * 24-h-Kurve, Ankern und Notizen — die wohnen auf der Marktpreise-Seite, die
 * seit Stufe 1 einen Daumen entfernt in der Bottom-Bar sitzt).
 *
 * Alles kommt fertig formatiert aus `strompreis.ts` — hier wird nur komponiert.
 * null = keine heutigen Preise ⇒ der Aufrufer zeigt den Leerzustand bzw. gar
 * nichts.
 */
export function preisZeile(input: {
  /** „11,9 ct/kWh" des laufenden Slots; null = kein Preis. */
  jetztWert: string | null;
  /** „Negativpreis"/„günstig"/… ; null = kein Urteil. */
  urteilLabel: string | null;
  /** „Ihr Bezugspreis jetzt: 32,5 ct/kWh" — der Wert; null = kein Tarif. */
  bezug?: string | null;
  /** Server-backed breakdown of the import price. */
  bezugDetail?: string | null;
  /** Visible warning when imports are only valued at bare spot. */
  tarifWarnung?: string | null;
  /** „Tageshoch 13,6 ct (19:45)"; null = flacher Tag. */
  hoch?: string | null;
}): MobileRow | null {
  if (!input.jetztWert) return null;
  const head = input.urteilLabel
    ? `Börsenpreis ${input.jetztWert} · ${input.urteilLabel}`
    : `Börsenpreis ${input.jetztWert}`;
  const parts: string[] = [];
  if (input.bezug) {
    const detail = input.bezugDetail ? ` ${input.bezugDetail}` : '';
    parts.push(`Ihr Bezugspreis jetzt ${input.bezug}${detail}`);
  }
  if (input.tarifWarnung) parts.push(input.tarifWarnung);
  if (input.hoch) parts.push(input.hoch);
  // These are complete facts, not a tag cloud. Sentence punctuation keeps a
  // wrapped mobile line from beginning with a stranded middle dot.
  const sub =
    parts.length > 0
      ? `${parts.map((part) => part.replace(/[.\s]+$/, '')).join('. ')}.`
      : null;
  return { head, sub };
}

/** Die geschrumpfte Kopfzeile beim Scrollen (Konzept: die zwei Anker). */
export interface StickyHead {
  /** „10,60 €"; null = diese Anlage hat keine Geld-Zahl. */
  value: string | null;
  /** „Verdient · Heute"; null ohne Zahl. */
  label: string | null;
  /** Der Zustands-Satz der Anlage; null = noch keiner. */
  status: string | null;
  tone: 'ok' | 'warn' | 'off';
}

/**
 * Der Kopf, der beim Scrollen stehen bleibt: die verdiente Zahl und der
 * Zustand — die zwei Anker, die der Kunde beim Weiterscrollen behalten soll.
 *
 * Es wird **nichts Neues abgeleitet**: die Zahl ist die des Hero, der Satz ist
 * derselbe `composeSiteSentence`-Satz wie im Seitenkopf (der am Telefon in die
 * Topbar gewandert ist). Ohne beides gibt es keinen Kopf — ein Streifen, der
 * nur sich selbst trägt, kostet nur Platz.
 */
export function stickyHead(input: {
  money: HeroMoney | null;
  status: { text: string; tone: 'ok' | 'warn' | 'off' } | null;
}): StickyHead | null {
  const money = input.money;
  const status = input.status;
  // V-04: ein GUTER Zustand steht am Telefon schon in der Kopfleiste
  // („● Alles in Ordnung"); hier gekürzt („Alles läuft. Ihre Anlage …") war er
  // nur Rauschen. Die Leiste nennt ihn deshalb nur, wenn er etwas meldet.
  const meldet = status != null && status.tone !== 'ok' ? status : null;
  if (!money && !meldet) return null;
  return {
    value: money?.value ?? null,
    label: money?.label ?? null,
    status: meldet?.text ?? null,
    tone: meldet?.tone ?? 'off',
  };
}

// ---------------------------------------------------------------------------

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}
