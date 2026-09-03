import type { ReactNode } from 'react';
import {
  BALKEN_BREITE,
  BALKEN_HOEHE,
  balkenGeometrie,
  type ErgebnisZeilenView,
  type ErloesZeile,
  type ErloesZeileId,
  type SekundaerZiel,
} from '../../erloesZeilen';

/**
 * **Der Kontoauszug** — Bauteil 2 der Variante C (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (2), Anatomie §3.2 (3)–(5)).
 *
 * Vier Ledger-Zeilen, jede `Name · Sekundärzeile · Balken · Betrag · Chevron`;
 * die Ergebnis-Zeile ist die hervorgehobene SUMMENZEILE auf Muted mit einer
 * 2-px-Linie in Foreground.
 *
 * ⚠ **Der Wasserfall wohnt IN den Zeilen** (E10, aus P3/P4 übernommen): jede
 *   Zeile trägt ihren Balken auf der GEMEINSAMEN Skala, die Zwischensumme
 *   wandert von Zeile zu Zeile, der letzte Balken IST die Statement-Zahl.
 *   Name und Betrag stehen dadurch genau einmal.
 *
 * ⚠ **Reines SVG, kein ECharts:** der Balken rechnet in einem festen
 *   Koordinatenraum und wird per `preserveAspectRatio="none"` gedehnt — keine
 *   Messung, kein Resize-Beobachter, kein Canvas-Text. Die Geometrie kommt aus
 *   der reinen `balkenGeometrie()` und ist ohne Browser prüfbar.
 *
 * ⚠ **KEIN Chip in einer Zeile** (§2 Prinzip 5, Befund B3): Mengen, Preis-
 *   herkunft und fehlende Wege stehen in der Sekundärzeile. Ein Chip trägt in
 *   Variante C ausschliesslich ein ZUSTANDSWORT, und davon hat der Ledger
 *   keines — sein Zustand IST sein Betrag.
 *
 * ⚠ **KEIN farbiger Punkt vor dem Namen:** der Balken ist die Kennung
 *   (§2 Prinzip 4). Zwei Träger derselben Farbe waren Befund B2.
 */

/** Der Balken EINER Zeile auf der gemeinsamen Skala. */
function Balken({
  geometrie,
  farbe,
}: {
  geometrie: ReturnType<typeof balkenGeometrie>[number];
  farbe: string;
}) {
  return (
    <svg
      className="vp-c-led-bar"
      viewBox={`0 0 ${BALKEN_BREITE} ${BALKEN_HOEHE}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="vp-c-led-bar-base" x={0} y={0} width={BALKEN_BREITE} height={BALKEN_HOEHE} />
      {geometrie.balken && (
        <rect
          className="vp-c-led-bar-fill"
          x={geometrie.balken.x}
          y={0}
          width={geometrie.balken.breite}
          height={BALKEN_HOEHE}
          fill={farbe}
        />
      )}
      {/* Die Null steht in JEDEM Balken an derselben Stelle — sonst wäre die
          gemeinsame Skala nicht ablesbar. `non-scaling-stroke`, weil das SVG
          horizontal gedehnt wird. */}
      <line
        className="vp-c-led-bar-zero"
        x1={geometrie.nullX}
        y1={0}
        x2={geometrie.nullX}
        y2={BALKEN_HOEHE}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Die Sekundärzeile — Teile mit „ · " verbunden, der Weg als Textlink. */
function Sekundaer({
  zeile,
  hrefFor,
}: {
  zeile: ErloesZeile;
  hrefFor?: (ziel: SekundaerZiel) => string | undefined;
}) {
  const s = zeile.sekundaer;
  if (!s) return null;
  const href = s.link ? hrefFor?.(s.link.ziel) : undefined;
  const klasse = s.ton === 'warn' ? 'vp-c-led-sek is-warn' : 'vp-c-led-sek';
  return (
    <span className={klasse} title={s.titel ?? undefined}>
      {s.teile.join(' · ')}
      {s.link && (
        <>
          {s.teile.length > 0 && ' · '}
          {/* Ohne Ziel bleibt der Weg ruhiger Text — nie ein Knopf, der
              nirgends hinführt (das `SpeicherBlock.nachtragHref`-Muster). */}
          {href ? <a href={href}>{s.link.text}</a> : <span>{s.link.text}</span>}
        </>
      )}
    </span>
  );
}

/** Der Inhalt einer Zeile — geteilt von der antippbaren und der ruhigen Form. */
function ZeilenInhalt({
  zeile,
  geometrie,
  hrefFor,
  chevron,
}: {
  zeile: ErloesZeile;
  geometrie: ReturnType<typeof balkenGeometrie>[number];
  hrefFor?: (ziel: SekundaerZiel) => string | undefined;
  chevron: boolean;
}) {
  return (
    <>
      <span className="vp-c-led-name">{zeile.name}</span>
      <span className={`vp-c-led-val is-${zeile.ton}`}>{zeile.text}</span>
      <span className="vp-c-led-barwrap">
        <Balken geometrie={geometrie} farbe={zeile.farbe} />
      </span>
      <Sekundaer zeile={zeile} hrefFor={hrefFor} />
      {chevron && <span className="vp-c-led-chev" aria-hidden="true" />}
    </>
  );
}

export interface KontoauszugProps {
  /** Das Label der Karte, 12/700 Versalien. */
  label?: string;
  view: ErgebnisZeilenView;
  /**
   * Ebene 1 der Zeile. Fehlt sie, bleibt die Zeile eine ruhige Zeile —
   * ein Aufklapper ohne Inhalt wäre ein Versprechen ins Leere.
   */
  ebene1?: (id: ErloesZeileId) => ReactNode | null;
  /** Wohin ein Weg der Sekundärzeile führt; ohne Auflösung bleibt er Text. */
  hrefFor?: (ziel: SekundaerZiel) => string | undefined;
  /**
   * Zeilen AUSSERHALB des Wasserfalls (Lastspitzen): eigene Abrechnungs-
   * periode, nie ein Summand der einen Zahl.
   */
  ausserhalb?: ReactNode;
  /** Der Perioden-Hinweis unter dem Auszug. */
  note?: ReactNode;
}

export function Kontoauszug({
  label = 'Kontoauszug',
  view,
  ebene1,
  hrefFor,
  ausserhalb,
  note,
}: KontoauszugProps) {
  const geo = balkenGeometrie(view);
  return (
    <section className="vp-c-card vp-c-auszug">
      <h3 className="vp-c-label">
        <span className="vp-c-label-text">{label}</span>
      </h3>
      <ul className="vp-c-led" aria-label="Woraus sich das Ergebnis zusammensetzt">
        {view.zeilen.map((zeile, i) => {
          const inhalt = ebene1?.(zeile.id) ?? null;
          const klasse =
            zeile.id === 'ergebnis' ? 'vp-c-led-row vp-c-led-row-erg' : 'vp-c-led-row';
          return (
            <li key={zeile.id} className={klasse}>
              {inhalt ? (
                <details className="vp-c-led-det">
                  <summary className="vp-c-led-sum">
                    <ZeilenInhalt
                      zeile={zeile}
                      geometrie={geo[i]}
                      hrefFor={hrefFor}
                      chevron
                    />
                  </summary>
                  {inhalt}
                </details>
              ) : (
                <div className="vp-c-led-sum">
                  <ZeilenInhalt
                    zeile={zeile}
                    geometrie={geo[i]}
                    hrefFor={hrefFor}
                    chevron={false}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {ausserhalb}
      {note}
    </section>
  );
}
