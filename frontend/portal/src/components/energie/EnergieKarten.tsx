import { useState } from 'react';
import { chartTheme } from '../../chartTheme';
import type { EnergieRolle, Quote, Spitze } from '../../energieSeite';
import type { EreignisSpurView } from '../../historieEreignisse';
import { VrKarte } from '../VerlaufRahmen';
import './EnergieSeite.css';

/**
 * Die Karten neben dem Energie-Diagramm (Konzept „Verlauf-Rework", Paket P3):
 * wie viel selbst versorgt war, die Spitzen des Zeitraums und das Auffällige.
 * Reine Render-Bausteine über `energieSeite.ts` bzw. `historieEreignisse.ts`.
 */

export function rollenFarbe(rolle: EnergieRolle): string {
  const t = chartTheme();
  return rolle === 'pv' ? t.cPv : rolle === 'load' ? t.cLoad : rolle === 'grid' ? t.cGrid : t.cBatt;
}

/** **Selbst versorgt** — Autarkie und Eigenverbrauch als Balken statt als Sätze. */
export function QuotenKarte({ quoten }: { quoten: readonly Quote[] }) {
  const hat = quoten.some((q) => q.pct != null);
  return (
    <VrKarte titel="Selbst versorgt">
      {hat ? (
        <div className="vp-vr-quoten">
          {quoten.map((q) => (
            <div key={q.key} className="vp-vr-quote">
              <div className="vp-vr-quote-kopf">
                <span>{q.name}</span>
                <b>{q.wert}</b>
              </div>
              {q.teile.length > 0 && (
                <>
                  <div
                    className="vp-vr-quote-balken"
                    role="img"
                    aria-label={q.teile.map((t) => `${t.label} ${t.menge}`).join(', ')}
                  >
                    {q.teile.map((t) => (
                      <i
                        key={t.label}
                        style={{ width: `${Math.max(0, Math.min(100, t.anteilPct))}%`, background: rollenFarbe(t.rolle) }}
                      />
                    ))}
                  </div>
                  <div className="vp-vr-quote-teile">
                    {q.teile.map((t) => (
                      <span key={t.label}>
                        <i style={{ background: rollenFarbe(t.rolle) }} aria-hidden="true" />
                        {t.label} {t.menge}
                      </span>
                    ))}
                  </div>
                </>
              )}
              <p className="vp-vr-foot">{q.info}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="vp-vr-empty">Für diesen Zeitraum lassen sich keine Quoten berechnen.</p>
      )}
    </VrKarte>
  );
}

/** **Spitzenwerte** des Zeitraums — in seiner Auflösung. */
export function SpitzenKarte({ titel, zeilen }: { titel: string; zeilen: readonly Spitze[] }) {
  return (
    <VrKarte titel={titel} label="Spitzenwerte">
      <dl className="vp-vr-kv">
        {zeilen.map((z) => (
          <div key={z.label}>
            <dt>
              <span className="vp-vr-key" style={{ background: rollenFarbe(z.rolle) }} aria-hidden="true" /> {z.label}
              {z.wann && <small> · {z.wann}</small>}
            </dt>
            <dd>{z.wert}</dd>
          </div>
        ))}
      </dl>
    </VrKarte>
  );
}

const SICHTBAR = 6;

/**
 * **Ereignisse** — das Auffällige des Zeitraums als Liste (statt des
 * Tagesprotokolls). Ab der Woche öffnet ein Eintrag seinen Tag.
 */
export function EreignisseKarte({
  spur,
  onTag,
}: {
  spur: EreignisSpurView;
  onTag?: (at: string) => void;
}) {
  const [alle, setAlle] = useState(false);
  const chips = alle ? spur.chips : spur.chips.slice(0, SICHTBAR);
  return (
    <VrKarte titel="Ereignisse" sub={spur.chips.length > 0 ? String(spur.chips.length) : undefined}>
      {spur.chips.length === 0 ? (
        <p className="vp-vr-empty">{spur.leerText ?? 'Nichts Auffälliges in diesem Zeitraum.'}</p>
      ) : (
        <ul className="vp-vr-ereignisse">
          {chips.map((c) => {
            const inhalt = (
              <>
                <span className="vp-vr-ereignis-zeit">{c.zeit}</span>
                <span className="vp-chip">{c.info.label}</span>
                <span className="vp-vr-ereignis-text">{c.text}</span>
              </>
            );
            return (
              <li key={c.key} title={c.info.erklaerung}>
                {onTag && c.sprungAt ? (
                  <button type="button" className="vp-vr-ereignis" onClick={() => onTag(c.sprungAt as string)}>
                    {inhalt}
                  </button>
                ) : (
                  <div className="vp-vr-ereignis">{inhalt}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {spur.chips.length > SICHTBAR && (
        <button type="button" className="vp-vr-textbtn" onClick={() => setAlle((a) => !a)}>
          {alle ? 'Weniger zeigen' : `Alle ${spur.chips.length} zeigen`}
        </button>
      )}
      {spur.hinweis && <p className="vp-vr-foot">{spur.hinweis}</p>}
    </VrKarte>
  );
}
