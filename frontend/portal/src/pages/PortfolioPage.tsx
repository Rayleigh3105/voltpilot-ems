import { currentUser } from '../auth';
import type { Betriebsart, Site } from '../api';
import type { Route } from '../nav';
import { PortfolioCockpit } from '../components/PortfolioCockpit';

interface PortfolioProps {
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0-Rahmen (effektiv, aus /tenant-context); null = unbekannt. */
  betriebsart?: Betriebsart | null;
}

/**
 * Die BETREIBER-Landung (`#/portfolio`).
 *
 * Seit dem Anwendungs-Programm Stufe 4 (Captain-Entscheid E5) rendert sie
 * dasselbe {@link PortfolioCockpit} wie die Kunden-Übersicht: EINE Fläche,
 * komponiert aus den Anwendungen der Anlagen. Die frühere feste KPI-Zeile
 * (Speicher, Ø Ladestand, Erlös heute/Monat, vermiedene Spitze) und die
 * Betreiber-Tabelle sind darin aufgegangen — die Tabelle als DICHTE der
 * Betriebsart `betreiber`, die Kacheln als Bausteine, die eine aktive
 * Anwendung beisteuert.
 *
 * Die Route bleibt, damit jedes Lesezeichen gilt; sie ist nur noch der Kopf
 * (Titel + Ansprache) über der gemeinsamen Fläche.
 */
export function PortfolioPage({
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
}: PortfolioProps) {
  const user = currentUser();
  const firstName = (user.name || '').split(/\s+/)[0] || user.name;
  return (
    <PortfolioCockpit
      sites={sites}
      onNavigate={onNavigate}
      onReload={onReload}
      isAdmin={isAdmin}
      // Ein Admin sieht das Portfolio des GEWÄHLTEN Mandanten; ohne gewählten
      // Mandanten kommt er hier gar nicht an (die Schale leitet ihn weiter).
      betriebsart={betriebsart ?? 'betreiber'}
      kopf={{
        titel: 'Portfolio',
        satz: isAdmin
          ? 'Alle Anlagen dieses Mandanten auf einen Blick.'
          : `Guten Tag, ${firstName} - Ihr Anlagen-Portfolio auf einen Blick.`,
      }}
    />
  );
}
