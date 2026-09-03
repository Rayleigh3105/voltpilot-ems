/**
 * Customer-facing module surface (captain decisions 2026-07-16, incl. the
 * Lavish-review design update): VoltPilot - not the customer - configures the
 * contract-grade value modules; the customer SEES what is active, what it
 * earns, and what else is available. Surfaced in two places:
 *
 *  - the "Optimierung" Anlage SUBPAGE (`#/anlage/{id}/optimierung`) with one
 *    card per value module + the "Automatisch aktiv" protections row;
 *  - the Anlage-anlegen wizard's "Anwendungen" step ("Wie soll Ihr Speicher
 *    arbeiten?") where the usages are chosen at setup time - changeable later
 *    on the subpage.
 *
 * All copy is German OUTCOME language - the words "Modul", "MILP" or any
 * optimizer-internal vocabulary never appear in customer copy (pinned by
 * moduleSurface.test.ts). The available-but-inactive card carries ONLY calm
 * info text - NO CTA button, no mailto (captain decision 2: Vertrieb läuft
 * persönlich).
 */

import type { PeakShaving, PlantKind, TarifArt } from './api';
import { parseDecimal } from './anlageFlow';
import { eur, eurAmount, fmtNum, NBSP } from './format';
import { speicherschonungLabel } from './speicherschonung';
import type {
  LeistungspreisAbrechnung,
  OptimizerOverrides,
  UpdateOptimizerConfig,
} from './optimizerApi';

/** One value card of the Optimierung surface, fully derived and render-ready. */
export interface ModuleCardView {
  id: 'marktoptimierung' | 'lastspitzenkappung';
  title: string;
  /** Active = VoltPilot runs it for this Anlage; inactive = the honest offer. */
  active: boolean;
  /** Short badge text: "Aktiv" / "Verfügbar". */
  stateLabel: string;
  /** Small line under the head naming who runs it / that it is on offer. */
  managedNote: string | null;
  /** ONE outcome sentence - what this does for the customer. */
  line: string;
  /** Optional read-only detail (preset, configured value, contact hint). */
  subLine: string | null;
}

/** One always-on protection row ("Automatisch aktiv"). */
export interface AutomaticModuleRow {
  title: string;
  /** The one-line outcome. */
  line: string;
  /** The InfoTip detail sentence(s). */
  tip: string;
}

/**
 * "Marktoptimierung" - the always-active core service. The outcome sentence is
 * plant-kind/tariff aware: a Direktvermarktung plant literally SELLS at the
 * exchange; an Eigenverbrauch plant on a dynamic tariff still trades against
 * the same prices but USES the energy itself; a fixed/no-tariff Eigenverbrauch
 * plant gets the solar-shifting story (its value is time-shifted own solar).
 */
export function marktoptimierungCard(
  plantKind: PlantKind,
  tarifArt: TarifArt,
  /** The battery's EFFECTIVE Speicherschonung preset; pass hasBattery=false when the Anlage has no battery. */
  speicherschonung: string | null,
  hasBattery: boolean,
): ModuleCardView {
  return {
    id: 'marktoptimierung',
    title: 'Marktoptimierung',
    active: true,
    stateLabel: 'Aktiv',
    managedNote: null,
    line: marktoptimierungLine(plantKind, tarifArt),
    subLine: hasBattery
      ? `Umgang mit dem Speicher: ${speicherschonungLabel(speicherschonung)}`
      : null,
  };
}

/** The Marktoptimierung outcome sentence alone (reused by the wizard's step). */
export function marktoptimierungLine(plantKind: PlantKind, tarifArt: TarifArt): string {
  if (plantKind === 'direktvermarktung') {
    return 'Ihr Speicher handelt am Strommarkt: günstig laden, teuer verkaufen.';
  }
  if (tarifArt === 'dynamisch') {
    return 'Ihr Speicher handelt am Strommarkt: günstig laden, teuer nutzen.';
  }
  return 'Ihr Speicher verschiebt Ihren Solarstrom dorthin, wo er am meisten wert ist: tagsüber laden, abends nutzen.';
}

/** The plain-text contact hint of an available-but-inactive service (no CTA). */
export const EINRICHTUNG_DURCH_VOLTPILOT = 'Einrichtung durch VoltPilot – sprechen Sie uns an.';

