import type { SkalaBild } from '../energiezielBild';
import './StandSkala.css';

/** Positionen der viewBox (0…320) als Prozent der Breite für die Beschriftungen in HTML. */
const pct = (x: number) => `${((x / 320) * 100).toFixed(2)}%`;

/**
 * Wo eine Beschriftung an ihrem Strich steht: mittig, am Rand nach innen — und nahe der Bezugsbasis zur Seite, damit
 * „Bezugsbasis“ und „Energieziel −1 %“ sich nie überdecken.
 */
function anker(x: number, nachbar: number | null, seite: 'links' | 'rechts' | null = null): string {
  if (x < 40) return 'is-start';
  if (x > 280) return 'is-ende';
  if (nachbar !== null && Math.abs(x - nachbar) < 70 && seite) return seite === 'links' ? 'is-ende' : 'is-start';
  return 'is-mitte';
}

/**
 * Die Skala aus Auswerten (Konzept a1, übernommen in Verbessern §6.11): die Bezugsbasis in der Mitte, rechts „weniger
 * als erwartet“, das Energieziel als Strich in Navy, „bisher“ als Punkt in der Farbe des Urteils, der Weg von der
 * Bezugsbasis zum Energieziel hellgrün. Ohne Zahl (noch keine Aussage) fehlt der Punkt. Das SVG trägt nur Marken; alle
 * Texte sind HTML, damit sie bei jeder Breite gleich groß bleiben.
 */
export function StandSkala({ bild, label }: { bild: SkalaBild; label: string }) {
  const zielLinks = bild.ziel < bild.basis;
  return (
    <div className="vp-skala" role="img" aria-label={label}>
      <div className="vp-skala-o" aria-hidden="true">
        {bild.punkt !== null && bild.punktText && (
          <span className={anker(bild.punkt, null)} style={{ left: pct(bild.punkt) }}>
            {bild.punktText}
          </span>
        )}
      </div>
      <svg viewBox="0 0 320 24" aria-hidden="true" focusable="false">
        <rect className="vp-skala-spur" x="10" y="8" width="300" height="8" rx="4" />
        <rect className="vp-skala-weg" x={bild.bereich[0]} y="8" width={bild.bereich[1] - bild.bereich[0]} height="8" />
        <line className="vp-skala-basis" x1={bild.basis} x2={bild.basis} y1="3" y2="21" />
        <line className="vp-skala-ziel" x1={bild.ziel} x2={bild.ziel} y1="2" y2="22" />
        {bild.punkt !== null && <circle className={`vp-skala-punkt is-${bild.punktTon}`} cx={bild.punkt} cy="12" r="7" />}
      </svg>
      <div className="vp-skala-m" aria-hidden="true">
        <span className={anker(bild.basis, bild.ziel, zielLinks ? 'rechts' : 'links')} style={{ left: pct(bild.basis) }}>
          Bezugsbasis
        </span>
        <span className={`is-ziel ${anker(bild.ziel, bild.basis, zielLinks ? 'links' : 'rechts')}`} style={{ left: pct(bild.ziel) }}>
          {bild.zielText}
        </span>
      </div>
      <div className="vp-skala-u" aria-hidden="true">
        <span>mehr als erwartet</span>
        <span>weniger als erwartet</span>
      </div>
    </div>
  );
}
