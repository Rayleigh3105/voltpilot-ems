/**
 * **Die Richtungs-Spitze des Energieflusses** (Bewegungs-Programm P3).
 *
 * Sie ist im Normalbetrieb NICHT sichtbar (`.vp-flow-arrow { display: none }`,
 * `index.css` P3-Block) — dort erzählt die Bewegung der Punkte die Richtung,
 * und ein zusätzliches Dreieck wäre Dekoration über einer Aussage, die schon
 * steht (Owner-Auflage: „Art und Geometrie des Flusses bleiben").
 *
 * ⚠ SIE ERSCHEINT AUSSCHLIESSLICH UNTER REDUZIERTER BEWEGUNG. Dort hält der
 *   eine Schalter die Punkte an (`animation: none`), und im Browser
 *   nachgemessen war die Richtung danach in NICHTS mehr gesagt: das
 *   Dash-Muster ist symmetrisch, `aria-label` nennt nur die vier Rollen, und
 *   der Knotenwert trägt kein Vorzeichen. „Statisch UND Richtung erkennbar"
 *   (Konzept §5 Zeile G) braucht deshalb dieses eine Dreieck.
 */
export interface FlowPoint {
  x: number;
  y: number;
}

export function DirectionArrow({
  from,
  to,
  color,
  size = 5,
}: {
  /** Wo der Fluss herkommt. */
  from: FlowPoint;
  /** Wohin er läuft — die Spitze zeigt dorthin. */
  to: FlowPoint;
  color: string;
  size?: number;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Etwas jenseits der Mitte, damit sie auch bei kurzen Speichen nicht unter
  // dem Nabenkreis verschwindet.
  const cx = from.x + dx * 0.55;
  const cy = from.y + dy * 0.55;
  const px = -uy;
  const py = ux;
  const pt = (fx: number, fy: number) => `${fx.toFixed(1)},${fy.toFixed(1)}`;
  const points = [
    pt(cx + ux * size, cy + uy * size),
    pt(cx - ux * size + px * size * 0.8, cy - uy * size + py * size * 0.8),
    pt(cx - ux * size - px * size * 0.8, cy - uy * size - py * size * 0.8),
  ].join(' ');
  return <polygon className="vp-flow-arrow" points={points} fill={color} aria-hidden="true" />;
}