/**
 * "Lastspitzenkappung" - a Tier-2 service VoltPilot sets up per contract.
 * ACTIVE exactly when a positive Leistungspreis is configured; absent (the
 * backend field may not exist yet - sibling task vp-peakshave-core-p1), null,
 * zero or garbage all read as NOT active, so this surface ships independently
 * of the backend field. The inactive card is the honest offer - calm info
 * text only, no button (Vertrieb läuft persönlich).
 */
export function lastspitzenkappungCard(
  leistungspreisEurKw: number | null | undefined,
): ModuleCardView {
  if (isLeistungspreisActive(leistungspreisEurKw)) {
    return {
      id: 'lastspitzenkappung',
      title: 'Lastspitzenkappung',
      active: true,
      stateLabel: 'Aktiv',
      managedNote: 'Von VoltPilot für Sie eingerichtet.',
      line: 'Ihre Batterie kappt die Bezugsspitze Ihres Netzanschlusses und senkt damit Ihren Leistungspreis.',
      subLine: `Leistungspreis: ${eur(leistungspreisEurKw as number)}${NBSP}€/kW`,
    };
  }
  return {
    id: 'lastspitzenkappung',
    title: 'Lastspitzenkappung',
    active: false,
    stateLabel: 'Verfügbar',
    managedNote: 'Verfügbar für Ihre Anlage.',
    line:
      'Für Gewerbe mit Leistungsmessung: die Batterie kappt Ihre Bezugsspitze – ' +
      'oft mehrere tausend Euro Leistungspreis im Jahr.',
    subLine: EINRICHTUNG_DURCH_VOLTPILOT,
  };
}

/** Present-and-positive gate for the (possibly still absent) Leistungspreis field. */
export function isLeistungspreisActive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// --- The PS-4 proof: real numbers on the active Lastspitzenkappung card -----

/**
 * Below this avoided peak the proof reads as noise, not a result (the same
 * 0.05 kW deadband the live surfaces use), so the hero line stays hidden.
 */
const AVOIDED_NOISE_KW = 0.05;

/** "pro Jahr" / "pro Monat" for the configured billing-period kind. */
export function abrechnungLabel(abrechnung: PeakShaving['abrechnung']): string {
  return abrechnung === 'monat' ? 'pro Monat' : 'pro Jahr';
}

/**
 * The ONE German sentence explaining the counterfactual behind the avoided
 * peak (rendered as the InfoTip on both surfaces).
 */
export function peakCounterfactualTip(peak: PeakShaving): string {
  return (
    'Verglichen wird die höchste Viertelstunden-Bezugsspitze der laufenden ' +
    'Abrechnungsperiode mit derselben Anlage ohne Speichereinsatz; die ' +
    `Ersparnis ist die vermiedene Spitze × Leistungspreis (${eur(peak.leistungspreisEurKw)}${NBSP}€/kW ` +
    `${abrechnungLabel(peak.abrechnung)}) und gilt, solange die Spitze bis zum Periodenende gehalten wird.`
  );
}

/**
 * EINE Abrechnungsperiode der Lastspitzen-Fläche, blätterbar (Paket P1, V3).
 *
 * ⚠ **Der Zeitraum dieses Reiters ist die ABRECHNUNGSPERIODE, nicht Tag/Woche/
 * Monat** (§4.4): der Leistungspreis wird je Periode abgerechnet, alles andere
 * wäre ein Segment ohne Bedeutung. Deshalb trägt die Leiste hier einen
 * Blätterer und KEIN Segment.
 */
export interface LastspitzenPeriode {
  /** Erster Berliner Tag der Periode (ISO). */
  start: string;
  /** „Abrechnungsjahr 2026" bzw. „Abrechnung September 2026". */
  label: string;
  peakKw: number | null;
  avoidedKw: number | null;
  avoidedEur: number | null;
  /** Die LAUFENDE Periode — die einzige, für die es einen Fahrplan gibt. */
  laufend: boolean;
}

/**
 * Die blätterbaren Perioden, ÄLTESTE zuerst (wie `peak.history`).
 *
 * ⚠ **Es entsteht kein neuer Abruf.** `peak.history` trägt die letzten zwölf
 * gemessenen Perioden EINSCHLIESSLICH der laufenden; einen Endpunkt für den
 * Beweis einer VERGANGENEN Periode gibt es nicht — es gäbe also gar keine
 * andere ehrliche Quelle.
 *
 * ⚠ Für die LAUFENDE Periode gewinnen die Kopf-Felder von `peak`
 * (`peakKw`/`avoidedKw`/`avoidedEur`): sie sind der Stand von JETZT, während
 * die Historien-Zeile ihr Abbild ist. Sie können sich nur unterscheiden, wenn
 * beide aus verschiedenen Momenten stammen — dann ist der Kopf der jüngere.
 *
 * Eine Anlage ohne eine einzige gemessene Periode bekommt trotzdem einen
 * Eintrag: den laufenden, mit den ehrlichen `null`-Werten des Kopfes. Ohne ihn
 * hätte die Leiste nichts zu beschriften.
 */
