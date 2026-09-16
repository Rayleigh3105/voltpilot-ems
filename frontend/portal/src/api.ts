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
import type { Aktion as FunktionAktion, FunktionZustand, Pruefung as FunktionPruefung } from './uemsFunktion';
export type { SiteVerbraucher } from './verbraucherZone';
import type { SteuerartErgebnis, SteuerartWunsch } from './steuerartDialog';
export type { SteuerartErgebnis, SteuerartWunsch } from './steuerartDialog';
import type { Bestand, FlaecheQuelle } from './uemsOrtsbaum';
import type { FahrzeugWunsch, SiteFahrzeuge } from './fahrzeugProfile';
export type { Fahrzeug, FahrzeugWunsch, SiteFahrzeuge } from './fahrzeugProfile';
import type { Topology } from './topology';
import type { ModellWahlZustand } from './prognose';
import type { ComponentMatch } from './komponentenAssistent';

/** AP-08 IP-16: Prüfseite und Ersatzwerte; Werte entstehen erst nach Freigabe im Rechenlauf. */
export type ErsatzwertMethode = 'gleichmaessig_verteilen' | 'profil_vorperiode' | 'profil_vergleichsquelle'
  | 'ablesestand_nachtragen' | 'wert_eingeben' | 'vorperiode_uebernehmen' | 'vergleichsquelle_uebernehmen';
export interface ErsatzwertLuecke { id: string; art: 'data_gap' | 'counter_reset' | 'device_boundary'; von: string; bis: string | null; zuwachs: number | null; einheit: string | null }
export interface ErsatzwertEingabe {
  quelle_id: string; methode: ErsatzwertMethode; von: string; bis: string; begruendung: string;
  beleg?: string; luecke_ereignis_id?: string; vorperiode_von?: string; vergleich_quelle_id?: string;
  zeitpunkt?: string; endstand?: number; anfangsstand?: number; betrag?: number; einheit?: string;
}
export interface KorrekturPeriodenStand {
  menge: number | null; menge_zustand: string; kennzeichen?: string[];
  erhalten?: number; erwartet?: number; abdeckung_prozent?: number | null;
}
export interface KorrekturPeriode {
  periode: string; von: string; bis: string; version_alt?: number; version_neu?: number;
  alt?: KorrekturPeriodenStand; neu: KorrekturPeriodenStand;
}
export interface KorrekturAuswirkungen {
  perioden: string[]; berechnete_messstellen: string; kennzahlen: string; berichte: string;
}
export interface KorrekturAktion { erlaubt: boolean; grund: string | null }
export interface KorrekturDetail {
  kennung: string; art: string; status: 'vorschlag' | 'freigegeben' | 'abgelehnt' | 'zurueckgenommen';
  fassung: number; von: string; bis: string; begruendung: string; beleg: string | null;
  ersatzwert_kennung: string | null; methode: ErsatzwertMethode | null; einheit: string | null;
  messstellen: { kennzeichen: string; name: string }[];
  ersteller: { name: string; rolle: string; art: string }; erstellt_am: string; vieraugen: boolean;
  vorschau: KorrekturPeriode[]; auswirkungen: KorrekturAuswirkungen;
  freigeben: KorrekturAktion; zuruecknehmen: KorrekturAktion; ablehnen: KorrekturAktion;
}
export interface ErsatzwertVorschau {
  perioden: KorrekturPeriode[]; auswirkungen: KorrekturAuswirkungen; vieraugen: boolean; freigabe_noetig: boolean;
}

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

/** Belegte offene Ausfälle eines Standorts; Ursachen stehen nur an Fakten aus `data_gap`. */
export interface StandortAusfall {
  standort_id: string;
  boxen_gesamt: number;
  boxen_ausgefallen: number;
  messstellen_unvollstaendig: number;
  boxen: Array<{ id: string; name: string; seit: string; anlagen: string[] }>;
  messstellen: Array<{
    id: string;
    kennzeichen: string;
    name: string | null;
    art: 'gemessen' | 'berechnet';
    seit: string | null;
    box_id: string | null;
    box: string | null;
    fehlt: string[];
  }>;
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
  /** AP-03 IP-7: wer den Eingriff gesetzt hat; null für einen Eingriff von vor dieser Fassung. */
  urheber?: ProtokollUrheber | null;
  /**
   * AP-03 IP-9 (E15): der Satz der Jetzt-Zone — „gesetzt von Murat Demirci" und, wenn dessen Bedienrecht
   * inzwischen endete, „… (Bedienrecht beendet am 14.11.2026 09:02)". Der Eingriff selbst bleibt und wirkt
   * bis zu seinem Ende; ein Entzug schaltet nie. null ohne bekannten Urheber.
   */
  etikett?: string | null;
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
  /** Benannter Zustellgrund, wenn der Wunsch die Box noch nicht erreicht hat. */
  pushReason?: string | null;
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
  /** Ungeklemmt — außerhalb 0…100 % trägt `autarkieUnplausibel` es (AP-10 E16 Nr. 5). */
  autarkiePct: number | null;
  /** Ungeklemmt — außerhalb 0…100 % trägt `eigenverbrauchUnplausibel` es. */
  eigenverbrauchPct: number | null;
  /**
   * Die Quote liegt außerhalb 0…100 %: die Messwerte passen nicht zusammen.
   * OPTIONAL, weil ein älterer Server es nicht liefert — gelesen wird es nur über
   * `quoteUnplausibel`, das dann am Wertebereich prüft.
   */
  autarkieUnplausibel?: boolean | null;
  eigenverbrauchUnplausibel?: boolean | null;
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
  /** Newest status-heartbeat arrival; legacy telemetry is the migration fallback. */
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
  /** Server-derived role; absent on older backends. Never infer it from list order. */
  fuehrtAnlage?: boolean | null;
}

/** AP-06 IP-19: Ergebnis der Nachfolger-Anmeldung; `zugestellt=false` ist erst vorbereitet. */
export interface BoxTauschAntwort {
  tausch: {
    oldDeviceId: string;
    newDeviceId: string;
    siteId: string;
    effectiveAt: string;
    transferred: Record<string, number>;
  };
  zugestellt: boolean;
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
  /**
   * Die ROHEN Katalogwörter der Messgröße/Richtung (`active_power`, `generation`
   * …), `null` = nicht belegt (z. B. der richtungslose Gen-Port). Additiv, damit
   * der Summenwert-Assistent auch noch nicht beobachtete Register einordnen kann;
   * die Kundenwörter leitet `registerAbbildung.ts` daraus ab.
   */
  quantity: string | null;
  direction: string | null;
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
  availabilityReason?: 'registerfamilie_nicht_zugeordnet' | null;
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

/** A box counts as connected when its status heartbeat arrived within this window. */
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
  /**
   * „composed" = a platform-SYNTHESIZED base row (the grid-meter / house-load
   * derived from the gateway). The delete gate mirrors the server
   * (vp-komp-loeschen E2): a component without a pin is deletable UNLESS it
   * carries this marker, so a never-connected producer can be removed while the
   * plant's derived base stays protected. Absent on an older backend.
   */
  sourceKind?: string | null;
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
  quantity?: string | null;
  kanal: string;
  anzeigename: string | null;
  einheit: string | null;
  wertart: string | null;
  groesse: string | null;
  richtung: string | null;
  aktiv: boolean;
  /** Die Box, die den Kanal liest (AP-04-Read-Model); Kennung, nicht Anzeigename. */
  lesende_box?: string | null;
  /** Das zum Stichtag eingebaute Gerät; `null` heißt: nicht erfasst. */
  geraet?: MesskanalGeraet | null;
  /**
   * Das KATALOGWORT der Richtung (`import_export`, `import`, …) — nicht das Kundenwort `richtung`.
   * Nur daran hängt der Anteil eines Vorzeichen-Werts (AP-08 IP-7, E15); fehlend = keiner.
   */
  direction?: string | null;
  /** Die gewünschte Kadenz der Mess-Selektion in Sekunden; `null` = nicht festgelegt. */
  kadenz_s?: number | null;
  /** Welche Messstellen der Kanal jetzt speist (AP-04 IP-13) — leer ohne laufende Quellenbindung. */
  speist?: MesskanalSpeist[];
}

export interface MesskanalGeraet {
  id: string;
  geraet: string;
  einbau: string | null;
  seriennummer: string | null;
}

