import { useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { RollenKanonischerWert } from '../api';
import { fmtNum } from '../format';
import { pvRolleView, teilSummeText } from '../pvRolle';
import './PvComposition.css';

/**
 * Die kanonische PV-ROLLE unter dem Cockpit-Fluss (vp-agg §2.4/B, Mockup „2 · Das Cockpit"):
 * existiert eine Standort-PV-Zuordnung, trägt die Cockpit-Zahl ein dezentes „berechnet" - und ein
 * Tipp öffnet „So setzt sich Ihre PV-Produktion zusammen": eine Zeile je zugeordnetem Gerät (ein
 * stummes Gerät ist BENANNT mit „liefert gerade nicht"), darunter die ehrliche Teil-Summe „aus N
 * von M Geräten".
 *
 * Ohne Zuordnung rendert die Fläche NICHTS - der Rückfall `telemetry.pv_power_kw` bleibt
 * unmarkiert, nichts ändert sich für Anlagen ohne Zuordnung. Render-only; die Ableitung liegt rein
 * in `pvRolle.ts`.
 */
export function PvRollenBreakdown({ wert }: { wert: RollenKanonischerWert | null }) {
  const view = pvRolleView(wert);
  const [offen, setOffen] = useState(false);
  if (!view) return null;

  const summe = view.summe == null ? '–' : fmtNum(view.summe, view.einheit, stellen(view.summe));
  const teil = teilSummeText(view);

  return (
    <div className="vp-pvrolle">
      <button
        type="button"
        className="vp-pvrolle-kopf"
        aria-expanded={offen}
        onClick={() => setOffen((o) => !o)}
      >
        <Icon name="sun" size={14} />
        <span className="vp-pvrolle-label">Gesamt-PV</span>
        <span className="vp-pvrolle-calc">berechnet</span>
        <span className="vp-pvrolle-wert">{summe}</span>
        <span className="vp-pvrolle-chevron" aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>

      {offen && (
        <div className="vp-pvrolle-auf">
          <p className="vp-pvrolle-sub">So setzt sich Ihre PV-Produktion zusammen</p>
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
          <div className="vp-pvrolle-summe">
            <span className="vp-pvrolle-summe-k">
              Gesamt-PV{teil ? <span className="vp-pvrolle-teil"> · {teil}</span> : null}
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
