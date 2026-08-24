/**
 * M3 — das **Cockpit als Modul-Stapel** ("Projektion", OpenProject #531,
 * Epic #527; Spec `data/vp-anlagen-face-k9/report.md` §1.3/§2.2/§3/§6 +
 * `feedback.md`).
 *
 * Die Übersicht einer Anlage ist keine feste Zonen-Anordnung mehr, sondern die
 * gerenderte **Projektion**: `surface = base(entities) ∪ ⋃ module(m)`. Dieses
 * Modul übersetzt das M0-Read-Model (`surface.ts`) in einen **deterministisch
 * geordneten Stapel** von Blöcken (§1.3) und leitet die beiden NEUEN Blöcke —
 * **Handel** und **Eigenverbrauch** — aus BEREITS vorhandenen Daten ab
 * (Fahrplan-Slots, Earnings, Historie-Totals). Es gibt **keinen neuen
 * Rechenkern**: was nicht messbar ist, bleibt weg — nie eine erfundene Zahl.
 *
 * Rein + deterministisch (der `live.ts`/`erloesKomposition.ts`-Präzedenzfall):
 * kein React, kein Netzwerk. Die Komponenten rendern nur.
 *
 * Drei Regeln aus der Spec sind hier Gesetz:
 *
 * 1. **Blockreihenfolge ist kanonisch** (§1.3, F2) — Status → Peak-Band →
 *    Erlös-Komposition → Energiefluss → Handel → Eigenverbrauch →
 *    Geräte-Automatik → Toolbox-Zeile. Nie €-gewichtet, kein tägliches
 *    Umsortieren, kein Flackern. Die Ordnung kommt aus M0 (`CockpitBlock.order`).
 * 2. **Jeder Block trägt sein „von"-Tag** (§1.1) — der Modus, der ihn
 *    beisteuert; `null` = `base(entities)` („Entitäten"). Die Projektion ist
 *    lesbar, nicht magisch.
 * 3. **Die Tiefen-Sichten sind Drill-ins ihres besitzenden Blocks** (§2.2), und
 *    die **Telemetrie-Historie („Verlauf →") hängt am Energiefluss-Block, also
 *    an `base(entities)`** — in JEDEM Modus vorhanden und sauber getrennt von
 *    der **Erlös-Historie**, die als Drill-in der Erlös-Komposition am
 *    Geld-Modus hängt (feedback.md Punkt 2). Ein Modus darf die
 *    Telemetrie-Historie NIE beanspruchen.
 *
 * **Routen-Hinweis (bewusst, keine Nav-Änderung):** es gibt keine eigene
 * Telemetrie-Historie-Route — der Kanal-Verlauf IST der „Verlauf"-Teil der
 * Live-Seite (`#/anlage/{id}/live`, `TelemetryChart` mit Fenster-Umschalter).
 * Der Drill-in zeigt deshalb dorthin, mit eigenem Label („Verlauf"), während
 * die Erlös-Historie auf `#/anlage/{id}/historie` zeigt. So bleiben `nav.ts`
 * und die M1-Shell unangetastet und die beiden Historien trotzdem getrennt.
 *
 * **Der v1-Zonen-Dashboard-Zweig ist ENTFALLEN (Captain-Nachtrag 06.08.2026,
 * `fm/vp-erst-alt-layout-r5`).** Die frühere Weiche (`projectionActive` als
 * "Stapel ODER v1-Rückfall") entschied, BEVOR ihre Eingaben geladen waren -
 * das erzeugte das sichtbare "erst die alte Ansicht, dann der Stapel". Die
 * Anlagen-Seite kennt seither drei, nicht zwei Zustände: siehe `anlageDecision`
 * unten. Ein Modul-Stapel ODER der ehrliche "nicht zugeordnet"-Endzustand -
 * nie mehr ein Ersatz-Layout, das gleich wieder verschwindet.
 */

import type { CockpitMoney } from './api';
import { ctPerKwh, eurAmount, fmtNum } from './format';
import type { AnlagenSub } from './nav';
import { chargeKind, todaySlots, SLOT_DEADBAND_KW } from './schedule';
import type { ActiveMode, CockpitBlock, CockpitBlockId } from './surface';

// ---------------------------------------------------------------------------
// Der Stapel
// ---------------------------------------------------------------------------

