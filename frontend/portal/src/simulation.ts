/**
 * Ersparnis-Simulation: types for the async job document (the simulation
 * service's German-keyed result contract, relayed 1:1 by the api) and ALL
 * display derivation - headline sentence, scenario cards, Netzladen line,
 * chart data, footnote. Pure and unit-tested (simulation.test.ts); the
 * components only render what this module builds.
 *
 * Captain framing (2026-07-16, binding): the simulation is an OPERATOR
 * instrument, not a hard-sell tool. The headline is "Speicher + VoltPilot
 * gegenüber ohne Speicher" (the big honest number), the 3-way breakdown
 * stays fully visible, and the Netzladen variant is one calm potential line
 * - sign-honest in every direction, never overselling, never hiding.
 */
import { eurAmount, fmtNum } from './format';

// ---------------------------------------------------------------------------
// Job document types (mirror services/optimization simulation/runner.py)
// ---------------------------------------------------------------------------

export interface SimulationMonat {
  monat: string; // "2025-07"
  kostenEur: number;
  wearEur: number;
  importKwh: number;
  exportKwh: number;
}

export interface SimulationScenario {
  kostenEur: number;
  importKwh: number;
  exportKwh: number;
  monatlich: SimulationMonat[];
  // battery scenarios only:
  wearEur?: number;
  nettoKostenEur?: number;
  vollzyklen?: number | null;
  eigenverbrauchsquotePct?: number | null;
  autarkiegradPct?: number | null;
  abgeregeltKwh?: number;
}

export interface SimulationHeadline {
  gesamtVorteilEur: number;
  gesamtVorteilNettoEur: number;
  speicherVorteilEur: number;
  voltpilotVorteilEur: number;
  voltpilotVorteilNettoEur: number;
}

export interface SweepEntry {
  capacityKwh: number;
  gesamtVorteilEur: number;
  voltpilotVorteilEur: number;
  istBasisgroesse: boolean;
}

export interface NetzladenVariante {
  kostenEur: number;
  wearEur: number;
  nettoKostenEur: number;
  vollzyklen: number | null;
  abgeregeltKwh: number;
  zusatzVorteilNettoEur: number;
}

export interface BeispielSlot {
  start: string;
  preisEurMwh: number;
  loadKw: number;
  pvKw: number;
  socVoltpilotKwh: number;
  socStandardKwh: number;
  batterieVoltpilotKw: number;
  batterieStandardKw: number;
}

export interface BeispielTag {
  datum: string; // "2025-11-12"
  vorteilEur: number;
  slots: BeispielSlot[];
}

export interface SimulationAnnahmen {
  preisjahr: string;
  zone: string;
  wetter: string;
  profil: string;
  wearCtKwh?: number;
  hinweis: string;
  fehlendeMarktwertMonate?: string[];
}

export interface SimulationResult {
  scenarios: {
    ohneSpeicher?: SimulationScenario;
    standardSpeicher?: SimulationScenario;
    voltpilot?: SimulationScenario;
  };
  headline: SimulationHeadline | null;
  sizeSweep: SweepEntry[];
  netzladenVariante: NetzladenVariante | null;
  beispielTage: { typisch: BeispielTag; bester: BeispielTag } | null;
  annahmen: SimulationAnnahmen;
}

export interface SimulationStatus {
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  result?: SimulationResult;
  error?: string;
}

/** The what-if request the api merges over the site's master data. */
export interface SimulationRequestInput {
  year?: number;
  zone?: string;
  plant?: {
    pvKwp?: number;
    latitude?: number;
    longitude?: number;
    azimuthDeg?: number;
    tiltDeg?: number;
  };
  consumption?: { annualKwh?: number; profile?: string };
  tariff?: {
    plantKind?: string;
    tarifArt?: string;
    tarifParamCtKwh?: number;
    anzulegenderWertCtKwh?: number;
    commissionedOn?: string;
    netzladenErlaubt?: boolean;
  };
  battery?: {
    capacityKwh?: number;
    maxChargeKw?: number;
    maxDischargeKw?: number;
    roundtripEfficiencyPct?: number;
    speicherschonung?: string;
  };
  sizeSweep?: number[];
}

// ---------------------------------------------------------------------------
// Display derivation
// ---------------------------------------------------------------------------

/** Rounded euro with sign for "mehr/weniger" phrasing. */
function eur(v: number): string {
  return eurAmount(Math.abs(v));
}

