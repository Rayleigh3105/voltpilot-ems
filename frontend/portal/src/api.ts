import { AuthRedirectError, freshToken } from './auth';
import type { SimulationRequestInput, SimulationStatus } from './simulation';
import type { ProfileState, SiteProfiles } from './profiles';
import type { Topology } from './topology';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8090';

/**
 * Anlagentyp of a site: steers the money wording ("mehr verdient" for
 * Direktvermarktung - spot revenue is literal income - vs. "gespart" for
 * Eigenverbrauch - avoided cost).
 */
export type PlantKind = 'direktvermarktung' | 'eigenverbrauch';

/**
 * Electricity tariff art of a site (REPLACES the old fixed strompreis). Steers
 * how self-consumed energy is valued in euros: 'dynamisch' = each self-consumed
 * kWh at its 15-min Börsenpreis + an optional Aufschlag; 'fest' = a single fixed
 * retail price; 'ohne' = no euro value (kWh only, never fabricated).
 */
export type TarifArt = 'dynamisch' | 'fest' | 'ohne';

/**
 * The U0 Kontotyp/Betriebsart shell frame (design vp-ems-ui-overhaul §2):
 * 'endkunde' = single-object cockpit shell (never fleet chrome), 'betreiber' =
 * fleet/portfolio shell. The value is resolved SERVER-side (the explicit
 * tenant override, else null = unknown - the segment is deliberately NOT used,
 * see the api's Betriebsart) - the portal consumes it as-is and never
 * re-derives; null falls back to the pre-U0 site-count heuristic.
 */
export type Betriebsart = 'endkunde' | 'betreiber';

/**
 * The caller's tenant context, read once at login (the U0 bootstrap).
 * `betriebsart` is the EFFECTIVE frame the navigation shell keys on.
 */
export interface TenantContext {
  tenantId: string;
  name: string;
  segment: string;
  /** null = unknown frame -> the shell derives from the site count. */
  betriebsart: Betriebsart | null;
}

export interface Site {
  id: string;
  name: string;
  biddingZone: string;
  latitude: number | null;
  longitude: number | null;
  plantKind: PlantKind;
  /**
   * Anzulegender Wert (ct/kWh) - the plant's fixed EEG reference rate from
   * the EEG award / Direktvermarktungsvertrag; null = not configured. Only
   * relevant for plantKind 'direktvermarktung' - when set, the earnings
   * include the dynamic monthly premium max(0, anzulegender Wert -
   * Monatsmarktwert Solar), suspended in negative-price slots.
   */
  anzulegenderWertCtKwh: number | null;
  /**
   * Electricity tariff art (REPLACES the fixed strompreisCtKwh). 'dynamisch'
   * values self-consumption per 15-min slot at spot + Aufschlag, 'fest' at the
   * fixed price, 'ohne' in kWh only. Defaults to 'ohne'.
   */
  tarifArt: TarifArt;
  /**
   * The tariff parameter (ct/kWh); null = none. The fixed retail price for
   * 'fest', the optional spot-price Aufschlag (grid fees, levies, margin) for
   * 'dynamisch', unused for 'ohne'.
   */
  tarifParamCtKwh: number | null;
  /**
   * Per-site grid-charging switch: false (default) = "Nur Solarladen (EEG)"
   * (the optimizer charges the battery only from PV surplus), true =
   * "Netzladen aktiv" (grid arbitrage). Editable by the site owner and by
   * Portal-Admins (captain revision 2026-07-07); the form carries the
   * Ausschließlichkeitsprinzip warning.
   */
  netzladenErlaubt: boolean;
  /**
   * Static feed-in cap at the grid connection point (Einspeisegrenze am
   * Netzanschlusspunkt, kW > 0); null = no connection-point limit. The
   * optimizer enforces it export-only (FK1).
   */
  maxFeedInKw: number | null;
  /**
   * Leistungspreis (EUR/kW) of a Lastspitzenkappung setup, configured by
   * VoltPilot (admin optimizer-config, Tier 2) - never customer-editable.
   * DEFENSIVELY OPTIONAL: a sibling backend task adds the field; until that
   * ships the API omits it (undefined) and absent/null both read as
   * "not active" (see moduleSurface.ts).
   */
  leistungspreisEurKw?: number | null;
  /**
   * Leistungspreis billing period (PS-1, `site.abrechnung_leistung`):
   * 'jahr' = Jahresleistungspreis, 'monat' = Monatsleistungspreis
   * (Europe/Berlin calendar periods; defaults to 'jahr'). Echoed READ-ONLY
   * here (configured by VoltPilot via optimizer-config, never customer-editable);
   * the backend SiteDto already serves it (migration V20260716020000). Rendered
   * in the Gewerbe/Lastspitzenkappung Modus-Container's "Von VoltPilot
   * eingerichtet"-block (v3.1-M4). DEFENSIVELY OPTIONAL like leistungspreisEurKw
   * - absent/null read fail-soft as "—", never a fabricated period.
   */
  abrechnungLeistung?: 'jahr' | 'monat' | null;
  /**
   * Peak reserve (PS-2, `site.peak_reserve_soc_pct`): the hard SoC floor held
   * back to shave an out-of-horizon peak. Echoed READ-ONLY (configured by
   * VoltPilot via optimizer-config), and DEFENSIVELY OPTIONAL like
   * leistungspreisEurKw - absent/null both read as "no peak reserve", so the
   * SoC reservation stack (M2) simply omits that layer instead of inventing it.
   */
  peakReserveSocPct?: number | null;
}

/**
 * One Anlage's structured supply-price sheet (site_supply_price, report
 * vp-nacht-bezug-e7 §3.1). Components ct/kWh NETTO, all nullable (null =
 * unknown). `present` = a row exists (false => prefill the suggestions);
 * `hasComponents` = the activation gate (>= 1 component maintained), i.e. the
 * optimizer prices import as (spot + Sum Komponenten) x (1+USt) instead of bare
 * spot.
 */
export interface SupplyPrice {
  present: boolean;
  hasComponents: boolean;
  netzentgeltArbeitspreisCt: number | null;
  stromsteuerCt: number | null;
  konzessionsabgabeCt: number | null;
  umlagenCt: number | null;
  vertriebsaufschlagCt: number | null;
  ustPct: number | null;
  /** "Preisblatt gültig ab" (ISO date, JJJJ-MM-TT) or null. */
  komponentenStand: string | null;
  updatedAt: string | null;
}

/**
 * A PATCH body for the supply-price sheet: any subset of the component fields.
 * A field ABSENT keeps its stored value; a field present with a value is
 * written; an explicit `null` clears that component to "unknown". `ustPct` is
 * NOT NULL - a present null is ignored server-side.
 */
export type SupplyPriceUpdate = Partial<{
  netzentgeltArbeitspreisCt: number | null;
  stromsteuerCt: number | null;
  konzessionsabgabeCt: number | null;
  umlagenCt: number | null;
  vertriebsaufschlagCt: number | null;
  ustPct: number | null;
  komponentenStand: string | null;
}>;

export interface CreateSiteInput {
  name: string;
  biddingZone?: string;
  latitude?: number | null;
  longitude?: number | null;
  /** Defaults to 'eigenverbrauch' server-side. */
  plantKind?: PlantKind;
  /** Anzulegender Wert in ct/kWh (>= 0); omit/null = not configured. */
  anzulegenderWertCtKwh?: number | null;
  /** Electricity tariff art; omitted = 'ohne'. */
  tarifArt?: TarifArt;
  /** Tariff parameter in ct/kWh (>= 0): fixed price for fest, Aufschlag for dynamisch. */
  tarifParamCtKwh?: number | null;
  /**
   * Grid-charging switch, settable by the site owner and by Portal-Admins.
   * Omitted = the safe default false on create / keep the stored value on
   * update.
   */
  netzladenErlaubt?: boolean;
  /**
   * Static feed-in cap at the grid connection point (kW, strictly positive).
   * Omitted/null = no limit on create / keep the stored value on update
   * (the netzladenErlaubt pattern).
   */
  maxFeedInKw?: number | null;
}

export interface PricePoint {
  ts: string;
  end: string;
  priceEurMwh: number | null;
}

export interface PriceSeries {
  biddingZone: string;
  resolution: string | null;
  currency: string;
  points: PricePoint[];
}

export interface PriceBucket {
  ts: string;
  avgEurMwh: number | null;
  minEurMwh: number | null;
  maxEurMwh: number | null;
}