/** Ein Drill-in eines Blocks in seine Tiefen-Sicht (§2.2). */
export interface BlockDrillIn {
  sub: AnlagenSub;
  label: string;
  /** Optionale Abgrenzung, sichtbar im UI (Telemetrie ≠ Erlös). */
  hint?: string;
}

/** Ein render-fertiger Block des Stapels. */
export interface CockpitBlockView {
  id: CockpitBlockId;
  title: string;
  /** Das sichtbare „von"-Tag: der beitragende Modus bzw. „Entitäten". */
  fromTag: string;
  /** true = base(entities), kein Modus. */
  isBase: boolean;
  drillIns: BlockDrillIn[];
  /** true = dieser Block führt das Cockpit (peak → money → flow). */
  lead: boolean;
}

/**
 * Das „von"-Tag eines base-Blocks — die Komponenten der Anlage steuern ihn bei,
 * kein Modus. Kundensprache (D3): „Komponenten", nie „Entitäten" (M7).
 */
export const BASE_FROM_TAG = 'Komponenten';

/**
 * Die **Telemetrie-Historie** als BASIS-Drill-in (feedback.md Punkt 2): der
 * Verlauf ALLER angelegten Telemetriekanäle — inklusive frei gemappter
 * Modbus-Kanäle (MB-M1) — hängt an den Entitäten, nicht an einem Geld-Modus,
 * und ist deshalb in jedem Modus vorhanden.
 */
export const TELEMETRIE_HISTORIE: BlockDrillIn = {
  // Seit der Zwei-Welten-Struktur (Captain H1) ist das die Messwerte-Welt; der
  // Explorer ist ihr aufklappbarer Abschnitt (`?m=…` öffnet ihn vorfokussiert).
  sub: 'messwerte',
  label: 'Verlauf',
  hint: 'Telemetrie-Verlauf aller angelegten Kanäle – getrennt von den Erlösen.',
};

/** Die Drill-ins je Block (§2.2) — die Tiefen-Sichten der abgelösten Tab-Leiste. */
const BLOCK_DRILL_INS: Partial<Record<CockpitBlockId, BlockDrillIn[]>> = {
  'peak-band': [{ sub: 'lastspitzen', label: 'Lastspitzen im Detail' }],
  'lade-budget': [{ sub: 'ladevorgaenge', label: 'Ladevorgänge' }],
  'erloes-komposition': [
    {
      sub: 'erloese',
      label: 'Erlöse im Detail',
      hint: 'Die Erlöse-Welt – getrennt vom Telemetrie-Verlauf.',
    },
  ],
  // base: die Live-Tiefe lebt seit dem Merge IM Cockpit selbst (Komponenten-
  // Board); als Drill-in bleibt der Kanal-Verlauf (Telemetrie-Historie).
  energiefluss: [TELEMETRIE_HISTORIE],
  handel: [{ sub: 'fahrplan', label: 'Ganzer Fahrplan' }],
  eigenverbrauch: [{ sub: 'fahrplan', label: 'Ganzer Fahrplan' }],
  'geraete-automatik': [{ sub: 'steuerung', label: 'Steuerung' }],
};

/**
 * Der Status-Block wird vom **Seitenkopf** gerendert (Name, Status-Punkt, der
 * eine deutsche Satz, Badges) — er ist kein eigener Kartenblock. Er bleibt im
 * M0-Read-Model, damit die Reihenfolge vollständig bleibt, und wird hier
 * herausgefiltert.
 */
const HEAD_BLOCKS: CockpitBlockId[] = ['status'];

/** Die Toolbox-Zeile ist kein Kartenblock, sondern die ruhige Schlusszeile. */
const FOOTER_BLOCKS: CockpitBlockId[] = ['toolbox-pointer'];

/**
 * Der Modul-Stapel: die M0-Blöcke in ihrer kanonischen Reihenfolge, jeweils mit
 * „von"-Tag und Drill-ins, ohne Kopf- und Fußzeilen-Blöcke. Der führende Block
 * (peak → money → flow) ist markiert; die REIHENFOLGE ändert sich dadurch
 * nicht — die Führung ist eine Betonung, kein Umsortieren.
 */
