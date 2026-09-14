import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { Betriebsart, Site, StandortAmStichtag } from '../api';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { StandortKopf } from '../components/StandortKopf';
import { anlageRoute, type Route } from '../nav';
import './StandortUebersichtPage.css';

/**
 * Die Standort-Übersicht (UEMS AP-01 IP-5, E1): `#/standort/{id}` — der Kopf
 * des Standorts (`StandortKopf`, AP-02) über seinen Anlagen.
 *
 * ⚠ Das Portfolio-Cockpit zählt ALLE Anlagen des Kundenbereichs
 * (`api.overview()`), es kennt keinen Standort-Filter. Es steht deshalb nur da,
 * wo „alle Anlagen" und „die Anlagen dieses Standorts" dieselbe Menge sind —
 * bei einem Kunden mit genau einem Standort (Landung „1 Standort, n Anlagen" =
 * das heutige Portfolio mit Standort-Kopf). Unter einem Unternehmen mit mehreren
 * Standorten zeigt die Seite die Anlagen des Standorts als Liste, ohne
 * Kennzahlen: eine Summe über fremde Anlagen wäre eine falsche Zahl. Die
 * Kennzahlen je Standort und die Standort-Karten bringt IP-6.
 */
export function StandortUebersichtPage({
  standort,
  sites,
  alleAnlagenHier,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  /** Gehört JEDE Anlage des Kundenbereichs zu diesem Standort? Nur dann trägt das Portfolio-Cockpit. */
  alleAnlagenHier: boolean;
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
      {alleAnlagenHier ? (
        <PortfolioCockpit
          sites={sites}
          onNavigate={onNavigate}
          onReload={onReload}
          isAdmin={isAdmin}
          betriebsart={betriebsart}
          titel={`Anlagen am Standort ${standort.name}`}
          titelBereitsGenannt
        />
      ) : (
        <Card padding="lg" radius="lg" className="vp-standort-anlagen">
          <section aria-labelledby="vp-standort-anlagen-titel">
            <h2 id="vp-standort-anlagen-titel">Anlagen an diesem Standort</h2>
            {standort.anlagen.length === 0 ? (
              <p className="vp-muted">Diesem Standort ist heute keine Anlage zugeordnet.</p>
            ) : (
              <ul>
                {standort.anlagen.map((anlage) => (
                  <li key={anlage.id}>
                    <button
                      type="button"
                      className="vp-standort-anlage"
                      onClick={() => onNavigate(anlageRoute(anlage.id))}
                    >
                      <span>{anlage.name}</span>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Card>
      )}
    </div>
  );
}
