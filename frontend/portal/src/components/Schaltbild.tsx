import type { KeyboardEvent } from 'react';
import type {
  Schaltbild as SchaltbildModell,
  SchaltbildKante,
  SchaltbildKnoten,
} from '../schaltbild';
import './Schaltbild.css';

/**
 * Der EINE Renderer des Struktur-Schaltbilds (Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` §8.4, Revision 2: EIN Rendering im
 * Reiter, keine Kompakt-Karte und kein Vollbild-Modal).
 *
 * Er ist bewusst DUMM: jede Position, jedes Wort und jede Linien-Art kommt aus
 * der reinen `schaltbild.ts`. Damit ist die Geometrie ohne Browser prüfbar -
 * und es gibt keine zweite Stelle, an der ein Bezug entstehen könnte.
 *
 * **⚠ Text in SVG wird nicht geraten.** SVG kennt weder Umbruch noch Ellipse:
 * eine zu lange Zeile läuft über den Kasten hinaus, und zwar erst mit der
 * Schriftmetrik des Kunden. Jede Zeile, die knapp werden kann, trägt deshalb
 * `textLength` + `lengthAdjust="spacingAndGlyphs"` (aus `svgText.capTextLength`)
 * - dann staucht der Browser sie mit seinen ECHTEN Metriken in den Kasten.
 * Zeilen, die bequem passen, bekommen KEIN `textLength`, sonst würden kurze
 * Wörter auf die volle Breite auseinandergezogen.
 */
export function Schaltbild({
  bild,
  onKomponente,
}: {
  bild: SchaltbildModell;
  /** Klick auf eine Komponente - die Fläche springt zu ihrer Zeile in der Liste. */
  onKomponente?: (komponenteId: string) => void;
}) {
  if (bild.leer) {
    return <p className="vp-sb-leer">{bild.leer}</p>;
  }
  return (
    <div className="vp-sb">
      <div className="vp-sb-canvas">
        <svg
          viewBox={`0 0 ${bild.breite} ${bild.hoehe}`}
          width="100%"
          preserveAspectRatio="xMidYMin meet"
          className="vp-sb-svg"
          aria-label="Struktur-Schaltbild Ihrer Anlage"
        >
          <defs>
            <marker
              id="vp-sb-pfeil"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10z" className="vp-sb-pfeil" />
            </marker>
          </defs>

          {bild.spalten.map((s) => (
            <text key={s.titel} x={s.x} y={26} textAnchor="middle" className="vp-sb-spalte">
              {s.titel}
            </text>
          ))}

          {bild.kanten.map((k) => (
            <Kante key={k.id} kante={k} />
          ))}

          {bild.knoten.map((k) => (
            <Knoten key={k.id} knoten={k} onKomponente={onKomponente} />
          ))}
        </svg>
      </div>

      <ul className="vp-sb-legende">
        {bild.legende.map((l) => (
          <li key={l.art}>
            <svg width="26" height="10" aria-hidden="true">
              <line x1="1" y1="5" x2="25" y2="5" className={`vp-sb-kante art-${l.art}`} />
            </svg>
            {l.text}
          </li>
        ))}
      </ul>

      {bild.luecken.length > 0 && (
        <ul className="vp-sb-luecken">
          {bild.luecken.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kante({ kante }: { kante: SchaltbildKante }) {
  const rolle = kante.rolle ? ` rolle-${kante.rolle}` : '';
  return (
    <g className="vp-sb-kantengruppe">
      <line
        x1={kante.x1}
        y1={kante.y1}
        x2={kante.x2}
        y2={kante.y2}
        className={`vp-sb-kante art-${kante.art}${rolle}`}
        markerEnd={kante.pfeil ? 'url(#vp-sb-pfeil)' : undefined}
      />
      {kante.label && (
        <>
          <rect
            x={kante.labelX - labelBreite(kante) / 2}
            y={kante.labelY - 11}
            width={labelBreite(kante)}
            height={16}
            rx={5}
            className="vp-sb-labelbox"
          />
          <text
            x={kante.labelX}
            y={kante.labelY}
            textAnchor="middle"
            className={`vp-sb-label art-${kante.art}${rolle}`}
            {...(kante.labelKapp
              ? { textLength: kante.labelKapp, lengthAdjust: 'spacingAndGlyphs' as const }
              : {})}
          >
            {kante.label}
          </text>
        </>
      )}
    </g>
  );
}

/** Die Breite des Beschriftungs-Kästchens: die Kappbreite, sonst geschätzt. */
function labelBreite(k: SchaltbildKante): number {
  return (k.labelKapp ?? (k.label ?? '').length * 6.2) + 12;
}

function Knoten({
  knoten,
  onKomponente,
}: {
  knoten: SchaltbildKnoten;
  onKomponente?: (komponenteId: string) => void;
}) {
  const inhalt = <KnotenInhalt knoten={knoten} onKomponente={onKomponente} />;
  if (knoten.href) {
    return (
      <a href={knoten.href} className="vp-sb-link">
        {inhalt}
      </a>
    );
  }
  if (knoten.komponenteId && onKomponente) {
    const id = knoten.komponenteId;
    const onKey = (e: KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onKomponente(id);
      }
    };
    return (
      <g
        role="button"
        tabIndex={0}
        className="vp-sb-klick"
        onClick={() => onKomponente(id)}
        onKeyDown={onKey}
        aria-label={`${knoten.titel} — zur Zeile in der Geräte-Liste`}
      >
        {inhalt}
      </g>
    );
  }
  return inhalt;
}

function KnotenInhalt({
  knoten,
  onKomponente,
}: {
  knoten: SchaltbildKnoten;
  onKomponente?: (komponenteId: string) => void;
}) {
  const rolle = knoten.rolle ? ` rolle-${knoten.rolle}` : '';
  return (
    <g className={`vp-sb-knoten art-${knoten.art}${rolle} ton-${knoten.ton}`}>
      <rect
        x={knoten.x}
        y={knoten.y}
        width={knoten.w}
        height={knoten.h}
        rx={12}
        className={`vp-sb-box${knoten.gestrichelt ? ' gestrichelt' : ''}`}
      />
      <text
        x={knoten.x + 12}
        y={knoten.y + 20}
        className="vp-sb-titel"
        {...(knoten.titelKapp
          ? { textLength: knoten.titelKapp, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {knoten.titel}
      </text>
      {knoten.abzeichen && (
        <text x={knoten.x + knoten.w - 12} y={knoten.y + 20} textAnchor="end" className="vp-sb-abzeichen">
          {knoten.abzeichen}
        </text>
      )}
      {knoten.zeilen.map((z, i) => (
        <text
          key={`${knoten.id}-${i}`}
          x={knoten.x + 12}
          y={knoten.y + 20 + (i + 1) * 15}
          className={`vp-sb-zeile${z.ton ? ` ton-${z.ton}` : ''}`}
          {...(z.kapp ? { textLength: z.kapp, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
        >
          {z.text}
        </text>
      ))}
      {knoten.einheiten.map((e) => (
        <Knoten key={e.id} knoten={e} onKomponente={onKomponente} />
      ))}
    </g>
  );
}