/**
 * The ONE German headline sentence (captain framing: the big honest number is
 * Speicher + VoltPilot vs. ohne Speicher; the VoltPilot-vs-Standard share is
 * named honestly even when it is small or negative). Uses the NET figures
 * (incl. Speicherverschleiß) - the honest currency.
 */
export function headlineSentence(
  headline: SimulationHeadline,
  year: string,
): string {
  const gesamt = headline.gesamtVorteilNettoEur;
  const vp = headline.voltpilotVorteilNettoEur;
  const lead =
    gesamt >= 0
      ? `Im Jahr ${year} hätte Ihre Anlage mit Speicher und VoltPilot ${eur(gesamt)} mehr erwirtschaftet als ohne Speicher`
      : `Im Jahr ${year} hätte Ihre Anlage mit Speicher und VoltPilot ${eur(gesamt)} weniger erwirtschaftet als ohne Speicher`;
  let vpPart: string;
  if (vp > 1) {
    vpPart = ` – davon ${eur(vp)} durch die intelligente VoltPilot-Steuerung gegenüber einem Standard-Speicher.`;
  } else if (vp < -1) {
    vpPart = ` – ein Standard-Speicher hätte in diesem Jahr ${eur(vp)} besser abgeschnitten.`;
  } else {
    vpPart = ' – auf Augenhöhe mit einem Standard-Speicher.';
  }
  return lead + vpPart;
}

/**
 * The calm Netzladen potential line ("Ihr Potenzial mit Netzladen") -
 * sign-honest: for many EEG households Netzladen LOSES money because the
 * Vergütung entfällt, and the line says so plainly.
 */
export function netzladenLine(variante: NetzladenVariante | null): string | null {
  if (variante == null) return null;
  const delta = variante.zusatzVorteilNettoEur;
  if (delta > 1) {
    return `Ihr Potenzial mit Netzladen: zusätzlich +${eur(delta)} pro Jahr, wenn Ihr Speicher auch aus dem Netz laden darf.`;
  }
  if (delta < -1) {
    return `Netzladen würde sich hier nicht lohnen: ${eur(delta)} pro Jahr weniger, weil die EEG-Vergütung für Netzstrom entfällt.`;
  }
  return 'Netzladen würde an Ihrem Ergebnis kaum etwas ändern.';
}

export interface ScenarioCard {
  key: 'ohneSpeicher' | 'standardSpeicher' | 'voltpilot';
  title: string;
  /** Big number: net annual result, revenue-positive framing. */
  amount: string;
  amountLabel: 'Stromkosten' | 'Überschuss';
  /** Small honest sub-lines (wear, cycles, autarky). */
  subLines: string[];
  highlight: boolean;
}

/** The 3 comparison cards (fully visible breakdown, captain framing). */
export function scenarioCards(result: SimulationResult): ScenarioCard[] {
  const cards: ScenarioCard[] = [];
  const meta: Array<[ScenarioCard['key'], string, boolean]> = [
    ['ohneSpeicher', 'Ohne Speicher', false],
    ['standardSpeicher', 'Standard-Speicher', false],
    ['voltpilot', 'Mit VoltPilot', true],
  ];
  for (const [key, title, highlight] of meta) {
    const scenario = result.scenarios[key];
    if (!scenario) continue;
    const netto = scenario.nettoKostenEur ?? scenario.kostenEur;
    const subLines: string[] = [];
    if (scenario.wearEur != null && scenario.wearEur > 0) {
      subLines.push(`inkl. ${eurAmount(scenario.wearEur)} Speicherverschleiß`);
    }
    if (scenario.vollzyklen != null) {
      subLines.push(`${fmtNum(scenario.vollzyklen, 'Vollzyklen', 0)}`);
    }
    if (scenario.autarkiegradPct != null) {
      subLines.push(`Autarkie ${fmtNum(scenario.autarkiegradPct, '%', 0)}`);
    }
    if (scenario.abgeregeltKwh != null && scenario.abgeregeltKwh > 0) {
      subLines.push(`${fmtNum(scenario.abgeregeltKwh, 'kWh', 0)} abgeregelt`);
    }
    cards.push({
      key,
      title,
      amount: eurAmount(Math.abs(netto)),
      amountLabel: netto >= 0 ? 'Stromkosten' : 'Überschuss',
      subLines,
      highlight,
    });
  }
  return cards;
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];

export function monthLabel(monat: string): string {
  const m = Number(monat.slice(5, 7));
  return MONTH_SHORT[m - 1] ?? monat;
}

