import type { Site } from '../api';
import { PortfolioCockpit } from '../components/PortfolioCockpit';

interface PortfolioProps {
  sites: Site[];
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
}

/**
 * Die Landung der Flotten-Ebene (`#/portfolio`).
 *
 * Seit dem Anwendungs-Programm Stufe 4 (Captain-Entscheid E5) rendert sie
 * dasselbe {@link PortfolioCockpit} wie die Kunden-Übersicht: EINE Fläche,
 * komponiert aus den Anwendungen der Anlagen. Seit dem Entscheid vom
 * 25.09.2026 zeigt diese Fläche für JEDE Betriebsart dieselben vier Blöcke;
 * die frühere Betreiber-Tabelle und die Kennzahlen-Leiste sind entfallen.
 *
 * Die Route bleibt, damit jedes Lesezeichen gilt; sie liefert der gemeinsamen
 * Fläche nur ihren TITEL. Die frühere Ansprache („Guten Tag, …") ist
 * ersatzlos entfallen: unter dem Titel steht die EINE Statuszeile, und eine
 * Begrüßung darüber wäre die zweite Zeile, die nichts über die Flotte sagt
 * (Captain 25.08.2026).
 */
export function PortfolioPage({ sites, onReload, isAdmin = false }: PortfolioProps) {
  return (
    <PortfolioCockpit
      sites={sites}
      onReload={onReload}
      isAdmin={isAdmin}
      titel="Portfolio"
      titelBereitsGenannt
    />
  );
}
