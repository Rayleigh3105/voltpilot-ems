import { AuthRedirectError, freshToken } from './auth';
import type { SimulationRequestInput, SimulationStatus } from './simulation';
import type { SocCurveTemplate } from './batterieAnschluss';
import type { ProfileState, SiteProfiles } from './profiles';
import type {
  CockpitLayoutDocument,
  CockpitLayoutLayer,
  CockpitLayoutResponse,
  Flaeche as CockpitLayoutFlaeche,
} from './cockpitLayout';
import type { Profil } from './anwendungen';
import type { BezugsgroesseLesart } from './bezugsgroesse';
import type { EigeneAuswertungWerte } from './eigeneAuswertung';
import type {
  ChargingBoostResult,
  ChargingConfig,
  SiteCharging,
  StoragePriority,
  SurplusPolicy,
} from './ladepunkte';
export type {
  ChargingBoostResult,
  ChargingConfig,
  SiteCharging,
  StoragePriority,
  SurplusPolicy,
} from './ladepunkte';
import type { SiteVerbraucher } from './verbraucherZone';
export type { SiteVerbraucher } from './verbraucherZone';
import type { SteuerartErgebnis, SteuerartWunsch } from './steuerartDialog';
export type { SteuerartErgebnis, SteuerartWunsch } from './steuerartDialog';
import type { Bestand, FlaecheQuelle } from './uemsOrtsbaum';
import type { FahrzeugWunsch, SiteFahrzeuge } from './fahrzeugProfile';
export type { Fahrzeug, FahrzeugWunsch, SiteFahrzeuge } from './fahrzeugProfile';
import type { Topology } from './topology';
import type { ModellWahlZustand } from './prognose';
import type { ComponentMatch } from './komponentenAssistent';

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
  /**
   * Das ANWENDUNGS-PRESET der Anlage (Stufe 2, `site.profil`): `privat` |
   * `gewerbe`, oder null = noch keins gewählt (der Zustand JEDER Bestandsanlage).
   *
   * Es hat GENAU DREI Wirkungen und ist NIE ein Signal der Ableitung
   * (Captain-Entscheid E3): die Vorauswahl im Anwendungs-Regal (welche
   * Anwendungen der Assistent vorschlägt — die Liste steht je Anwendung im
   * Katalog), die TONALITÄT der Geld-Sprache (`fleet.ts siteTonalitaet`; ohne
   * Profil fällt sie byte-identisch auf die `plantKind`-Regel zurück) und die
   * Reset-Basis des Cockpit-Layouts (Stufe 3). Geschrieben ausschließlich über
   * `api.setAnwendungsPreset` — DEFENSIV OPTIONAL, ein älteres Backend liefert
   * das Feld gar nicht.
   */
  profil?: Profil | null;
}

/**
 * GET /api/v1/sites/{siteId}: genau die `Site`-Felder, plus additiv der
 * `standort` heute (UEMS AP-02 IP-3); `null` = noch keinem Standort zugeordnet.
 */
