import type { ReactNode } from 'react';
import {
  BALKEN_BREITE,
  BALKEN_HOEHE,
  balkenGeometrie,
  type ErgebnisZeilenView,
  type ErloesZeile,
  type ErloesZeileId,
} from '../erloesZeilen';

/**
 * **Ebene 0 der Ergebnis-Karte** (Konzept `vp-erloese-seite-konzept-e2` §3.2,
 * Revision 2): eine Zahl, ein Satz von höchstens acht Wörtern und die vier
 * Zeilen, in denen der Wasserfall WOHNT.
 *
 * ⚠ **Der Wasserfall steht nicht mehr über den Zeilen, sondern IN ihnen.**
 * Ein freistehendes Bild musste jeden Namen und jeden Betrag ein zweites Mal
 * beschriften; jetzt trägt jede Zeile ihren eigenen Balken auf der GEMEINSAMEN
 * Skala, die Zwischensumme wandert von Zeile zu Zeile, und der letzte Balken
 * IST die Hero-Zahl. Name und Betrag stehen dadurch genau einmal.
 *
 * ⚠ **Reines SVG, kein ECharts (E10 = a).** Der Balken rechnet in einem festen
 * Koordinatenraum und wird per `preserveAspectRatio="none"` auf die echte
 * Breite gezogen — es gibt keinen Text im SVG, keine Messung, keinen
 * Resize-Beobachter und damit auch keine der Fallen, an denen Canvas-Diagramme
 * in Headless-Umgebungen scheitern. Die Geometrie kommt aus der reinen
 * `balkenGeometrie()`, ist also ohne Browser prüfbar.
 *
 * ⚠ **Die Reihenfolge ist auf JEDER Breite dieselbe** (§3.2): kein
 * `isPhone`-Umsortieren mehr. Am Telefon steht der Name über dem Balken, ab
 * 600 px daneben — das entscheidet allein das CSS.
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
      className="vp-ez-bar"
      viewBox={`0 0 ${BALKEN_BREITE} ${BALKEN_HOEHE}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Die Grundlinie macht die Skala sichtbar, auch wo der Balken kurz ist. */}
      <rect
        className="vp-ez-bar-base"
        x={0}
        y={BALKEN_HOEHE / 2 - 1}
        width={BALKEN_BREITE}
        height={2}
      />
      {geometrie.balken && (
        <rect
          className="vp-ez-bar-fill"
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
        className="vp-ez-bar-zero"
        x1={geometrie.nullX}
        y1={0}
        x2={geometrie.nullX}
        y2={BALKEN_HOEHE}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Der Inhalt einer Zeile — geteilt von der antippbaren und der ruhigen Form. */
function ZeilenInhalt({
  zeile,
  geometrie,
}: {
  zeile: ErloesZeile;
  geometrie: ReturnType<typeof balkenGeometrie>[number];
}) {
  return (
    <>
      <span className="vp-ez-dot" style={{ background: zeile.farbe }} aria-hidden="true" />
      <span className="vp-ez-name">{zeile.name}</span>
      <span className={`vp-ez-val vp-ez-t-${zeile.ton}`}>{zeile.text}</span>
      <span className="vp-ez-barwrap">
        <Balken geometrie={geometrie} farbe={zeile.farbe} />
      </span>
      <span className="vp-ez-chipwrap">
        {zeile.chip && (
          <span
            className={`vp-ez-chip vp-ez-chip-${zeile.chip.ton}`}
            title={zeile.chip.titel ?? undefined}
          >
            {zeile.chip.text}
          </span>
        )}
      </span>
    </>
  );
}

export interface ErgebnisZeilenProps {
  view: ErgebnisZeilenView;
  /**
   * Ebene 1 der Zeile (P4). Fehlt sie, bleibt die Zeile eine ruhige Zeile —
   * ein Aufklapper ohne Inhalt wäre ein Versprechen ins Leere.
   */
  ebene1?: (id: ErloesZeileId) => ReactNode | null;
  /** Der Speicher-Block (§3.5) — eigene Unterfläche, eigener Ton. */
  speicher?: ReactNode;
  /** Die Einordnung: der Vergleich in EINER Zeile, nur wenn er abweicht. */
  einordnung?: ReactNode;
  /** Ebene 2 („Preise & Vergütung") als Aufklapper. */
  ebene2?: ReactNode;
}

export function ErgebnisZeilen({
  view,
  ebene1,
  speicher,
  einordnung,
  ebene2,
}: ErgebnisZeilenProps) {
  const geo = balkenGeometrie(view);
  return (
    <div className="vp-ez">
      <div className="vp-ez-links">
        {view.hero && (
          <p className={`vp-ez-hero vp-ez-hero-${view.hero.ton}`}>{view.hero.text}</p>
        )}
        <p className="vp-ez-satz">{view.satz}</p>
        <ul className="vp-ez-list" aria-label="Woraus sich das Ergebnis zusammensetzt">
          {view.zeilen.map((zeile, i) => {
            const inhalt = ebene1?.(zeile.id) ?? null;
            const klasse = zeile.id === 'ergebnis' ? 'vp-ez-row vp-ez-row-erg' : 'vp-ez-row';
            return (
              <li key={zeile.id} className={klasse}>
                {inhalt ? (
                  <details className="vp-ez-det">
                    <summary className="vp-ez-sum">
                      <ZeilenInhalt zeile={zeile} geometrie={geo[i]} />
                      <span className="vp-ez-chev" aria-hidden="true" />
                    </summary>
                    {inhalt}
                  </details>
                ) : (
                  <div className="vp-ez-sum vp-ez-sum-still">
                    <ZeilenInhalt zeile={zeile} geometrie={geo[i]} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="vp-ez-rechts">
        {speicher}
        {einordnung}
        {ebene2}
      </div>
    </div>
  );
}
