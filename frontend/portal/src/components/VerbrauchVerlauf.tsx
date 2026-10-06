import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { infozeile, TIPP_HINWEIS, VERBRAUCH_VERLAUF_TITEL, verlaufListe, type VerlaufBild } from '../verbrauch';

/**
 * „Strom je Monat“ (Konzept Auswerten a1 §6.12, Form 3 „Verlauf mit Vorjahr“): zwölf Säulen ab null, der gewählte
 * Monat kräftig, das Vorjahr als Punkt auf der Säule; ein Monat ohne Wert bleibt eine leere, gestrichelte Säule.
 * Über der Grafik steht die Infozeile, die man ohne Antippen liest — sie zeigt zuerst den jüngsten Monat (oder den
 * gewählten) und wechselt beim Antippen, beim Fahren mit dem Finger und mit den Pfeiltasten; nichts legt sich über die
 * Säulen. Der rohe Vorjahresvergleich bekommt keine Urteilsfarbe.
 *
 * Die Zeichenfläche trägt nur Marken; alle Texte (Achse, Monate, Jahre) sind HTML und behalten bei jeder Breite ihre
 * Schriftgröße. Für Vorleser stehen dieselben Werte als Liste darunter.
 */
export function VerbrauchVerlauf({
  bild,
  antwort,
  rechts,
  gewaehlt,
  tippHinweis,
}: {
  bild: VerlaufBild;
  /** Der Antwortsatz der Fläche — die Bezeichnung der Grafik für Vorleser. */
  antwort: string;
  /** Rechts im Blockkopf: „kWh“ am Telefon, der Zeitraum am Rechner. */
  rechts: string;
  /** Der Monat, der zuerst in der Infozeile steht (`YYYY-MM`); ohne: der jüngste. */
  gewaehlt?: string;
  tippHinweis: boolean;
}) {
  const start = () => {
    const i = gewaehlt ? bild.saeulen.findIndex((s) => s.monat === gewaehlt) : -1;
    return i >= 0 ? i : bild.saeulen.length - 1;
  };
  // Ein neuer Zeitraum beginnt wieder beim gewählten bzw. jüngsten Monat: der Aufrufer setzt dafür `key`.
  const [wahl, setWahl] = useState(start);
  const flaeche = useRef<HTMLDivElement>(null);
  const ziehen = useRef(false);
  const s = bild.saeulen[Math.min(wahl, bild.saeulen.length - 1)];
  if (!s) return null;
  const info = infozeile(s);

  const anStelle = (clientX: number) => {
    const el = flaeche.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const i = Math.floor(((clientX - r.left) / r.width) * bild.saeulen.length);
    setWahl(Math.max(0, Math.min(bild.saeulen.length - 1, i)));
  };
  const runter = (e: PointerEvent<HTMLDivElement>) => {
    ziehen.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    anStelle(e.clientX);
  };
  const bewegen = (e: PointerEvent<HTMLDivElement>) => {
    if (ziehen.current) anStelle(e.clientX);
  };
  const hoch = () => {
    ziehen.current = false;
  };
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setWahl((w) => Math.max(0, Math.min(bild.saeulen.length - 1, w + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setWahl(e.key === 'Home' ? 0 : bild.saeulen.length - 1);
    }
  };
  const spalten = { gridTemplateColumns: `repeat(${bild.saeulen.length}, minmax(0, 1fr))` };
  const jahre = bild.saeulen.flatMap((x, i) => (x.jahr ? [{ jahr: x.jahr, ab: i + 1 }] : []));

  return (
    <section className="vp-vb-karte vp-vb-verlauf" aria-labelledby="vp-vb-verlauf-titel" data-testid="verbrauch-verlauf">
      <div className="vp-vb-blockkopf">
        <h2 id="vp-vb-verlauf-titel">{VERBRAUCH_VERLAUF_TITEL}</h2>
        <span className="vp-vb-m">{rechts}</span>
      </div>
      <div className="vp-vb-infozeile" aria-live="polite" data-testid="verbrauch-infozeile">
        <span className="vp-vb-info-erste">
          <b>{info.monat}</b>
          <span className="vp-vb-info-wert">{info.wert}</span>
        </span>
        {info.vorjahr && (
          <span className="vp-vb-info-zweite">
            {info.vorjahr}
            {info.vergleich && <b>{info.vergleich}</b>}
          </span>
        )}
      </div>
      <div className="vp-vb-graf">
        <div className="vp-vb-graf-y" aria-hidden="true">
          {bild.achse.map((a) => (
            <span key={a.wert} className="vp-vb-graf-sizer">
              {a.text}
            </span>
          ))}
          {bild.achse.map((a) => (
            <span key={`t-${a.wert}`} className="vp-vb-graf-at" style={{ bottom: `${a.hoehe}%` }}>
              {a.text}
            </span>
          ))}
        </div>
        <div
          ref={flaeche}
          className="vp-vb-graf-p"
          role="img"
          aria-label={antwort}
          tabIndex={0}
          onPointerDown={runter}
          onPointerMove={bewegen}
          onPointerUp={hoch}
          onPointerCancel={hoch}
          onKeyDown={taste}
          data-testid="verbrauch-verlauf-flaeche"
        >
          {bild.achse.map((a) => (
            <i key={a.wert} className="vp-vb-graf-linie" style={{ bottom: `${a.hoehe}%` }} />
          ))}
          <div className="vp-vb-graf-saeulen" style={spalten}>
            {bild.saeulen.map((x, i) => (
              <span key={x.monat} className="vp-vb-graf-spalte">
                <i
                  className={`vp-vb-saeule${x.wert === null ? ' is-leer' : ''}${!x.vollstaendig && x.wert !== null ? ' is-teil' : ''}${i === wahl ? ' is-wahl' : ''}`}
                  style={x.wert === null ? undefined : { height: `${x.hoehe}%` }}
                />
                {x.vorjahrHoehe !== null && <i className="vp-vb-punkt" style={{ bottom: `${x.vorjahrHoehe}%` }} />}
              </span>
            ))}
          </div>
        </div>
        <div className="vp-vb-graf-x" aria-hidden="true" style={spalten}>
          {bild.saeulen.map((x, i) => (
            <span key={x.monat} className={i === wahl ? 'is-wahl' : undefined}>
              <span className="vp-vb-ml">{x.kurz}</span>
              <span className="vp-vb-mk">{x.buchstabe}</span>
            </span>
          ))}
        </div>
        <div className="vp-vb-graf-j" aria-hidden="true" style={spalten}>
          {jahre.map((j, k) => (
            <span key={j.jahr} style={{ gridColumn: `${j.ab} / ${jahre[k + 1]?.ab ?? bild.saeulen.length + 1}` }}>
              {j.jahr}
            </span>
          ))}
        </div>
      </div>
      <div className="vp-vb-legende" aria-hidden="true">
        <span>
          <i className="is-jahr" />
          dieses Jahr
        </span>
        <span>
          <i className="is-vorjahr" />
          Vorjahr (Punkt)
        </span>
      </div>
      {tippHinweis && (
        <p className="vp-vb-tipp">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" />
            <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
          </svg>
          {TIPP_HINWEIS}
        </p>
      )}
      <ul className="vp-vb-nurvorleser">
        {verlaufListe(bild).map((z) => (
          <li key={z}>{z}</li>
        ))}
      </ul>
    </section>
  );
}