export interface SiteDetail extends Site {
  standort: StandortBezug | null;
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

/**
 * `POST /api/v1/sites`: die Felder von {@link CreateSiteInput} plus — additiv
 * (UEMS AP-02 IP-9) — der Standort der neuen Anlage. Weggelassen: bei genau
 * einem Standort des Kundenbereichs ist er vorbelegt, ohne Standort bleibt die
 * Anlage „noch nicht zugeordnet", bei mehreren antwortet der Server 422
 * `standort_waehlen` mit der Auswahl. `PUT` (Stammdaten) kennt das Feld nicht.
 */
export interface NeueAnlageInput extends CreateSiteInput {
  standortId?: string;
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

/** Ein laufender Handeingriff (Steuerung Stufe 4). */
export interface Intervention {
  kind: string;
  /** null = die ganze Anlage (die Pause), sonst die Komponente. */
  entityId: string | null;
  targetValueKw: number | null;
  endsAt: string;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Die KUNDEN-VORSCHAU (Steuerung Stufe 7): was eine Entscheidung am Fahrplan
 * ändert. `deltaEur` zeigt aus KUNDENSICHT - negativ = es kostet; `null` heisst
 * „keine Zahl", und `grund` sagt warum. `naeherung` ist IMMER true.
 */
export interface SteuerungVorschau {
  deltaEur: number | null;
  basisEur: number | null;
  varianteEur: number | null;
  horizonSlots: number | null;
  naeherung: boolean;
  grund: string | null;
}

/** Die drei Knöpfe, die ein Kunde treffen kann - mehr kennt die Route nicht. */
export interface VorschauKnoepfe {
  socFloorNow?: boolean;
  forcedChargeSlots?: number;
  verbraucherAbSlot?: number;
  verbraucherSlots?: number;
  verbraucherKw?: number;
}

/** Eine server-seitig gemerkte Haltung zu einem abgeleiteten Vorschlag. */
export interface SuggestionState {
  key: string;
  state: 'spaeter' | 'abgelehnt';
  /** Bis wann sie gilt; danach erscheint der Vorschlag wieder. */
  mutedUntil: string;
  updatedAt: string;
}

/** Alles, was gerade stumm ist (abgelaufene Zeilen kommen nicht mit). */
export interface SuggestionStates {
  states: SuggestionState[];
}

/** Alles, was gerade von Hand gesetzt ist. */
export interface SiteInterventions {
  automationPaused: boolean;
  /** Bis wann die Pause läuft; null = keine Pause. */
  pausedUntil: string | null;
  interventions: Intervention[];
}

/** Was ein Eingriffs-Aufruf bewirkt hat. */
export interface InterventionOutcome {
  applied: boolean;
  /** Ist der Wunsch wirklich hinausgegangen? Sonst sagt `message` das. */
  pushed: boolean;
  kind: string;
  endsAt: string | null;
  effectivePowerKw: number | null;
  /** true = der Eingriff dauert länger als die 4-h-Kappe und wird erneuert. */
  ttlRenewed: boolean;
  message: string;
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
  /** Additive authority to start measured load coverage from an idle slot. */
  unplannedLoadDischarge?: boolean | null;
  /**
   * Der Ladeseiten-Spiegel: true = das Gerät begrenzt die Ladung auf den
   * GEMESSENEN Solar-Überschuss, weil Zukauf in dieser Viertelstunde
   * unwirtschaftlich wäre. Dieselbe Dreiwertigkeit wie
   * `coverLoadFromBattery`.
   */
  chargeFromSurplusOnly?: boolean | null;
  /**
   * Erklärbarkeit Stufe 1 (Konzept vp-warum-erklaerbar-e2 §4.2 C): die beste
   * Handlung, die dieser RUHENDE Slot VERWORFEN hat - `decken` | `verkaufen` |
   * `solar_speichern` | `netzladen`. Genannt wird nur, was physisch zulässig
   * war; ein Wort, das dieser Stand nicht kennt, wird IGNORIERT statt geraten.
   * Null auf einem AKTIVEN Slot (dessen Grenznutzen ist am Optimum 0), wenn
   * gar nichts anderes möglich war, und auf Läufen ohne Erklär-Schicht -
   * die Fläche bleibt dann beobachtend (Stufe 0).
   */
  whyNextBest?: string | null;
  /**
   * Wie viel SCHLECHTER diese verworfene Handlung gewesen wäre, in ct/kWh -
   * immer <= 0. Ein Betrag unter `NEXT_BEST_TIE_CT` ist ein GLEICHSTAND und
   * wird als solcher ausgesprochen, nie als Entscheidung verkleidet: am
   * 17.08.2026 war er algebraisch exakt 0,000 ct/kWh, während der angezeigte
   * Satz eine Spannen-Ursache behauptete. Null genau dort, wo auch
   * `whyNextBest` null ist - Name und Marge sind EINE Aussage.
   */
  whyNextBestMarginCt?: number | null;
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
  /** Full corrective-discharge floor: max(technical, backup, peak reserve). */
  effectiveFloorSocPct?: number | null;
  /**
   * True when this run is the advisory fallback build WITHOUT the §14a grid
   * constraint (it was infeasible) - the device enforces the limit
   * additionally on execution, and the portal's §14a copy says so. Null on
   * pre-feature rows (the why-layer then stays hidden anyway).
   */
  fallback14a: boolean | null;
  /**
   * Erklärbarkeit Stufe 1 (§4.2 A): WORAN der Wert gespeicherter Energie
   * ankerte - `einspeisewert` (Überschuss-Slot: die entgangene Einspeisung) |
   * `bezugspreis` (Defizit-Slot: der vermiedene Netzbezug - der Trüb-Fall vom
   * 17.08.) | `marktpreis` (Netzladen erlaubt: günstigster Bezug) | `vorgabe`
   * (env-gepinnt, nichts abgeleitet). Ein LAUF-Fakt, also am Plan und nicht
   * je Slot. Null ohne Erklär-Schicht / auf Vor-Feature-Läufen.
   */
  whyTerminalAnchor?: string | null;
  /**
   * Wie viel der NUTZBAREN Kapazität der Horizont gratis wieder auffüllt
   * (0-100) - der Sommer-Satz „morgen füllt Ihr Überschuss den Speicher
   * ohnehin". Null, wenn es nichts zu bemessen gab; **nie eine erfundene 0**,
   * die als „der Horizont bietet nichts" gelesen würde.
   */
  whyRefillFreePct?: number | null;
  /**
   * Nacht-Wertfunktion (P3): wie viel Ladung dieser Lauf bei SONNENAUFGANG
   * über dem Reserve-Boden hält, weil die eigene Nacht-Historie eine
   * schwerere Nacht plausibel macht (kWh). KEINE feste Reserve - der Plan
   * hält genau so viel, wie Preisabstand mal Fehlerwahrscheinlichkeit
   * rechtfertigt, also bewegt sich die Zahl mit jedem Lauf. Null, wenn nichts
   * zurückgehalten wurde; **nie eine erfundene 0**.
   */
  whyNightReserveKwh?: number | null;
  /**
   * Die Quantilslage dieser Menge (0,75 = in 1 von 4 Nächten wird sie
   * gebraucht). Sie ist die ZWEITE Hälfte derselben Aussage: ohne sie steht
   * eine kWh-Zahl ohne ihre Häufigkeit da, und der Satz entfällt.
   */
  whyNightReserveQ?: number | null;
  /**
   * P7 (Scout `vp-deye-diybms-luecke-l5` §3.3, `schedule.soc_source`): WOHER
   * der Anfangs-Ladestand dieses Laufs kam — `gemessen` (echte Telemetrie im
   * Frischefenster) | `berechnet` (ein abgeleiteter Stand; der generische
   * SoC-Baustein folgt in einem eigenen Paket) | `unbekannt`.
   *
   * Bei `unbekannt` hat der Optimierer den Speicher GAR NICHT geplant: jeder
   * `batteryKw` ist 0, `socPct` und `baselineCostEur` sind null, `savingsEur`
   * ist null — und die Fahrplan-Seite sagt den GRUND, statt eine flache
   * 50-%-Linie zu zeichnen, die niemand gemessen hat.
   *
   * Null = ein Lauf vor der Spalte und wird wie `gemessen` gelesen, **nie** wie
   * `unbekannt` (sonst behauptete jeder Alt-Lauf rückwirkend, er habe keinen
   * Ladestand gehabt). Der Tages-Splice trägt es ebenfalls null: er ist aus
   * vielen Läufen genäht und hat keine EINE Herkunft.
   */
  socSource?: string | null;
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
  /**
   * The EX-ANTE **planned** value of VoltPilot's STEERING, measured against
   * the SAME plant with a battery but without smart control - the yardstick
   * every customer surface uses since the captain's 04.09.2026 call ("du musst
   * Anlage immer mit Speicher berechnen, einer halt ohne smart Steuerung").
   *
   * ⚠ It is NOT {@link HistoryTotals.batterySavingsPlannedEur}, which measures
   * against a plant WITHOUT a battery and is therefore an ADMIN number. The two
   * legitimately differ by a large factor; a surface must never substitute one
   * for the other.
   *
   * OPTIONAL because the optimizer only starts persisting it with its own
   * increment: `undefined`/`null` = no plan figure on this yardstick, and the
   * customer-facing plan line stays ABSENT rather than showing the old one.
   */
  steuerungPlannedEur?: number | null;
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
  | 'abendverkauf'
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
  /**
   * 1 - mae/mae_reference; positiv = genauer als das AKTIVE Modell dieser Art,
   * null für den Maßstab selbst. (Solange nichts befördert ist, IST das aktive
   * Modell das Basismodell - die Zahlen sind unverändert; nach einer
   * Beförderung tauschen die Rollen sauber.)
   */
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
  /**
   * Das Modell, dessen Prognosen der Optimierer FÜR DIESE ANLAGE konsumiert -
   * server-seitig mit DERSELBEN Präzedenz aufgelöst, die der Optimierer nutzt
   * (Anlagen-Wahl > Plattform-Vorgabe > Umgebung). Nach einer Umstellung steht
   * hier sofort das neue Modell.
   */
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
  /**
   * Die EIGENE Erreichbarkeit der Box im Kundennetz (Anlagen-Zentrale Stufe 2,
   * D5) - NUR Anzeige, verbatim inklusive Port.
   *
   * **`null` heißt „die Box meldet sie (noch) nicht" - NIE „nicht
   * erreichbar".** Ein älterer Edge-Stand sendet den Block gar nicht.
   */
  lanHost?: string | null;
  /** Der Frische-Anker DIESER Aussage; er reist immer MIT `lanHost`. */
  lanSeenAt?: string | null;
  /**
   * Herkunft des Belegs: `schnittstelle` = der vom Box-Host erkannte/
   * konfigurierte Endpunkt im Kundennetz; `erreicht` = kompatibler Fallback
   * aus einem Browser-Aufruf (der auch über ein Service-VPN erfolgt sein kann).
   */
  lanSource?: 'erreicht' | 'schnittstelle' | null;
}

export interface MeasurementCatalogPoint {
  family: string;
  pointKey: string;
  sourceKind: string;
  address: { kind: string; registers?: number[]; widthWords?: number; modelId?: number; offsetWords?: number | string } | null;
  selector: string;
  widthBits: number | null;
  valueType: string;
  signed: boolean | null;
  endian: string | null;
  scale: { kind: string; value?: number | number[] };
  unit: string | null;
  group: string;
  labelDe: string | null;
  labelSource: string | null;
  semanticStatus: 'known' | 'vendor_label_only' | 'unknown';
  aggregationKind: string;
  defaultCadenceS: number | null;
  minCadenceS: number | null;
  longTermCadenceS: number | null;
  pollGroup: string;
  sourceUrl: string;
  sourceCommit: string | null;
  sourceRevision: string | null;
  dynamic: boolean;
  recommended: boolean;
  available: boolean;
  availabilityStatus: 'read' | 'family_configured' | 'not_configured';
  availabilityReason: string;
  recorded: boolean;
  selected: boolean;
  selectedCadenceS: number | null;
  lastReadAt: string | null;
  rawValue: string | null;
  decodedValue: string | null;
  quality: string | null;
  gap: boolean;
  droppedSamples: number;
  estimatedDataPerYearBytes: number;
}

export interface MeasurementCatalogResult {
  catalogVersion: string;
  edgeMinVersion: string;
  customPointActionLabel: 'Eigenen Messwert hinzufügen';
  total: number;
  offset: number;
  limit: number;
  groups: { value: string; count: number }[];
  semanticStatuses: { value: string; count: number }[];
  points: MeasurementCatalogPoint[];
}

export interface MeasurementBudgetEstimate {
  enabledPointCount: number;
  samplesPerMinute: number;
  requestsPerMinute: number;
  dutyCyclePercent: number;
  softWarning: boolean;
  hardRejected: boolean;
  reasons: string[];
  rawGbPerYear: number;
  longTermGbPerYear: number;
  totalGbPerYear: number;
  retentionSummary: string;
}

export interface MeasurementSelectionState {
  deviceId: string;
  siteId: string;
  /**
   * Die Komponente, auf die diese Sicht geschnitten ist (Stufe 3b) - `null`
   * bzw. fehlend heisst „das ganze Geraet", die Box-Semantik von vorher.
   * Revision und Volumen bleiben in beiden Faellen GERAETE-weit: die Revision
   * ist das Token des EINEN veroeffentlichten Plans, das Budget die Last des
   * EINEN Busses.
   */
  entityId?: string | null;
  desiredRevision: number;
  catalogVersion: string;
  status: 'idle' | 'pending_edge' | 'applied' | 'first_sample' | 'partially_rejected';
  statusReason: string;
  activationNotice: string;
  disableNotice: string;
  selections: Array<{
    pointKey: string; enabled: boolean; cadenceS: number | null; applyStatus: string;
    applyReason: string | null; enabledAt: string | null; disabledAt: string | null;
    label: string; family: string; group: string; semanticStatus: string;
    customDefinition: {
      label: string; sourceKind: string; address: number; selector: string; valueType: string;
      widthBits: number; signed: boolean; endian: string; scale: number; unit: string;
      cadenceS: number; retentionClass: string; readOnly: boolean; requestCostMs: number;
    } | null;
  }>;
  volumeEstimate: MeasurementBudgetEstimate;
}

export type MeasurementRange = '24h' | '7d' | '30d' | '90d' | 'year' | 'free';

/** Woraus eine Verlaufs-Antwort gebildet ist (UEMS AP-07 IP-14). */
export type MeasurementQuelle = 'roh' | 'rollup_5m' | 'rollup_15m' | 'viertelstunde' | 'tag';

/**
 * Die Herkunft je Wert bzw. Intervall (UEMS AP-07 §4.2/§4.4). `null` heißt: für diese Quelle
 * gibt es sie nicht (die bestehenden Verdichtungen der Box tragen keine); ein `null` INNERHALB
 * heißt: für diesen Schritt nicht eindeutig oder nicht erhoben — nie ein geratener Wert.
 */
export interface MeasurementHerkunft {
  quelle: MeasurementQuelle;
  wertart: string | null;
  abdeckungProzent: number | null; erhalten: number | null; erwartet: number | null;
  nGood: number | null; nUncertain: number | null; nInvalid: number | null;
  nStale: number | null; nDeviceError: number | null;
  zustand: 'vorlaeufig' | 'endgueltig' | null; endgueltigAb: string | null; version: number | null;
  nachgeliefert: number | null; zustellart: string | null; letzteEingangszeit: string | null;
  geraetEinbau: string | null; geraetEinbauZwei: string | null;
  box: string | null; boxZwei: string | null;
  fassung: number | null; katalogVersion: string | null; rolle: string | null;
  standAnfang: number | null; standEnde: number | null;
  /** Nur Speicherklassen: Vollständigkeit der Menge (bzw. des Momentanwerts) und ihre Kennzeichen. */
  mengeZustand?: 'vollständig' | 'unvollständig' | 'keine Werte';
  kennzeichen?: string[];
  /** Energie aus Leistung — interpoliert, darum nie ohne ihr Kennzeichen „aus Leistung integriert …". */
  energieAusLeistung?: { wert: number; kennzeichen: string };
}

export interface MeasurementHistory {
  meta: {
    pointKey: string; label: string; sourceLabel: string | null; unit: string | null;
    aggregationKind: string; semanticStatus: string; catalogVersion: string | null;
    representation: 'raw' | 'decoded'; rawAvailable: boolean; from: string; to: string;
    bucketSeconds: number; aggregationExplanation: string; siteId: string; entityId?: string | null;
    /** AP-07 IP-14, additiv: woraus die Antwort gebildet ist und bis wann Rohwerte reichen. */
    quelle?: MeasurementQuelle | null; quelleErklaerung?: string | null;
    rohGrenze?: string | null; katalogVersionenGespeichert?: string[];
  };
  data: Array<{ time: string; value: number | null; minimum: number | null; maximum: number | null; text: string | null; sampleCount: number; gap: boolean; herkunft?: MeasurementHerkunft | null }>;
  markers: Array<{ time: string; kind: string; label: string; until?: string | null; count?: number }>;
}

export interface MeasurementComparisonOption {
  deviceId: string; deviceLabel: string; pointKey: string; label: string; unit: string;
  aggregationKind: string; compatibilityKey: string; lastReadAt: string;
}

/** Complete OCPP 1.6 read model. Optional values are facts the station did not report. */
export interface OcppConnectorState {
  connectorId: number;
  status: string;
  errorCode: string | null;
  info: string | null;
  vendorId: string | null;
  vendorErrorCode: string | null;
  stationTimestamp: string | null;
  reportedAt: string;
}

export interface OcppStation {
  deviceId: string;
  chargePointId: string;
  connected: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSeen: string | null;
  bootedAt: string | null;
  chargeBoxSerialNumber: string | null;
  chargePointModel: string | null;
  chargePointSerialNumber: string | null;
  chargePointVendor: string | null;
  firmwareVersion: string | null;
  iccid: string | null;
  imsi: string | null;
  meterSerialNumber: string | null;
  meterType: string | null;
  diagnosticsStatus: string | null;
  diagnosticsStatusAt: string | null;
  firmwareStatus: string | null;
  firmwareStatusAt: string | null;
  connectors: OcppConnectorState[];
  supportedFeatureProfiles: string[];
}

export interface OcppProtocolEvent {
  eventId: string;
  occurredAt: string;
  deviceId: string;
  chargePointId: string;
  direction: string;
  messageType: string;
  correlationId: string | null;
  action: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  errorDetails: unknown;
  payload: unknown;
}

export interface OcppDataGap {
  eventId: string;
  reportedAt: string;
  deviceId: string;
  droppedCount: number;
  totalDropped: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  firstEventId: string | null;
  lastEventId: string | null;
  reasons: Record<string, number>;
}

export interface OcppTransaction {
  deviceId: string;
  chargePointId: string;
  transactionId: number;
  connectorId: number;
  startedAt: string;
  stoppedAt: string | null;
  meterStart: number;
  meterStop: number | null;
  stopReason: string | null;
  startIdTagRef: string | null;
  stopIdTagRef: string | null;
  reservationId: number | null;
  chargingProfileId: number | null;
  chargingProfilePurpose: string | null;
  startAuthStatus: string | null;
  stopAuthStatus: string | null;
  parentIdTagRef: string | null;
  transactionData: unknown;
  transactionDataPurgedAt: string | null;
}

export interface OcppMeterSample {
  sampledAt: string;
  eventId: string;
  meterValueIndex: number;
  sampledValueIndex: number;
  deviceId: string;
  chargePointId: string;
  connectorId: number;
  transactionId: number | null;
  source: string;
  pointKey: string;
  measurand: string | null;
  context: string | null;
  format: string | null;
  phase: string | null;
  location: string | null;
  unit: string | null;
  value: string;
  numericValue: number | null;
}

export interface OcppConfigurationKey {
  key: string;
  value: string | null;
  readonly: boolean;
  secret: boolean;
  redacted: boolean;
  standardKey: boolean;
  meaningKnown: boolean;
  reportedAt: string;
}

export interface OcppConfiguration {
  deviceId: string;
  chargePointId: string;
  keys: OcppConfigurationKey[];
  unknownKeys: string[];
  supportedFeatureProfiles: string[];
}

export interface OcppActionPermissions { actions: Record<string, boolean>; }

export interface OcppAction {
  id: string;
  deviceId: string;
  chargePointId: string;
  action: string;
  state: string;
  correlationId: string;
  idempotencyKey: string;
  actor: string;
  connectorId: number | null;
  transactionId: number | null;
  request: unknown;
  response: unknown;
  responseStatus: string | null;
  effect: unknown;
  reason: string | null;
  preparedAt: string;
  sentAt: string | null;
  responseAt: string | null;
  effectAt: string | null;
  deadlineAt: string;
  updatedAt: string;
}

export interface OcppActionIntent {
  id: string;
  action: string;
  phrase: string;
  fourEyes: boolean;
  expiresAt: string;
}

export interface OcppActionAudit {
  id: number;
  actor: string;
  state: string;
  reason: string | null;
  deviceId: string;
  chargePointId: string;
  connectorId: number | null;
  transactionId: number | null;
  occurredAt: string;
}

export interface OcppActionInput {
  action: string;
  connectorId?: number;
  transactionId?: number;
  request: Record<string, unknown>;
  intentId?: string;
  confirmationPhrase?: string;
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
  /**
   * WIE die Box dieses Gerät erreicht (Anlagen-Zentrale Stufe 2, PR 2b) - aus
   * `entity_observed_state.edge_*`, also aus DEMSELBEN Lesepfad, aus dem die
   * Zentrale ohnehin ihre Geräte-Karten baut.
   *
   * **`null` heißt „diese Box meldet (noch) keine Verbindungen" - NIE „dieses
   * Gerät hat keine".** Ein älterer Box-Stand lässt die Felder weg, und daraus
   * darf nur „Weg unbekannt" folgen, nie eine erfundene Adresse.
   */
  communication?: string | null;
  family?: string | null;
  host?: string | null;
  port?: number | null;
  /** Die Modbus-Adresse (`unit_id` bzw. beim Solarman-Weg `mb_slave_id`). */
  unitId?: number | null;
  /** Die Logger-Nummer des Solarman-Wegs. */
  serial?: string | null;
  intervalS?: number | null;
}

/** The whole "Geräte & Entitäten" surface for a site. */
/**
 * Eine Geräte-VORLAGE (Einheitsmodell Stufe 0a) - woraus der Anlege-Assistent
 * seine Auswahl UND sein Formular rendert. `transportSchema` ist das
 * Feld-Vokabular; `channels`/`writes` sind bei eingebauten Vorlagen `null` =
 * „hier nicht erklärt", nie `[]`.
 */
export interface ComponentTemplate {
  templateRef: string;
  kind: string;
  version: number;
  brand: string;
  brandLabel: string;
  model: string;
  modelLabel: string;
  deviceType?: string | null;
  supersededBy?: string | null;
  family?: string | null;
  familyLabel?: string | null;
  communication: string;
  communicationLabel: string;
  transportSchema?: TemplateField[] | null;
  channels?: unknown;
  writes?: unknown;
  ratedKw?: number | null;
  controlTier?: number;
  certificationStatus?: string | null;
  note?: string | null;
}

/** Ein Feld des `transport_schema` einer Vorlage. */
export interface TemplateField {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  default?: string | number | boolean;
  help?: string;
  options?: { value: string | number; label: string }[];
  /** Geheimnis: wird nie zurückgegeben, nur mit einer festen Maske angezeigt. */
  secret?: boolean;
}

/** Eine gespeicherte Fassung der Anbindung einer Komponente (Stufe 1). */
export interface ComponentDefinition {
  entityId: string;
  version: number;
  role?: string | null;
  label?: string | null;
  brand?: string | null;
  model?: string | null;
  family?: string | null;
  communication?: string | null;
  connection?: Record<string, unknown> | null;
  sourceKind?: string | null;
  templateRef?: string | null;
  templateVersion?: number | null;
  createdAt?: string | null;
  createdBy?: string | null;
  note?: string | null;
}

/** Was der Anlege-Assistent speichert. */
export interface SaveComponentBody {
  templateRef: string;
  templateVersion?: number;
  label?: string;
  role: string;
  connection: Record<string, unknown>;
  capacityKwp?: number;
  intervalS?: number;
  note?: string;
  /**
   * Die ausdrückliche Zustimmung, diese Komponente OHNE einen Messkanal zu
   * betreiben („Trotzdem fortfahren (nur Lesen)"). Sie NENNT den Kanal - der
   * Server akzeptiert sie nur, wenn sein Testergebnis genau diesen Kanal als
   * fehlend ausgewiesen hat.
   */
  acceptMissingChannel?: string;
  /** Gelesene Fassung beim Bearbeiten; verhindert stilles Überschreiben. */
  expectedRevision?: number;
  /** Ab wann diese Änderung gilt; aktuell atomisch beim Speichern. */
  effectiveAt?: string;
}

/**
 * Der Befund einer Plausibilitätsregel: WELCHER Kanal sie verletzt hat und
 * WARUM (Vertrag `mqtt-probe.schema.json` `op_result.finding`).
 *
 * Er ist maschinenlesbar, damit die Fläche keinen deutschen Satz nach
 * Stichworten durchsuchen muss - die Haus-Regel „`target_verdict` NEBEN
 * `state`". Der Satz gehört dem Portal, die Tatsache dem Gerät.
 */
export interface ProbeBefund {
  /** Heute genau einer: `soc_pct`. */
  channel: string;
  /**
   * `missing` = der Registerblock LEBT und nur dieser Kanal liest exakt 0 (eine
   * Batterie, deren BMS nicht am Wechselrichter hängt) - der EINZIGE Fall, den
   * ein Betreiber bewusst übergehen darf. `out_of_range` (kaputter Rahmen) und
   * `no_answer` (Leerantwort des Loggers) sagen, dass der Lesung selbst nicht
   * zu trauen ist.
   */
  rule: string;
  /** Das rohe Registerwort. */
  raw?: number | null;
  /** Der dekodierte Wert, der die Regel verletzt hat. */
  value?: number | null;
  /**
   * Was die Box aus einem VERWANDTEN Messwert schätzen würde - heute der
   * Ladestand aus der gemessenen Batteriespannung, wenn die zwei Eckpunkte des
   * Speichers gepflegt sind.
   *
   * Sie steht NEBEN dem Befund, nie in `reading` (der beanstandete Kanal ist
   * dort nie enthalten), und sie ÄNDERT DAS URTEIL NICHT: der Test bleibt
   * fehlgeschlagen, die Komponente braucht weiterhin die ausdrückliche
   * Zustimmung und bleibt für die Batterie-Steuerung gesperrt. Absent = die
   * Box hat nichts anzubieten.
   */
  estimate?: { socPct?: number | null; voltageV?: number | null } | null;
}

/** Die Antwort des Probe-Kanals auf einen Verbindungstest. */
export interface ProbeAntwort {
  requestId?: string;
  errorCode?: string | null;
  message?: string | null;
  results?: {
    id?: string;
    ok?: boolean;
    errorCode?: string | null;
    message?: string | null;
    /**
     * Die dekodierten Messwerte. Sie stehen AUCH bei `ok: false`, wenn ein
     * `finding` den einen verletzenden Kanal benennt - dann hat die Box wirklich
     * gelesen und die übrigen Kanäle sind angekommen.
     */
    reading?: Record<string, unknown> | null;
    finding?: ProbeBefund | null;
    /**
     * Die Zuordnungs-VORSCHAU einer selbst angebundenen Batterie (P5d): EINE
     * Zeile je Feld-Zuordnung.
     *
     * ⚠ Der Block ist ABWESEND, wenn die Box (noch) nicht lauschen kann - das
     * heißt „diese Box kann es nicht", nie „es kam nichts an". Eine Zeile ohne
     * Empfang trägt `count: 0` und KEINE Zahl; „nicht gemessen" ist nie
     * „gemessen 0".
     */
    samples?: ProbeVorschauZeile[] | null;
  }[];
}

/** Was EINE Feld-Zuordnung im Lauschfenster empfangen hat (P5d). */
export interface ProbeVorschauZeile {
  channel: string;
  topic?: string | null;
  raw?: number | null;
  value?: number | null;
  count: number;
  at?: string | null;
}

/**
 * Die Komponenten einer Anlage samt Autoritäts- und Soll/Ist-Stand
 * (Einheitsmodell Stufe 1).
 *
 * `appliedRevision === null` heißt UNBEKANNT (ältere Box, noch kein
 * Herzschlag) - nie „nicht angekommen".
 */
/**
 * Die Antwort auf „Jetzt lesen" (Stufe 3). Jede Zahl ist OPTIONAL: ein
 * Fehlschlag trägt NIE einen Wert - nie eine 0, die sich wie eine Messung
 * liest.
 */
/** Der Schalt-Beleg einer Antwort des Probe-Kanals (Einheitsmodell Stufe 4). */
export interface ProbeSwitched {
  written: number;
  offAfterS?: number | null;
  readback?: number | null;
  readbackMatches?: boolean | null;
}

/** Das Ergebnis eines gefuehrten Schalt-Tests. */
export interface SchaltTestAntwort {
  passed: boolean;
  ttlSeconds: number;
  errorCode?: string | null;
  message?: string | null;
  switched?: ProbeSwitched | null;
}

export interface SelbstbauLeseAntwort {
  ok: boolean;
  raw?: number | null;
  registers?: number[] | null;
  value?: number | null;
  unit?: string | null;
  hint?: string | null;
  errorCode?: string | null;
  message?: string | null;
  receipt?: boolean;
}

/** Eine PRIVATE Geräte-Vorlage einer Anlage („Duplizieren", Stufe 3). */
export interface SiteComponentTemplate {
  templateRef: string;
  version: number;
  label: string;
  communication: string;
  connection?: Record<string, unknown> | null;
  channels?: unknown[] | null;
  note?: string | null;
  createdAt?: string | null;
}

export interface SiteComponents {
  componentAuthority: string;
  sollRevision?: string | null;
  appliedRevision?: string | null;
  appliedAt?: string | null;
  refusedRevision?: string | null;
  refusedReason?: string | null;
  /**
   * Der letzte bewusste HALT der Box (Befund L1): sie hat diese Revision
   * GESEHEN und nichts angewandt - heute, weil im Portal kein verbundenes
   * Gerät mehr hinterlegt ist. `null`/absent = kein Halt gemeldet (eine
   * ältere Box meldet ihn nie), ausdrücklich NICHT „kein Halt".
   */
  heldRevision?: string | null;
  heldReason?: string | null;
  /**
   * Wann diese Anlage AUTOMATISCH vom Gerät übernommen wurde (Einheitsmodell
   * Stufe 2). `null`/absent = nie übernommen - ausdrücklich NICHT dasselbe wie
   * box-verwaltet (eine neu angelegte Anlage ist portal-verwaltet, ohne je
   * übernommen worden zu sein).
   */
  adoptedAt?: string | null;
  components: SiteComponentRow[];
}

export interface SiteComponentRow {
  id: string;
  role?: string | null;
  entityType?: string | null;
  label?: string | null;
  brand?: string | null;
  model?: string | null;
  family?: string | null;
  communication?: string | null;
  connection?: Record<string, unknown> | null;
  sourceKind?: string | null;
  templateRef?: string | null;
  templateVersion?: number | null;
  definitionVersion: number;
  capacityKwp?: number | null;
  edgeSourceId?: string | null;
  syncStatus?: string | null;
}

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
  /**
   * WO eine Säule hängt (`haus` | `eigen`, Cockpit Phase 1 / C1) - nur bei
   * einem Ladepunkt gesetzt. `null` heisst „nicht gesagt" und wird als `haus`
   * gelesen; es ist die EINE zusätzliche Eingabe, die `topology.defaultRole`
   * braucht, damit die Fläche die Rollen-Auflösung des Servers nachvollziehen
   * kann (`rollen.isAutoAssigned`), statt sie zu raten.
   */
  connection?: string | null;
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
  /**
   * Seit wann diese Regel die Komponente DIREKT beansprucht (Steuerung Stufe
   * 7) — der Anker des Nachteil-Belegs. `null` = delegierter Anspruch (der
   * übergibt gerade an den Fahrplan) oder ein älteres Backend; dann wird KEIN
   * Nachteil behauptet, weil es den Zeitraum nicht gäbe, über den er gilt.
   */
  claimedAt?: string | null;
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

// --- UEMS: Messkanäle + berechnete Messstelle („Gesamtwert", AP-04 IP-13 / AP-10) ---

/**
 * Ein Messkanal einer Komponente, wie ihn das Read-Model
 * `GET …/komponenten/{entityId}/messkanaele` nennt: sein Kanal (`point_key`),
 * Anzeigename und seine Vertrags-Größe/Wertart/Richtung. Der Assistent für den
 * Gesamtwert liest daraus, welche Werte zueinander passen.
 *
 * ⚠ Die Felder heißen wie im echten Backend-JSON (`MesskanalDto`, `@JsonNaming`
 * = SnakeCase). Wer eines multi-wortig macht (`kadenz_s`), muss es hier
 * snake_case schreiben — `request()` wandelt NICHT um.
 */
export interface Messkanal {
  kanal: string;
  anzeigename: string | null;
  einheit: string | null;
  wertart: string | null;
  groesse: string | null;
  richtung: string | null;
  aktiv: boolean;
}

export interface MesskanalListe {
  site_id: string;
  komponente: string;
  inhaltsstand: string | null;
  messkanaele: Messkanal[];
}

/** Eine Messgröße wie im Messstellen-Vertrag (Größe · Richtung · Einheit · Wertart). */
export interface MessstelleGroesse {
  groesse: string;
  richtung: string;
  einheit: string;
  wertart: string;
}

/** Eine Messstelle, so wie die Liste/Detail-Route sie nennt (nur die hier gebrauchten Felder). */
export interface Messstelle {
  id: string;
  kennzeichen: string;
  name: string | null;
  art: string;
  medium: string | null;
  lebenszyklus: string;
  fehlt: string[];
  notiz: string | null;
}

/**
 * Ein Term der Formel (`GET …/{id}/formel`). ⚠ snake_case wie das echte Backend
 * (`MessstelleFormelDto.Term`, `@JsonNaming` = SnakeCase; belegt in
 * `MessstelleFormelApiTest`: `/terme/0/point_key`, `/eingang_art`,
 * `/quell_messstelle_id`). `request()` wandelt NICHT um — ein camelCase-Feld
 * wäre hier immer `undefined`, und die Site-Zuordnung fände nie einen Term.
 */
export interface MessstelleFormelTerm {
  position: number;
  eingang_art: string;
  entity_id: string | null;
  point_key: string | null;
  quell_messstelle_id: string | null;
  vorzeichen: string;
  faktor: number;
  groesse: MessstelleGroesse | null;
  eingerichtet: boolean;
  /** AP-10 IP-5: nur bei `eingang_art` = `verteilung` — die Kostenstelle. */
  verteilung_ziel?: string;
  /** AP-10 IP-5: nur der positive/negative Teil; fehlt = gesamt. */
  anteil?: 'positiv' | 'negativ';
}

/**
 * Eine Fassung der Formel (AP-10 IP-3, `messstelle-formel.md` §6), snake_case wie
 * `MessstelleFormelDto.Fassung`. `gueltig_ab` null = gilt seit Beginn (Fassung 1
 * des Bestands und des Anlegens); `gueltig_bis` ist der LETZTE Tag, einschließlich.
 */
export interface MessstelleFormelFassung {
  nummer: number;
  formel_typ: 'gewichtete_summe';
  gueltig_ab: string | null;
  gueltig_bis: string | null;
  herkunft: 'bestand' | 'anlage' | 'eintrag';
  rueckwirkend: boolean;
  /** „rückwirkend (5 Tage)“ — null, wenn nicht rückwirkend. */
  abzeichen: string | null;
  begruendung: string | null;
  eingetragen_am: string;
}

/**
 * Die Formel einer berechneten Messstelle (`GET …/{id}/formel`, snake_case): die
 * Terme der Fassung, die am Tag gilt. `fassung_am` steht NUR in der Antwort, wenn
 * `am` gefragt war — ohne Tag ist die Antwort die von vor AP-10 IP-3.
 */
export interface MessstelleFormel {
  messstelle_id: string;
  schema_version: string;
  hauptgroesse: MessstelleGroesse | null;
  terme: MessstelleFormelTerm[];
  formel_vorhanden: boolean;
  eingaenge_eingerichtet: boolean;
  fassung_am?: { tag: string; fassung: MessstelleFormelFassung | null };
}

/** Ein fehlender/veralteter Term des Live-Werts — genannt, nie verschwiegen. */
export interface MessstelleWertFehlend {
  position: number;
  grund: string;
}

/**
 * Der Live-Wert einer berechneten Messstelle (`GET …/{id}/wert`): die gewichtete
 * Summe der frischesten Eingänge. Fehlt/veraltet EIN Term, ist `wert` null
 * (`unvollstaendig`) und `fehlende` nennt die Terme — NIE eine Teilsumme.
 */
export interface MessstelleWert {
  wert: number | null;
  einheit: string | null;
  unvollstaendig: boolean;
  fehlende: MessstelleWertFehlend[];
  stand: string | null;
}

/** Ein 15-min-Zeitraster des Verlaufs; `wert` null = unvollständig (nie 0). */
export interface MessstelleVerlaufPunkt {
  zeit: string;
  wert: number | null;
}

/** Der Verlauf einer berechneten Messstelle (`GET …/{id}/verlauf`, snake_case). */
export interface MessstelleVerlauf {
  messstelle_id: string;
  einheit: string | null;
  punkte: MessstelleVerlaufPunkt[];
}

/** Der Körper von `POST /api/v1/messstellen/berechnet`. */
export interface BerechneteMessstelleAnlegen {
  name: string;
  terme: Array<{
    eingang_art: 'messkanal' | 'messstelle' | 'verteilung';
    entity_id?: string;
    point_key?: string;
    quell_messstelle_id?: string;
    vorzeichen: '+' | '-';
    faktor: number;
    /**
     * AP-10 IP-5: die Kostenstelle eines Verteilungs-Terms; seit AP-10 IP-8 liest der Term den Anteil
     * des Tages aus der Verteilung (eine unbekannte Kostenstelle ist 404).
     */
    verteilung_ziel?: string;
    /** AP-10 IP-5: fehlt = gesamt; `positiv`/`negativ` lehnt der Server ab (422 `anteil_wartet_auf_ap08`). */
    anteil?: 'gesamt' | 'positiv' | 'negativ';
  }>;
}

/** Der Körper von `POST /api/v1/messstellen/{id}/formel/fassungen` (AP-10 IP-3, streng, snake_case). */
export interface MessstelleFormelFassungEintragen {
  /** Der erste Tag der neuen Fassung (JJJJ-MM-TT); die laufende endet am Vortag. */
  gueltig_ab: string;
  formel_typ?: 'gewichtete_summe';
  terme: BerechneteMessstelleAnlegen['terme'];
  begruendung?: string;
}

/**
 * Eine Bezugsgröße (UEMS AP-09 IP-5, `/api/v1/bezugsgroessen`, snake_case wie der
 * Bezugsdaten-Vertrag). Die Wörter sind die Vokabulare von
 * `docs/contracts/v2/bezugsdaten-vectors.json`; `hat_werte` sagt, ob die Bedeutung
 * schon fest ist (M1) und ob sie noch löschbar ist (M6).
 */
export interface Bezugsgroesse {
  id: string;
  kennzeichen: string;
  name: string;
  wertart: 'periodenwert' | 'stand' | 'stammdatum';
  einheit: string;
  periode_art: 'tag' | 'woche' | 'monat' | 'jahr' | null;
  geltung_art: 'unternehmen' | 'standort' | 'gebaeude' | 'bereich' | 'prozess' | 'kostenstelle' | 'messstelle';
  geltung_id: string;
  geltung_name: string;
  hat_werte: boolean;
  archiviert_am: string | null;
  angelegt_am: string;
}

/**
 * Der Körper von `POST /api/v1/bezugsgroessen` (ohne `kennzeichen` vergibt der Server
 * BZ-0001 …) und `PUT …/{id}` (die GANZE Bezugsgröße, mit Kennzeichen). Streng gelesen.
 */
export interface BezugsgroesseAnfrage {
  kennzeichen?: string;
  name: string;
  wertart: Bezugsgroesse['wertart'];
  einheit: string;
  periode_art?: Bezugsgroesse['periode_art'];
  geltung_art: Bezugsgroesse['geltung_art'];
  geltung_id: string;
}

/** Wer eine Fassung eingetragen oder freigegeben hat. */
export interface BezugsgroessePerson {
  name: string;
  rolle: string | null;
  art: 'kunde' | 'unterstuetzung' | 'voltpilot' | 'notfall';
}

/** Eine Fassung eines Werts mit ihrer Herkunft; `stand` ist null, solange `stand_offen`. */
export interface BezugsgroesseFassung {
  fassung: number;
  vorgang: 'erstwert' | 'berichtigung' | 'ruecknahme';
  status: 'wirksam' | 'vorschlag' | 'zurueckgenommen' | 'abgelehnt';
  stand: string | null;
  /** Dezimaltext in der Einheit der Bezugsgröße — nie als Gleitkommazahl rechnen. */
  betrag: string | null;
  ersetzt_fassung: number | null;
  begruendung: string | null;
  kennzeichen: string[];
  herkunft: {
    art: 'eingabe' | 'import' | 'messkanal';
    von_hand: boolean;
    import_kennung: string | null;
    import_zeile: number | null;
    geliefert_text: string | null;
    geliefert_einheit: string | null;
  };
  urheber: BezugsgroessePerson;
  freigeber: BezugsgroessePerson | null;
  eingetragen_am: string;
}

/** Ein Wert: eine Periode (letzter Tag einschließlich) oder ein Zeitpunkt, mit seinen Fassungen. */
export interface BezugsgroesseWert {
  periode_von: string | null;
  periode_bis: string | null;
  zeitpunkt: string | null;
  zeitzone: string;
  /** null nach einer Rücknahme (nie 0) und solange `stand_offen`. */
  wirksamer_betrag: string | null;
  wirksame_fassung: number | null;
  stand_offen: boolean;
  fassungen: BezugsgroesseFassung[];
}

/**
 * Eine Kostenstelle (UEMS AP-10 IP-7, `/api/v1/unternehmen/kostenstellen`) — FLACH, ohne
 * Elternteil. `gueltig_bis` ist der LETZTE gültige Tag (einschließlich), `null` = offen; beendet,
 * nie gelöscht.
 */
export interface Kostenstelle {
  id: string;
  kennzeichen: string;
  name: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
  angelegt_am: string;
}

/** Ein Verweis auf eine Kostenstelle oder einen Prozess. */
export interface KostenstelleProzessVerweis {
  id: string;
  kennzeichen: string;
}

/** Ein Prozess (AP-10 IP-7, `/api/v1/unternehmen/prozesse`) — höchstens ein Elternteil, nur eine Ebene. */
export interface Prozess {
  id: string;
  kennzeichen: string;
  name: string;
  eltern: KostenstelleProzessVerweis | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
  angelegt_am: string;
}

/** Der Körper von `POST …/kostenstellen` und `POST …/prozesse`; `eltern_id` nur beim Prozess. */
export interface KostenstelleProzessAnlegen {
  kennzeichen: string;
  name: string;
  eltern_id?: string | null;
  gueltig_ab: string;
  gueltig_bis?: string | null;
}

/** Ein Intervall Messstelle → Prozess; `endet_mit_prozess`: der letzte Tag ist der des Prozesses. */
export interface MessstelleProzessZuordnung {
  id: string;
  prozess: KostenstelleProzessVerweis;
  name: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
  endet_mit_prozess: boolean;
}

/** Die Antwort von `GET/PUT /api/v1/messstellen/{id}/prozesse`. */
export interface MessstelleProzesse {
  messstelle_id: string;
  kennzeichen: string;
  am: string | null;
  prozesse: MessstelleProzessZuordnung[];
}

/**
 * Die Ablehnungen der Kostenstellen- und Prozess-Schnittstelle — der geschlossene Satz aus
 * `uems/KostenstelleProzessAbgelehnt` (gepinnt gegen OpenAPI `KostenstelleProzessFehler`).
 */
export type KostenstelleProzessFehlerCode =
  | 'anfrage_ungueltig'
  | 'nicht_gefunden'
  | 'unternehmen_nicht_angelegt'
  | 'kennzeichen_format'
  | 'kennzeichen_belegt'
  | 'zeitraum_ungueltig'
  | 'bereits_beendet'
  | 'zuordnung_besteht'
  | 'eine_ebene'
  | 'eltern_unbekannt'
  | 'prozess_unbekannt'
  | 'ziel_besteht_nicht'
  | 'messstelle_archiviert'
  | 'zuordnung_ueberlappt';

/** Eine Zeile des Verteilungs-Satzes (AP-10 IP-8): die Kostenstelle und ihr Anteil als Dezimaltext. */
export interface VerteilungZeileEingabe {
  kostenstelle_id: string;
  anteil_prozent: string;
}

/** Ein Anteil der Messstelle an einer Kostenstelle über Tage; `endet_mit_kostenstelle`: gilt nie länger als sie. */
export interface MessstelleVerteilungAnteil {
  id: string;
  kostenstelle: { id: string; kennzeichen: string };
  name: string;
  anteil_prozent: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
  endet_mit_kostenstelle: boolean;
}

/**
 * Die Antwort von `GET/PUT /api/v1/messstellen/{id}/verteilung`: mit `am` der Zustand des Tages —
 * `verteilt` oder ausdrücklich `nicht verteilt` (nie „zu 0 % verteilt“); ohne `am` `null`.
 */
export interface MessstelleVerteilung {
  messstelle_id: string;
  kennzeichen: string;
  am: string | null;
  zustand: 'verteilt' | 'nicht verteilt' | null;
  anteile: MessstelleVerteilungAnteil[];
}

/**
 * Die Ablehnungen der Verteilungs-Schnittstelle — der geschlossene Satz aus `uems/VerteilungAbgelehnt`
 * (gepinnt gegen OpenAPI `VerteilungFehler`).
 */
export type VerteilungFehlerCode =
  | 'anfrage_ungueltig'
  | 'nicht_gefunden'
  | 'unternehmen_nicht_angelegt'
  | 'messstelle_archiviert'
  | 'kostenstelle_unbekannt'
  | 'anteil_ungueltig'
  | 'ziel_besteht_nicht'
  | 'verteilung_summe'
  | 'formel_fassung_ueberlappt'
  | 'zuordnung_ueberlappt';

/** Die Antwort von `GET /api/v1/bezugsgroessen/{id}/werte`. */
export interface BezugsgroesseWerte {
  bezugsgroesse_id: string;
  kennzeichen: string;
  wertart: string;
  einheit: string;
  periode_art: string | null;
  von: string | null;
  bis: string | null;
  fassungen: BezugsgroesseLesart;
  werte: BezugsgroesseWert[];
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
  /**
   * Die Speicher-Kapazität DIESER Anlage (kWh) — das GEWICHT des
   * Portfolio-Ladestands (Stufe 4). `null`/absent = keine Batterie, nie eine 0.
   */
  storageCapacityKwh?: number | null;
  /**
   * Die Energie-Summen des laufenden Berliner Tages. Jedes Feld einzeln
   * `null`: eine reine Erzeuger-Anlage ohne Netz-Messung meldet kein
   * erfundenes `grid = 0`. Die Rollups hinken ihrem Auffrisch-Takt bis zu
   * 15 Minuten hinterher — für eine Tagessumme richtig, für „jetzt" falsch
   * (das kommt aus `live`).
   */
  energyToday?: OverviewEnergyToday | null;
  /** Zahl der Ladepunkte (`roleCounts` fasst sie unter `consumer` zusammen). */
  chargePointCount?: number;
  /**
   * Die AKTIVEN Anwendungen dieser Anlage — gespeicherter Kundenwille über der
   * Ableitung, dieselbe Regel wie das Regal. Absent = älteres Backend; das
   * Portfolio leitet dann aus der Zeile ab, was es belegen kann.
   */
  anwendungen?: string[];
  /**
   * UEMS AP-02 IP-3: der Standort dieser Anlage HEUTE. `null` = noch keinem
   * Standort zugeordnet (heute jede Bestandsanlage); absent = älteres Backend.
   */
  standort?: StandortBezug | null;
}

/** Die Energie-Summen eines Tages (kWh), jedes Feld einzeln `null`-fähig. */
export interface OverviewEnergyToday {
  pvKwh: number | null;
  loadKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
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

// ---- UEMS-Ortsstruktur: Unternehmen und Standorte (AP-02 IP-3) -------------
// Nur die Antwortformen von GET /api/v1/unternehmen, GET /api/v1/standorte
// (?stichtag=) und GET /api/v1/standorte/{id}; die Fläche dazu baut AP-01 IP-5.
// Die Ableitung (Stand am, Fläche, Zuordnung) ist der Server, gleich dem
// Vertrag docs/contracts/v2/ortsbaum-vectors.json — das Portal rechnet nichts nach.

/** Der Standort, dem eine Anlage heute zugeordnet ist; `gueltigAb` = Beginn der laufenden Zuordnung (ISO-Tag). */
export interface StandortBezug {
  id: string;
  name: string;
  kurzzeichen: string;
  gueltigAb: string;
}

/**
 * GET /api/v1/unternehmen — die Zahlen gelten HEUTE. `nicht_angelegt`: ein
 * Kundenbereich ohne Unternehmen-Zeile; dann sind die Stammdaten `null`, die
 * Zahlen stimmen trotzdem.
 */
export interface Unternehmen {
  zustand: 'angelegt' | 'nicht_angelegt';
  id: string | null;
  name: string | null;
  kurzname: string | null;
  zeitzone: string | null;
  /** Standorte, die es heute gibt (archivierte zählen nicht). */
  standortZahl: number;
  anlagenZahl: number;
  /** Anlagen, die heute keinem Standort zugeordnet sind. */
  nochNichtZugeordnetZahl: number;
  /** Der Sitz (additiv, AP-02 IP-4) — `null`, wenn kein Feld angegeben ist. */
  sitz?: StandortAdresse | null;
  /** Additiv (AP-02 IP-4). */
  rechtsform?: string | null;
}

export interface StandortAdresse {
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  land: 'DE' | 'AT' | 'CH' | null;
}

/** Eine Anlage am Standort; `gueltigBis` ist der letzte gültige Tag (einschließlich), `null` = offen. */
export interface StandortAnlage {
  id: string;
  name: string;
  gueltigAb: string;
  gueltigBis: string | null;
}

/**
 * Ein Standort zum Stichtag. Zeitgültig sind `bestand`, `anlagen`, die Zahlen
 * und die Fläche; Name, Adresse, Zeitzone, Zustand und `esFehlt` stehen wie
 * heute. Ohne Bestand am Stichtag: `anlagen` leer, Zahlen und Fläche `null`.
 */
export interface StandortAmStichtag {
  id: string;
  kurzzeichen: string;
  name: string;
  adresse: StandortAdresse | null;
  zeitzone: string;
  zustand: 'entwurf' | 'eingerichtet' | 'aktiv' | 'archiviert';
  /** Was einem Entwurf zum Einrichten fehlt; leer außerhalb des Entwurfs. */
  esFehlt: 'adresse'[];
  bestand: Bestand;
  /** Der Satz zum Bestand, nur wenn nicht `vorhanden`. */
  bestandText: string | null;
  anlagen: StandortAnlage[];
  anlagenZahl: number | null;
  gebaeudeZahl: number | null;
  bereichZahl: number | null;
  /** Eigene Fläche oder Summe der Gebäude (nur wenn jedes eine hat); `null`, nie 0. */
  flaecheM2: number | null;
  flaecheQuelle: FlaecheQuelle | null;
  /** Additiv (AP-02 IP-4): Codes, die erste ist die Hauptnutzung; `null` = nichts gewählt. */
  nutzung?: Nutzung[] | null;
  /** Additiv (AP-02 IP-4). */
  notiz?: string | null;
  /** Additiv (AP-02 IP-4): die Lage auf der Karte. */
  lage?: StandortLage | null;
  /** Additiv (AP-02 IP-4): wann er archiviert wurde (ISO-Zeitpunkt); `null`, solange er es nicht ist. */
  archiviertAm?: string | null;
}

/** Die Gruppe „Noch nicht zugeordnet" — es gibt sie nur, solange sie etwas enthält. */
export interface NochNichtZugeordnet {
  anlagenZahl: number;
  anlagen: { id: string; name: string }[];
}

/** GET /api/v1/standorte?stichtag= */
export interface StandorteAmStichtag {
  stichtag: string;
  /** Die Standorte, die es am Stichtag gab; leer ohne Standorte (nie ein 0-Objekt). */
  standorte: StandortAmStichtag[];
  /** Standorte, die es am Stichtag noch nicht gab oder die archiviert waren. */
  nichtGezeigt: StandortAmStichtag[];
  /** `null`, sobald jede Anlage zugeordnet ist. */
  nochNichtZugeordnet: NochNichtZugeordnet | null;
}

// ---- Ortsstruktur schreiben (UEMS AP-02 IP-4) --------------------------------
// Nur die Formen von PUT /api/v1/unternehmen und POST/PUT /api/v1/standorte,
// …/archivieren, …/wiederherstellen, …/kurzzeichen-vorschlag; die Fläche dazu
// baut IP-6. Jede Standort-Schreibroute antwortet mit `StandortAmStichtag`
// (heute), PUT /unternehmen mit `Unternehmen`; eine Ablehnung mit `OrtFehler`.

/** AP-02 E4 — Code = Kundenwort in Kleinbuchstaben (ä→ae, ö→oe, ü→ue, ß→ss). */
export type Nutzung =
  | 'produktion'
  | 'montage'
  | 'lager'
  | 'logistik'
  | 'buero'
  | 'technik'
  | 'aussenflaeche'
  | 'werkstatt'
  | 'labor'
  | 'verkauf'
  | 'sozialraeume'
  | 'sonstiges';

/** Die Lage auf der Karte — beide Koordinaten oder keine. */
export interface StandortLage {
  breitengrad: number;
  laengengrad: number;
}

/**
 * POST und PUT /api/v1/standorte. POST: `kurzzeichen` fehlt → automatisch ST-n,
 * `zeitzone` fehlt → die Vorgabe des Unternehmens; die Adresse ist Pflicht
 * (Straße, Ort, Land; PLZ optional). PUT: die ganze Menge — `kurzzeichen` und
 * `zeitzone` Pflicht, die Adresse nur außerhalb des Entwurfs.
 */
export interface StandortStammdaten {
  name: string;
  kurzzeichen?: string | null;
  adresse?: StandortAdresse | null;
  zeitzone?: string | null;
  nutzung?: Nutzung[] | null;
  notiz?: string | null;
  lage?: StandortLage | null;
}

/** POST …/wiederherstellen — optional ein neuer Name (das Umbenennen im selben Dialog). */
export interface StandortWiederherstellen {
  name?: string | null;
}

/** GET /api/v1/standorte/kurzzeichen-vorschlag — bewegt den Zähler nicht. */
export interface StandortKurzzeichenVorschlag {
  kurzzeichen: string;
}

/** PUT /api/v1/unternehmen — die ganze Menge; ein fehlendes Feld ist leer. */
export interface UnternehmenBearbeiten {
  name: string;
  kurzname?: string | null;
  zeitzone: string;
  sitz?: StandortAdresse | null;
  rechtsform?: string | null;
}

/** Wer den Namen oder das Kurzzeichen trägt (oder trug) — der Link „oder öffnen Sie …". */
export interface OrtVerweis {
  objekt_art: 'standort' | 'gebaeude' | 'bereich';
  id: string | null;
  kurzzeichen: string;
  name: string | null;
  /** Nur bei Kurzzeichen: das heutige Kurzzeichen des Trägers, ob archiviert, ob früher getragen. */
  heute?: string | null;
  archiviert?: boolean;
  frueher?: boolean;
}

/** Ein Sperrgrund beim Archivieren, in der festen Reihenfolge des Vertrags. */
export interface ArchivSperrgrund {
  art: 'gab_es_noch_nicht' | 'archiviert' | 'anlage_aktiv' | 'messstelle_aktiv' | 'geplante_zuordnung';
  objekt: 'anlage' | 'messstelle' | 'standort' | 'gebaeude' | 'bereich';
  id: string | null;
  kennzeichen: string | null;
  name: string;
  ab?: string;
  eltern?: string;
  weg: 'anlage_zuordnen' | 'messstelle_umziehen' | 'zuordnung_aufheben' | null;
}

/** Die Ablehnung der Ortsstruktur-Schreibrouten — nichts ist geschrieben. `message` nennt Grund und Weg. */
export interface OrtFehler {
  code:
    | 'anfrage_ungueltig'
    | 'nicht_gefunden'
    | 'name_belegt'
    | 'kurzzeichen_belegt'
    | 'archiviert'
    | 'archivieren_gesperrt'
    | 'wiederherstellen_gesperrt'
    // Gebäude/Bereich (IP-5): die Gründe des Ortsbaum-Vertrags mit seinem Satz.
    | 'ziel_art_unzulaessig'
    | 'ziel_gab_es_noch_nicht'
    | 'ziel_archiviert'
    | 'flaeche_ungueltig'
    | 'gab_es_noch_nicht'
    | 'gleiche_flaeche';
  message: string;
  feld?: string;
  verweis?: OrtVerweis;
  archiviert_am?: string | null;
  grund?: 'nicht_archiviert' | 'eltern_archiviert' | 'name_belegt';
  gruende?: ArchivSperrgrund[];
}

// ---- UEMS-Ortsstruktur: Gebäude und Bereiche (AP-02 IP-5) -------------------
// GET /api/v1/standorte/{id}/orte?stichtag= (der Ortsbaum), POST …/orte,
// PUT /api/v1/orte/{id}, PUT /api/v1/orte/{id}/flaeche. Die Fläche dazu baut
// IP-7/IP-8; jede Regel urteilt der Server nach docs/contracts/v2/ortsbaum-vectors.json.

export type OrtZustand = 'entwurf' | 'eingerichtet' | 'aktiv' | 'archiviert';

/**
 * Ein Bereich im Ortsbaum zum Stichtag. `gueltigAb`/`gueltigBis`: die am
 * Stichtag gültige Zuordnung (`gueltigBis` einschließlich, `null` = offen).
 * Ein Bereich erbt nie die Fläche seines Gebäudes.
 */
export interface OrtsbaumBereich {
  id: string;
  kurzzeichen: string;
  name: string;
  nutzung: Nutzung[] | null;
  notiz: string | null;
  zustand: OrtZustand;
  gueltigAb: string;
  gueltigBis: string | null;
  /** Die eigene Fläche am Stichtag — `null`, nie 0. */
  flaecheM2: number | null;
  flaecheQuelle: 'eigen' | null;
  /**
   * Die Messstellen, deren Ort am Stichtag GENAU dieser Knoten ist (am Gebäude nicht die
   * seiner Bereiche; AP-04 IP-7); 0, wenn keine — `null` nur ohne Messstellen-Quelle.
   */
  messstellenZahl: number | null;
}

export interface OrtsbaumGebaeude extends OrtsbaumBereich {
  baujahr: number | null;
  bereiche: OrtsbaumBereich[];
}

/**
 * GET /api/v1/standorte/{id}/orte?stichtag= — die Gebäude mit ihren Bereichen
 * und die Bereiche „direkt am Standort“, so wie sie am Stichtag galten. Gab es
 * den Standort am Stichtag nicht, sagt es `standort.bestand`; dann sind
 * `gebaeude` leer und `direktAmStandort` `null`. Gebäude und Bereiche tragen
 * keine Zeitzone (sie erben die des Standorts).
 */
export interface OrtsbaumAmStichtag {
  stichtag: string;
  standort: StandortAmStichtag;
  /** Die Summe der Gebäudeflächen — nur, wenn jedes eine hat; ein Hinweis, nie saldiert. */
  summeGebaeudeM2: number | null;
  /** Die Gebäude, denen am Stichtag die Fläche fehlt („für kWh/m² fehlt die Fläche“). */
  gebaeudeOhneFlaeche: string[];
  gebaeude: OrtsbaumGebaeude[];
  direktAmStandort: { bereiche: OrtsbaumBereich[]; messstellenZahl: number | null } | null;
}

/** POST /api/v1/standorte/{id}/orte */
export interface OrtAnlegen {
  art: 'gebaeude' | 'bereich';
  name: string;
  /** Fehlend = automatisch (G-n / B-n). */
  kurzzeichen?: string | null;
  /** Nur Bereich: das Gebäude dieses Standorts; fehlend = direkt am Standort. */
  elternId?: string | null;
  /** ISO-Tag; fehlend = heute in der Zeitzone des Standorts. */
  gueltigAb?: string | null;
  nutzung?: Nutzung[] | null;
  /** Nur Gebäude. */
  baujahr?: number | null;
  notiz?: string | null;
  /** Die erste Fläche, ab `gueltigAb`. */
  flaecheM2?: number | null;
}

/** PUT /api/v1/orte/{id} — ganz: fehlend ist leer; Name und Kurzzeichen Pflicht. */
export interface OrtBearbeiten {
  name: string;
  kurzzeichen: string;
  nutzung?: Nutzung[] | null;
  baujahr?: number | null;
  notiz?: string | null;
}

/** PUT /api/v1/orte/{id}/flaeche — ganze m² ab einem Tag (E3). */
export interface OrtFlaeche {
  m2: number;
  gueltigAb?: string | null;
}

/** `zustand` relativ zu heute; `gueltigBis` einschließlich. */
export interface OrtZuordnung {
  elternId: string;
  elternArt: 'standort' | 'gebaeude';
  elternName: string;
  gueltigAb: string;
  gueltigBis: string | null;
  zustand: 'gueltig' | 'geplant' | 'beendet';
}

export interface OrtFlaechenStand {
  m2: number;
  gueltigAb: string;
  gueltigBis: string | null;
  zustand: 'gueltig' | 'geplant' | 'beendet';
}

/** E2: rückwirkend erlaubt, aber sichtbar — `abzeichen` nur rückwirkend („rückwirkend (14 Tage)“). */
export interface OrtRueckwirkung {
  art: 'rueckwirkend' | 'ab_heute' | 'geplant';
  tage: number;
  abzeichen: string | null;
}

/** Ein Gebäude oder Bereich nach dem Schreiben (Antwort von POST/PUT). */
export interface Ort {
  id: string;
  art: 'gebaeude' | 'bereich';
  kurzzeichen: string;
  name: string;
  nutzung: Nutzung[] | null;
  baujahr: number | null;
  notiz: string | null;
  zustand: OrtZustand;
  /** Der Standort, an dessen Baum der Ort heute hängt. */
  standortId: string | null;
  zuordnungen: OrtZuordnung[];
  flaechen: OrtFlaechenStand[];
  /** Zum „gültig ab“ dieses Vorgangs; `null` beim Bearbeiten. */
  rueckwirkung: OrtRueckwirkung | null;
}

// ---- Messstelle zuordnen: Ort und elektrische Stellung (UEMS AP-04 IP-7) -----
// Nur die Formen von PUT /api/v1/messstellen/{id}/ort, …/stellung (Antwort: die
// Messstelle, deren `orte`/`elektrische_stellung` diese Zuordnungen tragen) und
// GET …/{id}/standort?am=; die Fläche dazu baut IP-8. Wie die Messstellen-Antwort
// in snake_case (die Form von docs/contracts/v2/messstelle.schema.json); jede
// Regel urteilt der Server (Tages-Mechanik des Ortsbaums, Regel 8 des Vertrags).

export type MessstelleStellung = 'Hauptzähler' | 'Unterzähler' | 'Erzeuger' | 'Speicher' | 'Abzweig' | 'keine';

/** Ein Ort mit Gültigkeit; `kennzeichen` ist das Kurzzeichen, `U` das Unternehmen; `gueltig_bis` einschließlich. */
export interface MessstelleOrtZuordnung {
  ort_art: 'unternehmen' | 'standort' | 'gebaeude' | 'bereich';
  kennzeichen: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/** Die elektrische Stellung mit Gültigkeit; `anlage` ist die ID, `unterzaehler_von` das Kennzeichen des Bezugs. */
export interface MessstelleStellungZuordnung {
  anlage: string;
  stellung: MessstelleStellung;
  unterzaehler_von: string | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/** PUT /api/v1/messstellen/{id}/ort — `korrektur: true` ersetzt das Intervall, das an `gueltig_ab` beginnt. */
export interface MessstelleOrtAendern {
  kennzeichen: string;
  gueltig_ab: string;
  korrektur?: boolean | null;
  grund?: string | null;
}

/** PUT /api/v1/messstellen/{id}/stellung */
export interface MessstelleStellungAendern {
  anlage: string;
  stellung: MessstelleStellung;
  unterzaehler_von?: string | null;
  gueltig_ab: string;
  korrektur?: boolean | null;
  grund?: string | null;
}

/**
 * GET /api/v1/messstellen/{id}/standort?am= — der Stand an einem Tag: Ort, Pfad bis zum
 * abgeleiteten Standort (Ortsbaum-Vertrag, Familie `messstelle_standort`) und die Stellung.
 */
export interface MessstelleStandortAm {
  am: string;
  ort: string | null;
  ort_art: MessstelleOrtZuordnung['ort_art'] | null;
  pfad: string[];
  standort: string | null;
  standort_id: string | null;
  grund: 'verortet' | 'am_unternehmen' | 'nicht_verortet' | 'ort_nicht_im_baum';
  elektrische_stellung: MessstelleStellungZuordnung | null;
}

// ---- Messstellen-Register (UEMS AP-04 IP-4) ---------------------------------
// Die Formen von GET /api/v1/messstellen?standort=&ort=&anlage=&zustand=&ohneQuelle=&stichtag=
// (die Liste IP-5 baut daraus die Fläche). `messstellen` trägt weiter die Vertrags-Form
// jeder Messstelle, `register` die Zeile zum Stichtag. Jede Ableitung macht der Server.

/** Der Ort am Stichtag und der daraus abgeleitete Standort (Ortsbaum-Vertrag, wie `MessstelleStandortAm`). */
export interface MessstelleRegisterOrt {
  id: string | null;
  /** Das Kurzzeichen des Orts; `U` = das Unternehmen; `null` = an dem Tag keiner. */
  kennzeichen: string | null;
  ort_art: MessstelleOrtZuordnung['ort_art'] | null;
  name: string | null;
  gueltig_ab: string | null;
  gueltig_bis: string | null;
  pfad: string[];
  standort: string | null;
  standort_id: string | null;
  standort_name: string | null;
  grund: MessstelleStandortAm['grund'];
}

/** Die elektrische Stellung am Stichtag. */
export interface MessstelleRegisterStellung {
  anlage: string;
  anlage_name: string | null;
  stellung: MessstelleStellung;
  unterzaehler_von: string | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/** Das Gerät des Messkanals: `geraet` das Kennzeichen (GR-4), `einbau` der Einbau (Z-5b). */
export interface MessstelleRegisterGeraet {
  id: string;
  geraet: string;
  einbau: string;
  bezeichnung: string | null;
}

/** Eine führende Bindung: Komponente, Messwert, Gerät und das „seit“ (`gueltig_ab`). */
export interface MessstelleRegisterBindung {
  id: string;
  komponente: string;
  komponente_name: string | null;
  kanal: string;
  kanal_name: string | null;
  geraet: MessstelleRegisterGeraet;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/**
 * Die Quelle der Hauptgröße zum Zeitpunkt. `berechnet` heißt: eine berechnete Messstelle hat
 * keine Quelle (ihre Formel kommt mit AP-10); `keine_datenquelle`: gemessen, aber keine
 * führende Quelle — nie eine 0. `davor` ist die führende Quelle, die zuletzt davor endete.
 */
export interface MessstelleRegisterQuelle {
  stand: 'gebunden' | 'berechnet' | 'keine_datenquelle';
  fuehrend: MessstelleRegisterBindung | null;
  davor: MessstelleRegisterBindung | null;
  vergleichsquellen: number;
}

/**
 * Die Beobachtung EINER Größe (AP-04 IP-15) — abgeleitet, nie gespeichert und nie geraten.
 * `zustand` ist eines der vier Wörter des Zustandsvertrags (`uemsZustand.ts`), `text` der
 * Kundensatz; `seit` trägt nur `liefert_nicht_seit`. `toleranz_s` ist das angewandte Fenster
 * `min(max(3 × kadenz_s, 300), 86400)` — die Kante gehört zu „liefert“.
 *
 * ⚠ 3 × Kadenz ist die BEOBACHTUNG; 2 × Kadenz ist die LÜCKE, eine ANDERE Aussage ohne Boden und
 * Deckel (AP-07 IP-9), die hier nicht vorkommt. Es gibt keinen Fehler- und keinen
 * Störungszustand: Schweigen ist nie ein bewiesener Fehlschlag.
 */
export interface MessstelleRegisterBeobachtung {
  zustand: 'liefert' | 'liefert_nicht_seit' | 'wartet_auf_erste_daten' | 'keine_datenquelle';
  text: string;
  seit: string | null;
  toleranz_s: number | null;
  kadenz_s: number | null;
  geraet: string | null;
}

/**
 * Der letzte Wert mit Qualität „gut“ der führenden Quelle. Genau eines von `wert` und `text` ist
 * gesetzt; `einheit` ist die des Messkanals — ohne jede Umrechnung.
 */
export interface MessstelleRegisterWert {
  wert: number | null;
  text: string | null;
  einheit: string | null;
  zeitpunkt: string;
}

/** Eine Nebengröße mit ihrer eigenen Beobachtung über ihre eigene führende Quelle. */
export interface MessstelleRegisterNebengroesse {
  id: string;
  groesse: { groesse: string; richtung: string; einheit: string; wertart: string };
  beobachtung: MessstelleRegisterBeobachtung | null;
  letzter_wert: MessstelleRegisterWert | null;
}

/**
 * Eine Zeile des Registers zum Stichtag. `lebenszyklus` ist der HEUTIGE (ein Stichtag verschiebt
 * Ort, Stellung und Quelle, nicht ihn); `beobachtung` und `letzter_wert` gelten der Hauptgröße
 * über ihre führende Quelle — `null` nur bei einer BERECHNETEN Messstelle (AP-10), nie geraten,
 * nie eine 0.
 */
export interface MessstelleRegisterZeile {
  id: string;
  kennzeichen: string;
  name: string | null;
  art: 'gemessen' | 'berechnet';
  medium: string;
  hauptgroesse: { groesse: string; richtung: string; einheit: string; wertart: string };
  ort: MessstelleRegisterOrt;
  elektrische_stellung: MessstelleRegisterStellung | null;
  quelle: MessstelleRegisterQuelle;
  lebenszyklus: 'entwurf' | 'eingerichtet' | 'aktiv' | 'angehalten' | 'archiviert';
  fehlt: string[];
  angehalten_ab: string | null;
  archiviert_am: string | null;
  beobachtung: MessstelleRegisterBeobachtung | null;
  letzter_wert: MessstelleRegisterWert | null;
  nebengroessen: MessstelleRegisterNebengroesse[];
}

/** „x von y Messstellen liefern Daten“ — nur `liefert` zählt im Zähler. */
export interface MessstelleRegisterAbdeckung {
  erfuellt: number;
  gesamt: number;
  text: string;
}

/** Dieselbe Zählung je Standort, mit Kurzzeichen und Namen. */
export interface MessstelleRegisterStandortAbdeckung extends MessstelleRegisterAbdeckung {
  id: string | null;
  kurzzeichen: string;
  name: string | null;
}

/**
 * Das Aggregat der Antwort: gezählt werden GENAU die gezeigten Zeilen mit einer Beobachtung
 * (die Filter gelten also auch hier); eine berechnete Messstelle steht in keinem Nenner, eine
 * Zeile ohne Standort nur beim Unternehmen.
 */
export interface MessstelleRegisterAggregat {
  unternehmen: MessstelleRegisterAbdeckung;
  standorte: MessstelleRegisterStandortAbdeckung[];
}

/**
 * GET /api/v1/messstellen — `messstellen` und `register` nennen dieselben Messstellen in
 * derselben Reihenfolge (nach Kennzeichen); `teilansicht` bleibt `false`, bis AP-03 Rechte je
 * Standort durchsetzt. `stichtag` ist der Tag von Ort und Stellung, `zeitpunkt` der Augenblick
 * der Quelle.
 */
export interface MessstellenRegister {
  messstellen: unknown[];
  register: MessstelleRegisterZeile[];
  stichtag: string;
  zeitpunkt: string;
  teilansicht: boolean;
  aggregat: MessstelleRegisterAggregat;
}

// ---- Zählerwechsel (UEMS AP-04 IP-17) ---------------------------------------
// Die Formen von POST /api/v1/messstellen/{id}/quellen/wechsel und
// POST /api/v1/geraete/{id}/austausch — EIN Vorgang, zwei Einstiege, dieselbe
// Anfrage und dieselbe Antwort. Die Fläche dazu baut IP-18; hier stehen nur die
// Typen. Entweder alle Wirkungen landen oder keine.

/** Ein abgelesener Zählerstand; `einheit` darf fehlen — dann gibt es den Hinweis `ablesestand_pruefen`. */
export interface MessstelleStand {
  wert: number;
  einheit: string | null;
}

/**
 * Das Kästchen, das kommt. Jedes Feld darf fehlen: `einbau_kennzeichen` vergibt dann der
 * Server (GR-4.2 …), Hersteller, Typ und Bezeichnung übernimmt er vom Vorgänger — die
 * `seriennummer` NIE: sie ist die des alten Kästchens (null = nicht erhoben).
 */
export interface ZaehlerwechselNeuesGeraet {
  einbau_kennzeichen?: string | null;
  hersteller?: string | null;
  typ?: string | null;
  seriennummer?: string | null;
  bezeichnung?: string | null;
}

/**
 * Wie das neue Gerät antwortet. Fehlt das Feld GANZ, bleibt die Verbindung des Vorgängers —
 * „gleiche Datenquelle und Geräte-ID", und dann entsteht auch keine neue Komponenten-Fassung.
 */
export interface ZaehlerwechselVerbindung {
  datenquelle?: string | null;
  geraete_id?: number | null;
}

/** Die Anfrage beider Einstiege. `zeitpunkt` fehlend = jetzt (Vergangenheit = rückwirkend). */
export interface Zaehlerwechsel {
  zeitpunkt?: string | null;
  neues_geraet?: ZaehlerwechselNeuesGeraet | null;
  verbindung?: ZaehlerwechselVerbindung | null;
  endstand_vorgaenger?: MessstelleStand | null;
  anfangsstand?: MessstelleStand | null;
  einstellungen_uebernehmen?: boolean | null;
  grund?: string | null;
}

/** Ein Einbau der Antwort: `geraet` ist die Stelle (GR-4), `einbau` das Kästchen (Z-5a). */
export interface ZaehlerwechselEinbau {
  id: string;
  geraet: string;
  einbau: string;
  seriennummer: string | null;
  eingebaut_am: string;
  ausgebaut_am: string | null;
}

export interface ZaehlerwechselGeraet {
  alt: ZaehlerwechselEinbau;
  neu: ZaehlerwechselEinbau;
  verbindung_neu: boolean;
}

/** Eine Größe einer Messstelle, die auf das neue Gerät umgezogen ist. */
export interface ZaehlerwechselBindung {
  messstelle: string;
  kennzeichen: string;
  groesse: string;
  richtung: string;
  rolle: 'fuehrend' | 'vergleich';
  beendet: unknown;
  neu: unknown;
}

/** Eine Einstellungs-Fassung, die auf den neuen Einbau übernommen wurde. */
export interface ZaehlerwechselEinstellung {
  id: string;
  art: string;
  komponente: string | null;
  kanal: string | null;
  anwendung: 'angewendet' | 'dokumentiert';
}

/**
 * Die Antwort beider Einstiege (201). `marken` zählt, in wie vielen Komponenten-Verläufen die
 * Marke „Zähler gewechselt" steht — sie ist ein isolierter Zusatz und lässt den Wechsel nie
 * scheitern, eine kleinere Zahl als `komponenten` ist also ehrlich, kein Fehler des Vorgangs.
 */
export interface ZaehlerwechselVorgang {
  geraet: ZaehlerwechselGeraet;
  komponenten: string[];
  bindungen: ZaehlerwechselBindung[];
  einstellungen: ZaehlerwechselEinstellung[];
  marken: number;
  rueckwirkung: { art: 'rueckwirkend' | 'ab_jetzt' | 'angekuendigt'; minuten: number; abzeichen: string | null };
  hinweise: 'ablesestand_pruefen'[];
}

// ---- Vorschlagsliste der Bestandsübernahme (UEMS AP-04 IP-16) ---------------
// Die Formen von GET /api/v1/standorte/{id}/messstellen-vorschlag und
// POST …/uebernehmen; die Fläche dazu baut AP-01 IP-9b. Nichts entsteht
// ungefragt: das GET liest nur, erst die Bestätigung legt Messstellen an.
// Was vorgeschlagen wird, entscheidet der Zwilling `uemsMessstelle.ts`
// (`vorschlagsliste`) — die Antwort trägt sein Urteil in snake_case.

/** Der Messwert hinter einer Größe des Vorschlags, mit der Herleitung (Regel 7). */
export interface MessstelleVorschlagQuelle {
  kanal: string;
  anzeigename: string | null;
  kanal_wertart: 'counter' | 'gauge';
  herleitung: 'zaehlerstand' | 'differenzen' | 'integration' | 'momentanwert';
}

/** Eine Größe der Messstelle (wie in der Messstellen-Antwort). */
export interface MessstelleVorschlagGroesse {
  groesse: string;
  richtung: string;
  einheit: string;
  wertart: string;
}

export interface MessstelleVorschlagNebengroesse {
  groesse: MessstelleVorschlagGroesse;
  quelle: MessstelleVorschlagQuelle;
}

/** „Unterzähler von": eine bestehende Messstelle oder eine Zeile DIESER Liste. */
export interface MessstelleVorschlagBezug {
  messstelle: string;
  bestehend: boolean;
  komponente: string | null;
  kanal: string | null;
}

export interface MessstelleVorschlagHinweis {
  code: 'integration' | 'ladestand_herkunft' | 'geraet_gewechselt' | 'standort_spaeter';
  text: string;
}

/**
 * Eine Zeile: was aus diesem Messwert eine Messstelle machen würde. `kennzeichen` ist
 * der automatische Vorschlag (E7) — vergeben wird es erst bei der Übernahme; `ab` ist
 * der Beginn der Bindung (der Verlauf der Komponente), `stellung` bleibt `null`, wo
 * die Topologie keine hergibt — nie geraten.
 */
export interface MessstelleVorschlag {
  kennzeichen: string;
  name: string;
  anlage: string;
  anlage_name: string | null;
  komponente: string;
  komponente_name: string | null;
  hauptgroesse: MessstelleVorschlagGroesse;
  quelle: MessstelleVorschlagQuelle;
  nebengroessen: MessstelleVorschlagNebengroesse[];
  stellung: MessstelleStellung | null;
  unterzaehler_von: MessstelleVorschlagBezug | null;
  ort: string;
  ab: string;
  stellung_ab: string;
  hinweise: MessstelleVorschlagHinweis[];
}

/** Was nicht vorgeschlagen wird, mit Grund und Satz; `kanal: null` = die ganze Komponente. */
export interface MessstelleVorschlagAusgelassen {
  anlage: string;
  komponente: string;
  komponente_name: string | null;
  kanal: string | null;
  grund:
    | 'abgeleitet'
    | 'ohne_messkanal'
    | 'ohne_geraet'
    | 'attribut_kanal'
    | 'keine_messgroesse'
    | 'ohne_richtung'
    | 'weitere_groesse'
    | 'vorzeichen_wert'
    | 'vergleich_kandidat'
    | 'gleicher_fluss'
    | 'passt_nicht';
  zu: string | null;
  text: string;
}

/** GET /api/v1/standorte/{id}/messstellen-vorschlag — `leer`/`text` nur ohne Vorschlag. */
export interface MessstelleVorschlagsliste {
  standort: string;
  standort_kennzeichen: string;
  standort_name: string;
  vorschlaege: MessstelleVorschlag[];
  ausgelassen: MessstelleVorschlagAusgelassen[];
  leer: 'alle_zugeordnet' | 'keine_komponente' | null;
  text: string | null;
}

/** Eine bestätigte Zeile — so, wie die Liste sie zeigt; nur `name` darf anders sein. */
export interface MessstelleVorschlagBestaetigt {
  komponente: string;
  kanal: string;
  hauptgroesse: MessstelleVorschlagGroesse;
  nebengroessen?: MessstelleVorschlagNebengroesse[];
  stellung?: MessstelleStellung | null;
  ab: string;
  name?: string | null;
}

/** POST …/messstellen-vorschlag/uebernehmen */
export interface MessstelleVorschlagUebernehmen {
  vorschlaege: MessstelleVorschlagBestaetigt[];
}

/** Die Antwort der Übernahme; `unveraendert` sind Zeilen, die es schon gab. */
export interface MessstelleVorschlagUebernommen<T = unknown> {
  neu: number;
  unveraendert: number;
  messstellen: T[];
}

// ---- Edge-Stand je Gerät (GET /api/v1/edge-versions) ------------------------

/**
 * Der von einem Gerät gemeldete Software-Stand. `coreVersion` kommt bevorzugt
 * aus dem top-level Update-Herzschlag, der auch ohne Flow-Deployment reist;
 * der Flow-Beleg bleibt Fallback und Quelle von `paletteVersion`.
 *
 * **Ein FEHLENDER Eintrag heißt „unbekannt", nie „veraltet".** Er bedeutet,
 * dass weder der moderne Top-Level-Stand noch der ältere Flow-Beleg vorliegt.
 */
export interface EdgeVersion {
  deviceId: string;
  siteId: string;
  coreVersion: string | null;
  paletteVersion: string | null;
  reportedAt: string;
  /**
   * Der Soll-Stand aus dem Release-Register (Geräteseiten Stufe 1 R2a);
   * `null` = leeres Register, also KEIN Maßstab. Optional, weil ein älteres
   * Backend das Urteil nicht bildet.
   */
  newestRelease?: string | null;
  /**
   * ⚠ DREIWERTIG: true = die Box fährt den neuesten registrierten Stand,
   * false = veraltet, `null`/absent = NICHT bewertbar (nichts gemeldet, oder
   * der Stand steht nicht im Register - eine Lücke im REGISTER, nie eine
   * Alters-Aussage über die Box).
   */
  upToDate?: boolean | null;
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
 *   limit    - reine BEGRENZUNG: die Entladung wurde auf den gemessenen
 *              Hausbedarf gedeckelt, ohne dass die Cloud den Slot für
 *              wirtschaftlich erklärt hat (`limit_discharge_to_load`); die
 *              Richtung ist immer `reduce`
 *   trim     - preisbewusste Begrenzung: die Ladung hält beim gemessenen
 *              PV-Überschuss
 *   fallback - kein aktueller Fahrplan: die eingebaute Eigenverbrauchs-Regel
 */
export type ExecutionMode =
  | 'plan'
  | 'follow'
  | 'limit'
  | 'trim'
  | 'absorb'
  | 'fallback'
  | 'idle_follow'
  | 'deficit_cover'
  | 'high_soc_follow'
  | 'high_soc_charge'
  | 'surplus_store'
  | 'autonomous_discharge';

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
  /** Der Sollwert VOR einer In-Slot-Korrektur. */
  executionPlannedKw?: number | null;
  /**
   * Der GEMESSENE Wert, dem die Korrektur folgt — verbleibender Hausbedarf bei
   * den Follower-Modi, PV-Überschuss bei `trim`/`absorb`. Null, wenn das Gerät ihn nicht messen konnte
   * (es regelt nie blind und meldet nie blind) — nie eine erfundene 0.
   */
  executionTargetKw?: number | null;
  /** Full floor actually applied to an idle correction. */
  executionFloorSocPct?: number | null;
  /** Device evidence that SOC/load/PV were fresh when correction ran. */
  executionMeasurementsFresh?: boolean | null;
  /**
   * WELCHE Quelle die Freigabe erteilt hat: `env` = die flottenweite
   * Allowlist, `device` = eine First-Light-Freigabe auf DIESER Box,
   * `platform` = das Modell-Register der Plattform. Null/absent = nicht
   * freigegeben oder ältere Edge-Version — eine Abwesenheit ist also nie eine
   * Aussage über die Quelle.
   */
  /**
   * Der Messkanal, ohne den diese ANLAGE ausdrücklich eingerichtet wurde
   * (heute `soc_pct`: eine Batterie ohne gekoppeltes BMS). Als einziges Feld
   * dieser Zeile eine PORTAL-Tatsache, keine Meldung des Geräts - sie steht in
   * der gespeicherten Anbindung der Wechselrichter-Komponente. `null`/absent =
   * keine solche Ausnahme (oder ein älterer Backend-Stand).
   */
  missingReadingChannel?: string | null;
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
  /**
   * Der EINSPEISEWÄCHTER („Grenzen & Wächter" Stufe 0). `null` = die Box hat
   * ihn nicht gemeldet (ältere Edge, oder für die Anlage ist gar keine
   * Einspeisegrenze hinterlegt) — nie „es gibt keine Grenze".
   */
  exportGuard: ExportGuard | null;
  /**
   * Die Einspeisegrenze, die der WECHSELRICHTER SELBST hält. `null` = nicht
   * gemeldet (ältere Edge, Familie ohne belastbares Register, oder noch nicht
   * gelesen) — nie eine erfundene 0.
   */
  deviceExportLimit: DeviceExportLimit | null;
  /**
   * Die Abregelung JE EINHEIT (R4a / Captain-Entscheid E2). **Dreiwertig, und
   * die zwei leeren Fälle sagen Verschiedenes:** `null`/fehlend = auf diesem
   * Pfad nicht geladen bzw. älteres Backend, `[]` = die Box hat keine gemeldet
   * (ältere Edge — der Block ist älter als die Liste). Nur eine nicht-leere
   * Liste ist eine Zuordnung.
   *
   * ⚠ Sie kann KÜRZER sein als `units`: eine Einheit ohne Join-Schlüssel wird
   * beim Ingest verworfen, statt sie niemandem zuzuordnen. `units` bleibt DIE
   * Zahl — nie aus der Länge dieser Liste ableiten.
   */
  perUnit?: CurtailmentUnit[] | null;
}

/**
 * Eine abregel-fähige Einheit, wie die BOX sie meldet. Bis dahin konnte die
 * Cloud nur zählen („0 von 2 Wechselrichtern freigegeben") — WELCHER der zwei
 * gemeint ist, wusste sie nicht, und eine Ableitung im Portal wäre genau die
 * erfundene Zuordnung, die `ANLAGENWEITE_BEFEHLE` vermeidet (E2).
 */
export interface CurtailmentUnit {
  /**
   * Der Join-Schlüssel auf die gemeldete Quelle (`/sources.sourceId`) — so wird
   * aus einer Einheit ein GERÄTENAME, gebildet vom EINEN Namensbildner des
   * Portals. Ein Name reist bewusst nicht über den Draht.
   */
  sourceId: string;
  /** Diese Einheit trägt eine First-Light-Freigabe (aus dem KERN der Box). */
  certified: boolean;
  /** Die Begrenzung, die DIESE Einheit hält; null = keine (nie eine erfundene 0). */
  appliedCapKw: number | null;
  /**
   * Ihr Rücklese-Urteil; `null` = nichts befohlen (nur beobachtet). Nur `true`
   * ist eine Bestätigung — `null` darf nie als Widerspruch gelesen werden.
   */
  match: boolean | null;
}

/**
 * Der live laufende Einspeisewächter, wie die Box ihn in JEDEM Herzschlag
 * meldet — und wie ihn cloud-seitig bis zu dieser Stufe niemand las. Genau
 * deshalb war „welche Einspeisegrenze hält die Box, und wirkt sie überhaupt?"
 * nur per Wartungstunnel zu beantworten (Herzogau, zwei Untersuchungsrunden).
 *
 * **`effective` ist das Feld, für das es den Block gibt:** ein Wächter, der
 * eine perfekte Kappe berechnet und sie NIRGENDS hinschreibt, muss das laut
 * sagen, statt eine Anlage an einen Schutz glauben zu lassen, den sie nicht hat.
 */
export interface ExportGuard {
  /** Die für die Anlage geltende Einspeisegrenze, wie die BOX sie kennt. */
  limitKw: number;
  /** Das maschinenlesbare Wort NEBEN dem deutschen Satz. */
  state: 'ueberwacht' | 'regelt' | 'haelt' | 'zieht_zusammen' | 'sicherheitskappe';
  /**
   * Der deutsche Satz der Box zu genau diesem Zustand. Er wird EINMAL auf dem
   * Gerät geschrieben — das Portal reicht ihn durch, statt ihn neu zu
   * formulieren, damit `:8484` und Portal dasselbe Urteil nie anders benennen.
   */
  reason: string | null;
  /** Die kommandierte anlagenweite PV-Kappe; null = keine (nie eine 0). */
  capKw: number | null;
  /** Die Kappe hält die Erzeuger gerade wirklich zurück. */
  limiting: boolean;
  /** Das Urteil entstand NICHT aus einer frischen Messung am Netzpunkt. */
  blind: boolean;
  /** false = die Kappe erreicht KEIN Gerät. */
  effective: boolean;
  /** Der deutsche Satz, der die Lücke benennt; null wenn es keine gibt. */
  reach: string | null;
}

/**
 * Die Einspeisegrenze, die im WECHSELRICHTER selbst eingestellt ist — eine
 * fremde Wahrheit im Gerät, die die Box liest und nie schreibt. In Herzogau
 * hielt der Deye 33,0 kW (Register 0x00E7), während im Portal 70 kW hinterlegt
 * waren; zwei Runden lang unsichtbar, weil niemand das Register las.
 */
export interface DeviceExportLimit {
  limitKw: number;
  /** Woher der Wert stammt („0x00e7") — eine Zahl ohne Herkunft ist kein Beleg. */
  register: string;
  /**
   * Der EIGENE Frische-Anker: das Register wird höchstens einmal täglich
   * gelesen (Ein-Socket-Gesetz), darf sich also nie `checkedAt` ausleihen.
   */
  readAt: string;
}

/**
 * Der KOMMANDO-VERLAUF einer Anlage bzw. EINER Komponente
 * (Kommando-Transparenz V1, Konzept `vp-kommando-transparenz-k3` §6.3) - EINE
 * Antwort für Kopf, „Gerade jetzt", „Grenzen & Wächter", Tages-Film und
 * Fußnote.
 *
 * **`recordingSince` ist der Grund, warum ein leerer Verlauf nicht gelogen
 * ist:** `null` heißt „für diese Anlage wurde noch gar nicht aufgezeichnet" -
 * davor wird NICHTS behauptet, auch nichts Entlastendes.
 *
 * **`writes: false` ist die F4-Antwort:** an diese Komponente geht kein
 * einziger Befehl, sie wird nur gelesen. Der SATZ dazu wohnt in
 * `src/befehle.ts`; hier steht die Tatsache.
 */
export interface CommandHistory {
  recordingSince: string | null;
  /** Der Herzschlag-Takt - ein Wechsel-und-zurück dazwischen ist unsichtbar. */
  accuracySeconds: number;
  from: string;
  to: string;
  entityId: string | null;
  entityLabel: string | null;
  /**
   * Echo des Geräte-Filters; null = die ganze Anlage bzw. eine Komponente. Die
   * Antwort trägt bewusst KEINEN Geräte-NAMEN - den bildet `entityLabel.ts`
   * `deviceName`, und ein zweiter wäre ein Zwilling, der abdriften kann.
   */
  deviceRef?: string | null;
  /**
   * true = die Box (jede Zeile ihres Geräts), false = ein Gerät dahinter (nur
   * die Zeilen seiner Komponenten), null/absent = nicht gefiltert. **Ein
   * SERVER-Fakt** - die Fläche darf ihn nicht raten.
   */
  deviceIsBox?: boolean | null;
  writes: boolean;
  /** Der Deckel hat gegriffen - ältere Zeilen fehlen. */
  truncated: boolean;
  /**
   * Der TREFFER-ZÄHLER der Suche (Geräteseiten Revision B §6): `total` sind die
   * Zeilen dieses Zeitraums OHNE Filter, `matched` die mit ihm - „14 von 212".
   *
   * ⚠ Ein ÄLTERES Backend meldet beide nicht; dann sagt die Fläche nichts,
   * statt eine Bilanz zu erfinden.
   */
  total?: number;
  matched?: number;
  /**
   * Der Seiten-Cursor nach hinten (der Beginn der ältesten gelieferten Zeile),
   * oder null/absent, wenn das Fenster vollständig gezeigt ist.
   *
   * ⚠ Er vergleicht serverseitig `<=`, damit an der Seitengrenze keine Zeile
   * lautlos verloren geht - die Fläche mischt die Seiten deshalb über die `id`.
   */
  nextBefore?: string | null;
  /** Älteste zuerst (der Tages-Film läuft vorwärts). */
  entries: CommandEntry[];
  control: ControlStatus | null;
  curtailment: CurtailmentStatus | null;
}

/** Das Rücklese-Urteil. ⚠ `keine_antwort` ist NIE `abweichend`. */
export type CommandVerdict =
  | 'bestaetigt'
  | 'abweichend'
  | 'keine_antwort'
  | 'prueft'
  | 'unbestaetigt';

export type CommandEventKind =
  | 'notaus_ein'
  | 'notaus_aus'
  | 'freigabe_erteilt'
  | 'freigabe_widerrufen'
  | 'luecke'
  | 'verlauf_gedeckelt';

/**
 * Eine HALTEPERIODE (`kind: 'periode'`) oder ein Punkt-Ereignis
 * (`kind: 'ereignis'`, dann trägt `eventKind` seine Art).
 *
 * Jedes Feld darf fehlen und ein fehlendes heißt „nicht gemessen", nie 0 -
 * insbesondere sind die vier `cycles*` in V1 IMMER `null` (aus
 * 15-Sekunden-Momentaufnahmen lässt sich die Zahl der 10-Sekunden-
 * Schreibvorgänge nicht ableiten).
 */

/**
 * EIN Vorgang aus dem append-only Register-Journal, zu einer Zeile gefaltet
 * (Konzept `vp-reg-schreib-konzept-p8` §2.5).
 *
 * Die HERKUNFT steht an der Zeile, weil genau das die Frage ist, die dieses
 * Journal beantworten muss: `kunde`/`voltpilot` sind über ein validiertes Token
 * beweisbare Identitäten, `geraet` ist der Wartungszugang an der Box - für den
 * es cloud-seitig KEINE Identität gibt, und genau das sagt das Wort.
 */
export interface RegisterWriteEvent {
  id: number;
  requestId: string;
  source: 'portal' | 'geraet' | string;
  deviceId: string | null;
  deviceRef: string | null;
  lane: string | null;
  /**
   * Die KOMPONENTE der Lane „komponente" (sonst null) - die einzige Zuordnung,
   * mit der sich ein Vorgang einem Gerät HINTER der Box zuschreiben lässt.
   */
  entityId?: string | null;
  targetLabel: string | null;
  registerKind: string | null;
  address: number | null;
  addressHex: string | null;
  /** VERBATIM, wie getippt. */
  addressInput: string | null;
  valueInput: string | null;
  note: string | null;
  valueRaw: number | null;
  expectedBefore: number | null;
  registerLabel: string | null;
  registerClass: 'netz_compliance' | 'bekannt' | 'unbekannt' | string | null;
  scaleNote: string | null;
  origin: 'kunde' | 'voltpilot' | 'geraet' | string | null;
  actorName: string | null;
  actorRole: string | null;
  viaTenantSwitcher: boolean;
  requestedAt: string;
  beforeRaw: number | null;
  afterRaw: number | null;
  /** DREIWERTIG: null = keine Aussage, false = nicht übernommen, true = übernommen. */
  adopted: boolean | null;
  outcome: string | null;
  reason: string | null;
  answeredAt: string | null;
}

/** Das Ergebnis EINES Schritts der Zwei-Schritt-Strecke. */
export interface RegisterWriteOutcome {
  requestId: string;
  mode: 'lesen' | 'schreiben' | string;
  ok: boolean;
  outcome: string;
  beforeRaw: number | null;
  afterRaw: number | null;
  beforeScaled: number | null;
  afterScaled: number | null;
  adopted: boolean | null;
  errorCode: string | null;
  message: string | null;
  targetLabel: string | null;
  address: number;
  addressHex: string;
  registerLabel: string | null;
  registerClass: string;
  scaleNote: string | null;
  /** Der Betreiber-Hinweis des Register-Wissens, oder null. */
  registerNote?: string | null;
  /** Die Einheit des skalierten Werts; null = keine bekannte Skala. */
  scaleUnit?: string | null;
  noteRequired: boolean;
  confirm: string | null;
  /**
   * Wie oft dieses Register auf diesem Gerät HEUTE schon angefordert wurde
   * (Berliner Tag) - EEPROM-Ehrlichkeit statt einer Sperre.
   */
  writesToday?: number;
  lane?: string;
  at: string;
}

/** Ein Ziel des Geräte-Pickers (Stufe 2). */
export interface RegisterWriteTarget {
  lane: 'primary' | 'entity' | 'lan' | string;
  deviceId: string;
  entityId: string | null;
  label: string;
  brand: string | null;
  model: string | null;
  family: string | null;
  communication: string | null;
  host: string | null;
  port: number | null;
  unitId: number | null;
  /** ANZEIGE-Hilfe, keine Zusage - die Box entscheidet. */
  writable: boolean;
  reason: string | null;
  /**
   * ⚠ Dieses Ziel NENNT eine Komponente, wird aber über die primäre Lane
   * erreicht (Geräteseiten Stufe 2, E4). Absent = ein gewöhnliches Ziel -
   * ein älteres Backend kennt das Feld nicht, und „unbekannt" heißt hier wie
   * überall „nein", nie eine erfundene Abbildung.
   */
  primaryAlias?: boolean;
}

/** Eine Register-Familie des kuratierten Verzeichnisses (reine Anzeige). */
export interface RegisterKnowledgeFamily {
  family: string;
  brand: string | null;
  label: string | null;
  registers: {
    address: number;
    addressHex: string;
    label: string;
    clazz: string;
    scale: number | null;
    unit: string | null;
    note: string | null;
  }[];
}

/** Was der Mensch im Register-Drawer eingetragen hat - ROH. */
export interface RegisterWriteInput {
  deviceId?: string;
  /** Das gewählte Ziel; absent = primary (zeichengleich zu Stufe 1). */
  lane?: string;
  entityId?: string;
  host?: string;
  port?: number;
  unitId?: number;
  registerKind?: string;
  address: string;
  value?: string;
  expectedBefore?: number | null;
  note?: string;
}

export interface CommandEntry {
  id: number;
  stream: 'batterie' | 'abregelung' | 'verbraucher' | 'waechter' | 'register' | string;
  kind: 'periode' | 'ereignis';
  eventKind: CommandEventKind | string | null;
  startedAt: string;
  /** null = die Periode LÄUFT noch. */
  endedAt: string | null;
  mode: string | null;
  path: string | null;
  whyKind: 'fahrplan' | 'sicherung' | string | null;
  whyRef: string | null;
  commandedKwFirst: number | null;
  commandedKwLast: number | null;
  commandedKwMin: number | null;
  commandedKwMax: number | null;
  verdict: CommandVerdict | string | null;
  cycles: number | null;
  cyclesConfirmed: number | null;
  cyclesNoAnswer: number | null;
  cyclesMismatch: number | null;
  controlEnabled: boolean | null;
  released: boolean | null;
  foreignInfluence: boolean | null;
  entityId: string | null;
  source: 'cloud_abgeleitet' | 'geraet' | 'portal' | string;
  /** Der Roh-Blick (F1: für ALLE Kunden aufklappbar). */
  detail: CommandDetail | null;
  /**
   * NUR auf den Zeilen des vierten Stroms `register`: der gefaltete Vorgang aus
   * dem Journal. Ein älteres Backend lässt das Feld weg - dann gibt es die
   * Zeile ohnehin nicht (das Strom-Wort ist ihm auch unbekannt).
   */
  register?: RegisterWriteEvent | null;
}

export interface CommandDetail {
  mismatchRoles: string | null;
  certSource: string | null;
  units: number | null;
  certifiedUnits: number | null;
  state: string | null;
  reasonCode: string | null;
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
  /**
   * Was dieses Gerät über eine per CAN GEKOPPELTE Batterie meldet (P4) - beim
   * Deye der Registerblock 0x00D2..0x00DF: `bms_soc_pct`, `bms_voltage_v`,
   * `bms_current_a`, die Lade-/Entladegrenzen, `bms_alarm`/`bms_fault` und
   * `bms_type`.
   *
   * `null`/abwesend heißt „keine solche Kopplung", und das ist heute JEDE
   * Anlage: ein Block voller Nullen ist die belegte Signatur „nicht gekoppelt",
   * und die Box veröffentlicht dafür gar keinen Kanal - nie eine erfundene 0 %.
   * Ein älteres Backend lässt das Feld schlicht weg. Reine ANZEIGE.
   */
  bms?: Record<string, number> | null;
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
  /**
   * The whole battery's value on that Berlin day, measured against a plant
   * WITHOUT a battery. ⚠ **ADMIN number since the captain's 04.09.2026 call** —
   * no customer surface may render it; the customer yardstick is
   * {@link EarningsDaily.savedSteuerungEur}.
   */
  savedEur: number;
  /**
   * What VoltPilot's STEERING was worth on that Berlin day, measured against
   * the SAME plant with the SAME battery run dumb (charge every surplus, cover
   * every need, no prices, never hold for later) - the one yardstick every
   * customer surface uses.
   *
   * `null`/absent = no comparison for that day (the plant has no battery master
   * data, or an older backend does not ship the field). A surface then shows
   * NOTHING for that day - never the total as a substitute, never a fake zero.
   */
  savedSteuerungEur?: number | null;
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
  /**
   * Die DREITEILUNG `savedEur = savedSpeicherEur + savedSteuerungEur`
   * (Audit `vp-geldzahlen-audit-x7` §2.5 / PR 591, Erlöse-Konzept §3.6):
   * `savedSpeicherEur` ist, was ein STUR arbeitender Standard-Speicher
   * (gleiche Physik, null Preisbewusstsein) gegenüber der speicherlosen
   * Anlage erwirtschaftet hätte; `savedSteuerungEur` ist der EXAKTE Rest —
   * der Mehrwert von VoltPilots Steuerung. Die Identität gilt serverseitig
   * per Konstruktion (BigDecimal-Subtraktion), nicht per Rundungsglück.
   *
   * ⚠ Beides ist `null`, wo die Anlage keine gepflegten Batterie-Stammdaten
   * hat — dann sagt `steuerungSplitReason` warum, und die Fläche zeigt
   * ehrlich NUR die Gesamtzahl statt einer geratenen Referenz-Batterie.
   *
   * OPTIONAL, weil ein ÄLTERES Backend sie nicht sendet: `undefined` wird wie
   * `null` OHNE Grund behandelt (nur Zeile 1, kein Nachtrag-Link) — ein
   * fehlendes FELD ist kein fehlendes STAMMDATUM (`speicherAussage.ts`).
   */
  savedSpeicherEur?: number | null;
  savedSteuerungEur?: number | null;
  steuerungSplitReason?: 'no_battery_data' | null;
  anzulegenderWertCtKwh: number | null;
  firstCoveredDate: string | null;
  peakShaving?: PeakShaving | null;
  /**
   * Optional period facts of the site-scoped earnings endpoint. They let the
   * cockpit distinguish a RUNNING cash-flow interim result from a completed
   * result and show the separately valued battery inventory next to it.
   * Fleet rows legitimately omit them.
   */
  range?: string | null;
  to?: string | null;
  speicherDeltaKwh?: number | null;
  speicherWertCtKwh?: number | null;
  speicherWertEur?: number | null;
  speicherWertBasis?: string | null;
  /**
   * Die EINE grosse Zahl aller Flaechen: das Ergebnis „unterm Strich"
   * (Erloese-Konzept E9, Paket P9). Beide Endpunkte tragen genau EINEN der
   * zwei Wege dorthin, und `erloesNetto.nettoEur()` ist die EINE Ableitung,
   * die sie liest: der anlagen-scharfe Endpunkt liefert `nettoErgebnisEur`
   * fertig, der mandantenweite nur `actualEur` (aus dem sich dasselbe Netto
   * ueber die serverseitig zugesicherte Identitaet ergibt). Optional, damit
   * ein aelterer Endpunkt und jede Test-Attrappe den Vertrag weiter erfuellt.
   */
  nettoErgebnisEur?: number | null;
  actualEur?: number | null;
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
  /**
   * Whether the EXPORT side is valued at the feste EEG-Einspeisevergütung
   * (audit vp-review-eeg-r1 A1) - true only for an EEG-vergütete
   * `eigenverbrauch` plant with a commissioned PV asset; DV plants stay
   * spot + Marktprämie. Gates the "Ihre feste Einspeisevergütung" copy so
   * the provenance sentence never claims "Börsenpreis" for an EEG feed-in.
   * Optional so an older/fleet backend never over-claims (undefined =
   * unchanged, conservative Börsenpreis wording).
   */
  exportVerguetungPriced?: boolean | null;
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

/**
 * **Die Einordnung der Flotten-Zahl** — Erlöse-Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.7 Befund **B13**, Runde-1-Entscheid **E3**
 * (Paket P6).
 *
 * Der behobene Befund: das Portfolio verglich einen LAUFENDEN Tag mit dem
 * GANZEN Vortag und schrieb „↑ 532 % mehr als am Vortag" darüber. Der Server
 * liefert jetzt zwei Beträge über GLEICH LANGE Grundlagen — aus derselben
 * Preiskomposition wie die Zeilen (kein zweites SQL).
 *
 * **`modus` sagt, WIE verglichen werden darf** — das Portal formuliert daraus,
 * es entscheidet es nicht:
 * `gleicher_zeitpunkt` (laufender Tag, beide Seiten bis `bisStunde`; NUR hier
 * darf ein Prozentsatz stehen) · `ganze_periode` (abgeschlossener Tag, beide
 * Seiten vollständig).
 *
 * **Absent heißt: es gibt nichts ehrlich zu vergleichen** — dann bleibt die
 * Zeile WEG, nie eine erfundene Null und nie ein halber Tag gegen einen
 * ganzen. Für Monat/Jahr/Gesamt ist er per Vertrag absent; dort liefert der
 * zweite Abruf mit verschobenem Anker die zwei Beträge, und ein Prozentsatz
 * wäre per E3 ohnehin verboten.
 */
export interface EarningsVergleich {
  modus: 'gleicher_zeitpunkt' | 'ganze_periode';
  /** Die Berliner WANDUHR-Stunde, bis zu der BEIDE Seiten summiert sind. */
  bisStunde: number | null;
  jetztEur: number;
  vorherEur: number;
}

export interface Earnings {
  range: EarningsRange;
  from: string;
  to: string;
  sites: EarningsSite[];
  totals: EarningsTotals;
  /** Absent auf einem älteren Backend — die Zeile bleibt dann weg. */
  vergleich?: EarningsVergleich | null;
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
  /**
   * Whether the export side is valued at the feste EEG-Einspeisevergütung
   * (audit vp-review-eeg-r1 A1). Optional so an older backend never
   * over-claims (undefined = conservative Börsenpreis wording); the
   * consumers gate on `=== true`.
   */
  exportVerguetungPriced?: boolean | null;
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
  /**
   * Das BESTANDSKONTO des Zeitraums (Diagnose `vp-tagesbild-minus-f3` §6):
   * wie viel Energie am Ende MEHR (+) oder weniger (−) im Speicher steckt als
   * am Anfang, und was der Fahrplan sie wert findet.
   *
   * ⚠ `speicherWertEur` ist ausdrücklich KEIN Summand von `savedEur` — das
   * bleibt die GEMESSENE Kasse. Der Bestand ist der zweite, als „nach dem Plan
   * bewertet" beschriftete Posten daneben; ihn hineinzurechnen ergäbe zwei
   * Geldwahrheiten über dieselbe Kasse.
   *
   * OPTIONAL, weil ein ÄLTERES Backend sie nicht sendet — dann rendert die
   * Fläche exakt wie vor dem Fix (die Haus-Regel „absent = älterer Stand").
   */
  speicherDeltaKwh?: number | null;
  speicherWertCtKwh?: number | null;
  speicherWertEur?: number | null;
  speicherWertBasis?: 'plan' | 'terminal' | null;
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

export async function downloadMeasurementExport(
  deviceId: string,
  pointKey: string,
  range: MeasurementRange,
  representation: 'raw' | 'decoded',
  from?: string,
  to?: string,
  siteId?: string,
  entityId?: string,
) {
  const token = await freshToken();
  const path = `/api/v1/devices/${deviceId}/measurement-selection/${encodeURIComponent(pointKey)}/export?range=${range}&representation=${representation}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`;
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantOverride ? { 'X-Tenant-Id': tenantOverride } : {}),
    },
  });
  if (!response.ok) throw new ApiError(response.status, 'Der Export konnte nicht erstellt werden.');
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `messwert-${pointKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.csv`;
  link.click();
  URL.revokeObjectURL(href);
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
export type {
  CockpitLayoutDocument,
  CockpitLayoutLayer,
  CockpitLayoutResponse,
  Flaeche as CockpitLayoutFlaeche,
} from './cockpitLayout';
export type {
  EigeneAuswertungDef,
  EigeneAuswertungWerte,
  EigenerWert,
} from './eigeneAuswertung';

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

// ---------------------------------------------------------------------------
// Das ÄNDERUNGSPROTOKOLL (UEMS AP-04 IP-21) — drei Lesewege auf dieselben
// Einträge: je Messstelle, je Gerät und für das ganze Unternehmen.
//
// ⚠ ZWEI ZEITACHSEN, und sie sind verschieden: `gilt_ab` sagt, WANN die
// Änderung gilt, `eingetragen_am`, WANN sie eingetragen wurde. Ein rückwirkender
// Zählerwechsel gilt um 10:40 und wurde um 11:05 eingetragen. `achse` sagt,
// welche der beiden gefiltert und sortiert hat — sie steht in der ANTWORT, nicht
// nur in der Anfrage.
// ---------------------------------------------------------------------------

/**
 * Ein UEMS-Gerät (`GET /api/v1/sites/{id}/geraete`, AP-04 IP-10) — hier nur mit
 * den Feldern, die das Portal heute braucht: das Protokoll je Gerät hängt an
 * dieser ID, die Fläche kennt aber nur die Komponente. `ausgebaut_am` null =
 * eingebaut; `gueltig_bis` null = speist die Komponente bis auf Weiteres.
 */
export interface UemsGeraet {
  id: string;
  kennzeichen: string;
  einbau_kennzeichen: string;
  ausgebaut_am: string | null;
  komponenten: Array<{ entity_id: string; gueltig_ab: string; gueltig_bis: string | null }>;
}

/** Wer den Eintrag geschrieben hat; `rolle`/`art` null = vom Journal nicht festgehalten. */
export interface ProtokollUrheber {
  name: string;
  rolle: string | null;
  art: string | null;
}

/** Das Objekt, um das es geht; `name` null = inzwischen gelöscht (das Protokoll überlebt es). */
export interface ProtokollBezug {
  art: 'messstelle' | 'datenquelle' | 'unternehmen' | 'standort' | 'gebaeude' | 'bereich' | 'anlage';
  id: string;
  kennzeichen: string | null;
  name: string | null;
}

/** Ein Eintrag; `text` ist der Kundensatz „was wurde geändert", `alt`/`neu` seine Fakten. */
export interface ProtokollEintrag {
  id: string;
  quelle: 'messstelle' | 'ort' | 'datenquelle';
  art: string;
  text: string;
  bezug: ProtokollBezug;
  gilt_ab: string;
  eingetragen_am: string;
  zeitform: 'rueckwirkend' | 'angekuendigt' | 'sofort';
  grund: string | null;
  urheber: ProtokollUrheber;
  alt: Record<string, unknown> | null;
  neu: Record<string, unknown> | null;
}

/** `weiter` ist der Fortsetzungszeiger der nächsten Seite — null, wenn es keine gibt. */
export interface Protokoll {
  eintraege: ProtokollEintrag[];
  achse: 'wirkung' | 'eintrag';
  von: string | null;
  bis: string | null;
  weiter: string | null;
}

/** Der Zeitraum-Filter der drei Protokoll-Routen. */
export interface ProtokollAbfrage {
  von?: string;
  bis?: string;
  /** Vorgabe `wirkung` = „gilt ab"; `eintrag` = „eingetragen am". */
  achse?: 'wirkung' | 'eintrag';
  limit?: number;
  /** Der Wert `weiter` der vorigen Seite. */
  nach?: string;
}


/** Baut die Abfrage der drei Protokoll-Routen; ein fehlendes Feld wird weggelassen. */
function protokollFrage(f?: ProtokollAbfrage): string {
  if (!f) return '';
  const q = new URLSearchParams();
  if (f.von) q.set('von', f.von);
  if (f.bis) q.set('bis', f.bis);
  if (f.achse) q.set('achse', f.achse);
  if (f.limit != null) q.set('limit', String(f.limit));
  if (f.nach) q.set('nach', f.nach);
  const s = q.toString();
  return s ? `?${s}` : '';
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
   * ⚠ `entityId` schneidet Auswahl und Papier-Spur auf EINE Komponente dieses
   * Geraets (Stufe 3b). Es ist ueberall OPTIONAL: ohne es antwortet der Server
   * wie vorher ueber das ganze Geraet, also bleibt jeder Bestands-Aufrufer
   * Zeichen fuer Zeichen unveraendert.
   */
  measurementSelection: (deviceId: string, entityId?: string) =>
    request<MeasurementSelectionState>(
      `/api/v1/devices/${deviceId}/measurement-selection${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    ),
  measurementCatalog: (deviceId: string, params: URLSearchParams) =>
    request<MeasurementCatalogResult>(
      `/api/v1/devices/${deviceId}/measurement-selection/catalog?${params.toString()}`,
    ),
  measurementEstimate: (
    deviceId: string, pointKey: string, cadenceS: number, enabled: boolean, entityId?: string,
  ) => request<MeasurementBudgetEstimate>(
    `/api/v1/devices/${deviceId}/measurement-selection/estimate?pointKey=${encodeURIComponent(pointKey)}&enabled=${enabled}&cadenceS=${cadenceS}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`,
  ),
  changeMeasurementSelection: (
    deviceId: string,
    pointKey: string,
    body: { expectedRevision: number; idempotencyKey: string; enabled: boolean; cadenceS?: number },
    entityId?: string,
  ) => request<MeasurementSelectionState>(
    `/api/v1/devices/${deviceId}/measurement-selection/${encodeURIComponent(pointKey)}${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
  addCustomMeasurement: (deviceId: string, body: Record<string, unknown>, entityId?: string) =>
    request<MeasurementSelectionState>(
      `/api/v1/devices/${deviceId}/measurement-selection/custom${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  customMeasurementEstimate: (
    deviceId: string, definition: Record<string, unknown>, entityId?: string,
  ) => request<MeasurementBudgetEstimate>(
    `/api/v1/devices/${deviceId}/measurement-selection/custom/estimate${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    { method: 'POST', body: JSON.stringify(definition) },
  ),
  measurementHistory: (
    deviceId: string, pointKey: string, range: MeasurementRange,
    representation: 'raw' | 'decoded', from?: string, to?: string, siteId?: string,
    entityId?: string,
  ) => request<MeasurementHistory>(
    `/api/v1/devices/${deviceId}/measurement-selection/${encodeURIComponent(pointKey)}/history?range=${range}&representation=${representation}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`,
  ),
  measurementComparisonOptions: (siteId: string) =>
    request<MeasurementComparisonOption[]>(`/api/v1/sites/${siteId}/measurement-history/options`),
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
   * Die LADEPUNKTE der Anlage: das Budget, das sie sich teilen, und je Säule
   * ihre Stecker (Lastmanagement Stufe 3). Jede Zahl und jeder deutsche Satz
   * stammt aus der Box und wird nur weitergereicht. `budget: null` + leere
   * Liste ist der ehrliche Zustand einer Anlage ohne Ladesäulen.
   */
  siteChargers: (siteId: string) =>
    request<SiteCharging>(`/api/v1/sites/${siteId}/chargers`),
  ocppControl: (siteId: string) => request<import('./ocppControl').OcppControlView>(`/api/v1/sites/${siteId}/ocpp/control`),
  saveOcppControl: (siteId: string, policy: import('./ocppControl').OcppControlPolicy) =>
    request<import('./ocppControl').OcppControlView>(`/api/v1/sites/${siteId}/ocpp/control`, { method: 'PUT', body: JSON.stringify(policy) }),
  /**
   * Die Zone „Verbraucher" der Steuerungsseite (Konzept
   * `vp-verbrauchsmgmt-konzept-v1` §6, Paket P1) — EIN Lese-Aggregat: je
   * steuerbarer Komponente ihre STEUERART, der Anlagen-Standard der Ladepunkte
   * samt Ladepark-Rahmen, und die initiale Rangliste. Alles ist eine
   * PROJEKTION auf den Bestand (Policy, Quellen-Wahl der Box, Herzschlag,
   * aktive Flows) — es gibt hier bewusst KEINEN Schreibpfad.
   */
  siteVerbraucher: (siteId: string) =>
    request<SiteVerbraucher>(`/api/v1/sites/${siteId}/verbraucher`),
  /**
   * Die REIHENFOLGE bei knapper Leistung setzen (Paket P4, §5). Die Antwort ist
   * die Zone, wie sie danach GELESEN wird — also die Normalform; die Fläche
   * übernimmt sie, statt ihre eigene Anordnung stehen zu lassen.
   *
   * Gespeichert wird kein neues Format: der Server projiziert auf
   * `default_service_rank`, `storage_relation` und die Speicher-Frage des
   * Ladeparks.
   */
  saveRangliste: (siteId: string, eintraege: { art: string; entityId?: string }[]) =>
    request<SiteVerbraucher>(`/api/v1/sites/${siteId}/rangliste`, {
      method: 'PUT',
      body: JSON.stringify({ eintraege }),
    }),
  /**
   * Die Steuerart EINER Komponente setzen (Verbrauchsmanagement v1 P2).
   *
   * Der Rumpf ist die SPIEGELFORM der gelesenen Steuerart, damit der Rundlauf
   * hält: was hier hingeht, liest die Projektion danach wieder aus. Die
   * Antwort trägt die Steuerart, wie sie JETZT gilt — die Fläche rechnet sie
   * nie selbst aus.
   */
  setzeSteuerart: (siteId: string, entityId: string, wunsch: SteuerartWunsch) =>
    request<SteuerartErgebnis>(
      `/api/v1/sites/${siteId}/verbraucher/${entityId}/steuerart`,
      { method: 'PUT', body: JSON.stringify(wunsch) },
    ),
  /**
   * Die FAHRZEUGE einer Anlage (Verbrauchsmanagement v1 P7): je Ladekarte, die
   * hier geladen hat, eine Zeile - mit Namen und Steuerart, sobald der Kunde
   * sie vergeben hat.
   *
   * ⚠ Der Schlüssel ist der PSEUDONYM der Box, nie ein Klartext-IdTag - das
   * Portal bekommt ihn gar nicht zu sehen. Er ist auch NICHT der Bezug aus dem
   * OCPP-Journal (`OcppTransaction.startIdTagRef`): den pfeffert die Cloud ein
   * zweites Mal, dieselbe Karte trägt dort einen anderen Wert.
   */
  siteFahrzeuge: (siteId: string) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge`),
  setzeFahrzeug: (siteId: string, tagRef: string, wunsch: FahrzeugWunsch) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge/${encodeURIComponent(tagRef)}`,
      { method: 'PUT', body: JSON.stringify(wunsch) }),
  entferneFahrzeugProfil: (siteId: string, tagRef: string) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge/${encodeURIComponent(tagRef)}`,
      { method: 'DELETE' }),
  /** Complete, tenant-scoped OCPP 1.6 station inventory for the device home. */
  ocppStations: (siteId: string, signal?: AbortSignal) =>
    request<OcppStation[]>(`/api/v1/sites/${siteId}/ocpp/stations`, { signal }),
  ocppEvents: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppProtocolEvent[]>(`/api/v1/sites/${siteId}/ocpp/events?limit=${limit}`, { signal }),
  ocppGaps: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppDataGap[]>(`/api/v1/sites/${siteId}/ocpp/gaps?limit=${limit}`, { signal }),
  ocppTransactions: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppTransaction[]>(`/api/v1/sites/${siteId}/ocpp/transactions?limit=${limit}`, { signal }),
  /**
   * Die Zählerstands-Proben der Anlage. `from`/`pointKey` engen sie serverseitig
   * ein (`SiteOcppController.meterValues` kennt beide seit Slice 9) - die
   * Tages-Aufschlüsselung fragt damit GENAU den Register-Kanal ab dem
   * Tagesbeginn ab, statt 1000 gemischte Proben zu holen und zu filtern.
   */
  ocppMeterValues: (
    siteId: string,
    limit = 1000,
    signal?: AbortSignal,
    opts?: { from?: string; pointKey?: string },
  ) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (opts?.from) q.set('from', opts.from);
    if (opts?.pointKey) q.set('pointKey', opts.pointKey);
    return request<OcppMeterSample[]>(`/api/v1/sites/${siteId}/ocpp/meter-values?${q}`, { signal });
  },
  ocppConfiguration: (siteId: string, chargePointId: string, signal?: AbortSignal) =>
    request<OcppConfiguration[]>(
      `/api/v1/sites/${siteId}/ocpp/configuration?chargePointId=${encodeURIComponent(chargePointId)}`,
      { signal },
    ),
  ocppActionPermissions: (siteId: string, signal?: AbortSignal) =>
    request<OcppActionPermissions>(`/api/v1/sites/${siteId}/ocpp/action-permissions`, { signal }),
  ocppActions: (siteId: string, chargePointId: string, limit = 100, signal?: AbortSignal) =>
    request<OcppAction[]>(
      `/api/v1/sites/${siteId}/ocpp/actions?chargePointId=${encodeURIComponent(chargePointId)}&limit=${limit}`,
      { signal },
    ),
  createOcppActionIntent: (
    siteId: string,
    chargePointId: string,
    body: Pick<OcppActionInput, 'action' | 'connectorId' | 'transactionId' | 'request'>,
  ) => request<OcppActionIntent>(
    `/api/v1/sites/${siteId}/ocpp/stations/${encodeURIComponent(chargePointId)}/action-intents`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  createOcppAction: (
    siteId: string,
    chargePointId: string,
    body: OcppActionInput,
    idempotencyKey: string,
  ) => request<OcppAction>(
    `/api/v1/sites/${siteId}/ocpp/stations/${encodeURIComponent(chargePointId)}/actions`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    },
  ),
  ocppAction: (siteId: string, actionId: string, signal?: AbortSignal) =>
    request<OcppAction>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}`, { signal }),
  ocppActionAudit: (siteId: string, actionId: string, signal?: AbortSignal) =>
    request<OcppActionAudit[]>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}/audit`, { signal }),
  cancelOcppAction: (siteId: string, actionId: string) =>
    request<void>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}`, { method: 'DELETE' }),
  /**
   * Die laufenden HANDEINGRIFFE der Anlage (Steuerung Stufe 4): der Speicher-
   * Eingriff und die „Automatik pausieren"-Sperre. Der EINE Lesepfad, aus dem
   * die Jetzt-Zone ihre Zeilen-Countdowns UND ihr Banner baut - abgelaufene
   * Eingriffe lesen server-seitig als abwesend, hier kommt nie ein Geist an.
   */
  siteInterventions: (siteId: string) =>
    request<SiteInterventions>(`/api/v1/sites/${siteId}/interventions`),
  /** „Speicher jetzt laden" / „Ladestand halten" - Dauer ist PFLICHT. */
  startBatteryOverride: (
    siteId: string,
    body: { kind: 'speicher_laden' | 'speicher_halten'; durationMinutes?: number;
      endsAt?: string; setpointKw?: number },
  ) => request<InterventionOutcome>(`/api/v1/sites/${siteId}/battery-override`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  /** „Automatik fortsetzen" für den Speicher. */
  clearBatteryOverride: (siteId: string) =>
    request<InterventionOutcome>(`/api/v1/sites/${siteId}/battery-override`, {
      method: 'DELETE',
    }),
  /** „Automatik pausieren" - Fahrplan UND Regeln ruhen für die Dauer. */
  pauseAutomation: (
    siteId: string,
    body: { durationMinutes?: number; endsAt?: string },
  ) => request<InterventionOutcome>(`/api/v1/sites/${siteId}/automation-pause`, {
    method: 'POST', body: JSON.stringify({ kind: 'pause', ...body }),
  }),
  /** „Automatik fortsetzen" für die ganze Anlage. */
  resumeAutomation: (siteId: string) =>
    request<InterventionOutcome>(`/api/v1/sites/${siteId}/automation-pause`, {
      method: 'DELETE',
    }),
  /**
   * Das GEDÄCHTNIS der Vorschläge (Steuerung Stufe 6): welche der abgeleiteten
   * Karten der Kunde gerade nicht sehen will.
   *
   * ⚠ Es gibt bewusst KEINE Route, die Vorschläge LIEFERT - sie sind eine
   * Ableitung aus dem Fahrplan (`vorschlaege.ts`), und eine Server-Route müsste
   * dieselbe Ableitung ein zweites Mal führen. Abgelaufene Haltungen kommen
   * hier gar nicht erst an.
   */
  /**
   * Die Vorschau EINER Entscheidung (Steuerung Stufe 7): zwei echte
   * Solver-Läufe über eine Eingabe, und die Differenz ihres Netto-Vorteils.
   *
   * ⚠ Sie ist TEUER (ein MILP-Lauf) und gedeckelt - die Fläche fragt sie
   * einmal je geöffneter Folgen-Karte, nie in einer Schleife.
   */
  steuerungVorschau: (siteId: string, knoepfe: VorschauKnoepfe) =>
    request<SteuerungVorschau>(`/api/v1/sites/${siteId}/steuerung-vorschau`, {
      method: 'POST', body: JSON.stringify(knoepfe),
    }),
  suggestionStates: (siteId: string) =>
    request<SuggestionStates>(`/api/v1/sites/${siteId}/suggestion-states`),
  /**
   * „Später" (ein Tag) oder „Ablehnen" (sieben Tage). Die FRIST rechnet der
   * Server - eine vom Client gewählte Dauer wäre ein Weg, einen Vorschlag für
   * immer verstummen zu lassen, ohne ihn je abzulehnen.
   */
  setSuggestionState: (siteId: string, key: string, state: 'spaeter' | 'abgelehnt') =>
    request<SuggestionState>(
      `/api/v1/sites/${siteId}/suggestion-states/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ state }) },
    ),
  /** Die im Portal gepflegte Anschlussgrenze + Vorrang-Wahl. */
  chargingConfig: (siteId: string) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config`),
  /**
   * Speichert Anschlussgrenze und/oder Vorrang - PATCH-Semantik: ein NICHT
   * übergebenes Feld behält seinen Wert (ein Dialog, der nur den Vorrang
   * stellt, darf die Grenze nicht löschen).
   */
  saveChargingConfig: (
    siteId: string,
    body: {
      gridLimitKw?: number;
      priorityChargePointIds?: string[];
      // Die QUELLEN-Wahl (Stufe 4). Sie ändert KEINE Grenze - die zwei Bahnen
      // komponieren most-restrictive-wins. Nicht übergeben = unverändert, was
      // NICHT dasselbe ist wie `schnell` (eine eigene Aussage des Kunden).
      surplusPolicy?: SurplusPolicy;
      storagePriority?: StoragePriority;
    },
  ) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Speichert den Ladepark-RAHMEN (P5/E10) — Plattform-Admin only.
   *
   * ⚠ PATCH-Semantik in BEIDE Richtungen: ein NICHT übergebenes Feld behält
   * seinen gespeicherten Wert, ein ausdrückliches `null` LÖSCHT es (und die Box
   * behält dann wieder ihre eigene Zahl). Deshalb sind die Werte `| null` und
   * nicht bloß optional — „nichts sagen" und „zurücknehmen" sind zwei
   * verschiedene Handlungen.
   */
  saveChargingFrame: (
    siteId: string,
    body: {
      houseReserveKw?: number | null;
      marginPct?: number | null;
      minPowerKw?: number | null;
      rotationMinutes?: number | null;
      maxHouseLoadKw?: number | null;
      staticBudget?: boolean | null;
    },
  ) =>
    request<ChargingConfig>(`/api/v1/admin/sites/${siteId}/charging-frame`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Trägt EINE Ladesäule in die Allowlist ein (Anbinde-Assistent, Schritt 1).
   *
   * ⚠ Es ist ein POST, kein PUT, und das ist die Aussage: die Liste fügt nur
   * hinzu. Einen Eintrag zu ENTFERNEN würfe die Säule beim nächsten
   * Verbindungsaufbau vom Broker - das bleibt eine ausdrückliche Handlung am
   * Gerät. Dieselbe Kennung erneut ist ein No-op, das nur auffrischt.
   */
  admitChargePoint: (
    siteId: string,
    body: {
      chargePointId: string;
      label?: string;
      ratedKw?: number;
      connectors?: number;
      /**
       * WO die Säule hängt (Cockpit Phase 1 / C1). Weggelassen heisst „dazu
       * wird nichts gesagt" - die Box behält dann, was sie hat.
       */
      connection?: 'haus' | 'eigen';
    },
  ) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config/charge-points`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Nimmt EINE eingetragene Ladepunkt-Kennung zurück.
   *
   * ⚠ Es ist ein DELETE auf GENAU EINE Kennung, nie ein Setzen der ganzen
   * Liste: die Rücknahme hat Folgen für eine laufende Anlage (die Säule wird
   * getrennt und ein Wiederverbinden abgewiesen), und die soll niemand als
   * Nebenwirkung eines Speicherns auslösen können. Sie reist als GRABSTEIN in
   * jedem folgenden Dokument an die Box mit, bis die Kennung wieder eingetragen
   * wird - ein blosses Weglassen wäre kein Löschen.
   */
  removeChargePoint: (siteId: string, chargePointId: string) =>
    request<ChargingConfig>(
      `/api/v1/sites/${siteId}/charging-config/charge-points/${encodeURIComponent(chargePointId)}`,
      { method: 'DELETE' },
    ),
  /**
   * Der Handeingriff an EINEM laufenden Ladevorgang, in zwei Richtungen:
   * „Jetzt voll laden" (von der Überschuss-Priorität ausgenommen, Netzstrom
   * erlaubt) und sein Geschwister „Laden pausieren" (P3b, Deckel 0).
   *
   * ⚠ BEIDES ist KEINE Grenze: Anschlussgrenze, Sicherheitsabstand, §14a und
   * der Ausfall-Schutz binden unverändert, und ALLE ANDEREN Ladevorgänge
   * bleiben, wie sie sind. `cancel: true` nimmt beide Richtungen zurück.
   */
  chargingBoost: (
    siteId: string,
    body: {
      chargePointId: string;
      connectorId: number;
      minutes?: number;
      cancel?: boolean;
      /**
       * Die RICHTUNG (P3b, Entscheid E5): `voll` (Vorgabe) oder `pause`
       * („Laden pausieren"). Abwesend = `voll`, also ist ein Aufruf ohne das
       * Feld zeichengleich wie vorher.
       */
      action?: 'voll' | 'pause';
    },
  ) =>
    request<ChargingBoostResult>(`/api/v1/sites/${siteId}/charging-boost`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
   * Der KOMMANDO-VERLAUF (Kommando-Transparenz V1): der Zeitraum EINER
   * Komponente - oder der ganzen Anlage, wenn keine gewählt ist. Ein älteres
   * Backend kennt die Route nicht; der Aufrufer holt sie deshalb fail-soft.
   */
  commandHistory: (
    siteId: string,
    opts: {
      entity?: string | null;
      /**
       * Das GERÄT (Anlagen-Zentrale Stufe 1): die Referenz der Box, eine
       * gemeldete Quellen-Kennung oder `cp-<ChargePointId>`. Schliesst
       * `entity` aus - der Server antwortet auf beides mit 400.
       */
      device?: string | null;
      range?: 'day' | 'week' | 'month';
      at?: string | null;
      /** Ein eigener Zeitraum (Kalendertage) - schliesst `range`/`at` aus. */
      from?: string | null;
      to?: string | null;
      /**
       * Die drei STRUKTUR-Filter (Geräteseiten Revision B §6), komma-getrennt.
       * Ein Wort ausserhalb des Server-Vokabulars ist eine benannte 400 - das
       * Portal schickt deshalb nur Werte aus dem hier notierten Vokabular.
       */
      streams?: string | null;
      sources?: string | null;
      verdicts?: string | null;
      limit?: number | null;
      /** Der Seiten-Cursor: „bis zu diesem Zeitpunkt" (ISO). */
      before?: string | null;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.from && opts.to) {
      q.set('from', opts.from);
      q.set('to', opts.to);
    } else {
      q.set('range', opts.range ?? 'day');
      if (opts.at) q.set('at', opts.at);
    }
    if (opts.entity) q.set('entity', opts.entity);
    else if (opts.device) q.set('device', opts.device);
    if (opts.streams) q.set('streams', opts.streams);
    if (opts.sources) q.set('sources', opts.sources);
    if (opts.verdicts) q.set('verdicts', opts.verdicts);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    return request<CommandHistory>(`/api/v1/sites/${siteId}/command-history?${q}`);
  },
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
  createSite: (input: NeueAnlageInput) =>
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
  /**
   * Die Geräte-Vorlagen, aus denen der Anlege-Assistent seine Auswahl rendert
   * (Einheitsmodell Stufe 0a/1). Authentifiziert, nicht anlagenbezogen - eine
   * Vorlage ist eine Aussage über ein PRODUKT.
   */
  componentTemplates: () => request<ComponentTemplate[]>('/api/v1/component-templates'),
  componentTemplate: (templateRef: string) =>
    request<ComponentTemplate>(`/api/v1/component-templates/${encodeURIComponent(templateRef)}`),
  /** Die Komponenten einer Anlage samt Autoritäts- und Soll/Ist-Stand (Stufe 1). */
  siteComponents: (siteId: string) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components`),
  /**
   * „Verbindung testen": die BOX liest das noch nicht gespeicherte Gerät einmal.
   * Ein Erfolg hinterlegt zugleich den Beleg, ohne den nicht gespeichert wird
   * (die Verbindungstest-Pflicht) - deshalb ist es dieselbe Route, nicht zwei.
   */
  testComponentConnection: (
    siteId: string,
    body: {
      templateRef: string;
      templateVersion?: number;
      role?: string;
      connection: Record<string, unknown>;
      deviceId?: string;
      /** Bestehende Komponente: der Server ergänzt unveränderte Secrets. */
      entityId?: string;
    },
  ) =>
    request<ProbeAntwort>(`/api/v1/sites/${siteId}/component-test`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * „Kennen wir dieses Gerät schon?" - die verwaiste Komponente, die ein
   * Speichern ÜBERNEHMEN würde (Alias-Kontinuität, Live-Fall Herzogau).
   *
   * <p>Die Entscheidung fällt AUF DEM SERVER, mit derselben Regel, die
   * `createComponent` danach fährt; hier wird nichts nachgerechnet. `204` (kein
   * Treffer) kommt als `undefined` an und heißt „es entsteht eine neue
   * Komponente" - ein völlig normaler Ausgang, nie ein Fehler.
   */
  matchComponent: (
    siteId: string,
    body: { templateRef: string; role: string; connection: Record<string, unknown> },
  ) =>
    request<ComponentMatch | undefined>(`/api/v1/sites/${siteId}/component-match`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Komponente anlegen (422 ohne bestandenen Verbindungstest). */
  createComponent: (siteId: string, body: SaveComponentBody) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Verbindung ändern - eine NEUE Fassung; die alte bleibt abrufbar. */
  updateComponent: (siteId: string, entityId: string, body: SaveComponentBody) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/${entityId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Die Fassungen einer Komponente, neueste zuerst. */
  componentVersions: (siteId: string, entityId: string) =>
    request<ComponentDefinition[]>(`/api/v1/sites/${siteId}/components/${entityId}/versions`),
  /** Zurück auf eine frühere Fassung - der Ein-Klick-Weg aus einem falschen Soll. */
  rollbackComponent: (siteId: string, entityId: string, version: number, expectedRevision: number) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/${entityId}/versions/${version}/rollback`,
      { method: 'POST', body: JSON.stringify({ expectedRevision }) },
    ),
  /**
   * „Jetzt lesen" (Einheitsmodell Stufe 3): die BOX liest EINEN Messwert des
   * noch nicht gespeicherten Geräts einmal und antwortet mit Roh- UND
   * skaliertem Wert - der Moment, in dem ein Skalierungsfehler sichtbar wird.
   *
   * Ein Erfolg hinterlegt zugleich den Beleg, der das Speichern freigibt; er
   * hängt an der VERBINDUNG, nicht am Messwert, also erzwingt eine geänderte
   * Skalierung keine neue Lesung, eine geänderte Adresse sehr wohl.
   */
  readCustomComponent: (siteId: string, body: Record<string, unknown>) =>
    request<SelbstbauLeseAntwort>(`/api/v1/sites/${siteId}/components/custom/read`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Modbus-Gerät anlegen (Stufe 3). */
  createCustomComponent: (siteId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Gerät ändern - eine NEUE Fassung. */
  updateCustomComponent: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom/${entityId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Gerät entfernen - samt seinem Lese-Flow. */
  deleteCustomComponent: (siteId: string, entityId: string) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom/${entityId}`, {
      method: 'DELETE',
    }),
  /**
   * Die KURVEN-VORLAGEN der SoC-Ableitung (P5b/P5d).
   *
   * ⚠ Sie kommen vom Server, damit das Portal die Stützpunkte NICHT nachbaut:
   * eine Kennlinie im Frontend wäre ein Zwilling von `soccurves/catalog.json`
   * und dürfte von ihm abdriften - und eine abgedriftete Kennlinie ist ein
   * falscher Ladestand mit Nachkommastellen.
   */
  socCurveTemplates: () => request<SocCurveTemplate[]>('/api/v1/soc-curve-templates'),
  /**
   * Die Feld-Zuordnung EINMAL vorschauen (P5d): die Box lauscht kurz auf dem
   * Broker des Kunden und antwortet je Zuordnung mit Roh- UND skaliertem Wert.
   *
   * ⚠ Sie schreibt NICHTS und ist ausdrücklich KEINE Voraussetzung des
   * Speicherns - anders als `testComponentConnection`. Eine Box, die noch
   * nicht lauschen kann, antwortet `not_supported`; das ist eine Aussage über
   * die Box, nie über die Zuordnung.
   */
  previewBattery: (
    siteId: string,
    body: Record<string, unknown>,
    /**
     * Beim BEARBEITEN die Komponente: nur dann kann der Server ein
     * gespeichertes Geheimnis wieder einsetzen, damit die Vorschau exakt das
     * tut, was das Speichern täte. Ohne sie müsste der Kunde seinen
     * BMS-Schlüssel für jede Vorschau neu eintippen.
     */
    entityId?: string | null,
  ) =>
    request<ProbeAntwort>(
      `/api/v1/sites/${siteId}/components/battery/preview`
      + (entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''),
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  /** Eine selbst angebundene Batterie anlegen (P5 Ebene 1 + P5b Ebene 2). */
  createBattery: (siteId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/battery`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Eine selbst angebundene Batterie ändern - eine NEUE Fassung. */
  updateBattery: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/battery/${entityId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Eine selbst angebundene Batterie entfernen - samt ihrem Lese-Flow. */
  deleteBattery: (siteId: string, entityId: string) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/battery/${entityId}`, {
      method: 'DELETE',
    }),
  /**
   * Der gefuehrte Schalt-Test (Einheitsmodell Stufe 4). Er schreibt EINMAL; die
   * Box armiert ihr automatisches Aus, BEVOR sie schreibt.
   */
  /**
   * Schritt 1 der Register-Strecke: den Ist-Wert LESEN. Schreibt nichts und
   * hinterlässt keine Spur.
   *
   * `tenantId` stampft den `X-Tenant-Id`-Kopf NUR für diesen Aufruf - die
   * Plattform-Geräteseite kennt den Mandanten der Zeile, und den globalen
   * Umschalter unter den Füßen des Admins zu verstellen wäre ein Seiteneffekt.
   */
  registerWritePreview: (siteId: string, body: RegisterWriteInput, tenantId?: string) =>
    request<RegisterWriteOutcome>(`/api/v1/sites/${siteId}/register-write/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
      ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    }),
  /** Schritt 2: der EINE Schreibvorgang - mit Beleg und Papier-Spur. */
  registerWrite: (siteId: string, body: RegisterWriteInput, tenantId?: string) =>
    request<RegisterWriteOutcome>(`/api/v1/sites/${siteId}/register-write`, {
      method: 'POST',
      body: JSON.stringify(body),
      ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    }),
  /** Schritt 0: WELCHE Geräte dieser Anlage als Ziel in Frage kommen. */
  registerWriteTargets: (siteId: string, tenantId?: string) =>
    request<RegisterWriteTarget[]>(`/api/v1/sites/${siteId}/register-write/targets`,
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
  /** Das kuratierte Register-Wissen - reine Anzeige, entscheidet nichts. */
  registerKnowledge: (siteId: string, tenantId?: string) =>
    request<RegisterKnowledgeFamily[]>(
      `/api/v1/sites/${siteId}/register-write/register-knowledge`,
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
  /** Der Verlauf - dieselben Zeilen, die die Befehle-Seite einmischt. */
  registerWriteHistory: (siteId: string, deviceId?: string, tenantId?: string) =>
    request<RegisterWriteEvent[]>(
      `/api/v1/sites/${siteId}/register-write/history`
        + (deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''),
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {},
    ),
  switchTest: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SchaltTestAntwort>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-test`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Bricht den laufenden Test ab und schreibt den Sicherheitswert sofort. */
  switchTestCancel: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SchaltTestAntwort>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-test/cancel`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Die Freigabe - nur mit bestandenem Test UND bestaetigter Wirkung. */
  releaseSwitch: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-release`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Nimmt die Freigabe zurueck - das Geraet ist danach wieder ein Sensor. */
  revokeSwitch: (siteId: string, entityId: string) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-release`,
      { method: 'DELETE' },
    ),
  /** Die PRIVATEN Vorlagen dieser Anlage (kein Katalog, kein Teilen). */
  siteComponentTemplates: (siteId: string) =>
    request<SiteComponentTemplate[]>(`/api/v1/sites/${siteId}/component-templates`),
  /** „Duplizieren": aus einem Gerät wird eine private Vorlage dieser Anlage. */
  duplicateCustomComponent: (siteId: string, entityId: string, label?: string) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/duplicate`,
      { method: 'POST', body: JSON.stringify({ label }) },
    ),
  /**
   * Eine eigene Vorlage umbenennen (Einheitsmodell Stufe 6). VOLLE Darstellung
   * von Name und Notiz: eine ausgelassene Notiz LÖSCHT sie, ein leerer Name
   * wird abgelehnt. Es entsteht KEINE neue Fassung - eine Vorlage IST ihr
   * Leseplan, und ein Name ändert daran nichts.
   */
  renameSiteComponentTemplate: (
    siteId: string,
    templateRef: string,
    body: { label: string; note?: string | null },
  ) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/component-templates/${encodeURIComponent(templateRef)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  /** Eine eigene Vorlage entfernen. Geräte, die daraus entstanden, bleiben. */
  deleteSiteComponentTemplate: (siteId: string, templateRef: string) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/component-templates/${encodeURIComponent(templateRef)}`,
      { method: 'DELETE' },
    ),
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
  /**
   * Set the site's application PRESET (Anwendungs-Programm Stufe 2):
   * `privat` | `gewerbe`, or null to clear it. Returns the updated site.
   *
   * It changes NO switch — which applications run stays the shelf's business
   * (`setSiteProfile`), so a later "Profil ändern" can never rewrite the
   * customer's own switches. Deliberately a narrow route rather than a field of
   * the site master-data form: the assistant writes it from a step that never
   * loaded the tariff/remuneration fields, and a full-representation
   * `updateSite` from there would be a clobber risk.
   */
  setAnwendungsPreset: (siteId: string, profil: Profil | null) =>
    request<Site>(`/api/v1/sites/${siteId}/anwendungs-preset`, {
      method: 'PUT',
      body: JSON.stringify({ profil }),
    }),
  /**
   * Portal v3 M3: the „Anwendungen" shelf of the Anlage (the route + payload
   * keep the `profile` vocabulary — only the customer WORD changed). Every one
   * is a
   * DIRECT customer toggle (two states, `an`/`aus` - there is no "angefragt").
   */
  siteProfiles: (siteId: string) =>
    request<SiteProfiles>(`/api/v1/sites/${siteId}/profiles`),
  /**
   * Switch one Anwendung on or off. Switching ON makes the SERVER enable
   * exactly that profile's gated node types for the site and seed its starter
   * flow; switching OFF deactivates its flows and closes those nodes again.
   * Returns the recomputed shelf.
   */
  setSiteProfile: (siteId: string, profile: string, state: ProfileState) =>
    request<SiteProfiles>(`/api/v1/sites/${siteId}/profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profile, state }),
    }),
  /**
   * Das gespeicherte COCKPIT-LAYOUT einer Anlage (Anwendungs-Programm Stufe 3):
   * alle Schichten GETRENNT plus den Baustein-Katalog — nie das aufgelöste
   * Ergebnis. Die Auflösung ist eine reine Funktion (`cockpitLayout.ts`), und
   * getrennt müssen die Schichten sein, damit die Fläche sagen kann, worauf
   * ein „Zurücksetzen" fällt (E2).
   */
  cockpitLayout: (siteId: string) =>
    request<CockpitLayoutResponse>(`/api/v1/sites/${siteId}/cockpit-layout`),
  /**
   * Speichert eine Schicht. `eigen` schreibt der Kunde (sie gewinnt),
   * `vorgabe` nur ein Portal-Admin über den Mandanten-Umschalter — die
   * Rechte-Prüfung sitzt am Server, hier wird nur gefragt.
   */
  saveCockpitLayout: (siteId: string, layer: CockpitLayoutLayer, document: CockpitLayoutDocument) =>
    request<CockpitLayoutResponse>(
      `/api/v1/sites/${siteId}/cockpit-layout?layer=${layer}`,
      { method: 'PUT', body: JSON.stringify(document) },
    ),
  /** Der RESET einer Schicht — sie fällt damit auf die darunter (E2). */
  resetCockpitLayout: (siteId: string, layer: CockpitLayoutLayer) =>
    request<CockpitLayoutResponse>(`/api/v1/sites/${siteId}/cockpit-layout?layer=${layer}`, {
      method: 'DELETE',
    }),
  /**
   * Die kunden-weite Schicht EINER Fläche: auf `cockpit` die Vorgabe „für alle
   * meine Anlagen" (E1), auf `portfolio` das Kunden-Cockpit selbst (Stufe 4) —
   * dort ist `eigen` der Wille des Kunden. Ein Aufruf ohne Fläche bleibt
   * zeichengleich auf `cockpit`.
   */
  tenantCockpitLayout: (surface: CockpitLayoutFlaeche = 'cockpit') =>
    request<CockpitLayoutResponse>(`/api/v1/tenant/cockpit-layout?surface=${surface}`),
  saveTenantCockpitLayout: (
    layer: CockpitLayoutLayer,
    document: CockpitLayoutDocument,
    surface: CockpitLayoutFlaeche = 'cockpit',
  ) =>
    request<CockpitLayoutResponse>(
      `/api/v1/tenant/cockpit-layout?surface=${surface}&layer=${layer}`,
      { method: 'PUT', body: JSON.stringify(document) },
    ),
  resetTenantCockpitLayout: (
    layer: CockpitLayoutLayer,
    surface: CockpitLayoutFlaeche = 'cockpit',
  ) =>
    request<CockpitLayoutResponse>(
      `/api/v1/tenant/cockpit-layout?surface=${surface}&layer=${layer}`,
      { method: 'DELETE' },
    ),
  /**
   * Die WERTE der eigenen Auswertungen einer Anlage (Anwendungs-Programm
   * Stufe 5). Eine Route für ALLE eigenen Bausteine zusammen: das Cockpit
   * rendert sie gemeinsam, und mehrere Kacheln auf derselben Komponente teilen
   * sich server-seitig eine Abfrage.
   *
   * Sie nimmt KEINE Definition entgegen — was auf dem Cockpit steht, entscheidet
   * das Layout-Dokument; eine Route, die eine mitgeschickte Definition
   * beantwortet, wäre ein zweiter Weg an der Prüfung des Schreibpfads vorbei.
   */
  eigeneAuswertung: (siteId: string, at?: string) =>
    request<EigeneAuswertungWerte>(
      `/api/v1/sites/${siteId}/eigene-auswertung${at ? `?at=${at}` : ''}`,
    ),
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

  /**
   * Der Prognose-Schalter DIESER Anlage: welches Modell je Prognoseart sie
   * plant, woher die Wahl kommt (eigene · Plattform-Vorgabe · Standardmodell)
   * und ihre Umstellungs-Historie. Mandantenbezogen wie jede `/sites/**`-Route
   * - eine fremde Anlage ist 404.
   */
  siteForecastModels: (siteId: string) =>
    request<ModellWahlZustand>(`/api/v1/sites/${siteId}/forecast-models`),

  /**
   * „Kandidat übernehmen" FÜR DIESE ANLAGE - ab dem nächsten Planungslauf plant
   * sie mit diesem Modell, alle anderen Anlagen bleiben unverändert. Der
   * Rückweg ist derselbe Aufruf in die Gegenrichtung; die Umstellung wird
   * append-only protokolliert (von->zu, wer, wann).
   */
  promoteSiteForecastModel: (siteId: string, kind: 'load' | 'pv', model: string) =>
    request<ModellWahlZustand>(`/api/v1/sites/${siteId}/forecast-models`, {
      method: 'POST',
      body: JSON.stringify({ kind, model }),
    }),
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

  // --- UEMS: Messkanäle + berechnete Messstelle („Gesamtwert") ---

  /** Die Messkanäle einer Komponente mit ihrer Vertrags-Größe (Read-Model AP-04). */
  komponenteMesskanaele: (siteId: string, entityId: string) =>
    request<MesskanalListe>(`/api/v1/sites/${siteId}/komponenten/${entityId}/messkanaele`),

  /** Alle Messstellen des Kundenbereichs (für die Auswahl der berechneten). */
  messstellen: () => request<{ messstellen: Messstelle[] }>(`/api/v1/messstellen`),

  /** Eine einzelne Messstelle. */
  messstelle: (id: string) => request<Messstelle>(`/api/v1/messstellen/${id}`),

  /** Der Vorschlag für das nächste Kennzeichen (MS-…), unaufdringlich gezeigt. */
  kennzeichenVorschlag: () =>
    request<{ kennzeichen: string }>(`/api/v1/messstellen/kennzeichen-vorschlag`),

  /** Die UEMS-Geräte einer Anlage (AP-04 IP-10) — der Weg von der Komponente zum Gerät. */
  uemsGeraete: (siteId: string) =>
    request<{ geraete: UemsGeraet[] }>(`/api/v1/sites/${siteId}/geraete`),

  /**
   * Das Änderungsprotokoll EINER Messstelle (AP-04 IP-21) — jüngster Eintrag
   * zuerst. Ohne `von`/`bis` das ganze Protokoll.
   */
  messstelleAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/messstellen/${id}/aenderungen${protokollFrage(f)}`),

  /**
   * Das Änderungsprotokoll EINES Geräts — seine Bindungen, seine Einstellungen,
   * sein Ein- und Ausbau. `id` ist das UEMS-Gerät (`/api/v1/sites/{id}/geraete`),
   * nicht die Komponente.
   */
  geraetAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/geraete/${id}/aenderungen${protokollFrage(f)}`),

