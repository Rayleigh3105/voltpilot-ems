/**
 * Die IST-SPUR des Fahrplans: der GEMESSENE Ladestand je Viertelstunde des
 * Tagesbilds (Schritt 2 des Konzepts „Tagesuhr und Bildfahrplan", gebaut mit
 * dem Überblick vom 20.10.2026).
 *
 * Warum: Vergangenes zeigte bisher nur den Plan, der damals galt. Folgte das
 * Gerät dem Plan nicht (Steuerung noch nicht bestätigt, Wechselrichter regelt
 * selbst), las der Kunde Widersprüche wie „Warten · 68 % → 95 %" - der Plan
 * sagte warten, der Speicher lud trotzdem. Mit der Messung daneben ist das kein
 * Rätsel mehr, sondern eine Aussage: „anders als geplant".
 *
 * Quelle ist der Verlauf der Anlage (`GET /sites/{id}/history?range=day`, die
 * 15-Minuten-Eimer mit `socLastPct`) - dieselbe Messung wie auf der
 * Verlauf-Seite. Ein Eimer gehört zur Viertelstunde mit DEMSELBEN Beginn; nur
 * vergangene und laufende Viertelstunden bekommen einen Wert. Fehlt eine
 * Messung, bleibt eine Lücke (null), nie eine 0.
 *
 * Rein: kein React, kein Netz.
 */

import type { TagModell } from './fahrplanTag';

/** Was die Ist-Spur aus einem Verlaufs-Eimer liest. */
export interface IstEimer {
  start: string;
  socLastPct?: number | null;
}

/** Der gemessene Ladestand am ENDE jeder Viertelstunde von `tag.slots`; null = keine Messung. */
export function istLadestand(tag: TagModell, eimer: readonly IstEimer[] | null | undefined): (number | null)[] {
  if (!eimer || eimer.length === 0) return tag.slots.map(() => null);
  const nachBeginn = new Map<number, number>();
  for (const e of eimer) {
    const v = e.socLastPct;
    if (v == null || !Number.isFinite(Number(v))) continue;
    nachBeginn.set(new Date(e.start).getTime(), Math.max(0, Math.min(100, Number(v))));
  }
  return tag.slots.map((s, i) => {
    const v = tag.viertel[i];
    if (!v || !(v.vorbei || v.laeuft)) return null;
    return nachBeginn.get(new Date(s.start).getTime()) ?? null;
  });
}

/** Ab dieser Änderung (Prozentpunkte) hat sich der Speicher in einer Phase wirklich bewegt. */
export const IST_BEWEGUNG_PCT = 5;

/**
 * Was der Speicher in einer vergangenen Phase GEMESSEN tat: Stand davor und
 * danach. null, wenn eine der beiden Messungen fehlt.
 */
export function istVerlauf(
  ist: readonly (number | null)[],
  startIdx: number,
  endIdx: number,
): { von: number; bis: number } | null {
  const bis = ist[endIdx];
  // Der Stand VOR der Phase ist das Ende der Viertelstunde davor; am
  // Tagesanfang der erste Wert der Phase selbst.
  const von = startIdx > 0 ? ist[startIdx - 1] : ist[startIdx];
  if (von == null || bis == null) return null;
  return { von, bis };
}