export function cockpitStack(
  blocks: CockpitBlock[] | null | undefined,
  leadId: CockpitBlockId | null,
): CockpitBlockView[] {
  return (blocks ?? [])
    .filter((b) => !HEAD_BLOCKS.includes(b.id) && !FOOTER_BLOCKS.includes(b.id))
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((b) => ({
      id: b.id,
      title: b.title,
      fromTag: b.from ?? BASE_FROM_TAG,
      isBase: b.from == null,
      drillIns: BLOCK_DRILL_INS[b.id] ?? [],
      lead: b.id === leadId,
    }));
}

/** Enthält der Stapel diesen Block? */
export function hasBlock(blocks: CockpitBlock[] | null | undefined, id: CockpitBlockId): boolean {
  return (blocks ?? []).some((b) => b.id === id);
}

/**
 * Das Stapel-Kriterium (ehem. "der v1-Rückfall-Riegel", report §6.2): der
 * Modul-Stapel erscheint erst, wenn die Anlage wirklich migriert ist —
 * Entitäten vorhanden UND die bestehende Topologie-Weiche (`useAdaptiveLive`/
 * `hasTopology`) offen. **Beide Tore müssen offen sein.**
 *
 * Seit dem Wegfall des v1-Zonen-Dashboards (Captain-Nachtrag 06.08.2026, siehe
 * `anlageDecision` unten) entscheidet dieses Kriterium NICHT mehr zwischen
 * „Stapel" und „altes Layout" — es entscheidet zwischen „Stapel" (§6.2:
 * `projectionActive` true) und dem ehrlichen Endzustand „nicht zugeordnet"
 * (Anlage misst, aber ohne Komponenten). `false`/`null`/`undefined` heißt hier
 * also NICHT mehr automatisch "un-migriert" — es heißt nur "kein Stapel", und
 * `anlageDecision` entscheidet, was daraus für die Anzeige folgt (nie ohne
 * geladene Eingaben, siehe dort).
 */
export function projectionActive(input: {
  hasEntities: boolean | null | undefined;
  adaptive: boolean | null | undefined;
}): boolean {
  return input.hasEntities === true && input.adaptive === true;
}

// ---------------------------------------------------------------------------
// Die Lade-/Fehler-Weiche (Captain-Nachtrag 06.08.2026)
// ---------------------------------------------------------------------------

/**
 * Der DREIWERTIGE Render-Entscheid der Anlagen-Seite — der eigentliche Fix
 * des "erst zeigt das Portal die alte Ansicht"-Defekts: die frühere Weiche
 * entschied `projectionActive`, BEVOR ihre Eingaben (`/entities`, `/topology`,
 * die Übersichts-Zeile) geladen waren — während des Ladens war `hasEntities`/
 * `adaptive` schlicht `false`, also rendete die Seite den (heute entfernten)
 * v1-Zweig, bis die Abrufe landeten und auf den Stapel umgebaut wurde. Der
 * Fehler war die fehlende Unterscheidung zwischen „nicht migriert" und „noch
 * nicht bekannt".
 *
 * `anlageDecision` macht diese Unterscheidung explizit:
 *  - `'pending'`  — die Entscheidungs-Eingaben laufen noch. Es wird KEIN
 *    Layout gewählt (weder Stapel noch der Nicht-zugeordnet-Zustand) — der
 *    Aufrufer zeigt einen ruhigen Zwischenzustand.
 *  - `'error'`    — ein entscheidungskritischer Abruf ist fehlgeschlagen ODER
 *    die Frist ist überschritten (`timedOut` — kein Dauer-Spinner). Ein
 *    Fehlschlag wird wie „fertig" behandelt: kein endloses Warten, sondern der
 *    ehrliche Fehlerzustand mit Wiederholen.
 *  - `'stack'`    — geladen, `projectionActive` true: der Modul-Stapel.
 *  - `'unassigned'` — geladen, `projectionActive` false: die Anlage hat
 *    (potenziell) noch nie Komponenten zugeordnet bekommen. Der Aufrufer prüft
 *    zusätzlich `setupPathActive` (die Anlage hat NIE Daten geliefert) — trifft
 *    das zu, gewinnt der Einrichtungspfad (M5); sonst der ehrliche
 *    „nicht zugeordnet"-Endzustand (Anlage MIT Daten, ohne Komponenten - die
 *    Lücke, die der frühere v1-Zweig stillschweigend gefüllt hat).
 *
 * `timedOut` gewinnt IMMER (auch während `loading` noch true ist) - die knappe,
 * begründete Frist verhindert den Dauer-Spinner.
 */