export function lastspitzenPerioden(
  peak: PeakShaving | null | undefined,
): LastspitzenPeriode[] {
  if (peak == null) return [];
  const perioden: LastspitzenPeriode[] = peak.history.map((h) => ({
    start: h.periodStart,
    label: periodenLabel(h.periodStart, peak.abrechnung),
    peakKw: h.peakKw,
    avoidedKw: h.avoidedKw,
    avoidedEur: h.avoidedEur,
    laufend: h.periodStart === peak.periodStart,
  }));
  const laufend = perioden.find((p) => p.laufend);
  if (laufend) {
    laufend.peakKw = peak.peakKw;
    laufend.avoidedKw = peak.avoidedKw;
    laufend.avoidedEur = peak.avoidedEur;
    return perioden;
  }
  return [
    ...perioden,
    {
      start: peak.periodStart,
      label: periodenLabel(peak.periodStart, peak.abrechnung),
      peakKw: peak.peakKw,
      avoidedKw: peak.avoidedKw,
      avoidedEur: peak.avoidedEur,
      laufend: true,
    },
  ];
}

/**
 * Die Beschriftung EINER Periode im Blätterer. Sie nennt die ART der
 * Abrechnung mit — „2026" allein sagt nicht, ob das ein Jahr oder ein Monat
 * ist, und beide kommen im Feld vor.
 */
export function periodenLabel(
  periodStart: string,
  abrechnung: PeakShaving['abrechnung'],
): string {
  const d = new Date(`${periodStart}T12:00:00`);
  if (Number.isNaN(d.getTime())) return periodStart;
  if (abrechnung === 'monat') {
    return `Abrechnung ${d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}`;
  }
  return `Abrechnungsjahr ${d.getFullYear()}`;
}

/** The proof numbers of the ACTIVE Lastspitzenkappung card, render-ready. */
export interface LastspitzenProof {
  /**
   * Label/value pairs; empty while the running period has no measurement.
   * The "Vermiedene Spitze" row carries the counterfactual InfoTip sentence.
   */
  rows: { label: string; value: string; tip?: string }[];
  /** Calm note instead of rows when nothing is measured yet; null otherwise. */
  note: string | null;
}

/**
 * Derive the card's proof rows from the earnings response's peakShaving
 * block. Null when the block is absent (module inactive, or an older backend
 * without the field) - the card then stays as it was. A module site whose
 * RUNNING period has no measured import bucket yet gets the honest note
 * instead of fabricated zeros.
 */
export function lastspitzenProof(peak: PeakShaving | null | undefined): LastspitzenProof | null {
  if (peak == null) return null;
  if (peak.peakKw == null || peak.avoidedKw == null || peak.avoidedEur == null) {
    return {
      rows: [],
      note: 'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.',
    };
  }
  return {
    rows: [
      { label: 'Gehaltene Spitze diese Periode', value: fmtNum(peak.peakKw, 'kW') },
      {
        label: 'Vermiedene Spitze',
        value: fmtNum(peak.avoidedKw, 'kW'),
        tip: peakCounterfactualTip(peak),
      },
      {
        label: 'Ersparte Leistungskosten',
        value: `${peak.avoidedEur >= 0 ? '+' : ''}${eurAmount(peak.avoidedEur)}`,
      },
    ],
    note: null,
  };
}

/**
 * The ONE calm money-hero line of a peak site: "Vermiedene Lastspitze:
 * X kW × Y €/kW = Z €". Null when there is nothing meaningful to show - no
 * module, no measurement yet, or an avoided peak below the noise deadband
 * (the Optimierung card still shows the honest small numbers; the hero only
 * carries a real result).
 */
export function vermiedeneSpitzeLine(
  peak: PeakShaving | null | undefined,
): { label: string; value: string; tip: string } | null {
  if (peak == null || peak.avoidedKw == null || peak.avoidedEur == null) return null;
  if (peak.avoidedKw <= AVOIDED_NOISE_KW) return null;
  return {
    label: 'Vermiedene Lastspitze',
    value:
      `${fmtNum(peak.avoidedKw, 'kW')} × ${eur(peak.leistungspreisEurKw)}${NBSP}€/kW` +
      ` = ${eurAmount(peak.avoidedEur)}`,
    tip: peakCounterfactualTip(peak),
  };
}

