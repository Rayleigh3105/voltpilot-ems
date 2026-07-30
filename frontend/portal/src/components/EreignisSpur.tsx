import { useState } from 'react';
import { chartTheme, type ChartTheme } from '../chartTheme';
import {
  CHIPS_SICHTBAR,
  type EreignisChip,
  type EreignisFarbe,
  type EreignisSpurView,
} from '../historieEreignisse';

import './Ereignisse.css';

/**
 * **Die Ereignis-Spur unter dem Diagramm** (F6, Konzept
 * `data/vp-historie-konzept-t4`) — render-only: alle Regeln, Texte und
 * Reihenfolgen entscheidet das reine `historieEreignisse.ts`.
 *
 * Sie beantwortet die Frage, die das Diagramm bisher offen ließ: *warum* bricht
 * dieser Balken ein? Jeder Chip nennt Zeit und Grund im Klartext und trägt die
 * Farbe, in der dasselbe Ereignis als Band im Diagramm liegt — so gehören
 * Marker und Erklärung sichtbar zusammen.
 *
 * Ab Woche/Monat/Jahr ist ein Chip zugleich der Sprung in seinen Tag (F5); am
 * Tag gibt es nichts feineres zu öffnen, dort ist er ruhige Information.
 */

/** Ein reiner Farbschlüssel -> der aufgelöste Chart-Hex. */
export function ereignisFarbe(t: ChartTheme, key: EreignisFarbe): string {
  switch (key) {
    case 'discharge':
      return t.discharge;
    case 'pv':
      return t.pv;
    case 'flowGrid':
      return t.flowGrid;
    case 'gridCharge':
      return t.gridCharge;
    case 'cloud':
    default:
      return t.cloud;
  }
}

function Punkt({ color }: { color: string }) {
  return (
    <span
      className="vp-ereignis-dot"
      style={{ ['--dot' as string]: color }}
      aria-hidden="true"
    />
  );
}

function Chip({
  chip,
  color,
  onTagOeffnen,
}: {
  chip: EreignisChip;
  color: string;
  onTagOeffnen?: (at: string) => void;
}) {
  const inhalt = (
    <>
      <Punkt color={color} />
      <span className="vp-ereignis-zeit">{chip.zeit}</span>
      <span className="vp-ereignis-text">{chip.text}</span>
    </>
  );
  if (chip.sprungAt && onTagOeffnen) {
    return (
      <button
        type="button"
        className="vp-ereignis-chip is-link"
        title={`${chip.titel} — diesen Tag öffnen`}
        onClick={() => onTagOeffnen(chip.sprungAt as string)}
      >
        {inhalt}
      </button>
    );
  }
  return (
    <span className="vp-ereignis-chip" title={chip.titel}>
      {inhalt}
    </span>
  );
}

export function EreignisSpur({
  spur,
  onTagOeffnen,
  protokollHinweis,
}: {
  spur: EreignisSpurView;
  /** Der Sprung in den Tag (F5) — fehlt er, sind die Chips reine Information. */
  onTagOeffnen?: (at: string) => void;
  /**
   * Der Verweis auf die Tagesprotokoll-Liste derselben Seite (nur dort, wo sie
   * wirklich darunter steht) — nie ein Link ins Leere.
   */
  protokollHinweis?: string | null;
}) {
  const [alle, setAlle] = useState(false);
  const t = chartTheme();
  const sichtbar = alle ? spur.chips : spur.chips.slice(0, CHIPS_SICHTBAR);
  const rest = spur.chips.length - sichtbar.length;

  return (
    <section className="vp-ereignis-spur" aria-label="Besondere Ereignisse im Zeitraum">
      {spur.arten.length > 0 && (
        <p className="vp-ereignis-legende">
          {spur.arten.map(({ art, info }) => (
            <span key={art} className="vp-ereignis-legendeitem" title={info.erklaerung}>
              <Punkt color={ereignisFarbe(t, info.farbe)} />
              {info.label}
            </span>
          ))}
        </p>
      )}

      {spur.leerText ? (
        <p className="vp-note vp-ereignis-leer">{spur.leerText}</p>
      ) : (
        <div className="vp-ereignis-chips">
          {sichtbar.map((c) => (
            <Chip
              key={c.key}
              chip={c}
              color={ereignisFarbe(t, c.info.farbe)}
              onTagOeffnen={onTagOeffnen}
            />
          ))}
          {rest > 0 && (
            <button
              type="button"
              className="vp-ereignis-mehr"
              onClick={() => setAlle(true)}
            >
              {rest} weitere anzeigen
            </button>
          )}
        </div>
      )}

      {protokollHinweis && <p className="vp-note">{protokollHinweis}</p>}
      {spur.hinweis && <p className="vp-note vp-ereignis-hinweis">{spur.hinweis}</p>}
    </section>
  );
}