export interface PriceRangeSummary {
  avgEurMwh: number | null;
  minEurMwh: number | null;
  maxEurMwh: number | null;
  cheapestTs: string | null;
  mostExpensiveTs: string | null;
  count: number;
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface PriceHistory {
  biddingZone: string;
  currency: string;
  /** ISO-8601 duration: PT15M (day), PT1H (week), P1D (month/year). */
  bucket: string;
  from: string;
  to: string;
  buckets: PriceBucket[];
  summary: PriceRangeSummary;
}

export interface WeatherPoint {
  ts: string;
  temperatureC: number | null;
  cloudCoverPct: number | null;
  ghiWM2: number | null;
  dniWM2: number | null;
  dhiWM2: number | null;
}

export interface WeatherForecast {
  runAt: string | null;
  points: WeatherPoint[];
}

export interface ScheduleSlot {
  start: string;
  batteryKw: number | null;
  gridKw: number | null;
  socPct: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
  /**
   * Planned PV curtailment for the slot (kW held back, always >= 0). At
   * negative prices the optimizer curtails feed-in so the plant does not pay
   * to export; the Anlage page surfaces it as a PLAN ("Heute geplant: X kWh
   * abregeln") - whether the plant executes the curtailment is not visible to
   * the cloud today. Null on runs that predate the curtailment column.
   */
  curtailKw: number | null;
  /**
   * PV forecast the slot planned with (kW, `schedule.pv_kw`). Feeds the
   * pv-aware "Laden aus dem Netz" derivation (schedule.ts chargeKind): since
   * FK3 an EEG site may charge solar while the house imports, so cyan needs
   * charge > available PV, not merely charge-while-importing. Null on rows
   * without a persisted PV input (chargeKind then falls back to the old
   * import-based rule).
   */
  pvKw: number | null;
  /**
   * Load (consumption) forecast the slot planned with (kW,
   * `schedule.load_kw`). Rendered together with `pvKw` as the two forecast
   * lines over the Fahrplan bars - they EXPLAIN the plan ("warum hält er
   * abends? da liegt die Nachtlast"). Null on rows without a persisted load
   * input; the line is then simply absent, never a fabricated 0.
   */
  loadKw: number | null;
  /**
   * P3 "Ist-Last": the MEASURED house consumption of this slot (kW) - the
   * quarter-hour mean of `telemetry.load_kw`, i.e. the same quantity `loadKw`
   * forecasts. Present only for slots that already happened (the RUNNING slot
   * carries the mean of the samples measured so far); null for future slots,
   * slots without telemetry and sites that report no load channel - the solid
   * Ist line is then absent, never a fabricated 0. Optional so an older
   * backend simply yields no line.
   */
  measuredLoadKw?: number | null;
  /**
   * The mirror of `measuredLoadKw`: the MEASURED PV production of this slot
   * (kW) - the quarter-hour mean of `telemetry.pv_power_kw`, i.e. the same
   * quantity `pvKw` forecasts, aggregated in the same pass. It makes the PV
   * forecast error visible and the Solarladen-Regel ("Laden <= gemessene PV")
   * checkable in the chart. Null for future slots, slots without telemetry and
   * sites whose device reports no PV channel - the solid PV-Ist line is then
   * absent, never a fabricated 0. Optional so an older backend simply yields
   * no line.
   */
  measuredPvKw?: number | null;
  /**
   * The slot's role in the plan (the "Warum"-layer, design report
   * vp-fahrplan-why-design §5.1/§6): abregeln | reserve_halten | warten |
   * pv_speichern | guenstig_laden | spitze_kappen | verkaufen |
   * eigenverbrauch. The vocabulary is additive - unknown ids and null (old
   * rows, pre-feature optimizer) both degrade the Fahrplan to today's view
   * (no phases band, no tap panel), never a fabricated explanation.
   */
  slotRole: string | null;
  /**
   * Binding-constraint codes active in the slot (soc_max, soc_floor,
   * reserve_backup, reserve_peak, charge_cap, discharge_cap, solar_only,
   * grid_limit_14a, feed_in_cap, peak_defining, curtailing). Null = none
   * recorded / pre-feature row.
   */
  slotFlags: string[] | null;
  /**
   * The exact value of a stored kWh at the end of the slot (ct/kWh, rounded
   * to 0.1 ct) - customer copy calls it "Wert gespeicherter Energie". Null on
   * pre-feature rows.
   */
  storedValueCtKwh: number | null;
  /**
   * Effective energy value at the grid connection point (ct/kWh). Present in
   * the contract but deliberately NOT rendered on the customer surface (D3 -
   * admin/installer depth only).
   */
  gridValueCtKwh: number | null;
  /**
   * The slot's share of the Leistungspreis pressure (EUR/kW, peak-shaving
   * module). > 0 = the slot belongs to the Lastspitzenkappung. Null when the
   * module is off or on pre-feature rows.
   */
  peakPressureEurKw: number | null;
  /**
   * P0 "Textwahrheit": what one IMPORTED kWh really costs this site in the
   * slot (ct/kWh) - THE PRICE THE OPTIMIZER DECIDED WITH. `priceEurMwh` is
   * bare spot, which is why a why-sentence built on it contradicts itself in
   * the normal case ("Börsenpreis 21,2 wäre teurer als der Speicherwert 21,5"
   * - while grid power really cost 32,5). Recomposed server-side from spot +
   * the site's tariff/Preisblatt (optimizer/SlotEconomics). Null on older runs
   * / slots without a spot price: the sentence then degrades to a number-free
   * form and NEVER passes spot off as "Netzstrom".
   */
  importPriceCtKwh: number | null;
  /**
   * What one EXPORTED kWh really earns in the slot (ct/kWh): spot + dynamic
   * Marktprämie (Direktvermarktung) or the feste Vergütung (Eigenverbrauch),
   * merchant mode bare spot. Null when not computable.
   */
  exportValueCtKwh: number | null;
  /**
   * Which rule priced the import: `fest` | `preisblatt` | `sammelaufschlag` |
   * `default-flag` | `spot`. A SITE-level fact (identical on every slot of a
   * run); it decides whether the sentence may break the price down into
   * "Börsenpreis X + Netzentgelte/Abgaben Y".
   */
  importPriceSource: string | null;
  /**
   * Duty-Vorschau (PR 4 des Fahrplan-Konzepts): true = in DIESEM Slot führt
   * das Gerät den GEMESSENEN Hausverbrauch nach (Ziel Netz ≈ 0), der Plan-Wert
   * `batteryKw` ist hier also eine Vorhersage und kein fester Befehl.
   * DREIWERTIG: null/absent = gar nicht bewertet (älterer Lauf, Pflicht-
   * Schalter aus), false = bewertet und keine Pflicht. Der Film markiert eine
   * Phase nur bei einem ausdrücklichen true - beide Nicht-true-Zustände zeigen
   * exakt die heutige Ansicht. Optional, damit ein älteres Backend nichts
   * markiert.
   */
  coverLoadFromBattery?: boolean | null;
  /**
   * Der Ladeseiten-Spiegel: true = das Gerät begrenzt die Ladung auf den
   * GEMESSENEN Solar-Überschuss, weil Zukauf in dieser Viertelstunde
   * unwirtschaftlich wäre. Dieselbe Dreiwertigkeit wie
   * `coverLoadFromBattery`.
   */
  chargeFromSurplusOnly?: boolean | null;
}

export interface SchedulePlan {
  planId: string | null;
  deviceId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  savingsEur: number | null;
  /**
   * Value of the energy the plan banks into (positive) or draws out of
   * (negative) the horizon - the run's terminal value per stored kWh times the
   * SoC swing. Makes savingsEur honest on bank days (storing into tomorrow
   * otherwise reads as negative savings). Null when not computable (runs
   * predating the terminal-value column, no battery asset) - the banked line
   * then stays hidden, never a fabricated 0.
   */
  bankedValueEur: number | null;
  /** Battery SoC at the plan start (what the banked value is measured from). */
  socStartPct: number | null;
  /** Planned SoC at the horizon end. */
  socEndPct: number | null;
  /**
   * The run's planned billing-period grid-import peak target (PS-1,
   * schedule.peak_target_kw): the "Ziel" a Lastspitzen (peak-shaving) Anlage
   * defends. Null when the site runs no peak-shaving module (no Leistungspreis)
   * or on a run predating the column - the Peak-Band then shows no target line,
   * never a fabricated 0.
   */
  peakTargetKw: number | null;
  /**
   * True when this run is the advisory fallback build WITHOUT the §14a grid
   * constraint (it was infeasible) - the device enforces the limit
   * additionally on execution, and the portal's §14a copy says so. Null on
   * pre-feature rows (the why-layer then stays hidden anyway).
   */
  fallback14a: boolean | null;
  slots: ScheduleSlot[];
}

/**
 * Welche LESART des Fahrplans geholt wird (Konzept vp-fahrplan-kunde-konzept
 * §8 „PR 5"):
 *
 * - `latest` (Standard, unverändert): DER Plan — der jüngste Lauf, also das,
 *   was das Gerät gerade ausführt. Jetzt-Held und Diagramm lesen ihn weiter.
 * - `day`: der TAGES-SPLICE „wie der Tag geplant war" — je Viertelstunde des
 *   Berliner Tages der Wert aus dem jüngsten Lauf, der den Slot noch VOR
 *   seinem Beginn geplant hat. Damit kann der Film des Tages die schon
 *   gelaufenen Vormittags-Phasen abhaken. Die lauf-bezogenen Felder (planId,
 *   bankedValueEur, socStartPct/socEndPct, peakTargetKw, fallback14a)
 *   beschreiben EINEN Lauf und sind in dieser Lesart null.
 */
export type ScheduleMode = 'latest' | 'day';

export type HistoryRange = 'day' | 'week' | 'month' | 'year';

export interface HistoryBucket {
  start: string;
  pvKwh: number | null;
  loadKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  batteryChargeKwh: number | null;
  batteryDischargeKwh: number | null;
  socMinPct: number | null;
  socMaxPct: number | null;
  socLastPct: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
}

/**
 * Period aggregates of a history window. The field types mirror
 * `HistoryTotalsDto` EXACTLY - which matters, because the four energy sums are
 * server-side **nullable** ("— nie eine erfundene 0", audit V2/X1) while this
 * interface used to declare them `number`, so every consumer believed a sum was
 * always present.
 */
export interface HistoryTotals {
  /** Null when not a single bucket carried the load channel. */
  consumptionKwh: number | null;
  /** Null when not a single bucket carried the PV channel. */
  pvGenerationKwh: number | null;
  /** Null when not a single bucket carried the grid channel. */
  gridImportKwh: number | null;
  /** Null when not a single bucket carried the grid channel. */
  gridExportKwh: number | null;
  /**
   * The real supply cost of the imported energy - since the structured
   * Bezugspreis (Stufe 3) valued with the SAME per-slot import-price
   * composition the optimizer plans with (flat tariff / spot + Aufschlag /
   * (spot + Preisblatt-Komponenten) × (1+USt)); a site without any price data
   * stays at bare spot. Null when nothing is computable in the period.
   * `tarifArt`/`tarifPriced` are the context needed to label it truthfully
   * (audit H8).
   */
  gridCostEur: number | null;
  /** The site's configured tariff kind; null only when unreadable. */
  tarifArt: TarifArt | null;
  /**
   * Whether `gridCostEur` is valued beyond bare spot (tariff parameter,
   * maintained Preisblatt, or the platform default-components flag): true =
   * "bewertet zu Ihrem Stromtarif", false = "zu Börsenpreisen". Optional so an
   * older backend degrades to the spot label, never an over-claim.
   */
  tarifPriced?: boolean | null;
  /**
   * The EX-ANTE **planned** battery saving from the persisted optimizer runs -
   * NOT measured money (the measured counterpart is `savedEur` on
   * `GET /api/v1/earnings`, and the two legitimately differ by a large factor).
   * Null when no plan covers any slot. Any surface rendering it MUST say
   * "geplant" (audit H3/X2) - hence the field name.
   *
   * The backend also still ships the deprecated `batterySavingsEur` alias for
   * one release; it is deliberately absent here so no new reader can appear.
   */
  batterySavingsPlannedEur: number | null;
  autarkiePct: number | null;
  eigenverbrauchPct: number | null;
}

export type ProtocolEventType =
  | 'batterie-laden'
  | 'batterie-entladen'
  | 'pv-spitze'
  | 'preis-tief'
  | 'preis-hoch';

export interface ProtocolEvent {
  type: ProtocolEventType;
  start: string;
  end: string;
  /** Plain-German event description, server-formatted. */
  text: string;
  energyKwh: number | null;
  avgPriceEurMwh: number | null;
  avoidedCostEur: number | null;
  peakKw: number | null;
}

export interface HistoryPlanPoint {
  time: string;
  batteryKw: number | null;
  socPct: number | null;
}

/**
 * Die Arten der Ereignis-Spur (F6). **Offen behandeln:** eine unbekannte Art
 * aus einem neueren Backend wird von `historieEreignisse.ts` übersprungen statt
 * geraten — ein Marker ohne Bedeutung wäre schlimmer als keiner.
 */
export type HistoryEventType =
  | 'negativpreis'
  | 'abregelung'
  | 'netzgrenze'
  | 'netzladen'
  | 'datenluecke'
  | 'geraet-still';

/**
 * Ein Ereignis im Verlauf (F6) — das Auffällige, das einen Ausreißer im
 * Diagramm ERKLÄRT. Anders als `protocol` (nur Tag, die gewöhnlichen
 * Ereignisse eines Tages) gibt es diese Spur in JEDEM Zeitraum.
 *
 * **`text` trägt die Aussage OHNE Zeitangabe** — die Zeit steht in
 * `start`/`end` und wird zeitraumgerecht davor gesetzt (`historieEreignisse.ts`
 * `ereignisSpur`). `end` ist exklusiv.
 */
export interface HistoryEvent {
  type: HistoryEventType;
  start: string;
  end: string;
  text: string;
}

/**
 * Wie vollständig der Zeitraum GEMESSEN ist (F4/P7 des Historie-Konzepts) —
 * aus einer eigenen billigen Abfrage auf dem 15-Minuten-Rollup, unabhängig von
 * der Reihe. Gezählt werden **Viertelstunden** (`resolutionMinutes`), nicht
 * Anzeige-Buckets: so entsteht die Messreihe, egal ob die Seite gerade Tage
 * oder Stunden zeichnet.
 *
 * **Absichtlich ohne Prozentsatz:** die Zähler sind die Tatsache, die
 * Formulierung gehört der Oberfläche (`historieZeit.ts` — inklusive der Regel
 * „nie auf 100 % aufrunden"). Optional, damit ein älteres Backend die Fläche
 * nicht bricht: fehlt das Feld, zeigt die Zeit-Leiste keine Abdeckung, statt
 * eine zu behaupten.
 */
export interface HistoryCoverage {
  /** Erste je gemessene Viertelstunde der Anlage („Daten ab …"). */
  firstDataAt: string | null;
  /** Letzte je gemessene Viertelstunde der Anlage. */
  lastDataAt: string | null;
  /** Beginn des Zeitraums, auf den sich die Zähler beziehen. */
  expectedFrom: string;
  /** Ende (exklusiv) desselben Zeitraums. */
  expectedTo: string;
  /** Viertelstunden, die dieser Zeitraum tragen konnte. */
  expectedBuckets: number;
  /** Davon wirklich gemessene Viertelstunden (nie mehr als erwartet). */
  measuredBuckets: number;
  /** Zusammenhängende Fehlstellen darin (0 = durchgehend gemessen). */
  gaps: number;
  /** Länge einer gezählten Einheit in Minuten (15). */
  resolutionMinutes: number;
}

export interface History {
  range: HistoryRange;
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: HistoryBucket[];
  totals: HistoryTotals;
  /** Tagesprotokoll - day range only, else empty. */
  protocol: ProtocolEvent[];
  /** Plan-vs-actual overlay - day range only, else empty. */
  plan: HistoryPlanPoint[];
  /**
   * Datenabdeckung des Zeitraums (F4/P7) — null, wenn die Anlage noch nie eine
   * Viertelstunde gemessen hat; optional für ältere Backends.
   */
  coverage?: HistoryCoverage | null;
  /**
   * Die Ereignis-Spur des Verlaufs (F6) — in JEDEM Zeitraum. **Optional, und
   * das ist load-bearing:** fehlt das Feld (älteres Backend), zeigt die Seite
   * GAR KEINE Spur, statt „keine besonderen Ereignisse" zu behaupten, was
   * niemand geprüft hat.
   */
  events?: HistoryEvent[];
}

/**
 * Prognosequalität (shadow-mode forecasting): which model is live per kind,
 * every model's lifecycle, and the daily error/skill series from the
 * evaluation job. Model ids: load-persistence / pv-physical (Vergleichsmodelle),
 * load-xgb / pv-residual-xgb (lernende Kandidaten, shadow-only until promoted).
 */
export type ForecastModelId =
  | 'load-persistence'
  | 'pv-physical'
  | 'load-xgb'
  | 'pv-residual-xgb';

export interface FeatureImportance {
  feature: string;
  /** Plain-German label, server-provided. */
  label: string;
  weight: number;
}

export interface ForecastModelState {
  model: ForecastModelId;
  kind: 'load' | 'pv';
  /** 'collecting' = challenger still gathering training days (no predictions). */
  status: 'collecting' | 'ready';
  /** Whether the optimizer consumes THIS model's forecasts. */
  active: boolean;
  daysCollected: number | null;
  daysRequired: number | null;
  trainedAt: string | null;
  trainRows: number | null;
  featureImportance: FeatureImportance[];
  updatedAt: string | null;
}

export interface ForecastAccuracyPoint {
  day: string;
  model: ForecastModelId;
  kind: 'load' | 'pv';
  maeKw: number;
  nmaePct: number | null;
  biasKw: number | null;
  /** 1 - mae/mae_baseline; positive = better than the baseline; null for the baseline. */
  skillVsBaseline: number | null;
  nSlots: number;
}

export interface PlanAccuracyPoint {
  day: string;
  plannedCostEur: number | null;
  baselineCostEur: number | null;
  realizedCostEur: number | null;
  nSlots: number;
}

export interface ForecastQuality {
  activeLoadModel: ForecastModelId;
  activePvModel: ForecastModelId;
  models: ForecastModelState[];
  accuracy: ForecastAccuracyPoint[];
  planAccuracy: PlanAccuracyPoint[];
}

export interface Device {
  id: string;
  siteId: string;
  externalRef: string;
  kind: string;
  /** Optional customer-facing label (Bezeichnung); externalRef stays the identity. */
  name: string | null;
  status: string;
  /** Newest telemetry timestamp; null until the first data arrives. */
  lastSeenAt: string | null;
  /** When the device was claimed; drives the waiting-too-long escalation. */
  createdAt: string | null;
}

/** Only type + label are editable; the externalRef is the device's identity. */
export interface UpdateDeviceInput {
  kind?: string;
  name?: string | null;
}

/** Outcome of a device data purge ("Datenaufzeichnungen löschen"). */
export interface DevicePurgeResult {
  deviceId: string;
  /** Raw datapoints removed (derived aggregates are rebuilt, not counted). */
  purgedRows: number;
  /** The purge watermark; older replayed samples are refused from now on. */
  purgedBefore: string;
  /**
   * Whether the purge command reached the device's message channel. False on
   * a broker outage: the cloud data is still gone, the device's local buffer
   * is cleaned up once the command can be delivered.
   */
  deviceNotified: boolean;
}

/** What deleting a site would remove - drives the confirm dialog. */
export interface SiteDeletionPreview {
  deviceCount: number;
  telemetryCount: number;
  telemetryFrom: string | null;
  telemetryTo: string | null;
  forecastCount: number;
  scheduleCount: number;
  weatherCount: number;
}

/** Portal onboarding state derived from telemetry recency. */
export type DeviceLiveStatus = 'online' | 'stale' | 'waiting';

/** A device counts as online when telemetry arrived within this window. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function deviceLiveStatus(d: Device, now: Date = new Date()): DeviceLiveStatus {
  if (!d.lastSeenAt) return 'waiting';
  return now.getTime() - new Date(d.lastSeenAt).getTime() <= ONLINE_WINDOW_MS
    ? 'online'
    : 'stale';
}

/**
 * A device claimed longer ago than this without ever sending data is treated
 * as abnormal (likely a mistyped ID or an offline device) - the portal then
 * escalates the "wartet auf erste Daten" copy to troubleshooting guidance.
 */
export const WAITING_ESCALATION_MS = 15 * 60 * 1000;

/** True when a still-waiting device has waited past {@link WAITING_ESCALATION_MS} since claiming. */
export function deviceWaitedTooLong(d: Device, now: Date = new Date()): boolean {
  if (deviceLiveStatus(d, now) !== 'waiting' || !d.createdAt) return false;
  return now.getTime() - new Date(d.createdAt).getTime() > WAITING_ESCALATION_MS;
}

/** One asset row of a site: optimizer battery params, forecast PV params, registry provenance. */
export interface SiteAsset {
  id: string;
  type: string;
  /**
   * The device that controls this asset. A battery with a null deviceId has no
   * control path - the optimizer plans it but can never publish the plan to the
   * edge, so the portal warns and offers the link editor.
   */
  deviceId: string | null;
  capacityKwh: number | null;
  maxChargeKw: number | null;
  maxDischargeKw: number | null;
  roundtripEfficiencyPct: number | null;
  /**
   * Battery only: the EFFECTIVE "Umgang mit dem Speicher" preset, derived
   * server-side from the stored wear cost - 'aggressiv' | 'ausgewogen' (also
   * for the platform default) | 'schonend', or 'individuell' when an admin
   * configured a custom value. Null for non-battery assets.
   */
  speicherschonung: string | null;
  pvCapacityKwp: number | null;
  moduleCount: number | null;
  azimuthDeg: number | null;
  tiltDeg: number | null;
  commissionedOn: string | null;
  registry: string | null;
  registryUnitId: string | null;
  registryFetchedAt: string | null;
}

/**
 * An additional read-only measurement point of a site (multi-source Anlage). A
 * site with a battery-hybrid inverter PLUS a separate AC-coupled PV records the
 * second PV here as an Erzeuger source; its kWp sums into the aggregate site PV.
 * Read-only by construction (control is always false).
 */
export interface MeasurementPoint {
  id: string;
  role: string;
  label: string | null;
  brand: string | null;
  model: string | null;
  capacityKwp: number | null;
  registryUnitId: string | null;
  control: boolean;
  createdAt: string | null;
  /** v2 entity registry: pilot domain type when this row is a v2 entity (admin-managed). */
  entityType?: string | null;
}

/** Record a new additional Erzeuger source (master data; no second device claim). */
export interface CreateMeasurementPointInput {
  role?: string;
  label?: string;
  brand?: string;
  model?: string;
  capacityKwp?: number;
  registryUnitId?: string;
}

// ---- v2 entities ("Geräte & Entitäten") ----------------------------------

/** Per-entity Soll/Ist verdict (edge-reported Ist vs. cloud registry Soll). */
export type EntitySyncStatus =
  | 'in_sync'
  | 'pending'
  | 'missing_on_device'
  | 'unreported'
  | 'never_pushed';

/** The edge-reported observed Ist of one entity (null = nothing reported). */
export interface EntityObserved {
  health: 'ok' | 'stale' | 'never';
  lastTelemetryAt: string | null;
  channels: string[] | null;
  appliedType: string | null;
  reportedAt: string;
}

/** One v2 entity with its capabilities, guard config and drift verdict. */
export interface SiteEntity {
  id: string;
  entityType: string;
  typeLabel: string;
  role: string;
  label: string | null;
  control: boolean;
  deviceId: string | null;
  capabilities: {
    measure?: { channel: string; unit?: string }[];
    actuate?: { command: string; min?: number; max?: number; modes?: string[] }[];
  } | null;
  guards: {
    limits?: Record<string, number | boolean>;
    failsafe?: { behavior: string };
  } | null;
  syncStatus: EntitySyncStatus;
  observed: EntityObserved | null;
  /** The edge source this entity was adopted from (U2 matcher), else null. */
  edgeSourceId: string | null;
  /**
   * The nameplate (kWp) recorded for an adopted producer — it sums into the
   * plant's total, so the delete dialog can name what is subtracted. Optional:
   * an older backend simply omits it (then the dialog stays generic).
   */
  capacityKwp?: number | null;
  /**
   * true = the pinned edge source is no longer among the device's reported
   * sources (identity churn - offer "Wieder verbinden"); false = pinned +
   * reported; null/absent = no pin, or no local view reported yet (an older
   * backend simply omits the field).
   */
  orphanedPin?: boolean | null;
}

/** The composed registry Soll + the edge's echoed revision. */
export interface EntityRegistryState {
  revision: string;
  composedAt: string;
  deviceId: string | null;
  reportedRevision: string | null;
  reportedAt: string | null;
}

/** One edge-local commissioning item (inverter/source; the U2 adoption source). */
export interface EntityLocalSetup {
  id: string;
  kind: string;
  /** The reported role of a source (pv-generation | grid-meter | consumer), else null. */
  role: string | null;
  brand: string | null;
  /** The reported model (own field since the label stopped carrying it; optional
   *  so an older backend without the field stays type-compatible). */
  model?: string | null;
  /** The operator-given name only - never a brand/model/role concatenation. */
  label: string | null;
  reportedAt: string;
  /** Non-null when a v2 entity was already adopted from this source. */
  adoptedEntityId: string | null;
}

/** The whole "Geräte & Entitäten" surface for a site. */
export interface SiteEntities {
  registry: EntityRegistryState | null;
  entities: SiteEntity[];
  localSetup: EntityLocalSetup[];
  staleOnDevice: string[];
}

// --- AE1 topology read-model (adaptive energy flow + tiles) -------------------

/** One capability of a topology entity: its resolved role + latest live value. */
export interface TopologyCapability {
  channel: string;
  unit: string | null;
  /** Resolved role (pv | storage | consumer | grid); null = unassigned. */
  role: string | null;
  /** The maßgebliche (primary) capability of its role. */
  primary: boolean;
  /** Latest live value; null = unknown (never a fabricated 0). */
  value: number | null;
}

/** One entity as the topology read-model exposes it (camelCase). */
export interface TopologyEntity {
  id: string;
  entityType: string;
  typeLabel: string;
  label: string | null;
  /** storage | producer | meter | consumer (steers the tile/flow semantics). */
  category: string;
  /** ok | stale | never (5-min liveness window). */
  health: string;
  capabilities: TopologyCapability[];
}

/**
 * The Anlagen-Topologie-Read-Model (AE1, GET /sites/{id}/topology): the entity
 * graph + the server-derived role-grouped hub topology the adaptive energy-flow
 * diagram (AE2) renders. A fresh / un-migrated site returns empty entities +
 * empty topology nodes (the caller then falls back to the v1 telemetry view).
 */
export interface SiteTopology {
  schemaVersion: string;
  entities: TopologyEntity[];
  topology: Topology;
}

/** One capability→role assignment (U2 "Rollen & Zuordnung"). Blank role clears. */
export interface TopologyRoleAssignment {
  entityId: string;
  channel: string;
  role: string;
  primary: boolean;
}

/** One active flow touching an entity (U2 strategy chip). */
export interface EntityStrategy {
  flowId: string;
  flowName: string;
}

// --- AE7 usage profile (adaptation axis 2: emphasis) -------------------------

/** Which surfaces a profile makes prominent | secondary | minimal | hidden. */
export interface UsageEmphasis {
  money: string;
  peak: string;
  flow: string;
  devices: string;
}

/** The signals the profile was derived from (transparency). */
export interface UsageProfileSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer: boolean;
  activeStrategyNodeTypes: string[];
  plantKind: string | null;
  hasLeistungspreis: boolean;
}

