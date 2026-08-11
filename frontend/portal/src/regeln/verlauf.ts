/**
 * Das REGEL-PROTOKOLL an der Fläche (Einheitsmodell Stufe 5b, Konzept
 * `vp-komponenten-einheit-h2` Teil 5b.6) — die drei Aussagen, die der
 * Verlaufsspeicher trägt:
 *
 *  1. die **Zähler-Zeile** an der Karte („heute 3× geschaltet · zuletzt 14:02"),
 *  2. der **Ausschnitt** im Detail-Einschub („Verlauf dieser Regel"),
 *  3. das **kompakte Gesamt-Protokoll** unter der Liste.
 *
 * **Es wird hier NICHTS abgeleitet, was der Server nicht belegt.** Der Zähler
 * kommt fertig aus `switchedToday` — ist er `null`, hat der Speicher den
 * heutigen Tag nicht ganz gesehen, und die Zeile sagt das („seit HH:MM
 * aufgezeichnet") statt eine 0 zu behaupten. Diese Entscheidung fällt einseitig
 * im Backend; das Portal kann den Zähler damit gar nicht erfinden.
 *
 * Die Ereignis-WÖRTER sind die schon gepinnten Vokabulare: Zustände und Gründe
 * gehen durch `consumers/status.ts`. **Ein Wort, das dieser Portal-Stand nicht
 * kennt, erzeugt KEINE Zeile** — geraten wird nie (die Regel, mit der schon der
 * Ingest ein unbekanntes Wort verwirft).
 *
 * PURE + unit-getestet (`verlauf.test.ts`).
 */
import { fmtNum } from '../format';
import { CONSUMER_REASON_TEXT, CONSUMER_STATE_TEXT } from '../consumers/status';
import type { RuleEvent, RuleEvents } from '../api';
import type { RegelAbschnitt } from './detail';

/** Der Wohnort des Verlaufs, solange für diese Anlage noch nichts vorliegt. */
export const VERLAUF_LEER = 'Für diese Regel wurde noch kein Wechsel aufgezeichnet.';

/** Die Genauigkeit gehört AN die Fläche, nicht ins Kleingedruckte. */
export function genauigkeitsNote(accuracySeconds: number | null | undefined): string | null {
  if (accuracySeconds == null || !Number.isFinite(accuracySeconds) || accuracySeconds <= 0) {
    return null;
  }
  return `Aufgezeichnet im ${accuracySeconds}-Sekunden-Takt Ihres Geräts — `
    + 'ein Wechsel und zurück dazwischen bleibt unsichtbar.';
}