/**
 * Tier 3 - always-on protections the system applies automatically. One line
 * each; the tip carries the detail behind an InfoTip.
 */
export const AUTOMATIC_MODULES: AutomaticModuleRow[] = [
  {
    title: '§ 14a-Schutz',
    line: 'Vorgaben Ihres Netzbetreibers werden automatisch eingehalten.',
    tip:
      'Wenn Ihr Netzbetreiber die Leistung am Netzanschluss vorübergehend begrenzt ' +
      '(§ 14a EnWG), hält Ihre Anlage diese Grenze von selbst ein – Sie müssen nichts tun.',
  },
  {
    title: 'Negativpreis-Abregelung',
    line: 'Bei negativen Börsenpreisen wird die Einspeisung automatisch begrenzt.',
    tip:
      'Ist Strom an der Börse zeitweise weniger als nichts wert, würde das Einspeisen ' +
      'Geld kosten. VoltPilot begrenzt die Einspeisung dann automatisch, bis sich ' +
      'Einspeisen wieder lohnt.',
  },
];

/** The subpage's intro sentence (who configures, what the customer sees). */
export const OPTIMIERUNG_INTRO =
  'Diese Leistungen richtet VoltPilot für Sie ein – hier sehen Sie, was aktiv ist und was es bewirkt.';

// --- The wizard's Anwendungen step ------------------------------------------

/** What a plain customer sees after selecting Lastspitzenkappung as intent. */
export const LASTSPITZEN_CUSTOMER_INFO =
  'Richten wir gemeinsam mit Ihnen ein – Einrichtung durch VoltPilot.';

// --- Admin contract fields (Lastspitzenkappung, optimizer-config) -----------

/**
 * Whether the admin optimizer-config already carries the peak-shaving contract
 * fields (the sibling backend task adds them). Probed on the GET response so
 * this frontend ships independently: absent fields simply hide the admin
 * editing block - nothing is guessed into a PUT the backend cannot hold.
 */
export function supportsLastspitzenConfig(
  overrides: OptimizerOverrides | null | undefined,
): boolean {
  return overrides != null && 'leistungspreisEurKw' in overrides;
}

export interface LastspitzenFormValue {
  leistungspreisEurKw: number;
  leistungspreisAbrechnung: LeistungspreisAbrechnung;
  lastspitzenReserveKw: number | null;
}

export type LastspitzenFormResult =
  | { ok: true; value: LastspitzenFormValue }
  | { ok: false; error: string };

/**
 * Validate the admin contract fields (German comma decimals accepted):
 * Leistungspreis is required and positive, the optional Reserve must be >= 0.
 */
export function parseLastspitzenForm(input: {
  leistungspreis: string;
  abrechnung: LeistungspreisAbrechnung;
  reserve: string;
}): LastspitzenFormResult {
  const lp = parseDecimal(input.leistungspreis);
  if (lp == null || lp <= 0) {
    return { ok: false, error: 'Bitte geben Sie den Leistungspreis als positive Zahl an (€/kW).' };
  }
  const reserve = input.reserve.trim() === '' ? null : parseDecimal(input.reserve);
  if (input.reserve.trim() !== '' && (reserve == null || reserve < 0)) {
    return { ok: false, error: 'Die Reserve muss eine Zahl ab 0 kW sein.' };
  }
  return {
    ok: true,
    value: {
      leistungspreisEurKw: lp,
      leistungspreisAbrechnung: input.abrechnung,
      lastspitzenReserveKw: reserve,
    },
  };
}

/**
 * Build the full-representation optimizer-config PUT body: the RECEIVED
 * overrides are spread through unchanged (a full-representation PUT with an
 * absent field would CLEAR that override), then the peak-shaving fields are
 * set - or cleared with `null` when deactivating.
 */
export function buildLastspitzenUpdate(
  overrides: OptimizerOverrides,
  value: LastspitzenFormValue | null,
): UpdateOptimizerConfig {
  return {
    ...overrides,
    leistungspreisEurKw: value?.leistungspreisEurKw ?? null,
    leistungspreisAbrechnung: value?.leistungspreisAbrechnung ?? null,
    lastspitzenReserveKw: value?.lastspitzenReserveKw ?? null,
  };
}
