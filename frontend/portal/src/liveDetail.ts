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
import type { HistoryTotals, SiteTopology } from './api';
import type { LiveState } from './adaptiveLive';
import type { LiveSnapshot } from './live';
import { energyLabel } from './anlage';
import { standLabel } from './datenAlter';
import { fmtRelative } from './format';
import type { LivePulsRow, TodayLine } from './livePuls';
import { isReportedTotal } from './nodata';

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
 * - `stale`     — "keine aktuellen Daten · Stand: 12:27 Uhr"; with no known
 *                 sample at all the chip stays away entirely (the status
 *                 sentence carries the story, e.g. "wartet auf erste Daten").
 *
 * **Der Daten-Alter-Ausweis im `stale`-Fall (Herzogau 17.08.2026,
 * `datenAlter.ts`):** bis hierher sagte der Chip NUR „keine aktuellen Daten" —
 * die Zahlen darunter blieben trotzdem stehen, und niemand konnte sehen, ob
 * sie zwei Minuten oder fünf Stunden alt waren. Er nennt jetzt den
 * MESSZEITPUNKT, statisch: eine Dauer wäre nur so lange wahr, wie die Seite
 * sie nachrechnet, und genau das tut eine eingefrorene Seite nicht (die
 * PR-279-Lehre, siehe `liveness.ts`). Im frischen Fenster bleibt die knappe
 * relative Form — dort ist sie kurzlebig und nie irreführend.
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
  if (!stand) return null;
  const at = standLabel(latestTs, now);
  return { tone: 'off', label: at ? `keine aktuellen Daten · ${at}` : 'keine aktuellen Daten' };
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
 * Die uniforme HEUTE-Spalte des Komponenten-Boards (vp-cockpit-unten-ux-n3
 * PR 2 — die K2-Heilung: EINE Grammatik statt vier Unterzeilen-Bedeutungen).
 * Gefüllt wird nur, was die Tages-Summen BERICHTEN:
 *
 * - PV → erzeugte kWh; Haus (per key/title identifiziert — eine Wallbox
 *   bekommt nie die Haus-Summe) → verbrauchte kWh;
 * - Netz → BEIDE Richtungen als eigene Zeilen (↓ Einspeisung / ↑ Bezug),
 *   jede nur, wenn ihr Kanal berichtet ist;
 * - Speicher/Verbraucher → null („—"): ihre Tages-Energie steht nicht in den
 *   `HistoryTotals`, und eine Spalte ohne Quelle bleibt ehrlich leer.
 *
 * **V2 (Audit), fortgeschrieben:** ein 0-Summen-Total gilt weiter als NICHT
 * BERICHTET (`nodata.isReportedTotal`) — nie eine gedruckte 0,0 kWh ohne
 * Beleg. Der zweite alte Guard (kein Tageswert neben „noch keine Daten")
 * ist mit der Grammatik OBSOLET: der Widerspruch entstand, weil beide
 * Aussagen in EINER Zeile klebten; jetzt sind „jetzt" (Wert-Zeile) und
 * „heute" (eigene Spalte) getrennt beschriftet, und eine real gemessene
 * Tagessumme neben einem gerade stummen Gerät ist zwei wahre Antworten auf
 * zwei benannte Fragen.
 */
export function withDayTotals(
  rows: LivePulsRow[],
  totals: HistoryTotals | null | undefined,
): LivePulsRow[] {
  if (!totals) return rows;
  const pvKwh = isReportedTotal(totals.pvGenerationKwh) ? totals.pvGenerationKwh : null;
  const loadKwh = isReportedTotal(totals.consumptionKwh) ? totals.consumptionKwh : null;
  const exportKwh = isReportedTotal(totals.gridExportKwh) ? totals.gridExportKwh : null;
  const importKwh = isReportedTotal(totals.gridImportKwh) ? totals.gridImportKwh : null;
  return rows.map((row) => {
    if (row.role === 'pv' && pvKwh != null) {
      return { ...row, today: [{ text: energyLabel(pvKwh) }] };
    }
    const isHouse = row.key === 'v1-haus' || row.title === 'Hausverbrauch';
    if (row.role === 'consumer' && isHouse && loadKwh != null) {
      return { ...row, today: [{ text: energyLabel(loadKwh) }] };
    }
    if (row.role === 'grid') {
      const lines: TodayLine[] = [];
      if (exportKwh != null) {
        lines.push({ text: energyLabel(exportKwh), arrow: 'down', word: 'Einspeisung' });
      }
      if (importKwh != null) {
        lines.push({ text: energyLabel(importKwh), arrow: 'up', word: 'Bezug' });
      }
      if (lines.length > 0) return { ...row, today: lines };
    }
    return row;
  });
}

/**
 * V14 (Audit) — hat der Energiefluss ÜBERHAUPT einen Wert?
 *
 * Bei schweigendem Gerät zeichnete der Hero ~450 px vier „—"-Knoten und
 * beherrschte damit den ersten Bildschirm, während die eigentliche Anweisung
 * („Ihr Gerät meldet sich nicht …") als kleine graue Zeile darüber stand. Wenn
 * NICHTS zu zeigen ist, wird das Diagramm eingeklappt und der Weg nach vorn
 * bekommt den Platz. Prüft beide Quellen der zusammengeführten Startseite: die
 * v2-Topologie (migriert) und den v1-Snapshot.
 */
export function flowHasValues(
  topology: SiteTopology | null | undefined,
  snapshot: LiveSnapshot | null | undefined,
): boolean {
  if (topology) {
    return topology.topology.nodes.some(
      (n) =>
        n.value_kw != null ||
        n.soc_pct != null ||
        n.members.some((m) => m.value_kw != null),
    );
  }
  if (!snapshot) return false;
  return (
    snapshot.pvKw != null ||
    snapshot.loadKw != null ||
    snapshot.gridKw != null ||
    snapshot.socPct != null
  );
}

/**
 * **Die Kopfsatz-Regel der Bühne** (Konzept `vp-cockpit-konzept-f4` §6.2).
 *
 * Der Prosa-Satz im Seitenkopf las im Normalfall genau die drei Zahlen vor, die
 * 100 px tiefer an den Knoten des Energieflusses stehen („erzeugt 38,1 kW, die
 * Batterie lädt (93 %), 30,0 kW fließen ins Netz") — zwei Zeilen Premium-Fläche
 * für eine Doppelung, und der Kunde liest dieselbe Aussage zweimal.
 *
 * Der Satz wird deshalb **nicht abgeschafft, er bekommt eine Aufgabe**: er
 * erscheint genau dann, wenn er etwas anderes sagt als das Diagramm.
 *
 *  - `tone !== 'ok'` — Warnung, stilles Gerät, „wartet auf erste Daten", und
 *    ebenso der Lade-/Fehler-Zustand (dann gibt es gar keinen Ton): der Satz
 *    trägt eine Ursache, die kein Kreis zeigt.
 *  - **kein zeichenbarer Fluss** (`flowHasValues` false) — dann ersetzt die
 *    Handlungsanweisung das Diagramm, und der Satz ist die einzige Aussage.
 *  - **nicht der projizierte Pfad** — das v1-Zonen-Dashboard und der
 *    Einrichtungspfad (M5) bleiben unangetastet (das v1-Invariant).
 *
 * Rein, damit beide Richtungen der Regel unit-getestet sind statt im JSX zu
 * verschwinden.
 */
export function headSentenceVisible(input: {
  /** true = die Bühne (projiziertes Cockpit) rendert gerade. */
  projected: boolean;
  /** Der Ton des komponierten Satzes; null/undefined = noch keiner da. */
  tone?: 'ok' | 'warn' | 'off' | null;
  /** Hat der Energiefluss überhaupt einen Wert (`flowHasValues`)? */
  hasFlow: boolean;
}): boolean {
  if (!input.projected) return true;
  if (!input.hasFlow) return true;
  return input.tone !== 'ok';
}
