import type { Betriebsart, Site } from '../api';
import type { Route } from '../nav';
import { EbenenCockpit } from '../components/EbenenCockpit';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { StandortVorschlagHinweis } from '../components/StandortVorschlagHinweis';
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
 *
 * UEMS AP-01 IP-6: mit bestätigten Standorten ist diese Landung die
 * Unternehmens-Übersicht ({@link EbenenCockpit}) — die Weiche ist die UEMS-Ebene,
 * nie die Betriebsart. Ohne Ebene trägt die Flotte die Vorschlagskarte der
 * Standorte als Hinweis (AP-02 IP-10/O18).
 */
export function PortfolioPage({
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
  ebene = null,
}: PortfolioProps) {
  // Ein Admin sieht das Portfolio des GEWÄHLTEN Mandanten; ohne gewählten
  // Mandanten kommt er hier gar nicht an (die Schale leitet ihn weiter).
  const rahmen = betriebsart ?? 'betreiber';
  if (ebene) {
    return (
      <EbenenCockpit
        sites={sites}
        onNavigate={onNavigate}
        onReload={onReload}
        isAdmin={isAdmin}
        betriebsart={rahmen}
        titel="Portfolio"
        titelBereitsGenannt
        ebene={ebene}
      />
    );
  }
  return (
    <PortfolioCockpit
      sites={sites}
      onReload={onReload}
      isAdmin={isAdmin}
      titel="Portfolio"
      titelBereitsGenannt
      hinweis={({ anwendungen, neuLaden }) => (
        <StandortVorschlagHinweis
          sites={sites}
          isAdmin={isAdmin}
          betriebsart={rahmen}
          anwendungen={anwendungen}
          onBestaetigt={() => {
            neuLaden();
            onReload();
          }}
        />
      )}
    />
  );
}
