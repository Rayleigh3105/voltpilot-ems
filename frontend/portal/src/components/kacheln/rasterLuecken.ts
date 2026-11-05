import { useLayoutEffect, useRef } from 'react';

/**
 * Lücken im Kachelraster schließen (UI-Runde Kundenseiten, Befund #7).
 *
 * Das Raster unter der Bühne setzt kleine (1 Spalte) und breite (2 Spalten)
 * Kacheln in Reihenfolge. Folgt auf eine ungerade Zahl kleiner Kacheln eine
 * breite, bleibt neben der letzten kleinen eine leere Spalte stehen - am
 * Telefon eine halbe Kachel mit Leerraum daneben, am Rechner eine leere vierte
 * Spalte. Die Reihenfolge bleibt die gewählte (kein `grid-auto-flow: dense`,
 * das die Kacheln umsortierte): stattdessen übernimmt die LETZTE Kachel einer
 * Zeile mit Lücke die Restspalten.
 *
 * Gerechnet wird an gemessenen Kästen, nicht an Größen-Namen: die Kacheln
 * laden spät (`KachelSpaet`), eine Gruppe steht mit `display: contents` im
 * Raster, und eine hohe Kachel belegt am Rechner zwei Zeilen.
 */
export interface Kasten {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Für jeden Kasten, der als letzter in seiner Zeile vor einer Lücke steht, die
 * Zahl der Spalten, die er zusätzlich übernehmen soll. Andere Kästen fehlen in
 * der Antwort.
 *
 * Eine Zeile hat eine Lücke, wenn rechts vom Kasten bis zum Rand kein anderer
 * Kasten steht, der seine Höhe schneidet (eine hohe Kachel aus der Zeile davor
 * zählt mit), und der freie Platz mindestens eine Spalte breit ist.
 */
export function lueckenFuellen(
  kaesten: readonly Kasten[],
  rand: { left: number; right: number },
  spalte: number,
  abstand: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (spalte <= 0) return out;
  const schritt = spalte + abstand;
  kaesten.forEach((k, i) => {
    if (k.right - k.left <= 0) return;
    const rechtsBelegt = kaesten.some(
      (o, j) => j !== i && o.right - o.left > 0 && o.left >= k.right - 1 && o.top < k.bottom - 1 && o.bottom > k.top + 1,
    );
    if (rechtsBelegt) return;
    const frei = rand.right - k.right;
    const spalten = Math.floor((frei + 1) / schritt);
    if (spalten >= 1) out.set(i, spalten);
  });
  return out;
}

/** Die eigene Spaltenzahl eines Kastens im Raster. */
export function eigeneSpalten(k: Kasten, spalte: number, abstand: number): number {
  if (spalte <= 0) return 1;
  return Math.max(1, Math.round((k.right - k.left + abstand) / (spalte + abstand)));
}

const MARKE = 'data-k-fuell';

/** Die Plätze des Rasters - auch die in einer `display: contents`-Gruppe. */
function plaetze(raster: HTMLElement): HTMLElement[] {
  return Array.from(raster.querySelectorAll<HTMLElement>('.vp-k-platz')).filter(
    (p) => p.closest('.vp-kraster') === raster,
  );
}

function ausrichten(raster: HTMLElement): void {
  const liste = plaetze(raster);
  // Erst die eigene Füllung zurücknehmen, dann messen - sonst misst die nächste
  // Runde die Spalten, die sie selbst gesetzt hat.
  for (const p of liste) {
    if (p.hasAttribute(MARKE)) {
      p.style.gridColumn = '';
      p.removeAttribute(MARKE);
    }
  }
  const stil = getComputedStyle(raster);
  const spalten = stil.gridTemplateColumns.split(' ').filter((s) => s.endsWith('px'));
  if (spalten.length < 2) return;
  const spalte = parseFloat(spalten[0]);
  const abstand = parseFloat(stil.columnGap) || 0;
  const r = raster.getBoundingClientRect();
  const kaesten = liste.map((p) => p.getBoundingClientRect());
  for (const [i, extra] of lueckenFuellen(kaesten, { left: r.left, right: r.right }, spalte, abstand)) {
    const p = liste[i];
    p.style.gridColumn = `span ${eigeneSpalten(kaesten[i], spalte, abstand) + extra}`;
    p.setAttribute(MARKE, '');
  }
}

/**
 * Hängt das Lückenschließen an ein Raster. Neu gerechnet wird, wenn sich seine
 * BREITE ändert (Drehen, Fenster) oder Kacheln hinzukommen/wegfallen - nicht bei
 * jeder Höhenänderung (die eigene Füllung löst keine neue Runde aus).
 */
export function useRasterLuecken<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const raster = ref.current;
    if (!raster || typeof ResizeObserver === 'undefined') return;
    let breite = -1;
    let frame = 0;
    const planen = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => ausrichten(raster));
    };
    const groesse = new ResizeObserver(() => {
      const b = raster.getBoundingClientRect().width;
      if (Math.abs(b - breite) < 0.5) return;
      breite = b;
      planen();
    });
    const kinder = new MutationObserver(planen);
    groesse.observe(raster);
    kinder.observe(raster, { childList: true, subtree: true });
    planen();
    return () => {
      cancelAnimationFrame(frame);
      groesse.disconnect();
      kinder.disconnect();
    };
  }, []);
  return ref;
}
