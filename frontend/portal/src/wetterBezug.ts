import type { StandortWetter, WetterBindung, WetterStand } from './api';
import { UEMS_BEZOGEN, UEMS_KOORDINATEN_FEHLEN, UEMS_TEMPERATUR_BEZOGEN } from './glossar';
import { ZONE } from './wetterArchiv';

/**
 * AP-17 IP-12c: die Sätze des Wetter-Archivs an der Gradtagzahl (Abschnitt „Wetter“) und am Standort (Zeile
 * „Wetter“). Die Kundenwörter kommen aus `glossar.ts` (IP-4); die Zahlen liest die API (`…/wetterbezug`,
 * `/standorte/{id}/wetter`) — hier wird nur formuliert, nichts nachgerechnet.
 */
export const WETTER = 'Wetter';
export const WETTER_BEZIEHEN = 'Wetter beziehen';
export const WETTER_LOESEN = 'Bezug lösen';
export const NOCH_KEIN_ABRUF = 'Noch kein Abruf — VoltPilot holt die Tage beim nächsten täglichen Abruf.';
export const NUR_GRADTAGZAHL = 'Wetter lässt sich für eine Gradtagzahl am Standort mit Tages- oder Monatswerten beziehen.';
export const LOESEN_FOLGEN = [
  'VoltPilot holt keine weiteren Tage aus dem Wetter-Archiv.',
  'Die schon bezogenen Werte bleiben mit ihrem Kennzeichen erhalten.',
];

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** `2027-03` → „März 2027“. */
export const monatText = (monat: string) => `${MONATE[Number(monat.slice(5, 7)) - 1]} ${monat.slice(0, 4)}`;

/** `2027-03-01` → „01.03.2027“. */
export const tagText = (tag: string) => `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;

const ABRUF = new Intl.DateTimeFormat('de-DE', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** Abrufzeit in der Ortszone, ohne Sekunden: „03.04.2027 06:10“ (wie das Kennzeichen, Vertrag §„Wetter-Archiv“). */
export const abrufText = (zeitpunkt: string) => ABRUF.format(new Date(zeitpunkt)).replace(',', '');

/** „März 2027: 27 von 31 Tagen“ — der Stand des letzten Monats mit bezogenen Tagen. */
export const standText = (s: WetterStand) => `${monatText(s.monat)}: ${s.tage} von ${s.tage_erwartet} Tagen`;

/** „bezogen aus Open-Meteo-Archiv, zuletzt am 03.04.2027 06:10“. */
export const bezogenText = (quelle: string, letzterAbruf: string) =>
  `${UEMS_BEZOGEN} aus ${quelle}, zuletzt am ${abrufText(letzterAbruf)}`;

/** Der Zustand an der Gradtagzahl: „bezogen aus …, zuletzt am …, März 2027: 27 von 31 Tagen“ — oder noch kein Abruf. */
export function zustandSatz(b: WetterBindung) {
  if (!b.quelle || !b.letzter_abruf) return NOCH_KEIN_ABRUF;
  return b.stand ? `${bezogenText(b.quelle, b.letzter_abruf)}, ${standText(b.stand)}` : bezogenText(b.quelle, b.letzter_abruf);
}

/** „Gradtage G20/15 ab 01.03.2027“. */
export const bindungText = (b: WetterBindung) => `${b.regel} ab ${tagText(b.von)}`;

/** Der Kennzeichen-Satz unter jeder bezogenen Zahl (§5.8). */
export const KENNZEICHEN_SATZ = UEMS_TEMPERATUR_BEZOGEN;

/**
 * Die Zeile „Wetter“ am Standort: ohne Koordinaten der Satz „Koordinaten fehlen“ (§5.8); sonst die gebundenen
 * Gradtagzahlen und der letzte Abruf.
 */
export function standortWetterZeile(w: StandortWetter): { wert: string; satz: string | null } {
  if (!w.koordinaten) return { wert: UEMS_KOORDINATEN_FEHLEN, satz: w.satz ?? null };
  if (w.gradtagzahlen.length === 0) return { wert: 'Koordinaten vorhanden · keine Gradtagzahl bezieht Wetter', satz: null };
  const namen = w.gradtagzahlen.map(g => g.kennzeichen).join(', ');
  const abruf = w.quelle && w.letzter_abruf ? bezogenText(w.quelle, w.letzter_abruf) : NOCH_KEIN_ABRUF;
  return { wert: `${abruf} · ${namen}`, satz: null };
}
