import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { lage, type Balkenliste as BalkenlisteView, type BalkenSkala, type BalkenZeile } from '../../balkenliste';
import { chartMotion } from '../../chartMotion';
import type { SekundaerZiel } from '../../erloesZeilen';
import { Erklaert } from '../VerlaufRahmen';
import './Balkenliste.css';

/**
 * Die **Balkenliste** der Erlöse-Karten — ein reiner Renderer über
 * `balkenliste.ts` (Konzept „Erlöse · Preise und Verdienst", 25.09.2026).
 *
 * Name und Zahl stehen als TEXT, der Balken ist nur ihr Bild (`aria-hidden`):
 * ein Screenreader liest dieselbe Geschichte wie das Auge, und im Bild steht
 * nichts, was bei 375 px überlappen könnte. Die Farben kommen als Rolle
 * (`data-rolle`) und lösen in `Balkenliste.css` auf die Chart-Token auf —
 * dieselben, die `chartTheme()` für Kennzahlen und Abrechnung liest.
 *
 * **Bewegung** (docs/agents/portal/bewegung.md, P1/P3): die Balken wachsen
 * NICHT, sie werden aufgedeckt — jeder steht ab dem ersten Bild auf seinem
 * wahren Wert, bewegt wird nur eine Maske. Aufgedeckt wird GENAU EINMAL, beim
 * ersten Sichtbarwerden (am Telefon liegen die Karten unter der Falz); ein
 * späterer Zeitraumwechsel lässt die Breiten zwischen zwei echten Zuständen
 * gleiten. Unter reduzierter Bewegung steht alles sofort.
 */
export function Balkenliste({
  liste,
  hrefFor,
}: {
  liste: BalkenlisteView;
  /** Der Weg zu einer fehlenden Eingabe („Tarif hinterlegen ›"). Ohne ihn kein Link. */
  hrefFor?: (ziel: SekundaerZiel) => string;
}) {
  const [ref, aufdecken] = useAufdecken<HTMLDivElement>();
  return (
    <div className="vp-bl-rahmen" ref={ref} data-aufdecken={aufdecken ? 'laeuft' : undefined}>
      <ul className="vp-bl" aria-label={liste.label}>
        {liste.zeilen.map((z, i) => (
          <Zeile key={z.id} z={z} i={i} skala={liste.skala} hrefFor={hrefFor} />
        ))}
      </ul>
    </div>
  );
}

function Zeile({
  z,
  i,
  skala,
  hrefFor,
}: {
  z: BalkenZeile;
  i: number;
  skala: BalkenSkala;
  hrefFor?: (ziel: SekundaerZiel) => string;
}) {
  const letzte = z.segmente.length - 1;
  return (
    <li
      className={`vp-bl-zeile${z.summe ? ' summe' : ''}`}
      data-zeile={z.id}
      style={{ '--i': i } as CSSProperties}
    >
      <span className="vp-bl-name">
        {z.rolle && <i className="vp-bl-key" data-rolle={z.rolle} aria-hidden="true" />}
        <span className="vp-bl-name-text">{z.name}</span>
        <Erklaert info={z.info ?? null} />
      </span>
      <span className={`vp-bl-wert${!z.vorhanden ? ' leer' : z.minus ? ' minus' : ''}`}>{z.wert}</span>
      <span className={`vp-bl-spur${z.segmente.length ? '' : ' leer'}`} aria-hidden="true">
        {z.segmente.map((s, k) => {
          const links = lage(Math.min(s.von, s.bis), skala);
          const breite = lage(Math.max(s.von, s.bis), skala) - links;
          const klassen = [
            'vp-bl-seg',
            k === 0 ? 'anfang' : null,
            k === letzte ? 'ende' : null,
            s.vorlaeufig ? 'vorlaeufig' : null,
            s.danach ? 'danach' : null,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <i
              key={`${s.rolle}-${k}`}
              className={klassen}
              data-rolle={s.rolle}
              style={{ left: prozent(links), width: prozent(breite) }}
            />
          );
        })}
        {skala.min < 0 && <i className="vp-bl-null" style={{ left: prozent(lage(0, skala)) }} />}
      </span>
      {z.unter && (
        <span className="vp-bl-unter">
          {z.unter.schluessel && (
            <i className="vp-bl-key klein" data-rolle={z.unter.schluessel} aria-hidden="true" />
          )}
          {z.unter.text}
          {z.unter.link && hrefFor && (
            <>
              {' · '}
              <a className="vp-vr-link" href={hrefFor(z.unter.link.ziel)}>
                {z.unter.link.text}
              </a>
            </>
          )}
        </span>
      )}
    </li>
  );
}

/** Eine Lage in Prozent — auf drei Stellen, damit das DOM keine Gleitkomma-Reste trägt. */
function prozent(v: number): string {
  return `${Math.round(v * 1000) / 1000}%`;
}

/**
 * Deckt die Liste GENAU EINMAL auf, sobald sie sichtbar wird — dasselbe Muster
 * wie `useEChart` (P1): kein Vorab-Verstecken (ohne Beobachter, im Druck oder
 * in jsdom steht die Liste einfach), Schalter 0 ⇒ keine Klasse, und
 * aufgeräumt wird per Frist, nie über `animationend` (ein Tabwechsel liefert
 * das Ereignis nie).
 */
function useAufdecken<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [laeuft, setLaeuft] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    let frist: number | undefined;
    const io = new IntersectionObserver(
      (eintraege) => {
        if (!eintraege.some((e) => e.isIntersecting) || el.clientWidth === 0) return;
        io.disconnect();
        const m = chartMotion();
        if (m.scale === 0 || m.enter <= 0) return;
        setLaeuft(true);
        // Maske (chart) + Prämien-Block (≈ enter) + Staffel — großzügig.
        frist = window.setTimeout(() => setLaeuft(false), m.enter * 2 + 200);
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(frist);
    };
  }, []);
  return [ref, laeuft];
}
