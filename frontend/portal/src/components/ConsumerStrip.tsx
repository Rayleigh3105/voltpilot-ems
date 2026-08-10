/**
 * Der Cockpit-VERBRAUCHERSTREIFEN (§14.10): eine ruhige Zeile je steuerbarem
 * Verbraucher mit gemessener Leistung / Nennleistung und seinem Live-Zustand,
 * darüber die Σ. Reine Anzeige - die EINE Ableitung ist `consumers/fulfillment.ts`
 * `consumerStrip`, die NULL zurückgibt, wenn es keine Verbraucher gibt (dann
 * rendert diese Komponente gar nichts, und das Cockpit ist byte-identisch zu
 * vorher). Ein Verbraucher ohne Messwert zeigt „—", nie eine erfundene 0.
 */
import { fmtNum } from '../format';
import type { ConsumerStripView } from '../consumers/fulfillment';

/** de-DE, one decimal, no unit (the ratio "3,0 / 11" shares one "kW"). */
const de1 = (v: number): string =>
  v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function ConsumerStrip({
  view,
  onOpen,
}: {
  view: ConsumerStripView | null;
  /** Absprung in die Verbraucher-Fläche der Anlage. */
  onOpen?: () => void;
}): JSX.Element | null {
  if (!view || view.rows.length === 0) return null;
  return (
    <section className="vp-cstrip" aria-label="Steuerbare Verbraucher">
      <header className="vp-cstrip-head">
        <span className="vp-cstrip-title">Steuerbare Verbraucher</span>
        <span className="vp-cstrip-sum">
          {view.sumKw != null ? fmtNum(view.sumKw, 'kW') : '—'}
        </span>
        {onOpen && (
          <button type="button" className="vp-cstrip-more" onClick={onOpen}>
            Verbraucher
          </button>
        )}
      </header>
      <ul className="vp-cstrip-list">
        {view.rows.map((r, i) => (
          <li key={i} className={`vp-cstrip-row vp-cstrip-${r.tone}`}>
            <span className="vp-dot" />
            <span className="vp-cstrip-name">{r.name}</span>
            <span className="vp-cstrip-power">
              {r.actualKw != null ? de1(r.actualKw) : '—'} / {de1(r.ratedKw)} kW
            </span>
            <span className="vp-cstrip-state">
              {r.text}
              {r.reason ? ` · ${r.reason}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
