import { useEffect, useRef } from 'react';
import { PLATTFORM_BEREICH, pageRoute, type PageId, type Route } from '../../nav';
import { PlattformUebersichtPage } from './PlattformUebersichtPage';
import { EdgeUpdatesPage } from './EdgeUpdatesPage';
import { FernwartungPage } from './FernwartungPage';
import { WerkstattPage } from './WerkstattPage';
import { KatalogBereich } from './KatalogBereich';

/**
 * Der Raum „Plattform" (Konzept `vp-adminview-konzept-k1` §4.2/4.3, Scheibe
 * S1): Übersicht · Software (N5) · Werkstatt · Fernwartung · Katalog, EINE
 * gemeinsame Reiterleiste über fünf bestehenden Seiten. Dasselbe Haus wie der
 * frühere Geräte-Bereich (Updates/Registrierung/Fernwartung/Werkstatt) -
 * Registrierung ist seit S1 der eigene Raum „Geräte" und steht hier nicht
 * mehr.
 */
export function PlattformBereich({
  page,
  onNavigate,
  onJumpToTenant,
}: {
  page: PageId;
  onNavigate: (target: Route | PageId) => void;
  onJumpToTenant?: (tenantId: string, route: Route) => void;
}) {
  const tabs = <PlattformTabs active={page} onSelect={(id) => onNavigate(pageRoute(id))} />;

  if (page === 'fernwartung') return <FernwartungPage tabs={tabs} />;
  if (page === 'werkstatt') return <WerkstattPage tabs={tabs} />;
  if (page === 'katalog') return <KatalogBereich tabs={tabs} />;
  if (page === 'edge-updates') {
    return <EdgeUpdatesPage onNavigate={(r) => onNavigate(r)} tabs={tabs} />;
  }
  return (
    <PlattformUebersichtPage
      onJumpToTenant={onJumpToTenant ?? (() => {})}
      onNavigate={(r) => onNavigate(r)}
      tabs={tabs}
    />
  );
}

/** Die Tab-Leiste des Raums - das Haus-Segment (`.vp-seg`), wie der frühere Geräte-Bereich. */
function PlattformTabs({
  active,
  onSelect,
}: {
  active: PageId;
  onSelect: (id: PageId) => void;
}) {
  const gewaehlt = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const zeigen = () => {
      const knopf = gewaehlt.current;
      const leiste = knopf?.parentElement;
      if (!knopf || !leiste || leiste.scrollWidth <= leiste.clientWidth) return;
      const links = knopf.getBoundingClientRect().left - leiste.getBoundingClientRect().left + leiste.scrollLeft;
      leiste.scrollLeft = Math.max(0, links - (leiste.clientWidth - knopf.offsetWidth) / 2);
    };
    zeigen();
    let aktiv = true;
    void document.fonts?.ready.then(() => aktiv && zeigen());
    return () => {
      aktiv = false;
    };
  }, [active]);
  return (
    <div className="vp-seg vp-bereich-tabs vp-plattform-tabs" role="tablist" aria-label="Plattform">
      {PLATTFORM_BEREICH.tabs.map((t) => (
        <button
          key={t.id}
          ref={active === t.id ? gewaehlt : undefined}
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
