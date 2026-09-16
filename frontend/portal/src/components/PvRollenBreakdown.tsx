import { useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { RollenKanonischerWert } from '../api';
import { fmtNum } from '../format';
import { SUMMENWERT } from '../glossar';
import { rollenView, rollenStand, ROLLEN_WOERTER, teilSummeText } from '../pvRolle';
import './PvComposition.css';

/** Aufschlüsselung einer ausdrücklich zugeordneten Live-Rolle. Ohne Zuordnung keine Fläche. */
export function RollenBreakdown({ wert }: { wert: RollenKanonischerWert | null }) {
  const view = rollenView(wert);
  const wort = ROLLEN_WOERTER[wert?.role as keyof typeof ROLLEN_WOERTER];
  const [offen, setOffen] = useState(false);
  if (!view || !wort) return null;

  const summe = view.summe == null ? '–' : fmtNum(view.summe, view.einheit, stellen(view.summe));
  const teil = teilSummeText(view);

  return (
    <div className={`vp-pvrolle vp-rolle-${wert?.role}`}>
      <button
        type="button"
        className="vp-pvrolle-kopf"
        aria-expanded={offen}
        onClick={() => setOffen((o) => !o)}
      >
        <Icon name={wort.icon} size={14} />
        <span className="vp-pvrolle-label">{wort.label}</span>
        <span className="vp-pvrolle-calc">berechnet</span>
        <span className="vp-pvrolle-wert">{summe}</span>
        <span className="vp-pvrolle-chevron" aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>

      <p className="vp-rolle-stand">{rollenStand(view.stand)}</p>
      {offen && (
        <div className="vp-pvrolle-auf">
          <p className="vp-pvrolle-sub">{wort.erklaerung}</p>
          <ul className="vp-pvrolle-zeilen">
            {view.zeilen.map((z) => (
              <li key={z.entityId} className={`vp-pvrolle-zeile${z.liefernd ? '' : ' stumm'}`}>
                <span className="vp-pvrolle-name">{z.name}</span>
                {z.liefernd ? (
                  <span className="vp-pvrolle-zwert">
                    {fmtNum(z.kw, view.einheit, stellen(z.kw))}
                  </span>
                ) : (
                  <span className="vp-pvrolle-leer">liefert gerade nicht</span>
                )}
              </li>
            ))}
          </ul>
          {view.summenwertHinweis && <p className="vp-pvrolle-sub">
            Ein {SUMMENWERT} kann mehreren Geräten zugeordnet sein. Er zählt in der Anlagenzahl einmal.
          </p>}
          <div className="vp-pvrolle-summe">
            <span className="vp-pvrolle-summe-k">
              {wort.label}{teil ? <span className="vp-pvrolle-teil"> · {teil}</span> : null}
            </span>
            <span className="vp-pvrolle-summe-v">{summe}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Wie viele Nachkommastellen: großzügig bei kleinen Werten, knapp bei großen. */
function stellen(wert: number | null): number {
  if (wert == null) return 1;
  const a = Math.abs(wert);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
}

/** Kompatibler Name für bestehende PV-Aufrufer. */
export const PvRollenBreakdown = RollenBreakdown;