/**
 * The AE7 Nutzungsprofil read-model (GET /sites/{id}/profile): the EFFECTIVE
 * profile (arbitrage | peak | private), the derived default, the raw override,
 * the emphasis map (which surfaces AE2/AE3 make prominent) and the signals.
 */
export interface SiteUsageProfile {
  usageProfile: string;
  derivedProfile: string;
  override: string | null;
  emphasis: UsageEmphasis;
  signals: UsageProfileSignals;
}

/** One aggregated bucket of one entity channel. */
export interface EntityHistoryBucket {
  start: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  n: number;
}

/** Per-entity channel history (channel name -> bucket series). */
export interface EntityHistory {
  range: HistoryRange;
  from: string;
  to: string;
  bucketMinutes: number;
  channels: Record<string, EntityHistoryBucket[]>;
}

/**
 * Mapped MaStR record for confirmation ("Anlage verknüpfen" step 2). Nothing
 * is persisted until mastrApply; null fields mean "nicht im Register
 * hinterlegt" (e.g. Balkonkraftwerke carry no orientation).
 */
export interface MastrPreview {
  mastrNummer: string;
  kind: 'pv' | 'storage';
  name: string | null;
  status: string | null;
  plantType: string | null;
  powerKw: number | null;
  inverterPowerKw: number | null;
  moduleCount: number | null;
  azimuthLabel: string | null;
  azimuthDeg: number | null;
  tiltLabel: string | null;
  tiltDeg: number | null;
  commissionedOn: string | null;
  storageCapacityKwh: number | null;
  chargePowerKw: number | null;
  batteryTechnology: string | null;
  plz: string | null;
  ort: string | null;
  linkedUnitNumber: string | null;
  warnings: string[];
}