  /** Das Änderungsprotokoll des ganzen Unternehmens über einen Zeitraum. */
  unternehmenAenderungen: (f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/unternehmen/aenderungen${protokollFrage(f)}`),

  /** Legt eine berechnete Messstelle (Gesamtwert) mit ihrer gewichteten Summe an. */
  berechneteMessstelleAnlegen: (body: BerechneteMessstelleAnlegen) =>
    request<Messstelle>(`/api/v1/messstellen/berechnet`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Die Formel (Terme + abgeleitete Hauptgröße) einer berechneten Messstelle —
   * ohne `am` die von heute (unverändert), mit `am` (JJJJ-MM-TT) die Fassung des Tages.
   */
  messstelleFormel: (id: string, am?: string) =>
    request<MessstelleFormel>(`/api/v1/messstellen/${id}/formel${am ? `?am=${am}` : ''}`),

  /** Trägt eine neue Fassung der Formel ab einem Tag ein (AP-10 IP-3). */
  messstelleFormelFassungEintragen: (id: string, body: MessstelleFormelFassungEintragen) =>
    request<MessstelleFormel>(`/api/v1/messstellen/${id}/formel/fassungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Der Live-Wert einer berechneten Messstelle (null, wenn unvollständig). */
  messstelleWert: (id: string) => request<MessstelleWert>(`/api/v1/messstellen/${id}/wert`),

  /** Der Verlauf einer berechneten Messstelle (je 15 min die Summe, sonst null). */
  messstelleVerlauf: (id: string, range?: string) =>
    request<MessstelleVerlauf>(
      `/api/v1/messstellen/${id}/verlauf${range ? `?range=${range}` : ''}`,
    ),

  /**
   * Bearbeitet die drei änderbaren Felder einer Messstelle (Kennzeichen · Name ·
   * Notiz) — der Server ersetzt sie GANZ, ein fehlendes Feld wird leer. Zum
   * Umbenennen also das bestehende Kennzeichen mitschicken.
   */
  messstelleBearbeiten: (id: string, body: { kennzeichen?: string; name: string; notiz?: string }) =>
    request<Messstelle>(`/api/v1/messstellen/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** Hält eine Messstelle an (behält ihre Definition). */
  messstelleAnhalten: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/anhalten`, { method: 'POST' }),

  /** Setzt eine angehaltene Messstelle fort. */
  messstelleFortsetzen: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/fortsetzen`, { method: 'POST' }),

  /** Archiviert eine Messstelle (statt hartem Löschen; das Kennzeichen bleibt belegt). */
  messstelleArchivieren: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/archivieren`, { method: 'POST' }),
  /** Die Kostenstellen des Unternehmens (AP-10 IP-7); mit `stichtag` nur die an dem Tag bestehenden. */
  kostenstellen: (stichtag?: string) =>
    request<{ stichtag: string | null; kostenstellen: Kostenstelle[] }>(
      `/api/v1/unternehmen/kostenstellen${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`,
    ),

