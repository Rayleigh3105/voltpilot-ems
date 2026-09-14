import type { Betriebsart, Site } from '../api';
import type { Route } from '../nav';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import type { UebersichtEbene } from '../uebersicht';

interface PortfolioProps {
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0-Rahmen (effektiv, aus /tenant-context); null = unbekannt. */
  betriebsart?: Betriebsart | null;
  /**
   * UEMS AP-01 IP-6: bei mehreren Standorten ist diese Landung die
   * Unternehmens-Übersicht (Kopfzeile, Standort-Gruppen, Geld-Regel); `null` =
   * das Portfolio wie bisher.
   */
  ebene?: UebersichtEbene | null;
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
 * Die Route bleibt, damit jedes Lesezeichen gilt; sie liefert der gemeinsamen
 * Fläche seit Revision 2 nur noch ihren TITEL. Die frühere Ansprache („Guten
 * Tag, …") ist ersatzlos entfallen: unter dem Titel steht jetzt die EINE
 * Flotten-Aussage, und eine Begrüßung darüber wäre die zweite Zeile, die
 * nichts über die Flotte sagt (Captain 25.08.2026).
 */
export function PortfolioPage({
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
  ebene = null,
}: PortfolioProps) {
  return (
    <PortfolioCockpit
      sites={sites}
      onNavigate={onNavigate}
      onReload={onReload}
      isAdmin={isAdmin}
      // Ein Admin sieht das Portfolio des GEWÄHLTEN Mandanten; ohne gewählten
      // Mandanten kommt er hier gar nicht an (die Schale leitet ihn weiter).
      betriebsart={betriebsart ?? 'betreiber'}
      titel="Portfolio"
      titelBereitsGenannt
      ebene={ebene}
    />
  );
}