/** „14:02" in der Zeit des Betrachters. */
export function uhrzeit(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Der Kartenschlüssel, unter dem eine Regel ihre Ereignisse findet. */
export function karteSchluessel(kind: string | null, ref: string | null): string | null {
  if (!kind || !ref) return null;
  if (kind === 'rezept') return `rezept:${ref}`;
  if (kind === 'flow') return `flow:${ref}`;
  return null;
}

// ---------------------------------------------------------------------------
// 1 · Die Zähler-Zeile an der Karte
// ---------------------------------------------------------------------------

/**
 * „heute 3× geschaltet · zuletzt 14:02".
 *
 * Vier Fälle, und keiner behauptet etwas Unbelegtes:
 *  - der Server hat gezählt → der Zähler steht da (auch die ehrliche 0),
 *  - die Regel hat noch NIE ein Ereignis erzeugt und der Tag ist zählbar
 *    (`countsToday`) → ebenfalls die ehrliche 0,
 *  - nicht zählbar, aber wir wissen, seit wann aufgezeichnet wird →
 *    „seit HH:MM aufgezeichnet",
 *  - gar nichts davon → gar keine Zeile.
 */
export function aktivitaetZeile(
  aktivitaet: { switchedToday?: number | null; lastSwitchedAt?: string | null } | null | undefined,
  recordingSince: string | null | undefined,
  countsToday = false,
): string | null {
  const teile: string[] = [];
  const n = aktivitaet?.switchedToday;
  if (n != null && Number.isFinite(n)) {
    teile.push(n === 1 ? 'heute 1× geschaltet'
      : n === 0 ? 'heute noch nicht geschaltet' : `heute ${n}× geschaltet`);
  } else if (aktivitaet == null && countsToday) {
    // Eine Regel ohne ein einziges Ereignis steht gar nicht in `rules` - aber
    // der Server sagt, dass der Tag zählbar IST, also ist die 0 belegt.
    teile.push('heute noch nicht geschaltet');
  } else {
    const seit = uhrzeit(recordingSince);
    // Ohne belastbaren Zähler ist der Beginn der Aufzeichnung die einzige
    // ehrliche Aussage - und ohne ihn gibt es gar keine.
    if (!seit) return null;
    teile.push(`seit ${seit} aufgezeichnet`);
  }
  const zuletzt = uhrzeit(aktivitaet?.lastSwitchedAt);
  if (zuletzt) teile.push(`zuletzt ${zuletzt}`);
  return teile.join(' · ');
}

// ---------------------------------------------------------------------------
// 2 · Die Ereignis-Zeile
// ---------------------------------------------------------------------------

const KIND_TEXT: Record<string, string> = {
  gestartet: 'gestartet',
  gestoppt: 'gestoppt',
  ausgerollt: 'auf das Gerät ausgerollt',
  geraet_problem: 'Gerät meldet ein Problem',
  protokoll_gedeckelt: 'Ab hier wurde heute nicht weiter protokolliert',
};

/**
 * Eine Ereignis-Zeile („14:02 · gestartet · 7,4 kW · Günstiger Strompreis").
 * Gibt `null` zurück, wenn dieser Portal-Stand die Art nicht kennt — eine
 * unbekannte Art zu rendern hieße, sie zu erfinden.
 */
export function ereignisZeile(e: RuleEvent): string | null {
  const zeit = uhrzeit(e.occurredAt);
  let was: string | null = KIND_TEXT[e.kind] ?? null;
  if (e.kind === 'zustand') {
    // Ein Zustandswechsel spricht mit dem Wort des Zustands selbst; kennt der
    // Portal-Stand es nicht, gibt es keine Zeile.
    was = e.state ? CONSUMER_STATE_TEXT[e.state] ?? null : null;
  }
  if (!was) return null;

  const teile: string[] = [];
  if (zeit) teile.push(zeit);
  teile.push(was);
  if (e.actualKw != null && Number.isFinite(e.actualKw) && Math.abs(e.actualKw) >= 0.05) {
    teile.push(fmtNum(Math.abs(e.actualKw), 'kW'));
  }
  const grund = e.reasonCode ? CONSUMER_REASON_TEXT[e.reasonCode] : null;
  if (grund) teile.push(grund);
  if (e.detail) teile.push(e.detail);
  return teile.join(' · ');
}

/** Die Ereignisse EINER Regel, neueste zuerst (der Server liefert sie so). */
export function ereignisseFuer(events: RuleEvent[] | null | undefined, key: string): RuleEvent[] {
  return (events ?? []).filter((e) => karteSchluessel(e.ruleKind, e.ruleRef) === key);
}

// ---------------------------------------------------------------------------
// 3 · Der Abschnitt im Detail-Einschub
// ---------------------------------------------------------------------------

/** So viele Zeilen trägt der Einschub — der Rest lebt im Gesamt-Protokoll. */
export const MAX_ZEILEN_JE_REGEL = 12;

/**
 * „Verlauf dieser Regel". Ohne ein einziges Ereignis sagt der Abschnitt das
 * ehrlich UND nennt, seit wann überhaupt aufgezeichnet wird — eine leere Liste
 * ohne Satz sähe aus wie ein Ausfall.
 */
export function verlaufAbschnitt(
  events: RuleEvent[] | null | undefined,
  key: string,
  protokoll: Pick<RuleEvents, 'recordingSince' | 'accuracySeconds'> | null | undefined,
): RegelAbschnitt {
  const eigene = ereignisseFuer(events, key);
  const zeilen = eigene
    .slice(0, MAX_ZEILEN_JE_REGEL)
    .map(ereignisZeile)
    .filter((z): z is string => z != null);

  if (zeilen.length === 0) {
    const seit = uhrzeit(protokoll?.recordingSince);
    return {
      titel: 'Verlauf dieser Regel',
      zeilen: [],
      note: seit
        ? `${VERLAUF_LEER} Aufgezeichnet wird seit ${seit}.`
        : VERLAUF_LEER,
    };
  }
  return {
    titel: 'Verlauf dieser Regel',
    zeilen,
    note: genauigkeitsNote(protokoll?.accuracySeconds),
  };
}

// ---------------------------------------------------------------------------
// 4 · Das kompakte Gesamt-Protokoll
// ---------------------------------------------------------------------------

export interface ProtokollZeile {
  key: string;
  /** Der Name der Regel, oder null wenn das Ereignis keiner zuzuordnen war. */
  regel: string | null;
  text: string;
  /** Ein Problem wird bernstein getönt, alles andere ruhig. */
  ton: 'plain' | 'warn';
}

/** So viele Zeilen zeigt das Gesamt-Protokoll. */
export const MAX_ZEILEN_GESAMT = 30;

export interface ProtokollView {
  titel: string;
  zeilen: ProtokollZeile[];
  /** Der ehrliche Satz, wenn (noch) nichts aufgezeichnet ist. */
  leer: string | null;
  note: string | null;
}

/**
 * Das Gesamt-Protokoll unter der Liste. `namen` bildet den Kartenschlüssel auf
 * den Regel-Namen ab; ein Ereignis ohne zuordenbare Regel bleibt SICHTBAR
 * (es ist passiert), nennt aber keine — nie eine geratene.
 */
export function protokoll(
  daten: RuleEvents | null | undefined,
  namen: Record<string, string>,
): ProtokollView {
  const zeilen: ProtokollZeile[] = [];
  for (const e of daten?.events ?? []) {
    if (zeilen.length >= MAX_ZEILEN_GESAMT) break;
    const text = ereignisZeile(e);
    if (!text) continue;
    const key = karteSchluessel(e.ruleKind, e.ruleRef);
    zeilen.push({
      key: `e${e.id}`,
      regel: key ? namen[key] ?? null : null,
      text,
      ton: e.kind === 'geraet_problem' || e.kind === 'protokoll_gedeckelt' ? 'warn' : 'plain',
    });
  }
  const seit = uhrzeit(daten?.recordingSince);
  return {
    titel: 'Verlauf',
    zeilen,
    leer: zeilen.length > 0
      ? null
      : (seit
        ? `Noch kein Wechsel aufgezeichnet. Aufgezeichnet wird seit ${seit}.`
        : 'Für diese Anlage wird noch kein Verlauf aufgezeichnet.'),
    note: zeilen.length > 0 ? genauigkeitsNote(daten?.accuracySeconds) : null,
  };
}