/** Manual battery master data + optional controlling-device link. */
export interface SaveBatteryInput {
  capacityKwh: number;
  maxChargeKw: number;
  maxDischargeKw: number;
  roundtripEfficiencyPct?: number | null;
  /** The controlling device; omit to auto-link the site's single device. */
  deviceId?: string | null;
  /**
   * "Umgang mit dem Speicher" preset (FK4), mapped server-side onto the
   * battery's wear cost. Omit to keep the stored value.
   */
  speicherschonung?: 'aggressiv' | 'ausgewogen' | 'schonend';
}

export interface MastrApplyInput {
  pv?: {
    mastrNummer: string;
    capacityKwp: number | null;
    moduleCount: number | null;
    azimuthDeg: number | null;
    tiltDeg: number | null;
    commissionedOn: string | null;
  };
  storage?: {
    mastrNummer: string;
    capacityKwh: number | null;
    maxChargeKw: number | null;
    maxDischargeKw: number | null;
    commissionedOn: string | null;
  };
}

export interface TelemetryPoint {
  ts: string;
  powerKw: number | null;
  socPct: number | null;
  pvPowerKw: number | null;
  loadKw: number | null;
  gridLimitKw: number | null;
}

// ---- Fleet overview (GET /api/v1/overview) ---------------------------------

/** Newest telemetry observation of a site (the fleet card's live snapshot). */
export interface OverviewLive {
  ts: string;
  pvKw: number | null;
  loadKw: number | null;
  /** + = Bezug (import), - = Einspeisung (export). */
  gridKw: number | null;
  socPct: number | null;
}

/**
 * One site of the fleet overview. Liveness counts derive from each device's
 * newest telemetry ARRIVAL server-side (the store-and-forward rule) with the
 * same 5-minute window as {@link deviceLiveStatus}.
 */
export interface OverviewSite {
  id: string;
  name: string;
  plantKind: PlantKind;
  /** Per-site grid-charging switch (the mode badge on the site card). */
  netzladenErlaubt: boolean;
  /**
   * The site has a battery asset with no controlling device: the optimizer
   * plans it but cannot publish the plan to the edge. The portal warns.
   */
  batteryWithoutDevice: boolean;
  deviceCount: number;
  onlineCount: number;
  /** Devices that never sent data ("wartet auf erste Daten"). */
  waitingCount: number;
  /** Worst device status (stale beats waiting beats online); null = no devices. */
  worstStatus: DeviceLiveStatus | null;
  lastSeenAt: string | null;
  live: OverviewLive | null;
  /** Ex-ante optimizer savings for today (Berlin day); null = no plan today. */
  plannedSavingsTodayEur: number | null;
  /**
   * U5 portfolio: Σ v2 entities per topology role for the "Entitäten" badge.
   * All zero for a v1/registry-less site (older backends omit the field, read
   * as undefined -> the portfolio treats it as all-zero).
   */
  roleCounts?: RoleCounts;
  /**
   * The site's effective AE7 usage profile (arbitrage | peak | private) - the
   * portfolio Profil-Chip, same derivation as GET /sites/{id}/profile. Absent
   * on an older backend.
   */
  usageProfile?: string;
  /**
   * Wann der Optimierer zuletzt für diese Anlage GERECHNET hat. Er plant alle
   * 15 Minuten neu, das Alter IST also die Aussage („Optimierer tot" wird
   * flottenweit sichtbar). `null`/absent = kein Lauf im Nachschau-Fenster des
   * Servers bzw. älteres Backend — nie ein erfundenes Alter.
   */
  lastPlanGeneratedAt?: string | null;
}

