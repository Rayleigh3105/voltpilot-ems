import type { BezugsbasisRichtung, BezugsbasisUrteil } from './api';
import { PROZENT, zahlMitStellen } from './uemsErgebnis';

/**
 * Die Wörter des Urteils gegen die Bezugsbasis - dieselben auf der Karte einer Kennzahl, ihrer Seite und der Leitkachel
 * der Übersicht (Konzept Auswerten a1 §6.1 Regel 9, §10.8: ein Urteil, eine Ableitung, dieselben Wörter). Das Urteil
 * selbst kommt immer vom Server (Operation `vergleich`); hier wird nur benannt.
 */

export type UrteilTon = 'ok' | 'warn' | 'neutral';

export const URTEIL_WORT: Record<'besser' | 'schlechter' | 'im_rahmen', string> = {
  besser: 'besser als die Bezugsbasis',
  schlechter: 'über der Bezugsbasis',
  im_rahmen: 'im Rahmen der Bezugsbasis',
};

const URTEIL_TON: Record<keyof typeof URTEIL_WORT, UrteilTon> = { besser: 'ok', schlechter: 'warn', im_rahmen: 'neutral' };

/** Wort und Ton eines Urteils; `null` für „ohne Urteil“, „nicht anwendbar“ und Unbekanntes - nie geraten. */
export function urteilAnsicht(u: BezugsbasisUrteil | string | null | undefined): { wort: string; ton: UrteilTon } | null {
  if (u !== 'besser' && u !== 'schlechter' && u !== 'im_rahmen') return null;
  return { wort: URTEIL_WORT[u], ton: URTEIL_TON[u] };
}

/** „2,2 %“ aus dem Dezimaltext des Servers, ohne Vorzeichen (die Richtung sagt das Wort daneben). */
export function prozentText(delta: string, stellen = 1): string {
  return zahlMitStellen(delta.replace(/^-/, ''), stellen, PROZENT);
}

/** „2,2 % mehr als erwartet“ · „3,4 % weniger als erwartet“ · „genau wie erwartet“ (U2, U6: keine Ursache). */
export function abweichungSatz(delta: string, richtung: BezugsbasisRichtung | null): string {
  if (richtung === 'gleich') return 'genau wie erwartet';
  return `${prozentText(delta)} ${richtung === 'weniger' ? 'weniger' : 'mehr'} als erwartet`;
}

/** Die kurze Form neben einem schon genannten „als erwartet“: „6,5 % mehr“. */
export function abweichungKurz(delta: string, richtung: BezugsbasisRichtung | null): string {
  if (richtung === 'gleich') return 'wie erwartet';
  return `${prozentText(delta)} ${richtung === 'weniger' ? 'weniger' : 'mehr'}`;
}
