import { Icon } from '../../designsystem/components/core/Icon';
import type { Betriebsart, Site, StandortAmStichtag } from '../api';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { StandortKopf } from '../components/StandortKopf';
import { StandortWetterZeile } from '../components/StandortWetterZeile';
import { VersorgungKarte } from '../components/VersorgungKarte';
import type { StandortEinstieg } from '../ebenenNav';
import type { Route } from '../nav';
import './StandortUebersichtPage.css';

// UEMS AP-13 IP-2: die Seiten des Standorts reisen im Chunk seiner Übersicht (`PAGE_CHUNK.standort`).
export { StandortAnlagenPage } from './StandortAnlagenPage';
export { StandortGebaeudePage } from './StandortGebaeudePage';
export { StandortBoxenPage } from './StandortBoxenPage';

/**
 * Die Standort-Übersicht (UEMS AP-01 IP-5, E1): `#/standort/{id}` — der Kopf
 * des Standorts (`StandortKopf`, AP-02) über seinen Anlagen.
 *
 * Seit IP-6 ist sie DIESELBE Fläche wie die Unternehmens-Übersicht — das
 * Portfolio-Cockpit mit der Ebene „Standort": es filtert auf die Anlagen, die
 * dem Standort heute zugeordnet sind, und jede Kennzahl, jede Spalte und die
 * Geld-Regel gehen nur über sie. Unter einem Unternehmen mit mehreren
 * Standorten ist das dieselbe Seite wie bei einem Kunden mit genau einem —
 * keine zweite Liste ohne Kennzahlen mehr.
 *
 * AP-13 IP-2 (Ü8/K3): unter dem Kopf die Einstiege „Kennzahlen dieses
 * Standorts“ und „Berichte dieses Standorts“ (`ebenenNav.standortEinstiege`) —
 * am Standort sind beide Seiten, aber keine Bereiche, also keine Kachel. Wer
 * nicht misst, bekommt keinen Einstieg; die Übersicht bleibt dann zeichengleich.
 */
export function StandortUebersichtPage({
  standort,
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
  einstiege = [],
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  betriebsart?: Betriebsart | null;
  einstiege?: readonly StandortEinstieg[];
}) {
  return (
    <div className="vp-standort-uebersicht">
      <div className="vp-standort-uebersicht-kopf">
        <StandortKopf standort={standort} titelEbene="h1" />
        {einstiege.length > 0 && (
          <nav className="vp-standort-einstiege" aria-label={`Weitere Seiten des Standorts ${standort.name}`}>
            {einstiege.map((e) => (
              <button
                key={e.key}
                type="button"
                className="vp-standort-einstieg"
                data-testid={`einstieg-${e.key}`}
                onClick={() => onNavigate(e.ziel)}
              >
                <Icon name={e.icon} size={18} />
                <span className="vp-standort-einstieg-text">{e.label}</span>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
          </nav>
        )}
      </div>
      <VersorgungKarte standort={standort} />
      <StandortWetterZeile standort={standort} />
      <PortfolioCockpit
        sites={sites}
        onNavigate={onNavigate}
        onReload={onReload}
        isAdmin={isAdmin}
        betriebsart={betriebsart}
        titel={`Anlagen am Standort ${standort.name}`}
        titelBereitsGenannt
        ebene={{ art: 'standort', standort }}
      />
    </div>
  );
}