export type AnlageDecision = 'pending' | 'error' | 'stack' | 'unassigned';

export interface AnlageDecisionInput {
  /** Laufen die Entscheidungs-Eingaben noch (Entitäten/Topologie/Übersicht)? */
  loading: boolean;
  /** Ist mindestens ein entscheidungskritischer Abruf fehlgeschlagen? */
  failed: boolean;
  /** Wurde die knappe Lade-Frist überschritten? Gewinnt vor `loading`. */
  timedOut: boolean;
  hasEntities: boolean | null | undefined;
  adaptive: boolean | null | undefined;
}

export function anlageDecision(input: AnlageDecisionInput): AnlageDecision {
  if (input.timedOut) return 'error';
  if (input.loading) return 'pending';
  if (input.failed) return 'error';
  return projectionActive(input) ? 'stack' : 'unassigned';
}

/** Die ruhige Toolbox-Zeile (§1.3) — nennt NIE einen bestimmten Modus. */
export const TOOLBOX_POINTER = 'Ihre Anlage kann mehr';
export const TOOLBOX_ACTION = 'Anwendung hinzufügen';

// ---------------------------------------------------------------------------
// Handel-Block (iff Markt-Modus) — aus BESTEHENDEN Daten
// ---------------------------------------------------------------------------

/** Eine Kennzahl des Handel-/Eigenverbrauchs-Blocks. */
export interface BlockTile {
  label: string;
  /** Der Wert; null = nicht berechenbar → die Kachel entfällt (nie eine 0). */
  value: string;
  /** Ruhige Detailzeile unter dem Wert. */
  sub: string | null;
  /** Farb-Kanal (die `--vp-flow-*`-Token) für den Akzent. */
  hue: 'pv' | 'batt' | 'grid' | 'load';
}

export interface HandelBlockView {
  tiles: BlockTile[];
  /** Das Marktprämien-Kleingedruckte; null = kein anzulegender Wert hinterlegt. */
  praemieNote: string | null;
  /** true = es gibt nichts Ehrliches zu zeigen → Block entfällt. */
  isEmpty: boolean;
}

export const MARKTPRAEMIE_NOTE =
  'zzgl. Marktprämie: anzulegender Wert minus Monatsmarktwert Solar; entfällt bei negativen Preisen.';

/** Die Fahrplan-Felder, die die Block-Ableitungen brauchen. */
export interface CockpitSlot {
  start: string;
  batteryKw: number | null;
  gridKw: number | null;
  pvKw?: number | null;
  curtailKw?: number | null;
  priceEurMwh?: number | null;
}

export interface PlanWindow {
  from: Date;
  to: Date;
  /** Energie (kWh) — gewichtet die Preis-Mittelung und wählt das dominante Fenster. */
  energy: number;
  /** Energiegewichteter Mittelpreis (EUR/MWh); null ohne Preisdaten. */
  avgPriceEurMwh: number | null;
}

/**
 * Zusammenhängende Lade- bzw. Entladefenster des heutigen Plans, energie- und
 * preisgewichtet. Bewusst hier abgeleitet (statt `schedule.ts` zu öffnen): die
 * Regel, WAS ein Ladefenster ist, kommt aus dem geteilten `chargeKind`.
 */
