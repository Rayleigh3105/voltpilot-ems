import type { Grafik } from '../bezugsbasisModell';
import { UEMS_GRUNDLAST } from '../glossar';

/**
 * Punkte und Gerade einer Fassung (UEMS AP-17 IP-14, §5.2) als SVG ohne Fremdbibliothek und ohne Bewegung: jeder Punkt
 * ist ein Monatspaar der Grundlage (Energie über Einflussgröße 1), die Gerade ist a + b·x der Fassung — durchgezogen
 * über der Spannweite (Band), gestrichelt im Toleranzband daneben. Die Zahlen an den Achsen sind die Texte der Fassung;
 * die Grafik skaliert über die `viewBox` (375 px), ihre Legende steht darunter in HTML. Der Grenz-Satz gehört der
 * Fläche, in der sie steht (Reiter bzw. Assistent, SP3).
 */
const B = 400;
const H = 250;
const RAND = { links: 58, rechts: 12, oben: 12, unten: 40 };

export function BezugsbasisModellGrafik({
  g,
  beschreibung,
  achsen,
  xMarken,
  yMarken,
  punktTitel,
}: {
  g: Grafik;
  beschreibung: string;
  achsen: { x: string; y: string };
  /** Beschriftete Stellen der x-Achse: die Spannweite der Fassung (Wert und Text). */
  xMarken: { wert: number; text: string }[];
  /** Beschriftete Stellen der y-Achse: kleinster und größter Monatswert. */
  yMarken: { wert: number; text: string }[];
  punktTitel: (periode: string) => string;
}) {
  const breite = B - RAND.links - RAND.rechts;
  const hoehe = H - RAND.oben - RAND.unten;
  const sx = (x: number) => RAND.links + ((x - g.x.min) / (g.x.max - g.x.min)) * breite;
  const sy = (y: number) => RAND.oben + hoehe - ((y - g.y.min) / (g.y.max - g.y.min)) * hoehe;
  const imBand = (x: number) => Math.min(Math.max(x, g.band.von), g.band.bis);
  const aufGerade = (x: number) => g.gerade.y1 + ((x - g.gerade.x1) / (g.gerade.x2 - g.gerade.x1 || 1)) * (g.gerade.y2 - g.gerade.y1);
  const bandVon = imBand(g.band.von);
  const bandBis = imBand(g.band.bis);

  return (
    <svg
      className="vp-bbm-svg"
      viewBox={`0 0 ${B} ${H}`}
      role="img"
      aria-label={beschreibung}
      data-testid="bezugsbasis-modell-grafik"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect
        className="vp-bbm-band"
        x={sx(bandVon)}
        y={RAND.oben}
        width={Math.max(1, sx(bandBis) - sx(bandVon))}
        height={hoehe}
        data-testid="bezugsbasis-modell-band"
      />
      <line className="vp-bbm-achse" x1={RAND.links} y1={RAND.oben + hoehe} x2={B - RAND.rechts} y2={RAND.oben + hoehe} />
      <line className="vp-bbm-achse" x1={RAND.links} y1={RAND.oben} x2={RAND.links} y2={RAND.oben + hoehe} />
      {xMarken.map((m) => (
        <g key={`x-${m.text}`}>
          <line className="vp-bbm-marke" x1={sx(m.wert)} y1={RAND.oben + hoehe} x2={sx(m.wert)} y2={RAND.oben + hoehe + 4} />
          <text className="vp-bbm-zahl" x={sx(m.wert)} y={RAND.oben + hoehe + 16} textAnchor="middle">
            {m.text}
          </text>
        </g>
      ))}
      {yMarken.map((m) => (
        <g key={`y-${m.text}`}>
          <line className="vp-bbm-marke" x1={RAND.links - 4} y1={sy(m.wert)} x2={RAND.links} y2={sy(m.wert)} />
          <text className="vp-bbm-zahl" x={RAND.links - 6} y={sy(m.wert) + 4} textAnchor="end">
            {m.text}
          </text>
        </g>
      ))}
      <text className="vp-bbm-achsentext" x={RAND.links + breite / 2} y={H - 4} textAnchor="middle">
        {achsen.x}
      </text>
      <text className="vp-bbm-achsentext" x={RAND.links + 4} y={RAND.oben + 12} textAnchor="start">
        {achsen.y}
      </text>
      {g.grundlast !== null && (
        <g data-testid="bezugsbasis-modell-grundlast">
          <line className="vp-bbm-grundlast" x1={sx(g.x.min)} y1={sy(g.grundlast)} x2={sx(g.x.max)} y2={sy(g.grundlast)} />
          <text className="vp-bbm-achsentext" x={B - RAND.rechts} y={sy(g.grundlast) - 4} textAnchor="end">
            {UEMS_GRUNDLAST}
          </text>
        </g>
      )}
      <line
        className="vp-bbm-gerade is-toleriert"
        x1={sx(g.gerade.x1)}
        y1={sy(g.gerade.y1)}
        x2={sx(g.gerade.x2)}
        y2={sy(g.gerade.y2)}
      />
      <line
        className="vp-bbm-gerade"
        data-testid="bezugsbasis-modell-gerade"
        x1={sx(bandVon)}
        y1={sy(aufGerade(bandVon))}
        x2={sx(bandBis)}
        y2={sy(aufGerade(bandBis))}
      />
      {g.punkte.map((p) => (
        <circle key={p.periode} className="vp-bbm-punkt" cx={sx(p.x)} cy={sy(p.y)} r={4.5} data-testid="bezugsbasis-modell-punkt" data-periode={p.periode}>
          <title>{punktTitel(p.periode)}</title>
        </circle>
      ))}
    </svg>
  );
}