/** Σ v2 entities per topology role (U5 portfolio "Entitäten" badge). */
export interface RoleCounts {
  pv: number;
  storage: number;
  consumer: number;
  grid: number;
}

export interface OverviewTotals {
  sites: number;
  devices: number;
  online: number;
  /** Null when NO site has a plan today (never a misleading zero). */
  plannedSavingsTodayEur: number | null;
  /** Sites whose live snapshot is inside the 5-min freshness window. */
  liveSitesCovered: number;
  /** U5 portfolio KPI: Σ battery capacity (kWh); null when the fleet has none. */
  storageCapacityKwh?: number | null;
  /** U5 portfolio KPI: Σ battery discharge power (kW); null when none. */
  storagePowerKw?: number | null;
}

/** One Europe/Berlin day of fleet-wide ex-ante savings (hero mini chart). */
export interface OverviewDailySavings {
  day: string;
  savingsEur: number;
}

export interface Overview {
  sites: OverviewSite[];
  totals: OverviewTotals;
  dailySavings: OverviewDailySavings[];
}

// ---- Edge-Stand je Gerät (GET /api/v1/edge-versions) ------------------------

/**
 * Der von einem Gerät gemeldete Software-Stand (Spalte „Edge-Stand" der
 * Plattform-Übersicht). Beide Versionsfelder sind einzeln nullable — die Edge
 * lässt ein leeres weg (die Palette-Version fehlt z. B., solange Node-REDs
 * Admin-API nicht konfiguriert ist).
 *
 * **Ein FEHLENDER Eintrag heißt „unbekannt", nie „veraltet".** Die Edge baut
 * den Herzschlag-Block, in dem die Versionen reisen, erst nach dem ersten
 * Flow-Deployment — ein Gerät ohne ausgerollte Automation meldet also gar
 * nichts.
 */
export interface EdgeVersion {
  deviceId: string;
  siteId: string;
  coreVersion: string | null;
  paletteVersion: string | null;
  reportedAt: string;
}

// ---- Inverter control confirmation (GET /api/v1/sites/{id}/control-status) --

/**
 * The latest inverter-control confirmation for a site: what the schedule
 * commanded ({@code commandedKw}) vs. what the inverter read back
 * ({@code confirmedKw}), a healthy/mismatch verdict, and the freshness anchor
 * the "Steuerung" strip turns into "geprüft vor X". `controlEnabled` /
 * `certified` distinguish "confirmed", "control off" and "not yet released".
 */
/**
 * WHY the commanded setpoint is what it is (PR 3 des Fahrplan-Konzepts).
 *
 *   plan     - der Plan-Wert selbst, unkorrigiert
 *   follow   - Nachführung: die Entladung folgt dem GEMESSENEN Hausbedarf
 *   trim     - preisbewusste Begrenzung: die Ladung hält beim gemessenen
 *              PV-Überschuss
 *   fallback - kein aktueller Fahrplan: die eingebaute Eigenverbrauchs-Regel
 */
export type ExecutionMode = 'plan' | 'follow' | 'trim' | 'fallback';

/** `deepen` = Entladung angehoben, `reduce` = Entladung begrenzt. */
export type ExecutionDirection = 'deepen' | 'reduce';

export interface ControlStatus {
  deviceId: string;
  /**
   * Worauf das GERÄT regelt. Seit den Nachführungs-Pflichten ist das der
   * KORRIGIERTE Wert, nicht der Plan-Wert — `executionMode`/`-Direction`
   * sagen, warum er abweicht.
   */
  commandedKw: number | null;
  confirmedKw: number | null;
  allMatch: boolean;
  controlEnabled: boolean;
  certified: boolean;
  mismatchRoles: string | null;
  slotStart: string | null;
  checkedAt: string;
  /**
   * Die GROBE Wahrheit des Geräts: steuert überhaupt ein aktueller Fahrplan?
   * Sie fasst jeden Nicht-Fahrplan-Modus (eingebaute Sicherung, ein v2-Wunsch
   * auf der Batterie, Kalibrierung) zu `default` zusammen — deshalb darf sie
   * NIE als „die eingebaute Sicherung läuft" gelesen werden; das präzise
   * Signal ist `executionMode`. Null/absent bei einer älteren Zeile.
   */
  controlSource?: 'schedule' | 'default' | null;
  /** Der präzise Grund; null/absent bei einer älteren Edge-Version. */
  executionMode?: ExecutionMode | null;
  /** Nur bei `follow`: angehoben (`deepen`) oder begrenzt (`reduce`). */
  executionDirection?: ExecutionDirection | null;
  /** Der Sollwert VOR der Korrektur (nur follow/trim). */
  executionPlannedKw?: number | null;
  /**
   * Der GEMESSENE Wert, dem die Korrektur folgt — Hausbedarf bei `follow`,
   * PV-Überschuss bei `trim`. Null, wenn das Gerät ihn nicht messen konnte
   * (es regelt nie blind und meldet nie blind) — nie eine erfundene 0.
   */
  executionTargetKw?: number | null;
  /**
   * WELCHE Quelle die Freigabe erteilt hat: `env` = die flottenweite
   * Allowlist, `device` = eine First-Light-Freigabe auf DIESER Box,
   * `platform` = das Modell-Register der Plattform. Null/absent = nicht
   * freigegeben oder ältere Edge-Version — eine Abwesenheit ist also nie eine
   * Aussage über die Quelle.
   */
  certSource?: CertSource | null;
  /**
   * Was das PLATTFORM-Register über das AUSGEWÄHLTE Modell dieses Geräts sagt.
   *
   * ⚠ Die drei Nicht-`granted`-Antworten sind VERSCHIEDENE Sätze und dürfen
   * nie zusammenfallen: `covered_not_activated` heißt „ein Klick fehlt",
   * `not_covered` heißt „ein Prüfstandslauf fehlt" — und `null` heißt „wir
   * wissen es nicht" (ältere Edge-Version, oder eine Box, die nie ein
   * Cloud-Dokument gesehen hat). Wer null als „nicht zertifiziert" liest,
   * schickt einen Kunden zu einem Prüfstand, den er nicht braucht.
   */
  platformCertVerdict?: PlatformCertVerdict | null;
  /** Der Register-Eintrag, der gepasst hat — damit eine Fläche ihn NENNEN kann. */
  platformCertModel?: string | null;
  /** Der deutsche Grund, wenn ein gedeckt aussehendes Modell doch nichts bekommt. */
  platformCertReason?: string | null;
}

/** Woher die Steuerungs-Freigabe kommt (siehe `ControlStatus.certSource`). */
export type CertSource = 'env' | 'device' | 'platform';

/** Das Urteil des Plattform-Registers (siehe `ControlStatus.platformCertVerdict`). */
export type PlatformCertVerdict =
  | 'granted'
  | 'covered_not_activated'
  | 'not_covered'
  | 'unknown';

// ---- Abregel-Wahrheit (GET /api/v1/sites/{id}/curtailment-status) -----------

/**
 * Was die Anlage aus einem geplanten „Abregeln"-Slot WIRKLICH macht.
 *
 * Der Optimierer plant die Einspeise-Begrenzung, aber ob die Anlage sie
 * ausführt, hängt an einer manuellen Freigabe JE Wechselrichter — solange die
 * fehlt, bleibt die Drosselung ein Plan. Genau diesen Unterschied konnte das
 * Portal bis hierher nicht sehen (es behauptete „die PV wird gedrosselt" neben
 * einem gemessenen 16,6-kW-Einspeise-Chip).
 *
 * **Ein eigener Abruf neben `controlStatus`, kein Feld darin:** die beiden
 * Herzschlag-Blöcke kommen unabhängig (ein Gerät kann den einen ohne den
 * anderen senden) und jeder trägt seine EIGENE Frische.
 *
 * `null` (204) = ältere Edge-Version oder eine Anlage ohne Abregel-Aktor —
 * dann bleibt jede Fläche beim Plan-Wortlaut, nie bei einer erfundenen
 * Ausführung.
 */
export interface CurtailmentStatus {
  deviceId: string;
  /** Abregel-fähige Einheiten, die das Gerät kennt. */
  units: number;
  /** Davon freigegeben. `certifiedUnits < units` ist DER nennbare Grund. */
  certifiedUnits: number;
  /** Der Not-Aus der Wechselrichter-Steuerung. */
  controlEnabled: boolean;
  /** Mindestens eine Einheit wendet gerade eine Begrenzung an. */
  active: boolean;
  /** Summe der angewandten Begrenzungen; null = keine (nie eine erfundene 0). */
  appliedCapKw: number | null;
  /**
   * Über die ANWENDENDEN Einheiten; null = nichts angewandt. Nur `true` ist
   * eine Bestätigung — `null` darf nie als Widerspruch gelesen werden.
   */
  allMatch: boolean | null;
  /**
   * Die gemessene Leistung einer Einheit liegt nach der Einschwingzeit über
   * ihrer Begrenzung: möglicherweise übersteuert sie etwas anderes.
   */
  possibleOverride: boolean;
  /** Der jüngste Rücklese-Zeitpunkt — der Frische-Anker. */
  checkedAt: string;
}

/**
 * Verbraucher-Slots des jüngsten Co-Optimizer-Laufs (Verbrauchssteuerung
 * Inkrement 2, §14.11 Fahrplan-Layer). SHADOW: Zeilen existieren nur für
 * Anlagen, die der Optimierer co-plant; ohne Lauf ist das Dokument leer und
 * der Fahrplan rendert byte-identisch zur Vor-Verbraucher-Ansicht.
 */
export interface ConsumerPlanSlot {
  time: string;
  command: 'on_off' | 'setpoint_kw';
  /** Geplante Leistung in kW (on_off: Nennleistung wenn an, 0 wenn aus). */
  targetValue: number | null;
  reasonCode: string | null;
  requirementId: string | null;
}

export interface ConsumerEntitySchedule {
  entityId: string;
  name: string | null;
  slots: ConsumerPlanSlot[];
}

export interface ConsumerSchedule {
  planId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  entities: ConsumerEntitySchedule[];
}

// ---- Per-source breakdown (GET /api/v1/sites/{id}/sources) ------------------

/**
 * One measurement point of a site as the EDGE reports it (primary inverter or
 * an additional source), with its OWN latest reading and freshness. It exists
 * so a multi-inverter site's composite PV is explainable ("39,0 kW = Deye 8,3 +
 * Fronius 21,3 + Fronius WR 2 9,3") instead of one opaque number.
 *
 * Absent measurements stay `null` (never a fabricated 0); a point that is stale
 * or has never delivered says so via `health`.
 */
