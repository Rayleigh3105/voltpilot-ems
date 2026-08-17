/**
 * Der **Daten-Alter-Ausweis**: „Stand: 12:27 Uhr" — die EINE Regel, mit der
 * jede „JETZT/Gemessen"-Fläche des Cockpits sagt, WANN ihre Zahlen gemessen
 * wurden, sobald sie das Live-Fenster verlassen haben.
 *
 * **Der belegte Anlass (Herzogau, 17.08.2026, Report `vp-herzogau-runde2-m6`
 * §4.2):** Um 17:55 zeigte das Kunden-Cockpit ein um über fünf Stunden
 * veraltetes Bild (8,6 kW PV, „Deye 0,0", alter Ladestand) als frisches
 * Live-Bild — mit grünen Frische-Punkten an den Geräten. Die Box maß in genau
 * dieser Minute 12,8 kW bei 83 % Ladestand. Das Cockpit rendert
 * konstruktionsbedingt den JÜNGSTEN vorhandenen Messwert, egal wie alt er ist;
 * einen Alters-Ausweis gab es nur punktuell. Der Kunde konnte den Unterschied
 * zwischen „meine Anlage produziert nichts" und „das Portal zeigt Mittag"
 * nicht sehen.
 *
 * **Warum die Ausgabe STATISCH ist (die PR-279-Lehre, siehe `liveness.ts`):**
 * Der Ausweis nennt den ZEITPUNKT der Messung („Stand: 12:27 Uhr"), nie eine
 * Dauer („vor 5 Std."). Eine Dauer ist nur dann wahr, wenn die Seite sie
 * nachrechnet — genau das tut eine eingefrorene, nicht nachladende Seite aber
 * nicht, und das war der 17:55-Fall. Ein Zeitpunkt bleibt auch dann wahr, wenn
 * die Seite eine Stunde offen liegt: er altert mit der Wanduhr des Kunden von
 * selbst mit. `now` entscheidet AUSSCHLIESSLICH, OB der Ausweis erscheint, und
 * Zustand und Bezugszeit werden dabei — wie in `liveness.ts` gefordert — im
 * selben Render gemeinsam gesetzt.
 *
 * **Innerhalb des Live-Fensters gibt es keinen Ausweis** (`null`): eine frische
 * Anlage bekommt kein Dauer-Zeitstempel-Rauschen, die Fläche ist dann
 * zeichengleich zu vorher.
 *
 * Rein + framework-frei (unit-getestet in `datenAlter.test.ts`).
 */
import { ONLINE_WINDOW_MS } from './api';
import { NBSP } from './format';

/** Der eine Wortstamm — Log, Chip und Zusatzzeile dürfen nie anders heißen. */
export const STAND_PREFIX = 'Stand:';

/**
 * Der Zeitpunkt einer Messung als Uhrzeit: „12:27 Uhr" am selben Kalendertag,
 * sonst mit Datum davor („16.08., 23:41 Uhr"). Ohne verwertbaren Zeitstempel
 * `null` — es wird nie eine Uhrzeit erfunden.
 */
export function standTime(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return null;
  const time = at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `${time}${NBSP}Uhr`;
  const day = at.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `${day}, ${time}${NBSP}Uhr`;
}

/**
 * Der Ausweis für eine Live-Fläche, oder `null` solange die Daten frisch sind.
 *
 * Frisch heißt: der jüngste Messwert liegt höchstens `windowMs` (Vorgabe: das
 * 5-Minuten-Live-Fenster `ONLINE_WINDOW_MS`) zurück — dieselbe Grenze, die
 * `deviceLiveStatus` und die Cockpit-Frische benutzen; zwei Fenster wären zwei
 * Wahrheiten über dieselbe Frage. Ein Zeitstempel AUS DER ZUKUNFT (verstellte
 * Uhr) gilt als frisch, nie als uralt.
 */
export function standLabel(
  iso: string | null | undefined,
  now: Date = new Date(),
  windowMs: number = ONLINE_WINDOW_MS,
): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  if (now.getTime() - ms <= windowMs) return null;
  const time = standTime(iso, now);
  return time ? `${STAND_PREFIX} ${time}` : null;
}

/**
 * Der jüngste von mehreren Zeitstempeln (z. B. die `readAt` mehrerer
 * Messstellen). `null`, wenn keiner verwertbar ist — nie ein ersatzweise
 * genommener „jetzt".
 */
export function newestTs(stamps: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const s of stamps) {
    if (!s) continue;
    const ms = new Date(s).getTime();
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = s;
  }
  return best;
}