export function planWindows(
  slots: CockpitSlot[],
  dir: 'laden' | 'entladen',
  now: Date,
  slotMinutes = 15,
): PlanWindow[] {
  const sorted = [...todaySlots(slots, now)].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  const maxGapMs = (2 * slotMinutes + 1) * 60_000;
  const windows: PlanWindow[] = [];
  let current: (PlanWindow & { priceEnergy: number; pricedEnergy: number }) | null = null;
  for (const s of sorted) {
    const kind = chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw);
    if (kind === 'ruhe') continue;
    const slotDir = kind === 'entladen' ? 'entladen' : 'laden';
    if (slotDir !== dir) {
      current = null;
      continue;
    }
    const start = new Date(s.start);
    const end = new Date(start.getTime() + slotMinutes * 60_000);
    const energy = (Math.abs(Number(s.batteryKw ?? 0)) * slotMinutes) / 60;
    const price = s.priceEurMwh == null ? null : Number(s.priceEurMwh);
    if (current && start.getTime() - current.to.getTime() <= maxGapMs) {
      current.to = end;
      current.energy += energy;
      if (price != null && Number.isFinite(price)) {
        current.priceEnergy += price * energy;
        current.pricedEnergy += energy;
      }
    } else {
      current = {
        from: start,
        to: end,
        energy,
        avgPriceEurMwh: null,
        priceEnergy: price != null && Number.isFinite(price) ? price * energy : 0,
        pricedEnergy: price != null && Number.isFinite(price) ? energy : 0,
      };
      windows.push(current);
    }
  }
  for (const w of windows as (PlanWindow & { priceEnergy: number; pricedEnergy: number })[]) {
    w.avgPriceEurMwh = w.pricedEnergy > 0 ? w.priceEnergy / w.pricedEnergy : null;
  }
  return windows.filter((w) => w.energy > (SLOT_DEADBAND_KW * slotMinutes) / 60);
}

/** Das energiereichste Fenster einer Richtung; null wenn es keins gibt. */
export function dominantWindow(windows: PlanWindow[]): PlanWindow | null {
  return windows.reduce<PlanWindow | null>(
    (best, w) => (best == null || w.energy > best.energy ? w : best),
    null,
  );
}

/** "02–05 Uhr" — Start abgerundet, Ende auf die volle Stunde aufgerundet. */
export function windowHours(w: PlanWindow): string {
  const startH = w.from.getHours();
  const endRaw = w.to.getMinutes() > 0 ? w.to.getHours() + 1 : w.to.getHours();
  const endH = endRaw === 0 ? 24 : endRaw;
  const pad = (h: number) => String(h).padStart(2, '0');
  return `${pad(startH)}–${pad(endH)} Uhr`;
}

/**
 * Der **Handel-Block** (§3, Ausprägung Marktvermarktung): was der Handel heute
 * eingebracht hat, wann geladen wurde und wann verkauft wird. Alle drei
 * Kacheln lesen aus bestehenden Feldern (`savedEur`/`arbitrageEur` +
 * Fahrplan-Slots); eine Kachel ohne Datengrundlage entfällt ersatzlos.
 */
