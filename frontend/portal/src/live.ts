/**
 * Live status logic for the Übersicht "Live-Daten" status hero (report direction
 * B). Pure, framework-free, and fully unit-tested: it turns a site's telemetry
 * into the verdict-tile states, the animated energy-flow directions and the one
 * German status sentence - the same mental model the edge device's `:8484`
 * dashboard shows (`dashboard.js` renderKpis / renderFlow), so the customer sees
 * the same picture at home and in the portal.
 *
 * Every threshold + wording is lifted from the edge dashboard (0.05 kW deadband,
 * Lädt/Entlädt/Netzbezug/Einspeisung). Signs never reach the customer - the
 * grid/battery labels flip and the sentence speaks direction words.
 */
import type { TelemetryPoint } from './api';
import { fmtNum } from './format';
import { sanitizeSoc } from './plausible';

/** Below this magnitude a power reading counts as "idle" (edge renderKpis). */
export const DEADBAND_KW = 0.05;

/** The newest live values the hero renders from (built from a telemetry window). */
export interface LiveSnapshot {
  /** PV generation, kW (>= 0). */
  pvKw: number | null;
  /** House load, kW (>= 0). */
  loadKw: number | null;
  /** Grid connection power, kW: + = Bezug (import), - = Einspeisung (export). */
  gridKw: number | null;
  /** Battery power, kW, DERIVED: + = charging, - = discharging (see deriveBatteryKw). */
  battKw: number | null;
  /** Battery state of charge, %, sanitized; may fall back to an older plausible reading. */
  socPct: number | null;
  /** Timestamp of the SoC reading used (to say how old a fallback SoC is). */
  socAt: string | null;
}

/**
 * Battery power derived from the power balance: `battery = grid - load + pv`
 * (i.e. `powerKw - loadKw + pvPowerKw`), the same convention as the edge
 * `internal/history` and the Historie rollup migration. Positive = charging,
 * negative = discharging. Any absent input leaves the battery ABSENT (null),
 * never coerced to 0 - an unknown flow must not read as "idle".
 */
export function deriveBatteryKw(
  pvKw: number | null,
  loadKw: number | null,
  gridKw: number | null,
): number | null {
  if (pvKw == null || loadKw == null || gridKw == null) return null;
  return gridKw - loadKw + pvKw;
}

function lastFinite(
  points: TelemetryPoint[],
  pick: (p: TelemetryPoint) => number | null,
): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = pick(points[i]);
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Collapse a telemetry window into the newest live snapshot. Each channel takes
 * its last finite sample independently (a downsampled bucket may miss one), the
 * battery is derived PER sample then the newest taken, and the SoC is the newest
 * PLAUSIBLE reading (sanitizeSoc) with its own timestamp so the tile can say how
 * old a fallback value is.
 */
export function buildSnapshot(points: TelemetryPoint[]): LiveSnapshot {
  const pvKw = lastFinite(points, (p) => p.pvPowerKw);
  const loadKw = lastFinite(points, (p) => p.loadKw);
  const gridKw = lastFinite(points, (p) => p.powerKw);
  const battKw = lastFinite(points, (p) =>
    deriveBatteryKw(p.pvPowerKw, p.loadKw, p.powerKw),
  );

  let socPct: number | null = null;
  let socAt: string | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const s = sanitizeSoc(points[i].socPct);
    if (s != null) {
      socPct = s;
      socAt = points[i].ts;
      break;
    }
  }
  return { pvKw, loadKw, gridKw, battKw, socPct, socAt };
}

// --- Verdict-tile states -----------------------------------------------------

export type PvState = 'erzeugt' | 'keine' | 'unbekannt';
export function pvState(pvKw: number | null): PvState {
  if (pvKw == null) return 'unbekannt';
  return pvKw > DEADBAND_KW ? 'erzeugt' : 'keine';
}

export type LoadState = 'bedarf' | 'keiner' | 'unbekannt';
export function loadState(loadKw: number | null): LoadState {
  if (loadKw == null) return 'unbekannt';
  return loadKw > DEADBAND_KW ? 'bedarf' : 'keiner';
}

export type BatteryState = 'laedt' | 'entlaedt' | 'voll' | 'bereit' | 'keine';
/** Battery verdict from SoC + derived power (edge renderKpis order of checks). */
export function batteryState(socPct: number | null, battKw: number | null): BatteryState {
  if (socPct == null) return 'keine';
  if (battKw != null && battKw > DEADBAND_KW) return 'laedt';
  if (battKw != null && battKw < -DEADBAND_KW) return 'entlaedt';
  if (socPct >= 99) return 'voll';
  return 'bereit';
}

export type GridState = 'bezug' | 'einspeisung' | 'ausgeglichen' | 'unbekannt';
export function gridState(gridKw: number | null): GridState {
  if (gridKw == null) return 'unbekannt';
  if (gridKw > DEADBAND_KW) return 'bezug';
  if (gridKw < -DEADBAND_KW) return 'einspeisung';
  return 'ausgeglichen';
}

// --- Energy-flow directions --------------------------------------------------

/** One spoke of the flow diagram: whether it flows, which way, and how strong. */
export interface Spoke {
  active: boolean;
  /** true = hub -> node (consumption / export / charge); false = node -> hub. */
  reverse: boolean;
  /** Signed magnitude driving the animated stroke width. */
  magnitude: number;
}

export interface FlowState {
  pv: Spoke;
  load: Spoke;
  grid: Spoke;
  batt: Spoke;
}

