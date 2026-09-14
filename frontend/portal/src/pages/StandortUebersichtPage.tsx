import type { Betriebsart, Site, StandortAmStichtag } from '../api';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { StandortKopf } from '../components/StandortKopf';
import type { Route } from '../nav';
import './StandortUebersichtPage.css';

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
 */
export function StandortUebersichtPage({
  standort,
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  betriebsart?: Betriebsart | null;
}) {
  return (
    <div className="vp-standort-uebersicht">
      <div className="vp-standort-uebersicht-kopf">
        <StandortKopf standort={standort} titelEbene="h1" />
      </div>
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