export interface SiteSource {
  deviceId: string;
  sourceId: string;
  kind: 'primary' | 'source';
  role: string | null;
  label: string | null;
  brand: string | null;
  model: string | null;
  pvKw: number | null;
  powerKw: number | null;
  loadKw: number | null;
  health: 'ok' | 'stale' | 'never';
  readAt: string | null;
  reportedAt: string;
}

// ---- Realized earnings (GET /api/v1/earnings) -------------------------------

export type EarningsRange = 'day' | 'month' | 'year' | 'all';

/**
 * Why a site has nothing computable: no_data = no measurements in the window;
 * missing_channels = the device does not report the load/PV/grid channels the
 * math needs (generation-only inverters); no_prices = no day-ahead price
 * covers the measured slots yet.
 */
export type EarningsReason = 'no_data' | 'missing_channels' | 'no_prices';

/** One Europe/Berlin day of realized savings. */
export interface EarningsDaily {
  day: string;
  savedEur: number;
}

/** One Ertrag-chart bucket: its Berlin start (ISO) + the Gesamtertrag. */
export interface EarningsSeriesPoint {
  start: string;
  gesamtertragEur: number;
}

/** One month of the 12-month strip: first day of the Berlin month + Gesamtertrag. */
export interface EarningsMonth {
  month: string;
  gesamtertragEur: number;
}

/**
 * One site's MEASURED earnings over the window: baseline = the unregulated
 * plant (same sun, same consumption, battery idle), actual = what really
 * happened at the meter, saved = baseline - actual. All are signed COSTS
 * (negative = revenue); null when nothing is computable ({@link EarningsReason}).
 * `dailySaved` is the last 14 Berlin days regardless of range (spark bars +
 * "Heute" teaser).
 */
/**
 * The money fields the COCKPIT derivations (`cockpitHero`, `cockpitWidgets` ->
 * `erloesKomposition`/`handelBlock`) actually read. Both the tenant-wide
 * {@link EarningsSite} row AND the site-scoped {@link SiteEarnings} carry them,
 * so the cockpit can be fed by either - the audit's B2 fix points it at the
 * cheaper `/sites/{id}/earnings` endpoint, and this shared type documents the
 * exact contract both must satisfy (drift is a compile error, not a runtime
 * surprise).
 */
export interface CockpitMoney {
  gesamtertragEur: number | null;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  savedEur: number | null;
  arbitrageEur: number | null;
  anzulegenderWertCtKwh: number | null;
  firstCoveredDate: string | null;
  peakShaving?: PeakShaving | null;
}

export interface EarningsSite extends CockpitMoney {
  id: string;
  name: string;
  plantKind: PlantKind;
  /**
   * The site's configured anzulegender Wert (ct/kWh), echoed so the fine
   * print can say the numbers INCLUDE the dynamic monthly premium; null =
   * none (pure spot numbers).
   */
  anzulegenderWertCtKwh: number | null;
  /**
   * Benchmark KPI: the export-weighted spot price (ct/kWh) the site's feed-in
   * actually fetched over the window vs the Monatsmarktwert Solar weighted
   * with the same exports; `marketValueProvisional` is true while any
   * contributing month's value is still the provisional (not yet published)
   * one. Null without exported energy or market-value coverage.
   */
  realizedExportCtKwh: number | null;
  marketValueSolarCtKwh: number | null;
  marketValueProvisional: boolean | null;
  baselineEur: number | null;
  actualEur: number | null;
  savedEur: number | null;
  /**
   * The "davon Arbitrage-Gewinn" split for grid-charging sites
   * (netzladen_erlaubt): arbitrage = what the permission concretely earned
   * (grid-charged energy's discharge revenue minus its purchase cost,
   * storage-mix attribution), pvShift = the remainder, so
   * arbitrageEur + pvShiftEur === savedEur exactly. Both null when the site
   * may not grid-charge or the window has no grid-charged energy.
   */
  arbitrageEur: number | null;
  pvShiftEur: number | null;
  coveredSlots: number;
  firstCoveredDate: string | null;
  reason: EarningsReason | null;
  dailySaved: EarningsDaily[];
  /**
   * Money-centric "Meine Anlage" view (v2). Gesamtertrag =
   * einspeiseErloesEur (metered feed-in valued at spot + Marktprämie) +
   * eigenverbrauchsWertEur (self-consumed energy valued per the site's tariff).
   * `tarifArt`/`tarifParamCtKwh` echo the configured tariff so the provenance
   * sentence can name it. eigenverbrauchsWertEur is computed slot-by-slot
   * (dynamisch: each kWh at its 15-min spot price + Aufschlag; fest: the fixed
   * price) and is null for an 'ohne' tariff (self-consumption then shown as
   * selbstverbrauchKwh only, never a fabricated euro), so gesamtertragEur equals
   * einspeiseErloesEur alone. All money fields are null when nothing is
   * computable (same `reason`). `series` is the Ertrag chart for the selected
   * range (per Berlin hour for day, day for month, month for year/all);
   * `monthlyStrip` is the last 12 months (independent of range) - the tappable
   * strip. Both list only computable buckets.
   */
  tarifArt: TarifArt;
  tarifParamCtKwh: number | null;
  /**
   * Whether `savedEur`'s import side is valued beyond bare spot (tariff
   * parameter, maintained Preisblatt, or the platform default-components
   * flag) - gates the "bewertet zu Ihrem Stromtarif" provenance sentence.
   * Optional so an older backend never over-claims.
   */
  tarifPriced?: boolean | null;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  gesamtertragEur: number | null;
  selbstverbrauchKwh: number | null;
  eingespeistKwh: number | null;
  batterieBewegtKwh: number | null;
  /**
   * Forward-looking expected Marktwert Solar (ct/kWh): the day-ahead price
   * weighted with THIS site's own PV forecast over the coming horizon
   * (Σ(price × pv) / Σ(pv)) - the forward companion to the realized
   * `marketValueSolarCtKwh`. Range-independent (always the future).
   * `expectedMarketValueFrom`/`...To` bound the covered forward slots and
   * `expectedMarketValueSlots` counts them, so the portal can say "nächste
   * N h". All four are null when there is no forward PV forecast or no
   * forward price coverage - the figure is then hidden (never a fake 0).
   */
  expectedMarketValueSolarCtKwh: number | null;
  expectedMarketValueFrom: string | null;
  expectedMarketValueTo: string | null;
  expectedMarketValueSlots: number | null;
  series: EarningsSeriesPoint[];
  monthlyStrip: EarningsMonth[];
  /**
   * The Lastspitzenkappung proof (PS-4): present exactly when the site's
   * peak-shaving module is active (a Leistungspreis is configured); null
   * otherwise. Range-independent - always the RUNNING billing period.
   * Optional so the portal ships against an older backend (absent reads the
   * same as null - no proof shown).
   */
  peakShaving?: PeakShaving | null;
}

/**
 * Peak-shaving proof of a module-active site: the running Europe/Berlin
 * billing period's measured grid-import peak vs. the counterfactual
 * no-battery peak (max 15-min mean import; the counterfactual is the same
 * plant with the battery idle). `avoidedKw = max(0, baseline - measured)`;
 * `avoidedEur = avoidedKw × leistungspreisEurKw` - NOT pro-rated, mid-period
 * it is the current standing. The peak fields are null while the running
 * period has no measured import bucket yet - never fabricated.
 */
export interface PeakShaving {
  /** EUR per kW per billing period (the module flag - always present here). */
  leistungspreisEurKw: number;
  /** Billing period kind: Europe/Berlin calendar year or month. */
  abrechnung: 'jahr' | 'monat';
  /** First Berlin day of the running billing period (ISO date). */
  periodStart: string;
  peakKw: number | null;
  baselinePeakKw: number | null;
  avoidedKw: number | null;
  avoidedEur: number | null;
  /** Last 12 billing periods with measured data, ascending (incl. running). */
  history: PeakShavingPeriod[];
}

/** One billing period of the peak-shaving history. */
export interface PeakShavingPeriod {
  periodStart: string;
  peakKw: number;
  baselinePeakKw: number;
  avoidedKw: number;
  avoidedEur: number;
}

export interface EarningsTotals {
  baselineEur: number | null;
  actualEur: number | null;
  savedEur: number | null;
  /**
   * Fleet-level arbitrage split: arbitrage sums the grid-charging sites'
   * attributions, pvShift is the whole fleet's remainder (sites without a
   * split cannot grid-charge, so their entire saved is PV-shift) - null when
   * no site grid-charged in the window.
   */
  arbitrageEur: number | null;
  pvShiftEur: number | null;
  coveredSlots: number;
  /** Earliest covered Berlin day - the honest start of a "Gesamt" range. */
  firstCoveredDate: string | null;
}

export interface Earnings {
  range: EarningsRange;
  from: string;
  to: string;
  sites: EarningsSite[];
  totals: EarningsTotals;
}

// ---- Anlagen-scharfe Erlöse (GET /api/v1/sites/{id}/earnings) ---------------

/**
 * Der Zeitraum der Erlöse-Welt: dieselbe Vokabel wie die Zeit-Leiste
 * (`HistoryRange`), plus das „Gesamt" der Geld-Ansicht. Der Endpunkt kennt
 * beides — die Historie hat „Woche", die Geld-Ansicht „Gesamt".
 */
export type SiteEarningsRange = HistoryRange | 'all';

/** Ein Balken des Geld-Verlaufs: die drei Teile plus ihr Netto. */
export interface SiteEarningsBucket {
  start: string;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  stromkostenEur: number | null;
  nettoEur: number | null;
}

/**
 * Das GEMESSENE Geld EINER Anlage in EINEM Zeitraum — die Antwort der
 * Erlöse-Welt (`#/anlage/{id}/erloese`, Konzept `vp-historie-konzept-t4` §4.2
 * Welt B). Anlagen-scharfer Zwilling von `/api/v1/earnings` (P3): dieselbe
 * Slot-Rechnung, dieselbe Preiswahrheit, eine Anlage.
 *
 * **Zwei Identitäten, auf die sich die Oberfläche verlassen darf** (sie gelten
 * per Konstruktion, nicht per Rundung):
 * `nettoErgebnisEur = einspeiseErloesEur + eigenverbrauchsWertEur − stromkostenEur`
 * und `stromkostenEur − einspeiseErloesEur = actualEur`.
 *
 * **Ehrlichkeit:** jedes Geld-/Mengenfeld ist `null`, wenn es nicht berechenbar
 * ist — nie eine erfundene 0; `reason` sagt warum. `savedEur` ist die
 * ZURECHNUNG der Steuerung und steckt bereits IM Ergebnis (nie ein weiterer
 * Summand); `marktpraemieEur` steckt bereits im Einspeise-Erlös;
 * `peakShaving` gehört einer ANDEREN Periode (laufende Abrechnungsperiode) und
 * wird nie in die Zeitraum-Summe addiert.
 */
