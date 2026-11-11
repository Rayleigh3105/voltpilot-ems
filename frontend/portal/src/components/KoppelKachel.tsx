import { useState } from 'react';
import { kennungWieGedruckt } from '../koppelLink';
import { KOPIEREN } from '../koppelTexte';
import './KoppelBand.css';

/** Die Kennung wie auf dem Gehäuse, groß, mit „Kopieren“ (M1, M11, M12). */
export function KennungKachel({
  kennung,
  titel,
  zeile,
  kopieren = false,
}: {
  kennung: string;
  titel: string;
  zeile: string;
  kopieren?: boolean;
}) {
  const [kopiert, setKopiert] = useState(false);
  const gedruckt = kennungWieGedruckt(kennung);
  return (
    <div className="vp-koppel-kachel">
      <span className="vp-koppel-kachel-titel">{titel}</span>
      <span className="vp-koppel-kachel-wert">
        <code translate="no">{gedruckt}</code>
        {kopieren && (
          <button
            type="button"
            className="vp-btn vp-btn--outline vp-btn--sm"
            onClick={() => {
              void navigator.clipboard?.writeText(gedruckt).then(
                () => setKopiert(true),
                () => setKopiert(false),
              );
            }}
          >
            {kopiert ? KOPIEREN.kopiert : KOPIEREN.knopf}
          </button>
        )}
      </span>
      <span className="vp-koppel-kachel-zeile">{zeile}</span>
    </div>
  );
}

/**
 * Die Unterseite der Box als Zeichnung: QR-Code und darunter die Kennung in Klarschrift
 * (Beschriftung nach Entscheid 8, `werkstatt.ts → beschriftung`). Der QR-Code ist nur angedeutet.
 */
export function BoxUnterseite({ gedruckt, titel }: { gedruckt: string | null; titel: string }) {
  const zellen = [0, 1, 2, 3, 4, 5, 6].flatMap((y) => [0, 1, 2, 3, 4, 5, 6].map((x) => ({ x, y })));
  const muster = (x: number, y: number) => (x * 7 + y * 3 + x * y) % 3 === 0;
  const ecke = (x: number, y: number) => (x < 2 && y < 2) || (x > 4 && y < 2) || (x < 2 && y > 4);
  return (
    <figure className="vp-koppel-unterseite">
      <svg viewBox="0 0 220 120" role="img" aria-label={titel}>
        <rect x="4" y="4" width="212" height="112" rx="14" className="vp-koppel-gehaeuse" />
        <g transform="translate(78 14)">
          {zellen.map(({ x, y }) =>
            ecke(x, y) || muster(x, y) ? <rect key={`${x}-${y}`} x={x * 9} y={y * 9} width="8" height="8" className="vp-koppel-qr" /> : null,
          )}
        </g>
        <text x="110" y="102" textAnchor="middle" className="vp-koppel-klartext">
          {gedruckt ? (
            gedruckt
          ) : (
            <>
              <tspan>EDGE-</tspan>
              <tspan className="vp-koppel-klartext-luecke">•••••••</tspan>
            </>
          )}
        </text>
      </svg>
      <figcaption className="vp-visually-hidden">{titel}</figcaption>
    </figure>
  );
}