/**
 * **Das Tempo einer Speiche aus ihrer Leistung** (Bewegungs-Programm P3,
 * Captain-Entscheid E4 a: „Tempo ∝ Leistung, Ruhe bei Null, Zahlen blenden —
 * sonst nichts"; Konzept `data/vp-motion-konzept-m1/report.md` §5 Zeile G).
 *
 * `clamp(0.45 s, 1.8 s / (1 + kW/2), 1.8 s)` — die Umlaufdauer EINES
 * Punkt-Zyklus. Weniger Dauer = schnellere Punkte, also erzählt jede Bewegung
 * einen Messwert statt einer Werkseinstellung (heute laufen alle vier Speichen
 * mit denselben 0,9 s, egal ob 0,3 oder 30 kW fliessen).
 *
 * Drei Eigenschaften, alle in `live.test.ts` festgenagelt:
 *
 *  - **monoton**: mehr kW ⇒ nie langsamer. Sonst läse sich ein Anstieg als
 *    Rückgang.
 *  - **gedeckelt in BEIDE Richtungen**: 0,45 s ist die Grenze, ab der ein
 *    Punktband nur noch flimmert; 1,8 s ist das Ruhetempo, das die Login-Bühne
 *    teilt (eine Uhr, §6).
 *  - **vorzeichenblind**: die Richtung sagt `Spoke.reverse`, nicht das Tempo.
 *
 * ⚠ **RUHE BEI NULL STEHT NICHT HIER.** Unter {@link DEADBAND_KW} ist die
 *   Speiche gar nicht aktiv ({@link flowState}), und eine inaktive Speiche
 *   zeichnet keine Punktlinie — sie ist damit still UND ausgeblendet, ohne dass
 *   das Tempo davon wissen müsste. Diese Funktion beantwortet genau eine Frage:
 *   wie schnell, wenn überhaupt.
 *
 * @param kW Leistung der Speiche (Vorzeichen egal); nicht endlich ⇒ Ruhetempo.
 * @returns Umlaufdauer in SEKUNDEN (CSS-Konvention der Animation).
 */
export const FLOW_TEMPO_FAST_S = 0.45;
export const FLOW_TEMPO_SLOW_S = 1.8;
export function flowTempo(kW: number): number {
  if (!Number.isFinite(kW)) return FLOW_TEMPO_SLOW_S;
  const raw = FLOW_TEMPO_SLOW_S / (1 + Math.abs(kW) / 2);
  return Math.min(FLOW_TEMPO_SLOW_S, Math.max(FLOW_TEMPO_FAST_S, raw));
}

/**
 * Flow directions for the four spokes, mirroring the edge `renderFlow`/setSpoke:
 * PV always flows into the hub (generation), Haus always draws from it, Netz
 * reverses on export (grid < 0), Batterie reverses on charge (batt > 0).
 */
export function flowState(snap: LiveSnapshot): FlowState {
  const spoke = (v: number | null, reverse: boolean): Spoke => ({
    active: v != null && Math.abs(v) > DEADBAND_KW,
    reverse,
    magnitude: v ?? 0,
  });
  return {
    pv: spoke(snap.pvKw, false),
    load: spoke(snap.loadKw, true),
    grid: spoke(snap.gridKw, snap.gridKw != null && snap.gridKw < 0),
    batt: spoke(snap.battKw, snap.battKw != null && snap.battKw > 0),
  };
}

// --- Status sentence ---------------------------------------------------------

export interface StatusSentence {
  text: string;
  /** false = stale/offline: the sentence renders honest-grey and shows last-known values. */
  live: boolean;
}

/**
 * The one plain-German "toddler-simple" answer above the tiles, composed from
 * the live snapshot: PV lead, then the battery clause, then the grid clause -
 * each honest about absent data and speaking direction words, never signs. When
 * the data is not fresh the sentence goes honest-grey and says so.
 */
export function composeStatusSentence(snap: LiveSnapshot, fresh: boolean): StatusSentence {
  if (!fresh) {
    return {
      live: false,
      text: 'Ihre Anlage meldet gerade keine aktuellen Daten. Angezeigt werden die zuletzt bekannten Werte.',
    };
  }

  const parts: string[] = [];
  const soc = snap.socPct != null ? ` (${fmtNum(snap.socPct, '%', 0)})` : '';

  // PV lead.
  if (snap.pvKw != null) {
    parts.push(
      snap.pvKw > DEADBAND_KW
        ? `Ihre Anlage erzeugt gerade ${fmtNum(snap.pvKw, 'kW')}.`
        : 'Ihre Anlage erzeugt gerade keinen Strom.',
    );
  }

  // Battery.
  switch (batteryState(snap.socPct, snap.battKw)) {
    case 'laedt':
      parts.push(`Die Batterie lädt${soc}.`);
      break;
    case 'entlaedt':
      parts.push(`Die Batterie entlädt${soc}.`);
      break;
    case 'voll':
      parts.push(`Die Batterie ist voll geladen${soc}.`);
      break;
    case 'bereit':
      parts.push(`Die Batterie ruht${soc}.`);
      break;
    case 'keine':
      break;
  }

  // Grid.
  switch (gridState(snap.gridKw)) {
    case 'einspeisung':
      parts.push(`${fmtNum(Math.abs(snap.gridKw as number), 'kW')} fließen ins Netz.`);
      break;
    case 'bezug':
      parts.push(`Sie beziehen ${fmtNum(Math.abs(snap.gridKw as number), 'kW')} aus dem Netz.`);
      break;
    case 'ausgeglichen':
      parts.push('Ihr Netzanschluss ist gerade ausgeglichen.');
      break;
    case 'unbekannt':
      break;
  }

  if (parts.length === 0) return { live: true, text: 'Ihre Anlage liefert gerade Daten.' };
  return { live: true, text: parts.join(' ') };
}