export interface SiteEarnings extends CockpitMoney {
  siteId: string;
  name: string;
  range: SiteEarningsRange;
  from: string;
  to: string;
  plantKind: PlantKind;
  tarifArt: TarifArt;
  tarifParamCtKwh: number | null;
  tarifPriced: boolean;
  anzulegenderWertCtKwh: number | null;
  coveredSlots: number;
  firstCoveredDate: string | null;
  reason: EarningsReason | null;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  stromkostenEur: number | null;
  nettoErgebnisEur: number | null;
  savedEur: number | null;
  arbitrageEur: number | null;
  pvShiftEur: number | null;
  baselineEur: number | null;
  actualEur: number | null;
  marktpraemieEur: number | null;
  bezugspreisCtKwh: number | null;
  realizedExportCtKwh: number | null;
  marketValueSolarCtKwh: number | null;
  marketValueProvisional: boolean | null;
  bezogenKwh: number | null;
  eingespeistKwh: number | null;
  selbstverbrauchKwh: number | null;
  batterieBewegtKwh: number | null;
  /**
   * B2 parity with the fleet twin (audit vp-portal-perf-a4): the cockpit money
   * hero reads these from THIS cheaper site endpoint instead of filtering the
   * tenant-wide `/earnings`. `gesamtertragEur` = einspeiseErloesEur +
   * eigenverbrauchsWertEur (feed-in alone for an 'ohne' tariff); the
   * `expectedMarketValue*` are the forward Marktwert Solar (range-independent),
   * all null without forward PV/price coverage - never a fabricated figure.
   */
  gesamtertragEur: number | null;
  expectedMarketValueSolarCtKwh: number | null;
  expectedMarketValueFrom: string | null;
  expectedMarketValueTo: string | null;
  expectedMarketValueSlots: number | null;
  series: SiteEarningsBucket[];
  peakShaving?: PeakShaving | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Portal-Admin tenant switcher: when set, every request carries the selected
 * tenant as `X-Tenant-Id`. The backend honors the header ONLY for
 * platform-admin tokens (see TenantFilter), so the customer pages render that
 * tenant's data through the same RLS scoping the customer gets.
 */
let tenantOverride: string | null = null;

export function setTenantOverride(tenantId: string | null): void {
  tenantOverride = tenantId;
}

/**
 * IN-FLIGHT-Bündelung gleicher GETs.
 *
 * Gemessen auf dem Cockpit: von 21 anlagenbezogenen Anfragen waren 8 exakte
 * Doppel - `/profile` dreimal, `/entities`/`/flows`/`/profiles`/`/history` je
 * zweimal. Sie entstehen strukturell, nicht durch einen Fehler: die Schale und
 * die Anlagen-Seite lesen BEIDE dasselbe Lese-Modell (`useAnlageSurface`), und
 * `useAdaptiveLive` braucht dasselbe Profil noch einmal. Jede Kopie kostet eine
 * Server-Abfrage, einen Verbindungsplatz und einen JSON-Parse.
 *
 * Bewusst KEIN Ergebnis-Zwischenspeicher: gebündelt wird nur, was GERADE
 * unterwegs ist, und der Eintrag fällt weg, sobald die Antwort da ist. Ein
 * 30-s-Takt holt also weiterhin wirklich neu - eine zwischengespeicherte
 * Antwort wäre genau die stille Veraltung, die dieses Portal nirgends duldet.
 *
 * Zwei Grenzen sind tragend: **nur GET** (eine Mutation darf nie geteilt
 * werden) und der Schlüssel trägt den **Mandanten-Umschalter** - sonst könnte
 * ein Admin, der mitten im Flug umschaltet, die Antwort des vorherigen
 * Mandanten bekommen.
 */
const inFlight = new Map<string, Promise<unknown>>();

function coalesceKey(path: string, init: RequestInit): string | null {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return null;
  if (init.body != null || init.signal != null) return null;
  return `${tenantOverride ?? ''}|${path}`;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = coalesceKey(path, init);
  if (key != null) {
    const running = inFlight.get(key);
    if (running) return running as Promise<T>;
    const p = requestUncoalesced<T>(path, init).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
  }
  return requestUncoalesced<T>(path, init);
}

async function requestUncoalesced<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token: string | undefined;
  try {
    token = await freshToken();
  } catch (e) {
    // freshToken() already triggered a full-page login redirect. Abort this
    // request by never resolving - the browser navigates away, so no error
    // banner (and no raw "401") flashes before the redirect (m4).
    if (e instanceof AuthRedirectError) return new Promise<never>(() => {});
    throw e;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantOverride ? { 'X-Tenant-Id': tenantOverride } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Never leak a raw HTTP status/statusText into customer-facing copy (m4):
    // default to a plain-German message and let a server-provided German
    // `message` (e.g. MaStR lookup) override it. The numeric status stays on
    // ApiError.status for callers that branch on it (409/422/…).
    // A 403 is NOT an outage - the server answered, it just refused. Saying
    // "nicht erreichbar" sent customers chasing a connection problem that did
    // not exist (G6). The gate itself is untouched; only the copy is honest.
    let message =
      res.status === 403
        ? 'Dafür ist Ihr Konto nicht freigeschaltet. VoltPilot richtet das für Sie ein.'
        : 'Der Server ist zurzeit nicht erreichbar. Bitte versuchen Sie es erneut.';
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, message);
  }
  // 201 with body for claim; others JSON. 204 would be empty.
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface RegistrationResult {
  tenantId: string;
  tenantName: string;
  username: string;
}

/**
 * Self-service registration. Deliberately NOT via request(): it runs before any
 * login exists, and request()'s token refresh would bounce the visitor to the
 * Keycloak login page instead.
 */