  kostenstelleAnlegen: (body: KostenstelleProzessAnlegen) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen`, { method: 'POST', body: JSON.stringify(body) }),

  kostenstelleUmbenennen: (id: string, name: string) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),

  /** Beendet (der letzte Tag) — beenden statt löschen; 409 `zuordnung_besteht` nennt, was länger gilt. */
  kostenstelleBeenden: (id: string, gueltig_bis: string) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen/${id}/beenden`, {
      method: 'PUT',
      body: JSON.stringify({ gueltig_bis }),
    }),

  /** Die Prozesse des Unternehmens (AP-10 IP-7); mit `stichtag` nur die an dem Tag bestehenden. */
  prozesse: (stichtag?: string) =>
    request<{ stichtag: string | null; prozesse: Prozess[] }>(
      `/api/v1/unternehmen/prozesse${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`,
    ),

  prozessAnlegen: (body: KostenstelleProzessAnlegen) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse`, { method: 'POST', body: JSON.stringify(body) }),

  prozessUmbenennen: (id: string, name: string) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),

  prozessBeenden: (id: string, gueltig_bis: string) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse/${id}/beenden`, {
      method: 'PUT',
      body: JSON.stringify({ gueltig_bis }),
    }),

  /** Die Prozesse einer Messstelle: alle wirksamen Intervalle, mit `am` die an dem Tag geltenden. */
  messstelleProzesse: (id: string, am?: string) =>
    request<MessstelleProzesse>(`/api/v1/messstellen/${id}/prozesse${am ? `?am=${encodeURIComponent(am)}` : ''}`),