export interface MonthlyChartData {
  labels: string[];
  /** Monthly NET costs per scenario (aligned with labels; null = not solved yet). */
  ohne: Array<number | null>;
  standard: Array<number | null>;
  voltpilot: Array<number | null>;
}

/**
 * Monthly grouped bars: net cost per scenario and month. While the job is
 * still running, months the VoltPilot chunks have not solved yet show null
 * (the bars fill in as the poll progresses) - detected by an exactly-zero
 * month that the other scenarios priced (a real all-zero month cannot occur
 * with a nonzero load profile).
 */
export function monthlyChartData(result: SimulationResult): MonthlyChartData | null {
  const ohne = result.scenarios.ohneSpeicher;
  const standard = result.scenarios.standardSpeicher;
  const voltpilot = result.scenarios.voltpilot;
  if (!ohne || ohne.monatlich.length === 0) return null;
  const labels = ohne.monatlich.map((m) => monthLabel(m.monat));
  const byMonth = (s: SimulationScenario | undefined): Array<number | null> =>
    ohne.monatlich.map((base) => {
      const row = s?.monatlich.find((m) => m.monat === base.monat);
      if (!row) return null;
      const net = row.kostenEur + row.wearEur;
      if (s !== ohne && net === 0 && base.kostenEur !== 0) return null; // chunk pending
      return Math.round(net * 100) / 100;
    });
  return {
    labels,
    ohne: byMonth(ohne),
    standard: byMonth(standard),
    voltpilot: byMonth(voltpilot),
  };
}

/** Progress copy for the running job ("Monat für Monat wird gerechnet"). */
export function progressLabel(status: SimulationStatus): string {
  if (status.status === 'queued') return 'Simulation wartet …';
  const pct = Math.round((status.progress ?? 0) * 100);
  return `Simulation läuft – ${pct} % gerechnet`;
}

/** The mandatory honest footnote under every result. */
export function assumptionsFootnote(annahmen: SimulationAnnahmen): string {
  const profil =
    annahmen.profil === 'haushalt' ? 'typisches Haushaltsprofil' : annahmen.profil;
  let text =
    `Simulation auf Basis der echten Börsenpreise und Wetterdaten des Jahres ` +
    `${annahmen.preisjahr} an Ihrem Standort, ${profil}. ` +
    'Vergangenheitswerte, keine Zusage künftiger Erträge.';
  if (annahmen.fehlendeMarktwertMonate?.length) {
    text +=
      ' Für einzelne Monate lag kein Monatsmarktwert vor - die Marktprämie fehlt dort.';
  }
  return text;
}

/** Sweep helpers: the Kaufberatungs-Kurve with the base size marked. */
export function sweepChartData(sweep: SweepEntry[]) {
  if (!sweep || sweep.length < 2) return null;
  return {
    sizes: sweep.map((e) => e.capacityKwh),
    gesamt: sweep.map((e) => Math.round(e.gesamtVorteilEur * 100) / 100),
    baseIndex: sweep.findIndex((e) => e.istBasisgroesse),
  };
}

/**
 * One sentence under the sweep curve naming the marginal value ("Ein
 * größerer Speicher brächte kaum noch etwas" vs. "lohnt sich weiter") -
 * comparing the base size against the next larger sweep point.
 */
export function sweepInsight(sweep: SweepEntry[]): string | null {
  const base = sweep.find((e) => e.istBasisgroesse);
  if (!base) return null;
  const larger = sweep
    .filter((e) => e.capacityKwh > base.capacityKwh)
    .sort((a, b) => a.capacityKwh - b.capacityKwh)[0];
  if (!larger) return null;
  const delta = larger.gesamtVorteilEur - base.gesamtVorteilEur;
  const per = `${fmtNum(larger.capacityKwh, 'kWh', 0)}`;
  if (delta > 25) {
    return `Ein größerer Speicher (${per}) brächte noch etwa ${eur(delta)} pro Jahr zusätzlich.`;
  }
  if (delta >= 0) {
    return `Ein größerer Speicher (${per}) brächte kaum noch etwas (+${eur(delta)} pro Jahr) - Ihre Größe liegt im flachen Teil der Kurve.`;
  }
  return `Ein größerer Speicher (${per}) würde sich hier nicht lohnen (${eur(delta)} pro Jahr weniger).`;
}

/** German date for a Beispieltag ("12. November 2025"). */
export function beispielDatum(datum: string): string {
  const [y, m, d] = datum.split('-').map(Number);
  const months = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
    'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  return `${d}. ${months[(m ?? 1) - 1]} ${y}`;
}