export function handelBlock(input: {
  money: CockpitMoney | null;
  slots: CockpitSlot[];
  now: Date;
  slotMinutes?: number;
  /** Etikett des gewählten Zeitraums ("Heute" / "Juli"). */
  periodLabel: string;
}): HandelBlockView {
  const tiles: BlockTile[] = [];
  const saved = numOrNull(input.money?.savedEur);
  if (saved != null) {
    const arbitrage = numOrNull(input.money?.arbitrageEur);
    tiles.push({
      // V3 (Audit): NIE zweimal dasselbe Etikett mit zwei Zahlen auf einem
      // Bildschirm. Der Hero sagt „Verdient · Juli" = `gesamtertragEur`; DIESE
      // Kachel ist `savedEur`, also die Zurechnung zur Steuerung - genau das,
      // was der Hero darunter schon ausschreibt („davon X € durch VoltPilots
      // Steuerung"). Also heißt sie auch so.
      label: `Durch Steuerung · ${input.periodLabel}`,
      value: eurAmount(saved),
      sub: arbitrage != null ? `davon Arbitrage ${eurAmount(arbitrage)}` : null,
      hue: 'grid',
    });
  }

  const slotMinutes = input.slotMinutes ?? 15;
  const charge = dominantWindow(planWindows(input.slots, 'laden', input.now, slotMinutes));
  if (charge) {
    tiles.push({
      label: 'Geladen',
      value: windowHours(charge),
      sub:
        charge.avgPriceEurMwh != null
          ? `Ø ${ctPerKwh(charge.avgPriceEurMwh)}`
          : null,
      hue: 'batt',
    });
  }
  const discharge = dominantWindow(planWindows(input.slots, 'entladen', input.now, slotMinutes));
  if (discharge) {
    tiles.push({
      label: 'Verkauf geplant',
      value: windowHours(discharge),
      sub:
        discharge.avgPriceEurMwh != null
          ? `Ø ${ctPerKwh(discharge.avgPriceEurMwh)} erwartet`
          : null,
      hue: 'pv',
    });
  }

  return {
    tiles,
    praemieNote: numOrNull(input.money?.anzulegenderWertCtKwh) != null ? MARKTPRAEMIE_NOTE : null,
    isEmpty: tiles.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Eigenverbrauchs-Block (iff EV-Modus) — aus BESTEHENDEN Daten
// ---------------------------------------------------------------------------

export interface EigenverbrauchBlockView {
  tiles: BlockTile[];
  isEmpty: boolean;
}

/**
 * Der **Eigenverbrauchs-Block** (§3, Ausprägung Privat-EMS): Autarkie,
 * PV-Nutzung und wie weit der Speicher trägt. Autarkie/PV-Nutzung kommen aus
 * den **bestehenden** Historie-Totals des Tages (`autarkiePct`/
 * `eigenverbrauchPct`, seit der Historie-Auslieferung serverseitig gerechnet);
 * „reicht bis" liest das letzte NOCH BEVORSTEHENDE Entlade-Slot des heutigen
 * Fahrplans. Jede Kachel ohne Grundlage entfällt — nie ein erfundenes „0 %".
 */
export function eigenverbrauchBlock(input: {
  autarkiePct: number | null | undefined;
  eigenverbrauchPct: number | null | undefined;
  slots: CockpitSlot[];
  now: Date;
  gridImportKwh?: number | null;
  slotMinutes?: number;
}): EigenverbrauchBlockView {
  const tiles: BlockTile[] = [];
  const autarkie = numOrNull(input.autarkiePct);
  if (autarkie != null) {
    const imported = numOrNull(input.gridImportKwh);
    tiles.push({
      label: 'Autarkie heute',
      value: fmtNum(autarkie, '%', 0),
      sub: imported != null ? `${fmtNum(imported, 'kWh')} aus dem Netz` : null,
      hue: 'pv',
    });
  }
  const evQuote = numOrNull(input.eigenverbrauchPct);
  if (evQuote != null) {
    tiles.push({
      label: 'PV selbst genutzt',
      value: fmtNum(evQuote, '%', 0),
      sub: 'Rest gespeichert oder eingespeist',
      hue: 'batt',
    });
  }
  const until = coverUntil(input.slots, input.now, input.slotMinutes ?? 15);
  if (until) {
    tiles.push({
      label: 'Heute Abend',
      value: 'gedeckt',
      sub: `Speicher reicht bis ca. ${until}`,
      hue: 'load',
    });
  }
  return { tiles, isEmpty: tiles.length === 0 };
}

/**
 * Bis wann der Speicher heute laut Plan noch entlädt ("23 Uhr"); null wenn
 * heute kein Entladen mehr ansteht — dann wird auch nichts behauptet.
 */
export function coverUntil(slots: CockpitSlot[], now: Date, slotMinutes = 15): string | null {
  const upcoming = todaySlots(slots, now)
    .filter((s) => new Date(s.start).getTime() + slotMinutes * 60_000 > now.getTime())
    .filter((s) => chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw) === 'entladen')
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  if (upcoming.length === 0) return null;
  const last = upcoming[upcoming.length - 1];
  const end = new Date(new Date(last.start).getTime() + slotMinutes * 60_000);
  const hour = end.getMinutes() > 0 ? end.getHours() + 1 : end.getHours();
  return `${hour === 0 ? 24 : hour} Uhr`;
}

// ---------------------------------------------------------------------------
// Geräte-Automatik (iff Automationen)
// ---------------------------------------------------------------------------

export interface AutomationRow {
  key: string;
  name: string;
  /** Ehrliche Zustands-Zeile — es gibt KEINE €-Zurechnung je Regel (E15). */
  line: string;
}

export const AUTOMATION_LINE = 'Läuft auf Ihrem Gerät.';

/** Eine Zeile je aktiver Automation (report §1.2: ein Modus je Regel). */
export function automationRows(modes: ActiveMode[] | null | undefined): AutomationRow[] {
  return (modes ?? [])
    .filter((m) => m.kind === 'automation')
    .map((m) => ({ key: m.key, name: m.label, line: AUTOMATION_LINE }));
}

// ---------------------------------------------------------------------------

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
