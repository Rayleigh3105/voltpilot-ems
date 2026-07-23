/**
 * Cockpit + Live-Daten merge (Option A, `data/vp-cockpit-live-merge-design/
 * report.md` §2/§3): the pure logic of the merged home's "Komponenten im
 * Detail" stratum — the live telemetry window, the ONE freshness chip of the
 * page head, the "Verlauf ▾" disclosure default and the optional board
 * sub-lines fed from the day totals (R2: the retired flow tiles' kWh lines).
 *
 * Pure + framework-free (the `livePuls.ts`/`adaptiveLive.ts` precedent); the
 * render half is `components/KomponentenSection.tsx`.
 */
import type { HistoryTotals } from './api';
import type { LiveState } from './adaptiveLive';
import { energyLabel } from './anlage';
import { fmtRelative } from './format';
import type { LivePulsRow } from './livePuls';

/**
 * The live window of the compact Verlauf chart. R3 (owner Q4): the third
 * window is labelled **„Seit 0 Uhr"**, never „Heute" — the Bilanz period seg
 * (Heute/Monat/Jahr/Gesamt) owns that word, and the two time controls must
 * never share one (two controls, two meanings).
 */
export type LiveWindow = '1h' | '3h' | 'today';

export const LIVE_WINDOWS: { id: LiveWindow; label: string; insight: string }[] = [
  { id: '1h', label: '1 Std', insight: 'in der letzten Stunde' },
  { id: '3h', label: '3 Std', insight: 'in den letzten 3 Stunden' },
  { id: 'today', label: 'Seit 0 Uhr', insight: 'seit 0 Uhr' },
];

/** Start of the fetched telemetry window: now-1h / now-3h / local midnight. */
export function windowStart(win: LiveWindow, now: Date): Date {
  const from = new Date(now);
  if (win === '1h') from.setHours(from.getHours() - 1);
  else if (win === '3h') from.setHours(from.getHours() - 3);
  else from.setHours(0, 0, 0, 0);
  return from;
}

/** The head chip: label + Badge tone. */
export interface LiveChip {
  label: string;
  tone: 'ok' | 'off';
}

/**
 * R4 — ONE freshness truth: the merged home has one head sentence and ONE
 * chip, driven by the existing three-state `adaptiveLive.liveState`.
 *
 * - `live`      — the honest "Stand vor X".
 * - `site-only` — the Anlage delivers, the per-device breakdown does not yet:
 *                 the chip SAYS so (no greying — the values below are real).
 * - `stale`     — "keine aktuellen Daten"; with no known sample at all the
 *                 chip stays away entirely (the status sentence carries the
 *                 story, e.g. "wartet auf erste Daten").
 */
export function liveChip(
  state: LiveState,
  latestTs: string | null | undefined,
  now: Date,
): LiveChip | null {
  const stand = latestTs ? `Stand ${fmtRelative(latestTs, now)}` : null;
  if (state === 'live') return { tone: 'ok', label: stand ?? 'Live' };
  if (state === 'site-only') {
    return {
      tone: 'ok',
      label: stand
        ? `${stand} · einzelne Geräte melden noch nichts`
        : 'Einzelne Geräte melden noch nichts',
    };
  }
  return stand ? { tone: 'off', label: 'keine aktuellen Daten' } : null;
}

/** sessionStorage key remembering the "Verlauf ▾" disclosure (owner Q2). */
export const VERLAUF_OPEN_KEY = 'vp.cockpit.verlaufOpen';

/**
 * The disclosure default: COLLAPSED (owner Q2 — board visible, chart behind
 * "Verlauf ▾"), remembered per session. Only an explicit stored '1' opens it.
 */
export function initialVerlaufOpen(stored: string | null): boolean {
  return stored === '1';
}

/**
 * R2 (optional half): the retired flow tiles' kWh sub-lines move onto the
 * board rows — "32,1 kWh heute" under Erzeugung, the consumed energy under the
 * Haus row. Applied ONLY where the row has no sub-line of its own (a
 * multi-producer "2 Erzeuger" line is never overwritten) and only where the
 * row is unambiguous (the PV role row; the house row identified by key/title —
 * a Wallbox consumer never gets the house total). Absent totals add nothing.
 */
export function withDayTotals(
  rows: LivePulsRow[],
  totals: HistoryTotals | null | undefined,
): LivePulsRow[] {
  if (!totals) return rows;
  const pvKwh = num(totals.pvGenerationKwh);
  const loadKwh = num(totals.consumptionKwh);
  return rows.map((row) => {
    if (row.subLine) return row;
    if (row.role === 'pv' && pvKwh != null) {
      return { ...row, subLine: `${energyLabel(pvKwh)} heute` };
    }
    const isHouse = row.key === 'v1-haus' || row.title === 'Hausverbrauch';
    if (row.role === 'consumer' && isHouse && loadKwh != null) {
      return { ...row, subLine: `${energyLabel(loadKwh)} heute` };
    }
    return row;
  });
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