export async function register(input: RegisterInput): Promise<RegistrationResult> {
  const res = await fetch(`${API_BASE}/api/v1/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    // Carry the server's message (don't discard it) but keep it off the raw
    // status text; App maps the status to German copy, incl. the 502/503
    // outage branch (m7).
    let message = 'Die Registrierung ist zurzeit nicht möglich.';
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as RegistrationResult;
}

export type { ProfileState, SiteProfile, SiteProfiles } from './profiles';

/**
 * Ein aufgezeichneter Wechsel aus dem Regel-Protokoll (Stufe 5b). Die Wörter
 * in `state`/`previousState`/`reasonCode` sind GEMELDETE Wörter - der Ingest
 * hat unbekannte längst verworfen, die Fläche rendert nie ein geratenes.
 */
export interface RuleEvent {
  id: number;
  /** Der Schnappschuss der Zuordnung; null = keiner Regel zuzuordnen. */
  ruleKind: 'rezept' | 'flow' | null;
  ruleRef: string | null;
  entityId: string | null;
  kind: string;
  state: string | null;
  previousState: string | null;
  reasonCode: string | null;
  /** Der gemessene Wert im Moment des Wechsels; null = nicht gemessen. */
  actualKw: number | null;
  detail: string | null;
  occurredAt: string;
}

/** Die Zähler EINER Regel. */
export interface RuleActivity {
  ruleKind: 'rezept' | 'flow' | null;
  ruleRef: string | null;
  /**
   * STARTS seit Berliner Mitternacht - NULL heißt „nicht belastbar" (der
   * Speicher zeichnet erst seit heute auf), nie eine erfundene 0.
   */
  switchedToday: number | null;
  lastSwitchedAt: string | null;
}

export interface RuleEvents {
  /** Ab wann aufgezeichnet wird; null = für diese Anlage noch gar nicht. */
  recordingSince: string | null;
  /**
   * Ob der heutige Tag überhaupt zählbar ist (der Speicher hat ihn ganz
   * gesehen). Er beantwortet den Fall, den `rules` nicht abbilden kann: eine
   * Regel OHNE jedes Ereignis taucht dort gar nicht auf, und ohne dieses Flag
   * müsste die Fläche den Berliner Tagesbeginn selbst nachrechnen — ein
   * Zwilling der Server-Regel. Die Entscheidung fällt genau einmal, dort.
   */
  countsToday: boolean;
  /** Die Genauigkeit, die an der Fläche stehen muss (Herzschlag-Takt). */
  accuracySeconds: number;
  rules: RuleActivity[];
  events: RuleEvent[];
}

export const api = {
  /** Tenant-wide fleet overview (the adaptive Übersicht's fleet mode). */
  overview: () => request<Overview>('/api/v1/overview'),
  /**
   * Der gemeldete Edge-Stand aller Geräte des Mandanten (Plattform-Übersicht).
   * Eine leere Liste heißt „kein Gerät hat je gemeldet", nicht „alle aktuell".
   */
  edgeVersions: () => request<EdgeVersion[]>('/api/v1/edge-versions'),
  /**
   * Realized earnings (measured, per site + totals) for a Berlin period. `at`
   * (ISO day) picks the period instance - e.g. a past month tapped in the
   * 12-month strip; omitted = the current period.
   */
  earnings: (range: EarningsRange = 'month', at?: string | null) =>
    request<Earnings>(
      `/api/v1/earnings?range=${range}${at ? `&at=${at}` : ''}`,
    ),
  /**
   * Das gemessene Geld EINER Anlage in EINEM Zeitraum (die Erlöse-Welt, P3).
   * Der mandantenweite `earnings` bleibt fürs Portfolio — diese Fläche zeigt
   * eine Anlage und bezahlt deshalb auch nur eine.
   */
  siteEarnings: (siteId: string, range: SiteEarningsRange = 'month', at?: string | null) =>
    request<SiteEarnings>(
      `/api/v1/sites/${siteId}/earnings?range=${range}${at ? `&at=${at}` : ''}`,
    ),
  /**
   * The site's latest inverter-control confirmation (the calm "Steuerung"
   * strip). Resolves to null when no device has reported a readback yet
   * (endpoint answers 204).
   */
  /**
   * The site's measurement points as the edge reports them (primary inverter +
   * configured sources). Feeds the live view's PV breakdown; an empty list
   * (older edge / no heartbeat yet) simply keeps the single PV number.
   */
  siteSources: (siteId: string) =>
    request<SiteSource[]>(`/api/v1/sites/${siteId}/sources`),
  controlStatus: (siteId: string) =>
    request<ControlStatus | undefined>(
      `/api/v1/sites/${siteId}/control-status`,
    ).then((v) => v ?? null),
  /**
   * Das REGEL-PROTOKOLL der Anlage (Einheitsmodell Stufe 5b): Zähler je Regel,
   * Verlauf je Regel und das kompakte Gesamt-Protokoll in EINER Antwort - die
   * Fläche lädt es einmal und bedient daraus alle drei Orte. Ein älteres
   * Backend kennt die Route nicht; der Aufrufer holt sie deshalb fail-soft.
   */
  siteRuleEvents: (siteId: string) =>
    request<RuleEvents>(`/api/v1/sites/${siteId}/rule-events`),
  /**
   * Die Abregel-Wahrheit der Anlage (204 → null = kein Beleg → Plan-Wortlaut).
   * Bewusst ein eigener Abruf: die zwei Herzschlag-Blöcke kommen unabhängig
   * und jeder trägt seine eigene Frische.
   */
  curtailmentStatus: (siteId: string) =>
    request<CurtailmentStatus | undefined>(
      `/api/v1/sites/${siteId}/curtailment-status`,
    ).then((v) => v ?? null),
  /**
   * Verbraucher-Slots des jüngsten Co-Optimizer-Laufs für den Fahrplan-Layer
   * (Inkrement 2, SHADOW). Leeres Dokument = der Normalzustand einer nicht
   * geflaggten Anlage - der Fahrplan bleibt dann unverändert.
   */
  consumerSchedule: (siteId: string) =>
    request<ConsumerSchedule>(`/api/v1/sites/${siteId}/consumer-schedule`),
  /**
   * The caller's tenant context (U0 login bootstrap): tenant name/segment +
   * the EFFECTIVE Betriebsart that picks the navigation shell. 404 for an
   * admin without a selected tenant (RLS default-deny).
   */
  tenantContext: () => request<TenantContext>('/api/v1/tenant-context'),
  listSites: () => request<Site[]>('/api/v1/sites'),
  createSite: (input: CreateSiteInput) =>
    request<Site>('/api/v1/sites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSite: (siteId: string, input: CreateSiteInput) =>
    request<Site>(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** The site's structured supply-price sheet (Bezugspreis-Komponenten). */
  supplyPrice: (siteId: string) =>
    request<SupplyPrice>(`/api/v1/sites/${siteId}/supply-price`),
  /** Upsert the supply-price sheet (PATCH semantics; see SupplyPriceUpdate). */
  updateSupplyPrice: (siteId: string, patch: SupplyPriceUpdate) =>
    request<SupplyPrice>(`/api/v1/sites/${siteId}/supply-price`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** 409 while the site still has devices (remove them first). */
  deleteSite: (siteId: string) =>
    request<void>(`/api/v1/sites/${siteId}`, { method: 'DELETE' }),
  siteDeletionPreview: (siteId: string) =>
    request<SiteDeletionPreview>(`/api/v1/sites/${siteId}/deletion-preview`),
  listDevices: () => request<Device[]>('/api/v1/devices'),
  claimDevice: (siteId: string, externalRef: string) =>
    request<Device>('/api/v1/devices/claim', {
      method: 'POST',
      body: JSON.stringify({ siteId, externalRef }),
    }),
  updateDevice: (deviceId: string, input: UpdateDeviceInput) =>
    request<Device>(`/api/v1/devices/${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Unclaim: deletes the device and its telemetry; the ref becomes claimable again. */
  deleteDevice: (deviceId: string) =>
    request<void>(`/api/v1/devices/${deviceId}`, { method: 'DELETE' }),
  /**
   * Purge all recorded data of a device WITHOUT unclaiming it: telemetry and
   * derived aggregates are gone, the device stays connected, new data flows
   * normally. Irreversible.
   */
  purgeDeviceData: (deviceId: string) =>
    request<DevicePurgeResult>(`/api/v1/devices/${deviceId}/purge-data`, { method: 'POST' }),
  telemetry: (siteId: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return request<TelemetryPoint[]>(`/api/v1/sites/${siteId}/telemetry${qs ? `?${qs}` : ''}`);
  },
  siteAssets: (siteId: string) => request<SiteAsset[]>(`/api/v1/sites/${siteId}/assets`),
  /** A site's additional read-only Erzeuger measurement points (multi-source). */
  measurementPoints: (siteId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`),
  /** Record an additional Erzeuger source; returns the site's points afterwards. */
  addMeasurementPoint: (siteId: string, input: CreateMeasurementPointInput) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Remove an additional source; returns the site's remaining points. */
  deleteMeasurementPoint: (siteId: string, pointId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points/${pointId}`, {
      method: 'DELETE',
    }),
  /** The site's v2 "Geräte & Entitäten" surface (Soll/Ist reconciliation). */
  siteEntities: (siteId: string) =>
    request<SiteEntities>(`/api/v1/sites/${siteId}/entities`),
  /** AE1 topology read-model (adaptive energy flow + tiles). Empty for un-migrated sites. */
  topology: (siteId: string) => request<SiteTopology>(`/api/v1/sites/${siteId}/topology`),
  /**
   * Customer capability→role assignment (U2 "Rollen & Zuordnung"): set roles for
   * the caller's own site (RLS-fenced); returns the recomputed read-model. A
   * role never widens control, so no extra gate. Admins go through the switcher.
   */
  setTopologyRoles: (siteId: string, assignments: TopologyRoleAssignment[]) =>
    request<SiteTopology>(`/api/v1/sites/${siteId}/topology-roles`, {
      method: 'PUT',
      body: JSON.stringify({ assignments }),
    }),
  /** Which active flows touch each entity (U2 strategy chips). Keyed by entity id. */
  entityStrategies: (siteId: string) =>
    request<Record<string, EntityStrategy[]>>(`/api/v1/sites/${siteId}/entity-strategies`),
  /** AE7 usage profile + emphasis map (the adaptive view's second axis). */
  usageProfile: (siteId: string) =>
    request<SiteUsageProfile>(`/api/v1/sites/${siteId}/profile`),
  /**
   * Set (or clear with null) the site's usage-profile override (AE7, spec §2:
   * "Kunde/Admin kann explizit überschreiben"). Customer- or admin-scoped like
   * the GET; returns the recomputed read-model. Null re-enables auto-derivation.
   */
  setUsageProfileOverride: (siteId: string, override: string | null) =>
    request<SiteUsageProfile>(`/api/v1/sites/${siteId}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ override }),
    }),
  /**
   * Portal v3 M3: the Modus-Profile shelf of the Anlage. Every profile is a
   * DIRECT customer toggle (two states, `an`/`aus` - there is no "angefragt").
   */
  siteProfiles: (siteId: string) =>
    request<SiteProfiles>(`/api/v1/sites/${siteId}/profiles`),
  /**
   * Switch one Modus-Profil on or off. Switching ON makes the SERVER enable
   * exactly that profile's gated node types for the site and seed its starter
   * flow; switching OFF deactivates its flows and closes those nodes again.
   * Returns the recomputed shelf.
   */
  setSiteProfile: (siteId: string, profile: string, state: ProfileState) =>
    request<SiteProfiles>(`/api/v1/sites/${siteId}/profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profile, state }),
    }),
  /** Seed this site's starter flow DRAFT (customer twin, idempotent). */
  autoStart: (siteId: string) =>
    request<{ created: boolean; reason?: string | null; message?: string | null }>(
      `/api/v1/sites/${siteId}/flows/auto-start`,
      { method: 'POST' },
    ),
  /** Per-entity channel history over the v2 telemetry rollups. */
  entityHistory: (siteId: string, entityId: string, range: HistoryRange, at?: string) =>
    request<EntityHistory>(
      `/api/v1/sites/${siteId}/entities/${entityId}/history?range=${range}${
        at ? `&at=${at}` : ''
      }`,
    ),
  /**
   * Save the site's battery master data by hand and maintain its controlling
   * device link ("Ihr Wechselrichter steuert diesen Speicher"). Omit deviceId
   * to auto-link the site's single device; pass it to pick on a multi-device
   * site. Returns the site's assets after the save.
   */
  saveBattery: (siteId: string, input: SaveBatteryInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/battery`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  mastrLookup: (siteId: string, einheitNummer: string) =>
    request<MastrPreview>(`/api/v1/sites/${siteId}/mastr-lookup`, {
      method: 'POST',
      body: JSON.stringify({ einheitNummer }),
    }),
  mastrApply: (siteId: string, input: MastrApplyInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/mastr-apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  prices: (siteId: string) => request<PriceSeries>(`/api/v1/sites/${siteId}/prices`),
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  priceHistory: (siteId: string, range: HistoryRange, at: string) =>
    request<PriceHistory>(`/api/v1/sites/${siteId}/price-history?range=${range}&at=${at}`),
  weather: (siteId: string) => request<WeatherForecast>(`/api/v1/sites/${siteId}/weather`),
  /**
   * Ohne `mode` byte-gleich wie bisher (der jüngste Lauf); `mode: 'day'` holt
   * den Tages-Splice — siehe {@link ScheduleMode}. Ein Backend ohne den
   * Parameter beantwortet `mode=day` mit einem 400, der Aufrufer fällt dann
   * fail-soft auf die Standard-Lesart zurück.
   */
  schedule: (siteId: string, mode?: ScheduleMode) =>
    request<SchedulePlan>(
      `/api/v1/sites/${siteId}/schedule${mode && mode !== 'latest' ? `?mode=${mode}` : ''}`,
    ),
  forecastQuality: (siteId: string, days = 30) =>
    request<ForecastQuality>(`/api/v1/sites/${siteId}/forecast-quality?days=${days}`),
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  history: (siteId: string, range: HistoryRange, at: string) =>
    request<History>(`/api/v1/sites/${siteId}/history?range=${range}&at=${at}`),
  /** Ersparnis-Simulation: async job - POST starts (defaults from the site's
   * master data, body fields override), GET polls every ~2 s. */
  startSimulation: (siteId: string, input: SimulationRequestInput) =>
    request<{ simulationId: string }>(`/api/v1/sites/${siteId}/simulation`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  simulationStatus: (siteId: string, simulationId: string) =>
    request<SimulationStatus>(`/api/v1/sites/${siteId}/simulation/${simulationId}`),
};