/** Eine laufende Quellenbindung des Kanals — genug für „speist MS-06 (führend)“. */
export interface MesskanalSpeist {
  messstelle_id: string;
  messstelle: string;
  groesse: string | null;
  richtung: string | null;
  rolle: 'fuehrend' | 'vergleich';
  /** Nur bei `vergleich`: Plausibilität · Ersatz bei Ausfall · Abrechnungszähler. */
  zweck: string | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
  /**
   * Additiv (AP-04 IP-14): welchen Teil eines Vorzeichen-Werts die Bindung liest (AP-08 IP-7,
   * E15); fehlend/`null` = der ganze Wert. Erst damit graut „Quelle binden“ richtig aus — EIN
   * Vorzeichen-Kanal führt den Bezug der einen und die Abgabe der anderen Messstelle.
   */
  anteil?: 'positiv' | 'negativ' | null;
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
  // Additiv (AP-04 IP-6): die volle Form der Detail-Route, snake_case — der Messstellen-Dialog
  // „bearbeiten“ liest daraus Hauptgröße, Zuordnungen und ob schon eine Quelle führt.
  hauptgroesse?: MessstelleGroesse | null;
  nebengroessen?: (MessstelleGroesse & { lebenszyklus: string; fuehrende_quelle?: MessstelleQuelleZeitraum[] })[];
  orte?: MessstelleOrtZuordnung[];
  elektrische_stellung?: MessstelleStellungZuordnung[];
  fuehrende_quelle?: MessstelleQuelleZeitraum[];
  /** PUT ersetzt die Felder GANZ — wer umbenennt, schickt die Anschlussleistung mit. */
  anschlussleistung_kw?: number | null;
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
  /** AP-08: der Haken „gilt als Erzeugung“ an einem richtungslosen Kanal (`messstelle-formel.md` §2.2). */
  gilt_als_erzeugung: boolean;
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
  formel_typ: 'gewichtete_summe' | 'rest' | 'saldo';
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
 * (`unvollstaendig`) und `fehlende` nennt die Terme — NIE eine Teilsumme. Der Live-Wert wird nie
 * gespeichert; die Periodenwerte liegen seit AP-10 IP-10 in der Speicherklasse (`…/{kennzeichen}/werte`).
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

// ---- Werte je Messstelle (UEMS AP-08 IP-9) ----------------------------------
// Die Form von GET /api/v1/messstellen/{kennzeichen}/werte (snake_case, OpenAPI
// `MessstelleWerte`). Jedes Feld steht immer da; `null` heißt unbekannt oder nicht
// gebildet, nie 0. Die Fläche dazu ist die Tages- und Monatskarte (IP-11).

export type MessstelleWerteRaster = 'viertelstunde' | 'stunde' | 'tag' | 'monat' | 'jahr';

/** Eine FÜHRENDE Bindung der Hauptgröße, die den Zeitraum berührt. */
export interface MessstelleWerteQuelle {
  id: string;
  komponente: string;
  kanal: string;
  herleitung: 'zaehlerstand' | 'differenzen' | 'integration' | 'momentanwert';
  anteil: 'positiv' | 'negativ' | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/** Ein Schritt des Rasters — ungerundet; gerundet wird nur angezeigt (E11). */
export interface MessstelleWerteWert {
  von: string;
  bis: string;
  /** Viertelstunde und Stunde: „02:00–03:00 MESZ“ (E10). */
  beschriftung: string | null;
  /** Tag, Monat, Jahr: die Stunden der Periode. */
  stunden: number | null;
  /** Tag: „25 Stunden (Zeitumstellung)“, an einem 24-Stunden-Tag null. */
  tagesdauer: string | null;
  menge: number | null;
  mittel: number | null;
  min: number | null;
  max: number | null;
  zustand: 'vollständig' | 'unvollständig' | 'keine Werte' | 'mit Ersatzwert' | null;
  kennzeichen: string[];
  erhalten: number | null;
  erwartet: number | null;
  abdeckung_prozent: number | null;
  fassung: 'vorlaeufig' | 'endgueltig' | null;
  endgueltig_ab: string | null;
  version: number | null;
  gebildet_aus: 'viertelstunde' | 'zeitraum' | 'tag' | 'monat' | 'jahr' | null;
  /** Die Bindung, deren Reihe den Schritt beantwortet. */
  quelle: string | null;
  grund:
    | 'keine_quelle'
    | 'quelle_teilweise'
    | 'anteil_nicht_gespeichert'
    | 'berechnet'
    | 'noch_nicht_gebildet'
    | 'ohne_menge_gespeichert'
    | 'version_nicht_gespeichert'
    /** Die Stunde hat keine eigenen Versionen: eine ihrer Viertelstunden trägt eine spätere (IP-18). */
    | 'version_nicht_gebildet'
    | null;
  ereignisse: Array<{ id: string; art: string; von: string; bis: string | null }>;
  /**
   * AP-10 IP-12: die Hülle `{satz, fehlt}` nach `bilanzwert-herkunft.schema.json` an jeder BERECHNETEN
   * Zahl; `null` an einem gemessenen Schritt oder einem ohne Zahl.
   */
  herkunft: { satz: Record<string, unknown> | null; fehlt: string[] } | null;
  /**
   * AP-08 IP-18: wie viele Versionen die Periode hat — ab 2 gibt es eine Historie unter
   * `…/werte/versionen`. `null` an der Stunde (keine eigenen Versionen), ohne Reihe und wo nichts gebildet ist.
   */
  versionen: number | null;
}

// ---- Versionen am Wert (UEMS AP-08 IP-18) -----------------------------------
// Die Form von GET /api/v1/messstellen/{kennzeichen}/werte/versionen (OpenAPI
// `MessstelleWerteHistorie`): die Historie GENAU EINER Periode.

/** Wer eine Fassung geschrieben hat; ein System-Vorschlag: `VoltPilot`, `art` `voltpilot`. */
export interface MessstelleWerteUrheber {
  name: string;
  rolle: string | null;
  art: string;
}

/** Eine Fassung eines Ersatzwerts (`EW-…`) oder einer Korrektur (`K-…`), die eine Version ausmacht. */
export interface MessstelleWerteEntscheidung {
  vorgang: 'ersatzwert' | 'korrektur';
  kennung: string;
  fassung: number;
  status: string | null;
  methode: string | null;
  art: string | null;
  wer: MessstelleWerteUrheber | null;
  /** In der Zeitzone des Standorts, mit Versatz. */
  wann: string | null;
  /** Der Text DIESER Fassung (Begründung bzw. Grund) — `null`, wenn keiner geschrieben wurde. */
  warum: string | null;
  beleg: string | null;
  fehlt: Array<'warum' | 'fassung'>;
  /** Die anlegende Fassung, an einer späteren — mit IHREM Urheber. */
  angelegt: { wer: MessstelleWerteUrheber; wann: string; warum: string | null; beleg: string | null } | null;
}

export interface MessstelleWerteVersion {
  version: number;
  /** Was vorher dastand (Version n − 1); an Version 1 `null`. */
  wert_alt: MessstelleWerteWert | null;
  wert_neu: MessstelleWerteWert;
  gebildet_am: string | null;
  nachgezogen_am: string | null;
  anlass: { kennung: string; fassung: number } | null;
  entscheidungen: MessstelleWerteEntscheidung[];
}

export interface MessstelleWerteHistorie {
  messstelle: MessstelleWerte['messstelle'];
  raster: Exclude<MessstelleWerteRaster, 'stunde'>;
  von: string;
  bis: string;
  zeitzone: string;
  zeitzone_herkunft: MessstelleWerte['zeitzone_herkunft'];
  /** Ein Wort von `MessstelleWerteWert.grund` — warum die Periode keine Versionen hat. */
  grund: string | null;
  /** Aufsteigend: Version 1 zuerst. */
  versionen: MessstelleWerteVersion[];
}

export interface MessstelleWerte {
  messstelle: {
    id: string;
    kennzeichen: string;
    name: string | null;
    art: string;
    groesse: string;
    richtung: string;
    einheit: string;
    wertart: string;
  };
  raster: MessstelleWerteRaster;
  von: string;
  bis: string;
  zeitzone: string;
  zeitzone_herkunft: 'standort' | 'unternehmen' | 'vorgabe';
  version: number | null;
  quellen: MessstelleWerteQuelle[];
  werte: MessstelleWerteWert[];
}

/**
 * Der Beitrag EINES Geräts zum kanonischen Rollen-Wert (`RollenDto.GeraetBeitrag`). ⚠ snake_case
 * wie das echte Backend (`@JsonNaming` = SnakeCase) — `request()` wandelt NICHT um. Ehrlich
 * benannt: `liefernd` mit `wert`, oder stumm mit `grund` (`kein_wert` · `veraltet` ·
 * `unvollstaendig` · `archiviert` · `kein_geraet`) — nie eine stille Teilsumme.
 */
export interface RollenGeraetBeitrag {
  entity_id: string;
  name: string;
  /** `messkanal` (nativer Kanal) oder `gesamtwert` (berechneter Summenwert). */
  art: string;
  wert: number | null;
  liefernd: boolean;
  grund: string | null;
}

/**
 * Der kanonische, über alle Geräte zusammengefasste Rollen-Wert einer Anlage
 * (`GET /api/v1/sites/{id}/rollen/{role}`, `RollenDto.KanonischerWert`, snake_case). Existiert keine
 * Zuordnung, ist `zuordnung_vorhanden = false` und das Cockpit bleibt bei `telemetry.pv_power_kw`.
 * `unvollstaendig` = mindestens ein zugeordnetes Gerät liefert gerade nicht (in `geraete` benannt).
 */
export interface RollenKanonischerWert {
  role: string;
  zuordnung_vorhanden: boolean;
  wert: number | null;
  einheit: string;
  unvollstaendig: boolean;
  geraete: RollenGeraetBeitrag[];
  stand: string | null;
}

/** Der Körper von `POST /api/v1/messstellen/berechnet`. */
export type SummenwertRolle = 'pv' | 'consumer' | 'grid';
export interface GeraetSummenwert {
  messstelle: Messstelle;
  rolle: SummenwertRolle | null;
  wert: MessstelleWert;
}

export type SummenwertKontext = { art: 'anlage' } | { art: 'geraet'; boxId: string; geraetId: string };

export interface BerechneteMessstelleAnlegen {
  formel_typ?: 'gewichtete_summe' | 'saldo';
  gueltig_ab?: string;
  kontext?: { art: 'anlage' | 'geraet'; site_id: string; box_id?: string; geraet_id?: string };
  rolle?: { entity_id: string; role: SummenwertRolle; ersetzen?: boolean };
  name: string;
  terme: Array<{
    eingang_art: 'messkanal' | 'messstelle' | 'verteilung';
    entity_id?: string;
    point_key?: string;
    quell_messstelle_id?: string;
    vorzeichen: '+' | '-';
    faktor: number;
    /** AP-08: nur bei einem richtungslosen Kanal, der als Erzeugung zählen soll. */
    gilt_als_erzeugung?: boolean;
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
  formel_typ?: 'gewichtete_summe' | 'saldo';
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

/** Listenumschlag einschließlich der nur gelesenen Flächen aus der Struktur (IP-9). */
export interface BezugsgroessenListe {
  bezugsgroessen: Bezugsgroesse[];
  bezugsflaechen: Bezugsflaeche[];
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

/** Spaltenzuordnung eines Bezugsdaten-Imports (AP-09 IP-15, C3). Spalten sind 1-basiert. */
export interface BezugsdatenZuordnung {
  csv: { kodierung: string | null; trennzeichen: string | null; kopfzeile: boolean | null } | null;
  spalten: { periode: number | null; bis: number | null; wert: number | null; einheit: number | null; bezug: number | null; bemerkung: number | null };
  deutung: 'periode' | 'periodenbeginn' | 'periodenende' | 'von_bis' | 'zeitpunkt';
  zahlformat: 'de' | 'en' | 'auto';
  einheit: string | null;
  bezugsgroesse: string | null;
  bezug_tabelle: Record<string, string>;
  synonyme: Record<string, string>;
}

export interface BezugsdatenBefund { befund: string; satz: string; hinweis: boolean }
export interface BezugsdatenZaehler {
  zeilen: number; neu: number; wiederholung: number; konflikt: number; berichtigung: number;
  uebersprungen: number; abgelehnt: number; mit_hinweis: number;
}
export interface BezugsdatenVorschau {
  vorschau: { kennung: string; status: 'vorschau'; ausgestellt_am: string; gueltig_bis: string; ergebnis_fingerabdruck: string };
  vorlage: { vorlage_id: string; fassung: number; name: string } | null;
  datei: {
    name: string; bytes: number; sha256: string; befund: BezugsdatenBefund | null; zusatz: string | null;
    zusatz_satz: string | null; zeile: number | null; kodierung: string | null; bom: boolean | null;
    trennzeichen: string | null; kopfzeile: boolean | null; kopf: string[] | null; spalten: number | null; datenzeilen: number | null;
  };
  frueherer_import: { kennung: string; status: string; am: string } | null;
  zeilen: Array<{
    nr: number; felder: string[]; bezugsgroesse: string | null; bezugsgroesse_id: string | null; schluessel: string | null;
    periode_von: string | null; periode_bis: string | null; zeitpunkt: string | null; betrag: string | null; einheit: string | null;
    geliefert: { wert: string; einheit: string | null } | null; urteil: string; befunde: BezugsdatenBefund[];
    fingerabdruck: string | null; bestand: { betrag: string; fassung: number; import_kennung: string | null } | null;
  }>;
  import: {
    status: string | null; zaehler: BezugsdatenZaehler; uebernahme_moeglich: boolean; import_datensatz: boolean;
    bestaetigung: string | null; aenderungen: number; befunde: BezugsdatenBefund[];
  };
}

export interface BezugsdatenVorlage {
  vorlage_id: string; fassung: number; name: string; zuordnung: BezugsdatenZuordnung;
  urheber: { name: string; rolle: string; art: string }; erstellt_am: string;
}

export interface BezugsdatenImportErgebnis {
  kennung: string; status: string; aenderungen: number; vorschlaege: number;
  zaehler: BezugsdatenZaehler | null; vorlage: { vorlage_id: string; fassung: number; name: string } | null;
}

export interface BezugsdatenImportZeile {
  nr: number; urteil: string; befunde: BezugsdatenBefund[]; bezugsgroesse: string | null;
  periode_von: string | null; periode_bis: string | null; zeitpunkt: string | null;
  betrag: string | null; einheit: string | null; geliefert_wert: string | null; geliefert_einheit: string | null;
}
export interface BezugsdatenImportProtokollEintrag {
  kennung: string; status: string; datei_name: string; datei_bytes: number; erstellt_am: string; geaendert_am: string;
  aenderungen: number; vorschlaege: number; zaehler: BezugsdatenZaehler; vorlage: { vorlage_id: string; fassung: number; name: string } | null; begruendung: string | null;
  urheber: { name: string; rolle: string; art: string }; zeilen: BezugsdatenImportZeile[];
}
export interface BezugsdatenRuecknahmeVorschau {
  kennung: string; aenderungen: number; vieraugen: boolean; werte: Array<{
    bezugsgroesse_id: string; kennzeichen: string; name: string; periode_von: string | null; periode_bis: string | null;
    zeitpunkt: string | null; bisheriger_betrag: string | null; neuer_betrag: string | null; einheit: string;
    vorgang: 'zurueckgenommen' | 'vorfassung_wiederhergestellt';
  }>;
}

/**
 * UEMS AP-03 IP-4: die Selbstauskunft `GET /api/v1/me` (OpenAPI `Selbstauskunft`) - wer fragt und was er darf.
 * Rollen, Umfänge und Aktionen sind Kennungen der Rechte-Matrix (`docs/contracts/v2/rechte-matrix.json`);
 * `standorte`, `kuenftig`, `text` und `teilansicht` sind die Ableitung `sichtbare_standorte` aus
 * `rechte-vectors.json`. `rollen.ts` liest sie als einzige Rechte-Quelle (AP-03 IP-12).
 */
export interface Selbstauskunft {
  /** Das Subject des Kontos. */
  kennung: string | null;
  name: string | null;
  konto: 'benutzer' | 'partner' | 'plattform' | null;
  zustand: 'angelegt' | 'aktiv' | 'gesperrt' | 'entfernt';
  /** `null` ohne angenommenen Kundenbereich (Partner ohne wirksame Unterstützung). */
  kundenbereich: SelbstauskunftKundenbereich | null;
  /** `umschalter` = Plattform über `X-Tenant-Id` (bis AP-03 IP-8). */
  zugang: 'konto' | 'unterstuetzung' | 'umschalter' | null;
  rollen: string[];
  unternehmensweit: boolean;
  standorte: SelbstauskunftStandort[];
  /** Die Aktionen, die der Aufrufer auf Unternehmensebene darf. */
  unternehmen_rechte: string[];
  kuenftig: SelbstauskunftKuenftig[];
  /** Der Satz ohne Standort, sonst `null`. */
  text: string | null;
  teilansicht: SelbstauskunftTeilansicht | null;
  unterstuetzungen: SelbstauskunftUnterstuetzungen;
  kundenadministratoren: SelbstauskunftPerson[];
  kundenbereiche?: { id: string; name: string; umfang: SelbstauskunftUmfang; endet: string }[];
}

export type SelbstauskunftUmfang = 'ansehen' | 'einrichten' | 'einrichten_und_bedienen';

export interface SelbstauskunftKundenbereich {
  id: string;
  name: string;
}

export interface SelbstauskunftStandort {
  id: string;
  kennzeichen: string;
  name: string;
  rollen: string[];
  umfang: SelbstauskunftUmfang | null;
  ocpp_stufe: 'keine' | 'CUSTOMER' | 'SITE_ADMIN' | 'PLATFORM';
  /** Die Aktionen (Kennungen der Matrix), die der Aufrufer an diesem Standort darf. */
  rechte: string[];
}

export interface SelbstauskunftKuenftig {
  standort: string;
  ab: string;
  text: string;
}

export interface SelbstauskunftTeilansicht {
  sichtbar: number;
  gesamt: number;
  unternehmensebene: boolean;
  teilansicht: boolean;
  kopfzeile: string | null;
  export_kopfzeile: string | null;
  unternehmensweite_objekte: boolean;
}

export interface SelbstauskunftUnterstuetzungen {
  eigene: SelbstauskunftUnterstuetzung[];
  gewaehrte: SelbstauskunftUnterstuetzung[];
}

export interface SelbstauskunftUnterstuetzung {
  art: 'installateur' | 'voltpilot' | 'notfall';
  umfang: SelbstauskunftUmfang | null;
  standorte: string[];
  gueltig_ab: string;
  /** Enddatum einschließlich; der Notfall-Zugriff hat keins, nur `endet`. */
  gueltig_bis: string | null;
  endet: string | null;
  zustand: 'entwurf' | 'eingerichtet' | 'aktiv' | 'archiviert';
  erinnerung: boolean;
  unterstuetzer: SelbstauskunftPerson;
  banner: string | null;
}

export interface SelbstauskunftPerson {
  kennung: string;
  name: string;
}

/**
 * UEMS AP-03 IP-8: die Unterstützung (`/api/v1/unterstuetzung`, OpenAPI `Unterstuetzung`) - gewähren,
 * verlängern, beenden, die Anfragen von VoltPilot und das Hinweis-Postfach. Die Wörter `art`, `umfang` und
 * `zustand` sind die des Rechte-Vertrags; `anlass` ist das geschlossene Vokabular dieses Pakets (Zwilling des
 * CHECK `unterstuetzung_hinweis_anlass_chk`). Noch liest das Portal sie nicht (AP-03 IP-15).
 */
export type UnterstuetzungArt = 'installateur' | 'voltpilot' | 'notfall';
export type UnterstuetzungAnlass =
  | 'anfrage'
  | 'gewaehrt'
  | 'notfall'
  | 'erinnerung'
  | 'abgelaufen'
  | 'beendet';

export interface Unterstuetzung {
  /** Der Griff der Gewährung - die kleinste Kennung ihrer Zeilen; er bleibt, auch nachdem sie endete. */
  id: string;
  art: UnterstuetzungArt;
  umfang: SelbstauskunftUmfang | null;
  standorte: string[];
  /** Dieselben Standorte als Kennzeichen des Vertrags (ST-1 …). */
  standort_kennzeichen: string[];
  unterstuetzer: SelbstauskunftPerson;
  gueltig_ab: string;
  /** Enddatum einschließlich; der Notfall-Zugriff hat keins, nur `endet`. */
  gueltig_bis: string | null;
  endet: string | null;
  zustand: 'entwurf' | 'eingerichtet' | 'aktiv' | 'archiviert';
  erinnerung: boolean;
  grund: string | null;
  /** Der Banner-Satz, solange sie wirkt. */
  banner: string | null;
  /** Der Satz danach („Endete am … durch Zeitablauf“, „Beendet am … durch …“, „Wirkt ab …“). */
  text: string | null;
  /** GENAU EINMAL in der Antwort des Gewährens, wenn dafür ein Partner-Konto entstand (E14). */
  startpasswort: string | null;
}

/** Der Körper von `POST /api/v1/unterstuetzung` (streng gelesen, snake_case). */
export interface UnterstuetzungGewaehren {
  art?: 'installateur' | 'voltpilot';
  email?: string | null;
  standorte?: string[];
  umfang?: SelbstauskunftUmfang | null;
  gueltig_ab?: string | null;
  gueltig_bis?: string | null;
  grund?: string | null;
  anfrage_id?: string | null;
}

/** Ein Wunsch von VoltPilot (E8, A5) - er gewährt nichts, bis der Kundenadministrator bestätigt. */
export interface UnterstuetzungAnfrage {
  id: string;
  art: 'voltpilot';
  umfang: SelbstauskunftUmfang;
  standorte: string[];
  angefragt_von: SelbstauskunftPerson;
  gueltig_ab: string;
  gueltig_bis: string;
  grund: string | null;
  /** Abgeleitet, nie gespeichert. */
  zustand: 'offen' | 'bestaetigt' | 'abgelehnt';
  entschieden_am: string | null;
  /** Der Griff der gewährten Unterstützung, sonst `null`. */
  unterstuetzung: string | null;
  angefragt_am: string;
}

/** Ein Hinweis im Postfach eines Kundenadministrators - Karte im Portal, mit SMTP zusätzlich eine E-Mail. */
export interface UnterstuetzungHinweis {
  id: string;
  anlass: UnterstuetzungAnlass;
  text: string;
  unterstuetzung: string | null;
  anfrage: string | null;
  erzeugt_am: string;
  gelesen_am: string | null;
  /** `null`, solange kein SMTP steht - dann ist das Portal der Weg. */
  email_versandt_am: string | null;
}

/** Der geschlossene Satz der Ablehnungen (OpenAPI `UnterstuetzungFehler`). */
export type UnterstuetzungFehlerCode =
  | 'anfrage_ungueltig'
  | 'nicht_gefunden'
  | 'bereits_beendet'
  | 'anfrage_entschieden'
  | 'standort_fehlt'
  | 'standort_unbekannt'
  | 'hoechstens_12_monate'
  | 'grund_fehlt'
  | 'ende_nicht_spaeter'
  | 'notfall_nicht_verlaengerbar'
  | 'konto_nicht_erreichbar';

/** UEMS AP-11: die Wörter des Kennzahl-Vertrags (`docs/contracts/v2/kennzahl-vectors.json`). */
export type KennzahlRechenform = 'quotient' | 'anteil' | 'zusammenfassung';
export type KennzahlPeriodeArt = 'tag' | 'woche' | 'monat' | 'jahr';
export type KennzahlGeltungArt = 'unternehmen' | 'standort' | 'gebaeude' | 'bereich' | 'prozess' | 'kostenstelle' | 'messstelle';

/** Ein Eingang über das Kennzeichen seines Objekts (MS-12, BZ-6, KZ-0001). */
export interface KennzahlEingang {
  rolle: 'zaehler' | 'nenner' | 'paar';
  art: 'messstelle' | 'bezugsgroesse' | 'kennzahl';
  kennzeichen: string;
}

/**
 * Eine Kennzahl (UEMS AP-11 IP-5, `/api/v1/kennzahlen`, snake_case wie der Kennzahl-Vertrag).
 * `rechte_geltung` und `kennung` folgen aus dem Geltungsbereich (G1); `fassung`, `einheit`,
 * `grundperiode` und `perioden` beschreiben die HEUTE geltende Berechnung.
 */
export interface Kennzahl {
  id: string;
  kennzeichen: string;
  name: string;
  rechenform: KennzahlRechenform;
  geltung_art: KennzahlGeltungArt;
  geltung_id: string;
  geltung_name: string | null;
  rechte_geltung: 'standort' | 'unternehmen';
  standort_id: string | null;
  kennung: 'kennzahl.standort_definieren' | 'kennzahl.unternehmen_definieren';
  verantwortlich_name: string;
  zweck: string | null;
  fassung: number | null;
  einheit: string | null;
  einheit_anzeige: string | null;
  grundperiode: KennzahlPeriodeArt | null;
  perioden: KennzahlPeriodeArt[];
  hat_werte: boolean;
  archiviert_am: string | null;
  angelegt_am: string;
}

/** Der Körper von `POST /api/v1/kennzahlen` und `…/vorschau` (streng gelesen; `periode_art` ist ein Wunsch). */
export interface KennzahlAnfrage {
  kennzeichen?: string | null;
  name: string;
  rechenform: string;
  geltung_art: KennzahlGeltungArt;
  geltung_id: string;
  verantwortlich_name?: string | null;
  zweck?: string | null;
  periode_art?: KennzahlPeriodeArt | null;
  komplement?: boolean | null;
  eingaenge: KennzahlEingang[];
}

/** Eine Fassung der Berechnung; `gueltig_ab` null = gilt seit Beginn, `gueltig_bis` = letzter Tag einschließlich. */
export interface KennzahlFassung {
  nummer: number;
  gueltig_ab: string | null;
  gueltig_bis: string | null;
  aufgehoben_am: string | null;
  herkunft: 'anlage' | 'eintrag' | 'kopie';
  rueckwirkend: boolean;
  abzeichen: string | null;
  begruendung: string | null;
  eingetragen_von: { name: string; rolle: string | null; art: 'kunde' | 'unterstuetzung' | 'voltpilot' | 'notfall' };
  eingetragen_am: string;
  rechenform: KennzahlRechenform;
  einheit: string;
  einheit_anzeige: string;
  komplement: boolean;
  eingaenge: { rolle: KennzahlEingang['rolle']; art: KennzahlEingang['art']; id: string; kennzeichen: string; name: string | null }[];
}

/** Eine Periode der Vorschau — gerechnet, nie gespeichert; `wert` null heißt keine Werte, nie 0. */
export interface KennzahlVorschauPeriode {
  periode_art: KennzahlPeriodeArt;
  schluessel: string;
  beschriftung: string;
  von: string;
  bis: string;
  wert: string | null;
  zaehler: string | null;
  nenner: string | null;
  zustand: string;
  richtung: 'untergrenze' | 'obergrenze' | 'unbestimmt' | null;
  grund: string | null;
  abdeckung_prozent: string | null;
  fassung: string | null;
  kennzeichen: string[];
  anzeige: string;
  kundensatz: string | null;
}

/** Die Antwort von `POST /api/v1/kennzahlen/vorschau`: `befunde` leer = das Anlegen würde gelingen. */
export interface KennzahlVorschau {
  befunde: { code: KennzahlFehlerCode; message: string; fakten: Record<string, unknown> }[];
  rechte_geltung: 'standort' | 'unternehmen' | null;
  standort_id: string | null;
  kennung: string | null;
  einheit: string | null;
  einheit_anzeige: string | null;
  grundperiode: KennzahlPeriodeArt | null;
  perioden: KennzahlPeriodeArt[];
  periode_art: KennzahlPeriodeArt | null;
  letzte_perioden: KennzahlVorschauPeriode[];
}

/** Was eine Vorlage an einer Seite erwartet (UEMS AP-11 IP-10, `kennzahl-vorlagen.schema.json`); `berechnet` = Gesamtwert. */
export interface KennzahlVorlageMessstelle {
  art: 'messstelle';
  messstelle_arten: ('gemessen' | 'berechnet')[];
  groesse: string;
  /** null = die Vorlage verlangt keine Richtung. */
  richtungen: string[] | null;
  wertarten: string[];
  satz: string;
}

/** Arten aus `bezugsdaten-vectors.json → arten.je_art`; Einheiten werden nie umgerechnet. */
export interface KennzahlVorlageBezugsgroesse {
  art: 'bezugsgroesse';
  bezugsgroesse_arten: string[];
  einheiten: string[];
  wertarten: ('periodenwert' | 'stammdatum')[];
  satz: string;
}

export type KennzahlVorlageErwartung = KennzahlVorlageMessstelle | KennzahlVorlageBezugsgroesse;

/**
 * Eine Vorlage des VoltPilot-Katalogs (`GET /api/v1/kennzahl-vorlagen`, byte-gleich `src/kennzahlen/kennzahl-vorlagen.json`):
 * `zaehler_erwartung` ist Menge bzw. Teil, `nenner_erwartung` Bezugsgröße bzw. Ganzes.
 */
export interface KennzahlVorlage {
  kennung: string;
  name_vorschlag: string;
  zweck_vorschlag: string;
  hilfesatz: string;
  rechenform: 'quotient' | 'anteil';
  komplement: boolean;
  zaehler_erwartung: KennzahlVorlageErwartung;
  nenner_erwartung: KennzahlVorlageErwartung;
}

export interface KennzahlVorlagen {
  schema_version: string;
  vorlagen: KennzahlVorlage[];
}

/** Eine Gruppe möglicher Paare einer Zusammenfassung: dieselbe Rechenform, dieselbe Einheit (UEMS AP-11 IP-11, R4). */
export interface KennzahlPaarGruppe {
  rechenform: KennzahlRechenform;
  einheit: string;
  einheit_anzeige: string | null;
  kennzahlen: Kennzahl[];
}

/** Die Antwort von `GET /api/v1/kennzahlen/paare?rechenform=&einheit=&standort_id=` (alle Filter optional). */
export interface KennzahlPaare {
  gruppen: KennzahlPaarGruppe[];
}

/** Der geschlossene Satz der Ablehnungen (`schnittstelle.ablehnungen`); der Satz steht in `message`. */
export type KennzahlFehlerCode =
  | 'anfrage_ungueltig' | 'kennzeichen_format' | 'recht_fehlt' | 'nicht_gefunden' | 'kennzeichen_belegt'
  | 'archiviert' | 'hat_werte' | 'wird_gelesen' | 'periode_passt_nicht' | 'einheit_unpassend' | 'groesse_unbekannt'
  | 'eingang_ausserhalb_geltung' | 'formel_zyklus' | 'fassung_ueberlappt' | 'geltung_unbekannt' | 'eingang_unbekannt'
  | 'rechenform_unbekannt';

// ---- Werte einer Kennzahl (UEMS AP-11 IP-7) ---------------------------------
// Die Formen von GET /api/v1/kennzahlen/{id}/werte und …/werte/versionen (OpenAPI `KennzahlWerte`,
// `KennzahlWerteHistorie`). Beträge sind DEZIMALTEXT und ungerundet — gerundet wird nur in der Anzeige (U4).

export type KennzahlZustand = 'vollständig' | 'unvollständig' | 'keine Werte' | 'mit Ersatzwert';
export type KennzahlRichtung = 'untergrenze' | 'obergrenze' | 'unbestimmt';
/** `grund_ohne_zahl` des Vertrags — ohne die zwei Gründe des Lesers. */
export type KennzahlGrundOhneZahl =
  | 'nenner_fehlt' | 'nenner_null' | 'zaehler_fehlt' | 'periode_nicht_zu_ende' | 'vor_bestehen' | 'haengt_an_kreis'
  | 'eingang_archiviert';
/** Warum ein Schritt keine Zahl trägt: ein Wort der Zeile oder eines des Lesers (dieselben wie am Messstellen-Wert). */
export type KennzahlWertGrund = KennzahlGrundOhneZahl | 'noch_nicht_gebildet' | 'version_nicht_gespeichert';

/** Ein Eingang im Herkunfts-Satz (`kennzahlwert-herkunft.schema.json` → `$defs/eingang`), wie er beim Bilden stand. */
export interface KennzahlwertHerkunftEingang {
  rolle: 'zaehler' | 'nenner' | 'paar';
  art: 'messstelle' | 'bezugsgroesse' | 'kennzahl';
  /** Das Kennzeichen des Eingangs (MS-12, BZ-6, KZ-0001) — beim Stammdatum seine Bezeichnung. */
  objekt: string;
  wert: string | null;
  /** Nur bei `paar`. */
  zaehler: string | null;
  nenner: string | null;
  einheit: string;
  zustand: KennzahlZustand;
  abdeckung_prozent: string | null;
  /** Messstelle und Kennzahl. */
  version: number | null;
  /** Bezugsgröße mit Periodenwert; ein Stammdatum hat keine. */
  fassung: number | null;
  kennzeichen: string[];
}

/** Die Hülle `{satz, fehlt}` eines Kennzahl-Werts — nie eine halbe Herkunft: ohne Satz nennt `fehlt` jede Lücke. */
export interface KennzahlwertHerkunft {
  satz: {
    art: 'kennzahl';
    kennzahl: string;
    rechenform: KennzahlRechenform;
    definition_fassung: number;
    periode: { art: KennzahlPeriodeArt; schluessel: string };
    berechnet_am: string;
    version: number;
    anlass: string | null;
    eingaenge: KennzahlwertHerkunftEingang[];
    ergebnis: {
      wert: string | null;
      einheit: string;
      zustand: KennzahlZustand;
      richtung: KennzahlRichtung | null;
      grund: KennzahlGrundOhneZahl | null;
      abdeckung_prozent: string | null;
      kennzeichen: string[];
    };
  } | null;
  fehlt: Array<'kennzahl' | 'definition_fassung' | 'berechnet_am' | 'eingaenge' | 'anlass'>;
}

/** Eine Periode einer Kennzahl — die Trägerform des Messstellen-Werts mit Wert, Zähler und Nenner. */
export interface KennzahlWert {
  von: string;
  /** Der LETZTE Tag der Periode, einschließlich. */
  bis: string;
  /** 2026-10-05 · 2026-W40 · 2026-10 · 2026. */
  schluessel: string;
  /** „05.10.2026“ · „KW 40/2026“ · „Oktober 2026“ · „2026“. */
  beschriftung: string;
  /** Dezimaltext, ungerundet; `null` = keine Zahl, nie 0. Ein Anteil in Prozent. */
  wert: string | null;
  zaehler: string | null;
  nenner: string | null;
  /** Die Einheit der Fassung, mit der der Wert gebildet wurde. */
  einheit: string | null;
  /** `null` nur ohne Zeile oder ohne die angefragte Version — dann steht `grund`. */
  zustand: KennzahlZustand | null;
  richtung: KennzahlRichtung | null;
  kennzeichen: string[];
  abdeckung_prozent: string | null;
  fassung: 'vorlaeufig' | 'endgueltig' | null;
  endgueltig_ab: string | null;
  /** Die Version, deren Zahl der Schritt zeigt; `null` = noch keine. */
  version: number | null;
  /** Die Fassung der Berechnung am letzten Tag der Periode. */
  definition_fassung: number | null;
  berechnet_am: string | null;
  grund: KennzahlWertGrund | null;
  /** An jeder Version, auch ohne Zahl; `null` ohne Zeile oder ohne Version. */
  herkunft: KennzahlwertHerkunft | null;
  /** Ab 2 gibt es eine Historie unter `…/werte/versionen`; `null`, solange keine gebildet ist. */
  versionen: number | null;
}

export interface KennzahlWerte {
  kennzahl: {
    id: string;
    kennzeichen: string;
    name: string;
    rechenform: KennzahlRechenform;
    einheit: string | null;
    einheit_anzeige: string | null;
  };
  periode: KennzahlPeriodeArt;
  von: string;
  bis: string;
  zeitzone: string;
  /** Die angefragte Version; `null` = je Schritt die neueste. */
  version: number | null;
  werte: KennzahlWert[];
}

/** Eine Entscheidung hinter einer Version — die Form der Messstelle mit dem weiteren Vorgang `berechnung`. */
export interface KennzahlWertEntscheidung extends Omit<MessstelleWerteEntscheidung, 'vorgang' | 'fassung'> {
  vorgang: MessstelleWerteEntscheidung['vorgang'] | 'berechnung';
  /** `null`, wenn die Fassung des genannten Vorgangs nicht lesbar ist (`fehlt` nennt `fassung`). */
  fassung: number | null;
}

export interface KennzahlWertVersion {
  version: number;
  /** Version n − 1; an Version 1 `null`. */
  wert_alt: KennzahlWert | null;
  wert_neu: KennzahlWert;
  gebildet_am: string;
  nachgezogen_am: string | null;
  anlass: { art: 'eingang' | 'definition'; beleg: string } | null;
  entscheidungen: KennzahlWertEntscheidung[];
}

export interface KennzahlWerteHistorie {
  kennzahl: KennzahlWerte['kennzahl'];
  periode: KennzahlPeriodeArt;
  von: string;
  bis: string;
  zeitzone: string;
  /** Nur ohne Version: warum die Periode keine hat. */
  grund: KennzahlWertGrund | null;
  /** Aufsteigend: Version 1 zuerst. */
  versionen: KennzahlWertVersion[];
}

// Die Formen der Berichts-Routen (UEMS AP-12 IP-7, OpenAPI Tag `berichte`) — snake_case wie der Bericht-Vertrag,
// streng: jedes Feld ist da, `null` heißt „gibt es nicht“. Zeitpunkte UTC; die Fakten einer Ablehnung in der Zone
// der Geltung. Rechte (E12): 403 `recht_fehlt`, fremd 404 `nicht_gefunden` — die Unterstützung liest keinen Bericht.

/** R5 — der Vermerk eines Berichts als Wort; der Kundensatz steht in `stand_text`. */
export type BerichtStandZeichen = 'entwurf' | 'berichtsstand' | 'revision_noetig' | 'anstoss_verworfen';
export type BerichtAnstossArt =
  | 'korrektur_freigegeben'
  | 'korrektur_zurueckgenommen'
  | 'ersatzwert_wirksam'
  | 'ersatzwert_zurueckgenommen'
  | 'bezugsgroesse_fassung'
  | 'kennzahl_fassung_rueckwirkend'
  | 'zuordnung_rueckwirkend'
  | 'anlage_umzug_rueckwirkend'
  | 'flaeche_rueckwirkend'
  | 'verteilung_rueckwirkend';
/** Der geschlossene Satz der Ablehnungen (`uems/BerichtAbgelehnt`, OpenAPI `BerichtFehler`). */
export type BerichtFehlerCode =
  | 'anfrage_ungueltig'
  | 'nicht_gefunden'
  | 'recht_fehlt'
  | 'vorlage_unbekannt'
  | 'geltung_unbekannt'
  | 'bericht_gibt_es_schon'
  | 'keine_quellen'
  | 'zeitraum_nicht_zu_ende'
  | 'werte_vorlaeufig'
  | 'entwurf_veraltet'
  | 'stand_gibt_es_nicht'
  | 'abzug_beschaedigt'
  | 'begruendung_fehlt'
  | 'anstoss_nicht_offen'
  | 'gleichzeitig';

/** Wer etwas tat: der Name und — wo gespeichert — die Rolle, die das Recht gab. */
export interface BerichtPerson {
  name: string;
  rolle: string | null;
}

/** Ein Bericht in der Liste und im Kopf. */
export interface Bericht {
  kennung: string;
  vorlage: string;
  vorlage_fassung: number;
  geltung_art: 'standort' | 'unternehmen';
  geltung_id: string;
  geltung_name: string | null;
  zeitraum_art: 'monat' | 'jahr';
  zeitraum: string;
  zeitraum_text: string;
  zeitzone: string;
  angelegt_von: BerichtPerson;
  angelegt_am: string;
  archiviert_am: string | null;
  stand_zeichen: BerichtStandZeichen;
  stand_text: string | null;
  neueste_nr: number | null;
  entwurf_datenstand: string | null;
}

/** Der Körper von `POST /api/v1/berichte` (streng gelesen). */
export interface BerichtAnlegen {
  vorlage: string;
  geltung_id: string;
  zeitraum: string;
  /** AP-12 IP-14 (V3, Q4): die abgewählten Kennzahlen (IDs) — fehlt das Feld, sind alle gewählt. */
  kennzahlen_abgewaehlt?: string[];
}

/** Ein Berichtsstand im Verlauf — ohne Abzug. */
export interface BerichtStandKurz {
  nr: number;
  datenstand: string;
  freigegeben_am: string;
  freigegeben_von: BerichtPerson;
  pruefsumme: string;
  ersetzt_durch_nr: number | null;
  anlass_anstoss_id: string | null;
}

/** Ein Revisions-Anstoß an Stand `nr` (R1–R4). */
export interface BerichtAnstoss {
  id: string;
  nr: number;
  art: BerichtAnstossArt;
  anlass_kennung: string;
  anlass_fassung: number | null;
  anlass_text: string;
  erkannt_am: string;
  zustand: 'offen' | 'erledigt' | 'verworfen';
  erledigt_durch_nr: number | null;
  verworfen_begruendung: string | null;
  verworfen_von: BerichtPerson | null;
  verworfen_am: string | null;
}

export interface BerichtDetail {
  bericht: Bericht;
  staende: BerichtStandKurz[];
  anstoesse: BerichtAnstoss[];
}

/** Ein Abzug: `docs/contracts/v2/bericht.schema.json` `$defs/abzug` — gelesen über `uemsBericht.ts`. */
export type BerichtAbzug = Record<string, unknown>;

/** Die Strukturänderung, nach deren Folgen für freigegebene Berichte `GET /api/v1/berichte/betroffen` fragt (AP-12 IP-9). */
export type BerichtStrukturAnlass =
  | 'flaeche_rueckwirkend'
  | 'zuordnung_rueckwirkend'
  | 'anlage_umzug_rueckwirkend'
  | 'verteilung_rueckwirkend';

/** Ein Berichtsstand, genannt über die Kennung des Berichts und seine Nr. */
export interface BerichtStandRef {
  kennung: string;
  nr: number;
}

/** `GET /api/v1/berichte/betroffen` — welche freigegebenen Berichtsstände eine Strukturänderung träfe (AP-12 IP-9). */
export interface BerichteBetroffen {
  anlass: BerichtStrukturAnlass;
  gilt_ab: string;
  /** Es gibt im Unternehmen mindestens einen Bericht, den die Person lesen darf. */
  berichte_vorhanden: boolean;
  /** Gültige (nicht ersetzte) Berichtsstände, die mit Wirkung ab `gilt_ab` einen Revisions-Anstoß bekämen. */
  betroffen: BerichtStandRef[];
  /** Alle freigegebenen Berichtsstände (auch ersetzte), die eine Quelle des Objekts zitieren — ohne Zeitschnitt. */
  zitieren: BerichtStandRef[];
}

/** `GET …/entwurf` nach der D4-Prüfung; `neu_gebildet` = dieser Abruf hat ihn neu gebildet. */
export interface BerichtEntwurf {
  kennung: string;
  datenstand: string;
  gebildet_von: 'anlegen' | 'abruf' | 'kaskade' | 'struktur';
  neu_gebildet: boolean;
  pruefsumme: string;
  kopf: string;
  teilansicht: string[] | null;
  abzug: BerichtAbzug;
}

/** Eine Abweichung zwischen Stand und Entwurf (R1); Zahlen als Dezimaltext. */
export interface BerichtAbweichung {
  quelle: string;
  menge_art: string | null;
  vorher: string | null;
  nachher: string | null;
  version: string;
  anlass: string | null;
}

export interface BerichtVergleich {
  kennung: string;
  gegen: number;
  entwurf_datenstand: string;
  abweichungen: BerichtAbweichung[];
}

/** Ein freigegebener Berichtsstand — die Prüfsumme hat der Server geprüft (`pruefsumme_geprueft` ist immer true). */
export interface BerichtStand {
  kennung: string;
  nr: number;
  datenstand: string;
  freigegeben_am: string;
  freigegeben_von: BerichtPerson;
  pruefsumme: string;
  pruefsumme_geprueft: true;
  ersetzt_durch_nr: number | null;
  anlass_anstoss_id: string | null;
  vorlage_fassung: number;
  kopf: string;
  teilansicht: string[] | null;
  darstellung: Record<string, unknown>;
  regelwerk: Record<string, unknown>;
  abzug: BerichtAbzug;
}

/** Wer eine Fassung eingetragen oder freigegeben hat. */
export interface BezugsgroessePerson {
  name: string;
  rolle: string | null;
  art: 'kunde' | 'unterstuetzung' | 'voltpilot' | 'notfall';
}

/** Eine Fassung eines Werts mit ihrer Herkunft; `stand` ist null, solange `stand_offen`. */
export interface BezugsgroesseFassung {
  kanal?: { entity_id: string; kanal: string; regel: string; zustand: string; abdeckung_prozent: number; vorlaeufig: boolean; bindungen?: { kanal: string; regel?: string }[] };
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
  vorschlag?: { kennung: string; betrag: string; ersetzt_fassung: number; begruendung: string; urheber: BezugsgroessePerson; eingetragen_am: string } | null;
}

export interface BezugswertAntwort {
  urteil: string; satz: string; kennung: string | null;
  hinweise: { code: string; satz: string }[]; wert: BezugsgroesseWert;
}
export interface Ablesung {
  quelle: string; zeitpunkt: string; fassung: number; stand: number; monat: string | null;
  woher: string; urheber: { name: string; rolle: string | null }; korrektur: string | null; eingetragen_am: string;
}
export interface AblesungAntwort {
  urteil: string; korrektur: string | null; ablesung: Ablesung;
  ablesezeitraum: { menge: number | null; zustand: string; kennzeichen: string } | null;
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

/** Der Zeitraum der Kostenstellen-Sicht (AP-10 IP-11): der Tag, Monat oder das Jahr, das `am` enthält. */
export type KostenstelleEnergiePeriode = 'tag' | 'monat' | 'jahr';

/** Eine Summe JE Größe/Richtung/Einheit eines Blocks (`KostenstelleEnergieDto.Summe`, snake_case). */
export interface KostenstelleEnergieSumme {
  groesse: string;
  richtung: string;
  einheit: string;
  menge: number | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  vorhanden: number;
  gesamt: number;
  fehlend: string[];
}

/** Ein Tagesanteil eines Postens: der Anteil DIESES Tages (`null` = an dem Tag kein Anteil). */
export interface KostenstelleEnergieTag {
  tag: string;
  anteil_prozent: number | null;
  quelle_menge: number | null;
  menge: number | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  version: number;
  grund: string | null;
  herkunft: { satz: Record<string, unknown> | null; fehlt: string[] } | null;
}

/** Eine Messstelle in einem Block; `kennzeichen` sind die Sätze der Route („verteilt (30 % von MS-07)“). */
export interface KostenstelleEnergiePosten {
  messstelle: { id: string; kennzeichen: string; name: string | null; art: 'gemessen' | 'berechnet' };
  groesse: string;
  richtung: string;
  einheit: string;
  menge: number | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
  fassungen: number[];
  fehlend: string[];
  tage: KostenstelleEnergieTag[];
  /** Art `verteilt`; bei „nicht verteilt“ `null`. */
  herkunft: { satz: Record<string, unknown> | null; fehlt: string[] } | null;
}

/**
 * Ein Block der Sicht (gemessen · verteilt · berechnet · Summe · nicht verteilt): `menge`/`einheit`/`zustand` nur bei
 * GENAU einer Größe; `grund` `keine_zuordnung` (keine Posten) oder `groessen_gemischt` (je Größe eine `summen`-Zeile).
 */
export interface KostenstelleEnergieBlock {
  menge: number | null;
  einheit: string | null;
  zustand: string | null;
  grund: 'keine_zuordnung' | 'groessen_gemischt' | null;
  summen: KostenstelleEnergieSumme[];
  posten: KostenstelleEnergiePosten[];
}

/** Ein Posten, der an diesen Tagen bereits in einem anderen enthalten ist — `satz` aus `verteilung-vectors.json`. */
export interface KostenstelleDoppeltEnthalten {
  teil: string;
  summe: string;
  umfang: 'ganz' | 'teilweise';
  kette: string[];
  zeitraeume: { von: string; bis: string }[];
  satz: string;
}

/** Ein Posten, dessen Formel im Kreis führt — nicht prüfbar, mit Satz. */
export interface KostenstelleNichtPruefbar {
  messstelle: string;
  grund: 'formel_kreis' | 'haengt_an_kreis';
  kette: string[];
  satz: string;
}

/**
 * Die Antwort von `GET /api/v1/unternehmen/kostenstellen/{id}/energie?periode=&am=&version=` (UEMS AP-10 IP-11,
 * `KostenstelleEnergieDto.Energie`). „Nicht verteilt“ gehört keiner Kostenstelle und zählt in `summe` nie mit — es steht
 * in JEDER Antwort des Kundenbereichs gleich. `doppelzaehlung` ist eine Warnung neben den Blöcken und ändert keine Zahl.
 */
export interface KostenstelleEnergie {
  kostenstelle: { id: string; kennzeichen: string; name: string; gueltig_ab: string; gueltig_bis: string | null };
  periode: KostenstelleEnergiePeriode;
  am: string;
  von: string;
  bis: string;
  zeitzone: string;
  version: number | null;
  berechnet_am: string;
  gemessen: KostenstelleEnergieBlock;
  verteilt: KostenstelleEnergieBlock;
  berechnet: KostenstelleEnergieBlock;
  summe: KostenstelleEnergieBlock;
  nicht_verteilt: KostenstelleEnergieBlock;
  doppelzaehlung: { enthalten: KostenstelleDoppeltEnthalten[]; nicht_pruefbar: KostenstelleNichtPruefbar[] };
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

/** Eine Messstelle, auf die die Bilanz zeigt (AP-10 IP-9). */
export interface BilanzMessstelleRef {
  id: string;
  kennzeichen: string;
  name: string | null;
}

/** Die Summe einer Rolle: „mindestens …“ (`anzeige`) und `mit_werten` von `gesamt`; `menge` ungerundet, null nie 0. */
export interface BilanzSumme {
  menge: number | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  mit_werten: number;
  gesamt: number;
  fehlend: string[];
  kennzeichen: string[];
  anzeige: string | null;
}

/** Der Rest (fest Wirkenergie · Bezug): „10 kWh sind keiner Messstelle zugeordnet“ — nie „Verlust“. */
export interface BilanzRest {
  menge: number | null;
  groesse: string;
  richtung: string;
  einheit: string;
  zustand: string;
  abdeckung_prozent: number | null;
  fehlend: string[];
  kennzeichen: string[];
  kundensatz: string | null;
  /** AP-10 IP-12: die Hülle `{satz, fehlt}` nach `bilanzwert-herkunft.schema.json` (Art `berechnet`, Typ `rest`). */
  herkunft?: { satz: Record<string, unknown> | null; fehlt: string[] } | null;
}

export interface BilanzEingang {
  messstelle: string;
  rolle: 'zufluss' | 'abfluss' | 'zugeordnet';
  anteil: 'gesamt' | 'positiv' | 'negativ';
  menge: number | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
  grund: string | null;
}

export interface BilanzWerte {
  von: string;
  bis: string;
  zufluss: BilanzSumme;
  abfluss: BilanzSumme;
  zugeordnet: BilanzSumme;
  rest: BilanzRest;
  eingaenge: BilanzEingang[];
}

/** Tage mit denselben Termen aus der Stellung (E3); `raster` `tag`, wenn die Stellung in der Periode wechselt. */
export interface BilanzAbschnitt {
  von: string;
  bis: string;
  raster: 'tag' | 'monat' | 'jahr';
  terme: Array<{
    messstelle: string;
    messstelle_id: string | null;
    name: string | null;
    rolle: 'zufluss' | 'abfluss' | 'zugeordnet';
    anteil: 'gesamt' | 'positiv' | 'negativ';
  }>;
  ausserhalb: string[];
  werte: BilanzWerte[];
}

/** Der Rest JETZT in kW (F18): `wert` null, sobald ein Term fehlt oder veraltet ist — nie 0. */
export interface BilanzLive {
  wert: number | null;
  einheit: string;
  unvollstaendig: boolean;
  fehlende: Array<{ term: string; grund: 'kein_geraet' | 'kein_wert' | 'veraltet' }>;
  stand: string | null;
}

export interface BilanzHauptzaehler {
  messstelle: BilanzMessstelleRef;
  rest_messstelle: BilanzMessstelleRef | null;
  /** E18: „Rest anlegen“ — nur ohne Rest-Messstelle. */
  vorschlag: { aktion: 'rest_anlegen'; hauptzaehler_id: string; name: string } | null;
  stellung_geaendert: boolean;
  abschnitte: BilanzAbschnitt[];
  live: BilanzLive;
}

/** Die Antwort von `GET /api/v1/sites/{id}/bilanz?periode=&am=` (AP-10 IP-9). */
export interface Bilanz {
  anlage: { id: string; name: string };
  periode: 'tag' | 'monat' | 'jahr';
  am: string;
  von: string;
  bis: string;
  zeitzone: string;
  hauptzaehler: BilanzHauptzaehler[];
}

/** `POST /api/v1/sites/{id}/bilanz/rest`: `neu` = false, wenn der Hauptzähler schon einen Rest hatte. */
export interface BilanzRestAngelegt {
  neu: boolean;
  hauptzaehler: BilanzMessstelleRef;
  messstelle: Messstelle;
}

/** Die Ablehnungen der Bilanz-Schnittstelle (`uems/BilanzAbgelehnt`, OpenAPI `BilanzFehler`). */
export type BilanzFehlerCode = 'anfrage_ungueltig' | 'rest_ohne_hauptzaehler';

/**
 * Eine Bezugsfläche aus der Ortsstruktur als Bezugsgröße (AP-09 IP-6, E17): GELESEN aus
 * `flaeche_gueltigkeit`, ohne ID und Kennzeichen einer Bezugsgröße. `schreibbar` ist immer
 * false — geändert wird sie am Gebäude; `pflegen` sagt es in Kundensprache.
 */
export interface Bezugsflaeche {
  name: string;
  wertart: 'stammdatum';
  einheit: 'm²';
  herkunft_art: 'stammdatum_ap02';
  geltung_art: 'standort' | 'gebaeude' | 'bereich';
  geltung_id: string;
  geltung_kennzeichen: string | null;
  geltung_name: string;
  schreibbar: false;
  pflegen: string;
}

/**
 * Der Wert eines Stammdatums für EINE Periode am Stichtag = ihrem letzten Tag (E17).
 * `betrag` null heißt „nicht erhoben“, nie 0; `kennzeichen` nennt jeden Übergang in der Periode (S3).
 */
export interface BezugsgroesseStichtagwert {
  periode: string;
  von: string;
  stichtag: string;
  betrag: string | null;
  quelle: 'eigen' | 'aus_gebaeuden_summiert' | null;
  gilt_ab: string | null;
  eingetragen_am: string | null;
  abzeichen: string | null;
  kennzeichen: string[];
}

/** Die Antwort von `GET /api/v1/bezugsflaechen?periode_art&von&bis`. */
export interface Bezugsflaechen {
  periode_art: 'tag' | 'woche' | 'monat' | 'jahr';
  von: string;
  bis: string;
  bezugsflaechen: { bezugsflaeche: Bezugsflaeche; perioden: BezugsgroesseStichtagwert[] }[];
}

/** Die Antwort von `GET/PUT /api/v1/bezugsgroessen/{id}/stammdatum` (E15). */
export interface BezugsgroesseStammdatum {
  bezugsgroesse_id: string;
  kennzeichen: string;
  name: string;
  einheit: string;
  zeitzone: string;
  schreibbar: boolean;
  intervalle: {
    wert: string;
    gueltig_ab: string;
    gueltig_bis: string | null;
    aufgehoben_am: string | null;
    eingetragen_am: string;
    abzeichen: string | null;
  }[];
  periode_art: 'tag' | 'woche' | 'monat' | 'jahr' | null;
  von: string | null;
  bis: string | null;
  perioden: BezugsgroesseStichtagwert[];
}

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
 * Ein zugeordneter Rollen-Wert (`RollenDto.Wert`, PR 758): ENTWEDER ein Messwert-
 * Kanal (`art = messkanal`, `capability`) ODER ein Gesamtwert (`art = gesamtwert`,
 * `quell_messstelle_id`). `name` ist der Anzeigename des Werts. snake_case wie am
 * Vertrag (`@JsonNaming`).
 */
export interface RollenWert {
  art: 'messkanal' | 'gesamtwert';
  capability: string | null;
  quell_messstelle_id: string | null;
  name: string | null;
}

/**
 * Der maßgebliche Rollen-Wert EINES Geräts (`GET …/komponenten/{entityId}/rollen/{role}`,
 * `RollenDto.GeraetRolle`). `zugeordnet == null` heißt: keine Zuordnung, das Cockpit
 * bleibt beim Rückfall auf die Roh-Telemetrie.
 */
export interface GeraetRolle {
  entity_id: string;
  role: string;
  zugeordnet: RollenWert | null;
}

/** Der Anfrage-Körper von `PUT …/komponenten/{entityId}/rollen/{role}` (`RollenDto.Eingabe`). */
export interface RollenEingabe {
  art: 'messkanal' | 'gesamtwert';
  capability?: string;
  quell_messstelle_id?: string;
}

/**
 * Die Antwort eines Zuordnens (`RollenDto.ZuordnungAntwort`): der jetzt maßgebliche Wert
 * und - beim Konfliktfall - der abgelöste vorige Wert (`abgeloest == null`, wenn keiner
 * abgelöst wurde).
 */
export interface RollenZuordnungAntwort {
  zugeordnet: RollenWert;
  abgeloest: RollenWert | null;
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

/**
 * Das additive Feld `teilansicht` der Flotten-Antworten (UEMS AP-03 IP-10, Regel R-A2):
 * über wie viele Standorte die Antwort gebildet wurde und wie viele der Kundenbereich hat.
 *
 * `gesamt` ist eine ANZAHL von Standorten — keine Energie- und keine Geldsumme. Jede Liste
 * und jede Summe der Antwort entsteht ausschliesslich über die `sichtbar` Standorte; das
 * Portal rechnet nie selbst über Standorte hinweg, sondern nur über das, was es bekommt.
 * Der Satz „Teilansicht: n von m Standorten" kommt fertig aus `GET /api/v1/me`
 * (`teilansicht.kopfzeile`); dieses Feld sagt je Antwort, worüber sie gebildet wurde.
 */
export interface SichtbareListe<T> {
  eintraege: T[];
  teilansicht: Teilansicht;
}

export interface Teilansicht {
  sichtbar: number;
  gesamt: number;
}

export interface Overview {
  sites: OverviewSite[];
  totals: OverviewTotals;
  dailySavings: OverviewDailySavings[];
  /** Additiv (AP-03 IP-10); absent auf einem älteren Backend. */
  teilansicht?: Teilansicht;
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
  /** IP-6: Bindung am Stichtag, auch wenn die Anlage inzwischen den Standort gewechselt hat. */
  netzanschluss?: { id: string; kennzeichen: string; gueltigAb: string; gueltigBis: string | null } | null;
  gueltigAb: string;
  gueltigBis: string | null;
}

/** AP-10 IP-6: Tage einschließlich Endtag; Preise bleiben an der Anlage. */
export interface NetzanschlussAnfrage {
  kennzeichen: string | null; name: string; malo: string | null; netzbetreiber: string | null;
  anschluss_kva: string | number | null; vereinbart_kw: string | number | null;
  messung: 'RLM' | 'SLP'; gueltig_ab: string | null; gueltig_bis: string | null;
}
export interface NetzanschlussBindung {
  id: string; anlage: { id: string; name: string | null }; gueltig_ab: string; gueltig_bis: string | null;
}
export interface Netzanschluss extends NetzanschlussAnfrage {
  id: string; kennzeichen: string; standort: { id: string; kurzzeichen: string };
  hinweise: string[]; anlagen: NetzanschlussBindung[]; angelegt_am: string;
}
export interface Netzanschluesse {
  standort: { id: string; kurzzeichen: string }; stichtag: string | null;
  kennzeichen_vorschlag: string; netzanschluesse: Netzanschluss[];
}
export interface NetzanschlussVorschlag {
  anlage_id: string; anlage_name: string; bindung_ab: string; kennzeichen: string; name: string;
}
export interface NetzanschlussUebernehmen extends NetzanschlussAnfrage { bindung_ab: string; grund: string | null }
export interface NetzanschlussBinden { anlage_id: string; gueltig_ab: string; grund: string | null }

// ---- UEMS AP-02 IP-11: Anlage einem Standort zuordnen oder umziehen

/** Rumpf von `PUT /api/v1/sites/{id}/standort`; `gueltigAb` fehlend = heute am Ziel. */
export interface AnlageUmzugAnfrage {
  standortId: string;
  gueltigAb?: string;
  begruendung?: string;
}

export interface AnlageUmzugStandort {
  id: string;
  kurzzeichen: string | null;
  name: string | null;
}

/** Was eine Zuordnung nie berührt — die Codes des Servers in der Reihenfolge der Folgen-Karte. */
export type AnlageUmzugBleibt =
  | 'box'
  | 'topics'
  | 'freigaben'
  | 'betriebsmodell'
  | 'ladepark_rahmen'
  | 'fahrplaene'
  | 'messstellen';

/**
 * Vorschau (`GET …/standort/vorschau`) und Eintrag (`PUT …/standort`) antworten gleich: was die
 * Zuordnung bewirkt. `protokoll` ist in der Vorschau leer, `befehle` immer 0.
 */
export interface AnlageUmzug {
  anlageId: string;
  anlageName: string;
  /** Der Standort am „gültig ab“ ohne die Zuordnung; `null` = noch keiner. */
  bisher: AnlageUmzugStandort | null;
  neu: AnlageUmzugStandort;
  gueltigAb: string;
  /** Das Ende der neuen Zuordnung, von der laufenden geerbt; `null` = offen. */
  gueltigBis: string | null;
  /** Die schon geplante Zuordnung ab dem Tag nach `gueltigBis`. */
  danach: AnlageUmzugStandort | null;
  rueckwirkung: OrtRueckwirkung;
  zuordnungen: {
    standort: AnlageUmzugStandort;
    gueltigAb: string;
    gueltigBis: string | null;
    zustand: 'gueltig' | 'geplant' | 'beendet' | 'aufgehoben';
  }[];
  bleibt: AnlageUmzugBleibt[];
  boxen: number;
  netzanschluss: { id: string; kennzeichen: string } | null;
  steuern: { funktion: 'messen' | 'steuern'; zustand: string; standort: AnlageUmzugStandort } | null;
  befehle: number;
  begruendung: string | null;
  protokoll: { id: number; objektArt: 'anlage' | 'standort'; objektId: string }[];
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
  /** Additiv (AP-03 IP-10); absent auf einem älteren Backend. */
  teilansicht?: Teilansicht;
}

/** GET /api/v1/standorte/{id}/versorgung?stichtag= — F15, reine Sicht aus Ort × Stellung. */
export interface Versorgung {
  stichtag: string;
  standort: VersorgungBezug;
  gebaeude: GebaeudeVersorgung[];
  ausserhalbGebaeude: VersorgungAusserhalb[];
}

export interface VersorgungBezug {
  id: string;
  kennzeichen: string;
  name: string;
}

export interface VersorgungAnlage {
  id: string;
  name: string;
  netzanschlussKennzeichen: string | null;
}

export interface VersorgungMessstelle {
  kennzeichen: string;
  name: string | null;
}

export interface GebaeudeVersorgung {
  gebaeude: VersorgungBezug;
  messbar: boolean;
  systeme: { anlage: VersorgungAnlage; messstellen: VersorgungMessstelle[] }[];
}

export interface VersorgungAusserhalb {
  messstelle: VersorgungMessstelle;
  anlage: VersorgungAnlage;
}

/** Rein lesende Vorschau der Bestandsanlagen-Zuordnung (AP-02 IP-10). */
export interface StandortZuordnungAnlage {
  vorschlagId: string;
  anlageId: string;
  anlageName: string;
  gueltigAb: string;
}
export interface StandortZuordnungGruppe {
  name: string;
  zeitzone: string;
  adresse: StandortAdresse | null;
  anlagen: StandortZuordnungAnlage[];
}
export interface StandortZuordnungVorschau {
  gruppen: StandortZuordnungGruppe[];
  anlagenZahl: number;
}
export interface StandortZuordnungBestaetigen {
  gruppen: {
    name: string;
    zeitzone: string;
    adresse: StandortAdresse;
    vorschlagIds: string[];
  }[];
}
export interface StandortZuordnungErgebnis {
  standortIds: string[];
  zuordnungen: number;
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
    | 'gleiche_flaeche'
    // Löschen ohne Historie (IP-15)
    | 'loeschen_gesperrt'
    // Anlage zuordnen/umziehen (IP-11): die übrigen Gründe des Vertrags beim Eintrag.
    | 'vor_dem_ersten_intervall'
    | 'objekt_archiviert'
    | 'gleicher_tag'
    | 'ziel_ist_bisheriger_eltern';
  message: string;
  feld?: string;
  verweis?: OrtVerweis;
  archiviert_am?: string | null;
  grund?: 'nicht_archiviert' | 'eltern_archiviert' | 'name_belegt';
  gruende?: ArchivSperrgrund[];
  /** `loeschen_gesperrt`: was der Ort je getragen hat. */
  historie?: OrtLoeschGrund[];
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
  /** IP-12 (V4): wohin der Knoten nach `gueltigBis` zieht — „ab 01.03.2027 → Werk Ahrenberg Nord“; `null` ohne Ende. */
  danach?: OrtsbaumDanach | null;
  /** IP-15: was man heute mit dem Knoten tun kann; `null` mit Stichtag. */
  aktionen?: OrtAktionen | null;
}

/** IP-12 (V4): die schon eingetragene Zuordnung ab dem Tag nach `gueltigBis`. */
export interface OrtsbaumDanach {
  ab: string;
  elternId: string;
  elternArt: 'standort' | 'gebaeude';
  elternName: string | null;
  standortId: string | null;
  standortName: string | null;
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
  /** IP-15 (Z3): die am Stichtag archivierten Gebäude und Bereiche dieses Standorts. */
  archiviert?: OrtsbaumArchivierterOrt[];
  /** IP-15: was man heute mit dem Standort tun kann (nur `archivieren`); `null` mit Stichtag. */
  aktionen?: OrtAktionen | null;
}

/** IP-15: warum ein Ort nicht gelöscht wird (E1); `hat_bezugsgroessen` und `hat_kennzahlen` ergänzt die Datenbank. */
export type OrtLoeschGrund = 'hat_messstellen' | 'hat_anlagen' | 'hat_flaeche' | 'hat_kinder' | 'hat_bezugsgroessen' | 'hat_kennzahlen';

/**
 * IP-15: was man HEUTE mit einem Knoten tun kann, bevor jemand drückt — dieselben Urteile und
 * Sätze wie die Schreibrouten. Was nicht zum Knoten gehört, ist `null`.
 */
export interface OrtAktionen {
  archivieren: {
    erlaubt: boolean;
    /** Gesperrt: der Satz mit Grund und Weg (Z1). */
    text: string | null;
    gruende: ArchivSperrgrund[];
    /** Erlaubt: der letzte Tag der Zuordnung (gestern). */
    letzterTag: string | null;
    mitarchiviert: { id: string; art: 'gebaeude' | 'bereich'; kurzzeichen: string; name: string }[];
  } | null;
  wiederherstellen: {
    erlaubt: boolean;
    grund: 'nicht_archiviert' | 'eltern_archiviert' | 'name_belegt' | null;
    text: string | null;
    /** Der erste Tag des neuen Intervalls (heute). */
    ab: string;
  } | null;
  loeschen: { erlaubt: boolean; gruende: OrtLoeschGrund[]; text: string | null } | null;
  /** IP-12: nur an einem Gebäude oder Bereich, der heute im Baum steht. */
  verschieben?: OrtVerschiebenAktion | null;
}

/**
 * IP-12 (V1/V2): wohin der Knoten heute ziehen kann — jeder Knoten, der heute im Baum steht und als
 * Elternknoten erlaubt ist (nie ein Bereich), OHNE den bisherigen. Ob der Tag geht, urteilt die Vorschau.
 */
export interface OrtVerschiebenAktion {
  erlaubt: boolean;
  /** Ohne Ziel: warum nicht. */
  text: string | null;
  ziele: OrtVerschiebenZiel[];
}

export interface OrtVerschiebenZiel {
  id: string;
  art: 'standort' | 'gebaeude';
  kurzzeichen: string;
  name: string;
  /** Nur beim Gebäude. */
  standortName: string | null;
}

/** POST /api/v1/orte/{id}/verschieben */
export interface OrtVerschiebenAnfrage {
  zielId: string;
  gueltigAb?: string;
  begruendung?: string;
}

export interface OrtVerschiebungKnoten {
  id: string | null;
  art: 'unternehmen' | 'standort' | 'gebaeude' | 'bereich' | null;
  kurzzeichen: string | null;
  name: string | null;
}

/** Eine Messstelle mit dem Ort, an dem sie am „gültig ab“ hängt — das Verschieben ändert ihn nie. */
export interface OrtVerschiebungMessstelle {
  id: string | null;
  kennzeichen: string;
  name: string | null;
  ort: OrtVerschiebungKnoten | null;
}

/**
 * Vorschau (`GET …/verschieben/vorschau`) und Eintrag (`POST …/verschieben`) antworten gleich: was
 * das Verschieben bewirkt. `folgen` ist das Urteil des Vertrags (E11/A13), `protokoll` in der Vorschau
 * leer, `befehle` immer 0.
 */
export interface OrtVerschiebung {
  ortId: string;
  art: 'gebaeude' | 'bereich';
  kurzzeichen: string;
  name: string;
  /** Der Elternknoten am „gültig ab“ ohne das Verschieben. */
  bisher: OrtVerschiebungKnoten;
  bisherStandort: OrtVerschiebungKnoten | null;
  neu: OrtVerschiebungKnoten;
  neuStandort: OrtVerschiebungKnoten | null;
  gueltigAb: string;
  /** Von der laufenden Zuordnung geerbt; `null` = offen. */
  gueltigBis: string | null;
  /** Der Elternknoten der schon geplanten Zuordnung ab dem Tag nach `gueltigBis`. */
  danach: OrtVerschiebungKnoten | null;
  rueckwirkung: OrtRueckwirkung;
  /** Nur rückwirkend: die Tage, die nachträglich anders zählen. */
  rueckwirkendBetroffen: { von: string; bis: string } | null;
  zuordnungen: {
    eltern: OrtVerschiebungKnoten;
    gueltigAb: string;
    gueltigBis: string | null;
    zustand: 'gueltig' | 'geplant' | 'beendet' | 'aufgehoben';
  }[];
  folgen: {
    ziehenMit: OrtVerschiebungKnoten[];
    messstellenWechselnStandort: OrtVerschiebungMessstelle[];
    bleibenAnlagen: { id: string; name: string; standort: OrtVerschiebungKnoten | null }[];
    bleibenNetzanschluesse: { id: string | null; kennzeichen: string }[];
    bleibenMessstellen: OrtVerschiebungMessstelle[];
  };
  befehle: number;
  begruendung: string | null;
  protokoll: {
    id: number;
    objektArt: 'gebaeude' | 'bereich';
    objektId: string;
    text: string;
    giltAb: string;
    rueckwirkend: boolean;
    wer: string;
    eingetragenAm: string;
  }[];
}

/** IP-15 (Z3): ein am Stichtag archiviertes Gebäude oder ein archivierter Bereich. */
export interface OrtsbaumArchivierterOrt {
  id: string;
  art: 'gebaeude' | 'bereich';
  kurzzeichen: string;
  name: string;
  nutzung: Nutzung[] | null;
  /** Der Archivtag (ISO-Tag). */
  archiviertAm: string;
  /** Der Knoten, an dem der Ort zuletzt hing. */
  elternId: string;
  elternArt: 'standort' | 'gebaeude';
  aktionen: OrtAktionen | null;
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

// ---- Funktionen je Standort (UEMS AP-01 IP-3) --------------------------------

/**
 * `GET /api/v1/funktionen` (snake_case wie der Vertrag `funktion-zustand`): je nicht archiviertem
 * Standort beide Funktionen, dazu „läuft an x von y Standorten“. Zustände, Prüfungen und Aktionen
 * sind die Wörter von `uemsFunktion.ts`; jeder Satz kommt fertig vom Server. NUR Typen — die
 * Flächen sind AP-01 IP-5 bis IP-8.
 */
export interface Funktionen {
  unternehmen: FunktionUnternehmen;
  standorte: FunktionStandort[];
}

export interface FunktionUnternehmen {
  messen: FunktionVerbreitung;
  steuern: FunktionVerbreitung;
}

/** „Steuern & Optimieren läuft an 1 von 2 Standorten“; `text` null ohne Standort. */
export interface FunktionVerbreitung {
  laeuft_an: number;
  standorte: number;
  text: string | null;
}

export interface FunktionStandort {
  id: string;
  kurzzeichen: string;
  name: string;
  zeitzone: string;
  messen: FunktionMessen;
  steuern: FunktionSteuern;
}

export interface FunktionMessen {
  zustand: FunktionZustand;
  seit: string | null;
  text: string;
  fehlt: string[];
  datenlage: string | null;
}

/** Der höchste Zustand der Teilnahmen; `aktionen` = die Standort-Aktionen, die jetzt erlaubt wären. */
export interface FunktionSteuern {
  zustand: FunktionZustand;
  seit: string | null;
  text: string;
  fehlt: string[];
  aktionen: FunktionAktion[];
  anlagen: FunktionAnlage[];
}

export interface FunktionAnlage {
  id: string;
  name: string;
  teilnahme: FunktionTeilnahme;
}

/**
 * Die Teilnahme einer Anlage. `pruefliste` nur in entwurf, eingerichtet und angehalten;
 * `wege` je roter Zeile, was zu tun ist; ein Knopf nur für eine Aktion aus `aktionen` (R2).
 */
export interface FunktionTeilnahme {
  zustand: FunktionZustand;
  seit: string | null;
  text: string;
  uebernommen: boolean;
  pruefliste: FunktionPruefZeile[];
  fehlt: string[];
  wege: FunktionWeg[];
  aktionen: FunktionAktion[];
}

/** `bestanden: null` = nicht prüfbar, nie „bestanden“. */
export interface FunktionPruefZeile {
  pruefung: FunktionPruefung;
  bestanden: boolean | null;
}

export interface FunktionWeg {
  pruefung: FunktionPruefung;
  satz: string;
}

/** `PUT /api/v1/sites/{id}/funktionen/steuern` bzw. `/api/v1/standorte/{id}/funktionen/steuern`. */
export interface FunktionSteuernAnfrage {
  aktion: 'aufnehmen' | 'starten' | 'anhalten' | 'fortsetzen' | 'beenden';
}

export interface FunktionSteuernErgebnis {
  aktion: FunktionSteuernAnfrage['aktion'];
  betroffen: FunktionAnlageRef[];
  standort: FunktionStandort;
}

/** `GET /api/v1/sites/{id}/funktionen/steuern/pruefung` — frische Fakten für Schritt 5. */
export interface FunktionSteuernPruefung {
  anlage_id: string;
  anlage: string;
  standort_id: string;
  standort: string;
  bereit: boolean;
  zeilen: FunktionSteuernPruefZeile[];
  freigaben: FunktionFreigabeStand;
  folgen: string;
}

export interface FunktionFreigabeStand {
  freigegeben: number;
  gesamt: number;
  text: string;
  komponenten: FunktionFreigabeZeile[];
}

export interface FunktionFreigabeZeile {
  entity_id: string;
  name: string;
  weg: 'selbstbau' | 'ocpp' | 'wechselrichter';
  freigegeben: boolean;
  status: string;
  station_verbunden: boolean | null;
  steuerart_gesetzt: boolean | null;
}

export interface FunktionSteuernPruefZeile {
  pruefung: FunktionPruefung;
  bestanden: boolean | null;
  fakt: string;
  grund: string | null;
  weg: string | null;
}

export interface FunktionAnlageRef {
  id: string;
  name: string;
}

/** `PUT /api/v1/standorte/{id}/funktionen/messen` (AP-01 IP-9a) — „Messen & Auswerten“ im Entwurf anlegen. */
export interface FunktionMessenAnfrage {
  aktion: 'einrichten';
}

export interface FunktionMessenErgebnis {
  aktion: FunktionMessenAnfrage['aktion'];
  standort: FunktionStandort;
}

/** Die Ablehnungen der Funktions-Schnittstelle (`uems/FunktionAbgelehnt`, OpenAPI `FunktionFehler`). */
export type FunktionFehlerCode =
  | 'anfrage_ungueltig'
  | 'nicht_gefunden'
  | 'nicht_aufgenommen'
  | 'pruefliste_offen'
  | 'noch_nicht_gestartet'
  | 'laeuft_bereits'
  | 'ist_angehalten'
  | 'bereits_angehalten'
  | 'beendet'
  | 'bereits_angelegt'
  | 'standort_archiviert';

/** `{code, message, fehlt, wege}` — bei `pruefliste_offen` die roten Zeilen. */
export interface FunktionFehler {
  code: FunktionFehlerCode;
  message: string;
  fehlt: string[];
  wege: FunktionWeg[];
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

// ---- Messstellen-Dialog (UEMS AP-04 IP-6): anlegen und Quelle binden --------

/** Eine führende Quelle der Messstelle (IP-13), soweit der Dialog sie liest; Zeitpunkte mit Versatz. */
export interface MessstelleQuelleZeitraum {
  komponente: string;
  kanal: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/**
 * POST /api/v1/messstellen (IP-3) — `kennzeichen` fehlt = automatisch (der Zähler rückt nur dann
 * vor); Art, Medium und Hauptgröße sind danach nie mehr änderbar.
 */
export interface MessstelleAnlegen {
  kennzeichen?: string;
  name: string;
  art: 'gemessen';
  medium: string;
  hauptgroesse: MessstelleGroesse;
  nebengroessen: MessstelleGroesse[];
  notiz?: string;
}

/**
 * POST /api/v1/messstellen/{id}/quellen (IP-13) — ohne `groesse` die Hauptgröße, sonst Größe +
 * Richtung einer Nebengröße; `gueltig_ab` auf die Minute mit Versatz.
 *
 * `rolle: 'vergleich'` braucht IMMER einen `zweck` (E3); `anteil` liest nur einen Teil eines
 * Vorzeichen-Werts (AP-08 IP-7) — fehlend = der ganze Wert.
 */
export interface MessstelleQuelleBinden {
  groesse?: { groesse: string; richtung: string };
  komponente: string;
  kanal: string;
  rolle: 'fuehrend' | 'vergleich';
  zweck?: string;
  anteil?: 'positiv' | 'negativ';
  gueltig_ab: string;
}

// ---- Quelle binden (UEMS AP-04 IP-14): GET/POST …/quellen, PUT …/quellen/{qid}/beenden ------
// Die Formen von `GET /api/v1/messstellen/{id}/quellen?stichtag=` (OpenAPI `MessstelleQuellenListe`,
// snake_case wie das echte Backend). Je Größe der Stand zum Stichtag, dazu die ganze Historie.

/** Die drei Zwecke einer Vergleichsquelle (E3) — eine Vergleichsquelle gibt es nie ohne Zweck. */
export type MessstelleQuelleZweck = 'Plausibilität' | 'Ersatz bei Ausfall' | 'Abrechnungszähler';

/** Das Gerät des Messwerts: `geraet` das Kennzeichen (GR-4), `einbau` der Einbau (Z-5b). */
export interface MessstelleQuelleGeraet {
  id: string | null;
  geraet: string | null;
  einbau: string | null;
}

/** Ein abgelesener Zählerstand an einer Bindung. */
export interface MessstelleQuelleStand {
  wert: number | null;
  einheit: string | null;
}

/**
 * Eine Quellenbindung, wie sie gespeichert ist. `letzter_wert` trägt nur, was zum Stichtag GILT
 * (AP-04 IP-14, E3): so stehen der Wert der führenden und der der Vergleichsquelle nebeneinander,
 * beide nach derselben Regel gebildet. `null` heißt „nichts bekannt“, nie eine 0.
 */
export interface MessstelleQuelle {
  id: string;
  messstelle_id: string;
  groesse: string;
  richtung: string;
  rolle: 'fuehrend' | 'vergleich';
  zweck: string | null;
  komponente: string;
  komponente_name: string | null;
  anlage: string;
  kanal: string;
  /** Additiv (IP-14): der Anzeigename des Messwerts; `null`, wenn keiner bekannt ist. */
  kanal_name?: string | null;
  kanal_wertart: string;
  herleitung: 'zaehlerstand' | 'differenzen' | 'integration' | 'momentanwert';
  geraet: MessstelleQuelleGeraet;
  gueltig_ab: string;
  gueltig_bis: string | null;
  status: 'geplant' | 'gilt' | 'beendet';
  anfangsstand: MessstelleQuelleStand | null;
  endstand: MessstelleQuelleStand | null;
  rueckwirkend: boolean;
  herkunft: string | null;
  eingetragen_am: string;
  eingetragen_von: string;
  anteil: 'positiv' | 'negativ' | null;
  /** Additiv (IP-14): der letzte gute Wert DIESER Bindung — nur an einer, die zum Stichtag gilt. */
  letzter_wert?: MessstelleRegisterWert | null;
}

/** Ein Abschnitt des Zeitstrahls der führenden Quellen; `quelle === null` ist eine sichtbare Lücke. */
export interface MessstelleQuelleAbschnitt {
  von: string;
  bis: string | null;
  quelle: string | null;
}

/** Eine Größe der Messstelle zum Stichtag: ihre führende Quelle, die Vergleichsquellen, der Zeitstrahl. */
export interface MessstelleQuelleGroesse {
  groesse: string;
  richtung: string;
  einheit: string;
  wertart: string;
  hauptgroesse: boolean;
  lebenszyklus: string;
  fuehrend: MessstelleQuelle | null;
  vergleich: MessstelleQuelle[];
  zeitstrahl: MessstelleQuelleAbschnitt[];
}

export interface MessstelleQuellenListe {
  messstelle_id: string;
  kennzeichen: string;
  stichtag: string;
  /** Hauptgröße zuerst, dann die Nebengrößen. */
  groessen: MessstelleQuelleGroesse[];
  /** Die ganze Historie, beendete eingeschlossen. */
  quellen: MessstelleQuelle[];
}

/** Wie weit ein eingetragenes „gültig ab“ von jetzt entfernt ist (E2). */
export interface MessstelleQuelleRueckwirkung {
  art: 'rueckwirkend' | 'ab_jetzt' | 'angekuendigt';
  minuten: number;
  abzeichen: string | null;
}

/** Die Antwort auf Binden und Beenden; `beendet` ist die laufende Quelle, die die neue beendet hat. */
export interface MessstelleQuelleVorgang {
  quelle: MessstelleQuelle;
  beendet: MessstelleQuelle | null;
  rueckwirkung: MessstelleQuelleRueckwirkung;
  hinweise: string[];
}

/** PUT …/quellen/{qid}/beenden — ohne Inhalt endet die Quelle jetzt. Gelöscht wird nie. */
export interface MessstelleQuelleBeenden {
  gueltig_bis?: string;
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
 * über ihre führende Quelle — `null` nur bei einer BERECHNETEN Messstelle, nie geraten, nie eine 0;
 * deren Vollständigkeit steht in `berechnung` (AP-10 IP-9).
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
  berechnung: MessstelleRegisterBerechnung | null;
}

/** Nur berechnet (AP-10 IP-9): vollständig nur, wenn ALLE Eingänge der Formel des Tages liefern. */
export interface MessstelleRegisterBerechnung {
  zustand: 'vollstaendig' | 'unvollstaendig';
  fehlend: string[];
  seit: string | null;
  text: string;
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
 * Das Aggregat der Antwort: gezählt werden GENAU die gezeigten Zeilen (die Filter gelten also auch
 * hier); seit AP-10 IP-9 auch die berechneten (vollständig = liefert, ohne Formel im Nenner), eine
 * Zeile ohne Standort nur beim Unternehmen.
 */
export interface MessstelleRegisterAggregat {
  unternehmen: MessstelleRegisterAbdeckung;
  standorte: MessstelleRegisterStandortAbdeckung[];
}

/** Ein zeitgültiger Eintrag der Vertrags-Form: Tage bei Ort und Stellung, Zeitpunkte bei Quellen. */
interface MessstelleVertragsIntervall {
  gueltig_ab: string;
  gueltig_bis: string | null;
}

/**
 * Nur der Teil der Vertrags-Form (`MessstelleDto.Messstelle`, IP-3), den das Register im Portal
 * liest: ALLE wirksamen Intervalle (aufgehobene nicht) — daraus erkennt „Stand am …“, dass es eine
 * Messstelle an einem Tag noch nicht gab. Die übrigen Felder trägt die Antwort weiter.
 */
export interface MessstelleVertragsform {
  id: string;
  kennzeichen: string;
  orte: MessstelleVertragsIntervall[];
  elektrische_stellung: MessstelleVertragsIntervall[];
  fuehrende_quelle: MessstelleVertragsIntervall[];
  vergleichsquellen: MessstelleVertragsIntervall[];
  nebengroessen: { fuehrende_quelle: MessstelleVertragsIntervall[]; vergleichsquellen: MessstelleVertragsIntervall[] }[];
}

/** Die Filter von `GET /api/v1/messstellen` — ein leerer Filter wird nicht gesendet. */
export interface MessstellenRegisterAnfrage {
  standort?: string;
  ort?: string;
  anlage?: string;
  zustand?: string;
  ohneQuelle?: boolean;
  /** Ein Tag (`2026-11-20`); fehlt = jetzt. */
  stichtag?: string;
}

/**
 * GET /api/v1/messstellen — `messstellen` und `register` nennen dieselben Messstellen in
 * derselben Reihenfolge (nach Kennzeichen); `teilansicht` bleibt `false`, bis AP-03 Rechte je
 * Standort durchsetzt. `stichtag` ist der Tag von Ort und Stellung, `zeitpunkt` der Augenblick
 * der Quelle.
 */
export interface MessstellenRegister {
  messstellen: MessstelleVertragsform[];
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
  karten_uebernommen?: string[];
  ablesestaende?: { bindung: string; endstand?: MessstelleQuelleStand | null; anfangsstand?: MessstelleQuelleStand | null }[];
  bestaetigte_bindungen?: string[];
}

/** Ein Einbau der Antwort: `geraet` ist die Stelle (GR-4), `einbau` das Kästchen (Z-5a). */
export interface ControllerwechselVorschau {
  zeitpunkt: string;
  karten: { id: string; steckplatz: number | null; bezeichnung: string | null; typ: string | null; seriennummer: string | null }[];
  folgen: { bindung: string; karte: string | null; komponente: string; messstelle: string; kennzeichen: string;
    groesse: string; richtung: string; rolle: string; einheit: string | null; zaehlerstand: boolean }[];
}

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
  beendet: MessstelleQuelle;
  neu: MessstelleQuelle;
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

/** Bestehender Komponenten-Ereignispfad; unbekannte Arten bleiben beim jeweiligen Leser. */
export interface KomponentenEreignis {
  revision: number;
  eventType: string;
  effectiveAt: string;
  fromValue?: string | null;
  toValue?: string | null;
  createdAt: string;
  createdBy?: string | null;
  note?: string | null;
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
  /** AP-03 IP-7: das Akteur-Vokabular neben `origin`; null im Bestand und an Box-Meldungen. */
  actorRolle?: string | null;
  actorArt?: 'kunde' | 'unterstuetzung' | 'voltpilot' | 'notfall' | null;
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
  /** AP-03 IP-7: wer die Zeile ausgelöst hat (Register-Vorgang, „Jetzt voll laden“); null an abgeleiteten Zeilen. */
  urheber?: ProtokollUrheber | null;
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
  /** Additiv (AP-03 IP-10); absent auf einem älteren Backend. */
  teilansicht?: Teilansicht;
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
  /**
   * `body`: der JSON-Körper der Ablehnung, wie der Server ihn schickte (additiv,
   * UEMS AP-02 IP-6) — die Ortsstruktur braucht `code`, `feld` und `verweis`
   * aus {@link OrtFehler}, nicht nur den Satz. Ohne JSON-Körper `undefined`.
   */
  constructor(readonly status: number, message: string, readonly body?: unknown) {
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
let kundenbereich: string | null = null;
export function setKundenbereich(id: string | null): void { kundenbereich = id; }

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
  return `${tenantOverride ?? ''}|${kundenbereich ?? ''}|${path}`;
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

/**
 * Der EINE Ergebnis-Zwischenspeicher dieses Moduls — nur für die Kostenstellen-Sicht (UEMS AP-13 IP-9, E8).
 *
 * Bis AP-10 eine Route „alle Kostenstellen einer Periode“ liefert, ruft die Fläche JE Kostenstelle einmal (Ahrenberg:
 * fünf Aufrufe je Zeitraum). Wer zwischen den Reitern oder Zeiträumen hin und her wechselt, fragt dieselbe Antwort nicht
 * erneut. Die Veraltung bleibt sichtbar und begrenzt: jede Antwort trägt `berechnet_am` (die Fläche zeigt es), und nach
 * {@link GEMERKT_MS} fragt der nächste Aufruf neu. Der Schlüssel trägt den Mandanten-Umschalter wie `inFlight`; eine
 * Ablehnung wird nie gemerkt.
 */
export const GEMERKT_MS = 120_000;
const gemerkt = new Map<string, { seit: number; antwort: Promise<unknown> }>();

function gemerkteAnfrage<T>(path: string): Promise<T> {
  const key = `${tenantOverride ?? ''}|${kundenbereich ?? ''}|${path}`;
  const jetzt = Date.now();
  const da = gemerkt.get(key);
  if (da && jetzt - da.seit < GEMERKT_MS) return da.antwort as Promise<T>;
  const antwort = request<T>(path).catch((e: unknown) => {
    if (gemerkt.get(key)?.antwort === antwort) gemerkt.delete(key);
    throw e;
  });
  gemerkt.set(key, { seit: jetzt, antwort });
  return antwort;
}

/** Leert den Zwischenspeicher der Kostenstellen-Sicht (Tests, „Erneut versuchen“). */
export function vergissGemerkte(): void {
  gemerkt.clear();
}

async function requestUncoalesced<T>(path: string, init: RequestInit = {}): Promise<T> {
  const angefragterMandant = tenantOverride;
  const angefragterKundenbereich = kundenbereich;
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
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(angefragterKundenbereich && !path.startsWith('/api/v1/admin/') ? { 'X-Kundenbereich': angefragterKundenbereich }
        : angefragterMandant ? { 'X-Tenant-Id': angefragterMandant } : {}),
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
    let errorBody: unknown;
    try {
      const body = await res.json();
      errorBody = body;
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    if ((res.status === 404 || res.status === 403) && errorBody && typeof errorBody === 'object'
      && 'code' in errorBody && errorBody.code === 'zugriff_beendet'
      && angefragterMandant === tenantOverride && angefragterKundenbereich === kundenbereich) {
      window.dispatchEvent(new CustomEvent('vp-zugriff-beendet', { detail: message }));
    }
    throw new ApiError(res.status, message, errorBody);
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
  /**
   * Die Datenquelle, aus der die Box dieses Gerät liest (`geraet.data_source_id`) — der EINZIGE
   * Weg von einer Komponente zu ihrer Datenquelle, den die Schnittstellen heute anbieten
   * (AP-13 IP-12, Befund: `…/data-sources` nennt ihre Geräte und Komponenten nicht). `null` =
   * nicht erhoben; dann steht kein Box-Satz, nie eine geratene Box.
   */
  data_source_id?: string | null;
  /*
   * Die übrigen Felder von `GeraetDto.Geraet` — die Geräteseite (AP-04 IP-12)
   * braucht sie für die Karte „Gerät“. Optional, weil das Protokoll und seine
   * Tests nur die Felder oben kennen. `null` = nicht erhoben, nie geraten.
   */
  geraeteart?: 'zaehler' | 'wechselrichter' | 'controller' | 'ladestation' | 'speicher' | 'sonstiges';
  hersteller?: string | null;
  typ?: string | null;
  seriennummer?: string | null;
  bezeichnung?: string | null;
  eingebaut_am?: string;
  /** `true`: aus der Komponente abgeleitet — `eingebaut_am` ist der Beginn ihres Verlaufs, nicht der Einbautag. */
  aus_bestand?: boolean;
  teile?: UemsGeraetTeil[];
  /** Die früheren Einbauten desselben Geräts, der jüngste zuerst. */
  vorgaenger?: UemsGeraetVorgaenger[];
}

/** Eine Energiekarte im Steckplatz eines Controllers; `steckplatz` null = nicht erhoben. */
export interface UemsGeraetTeil {
  id: string;
  teilart: string;
  steckplatz: number | null;
  bezeichnung: string | null;
  typ: string | null;
  seriennummer: string | null;
  eingebaut_am: string;
  ausgebaut_am: string | null;
}

/** Ein früherer Einbau desselben Geräts — „Z-5a · ausgebaut am 18.11.2026, 10:40 Uhr“. */
export interface UemsGeraetVorgaenger {
  id: string;
  einbau_kennzeichen: string;
  hersteller: string | null;
  typ: string | null;
  seriennummer: string | null;
  eingebaut_am: string;
  ausgebaut_am: string | null;
}

// ---- Datenquellen (UEMS AP-06 IP-3): GET /api/v1/sites/{siteId}/data-sources ----
// Die Formen von `DatenquelleDto` — `snake_case` wie das echte Backend. AP-13 IP-12 ist der
// ERSTE Aufrufer dieser Routen im Portal; gelesen wird nur, wer wann liest (die Zuständigkeit).
//
// ⚠ BEFUND (AP-13 IP-12 an AP-06): eine `UemsDatenquelle` nennt WEDER ihre Geräte NOCH ihre
// Komponenten — `geraete_ids` sind Modbus-Geräte-IDs, keine Kennungen des Portals. Der Weg
// „Komponente → ihre Datenquelle“, den AP-13 §8 voraussetzt, geht deshalb über
// `GET …/sites/{id}/geraete` und dessen `data_source_id`. Zwei Aufrufe je Anlage statt einem.

/** Eine Box, wie ein Satz sie nennt; `name` ist `null`, wenn es die Box nicht mehr gibt. */
export interface UemsDatenquelleBox {
  id: string;
  name: string | null;
  heimat_anlage: string | null;
}

/** Ein Zuständigkeits-Zeitraum, halboffen auf die Minute: `effective_to` gehört NICHT dazu. */
export interface UemsDatenquelleZeitraum {
  /** Seit AP-06 IP-12; bei älteren Antworten fehlt die Kennung und damit die Rücknahme-Aktion. */
  id?: string;
  box: UemsDatenquelleBox;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Eine Datenquelle. `zustaendige_box` ist die Box, deren Zeitraum JETZT läuft — `null`, wenn
 * keine liest (Entwurf, Lücke oder erst geplant); „aktiv“ und „liefert Daten“ sind bewusst keine
 * Felder. Das Portal liest heute nur `id`, `kennzeichen` und `zeitraeume`; die übrigen Felder
 * stehen für den nächsten Aufrufer.
 */
export interface UemsDatenquelle {
  id: string;
  kennzeichen: string;
  name: string | null;
  anlage: string;
  protokoll: string;
  adresse: string;
  geraete_ids: number[];
  netz: string | null;
  mehrere_leser: boolean;
  steuerquelle: boolean;
  vergleichsquelle: boolean;
  kadenz_s: number | null;
  archiviert_am: string | null;
  zustaendige_box: UemsDatenquelleBox | null;
  zeitraeume: UemsDatenquelleZeitraum[];
  rueckmeldung?: UemsDatenquelleRueckmeldung | null;
  uebergabe?: {
    zustand: string;
    seit: string;
    box_alt: UemsDatenquelleBox | null;
    box_neu: UemsDatenquelleBox | null;
  } | null;
}

export interface UemsDatenquelleRueckmeldung {
  zustand: 'liefert' | 'liefert_nicht' | 'meldet_noch_nicht_je_quelle';
  fehlerklasse: string | null;
  seit: string | null;
  gelesen_am: string | null;
  anfragen_pro_minute: number | null;
  messwerte_pro_minute: number | null;
  gemeldet_am: string | null;
  text: string;
}

export interface UemsDatenquellenListe {
  datenquellen: UemsDatenquelle[];
}

export interface UemsDatenquelleAnlegen {
  name: string;
  protokoll: string;
  adresse: string;
  geraete_ids: number[];
  netz: string;
  mehrere_leser: boolean;
  steuerquelle: boolean;
  kadenz_s: number;
  device_id: string;
  vergleich_bestaetigt?: boolean;
}

export type UemsDatenquelleBearbeiten = Omit<UemsDatenquelleAnlegen, 'device_id' | 'vergleich_bestaetigt'>;

export interface UemsDatenquellePruefergebnis {
  box: UemsDatenquelleBox;
  adresse: string;
  ergebnis: string;
  gewertet: boolean;
  text: string;
  zeitpunkt: string;
  dauer_ms: number;
  antwort: unknown | null;
}

export interface DatenquelleBudgetZahlen {
  channels: number;
  samples_per_minute: number;
  requests_per_minute: number;
  duty_cycle_percent: number;
}

export interface DatenquelleBudgetBox {
  id: string;
  name: string;
  belegt: DatenquelleBudgetZahlen;
  frei: DatenquelleBudgetZahlen;
  quelle_passt: boolean;
}

/** Der strukturierte 422-Satz von `POST …/assignments` (AP-06 IP-10). */
export interface DatenquelleBudgetFehler {
  code: 'budget_ueberschritten';
  message: string;
  urteil: 'abgelehnt';
  rechnung: {
    code: 'budget_ueberschritten';
    kennzeichen: string;
    box: string;
    quelle: {
      protokoll: string;
      channels: number;
      takt_s: number;
      anfragen: Array<{ anfragen_je_takt: number; kosten_ms_je_anfrage: number }>;
      last: DatenquelleBudgetZahlen;
    };
    box_nachher: DatenquelleBudgetZahlen;
    grenzen: Omit<DatenquelleBudgetZahlen, 'channels'>;
    freie_kapazitaet: DatenquelleBudgetBox[];
    auswege: {
      takt_s: number | null;
      takt: string | null;
      boxen: DatenquelleBudgetBox[];
      andere_box: string | null;
    };
    gruende: string[];
  };
}

/**
 * Eine Einstellungs-Fassung (`GET /api/v1/geraete/{id}/einstellungen`, AP-04
 * IP-11, `EinstellungDto.Fassung`). Die Quelle ist der Einbau (`entity_id`
 * null), eine Komponente oder ein Kanal der Komponente. `wert_text`,
 * `art_kundenwort` und `anwendung_text` sind die Sätze des Vertrags.
 */
export interface EinstellungFassung {
  id: string;
  entity_id: string | null;
  kanal: string | null;
  art: string;
  art_kundenwort: string;
  wert: Record<string, unknown>;
  wert_text: string;
  anwendung: 'angewendet' | 'dokumentiert';
  anwendung_text: string;
  zustellung: 'verbindung' | 'ausstehend' | null;
  herkunft: 'bestand' | 'verbindung' | 'eintrag';
  gueltig_ab: string;
  gueltig_bis: string | null;
  status: 'geplant' | 'gueltig' | 'beendet';
  tatsaechlich_ab: string | null;
  rueckwirkend: boolean;
  begruendung: string | null;
  eingetragen: { am: string; von: string; rolle: string | null; art: string | null } | null;
}

export interface GeraetEinstellungen {
  geraet_id: string;
  geraet: string;
  einbau: string;
  stichtag: string;
  /** Je Quelle und Art die zum Stichtag gültige Fassung. */
  gueltig: EinstellungFassung[];
  /** Alle Fassungen, nach Quelle, Art und Beginn. */
  historie: EinstellungFassung[];
}

/** Eine neue Fassung; `entity_id`/`kanal` leer = sie gilt für den Einbau. */
export interface EinstellungNeu {
  entity_id: string | null;
  kanal: string | null;
  art: string;
  wert: Record<string, unknown>;
  anwendung: 'angewendet' | 'dokumentiert';
  gueltig_ab: string;
  tatsaechlich_ab: string | null;
  begruendung: string | null;
}

/** Antwort 201: die neue, die beendete Fassung, die Folgen-Sätze und die Messstellen des Protokolls. */
export interface EinstellungEingetragen {
  fassung: EinstellungFassung;
  beendet: EinstellungFassung | null;
  folgen: string[];
  messstellen: string[];
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
  /**
   * Der letzte TAG, an dem ein Eintrag der Ortsstruktur noch gilt (AP-02 IP-14) — null = bis heute
   * offen; bei Messstellen und Datenquellen immer null.
   */
  gilt_bis: string | null;
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
  achse: 'wirkung' | 'eintrag' | 'gueltigkeit';
  von: string | null;
  bis: string | null;
  weiter: string | null;
}

/** Der Zeitraum-Filter der drei Protokoll-Routen. */
export interface ProtokollAbfrage {
  von?: string;
  bis?: string;
  /**
   * Vorgabe `wirkung` = „gilt ab"; `eintrag` = „eingetragen am"; `gueltigkeit` = welche Einträge
   * in einen Zeitraum aus TAGEN reichen (AP-02 IP-14, `von`/`bis` zählen beide mit).
   */
  achse?: 'wirkung' | 'eintrag' | 'gueltigkeit';
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
  korrekturen: (standortId: string) => request<KorrekturDetail[]>(`/api/v1/standorte/${encodeURIComponent(standortId)}/korrekturen`),
  korrektur: (kennung: string) => request<KorrekturDetail>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}`),
  ersatzwertLuecken: (kennzeichen: string, quelle_id: string, von: string, bis: string) => request<ErsatzwertLuecke[]>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte/luecken?${new URLSearchParams({ quelle_id, von, bis })}`),
  ersatzwertVorschau: (kennzeichen: string, eingabe: ErsatzwertEingabe) => request<ErsatzwertVorschau>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte/vorschau`, { method: 'POST', body: JSON.stringify(eingabe) }),
  ersatzwertErfassen: (kennzeichen: string, eingabe: ErsatzwertEingabe) => request<KorrekturDetail>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte`, { method: 'POST', body: JSON.stringify(eingabe) }),
  korrekturFreigeben: (kennung: string, begruendung: string) => request<unknown>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/freigeben`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  korrekturAblehnen: (kennung: string, grund: string) => request<KorrekturDetail>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/ablehnen`, { method: 'POST', body: JSON.stringify({ grund }) }),
  korrekturZuruecknehmen: (kennung: string, grund: string) => request<unknown>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/zuruecknehmen`, { method: 'POST', body: JSON.stringify({ grund }) }),
  ersatzwertZuruecknehmen: (kennung: string, grund: string) => request<{ kennung: string; status: string; fassung: number; korrektur: string | null }>(`/api/v1/ersatzwerte/${encodeURIComponent(kennung)}/zuruecknehmen`, { method: 'POST', body: JSON.stringify({ grund }) }),

  /** Tenant-wide fleet overview (the adaptive Übersicht's fleet mode). */
  overview: () => request<Overview>('/api/v1/overview'),
  /**
   * Der gemeldete Edge-Stand aller Geräte des Mandanten (Plattform-Übersicht).
   * Eine leere Liste heißt „kein Gerät hat je gemeldet", nicht „alle aktuell".
   */
  edgeVersions: () => request<SichtbareListe<EdgeVersion>>('/api/v1/edge-versions'),
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
  summenwertQuellen: (siteId: string, kontext: SummenwertKontext = { art: 'anlage' }) =>
    request<Array<{ entityId: string; deviceId: string | null; name: string; grund: string | null }>>(`/api/v1/sites/${siteId}/summenwert-quellen${kontext.art === 'geraet' ? `?${new URLSearchParams({ boxId: kontext.boxId, geraetId: kontext.geraetId })}` : ''}`),

  /** Flüchtige Katalog-Lesung; verändert weder Selektion noch Register. */
  measurementLesen: (deviceId: string, entityId: string, pointKey: string) =>
    request<import('./summenwertQuellen').Sitzungswert>(
      `/api/v1/devices/${deviceId}/measurement-selection/lesen?${new URLSearchParams({ entityId, pointKey })}`,
      { method: 'POST' },
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
   * Kunden-Schritt „Grenze“ (AP-01 IP-13): der Server prüft die heute
   * gebundene vereinbarte Leistung und das verbleibende Ladebudget. Der
   * Übergangswert ist nur nötig, solange kein Netzanschluss gebunden ist.
   */
  saveCustomerChargingFrame: (
    siteId: string,
    body: { gridLimitKw: number; vereinbartKw?: number },
  ) => request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-frame`, {
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
      /** Die Box, deren echte Adresse der Anbinde-Assistent zeigt. */
      deviceId?: string;
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
  listSites: () => request<SichtbareListe<Site>>('/api/v1/sites'),
  siteDetail: (siteId: string) => request<SiteDetail>(`/api/v1/sites/${siteId}`),
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
  listDevices: () => request<SichtbareListe<Device>>('/api/v1/devices'),
  claimDevice: (siteId: string, externalRef: string) =>
    request<Device>('/api/v1/devices/claim', {
      method: 'POST',
      body: JSON.stringify({ siteId, externalRef }),
    }),
  boxTauschen: (newId: string, oldId: string) =>
    request<BoxTauschAntwort>(`/api/v1/devices/${newId}/succeed/${oldId}`, { method: 'POST' }),
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
      /** Gewählte Box für ein neues Gerät; ohne Wahl entscheidet die führende Box. */
      deviceId?: string;
      /** Bestehende Komponente: der Server wählt die ausführende Box und ergänzt Secrets. */
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
  /**
   * „Batterie am Standort abmelden" (vp-komp-loeschen E1): remove the site's
   * battery as one coherent action - the nameplate the optimizer reads, the
   * battery entity's flow-claim orphan and the entity/measurement point go
   * together, so nothing keeps planning a phantom battery. Recorded telemetry
   * is KEPT; only the live visibility ends. Returns the remaining assets.
   */
  unregisterBattery: (siteId: string) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/battery`, { method: 'DELETE' }),
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
  komponenteMesskanaele: (siteId: string, entityId: string, stichtag?: string) =>
    request<MesskanalListe>(`/api/v1/sites/${siteId}/komponenten/${entityId}/messkanaele${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`),

  /** Alle Messstellen des Kundenbereichs (für die Auswahl der berechneten). */
  messstellen: () => request<{ messstellen: Messstelle[] }>(`/api/v1/messstellen`),

  /**
   * Das Messstellen-Register (AP-04 IP-4/IP-15) — dieselbe Route, mit ihren Filtern und dem
   * Stichtag. Die Fläche „Messstellen“ (IP-5) liest NUR diese eine Abfrage.
   */
  messstellenRegister: (anfrage: MessstellenRegisterAnfrage = {}) => {
    const q = new URLSearchParams();
    for (const [schluessel, wert] of Object.entries(anfrage)) {
      if (wert === undefined || wert === false || wert === '') continue;
      q.set(schluessel, String(wert));
    }
    const text = q.toString();
    return request<MessstellenRegister>(`/api/v1/messstellen${text ? `?${text}` : ''}`);
  },

  /** AP-06 IP-17: reine, standortbezogene Sicht auf offene, festgehaltene Ausfall-Fakten. */
  standortAusfall: (standortId: string) =>
    request<StandortAusfall>(`/api/v1/standorte/${standortId}/ausfall`),

  /** Eine einzelne Messstelle. */
  messstelle: (id: string) => request<Messstelle>(`/api/v1/messstellen/${id}`),

  /** Der Vorschlag für das nächste Kennzeichen (MS-…), unaufdringlich gezeigt. */
  kennzeichenVorschlag: () =>
    request<{ kennzeichen: string }>(`/api/v1/messstellen/kennzeichen-vorschlag`),

  /** Die UEMS-Geräte einer Anlage (AP-04 IP-10) — der Weg von der Komponente zum Gerät. */
  uemsGeraete: (siteId: string) =>
    request<{ geraete: UemsGeraet[] }>(`/api/v1/sites/${siteId}/geraete`),

  komponentenEreignisse: (siteId: string, entityId: string) =>
    request<KomponentenEreignis[]>(`/api/v1/sites/${siteId}/components/${entityId}/events`),

  messstelleZaehlerwechsel: (id: string, body: Zaehlerwechsel) =>
    request<ZaehlerwechselVorgang>(`/api/v1/messstellen/${id}/quellen/wechsel`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  controllerwechselVorschau: (id: string, zeitpunkt: string) =>
    request<ControllerwechselVorschau>(`/api/v1/geraete/${id}/austausch/vorschau?zeitpunkt=${encodeURIComponent(zeitpunkt)}`),
  geraetAustauschen: (id: string, body: Zaehlerwechsel) =>
    request<ZaehlerwechselVorgang>(`/api/v1/geraete/${id}/austausch`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  /**
   * Die Datenquellen EINER Anlage (AP-06 IP-3) — AP-13 IP-12 ist ihr erster Aufrufer im Portal.
   * Gelesen wird daraus allein die Zuständigkeit: welche Box liest die Quelle, seit wann.
   */
  datenquellen: (siteId: string) =>
    request<UemsDatenquellenListe>(`/api/v1/sites/${siteId}/data-sources`),

  datenquelleAnlegen: (siteId: string, body: UemsDatenquelleAnlegen) =>
    request<UemsDatenquelle>(`/api/v1/sites/${siteId}/data-sources`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  datenquelleBearbeiten: (siteId: string, id: string, body: UemsDatenquelleBearbeiten) =>
    request<UemsDatenquelle>(`/api/v1/sites/${siteId}/data-sources/${id}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),

  datenquellePruefen: (siteId: string, id: string, body: {
    device_id: string; unit_id: number; register: number;
    register_kind?: string; data_type?: string; word_order?: string;
  }) => request<UemsDatenquellePruefergebnis>(
    `/api/v1/sites/${siteId}/data-sources/${id}/reachability-check`,
    { method: 'POST', body: JSON.stringify(body) },
  ),

  /** Eine 422-Ablehnung trägt {@link DatenquelleBudgetFehler} in `ApiError.body`. */
  datenquelleZuweisen: (siteId: string, id: string, body: {
    device_id: string; effective_from?: string; vergleich_bestaetigt?: boolean;
  }) => request<{ urteil: 'erlaubt'; text: string; hinweis: string | null;
    vergleichsquelle: boolean; datenquelle: UemsDatenquelle }>(
    `/api/v1/sites/${siteId}/data-sources/${id}/assignments`,
    { method: 'POST', body: JSON.stringify(body) },
  ),

  datenquelleZuweisungZuruecknehmen: (siteId: string, id: string, assignmentId: string) =>
    request<UemsDatenquelle>(
      `/api/v1/sites/${siteId}/data-sources/${id}/assignments/${assignmentId}`,
      { method: 'DELETE' },
    ),

  /** Die Einstellungs-Fassungen eines Einbaus (AP-04 IP-11) — gültig jetzt und die Historie. */
  geraetEinstellungen: (id: string) =>
    request<GeraetEinstellungen>(`/api/v1/geraete/${id}/einstellungen`),

  /** Trägt eine neue Fassung ein — sie legt sich zwischen die bestehenden, nie überschreibend. */
  geraetEinstellungEintragen: (id: string, body: EinstellungNeu) =>
    request<EinstellungEingetragen>(`/api/v1/geraete/${id}/einstellungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

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

  /** Das Änderungsprotokoll EINES Gebäudes oder Bereichs (AP-02 IP-14, H2). */
  ortAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/orte/${id}/aenderungen${protokollFrage(f)}`),

  /**
   * Das Änderungsprotokoll EINES Standorts samt seinen Gebäuden, Bereichen und
   * Anlagen-Zuordnungen (AP-02 IP-14) — jedes Kind aus seiner Zeit an diesem Standort.
   */
  standortAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/standorte/${id}/aenderungen${protokollFrage(f)}`),

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

  /**
   * Der kanonische, über alle Geräte zusammengefasste Rollen-Wert einer Anlage (heute nur `pv`) —
   * die Zahl, die das Cockpit statt `telemetry.pv_power_kw` zeigt, wenn eine Zuordnung existiert,
   * samt der Ehrlichkeits-Aufschlüsselung je Gerät. `zuordnung_vorhanden = false` = Rückfall.
   */
  rollenWert: (siteId: string, role: string) =>
    request<RollenKanonischerWert>(`/api/v1/sites/${siteId}/rollen/${role}`),

  /**
   * Der maßgebliche Rollen-Wert EINES Geräts (Konzept vp-agg „verwenden als",
   * PR 758); `zugeordnet == null` = keine Zuordnung.
   */
  geraetSummenwerte: (siteId: string, entityId: string) =>
    request<GeraetSummenwert[]>(`/api/v1/sites/${siteId}/komponenten/${entityId}/summenwerte`),
  anlageRolleZuordnen: (siteId: string, role: SummenwertRolle, id: string, ersetzen = false) =>
    request<{ geraete: GeraetRolle[] }>(`/api/v1/sites/${siteId}/rollen/${role}`, {
      method: 'PUT', body: JSON.stringify({ art: 'gesamtwert', quell_messstelle_id: id, ersetzen }),
    }),
  rolleEntziehen: (siteId: string, entityId: string, role: SummenwertRolle) =>
    request<RollenZuordnungAntwort>(`/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`, { method: 'DELETE' }),
  anlageAenderungen: (siteId: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/sites/${siteId}/aenderungen${protokollFrage(f)}`),

  geraetRolle: (siteId: string, entityId: string, role: string) =>
    request<GeraetRolle>(`/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`),

  /**
   * Setzt den maßgeblichen Rollen-Wert eines Geräts (nativer Kanal ODER Gesamtwert);
   * die Antwort nennt den abgelösten Wert (is_primary-Semantik, Ersetzen statt doppelt
   * zählen).
   */
  rolleZuordnen: (siteId: string, entityId: string, role: string, body: RollenEingabe) =>
    request<RollenZuordnungAntwort>(
      `/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  /** Der Verlauf einer berechneten Messstelle (je 15 min die Summe, sonst null). */
  messstelleVerlauf: (id: string, range?: string) =>
    request<MessstelleVerlauf>(
      `/api/v1/messstellen/${id}/verlauf${range ? `?range=${range}` : ''}`,
    ),

  /**
   * Die Werte je Messstelle (UEMS AP-08 IP-9) über ihr HEUTIGES Kennzeichen: `von`/`bis` als Tag
   * (JJJJ-MM-TT, `bis` = letzter Tag einschließlich) in der Zeitzone des Standorts. Mit `version` (AP-08 IP-18)
   * genau diese Version der gespeicherten Zeile, ohne sie die neueste.
   */
  messstelleWerte: (kennzeichen: string, raster: MessstelleWerteRaster, von: string, bis: string, version?: number | null) =>
    request<MessstelleWerte>(
      `/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/werte?raster=${raster}&von=${von}&bis=${bis}` +
        (version == null ? '' : `&version=${version}`),
    ),

  /**
   * Die Versions-Historie EINER Periode (UEMS AP-08 IP-18): `von`/`bis` sind die des Schritts, wie die Route
   * `…/werte` sie liefert (Zeitpunkte mit Versatz, `bis` ausschließlich) — kodiert, sonst würde das `+` des
   * Versatzes zum Leerzeichen.
   */
  messstelleWerteVersionen: (
    kennzeichen: string,
    raster: MessstelleWerteHistorie['raster'],
    von: string,
    bis: string,
  ) =>
    request<MessstelleWerteHistorie>(
      `/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/werte/versionen?raster=${raster}` +
        `&von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`,
    ),

  /**
   * Bearbeitet die drei änderbaren Felder einer Messstelle (Kennzeichen · Name ·
   * Notiz) — der Server ersetzt sie GANZ, ein fehlendes Feld wird leer. Zum
   * Umbenennen also das bestehende Kennzeichen mitschicken — und seit AP-08 IP-7 die
   * Anschlussleistung, sonst wird auch sie leer.
   */
  messstelleBearbeiten: (
    id: string,
    body: { kennzeichen?: string; name: string; notiz?: string; anschlussleistung_kw?: number | null },
  ) =>
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

  // ---- Messstellen-Dialog (UEMS AP-04 IP-6): jeder Schritt schreibt über seine Route
  /** Legt eine gemessene Messstelle an; eine Ablehnung trägt Code und Fakten in `ApiError.body`. */
  messstelleAnlegen: (body: MessstelleAnlegen) =>
    request<Messstelle>(`/api/v1/messstellen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Der Ort ab einem Tag (IP-7) — Antwort: die Messstelle mit ihren Orten. */
  messstelleOrtAendern: (id: string, body: MessstelleOrtAendern) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/ort`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die elektrische Stellung ab einem Tag (IP-7) — 409 `hauptzaehler_vorhanden` nennt `bestehend`. */
  messstelleStellungAendern: (id: string, body: MessstelleStellungAendern) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/stellung`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Bindet eine führende Quelle oder eine Vergleichsquelle (IP-13) — nie überschreibend. */
  messstelleQuelleBinden: (id: string, body: MessstelleQuelleBinden) =>
    request<MessstelleQuelleVorgang>(`/api/v1/messstellen/${id}/quellen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** UEMS AP-04 IP-14: je Größe die Quellen zum Stichtag (mit ihrem letzten Wert) und die Historie. */
  messstelleQuellen: (id: string, stichtag?: string | null) =>
    request<MessstelleQuellenListe>(
      `/api/v1/messstellen/${id}/quellen` + (stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''),
    ),
  /** Beendet eine Quelle (IP-13) — eine Quelle wird nie gelöscht, sie endet. */
  messstelleQuelleBeenden: (id: string, quelleId: string, body: MessstelleQuelleBeenden = {}) =>
    request<MessstelleQuelleVorgang>(`/api/v1/messstellen/${id}/quellen/${quelleId}/beenden`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ---- Ortsstruktur: Unternehmen und Standorte (UEMS AP-02 IP-3/IP-4; Fläche dazu IP-6)
  /** Das Unternehmen des Kundenbereichs — die Zeitzonen-Vorgabe eines neuen Standorts. */
  unternehmen: () => request<Unternehmen>('/api/v1/unternehmen'),
  /** UEMS AP-01 IP-6: beide Funktionen je Standort (`GET /api/v1/funktionen`, Routen aus IP-3). */
  funktionen: () => request<Funktionen>('/api/v1/funktionen'),
  /** AP-01 IP-10b: Startprüfung aus frischen Fakten; fremde Anlage = 404. */
  funktionSteuernPruefung: (siteId: string) =>
    request<FunktionSteuernPruefung>(`/api/v1/sites/${encodeURIComponent(siteId)}/funktionen/steuern/pruefung`),
  /** AP-01 IP-3/IP-10b: Anlage aufnehmen bzw. Steuerung starten. */
  funktionSteuern: (siteId: string, aktion: FunktionSteuernAnfrage['aktion']) =>
    request<FunktionSteuernErgebnis>(`/api/v1/sites/${encodeURIComponent(siteId)}/funktionen/steuern`, {
      method: 'PUT', body: JSON.stringify({ aktion }),
    }),
  /** AP-01 IP-3/IP-11: alle teilnehmenden Anlagen eines Standorts anhalten bzw. fortsetzen. */
  funktionSteuernStandort: (standortId: string, aktion: 'anhalten' | 'fortsetzen') =>
    request<FunktionSteuernErgebnis>(`/api/v1/standorte/${encodeURIComponent(standortId)}/funktionen/steuern`, {
      method: 'PUT', body: JSON.stringify({ aktion }),
    }),
  /** UEMS AP-01 IP-9a: „Messen & Auswerten“ für einen Standort einrichten (Entwurf); ein zweites Mal ist 409 `bereits_angelegt`. */
  funktionMessenEinrichten: (standortId: string) =>
    request<FunktionMessenErgebnis>(`/api/v1/standorte/${encodeURIComponent(standortId)}/funktionen/messen`, {
      method: 'PUT',
      body: JSON.stringify({ aktion: 'einrichten' }),
    }),
  /** UEMS AP-04 IP-16 (Fläche AP-01 IP-9b): die Vorschlagsliste je Standort — liest nur, nichts entsteht ungefragt. */
  messstellenVorschlag: (standortId: string) =>
    request<MessstelleVorschlagsliste>(`/api/v1/standorte/${encodeURIComponent(standortId)}/messstellen-vorschlag`),
  /** Übernimmt die gewählten Zeilen, wie die Liste sie zeigte (nur `name` darf anders sein) — in EINER Transaktion. */
  messstellenVorschlagUebernehmen: (standortId: string, body: MessstelleVorschlagUebernehmen) =>
    request<MessstelleVorschlagUebernommen<Messstelle>>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/messstellen-vorschlag/uebernehmen`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Die Standorte zum Stichtag (ohne: heute) samt der Gruppe „Noch nicht zugeordnet“. */
  standorte: (stichtag?: string) =>
    request<StandorteAmStichtag>(
      `/api/v1/standorte${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`,
    ),
  /** AP-10 IP-17/F15: welches System welches Gebäude am Tag versorgt. */
  versorgung: (standortId: string, stichtag?: string) =>
    request<Versorgung>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/versorgung${
        stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''
      }`,
    ),
  /** AP-02 IP-10: liest nur; vor der Bestätigung entsteht nichts. */
  standortZuordnungVorschlag: () =>
    request<StandortZuordnungVorschau>('/api/v1/standorte/vorschlag'),
  /** Legt alle gezeigten Gruppen und Zuordnungen in einer Transaktion an. */
  standortZuordnungBestaetigen: (body: StandortZuordnungBestaetigen) =>
    request<StandortZuordnungErgebnis>('/api/v1/standorte/vorschlag/bestaetigen', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  netzanschluesse: (standortId: string, stichtag?: string) =>
    request<Netzanschluesse>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`),
  netzanschlussVorschlaege: (standortId: string) =>
    request<NetzanschlussVorschlag[]>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege`),
  netzanschlussUebernehmen: (standortId: string, anlageId: string, body: NetzanschlussUebernehmen) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege/${encodeURIComponent(anlageId)}/uebernehmen`, { method: 'POST', body: JSON.stringify(body) }),
  netzanschlussVerwerfen: (standortId: string, anlageId: string) =>
    request<void>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege/${encodeURIComponent(anlageId)}/verwerfen`, { method: 'POST' }),
  netzanschlussAnlegen: (standortId: string, body: NetzanschlussAnfrage) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse`, { method: 'POST', body: JSON.stringify(body) }),
  netzanschlussBinden: (standortId: string, id: string, body: NetzanschlussBinden) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/${encodeURIComponent(id)}/anlagen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Das Kurzzeichen, das ein neuer Standort bekäme — bewegt den Zähler nicht. */
  standortKurzzeichenVorschlag: () =>
    request<StandortKurzzeichenVorschlag>('/api/v1/standorte/kurzzeichen-vorschlag'),

  /** Legt einen Standort an; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  standortAnlegen: (body: StandortStammdaten) =>
    request<StandortAmStichtag>('/api/v1/standorte', { method: 'POST', body: JSON.stringify(body) }),

  /** Schreibt die Stammdaten eines Standorts — die GANZE Menge, ein fehlendes Feld ist leer. */
  standortBearbeiten: (id: string, body: StandortStammdaten) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ---- Ortsstruktur: Gebäude und Bereiche (UEMS AP-02 IP-5; Fläche dazu IP-7)
  /** Der Ortsbaum eines Standorts zum Stichtag (ohne: heute) — Gebäude mit Bereichen und „direkt am Standort“. */
  standortOrte: (standortId: string, stichtag?: string) =>
    request<OrtsbaumAmStichtag>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/orte${
        stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''
      }`,
    ),

  /** Legt ein Gebäude oder einen Bereich an; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  ortAnlegen: (standortId: string, body: OrtAnlegen) =>
    request<Ort>(`/api/v1/standorte/${encodeURIComponent(standortId)}/orte`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Schreibt die einfachen Felder eines Gebäudes oder Bereichs — die GANZE Menge. */
  ortBearbeiten: (ortId: string, body: OrtBearbeiten) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die Bezugsfläche eines Gebäudes oder Bereichs ab einem Tag (E3). */
  ortFlaeche: (ortId: string, body: OrtFlaeche) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/flaeche`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ---- Archivieren · Wiederherstellen · Löschen (UEMS AP-02 IP-15); eine Ablehnung trägt OrtFehler.
  ortArchivieren: (ortId: string) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/archivieren`, { method: 'POST' }),
  /** `name`: das Umbenennen im selben Dialog, wenn der alte Name inzwischen vergeben ist. */
  ortWiederherstellen: (ortId: string, name?: string) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/wiederherstellen`, {
      method: 'POST',
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    }),
  /** Nur ohne Historie (E1) — sonst 409 `loeschen_gesperrt`. */
  ortLoeschen: (ortId: string) => request<void>(`/api/v1/orte/${encodeURIComponent(ortId)}`, { method: 'DELETE' }),
  /** IP-12: was das Verschieben bewirken würde — schreibt nichts; eine Ablehnung trägt OrtFehler (mit `feld`). */
  ortVerschiebenVorschau: (ortId: string, zielId: string, gueltigAb: string) =>
    request<OrtVerschiebung>(
      `/api/v1/orte/${encodeURIComponent(ortId)}/verschieben/vorschau?zielId=${encodeURIComponent(
        zielId,
      )}&gueltigAb=${encodeURIComponent(gueltigAb)}`,
    ),
  /** IP-12: verschiebt ab `gueltigAb`; die Antwort nennt die Zuordnungen danach und den Protokolleintrag. */
  ortVerschieben: (ortId: string, body: OrtVerschiebenAnfrage) =>
    request<OrtVerschiebung>(`/api/v1/orte/${encodeURIComponent(ortId)}/verschieben`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  standortArchivieren: (id: string) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}/archivieren`, { method: 'POST' }),
  standortWiederherstellen: (id: string, name?: string) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}/wiederherstellen`, {
      method: 'POST',
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    }),

  /** Die Folgen, bevor eine Anlage einem Standort zugeordnet wird (UEMS AP-02 IP-11) — schreibt nichts. */
  anlageStandortVorschau: (siteId: string, standortId: string, gueltigAb: string) =>
    request<AnlageUmzug>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/standort/vorschau?standortId=${encodeURIComponent(
        standortId,
      )}&gueltigAb=${encodeURIComponent(gueltigAb)}`,
    ),

  /** Ordnet die Anlage ab `gueltigAb` einem Standort zu; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  anlageStandortSetzen: (siteId: string, body: AnlageUmzugAnfrage) =>
    request<AnlageUmzug>(`/api/v1/sites/${encodeURIComponent(siteId)}/standort`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

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

  /**
   * Die Kostenstellen-Sicht EINER Kostenstelle (AP-10 IP-11): gemessen · verteilt · berechnet · Summe · nicht verteilt
   * und die Warnung vor doppelter Zählung. Gemerkt je Kostenstelle und Zeitraum ({@link GEMERKT_MS}, AP-13 IP-9).
   */
  kostenstelleEnergie: (id: string, periode: KostenstelleEnergiePeriode, am: string, version?: number | null) =>
    gemerkteAnfrage<KostenstelleEnergie>(
      `/api/v1/unternehmen/kostenstellen/${encodeURIComponent(id)}/energie?periode=${periode}&am=${am}` +
        (version == null ? '' : `&version=${version}`),
    ),

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

  /** Die Bilanz einer Anlage je Hauptzähler (AP-10 IP-9): Periode `tag` · `monat` · `jahr`, die `am` enthält. */
  anlageBilanz: (siteId: string, periode?: 'tag' | 'monat' | 'jahr', am?: string) => {
    const q = new URLSearchParams();
    if (periode) q.set('periode', periode);
    if (am) q.set('am', am);
    const qs = q.toString();
    return request<Bilanz>(`/api/v1/sites/${siteId}/bilanz${qs ? `?${qs}` : ''}`);
  },

  /** Bestätigt „Rest anlegen“ (E18) — nie zweimal: ein zweiter Klick liefert `neu` = false. */
  anlageRestAnlegen: (siteId: string, body: { hauptzaehler_id: string; name?: string }) =>
    request<BilanzRestAngelegt>(`/api/v1/sites/${siteId}/bilanz/rest`, { method: 'POST', body: JSON.stringify(body) }),

  /** Die Bezugsgrößen des Kundenbereichs, archivierte eingeschlossen (AP-09 IP-5) — daneben die Bezugsflächen der Ortsstruktur (IP-6). */
  bezugsgroessen: () =>
    request<BezugsgroessenListe>(`/api/v1/bezugsgroessen`),

  /** Die Bezugsflächen mit ihrem Wert je Periode am Stichtag (E17, S3) — nur lesen, es gibt keinen Schreibweg. */
  bezugsflaechen: (periodeArt: 'tag' | 'woche' | 'monat' | 'jahr', von: string, bis: string) =>
    request<Bezugsflaechen>(
      `/api/v1/bezugsflaechen?periode_art=${periodeArt}&von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`,
    ),

  /** Die Intervalle eines Stammdatums (E15); mit Periode zusätzlich der Wert je Periode am Stichtag. */
  bezugsgroesseStammdatum: (id: string, periode?: { periodeArt: 'tag' | 'woche' | 'monat' | 'jahr'; von: string; bis: string }) =>
    request<BezugsgroesseStammdatum>(
      `/api/v1/bezugsgroessen/${id}/stammdatum` +
        (periode
          ? `?periode_art=${periode.periodeArt}&von=${encodeURIComponent(periode.von)}&bis=${encodeURIComponent(periode.bis)}`
          : ''),
    ),

  /** Ein Wert eines Stammdatums ab einem Tag (E15/S4); eine Ablehnung trägt `code` aus `bezugsgroesse.ts`. */
  bezugsgroesseStammdatumEintragen: (id: string, body: { wert: string; gueltig_ab: string }) =>
    request<BezugsgroesseStammdatum>(`/api/v1/bezugsgroessen/${id}/stammdatum`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

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

  /** Vorschau und Übernahme schicken die Datei erneut; der Browser setzt die Multipart-Grenze. */
  bezugsdatenVorschau: (datei: File, zuordnung: BezugsdatenZuordnung | null, vorlageId: string | null = null) => {
    const body = new FormData(); body.append('datei', datei);
    if (vorlageId) body.append('vorlage_id', vorlageId); else body.append('zuordnung', JSON.stringify(zuordnung));
    return request<BezugsdatenVorschau>('/api/v1/bezugsdaten/importe/vorschau', { method: 'POST', body });
  },
  bezugsdatenImportieren: (datei: File, zuordnung: BezugsdatenZuordnung | null, vorlageId: string | null, bestaetigung: { vorschau: string; entscheidungen: Record<number, string>; begruendung: string | null; teiluebernahme: string | null }) => {
    const body = new FormData(); body.append('datei', datei);
    if (vorlageId) body.append('vorlage_id', vorlageId); else body.append('zuordnung', JSON.stringify(zuordnung));
    body.append('bestaetigung', JSON.stringify(bestaetigung));
    return request<BezugsdatenImportErgebnis>('/api/v1/bezugsdaten/importe', { method: 'POST', body });
  },
  bezugsdatenImporte: () => request<{ importe: BezugsdatenImportProtokollEintrag[] }>('/api/v1/bezugsdaten/importe'),
  bezugsdatenImport: (kennung: string) => request<BezugsdatenImportProtokollEintrag>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}`),
  bezugsdatenRuecknahmeVorschau: (kennung: string) => request<BezugsdatenRuecknahmeVorschau>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}/ruecknahme/vorschau`),
  bezugsdatenImportZuruecknehmen: (kennung: string, begruendung: string) => request<BezugsdatenImportErgebnis>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}/ruecknahme`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  bezugsdatenVorlagen: () => request<{ vorlagen: BezugsdatenVorlage[] }>('/api/v1/bezugsdaten/vorlagen'),
  bezugsdatenVorlageSpeichern: (body: { vorlage_id?: string; name: string; zuordnung: BezugsdatenZuordnung }) =>
    request<BezugsdatenVorlage>('/api/v1/bezugsdaten/vorlagen', { method: 'POST', body: JSON.stringify(body) }),

  /** Die Kennzahlen des Kundenbereichs, archivierte eingeschlossen (AP-11 IP-5); Ablehnungen tragen `KennzahlFehlerCode`. */
  kennzahlen: () => request<{ kennzahlen: Kennzahl[]; ausserhalb_zugriff?: { anzahl: number; text: string } }>(`/api/v1/kennzahlen`),
  kennzahl: (id: string) => request<Kennzahl>(`/api/v1/kennzahlen/${id}`),
  /** Legt die Kennzahl mit Fassung 1 „gilt seit Beginn“ an. */
  kennzahlAnlegen: (body: KennzahlAnfrage) =>
    request<Kennzahl>(`/api/v1/kennzahlen`, { method: 'POST', body: JSON.stringify(body) }),
  /** Prüft und rechnet die letzten drei Perioden — schreibt nichts. */
  kennzahlVorschau: (body: KennzahlAnfrage) =>
    request<KennzahlVorschau>(`/api/v1/kennzahlen/vorschau`, { method: 'POST', body: JSON.stringify(body) }),
  /** Der Vorlagen-Katalog (AP-11 IP-10) — dieselben Knoten wie die Portal-Kopie `src/kennzahlen/kennzahl-vorlagen.json`. */
  kennzahlVorlagen: () => request<KennzahlVorlagen>(`/api/v1/kennzahl-vorlagen`),
  /** Die GANZEN Stammdaten ohne Fassung. */
  kennzahlAendern: (id: string, body: { kennzeichen: string; name: string; verantwortlich_name: string; zweck?: string | null }) =>
    request<Kennzahl>(`/api/v1/kennzahlen/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  kennzahlArchivieren: (id: string) => request<Kennzahl>(`/api/v1/kennzahlen/${id}/archivieren`, { method: 'POST' }),
  /** Nur ohne Wert und ohne lesende Kennzahl (sonst 409 `hat_werte` bzw. `wird_gelesen`). */
  kennzahlLoeschen: (id: string) => request<void>(`/api/v1/kennzahlen/${id}`, { method: 'DELETE' }),
  kennzahlFassungen: (id: string) =>
    request<{ kennzahl_id: string; kennzeichen: string; fassungen: KennzahlFassung[] }>(`/api/v1/kennzahlen/${id}/fassungen`),
  /** Die Berechnung ab einem Tag als Fassung n + 1, mit Begründung, auch rückwirkend. */
  kennzahlFassungEintragen: (
    id: string,
    body: { gueltig_ab: string; begruendung: string; periode_art?: KennzahlPeriodeArt | null; komplement?: boolean | null; eingaenge: KennzahlEingang[] },
  ) =>
    request<{ kennzahl_id: string; kennzeichen: string; fassungen: KennzahlFassung[] }>(`/api/v1/kennzahlen/${id}/fassungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Die Fassung, die am Tag `am` (JJJJ-MM-TT, Vorgabe heute) galt. */
  kennzahlBerechnung: (id: string, am?: string) =>
    request<{ kennzahl_id: string; kennzeichen: string; am: string; fassung: KennzahlFassung }>(
      `/api/v1/kennzahlen/${id}/berechnung` + (am ? `?am=${encodeURIComponent(am)}` : ''),
    ),
  /**
   * Die Werte einer Kennzahl je Periode (AP-11 IP-7): `von` der erste, `bis` der LETZTE Tag einer Periode; ohne
   * `version` je Schritt die neueste. Ungerundet — gerundet wird nur in der Anzeige.
   */
  kennzahlWerte: (id: string, periode: KennzahlPeriodeArt, von: string, bis: string, version?: number) =>
    request<KennzahlWerte>(
      `/api/v1/kennzahlen/${id}/werte?periode=${periode}&von=${von}&bis=${bis}` + (version ? `&version=${version}` : ''),
    ),
  /** Die Versionen EINER Periode (`von` = ihr erster Tag) — wer, wann, warum, und was vorher dastand. */
  kennzahlWertVersionen: (id: string, periode: KennzahlPeriodeArt, von: string) =>
    request<KennzahlWerteHistorie>(`/api/v1/kennzahlen/${id}/werte/versionen?periode=${periode}&von=${von}`),

  /**
   * Die Werte mit ihren Fassungen und der Herkunft je Fassung. `von`/`bis` sind Tage
   * (JJJJ-MM-TT, der letzte einschließlich); `fassungen` `wirksam` (Vorgabe) oder `alle`.
   */
  bezugswertEingeben: (id: string, body: { periode: string; wert: string }) =>
    request<BezugswertAntwort>(`/api/v1/bezugsgroessen/${encodeURIComponent(id)}/werte`, { method: 'POST', body: JSON.stringify(body) }),
  bezugswertBerichtigen: (id: string, periode: string, body: { wert: string; begruendung: string }) =>
    request<BezugswertAntwort>(`/api/v1/bezugsgroessen/${encodeURIComponent(id)}/werte/${encodeURIComponent(periode)}/berichtigung`, { method: 'POST', body: JSON.stringify(body) }),
  ablesungen: (kz: string) => request<Ablesung[]>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen`),
  ablesungEintragen: (kz: string, body: { zeitpunkt: string; stand: string; zuordnung_monat: string | null }) =>
    request<AblesungAntwort>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen`, { method: 'POST', body: JSON.stringify(body) }),
  ablesungBerichtigen: (kz: string, zeitpunkt: string, body: { stand: string; zuordnung_monat: string | null; begruendung: string }) =>
    request<AblesungAntwort>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen/${encodeURIComponent(zeitpunkt)}/berichtigung`, { method: 'POST', body: JSON.stringify(body) }),

  bezugsKanaele: (id: string) => request<BezugsKanalAuswahl[]>(`/api/v1/bezugsgroessen/${id}/kanalbindung/kanaele`),
  kanalbindungen: (id: string) => request<BezugsKanalbindung[]>(`/api/v1/bezugsgroessen/${id}/kanalbindung`),
  kanalBinden: (id: string, body: BezugsKanalAnfrage) => request<BezugsKanalbindung>(`/api/v1/bezugsgroessen/${id}/kanalbindung`, { method: 'POST', body: JSON.stringify(body) }),
  kanalBeenden: (id: string, bindung: string, bis: string) => request<BezugsKanalbindung>(`/api/v1/bezugsgroessen/${id}/kanalbindung/${bindung}/beenden`, { method: 'POST', body: JSON.stringify({ bis }) }),
  bezugsgroesseWerte: (id: string, abfrage: { von?: string; bis?: string; fassungen?: BezugsgroesseLesart } = {}) => {
    const q = new URLSearchParams();
    if (abfrage.von) q.set('von', abfrage.von);
    if (abfrage.bis) q.set('bis', abfrage.bis);
    if (abfrage.fassungen) q.set('fassungen', abfrage.fassungen);
    const s = q.toString();
    return request<BezugsgroesseWerte>(`/api/v1/bezugsgroessen/${id}/werte${s ? `?${s}` : ''}`);
  },
  /**
   * UEMS AP-03 IP-4: die Selbstauskunft — wer fragt und was er darf. Die Berichts-Dialoge (AP-12 IP-14) lesen daraus,
   * welche Hebel sie zeigen; entscheiden tut weiter die Route.
   */
  selbstauskunft: () => request<Selbstauskunft>('/api/v1/me'),
  /** Die Berichte, die die Person lesen darf (AP-12 IP-7); Ablehnungen tragen `BerichtFehlerCode`. */
  berichte: () => request<{ berichte: Bericht[] }>(`/api/v1/berichte`),
  /** Legt den Bericht an und bildet seinen Entwurf. */
  berichtAnlegen: (body: BerichtAnlegen) =>
    request<Bericht>(`/api/v1/berichte`, { method: 'POST', body: JSON.stringify(body) }),
  bericht: (kennung: string) => request<BerichtDetail>(`/api/v1/berichte/${kennung}`),
  /** Der Entwurf nach der D4-Prüfung, nötigenfalls neu gebildet. */
  berichtEntwurf: (kennung: string) => request<BerichtEntwurf>(`/api/v1/berichte/${kennung}/entwurf`),
  berichtVergleich: (kennung: string, gegen: number) =>
    request<BerichtVergleich>(`/api/v1/berichte/${kennung}/entwurf/vergleich?gegen=${gegen}`),
  /** Gibt genau den gesehenen Entwurf frei (F2); dieselbe Freigabe noch einmal ist derselbe Stand (F5, 200). */
  berichtFreigeben: (kennung: string, entwurfDatenstand: string) =>
    request<BerichtStand>(`/api/v1/berichte/${kennung}/freigeben`, {
      method: 'POST',
      body: JSON.stringify({ entwurf_datenstand: entwurfDatenstand }),
    }),
  berichtStand: (kennung: string, nr: number) => request<BerichtStand>(`/api/v1/berichte/${kennung}/staende/${nr}`),
  /** Verwirft einen offenen Anstoß — die Begründung ist Pflicht (10 bis 500 Zeichen). */
  berichtAnstossVerwerfen: (kennung: string, id: string, begruendung: string) =>
    request<BerichtAnstoss>(`/api/v1/berichte/${kennung}/anstoesse/${id}/verwerfen`, {
      method: 'POST',
      body: JSON.stringify({ begruendung }),
    }),
  berichtArchivieren: (kennung: string) =>
    request<Bericht>(`/api/v1/berichte/${kennung}/archivieren`, { method: 'POST' }),
  /**
   * Welche freigegebenen Berichtsstände eine Strukturänderung an `objekt` mit Wirkung ab `giltAb` träfe
   * (AP-12 IP-9). 403, wenn die Person keinen Bericht lesen darf — die Folgen-Karten zeigen dann nichts.
   */
  berichteBetroffen: (objekt: string, giltAb: string, anlass: BerichtStrukturAnlass) =>
    request<BerichteBetroffen>(
      `/api/v1/berichte/betroffen?${new URLSearchParams({ objekt, gilt_ab: giltAb, anlass }).toString()}`,
    ),
};

/** AP-09 K1/K7: Minutenintervall [von,bis), Parameter bleiben mit der Bindung erhalten. */
export interface BezugsKanalAnfrage {
  entity_id: string; kanal: string; zustand?: string; von: string; raumtemperatur?: number; heizgrenze?: number;
}
export interface BezugsKanalbindung extends BezugsKanalAnfrage {
  id: string; wertart: string; bis: string | null;
}

export interface BezugsKanalAuswahl {
  entity_id: string; komponente: string; kanal: string; name: string; wertart: string; einheit: string;
  erste_messung: string | null; liefert: boolean; zustaende: string[];
}
