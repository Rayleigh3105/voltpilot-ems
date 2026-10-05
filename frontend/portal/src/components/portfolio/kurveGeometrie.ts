/**
 * GEMEINSAME SVG-GEOMETRIE der Tageskurven (Erzeugung/Verbrauch je Viertelstunde).
 *
 * Eine Quelle für beide Kurvenorte des Portfolios: die große Tageskurve und den
 * Je-Anlage-Spark der Kundenübersicht (`KundenUebersicht.tsx`) UND den Spark der
 * UEMS-Anlagenkarten (`AnlagenEnergie.tsx`). Keine zweite Kurven-Mechanik daneben
 * (AGENTS.md „keine zweite Chart-Palette"); Farben kommen über die Chart-Tokens
 * `--vp-c-chart-*` aus dem CSS der jeweiligen Komponente, nicht von hier.
 *
 * Ehrlich (AGENTS.md „Fehlend ist keine Null"): `bis` schneidet rechts bei der
 * aktuellen Viertelstunde ab (rechts davon ist nichts gemessen), und jede `null`
 * bricht die Linie zu einer Lücke statt sie über fehlende Werte zu ziehen.
 */

/** Standardmaße der großen Tageskurve (die Spark-Varianten geben eigene mit). */
export const B = 960;
export const H = 130;
export const UNTEN = H;

/** Ein Pfad mit Lücken: jede `null`-Viertelstunde bricht die Linie. */
export function pfad(werte: readonly (number | null)[], max: number, bis: number, hoehe = UNTEN, breite = B): string {
  let d = '';
  let offen = false;
  for (let i = 0; i <= Math.min(bis, 95); i++) {
    const v = werte[i];
    if (v == null) {
      offen = false;
      continue;
    }
    const x = ((i + 0.5) / 96) * breite;
    const y = hoehe - (Math.max(0, v) / max) * (hoehe - 8);
    d += `${offen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    offen = true;
  }
  return d;
}

/** Die Fläche unter einer Reihe — je zusammenhängendem Stück geschlossen. */
export function flaeche(werte: readonly (number | null)[], max: number, bis: number, hoehe = UNTEN, breite = B): string {
  let d = '';
  let start: number | null = null;
  let letzte = 0;
  const schliessen = () => {
    if (start != null) d += `L${letzte.toFixed(1)},${hoehe}L${start.toFixed(1)},${hoehe}Z`;
    start = null;
  };
  for (let i = 0; i <= Math.min(bis, 95); i++) {
    const v = werte[i];
    if (v == null) {
      schliessen();
      continue;
    }
    const x = ((i + 0.5) / 96) * breite;
    const y = hoehe - (Math.max(0, v) / max) * (hoehe - 8);
    if (start == null) {
      start = x;
      d += `M${x.toFixed(1)},${hoehe}L${x.toFixed(1)},${y.toFixed(1)}`;
    } else d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    letzte = x;
  }
  schliessen();
  return d;
}
