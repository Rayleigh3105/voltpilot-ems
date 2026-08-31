/**
 * Die EINE Bezugszeit-Regel für Geräte-Lebendigkeit.
 *
 * **Der behobene Fehler (Captain 30.07.):** „Im Portal steht ziemlich oft
 * Warnung Gerät meldet sich nicht, obwohl ich gerade eigentlich Daten bekomme.
 * Wenn ich F5 drücke, dann steht wieder alles in Ordnung da."
 *
 * Ursache war ein EINGEFRORENER Bezugspunkt: die Geräteliste (`api.listDevices`)
 * wurde genau einmal je Seitenaufruf geholt, `lastSeenAt` blieb damit stehen —
 * und der Gesundheits-Ticker verglich sie alle 30 s gegen eine WEITERLAUFENDE
 * Wanduhr. Nach fünf Minuten offenem Portal überschritt jedes Gerät zwangsläufig
 * `ONLINE_WINDOW_MS`, der Kopfzeilen-Zustand kippte auf „Gerät meldet sich
 * nicht" und konnte sich NIE wieder erholen (nichts aktualisierte den Bezug),
 * während das Cockpit darunter — das `/overview` alle 30 s neu holt — ruhig
 * grün blieb. F5 holte die Liste neu und alles war wieder in Ordnung.
 *
 * Die Regel, die das strukturell ausschließt:
 *
 * > **Lebendigkeit wird gegen die ANTWORTZEIT des Servers gemessen, nie gegen
 * > eine Uhr, die über einen nicht erneuerten Schnappschuss hinausläuft.**
 *
 * Konsequenzen, alle beabsichtigt:
 *
 * - Jede frische Antwort aktualisiert Zustand UND Bezugszeit gemeinsam
 *   ({@link DevicesSnapshot}) — sie können gar nicht auseinanderlaufen.
 * - Ein FEHLGESCHLAGENER Poll ändert nichts: weder Daten noch Bezugszeit, also
 *   kann er den Zustand nicht kippen. Das ist stärker als eine
 *   N-Fehlversuche-Schwelle, weil es keinen Zähler gibt, der falsch stehen
 *   könnte.
 * - Ein gedrosselter Hintergrund-Tab (Browser drosseln `setInterval` massiv)
 *   lässt den Zustand EINFRIEREN statt zu verfallen. Bei der Rückkehr wird
 *   sofort neu geholt (`visibilitychange`), nicht erst zum nächsten Intervall.
 * - Die Warnung erscheint damit nur noch, wenn der SERVER das Gerät wirklich
 *   als still meldet: sein `lastSeenAt` bleibt stehen, während unsere
 *   Bezugszeit mit jedem erfolgreichen Poll weiterrückt.
 *
 * Bewusst NICHT gebaut: eine Obergrenze, ab der ein alter Schnappschuss doch
 * als „still" gilt. Ein Portal, das den Server nicht erreicht, weiß über das
 * GERÄT nichts Neues — es einfrieren zu lassen ist die ehrliche Antwort, eine
 * erfundene Alterung wäre genau der Fehler von oben. Ein wirklich stiller
 * Zustand bleibt dabei ebenso stehen (die Warnung verschwindet nicht heimlich).
 */
import { deviceLiveStatus, type Device } from './api';
import { LIST_POLL_MS } from './pollCadence';

/**
 * Takt der stillen Geräte-Auffrischung. Deutlich kürzer als
 * `ONLINE_WINDOW_MS` (5 Min), damit ein echt verstummtes Gerät spätestens
 * einen Poll nach Ablauf des Fensters als solches erkannt wird — schneller
 * zu fragen könnte das Urteil gar nicht ändern, deshalb der LIST-Takt
 * (`pollCadence.ts`). Der Name bleibt, weil die Regel hier zuhause ist.
 */
export const LIVENESS_POLL_MS = LIST_POLL_MS;

/** Zustand UND Bezugszeit — immer zusammen, nie einzeln fortgeschrieben. */
export interface DevicesSnapshot {
  /** Was der Server zuletzt geantwortet hat. */
  devices: Device[];
  /** Zeitpunkt genau dieser Antwort (Epoch-ms); null = noch nie geladen. */
  fetchedAt: number | null;
}

/** Die Geräte-Lebendigkeit einer Anlage, so wie `healthChecklist` sie erwartet. */
export interface DeviceHealthCounts {
  deviceCount: number;
  onlineCount: number;
  waitingCount: number;
}

/**
 * Der Zeitpunkt, gegen den `lastSeenAt` gemessen werden darf: die Antwortzeit
 * des Servers. `now` wird nur zur Sicherheit als Obergrenze mitgeführt (eine
 * verstellte Uhr darf keine Antwort „aus der Zukunft" erzeugen).
 */
export function livenessReference(fetchedAt: number | null, now: number): number | null {
  if (fetchedAt == null) return null;
  return Math.min(fetchedAt, now);
}

/** Alter des Schnappschusses in ms; null solange nie geladen wurde. */
export function snapshotAgeMs(fetchedAt: number | null, now: number): number | null {
  if (fetchedAt == null) return null;
  return Math.max(0, now - fetchedAt);
}

/**
 * Die Geräte-Lebendigkeit EINER Anlage aus dem Schnappschuss.
 *
 * `null` bedeutet „noch nichts gemessen" — nie „alles gut" und nie „still".
 * `healthBadge` lässt eine Zeile, deren Fakt niemand geliefert hat, ersatzlos
 * weg, also behauptet die Kopfzeile dann weder Gesundheit noch Störung.
 */
export function deviceHealthForSite(
  snapshot: DevicesSnapshot,
  siteId: string,
  now: number = Date.now(),
): DeviceHealthCounts | null {
  const reference = livenessReference(snapshot.fetchedAt, now);
  if (reference == null) return null;
  const own = snapshot.devices.filter((d) => d.siteId === siteId);
  if (own.length === 0) return { deviceCount: 0, onlineCount: 0, waitingCount: 0 };
  const at = new Date(reference);
  let onlineCount = 0;
  let waitingCount = 0;
  for (const d of own) {
    const status = deviceLiveStatus(d, at);
    if (status === 'online') onlineCount += 1;
    else if (status === 'waiting') waitingCount += 1;
  }
  return { deviceCount: own.length, onlineCount, waitingCount };
}
