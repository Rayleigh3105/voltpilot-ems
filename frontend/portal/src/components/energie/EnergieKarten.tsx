import { chartTheme } from '../../chartTheme';
import type { EnergieRolle, Quote, Spitze } from '../../energieSeite';
import { VrKarte } from '../VerlaufRahmen';
import './EnergieSeite.css';

/**
 * Die Karten neben dem Energie-Diagramm (Konzept „Verlauf-Rework", Paket P3):
 * wie viel selbst versorgt war und die Spitzen des Zeitraums. Reine
 * Render-Bausteine über `energieSeite.ts`; die Ereignisse stehen in
 * `EreignisKarte.tsx`.
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
