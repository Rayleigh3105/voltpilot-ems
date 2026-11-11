import { NARROW_PX } from '../../chartStyle';

/**
 * **Die Zeichenfläche der Energie-Diagramme** — EINE Quelle für das Diagramm
 * (ECharts-`grid`, `EnergieCharts.tsx`) und die Ereignis-Spur darunter (DOM,
 * `EreignisSpurRahmen.tsx`), damit eine Marke genau unter ihrem Balken bzw.
 * ihrer Uhrzeit sitzt. Ein eigenes, winziges Modul: die Spur liegt im
 * Seiten-Stück, die Diagramme laden als eigenes Stück nach (`CHART_CHUNK`).
 */

export type ZeichenArt = 'bilanz' | 'tag';

/** Die Ränder der Balken-Bilanz (Woche, Monat, Jahr). */
export function bilanzRand(breite: number): { left: number; right: number } {
  return { left: breite < NARROW_PX ? 48 : 56, right: 12 };
}

/** Die Ränder der Felder des Tages. */
export function tagRand(breite: number): { left: number; right: number } {
  return { left: breite < NARROW_PX ? 40 : 48, right: 12 };
}

/**
 * Wo die Zellen `von`..`bis` (einschließlich) auf der x-Achse liegen, in px vom
 * linken Rand. Die Bilanz zeichnet Kategorie-BÄNDER (Balken mittig im Band),
 * der Tag PUNKTE an den Viertelstunden-Anfängen (`boundaryGap: false`) — dort
 * reicht eine Spanne wie die Bänder des Diagramms (`markArea` von `von` bis
 * `bis`) vom ersten bis zum letzten Punkt; eine einzelne Viertelstunde ist
 * einen Schritt breit, damit sie sichtbar bleibt.
 */
export function spurLage(
  art: ZeichenArt,
  breite: number,
  n: number,
  von: number,
  bis: number,
): { x: number; w: number } {
  const { left, right } = art === 'bilanz' ? bilanzRand(breite) : tagRand(breite);
  const plot = Math.max(0, breite - left - right);
  if (n <= 0) return { x: left, w: 0 };
  if (art === 'bilanz') {
    const band = plot / n;
    return { x: left + von * band, w: (bis - von + 1) * band };
  }
  const schritt = plot / Math.max(1, n - 1);
  const x0 = left + von * schritt;
  const x1 = left + Math.min(Math.max(bis, von + 1), n - 1) * schritt;
  return { x: x0, w: Math.max(0, x1 - x0) };
}
