/**
 * Cockpit-Kachel → Absprung-Ziel (design `data/vp-portal-livedata-design/report.md`
 * §1 „Cockpit → explorer jump" + §4 V2; verschlankt durch den Cockpit+Live-Merge,
 * Option A: `data/vp-cockpit-live-merge-design/report.md` §6 M2).
 *
 * „Eine Kachel ist ein Absprung": ein Tipp navigiert, es gibt kein Modal mehr.
 * Seit dem Merge sind die vier FLUSS-Kacheln (Erzeugung/Speicher/Haus/Netz)
 * aus dem Raster genommen — das Komponenten-Board im Cockpit ist die EINE
 * Live-Wert-Fläche (R2), und dessen Zeilen springen selbst in den Explorer
 * (`verlaufHash` + `verlaufRangeForCockpit`). Übrig bleiben die Geld-/Modus-
 * Kacheln, die per Tabelle auf ihre Zielseite abbilden.
 *
 * Die Abbildung (report §1):
 *   Eigenverbrauch/Erlöse → Historie · Bilanz
 *   Handel     → Fahrplan · Lastspitze → Lastspitzen · Automatik → Steuerung ·
 *   Wetter     → Wetter
 */
import type { EarningsRange } from './api';
import type { AnlagenSub } from './nav';
import type { VerlaufRange } from './verlauf';
import type { WidgetId } from './cockpitWidgets';

/** Wohin eine Kachel springt: seit dem Merge immer eine Seite. */
export type WidgetTarget = { kind: 'sub'; sub: AnlagenSub };

/** Die Geld-/Modus-Kacheln bilden fest auf ihre bestehende Zielseite ab. */
const SUB_TARGETS: Record<WidgetId, AnlagenSub> = {
  ladebudget: 'ladevorgaenge',
  eigenverbrauch: 'messwerte',
  erloes: 'erloese',
  handel: 'fahrplan',
  lastspitze: 'lastspitzen',
  automatik: 'steuerung',
  wetter: 'wetter',
};

/** Das Absprung-Ziel einer Kachel. */
export function widgetTarget(id: WidgetId): WidgetTarget {
  return { kind: 'sub', sub: SUB_TARGETS[id] };
}

/**
 * Zeitraum-Übernahme aus dem Cockpit-Tab (`EarningsRange`) in den Explorer-
 * Zeitraum (`VerlaufRange`/`HistoryRange`): Heute→Tag, Monat→Monat, Jahr→Jahr,
 * **Gesamt→Jahr** (der Explorer hat keinen All-Zeit-Bereich; der `historyRange
 * ForCockpit`-Präzedenzfall, hier aber „Gesamt" auf Jahr statt auf null).
 * Seit dem Merge tragen die KOMPONENTEN-BOARD-Zeilen diese Übernahme in jeden
 * „Verlauf →"-Sprung (die frühere Fluss-Kachel-Regel, unverändert).
 */
export function verlaufRangeForCockpit(range: EarningsRange): VerlaufRange {
  switch (range) {
    case 'day':
      return 'day';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return 'year';
  }
}