  /** Ab `gueltig_ab` gehört die Messstelle zu GENAU diesen Prozessen (leer = zu keinem). */
  messstelleProzesseSetzen: (id: string, body: { gueltig_ab: string; prozesse: string[]; grund?: string | null }) =>
    request<MessstelleProzesse>(`/api/v1/messstellen/${id}/prozesse`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die Verteilung einer Messstelle auf Kostenstellen (AP-10 IP-8): alle Anteile, mit `am` die des Tages. */
  messstelleVerteilung: (id: string, am?: string) =>
    request<MessstelleVerteilung>(`/api/v1/messstellen/${id}/verteilung${am ? `?am=${encodeURIComponent(am)}` : ''}`),

  /** Ab `gueltig_ab` gilt GENAU dieser Satz (alle Ziele des Tages; leer = nicht verteilt); `korrektur` ersetzt den vom selben Tag. */
  messstelleVerteilungSetzen: (
    id: string,
    body: { gueltig_ab: string; zeilen: VerteilungZeileEingabe[]; korrektur?: boolean | null; grund?: string | null },
  ) => request<MessstelleVerteilung>(`/api/v1/messstellen/${id}/verteilung`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die Bezugsgrößen des Kundenbereichs, archivierte eingeschlossen (AP-09 IP-5). */
  bezugsgroessen: () => request<{ bezugsgroessen: Bezugsgroesse[] }>(`/api/v1/bezugsgroessen`),

  bezugsgroesse: (id: string) => request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}`),

  /** Legt eine Bezugsgröße an; eine Ablehnung trägt `code` aus `bezugsgroesse.ts` (`ABLEHNUNGEN`). */
  bezugsgroesseAnlegen: (body: BezugsgroesseAnfrage) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Ändert die GANZE Bezugsgröße (mit Kennzeichen); nach dem ersten Wert nur Name und Kennzeichen. */
  bezugsgroesseAendern: (id: string, body: BezugsgroesseAnfrage & { kennzeichen: string }) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Archiviert eine Bezugsgröße — die Werte bleiben lesbar, das Kennzeichen belegt. */
  bezugsgroesseArchivieren: (id: string) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}/archivieren`, { method: 'POST' }),

  /** Löscht eine Bezugsgröße ohne einen einzigen Wert (sonst 409 `hat_werte`). */
  bezugsgroesseLoeschen: (id: string) =>
    request<void>(`/api/v1/bezugsgroessen/${id}`, { method: 'DELETE' }),

  /**
   * Die Werte mit ihren Fassungen und der Herkunft je Fassung. `von`/`bis` sind Tage
   * (JJJJ-MM-TT, der letzte einschließlich); `fassungen` `wirksam` (Vorgabe) oder `alle`.
   */
  bezugsgroesseWerte: (id: string, abfrage: { von?: string; bis?: string; fassungen?: BezugsgroesseLesart } = {}) => {
    const q = new URLSearchParams();
    if (abfrage.von) q.set('von', abfrage.von);
    if (abfrage.bis) q.set('bis', abfrage.bis);
    if (abfrage.fassungen) q.set('fassungen', abfrage.fassungen);
    const s = q.toString();
    return request<BezugsgroesseWerte>(`/api/v1/bezugsgroessen/${id}/werte${s ? `?${s}` : ''}`);
  },
};
