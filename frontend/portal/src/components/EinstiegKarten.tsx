import { Icon } from '../../designsystem/components/core/Icon';
import { UEMS_ABWEICHUNGEN, UEMS_MESSSTELLE } from '../glossar';
import { AUFBAU_REITER } from '../ebenenNav';
import {
  standortBereichRoute,
  standortMessstellenRoute,
  verbesserungRoute,
  type Route,
} from '../nav';
import './UebersichtBausteine.css';

interface Weg {
  key: string;
  text: string;
  satz: string | null;
  ziel: Route;
}

function Wege({ wege, onNavigate, testid }: { wege: readonly Weg[]; onNavigate: (ziel: Route) => void; testid: string }) {
  return (
    <ul className="vp-ub-zeilen">
      {wege.map((w) => (
        <li key={w.key}>
          <button type="button" className="vp-ub-zeile" onClick={() => onNavigate(w.ziel)} data-testid={`${testid}-${w.key}`}>
            <span className="vp-ub-punkt" aria-hidden="true" />
            <span className="vp-ub-text">
              <span className="vp-ub-name">{w.text}</span>
              {w.satz && <span className="vp-ub-satz">{w.satz}</span>}
            </span>
            <Icon name="chevron-right" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * K6: der Einstieg für Bearbeiter — „Ist mein Standort angeschlossen?“: je Standort, an dem die Person Bearbeiter ist,
 * der Weg in seinen Aufbau (nur mit Messfunktion) und zu seinen Messstellen, dazu die Abweichungen (mit
 * `verbesserung.ansehen`). Ohne Standort steht die Karte nicht.
 */
export function StandortKarte({
  standorte,
  abweichungen,
  onNavigate,
}: {
  standorte: readonly { id: string; name: string; misst: boolean }[];
  abweichungen: boolean;
  onNavigate: (ziel: Route) => void;
}) {
  if (standorte.length === 0) return null;
  const titel = standorte.length === 1 ? `Ihr Standort ${standorte[0].name}` : 'Ihre Standorte';
  const wege: Weg[] = [
    ...standorte.flatMap((s) => {
      const vor = standorte.length === 1 ? '' : `${s.name}: `;
      return [
        ...(s.misst ? [{ key: `aufbau-${s.id}`, text: `${vor}${AUFBAU_REITER}`, satz: 'Anlagen, VoltPilot-Boxen und Geräte.', ziel: standortBereichRoute(s.id, 'aufbau') }] : []),
        { key: `messstellen-${s.id}`, text: `${vor}${UEMS_MESSSTELLE}n`, satz: 'Welche Messstellen Daten liefern.', ziel: standortMessstellenRoute(s.id) },
      ];
    }),
    ...(abweichungen ? [{ key: 'abweichungen', text: UEMS_ABWEICHUNGEN, satz: null, ziel: verbesserungRoute('abweichungen') }] : []),
  ];
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-ihr-standort" data-testid="baustein-standort">
      <h2 id="vp-ub-ihr-standort" className="vp-ub-titel">
        {titel}
      </h2>
      <Wege wege={wege} onNavigate={onNavigate} testid="standort" />
    </section>
  );
}
