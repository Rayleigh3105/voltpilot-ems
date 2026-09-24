/**
 * Laden bei Bezug — die reine Ableitung „der Speicher lädt, während das Netz
 * liefert" für das Cockpit (Diagnose `vp-herzogau-laden-bei-bezug-h4` §7 B2,
 * Konzept „Wechselrichter-Eigenregelung" Paket K8).
 *
 * Der belegte Fall (Herzogau, 24.09.2026 17:08): eine Wolke nimmt der Anlage in
 * Sekunden 15 kW PV; der Wechselrichter braucht einen Messtakt (10 s) plus
 * Folgezeit (15–20 s), bis er das Laden absenkt. In dieser Lücke fließt kurz
 * Netzstrom in den Speicher — physikalisch echt, aber kein Fehler. Das Cockpit
 * zeigte „lädt 16,6 kW ✓" neben „8,5 kW Bezug" ohne ein Wort dazu; der Haken
 * (Sollwert bestätigt) las sich wie „so ist es gewollt".
 *
 * Deshalb, EINE Ableitung für Satz und Haken:
 *   - **kurz** (bis {@link LADEN_BEI_BEZUG_KURZ_MS}): der Wolken-Satz — der
 *     Speicher regelt gleich nach;
 *   - **länger**: der Grund. Lädt der Fahrplan bewusst aus dem Netz
 *     (`guenstig_laden`), sagt der Satz das und nennt den Fahrplan-Grund; sonst
 *     bleibt er ursachenfrei und bittet, es im Blick zu behalten — die Cloud
 *     erfindet keine Ursache (die `flowConflict`-Disziplin).
 *   - In BEIDEN Fällen entfällt der Haken hinter „lädt … kW".
 *
 * Ehrlichkeit: unbekannte Werte vergleichen nichts (unbekannt ≠ 0); veraltete
 * Werte behaupten keinen gegenwärtigen Zustand. Die Uhr wird übergeben, nie
 * gelesen.
 */

import type { FlowNode } from './topology';
import type { LiveSnapshot } from './live';
import { LADEN_BEI_BEZUG_FAHRPLAN, LADEN_BEI_BEZUG_WOLKE } from './glossar';

/**
 * Ab diesem Betrag zählen Laden UND Bezug — beide müssen darüber liegen.
 * Zehnmal über dem 0,05-kW-Anzeige-Totband, derselbe Wert wie
 * `FLOW_CONFLICT_MIN_FLOW_KW`: ein paar Zehntel sind Messversatz.
 */
export const LADEN_BEI_BEZUG_MIN_KW = 0.5;

/**
 * Bis zu dieser Dauer ist Laden bei Bezug die Totzeit einer Wolkenkante:
 * Messtakt des Wechselrichters (10 s) + Folgezeit (15–20 s) + das 30-s-Mittel
 * der Cockpit-Zahlen + ein Abruf-Takt des Portals — gut 60 s, mit Reserve 90 s
 * (h4 §7 B2: „kürzer als 60–90 s").
 */
export const LADEN_BEI_BEZUG_KURZ_MS = 90_000;

/** Die zwei Flüsse, die verglichen werden (+ laden, + Bezug; kW). */
export interface LadenBeiBezugFluss {
  battKw: number | null;
  gridKw: number | null;
}

/** Die gezeichneten Knoten → vorzeichenbehaftete Flüsse (Speicher „out" = lädt). */
export function flussAusKnoten(nodes: readonly FlowNode[] | null | undefined): LadenBeiBezugFluss {
  const node = (role: string) => nodes?.find((n) => n.role === role);
  const signed = (n: FlowNode | undefined, plus: 'in' | 'out'): number | null => {
    if (n?.value_kw == null) return null;
    if (!n.flow_active || !n.direction) return 0;
    return n.direction === plus ? n.value_kw : -n.value_kw;
  };
  return {
    // Speicher: „out" zieht vom Knotenpunkt = lädt.
    battKw: signed(node('storage'), 'out'),
    // Netz: „in" liefert an den Knotenpunkt = Bezug.
    gridKw: signed(node('grid'), 'in'),
  };
}

/** Die v1-Anlage ohne Topologie: dieselben zwei Größen aus dem Schnappschuss. */
export function flussAusSnapshot(s: LiveSnapshot | null | undefined): LadenBeiBezugFluss {
  return { battKw: s?.battKw ?? null, gridKw: s?.gridKw ?? null };
}

/** Lädt der Speicher gerade deutlich, während das Netz deutlich liefert? */
export function ladenBeiBezugJetzt(f: LadenBeiBezugFluss, frisch: boolean): boolean {
  if (!frisch || f.battKw == null || f.gridKw == null) return false;
  return f.battKw > LADEN_BEI_BEZUG_MIN_KW && f.gridKw > LADEN_BEI_BEZUG_MIN_KW;
}

/**
 * Seit wann der Zustand ununterbrochen beobachtet wird: bleibt er, bleibt der
 * erste Zeitpunkt; endet er, wird die Uhr gelöscht.
 */
export function ladenBeiBezugSeit(seitMs: number | null, jetzt: boolean, nowMs: number): number | null {
  if (!jetzt) return null;
  return seitMs ?? nowMs;
}

/** Was der Fahrplan für die laufende Viertelstunde sagt (beides optional). */
export interface LadenBeiBezugPlan {
  /** Die Rolle des laufenden Slots (`guenstig_laden` = bewusst aus dem Netz). */
  slotRole?: string | null;
  /** Der Fahrplan-Grund dieses Slots (`slotWhy`), wörtlich. */
  grund?: string | null;
}

export interface LadenBeiBezugView {
  /** `wolke` = kurze Totzeit, `fahrplan` = bewusst geplant, `anhaltend` = ohne belegten Grund. */
  art: 'wolke' | 'fahrplan' | 'anhaltend';
  text: string;
}

function minuten(ms: number): string {
  const m = Math.max(2, Math.round(ms / 60_000));
  return `${m} Minuten`;
}

/**
 * Der Satz, oder `null`, wenn gerade nicht gleichzeitig geladen und bezogen
 * wird. Ein nicht-null Ergebnis entzieht dem Speicherknoten den Haken.
 */
export function ladenBeiBezug(
  seitMs: number | null,
  nowMs: number,
  plan?: LadenBeiBezugPlan | null,
): LadenBeiBezugView | null {
  if (seitMs == null) return null;
  const dauer = Math.max(0, nowMs - seitMs);
  if (dauer <= LADEN_BEI_BEZUG_KURZ_MS) return { art: 'wolke', text: LADEN_BEI_BEZUG_WOLKE };
  const grund = plan?.grund?.trim() || null;
  if (plan?.slotRole === 'guenstig_laden') {
    return { art: 'fahrplan', text: grund ? `${LADEN_BEI_BEZUG_FAHRPLAN} ${grund}` : LADEN_BEI_BEZUG_FAHRPLAN };
  }
  return {
    art: 'anhaltend',
    text: `Der Speicher lädt seit ${minuten(dauer)} auch mit Strom aus dem Netz. Bitte im Blick behalten.`,
  };
}
